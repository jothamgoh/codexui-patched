import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_SESSION_RECORD_BYTES = 64 * 1024
const SESSION_STATES = new Set(['busy', 'shell', 'idle', 'waiting'])

export type ClaudeSessionState = 'busy' | 'shell' | 'idle' | 'waiting'

export type ClaudeSessionRegistryScan = {
  states: Map<string, ClaudeSessionState>
  /** A live-looking record could not be classified, so credential changes should wait. */
  uncertain: boolean
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

export function isClaudeSessionActive(state: ClaudeSessionState | undefined): boolean {
  return state === 'busy' || state === 'shell' || state === 'waiting'
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function preferredState(first: ClaudeSessionState | undefined, second: ClaudeSessionState): ClaudeSessionState {
  if (!first || first === 'idle') return second
  if (first === 'waiting' && (second === 'busy' || second === 'shell')) return second
  return first
}

/** Read Claude Code's own live PID/session records without inspecting commands or credentials. */
export async function scanClaudeSessionRegistry(configDir = claudeConfigDir()): Promise<ClaudeSessionRegistryScan> {
  const sessionsDir = join(configDir, 'sessions')
  let entries
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { states: new Map(), uncertain: false }
    return { states: new Map(), uncertain: true }
  }

  const states = new Map<string, ClaudeSessionState>()
  let uncertain = false
  await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map(async (entry) => {
    const path = join(sessionsDir, entry.name)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_SESSION_RECORD_BYTES) {
        uncertain = true
        return
      }
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        uncertain = true
        return
      }
      const record = parsed as Record<string, unknown>
      const pid = record.pid
      if (typeof pid !== 'number' || !isPidAlive(pid)) return
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
      const status = typeof record.status === 'string' && SESSION_STATES.has(record.status)
        ? record.status as ClaudeSessionState
        : null
      if (!sessionId || !status) {
        uncertain = true
        return
      }
      states.set(sessionId, preferredState(states.get(sessionId), status))
    } catch {
      uncertain = true
    }
  }))
  return { states, uncertain }
}
