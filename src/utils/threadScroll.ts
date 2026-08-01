export function shouldForceThreadOpenToBottom(activeThreadId: string, isLoading: boolean): boolean {
  return activeThreadId.trim().length > 0 && !isLoading
}

export function shouldFollowConversationBottom(userHasScrolledAwayFromBottom: boolean): boolean {
  return !userHasScrolledAwayFromBottom
}
