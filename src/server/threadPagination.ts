export const DEFAULT_THREAD_PAGE_SIZE = 20
export const MAX_THREAD_PAGE_SIZE = 50

export type ThreadPageMetadata = {
  startTurnIndex: number
  endTurnIndex: number
  totalTurns: number
  hasEarlier: boolean
}

export type PaginatedThreadReadResult = {
  thread: Record<string, unknown> & { turns: unknown[] }
  page: ThreadPageMetadata
}

type ThreadResumeRpc = {
  rpc(method: string, params: unknown): Promise<unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), minimum), maximum)
}

export function paginateThreadReadResult(
  result: unknown,
  options: { beforeTurnIndex?: number | null; limit?: number } = {},
): PaginatedThreadReadResult {
  const response = asRecord(result)
  const thread = asRecord(response?.thread)
  if (!thread) {
    throw new Error('thread/read returned a malformed thread')
  }

  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const totalTurns = turns.length
  const endTurnIndex = options.beforeTurnIndex === null || options.beforeTurnIndex === undefined
    ? totalTurns
    : clampInteger(options.beforeTurnIndex, totalTurns, 0, totalTurns)
  const limit = clampInteger(
    options.limit,
    DEFAULT_THREAD_PAGE_SIZE,
    1,
    MAX_THREAD_PAGE_SIZE,
  )
  const startTurnIndex = Math.max(0, endTurnIndex - limit)

  return {
    thread: {
      ...thread,
      turns: turns.slice(startTurnIndex, endTurnIndex),
    },
    page: {
      startTurnIndex,
      endTurnIndex,
      totalTurns,
      hasEarlier: startTurnIndex > 0,
    },
  }
}

export function stripThreadTurnsFromResumeResult(result: unknown): unknown {
  const response = asRecord(result)
  const thread = asRecord(response?.thread)
  if (!response || !thread) return result

  return {
    ...response,
    thread: {
      ...thread,
      turns: [],
    },
  }
}

export async function resumeThreadLite(
  appServer: ThreadResumeRpc,
  threadId: string,
): Promise<unknown> {
  const result = await appServer.rpc('thread/resume', {
    threadId,
    excludeTurns: true,
  })
  return stripThreadTurnsFromResumeResult(result)
}
