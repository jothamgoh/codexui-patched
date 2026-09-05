export type ProjectBoardNeedsInput = {
  boardId: string
  featureId: string
  cardId: string
  questionId: string
  title: string
  message: string
}

export function projectBoardNeedsInputDeepLink(attention: ProjectBoardNeedsInput): string {
  const params = new URLSearchParams({
    feature: attention.featureId,
    question: attention.questionId,
  })
  return `#/board/${encodeURIComponent(attention.boardId)}?${params.toString()}`
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
