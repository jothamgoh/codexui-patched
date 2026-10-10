import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isInternalSubagentThread } from '../utils/codexThreadSource'

/**
 * Chats that were mid-reply, or whose Claude background tasks were running, when
 * the server stopped get one "continue" message after it starts again, so a
 * restart does not silently end their work.
 */
export const RESTART_CONTINUE_TEXT =
  // Names no app: the chat is usually working in another project, so "CodexUI" would mislead it.
  'Continue where you left off. A restart interrupted this session; restart any background task that is still needed.'

/** Ignore a file older than this: the stop was not a restart. */
const MAX_RECORD_AGE_MS = 10 * 60_000

type Notification = { method: string; params: unknown }
type Rpc = (method: string, params: unknown) => Promise<unknown>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readTurnId(params: unknown): string {
  const record = asRecord(params)
  const value = asRecord(record?.turn)?.id ?? record?.turnId
  return typeof value === 'string' ? value : ''
}

function readThreadId(params: unknown): string {
  const record = asRecord(params)
  const value = record?.threadId ?? asRecord(record?.thread)?.id
  return typeof value === 'string' ? value : ''
}

/**
 * Which chats this server has a reply or background work running for. Only turn
 * and background-task events count: `thread/status/changed` also reports Claude
 * sessions running in other apps, which a restart does not stop.
 */
export class ActiveTurnTracker {
  /** Running turn ids per chat. A completion only ends its own turn, never a newer one. */
  private readonly active = new Map<string, Set<string>>()
  private readonly background = new Set<string>()
  private readonly requested = new Set<string>()

  /** Continue this chat after the next restart even if it is idle, such as the chat that asked for it. */
  continueAfterRestart(threadId: string): void {
    this.requested.add(threadId)
  }

  observe(notification: Notification): void {
    const threadId = readThreadId(notification.params)
    if (!threadId) return
    if (notification.method === 'thread/backgroundTasks/updated') {
      const tasks = asRecord(notification.params)?.tasks
      if (Array.isArray(tasks) && tasks.length > 0) this.background.add(threadId)
      else this.background.delete(threadId)
    } else if (notification.method === 'turn/started') {
      const turns = this.active.get(threadId) ?? new Set<string>()
      turns.add(readTurnId(notification.params))
      this.active.set(threadId, turns)
    } else if (notification.method === 'turn/completed') {
      const turnId = readTurnId(notification.params)
      const turns = this.active.get(threadId)
      if (turnId) turns?.delete(turnId)
      else turns?.clear()
      if (!turns?.size) this.active.delete(threadId)
    }
  }

  threadIds(): string[] {
    return [...new Set([...this.active.keys(), ...this.background, ...this.requested])]
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
 * `skip` excludes chats someone else owns: project-board chats recover through
 * their own service, and Claude sessions CodexUI does not list are another app's.
 * Codex helper sub-chats are continued by their parent.
 */
export async function continueInterruptedTurns(
  threadIds: string[],
  rpc: Rpc,
  skip: (threadId: string) => Promise<boolean>,
): Promise<{ continued: string[]; skipped: string[]; failed: string[] }> {
  const result = { continued: [] as string[], skipped: [] as string[], failed: [] as string[] }
  for (const threadId of threadIds) {
    try {
      if (await skip(threadId)) {
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
