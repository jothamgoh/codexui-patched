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
  isBusy: () => boolean | Promise<boolean>
  isAuthenticating?: () => boolean
  /** `keepBusy` leaves working Claude processes running instead of refusing the change. */
  prepareSwitch: (options?: { keepBusy?: boolean }) => Promise<void>
  accountChanged: () => void
  now?: () => number
}

export type ClaudeLimitRecoveryResult =
  | { kind: 'ready'; accountNumber: number }
  | { kind: 'blocked'; reason: 'disabled' | 'no-account' | 'switch-failed' | 'stopped' }

type LimitRecoveryRequest = {
  exhaustedAccountNumber: number | null
  excludedAccountNumbers: Set<number>
  resolve: (result: ClaudeLimitRecoveryResult) => void
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
  private readonly limitRecoveries: LimitRecoveryRequest[] = []

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

  private async mutate(args: string[], prepare?: { keepBusy?: boolean }): Promise<CSwapResult> {
    this.switching = true
    try {
      // Drain a list read before changing the same account's token or Keychain entry.
      if (this.reading) await this.reading.catch(() => undefined)
      await this.options.prepareSwitch(prepare)
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

  private async applyPending(options: { keepBusy?: boolean } = {}): Promise<void> {
    if (this.pending === null || this.disposed) return
    if (!options.keepBusy && await this.options.isBusy()) return
    const number = this.pending
    const result = await this.mutate(['switch', String(number), '--json'], options)
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

  /** The active account when fresh usage shows it fully used, so every Claude process on it is stopped. */
  private exhaustedActiveAccount(): number | null {
    const active = this.cached?.accounts.find((account) => account.active)
    if (!active || active.usageStatus !== 'ok' || active.usageIsStale || active.limits.length === 0) return null
    return Math.max(...active.limits.map((limit) => limit.usedPercent)) >= 100 ? active.number : null
  }

  private bestRecoveryAccount(excludedAccountNumbers: ReadonlySet<number>): ClaudeSavedAccount | null {
    const candidates = (this.cached?.accounts ?? []).flatMap((account) => {
      if (
        account.active
        || account.disabled
        || account.usageStatus !== 'ok'
        || account.usageIsStale
        || account.limits.length === 0
        || excludedAccountNumbers.has(account.number)
      ) return []
      const bindingUsedPercent = Math.max(...account.limits.map((limit) => limit.usedPercent))
      return bindingUsedPercent < this.threshold ? [{ account, bindingUsedPercent }] : []
    })
    candidates.sort((left, right) => left.bindingUsedPercent - right.bindingUsedPercent || left.account.number - right.account.number)
    return candidates[0]?.account ?? null
  }

  private resolveLimitRecoveries(result: ClaudeLimitRecoveryResult): void {
    const pending = this.limitRecoveries.splice(0)
    for (const request of pending) request.resolve(result)
  }

  private async applyLimitRecovery(): Promise<void> {
    if (this.limitRecoveries.length === 0) return
    if (this.disposed) {
      this.resolveLimitRecoveries({ kind: 'blocked', reason: 'stopped' })
      return
    }
    if (!this.enabled) {
      this.notice = 'Claude reached its limit. Turn on automatic switching to continue on another saved account.'
      this.resolveLimitRecoveries({ kind: 'blocked', reason: 'disabled' })
      return
    }
    // Every Claude process shares the exhausted login, so waiting for other work
    // (often long background tasks) cannot help. Only a sign-in must finish first.
    if (this.options.isAuthenticating?.()) {
      this.notice = 'Claude reached its limit. Account recovery is waiting for Claude sign-in to finish.'
      return
    }
    if (this.pending !== null) await this.applyPending({ keepBusy: true })
    if (this.pending !== null) return

    try {
      await this.refresh(true)
    } catch {
      this.notice = 'Claude reached its limit, but saved accounts could not be refreshed.'
      this.resolveLimitRecoveries({ kind: 'blocked', reason: 'switch-failed' })
      return
    }
    const activeAccountNumber = this.cached?.active ?? null
    if (activeAccountNumber !== null) {
      for (const request of this.limitRecoveries) request.exhaustedAccountNumber ??= activeAccountNumber
    }
    const alreadyRecovered = activeAccountNumber !== null && this.limitRecoveries.every((request) => (
      request.exhaustedAccountNumber !== null
      && request.exhaustedAccountNumber !== activeAccountNumber
      && !request.excludedAccountNumbers.has(activeAccountNumber)
    ))
    if (alreadyRecovered) {
      this.resolveLimitRecoveries({ kind: 'ready', accountNumber: activeAccountNumber })
      return
    }

    const excludedAccountNumbers = new Set<number>()
    for (const request of this.limitRecoveries) {
      for (const number of request.excludedAccountNumbers) excludedAccountNumbers.add(number)
      if (request.exhaustedAccountNumber !== null) excludedAccountNumbers.add(request.exhaustedAccountNumber)
    }
    if (activeAccountNumber !== null) excludedAccountNumbers.add(activeAccountNumber)
    const target = this.bestRecoveryAccount(excludedAccountNumbers)
    if (!target) {
      this.notice = 'Claude reached its limit, but no enabled saved account below the switching threshold is ready.'
      this.resolveLimitRecoveries({ kind: 'blocked', reason: 'no-account' })
      return
    }

    try {
      const result = await this.mutate(['switch', String(target.number), '--json'], { keepBusy: true })
      if (result.code !== 0) throw new Error('switch failed')
      await this.refresh(true)
      if (this.cached?.active !== target.number) throw new Error('switch was not confirmed')
    } catch {
      this.notice = 'Claude reached its limit, but the next saved account could not be activated.'
      this.resolveLimitRecoveries({ kind: 'blocked', reason: 'switch-failed' })
      return
    }
    this.manualUntil = this.now() + 5 * 60_000
    this.nextAutoAt = this.manualUntil
    this.notice = `Claude reached its limit. Switched to account ${target.number} and continuing the reply.`
    this.resolveLimitRecoveries({ kind: 'ready', accountNumber: target.number })
  }

  recoverFromLimit(exhaustedAccountNumber: number | null, excludedAccountNumbers: readonly number[]): Promise<ClaudeLimitRecoveryResult> {
    return new Promise((resolve) => {
      const request: LimitRecoveryRequest = {
        exhaustedAccountNumber,
        excludedAccountNumbers: new Set(excludedAccountNumbers.filter((number) => Number.isSafeInteger(number) && number > 0)),
        resolve,
      }
      void this.exclusive(async () => {
        await this.initialize()
        if (this.disposed) {
          resolve({ kind: 'blocked', reason: 'stopped' })
          return
        }
        if (!this.enabled) {
          this.notice = 'Claude reached its limit. Turn on automatic switching to continue on another saved account.'
          resolve({ kind: 'blocked', reason: 'disabled' })
          return
        }
        this.limitRecoveries.push(request)
        await this.applyLimitRecovery()
      }).catch(() => {
        const index = this.limitRecoveries.indexOf(request)
        if (index >= 0) this.limitRecoveries.splice(index, 1)
        this.notice = 'Claude reached its limit, but account recovery failed.'
        resolve({ kind: 'blocked', reason: 'switch-failed' })
      })
    })
  }

  activeAccountNumber(): number | null {
    return this.cached?.active ?? null
  }

  /** Called inside the turn-start lock, before a new Claude process can be created. */
  async beforeTurn(): Promise<void> {
    if (this.disposed) throw new Error('Claude account manager is stopping.')
    if (this.switching) throw new Error('Claude is switching accounts. Send again in a moment.')
    if (this.limitRecoveries.length > 0) {
      await this.applyLimitRecovery()
      throw new Error('Claude is recovering a reply after an account limit. Wait for its continuation to start.')
    }
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
      if (await this.options.isBusy()) throw new Error('Wait for Claude replies or sign-in to finish before removing an account.')
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

  async setAccountEnabled(number: unknown, enabled: unknown): Promise<ClaudeAccountPool> {
    if (!Number.isSafeInteger(number) || Number(number) < 1 || typeof enabled !== 'boolean') {
      throw new Error('Choose a saved Claude account and whether it can be used automatically.')
    }
    await this.exclusive(async () => {
      if (this.options.isAuthenticating?.()) throw new Error('Finish or cancel Claude sign-in before changing account rotation.')
      await this.refresh()
      const account = this.cached?.accounts.find((entry) => entry.number === number)
      if (!account) throw new Error('This saved Claude account is no longer available.')
      if (account.disabled === !enabled) {
        this.notice = enabled ? 'This account is already available to automatic switching.' : 'This account is already excluded from automatic switching.'
        return
      }
      await this.drainReads()
      this.switching = true
      try {
        const result = await this.command([enabled ? 'enable' : 'disable', String(number)])
        if (result.code !== 0) throw new Error(`Could not ${enabled ? 'enable' : 'disable'} automatic switching for this account.`)
        await this.refresh(true)
        const updated = this.cached?.accounts.find((entry) => entry.number === number)
        if (!updated || updated.disabled !== !enabled) throw new Error('claude-swap did not confirm the account rotation change. Refresh and try again.')
      } finally { this.switching = false }
      this.notice = enabled
        ? 'Account enabled for automatic switching.'
        : account.active
          ? 'Account excluded from automatic switching. It stays active until you switch away.'
          : 'Account excluded from automatic switching.'
    })
    return this.snapshot()
  }

  async enrollCurrent(): Promise<ClaudeAccountPool> {
    await this.exclusive(async () => {
      if (await this.options.isBusy()) throw new Error('Wait for Claude replies to finish before saving this login.')
      if (!this.options.executable) throw new Error('Install claude-swap on the host first.')
      await this.saveCurrent()
    })
    return this.snapshot()
  }

  async tick(): Promise<void> {
    if (this.ticking) return this.ticking
    const pending = this.exclusive(async () => {
      await this.initialize()
      if (this.disposed || !this.options.executable) return
      if (this.limitRecoveries.length > 0) {
        await this.applyLimitRecovery()
        return
      }
      if (this.enabled) {
        // Read usage even while busy: a chat that only runs background tasks
        // never sends a request, so no limit error would ever start recovery.
        await this.refresh()
        const exhausted = this.exhaustedActiveAccount()
        if (exhausted !== null) {
          this.limitRecoveries.push({ exhaustedAccountNumber: exhausted, excludedAccountNumbers: new Set(), resolve: () => {} })
          await this.applyLimitRecovery()
          return
        }
      }
      if (await this.options.isBusy()) return
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
    this.resolveLimitRecoveries({ kind: 'blocked', reason: 'stopped' })
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
