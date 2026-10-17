import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The ChatGPT desktop app, which Codex computer use opens to drive Chrome. */
export const CHATGPT_APP_COMMAND = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'
export const QUIT_AFTER_IDLE_MS = 10 * 60_000
/** Computer use can take a minute or more to finish opening the app. */
const LAUNCH_GRACE_MS = 2 * 60_000
/** `ps` reports whole seconds, so a start time can read up to a second early. */
const CLOCK_SLACK_MS = 2_000
/** While a chat may still need the app, look again this often. */
const BUSY_RETRY_MS = 60_000

export type RunningApp = { pid: number; startedAtMs: number }

/** `[[dd-]hh:]mm:ss`, as `ps -o etime` prints it, in milliseconds. */
export function parseElapsed(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u)
  if (!match) return null
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
}

/** The ChatGPT app in `ps -axo pid=,etime=,command=` output, and when it started. */
export function findAppInProcessList(output: string, nowMs: number): RunningApp | null {
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/u)
    const command = match?.[3] ?? ''
    if (command !== CHATGPT_APP_COMMAND && !command.startsWith(`${CHATGPT_APP_COMMAND} `)) continue
    const elapsedMs = parseElapsed(match?.[2] ?? '')
    if (elapsedMs !== null) return { pid: Number(match?.[1]), startedAtMs: nowMs - elapsedMs }
  }
  return null
}

async function findChatGptApp(): Promise<RunningApp | null> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,etime=,command='], { maxBuffer: 16 * 1024 * 1024 })
  return findAppInProcessList(stdout, Date.now())
}

type ChatGptAppCloserOptions = {
  /** JSON file holding `{ "quitAfterComputerUse": boolean }`; missing means on. */
  settingsPath: string
  /** Whether a chat may still need the app: a Codex reply running, or a live Claude process that used computer use. */
  isBusy: () => boolean
  findApp?: () => Promise<RunningApp | null>
  quit?: (pid: number) => void
  now?: () => number
}

/**
 * When a Claude chat drives Chrome, computer use opens the ChatGPT app, which
 * then stays open at about 1.8 GB. Quit it ten minutes after the last computer
 * use, and only when computer use opened it: the app must have been closed
 * when computer use started and have opened during that use.
 */
export class ChatGptAppCloser {
  /** When computer use found the app closed, starting the current round of use. */
  private foundClosedAtMs: number | null = null
  private lastUseMs = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly findApp: () => Promise<RunningApp | null>
  private readonly quit: (pid: number) => void
  private readonly now: () => number

  constructor(private readonly options: ChatGptAppCloserOptions) {
    this.findApp = options.findApp ?? findChatGptApp
    this.quit = options.quit ?? ((pid) => process.kill(pid, 'SIGTERM'))
    this.now = options.now ?? Date.now
  }

  /** A Claude chat is starting a computer-use call. */
  async noteComputerUse(): Promise<void> {
    const now = this.now()
    this.lastUseMs = now
    this.schedule(QUIT_AFTER_IDLE_MS)
    if (this.foundClosedAtMs !== null) return
    if (!(await this.findApp().catch(() => null))) this.foundClosedAtMs = now
  }

  async readSettings(): Promise<{ enabled: boolean }> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.settingsPath, 'utf8'))
      return { enabled: (parsed as { quitAfterComputerUse?: unknown } | null)?.quitAfterComputerUse !== false }
    } catch {
      return { enabled: true }
    }
  }

  async writeSettings(enabled: boolean): Promise<{ enabled: boolean }> {
    const path = this.options.settingsPath
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify({ quitAfterComputerUse: enabled }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    return { enabled }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.quitIfIdle()
    }, delayMs)
    this.timer.unref?.()
  }

  private async quitIfIdle(): Promise<void> {
    const foundClosedAtMs = this.foundClosedAtMs
    if (foundClosedAtMs === null) return
    const app = await this.findApp().catch(() => null)
    const openedByComputerUse = app !== null
      && app.startedAtMs >= foundClosedAtMs - CLOCK_SLACK_MS
      && app.startedAtMs <= this.lastUseMs + LAUNCH_GRACE_MS
    if (!app || !openedByComputerUse || !(await this.readSettings()).enabled) {
      this.foundClosedAtMs = null
      return
    }
    if (this.options.isBusy()) {
      this.schedule(BUSY_RETRY_MS)
      return
    }
    this.foundClosedAtMs = null
    try {
      this.quit(app.pid)
      console.log(`[chatgpt-app] Quit the ChatGPT app (pid ${String(app.pid)}) that computer use opened; it was idle for 10 minutes.`)
    } catch (error) {
      console.warn('[chatgpt-app] Could not quit the ChatGPT app:', error instanceof Error ? error.message : error)
    }
  }
}
