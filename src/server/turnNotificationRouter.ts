import {
  CodexThreadAudienceTracker,
  loadInternalSubagentThreadIds,
  readCodexNotificationThreadId,
  resolveCodexThreadAudience,
  type CodexThreadAudience,
} from '../utils/codexThreadSource.js'
import type { ProjectBoardSnapshot } from '../types/projectBoards'
import { isProjectBoardNotification, type ProjectBoardNotification } from '../utils/projectBoardNotifications'
import { collectProjectBoardNotifications, projectBoardThreadIds } from './projectBoardNotificationEvents.js'

type BridgeNotification = {
  method: string
  params: unknown
  atIso: string
}

type NotificationBridge = {
  listThreads: (params: Record<string, unknown>) => Promise<unknown>
  readThread: (threadId: string) => Promise<unknown>
  subscribeNotifications: (listener: (notification: BridgeNotification) => void) => () => void
  readProjectBoards?: () => Promise<ProjectBoardSnapshot>
  takeProjectBoardRecoveryBaseline?: () => Promise<ProjectBoardSnapshot> | null
  publishLocalNotification?: (method: string, params: unknown) => void
}

type TurnNotificationSink = {
  handleNotification: (notification: BridgeNotification) => void
  handleProjectBoardNotification?: (event: ProjectBoardNotification) => void | Promise<unknown>
}

type WebPushNotificationSink = TurnNotificationSink & {
  removeThreadHistory: (threadIds: Iterable<string>) => Promise<void>
  resolveProjectBoardQuestions?: (questionIds: string[], atIso: string) => Promise<void>
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
  let boardSnapshot: ProjectBoardSnapshot | null = null
  let boardThreadIds = new Set<string>()
  let boardDeliveryQueue = Promise.resolve()

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

  const deliverBoardEvent = (event: ProjectBoardNotification): void => {
    boardDeliveryQueue = boardDeliveryQueue.then(async () => {
      if (disposed) return
      // The existing push history is also the durable inbox and dedupe source.
      const recorded = await options.webPushTurnNotifier.handleProjectBoardNotification?.(event)
      if (recorded === false) return
      options.bridge.publishLocalNotification?.('codexui/projectBoards/notification', event)
      if (!event.quiet) await options.telegramTurnNotifier.handleProjectBoardNotification?.(event)
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[project-boards] Could not deliver board notification: ${message}`)
    })
  }

  const observeBoardSnapshot = (snapshot: ProjectBoardSnapshot): void => {
    if (disposed || (boardSnapshot && snapshot.version < boardSnapshot.version)) return
    if (boardSnapshot && snapshot.version === boardSnapshot.version) {
      // Pausing a runtime queue does not mutate the persisted board version.
      // Retain its current consent without replaying card/question outcomes.
      boardSnapshot = { ...boardSnapshot, queues: snapshot.queues }
      return
    }
    const events = boardSnapshot ? collectProjectBoardNotifications(boardSnapshot, snapshot) : []
    const openQuestionIds = new Set(snapshot.questions.filter((question) => question.status === 'open').map((question) => question.id))
    const resolvedQuestionIds = (boardSnapshot?.questions ?? [])
      .filter((question) => question.status === 'open' && !openQuestionIds.has(question.id))
      .map((question) => question.id)
    boardSnapshot = snapshot
    const nextBoardThreadIds = projectBoardThreadIds(snapshot)
    const addedThreadIds = [...nextBoardThreadIds].filter((id) => !boardThreadIds.has(id))
    boardThreadIds = nextBoardThreadIds
    if (addedThreadIds.length) removeInternalHistory(addedThreadIds)
    if (resolvedQuestionIds.length) {
      boardDeliveryQueue = boardDeliveryQueue.then(async () => {
        if (disposed) return
        await options.webPushTurnNotifier.resolveProjectBoardQuestions?.(resolvedQuestionIds, snapshot.updatedAtIso)
        options.bridge.publishLocalNotification?.('codexui/projectBoards/historyUpdated', {})
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[project-boards] Could not resolve question notification: ${message}`)
      })
    }
    for (const event of events) deliverBoardEvent(event)
  }

  // The bridge captures this once, before recovery marks interrupted runs.
  // Later router instances use current state and cannot replay startup history.
  const recoveryBaseline = options.bridge.takeProjectBoardRecoveryBaseline?.()
  let boardSnapshotQueue = options.bridge.readProjectBoards
    ? (async () => {
      if (recoveryBaseline) {
        observeBoardSnapshot(await withTimeout(recoveryBaseline, backfillRequestTimeoutMs, 'project board recovery baseline'))
      }
      observeBoardSnapshot(await withTimeout(options.bridge.readProjectBoards!(), backfillRequestTimeoutMs, 'project board notification baseline'))
    })()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[project-boards] Could not load notification baseline: ${message}`)
      })
    : Promise.resolve()

  const deliverCompletion = async (notification: BridgeNotification): Promise<void> => {
    const threadId = readCodexNotificationThreadId(notification)
    if (!threadId) return
    await boardSnapshotQueue
    if (disposed || boardThreadIds.has(threadId)) return

    const resolvedAudience = await resolveAudience(threadId)
    const audience = resolvedAudience === 'unknown'
      ? tracker.getAudience(threadId)
      : resolvedAudience
    if (disposed) return
    if (boardThreadIds.has(threadId)) return
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
    if (notification.method === 'codexui/projectBoards/batchCompleted') {
      const event = notification.params
      if (isProjectBoardNotification(event) && event.kind === 'batch_completed') {
        boardSnapshotQueue = boardSnapshotQueue.then(() => {
          if (boardSnapshot?.boards.some((board) => board.id === event.boardId)) deliverBoardEvent(event)
        })
      }
      return
    }
    if (notification.method === 'codexui/projectBoards/updated') {
      const snapshot = notification.params as ProjectBoardSnapshot
      if (Array.isArray(snapshot?.cards) && Array.isArray(snapshot?.runs) && Array.isArray(snapshot?.questions)) {
        boardSnapshotQueue = boardSnapshotQueue.then(() => observeBoardSnapshot(snapshot))
      }
      return
    }
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
