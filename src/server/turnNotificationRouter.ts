import {
  CodexThreadAudienceTracker,
  loadInternalSubagentThreadIds,
  readCodexNotificationThreadId,
  resolveCodexThreadAudience,
  type CodexThreadAudience,
} from '../utils/codexThreadSource.js'

type BridgeNotification = {
  method: string
  params: unknown
  atIso: string
}

type NotificationBridge = {
  listThreads: (params: Record<string, unknown>) => Promise<unknown>
  readThread: (threadId: string) => Promise<unknown>
  subscribeNotifications: (listener: (notification: BridgeNotification) => void) => () => void
}

type TurnNotificationSink = {
  handleNotification: (notification: BridgeNotification) => void
}

type WebPushNotificationSink = TurnNotificationSink & {
  removeThreadHistory: (threadIds: Iterable<string>) => Promise<void>
}

export type TurnNotificationRouter = {
  dispose: () => void
}

type TurnNotificationRouterOptions = {
  bridge: NotificationBridge
  telegramTurnNotifier: TurnNotificationSink
  webPushTurnNotifier: WebPushNotificationSink
  threadLookupTimeoutMs?: number
  backfillRequestTimeoutMs?: number
}

const DEFAULT_THREAD_LOOKUP_TIMEOUT_MS = 4_000
const DEFAULT_BACKFILL_REQUEST_TIMEOUT_MS = 5_000

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
    timeout.unref?.()
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function createTurnNotificationRouter(
  options: TurnNotificationRouterOptions,
): TurnNotificationRouter {
  const tracker = new CodexThreadAudienceTracker()
  const pendingAudienceLookups = new Map<string, Promise<CodexThreadAudience>>()
  const threadLookupTimeoutMs = options.threadLookupTimeoutMs ?? DEFAULT_THREAD_LOOKUP_TIMEOUT_MS
  const backfillRequestTimeoutMs = options.backfillRequestTimeoutMs ?? DEFAULT_BACKFILL_REQUEST_TIMEOUT_MS
  let disposed = false

  const removeInternalHistory = (threadIds: Iterable<string>): void => {
    void options.webPushTurnNotifier.removeThreadHistory(threadIds).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[web-push] Could not remove subagent notification history: ${message}`)
    })
  }

  const resolveAudience = (threadId: string): Promise<CodexThreadAudience> => {
    const knownAudience = tracker.getAudience(threadId)
    if (knownAudience !== 'unknown') return Promise.resolve(knownAudience)

    const pending = pendingAudienceLookups.get(threadId)
    if (pending) return pending

    const lookup = withTimeout(
      resolveCodexThreadAudience(threadId, tracker, options.bridge.readThread),
      threadLookupTimeoutMs,
      `thread source lookup for ${threadId}`,
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[notifications] Could not classify thread ${threadId}: ${message}`)
      return 'unknown' as const
    }).finally(() => {
      pendingAudienceLookups.delete(threadId)
    })
    pendingAudienceLookups.set(threadId, lookup)
    return lookup
  }

  const deliverCompletion = async (notification: BridgeNotification): Promise<void> => {
    const threadId = readCodexNotificationThreadId(notification)
    if (!threadId) return

    const resolvedAudience = await resolveAudience(threadId)
    const audience = resolvedAudience === 'unknown'
      ? tracker.getAudience(threadId)
      : resolvedAudience
    if (disposed) return
    if (audience === 'internalSubagent') {
      removeInternalHistory([threadId])
      return
    }

    // Fail open after a bounded lookup so an app-server hiccup cannot swallow a
    // legitimate top-level completion indefinitely.
    options.telegramTurnNotifier.handleNotification(notification)
    options.webPushTurnNotifier.handleNotification(notification)
  }

  const unsubscribe = options.bridge.subscribeNotifications((notification) => {
    const observedAudience = tracker.observeNotification(notification)
    const observedThreadId = readCodexNotificationThreadId(notification)
    if (observedAudience === 'internalSubagent' && observedThreadId) {
      removeInternalHistory([observedThreadId])
    }
    if (notification.method !== 'turn/completed') return

    void deliverCompletion(notification).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[notifications] Could not route turn completion: ${message}`)
    })
  })

  void loadInternalSubagentThreadIds((params) => withTimeout(
    options.bridge.listThreads(params),
    backfillRequestTimeoutMs,
    'subagent thread backfill request',
  )).then((threadIds) => {
    if (disposed) return
    tracker.addInternalThreadIds(threadIds)
    removeInternalHistory(threadIds)
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[notifications] Could not backfill subagent thread metadata: ${message}`)
  })

  return {
    dispose: () => {
      disposed = true
      unsubscribe()
    },
  }
}
