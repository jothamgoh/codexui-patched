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
  kind: 'question' | 'failed' | 'completed' | 'plan_ready'
  boardId: string
  featureId: string
  cardId: string
  questionId?: string
  occurredAt: string
}

export function isProjectBoardNotification(value: unknown): value is ProjectBoardNotification {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return ['question', 'failed', 'completed', 'plan_ready'].includes(String(event.kind)) &&
    typeof event.id === 'string' && Boolean(event.id) &&
    typeof event.boardId === 'string' && Boolean(event.boardId) &&
    typeof event.featureId === 'string' && typeof event.cardId === 'string' &&
    typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt)) &&
    (event.questionId === undefined || typeof event.questionId === 'string') &&
    (event.kind !== 'question' || Boolean(event.questionId))
}

export function projectBoardNotificationDeepLink(event: Pick<ProjectBoardNotification, 'boardId' | 'featureId' | 'questionId'>): string {
  const params = new URLSearchParams()
  if (event.featureId) params.set('feature', event.featureId)
  if (event.questionId) params.set('question', event.questionId)
  const query = params.toString()
  return `#/board/${encodeURIComponent(event.boardId)}${query ? `?${query}` : ''}`
}

export function projectBoardNotificationCopy(event: Pick<ProjectBoardNotification, 'kind'>): { title: string; body: string } {
  switch (event.kind) {
    case 'question': return { title: 'CodexUI needs your input', body: 'Open the project board to answer a question.' }
    case 'failed': return { title: 'Project work needs attention', body: 'A board run stopped. Open the board to review and continue.' }
    case 'plan_ready': return { title: 'Project plan ready', body: 'Open the board to review the proposed features.' }
    case 'completed': return { title: 'Feature complete', body: 'Open the project board to review the result.' }
  }
}

export function projectBoardNotificationScope(event: Pick<ProjectBoardNotification, 'boardId' | 'featureId'>): string {
  return `project-board:${event.boardId}:${event.featureId}`
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
