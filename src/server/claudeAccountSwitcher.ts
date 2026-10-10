import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { ClaudeAccountPool, ClaudeSavedAccount } from '../types/claudeAccounts'

export type CSwapResult = { code: number | null; stdout: string }
type Options = {
  stateFilePath: string
  executable: string | null
  run: (command: string, args: string[]) => Promise<CSwapResult>
  isBusy: () => boolean
  isAuthenticating?: () => boolean
  prepareSwitch: () => Promise<void>
  accountChanged: () => void
  now?: () => number
}

/** How often CodexUI asks cswap for its locally cached account state. */
export const CLAUDE_CSWAP_CHECK_MS = 60_000

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 256) : null
}

/** Only public account metadata crosses the HTTP boundary, never cswap's raw output. */
export function parseCSwapAccounts(output: string): { active: number | null; accounts: ClaudeSavedAccount[] } {
  let data: Record<string, unknown>
  try { data = record(JSON.parse(output)) } catch { throw new Error('Invalid claude-swap account response. Refresh accounts or update claude-swap.') }
  if (data.schemaVersion !== 1 || !Array.isArray(data.accounts)) throw new Error('Unsupported claude-swap account response.')
  const accounts: ClaudeSavedAccount[] = []
  for (const raw of data.accounts) {
    const row = record(raw)
    const number = Number(row.number)
    if (!Number.isSafeInteger(number) || number < 1) continue
    const fallback = row.usage === null || row.usage === undefined
    const usage = record(fallback ? row.lastGoodUsage : row.usage)
    const limits: ClaudeSavedAccount['limits'] = []
    for (const [key, label] of [['fiveHour', '5 hours'], ['sevenDay', '7 days']] as const) {
      const limit = record(usage[key])
      if (typeof limit.pct === 'number' && Number.isFinite(limit.pct)) {
        limits.push({ label, usedPercent: Math.min(100, Math.max(0, limit.pct)), resetsAt: text(limit.resetsAt) })
      }
    }
    accounts.push({
      number, email: text(row.email) ?? `Account ${number}`, alias: text(row.alias),
      organization: text(row.organizationName), active: row.active === true,
      disabled: row.disabled === true, usageStatus: text(row.usageStatus) ?? 'unavailable', limits,
      // cswap's usageStatus is the decision-grade freshness boundary. Its
      // adaptive scheduler may deliberately keep a successful reading for
      // longer than CodexUI's local check interval.
      usageIsStale: fallback,
      usageRateLimited: row.usageError === 'http-429', usageRetryAt: text(row.usageRetryAt),
      usageFetchedAt: text(fallback ? row.lastGoodFetchedAt : row.usageFetchedAt),
    })
  }
  const active = accounts.find((account) => account.active)?.number ?? null
  return { active, accounts }
}

export function resolveCSwapExecutable(): string | null {
  const configured = process.env.CODEXUI_CSWAP_PATH?.trim()
  if (configured) return existsSync(configured) ? resolve(configured) : null
  // Verification and other private profiles must never switch the real default login.
  if (process.env.CLAUDE_CONFIG_DIR && resolve(process.env.CLAUDE_CONFIG_DIR) !== join(homedir(), '.claude')) return null
  const candidates = [join(homedir(), '.local', 'bin', 'cswap'), ...(process.env.PATH ?? '').split(delimiter).map((path) => join(path, 'cswap'))]
  return candidates.find((path) => existsSync(path)) ?? null
}

/** A shared lock covers turn starts, native logins, and credential changes. */
export class ClaudeAccountSwitcher {
  private enabled = true
  private threshold = 90
  private initialized: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private cached: { at: number; active: number | null; accounts: ClaudeSavedAccount[] } | null = null
  private reading: Promise<void> | null = null
  private pending: number | null = null
  private switching = false
  private notice: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking: Promise<void> | null = null
  private disposed = false
  private manualUntil = 0
  private nextReadAt = 0
  private nextAutoAt = 0
  private failures = 0

  constructor(private readonly options: Options) {}

  private now(): number { return this.options.now?.() ?? Date.now() }

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const saved = record(JSON.parse(await readFile(this.options.stateFilePath, 'utf8').catch(() => '{}')))
      if (typeof saved.enabled === 'boolean') this.enabled = saved.enabled
      if (typeof saved.threshold === 'number' && saved.threshold >= 50 && saved.threshold <= 99) this.threshold = saved.threshold
    })().catch(() => { this.notice = 'Could not read automatic switching settings.' })
    return this.initialized
  }

  start(): void {
    if (this.timer || !this.options.executable) return
    this.timer = setInterval(() => { void this.tick() }, 60_000)
    this.timer.unref?.()
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async command(args: string[]): Promise<CSwapResult> {
    if (!this.options.executable) throw new Error('Install claude-swap on the host to manage accounts.')
    return this.options.run(this.options.executable, args)
  }

  private async refresh(inventoryChanged = false): Promise<void> {
    if (!this.options.executable) return
    // Refresh buttons and multiple browser tabs share the same polling budget.
    // Account mutations may refresh inventory; cswap's persistent per-account
    // collector still enforces its own cache and Retry-After backoff then.
    if (!inventoryChanged && this.now() < this.nextReadAt) return
    if (this.reading) return this.reading
    const pending = (async () => {
      this.nextReadAt = this.now() + CLAUDE_CSWAP_CHECK_MS
      const result = await this.command(['list', '--json'])
      if (result.code !== 0) throw new Error('Could not read saved Claude accounts. Check claude-swap on the host.')
      const data = parseCSwapAccounts(result.stdout)
      const previous = this.cached
      this.cached = { at: this.now(), ...data }
      this.failures = 0
      for (const account of this.cached.accounts) {
        if (!account.limits.length) {
          const last = previous?.accounts.find((old) => old.number === account.number && old.email === account.email)
          if (last?.limits.length) { account.limits = last.limits; account.usageIsStale = true }
        }
        if (account.usageRateLimited) {
          this.notice = 'Claude usage checks are rate limited. Showing cached usage; replies and manual switching still work.'
        }
      }
    })()
    this.reading = pending
    try { await pending } catch (error) {
      this.failures += 1
      for (const account of this.cached?.accounts ?? []) account.usageIsStale = true
      this.nextReadAt = Math.max(this.nextReadAt, this.now() + Math.min(60 * 60_000, CLAUDE_CSWAP_CHECK_MS * 2 ** Math.min(this.failures - 1, 6)))
      throw error
    } finally { if (this.reading === pending) this.reading = null }
  }

  async snapshot(_force = false): Promise<ClaudeAccountPool> {
    await this.initialize()
    // Don't start a credential-refreshing usage reader during a credential change.
    if (!this.switching && !this.options.isAuthenticating?.()) {
      try { await this.refresh() } catch (error) { this.notice = error instanceof Error ? error.message : 'Could not read Claude accounts.' }
    }
    return {
      installed: Boolean(this.options.executable), enabled: this.enabled, threshold: this.threshold,
      activeAccountNumber: this.cached?.active ?? null, pendingAccountNumber: this.pending,
      switching: this.switching || Boolean(this.options.isAuthenticating?.()), accounts: this.cached?.accounts ?? [], notice: this.notice,
      checkedAt: this.cached ? new Date(this.cached.at).toISOString() : null,
      nextCheckAt: this.nextReadAt ? new Date(this.nextReadAt).toISOString() : null,
    }
  }

  async configure(enabled: unknown, threshold: unknown): Promise<ClaudeAccountPool> {
    if (typeof enabled !== 'boolean' || !Number.isInteger(threshold) || Number(threshold) < 50 || Number(threshold) > 99) {
      throw new Error('Choose automatic switching and a threshold between 50% and 99%.')
    }
    await this.exclusive(async () => {
      await this.initialize()
      const directory = dirname(this.options.stateFilePath)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.options.stateFilePath}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify({ enabled, threshold }) + '\n', { mode: 0o600 })
      await rename(temporary, this.options.stateFilePath)
      this.enabled = enabled
      this.threshold = Number(threshold)
    })
    if (enabled) void this.tick()
    return this.snapshot()
  }

  async requestSwitch(number: unknown): Promise<ClaudeAccountPool> {
    if (!Number.isSafeInteger(number) || Number(number) < 1) throw new Error('Choose a saved Claude account.')
    await this.exclusive(async () => {
      if (this.options.isAuthenticating?.()) throw new Error('Finish or cancel Claude sign-in before changing accounts.')
      await this.refresh()
      const account = this.cached?.accounts.find((entry) => entry.number === number)
      if (!account) throw new Error('This saved Claude account is no longer available.')
      this.pending = account.active ? null : Number(number)
      this.notice = this.pending ? 'Account switch queued until Claude replies finish.' : null
      await this.applyPending()
    })
    return this.snapshot()
  }

  private async mutate(args: string[]): Promise<CSwapResult> {
    this.switching = true
    try {
      // Drain a list read before changing the same account's token or Keychain entry.
      if (this.reading) await this.reading.catch(() => undefined)
      await this.options.prepareSwitch()
      return await this.command(args)
    } finally {
      this.options.accountChanged()
      this.switching = false
    }
  }

  /**
   * cswap owns automatic polling, backoff, threshold evaluation and the
   * credential change. Turn starts share this class's exclusive queue, so an
   * idle Claude process can be closed immediately after cswap reports a switch
   * without racing a new CodexUI reply.
   */
  private async autoSwitch(): Promise<CSwapResult> {
    this.switching = true
    try {
      if (this.reading) await this.reading.catch(() => undefined)
      const result = await this.command(['auto', '--once', '--json', '--threshold', String(this.threshold)])
      if (result.code === 0) {
        try { await this.options.prepareSwitch() } finally { this.options.accountChanged() }
      }
      return result
    } finally {
      this.switching = false
    }
  }

  private async applyPending(): Promise<void> {
    if (this.pending === null || this.options.isBusy() || this.disposed) return
    const number = this.pending
    const result = await this.mutate(['switch', String(number), '--json'])
    if (result.code !== 0) {
      this.pending = null
      throw new Error('Could not switch accounts. Sign into that account again on the host, then save it.')
    }
    await this.refresh(true)
    if (this.cached?.active !== number) {
      this.pending = null
      throw new Error('Claude did not confirm the selected account. Refresh accounts before continuing.')
    }
    this.pending = null
    this.manualUntil = this.now() + 5 * 60_000
    this.notice = `Switched to account ${number}. Your chats and folders are unchanged.`
  }

  /** Called inside the turn-start lock, before a new Claude process can be created. */
  async beforeTurn(): Promise<void> {
    if (this.disposed) throw new Error('Claude account manager is stopping.')
    if (this.switching) throw new Error('Claude is switching accounts. Send again in a moment.')
    await this.applyPending()
    if (this.pending !== null) throw new Error('An account change is queued. Wait for current Claude replies to finish before starting another.')
  }

  /** Already under exclusive(); login completes through the unmodified Claude CLI. */
  async saveCurrent(): Promise<void> {
    if (!this.options.executable) return
    const result = await this.command(['add'])
    if (result.code !== 0) throw new Error('Could not save the current Claude login. Run cswap add on the host.')
    await this.refresh(true)
    this.notice = 'Claude account saved. You can add another account without signing out.'
  }

  async drainReads(): Promise<void> {
    if (this.reading) await this.reading.catch(() => undefined)
  }

  async removeAccount(number: unknown): Promise<ClaudeAccountPool> {
    if (!Number.isSafeInteger(number) || Number(number) < 1) throw new Error('Choose a saved Claude account to remove.')
    await this.exclusive(async () => {
      if (this.options.isBusy()) throw new Error('Wait for Claude replies or sign-in to finish before removing an account.')
      await this.refresh()
      if (!this.cached?.accounts.some((account) => account.number === number)) throw new Error('That saved account is no longer available.')
      await this.drainReads()
      this.switching = true
      try {
        const result = await this.command(['remove', String(number)])
        if (result.code !== 0) throw new Error('Could not remove this saved account. Check for an isolated cswap session still using it.')
        if (this.pending === number) this.pending = null
        await this.refresh(true)
        if (this.cached?.accounts.some((account) => account.number === number)) throw new Error('The account was not removed. Refresh and try again.')
      } finally { this.switching = false }
      this.notice = 'Saved account removed. Existing chats and the current Claude login remain available.'
    })
    return this.snapshot()
  }

  async enrollCurrent(): Promise<ClaudeAccountPool> {
    await this.exclusive(async () => {
      if (this.options.isBusy()) throw new Error('Wait for Claude replies to finish before saving this login.')
      if (!this.options.executable) throw new Error('Install claude-swap on the host first.')
      await this.saveCurrent()
    })
    return this.snapshot()
  }

  async tick(): Promise<void> {
    if (this.ticking) return this.ticking
    const pending = this.exclusive(async () => {
      await this.initialize()
      if (this.disposed || !this.options.executable || this.options.isBusy()) return
      if (this.pending !== null) { await this.applyPending(); return }
      if (!this.enabled || this.now() < this.manualUntil || this.now() < this.nextAutoAt) return
      await this.refresh()
      if ((this.cached?.accounts.length ?? 0) < 2 || this.cached?.active === null) return
      // Asking every minute does not mean an Anthropic request every minute.
      // cswap serves its cache until its persisted adaptive poll plan is due.
      this.nextAutoAt = this.now() + CLAUDE_CSWAP_CHECK_MS
      const result = await this.autoSwitch()
      if (![0, 2, 3].includes(result.code ?? -1)) throw new Error('Automatic switching failed. Check saved accounts or sign in again.')
      if (result.code === 0) {
        this.notice = 'Automatically switched Claude accounts. Your next reply uses the new account.'
        await this.refresh(true)
      }
      else if (result.code === 3) this.notice = 'No saved account is ready. Add an account or wait for its usage to reset.'
    }).catch((error: unknown) => {
      this.notice = error instanceof Error ? error.message : 'Could not switch Claude accounts.'
    })
    this.ticking = pending
    try { await pending } finally { if (this.ticking === pending) this.ticking = null }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
