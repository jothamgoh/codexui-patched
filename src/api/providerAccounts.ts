import type { ClaudeAccountPool } from '../types/claudeAccounts'

export type ProviderId = 'codex' | 'claude'

export type ProviderStatus = {
  id: ProviderId
  label: string
  connected: boolean
  email: string | null
  organization: string | null
  plan: string | null
  authMethod: string | null
  apiProvider: string | null
  notice?: string
}

export type ProviderStatuses = {
  codex: ProviderStatus
  claude: ProviderStatus
}

export type ClaudeUsageLimit = {
  key: string
  label: string
  usedPercent: number
  resetsAt: string | null
}

export type ClaudeUsage = {
  plan: string | null
  limits: ClaudeUsageLimit[]
  notice?: string
}

export type ProviderLogin = {
  provider: ProviderId
  loginId: string
  authUrl: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null
  if (!response.ok) throw new Error(payload?.error || `Request failed (${String(response.status)})`)
  if (!payload || !('data' in payload)) throw new Error('The provider response was incomplete.')
  return payload.data as T
}

export function getProviderStatuses(force = false): Promise<ProviderStatuses> {
  return request(`/codex-api/providers${force ? '?force=1' : ''}`)
}

export function getClaudeUsage(force = false): Promise<ClaudeUsage | null> {
  return request(`/codex-api/providers/claude/usage${force ? '?force=1' : ''}`)
}

export async function startProviderLogin(provider: ProviderId): Promise<ProviderLogin> {
  const result = await request<Record<string, unknown>>(`/codex-api/providers/${provider}/login/start`, {
    method: 'POST',
  })
  const authUrl = typeof result.authUrl === 'string'
    ? result.authUrl
    : typeof result.auth_url === 'string' ? result.auth_url : ''
  const loginId = typeof result.loginId === 'string'
    ? result.loginId
    : typeof result.login_id === 'string' ? result.login_id : ''
  if (!authUrl) throw new Error(`${provider === 'claude' ? 'Claude' : 'Codex'} did not return a login URL.`)
  return { provider, loginId, authUrl }
}

export function completeClaudeLogin(loginId: string, code: string): Promise<ProviderStatus> {
  return request('/codex-api/providers/claude/login/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, code }),
  })
}

export function logoutProvider(provider: ProviderId): Promise<{ ok: boolean }> {
  return request(`/codex-api/providers/${provider}/logout`, { method: 'POST' })
}

export function getClaudeAccounts(force = false): Promise<ClaudeAccountPool> {
  return request(`/codex-api/providers/claude/accounts${force ? '?force=1' : ''}`)
}

function accountAction(action: string, body: Record<string, unknown> = {}): Promise<ClaudeAccountPool> {
  return request(`/codex-api/providers/claude/accounts/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

export const saveClaudeAccount = (): Promise<ClaudeAccountPool> => accountAction('save')
export const removeClaudeAccount = (number: number): Promise<ClaudeAccountPool> => accountAction('remove', { number })
export const setClaudeAccountEnabled = (number: number, enabled: boolean): Promise<ClaudeAccountPool> => accountAction('rotation', { number, enabled })
export const switchClaudeAccount = (number: number): Promise<ClaudeAccountPool> => accountAction('switch', { number })
export const configureClaudeAccounts = (enabled: boolean, threshold: number): Promise<ClaudeAccountPool> => accountAction('settings', { enabled, threshold })
export const cancelClaudeProviderLogin = (): Promise<{ ok: boolean }> => request('/codex-api/providers/claude/login/cancel', { method: 'POST' })
