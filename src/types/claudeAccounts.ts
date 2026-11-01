export type ClaudeSavedAccount = {
  number: number
  email: string
  alias: string | null
  organization: string | null
  active: boolean
  disabled: boolean
  usageStatus: string
  usageIsStale: boolean
  usageRateLimited: boolean
  /** cswap's latest usage-check failure, such as `http-403`; null after a good read. */
  usageError: string | null
  usageRetryAt: string | null
  usageFetchedAt: string | null
  limits: Array<{ label: string; usedPercent: number; resetsAt: string | null }>
}

export type ClaudeAccountPool = {
  installed: boolean
  enabled: boolean
  threshold: number
  activeAccountNumber: number | null
  pendingAccountNumber: number | null
  switching: boolean
  accounts: ClaudeSavedAccount[]
  notice: string | null
  checkedAt: string | null
  nextCheckAt: string | null
}
