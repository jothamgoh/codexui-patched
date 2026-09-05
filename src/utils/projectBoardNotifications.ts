import type { ProjectBoardSnapshot } from '../types/projectBoards'

export type ProjectBoardNeedsInput = {
  boardId: string
  featureId: string
  cardId: string
  questionId: string
  title: string
  message: string
}

export type ProjectBoardNotification = {
  id: string
  kind: 'question' | 'failed' | 'completed' | 'plan_ready' | 'batch_completed' | 'native_request'
  boardId: string
  featureId: string
  cardId: string
  questionId?: string
  threadId?: string
  queueId?: string
  requestId?: number
  requestKind?: 'approval' | 'question'
  /** Keep the outcome in Activity without a separate device alert. */
  quiet?: boolean
  occurredAt: string
}

export function isProjectBoardNotification(value: unknown): value is ProjectBoardNotification {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return ['question', 'failed', 'completed', 'plan_ready', 'batch_completed', 'native_request'].includes(String(event.kind)) &&
    typeof event.id === 'string' && Boolean(event.id) &&
    typeof event.boardId === 'string' && Boolean(event.boardId) &&
    typeof event.featureId === 'string' && typeof event.cardId === 'string' &&
    typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt)) &&
    (event.questionId === undefined || typeof event.questionId === 'string') &&
    (event.threadId === undefined || typeof event.threadId === 'string') &&
    (event.queueId === undefined || typeof event.queueId === 'string') &&
    (event.requestId === undefined || Number.isInteger(event.requestId)) &&
    (event.requestKind === undefined || event.requestKind === 'approval' || event.requestKind === 'question') &&
    (event.quiet === undefined || typeof event.quiet === 'boolean') &&
    (event.kind !== 'question' || Boolean(event.questionId)) &&
    (event.kind !== 'batch_completed' || Boolean(event.queueId)) &&
    (event.kind !== 'native_request' || (Boolean(event.threadId) && Number.isInteger(event.requestId) && Boolean(event.requestKind)))
}

export function projectBoardNotificationDeepLink(event: Pick<ProjectBoardNotification, 'boardId' | 'featureId' | 'questionId'> & Partial<Pick<ProjectBoardNotification, 'kind' | 'threadId'>>): string {
  const params = new URLSearchParams()
  if ((event.kind === 'completed' || event.kind === 'native_request') && event.threadId) {
    params.set('board', event.boardId)
    if (event.featureId) params.set('feature', event.featureId)
    return `#/thread/${encodeURIComponent(event.threadId)}?${params.toString()}`
  }
  if (event.featureId) params.set('feature', event.featureId)
  if (event.questionId) params.set('question', event.questionId)
  const query = params.toString()
  return `#/board/${encodeURIComponent(event.boardId)}${query ? `?${query}` : ''}`
}

export function projectBoardNotificationCopy(event: Pick<ProjectBoardNotification, 'kind'> & Partial<Pick<ProjectBoardNotification, 'threadId' | 'requestKind'>>): { title: string; body: string } {
  switch (event.kind) {
    case 'question': return { title: 'CodexUI needs your input', body: 'Open the project board to answer a question.' }
    case 'failed': return { title: 'Project work needs attention', body: 'A board run stopped. Open the board to review and continue.' }
    case 'plan_ready': return { title: 'Project plan ready', body: 'Open the board to review the proposed features.' }
    case 'completed': return { title: 'Feature complete', body: event.threadId ? 'Open the Lead chat to review the result.' : 'Open the project board to review the result.' }
    case 'batch_completed': return { title: 'Selected features complete', body: 'Open the project board to review the results.' }
    case 'native_request': return { title: event.requestKind === 'approval' ? 'Lead needs your approval' : 'Lead needs your input', body: 'Open the Lead chat to review the request and continue.' }
  }
}

export function projectBoardNotificationScope(event: Pick<ProjectBoardNotification, 'boardId' | 'featureId'> & Partial<Pick<ProjectBoardNotification, 'kind' | 'queueId'>>): string {
  if (event.kind === 'batch_completed') return `project-board:${event.boardId}:batch:${event.queueId}`
  return `project-board:${event.boardId}:${event.featureId}`
}

/** One event for the selected batch, after its last feature has completed. */
export function projectBoardBatchCompletedNotification(boardId: string, queueId: string, occurredAt: string): ProjectBoardNotification {
  return {
    id: `project-board-batch:${queueId}:completed`,
    kind: 'batch_completed',
    boardId,
    featureId: '',
    cardId: '',
    queueId,
    occurredAt,
  }
}

/** Only the saved feature Lead or board planner may raise a board device alert. */
export function projectBoardNativeRequestNotification(snapshot: ProjectBoardSnapshot, value: unknown, occurredAt: string): ProjectBoardNotification | null {
  if (!value || typeof value !== 'object') return null
  const request = value as Record<string, unknown>
  const params = request.params as Record<string, unknown> | undefined
  const approval = typeof request.method === 'string' && /^item\/(commandExecution|fileChange|permissions)\/requestApproval$/u.test(request.method)
  if (!approval && request.method !== 'item/tool/requestUserInput') return null
  if (!Number.isInteger(request.id) || !params || typeof params.threadId !== 'string' || !params.threadId || typeof params.turnId !== 'string' || !params.turnId) return null
  const feature = snapshot.cards.find((card) => card.type === 'feature' && card.threadId === params.threadId)
  const board = snapshot.boards.find((entry) => feature ? entry.id === feature.boardId : entry.planningThreadId === params.threadId)
  if (!board) return null
  return {
    id: `project-board-native:${params.threadId}:${params.turnId}:${request.id}`,
    kind: 'native_request',
    boardId: board.id,
    featureId: feature?.id || '',
    cardId: feature?.id || '',
    threadId: params.threadId,
    requestId: Number(request.id),
    requestKind: approval ? 'approval' : 'question',
    occurredAt,
  }
}

export function projectBoardNeedsInputDeepLink(attention: ProjectBoardNeedsInput): string {
  return projectBoardNotificationDeepLink(attention)
}

export function markProjectBoardAttentionSeen(seenQuestionIds: Set<string>, questionId: string): boolean {
  if (!questionId || seenQuestionIds.has(questionId)) return false
  seenQuestionIds.add(questionId)
  return true
}

export function openProjectBoardDeepLink(deepLink: string): void {
  if (typeof window === 'undefined') return
  window.focus()
  window.location.hash = deepLink.startsWith('#') ? deepLink.slice(1) : deepLink
}

export function showProjectBoardNotification(
  event: ProjectBoardNotification,
  notifyWhenFocused = false,
): Notification | null {
  if (event.quiet) return null
  if (typeof window === 'undefined' || typeof Notification === 'undefined' || typeof document === 'undefined') return null
  if (Notification.permission !== 'granted') return null
  if (!notifyWhenFocused && document.visibilityState === 'visible' && document.hasFocus()) return null
  const deepLink = projectBoardNotificationDeepLink(event)
  const copy = projectBoardNotificationCopy(event)
  try {
    const notification = new Notification(copy.title, {
      body: copy.body,
      tag: event.id,
      data: { url: deepLink, boardId: event.boardId, featureId: event.featureId, questionId: event.questionId },
    })
    notification.onclick = () => {
      notification.close()
      openProjectBoardDeepLink(deepLink)
    }
    return notification
  } catch {
    return null
  }
}

export function showProjectBoardNeedsInputNotification(
  attention: ProjectBoardNeedsInput,
  deepLink: string,
  notifyWhenFocused: boolean,
): Notification | null {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return null
  if (Notification.permission !== 'granted') return null
  if (!notifyWhenFocused && document.visibilityState === 'visible' && document.hasFocus()) return null

  try {
    const notification = new Notification('CodexUI needs your input', {
      body: 'Open the project board to answer a question.',
      tag: `project-board-question:${attention.questionId}`,
      data: {
        url: deepLink,
        boardId: attention.boardId,
        featureId: attention.featureId,
        questionId: attention.questionId,
      },
    })
    notification.onclick = () => {
      notification.close()
      openProjectBoardDeepLink(deepLink)
    }
    return notification
  } catch {
    return null
  }
}
