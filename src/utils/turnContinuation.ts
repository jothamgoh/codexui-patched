/**
 * Why a finished reply is not the end of a chat's work: the chat will start
 * another reply by itself. Alerts wait for that reply instead of announcing
 * this one as done.
 */
export type TurnContinuation =
  | { reason: 'backgroundWork' }
  | { reason: 'queuedMessage' }
  | { reason: 'scheduledWakeup'; resumesAt: string }
  | { reason: 'limitRetry' }
  | { reason: 'goal' }

/** The continuation a `turn/completed` notification carries, if any. */
export function readTurnContinuation(params: unknown): TurnContinuation | null {
  if (!params || typeof params !== 'object') return null
  const value = (params as { codexuiContinuation?: unknown }).codexuiContinuation
  if (!value || typeof value !== 'object') return null
  const { reason, resumesAt } = value as Record<string, unknown>
  switch (reason) {
    case 'backgroundWork':
    case 'queuedMessage':
    case 'limitRetry':
    case 'goal':
      return { reason }
    case 'scheduledWakeup':
      return typeof resumesAt === 'string' && Number.isFinite(Date.parse(resumesAt)) ? { reason, resumesAt } : null
    default:
      return null
  }
}
