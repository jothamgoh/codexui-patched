import type { UiThread } from '../types/codex'

export type ThreadSourceMap = Record<string, { isInternalSubagent?: boolean; parentThreadId?: string | null }>

/** Use native ownership, never names or shared folders, to group descendants. */
export function collectThreadHelpers(threads: UiThread[], sources: ThreadSourceMap, leadThreadIds: string[]) {
  const metadata: ThreadSourceMap = Object.fromEntries(threads.map((thread) => [thread.id, thread]))
  for (const [id, source] of Object.entries(sources)) metadata[id] = { ...metadata[id], ...source }
  const leads = new Set(leadThreadIds)
  const childIds = new Set(Object.keys(metadata).filter((id) => metadata[id]?.isInternalSubagent || metadata[id]?.parentThreadId))
  const ownerByChildId: Record<string, string> = {}
  for (const childId of childIds) {
    if (leads.has(childId)) continue
    let parentId = metadata[childId]?.parentThreadId
    const visited = new Set([childId])
    while (parentId && !visited.has(parentId) && visited.size <= 32) {
      visited.add(parentId)
      if (leads.has(parentId) || (metadata[parentId] && !childIds.has(parentId))) {
        ownerByChildId[childId] = parentId
        break
      }
      parentId = metadata[parentId]?.parentThreadId
    }
  }
  const helpersByOwnerId: Record<string, UiThread[]> = {}
  for (const thread of threads) {
    const ownerId = ownerByChildId[thread.id]
    if (!ownerId) continue
    ;(helpersByOwnerId[ownerId] ??= []).push(thread)
  }
  // A board-managed Lead is a user-facing job even if native ancestry exists.
  for (const id of leads) childIds.delete(id)
  return { childIds, ownerByChildId, helpersByOwnerId }
}
