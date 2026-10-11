import type { WebPushHistoryItem } from '../api/webPush'
import type { UiServerRequest, UiThread } from '../types/codex'
import { compactNotificationText } from './notificationText'
import type { ProjectBoardActivity } from './projectBoardActivity'
import type { ProjectBoardNotification } from './projectBoardNotifications'
import { collectThreadHelpers, type ThreadSourceMap } from './threadHelpers'

/**
 * Which chats the notification panel shows, and in which section. The panel and
 * the voice command route both call this, so a spoken "what's unread" lists
 * exactly the chats the panel lists.
 */

export const MAX_RECENT_ACTIVITY_ITEMS = 30

export type BoardAttentionItem = {
  questionId: string
  boardId: string
  featureId: string
  title: string
  prompt: string
  createdAtIso: string
}

export type NotificationActivityInput = {
  threads: UiThread[]
  threadSources?: ThreadSourceMap
  boardThreadIds?: string[]
  boardActivity?: ProjectBoardActivity[]
  boardActivityTitles?: Record<string, string>
  boardAttention: BoardAttentionItem[]
  pendingRequests?: Array<Pick<UiServerRequest, 'id' | 'method' | 'threadId' | 'receivedAtIso'>>
  history: WebPushHistoryItem[]
  /** Thread id -> the activity time the user dismissed. */
  dismissedActivityByThreadId: Record<string, string>
  /** Pinned chats have their own panel section, so Recent leaves them out. */
  pinnedThreadIds?: string[]
  /** Defaults to `thread.unread`; the panel layers its manual overrides on top. */
  isThreadUnread?: (thread: UiThread) => boolean
}

export type RequestAttentionItem = {
  threadId: string
  title: string
  label: 'Approval needed' | 'Answer needed'
  receivedAtIso: string
  board?: ProjectBoardActivity
}

export type RunningActivityItem = {
  id: string
  threadId: string
  title: string
  updatedAtIso: string
  board?: ProjectBoardActivity
}

export type RecentActivityItem = {
  id: string
  threadId: string
  source: 'history' | 'thread'
  status: string
  title: string
  body: string
  completedAt: string
  isUnread: boolean
  projectBoard?: ProjectBoardNotification
}

export type NotificationActivity = {
  threadHelpers: ReturnType<typeof collectThreadHelpers>
  /** Chats the panel may list: no helper sub-chats and no project-board chats. */
  activityThreads: UiThread[]
  requestAttention: RequestAttentionItem[]
  waitingThreadIds: Set<string>
  boardWorkActivity: ProjectBoardActivity[]
  runningThreadIds: Set<string>
  runningThreads: UiThread[]
  runningActivity: RunningActivityItem[]
  unreadThreads: UiThread[]
  visibleHistory: WebPushHistoryItem[]
  /** Newest first, one row per chat, at most MAX_RECENT_ACTIVITY_ITEMS. */
  allRecentHistory: RecentActivityItem[]
  unreadActivity: RecentActivityItem[]
  hasWorkingHelpers: (threadId: string) => boolean
}

export function normalizeActivityLabel(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function activityThreadTitle(thread: UiThread): string {
  return normalizeActivityLabel(thread.title) || normalizeActivityLabel(thread.preview) || `Chat ${thread.id.slice(0, 8)}`
}

/** A reply in progress, or Claude background work that outlived its reply. */
export function isThreadRunning(thread: UiThread): boolean {
  return thread.inProgress || thread.hasBackgroundTasks === true
}

function timestampOrZero(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function newestFirst(left: RecentActivityItem, right: RecentActivityItem): number {
  return timestampOrZero(right.completedAt) - timestampOrZero(left.completedAt)
}

export function selectNotificationActivity(input: NotificationActivityInput): NotificationActivity {
  const {
    threads,
    boardAttention,
    history,
    dismissedActivityByThreadId,
  } = input
  const boardThreadIds = input.boardThreadIds ?? []
  const boardActivity = input.boardActivity ?? []
  const pendingRequests = input.pendingRequests ?? []
  const isThreadUnread = input.isThreadUnread ?? ((thread: UiThread) => thread.unread)

  const threadHelpers = collectThreadHelpers(threads, input.threadSources ?? {}, boardThreadIds)
  const excluded = new Set([...boardThreadIds, ...boardActivity.map((item) => item.threadId).filter(Boolean)])
  const activityThreads = threads.filter((thread) => !excluded.has(thread.id) && !threadHelpers.childIds.has(thread.id))

  const historyItemBody = (item: WebPushHistoryItem): string => {
    const activity = item.projectBoard && boardActivity.find((entry) => entry.boardId === item.projectBoard?.boardId && entry.featureId === item.projectBoard?.featureId)
    if (item.status === 'failed' && activity?.summary) return compactNotificationText(`${activity.summary} Open the feature to review and continue.`, '', 220)
    if (item.projectBoard?.kind === 'completed' && (item.projectBoard.threadId || activity?.threadId)) return 'Open the Lead chat to review the result.'
    return compactNotificationText(item.body, '', 220)
  }
  const historyItemTitle = (item: WebPushHistoryItem, thread?: UiThread): string => {
    if (item.projectBoard) {
      const targetId = item.projectBoard.featureId || item.projectBoard.boardId
      return normalizeActivityLabel(input.boardActivityTitles?.[targetId] || item.title)
    }
    return thread ? activityThreadTitle(thread) : (normalizeActivityLabel(item.title) || `Chat ${item.threadId.slice(0, 8)}`)
  }

  const seenRequestThreads = new Set<string>()
  const requestAttention: RequestAttentionItem[] = pendingRequests.filter((request) => {
    if (!request.threadId || seenRequestThreads.has(request.threadId)) return false
    const board = boardActivity.find((item) => item.threadId === request.threadId)
    if (board && boardAttention.some((item) => item.boardId === board.boardId && item.featureId === board.featureId)) return false
    seenRequestThreads.add(request.threadId)
    return true
  }).map((request) => {
    const board = boardActivity.find((item) => item.threadId === request.threadId || item.threadId === threadHelpers.ownerByChildId[request.threadId])
    const thread = threads.find((item) => item.id === request.threadId)
    return {
      threadId: request.threadId,
      title: threadHelpers.childIds.has(request.threadId) ? (thread ? activityThreadTitle(thread) : 'Helper needs your input') : board?.title || (thread ? activityThreadTitle(thread) : 'Chat needs your input'),
      label: request.method.endsWith('/requestApproval') ? 'Approval needed' : 'Answer needed',
      receivedAtIso: request.receivedAtIso,
      board,
    }
  })
  const waitingThreadIds = new Set(requestAttention.map((item) => item.threadId))
  const hasWorkingHelpers = (threadId: string) =>
    threadHelpers.helpersByOwnerId[threadId]?.some((helper) => helper.inProgress && !waitingThreadIds.has(helper.id)) ?? false

  const boardWorkActivity = boardActivity.filter((item) =>
    (['running', 'paused', 'blocked', 'review', 'needs_input'].includes(item.status) || hasWorkingHelpers(item.threadId)) &&
    (item.threadId || item.status === 'running') && !waitingThreadIds.has(item.threadId) &&
    !boardAttention.some((question) => question.boardId === item.boardId && question.featureId === item.featureId),
  ).sort((left, right) => Number(right.status === 'running') - Number(left.status === 'running') || Date.parse(right.updatedAtIso) - Date.parse(left.updatedAtIso))

  const runningThreadIds = new Set(threads.filter(isThreadRunning).map((thread) => thread.id))
  const runningThreads = activityThreads.filter((thread) => (isThreadRunning(thread) || hasWorkingHelpers(thread.id)) && !waitingThreadIds.has(thread.id))
  const runningActivity: RunningActivityItem[] = [
    ...boardActivity.filter((item) => (item.status === 'running' || hasWorkingHelpers(item.threadId)) && !waitingThreadIds.has(item.threadId)).map((item) => ({
      id: `board:${item.boardId}:${item.featureId}`,
      threadId: item.threadId,
      title: item.title,
      updatedAtIso: item.updatedAtIso,
      board: item,
    })),
    ...runningThreads.map((thread) => ({
      id: thread.id,
      threadId: thread.id,
      title: activityThreadTitle(thread),
      updatedAtIso: thread.updatedAtIso,
    })),
  ].sort((left, right) => Date.parse(right.updatedAtIso) - Date.parse(left.updatedAtIso))

  const unreadThreads = activityThreads.filter((thread) =>
    isThreadUnread(thread) && !isThreadRunning(thread) && !hasWorkingHelpers(thread.id) && !waitingThreadIds.has(thread.id))

  const visibleHistory = history.filter((item) =>
    !threadHelpers.childIds.has(item.threadId) &&
    !boardThreadIds.includes(item.threadId) &&
    !boardAttention.some((attention) => attention.questionId === item.projectBoard?.questionId) &&
    !(item.projectBoard?.kind === 'native_request' && pendingRequests.some((request) => request.id === item.projectBoard?.requestId && request.threadId === item.projectBoard?.threadId)),
  )
  const currentActivityThreadIds = new Set([
    ...runningThreads.map((thread) => thread.id),
    ...unreadThreads.map((thread) => thread.id),
    ...waitingThreadIds,
  ])

  const recentCandidates: RecentActivityItem[] = []
  for (const item of visibleHistory) {
    if (currentActivityThreadIds.has(item.threadId)) continue
    const thread = threads.find((candidate) => candidate.id === item.threadId)
    recentCandidates.push({
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
  for (const thread of activityThreads) {
    if (currentActivityThreadIds.has(thread.id)) continue
    recentCandidates.push({
      id: `thread:${thread.id}`,
      threadId: thread.id,
      source: 'thread',
      status: 'completed',
      title: activityThreadTitle(thread),
      body: normalizeActivityLabel(thread.preview),
      completedAt: thread.updatedAtIso || thread.createdAtIso,
      isUnread: isThreadUnread(thread),
    })
  }
  recentCandidates.sort(newestFirst)
  const seenRecent = new Set<string>(input.pinnedThreadIds ?? [])
  const allRecentHistory = recentCandidates.filter((item) => {
    if (seenRecent.has(item.threadId)) return false
    seenRecent.add(item.threadId)
    return dismissedActivityByThreadId[item.threadId] !== item.completedAt
  }).slice(0, MAX_RECENT_ACTIVITY_ITEMS)

  const unreadCandidates: RecentActivityItem[] = []
  for (const item of visibleHistory) {
    if (item.readAt !== null) continue
    if (waitingThreadIds.has(item.threadId) || runningThreadIds.has(item.threadId)) continue
    if (dismissedActivityByThreadId[item.threadId] === item.completedAt) continue
    const thread = threads.find((candidate) => candidate.id === item.threadId)
    unreadCandidates.push({
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
  for (const thread of activityThreads) {
    if (!isThreadUnread(thread) || isThreadRunning(thread) || hasWorkingHelpers(thread.id) || waitingThreadIds.has(thread.id)) continue
    unreadCandidates.push({
      id: `thread:${thread.id}`,
      threadId: thread.id,
      source: 'thread',
      status: 'completed',
      title: activityThreadTitle(thread),
      body: normalizeActivityLabel(thread.preview),
      completedAt: thread.updatedAtIso || thread.createdAtIso,
      isUnread: true,
    })
  }
  unreadCandidates.sort(newestFirst)
  const seenUnread = new Set<string>()
  const unreadActivity = unreadCandidates.filter((item) => {
    if (seenUnread.has(item.threadId)) return false
    seenUnread.add(item.threadId)
    return true
  })

  return {
    threadHelpers,
    activityThreads,
    requestAttention,
    waitingThreadIds,
    boardWorkActivity,
    runningThreadIds,
    runningThreads,
    runningActivity,
    unreadThreads,
    visibleHistory,
    allRecentHistory,
    unreadActivity,
    hasWorkingHelpers,
  }
}
