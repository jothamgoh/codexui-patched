export function shouldForceThreadOpenToBottom(activeThreadId: string, isLoading: boolean): boolean {
  return activeThreadId.trim().length > 0 && !isLoading
}

export function shouldFollowConversationBottom(userHasScrolledAwayFromBottom: boolean): boolean {
  return !userHasScrolledAwayFromBottom
}

export interface ConversationScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function didScrollAwayFromConversationBottom(
  previous: ConversationScrollMetrics | null,
  current: ConversationScrollMetrics,
): boolean {
  if (!previous) return false
  // Focusing/growing the composer can move scrollTop before ResizeObserver
  // reports the new viewport. That browser adjustment is not a history scroll.
  if (current.clientHeight !== previous.clientHeight) return false
  // While following, the container disables browser anchoring. A shorter row or
  // taller viewport can still clamp scrollTop to the new maximum. Ignore only
  // that correction, so scrolling up during a streaming update still pauses.
  const maxScrollTop = Math.max(0, current.scrollHeight - current.clientHeight)
  const clampedPreviousTop = Math.min(previous.scrollTop, maxScrollTop)
  return Math.max(0, current.scrollTop) < clampedPreviousTop - 2
}
