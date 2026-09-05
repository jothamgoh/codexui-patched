import type { UiMessage } from '../types/codex'

/** Keep the native final-answer phase after work in its own turn, even when
 * late tool events and a history refresh arrive in a different order. */
export function sortMessagesByOrder(messages: UiMessage[]): UiMessage[] {
  const compareOrder = (first: UiMessage, second: UiMessage) =>
    (first.orderKey ?? '').localeCompare(second.orderKey ?? '')
  const groups = new Map<string, UiMessage[]>()
  for (const message of [...messages].sort(compareOrder)) {
    const key = message.turnId ? `turn:${message.turnId}` : `message:${message.id}`
    const group = groups.get(key)
    if (group) group.push(message)
    else groups.set(key, [message])
  }
  // Group before applying phase order: comparing phase only for same-turn
  // pairs can produce a circular comparator when a late live key is stale.
  const rank = (message: UiMessage) => message.messageType === 'turnDiff' ? 2
    : message.phase === 'final_answer' ? 1 : 0
  const next = [...groups.values()].flatMap((group) =>
    group.sort((first, second) => rank(first) - rank(second) || compareOrder(first, second)),
  )
  return next.every((message, index) => message === messages[index]) ? messages : next
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '<1s'
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return [hours ? `${hours}h` : '', minutes || hours ? `${minutes}m` : '', `${seconds % 60}s`]
    .filter(Boolean).join(' ')
}

export function insertTurnSummaryMessages(
  messages: UiMessage[],
  summaries: Array<{ turnId: string; durationMs: number }>,
): UiMessage[] {
  if (!summaries.length) return messages
  const summaryByTurn = new Map(summaries.map((summary) => [summary.turnId, summary]))
  const anchorByTurn = new Map<string, string>()
  for (const message of messages) {
    if (!message.turnId || message.role !== 'assistant') continue
    // Old runtimes have no phase. Explicit commentary must never look like a final answer.
    if (message.phase === 'commentary') continue
    anchorByTurn.set(message.turnId, message.id)
  }
  return messages.flatMap((message) => {
    if (message.messageType === 'worked') return []
    const summary = message.turnId ? summaryByTurn.get(message.turnId) : undefined
    if (!summary || anchorByTurn.get(summary.turnId) !== message.id) return [message]
    return [{
      id: `turn-summary:${summary.turnId}`,
      role: 'system' as const,
      text: `Worked for ${formatDuration(summary.durationMs)}`,
      messageType: 'worked',
      turnId: summary.turnId,
      turnIndex: message.turnIndex,
    }, message]
  })
}
