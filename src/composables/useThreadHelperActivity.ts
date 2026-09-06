import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { getThreadSummary } from '../api/codexGateway'
import { rpcCall, subscribeInPageRpcNotifications } from '../api/codexRpcClient'
import { normalizeThreadV2 } from '../api/normalizers/v2'
import type { Thread, ThreadListResponse } from '../api/appServerDtos'
import type { UiThread, UiThreadSource } from '../types/codex'

/** Activity needs descendant summaries: the normal sidebar catalog excludes them. */
export function useThreadHelperActivity(
  catalog: Ref<UiThread[]>, sources: Ref<Record<string, UiThreadSource>>,
  leadIds: Ref<string[]>, selectedId: Ref<string>,
) {
  const extra = ref<Record<string, UiThread>>({})
  const loading = ref(false)
  const error = ref('')
  const liveStatus = new Map<string, { version: number; inProgress: boolean; runtimeStatus: UiThread['runtimeStatus'] }>()
  let version = 0
  const parentReads = new Map<string, Promise<UiThread>>()
  let disposed = false
  const threads = computed(() => {
    const merged = new Map(catalog.value.map((thread) => [thread.id, thread]))
    for (const thread of Object.values(extra.value)) {
      const listed = merged.get(thread.id)
      merged.set(thread.id, listed && !thread.isInternalSubagent && !thread.parentThreadId ? listed : { ...listed, ...thread })
    }
    return [...merged.values()]
  })
  const remember = (thread: UiThread, readVersion = version) => {
    const live = liveStatus.get(thread.id)
    const status = live && live.version > readVersion ? { inProgress: live.inProgress, runtimeStatus: live.runtimeStatus } : {}
    if (!disposed) extra.value = { ...extra.value, [thread.id]: { ...thread, ...status, ...(thread.isInternalSubagent || thread.parentThreadId ? { unread: false } : {}) } }
  }
  async function readParent(id: string) {
    let pending = parentReads.get(id)
    if (!pending) {
      const readVersion = version
      pending = getThreadSummary(id).then((thread) => { remember(thread, readVersion); return thread })
      parentReads.set(id, pending)
    }
    try { return await pending } finally { parentReads.delete(id) }
  }
  async function resolveAncestors(ids: string[]) {
    const results = await Promise.allSettled([...new Set(ids)].map(async (id) => {
      const seen = new Set<string>()
      while (id && !seen.has(id) && seen.size < 32 && !disposed) {
        seen.add(id)
        let thread = threads.value.find((value) => value.id === id)
        if (!thread && !leadIds.value.includes(id)) {
          thread = await readParent(id)
        }
        if (leadIds.value.includes(id)) return
        id = sources.value[id]?.parentThreadId || thread?.parentThreadId || ''
      }
    }))
    if (results.some((result) => result.status === 'rejected')) throw new Error('Could not load a helper’s parent chat.')
  }
  async function refresh(rootIds: string[], attentionIds: string[]) {
    if (loading.value) return
    loading.value = true
    error.value = ''
    try {
      // No transcript reads, polling, or eager expansion of all historical chats.
      const rootReads = [...new Set(rootIds.filter(Boolean))].map(async (ancestorThreadId) => {
        const cursors = new Set<string>()
        let cursor: string | null = null
        do {
          const readVersion = version
          const response: ThreadListResponse = await rpcCall('thread/list', {
            ancestorThreadId, sourceKinds: ['subAgentThreadSpawn'], archived: false, limit: 100, cursor,
          })
          for (const item of response.data) remember(normalizeThreadV2(item), readVersion)
          cursor = response.nextCursor
          if (cursor && cursors.has(cursor)) throw new Error('Repeated helper page')
          if (cursor) cursors.add(cursor)
        } while (cursor && !disposed)
      })
      // An ordinary parent may be idle while descendants continue after reload.
      // Discover recent running helpers without listing every historical parent.
      const discovery = async () => {
        const readVersion = version
        const response: ThreadListResponse = await rpcCall('thread/list', {
          sourceKinds: ['subAgentThreadSpawn'], archived: false, limit: 100, sortKey: 'updated_at',
        })
        for (const item of response.data) {
          const thread = normalizeThreadV2(item)
          if (thread.inProgress) remember(thread, readVersion)
        }
      }
      const results = await Promise.allSettled([...rootReads, discovery()])
      await resolveAncestors([...attentionIds, ...threads.value.filter((thread) => thread.parentThreadId).map((thread) => thread.id)])
      if (results.some((result) => result.status === 'rejected')) throw new Error('Could not load helpers.')
    } catch {
      error.value = 'Some helper activity could not be loaded.'
    } finally { loading.value = false }
  }
  const unsubscribe = subscribeInPageRpcNotifications(({ method, params }) => {
    if (!params || typeof params !== 'object') return
    const payload = params as Record<string, unknown>
    if (method === 'thread/started' && payload.thread && typeof payload.thread === 'object') {
      const thread = normalizeThreadV2(payload.thread as Thread)
      if (thread.isInternalSubagent || thread.parentThreadId) remember(thread)
      return
    }
    const id = String(payload.threadId || payload.thread_id || '')
    const status = method === 'thread/status/changed' ? (payload.status as { type?: UiThread['runtimeStatus'] })?.type
      : method === 'turn/started' ? 'active' : method === 'turn/completed' ? 'idle' : undefined
    if (!id || !status) return
    liveStatus.set(id, { version: ++version, inProgress: status === 'active', runtimeStatus: status })
    if (extra.value[id]) remember(extra.value[id], -1)
  })
  watch(() => [selectedId.value, sources.value[selectedId.value]?.parentThreadId], () => {
    if (!sources.value[selectedId.value]?.parentThreadId) return
    void resolveAncestors([selectedId.value]).catch(() => { error.value = 'The helper’s parent chat could not be loaded.' })
  }, { immediate: true })
  onScopeDispose(() => { disposed = true; unsubscribe() })
  return { threads, loading, error, refresh }
}
