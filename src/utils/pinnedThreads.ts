export type SetThreadPinnedIntent = {
  threadId: string
  pinned: boolean
  beforeThreadId?: string
}

export function normalizePinnedThreadIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const threadIds: string[] = []
  for (const item of value) {
    const threadId = typeof item === 'string' ? item.trim() : ''
    if (!threadId || threadIds.includes(threadId)) continue
    threadIds.push(threadId)
  }
  return threadIds
}

export function hasSamePinnedThreadMembership(left: unknown, right: unknown): boolean {
  const leftIds = normalizePinnedThreadIds(left)
  const rightIds = normalizePinnedThreadIds(right)
  if (leftIds.length !== rightIds.length) return false
  const rightSet = new Set(rightIds)
  return leftIds.every((threadId) => rightSet.has(threadId))
}

export function applyPinnedThreadIntent(
  currentThreadIds: string[],
  intent: SetThreadPinnedIntent,
): string[] {
  const current = normalizePinnedThreadIds(currentThreadIds)
  const threadId = intent.threadId.trim()
  if (!threadId) return current

  const withoutThread = current.filter((id) => id !== threadId)
  if (!intent.pinned) return withoutThread

  const beforeIndex = intent.beforeThreadId
    ? withoutThread.indexOf(intent.beforeThreadId)
    : 0
  withoutThread.splice(beforeIndex >= 0 ? beforeIndex : 0, 0, threadId)
  return withoutThread
}
