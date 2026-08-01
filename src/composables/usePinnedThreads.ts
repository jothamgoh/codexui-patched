import { ref } from 'vue'
import {
  getPinnedThreadIds,
  setPinnedThreadIds,
  setThreadPinned,
  subscribeCodexInPageNotifications,
} from '../api/codexGateway'
import {
  applyPinnedThreadIntent,
  normalizePinnedThreadIds,
  type SetThreadPinnedIntent,
} from '../utils/pinnedThreads'

const PINNED_THREAD_IDS_STORAGE_KEY = 'codex-web-local.pinned-thread-ids.v1'
const LEGACY_PINNED_THREAD_IDS_PENDING_STORAGE_KEY = 'codex-web-local.pinned-thread-ids.pending.v1'
const PINNED_THREADS_CHANNEL_NAME = 'codexui-pinned-threads.v1'

export type { SetThreadPinnedIntent } from '../utils/pinnedThreads'

function loadPinnedThreadIdsFromStorage(storageKey: string): string[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey)
    return raw === null ? null : normalizePinnedThreadIds(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export function usePinnedThreads() {
  const pinnedThreadIds = ref<string[]>(
    loadPinnedThreadIdsFromStorage(PINNED_THREAD_IDS_STORAGE_KEY) ?? [],
  )
  let mutationRevision = 0
  let mutationQueue: Promise<void> = Promise.resolve()
  let pendingMutationCount = 0
  let isDisposed = false

  if (typeof window !== 'undefined') {
    // Full-list recovery could overwrite newer changes made on another device.
    window.localStorage.removeItem(LEGACY_PINNED_THREAD_IDS_PENDING_STORAGE_KEY)
  }

  const channel =
    typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(PINNED_THREADS_CHANNEL_NAME)
      : null

  function publish(threadIds: string[], broadcast = false): void {
    const normalized = normalizePinnedThreadIds(threadIds)
    pinnedThreadIds.value = normalized
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PINNED_THREAD_IDS_STORAGE_KEY, JSON.stringify(normalized))
    }
    if (broadcast) {
      channel?.postMessage({ threadIds: normalized })
    }
  }

  function enqueueMutation(operation: () => Promise<string[]>): void {
    const revision = ++mutationRevision
    pendingMutationCount += 1
    const queuedOperation = mutationQueue
      .catch(() => undefined)
      .then(operation)
      .then((serverThreadIds) => {
        if (revision === mutationRevision) {
          publish(serverThreadIds, true)
        }
      })
      .catch(() => {
        if (revision !== mutationRevision || isDisposed) return
        queueMicrotask(() => {
          void refreshPinnedThreads()
        })
      })
      .finally(() => {
        pendingMutationCount = Math.max(0, pendingMutationCount - 1)
      })

    mutationQueue = queuedOperation
  }

  function updatePinnedThread(intent: SetThreadPinnedIntent): void {
    const normalizedIntent = {
      ...intent,
      threadId: intent.threadId.trim(),
      beforeThreadId: intent.beforeThreadId?.trim() || undefined,
    }
    if (!normalizedIntent.threadId) return

    const nextThreadIds = applyPinnedThreadIntent(pinnedThreadIds.value, normalizedIntent)
    publish(nextThreadIds)
    enqueueMutation(() => setThreadPinned(normalizedIntent))
  }

  function reorderPinnedThreads(threadIds: string[]): void {
    const nextThreadIds = normalizePinnedThreadIds(threadIds)
    publish(nextThreadIds)
    enqueueMutation(() => setPinnedThreadIds(nextThreadIds))
  }

  async function refreshPinnedThreads(): Promise<void> {
    await mutationQueue.catch(() => undefined)
    if (isDisposed) return

    const revisionAtStart = mutationRevision
    try {
      const serverThreadIds = await getPinnedThreadIds()
      if (revisionAtStart !== mutationRevision || isDisposed) return
      publish(serverThreadIds)
    } catch {
      // Browser storage remains the startup fallback while the bridge is unavailable.
    }
  }

  function onChannelMessage(event: MessageEvent<unknown>): void {
    if (!event.data || typeof event.data !== 'object') return
    const rawThreadIds = (event.data as { threadIds?: unknown }).threadIds
    if (!Array.isArray(rawThreadIds)) return
    const threadIds = normalizePinnedThreadIds(rawThreadIds)
    if (pendingMutationCount > 0) return
    publish(threadIds)
  }

  const unsubscribeNotifications = subscribeCodexInPageNotifications((notification) => {
    if (notification.method !== 'codexui/pinnedThreads/updated') return
    if (!notification.params || typeof notification.params !== 'object') return
    const rawThreadIds = (notification.params as { threadIds?: unknown }).threadIds
    if (!Array.isArray(rawThreadIds)) return
    if (pendingMutationCount > 0) return
    publish(normalizePinnedThreadIds(rawThreadIds))
  })

  channel?.addEventListener('message', onChannelMessage)

  function dispose(): void {
    isDisposed = true
    unsubscribeNotifications()
    channel?.removeEventListener('message', onChannelMessage)
    channel?.close()
  }

  return {
    pinnedThreadIds,
    refreshPinnedThreads,
    reorderPinnedThreads,
    updatePinnedThread,
    dispose,
  }
}
