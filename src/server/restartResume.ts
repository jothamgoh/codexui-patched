import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isInternalSubagentThread } from '../utils/codexThreadSource'

/**
 * Chats that were mid-reply, or whose Claude background tasks were running, when
 * the server stopped get one "continue" message after it starts again, so a
 * restart does not silently end their work.
 */
export const RESTART_CONTINUE_TEXT =
  'CodexUI restarted while you were working, which stopped your last reply or background tasks. '
  + 'Continue where you left off, and restart any background task that was still needed.'

/** Ignore a file older than this: the stop was not a restart. */
const MAX_RECORD_AGE_MS = 10 * 60_000

type Notification = { method: string; params: unknown }
type Rpc = (method: string, params: unknown) => Promise<unknown>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readThreadId(params: unknown): string {
  const record = asRecord(params)
  const value = record?.threadId ?? asRecord(record?.thread)?.id
  return typeof value === 'string' ? value : ''
}

/** Which chats have a reply or background work in progress, from lifecycle notifications. */
export class ActiveTurnTracker {
  private readonly active = new Set<string>()
  private readonly background = new Set<string>()

  observe(notification: Notification): void {
    const threadId = readThreadId(notification.params)
    if (!threadId) return
    if (notification.method === 'thread/backgroundTasks/updated') {
      const tasks = asRecord(notification.params)?.tasks
      if (Array.isArray(tasks) && tasks.length > 0) this.background.add(threadId)
      else this.background.delete(threadId)
    } else if (notification.method === 'turn/started') {
      this.active.add(threadId)
    } else if (notification.method === 'turn/completed') {
      this.active.delete(threadId)
    } else if (notification.method === 'thread/status/changed') {
      const status = asRecord(asRecord(notification.params)?.status)?.type
      if (status === 'active') this.active.add(threadId)
      else this.active.delete(threadId)
    }
  }

  threadIds(): string[] {
    return [...new Set([...this.active, ...this.background])]
  }
}

export function recordInterruptedTurns(path: string, threadIds: string[], now = Date.now()): void {
  if (threadIds.length === 0) {
    rmSync(path, { force: true })
    return
  }
  writeFileSync(path, JSON.stringify({ recordedAtMs: now, threadIds }), { mode: 0o600 })
}

/** Reads and deletes the record, so each interruption is continued at most once. */
export function takeInterruptedTurns(path: string, now = Date.now()): string[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  rmSync(path, { force: true })
  try {
    const record = asRecord(JSON.parse(raw))
    const recordedAtMs = typeof record?.recordedAtMs === 'number' ? record.recordedAtMs : 0
    if (now - recordedAtMs > MAX_RECORD_AGE_MS) return []
    const ids = Array.isArray(record?.threadIds) ? record.threadIds : []
    return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  } catch {
    return []
  }
}

/**
 * Sends the continue message to each interrupted chat the user drives directly.
 * Project-board chats recover through their own service, and Codex helper
 * sub-chats are continued by their parent.
 */
export async function continueInterruptedTurns(
  threadIds: string[],
  rpc: Rpc,
  isManagedThread: (threadId: string) => Promise<boolean>,
): Promise<{ continued: string[]; skipped: string[]; failed: string[] }> {
  const result = { continued: [] as string[], skipped: [] as string[], failed: [] as string[] }
  for (const threadId of threadIds) {
    try {
      if (await isManagedThread(threadId)) {
        result.skipped.push(threadId)
        continue
      }
      const resumed = asRecord(await rpc('thread/resume', { threadId }))
      if (isInternalSubagentThread(resumed?.thread)) {
        result.skipped.push(threadId)
        continue
      }
      await rpc('turn/start', { threadId, input: [{ type: 'text', text: RESTART_CONTINUE_TEXT }] })
      result.continued.push(threadId)
    } catch (error) {
      result.failed.push(threadId)
      console.warn(`[restart-resume] Could not continue ${threadId}:`, error instanceof Error ? error.message : error)
    }
  }
  return result
}
