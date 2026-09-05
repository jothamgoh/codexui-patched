import { computed, ref } from 'vue'
import {
  archiveThread,
  clearThreadGoal,
  consumeRateLimitResetCredit,
  createWorktree,
  forkThread,
  getAccountRateLimits,
  getAvailableModelCatalog,
  getCodexUiRuntimeConfig,
  getCurrentModelConfig,
  getPendingServerRequests,
  getSkillsList,
  getSharedThreadReadState,
  getThreadAudience,
  getThreadGoal,
  interruptThreadTurn,
  replyToServerRequest,
  rollbackThread,
  getThreadGroups,
  getThreadMessagesWithStatus,
  getWorkspaceRootsState,
  setWorkspaceRootsState,
  getThreadTitleCache,
  persistThreadTitle,
  generateThreadTitle,
  resumeThread,
  setDefaultModel,
  setFastModePreference,
  setThreadName,
  setThreadGoal,
  startThread,
  subscribeCodexNotifications,
  startThreadTurn,
  type AccountRateLimitsState,
  type PluginMentionParam,
  type RpcNotification,
  type SkillInfo,
  type ThreadMentionParam,
  type ResolvedThreadMentionParam,
  type ThreadModelConfig,
  type ThreadMessagePage,
  type ThreadTurnSummary,
  normalizeRateLimitSnapshotPayload,
  normalizeSharedThreadReadState,
  updateSharedThreadReadState,
  type SharedThreadReadState,
} from '../api/codexGateway'
import { formatMcpToolCallPresentation, readMcpAppResult } from '../api/toolCallPresentation'
import { normalizeSubAgentActivity } from '../api/subAgentActivity'
import type {
  CommandExecutionData,
  McpAppResultData,
  ReasoningEffort,
  ResponseTextAnnotation,
  ThreadGoalStatus,
  ThreadScrollState,
  ToolCallData,
  UiLiveOverlay,
  UiMessage,
  UiProjectGroup,
  UiServerRequest,
  UiServerRequestReply,
  UiThreadTokenUsage,
  UiThread,
  UiThreadGoal,
  UiTokenUsageBreakdown,
} from '../types/codex'
import {
  serviceTierForModel,
  type FastServiceTierByModel,
} from '../utils/serviceTier'
import {
  getLocalTurnNotificationMode,
  isWebPushLocallyEnabled,
} from './useWebPushNotifications'
import { compactNotificationText } from '../utils/notificationText'
import type { CodexThreadAudience } from '../utils/codexThreadSource'
import { MAX_THREAD_REFERENCE_COUNT } from '../utils/threadReferences'
import { insertTurnSummaryMessages, sortMessagesByOrder } from '../utils/conversationMessages'

function flattenThreads(groups: UiProjectGroup[]): UiThread[] {
  return groups.flatMap((group) => group.threads)
}

const READ_STATE_STORAGE_KEY = 'codex-web-local.thread-read-state.v1'
const SCROLL_STATE_STORAGE_KEY = 'codex-web-local.thread-scroll-state.v1'
const SELECTED_THREAD_STORAGE_KEY = 'codex-web-local.selected-thread-id.v1'
const PROJECT_ORDER_STORAGE_KEY = 'codex-web-local.project-order.v1'
const PROJECT_DISPLAY_NAME_STORAGE_KEY = 'codex-web-local.project-display-name.v1'
const THREAD_ORDER_STORAGE_KEY = 'codex-web-local.thread-order.v1'
const ACTIVE_TURN_ID_STORAGE_KEY = 'codex-web-local.active-turn-id.v1'
const TURN_SUMMARY_STORAGE_KEY = 'codex-web-local.thread-turn-summary.v1'
const THREAD_MODEL_CONFIG_STORAGE_KEY = 'codex-web-local.thread-model-config.v1'
const NEW_THREAD_MODEL_CONFIG_STORAGE_KEY = 'codex-web-local.new-thread-model-config.v1'
const EVENT_SYNC_DEBOUNCE_MS = 220
const PREFERRED_DEFAULT_MODEL_ID = 'gpt-5.6-sol'
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'xhigh'
const REASONING_EFFORT_OPTIONS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const GLOBAL_SERVER_REQUEST_SCOPE = '__global__'
const BROWSER_TURN_NOTIFICATION_FALLBACK_BODY = 'Codex finished responding'
const BROWSER_TURN_NOTIFICATION_BODY_MAX_LENGTH = 180
const MAX_BROWSER_NOTIFIED_TURNS = 200
const GOAL_CONTINUATION_DELAY_MS = 350
const THREAD_MESSAGE_PAGE_SIZE = 20
const THREAD_AUDIENCE_LOOKUP_TIMEOUT_MS = 4_000

function loadReadStateMap(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(READ_STATE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function saveReadStateMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(READ_STATE_STORAGE_KEY, JSON.stringify(state))
}

function hasThreadActivityAfterRead(readAtIso: string, updatedAtIso: string): boolean {
  const readAt = Date.parse(readAtIso)
  const updatedAt = Date.parse(updatedAtIso)
  if (Number.isFinite(readAt) && Number.isFinite(updatedAt)) {
    return updatedAt > readAt
  }
  return readAtIso !== updatedAtIso
}

function loadActiveTurnIdMap(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(ACTIVE_TURN_ID_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalized: Record<string, string> = {}
    for (const [threadId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const turnId = typeof value === 'string' ? value.trim() : ''
      if (!threadId || !turnId) continue
      normalized[threadId] = turnId
    }
    return normalized
  } catch {
    return {}
  }
}

function saveActiveTurnIdMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ACTIVE_TURN_ID_STORAGE_KEY, JSON.stringify(state))
}

function normalizeTurnSummaryRecord(value: unknown): TurnSummaryState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const turnId = typeof record.turnId === 'string' ? record.turnId.trim() : ''
  const durationMs = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)
    ? Math.max(0, record.durationMs)
    : null
  if (!turnId || durationMs === null) return null
  return { turnId, durationMs }
}

function normalizeTurnSummaryList(value: unknown): TurnSummaryState[] {
  const incoming = Array.isArray(value)
    ? value.map(normalizeTurnSummaryRecord).filter((summary): summary is TurnSummaryState => summary !== null)
    : [normalizeTurnSummaryRecord(value)].filter((summary): summary is TurnSummaryState => summary !== null)

  const byTurnId = new Map<string, TurnSummaryState>()
  for (const summary of incoming) {
    byTurnId.set(summary.turnId, summary)
  }
  return Array.from(byTurnId.values())
}

function loadTurnSummaryMap(): TurnSummaryByThreadId {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(TURN_SUMMARY_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalized: TurnSummaryByThreadId = {}
    for (const [threadId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const summaries = normalizeTurnSummaryList(value)
      if (!threadId || summaries.length === 0) continue
      normalized[threadId] = summaries
    }
    return normalized
  } catch {
    return {}
  }
}

function saveTurnSummaryMap(state: TurnSummaryByThreadId): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(TURN_SUMMARY_STORAGE_KEY, JSON.stringify(state))
}

function loadPersistedThreadRuntimeState(): {
  inProgressById: Record<string, boolean>
  activeTurnIdByThreadId: Record<string, string>
} {
  const activeTurnIdByThreadId = loadActiveTurnIdMap()
  const inProgressById: Record<string, boolean> = {}
  for (const threadId of Object.keys(activeTurnIdByThreadId)) {
    inProgressById[threadId] = true
  }
  return {
    inProgressById,
    activeTurnIdByThreadId,
  }
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue)
}

function pickDefaultModelId(modelIds: string[]): string {
  if (modelIds.includes(PREFERRED_DEFAULT_MODEL_ID)) return PREFERRED_DEFAULT_MODEL_ID
  return modelIds[0] ?? ''
}

function normalizeReasoningEffortPreference(value: unknown): ReasoningEffort | '' {
  return typeof value === 'string' && REASONING_EFFORT_OPTIONS.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : ''
}

function normalizeThreadScrollState(value: unknown): ThreadScrollState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const rawState = value as Record<string, unknown>
  if (typeof rawState.scrollTop !== 'number' || !Number.isFinite(rawState.scrollTop)) return null
  if (typeof rawState.isAtBottom !== 'boolean') return null

  const normalized: ThreadScrollState = {
    scrollTop: Math.max(0, rawState.scrollTop),
    isAtBottom: rawState.isAtBottom,
  }

  if (typeof rawState.scrollRatio === 'number' && Number.isFinite(rawState.scrollRatio)) {
    normalized.scrollRatio = clamp(rawState.scrollRatio, 0, 1)
  }

  return normalized
}

function loadThreadScrollStateMap(): Record<string, ThreadScrollState> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(SCROLL_STATE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, ThreadScrollState> = {}
    for (const [threadId, state] of Object.entries(parsed as Record<string, unknown>)) {
      if (!threadId) continue
      const normalizedState = normalizeThreadScrollState(state)
      if (normalizedState) {
        normalizedMap[threadId] = normalizedState
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadScrollStateMap(state: Record<string, ThreadScrollState>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SCROLL_STATE_STORAGE_KEY, JSON.stringify(state))
}

function loadSelectedThreadId(): string {
  if (typeof window === 'undefined') return ''
  const raw = window.localStorage.getItem(SELECTED_THREAD_STORAGE_KEY)
  return raw ?? ''
}

function saveSelectedThreadId(threadId: string): void {
  if (typeof window === 'undefined') return
  if (!threadId) {
    window.localStorage.removeItem(SELECTED_THREAD_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(SELECTED_THREAD_STORAGE_KEY, threadId)
}

function loadProjectOrder(): string[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const order: string[] = []
    for (const item of parsed) {
      if (typeof item === 'string' && item.length > 0 && !order.includes(item)) {
        order.push(item)
      }
    }
    return order
  } catch {
    return []
  }
}

function saveProjectOrder(order: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(order))
}

function loadProjectDisplayNames(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(PROJECT_DISPLAY_NAME_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const displayNames: Record<string, string> = {}
    for (const [projectName, displayName] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof projectName === 'string' && projectName.length > 0 && typeof displayName === 'string') {
        displayNames[projectName] = displayName
      }
    }
    return displayNames
  } catch {
    return {}
  }
}

function saveProjectDisplayNames(displayNames: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_DISPLAY_NAME_STORAGE_KEY, JSON.stringify(displayNames))
}

function loadThreadOrder(): string[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(THREAD_ORDER_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const order: string[] = []
    for (const item of parsed) {
      if (typeof item === 'string' && item.length > 0 && !order.includes(item)) {
        order.push(item)
      }
    }
    return order
  } catch {
    return []
  }
}

function saveThreadOrder(order: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_ORDER_STORAGE_KEY, JSON.stringify(order))
}

function loadThreadModelConfigMap(): Record<string, ThreadModelConfig> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_MODEL_CONFIG_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalized: Record<string, ThreadModelConfig> = {}
    for (const [threadId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!threadId || !value || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const model = typeof record.model === 'string' ? record.model.trim() : ''
      const reasoningEffort = normalizeReasoningEffortPreference(record.reasoningEffort)
      if (!model && !reasoningEffort) continue
      normalized[threadId] = { model, reasoningEffort }
    }
    return normalized
  } catch {
    return {}
  }
}

function saveThreadModelConfigMap(state: Record<string, ThreadModelConfig>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_MODEL_CONFIG_STORAGE_KEY, JSON.stringify(state))
}

function loadNewThreadModelConfig(): ThreadModelConfig {
  const fallback: ThreadModelConfig = {
    model: PREFERRED_DEFAULT_MODEL_ID,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  }
  if (typeof window === 'undefined') return fallback

  try {
    const raw = window.localStorage.getItem(NEW_THREAD_MODEL_CONFIG_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
    const record = parsed as Record<string, unknown>
    const model = typeof record.model === 'string' ? record.model.trim() : ''
    const reasoningEffort = normalizeReasoningEffortPreference(record.reasoningEffort)
    return {
      model: model || fallback.model,
      reasoningEffort: reasoningEffort || fallback.reasoningEffort,
    }
  } catch {
    return fallback
  }
}

function saveNewThreadModelConfig(config: ThreadModelConfig): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(NEW_THREAD_MODEL_CONFIG_STORAGE_KEY, JSON.stringify(config))
}

function mergeProjectOrder(previousOrder: string[], incomingGroups: UiProjectGroup[]): string[] {
  const nextOrder: string[] = []

  for (const projectName of previousOrder) {
    if (!nextOrder.includes(projectName)) {
      nextOrder.push(projectName)
    }
  }

  for (const group of incomingGroups) {
    if (!nextOrder.includes(group.projectName)) {
      nextOrder.push(group.projectName)
    }
  }

  return areStringArraysEqual(previousOrder, nextOrder) ? previousOrder : nextOrder
}

function hasKnownProjectOrder(projectOrder: string[], groups: UiProjectGroup[]): boolean {
  const groupNames = new Set(groups.map((group) => group.projectName))
  return projectOrder.some((projectName) => groupNames.has(projectName))
}

function orderGroupsByProjectOrder(incoming: UiProjectGroup[], projectOrder: string[]): UiProjectGroup[] {
  const incomingByName = new Map(incoming.map((group) => [group.projectName, group]))
  const ordered: UiProjectGroup[] = projectOrder
    .map((projectName) => incomingByName.get(projectName) ?? { projectName, threads: [] })

  for (const group of incoming) {
    if (!projectOrder.includes(group.projectName)) {
      ordered.push(group)
    }
  }

  return ordered
}

function orderThreadsByThreadOrder(threads: UiThread[], threadOrder: string[]): UiThread[] {
  if (threadOrder.length === 0 || threads.length < 2) return threads

  const orderIndexById = new Map(threadOrder.map((threadId, index) => [threadId, index]))
  const sorted = threads
    .map((thread, index) => ({ thread, index }))
    .sort((first, second) => {
      const firstOrder = orderIndexById.get(first.thread.id)
      const secondOrder = orderIndexById.get(second.thread.id)
      if (firstOrder !== undefined && secondOrder !== undefined) return firstOrder - secondOrder
      if (firstOrder !== undefined) return -1
      if (secondOrder !== undefined) return 1
      return first.index - second.index
    })
    .map((entry) => entry.thread)

  return areThreadArraysEqual(threads, sorted) ? threads : sorted
}

function orderGroupsByThreadOrder(groups: UiProjectGroup[], threadOrder: string[]): UiProjectGroup[] {
  if (threadOrder.length === 0) return groups

  const orderedGroups = groups.map((group) => {
    const orderedThreads = orderThreadsByThreadOrder(group.threads, threadOrder)
    if (orderedThreads === group.threads) return group
    return {
      projectName: group.projectName,
      threads: orderedThreads,
    }
  })

  return areGroupArraysEqual(groups, orderedGroups) ? groups : orderedGroups
}

function areStringArraysEqual(first?: string[], second?: string[]): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function reorderStringArray(items: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
    return items
  }

  if (fromIndex === toIndex) {
    return items
  }

  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

function areCommandExecutionsEqual(first?: CommandExecutionData, second?: CommandExecutionData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.status === second.status && first.aggregatedOutput === second.aggregatedOutput && first.exitCode === second.exitCode
}

function areToolCallsEqual(first?: ToolCallData, second?: ToolCallData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return (
    first.kind === second.kind &&
    first.label === second.label &&
    first.detail === second.detail &&
    first.status === second.status &&
    first.progress === second.progress &&
    first.description === second.description &&
    first.statusLabel === second.statusLabel &&
    first.tone === second.tone
  )
}

function areMcpAppResultsEqual(first?: McpAppResultData, second?: McpAppResultData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return (
    first.server === second.server
    && first.tool === second.tool
    && first.appName === second.appName
    && first.resourceUri === second.resourceUri
  )
}

function areFileAttachmentsEqual(
  first?: Array<{ label: string; path: string }>,
  second?: Array<{ label: string; path: string }>,
): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.label !== right[index]?.label) return false
    if (left[index]?.path !== right[index]?.path) return false
  }
  return true
}

function areResponseAnnotationsEqual(
  first?: ResponseTextAnnotation[],
  second?: ResponseTextAnnotation[],
): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.text !== right[index]?.text) return false
    if ((left[index]?.annotation ?? '') !== (right[index]?.annotation ?? '')) return false
  }
  return true
}

function areThreadReferencesEqual(
  first?: UiMessage['threadReferences'],
  second?: UiMessage['threadReferences'],
): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.id !== right[index]?.id) return false
    if (left[index]?.name !== right[index]?.name) return false
    if (left[index]?.path !== right[index]?.path) return false
  }
  return true
}

function areReviewChangesEqual(
  first?: UiMessage['reviewChanges'],
  second?: UiMessage['reviewChanges'],
): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (
    first.fileCount !== second.fileCount
    || first.changeCount !== second.changeCount
    || first.actionUnavailableReason !== second.actionUnavailableReason
    || first.filesTruncated !== second.filesTruncated
    || first.additions !== second.additions
    || first.deletions !== second.deletions
    || first.patchBatches.length !== second.patchBatches.length
    || first.files.length !== second.files.length
  ) return false

  for (let index = 0; index < first.patchBatches.length; index += 1) {
    const left = first.patchBatches[index]
    const right = second.patchBatches[index]
    if (
      left?.id !== right?.id
      || left?.cwd !== right?.cwd
      || left?.fingerprint !== right?.fingerprint
      || left?.byteLength !== right?.byteLength
      || left?.patch !== right?.patch
    ) return false
  }
  return true
}

function areMessageFieldsEqual(first: UiMessage, second: UiMessage): boolean {
  return (
    first.id === second.id &&
    first.role === second.role &&
    first.text === second.text &&
    areStringArraysEqual(first.images, second.images) &&
    areFileAttachmentsEqual(first.fileAttachments, second.fileAttachments) &&
    areThreadReferencesEqual(first.threadReferences, second.threadReferences) &&
    areResponseAnnotationsEqual(first.responseAnnotations, second.responseAnnotations) &&
    first.orderKey === second.orderKey &&
    first.messageType === second.messageType &&
    first.phase === second.phase &&
    first.rawPayload === second.rawPayload &&
    first.isUnhandled === second.isUnhandled &&
    areCommandExecutionsEqual(first.commandExecution, second.commandExecution) &&
    areToolCallsEqual(first.toolCall, second.toolCall) &&
    first.subAgentActivity?.threadId === second.subAgentActivity?.threadId &&
    first.subAgentActivity?.name === second.subAgentActivity?.name &&
    first.subAgentActivity?.status === second.subAgentActivity?.status &&
    first.subAgentActivity?.statusLabel === second.subAgentActivity?.statusLabel &&
    first.subAgentActivity?.task === second.subAgentActivity?.task &&
    areMcpAppResultsEqual(first.mcpApp, second.mcpApp) &&
    areReviewChangesEqual(first.reviewChanges, second.reviewChanges) &&
    first.turnId === second.turnId &&
    first.turnIndex === second.turnIndex
  )
}

function areMessageArraysEqual(first: UiMessage[], second: UiMessage[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function mergeMessages(
  previous: UiMessage[],
  incoming: UiMessage[],
  options: { preserveMissing?: boolean } = {},
): UiMessage[] {
  const previousById = new Map(previous.map((message) => [message.id, message]))

  const mergedIncoming = incoming.map((incomingMessage) => {
    const previousMessage = previousById.get(incomingMessage.id)
    if (previousMessage && areMessageFieldsEqual(previousMessage, incomingMessage)) {
      return previousMessage
    }
    return incomingMessage
  })

  if (options.preserveMissing !== true) {
    return areMessageArraysEqual(previous, mergedIncoming) ? previous : mergedIncoming
  }

  const incomingIdSet = new Set(mergedIncoming.map((message) => message.id))
  const missingBeforeId = new Map<string, UiMessage[]>()
  let missing: UiMessage[] = []
  for (const message of previous) {
    if (!incomingIdSet.has(message.id)) {
      missing.push(message)
    } else if (missing.length) {
      missingBeforeId.set(message.id, missing)
      missing = []
    }
  }
  const merged = mergedIncoming.flatMap((message) => [...(missingBeforeId.get(message.id) ?? []), message])
  merged.push(...missing)

  return areMessageArraysEqual(previous, merged) ? previous : merged
}

function haveSameUserMessagePayload(first: UiMessage, second: UiMessage): boolean {
  return (
    first.role === 'user' &&
    second.role === 'user' &&
    normalizeMessageText(first.text) === normalizeMessageText(second.text) &&
    areStringArraysEqual(first.images, second.images) &&
    areFileAttachmentsEqual(first.fileAttachments, second.fileAttachments) &&
    areThreadReferencesEqual(first.threadReferences, second.threadReferences) &&
    areResponseAnnotationsEqual(first.responseAnnotations, second.responseAnnotations)
  )
}

function mergeServerMessagesPreservingOptimistic(
  previous: UiMessage[],
  incoming: UiMessage[],
  options: { preserveMissing?: boolean } = {},
): UiMessage[] {
  const optimisticMessages = previous.filter((message) => message.id.startsWith('optimistic-'))
  const persistedMessages = previous.filter((message) => !message.id.startsWith('optimistic-'))
  const persistedIds = new Set(persistedMessages.map((message) => message.id))
  const newUserMessages = incoming.filter(
    (message) => message.role === 'user' && !persistedIds.has(message.id),
  )

  const unresolvedOptimisticMessages = optimisticMessages.filter((optimisticMessage) => {
    const matchingIndex = newUserMessages.findIndex((message) =>
      haveSameUserMessagePayload(optimisticMessage, message),
    )
    if (matchingIndex < 0) return true
    newUserMessages.splice(matchingIndex, 1)
    return false
  })

  const merged = mergeMessages(persistedMessages, incoming, options)
  if (unresolvedOptimisticMessages.length === 0) return merged
  return sortMessagesByOrder([...merged, ...unresolvedOptimisticMessages])
}

function normalizeMessageText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function removeRedundantLiveAgentMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingAssistantTexts = new Set(
    incoming
      .filter((message) => message.role === 'assistant')
      .map((message) => `${message.turnId ?? ''}\u0000${normalizeMessageText(message.text)}`)
      .filter((text) => text.length > 0),
  )

  if (incomingAssistantTexts.size === 0) {
    return previous
  }

  const next = previous.filter((message) => {
    if (message.messageType !== 'agentMessage.live') return true
    const normalized = normalizeMessageText(message.text)
    if (normalized.length === 0) return false
    return !incoming.some((item) => item.id === message.id)
      && !incomingAssistantTexts.has(`${message.turnId ?? ''}\u0000${normalized}`)
  })

  return next.length === previous.length ? previous : next
}

function upsertMessage(previous: UiMessage[], nextMessage: UiMessage): UiMessage[] {
  const existingIndex = previous.findIndex((message) => message.id === nextMessage.id)
  if (existingIndex < 0) {
    return [...previous, nextMessage]
  }

  const existing = previous[existingIndex]
  const mergedMessage =
    !nextMessage.orderKey && existing.orderKey
      ? { ...nextMessage, orderKey: existing.orderKey }
      : nextMessage

  if (areMessageFieldsEqual(existing, mergedMessage)) {
    return previous
  }

  const next = [...previous]
  next.splice(existingIndex, 1, mergedMessage)
  return next
}

type TurnSummaryState = {
  turnId: string
  durationMs: number
}

type TurnSummaryByThreadId = Record<string, TurnSummaryState[]>

type ThreadPaginationState = Pick<
  ThreadMessagePage,
  'startTurnIndex' | 'endTurnIndex' | 'totalTurns' | 'hasEarlier'
>

type TurnActivityState = {
  label: string
  details: string[]
}

type TurnErrorState = {
  message: string
}

type TurnStartedInfo = {
  threadId: string
  turnId: string
  startedAtMs: number
}

type TurnCompletedInfo = {
  threadId: string
  turnId: string
  completedAtMs: number
  startedAtMs?: number
}

function parseIsoTimestamp(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

function areTurnSummariesEqual(first?: TurnSummaryState, second?: TurnSummaryState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.turnId === second.turnId && first.durationMs === second.durationMs
}

function areTurnSummaryArraysEqual(first: TurnSummaryState[], second: TurnSummaryState[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (!areTurnSummariesEqual(first[index], second[index])) return false
  }
  return true
}

function areTurnActivitiesEqual(first?: TurnActivityState, second?: TurnActivityState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.label !== second.label) return false
  if (first.details.length !== second.details.length) return false
  for (let index = 0; index < first.details.length; index += 1) {
    if (first.details[index] !== second.details[index]) return false
  }
  return true
}

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRawString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function pick(record: Record<string, unknown>, camelKey: string, snakeKey: string): unknown {
  if (camelKey in record) return record[camelKey]
  if (snakeKey in record) return record[snakeKey]
  return null
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

function normalizeThreadGoalPayload(value: unknown, fallbackThreadId = ''): UiThreadGoal | null {
  const record = asRecord(value)
  if (!record) return null

  const threadId = readString(pick(record, 'threadId', 'thread_id')) || fallbackThreadId
  const objective = readString(pick(record, 'objective', 'objective'))
  const status = normalizeThreadGoalStatus(pick(record, 'status', 'status'))
  const tokenBudget = readNumber(pick(record, 'tokenBudget', 'token_budget'))
  const tokensUsed = readNumber(pick(record, 'tokensUsed', 'tokens_used'))
  const timeUsedSeconds = readNumber(pick(record, 'timeUsedSeconds', 'time_used_seconds'))
  const createdAt = readNumber(pick(record, 'createdAt', 'created_at'))
  const updatedAt = readNumber(pick(record, 'updatedAt', 'updated_at'))

  if (!threadId || !objective || !status || tokensUsed === null || timeUsedSeconds === null || createdAt === null || updatedAt === null) {
    return null
  }

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

function normalizeTokenUsageBreakdown(value: unknown): UiTokenUsageBreakdown | null {
  const record = asRecord(value)
  if (!record) return null

  const totalTokens = readNumber(pick(record, 'totalTokens', 'total_tokens'))
  const inputTokens = readNumber(pick(record, 'inputTokens', 'input_tokens'))
  const cachedInputTokens = readNumber(pick(record, 'cachedInputTokens', 'cached_input_tokens'))
  const outputTokens = readNumber(pick(record, 'outputTokens', 'output_tokens'))
  const reasoningOutputTokens = readNumber(pick(record, 'reasoningOutputTokens', 'reasoning_output_tokens'))

  if (
    totalTokens === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null
  ) {
    return null
  }

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  }
}

function normalizeThreadTokenUsagePayload(value: unknown, fallbackThreadId = '', fallbackTurnId = ''): UiThreadTokenUsage | null {
  const record = asRecord(value)
  if (!record) return null

  const threadId = readString(pick(record, 'threadId', 'thread_id')) || fallbackThreadId
  const turnId = readString(pick(record, 'turnId', 'turn_id')) || fallbackTurnId
  const total = normalizeTokenUsageBreakdown(pick(record, 'total', 'total'))
  const last = normalizeTokenUsageBreakdown(pick(record, 'last', 'last'))
  const modelContextWindow = readNumber(pick(record, 'modelContextWindow', 'model_context_window'))

  if (!threadId || !turnId || !total || !last) return null

  return {
    threadId,
    turnId,
    total,
    last,
    modelContextWindow,
  }
}

function summarizeBrowserNotificationText(value: string, fallback: string): string {
  return compactNotificationText(value, fallback, BROWSER_TURN_NOTIFICATION_BODY_MAX_LENGTH)
}

function toRawPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function mergeAccountRateLimitSnapshot(
  current: AccountRateLimitsState | null,
  snapshot: NonNullable<AccountRateLimitsState['defaultSnapshot']>,
): AccountRateLimitsState {
  const limitId = snapshot.limitId?.trim() ?? ''
  const nextByLimitId = { ...(current?.byLimitId ?? {}) }

  if (limitId) {
    nextByLimitId[limitId] = snapshot
  }

  return {
    defaultSnapshot: current?.defaultSnapshot?.limitId === snapshot.limitId || !current?.defaultSnapshot
      ? snapshot
      : current.defaultSnapshot,
    byLimitId: nextByLimitId,
    rateLimitResetCredits: current?.rateLimitResetCredits ?? { availableCount: 0, credits: [] },
  }
}

function rateLimitResetErrorMessage(code: string): string {
  if (code === 'no_credit') return 'No resets are available'
  if (code === 'nothing_to_reset') return 'Your usage does not need a reset right now'
  if (code === 'already_redeemed') return 'This reset was already used'
  return 'Failed to use rate limit reset'
}

function areThreadFieldsEqual(first: UiThread, second: UiThread): boolean {
  return (
    first.id === second.id &&
    first.title === second.title &&
    first.projectName === second.projectName &&
    first.cwd === second.cwd &&
    first.createdAtIso === second.createdAtIso &&
    first.updatedAtIso === second.updatedAtIso &&
    first.preview === second.preview &&
    first.runtimeStatus === second.runtimeStatus &&
    first.unread === second.unread &&
    first.inProgress === second.inProgress
  )
}

function areThreadArraysEqual(first: UiThread[], second: UiThread[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function areGroupArraysEqual(first: UiProjectGroup[], second: UiProjectGroup[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function pruneThreadStateMap<T>(stateMap: Record<string, T>, threadIds: Set<string>): Record<string, T> {
  const nextEntries = Object.entries(stateMap).filter(([threadId]) => threadIds.has(threadId))
  if (nextEntries.length === Object.keys(stateMap).length) {
    return stateMap
  }
  return Object.fromEntries(nextEntries) as Record<string, T>
}

function pruneThreadOrder(order: string[], threadIds: Set<string>): string[] {
  const nextOrder = order.filter((threadId) => threadIds.has(threadId))
  return areStringArraysEqual(order, nextOrder) ? order : nextOrder
}

function mergeThreadGroups(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
): UiProjectGroup[] {
  const previousGroupsByName = new Map(previous.map((group) => [group.projectName, group]))
  const mergedGroups: UiProjectGroup[] = incoming.map((incomingGroup) => {
    const previousGroup = previousGroupsByName.get(incomingGroup.projectName)
    const previousThreadsById = new Map(previousGroup?.threads.map((thread) => [thread.id, thread]) ?? [])

    const mergedThreads = incomingGroup.threads.map((incomingThread) => {
      const previousThread = previousThreadsById.get(incomingThread.id)
      if (previousThread && areThreadFieldsEqual(previousThread, incomingThread)) {
        return previousThread
      }
      return incomingThread
    })

    if (
      previousGroup &&
      previousGroup.projectName === incomingGroup.projectName &&
      areThreadArraysEqual(previousGroup.threads, mergedThreads)
    ) {
      return previousGroup
    }

    return {
      projectName: incomingGroup.projectName,
      threads: mergedThreads,
    }
  })

  return areGroupArraysEqual(previous, mergedGroups) ? previous : mergedGroups
}

function mergeIncomingWithLocalRetainedThreads(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
  inProgressById: Record<string, boolean>,
  threadGoalByThreadId: Record<string, UiThreadGoal>,
  selectedThreadId: string,
): UiProjectGroup[] {
  const incomingThreadIds = new Set(flattenThreads(incoming).map((thread) => thread.id))
  const localRetainedThreads = flattenThreads(previous).filter(
    (thread) =>
      !incomingThreadIds.has(thread.id) &&
      (
        inProgressById[thread.id] === true ||
        !!threadGoalByThreadId[thread.id] ||
        thread.id === selectedThreadId
      ),
  )

  if (localRetainedThreads.length === 0) {
    return incoming
  }

  const incomingByProjectName = new Map(incoming.map((group) => [group.projectName, group]))
  const merged: UiProjectGroup[] = incoming.map((group) => ({
    projectName: group.projectName,
    threads: [...group.threads],
  }))

  for (const thread of localRetainedThreads) {
    const existingGroup = incomingByProjectName.get(thread.projectName)
    if (existingGroup) {
      const mergedGroupIndex = merged.findIndex((group) => group.projectName === thread.projectName)
      if (mergedGroupIndex >= 0) {
        merged[mergedGroupIndex] = {
          projectName: merged[mergedGroupIndex].projectName,
          threads: [thread, ...merged[mergedGroupIndex].threads],
        }
      }
      continue
    }

    merged.push({
      projectName: thread.projectName,
      threads: [thread],
    })
  }

  return merged
}

function toProjectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.at(-1) || cwd || 'unknown-project'
}

function toProjectNameFromWorkspaceRoot(value: string): string {
  const normalized = value.replace(/\\/gu, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.at(-1) || normalized
}

function toOptimisticThreadTitle(message: string): string {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) return 'Untitled thread'
  return firstLine.slice(0, 80)
}

export function useDesktopState() {
  const persistedRuntimeState = loadPersistedThreadRuntimeState()
  const persistedNewThreadModelConfig = loadNewThreadModelConfig()
  const projectGroups = ref<UiProjectGroup[]>([])
  const sourceGroups = ref<UiProjectGroup[]>([])
  const selectedThreadId = ref(loadSelectedThreadId())
  const persistedMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveAgentMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveReasoningTextByThreadId = ref<Record<string, string>>({})
  const liveCommandsByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveToolMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const inProgressById = ref<Record<string, boolean>>(persistedRuntimeState.inProgressById)
  type FileAttachment = { label: string; path: string; fsPath: string }
  type QueuedMessage = {
    id: string
    text: string
    imageUrls: string[]
    skills: Array<{ name: string; path: string }>
    plugins: PluginMentionParam[]
    threads: ThreadMentionParam[]
    fileAttachments: FileAttachment[]
    responseTextAnnotations: ResponseTextAnnotation[]
  }
  const queuedMessagesByThreadId = ref<Record<string, QueuedMessage[]>>({})
  const eventUnreadByThreadId = ref<Record<string, boolean>>({})
  const manuallyRenamedThreadIds = new Set<string>()
  const availableModelIds = ref<string[]>([])
  const defaultModelId = ref(PREFERRED_DEFAULT_MODEL_ID)
  const defaultReasoningEffort = ref<ReasoningEffort | ''>(DEFAULT_REASONING_EFFORT)
  const fastServiceTierByModel = ref<FastServiceTierByModel>({})
  const fastModeEnabled = ref(false)
  const isUpdatingFastMode = ref(false)
  const fastModeError = ref('')
  const selectedModelId = ref(persistedNewThreadModelConfig.model)
  const selectedReasoningEffort = ref<ReasoningEffort | ''>(persistedNewThreadModelConfig.reasoningEffort)
  const threadModelConfigById = ref<Record<string, ThreadModelConfig>>(loadThreadModelConfigMap())
  const newThreadModelConfig = ref<ThreadModelConfig>(persistedNewThreadModelConfig)
  const readStateByThreadId = ref<Record<string, string>>(loadReadStateMap())
  const sharedReadStateVersion = ref(0)
  const scrollStateByThreadId = ref<Record<string, ThreadScrollState>>(loadThreadScrollStateMap())
  const projectOrder = ref<string[]>(loadProjectOrder())
  const projectDisplayNameById = ref<Record<string, string>>(loadProjectDisplayNames())
  const threadOrder = ref<string[]>(loadThreadOrder())
  const loadedVersionByThreadId = ref<Record<string, string>>({})
  const loadedMessagesByThreadId = ref<Record<string, boolean>>({})
  const recentMessageThreadIds: string[] = []
  let historyReadSequence = 0
  let historyReadReset = 0
  const appliedTailReadByThreadId = new Map<string, number>()
  const resetHistoryReadByThreadId = new Map<string, number>()
  const realtimeMessageVersionByThreadId = new Map<string, number>()
  const agentMessageVersionByThreadId = new Map<string, Map<string, number>>()
  const paginationByThreadId = ref<Record<string, ThreadPaginationState>>({})
  const loadingEarlierByThreadId = ref<Record<string, boolean>>({})
  const earlierLoadErrorByThreadId = ref<Record<string, string>>({})
  const resumedThreadById = ref<Record<string, boolean>>({})
  const turnSummaryByThreadId = ref<TurnSummaryByThreadId>(loadTurnSummaryMap())
  const turnActivityByThreadId = ref<Record<string, TurnActivityState>>({})
  const turnErrorByThreadId = ref<Record<string, TurnErrorState>>({})
  const threadGoalByThreadId = ref<Record<string, UiThreadGoal>>({})
  const threadTokenUsageByThreadId = ref<Record<string, UiThreadTokenUsage>>({})
  const activeTurnIdByThreadId = ref<Record<string, string>>(persistedRuntimeState.activeTurnIdByThreadId)
  const pendingServerRequestsByThreadId = ref<Record<string, UiServerRequest[]>>({})

  const threadTitleById = ref<Record<string, string>>({})

  const installedSkills = ref<SkillInfo[]>([])

  const isLoadingThreads = ref(false)
  const isLoadingMessages = ref(false)
  const isSendingMessage = ref(false)
  const isInterruptingTurn = ref(false)
  const isForkingThread = ref(false)
  const isRollingBack = ref(false)
  const isUsingRateLimitReset = ref(false)
  const error = ref('')
  const isPolling = ref(false)
  const hasLoadedThreads = ref(false)
  let stopNotificationStream: (() => void) | null = null
  let eventSyncTimer: number | null = null
  let pendingThreadsRefresh = false
  const pendingThreadMessageRefresh = new Set<string>()
  let hasHydratedWorkspaceRootsState = false
  let activeReasoningItemId = ''
  let shouldAutoScrollOnNextAgentEvent = false
  const pendingTurnStartsById = new Map<string, TurnStartedInfo>()
  const pendingGoalContinuationsByThreadId = new Set<string>()
  const autoClearedCompletedGoalUpdatedAtByThreadId = new Map<string, number>()
  const accountRateLimits = ref<AccountRateLimitsState | null>(null)
  const liveOrderCounterByThreadId = new Map<string, number>()
  const liveTurnIndexByTurnId = new Map<string, number>()
  const liveItemIndexByItemKey = new Map<string, number>()
  const liveItemCounterByTurnKey = new Map<string, number>()
  const inProgressReconcileTimerByThreadId = new Map<string, number>()
  let boardManagedThreadIds = new Set<string>()
  const browserNotifiedTurnKeys = new Set<string>()
  const browserNotifiedTurnOrder: string[] = []
  const audienceByThreadId = new Map<string, Exclude<CodexThreadAudience, 'unknown'>>()
  const pendingAudienceLookupByThreadId = new Map<string, Promise<CodexThreadAudience>>()

  const fastModeAvailable = computed(() => Object.keys(fastServiceTierByModel.value).length > 0)
  const allThreads = computed(() => flattenThreads(projectGroups.value))
  const selectedThread = computed(() =>
    allThreads.value.find((thread) => thread.id === selectedThreadId.value) ?? null,
  )
  const selectedThreadScrollState = computed<ThreadScrollState | null>(
    () => scrollStateByThreadId.value[selectedThreadId.value] ?? null,
  )
  const selectedThreadGoal = computed<UiThreadGoal | null>(
    () => threadGoalByThreadId.value[selectedThreadId.value] ?? null,
  )
  const selectedThreadTokenUsage = computed<UiThreadTokenUsage | null>(
    () => threadTokenUsageByThreadId.value[selectedThreadId.value] ?? null,
  )
  const selectedThreadServerRequests = computed<UiServerRequest[]>(() => {
    const rows: UiServerRequest[] = []
    const selected = selectedThreadId.value
    if (selected && Array.isArray(pendingServerRequestsByThreadId.value[selected])) {
      rows.push(...pendingServerRequestsByThreadId.value[selected])
    }
    if (Array.isArray(pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])) {
      rows.push(...pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])
    }
    return rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
  })
  const selectedLiveOverlay = computed<UiLiveOverlay | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null
    if (inProgressById.value[threadId] !== true) return null

    const activity = turnActivityByThreadId.value[threadId]
    const reasoningText = (liveReasoningTextByThreadId.value[threadId] ?? '').trim()
    const errorText = (turnErrorByThreadId.value[threadId]?.message ?? '').trim()

    if (!activity && !reasoningText && !errorText) {
      return {
        activityLabel: 'Thinking',
        activityDetails: [],
        reasoningText: '',
        errorText: '',
      }
    }
    return {
      activityLabel: activity?.label || 'Thinking',
      activityDetails: activity?.details ?? [],
      reasoningText,
      errorText,
    }
  })
  const messages = computed<UiMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const liveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
    const liveCommands = liveCommandsByThreadId.value[threadId] ?? []
    const liveToolMessages = liveToolMessagesByThreadId.value[threadId] ?? []
    // A live item can already exist in a hydrated page. Render its newest
    // version once; duplicate keys can otherwise leave an empty/stale body.
    const combinedById = new Map([...persisted, ...liveCommands, ...liveToolMessages, ...liveAgent]
      .map((message) => [message.id, message]))
    const combined = sortMessagesByOrder([...combinedById.values()])

    const summaries = turnSummaryByThreadId.value[threadId] ?? []
    if (summaries.length === 0) return combined
    return insertTurnSummaryMessages(combined, summaries)
  })
  const selectedThreadPagination = computed<ThreadPaginationState | null>(() => {
    const threadId = selectedThreadId.value
    return threadId ? paginationByThreadId.value[threadId] ?? null : null
  })
  const selectedThreadHasEarlierMessages = computed(
    () => selectedThreadPagination.value?.hasEarlier === true,
  )
  const isLoadingSelectedThreadEarlierMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? loadingEarlierByThreadId.value[threadId] === true : false
  })
  const selectedThreadEarlierLoadError = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? earlierLoadErrorByThreadId.value[threadId] ?? '' : ''
  })

  function setSelectedThreadId(nextThreadId: string): void {
    if (selectedThreadId.value === nextThreadId) return
    const previousThreadId = selectedThreadId.value
    selectedThreadId.value = nextThreadId
    if (previousThreadId) {
      trimInactiveMessageCache(previousThreadId)
      rememberMessageCache(previousThreadId)
    }
    if (nextThreadId) rememberMessageCache(nextThreadId)
    saveSelectedThreadId(nextThreadId)
    activeReasoningItemId = ''
    shouldAutoScrollOnNextAgentEvent = false
  }

  function getDefaultModelConfig(): ThreadModelConfig {
    const model = defaultModelId.value && (
      availableModelIds.value.length === 0 ||
      availableModelIds.value.includes(defaultModelId.value)
    )
      ? defaultModelId.value
      : pickDefaultModelId(availableModelIds.value)
    return {
      model,
      reasoningEffort: defaultReasoningEffort.value || DEFAULT_REASONING_EFFORT,
    }
  }

  function getNewThreadModelConfig(): ThreadModelConfig {
    const fallback = getDefaultModelConfig()
    const configuredModel = newThreadModelConfig.value.model.trim()
    const model = configuredModel && (
      availableModelIds.value.length === 0 ||
      availableModelIds.value.includes(configuredModel)
    )
      ? configuredModel
      : fallback.model
    return {
      model,
      reasoningEffort: normalizeReasoningEffortPreference(newThreadModelConfig.value.reasoningEffort) || fallback.reasoningEffort,
    }
  }

  function setPickerModelConfig(config: ThreadModelConfig): void {
    selectedModelId.value = config.model
    selectedReasoningEffort.value = config.reasoningEffort
  }

  function applyDefaultModelConfig(): void {
    const config = getDefaultModelConfig()
    setPickerModelConfig(config)
  }

  function applyNewThreadModelConfig(): void {
    const config = getNewThreadModelConfig()
    newThreadModelConfig.value = config
    saveNewThreadModelConfig(config)
    setPickerModelConfig(config)
  }

  function applyThreadModelConfig(threadId: string, config: ThreadModelConfig, applyToPicker: boolean): void {
    const model = config.model.trim()
    const reasoningEffort = normalizeReasoningEffortPreference(config.reasoningEffort)
    if (!model && !reasoningEffort) return

    const previousConfig = threadModelConfigById.value[threadId]
    const nextConfig = {
      model: model || previousConfig?.model || getDefaultModelConfig().model,
      reasoningEffort: reasoningEffort || previousConfig?.reasoningEffort || getDefaultModelConfig().reasoningEffort,
    }
    const hasChanged =
      previousConfig?.model !== nextConfig.model ||
      previousConfig?.reasoningEffort !== nextConfig.reasoningEffort
    if (hasChanged) {
      threadModelConfigById.value = {
        ...threadModelConfigById.value,
        [threadId]: nextConfig,
      }
      saveThreadModelConfigMap(threadModelConfigById.value)
    }
    if (!applyToPicker) return
    setPickerModelConfig(nextConfig)
  }

  function getTurnModelConfig(threadId: string): ThreadModelConfig {
    if (threadId && threadId === selectedThreadId.value) {
      return {
        model: selectedModelId.value.trim(),
        reasoningEffort: selectedReasoningEffort.value,
      }
    }
    return threadModelConfigById.value[threadId] ?? getDefaultModelConfig()
  }

  function getRequestedServiceTier(modelId: string): string | null {
    const resolvedModelId = modelId.trim() || getDefaultModelConfig().model
    return serviceTierForModel(
      fastModeEnabled.value,
      resolvedModelId,
      fastServiceTierByModel.value,
    )
  }

  async function setSelectedModelId(modelId: string): Promise<void> {
    const nextModelId = modelId.trim()
    if (selectedModelId.value === nextModelId) return

    selectedModelId.value = nextModelId
    const threadId = selectedThreadId.value
    if (threadId) {
      applyThreadModelConfig(threadId, {
        model: nextModelId,
        reasoningEffort: selectedReasoningEffort.value,
      }, false)
      return
    }
    newThreadModelConfig.value = {
      model: nextModelId,
      reasoningEffort: selectedReasoningEffort.value || getDefaultModelConfig().reasoningEffort,
    }
    saveNewThreadModelConfig(newThreadModelConfig.value)
  }

  async function setSelectedReasoningEffort(effort: ReasoningEffort | ''): Promise<void> {
    if (effort && !REASONING_EFFORT_OPTIONS.includes(effort)) {
      return
    }
    if (selectedReasoningEffort.value === effort) return

    selectedReasoningEffort.value = effort
    const threadId = selectedThreadId.value
    if (threadId) {
      applyThreadModelConfig(threadId, {
        model: selectedModelId.value,
        reasoningEffort: effort,
      }, false)
      return
    }
    newThreadModelConfig.value = {
      model: selectedModelId.value.trim() || getDefaultModelConfig().model,
      reasoningEffort: effort || getDefaultModelConfig().reasoningEffort,
    }
    saveNewThreadModelConfig(newThreadModelConfig.value)
  }

  async function setFastModeEnabled(enabled: boolean): Promise<void> {
    if (isUpdatingFastMode.value || (fastModeEnabled.value === enabled && !fastModeError.value)) return

    const previousValue = fastModeEnabled.value
    fastModeEnabled.value = enabled
    fastModeError.value = ''
    isUpdatingFastMode.value = true
    try {
      await setFastModePreference(enabled)
    } catch (unknownError) {
      fastModeEnabled.value = previousValue
      fastModeError.value = unknownError instanceof Error
        ? unknownError.message
        : 'Could not save the Speed setting'
    } finally {
      isUpdatingFastMode.value = false
    }
  }

  async function refreshFastModePreference(): Promise<void> {
    if (isUpdatingFastMode.value) return
    try {
      const currentConfig = await getCurrentModelConfig()
      fastModeEnabled.value = currentConfig.fastModeEnabled
      fastModeError.value = ''
    } catch {
      // Keep the last known preference when another device cannot be reached.
    }
  }

  function buildPendingTurnDetails(modelId: string, effort: ReasoningEffort | ''): string[] {
    const modelLabel = modelId.trim() || 'default'
    const effortLabel = effort || 'default'
    return [`Model: ${modelLabel}`, `Thinking: ${effortLabel}`]
  }

  async function refreshModelPreferences(): Promise<void> {
    try {
      const [modelCatalog, currentConfig, runtimeConfig] = await Promise.all([
        getAvailableModelCatalog(),
        getCurrentModelConfig(),
        getCodexUiRuntimeConfig(),
      ])
      const modelIds = modelCatalog.ids

      availableModelIds.value = modelIds
      fastServiceTierByModel.value = modelCatalog.fastServiceTierByModel
      if (!isUpdatingFastMode.value) {
        fastModeEnabled.value = currentConfig.fastModeEnabled
        fastModeError.value = ''
      }

      defaultModelId.value = modelIds.length === 0 || modelIds.includes(PREFERRED_DEFAULT_MODEL_ID)
        ? PREFERRED_DEFAULT_MODEL_ID
        : pickDefaultModelId(modelIds)

      const configuredDefaultReasoningEffort =
        runtimeConfig.defaultReasoningEffort || DEFAULT_REASONING_EFFORT
      defaultReasoningEffort.value = configuredDefaultReasoningEffort

      if (
        defaultModelId.value &&
        (currentConfig.model !== defaultModelId.value || currentConfig.reasoningEffort !== configuredDefaultReasoningEffort)
      ) {
        try {
          await setDefaultModel(defaultModelId.value, configuredDefaultReasoningEffort)
        } catch {
          // Frontend defaults still apply when app-server config persistence is unavailable.
        }
      }

      if (runtimeConfig.defaultReasoningEffort) {
        newThreadModelConfig.value = {
          model: defaultModelId.value,
          reasoningEffort: runtimeConfig.defaultReasoningEffort,
        }
        saveNewThreadModelConfig(newThreadModelConfig.value)
      }

      if (!selectedThreadId.value) {
        applyNewThreadModelConfig()
      } else if (!selectedModelId.value || (modelIds.length > 0 && !modelIds.includes(selectedModelId.value))) {
        const cached = threadModelConfigById.value[selectedThreadId.value]
        if (cached) {
          applyThreadModelConfig(selectedThreadId.value, cached, true)
        } else {
          applyDefaultModelConfig()
        }
      }
    } catch {
      // Keep chat UI usable even if model metadata is temporarily unavailable.
    }
  }

  function applyCachedTitlesToGroups(groups: UiProjectGroup[]): UiProjectGroup[] {
    const titles = threadTitleById.value
    if (Object.keys(titles).length === 0) return groups
    return groups.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const cached = titles[thread.id]
        return cached ? { ...thread, title: cached } : thread
      }),
    }))
  }

  function applyThreadFlags(): void {
    const withTitles = applyCachedTitlesToGroups(sourceGroups.value)
    const flaggedGroups: UiProjectGroup[] = withTitles.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const inProgress = inProgressById.value[thread.id] === true
        const isSelected = selectedThreadId.value === thread.id
        const lastReadIso = readStateByThreadId.value[thread.id]
        const hasReadState = typeof lastReadIso === 'string' && lastReadIso.length > 0
        const unreadByEvent = eventUnreadByThreadId.value[thread.id] === true
        const unread = !isSelected &&
          !inProgress &&
          (unreadByEvent || (hasReadState && hasThreadActivityAfterRead(lastReadIso, thread.updatedAtIso)))

        return {
          ...thread,
          inProgress,
          unread,
        }
      }),
    }))
    projectGroups.value = mergeThreadGroups(projectGroups.value, flaggedGroups)
  }

  function promoteThreadForActivity(threadId: string, activityAtIso = new Date().toISOString()): void {
    if (!threadId) return

    const activityAtMs = Date.parse(activityAtIso)
    let foundThread = false
    const nextGroups = sourceGroups.value.map((group) => {
      const threadIndex = group.threads.findIndex((thread) => thread.id === threadId)
      if (threadIndex < 0) return group

      foundThread = true
      const thread = group.threads[threadIndex]
      const currentUpdatedAtMs = Date.parse(thread.updatedAtIso)
      const shouldUpdateTimestamp =
        Number.isFinite(activityAtMs) &&
        (!Number.isFinite(currentUpdatedAtMs) || activityAtMs > currentUpdatedAtMs)
      const promotedThread = shouldUpdateTimestamp
        ? { ...thread, updatedAtIso: activityAtIso }
        : thread
      const nextThreads = [
        promotedThread,
        ...group.threads.filter((candidate) => candidate.id !== threadId),
      ]

      return {
        ...group,
        threads: nextThreads,
      }
    })

    if (!foundThread) return

    sourceGroups.value = nextGroups
    const activeThreadIds = flattenThreads(nextGroups).map((thread) => thread.id)
    const activeThreadIdSet = new Set(activeThreadIds)
    const baseOrder = threadOrder.value.length > 0 ? threadOrder.value : activeThreadIds
    const nextOrder = [
      threadId,
      ...baseOrder.filter((candidate) => candidate !== threadId && activeThreadIdSet.has(candidate)),
    ]
    for (const activeThreadId of activeThreadIds) {
      if (!nextOrder.includes(activeThreadId)) {
        nextOrder.push(activeThreadId)
      }
    }

    if (!areStringArraysEqual(threadOrder.value, nextOrder)) {
      threadOrder.value = nextOrder
      saveThreadOrder(nextOrder)
    }
    applyThreadFlags()
  }

  function insertOptimisticThread(threadId: string, cwd: string, firstMessageText: string): void {
    const nowIso = new Date().toISOString()
    const normalizedCwd = cwd.trim()
    const projectName = toProjectName(normalizedCwd)
    const nextThread: UiThread = {
      id: threadId,
      title: toOptimisticThreadTitle(firstMessageText),
      projectName,
      cwd: normalizedCwd,
      hasWorktree: normalizedCwd.includes('/.codex/worktrees/') || normalizedCwd.includes('/.git/worktrees/'),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      preview: firstMessageText,
      unread: false,
      inProgress: false,
    }

    const existingGroupIndex = sourceGroups.value.findIndex((group) => group.projectName === projectName)
    if (existingGroupIndex >= 0) {
      const existingGroup = sourceGroups.value[existingGroupIndex]
      const remainingThreads = existingGroup.threads.filter((thread) => thread.id !== threadId)
      const nextGroup: UiProjectGroup = {
        projectName,
        threads: [nextThread, ...remainingThreads],
      }
      const nextGroups = [...sourceGroups.value]
      nextGroups.splice(existingGroupIndex, 1, nextGroup)
      sourceGroups.value = nextGroups
    } else {
      sourceGroups.value = [{ projectName, threads: [nextThread] }, ...sourceGroups.value]
    }

    const nextProjectOrder = mergeProjectOrder(projectOrder.value, sourceGroups.value)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }
    if (threadOrder.value.length > 0) {
      threadOrder.value = [threadId, ...threadOrder.value.filter((id) => id !== threadId)]
      saveThreadOrder(threadOrder.value)
    }
    applyThreadFlags()
  }

  function ensureSearchThreadVisible(thread: UiThread): void {
    if (!thread.id) return

    const existingGroupIndex = sourceGroups.value.findIndex((group) => group.projectName === thread.projectName)
    if (existingGroupIndex >= 0) {
      const existingGroup = sourceGroups.value[existingGroupIndex]
      const existingThreadIndex = existingGroup.threads.findIndex((candidate) => candidate.id === thread.id)
      const nextThreads = existingThreadIndex >= 0
        ? existingGroup.threads.map((candidate) => candidate.id === thread.id ? thread : candidate)
        : [...existingGroup.threads, thread]
      const nextGroups = [...sourceGroups.value]
      nextGroups.splice(existingGroupIndex, 1, {
        ...existingGroup,
        threads: nextThreads,
      })
      sourceGroups.value = nextGroups
    } else {
      sourceGroups.value = [
        ...sourceGroups.value,
        {
          projectName: thread.projectName,
          threads: [thread],
        },
      ]
    }

    const nextProjectOrder = mergeProjectOrder(projectOrder.value, sourceGroups.value)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(nextProjectOrder)
    }
    applyThreadFlags()
  }

  function pruneThreadScopedState(flatThreads: UiThread[]): void {
    const activeThreadIds = new Set(flatThreads.map((thread) => thread.id))
    for (const threadId of Array.from(liveOrderCounterByThreadId.keys())) {
      if (!activeThreadIds.has(threadId)) {
        liveOrderCounterByThreadId.delete(threadId)
      }
    }
    const nextReadState = pruneThreadStateMap(readStateByThreadId.value, activeThreadIds)
    if (nextReadState !== readStateByThreadId.value) {
      readStateByThreadId.value = nextReadState
      saveReadStateMap(nextReadState)
    }
    const nextScrollState = pruneThreadStateMap(scrollStateByThreadId.value, activeThreadIds)
    if (nextScrollState !== scrollStateByThreadId.value) {
      scrollStateByThreadId.value = nextScrollState
      saveThreadScrollStateMap(nextScrollState)
    }
    loadedMessagesByThreadId.value = pruneThreadStateMap(loadedMessagesByThreadId.value, activeThreadIds)
    paginationByThreadId.value = pruneThreadStateMap(paginationByThreadId.value, activeThreadIds)
    loadingEarlierByThreadId.value = pruneThreadStateMap(loadingEarlierByThreadId.value, activeThreadIds)
    earlierLoadErrorByThreadId.value = pruneThreadStateMap(earlierLoadErrorByThreadId.value, activeThreadIds)
    loadedVersionByThreadId.value = pruneThreadStateMap(loadedVersionByThreadId.value, activeThreadIds)
    resumedThreadById.value = pruneThreadStateMap(resumedThreadById.value, activeThreadIds)
    persistedMessagesByThreadId.value = pruneThreadStateMap(persistedMessagesByThreadId.value, activeThreadIds)
    liveAgentMessagesByThreadId.value = pruneThreadStateMap(liveAgentMessagesByThreadId.value, activeThreadIds)
    liveReasoningTextByThreadId.value = pruneThreadStateMap(liveReasoningTextByThreadId.value, activeThreadIds)
    liveCommandsByThreadId.value = pruneThreadStateMap(liveCommandsByThreadId.value, activeThreadIds)
    liveToolMessagesByThreadId.value = pruneThreadStateMap(liveToolMessagesByThreadId.value, activeThreadIds)
    const nextTurnSummaryByThreadId = pruneThreadStateMap(turnSummaryByThreadId.value, activeThreadIds)
    if (nextTurnSummaryByThreadId !== turnSummaryByThreadId.value) {
      turnSummaryByThreadId.value = nextTurnSummaryByThreadId
      saveTurnSummaryMap(nextTurnSummaryByThreadId)
    }
    turnActivityByThreadId.value = pruneThreadStateMap(turnActivityByThreadId.value, activeThreadIds)
    turnErrorByThreadId.value = pruneThreadStateMap(turnErrorByThreadId.value, activeThreadIds)
    threadGoalByThreadId.value = pruneThreadStateMap(threadGoalByThreadId.value, activeThreadIds)
    const nextActiveTurnIds = pruneThreadStateMap(activeTurnIdByThreadId.value, activeThreadIds)
    if (nextActiveTurnIds !== activeTurnIdByThreadId.value) {
      activeTurnIdByThreadId.value = nextActiveTurnIds
      saveActiveTurnIdMap(nextActiveTurnIds)
    }
    eventUnreadByThreadId.value = pruneThreadStateMap(eventUnreadByThreadId.value, activeThreadIds)
    const nextInProgressById = pruneThreadStateMap(inProgressById.value, activeThreadIds)
    if (nextInProgressById !== inProgressById.value) {
      inProgressById.value = nextInProgressById
    }
    const nextPending: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      if (threadId === GLOBAL_SERVER_REQUEST_SCOPE || activeThreadIds.has(threadId)) {
        nextPending[threadId] = requests
      }
    }
    pendingServerRequestsByThreadId.value = nextPending

    const nextThreadModelConfigById = pruneThreadStateMap(threadModelConfigById.value, activeThreadIds)
    if (nextThreadModelConfigById !== threadModelConfigById.value) {
      threadModelConfigById.value = nextThreadModelConfigById
      saveThreadModelConfigMap(nextThreadModelConfigById)
    }

    const nextThreadOrder = pruneThreadOrder(threadOrder.value, activeThreadIds)
    if (nextThreadOrder !== threadOrder.value) {
      threadOrder.value = nextThreadOrder
      saveThreadOrder(nextThreadOrder)
    }
  }

  let hasHydratedSharedReadState = false

  function applySharedReadState(state: SharedThreadReadState, force = false): void {
    if (
      hasHydratedSharedReadState &&
      (
        state.version < sharedReadStateVersion.value ||
        (!force && state.version === sharedReadStateVersion.value)
      )
    ) {
      return
    }
    hasHydratedSharedReadState = true
    sharedReadStateVersion.value = state.version
    readStateByThreadId.value = { ...state.readAtByThreadId }
    saveReadStateMap(readStateByThreadId.value)
    eventUnreadByThreadId.value = Object.fromEntries(
      state.unreadThreadIds.map((threadId) => [threadId, true]),
    )
    applyThreadFlags()

    const selectedId = selectedThreadId.value
    if (selectedId && state.unreadThreadIds.includes(selectedId)) {
      markThreadAsRead(selectedId)
    }
  }

  async function refreshThreadReadState(): Promise<void> {
    try {
      const state = await getSharedThreadReadState()
      applySharedReadState(state, true)
    } catch {
      // Keep current state while offline; the next resume or bridge reconnect retries.
    }
  }

  function persistSharedReadState(
    threadId: string,
    options: { unread: boolean; readAtIso?: string },
  ): void {
    void updateSharedThreadReadState(threadId, options)
      .then(applySharedReadState)
      .catch(() => {
        // Keep the local fallback; the next thread refresh will retry hydration.
      })
  }

  function markThreadAsRead(threadId: string): void {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    if (!thread) return
    const wasUnreadByEvent = eventUnreadByThreadId.value[threadId] === true
    if (readStateByThreadId.value[threadId] === thread.updatedAtIso && !wasUnreadByEvent) return

    readStateByThreadId.value = {
      ...readStateByThreadId.value,
      [threadId]: thread.updatedAtIso,
    }
    saveReadStateMap(readStateByThreadId.value)
    if (wasUnreadByEvent) {
      eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, threadId)
    }
    applyThreadFlags()
    persistSharedReadState(threadId, { unread: false, readAtIso: thread.updatedAtIso })
  }

  function setTurnSummaryForThread(threadId: string, summary: TurnSummaryState): void {
    if (!threadId) return

    const previous = turnSummaryByThreadId.value[threadId] ?? []
    const existingIndex = previous.findIndex((entry) => entry.turnId === summary.turnId)
    const next = existingIndex >= 0
      ? previous.map((entry, index) => (index === existingIndex ? summary : entry))
      : [...previous, summary]
    if (areTurnSummaryArraysEqual(previous, next)) return

    turnSummaryByThreadId.value = {
      ...turnSummaryByThreadId.value,
      [threadId]: next,
    }
    saveTurnSummaryMap(turnSummaryByThreadId.value)
  }

  function setTurnSummariesForThread(
    threadId: string,
    summaries: ThreadTurnSummary[],
    options: { preserveMissing?: boolean } = {},
  ): void {
    if (!threadId) return
    const normalizedSummaries = summaries
      .map((summary) => ({
        turnId: typeof summary.turnId === 'string' ? summary.turnId.trim() : '',
        durationMs: typeof summary.durationMs === 'number' && Number.isFinite(summary.durationMs)
          ? Math.max(0, summary.durationMs)
          : null,
      }))
      .filter((summary): summary is TurnSummaryState => Boolean(summary.turnId) && summary.durationMs !== null)

    const previous = turnSummaryByThreadId.value[threadId] ?? []
    const nextSummaries = options.preserveMissing
      ? normalizeTurnSummaryList([...previous, ...normalizedSummaries])
      : normalizedSummaries
    if (nextSummaries.length === 0) {
      if (previous.length === 0) return
      turnSummaryByThreadId.value = omitKey(turnSummaryByThreadId.value, threadId)
      saveTurnSummaryMap(turnSummaryByThreadId.value)
      return
    }

    if (areTurnSummaryArraysEqual(previous, nextSummaries)) return
    turnSummaryByThreadId.value = {
      ...turnSummaryByThreadId.value,
      [threadId]: nextSummaries,
    }
    saveTurnSummaryMap(turnSummaryByThreadId.value)
  }

  function setThreadPagination(
    threadId: string,
    page: ThreadPaginationState,
    options: { preserveEarlier?: boolean } = {},
  ): void {
    const previous = paginationByThreadId.value[threadId]
    const startTurnIndex = options.preserveEarlier && previous
      ? Math.min(previous.startTurnIndex, page.startTurnIndex)
      : page.startTurnIndex
    paginationByThreadId.value = {
      ...paginationByThreadId.value,
      [threadId]: {
        ...page,
        startTurnIndex,
        hasEarlier: startTurnIndex > 0,
      },
    }
  }

  function clearTurnSummariesForThread(threadId: string): void {
    if (!threadId || !turnSummaryByThreadId.value[threadId]) return
    turnSummaryByThreadId.value = omitKey(turnSummaryByThreadId.value, threadId)
    saveTurnSummaryMap(turnSummaryByThreadId.value)
  }

  function setActiveTurnIdForThread(threadId: string, turnId: string | null): void {
    if (!threadId) return
    const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : ''
    if (!normalizedTurnId) {
      if (!(threadId in activeTurnIdByThreadId.value)) return
      activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
      saveActiveTurnIdMap(activeTurnIdByThreadId.value)
      return
    }

    if (activeTurnIdByThreadId.value[threadId] === normalizedTurnId) return
    activeTurnIdByThreadId.value = {
      ...activeTurnIdByThreadId.value,
      [threadId]: normalizedTurnId,
    }
    saveActiveTurnIdMap(activeTurnIdByThreadId.value)
  }

  function setThreadInProgress(threadId: string, nextInProgress: boolean): void {
    if (!threadId) return
    const currentValue = inProgressById.value[threadId] === true
    if (!nextInProgress) {
      const timer = inProgressReconcileTimerByThreadId.get(threadId)
      if (typeof timer === 'number' && typeof window !== 'undefined') {
        window.clearTimeout(timer)
      }
      inProgressReconcileTimerByThreadId.delete(threadId)
    }
    if (currentValue === nextInProgress) return
    if (nextInProgress) {
      inProgressById.value = {
        ...inProgressById.value,
        [threadId]: true,
      }
    } else {
      inProgressById.value = omitKey(inProgressById.value, threadId)
      setActiveTurnIdForThread(threadId, null)
    }
    applyThreadFlags()
  }

  function syncThreadProgressFromRuntimeStatuses(groups: UiProjectGroup[]): void {
    let nextInProgressById = inProgressById.value
    let nextActiveTurnIds = activeTurnIdByThreadId.value

    for (const thread of flattenThreads(groups)) {
      if (!thread.runtimeStatus) continue
      const isActive = thread.runtimeStatus === 'active'
      const isMarkedActive = nextInProgressById[thread.id] === true

      if (isActive !== isMarkedActive) {
        nextInProgressById = isActive
          ? { ...nextInProgressById, [thread.id]: true }
          : omitKey(nextInProgressById, thread.id)
      }
      if (!isActive && thread.id in nextActiveTurnIds) {
        nextActiveTurnIds = omitKey(nextActiveTurnIds, thread.id)
      }
    }

    if (nextInProgressById !== inProgressById.value) {
      inProgressById.value = nextInProgressById
    }
    if (nextActiveTurnIds !== activeTurnIdByThreadId.value) {
      activeTurnIdByThreadId.value = nextActiveTurnIds
      saveActiveTurnIdMap(nextActiveTurnIds)
    }
  }

  // Snapshot order/metadata is canonical, but its text may precede observed
  // deltas. Explicit live completion can also replace text with a shorter answer.
  function preserveObservedAgentText(threadId: string, incoming: UiMessage[], readId: number, isInProgress: boolean): UiMessage[] {
    const live = liveAgentMessagesByThreadId.value[threadId] ?? []
    const observedById = new Map([...(persistedMessagesByThreadId.value[threadId] ?? []), ...live]
      .map((message) => [message.id, message]))
    const liveIds = new Set(live.map((message) => message.id))
    const versions = agentMessageVersionByThreadId.get(threadId)
    return incoming.map((message) => {
      const observed = observedById.get(message.id)
      const newerLive = liveIds.has(message.id) && readId < (versions?.get(message.id) ?? 0)
      // Completed history can correct a streaming estimate. Empty/partial
      // in-progress snapshots must not blank an already observed answer.
      if (!isInProgress && message.phase === 'final_answer' && message.text && !newerLive) return message
      if (message.role !== 'assistant' || !observed || observed.role !== 'assistant'
        || (message.turnId && observed.turnId && message.turnId !== observed.turnId)
        || (!observed.text.startsWith(message.text) && !newerLive)) return message
      const phase = observed.phase === 'final_answer' ? observed.phase : message.phase ?? observed.phase
      return observed.text === message.text && phase === message.phase
        ? message : { ...message, text: observed.text, phase }
    })
  }

  function recordAgentMessageVersion(threadId: string, itemId: string): void {
    let versions = agentMessageVersionByThreadId.get(threadId)
    if (!versions) { versions = new Map(); agentMessageVersionByThreadId.set(threadId, versions) }
    versions.set(itemId, ++historyReadSequence)
  }

  function historyHasCurrentRuntimeState(threadId: string, readId: number): boolean {
    return readId >= (realtimeMessageVersionByThreadId.get(threadId) ?? 0)
  }

  function acceptHistoryRead(threadId: string, readId: number, earlier = false): boolean {
    const resetId = Math.max(historyReadReset, resetHistoryReadByThreadId.get(threadId) ?? 0)
    if (readId < resetId || (!earlier && readId < (appliedTailReadByThreadId.get(threadId) ?? 0))) return false
    if (!earlier) appliedTailReadByThreadId.set(threadId, readId)
    return true
  }

  async function reconcileThreadProgressState(threadId: string): Promise<void> {
    if (!threadId) return
    try {
      const readId = ++historyReadSequence
      const [page, nextGoal] = await Promise.all([
        getThreadMessagesWithStatus(threadId),
        getThreadGoal(threadId).catch(() => null),
      ])
      if (!acceptHistoryRead(threadId, readId)) return
      const { isInProgress, activeTurnId, turnSummaries } = page
      const nextMessages = preserveObservedAgentText(threadId, page.messages, readId, isInProgress)
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const mergedMessages = mergeServerMessagesPreservingOptimistic(previousPersisted, nextMessages, {
        preserveMissing: true,
      })
      setPersistedMessagesForThread(threadId, mergedMessages)
      setTurnSummariesForThread(threadId, turnSummaries, { preserveMissing: true })
      setThreadPagination(threadId, page, { preserveEarlier: true })

      const previousLiveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
      const nextLiveAgent = removeRedundantLiveAgentMessages(previousLiveAgent, nextMessages)
      setLiveAgentMessagesForThread(threadId, nextLiveAgent)
      removeLiveCommandsPersistedIn(threadId, nextMessages)
      removeLiveToolMessagesPersistedIn(threadId, nextMessages)

      if (historyHasCurrentRuntimeState(threadId, readId)) {
        setThreadInProgress(threadId, isInProgress)
        setActiveTurnIdForThread(threadId, isInProgress ? activeTurnId || null : null)
        if (!isInProgress) {
          setTurnActivityForThread(threadId, null)
          clearLiveReasoningForThread(threadId)
        }
      }
      setThreadGoalForState(threadId, nextGoal)
      maybeAutoClearCompletedThreadGoal(threadId, nextGoal)
    } catch {
      // Reconciliation is best-effort; next notification or manual refresh can recover.
    }
  }

  function scheduleInProgressReconcile(threadId: string, delayMs = 900): void {
    if (!threadId || typeof window === 'undefined') return
    if (inProgressById.value[threadId] !== true) return

    const existing = inProgressReconcileTimerByThreadId.get(threadId)
    if (typeof existing === 'number') {
      window.clearTimeout(existing)
    }

    const timer = window.setTimeout(() => {
      inProgressReconcileTimerByThreadId.delete(threadId)
      void reconcileThreadProgressState(threadId)
    }, delayMs)

    inProgressReconcileTimerByThreadId.set(threadId, timer)
  }

  function markThreadUnreadByEvent(threadId: string): void {
    if (!threadId) return
    if (threadId === selectedThreadId.value) return
    if (eventUnreadByThreadId.value[threadId] === true) return
    eventUnreadByThreadId.value = {
      ...eventUnreadByThreadId.value,
      [threadId]: true,
    }
    applyThreadFlags()
    persistSharedReadState(threadId, { unread: true })
  }

  function setTurnActivityForThread(threadId: string, activity: TurnActivityState | null): void {
    if (!threadId) return

    const previous = turnActivityByThreadId.value[threadId]
    if (!activity) {
      if (previous) {
        turnActivityByThreadId.value = omitKey(turnActivityByThreadId.value, threadId)
      }
      return
    }

    const normalizedLabel = sanitizeDisplayText(activity.label) || 'Thinking'
    const incomingDetails = activity.details
      .map((line) => sanitizeDisplayText(line))
      .filter((line) => line.length > 0 && line !== normalizedLabel)
    const mergedDetails = Array.from(new Set([...(previous?.details ?? []), ...incomingDetails])).slice(-3)
    const nextActivity: TurnActivityState = {
      label: normalizedLabel,
      details: mergedDetails,
    }

    if (areTurnActivitiesEqual(previous, nextActivity)) return
    turnActivityByThreadId.value = {
      ...turnActivityByThreadId.value,
      [threadId]: nextActivity,
    }
  }

  function setTurnErrorForThread(threadId: string, message: string | null): void {
    if (!threadId) return

    const previous = turnErrorByThreadId.value[threadId]
    const normalizedMessage = message ? normalizeMessageText(message) : ''
    if (!normalizedMessage) {
      if (previous) {
        turnErrorByThreadId.value = omitKey(turnErrorByThreadId.value, threadId)
      }
      return
    }

    if (previous?.message === normalizedMessage) return

    turnErrorByThreadId.value = {
      ...turnErrorByThreadId.value,
      [threadId]: { message: normalizedMessage },
    }
  }

  function setThreadGoalForState(threadId: string, goal: UiThreadGoal | null): void {
    if (!threadId) return
    if (!goal) {
      autoClearedCompletedGoalUpdatedAtByThreadId.delete(threadId)
      if (!(threadId in threadGoalByThreadId.value)) return
      threadGoalByThreadId.value = omitKey(threadGoalByThreadId.value, threadId)
      return
    }

    const previous = threadGoalByThreadId.value[threadId]
    if (
      previous &&
      previous.objective === goal.objective &&
      previous.status === goal.status &&
      previous.tokenBudget === goal.tokenBudget &&
      previous.tokensUsed === goal.tokensUsed &&
      previous.timeUsedSeconds === goal.timeUsedSeconds &&
      previous.createdAt === goal.createdAt &&
      previous.updatedAt === goal.updatedAt
    ) {
      return
    }

    threadGoalByThreadId.value = {
      ...threadGoalByThreadId.value,
      [threadId]: goal,
    }
  }

  function setThreadTokenUsageForState(threadId: string, usage: UiThreadTokenUsage | null): void {
    if (!threadId) return
    if (!usage) {
      if (!(threadId in threadTokenUsageByThreadId.value)) return
      threadTokenUsageByThreadId.value = omitKey(threadTokenUsageByThreadId.value, threadId)
      return
    }

    const previous = threadTokenUsageByThreadId.value[threadId]
    if (
      previous &&
      previous.turnId === usage.turnId &&
      previous.modelContextWindow === usage.modelContextWindow &&
      previous.total.totalTokens === usage.total.totalTokens &&
      previous.total.inputTokens === usage.total.inputTokens &&
      previous.total.cachedInputTokens === usage.total.cachedInputTokens &&
      previous.total.outputTokens === usage.total.outputTokens &&
      previous.total.reasoningOutputTokens === usage.total.reasoningOutputTokens &&
      previous.last.totalTokens === usage.last.totalTokens &&
      previous.last.inputTokens === usage.last.inputTokens &&
      previous.last.cachedInputTokens === usage.last.cachedInputTokens &&
      previous.last.outputTokens === usage.last.outputTokens &&
      previous.last.reasoningOutputTokens === usage.last.reasoningOutputTokens
    ) {
      return
    }

    threadTokenUsageByThreadId.value = {
      ...threadTokenUsageByThreadId.value,
      [threadId]: usage,
    }
  }

  function maybeAutoClearCompletedThreadGoal(threadId: string, goal: UiThreadGoal | null): void {
    if (!threadId || !goal || goal.status !== 'complete') return
    if (autoClearedCompletedGoalUpdatedAtByThreadId.get(threadId) === goal.updatedAt) return

    autoClearedCompletedGoalUpdatedAtByThreadId.set(threadId, goal.updatedAt)
    void clearThreadGoal(threadId).catch(() => {
      if (autoClearedCompletedGoalUpdatedAtByThreadId.get(threadId) === goal.updatedAt) {
        autoClearedCompletedGoalUpdatedAtByThreadId.delete(threadId)
      }
    })
  }

  function shouldContinueThreadGoal(threadId: string): boolean {
    if (!threadId) return false
    const goal = threadGoalByThreadId.value[threadId]
    const queue = queuedMessagesByThreadId.value[threadId] ?? []
    return goal?.status === 'active' && inProgressById.value[threadId] !== true && queue.length === 0
  }

  async function continueActiveThreadGoal(threadId: string): Promise<void> {
    if (!shouldContinueThreadGoal(threadId)) return
    if (pendingGoalContinuationsByThreadId.has(threadId)) return

    pendingGoalContinuationsByThreadId.add(threadId)
    try {
      await new Promise((resolve) => setTimeout(resolve, GOAL_CONTINUATION_DELAY_MS))
      if (!shouldContinueThreadGoal(threadId)) return
      const goal = await setThreadGoal(threadId, { status: 'active' })
      setThreadGoalForState(threadId, goal)
      maybeAutoClearCompletedThreadGoal(threadId, goal)
    } catch {
      // Best effort; a later idle transition can retry.
    } finally {
      pendingGoalContinuationsByThreadId.delete(threadId)
    }
  }

  function currentThreadVersion(threadId: string): string {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    return thread?.updatedAtIso ?? ''
  }

  function setThreadScrollState(threadId: string, nextState: ThreadScrollState): void {
    if (!threadId) return

    const normalizedState: ThreadScrollState = {
      scrollTop: Math.max(0, nextState.scrollTop),
      isAtBottom: nextState.isAtBottom === true,
    }
    if (typeof nextState.scrollRatio === 'number' && Number.isFinite(nextState.scrollRatio)) {
      normalizedState.scrollRatio = clamp(nextState.scrollRatio, 0, 1)
    }

    const previousState = scrollStateByThreadId.value[threadId]
    if (
      previousState &&
      previousState.scrollTop === normalizedState.scrollTop &&
      previousState.isAtBottom === normalizedState.isAtBottom &&
      previousState.scrollRatio === normalizedState.scrollRatio
    ) {
      return
    }

    scrollStateByThreadId.value = {
      ...scrollStateByThreadId.value,
      [threadId]: normalizedState,
    }
    saveThreadScrollStateMap(scrollStateByThreadId.value)
  }

  function trimInactiveMessageCache(threadId: string): void {
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    const firstRetainedTurn = Math.max(0, maxPersistedTurnIndex(threadId) - THREAD_MESSAGE_PAGE_SIZE + 1)
    const retained = previous.filter((message) => message.turnIndex === undefined || message.turnIndex >= firstRetainedTurn)
    if (retained.length === previous.length) return
    persistedMessagesByThreadId.value = { ...persistedMessagesByThreadId.value, [threadId]: retained }
    const pagination = paginationByThreadId.value[threadId]
    if (pagination) paginationByThreadId.value = {
      ...paginationByThreadId.value,
      [threadId]: { ...pagination, startTurnIndex: firstRetainedTurn, hasEarlier: firstRetainedTurn > 0 },
    }
  }

  function rememberMessageCache(threadId: string): void {
    const previousIndex = recentMessageThreadIds.indexOf(threadId)
    if (previousIndex >= 0) recentMessageThreadIds.splice(previousIndex, 1)
    recentMessageThreadIds.push(threadId)
    while (recentMessageThreadIds.length > 4) {
      const evicted = recentMessageThreadIds.shift()!
      if (evicted === selectedThreadId.value) continue
      // Optimistic submissions must remain until acknowledged, even in an inactive chat.
      if (persistedMessagesByThreadId.value[evicted]?.some((message) => message.id.startsWith('optimistic-'))) continue
      persistedMessagesByThreadId.value = omitKey(persistedMessagesByThreadId.value, evicted)
      liveAgentMessagesByThreadId.value = omitKey(liveAgentMessagesByThreadId.value, evicted)
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, evicted)
      liveToolMessagesByThreadId.value = omitKey(liveToolMessagesByThreadId.value, evicted)
      loadedMessagesByThreadId.value = omitKey(loadedMessagesByThreadId.value, evicted)
      loadedVersionByThreadId.value = omitKey(loadedVersionByThreadId.value, evicted)
      paginationByThreadId.value = omitKey(paginationByThreadId.value, evicted)
      appliedTailReadByThreadId.delete(evicted)
      resetHistoryReadByThreadId.delete(evicted)
      realtimeMessageVersionByThreadId.delete(evicted)
      agentMessageVersionByThreadId.delete(evicted)
    }
  }

  function setPersistedMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const orderedMessages = sortMessagesByOrder(nextMessages)
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, orderedMessages)) return
    persistedMessagesByThreadId.value = {
      ...persistedMessagesByThreadId.value,
      [threadId]: orderedMessages,
    }
    rememberMessageCache(threadId)
  }

  function setOptimisticMessageType(threadId: string, messageId: string, messageType: string): void {
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    const messageIndex = previous.findIndex((message) => message.id === messageId)
    if (messageIndex < 0 || previous[messageIndex]?.messageType === messageType) return
    const next = [...previous]
    next.splice(messageIndex, 1, { ...previous[messageIndex], messageType })
    setPersistedMessagesForThread(threadId, next)
  }

  function setLiveAgentMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveAgentMessagesByThreadId.value = {
      ...liveAgentMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function setLiveToolMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveToolMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveToolMessagesByThreadId.value = {
      ...liveToolMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function nextLiveOrderKey(threadId: string): string {
    const next = (liveOrderCounterByThreadId.get(threadId) ?? 0) + 1
    liveOrderCounterByThreadId.set(threadId, next)
    return `live:${threadId}:${String(next).padStart(6, '0')}`
  }

  function maxPersistedTurnIndex(threadId: string): number {
    const persisted = [
      ...(persistedMessagesByThreadId.value[threadId] ?? []),
      ...(liveAgentMessagesByThreadId.value[threadId] ?? []),
      ...(liveCommandsByThreadId.value[threadId] ?? []),
      ...(liveToolMessagesByThreadId.value[threadId] ?? []),
    ]
    let maxIndex = -1
    for (const message of persisted) {
      if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
        maxIndex = Math.max(maxIndex, message.turnIndex)
      }
    }
    return maxIndex
  }

  function persistedTurnIndexForTurnId(threadId: string, turnId: string): number | null {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    for (const message of persisted) {
      if (
        message.turnId === turnId &&
        typeof message.turnIndex === 'number' &&
        Number.isFinite(message.turnIndex)
      ) {
        return message.turnIndex
      }
    }
    return null
  }

  function getRealtimeTurnIndex(threadId: string, turnId: string): number {
    const persistedTurnIndex = persistedTurnIndexForTurnId(threadId, turnId)
    if (persistedTurnIndex !== null) {
      liveTurnIndexByTurnId.set(turnId, persistedTurnIndex)
      return persistedTurnIndex
    }
    const existing = liveTurnIndexByTurnId.get(turnId)
    if (typeof existing === 'number') return existing
    const nextIndex = persistedTurnIndex ?? maxPersistedTurnIndex(threadId) + 1
    liveTurnIndexByTurnId.set(turnId, nextIndex)
    return nextIndex
  }

  function rememberRealtimeTurnIndex(threadId: string, turnId: string): void {
    if (!threadId || !turnId || liveTurnIndexByTurnId.has(turnId)) return
    liveTurnIndexByTurnId.set(turnId, maxPersistedTurnIndex(threadId) + 1)
  }

  function realtimeTurnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`
  }

  function nextRealtimeItemIndex(threadId: string, turnId: string): number {
    const key = realtimeTurnKey(threadId, turnId)
    const persistedMax = (persistedMessagesByThreadId.value[threadId] ?? [])
      .filter((message) => message.turnId === turnId)
      .reduce((max, message) => Math.max(max, Number(message.orderKey?.split(':')[1] ?? -1)), -1)
    const next = Math.max(liveItemCounterByTurnKey.get(key) ?? -1, persistedMax) + 1
    liveItemCounterByTurnKey.set(key, next)
    return next
  }

  function realtimeItemKey(threadId: string, itemId: string): string {
    return `${threadId}:${itemId}`
  }

  function getRealtimeItemOrderKey(threadId: string, turnId: string, itemId: string): string {
    const persistedKey = (persistedMessagesByThreadId.value[threadId] ?? [])
      .find((message) => message.id === itemId)?.orderKey
    if (persistedKey) return persistedKey
    const itemKey = realtimeItemKey(threadId, itemId)
    let itemIndex = liveItemIndexByItemKey.get(itemKey)
    if (typeof itemIndex !== 'number') {
      itemIndex = nextRealtimeItemIndex(threadId, turnId)
      liveItemIndexByItemKey.set(itemKey, itemIndex)
    }

    return [
      String(getRealtimeTurnIndex(threadId, turnId)).padStart(6, '0'),
      String(itemIndex).padStart(6, '0'),
      '000000',
    ].join(':')
  }

  function withRealtimeItemOrder(threadId: string, turnId: string, message: UiMessage): UiMessage {
    if (!threadId || !turnId || !message.id) return message
    const turnIndex = getRealtimeTurnIndex(threadId, turnId)
    if (message.orderKey) {
      return {
        ...message,
        turnId: message.turnId ?? turnId,
        turnIndex: message.turnIndex ?? turnIndex,
      }
    }
    return {
      ...message,
      turnId,
      turnIndex,
      orderKey: getRealtimeItemOrderKey(threadId, turnId, message.id),
    }
  }

  function ensureRealtimeMessageOrder(threadId: string, message: UiMessage, previous: UiMessage[]): UiMessage {
    if (message.orderKey) return message
    const existing = previous.find((entry) => entry.id === message.id)
    if (existing?.orderKey) {
      return { ...message, orderKey: existing.orderKey }
    }
    return { ...message, orderKey: nextLiveOrderKey(threadId) }
  }

  function upsertLiveAgentMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, ensureRealtimeMessageOrder(threadId, nextMessage, previous))
    setLiveAgentMessagesForThread(threadId, next)
  }

  function upsertLiveToolMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveToolMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, ensureRealtimeMessageOrder(threadId, nextMessage, previous))
    setLiveToolMessagesForThread(threadId, next)
  }

  function setLiveReasoningText(threadId: string, text: string): void {
    if (!threadId) return
    const normalized = text.trim()
    const previous = liveReasoningTextByThreadId.value[threadId] ?? ''
    if (normalized.length === 0) {
      if (!previous) return
      liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
      return
    }
    if (previous === normalized) return
    liveReasoningTextByThreadId.value = {
      ...liveReasoningTextByThreadId.value,
      [threadId]: normalized,
    }
  }

  function appendLiveReasoningText(threadId: string, delta: string): void {
    if (!threadId) return
    const previous = liveReasoningTextByThreadId.value[threadId] ?? ''
    setLiveReasoningText(threadId, `${previous}${delta}`)
  }

  function clearLiveReasoningForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveReasoningTextByThreadId.value)) return
    liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
  }

  function extractThreadIdFromNotification(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    const directThreadId = readString(params.threadId)
    if (directThreadId) return directThreadId
    const snakeThreadId = readString(params.thread_id)
    if (snakeThreadId) return snakeThreadId

    const conversationId = readString(params.conversationId)
    if (conversationId) return conversationId
    const snakeConversationId = readString(params.conversation_id)
    if (snakeConversationId) return snakeConversationId

    const thread = asRecord(params.thread)
    const nestedThreadId = readString(thread?.id)
    if (nestedThreadId) return nestedThreadId

    const turn = asRecord(params.turn)
    const turnThreadId = readString(turn?.threadId)
    if (turnThreadId) return turnThreadId
    const turnSnakeThreadId = readString(turn?.thread_id)
    if (turnSnakeThreadId) return turnSnakeThreadId

    return ''
  }

  function extractTurnIdFromNotification(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    const directTurnId = readString(params.turnId)
    if (directTurnId) return directTurnId
    const snakeTurnId = readString(params.turn_id)
    if (snakeTurnId) return snakeTurnId

    const turn = asRecord(params.turn)
    const nestedTurnId = readString(turn?.id)
    if (nestedTurnId) return nestedTurnId

    const item = asRecord(params.item)
    const itemTurnId = readString(item?.turnId)
    if (itemTurnId) return itemTurnId
    const itemSnakeTurnId = readString(item?.turn_id)
    if (itemSnakeTurnId) return itemSnakeTurnId

    return ''
  }

  function readTurnErrorMessage(notification: RpcNotification): string {
    if (notification.method !== 'turn/completed') return ''
    const params = asRecord(notification.params)
    const turn = asRecord(params?.turn)
    if (!turn || turn.status !== 'failed') return ''
    const errorPayload = asRecord(turn.error)
    return readString(errorPayload?.message)
  }

  function readTurnCompletionStatus(notification: RpcNotification): string {
    if (notification.method !== 'turn/completed') return ''
    const params = asRecord(notification.params)
    const turn = asRecord(params?.turn)
    return readString(turn?.status) || readString(params?.status)
  }

  function readSessionConfiguredModel(notification: RpcNotification): { threadId: string; config: ThreadModelConfig } | null {
    if (notification.method !== 'sessionConfigured') return null
    const params = asRecord(notification.params)
    if (!params) return null

    const threadId = readString(params.sessionId) || readString(params.session_id)
    const model = readString(params.model)
    const reasoningEffort = normalizeReasoningEffortPreference(params.reasoningEffort ?? params.reasoning_effort)
    if (!threadId || (!model && !reasoningEffort)) return null

    return {
      threadId,
      config: {
        model,
        reasoningEffort,
      },
    }
  }

  function normalizeServerRequest(params: unknown): UiServerRequest | null {
    const row = asRecord(params)
    if (!row) return null

    const id = row.id
    const method = readString(row.method)
    const requestParams = row.params
    if (typeof id !== 'number' || !Number.isInteger(id) || !method) {
      return null
    }

    const requestParamRecord = asRecord(requestParams)
    const threadId = readString(requestParamRecord?.threadId) || GLOBAL_SERVER_REQUEST_SCOPE
    const turnId = readString(requestParamRecord?.turnId)
    const itemId = readString(requestParamRecord?.itemId)
    const receivedAtIso = readString(row.receivedAtIso) || new Date().toISOString()

    return {
      id,
      method,
      threadId,
      turnId,
      itemId,
      receivedAtIso,
      params: requestParams ?? null,
    }
  }

  function upsertPendingServerRequest(request: UiServerRequest): void {
    const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
    const current = pendingServerRequestsByThreadId.value[threadId] ?? []
    const index = current.findIndex((row) => row.id === request.id)
    const nextRows = [...current]
    if (index >= 0) {
      nextRows.splice(index, 1, { ...current[index], ...request })
    } else {
      nextRows.push(request)
    }

    pendingServerRequestsByThreadId.value = {
      ...pendingServerRequestsByThreadId.value,
      [threadId]: nextRows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso)),
    }
  }

  function removePendingServerRequestById(requestId: number): void {
    const next: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      const filtered = requests.filter((request) => request.id !== requestId)
      if (filtered.length > 0) {
        next[threadId] = filtered
      }
    }
    pendingServerRequestsByThreadId.value = next
  }

  function handleServerRequestNotification(notification: RpcNotification): boolean {
    if (notification.method === 'server/request') {
      const request = normalizeServerRequest(notification.params)
      if (!request) return true
      upsertPendingServerRequest(request)
      return true
    }

    if (notification.method === 'server/request/resolved') {
      const row = asRecord(notification.params)
      const id = row?.id
      if (typeof id === 'number' && Number.isInteger(id)) {
        removePendingServerRequestById(id)
      }
      return true
    }

    return false
  }

  function sanitizeDisplayText(value: string): string {
    return value.replace(/\s+/gu, ' ').trim()
  }

  function readTurnActivity(notification: RpcNotification): { threadId: string; activity: TurnActivityState } | null {
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    if (notification.method === 'turn/started') {
      return {
        threadId,
        activity: {
          label: 'Thinking',
          details: [],
        },
      }
    }

    if (notification.method === 'item/started') {
      const params = asRecord(notification.params)
      const item = asRecord(params?.item)
      const itemType = readString(item?.type).toLowerCase()
      if (itemType === 'reasoning') {
        return {
          threadId,
          activity: {
            label: 'Thinking',
            details: [],
          },
        }
      }
      if (itemType === 'agentmessage') {
        return {
          threadId,
          activity: {
            label: 'Writing response',
            details: [],
          },
        }
      }
      if (itemType === 'commandexecution') {
        const cmd = readString(item?.command)
        return {
          threadId,
          activity: {
            label: 'Running command',
            details: cmd ? [cmd] : [],
          },
        }
      }
    }

    if (notification.method === 'item/commandExecution/outputDelta') {
      return {
        threadId,
        activity: {
          label: 'Running command',
          details: [],
        },
      }
    }

    if (
      notification.method === 'item/reasoning/summaryTextDelta' ||
      notification.method === 'item/reasoning/summaryPartAdded'
    ) {
      return {
        threadId,
        activity: {
          label: 'Thinking',
          details: [],
        },
      }
    }

    if (notification.method === 'item/agentMessage/delta') {
      return {
        threadId,
        activity: {
          label: 'Writing response',
          details: [],
        },
      }
    }

    return null
  }

  function readTurnStartedInfo(notification: RpcNotification): TurnStartedInfo | null {
    if (notification.method !== 'turn/started') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    return {
      threadId,
      turnId,
      startedAtMs,
    }
  }

  function readTurnCompletedInfo(notification: RpcNotification): TurnCompletedInfo | null {
    if (notification.method !== 'turn/completed') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const completedAtMs =
      parseIsoTimestamp(readString(turnPayload?.completedAt)) ??
      parseIsoTimestamp(readString(params.completedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      undefined

    return {
      threadId,
      turnId,
      completedAtMs,
      startedAtMs,
    }
  }

  function getBrowserNotificationApi(): typeof Notification | null {
    if (typeof window === 'undefined') return null
    return typeof window.Notification === 'function' ? window.Notification : null
  }

  function requestBrowserTurnNotificationsPermission(): void {
    const NotificationApi = getBrowserNotificationApi()
    if (!NotificationApi) return
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window) {
      return
    }
    if (NotificationApi.permission !== 'default' || typeof NotificationApi.requestPermission !== 'function') {
      return
    }
    void NotificationApi.requestPermission().catch(() => {})
  }

  function shouldShowBrowserTurnNotification(): boolean {
    const NotificationApi = getBrowserNotificationApi()
    if (!NotificationApi || NotificationApi.permission !== 'granted') return false
    if (typeof document === 'undefined') return false
    const pageIsFocused =
      document.visibilityState === 'visible' &&
      typeof document.hasFocus === 'function' &&
      document.hasFocus()
    if (
      pageIsFocused &&
      (!isWebPushLocallyEnabled() || getLocalTurnNotificationMode() !== 'always')
    ) {
      return false
    }
    return true
  }

  function rememberBrowserTurnNotification(turnKey: string): void {
    if (browserNotifiedTurnKeys.has(turnKey)) return
    browserNotifiedTurnKeys.add(turnKey)
    browserNotifiedTurnOrder.push(turnKey)
    if (browserNotifiedTurnOrder.length <= MAX_BROWSER_NOTIFIED_TURNS) return

    const evictedTurnKey = browserNotifiedTurnOrder.shift()
    if (evictedTurnKey) {
      browserNotifiedTurnKeys.delete(evictedTurnKey)
    }
  }

  function readLatestAssistantMessageText(threadId: string): string {
    const liveMessages = liveAgentMessagesByThreadId.value[threadId] ?? []
    for (let index = liveMessages.length - 1; index >= 0; index -= 1) {
      const message = liveMessages[index]
      if (message.role === 'assistant' && message.text.trim()) {
        return message.text
      }
    }

    const persistedMessages = persistedMessagesByThreadId.value[threadId] ?? []
    for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
      const message = persistedMessages[index]
      if (message.role === 'assistant' && message.text.trim()) {
        return message.text
      }
    }

    return ''
  }

  function readTurnNotificationTitle(threadId: string, status: string): string {
    const threadTitle =
      threadTitleById.value[threadId] ||
      allThreads.value.find((thread) => thread.id === threadId)?.title ||
      ''

    if (status === 'failed') {
      return threadTitle ? `${threadTitle} failed` : 'Turn failed'
    }
    return threadTitle || 'Turn complete'
  }

  function resolveNotificationThreadAudience(threadId: string): Promise<CodexThreadAudience> {
    if (allThreads.value.some((thread) => thread.id === threadId)) {
      audienceByThreadId.set(threadId, 'interactive')
      return Promise.resolve('interactive')
    }

    const knownAudience = audienceByThreadId.get(threadId)
    if (knownAudience) return Promise.resolve(knownAudience)
    const pendingLookup = pendingAudienceLookupByThreadId.get(threadId)
    if (pendingLookup) return pendingLookup

    let timeout: ReturnType<typeof setTimeout> | null = null
    const readAudience = getThreadAudience(threadId)
      .then((audience) => {
        if (audience !== 'unknown') audienceByThreadId.set(threadId, audience)
        return audience
      })
      .catch(() => 'unknown' as const)
    const lookup = Promise.race([
      readAudience,
      new Promise<CodexThreadAudience>((resolve) => {
        timeout = setTimeout(() => resolve('unknown'), THREAD_AUDIENCE_LOOKUP_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
      pendingAudienceLookupByThreadId.delete(threadId)
    })
    pendingAudienceLookupByThreadId.set(threadId, lookup)
    return lookup
  }

  async function handleCompletedTurnAttention(
    completedTurn: TurnCompletedInfo,
    notification: RpcNotification,
  ): Promise<void> {
    const audience = await resolveNotificationThreadAudience(completedTurn.threadId)
    if (audience === 'internalSubagent') return
    markThreadUnreadByEvent(completedTurn.threadId)
    notifyBrowserAboutCompletedTurn(completedTurn, notification)
  }

  function setBoardManagedThreadIds(ids: string[]): void {
    boardManagedThreadIds = new Set(ids.filter(Boolean))
  }

  function notifyBrowserAboutCompletedTurn(completedTurn: TurnCompletedInfo, notification: RpcNotification): void {
    if (boardManagedThreadIds.has(completedTurn.threadId)) return
    if (!shouldShowBrowserTurnNotification()) return

    const status = readTurnCompletionStatus(notification)
    if (status === 'interrupted') return
    const automation = asRecord(asRecord(notification.params)?.codexuiAutomation)
    const notificationPolicy = readString(automation?.notificationPolicy)
    if (
      notificationPolicy === 'never' ||
      (notificationPolicy === 'failure' && status !== 'failed')
    ) return

    const turnKey = `${completedTurn.threadId}:${completedTurn.turnId}`
    if (browserNotifiedTurnKeys.has(turnKey)) return

    const NotificationApi = getBrowserNotificationApi()
    if (!NotificationApi) return

    if (isWebPushLocallyEnabled()) {
      // The server sends subscribed devices one Web Push notification for this turn.
      // Showing the same tag here would replace it immediately and can make the macOS
      // banner appear to flash or disappear.
      rememberBrowserTurnNotification(turnKey)
      return
    }

    const body = status === 'failed'
      ? summarizeBrowserNotificationText(readTurnErrorMessage(notification), 'Turn failed')
      : summarizeBrowserNotificationText(
        readLatestAssistantMessageText(completedTurn.threadId),
        BROWSER_TURN_NOTIFICATION_FALLBACK_BODY,
      )

    try {
      const browserNotification = new NotificationApi(
        readTurnNotificationTitle(completedTurn.threadId, status),
        {
          body,
          tag: turnKey,
        },
      )
      browserNotification.onclick = () => {
        if (typeof window !== 'undefined') {
          window.focus()
          window.location.hash = `#/thread/${completedTurn.threadId}`
        }
        browserNotification.close()
      }
      rememberBrowserTurnNotification(turnKey)
    } catch {
      // Ignore browser notification failures and keep chat state consistent.
    }
  }

  function liveReasoningMessageId(reasoningItemId: string): string {
    return `${reasoningItemId}:live-reasoning`
  }

  function readReasoningStartedItemId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return readString(item.id)
    }

    return ''
  }

  function readReasoningDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический источник дельт для UI — уже нормализованный item/*.
    if (notification.method === 'item/reasoning/summaryTextDelta') {
      const itemId = readString(params.itemId)
      const delta = readRawString(params.delta)
      if (!itemId || delta.length === 0) return null
      return { messageId: liveReasoningMessageId(itemId), delta }
    }

    return null
  }

  function readReasoningSectionBreakMessageId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    // Канонический source для section break — item/*
    if (notification.method === 'item/reasoning/summaryPartAdded') {
      const itemId = readString(params.itemId)
      if (!itemId) return ''
      return liveReasoningMessageId(itemId)
    }

    return ''
  }

  function readReasoningCompletedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return liveReasoningMessageId(readString(item.id))
    }

    return ''
  }

  function readAgentMessageStartedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return ''
      return readString(item.id)
    }

    return ''
  }

  function readAgentMessageDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический live-канал агентского текста.
    if (notification.method === 'item/agentMessage/delta') {
      const messageId = readString(params.itemId)
      const delta = readRawString(params.delta)
      if (!messageId || delta.length === 0) return null
      return { messageId, delta }
    }

    return null
  }

  function readAgentMessageCompleted(notification: RpcNotification): UiMessage | null {
    const params = asRecord(notification.params)
    if (!params) return null

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return null
      const id = readString(item.id)
      const text = readRawString(item.text)
      if (!id || typeof item.text !== 'string') return null
      return {
        id,
        role: 'assistant',
        text,
        messageType: 'agentMessage.live',
        phase: item.phase === 'final_answer' || item.phase === 'commentary' ? item.phase : undefined,
      }
    }

    return null
  }

  function readCommandExecutionStarted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/started') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: { command, cwd, status: 'inProgress', aggregatedOutput: '', exitCode: null },
    }
  }

  function readCommandOutputDelta(notification: RpcNotification): { itemId: string; delta: string } | null {
    if (notification.method !== 'item/commandExecution/outputDelta') return null
    const params = asRecord(notification.params)
    if (!params) return null
    const itemId = readString(params.itemId)
    const delta = readRawString(params.delta)
    if (!itemId || delta.length === 0) return null
    return { itemId, delta }
  }

  function readCommandExecutionCompleted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    const statusRaw = readString(item.status)
    const status: CommandExecutionData['status'] =
      statusRaw === 'failed' ? 'failed' : statusRaw === 'declined' ? 'declined' : statusRaw === 'interrupted' ? 'interrupted' : 'completed'
    const aggregatedOutput = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: { command, cwd, status, aggregatedOutput, exitCode },
    }
  }

  function normalizeRealtimeToolCallStatus(
    value: unknown,
    fallback: 'inProgress' | 'completed' = 'completed',
  ): 'inProgress' | 'completed' | 'failed' {
    if (value === 'inProgress' || value === 'in_progress' || value === 'pending') return 'inProgress'
    if (value === 'failed') return 'failed'
    return fallback
  }

  function readRealtimeWebSearchQuery(item: Record<string, unknown>): string {
    const directQuery = readString(item.query)
    if (directQuery) return directQuery

    const action = asRecord(item.action)
    if (!action) return ''
    const actionType = readString(action.type)

    if (actionType === 'search') {
      const query = readString(action.query)
      if (query) return query
      const queries = Array.isArray(action.queries)
        ? action.queries
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter(Boolean)
        : []
      return queries.join(', ')
    }

    if (actionType === 'openPage') {
      return readString(action.url)
    }

    if (actionType === 'findInPage') {
      return readString(action.pattern)
    }

    return ''
  }

  function buildRealtimeToolMessage(
    item: Record<string, unknown>,
    phase: 'started' | 'completed',
  ): UiMessage | null {
    const subAgentActivity = normalizeSubAgentActivity(item)
    if (subAgentActivity) return subAgentActivity
    const itemId = readString(item.id)
    if (!itemId) return null

    const normalizedItemType = readString(item.type).replace(/[_\s-]/gu, '').toLowerCase()
    const fallbackStatus = phase === 'started' ? 'inProgress' : 'completed'

    if (normalizedItemType === 'mcptoolcall') {
      const status = normalizeRealtimeToolCallStatus(item.status, fallbackStatus)
      const verb = status === 'inProgress' ? 'Calling' : status === 'failed' ? 'Failed' : 'Called'
      const progress = readString(item.progress)
      const presentation = formatMcpToolCallPresentation(item, status)
      const mcpApp = readMcpAppResult(item, status)
      return {
        id: itemId,
        role: 'system',
        text: `${verb} ${presentation.label}`,
        messageType: 'mcpToolCall',
        rawPayload: toRawPayload(item),
        isUnhandled: true,
        toolCall: {
          kind: 'mcp',
          ...presentation,
          status,
          progress,
        },
        mcpApp,
      }
    }

    if (normalizedItemType === 'collabagenttoolcall') {
      const status = normalizeRealtimeToolCallStatus(item.status, fallbackStatus)
      const verb = status === 'inProgress' ? 'Running' : status === 'failed' ? 'Failed' : 'Ran'
      const tool = readString(item.tool) || 'tool'
      const progress = readString(item.progress)
      return {
        id: itemId,
        role: 'system',
        text: `${verb} collaboration tool: ${tool}`,
        messageType: 'collabAgentToolCall',
        rawPayload: toRawPayload(item),
        isUnhandled: true,
        toolCall: {
          kind: 'collab',
          label: tool,
          detail: 'Collaboration',
          status,
          progress,
        },
      }
    }

    if (normalizedItemType === 'websearch') {
      const query = readRealtimeWebSearchQuery(item)
      const actionLabel = phase === 'started' ? 'Searching web' : 'Searched web'
      const status = phase === 'started' ? 'inProgress' : 'completed'
      return {
        id: itemId,
        role: 'system',
        text: query ? `${actionLabel} for ${query}` : actionLabel,
        messageType: 'webSearch',
        rawPayload: toRawPayload(item),
        isUnhandled: true,
        toolCall: {
          kind: 'web',
          label: 'Web search',
          detail: query,
          status,
          progress: '',
        },
      }
    }

    return null
  }

  function readRealtimeToolItemStarted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/started') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item) return null
    return buildRealtimeToolMessage(item, 'started')
  }

  function readRealtimeToolItemCompleted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item) return null
    return buildRealtimeToolMessage(item, 'completed')
  }

  function readMcpToolProgressUpdate(notification: RpcNotification): { itemId: string; message: string } | null {
    if (notification.method !== 'item/mcpToolCall/progress') return null
    const params = asRecord(notification.params)
    if (!params) return null
    const itemId = readString(params.itemId)
    const message = readString(params.message)
    if (!itemId || !message) return null
    return { itemId, message }
  }

  function upsertLiveCommand(threadId: string, msg: UiMessage): void {
    const previous = liveCommandsByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, ensureRealtimeMessageOrder(threadId, msg, previous))
    if (next === previous) return
    liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
  }

  function removeLiveCommandsPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveCommandsByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map((m) => m.id))
    const next = current.filter((m) => !persistedIds.has(m.id))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
    } else {
      liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
    }
  }

  function removeLiveToolMessagesPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveToolMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map((m) => m.id))
    const next = current.filter((m) => !persistedIds.has(m.id))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveToolMessagesByThreadId.value = omitKey(liveToolMessagesByThreadId.value, threadId)
    } else {
      liveToolMessagesByThreadId.value = { ...liveToolMessagesByThreadId.value, [threadId]: next }
    }
  }

  function isAgentContentEvent(notification: RpcNotification): boolean {
    if (notification.method === 'item/agentMessage/delta') {
      return true
    }

    const params = asRecord(notification.params)
    if (!params) return false

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      return item?.type === 'agentMessage'
    }

    return false
  }

  async function refreshAccountRateLimits(): Promise<void> {
    try {
      accountRateLimits.value = await getAccountRateLimits()
    } catch {
      // Keep the last known account rate limits when the RPC is unavailable.
    }
  }

  async function useRateLimitReset(): Promise<void> {
    if (isUsingRateLimitReset.value) return
    isUsingRateLimitReset.value = true
    error.value = ''
    try {
      const code = await consumeRateLimitResetCredit()
      if (code !== 'reset' && code !== 'already_redeemed') {
        throw new Error(rateLimitResetErrorMessage(code))
      }
      await refreshAccountRateLimits()
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to use rate limit reset'
      throw unknownError
    } finally {
      isUsingRateLimitReset.value = false
    }
  }

  function applyRealtimeUpdates(notification: RpcNotification): void {
    if (handleServerRequestNotification(notification)) {
      return
    }

    if (notification.method === 'codexui/threadReadState/updated') {
      applySharedReadState(normalizeSharedThreadReadState(notification.params))
      return
    }

    const sessionConfigured = readSessionConfiguredModel(notification)
    if (sessionConfigured) {
      const cachedConfig = threadModelConfigById.value[sessionConfigured.threadId]
      if (cachedConfig) {
        if (sessionConfigured.threadId === selectedThreadId.value) {
          setPickerModelConfig(cachedConfig)
        }
      } else {
        applyThreadModelConfig(
          sessionConfigured.threadId,
          sessionConfigured.config,
          sessionConfigured.threadId === selectedThreadId.value,
        )
      }
    }

    if (notification.method === 'account/rateLimits/updated') {
      const params = asRecord(notification.params)
      const snapshot = normalizeRateLimitSnapshotPayload(params?.rateLimits ?? params?.rate_limits)
      if (snapshot) {
        accountRateLimits.value = mergeAccountRateLimitSnapshot(accountRateLimits.value, snapshot)
      }
      return
    }

    if (notification.method === 'thread/name/updated') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const threadName = readString(params?.threadName)
      if (threadId && threadName) {
        threadTitleById.value = { ...threadTitleById.value, [threadId]: threadName }
        applyThreadFlags()
        void persistThreadTitle(threadId, threadName)
      }
    }

    if (notification.method === 'thread/goal/updated') {
      const params = asRecord(notification.params)
      const threadId = readString(pick(params ?? {}, 'threadId', 'thread_id'))
      const normalizedGoal = normalizeThreadGoalPayload(params?.goal, threadId)
      if (threadId && normalizedGoal) {
        setThreadGoalForState(threadId, normalizedGoal)
        maybeAutoClearCompletedThreadGoal(threadId, normalizedGoal)
      }
    }

    if (notification.method === 'thread/tokenUsage/updated') {
      const params = asRecord(notification.params)
      const threadId = readString(pick(params ?? {}, 'threadId', 'thread_id'))
      const turnId = readString(pick(params ?? {}, 'turnId', 'turn_id'))
      const normalizedUsage = normalizeThreadTokenUsagePayload(
        params?.tokenUsage ?? params?.token_usage,
        threadId,
        turnId,
      )
      if (threadId && normalizedUsage) {
        setThreadTokenUsageForState(threadId, normalizedUsage)
      }
    }

    if (notification.method === 'thread/goal/cleared') {
      const params = asRecord(notification.params)
      const threadId = readString(pick(params ?? {}, 'threadId', 'thread_id'))
      if (threadId) {
        setThreadGoalForState(threadId, null)
      }
    }

    if (notification.method === 'thread/status/changed') {
      const params = asRecord(notification.params)
      const threadId = readString(pick(params ?? {}, 'threadId', 'thread_id'))
      const status = asRecord(pick(params ?? {}, 'status', 'status'))
      const statusType = readString(status?.type)
      if (threadId && statusType) {
        realtimeMessageVersionByThreadId.set(threadId, ++historyReadSequence)
        const isActive = statusType === 'active'
        setThreadInProgress(threadId, isActive)
        if (!isActive) {
          setTurnActivityForThread(threadId, null)
          clearLiveReasoningForThread(threadId)
        }
        if (statusType === 'idle') {
          void continueActiveThreadGoal(threadId)
        }
      }
    }

    const turnActivity = readTurnActivity(notification)
    const notificationTurnId = extractTurnIdFromNotification(notification)
    if (turnActivity) {
      const isThreadAlreadyActive =
        inProgressById.value[turnActivity.threadId] === true ||
        typeof activeTurnIdByThreadId.value[turnActivity.threadId] === 'string'
      if (notification.method === 'turn/started' || isThreadAlreadyActive) {
        setTurnActivityForThread(turnActivity.threadId, turnActivity.activity)
        setThreadInProgress(turnActivity.threadId, true)
        if (notificationTurnId) {
          setActiveTurnIdForThread(turnActivity.threadId, notificationTurnId)
        }
      }
    }

    const startedTurn = readTurnStartedInfo(notification)
    if (startedTurn) {
      realtimeMessageVersionByThreadId.set(startedTurn.threadId, ++historyReadSequence)
      promoteThreadForActivity(startedTurn.threadId, new Date(startedTurn.startedAtMs).toISOString())
      pendingTurnStartsById.set(startedTurn.turnId, startedTurn)
      rememberRealtimeTurnIndex(startedTurn.threadId, startedTurn.turnId)
      if (notificationTurnId) {
        setActiveTurnIdForThread(startedTurn.threadId, notificationTurnId)
      }
      setTurnErrorForThread(startedTurn.threadId, null)
      setThreadInProgress(startedTurn.threadId, true)
      if (eventUnreadByThreadId.value[startedTurn.threadId]) {
        eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, startedTurn.threadId)
      }
    }

    const completedTurn = readTurnCompletedInfo(notification)
    if (completedTurn) {
      realtimeMessageVersionByThreadId.set(completedTurn.threadId, ++historyReadSequence)
      const startedTurnState = pendingTurnStartsById.get(completedTurn.turnId)
      if (startedTurnState) {
        pendingTurnStartsById.delete(completedTurn.turnId)
      }

      const rawDurationMs =
        readNumber(asRecord(notification.params)?.durationMs) ??
        readNumber(asRecord(asRecord(notification.params)?.turn)?.durationMs) ??
        (typeof completedTurn.startedAtMs === 'number'
          ? completedTurn.completedAtMs - completedTurn.startedAtMs
          : null) ??
        (startedTurnState ? completedTurn.completedAtMs - startedTurnState.startedAtMs : null)

      const durationMs = typeof rawDurationMs === 'number' ? Math.max(0, rawDurationMs) : 0
      setTurnSummaryForThread(completedTurn.threadId, {
        turnId: completedTurn.turnId,
        durationMs,
      })
      setActiveTurnIdForThread(completedTurn.threadId, null)
      setThreadInProgress(completedTurn.threadId, false)
      setTurnActivityForThread(completedTurn.threadId, null)
      promoteThreadForActivity(completedTurn.threadId, new Date(completedTurn.completedAtMs).toISOString())
      void handleCompletedTurnAttention(completedTurn, notification)
      void processQueuedMessages(completedTurn.threadId)
      void continueActiveThreadGoal(completedTurn.threadId)
    }

    const turnErrorMessage = readTurnErrorMessage(notification)
    if (turnErrorMessage) {
      const failedThreadId = completedTurn?.threadId || extractThreadIdFromNotification(notification)
      if (failedThreadId) {
        setTurnErrorForThread(failedThreadId, turnErrorMessage)
      }
      error.value = turnErrorMessage
    } else if (completedTurn) {
      setTurnErrorForThread(completedTurn.threadId, null)
    }

    const notificationThreadId = extractThreadIdFromNotification(notification)
    if (!notificationThreadId || notificationThreadId !== selectedThreadId.value) return

    const startedAgentMessageId = readAgentMessageStartedId(notification)
    if (startedAgentMessageId) {
      activeReasoningItemId = ''
    }

    const liveAgentMessageDelta = readAgentMessageDelta(notification)
    if (liveAgentMessageDelta) {
      recordAgentMessageVersion(notificationThreadId, liveAgentMessageDelta.messageId)
      const existing = (liveAgentMessagesByThreadId.value[notificationThreadId] ?? [])
        .find((message) => message.id === liveAgentMessageDelta.messageId)
        ?? (persistedMessagesByThreadId.value[notificationThreadId] ?? [])
          .find((message) => message.id === liveAgentMessageDelta.messageId)
      const nextText = `${existing?.text ?? ''}${liveAgentMessageDelta.delta}`
      upsertLiveAgentMessage(notificationThreadId, {
        ...existing,
        ...withRealtimeItemOrder(notificationThreadId, notificationTurnId, {
          id: liveAgentMessageDelta.messageId,
          role: 'assistant',
          text: nextText,
          messageType: 'agentMessage.live',
        }),
      })
    }

    const completedAgentMessage = readAgentMessageCompleted(notification)
    if (completedAgentMessage) {
      recordAgentMessageVersion(notificationThreadId, completedAgentMessage.id)
      upsertLiveAgentMessage(notificationThreadId, withRealtimeItemOrder(notificationThreadId, notificationTurnId, completedAgentMessage))
      scheduleInProgressReconcile(notificationThreadId)
    }

    const startedReasoningItemId = readReasoningStartedItemId(notification)
    if (startedReasoningItemId) {
      activeReasoningItemId = startedReasoningItemId
    }

    const liveReasoningDelta = readReasoningDelta(notification)
    if (liveReasoningDelta) {
      appendLiveReasoningText(notificationThreadId, liveReasoningDelta.delta)
    }

    const sectionBreakMessageId = readReasoningSectionBreakMessageId(notification)
    if (sectionBreakMessageId) {
      const current = liveReasoningTextByThreadId.value[notificationThreadId] ?? ''
      if (current.trim().length > 0 && !current.endsWith('\n\n')) {
        setLiveReasoningText(notificationThreadId, `${current}\n\n`)
      }
    }

    const completedReasoningMessageId = readReasoningCompletedId(notification)
    if (completedReasoningMessageId) {
      if (completedReasoningMessageId === liveReasoningMessageId(activeReasoningItemId)) {
        activeReasoningItemId = ''
      }
    }

    const commandStarted = readCommandExecutionStarted(notification)
    if (commandStarted) {
      upsertLiveCommand(notificationThreadId, withRealtimeItemOrder(notificationThreadId, notificationTurnId, commandStarted))
      setTurnActivityForThread(notificationThreadId, { label: 'Running command', details: [commandStarted.commandExecution?.command ?? ''] })
    }

    const commandDelta = readCommandOutputDelta(notification)
    if (commandDelta) {
      const current = (liveCommandsByThreadId.value[notificationThreadId] ?? []).find((m) => m.id === commandDelta.itemId)
      if (current?.commandExecution) {
        upsertLiveCommand(notificationThreadId, {
          ...withRealtimeItemOrder(notificationThreadId, notificationTurnId, current),
          commandExecution: { ...current.commandExecution, aggregatedOutput: `${current.commandExecution.aggregatedOutput}${commandDelta.delta}` },
        })
      }
    }

    const commandCompleted = readCommandExecutionCompleted(notification)
    if (commandCompleted) {
      upsertLiveCommand(notificationThreadId, withRealtimeItemOrder(notificationThreadId, notificationTurnId, commandCompleted))
      scheduleInProgressReconcile(notificationThreadId)
    }

    const realtimeToolStarted = readRealtimeToolItemStarted(notification)
    if (realtimeToolStarted) {
      upsertLiveToolMessage(notificationThreadId, withRealtimeItemOrder(notificationThreadId, notificationTurnId, realtimeToolStarted))
    }

    const realtimeToolCompleted = readRealtimeToolItemCompleted(notification)
    if (realtimeToolCompleted) {
      upsertLiveToolMessage(notificationThreadId, withRealtimeItemOrder(notificationThreadId, notificationTurnId, realtimeToolCompleted))
      scheduleInProgressReconcile(notificationThreadId)
    }

    const mcpToolProgress = readMcpToolProgressUpdate(notification)
    if (mcpToolProgress) {
      const existing = (liveToolMessagesByThreadId.value[notificationThreadId] ?? [])
        .find((message) => message.id === mcpToolProgress.itemId)
      const baseText = existing?.text || 'Calling MCP tool'
      const progressSuffix = mcpToolProgress.message.trim()
      const nextText = progressSuffix ? `${baseText} - ${progressSuffix}` : baseText

      const toolCall = existing?.toolCall
        ? { ...existing.toolCall, progress: progressSuffix }
        : { kind: 'mcp' as const, label: 'MCP tool', detail: '', status: 'inProgress' as const, progress: progressSuffix }

      upsertLiveToolMessage(notificationThreadId, withRealtimeItemOrder(notificationThreadId, notificationTurnId, {
        id: mcpToolProgress.itemId,
        role: 'system',
        text: nextText,
        messageType: existing?.messageType || 'mcpToolCall',
        rawPayload: existing?.rawPayload || toRawPayload({ id: mcpToolProgress.itemId, progress: mcpToolProgress.message }),
        isUnhandled: true,
        toolCall,
      }))
    }

    if (isAgentContentEvent(notification)) {
      if (shouldAutoScrollOnNextAgentEvent && selectedThreadId.value) {
        setThreadScrollState(selectedThreadId.value, {
          scrollTop: 0,
          isAtBottom: true,
          scrollRatio: 1,
        })
      }
      activeReasoningItemId = ''
      clearLiveReasoningForThread(notificationThreadId)
    }

    if (notification.method === 'turn/completed') {
      activeReasoningItemId = ''
      shouldAutoScrollOnNextAgentEvent = false
      clearLiveReasoningForThread(notificationThreadId)
      if (liveCommandsByThreadId.value[notificationThreadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, notificationThreadId)
      }
      if (liveToolMessagesByThreadId.value[notificationThreadId]) {
        liveToolMessagesByThreadId.value = omitKey(liveToolMessagesByThreadId.value, notificationThreadId)
      }
      const completedThreadId = extractThreadIdFromNotification(notification)
      if (completedThreadId) {
        setActiveTurnIdForThread(completedThreadId, null)
        setThreadInProgress(completedThreadId, false)
        setTurnActivityForThread(completedThreadId, null)
        void processQueuedMessages(completedThreadId)
      }
    }

  }

  function queueEventDrivenSync(notification: RpcNotification): void {
    const threadId = extractThreadIdFromNotification(notification)
    if (threadId) {
      pendingThreadMessageRefresh.add(threadId)
    }

    const method = notification.method
    if (
      method.startsWith('thread/') ||
      method.startsWith('turn/') ||
      method.startsWith('item/')
    ) {
      pendingThreadsRefresh = true
    }

    if (eventSyncTimer !== null || typeof window === 'undefined') return
    eventSyncTimer = window.setTimeout(() => {
      eventSyncTimer = null
      void syncFromNotifications()
    }, EVENT_SYNC_DEBOUNCE_MS)
  }

  async function hydrateWorkspaceRootsStateIfNeeded(groups: UiProjectGroup[]): Promise<void> {
    if (hasHydratedWorkspaceRootsState) return
    hasHydratedWorkspaceRootsState = true

    try {
      const rootsState = await getWorkspaceRootsState()
      const hydratedOrder: string[] = []
      for (const rootPath of rootsState.order) {
        const projectName = toProjectNameFromWorkspaceRoot(rootPath)
        if (hydratedOrder.includes(projectName)) continue
        hydratedOrder.push(projectName)
      }

      if (hydratedOrder.length > 0) {
        if (hasKnownProjectOrder(projectOrder.value, groups)) {
          void persistProjectOrderToWorkspaceRoots(groups)
        } else {
          const mergedOrder = mergeProjectOrder(hydratedOrder, groups)
          if (!areStringArraysEqual(projectOrder.value, mergedOrder)) {
            projectOrder.value = mergedOrder
            saveProjectOrder(projectOrder.value)
          }
        }
      }

      if (Object.keys(rootsState.labels).length > 0) {
        const nextLabels = { ...projectDisplayNameById.value }
        let changed = false
        for (const [rootPath, label] of Object.entries(rootsState.labels)) {
          const projectName = toProjectNameFromWorkspaceRoot(rootPath)
          if (nextLabels[projectName] === label) continue
          nextLabels[projectName] = label
          changed = true
        }
        if (changed) {
          projectDisplayNameById.value = nextLabels
          saveProjectDisplayNames(nextLabels)
        }
      }
    } catch {
      // Keep local storage fallback when global state is unavailable.
    }
  }

  async function loadThreadTitleCacheIfNeeded(): Promise<void> {
    if (Object.keys(threadTitleById.value).length > 0) return
    try {
      const cache = await getThreadTitleCache()
      if (Object.keys(cache.titles).length > 0) {
        threadTitleById.value = cache.titles
      }
    } catch {
      // Title cache is optional; keep UI functional.
    }
  }

  async function requestThreadTitleGeneration(threadId: string, prompt: string, cwd: string | null): Promise<void> {
    if (threadTitleById.value[threadId] || manuallyRenamedThreadIds.has(threadId)) return
    const trimmed = prompt.trim()
    if (!trimmed) return
    try {
      const title = await generateThreadTitle(trimmed, cwd)
      if (!title || threadTitleById.value[threadId] || manuallyRenamedThreadIds.has(threadId)) return
      await setThreadName(threadId, title)
      if (
        manuallyRenamedThreadIds.has(threadId) ||
        (threadTitleById.value[threadId] && threadTitleById.value[threadId] !== title)
      ) return
      threadTitleById.value = { ...threadTitleById.value, [threadId]: title }
      applyThreadFlags()
      void persistThreadTitle(threadId, title)
    } catch {
      // Title generation is best-effort.
    }
  }

  async function loadThreads() {
    if (!hasLoadedThreads.value) {
      isLoadingThreads.value = true
    }

    try {
      const [groups, , sharedReadState] = await Promise.all([
        getThreadGroups(),
        loadThreadTitleCacheIfNeeded(),
        getSharedThreadReadState().catch(() => null),
      ])
      if (sharedReadState) applySharedReadState(sharedReadState)
      await hydrateWorkspaceRootsStateIfNeeded(groups)
      syncThreadProgressFromRuntimeStatuses(groups)

      const nextProjectOrder = mergeProjectOrder(projectOrder.value, groups)
      if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
        projectOrder.value = nextProjectOrder
        saveProjectOrder(projectOrder.value)
      }

      const orderedGroups = orderGroupsByProjectOrder(groups, projectOrder.value)
      const mergedWithInProgress = mergeIncomingWithLocalRetainedThreads(
        sourceGroups.value,
        orderedGroups,
        inProgressById.value,
        threadGoalByThreadId.value,
        selectedThreadId.value,
      )
      const threadOrderedGroups = orderGroupsByThreadOrder(mergedWithInProgress, threadOrder.value)
      sourceGroups.value = mergeThreadGroups(sourceGroups.value, threadOrderedGroups)
      const nextInProgressById = pruneThreadStateMap(
        inProgressById.value,
        new Set(flattenThreads(sourceGroups.value).map((thread) => thread.id)),
      )
      if (nextInProgressById !== inProgressById.value) {
        inProgressById.value = nextInProgressById
      }
      const nextActiveTurnIds = pruneThreadStateMap(
        activeTurnIdByThreadId.value,
        new Set(flattenThreads(sourceGroups.value).map((thread) => thread.id)),
      )
      if (nextActiveTurnIds !== activeTurnIdByThreadId.value) {
        activeTurnIdByThreadId.value = nextActiveTurnIds
        saveActiveTurnIdMap(nextActiveTurnIds)
      }
      applyThreadFlags()
      hasLoadedThreads.value = true

      const flatThreads = flattenThreads(projectGroups.value)
      pruneThreadScopedState(flatThreads)

      const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)

      if (selectedThreadId.value && !currentExists) {
        setSelectedThreadId(flatThreads[0]?.id ?? '')
      }
    } finally {
      isLoadingThreads.value = false
    }
  }

  async function loadMessages(threadId: string, options: { silent?: boolean } = {}) {
    if (!threadId) {
      return
    }

    const alreadyLoaded = loadedMessagesByThreadId.value[threadId] === true
    const shouldShowLoading = options.silent !== true && !alreadyLoaded
    if (shouldShowLoading) {
      isLoadingMessages.value = true
    }

    try {
      if (resumedThreadById.value[threadId] !== true) {
        const modelConfig = await resumeThread(threadId)
        const cachedConfig = threadModelConfigById.value[threadId]
        if (cachedConfig) {
          applyThreadModelConfig(threadId, cachedConfig, threadId === selectedThreadId.value)
        } else {
          applyThreadModelConfig(threadId, modelConfig, threadId === selectedThreadId.value)
        }
        resumedThreadById.value = {
          ...resumedThreadById.value,
          [threadId]: true,
        }
      } else {
        const cachedConfig = threadModelConfigById.value[threadId]
        if (cachedConfig && threadId === selectedThreadId.value) {
          applyThreadModelConfig(threadId, cachedConfig, true)
        }
      }

      const readId = ++historyReadSequence
      const [page, nextGoal] = await Promise.all([
        getThreadMessagesWithStatus(threadId, { limit: THREAD_MESSAGE_PAGE_SIZE }),
        getThreadGoal(threadId).catch(() => null),
      ])
      if (!acceptHistoryRead(threadId, readId)) return
      const { isInProgress, activeTurnId, turnSummaries } = page
      const nextMessages = preserveObservedAgentText(threadId, page.messages, readId, isInProgress)
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const mergedMessages = mergeServerMessagesPreservingOptimistic(previousPersisted, nextMessages, {
        preserveMissing: options.silent === true || alreadyLoaded,
      })
      setPersistedMessagesForThread(threadId, mergedMessages)
      setTurnSummariesForThread(threadId, turnSummaries, {
        preserveMissing: options.silent === true || alreadyLoaded,
      })
      setThreadPagination(threadId, page, {
        preserveEarlier: options.silent === true || alreadyLoaded,
      })

      const previousLiveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
      const nextLiveAgent = removeRedundantLiveAgentMessages(previousLiveAgent, nextMessages)
      setLiveAgentMessagesForThread(threadId, nextLiveAgent)
      removeLiveCommandsPersistedIn(threadId, nextMessages)
      removeLiveToolMessagesPersistedIn(threadId, nextMessages)

      loadedMessagesByThreadId.value = {
        ...loadedMessagesByThreadId.value,
        [threadId]: true,
      }

      const version = currentThreadVersion(threadId)
      if (version) {
        loadedVersionByThreadId.value = {
          ...loadedVersionByThreadId.value,
          [threadId]: version,
        }
      }
      if (historyHasCurrentRuntimeState(threadId, readId)) {
        setThreadInProgress(threadId, isInProgress)
        if (isInProgress) {
          if (activeTurnId) setActiveTurnIdForThread(threadId, activeTurnId)
        } else {
          setActiveTurnIdForThread(threadId, null)
        }
      }
      setThreadGoalForState(threadId, nextGoal)
      maybeAutoClearCompletedThreadGoal(threadId, nextGoal)
      markThreadAsRead(threadId)
    } finally {
      if (shouldShowLoading) {
        isLoadingMessages.value = false
      }
    }
  }

  async function loadEarlierMessages(threadId = selectedThreadId.value): Promise<void> {
    if (!threadId) return
    const pagination = paginationByThreadId.value[threadId]
    if (!pagination?.hasEarlier || loadingEarlierByThreadId.value[threadId] === true) return

    loadingEarlierByThreadId.value = {
      ...loadingEarlierByThreadId.value,
      [threadId]: true,
    }
    earlierLoadErrorByThreadId.value = omitKey(earlierLoadErrorByThreadId.value, threadId)

    try {
      const readId = ++historyReadSequence
      const page = await getThreadMessagesWithStatus(threadId, {
        beforeTurnIndex: pagination.startTurnIndex,
        limit: THREAD_MESSAGE_PAGE_SIZE,
      })
      if (!acceptHistoryRead(threadId, readId, true)) return
      const previous = persistedMessagesByThreadId.value[threadId] ?? []
      const merged = mergeServerMessagesPreservingOptimistic(previous, page.messages, {
        preserveMissing: true,
      })
      setPersistedMessagesForThread(threadId, merged)
      setTurnSummariesForThread(threadId, page.turnSummaries, { preserveMissing: true })
      setThreadPagination(threadId, page)
    } catch (unknownError) {
      earlierLoadErrorByThreadId.value = {
        ...earlierLoadErrorByThreadId.value,
        [threadId]: unknownError instanceof Error
          ? unknownError.message
          : 'Could not load earlier messages',
      }
    } finally {
      loadingEarlierByThreadId.value = omitKey(loadingEarlierByThreadId.value, threadId)
    }
  }

  async function refreshSkills(): Promise<void> {
    try {
      const cwds = sourceGroups.value.flatMap((g) => g.threads.map((t) => t.cwd)).filter(Boolean)
      installedSkills.value = await getSkillsList(cwds.length > 0 ? [...new Set(cwds)] : undefined)
    } catch {
      // keep previous skills on failure
    }
  }

  async function refreshAll() {
    error.value = ''

    try {
      await loadThreads()
      await Promise.all([
        refreshModelPreferences(),
        refreshSkills(),
        refreshAccountRateLimits(),
      ])
      await loadMessages(selectedThreadId.value)
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function selectThread(threadId: string) {
    setSelectedThreadId(threadId)
    if (!threadId) {
      applyNewThreadModelConfig()
      return
    }

    const cachedConfig = threadModelConfigById.value[threadId]
    if (cachedConfig) {
      applyThreadModelConfig(threadId, cachedConfig, true)
    }

    try {
      await loadMessages(threadId)
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function selectThreadFromSearch(thread: UiThread): Promise<void> {
    ensureSearchThreadVisible(thread)
    await selectThread(thread.id)
  }

  async function archiveThreadById(threadId: string) {
    try {
      await archiveThread(threadId)
      await loadThreads()

      if (selectedThreadId.value === threadId) {
        await loadMessages(selectedThreadId.value)
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function renameThread(threadId: string, name: string): Promise<void> {
    const normalizedName = name.replace(/\s+/g, ' ').trim()
    if (!threadId || !normalizedName) return
    manuallyRenamedThreadIds.add(threadId)

    try {
      await setThreadName(threadId, normalizedName)
      threadTitleById.value = { ...threadTitleById.value, [threadId]: normalizedName }
      applyThreadFlags()
      void persistThreadTitle(threadId, normalizedName)
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to rename chat'
    }
  }

  async function setGoalForExistingThread(
    threadId: string,
    objective: string,
  ): Promise<UiThreadGoal | null> {
    const normalizedObjective = objective.trim()
    if (!threadId || !normalizedObjective) return null

    try {
      const goal = await setThreadGoal(threadId, {
        objective: normalizedObjective,
        status: 'active',
      })
      setThreadGoalForState(threadId, goal)
      maybeAutoClearCompletedThreadGoal(threadId, goal)
      void continueActiveThreadGoal(threadId)
      return goal
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to set thread goal'
      throw unknownError
    }
  }

  async function setGoalForSelectedThread(objective: string): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return
    await setGoalForExistingThread(threadId, objective)
  }

  async function createThreadWithGoal(objective: string, cwd: string): Promise<string> {
    const normalizedObjective = objective.trim()
    const targetCwd = cwd.trim()
    const selectedModel = selectedModelId.value.trim()
    if (!normalizedObjective) return ''

    error.value = ''
    const startResult = await startThread(
      targetCwd || undefined,
      selectedModel || undefined,
      getRequestedServiceTier(selectedModel),
    )
    const threadId = startResult.threadId
    if (!threadId) return ''

    applyThreadModelConfig(threadId, {
      model: selectedModel || startResult.modelConfig.model,
      reasoningEffort: selectedReasoningEffort.value || startResult.modelConfig.reasoningEffort,
    }, false)
    insertOptimisticThread(threadId, targetCwd, normalizedObjective)
    setSelectedThreadId(threadId)
    const goal = await setGoalForExistingThread(threadId, normalizedObjective)
    if (goal) {
      setThreadGoalForState(threadId, goal)
      maybeAutoClearCompletedThreadGoal(threadId, goal)
    }
    return threadId
  }

  async function clearGoalForSelectedThread(): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return

    try {
      await clearThreadGoal(threadId)
      setThreadGoalForState(threadId, null)
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to clear thread goal'
      throw unknownError
    }
  }

  async function updateSelectedThreadGoalStatus(status: ThreadGoalStatus): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return

    try {
      const goal = await setThreadGoal(threadId, { status })
      setThreadGoalForState(threadId, goal)
      maybeAutoClearCompletedThreadGoal(threadId, goal)
      if (status === 'active') {
        void continueActiveThreadGoal(threadId)
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to update thread goal'
      throw unknownError
    }
  }

  async function sendMessageToSelectedThread(
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    mode: 'steer' | 'queue' = 'steer',
    fileAttachments: FileAttachment[] = [],
    responseTextAnnotations: ResponseTextAnnotation[] = [],
    plugins: PluginMentionParam[] = [],
    threads: ThreadMentionParam[] = [],
  ): Promise<void> {
    const threadId = selectedThreadId.value
    const nextText = text.trim()
    if (!threadId || (!nextText && imageUrls.length === 0 && fileAttachments.length === 0 && responseTextAnnotations.length === 0)) return

    promoteThreadForActivity(threadId)
    const isInProgress = inProgressById.value[threadId] === true

    if (isInProgress && mode === 'queue') {
      const queue = queuedMessagesByThreadId.value[threadId] ?? []
      const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      queuedMessagesByThreadId.value = {
        ...queuedMessagesByThreadId.value,
        [threadId]: [...queue, { id, text: nextText, imageUrls, skills, plugins, threads, fileAttachments, responseTextAnnotations }],
      }
      return
    }

    if (isInProgress) {
      shouldAutoScrollOnNextAgentEvent = true
      // Optimistic user message for steer path
      const steerOptimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const steerOptimisticMessage: UiMessage = {
        id: steerOptimisticId,
        role: 'user',
        text: nextText,
        messageType: 'userMessage.steering',
        orderKey: nextLiveOrderKey(threadId),
        images: imageUrls.length > 0 ? imageUrls : undefined,
        fileAttachments: fileAttachments.length > 0 ? fileAttachments.map(a => ({ label: a.label, path: a.path })) : undefined,
        threadReferences: threads.length > 0 ? threads : undefined,
        responseAnnotations: responseTextAnnotations.length > 0 ? responseTextAnnotations : undefined,
      }
      const steerPrevious = persistedMessagesByThreadId.value[threadId] ?? []
      setPersistedMessagesForThread(threadId, [...steerPrevious, steerOptimisticMessage])
      void startTurnForThread(threadId, nextText, imageUrls, skills, fileAttachments, responseTextAnnotations, plugins, threads)
        .then(() => setOptimisticMessageType(threadId, steerOptimisticId, 'userMessage.steered'))
        .catch((unknownError) => {
          setOptimisticMessageType(threadId, steerOptimisticId, 'userMessage.failed')
          const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
          setTurnErrorForThread(threadId, errorMessage)
          error.value = errorMessage
        })
      return
    }

    error.value = ''
    shouldAutoScrollOnNextAgentEvent = true
    const turnModelConfig = getTurnModelConfig(threadId)
    setTurnActivityForThread(
      threadId,
      { label: 'Thinking', details: buildPendingTurnDetails(turnModelConfig.model, turnModelConfig.reasoningEffort) },
    )
    setTurnErrorForThread(threadId, null)
    setThreadInProgress(threadId, true)

    // Optimistic user message: show immediately before the API round-trip
    const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const optimisticMessage: UiMessage = {
      id: optimisticId,
      role: 'user',
      text: nextText,
      orderKey: nextLiveOrderKey(threadId),
      images: imageUrls.length > 0 ? imageUrls : undefined,
      fileAttachments: fileAttachments.length > 0 ? fileAttachments.map(a => ({ label: a.label, path: a.path })) : undefined,
      threadReferences: threads.length > 0 ? threads : undefined,
      responseAnnotations: responseTextAnnotations.length > 0 ? responseTextAnnotations : undefined,
    }
    const previousMessages = persistedMessagesByThreadId.value[threadId] ?? []
    setPersistedMessagesForThread(threadId, [...previousMessages, optimisticMessage])

    try {
      await startTurnForThread(threadId, nextText, imageUrls, skills, fileAttachments, responseTextAnnotations, plugins, threads)
    } catch (unknownError) {
      shouldAutoScrollOnNextAgentEvent = false
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      throw unknownError
    }
  }

  async function sendMessageToNewThread(
    text: string,
    cwd: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    responseTextAnnotations: ResponseTextAnnotation[] = [],
    plugins: PluginMentionParam[] = [],
    threads: ThreadMentionParam[] = [],
  ): Promise<string> {
    const nextText = text.trim()
    const targetCwd = cwd.trim()
    const selectedModel = selectedModelId.value.trim()
    if (!nextText && imageUrls.length === 0 && fileAttachments.length === 0 && responseTextAnnotations.length === 0) return ''

    isSendingMessage.value = true
    error.value = ''
    let threadId = ''

    try {
      const startResult = await startThread(
        targetCwd || undefined,
        selectedModel || undefined,
        getRequestedServiceTier(selectedModel),
      )
      threadId = startResult.threadId
      if (!threadId) return ''
      applyThreadModelConfig(threadId, {
        model: selectedModel || startResult.modelConfig.model,
        reasoningEffort: selectedReasoningEffort.value || startResult.modelConfig.reasoningEffort,
      }, false)

      insertOptimisticThread(threadId, targetCwd, nextText || (responseTextAnnotations.length > 0 ? '[Selection]' : '[Image]'))
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [threadId]: true,
      }
      setSelectedThreadId(threadId)
      shouldAutoScrollOnNextAgentEvent = true
      const turnModelConfig = getTurnModelConfig(threadId)
      setTurnActivityForThread(
        threadId,
        { label: 'Thinking', details: buildPendingTurnDetails(turnModelConfig.model, turnModelConfig.reasoningEffort) },
      )
      setTurnErrorForThread(threadId, null)
      setThreadInProgress(threadId, true)
      // Optimistic user message for new thread
      const newThreadOptimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const newThreadOptimisticMessage: UiMessage = {
        id: newThreadOptimisticId,
        role: 'user',
        text: nextText,
        orderKey: nextLiveOrderKey(threadId),
        images: imageUrls.length > 0 ? imageUrls : undefined,
        fileAttachments: fileAttachments.length > 0 ? fileAttachments.map(a => ({ label: a.label, path: a.path })) : undefined,
        threadReferences: threads.length > 0 ? threads : undefined,
        responseAnnotations: responseTextAnnotations.length > 0 ? responseTextAnnotations : undefined,
      }
      const newThreadPrevious = persistedMessagesByThreadId.value[threadId] ?? []
      setPersistedMessagesForThread(threadId, [...newThreadPrevious, newThreadOptimisticMessage])
      const capturedThreadId = threadId
      const capturedCwd = targetCwd || null
      const capturedPrompt = nextText
      void startTurnForThread(threadId, nextText, imageUrls, skills, fileAttachments, responseTextAnnotations, plugins, threads)
        .catch((unknownError) => {
          shouldAutoScrollOnNextAgentEvent = false
          setThreadInProgress(threadId, false)
          setTurnActivityForThread(threadId, null)
          const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
          setTurnErrorForThread(threadId, errorMessage)
          error.value = errorMessage
        })
        .finally(() => {
          isSendingMessage.value = false
        })
      void requestThreadTitleGeneration(capturedThreadId, capturedPrompt, capturedCwd)
      return threadId
    } catch (unknownError) {
      shouldAutoScrollOnNextAgentEvent = false
      if (threadId) {
        setThreadInProgress(threadId, false)
        setTurnActivityForThread(threadId, null)
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      if (threadId) {
        setTurnErrorForThread(threadId, errorMessage)
      }
      error.value = errorMessage
      isSendingMessage.value = false
      throw unknownError
    }
  }

  async function startTurnForThread(
    threadId: string,
    nextText: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    responseTextAnnotations: ResponseTextAnnotation[] = [],
    plugins: PluginMentionParam[] = [],
    threads: ThreadMentionParam[] = [],
  ): Promise<void> {
    const modelConfig = getTurnModelConfig(threadId)
    let modelId = modelConfig.model.trim()
    let reasoningEffort = modelConfig.reasoningEffort

    try {
      if (resumedThreadById.value[threadId] !== true) {
        const resumedConfig = await resumeThread(threadId)
        if (!modelId && !reasoningEffort) {
          applyThreadModelConfig(threadId, resumedConfig, threadId === selectedThreadId.value)
          modelId = resumedConfig.model.trim()
          reasoningEffort = resumedConfig.reasoningEffort
        }
      }

      const resolvedThreads = await resolveThreadMentions(threadId, threads)
      await startThreadTurn(
        threadId,
        nextText,
        imageUrls,
        modelId || undefined,
        reasoningEffort || undefined,
        skills.length > 0 ? skills : undefined,
        fileAttachments,
        responseTextAnnotations,
        plugins,
        resolvedThreads,
        getRequestedServiceTier(modelId),
      )

      resumedThreadById.value = {
        ...resumedThreadById.value,
        [threadId]: true,
      }

      pendingThreadMessageRefresh.add(threadId)
      pendingThreadsRefresh = true
      await syncFromNotifications()
    } catch (unknownError) {
      throw unknownError
    }
  }

  async function resolveThreadMentions(
    activeThreadId: string,
    threads: ThreadMentionParam[],
  ): Promise<ResolvedThreadMentionParam[]> {
    const uniqueThreads: ThreadMentionParam[] = []
    const seen = new Set<string>()
    for (const thread of threads) {
      const id = thread.id.trim()
      if (!id || id === activeThreadId || seen.has(id)) continue
      seen.add(id)
      uniqueThreads.push({
        id,
        name: thread.name.trim() || 'Untitled chat',
        path: `thread://${id}`,
      })
      if (uniqueThreads.length >= MAX_THREAD_REFERENCE_COUNT) break
    }

    return Promise.all(uniqueThreads.map(async (thread) => {
      try {
        const page = await getThreadMessagesWithStatus(thread.id, { limit: THREAD_MESSAGE_PAGE_SIZE })
        return {
          ...thread,
          messages: page.messages.map((message) => ({ role: message.role, text: message.text })),
          hasEarlier: page.hasEarlier,
        }
      } catch (unknownError) {
        const detail = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        throw new Error(`Could not reference chat “${thread.name}”: ${detail}`)
      }
    }))
  }

  async function processQueuedMessages(threadId: string): Promise<void> {
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue || queue.length === 0) return
    const [next, ...rest] = queue
    queuedMessagesByThreadId.value = rest.length > 0
      ? { ...queuedMessagesByThreadId.value, [threadId]: rest }
      : omitKey(queuedMessagesByThreadId.value, threadId)
    isSendingMessage.value = true
    error.value = ''
    shouldAutoScrollOnNextAgentEvent = true
    const turnModelConfig = getTurnModelConfig(threadId)
    setTurnActivityForThread(threadId, { label: 'Thinking', details: buildPendingTurnDetails(turnModelConfig.model, turnModelConfig.reasoningEffort) })
    setTurnErrorForThread(threadId, null)
    setThreadInProgress(threadId, true)
    try {
      await startTurnForThread(
        threadId,
        next.text,
        next.imageUrls,
        next.skills,
        next.fileAttachments,
        next.responseTextAnnotations,
        next.plugins,
        next.threads,
      )
    } catch {
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
    } finally {
      isSendingMessage.value = false
    }
  }

  async function interruptSelectedThreadTurn(): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return
    if (inProgressById.value[threadId] !== true) return
    const turnId = activeTurnIdByThreadId.value[threadId]

    isInterruptingTurn.value = true
    error.value = ''
    try {
      await interruptThreadTurn(threadId, turnId)
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
      setTurnErrorForThread(threadId, null)
      setActiveTurnIdForThread(threadId, null)
      pendingThreadMessageRefresh.add(threadId)
      pendingThreadsRefresh = true
      await syncFromNotifications()
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to interrupt active turn'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
    } finally {
      isInterruptingTurn.value = false
    }
  }

  async function rollbackSelectedThread(turnIndex: number): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return
    if (isRollingBack.value) return

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const maxTurnIndex = persisted.reduce((max, m) => (typeof m.turnIndex === 'number' && m.turnIndex > max ? m.turnIndex : max), -1)
    if (maxTurnIndex < 0 || turnIndex > maxTurnIndex) return
    const numTurns = maxTurnIndex - turnIndex + 1
    if (numTurns < 1) return

    isRollingBack.value = true
    error.value = ''
    try {
      const nextMessages = await rollbackThread(threadId, numTurns)
      // Explicit rollback is authoritative; a read started before it completed
      // must not restore removed turns, even if its response arrives later.
      resetHistoryReadByThreadId.set(threadId, ++historyReadSequence)
      setPersistedMessagesForThread(threadId, nextMessages)
      setLiveAgentMessagesForThread(threadId, [])
      clearLiveReasoningForThread(threadId)
      if (liveCommandsByThreadId.value[threadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
      }
      if (liveToolMessagesByThreadId.value[threadId]) {
        liveToolMessagesByThreadId.value = omitKey(liveToolMessagesByThreadId.value, threadId)
      }
      clearTurnSummariesForThread(threadId)
      setTurnActivityForThread(threadId, null)
      setTurnErrorForThread(threadId, null)
      pendingThreadsRefresh = true
      await syncFromNotifications()
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to rollback thread'
    } finally {
      isRollingBack.value = false
    }
  }

  async function continueSelectedThreadInNewChat(
    turnIndex: number,
    target: 'workspace' | 'worktree',
  ): Promise<string> {
    const sourceThread = selectedThread.value
    if (!sourceThread || isForkingThread.value) return ''

    const sourceMessages = persistedMessagesByThreadId.value[sourceThread.id] ?? []
    const maxTurnIndex = sourceMessages.reduce(
      (max, message) => typeof message.turnIndex === 'number' ? Math.max(max, message.turnIndex) : max,
      -1,
    )
    if (maxTurnIndex < 0 || turnIndex < 0 || turnIndex > maxTurnIndex) return ''

    isForkingThread.value = true
    error.value = ''
    try {
      const targetCwd = target === 'worktree'
        ? await createWorktree(sourceThread.cwd)
        : sourceThread.cwd
      const forked = await forkThread(sourceThread.id, {
        cwd: targetCwd,
        numTurnsToDrop: maxTurnIndex - turnIndex,
      })

      const sourceTitle = sourceThread.title.trim()
      if (sourceTitle) {
        await setThreadName(forked.threadId, sourceTitle).catch(() => {})
        threadTitleById.value = {
          ...threadTitleById.value,
          [forked.threadId]: sourceTitle,
        }
        void persistThreadTitle(forked.threadId, sourceTitle)
      }

      applyThreadModelConfig(forked.threadId, forked.modelConfig, false)
      setPersistedMessagesForThread(forked.threadId, forked.messages)
      loadedMessagesByThreadId.value = {
        ...loadedMessagesByThreadId.value,
        [forked.threadId]: true,
      }
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [forked.threadId]: true,
      }

      await loadThreads()
      if (!flattenThreads(sourceGroups.value).some((thread) => thread.id === forked.threadId)) {
        insertOptimisticThread(forked.threadId, targetCwd, sourceTitle || sourceThread.preview)
      }
      setSelectedThreadId(forked.threadId)
      applyThreadModelConfig(forked.threadId, forked.modelConfig, true)
      setThreadScrollState(forked.threadId, { scrollTop: 0, isAtBottom: true, scrollRatio: 1 })
      await loadMessages(forked.threadId, { silent: true })
      return forked.threadId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to continue in a new chat'
      throw unknownError
    } finally {
      isForkingThread.value = false
    }
  }

  function renameProject(projectName: string, displayName: string): void {
    if (projectName.length === 0) return

    const currentValue = projectDisplayNameById.value[projectName] ?? ''
    if (currentValue === displayName) return

    projectDisplayNameById.value = {
      ...projectDisplayNameById.value,
      [projectName]: displayName,
    }
    saveProjectDisplayNames(projectDisplayNameById.value)
  }

  function removeProject(projectName: string): void {
    if (projectName.length === 0) return

    const nextProjectOrder = projectOrder.value.filter((name) => name !== projectName)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }

    sourceGroups.value = sourceGroups.value.filter((group) => group.projectName !== projectName)

    if (projectDisplayNameById.value[projectName] !== undefined) {
      const nextDisplayNames = { ...projectDisplayNameById.value }
      delete nextDisplayNames[projectName]
      projectDisplayNameById.value = nextDisplayNames
      saveProjectDisplayNames(nextDisplayNames)
    }

    applyThreadFlags()

    const flatThreads = flattenThreads(projectGroups.value)
    pruneThreadScopedState(flatThreads)

    const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)
    if (!currentExists) {
      setSelectedThreadId(flatThreads[0]?.id ?? '')
    }

    void persistProjectOrderToWorkspaceRoots()
  }

  function reorderProject(projectName: string, toIndex: number): void {
    if (projectName.length === 0) return
    if (sourceGroups.value.length === 0) return

    const visibleOrder = sourceGroups.value.map((group) => group.projectName)
    const fromIndex = visibleOrder.indexOf(projectName)
    if (fromIndex === -1) return

    const clampedToIndex = Math.max(0, Math.min(toIndex, visibleOrder.length - 1))
    const reorderedVisibleOrder = reorderStringArray(visibleOrder, fromIndex, clampedToIndex)
    if (reorderedVisibleOrder === visibleOrder) return

    const normalizedProjectOrder = mergeProjectOrder(reorderedVisibleOrder, sourceGroups.value)
    projectOrder.value = normalizedProjectOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  function reorderThread(threadId: string, toIndex: number, projectName = '', scopeThreadIdsOverride?: string[]): void {
    if (threadId.length === 0) return
    if (sourceGroups.value.length === 0) return

    const allThreadIds = flattenThreads(sourceGroups.value).map((thread) => thread.id)
    const activeThreadIds = new Set(allThreadIds)
    const scopeThreadIds = Array.isArray(scopeThreadIdsOverride) && scopeThreadIdsOverride.length > 0
      ? scopeThreadIdsOverride.filter((id) => activeThreadIds.has(id))
      : projectName
        ? sourceGroups.value.find((group) => group.projectName === projectName)?.threads.map((thread) => thread.id) ?? []
        : allThreadIds
    const fromIndex = scopeThreadIds.indexOf(threadId)
    if (fromIndex === -1) return

    const clampedToIndex = Math.max(0, Math.min(toIndex, scopeThreadIds.length - 1))
    const reorderedScope = reorderStringArray(scopeThreadIds, fromIndex, clampedToIndex)
    if (reorderedScope === scopeThreadIds) return

    const scopeThreadIdSet = new Set(reorderedScope)
    const baseOrder = threadOrder.value.length > 0 ? threadOrder.value : allThreadIds
    const nextOrder: string[] = []
    let insertedScope = false

    for (const currentThreadId of baseOrder) {
      if (!activeThreadIds.has(currentThreadId)) continue
      if (!scopeThreadIdSet.has(currentThreadId)) {
        nextOrder.push(currentThreadId)
        continue
      }

      if (insertedScope) continue
      nextOrder.push(...reorderedScope)
      insertedScope = true
    }

    if (!insertedScope) {
      nextOrder.push(...reorderedScope)
    }

    for (const currentThreadId of allThreadIds) {
      if (!nextOrder.includes(currentThreadId)) {
        nextOrder.push(currentThreadId)
      }
    }

    const prunedOrder = pruneThreadOrder(nextOrder, activeThreadIds)
    threadOrder.value = prunedOrder
    saveThreadOrder(prunedOrder)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderGroupsByThreadOrder(sourceGroups.value, threadOrder.value))
    applyThreadFlags()
  }

  function pinProjectToTop(projectName: string): void {
    const normalizedName = projectName.trim()
    if (!normalizedName) return
    const nextOrder = [normalizedName, ...projectOrder.value.filter((name) => name !== normalizedName)]
    if (areStringArraysEqual(projectOrder.value, nextOrder)) return
    projectOrder.value = nextOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  async function persistProjectOrderToWorkspaceRoots(groupsOverride?: UiProjectGroup[]): Promise<void> {
    try {
      const rootsState = await getWorkspaceRootsState()
      const rootByProjectName = new Map<string, string>()
      for (const rootPath of rootsState.order) {
        const projectName = toProjectNameFromWorkspaceRoot(rootPath)
        if (!rootByProjectName.has(projectName)) {
          rootByProjectName.set(projectName, rootPath)
        }
      }
      for (const group of groupsOverride ?? sourceGroups.value) {
        const cwd = group.threads[0]?.cwd?.trim() ?? ''
        if (!cwd) continue
        rootByProjectName.set(group.projectName, cwd)
      }

      const nextOrder: string[] = []
      for (const projectName of projectOrder.value) {
        const rootPath = rootByProjectName.get(projectName)
        if (rootPath && !nextOrder.includes(rootPath)) {
          nextOrder.push(rootPath)
        }
      }
      for (const rootPath of rootsState.order) {
        if (!nextOrder.includes(rootPath)) {
          nextOrder.push(rootPath)
        }
      }

      const nextActive = rootsState.active.filter((rootPath) => nextOrder.includes(rootPath))
      if (nextActive.length === 0 && nextOrder.length > 0) {
        nextActive.push(nextOrder[0])
      }

      await setWorkspaceRootsState({
        order: nextOrder,
        labels: rootsState.labels,
        active: nextActive,
      })
    } catch {
      // Keep local project order when global state persistence is unavailable.
    }
  }

  async function syncFromNotifications(): Promise<void> {
    if (isPolling.value) {
      if (typeof window !== 'undefined' && eventSyncTimer === null) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
      return
    }

    isPolling.value = true

    const shouldRefreshThreads = pendingThreadsRefresh
    const threadIdsToRefresh = new Set(pendingThreadMessageRefresh)
    pendingThreadsRefresh = false
    pendingThreadMessageRefresh.clear()

    try {
      if (shouldRefreshThreads) {
        await loadThreads()
      }

      const activeThreadId = selectedThreadId.value
      if (!activeThreadId) return

      const isActiveDirty = threadIdsToRefresh.has(activeThreadId)
      const isInProgress = inProgressById.value[activeThreadId] === true
      const currentVersion = currentThreadVersion(activeThreadId)
      const loadedVersion = loadedVersionByThreadId.value[activeThreadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion

      if (isActiveDirty || isInProgress || hasVersionChange || shouldRefreshThreads) {
        await loadMessages(activeThreadId, { silent: true })
      }
    } catch {
      // Keep UI stable on transient event sync failures.
    } finally {
      isPolling.value = false

      if (
        (pendingThreadsRefresh || pendingThreadMessageRefresh.size > 0) &&
        typeof window !== 'undefined' &&
        eventSyncTimer === null
      ) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
    }
  }

  function startPolling(): void {
    if (typeof window === 'undefined') return

    if (stopNotificationStream) return
    void loadPendingServerRequestsFromBridge()
    stopNotificationStream = subscribeCodexNotifications({
      onNotification: (notification) => {
        applyRealtimeUpdates(notification)
        queueEventDrivenSync(notification)
      },
      onReconnect: () => {
        void (async () => {
          try {
            await loadThreads()
            await Promise.all([refreshModelPreferences(), refreshSkills(), refreshAccountRateLimits()])

            const threadId = selectedThreadId.value
            if (threadId) {
              const readId = ++historyReadSequence
              const [page, goal] = await Promise.all([
                getThreadMessagesWithStatus(threadId),
                getThreadGoal(threadId).catch(() => null),
              ])
              if (!acceptHistoryRead(threadId, readId)) return
              const { isInProgress, activeTurnId, turnSummaries } = page
              const messages = preserveObservedAgentText(threadId, page.messages, readId, isInProgress)
              const previous = persistedMessagesByThreadId.value[threadId] ?? []
              const merged = mergeServerMessagesPreservingOptimistic(previous, messages, { preserveMissing: true })
              setPersistedMessagesForThread(threadId, merged)
              setTurnSummariesForThread(threadId, turnSummaries, { preserveMissing: true })
              setThreadPagination(threadId, page, { preserveEarlier: true })

              const previousLiveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
              const nextLiveAgent = removeRedundantLiveAgentMessages(previousLiveAgent, messages)
              setLiveAgentMessagesForThread(threadId, nextLiveAgent)
              removeLiveCommandsPersistedIn(threadId, messages)
              removeLiveToolMessagesPersistedIn(threadId, messages)

              if (historyHasCurrentRuntimeState(threadId, readId)) {
                setThreadInProgress(threadId, isInProgress)
                if (isInProgress) {
                  if (activeTurnId) setActiveTurnIdForThread(threadId, activeTurnId)
                } else {
                  setActiveTurnIdForThread(threadId, null)
                }
              }
              setThreadGoalForState(threadId, goal)
              maybeAutoClearCompletedThreadGoal(threadId, goal)
            }
          } catch {
            // Keep UI usable when reconnect refresh fails.
          }
          void loadPendingServerRequestsFromBridge()
        })()
      },
    })
  }

  async function loadPendingServerRequestsFromBridge(): Promise<void> {
    try {
      const rows = await getPendingServerRequests()
      for (const row of rows) {
        const request = normalizeServerRequest(row)
        if (request) {
          upsertPendingServerRequest(request)
        }
      }
    } catch {
      // Keep UI usable when pending request endpoint is temporarily unavailable.
    }
  }

  async function respondToPendingServerRequest(reply: UiServerRequestReply): Promise<void> {
    const pending = Object.values(pendingServerRequestsByThreadId.value).flat().find((request) => request.id === reply.id)
    if (pending?.replyState === 'sending') return
    if (pending) upsertPendingServerRequest({ ...pending, replyState: 'sending', replyError: undefined })
    try {
      await replyToServerRequest(reply.id, {
        result: reply.result,
        error: reply.error,
      })
      removePendingServerRequestById(reply.id)
    } catch (unknownError) {
      const message = unknownError instanceof Error ? unknownError.message : 'Failed to reply to server request'
      error.value = message
      // Another client may have resolved the request while this reply was in flight.
      const current = Object.values(pendingServerRequestsByThreadId.value).flat().find((request) => request.id === reply.id)
      if (current) upsertPendingServerRequest({ ...current, replyState: 'failed', replyError: message })
    }
  }

  function stopPolling(): void {
    if (stopNotificationStream) {
      stopNotificationStream()
      stopNotificationStream = null
    }

    pendingThreadsRefresh = false
    pendingThreadMessageRefresh.clear()
    pendingTurnStartsById.clear()
    if (eventSyncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(eventSyncTimer)
      eventSyncTimer = null
    }
    if (typeof window !== 'undefined') {
      for (const timer of inProgressReconcileTimerByThreadId.values()) {
        window.clearTimeout(timer)
      }
    }
    inProgressReconcileTimerByThreadId.clear()
    browserNotifiedTurnKeys.clear()
    browserNotifiedTurnOrder.length = 0
    audienceByThreadId.clear()
    pendingAudienceLookupByThreadId.clear()
    activeReasoningItemId = ''
    shouldAutoScrollOnNextAgentEvent = false
    liveOrderCounterByThreadId.clear()
    liveTurnIndexByTurnId.clear()
    liveItemIndexByItemKey.clear()
    liveItemCounterByTurnKey.clear()
    historyReadReset = ++historyReadSequence
    appliedTailReadByThreadId.clear()
    resetHistoryReadByThreadId.clear()
    realtimeMessageVersionByThreadId.clear()
    agentMessageVersionByThreadId.clear()
    persistedMessagesByThreadId.value = {}
    recentMessageThreadIds.length = 0
    paginationByThreadId.value = {}
    loadingEarlierByThreadId.value = {}
    earlierLoadErrorByThreadId.value = {}
    liveAgentMessagesByThreadId.value = {}
    liveReasoningTextByThreadId.value = {}
    liveCommandsByThreadId.value = {}
    liveToolMessagesByThreadId.value = {}
    turnActivityByThreadId.value = {}
    turnSummaryByThreadId.value = {}
    turnErrorByThreadId.value = {}
    activeTurnIdByThreadId.value = {}
    queuedMessagesByThreadId.value = {}
  }

  const selectedThreadQueuedMessages = computed<QueuedMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []
    return queuedMessagesByThreadId.value[threadId] ?? []
  })

  function removeQueuedMessage(messageId: string): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return
    const next = queue.filter((m) => m.id !== messageId)
    queuedMessagesByThreadId.value = next.length > 0
      ? { ...queuedMessagesByThreadId.value, [threadId]: next }
      : omitKey(queuedMessagesByThreadId.value, threadId)
  }

  function steerQueuedMessage(messageId: string): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return
    const msg = queue.find((m) => m.id === messageId)
    if (!msg) return
    removeQueuedMessage(messageId)
    void sendMessageToSelectedThread(
      msg.text,
      msg.imageUrls,
      msg.skills,
      'steer',
      msg.fileAttachments,
      msg.responseTextAnnotations,
      msg.plugins,
      msg.threads,
    )
  }

  return {
    setBoardManagedThreadIds,
    projectGroups,
    projectDisplayNameById,
    selectedThread,
    selectedThreadGoal,
    selectedThreadTokenUsage,
    selectedThreadScrollState,
    selectedThreadServerRequests,
    selectedLiveOverlay,
    selectedThreadId,
    availableModelIds,
    selectedModelId,
    selectedReasoningEffort,
    fastModeAvailable,
    fastModeEnabled,
    isUpdatingFastMode,
    fastModeError,
    accountRateLimits,
    installedSkills,
    messages,
    selectedThreadHasEarlierMessages,
    isLoadingSelectedThreadEarlierMessages,
    selectedThreadEarlierLoadError,
    isLoadingThreads,
    isLoadingMessages,
    isSendingMessage,
    isInterruptingTurn,
    isUsingRateLimitReset,
    error,
    refreshAll,
    refreshThreadReadState,
    refreshAccountRateLimits,
    useRateLimitReset,
    refreshSkills,
    loadEarlierMessages,
    selectThread,
    selectThreadFromSearch,
    setThreadScrollState,
    archiveThreadById,
    renameThread,
    createThreadWithGoal,
    sendMessageToSelectedThread,
    sendMessageToNewThread,
    setGoalForSelectedThread,
    clearGoalForSelectedThread,
    updateSelectedThreadGoalStatus,
    interruptSelectedThreadTurn,
    continueSelectedThreadInNewChat,
    isForkingThread,
    rollbackSelectedThread,
    isRollingBack,
    selectedThreadQueuedMessages,
    removeQueuedMessage,
    steerQueuedMessage,
    setSelectedModelId,
    setSelectedReasoningEffort,
    setFastModeEnabled,
    refreshFastModePreference,
    respondToPendingServerRequest,
    renameProject,
    removeProject,
    reorderProject,
    reorderThread,
    pinProjectToTop,
    requestBrowserTurnNotificationsPermission,
    startPolling,
    stopPolling,
  }
}
