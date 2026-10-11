/**
 * Sends a voice message, or starts a new chat, after the undo window. The
 * window is kept here on the server, so it runs with the phone locked or the
 * app closed. Pending sends live in memory only: a restart drops them unsent.
 * Logs say what happened and when, never the words.
 */
import type { VoiceAgent, VoiceDeliveryState } from '../../types/voice'
import type { VoiceResultStore } from './voiceStore'

export type DeliveryTarget =
  | { kind: 'send'; code: string; threadId: string; message: string; label: string }
  | { kind: 'new_chat'; code: string; cwd: string; agent: VoiceAgent | null; message: string; label: string }

export type DeliveryOutcome = { target: DeliveryTarget; state: Extract<VoiceDeliveryState, 'sent' | 'failed' | 'cancelled'>; threadId?: string }

export type VoiceDeliveryDeps = {
  store: VoiceResultStore
  sendMessage: (threadId: string, text: string) => Promise<void>
  /** Starts a chat in `cwd` with the spoken (or default) agent and sends the first message. */
  startChat: (input: { cwd: string; agent: VoiceAgent | null; message: string }) => Promise<{ threadId: string }>
  log: (line: string) => void
  now?: () => number
  /** setTimeout and clearTimeout unless a test drives the clock itself. */
  timers?: DeliveryTimers
}

export type DeliveryTimers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

const SYSTEM_TIMERS: DeliveryTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type DeliverOptions = {
  delaySeconds: number
  trigger: 'auto' | 'tap'
  /** Called once every target has gone out, failed or been cancelled; not called when all were cancelled. */
  onSettled?: (outcomes: DeliveryOutcome[]) => Promise<void> | void
}

type Job = {
  key: string
  targets: DeliveryTarget[]
  cancelled: Set<string>
  scheduledAtMs: number
  timer: unknown
  fired: boolean
  trigger: 'auto' | 'tap'
  onSettled?: DeliverOptions['onSettled']
}

export class VoiceDeliveryQueue {
  private readonly jobs = new Map<string, Job>()
  /** A target's code -> its job's key, while the job waits. */
  private readonly jobKeyOf = new Map<string, string>()
  private readonly now: () => number
  private readonly timers: DeliveryTimers

  constructor(private readonly deps: VoiceDeliveryDeps) {
    this.now = deps.now ?? deps.store.now
    this.timers = deps.timers ?? SYSTEM_TIMERS
  }

  /**
   * Records every target as pending and sends them in order after the delay.
   * With no delay they go out at once and this resolves with the outcomes;
   * otherwise it resolves with null as soon as they are scheduled.
   */
  async deliver(key: string, targets: DeliveryTarget[], options: DeliverOptions): Promise<DeliveryOutcome[] | null> {
    const delayMs = Math.max(0, options.delaySeconds) * 1000
    const scheduledAtMs = this.now()
    for (const target of targets) {
      this.deps.store.setDelivery(target.code, {
        kind: target.kind,
        state: 'pending',
        trigger: options.trigger,
        delaySeconds: options.delaySeconds,
        sendAtMs: scheduledAtMs + delayMs,
        label: target.label,
        message: target.message,
        ...(target.kind === 'send' ? { threadId: target.threadId } : {}),
      })
    }
    const job: Job = { key, targets, cancelled: new Set(), scheduledAtMs, timer: null, fired: false, trigger: options.trigger, onSettled: options.onSettled }
    this.deps.log(`[voice] auto_send=scheduled trigger=${options.trigger} kinds=${targets.map((target) => target.kind).join(',')} delay=${delayMs}ms`)
    if (delayMs === 0) return this.fire(job)
    this.jobs.set(key, job)
    for (const target of targets) this.jobKeyOf.set(target.code, key)
    job.timer = this.timers.set(() => { void this.fire(job) }, delayMs)
    return null
  }

  /**
   * Cancels a waiting send: the whole job by its key, or one target by its
   * code. Returns whether anything was cancelled now; a second call, a call
   * after the send began and an unknown code all return false.
   */
  cancel(code: string): boolean {
    const key = this.jobs.has(code) ? code : this.jobKeyOf.get(code)
    const job = key ? this.jobs.get(key) : undefined
    if (!job || job.fired) return false
    const chosen = code === job.key ? job.targets : job.targets.filter((target) => target.code === code)
    const fresh = chosen.filter((target) => !job.cancelled.has(target.code))
    if (fresh.length === 0) return false
    for (const target of fresh) {
      job.cancelled.add(target.code)
      this.jobKeyOf.delete(target.code)
      this.deps.store.updateDelivery(target.code, { state: 'cancelled' })
      this.deps.log(`[voice] auto_send=cancelled trigger=${job.trigger} kind=${target.kind} after=${this.now() - job.scheduledAtMs}ms`)
    }
    if (job.cancelled.size === job.targets.length) this.forget(job)
    return true
  }

  /** On shutdown: every waiting send is dropped, not sent. Returns how many. */
  dispose(): number {
    let dropped = 0
    for (const job of this.jobs.values()) {
      dropped += job.targets.length - job.cancelled.size
      this.forget(job)
    }
    if (dropped > 0) this.deps.log(`[voice] auto_send=dropped count=${dropped} reason=shutdown`)
    return dropped
  }

  get pendingCount(): number {
    return this.jobs.size
  }

  private forget(job: Job): void {
    if (job.timer !== null) this.timers.clear(job.timer)
    job.timer = null
    this.jobs.delete(job.key)
    for (const target of job.targets) this.jobKeyOf.delete(target.code)
  }

  private async fire(job: Job): Promise<DeliveryOutcome[]> {
    // At most once, whatever calls it.
    if (job.fired) return []
    job.fired = true
    this.forget(job)
    const outcomes: DeliveryOutcome[] = []
    for (const target of job.targets) {
      if (job.cancelled.has(target.code)) {
        outcomes.push({ target, state: 'cancelled' })
        continue
      }
      this.deps.store.updateDelivery(target.code, { state: 'sending' })
      const started = this.now()
      const waited = started - job.scheduledAtMs
      try {
        let threadId: string
        if (target.kind === 'send') {
          await this.deps.sendMessage(target.threadId, target.message)
          threadId = target.threadId
        } else {
          threadId = (await this.deps.startChat({ cwd: target.cwd, agent: target.agent, message: target.message })).threadId
        }
        this.deps.store.updateDelivery(target.code, { state: 'sent', threadId })
        this.deps.log(`[voice] auto_send=sent trigger=${job.trigger} kind=${target.kind} waited=${waited}ms send=${this.now() - started}ms`)
        outcomes.push({ target, state: 'sent', threadId })
      } catch (error) {
        this.deps.store.updateDelivery(target.code, { state: 'failed' })
        this.deps.log(`[voice] auto_send=failed trigger=${job.trigger} kind=${target.kind} waited=${waited}ms send=${this.now() - started}ms error=${error instanceof Error ? error.name : 'unknown'}`)
        outcomes.push({ target, state: 'failed' })
      }
    }
    if (outcomes.some((outcome) => outcome.state !== 'cancelled')) {
      try {
        await job.onSettled?.(outcomes)
      } catch {
        this.deps.log('[voice] auto_send notification failed')
      }
    }
    return outcomes
  }
}

/**
 * The model for a voice new chat: the spoken agent when there is one, kept on
 * the configured default when that already is the agent; otherwise the
 * default. undefined leaves the choice to Codex.
 */
export function voiceChatModel(agent: VoiceAgent | null, defaultModel: string, isClaudeModel: (id: string) => boolean): string | undefined {
  const fallback = defaultModel.trim()
  if (!agent) return fallback || undefined
  if (agent === 'claude') return fallback && isClaudeModel(fallback) ? fallback : 'claude-default'
  return fallback && !isClaudeModel(fallback) ? fallback : undefined
}
