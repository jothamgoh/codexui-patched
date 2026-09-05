import type { SubAgentActivityData, UiMessage } from '../types/codex'

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

function agentName(path: unknown): string {
  if (typeof path !== 'string') return ''
  const leaf = path.split('/').map((part) => part.trim()).filter((part) => part && part !== 'root').at(-1)
  const name = leaf?.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').toLowerCase() ?? ''
  return name ? text(name[0]!.toUpperCase() + name.slice(1), 120) : ''
}

/** Shared by persisted items and item/started + item/completed notifications. */
export function normalizeSubAgentActivity(item: Record<string, unknown>): UiMessage | null {
  if (text(item.type, 80).replace(/[_\s-]/gu, '').toLowerCase() !== 'subagentactivity') return null
  const id = text(item.id, 512)
  if (!id) return null

  // The event's kind describes the agent; item/completed only closes the event.
  const kinds = new Map<string, [SubAgentActivityData['status'], string]>([
    ['started', ['active', 'Started working']],
    ['interacted', ['updated', 'Updated']],
    ['interrupted', ['interrupted', 'Interrupted']],
    ['completed', ['completed', 'Finished']],
  ])
  const [status, statusLabel] = kinds.get(text(item.kind, 80)) ?? ['unknown', 'Activity']
  const rawThreadId = item.agentThreadId ?? item.agent_thread_id
  const threadId = typeof rawThreadId === 'string' && rawThreadId.trim().length <= 512
    ? rawThreadId.trim() || null
    : null
  const name = text(item.name ?? item.agentNickname, 120)
    || agentName(item.agentPath ?? item.agent_path)
    || 'Agent'
  const task = text(item.prompt ?? item.task ?? item.objective, 600) || null
  return {
    id,
    role: 'system',
    text: `${name} ${statusLabel.toLowerCase()}`,
    messageType: 'subAgentActivity',
    subAgentActivity: { threadId, name, status, statusLabel, task },
  }
}
