export type CodexThreadSourceClassification = {
  kind: 'interactive' | 'internalSubagent'
  isInternalSubagent: boolean
  parentThreadId: string | null
}

export type CodexThreadAudience = 'interactive' | 'internalSubagent' | 'unknown'

export const CODEX_SUBAGENT_SOURCE_KINDS = [
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
] as const

const NORMALIZED_SUBAGENT_SOURCE_KINDS = new Set([
  'subagent',
  'subagentreview',
  'subagentcompact',
  'subagentthreadspawn',
  'subagentother',
  'subagentmemoryconsolidation',
])
const MAX_THREAD_LIST_PAGES_PER_ARCHIVE_STATE = 1_000

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function hasOwn(record: Record<string, unknown> | null, key: string): boolean {
  return record !== null && Object.prototype.hasOwnProperty.call(record, key)
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = readString(value)
    if (normalized) return normalized
  }
  return null
}

function normalizeSourceKind(value: unknown): string {
  const sourceKind = readString(value)
  if (!sourceKind) return ''
  return sourceKind.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

export function isSubagentSourceKind(value: unknown): boolean {
  return NORMALIZED_SUBAGENT_SOURCE_KINDS.has(normalizeSourceKind(value))
}

export function classifyCodexThreadSource(value: unknown): CodexThreadSourceClassification {
  const threadRecord = asRecord(value)
  const source = hasOwn(threadRecord, 'source') ? threadRecord?.source : value
  const sourceRecord = asRecord(source)
  const hasSubagentWrapper =
    hasOwn(sourceRecord, 'subAgent') ||
    hasOwn(sourceRecord, 'subagent')
  const subagent = hasOwn(sourceRecord, 'subAgent')
    ? sourceRecord?.subAgent
    : sourceRecord?.subagent
  const subagentRecord = asRecord(subagent)
  const spawn = hasOwn(subagentRecord, 'thread_spawn')
    ? subagentRecord?.thread_spawn
    : subagentRecord?.threadSpawn
  const spawnRecord = asRecord(spawn)

  const parentThreadId = firstString(
    threadRecord?.parentThreadId,
    threadRecord?.parent_thread_id,
    sourceRecord?.parentThreadId,
    sourceRecord?.parent_thread_id,
    subagentRecord?.parentThreadId,
    subagentRecord?.parent_thread_id,
    spawnRecord?.parentThreadId,
    spawnRecord?.parent_thread_id,
  )

  const hasSubagentSourceKind = [
    source,
    threadRecord?.sourceKind,
    threadRecord?.source_kind,
    threadRecord?.threadSource,
    threadRecord?.thread_source,
    sourceRecord?.sourceKind,
    sourceRecord?.source_kind,
    sourceRecord?.kind,
    sourceRecord?.type,
  ].some(isSubagentSourceKind)

  const isInternalSubagent = Boolean(
    parentThreadId ||
    hasSubagentWrapper ||
    hasSubagentSourceKind,
  )

  return {
    kind: isInternalSubagent ? 'internalSubagent' : 'interactive',
    isInternalSubagent,
    parentThreadId,
  }
}

export function isInternalSubagentThread(value: unknown): boolean {
  return classifyCodexThreadSource(value).isInternalSubagent
}

export function readSubagentParentThreadId(value: unknown): string | null {
  return classifyCodexThreadSource(value).parentThreadId
}

export function readCodexThreadAudience(value: unknown): CodexThreadAudience {
  if (isInternalSubagentThread(value)) return 'internalSubagent'

  const record = asRecord(value)
  if (typeof value === 'string' && readString(value)) return 'interactive'
  if (!record) return 'unknown'

  const source = hasOwn(record, 'source') ? record.source : undefined
  const sourceRecord = asRecord(source)
  const explicitSourceValues = [
    source,
    record.sourceKind,
    record.source_kind,
    record.threadSource,
    record.thread_source,
    sourceRecord?.sourceKind,
    sourceRecord?.source_kind,
    sourceRecord?.kind,
    sourceRecord?.type,
  ]
  return explicitSourceValues.some((candidate) => readString(candidate) !== null)
    ? 'interactive'
    : 'unknown'
}

type CodexNotification = {
  method: string
  params: unknown
}

type ThreadListPage = {
  data?: unknown
  nextCursor?: unknown
}

export type CodexThreadListRequest = (params: Record<string, unknown>) => Promise<unknown>
export type CodexThreadReadRequest = (threadId: string) => Promise<unknown>

export function readCodexNotificationThreadId(notification: CodexNotification): string | null {
  const params = asRecord(notification.params)
  const thread = asRecord(params?.thread)
  return firstString(
    params?.threadId,
    params?.thread_id,
    thread?.id,
  )
}

export function readInternalSubagentThreadIdFromNotification(
  notification: CodexNotification,
): string | null {
  const threadId = readCodexNotificationThreadId(notification)
  if (!threadId) return null

  const params = asRecord(notification.params)
  const thread = asRecord(params?.thread)
  if (thread && isInternalSubagentThread(thread)) return threadId
  if (params && isInternalSubagentThread(params)) return threadId
  return null
}

export class CodexThreadAudienceTracker {
  private readonly audienceByThreadId = new Map<string, Exclude<CodexThreadAudience, 'unknown'>>()

  addInternalThreadIds(threadIds: Iterable<string>): void {
    for (const threadId of threadIds) {
      const normalized = threadId.trim()
      if (normalized) this.audienceByThreadId.set(normalized, 'internalSubagent')
    }
  }

  observeThread(value: unknown): CodexThreadAudience {
    const thread = asRecord(value)
    const threadId = readString(thread?.id)
    const audience = readCodexThreadAudience(thread)
    if (threadId && audience !== 'unknown') this.audienceByThreadId.set(threadId, audience)
    return audience
  }

  observeNotification(notification: CodexNotification): CodexThreadAudience {
    const threadId = readCodexNotificationThreadId(notification)
    if (!threadId) return 'unknown'

    const params = asRecord(notification.params)
    const thread = asRecord(params?.thread)
    const audience = readCodexThreadAudience(thread ?? params)
    if (audience !== 'unknown') this.audienceByThreadId.set(threadId, audience)
    return audience === 'unknown' ? this.getAudience(threadId) : audience
  }

  getAudience(threadId: string): CodexThreadAudience {
    return this.audienceByThreadId.get(threadId.trim()) ?? 'unknown'
  }

  snapshotInternalThreadIds(): Set<string> {
    return new Set(
      [...this.audienceByThreadId.entries()]
        .filter(([, audience]) => audience === 'internalSubagent')
        .map(([threadId]) => threadId),
    )
  }
}

export async function resolveCodexThreadAudience(
  threadId: string,
  tracker: CodexThreadAudienceTracker,
  readThread: CodexThreadReadRequest,
): Promise<CodexThreadAudience> {
  const knownAudience = tracker.getAudience(threadId)
  if (knownAudience !== 'unknown') return knownAudience

  const payload = asRecord(await readThread(threadId))
  const thread = asRecord(payload?.thread)
  if (!thread || readString(thread.id) !== threadId) return 'unknown'
  return tracker.observeThread(thread)
}

export async function loadInternalSubagentThreadIds(
  listThreads: CodexThreadListRequest,
): Promise<Set<string>> {
  const threadIds = new Set<string>()

  for (const archived of [false, true]) {
    let cursor: string | null = null
    const visitedCursors = new Set<string>()

    for (let page = 0; page < MAX_THREAD_LIST_PAGES_PER_ARCHIVE_STATE; page += 1) {
      const payload = asRecord(await listThreads({
        archived,
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sourceKinds: [...CODEX_SUBAGENT_SOURCE_KINDS],
      })) as ThreadListPage | null
      const threads = Array.isArray(payload?.data) ? payload.data : []
      for (const candidate of threads) {
        const thread = asRecord(candidate)
        const threadId = readString(thread?.id)
        if (threadId && isInternalSubagentThread(thread)) threadIds.add(threadId)
      }

      const nextCursor = readString(payload?.nextCursor)
      if (!nextCursor || visitedCursors.has(nextCursor)) break
      visitedCursors.add(nextCursor)
      cursor = nextCursor
    }
  }

  return threadIds
}
