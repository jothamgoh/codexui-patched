// Verbatim copy of the notification panel's selection logic before it moved to
// src/utils/notificationActivity.ts (NotificationSettingsButton.vue at commit
// 5c131a8, lines 688-901 and its helpers). Used only to prove the shared module
// selects exactly what the panel used to. Do not edit the copied lines.
// @ts-nocheck
import { collectThreadHelpers } from '../../src/utils/threadHelpers'
import { compactNotificationText } from '../../src/utils/notificationText'

type UiThread = any
type RecentActivityItem = any
type RunningActivityItem = any
type WebPushHistoryItem = any
type ProjectBoardNotification = any
type ProjectBoardActivity = any
type PinnedRow = any

const MAX_RECENT_ITEMS = 30
const DEFAULT_RECENT_LIMIT = 6

export function legacyPanelSelection(props, historyItems, dismissed, manualUnread = {}, activityFilterValue = 'all') {
  const computed = (fn) => { let cached; let done = false; return { get value() { if (!done) { cached = fn(); done = true } return cached } } }
  const history = { value: historyItems }
  const dismissedActivityByThreadId = { value: dismissed }
  const manualUnreadByThreadId = { value: manualUnread }
  const fetchedPinnedThreadById = { value: {} }
  const recentLimit = { value: DEFAULT_RECENT_LIMIT }
  const activityFilter = { value: activityFilterValue }

  const threadHelpers = computed(() => collectThreadHelpers(props.threads, props.threadSources ?? {}, props.boardThreadIds ?? []))
  const activityThreads = computed(() => {
    const excluded = new Set([...(props.boardThreadIds ?? []), ...(props.boardActivity ?? []).map((item) => item.threadId).filter(Boolean)])
    return props.threads.filter((thread) => !excluded.has(thread.id) && !threadHelpers.value.childIds.has(thread.id))
  })
  const requestAttention = computed(() => {
    const seen = new Set<string>()
    return (props.pendingRequests ?? []).filter((request) => {
      if (!request.threadId || seen.has(request.threadId)) return false
      const board = props.boardActivity?.find((item) => item.threadId === request.threadId)
      if (board && props.boardAttention.some((item) => item.boardId === board.boardId && item.featureId === board.featureId)) return false
      seen.add(request.threadId)
      return true
    }).map((request) => {
      const board = props.boardActivity?.find((item) => item.threadId === request.threadId || item.threadId === threadHelpers.value.ownerByChildId[request.threadId])
      const thread = props.threads.find((item) => item.id === request.threadId)
      return {
        threadId: request.threadId,
        title: threadHelpers.value.childIds.has(request.threadId) ? (thread ? threadTitle(thread) : 'Helper needs your input') : board?.title || (thread ? threadTitle(thread) : 'Chat needs your input'),
        label: request.method.endsWith('/requestApproval') ? 'Approval needed' : 'Answer needed',
        receivedAtIso: request.receivedAtIso,
        board,
      }
    })
  })
  const waitingThreadIds = computed(() => new Set(requestAttention.value.map((item) => item.threadId)))
  const hasWorkingHelpers = (threadId: string) => threadHelpers.value.helpersByOwnerId[threadId]?.some((helper) => helper.inProgress && !waitingThreadIds.value.has(helper.id)) ?? false
  const needsYouCount = computed(() => props.boardAttention.length + requestAttention.value.length)
  const boardWorkActivity = computed(() => (props.boardActivity ?? []).filter((item) =>
    (['running', 'paused', 'blocked', 'review', 'needs_input'].includes(item.status) || hasWorkingHelpers(item.threadId)) &&
    (item.threadId || item.status === 'running') && !waitingThreadIds.value.has(item.threadId) &&
    !props.boardAttention.some((question) => question.boardId === item.boardId && question.featureId === item.featureId),
  ).sort((left, right) => Number(right.status === 'running') - Number(left.status === 'running') || Date.parse(right.updatedAtIso) - Date.parse(left.updatedAtIso)))
  /** A reply in progress, or Claude background work that outlived its reply. */
  const isThreadRunning = (thread: UiThread) => thread.inProgress || thread.hasBackgroundTasks === true
  const runningThreadIds = computed(() => new Set(props.threads.filter(isThreadRunning).map((thread) => thread.id)))
  const runningThreads = computed(() => activityThreads.value.filter((thread) => (isThreadRunning(thread) || hasWorkingHelpers(thread.id)) && !waitingThreadIds.value.has(thread.id)))
  const runningActivity = computed<RunningActivityItem[]>(() => [
    ...(props.boardActivity ?? []).filter((item) => (item.status === 'running' || hasWorkingHelpers(item.threadId)) && !waitingThreadIds.value.has(item.threadId)).map((item) => ({
      id: `board:${item.boardId}:${item.featureId}`,
      threadId: item.threadId,
      title: item.title,
      updatedAtIso: item.updatedAtIso,
      board: item,
    })),
    ...runningThreads.value.map((thread) => ({
      id: thread.id,
      threadId: thread.id,
      title: threadTitle(thread),
      updatedAtIso: thread.updatedAtIso,
    })),
  ].sort((left, right) => Date.parse(right.updatedAtIso) - Date.parse(left.updatedAtIso)))
  const unreadThreads = computed(() =>
    activityThreads.value.filter((thread) => isThreadUnread(thread) && !isThreadRunning(thread) && !hasWorkingHelpers(thread.id) && !waitingThreadIds.value.has(thread.id)),
  )
  const pinnedThreadIdSet = computed(() => new Set(props.pinnedThreadIds ?? []))
  const pinnedThreads = computed(() => (props.pinnedThreadIds ?? []).flatMap((threadId) => {
    const thread = props.threads.find((candidate) => candidate.id === threadId) ?? fetchedPinnedThreadById.value[threadId]
    return thread ? [thread] : []
  }))
  const listedRunningThreads = computed(() => runningThreads.value.filter((thread) => !pinnedThreadIdSet.value.has(thread.id)))
  const listedUnreadThreads = computed(() => unreadThreads.value.filter((thread) => !pinnedThreadIdSet.value.has(thread.id)))
  const visibleHistory = computed(() => history.value.filter((item) =>
    !threadHelpers.value.childIds.has(item.threadId) &&
    !(props.boardThreadIds ?? []).includes(item.threadId) &&
    !props.boardAttention.some((attention) => attention.questionId === item.projectBoard?.questionId) &&
    !(item.projectBoard?.kind === 'native_request' && props.pendingRequests?.some((request) => request.id === item.projectBoard?.requestId && request.threadId === item.projectBoard?.threadId)),
  ))
  const currentActivityThreadIds = computed(() =>
    new Set([
      ...runningThreads.value.map((thread) => thread.id),
      ...unreadThreads.value.map((thread) => thread.id),
      ...waitingThreadIds.value,
    ]),
  )
  const allRecentHistory = computed<RecentActivityItem[]>(() => {
    const candidates: RecentActivityItem[] = []
    for (const item of visibleHistory.value) {
      if (currentActivityThreadIds.value.has(item.threadId)) continue
      const thread = props.threads.find((candidate) => candidate.id === item.threadId)
      candidates.push({
        id: item.id,
        threadId: item.threadId,
        source: 'history',
        status: item.status,
        title: historyItemTitle(item, thread),
        body: historyItemBody(item),
        completedAt: item.completedAt,
        isUnread: item.readAt === null || Boolean(thread && isThreadUnread(thread)),
        projectBoard: item.projectBoard,
      })
    }
    for (const thread of activityThreads.value) {
      if (currentActivityThreadIds.value.has(thread.id)) continue
      candidates.push({
        id: `thread:${thread.id}`,
        threadId: thread.id,
        source: 'thread',
        status: 'completed',
        title: threadTitle(thread),
        body: normalizeLabel(thread.preview),
        completedAt: thread.updatedAtIso || thread.createdAtIso,
        isUnread: isThreadUnread(thread),
      })
    }
    candidates.sort((left, right) => {
      const leftTimestamp = Date.parse(left.completedAt)
      const rightTimestamp = Date.parse(right.completedAt)
      return (Number.isFinite(rightTimestamp) ? rightTimestamp : 0) -
        (Number.isFinite(leftTimestamp) ? leftTimestamp : 0)
    })
  
    const seen = new Set<string>(pinnedThreadIdSet.value)
    return candidates.filter((item) => {
      if (seen.has(item.threadId)) return false
      seen.add(item.threadId)
      return dismissedActivityByThreadId.value[item.threadId] !== item.completedAt
    }).slice(0, MAX_RECENT_ITEMS)
  })
  const unreadActivity = computed<RecentActivityItem[]>(() => {
    const candidates: RecentActivityItem[] = []
    for (const item of visibleHistory.value) {
      if (item.readAt !== null) continue
      if (waitingThreadIds.value.has(item.threadId) || runningThreadIds.value.has(item.threadId)) continue
      if (dismissedActivityByThreadId.value[item.threadId] === item.completedAt) continue
      const thread = props.threads.find((candidate) => candidate.id === item.threadId)
      candidates.push({
        id: item.id,
        threadId: item.threadId,
        source: 'history',
        status: item.status,
        title: historyItemTitle(item, thread),
        body: historyItemBody(item),
        completedAt: item.completedAt,
        isUnread: true,
        projectBoard: item.projectBoard,
      })
    }
    for (const thread of activityThreads.value) {
      if (!isThreadUnread(thread) || isThreadRunning(thread) || hasWorkingHelpers(thread.id) || waitingThreadIds.value.has(thread.id)) continue
      candidates.push({
        id: `thread:${thread.id}`,
        threadId: thread.id,
        source: 'thread',
        status: 'completed',
        title: threadTitle(thread),
        body: normalizeLabel(thread.preview),
        completedAt: thread.updatedAtIso || thread.createdAtIso,
        isUnread: true,
      })
    }
    candidates.sort((left, right) => {
      const leftTimestamp = Date.parse(left.completedAt)
      const rightTimestamp = Date.parse(right.completedAt)
      return (Number.isFinite(rightTimestamp) ? rightTimestamp : 0) -
        (Number.isFinite(leftTimestamp) ? leftTimestamp : 0)
    })
  
    const seen = new Set<string>()
    return candidates.filter((item) => {
      if (seen.has(item.threadId)) return false
      seen.add(item.threadId)
      return true
    })
  })
  const pinnedRows = computed<PinnedRow[]>(() => {
    const unreadIds = new Set(unreadActivity.value.map((item) => item.threadId))
    return pinnedThreads.value.map((thread) => {
      const latest = visibleHistory.value.reduce<WebPushHistoryItem | undefined>((best, item) =>
        item.threadId === thread.id && (!best || Date.parse(item.completedAt) > Date.parse(best.completedAt)) ? item : best, undefined)
      const isUnread = unreadIds.has(thread.id) || isThreadUnread(thread)
      const activityAt = thread.updatedAtIso || thread.createdAtIso
      const row = { threadId: thread.id, title: threadTitle(thread), activityAt, pill: isUnread ? 'Unread' : '' }
      if (waitingThreadIds.value.has(thread.id)) return { ...row, tone: 'failed', statusLabel: 'Waiting for you', pill: 'Needs you' }
      if (isThreadRunning(thread) || hasWorkingHelpers(thread.id)) return { ...row, tone: 'running', statusLabel: 'In progress', pill: '' }
      if (latest && ['failed', 'question', 'native_request'].includes(latest.status)) {
        return { ...row, tone: 'failed', activityAt: latest.completedAt, statusLabel: activityStatusLabel({ status: latest.status, projectBoard: latest.projectBoard }) }
      }
      return { ...row, tone: isUnread ? 'unread' : 'pinned', statusLabel: isUnread ? 'Completed — not opened' : 'Pinned' }
    })
  })
  const recentHistory = computed(() => allRecentHistory.value.slice(0, recentLimit.value))
  const visibleRecentHistory = computed(() =>
    activityFilter.value === 'unread' ? unreadActivity.value : recentHistory.value,
  )
  const shortcutThreadIds = computed(() => [...new Set(
    activityFilter.value === 'unread'
      ? unreadActivity.value.map((item) => item.threadId)
      : [
        ...pinnedRows.value.map((row) => row.threadId),
        ...runningActivity.value.map((item) => item.id),
        ...unreadThreads.value.map((thread) => thread.id),
        ...recentHistory.value.map((item) => item.threadId),
      ],
  )].slice(0, 9))
  const hiddenRecentCount = computed(() =>
    Math.max(0, allRecentHistory.value.length - DEFAULT_RECENT_LIMIT),
  )
  const canToggleRecentLimit = computed(() =>
    activityFilter.value === 'all' && allRecentHistory.value.length > DEFAULT_RECENT_LIMIT,
  )
  const unreadAttentionCount = computed(() => unreadActivity.value.length)
  const totalAttentionCount = computed(() => unreadAttentionCount.value + needsYouCount.value)
  const hasUnreadActivity = computed(() => unreadActivity.value.length > 0)
  const hasActivity = computed(() =>
    pinnedRows.value.length > 0 ||
    boardWorkActivity.value.length > 0 ||
    runningActivity.value.length > 0 ||
    unreadThreads.value.length > 0 ||
    recentHistory.value.length > 0,
  )
  const hasVisibleActivity = computed(() =>
    needsYouCount.value > 0 || (activityFilter.value === 'unread' ? hasUnreadActivity.value : hasActivity.value),
  )

  function activityStatusLabel(item: Pick<RecentActivityItem, 'status' | 'projectBoard'>): string {
    if (item.status === 'failed') return 'Needs attention'
    if (item.status === 'question') return 'Question'
    if (item.status === 'answered') return 'Answered'
    if (item.status === 'plan_ready') return 'Plan ready'
    if (item.status === 'batch_completed') return 'Selected features complete'
    if (item.status === 'resolved') return 'Resolved'
    if (item.status === 'native_request') return item.projectBoard?.requestKind === 'approval' ? 'Approval needed' : 'Answer needed'
    return item.projectBoard ? 'Feature complete' : 'Completed'
  }
  
  function boardItemForEvent(event: ProjectBoardNotification): ProjectBoardActivity | undefined {
    return props.boardActivity?.find((item) => item.boardId === event.boardId && item.featureId === event.featureId)
  }
  
  function historyItemBody(item: WebPushHistoryItem): string {
    const activity = item.projectBoard && boardItemForEvent(item.projectBoard)
    if (item.status === 'failed' && activity?.summary) return compactNotificationText(`${activity.summary} Open the feature to review and continue.`, '', 220)
    if (item.projectBoard?.kind === 'completed' && (item.projectBoard.threadId || activity?.threadId)) return 'Open the Lead chat to review the result.'
    return compactNotificationText(item.body, '', 220)
  }
  
  function historyItemTitle(item: WebPushHistoryItem, thread?: UiThread): string {
    if (item.projectBoard) {
      const targetId = item.projectBoard.featureId || item.projectBoard.boardId
      return normalizeLabel(props.boardActivityTitles?.[targetId] || item.title)
    }
    return thread ? threadTitle(thread) : (normalizeLabel(item.title) || `Chat ${item.threadId.slice(0, 8)}`)
  }

  function isThreadUnread(thread: UiThread): boolean {
    const override = manualUnreadByThreadId.value[thread.id]
    if (override && override.activityAt === thread.updatedAtIso) return override.unread
    return thread.unread
  }
  
  function threadTitle(thread: UiThread): string {
    return normalizeLabel(thread.title) || normalizeLabel(thread.preview) || `Chat ${thread.id.slice(0, 8)}`
  }
  
  function normalizeLabel(value: string): string {
    return value.replace(/\s+/gu, ' ').trim()
  }

  return {
    activityThreadIds: activityThreads.value.map((thread) => thread.id),
    requestAttention: requestAttention.value,
    waitingThreadIds: [...waitingThreadIds.value],
    boardWorkActivity: boardWorkActivity.value,
    runningThreadIds: [...runningThreadIds.value],
    runningThreads: runningThreads.value.map((thread) => thread.id),
    runningActivity: runningActivity.value,
    unreadThreads: unreadThreads.value.map((thread) => thread.id),
    visibleHistory: visibleHistory.value.map((item) => item.id),
    allRecentHistory: allRecentHistory.value,
    unreadActivity: unreadActivity.value,
    shortcutThreadIds: shortcutThreadIds.value,
    hiddenRecentCount: hiddenRecentCount.value,
    hasActivity: hasActivity.value,
    needsYouCount: needsYouCount.value,
    unreadAttentionCount: unreadAttentionCount.value,
    pinnedRows: pinnedRows.value,
  }
}
