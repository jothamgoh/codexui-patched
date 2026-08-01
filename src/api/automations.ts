import type { AutomationDraft, AutomationSnapshot } from '../types/automations'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

async function requestSnapshot(path: string, init?: RequestInit): Promise<AutomationSnapshot> {
  const response = await fetch(path, init)
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const message = asRecord(payload)?.error
    throw new Error(typeof message === 'string' ? message : `Scheduled task request failed (${String(response.status)})`)
  }
  const snapshot = asRecord(payload)?.data
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Scheduled task response was invalid.')
  return snapshot as AutomationSnapshot
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

export function getAutomations(): Promise<AutomationSnapshot> {
  return requestSnapshot('/codex-api/automations')
}

export function createAutomation(draft: AutomationDraft): Promise<AutomationSnapshot> {
  return requestSnapshot('/codex-api/automations', jsonRequest('POST', draft))
}

export function updateAutomation(id: string, changes: Partial<AutomationDraft>): Promise<AutomationSnapshot> {
  return requestSnapshot(`/codex-api/automations/${encodeURIComponent(id)}`, jsonRequest('PATCH', changes))
}

export function deleteAutomation(id: string): Promise<AutomationSnapshot> {
  return requestSnapshot(`/codex-api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function runAutomationNow(id: string): Promise<AutomationSnapshot> {
  return requestSnapshot(`/codex-api/automations/${encodeURIComponent(id)}/run`, { method: 'POST' })
}

export function resolveAutomationProposal(id: string, accept: boolean): Promise<AutomationSnapshot> {
  return requestSnapshot(
    `/codex-api/automation-proposals/${encodeURIComponent(id)}/resolve`,
    jsonRequest('POST', { accept }),
  )
}

export function updateAutomationRun(
  id: string,
  changes: { unread?: boolean; archived?: boolean },
): Promise<AutomationSnapshot> {
  return requestSnapshot(
    `/codex-api/automation-runs/${encodeURIComponent(id)}`,
    jsonRequest('PATCH', changes),
  )
}
