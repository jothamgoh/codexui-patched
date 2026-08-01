import {
  fetchRpcMethodCatalog,
  fetchRpcNotificationCatalog,
  fetchPendingServerRequests,
  rpcCall,
  respondServerRequest,
  subscribeInPageRpcNotifications,
  subscribeRpcNotifications,
  type RpcNotification,
  type SubscribeOptions,
} from './codexRpcClient'
import type {
  ConfigReadResponse,
  GetAccountRateLimitsResponse,
  ListMcpServerStatusResponse,
  McpAuthStatus,
  ModelListResponse,
  RateLimitSnapshot,
  ThreadForkResponse,
  Thread,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
} from './appServerDtos'
import { CodexApiError, extractErrorMessage, normalizeCodexApiError } from './codexErrors'
import { getInProgressTurnStateV2, normalizeThreadGroupsV2, normalizeThreadMessagesV2, normalizeThreadV2 } from './normalizers/v2'
import { compactNotificationText } from '../utils/notificationText'
import type {
  ReasoningEffort,
  ResponseTextAnnotation,
  ThreadGoalStatus,
  UiMessage,
  UiProjectGroup,
  UiThread,
  UiThreadGoal,
} from '../types/codex'

type CurrentModelConfig = {
  model: string
  reasoningEffort: ReasoningEffort | ''
}

export type CodexUiRuntimeConfig = {
  defaultReasoningEffort: ReasoningEffort | ''
}

export type ThreadModelConfig = {
  model: string
  reasoningEffort: ReasoningEffort | ''
}

export type ThreadSearchResult = {
  thread: UiThread
  snippet: string
}

export type ThreadMessagePage = {
  messages: UiMessage[]
  isInProgress: boolean
  activeTurnId: string
  turnSummaries: ThreadTurnSummary[]
  startTurnIndex: number
  endTurnIndex: number
  totalTurns: number
  hasEarlier: boolean
}

type ThreadSearchResponse = {
  data?: Array<{
    thread?: Thread
    snippet?: string | null
  }>
}

export type WorkspaceRootsState = {
  order: string[]
  labels: Record<string, string>
  active: string[]
}

export type ComposerFileSuggestion = {
  path: string
}

export type McpTransportType = 'local' | 'remote' | 'unknown'

export type McpServerRecord = {
  name: string
  enabled: boolean
  transportType: McpTransportType
  command: string
  args: string[]
  url: string
  envKeys: string[]
  bearerTokenEnvVar: string
  authStatus: McpAuthStatus | 'unknown'
  toolCount: number
  resourceCount: number
  resourceTemplateCount: number
  toolNames: string[]
}

export type McpAppResource = {
  uri: string
  mimeType: string
  text: string
  meta: Record<string, unknown>
}

const mcpAppResourceCache = new Map<string, Promise<McpAppResource | null>>()

export type AccountRateLimitsState = {
  defaultSnapshot: RateLimitSnapshot | null
  byLimitId: Record<string, RateLimitSnapshot>
  rateLimitResetCredits: {
    availableCount: number
    credits: RateLimitResetCredit[]
  }
}

export type RateLimitResetCredit = {
  status: string
  expiresAt: string | null
  title: string | null
}

type RateLimitResetCreditConsumeResponse = {
  code?: string
}

type PinnedThreadsResponse = {
  data?: {
    threadIds?: unknown
  }
}

export type SetThreadPinnedParams = {
  threadId: string
  pinned: boolean
  beforeThreadId?: string
}

export type SharedThreadReadState = {
  readAtByThreadId: Record<string, string>
  unreadThreadIds: string[]
  version: number
}

type ThreadGoalGetResponse = {
  goal: UiThreadGoal | null
}

type ThreadGoalSetResponse = {
  goal: UiThreadGoal
}

type ThreadGoalClearResponse = {
  cleared: boolean
}

export type ThreadTurnSummary = {
  turnId: string
  durationMs: number
}

export type PluginMentionParam = {
  id: string
  name: string
  displayName: string
  description: string
  path: string
}

export type ThreadMentionParam = {
  id: string
  name: string
  path: string
}

export type PluginCatalogItem = PluginMentionParam & {
  longDescription: string
  developerName: string
  category: string
  capabilities: string[]
  marketplaceName: string
  marketplacePath: string
  installed: boolean
  enabled: boolean
  featured: boolean
  availability: 'AVAILABLE' | 'DISABLED_BY_ADMIN'
  installPolicy: 'NOT_AVAILABLE' | 'AVAILABLE' | 'INSTALLED_BY_DEFAULT'
  installPolicySource: string
  authPolicy: 'ON_INSTALL' | 'ON_USE'
  version: string
  sourceType: string
}

export type PluginCatalogResult = {
  plugins: PluginCatalogItem[]
  loadErrors: Array<{ marketplacePath: string; message: string }>
}

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return await rpcCall<T>(method, params)
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

async function callBridgeEndpoint<T>(path: string, body: unknown, method: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new CodexApiError(
      error instanceof Error ? error.message : `${method} failed before request was sent`,
      { code: 'network_error', method },
    )
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `${method} failed with HTTP ${response.status}`),
      { code: 'http_error', method, status: response.status },
    )
  }

  const envelope = asRecord(payload)
  if (!envelope || !('result' in envelope)) {
    throw new CodexApiError(`${method} returned a malformed envelope`, {
      code: 'invalid_response',
      method,
      status: response.status,
    })
  }
  return envelope.result as T
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  const allowed: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  return typeof value === 'string' && allowed.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : ''
}

function normalizeThreadTurnSummaries(payload: ThreadReadResponse): ThreadTurnSummary[] {
  const thread = asRecord(payload.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const summaries: ThreadTurnSummary[] = []

  for (const rawTurn of turns) {
    const turn = asRecord(rawTurn)
    if (!turn) continue
    const turnId = readString(turn.id)
    const durationMs = readNumber(turn.durationMs)
    const status = readString(turn.status)
    if (!turnId || durationMs === null || durationMs < 0 || status === 'inProgress') continue
    summaries.push({ turnId, durationMs })
  }

  return summaries
}

function normalizeThreadGoalStatus(value: unknown): ThreadGoalStatus | null {
  switch (value) {
    case 'active':
    case 'paused':
    case 'blocked':
    case 'usageLimited':
    case 'budgetLimited':
    case 'complete':
      return value
    default:
      return null
  }
}

function pick(record: Record<string, unknown>, camelKey: string, snakeKey: string): unknown {
  if (camelKey in record) return record[camelKey]
  if (snakeKey in record) return record[snakeKey]
  return null
}

function normalizeRateLimitWindow(value: unknown): RateLimitSnapshot['primary'] {
  const record = asRecord(value)
  if (!record) return null

  const usedPercent = readNumber(pick(record, 'usedPercent', 'used_percent'))
  if (usedPercent === null) return null

  return {
    usedPercent,
    windowDurationMins: readNumber(pick(record, 'windowDurationMins', 'window_minutes')),
    resetsAt: readNumber(pick(record, 'resetsAt', 'resets_at')),
  }
}

function normalizePlanType(value: unknown): RateLimitSnapshot['planType'] {
  switch (value) {
    case 'free':
    case 'go':
    case 'plus':
    case 'pro':
    case 'team':
    case 'business':
    case 'enterprise':
    case 'edu':
    case 'unknown':
      return value
    default:
      return null
  }
}

function normalizeRateLimitResetCredit(value: unknown): RateLimitResetCredit | null {
  const record = asRecord(value)
  if (!record) return null

  const status = readString(pick(record, 'status', 'status'))
  const expiresAt = readString(pick(record, 'expiresAt', 'expires_at')) || null
  const title = readString(pick(record, 'title', 'title')) || null
  if (!status && !expiresAt) return null
  return { status, expiresAt, title }
}

function normalizeRateLimitResetCreditsPayload(value: unknown): AccountRateLimitsState['rateLimitResetCredits'] {
  const record = asRecord(value)
  if (!record) return { availableCount: 0, credits: [] }

  const nested = asRecord(pick(record, 'rateLimitResetCredits', 'rate_limit_reset_credits'))
  const source = nested ?? record
  const credits = Array.isArray(source.credits)
    ? source.credits
      .map(normalizeRateLimitResetCredit)
      .filter((credit): credit is RateLimitResetCredit => credit !== null)
      .sort((a, b) => {
        const first = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY
        const second = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY
        return first - second
      })
    : []
  const availableCount = readNumber(pick(source, 'availableCount', 'available_count'))
    ?? credits.filter((credit) => credit.status === 'available').length

  return {
    availableCount: Math.max(0, Math.round(availableCount)),
    credits,
  }
}

export function normalizeRateLimitSnapshotPayload(value: unknown): RateLimitSnapshot | null {
  const record = asRecord(value)
  if (!record) return null

  const creditsRecord = asRecord(pick(record, 'credits', 'credits'))
  return {
    limitId: readString(pick(record, 'limitId', 'limit_id')) || null,
    limitName: readString(pick(record, 'limitName', 'limit_name')) || null,
    primary: normalizeRateLimitWindow(pick(record, 'primary', 'primary')),
    secondary: normalizeRateLimitWindow(pick(record, 'secondary', 'secondary')),
    credits: creditsRecord
      ? {
          hasCredits: pick(creditsRecord, 'hasCredits', 'has_credits') === true,
          unlimited: pick(creditsRecord, 'unlimited', 'unlimited') === true,
          balance: readString(pick(creditsRecord, 'balance', 'balance')) || null,
        }
      : null,
    planType: normalizePlanType(pick(record, 'planType', 'plan_type')),
  }
}

export function normalizeAccountRateLimitsPayload(payload: unknown): AccountRateLimitsState {
  const record = asRecord(payload)
  if (!record) {
    return {
      defaultSnapshot: null,
      byLimitId: {},
      rateLimitResetCredits: {
        availableCount: 0,
        credits: [],
      },
    }
  }

  const byLimitId: Record<string, RateLimitSnapshot> = {}
  const rawByLimitId = asRecord(pick(record, 'rateLimitsByLimitId', 'rate_limits_by_limit_id'))
  if (rawByLimitId) {
    for (const [limitId, rawSnapshot] of Object.entries(rawByLimitId)) {
      const snapshot = normalizeRateLimitSnapshotPayload(rawSnapshot)
      if (!snapshot) continue
      if (!snapshot.limitId && limitId.trim().length > 0) {
        snapshot.limitId = limitId.trim()
      }
      byLimitId[snapshot.limitId ?? limitId] = snapshot
    }
  }

  const defaultSnapshot = normalizeRateLimitSnapshotPayload(pick(record, 'rateLimits', 'rate_limits'))
  const defaultLimitId = defaultSnapshot?.limitId?.trim() ?? ''
  if (defaultSnapshot && defaultLimitId && !byLimitId[defaultLimitId]) {
    byLimitId[defaultLimitId] = defaultSnapshot
  }

  return {
    defaultSnapshot,
    byLimitId,
    rateLimitResetCredits: normalizeRateLimitResetCreditsPayload(record),
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const next: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0 && !next.includes(item.trim())) {
      next.push(item.trim())
    }
  }
  return next
}

function deepCopyJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeThreadGoal(value: unknown): UiThreadGoal | null {
  const record = asRecord(value)
  if (!record) return null

  const threadId = readString(pick(record, 'threadId', 'thread_id'))
  const objective = readString(pick(record, 'objective', 'objective'))
  const status = normalizeThreadGoalStatus(pick(record, 'status', 'status'))
  const tokensUsed = readNumber(pick(record, 'tokensUsed', 'tokens_used'))
  const timeUsedSeconds = readNumber(pick(record, 'timeUsedSeconds', 'time_used_seconds'))
  const createdAt = readNumber(pick(record, 'createdAt', 'created_at'))
  const updatedAt = readNumber(pick(record, 'updatedAt', 'updated_at'))

  if (!threadId || !objective || !status || tokensUsed === null || timeUsedSeconds === null || createdAt === null || updatedAt === null) {
    return null
  }

  const tokenBudget = readNumber(pick(record, 'tokenBudget', 'token_budget'))

  return {
    threadId,
    objective,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  }
}

async function getThreadGroupsV2(): Promise<UiProjectGroup[]> {
  const payload = await callRpc<ThreadListResponse>('thread/list', {
    archived: false,
    limit: 100,
    sortKey: 'updated_at',
  })
  return normalizeThreadGroupsV2(payload)
}

async function getThreadMessagesV2(threadId: string): Promise<UiMessage[]> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  })
  return normalizeThreadMessagesV2(payload)
}

export async function getThreadGroups(): Promise<UiProjectGroup[]> {
  try {
    return await getThreadGroupsV2()
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load thread groups', 'thread/list')
  }
}

export async function searchThreads(query: string, limit = 50): Promise<ThreadSearchResult[]> {
  const searchTerm = query.trim()
  if (!searchTerm) return []

  try {
    const payload = await callRpc<ThreadSearchResponse>('thread/search', {
      archived: false,
      limit,
      searchTerm,
      sortKey: 'updated_at',
    })

    return (payload.data ?? []).flatMap((result) => {
      if (!result.thread) return []
      return [{
        thread: normalizeThreadV2(result.thread),
        snippet: compactNotificationText(result.snippet ?? '', '', 280),
      }]
    })
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to search chats', 'thread/search')
  }
}

export async function getThreadSummary(threadId: string): Promise<UiThread> {
  try {
    const payload = await callRpc<ThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: false,
    })
    return normalizeThreadV2(payload.thread)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getThreadMessages(threadId: string): Promise<UiMessage[]> {
  try {
    return await getThreadMessagesV2(threadId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getThreadMessagesWithStatus(
  threadId: string,
  options: { beforeTurnIndex?: number; limit?: number } = {},
): Promise<ThreadMessagePage> {
  try {
    const payload = await callBridgeEndpoint<
      ThreadReadResponse & {
        page: {
          startTurnIndex: number
          endTurnIndex: number
          totalTurns: number
          hasEarlier: boolean
        }
      }
    >('/codex-api/thread-page', {
      threadId,
      beforeTurnIndex: options.beforeTurnIndex,
      limit: options.limit,
    }, 'thread/read')
    const turnState = getInProgressTurnStateV2(payload)
    return {
      messages: normalizeThreadMessagesV2(payload, payload.page.startTurnIndex),
      isInProgress: turnState.isInProgress,
      activeTurnId: turnState.activeTurnId,
      turnSummaries: normalizeThreadTurnSummaries(payload),
      ...payload.page,
    }
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getThreadGoal(threadId: string): Promise<UiThreadGoal | null> {
  try {
    const payload = await callRpc<ThreadGoalGetResponse>('thread/goal/get', { threadId })
    return normalizeThreadGoal(payload.goal)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread goal for ${threadId}`, 'thread/goal/get')
  }
}

export async function setThreadGoal(
  threadId: string,
  params: {
    objective?: string | null
    status?: ThreadGoalStatus | null
    tokenBudget?: number | null
  },
): Promise<UiThreadGoal> {
  try {
    const payload = await callRpc<ThreadGoalSetResponse>('thread/goal/set', {
      threadId,
      objective: params.objective ?? undefined,
      status: params.status ?? undefined,
      tokenBudget: typeof params.tokenBudget === 'number' ? params.tokenBudget : params.tokenBudget ?? undefined,
    })
    const goal = normalizeThreadGoal(payload.goal)
    if (!goal) {
      throw new Error('thread/goal/set returned invalid goal')
    }
    return goal
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to update thread goal for ${threadId}`, 'thread/goal/set')
  }
}

export async function clearThreadGoal(threadId: string): Promise<boolean> {
  try {
    const payload = await callRpc<ThreadGoalClearResponse>('thread/goal/clear', { threadId })
    return payload.cleared === true
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to clear thread goal for ${threadId}`, 'thread/goal/clear')
  }
}

export async function getMethodCatalog(): Promise<string[]> {
  return fetchRpcMethodCatalog()
}

export async function getNotificationCatalog(): Promise<string[]> {
  return fetchRpcNotificationCatalog()
}

export function subscribeCodexNotifications(
  onNotificationOrOpts: ((value: RpcNotification) => void) | SubscribeOptions,
): () => void {
  return subscribeRpcNotifications(onNotificationOrOpts)
}

export function subscribeCodexInPageNotifications(
  listener: (value: RpcNotification) => void,
): () => void {
  return subscribeInPageRpcNotifications(listener)
}

export type { RpcNotification, SubscribeOptions }

export async function replyToServerRequest(
  id: number,
  payload: { result?: unknown; error?: { code?: number; message: string } },
): Promise<void> {
  await respondServerRequest({
    id,
    ...payload,
  })
}

export async function getPendingServerRequests(): Promise<unknown[]> {
  return fetchPendingServerRequests()
}

function normalizeThreadModelConfig(payload: ThreadResumeResponse | ThreadStartResponse): ThreadModelConfig {
  return {
    model: typeof payload.model === 'string' ? payload.model.trim() : '',
    reasoningEffort: normalizeReasoningEffort(payload.reasoningEffort),
  }
}

export async function resumeThread(threadId: string): Promise<ThreadModelConfig> {
  const payload = await callBridgeEndpoint<ThreadResumeResponse>(
    '/codex-api/thread-resume-lite',
    { threadId },
    'thread/resume',
  )
  return normalizeThreadModelConfig(payload)
}

export async function archiveThread(threadId: string): Promise<void> {
  await callRpc('thread/archive', { threadId })
}

export async function setThreadName(threadId: string, name: string): Promise<void> {
  await callRpc('thread/name/set', { threadId, name })
}

export async function rollbackThread(threadId: string, numTurns: number): Promise<UiMessage[]> {
  const payload = await callRpc<ThreadReadResponse>('thread/rollback', { threadId, numTurns })
  return normalizeThreadMessagesV2(payload)
}

export type ForkedThread = {
  threadId: string
  messages: UiMessage[]
  modelConfig: ThreadModelConfig
}

export async function forkThread(
  threadId: string,
  options: { cwd?: string; numTurnsToDrop?: number } = {},
): Promise<ForkedThread> {
  try {
    const params: Record<string, unknown> = {
      threadId,
      persistExtendedHistory: true,
    }
    const cwd = options.cwd?.trim() ?? ''
    if (cwd) params.cwd = cwd

    const forkPayload = await callRpc<ThreadForkResponse>('thread/fork', params)
    const forkedThreadId = normalizeThreadIdFromPayload(forkPayload)
    if (!forkedThreadId) {
      throw new Error('thread/fork did not return a thread id')
    }

    const numTurnsToDrop = Math.max(0, Math.floor(options.numTurnsToDrop ?? 0))
    const historyPayload: ThreadReadResponse = numTurnsToDrop > 0
      ? await callRpc<ThreadReadResponse>('thread/rollback', {
          threadId: forkedThreadId,
          numTurns: numTurnsToDrop,
        })
      : forkPayload

    return {
      threadId: forkedThreadId,
      messages: normalizeThreadMessagesV2(historyPayload),
      modelConfig: normalizeThreadModelConfig(forkPayload),
    }
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to fork thread ${threadId}`, 'thread/fork')
  }
}

export async function createWorktree(cwd: string): Promise<string> {
  const response = await fetch('/codex-api/worktree', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: cwd.trim() }),
  })
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const record = asRecord(payload)
    throw new Error(typeof record?.error === 'string' ? record.error : `Failed to create worktree (${String(response.status)})`)
  }
  const record = asRecord(payload)
  const data = asRecord(record?.data)
  const path = readString(data?.path)
  if (!path) throw new Error('Worktree creation did not return a path')
  return path
}

function normalizeThreadIdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  const thread = record.thread
  if (thread && typeof thread === 'object') {
    const threadId = (thread as Record<string, unknown>).id
    if (typeof threadId === 'string' && threadId.length > 0) {
      return threadId
    }
  }
  return ''
}

export async function startThread(cwd?: string, model?: string): Promise<{ threadId: string; modelConfig: ThreadModelConfig }> {
  try {
    const params: Record<string, unknown> = {}
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      params.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      params.model = model.trim()
    }
    const payload = await callRpc<ThreadStartResponse>('thread/start', params)
    const threadId = normalizeThreadIdFromPayload(payload)
    if (!threadId) {
      throw new Error('thread/start did not return a thread id')
    }
    return {
      threadId,
      modelConfig: normalizeThreadModelConfig(payload),
    }
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to start a new thread', 'thread/start')
  }
}

export type FileAttachmentParam = { label: string; path: string; fsPath: string }

function buildTextWithAttachments(
  prompt: string,
  files: FileAttachmentParam[],
  responseTextAnnotations: ResponseTextAnnotation[],
  pluginMentions: PluginMentionParam[],
  threadMentions: ThreadMentionParam[],
): string {
  if (
    files.length === 0
    && responseTextAnnotations.length === 0
    && pluginMentions.length === 0
    && threadMentions.length === 0
  ) return prompt
  let prefix = ''

  if (responseTextAnnotations.length > 0) {
    const annotations = responseTextAnnotations.map(({ text, annotation }) => ({
      text,
      ...(annotation ? { annotation } : {}),
    }))
    prefix += '# Response annotations:\n'
    prefix += 'Each item contains text selected from an earlier Codex response and may include a user comment. Use every selection as context and address every comment in your response.\n'
    prefix += '<response-annotations>\n'
    prefix += `${JSON.stringify(annotations)}\n`
    prefix += '</response-annotations>\n'
  }

  if (files.length > 0) {
    prefix += `${prefix ? '\n' : ''}# Files mentioned by the user:\n`
    for (const f of files) {
      prefix += `\n## ${f.label}: ${f.path}\n`
    }
  }

  if (pluginMentions.length > 0) {
    prefix += prefix ? '\n' : ''
    for (const plugin of pluginMentions) {
      const mentionLabel = plugin.displayName.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
      prefix += `[@${mentionLabel}](${plugin.path}) `
    }
    prefix += '\n'
  }

  if (threadMentions.length > 0) {
    prefix += prefix ? '\n' : ''
    for (const thread of threadMentions) {
      const mentionLabel = thread.name.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
      prefix += `[@${mentionLabel}](${thread.path}) `
    }
    prefix += '\n'
  }

  return `${prefix}\n## My request for Codex:\n\n${prompt}\n`
}

export async function startThreadTurn(
  threadId: string,
  text: string,
  imageUrls: string[] = [],
  model?: string,
  effort?: ReasoningEffort,
  skills?: Array<{ name: string; path: string }>,
  fileAttachments: FileAttachmentParam[] = [],
  responseTextAnnotations: ResponseTextAnnotation[] = [],
  pluginMentions: PluginMentionParam[] = [],
  threadMentions: ThreadMentionParam[] = [],
): Promise<void> {
  try {
    const finalText = buildTextWithAttachments(
      text,
      fileAttachments,
      responseTextAnnotations,
      pluginMentions,
      threadMentions,
    )
    const input: Array<Record<string, unknown>> = [{ type: 'text', text: finalText }]
    for (const imageUrl of imageUrls) {
      const normalizedUrl = imageUrl.trim()
      if (!normalizedUrl) continue
      input.push({
        type: 'image',
        url: normalizedUrl,
        image_url: normalizedUrl,
      })
    }
    if (skills) {
      for (const skill of skills) {
        input.push({ type: 'skill', name: skill.name, path: skill.path })
      }
    }
    for (const plugin of pluginMentions) {
      input.push({ type: 'mention', name: plugin.name, path: plugin.path })
    }
    for (const thread of threadMentions) {
      input.push({ type: 'mention', name: thread.name, path: thread.path })
    }
    const attachments = fileAttachments.map((f) => ({ label: f.label, path: f.path, fsPath: f.fsPath }))
    const params: Record<string, unknown> = {
      threadId,
      input,
    }
    if (attachments.length > 0) params.attachments = attachments
    if (typeof model === 'string' && model.length > 0) {
      params.model = model
    }
    if (typeof effort === 'string' && effort.length > 0) {
      params.effort = effort
    }
    await callRpc('turn/start', params)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to start turn for thread ${threadId}`, 'turn/start')
  }
}

export async function getInstalledPlugins(cwd?: string): Promise<PluginMentionParam[]> {
  const normalizedCwd = cwd?.trim() ?? ''
  const payload = await callRpc<unknown>('plugin/installed', {
    ...(normalizedCwd ? { cwds: [normalizedCwd] } : {}),
  })
  const marketplaces = asRecord(payload)?.marketplaces
  if (!Array.isArray(marketplaces)) return []

  const pluginsById = new Map<string, PluginMentionParam>()
  for (const rawMarketplace of marketplaces) {
    const marketplace = asRecord(rawMarketplace)
    const plugins = marketplace?.plugins
    if (!Array.isArray(plugins)) continue

    for (const rawPlugin of plugins) {
      const plugin = asRecord(rawPlugin)
      if (!plugin || plugin.installed !== true || plugin.enabled !== true) continue
      if (readString(plugin.availability) === 'DISABLED_BY_ADMIN') continue

      const id = readString(plugin.id)
      const name = readString(plugin.name)
      if (!id || !name) continue

      const pluginInterface = asRecord(plugin.interface)
      const displayName = readString(pluginInterface?.displayName) || name
      const description = readString(pluginInterface?.shortDescription)
      pluginsById.set(id, {
        id,
        name,
        displayName,
        description,
        path: `plugin://${id}`,
      })
    }
  }

  return [...pluginsById.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' }),
  )
}

export async function getPluginCatalog(cwd?: string, forceRefetch = false): Promise<PluginCatalogResult> {
  const normalizedCwd = cwd?.trim() ?? ''
  const payload = await callRpc<unknown>('plugin/list', {
    ...(normalizedCwd ? { cwds: [normalizedCwd] } : {}),
    forceRefetch,
  })
  const result = asRecord(payload)
  const featuredPluginIds = new Set(
    Array.isArray(result?.featuredPluginIds)
      ? result.featuredPluginIds.map(readString).filter(Boolean)
      : [],
  )
  const marketplaces = Array.isArray(result?.marketplaces) ? result.marketplaces : []
  const pluginsById = new Map<string, PluginCatalogItem>()

  for (const rawMarketplace of marketplaces) {
    const marketplace = asRecord(rawMarketplace)
    if (!marketplace) continue
    const marketplaceName = readString(marketplace.name)
    const marketplacePath = readString(marketplace.path)
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []

    for (const rawPlugin of plugins) {
      const plugin = asRecord(rawPlugin)
      if (!plugin) continue
      const id = readString(plugin.id)
      const name = readString(plugin.name)
      if (!id || !name) continue

      const pluginInterface = asRecord(plugin.interface)
      const source = asRecord(plugin.source)
      const displayName = readString(pluginInterface?.displayName) || name
      pluginsById.set(id, {
        id,
        name,
        displayName,
        description: readString(pluginInterface?.shortDescription),
        longDescription: readString(pluginInterface?.longDescription),
        developerName: readString(pluginInterface?.developerName),
        category: readString(pluginInterface?.category),
        capabilities: Array.isArray(pluginInterface?.capabilities)
          ? pluginInterface.capabilities.map(readString).filter(Boolean)
          : [],
        marketplaceName,
        marketplacePath,
        installed: plugin.installed === true,
        enabled: plugin.enabled === true,
        featured: featuredPluginIds.has(id),
        availability: readString(plugin.availability) === 'DISABLED_BY_ADMIN'
          ? 'DISABLED_BY_ADMIN'
          : 'AVAILABLE',
        installPolicy: readString(plugin.installPolicy) === 'NOT_AVAILABLE'
          ? 'NOT_AVAILABLE'
          : readString(plugin.installPolicy) === 'INSTALLED_BY_DEFAULT'
            ? 'INSTALLED_BY_DEFAULT'
            : 'AVAILABLE',
        installPolicySource: readString(plugin.installPolicySource),
        authPolicy: readString(plugin.authPolicy) === 'ON_INSTALL' ? 'ON_INSTALL' : 'ON_USE',
        version: readString(plugin.localVersion) || readString(plugin.version),
        sourceType: readString(source?.type),
        path: `plugin://${id}`,
      })
    }
  }

  const loadErrors = Array.isArray(result?.marketplaceLoadErrors)
    ? result.marketplaceLoadErrors.flatMap((rawError) => {
        const error = asRecord(rawError)
        const message = readString(error?.message)
        if (!message) return []
        return [{ marketplacePath: readString(error?.marketplacePath), message }]
      })
    : []

  return {
    plugins: [...pluginsById.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' }),
    ),
    loadErrors,
  }
}

export async function installPlugin(plugin: PluginCatalogItem): Promise<{ appsNeedingAuth: number }> {
  const params: Record<string, unknown> = {
    pluginName: plugin.name,
  }
  if (plugin.marketplacePath) {
    params.marketplacePath = plugin.marketplacePath
  } else {
    params.remoteMarketplaceName = plugin.marketplaceName
  }
  const payload = await callRpc<unknown>('plugin/install', params)
  const appsNeedingAuth = asRecord(payload)?.appsNeedingAuth
  return { appsNeedingAuth: Array.isArray(appsNeedingAuth) ? appsNeedingAuth.length : 0 }
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  await callRpc('plugin/uninstall', { pluginId })
}

export async function interruptThreadTurn(threadId: string, turnId?: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedTurnId = turnId?.trim() || ''
  if (!normalizedThreadId) return

  try {
    if (!normalizedTurnId) {
      throw new Error('turn/interrupt requires turnId')
    }
    await callRpc('turn/interrupt', { threadId: normalizedThreadId, turnId: normalizedTurnId })
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to interrupt turn for thread ${normalizedThreadId}`, 'turn/interrupt')
  }
}

export async function setDefaultModel(model: string | null, reasoningEffort?: ReasoningEffort | ''): Promise<void> {
  const normalizedModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : null
  const normalizedReasoningEffort =
    typeof reasoningEffort === 'string' && reasoningEffort.length > 0
      ? reasoningEffort
      : null

  await callRpc('config/value/write', {
    keyPath: 'model',
    value: normalizedModel,
    mergeStrategy: 'replace',
  })

  await callRpc('config/value/write', {
    keyPath: 'model_reasoning_effort',
    value: normalizedReasoningEffort,
    mergeStrategy: 'replace',
  })
}

export async function getAvailableModelIds(): Promise<string[]> {
  const payload = await callRpc<ModelListResponse>('model/list', {})
  const ids: string[] = []
  for (const row of payload.data) {
    const candidate = row.id || row.model
    if (!candidate || ids.includes(candidate)) continue
    ids.push(candidate)
  }

  const extendedPayload = await callRpc<ModelListResponse>('model/list', { includeHidden: true })
  for (const row of extendedPayload.data) {
    const candidate = row.id || row.model
    if (!candidate || ids.includes(candidate)) continue
    ids.push(candidate)
  }

  return ids
}

export async function getCurrentModelConfig(): Promise<CurrentModelConfig> {
  const payload = await callRpc<ConfigReadResponse>('config/read', {})
  const model = payload.config.model ?? ''
  const reasoningEffort = normalizeReasoningEffort(payload.config.model_reasoning_effort)
  return { model, reasoningEffort }
}

export async function getCodexUiRuntimeConfig(): Promise<CodexUiRuntimeConfig> {
  try {
    const response = await fetch('/codex-api/runtime-config')
    if (!response.ok) return { defaultReasoningEffort: '' }
    const payload = asRecord(await response.json())
    const data = asRecord(payload?.data)
    return {
      defaultReasoningEffort: normalizeReasoningEffort(data?.defaultReasoningEffort),
    }
  } catch {
    return { defaultReasoningEffort: '' }
  }
}

export async function getAccountRateLimits(): Promise<AccountRateLimitsState> {
  const payload = await callRpc<GetAccountRateLimitsResponse | unknown>('account/rateLimits/read', undefined)
  const state = normalizeAccountRateLimitsPayload(payload)

  try {
    const response = await fetch('/codex-api/rate-limit-reset-credits')
    if (!response.ok) return state
    const resetCreditsPayload = await response.json() as unknown
    return {
      ...state,
      rateLimitResetCredits: normalizeRateLimitResetCreditsPayload(resetCreditsPayload),
    }
  } catch {
    return state
  }
}

export async function consumeRateLimitResetCredit(): Promise<string> {
  const idempotencyKey = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const payload = await callRpc<RateLimitResetCreditConsumeResponse>('account/rateLimitResetCredit/consume', {
    idempotencyKey,
  })
  return typeof payload.code === 'string' ? payload.code : 'unknown'
}

export async function getPinnedThreadIds(): Promise<string[]> {
  const response = await fetch('/codex-api/pinned-threads')
  if (!response.ok) throw new Error(`Failed to load pinned threads (${String(response.status)})`)
  const payload = (await response.json()) as PinnedThreadsResponse
  return normalizeStringArray(payload.data?.threadIds)
}

export async function setPinnedThreadIds(threadIds: string[]): Promise<string[]> {
  const response = await fetch('/codex-api/pinned-threads', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadIds: normalizeStringArray(threadIds) }),
    keepalive: true,
  })
  if (!response.ok) throw new Error(`Failed to save pinned threads (${String(response.status)})`)
  const payload = (await response.json()) as PinnedThreadsResponse
  return normalizeStringArray(payload.data?.threadIds)
}

export async function setThreadPinned(params: SetThreadPinnedParams): Promise<string[]> {
  const response = await fetch('/codex-api/pinned-threads', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: params.threadId.trim(),
      pinned: params.pinned,
      beforeThreadId: params.beforeThreadId?.trim() || undefined,
    }),
    keepalive: true,
  })
  if (!response.ok) throw new Error(`Failed to update pinned thread (${String(response.status)})`)
  const payload = (await response.json()) as PinnedThreadsResponse
  return normalizeStringArray(payload.data?.threadIds)
}

export function normalizeSharedThreadReadState(value: unknown): SharedThreadReadState {
  const envelope = asRecord(value)
  const record = asRecord(envelope?.data ?? value) ?? {}
  const rawReadAt = asRecord(record.readAtByThreadId)
  const readAtByThreadId: Record<string, string> = {}
  if (rawReadAt) {
    for (const [threadId, timestamp] of Object.entries(rawReadAt)) {
      if (threadId && typeof timestamp === 'string' && timestamp.trim()) {
        readAtByThreadId[threadId] = timestamp.trim()
      }
    }
  }
  return {
    readAtByThreadId,
    unreadThreadIds: normalizeStringArray(record.unreadThreadIds).slice(0, 100),
    version: typeof record.version === 'number' && Number.isFinite(record.version) ? Math.max(0, record.version) : 0,
  }
}

export async function getSharedThreadReadState(): Promise<SharedThreadReadState> {
  const response = await fetch('/codex-api/thread-read-state')
  if (!response.ok) throw new Error(`Failed to load thread read state (${String(response.status)})`)
  return normalizeSharedThreadReadState(await response.json())
}

export async function updateSharedThreadReadState(
  threadId: string,
  options: { unread: boolean; readAtIso?: string },
): Promise<SharedThreadReadState> {
  const response = await fetch('/codex-api/thread-read-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: threadId.trim(),
      unread: options.unread,
      readAtIso: options.readAtIso?.trim() ?? '',
    }),
  })
  if (!response.ok) throw new Error(`Failed to save thread read state (${String(response.status)})`)
  return normalizeSharedThreadReadState(await response.json())
}

function normalizeMcpConfig(
  payload: ConfigReadResponse,
): Map<string, Omit<McpServerRecord, 'authStatus' | 'toolCount' | 'resourceCount' | 'resourceTemplateCount' | 'toolNames'>> {
  const configRecord = asRecord(payload.config)
  const rawServers = asRecord(configRecord?.mcp_servers)
  const servers = new Map<string, Omit<McpServerRecord, 'authStatus' | 'toolCount' | 'resourceCount' | 'resourceTemplateCount' | 'toolNames'>>()

  if (!rawServers) return servers

  for (const [name, rawServer] of Object.entries(rawServers)) {
    const serverRecord = asRecord(rawServer)
    if (!serverRecord) continue

    const commandValue = serverRecord.command
    const command = typeof commandValue === 'string'
      ? commandValue.trim()
      : Array.isArray(commandValue) && commandValue.length > 0 && typeof commandValue[0] === 'string'
        ? commandValue[0].trim()
        : ''
    const args = normalizeStringArray(serverRecord.args)
    const url = typeof serverRecord.url === 'string' ? serverRecord.url.trim() : ''
    const envRecord = asRecord(serverRecord.env)
    const envKeys = envRecord ? Object.keys(envRecord).sort((left, right) => left.localeCompare(right)) : []
    const bearerTokenEnvVar =
      typeof serverRecord.bearer_token_env_var === 'string' ? serverRecord.bearer_token_env_var.trim() : ''

    servers.set(name, {
      name,
      enabled: serverRecord.enabled !== false,
      transportType: url ? 'remote' : command || args.length > 0 ? 'local' : 'unknown',
      command,
      args,
      url,
      envKeys,
      bearerTokenEnvVar,
    })
  }

  return servers
}

async function getAllMcpStatuses(): Promise<Map<string, {
  authStatus: McpAuthStatus
  toolCount: number
  resourceCount: number
  resourceTemplateCount: number
  toolNames: string[]
}>> {
  const statuses = new Map<string, {
    authStatus: McpAuthStatus
    toolCount: number
    resourceCount: number
    resourceTemplateCount: number
    toolNames: string[]
  }>()

  let cursor: string | null = null
  do {
    const payload: ListMcpServerStatusResponse = await callRpc('mcpServerStatus/list', {
      cursor,
      limit: 100,
    })

    for (const row of payload.data) {
      statuses.set(row.name, {
        authStatus: row.authStatus,
        toolCount: Object.keys(row.tools ?? {}).length,
        resourceCount: row.resources.length,
        resourceTemplateCount: row.resourceTemplates.length,
        toolNames: Object.keys(row.tools ?? {}).sort((left, right) => left.localeCompare(right)),
      })
    }

    cursor = payload.nextCursor
  } while (cursor)

  return statuses
}

export async function readMcpAppResource(
  server: string,
  uri: string,
  threadId?: string,
): Promise<McpAppResource | null> {
  const cacheKey = `${server}\u0000${uri}`
  const cached = mcpAppResourceCache.get(cacheKey)
  if (cached) return cached

  const request = (async () => {
    const payload = await callRpc<{ contents?: unknown }>('mcpServer/resource/read', {
      server,
      uri,
      ...(threadId ? { threadId } : {}),
    })
    const contents = Array.isArray(payload.contents) ? payload.contents : []
    for (const entry of contents) {
      const record = asRecord(entry)
      if (!record || typeof record.text !== 'string') continue
      return {
        uri: typeof record.uri === 'string' ? record.uri : uri,
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : '',
        text: record.text,
        meta: asRecord(record._meta) ?? {},
      }
    }
    return null
  })()
  mcpAppResourceCache.set(cacheKey, request)
  try {
    return await request
  } catch (error) {
    mcpAppResourceCache.delete(cacheKey)
    throw error
  }
}

export async function getMcpServers(): Promise<McpServerRecord[]> {
  const [configPayload, statuses] = await Promise.all([
    callRpc<ConfigReadResponse>('config/read', {}),
    getAllMcpStatuses(),
  ])
  const configServers = normalizeMcpConfig(configPayload)
  const names = new Set<string>([...configServers.keys(), ...statuses.keys()])

  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const config = configServers.get(name)
      const status = statuses.get(name)

      return {
        name,
        enabled: config?.enabled ?? false,
        transportType: config?.transportType ?? 'unknown',
        command: config?.command ?? '',
        args: config?.args ?? [],
        url: config?.url ?? '',
        envKeys: config?.envKeys ?? [],
        bearerTokenEnvVar: config?.bearerTokenEnvVar ?? '',
        authStatus: status?.authStatus ?? 'unknown',
        toolCount: status?.toolCount ?? 0,
        resourceCount: status?.resourceCount ?? 0,
        resourceTemplateCount: status?.resourceTemplateCount ?? 0,
        toolNames: status?.toolNames ?? [],
      }
    })
}

export async function reloadMcpServers(): Promise<void> {
  await callRpc('config/mcpServer/reload', undefined)
}

export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServerRecord[]> {
  const payload = await callRpc<ConfigReadResponse>('config/read', {})
  const configRecord = asRecord(payload.config) ?? {}
  const rawServers = asRecord(configRecord.mcp_servers)
  const nextServers = deepCopyJsonValue(rawServers ?? {})
  const currentServer = asRecord(nextServers[name]) ?? {}
  nextServers[name] = {
    ...currentServer,
    enabled,
  }

  await callRpc('config/value/write', {
    keyPath: 'mcp_servers',
    value: nextServers,
    mergeStrategy: 'replace',
  })
  await reloadMcpServers()
  return await getMcpServers()
}

export async function startMcpServerOauthLogin(name: string): Promise<string> {
  const payload = await callRpc<{ authorizationUrl?: string }>('mcpServer/oauth/login', {
    name,
  })
  return typeof payload.authorizationUrl === 'string' ? payload.authorizationUrl : ''
}

function normalizeWorkspaceRootsState(payload: unknown): WorkspaceRootsState {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}

  const normalizeArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const next: string[] = []
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0 && !next.includes(item)) {
        next.push(item)
      }
    }
    return next
  }

  const labelsRaw = record.labels
  const labels: Record<string, string> = {}
  if (labelsRaw && typeof labelsRaw === 'object' && !Array.isArray(labelsRaw)) {
    for (const [key, value] of Object.entries(labelsRaw as Record<string, unknown>)) {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'string') {
        labels[key] = value
      }
    }
  }

  return {
    order: normalizeArray(record.order),
    labels,
    active: normalizeArray(record.active),
  }
}

export async function getWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  const response = await fetch('/codex-api/workspace-roots-state')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error('Failed to load workspace roots state')
  }
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  return normalizeWorkspaceRootsState(envelope.data)
}

export async function getHomeDirectory(): Promise<string> {
  const response = await fetch('/codex-api/home-directory')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error('Failed to load home directory')
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  return typeof data.path === 'string' ? data.path.trim() : ''
}

export async function setWorkspaceRootsState(nextState: WorkspaceRootsState): Promise<void> {
  const response = await fetch('/codex-api/workspace-roots-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nextState),
  })
  if (!response.ok) {
    throw new Error('Failed to save workspace roots state')
  }
}

export async function openProjectRoot(path: string, options?: { createIfMissing?: boolean; label?: string }): Promise<string> {
  const response = await fetch('/codex-api/project-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      createIfMissing: options?.createIfMissing === true,
      label: options?.label ?? '',
    }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to open project root')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  const normalizedPath = typeof data.path === 'string' ? data.path.trim() : ''
  return normalizedPath
}

export async function getProjectRootSuggestion(basePath: string): Promise<{ name: string; path: string }> {
  const query = new URLSearchParams({ basePath })
  const response = await fetch(`/codex-api/project-root-suggestion?${query.toString()}`)
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to suggest project name')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  return {
    name: typeof data.name === 'string' ? data.name.trim() : '',
    path: typeof data.path === 'string' ? data.path.trim() : '',
  }
}

export async function searchComposerFiles(cwd: string, query: string, limit = 20): Promise<ComposerFileSuggestion[]> {
  const trimmedCwd = cwd.trim()
  if (!trimmedCwd) return []
  const response = await fetch('/codex-api/composer-file-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: trimmedCwd,
      query: query.trim(),
      limit,
    }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to search files')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data = Array.isArray(record.data) ? record.data : []
  const suggestions: ComposerFileSuggestion[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const rawPath = row.path
    const value = typeof rawPath === 'string' ? rawPath.trim() : ''
    if (!value) continue
    suggestions.push({ path: value })
  }
  return suggestions
}

function getErrorMessageFromPayload(payload: unknown, fallback: string): string {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const error = record.error
  return typeof error === 'string' && error.trim().length > 0 ? error : fallback
}

export type ThreadTitleCache = { titles: Record<string, string>; order: string[] }

export async function getThreadTitleCache(): Promise<ThreadTitleCache> {
  try {
    const response = await fetch('/codex-api/thread-titles')
    if (!response.ok) return { titles: {}, order: [] }
    const envelope = (await response.json()) as { data?: ThreadTitleCache }
    return envelope.data ?? { titles: {}, order: [] }
  } catch {
    return { titles: {}, order: [] }
  }
}

export async function persistThreadTitle(id: string, title: string): Promise<void> {
  try {
    await fetch('/codex-api/thread-titles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title }),
    })
  } catch {
    // Best-effort persist
  }
}

export async function generateThreadTitle(prompt: string, cwd: string | null): Promise<string> {
  try {
    const result = await callBridgeEndpoint<{ title?: string }>(
      '/codex-api/thread-title/generate',
      { prompt, cwd },
      'thread-title/generate',
    )
    return result.title?.trim() ?? ''
  } catch {
    return ''
  }
}

export type SkillInfo = {
  name: string
  description: string
  path: string
  scope: string
  enabled: boolean
}

type SkillsListResponseEntry = {
  cwd: string
  skills: Array<{
    name: string
    description: string
    shortDescription?: string
    path: string
    scope: string
    enabled: boolean
  }>
  errors: unknown[]
}

export async function getSkillsList(cwds?: string[]): Promise<SkillInfo[]> {
  try {
    const params: Record<string, unknown> = {}
    if (cwds && cwds.length > 0) params.cwds = cwds
    const payload = await callRpc<{ data: SkillsListResponseEntry[] }>('skills/list', params)
    const skills: SkillInfo[] = []
    const seen = new Set<string>()
    for (const entry of payload.data) {
      for (const skill of entry.skills) {
        if (!skill.name || seen.has(skill.path)) continue
        seen.add(skill.path)
        skills.push({
          name: skill.name,
          description: skill.shortDescription || skill.description || '',
          path: skill.path,
          scope: skill.scope,
          enabled: skill.enabled,
        })
      }
    }
    return skills
  } catch {
    return []
  }
}

export async function uploadFile(file: File): Promise<string | null> {
  try {
    const form = new FormData()
    form.append('file', file)
    const resp = await fetch('/codex-api/upload-file', { method: 'POST', body: form })
    if (!resp.ok) return null
    const data = (await resp.json()) as { path?: string }
    return data.path ?? null
  } catch {
    return null
  }
}
