import { randomBytes } from 'node:crypto'
import { voiceResultPath, type VoiceResult, type VoiceStepLink, type VoiceStoredResult } from '../../types/voice'

/** Results live for ten minutes, in memory only. */
export const VOICE_RESULT_TTL_MS = 10 * 60_000
/** A Shortcut confirm is answered within seconds; five minutes is generous. */
export const VOICE_CONFIRM_TTL_MS = 5 * 60_000
const MAX_ENTRIES = 200

/** 18 random bytes as base64url: 24 characters, 144 bits. Matches VOICE_CODE_PATTERN. */
export function createVoiceCode(): string {
  return randomBytes(18).toString('base64url')
}

export type VoiceConfirmation = {
  threadId: string
  message: string
  chatTitle: string
  code: string
}

type Entry<T> = { value: T; expiresAtMs: number }

class ExpiringMap<T> {
  private readonly entries = new Map<string, Entry<T>>()

  constructor(private readonly ttlMs: number, private readonly now: () => number) {}

  set(key: string, value: T): number {
    this.prune()
    const expiresAtMs = this.now() + this.ttlMs
    this.entries.set(key, { value, expiresAtMs })
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string)
    return expiresAtMs
  }

  get(key: string): T | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key)
      return null
    }
    return entry.value
  }

  take(key: string): T | null {
    const value = this.get(key)
    this.entries.delete(key)
    return value
  }

  get size(): number {
    this.prune()
    return this.entries.size
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) if (entry.expiresAtMs <= now) this.entries.delete(key)
  }
}

export class VoiceResultStore {
  private readonly results: ExpiringMap<VoiceStoredResult>
  private readonly confirmations: ExpiringMap<VoiceConfirmation>

  constructor(private readonly now: () => number = Date.now, private readonly newCode: () => string = createVoiceCode) {
    this.results = new ExpiringMap(VOICE_RESULT_TTL_MS, now)
    this.confirmations = new ExpiringMap(VOICE_CONFIRM_TTL_MS, now)
  }

  /** Saves a result; each step of a `steps` result is saved as its own result, so its link works like any other. */
  save(result: VoiceResult): VoiceStoredResult {
    const { steps, ...rest } = result
    const links = steps?.map((step): VoiceStepLink => {
      const saved = this.save(step)
      const { action, outcome, listType, candidates, message, project, agent } = saved
      return { action, outcome, listType, candidates, message, project, agent, code: saved.code, url: voiceResultPath(saved, saved.code) }
    })
    const code = this.newCode()
    const createdAtMs = this.now()
    const stored: VoiceStoredResult = {
      ...rest,
      ...(links ? { steps: links } : {}),
      code,
      createdAtIso: new Date(createdAtMs).toISOString(),
      expiresAtIso: new Date(createdAtMs + VOICE_RESULT_TTL_MS).toISOString(),
    }
    this.results.set(code, stored)
    return stored
  }

  get(code: string): VoiceStoredResult | null {
    return this.results.get(code)
  }

  /** A single-use token for sending one message from the Shortcut. */
  createConfirmation(confirmation: VoiceConfirmation): string {
    const token = this.newCode()
    this.confirmations.set(token, confirmation)
    return token
  }

  /** Returns the confirmation once; any later call with the same token gets null. */
  takeConfirmation(token: string): VoiceConfirmation | null {
    return this.confirmations.take(token)
  }

  get resultCount(): number {
    return this.results.size
  }
}
