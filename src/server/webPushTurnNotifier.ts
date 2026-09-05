import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import webPush from 'web-push'
import type { PushSubscription, WebPushError } from 'web-push'
import { compactNotificationText } from '../utils/notificationText'
import {
  projectBoardNotificationCopy,
  projectBoardNotificationDeepLink,
  projectBoardNotificationScope,
  type ProjectBoardNotification,
} from '../utils/projectBoardNotifications'

type BridgeNotification = {
  method: string
  params: unknown
  atIso: string
}

type NotificationMode = 'unfocused' | 'always'

type StoredSubscription = {
  subscription: PushSubscription
  mode: NotificationMode
  deviceName: string
  userAgent: string
  createdAt: string
  updatedAt: string
}

type StoredNotificationHistoryItem = {
  id: string
  threadId: string
  turnId: string
  status: string
  title: string
  body: string
  completedAt: string
  readAt: string | null
  projectBoard?: ProjectBoardNotification
}

type StoredNotificationDismissal = {
  threadId: string
  activityAt: string
  dismissedAt: string
}

type PushState = {
  version: 1
  vapid: {
    publicKey: string
    privateKey: string
  }
  subscriptions: StoredSubscription[]
  history: StoredNotificationHistoryItem[]
  dismissals: StoredNotificationDismissal[]
}

type PushPayload = {
  title: string
  body: string
  url: string
  tag: string
  mode: NotificationMode
  icon: string
  badge: string
}

type CompletedTurn = {
  threadId: string
  turnId: string
  status: string
  threadTitle: string
  body: string
  completedAt: string
  projectBoard?: ProjectBoardNotification
}

type PushSendResult =
  | { status: 'sent' }
  | { status: 'expired' }
  | { status: 'failed'; message: string }

export type WebPushTurnNotifier = {
  enabled: boolean
  statusMessage: string
  handleNotification: (notification: BridgeNotification) => void
  syncProjectBoardNativeRequests: (pendingEventIds: string[], atIso: string) => Promise<void>
  handleProjectBoardNotification: (event: ProjectBoardNotification) => Promise<boolean>
  resolveProjectBoardQuestions: (questionIds: string[], atIso: string) => Promise<void>
  handleRequest: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
  removeThreadHistory: (threadIds: Iterable<string>) => Promise<void>
}

const STATE_FILE_ENV = 'CODEXUI_WEB_PUSH_STATE_FILE'
const VAPID_PUBLIC_KEY_ENV = 'CODEXUI_WEB_PUSH_PUBLIC_KEY'
const VAPID_PRIVATE_KEY_ENV = 'CODEXUI_WEB_PUSH_PRIVATE_KEY'
const VAPID_SUBJECT_ENV = 'CODEXUI_WEB_PUSH_SUBJECT'
const DEFAULT_VAPID_SUBJECT = 'https://github.com/jothamgoh/codexui-patched'
const DEFAULT_NOTIFICATION_BODY = 'Codex finished responding'
const STATE_VERSION = 1
const MAX_BODY_BYTES = 64 * 1024
const MAX_NOTIFICATION_BODY_LENGTH = 180
const MAX_SEEN_TURNS = 500
const MAX_HISTORY_ITEMS = 30
const MAX_DISMISSALS = 100

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeMode(value: unknown): NotificationMode {
  return value === 'always' ? 'always' : 'unfocused'
}

function normalizeSubscription(value: unknown): PushSubscription | null {
  const record = asRecord(value)
  const keys = asRecord(record?.keys)
  const endpoint = readString(record?.endpoint)
  const p256dh = readString(keys?.p256dh)
  const auth = readString(keys?.auth)
  if (!endpoint || !p256dh || !auth) return null
  if (!/^https:\/\//iu.test(endpoint)) return null

  const expirationTime =
    typeof record?.expirationTime === 'number' && Number.isFinite(record.expirationTime)
      ? record.expirationTime
      : null

  return {
    endpoint,
    expirationTime,
    keys: { p256dh, auth },
  }
}

function normalizeStoredSubscription(value: unknown): StoredSubscription | null {
  const record = asRecord(value)
  const subscription = normalizeSubscription(record?.subscription)
  if (!record || !subscription) return null

  return {
    subscription,
    mode: normalizeMode(record.mode),
    deviceName: readString(record.deviceName).slice(0, 120),
    userAgent: readString(record.userAgent).slice(0, 500),
    createdAt: readString(record.createdAt) || new Date().toISOString(),
    updatedAt: readString(record.updatedAt) || new Date().toISOString(),
  }
}

function normalizeHistoryItem(value: unknown): StoredNotificationHistoryItem | null {
  const record = asRecord(value)
  if (!record) return null

  const threadId = readString(record.threadId)
  const turnId = readString(record.turnId)
  const completedAt = readString(record.completedAt)
  if (!threadId || !turnId || !completedAt) return null
  const board = asRecord(record.projectBoard)
  const projectBoard = board && ['question', 'failed', 'completed', 'plan_ready', 'batch_completed', 'native_request'].includes(readString(board.kind)) &&
    readString(board.id) && readString(board.boardId) && readString(board.occurredAt)
    ? {
      id: readString(board.id),
      kind: board.kind as ProjectBoardNotification['kind'],
      boardId: readString(board.boardId),
      featureId: readString(board.featureId),
      cardId: readString(board.cardId),
      ...(readString(board.questionId) ? { questionId: readString(board.questionId) } : {}),
      ...(readString(board.threadId) ? { threadId: readString(board.threadId) } : {}),
      ...(readString(board.queueId) ? { queueId: readString(board.queueId) } : {}),
      ...(Number.isInteger(board.requestId) ? { requestId: Number(board.requestId) } : {}),
      ...(board.requestKind === 'approval' || board.requestKind === 'question' ? { requestKind: board.requestKind as ProjectBoardNotification['requestKind'] } : {}),
      ...(board.quiet === true ? { quiet: true } : {}),
      occurredAt: readString(board.occurredAt),
    }
    : undefined

  return {
    id: readString(record.id) || `${threadId}:${turnId}`,
    threadId,
    turnId,
    status: readString(record.status) || 'completed',
    title: readString(record.title) || 'CodexUI',
    body: compactNotificationText(
      readString(record.body),
      DEFAULT_NOTIFICATION_BODY,
      MAX_NOTIFICATION_BODY_LENGTH,
    ),
    completedAt,
    readAt: readString(record.readAt) || null,
    ...(projectBoard ? { projectBoard } : {}),
  }
}

function normalizeDismissal(value: unknown): StoredNotificationDismissal | null {
  const record = asRecord(value)
  if (!record) return null
  const threadId = readString(record.threadId)
  const activityAt = readString(record.activityAt)
  if (!threadId || !activityAt) return null
  return {
    threadId,
    activityAt,
    dismissedAt: readString(record.dismissedAt) || new Date().toISOString(),
  }
}

function resolveStateFile(): string {
  const configured = readString(process.env[STATE_FILE_ENV])
  if (configured) return resolve(configured)
  return join(readString(process.env.CODEX_HOME) || join(homedir(), '.codex'), 'codexui-web-push.json')
}

function readEnvironmentVapidKeys(): PushState['vapid'] | null {
  const publicKey = readString(process.env[VAPID_PUBLIC_KEY_ENV])
  const privateKey = readString(process.env[VAPID_PRIVATE_KEY_ENV])
  if (!publicKey || !privateKey) return null
  return { publicKey, privateKey }
}

async function readStoredState(stateFile: string): Promise<PushState | null> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as unknown
    const record = asRecord(parsed)
    const vapidRecord = asRecord(record?.vapid)
    const publicKey = readString(vapidRecord?.publicKey)
    const privateKey = readString(vapidRecord?.privateKey)
    if (!publicKey || !privateKey) return null

    return {
      version: STATE_VERSION,
      vapid: { publicKey, privateKey },
      subscriptions: Array.isArray(record?.subscriptions)
        ? record.subscriptions
          .map(normalizeStoredSubscription)
          .filter((value): value is StoredSubscription => value !== null)
        : [],
      history: Array.isArray(record?.history)
        ? record.history
          .map(normalizeHistoryItem)
          .filter((value): value is StoredNotificationHistoryItem => value !== null)
          .slice(0, MAX_HISTORY_ITEMS)
        : [],
      dismissals: Array.isArray(record?.dismissals)
        ? record.dismissals
          .map(normalizeDismissal)
          .filter((value): value is StoredNotificationDismissal => value !== null)
          .slice(0, MAX_DISMISSALS)
        : [],
    }
  } catch {
    return null
  }
}

async function persistState(stateFile: string, state: PushState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true })
  const temporaryPath = `${stateFile}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporaryPath, stateFile)
}

async function initializeState(stateFile: string): Promise<PushState> {
  const stored = await readStoredState(stateFile)
  const environmentVapid = readEnvironmentVapidKeys()
  const state: PushState = {
    version: STATE_VERSION,
    vapid: environmentVapid ?? stored?.vapid ?? webPush.generateVAPIDKeys(),
    subscriptions: stored?.subscriptions ?? [],
    history: stored?.history ?? [],
    dismissals: stored?.dismissals ?? [],
  }
  await persistState(stateFile, state)
  return state
}

function readContentText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''

  return value
    .map((part) => {
      const record = asRecord(part)
      if (!record) return ''
      return readString(record.text) || readString(record.content)
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function readAssistantText(turn: Record<string, unknown>): string {
  const direct =
    readString(turn.lastAgentMessage) ||
    readString(turn.assistantMessage) ||
    readString(turn.outputText)
  if (direct) return direct

  const items = Array.isArray(turn.items) ? turn.items : []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index])
    if (!item) continue
    const type = readString(item.type)
    const role = readString(item.role)
    if (type !== 'agentMessage' && type !== 'assistantMessage' && role !== 'assistant') continue

    const text =
      readString(item.text) ||
      readString(item.message) ||
      readContentText(item.content)
    if (text) return text
  }

  return ''
}

function readCompletedTurn(notification: BridgeNotification): CompletedTurn | null {
  if (notification.method !== 'turn/completed') return null
  const params = asRecord(notification.params)
  const turn = asRecord(params?.turn)
  if (!params || !turn) return null

  const threadId = readString(params.threadId)
  const turnId = readString(turn.id) || readString(params.turnId)
  const status = readString(turn.status) || readString(params.status) || 'completed'
  const automation = asRecord(params.codexuiAutomation)
  const notificationPolicy = readString(automation?.notificationPolicy)
  if (
    notificationPolicy === 'never' ||
    (notificationPolicy === 'failure' && status !== 'failed')
  ) {
    return null
  }
  if (!threadId || !turnId || status === 'interrupted') return null

  const threadTitle =
    readString(params.threadTitle) ||
    readString(params.threadName) ||
    readString(params.title) ||
    readString(turn.threadTitle) ||
    readString(turn.threadName)
  const error = asRecord(turn.error)
  const errorText = readString(error?.message)
  const assistantText = readAssistantText(turn)

  return {
    threadId,
    turnId,
    status,
    threadTitle,
    body: status === 'failed'
      ? compactNotificationText(errorText, 'Turn failed', MAX_NOTIFICATION_BODY_LENGTH)
      : compactNotificationText(
        assistantText,
        DEFAULT_NOTIFICATION_BODY,
        MAX_NOTIFICATION_BODY_LENGTH,
      ),
    completedAt: readString(notification.atIso) || new Date().toISOString(),
  }
}

function buildCompletedTurnTitle(turn: CompletedTurn): string {
  if (turn.projectBoard) return projectBoardNotificationCopy(turn.projectBoard).title
  return turn.status === 'failed'
    ? (turn.threadTitle ? `${turn.threadTitle} failed` : 'Turn failed')
    : (turn.threadTitle || 'CodexUI')
}

function buildPayload(turn: CompletedTurn, mode: NotificationMode): PushPayload {
  return {
    title: buildCompletedTurnTitle(turn),
    body: turn.body,
    url: turn.projectBoard ? `/${projectBoardNotificationDeepLink(turn.projectBoard)}` : `/#/thread/${encodeURIComponent(turn.threadId)}`,
    tag: turn.projectBoard?.id ?? `${turn.threadId}:${turn.turnId}`,
    mode,
    icon: '/icons/codexui-192.png',
    badge: '/icons/codexui-192.png',
  }
}

function buildTestPayload(mode: NotificationMode, destination: string): PushPayload {
  return {
    title: 'CodexUI notifications',
    body: 'This device is ready for turn-complete alerts.',
    url: normalizeDestination(destination),
    tag: 'codexui-test',
    mode,
    icon: '/icons/codexui-192.png',
    badge: '/icons/codexui-192.png',
  }
}

function normalizeDestination(value: unknown): string {
  const destination = readString(value)
  if (!destination.startsWith('/#/')) return '/#/'
  return destination.slice(0, 2048)
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body is too large')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function readPushErrorStatus(error: unknown): number {
  const statusCode = (error as Partial<WebPushError> | null)?.statusCode
  return typeof statusCode === 'number' ? statusCode : 0
}

export function createWebPushTurnNotifier(): WebPushTurnNotifier {
  const stateFile = resolveStateFile()
  const statePromise = initializeState(stateFile)
  const seenTurnKeys = new Set<string>()
  const seenTurnOrder: string[] = []
  let mutationQueue: Promise<void> = Promise.resolve()

  const mutateState = async <T>(mutator: (state: PushState) => T | Promise<T>): Promise<T> => {
    let result!: T
    mutationQueue = mutationQueue
      .catch(() => {})
      .then(async () => {
        const state = await statePromise
        result = await mutator(state)
        await persistState(stateFile, state)
      })
    await mutationQueue
    return result
  }

  const removeSubscriptions = async (endpoints: Set<string>): Promise<void> => {
    if (endpoints.size === 0) return
    await mutateState((state) => {
      state.subscriptions = state.subscriptions.filter(
        (entry) => !endpoints.has(entry.subscription.endpoint),
      )
    })
  }

  const sendToEntry = async (
    entry: StoredSubscription,
    payload: PushPayload,
  ): Promise<PushSendResult> => {
    try {
      await webPush.sendNotification(entry.subscription, JSON.stringify(payload), {
        TTL: 24 * 60 * 60,
        urgency: 'normal',
        vapidDetails: {
          subject: readString(process.env[VAPID_SUBJECT_ENV]) || DEFAULT_VAPID_SUBJECT,
          publicKey: (await statePromise).vapid.publicKey,
          privateKey: (await statePromise).vapid.privateKey,
        },
      })
      return { status: 'sent' }
    } catch (error) {
      const status = readPushErrorStatus(error)
      if (status === 404 || status === 410) return { status: 'expired' }
      const message = error instanceof Error ? error.message : String(error)
      const responseBody = readString((error as Partial<WebPushError> | null)?.body).slice(0, 300)
      const responseDetails = [
        status ? `HTTP ${status.toString()}` : '',
        responseBody,
      ].filter(Boolean).join(' ')
      console.warn(
        `[web-push] Failed to notify ${entry.deviceName || 'device'}: ${message}${responseDetails ? ` (${responseDetails})` : ''}`,
      )
      return {
        status: 'failed',
        message: responseDetails ? `${message} (${responseDetails})` : message,
      }
    }
  }

  const sendCompletedTurn = async (turn: CompletedTurn): Promise<void> => {
    const state = await statePromise
    if (state.subscriptions.length === 0) return

    const expiredEndpoints = new Set<string>()
    await Promise.all(state.subscriptions.map(async (entry) => {
      const result = await sendToEntry(entry, buildPayload(turn, entry.mode))
      if (result.status === 'expired') expiredEndpoints.add(entry.subscription.endpoint)
    }))
    await removeSubscriptions(expiredEndpoints)
  }

  const recordCompletedTurn = async (turn: CompletedTurn): Promise<boolean> => {
    return mutateState((state) => {
      const id = turn.projectBoard?.id ?? `${turn.threadId}:${turn.turnId}`
      const previous = state.history.find((item) => item.id === id)
      if (turn.projectBoard && previous) return false
      const item: StoredNotificationHistoryItem = {
        id,
        threadId: turn.threadId,
        turnId: turn.turnId,
        status: turn.status,
        title: buildCompletedTurnTitle(turn),
        body: turn.body,
        completedAt: turn.completedAt,
        readAt: previous?.readAt ?? null,
        ...(turn.projectBoard ? { projectBoard: turn.projectBoard } : {}),
      }
      state.history = [
        item,
        ...state.history.filter((candidate) => candidate.id !== id),
      ].slice(0, MAX_HISTORY_ITEMS)
      state.dismissals = state.dismissals.filter(
        (dismissal) => dismissal.threadId !== turn.threadId,
      )
      return true
    })
  }

  const handleProjectBoardNotification = async (event: ProjectBoardNotification): Promise<boolean> => {
    const copy = projectBoardNotificationCopy(event)
    const turn: CompletedTurn = {
      threadId: projectBoardNotificationScope(event),
      turnId: event.id,
      status: event.kind,
      threadTitle: copy.title,
      body: copy.body,
      completedAt: event.occurredAt,
      projectBoard: event,
    }
    const recorded = await recordCompletedTurn(turn)
    if (!recorded) return false
    // Record first so Activity works without any enrolled delivery device.
    if (!event.quiet) void sendCompletedTurn(turn).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[web-push] Failed to send board notification: ${message}`)
    })
    return true
  }

  const resolveProjectBoardQuestions = async (questionIds: string[], atIso: string): Promise<void> => {
    const resolved = new Set(questionIds)
    await mutateState((state) => {
      for (const item of state.history) {
        if (item.projectBoard?.questionId && resolved.has(item.projectBoard.questionId)) {
          item.readAt = item.readAt || atIso
          item.status = 'answered'
          item.body = 'This board question has been resolved.'
        }
      }
    })
  }

  const syncProjectBoardNativeRequests = async (pendingEventIds: string[], atIso: string): Promise<void> => {
    const pending = new Set(pendingEventIds)
    await mutateState((state) => {
      for (const item of state.history) {
        if (item.projectBoard?.kind !== 'native_request' || pending.has(item.projectBoard.id)) continue
        item.readAt = item.readAt || atIso
        item.status = 'resolved'
        item.title = 'Lead request resolved'
        item.body = 'This Lead request has been resolved.'
      }
    })
  }

  const processCompletedTurn = async (turn: CompletedTurn): Promise<void> => {
    await recordCompletedTurn(turn)
    await sendCompletedTurn(turn)
  }

  const handleNotification = (notification: BridgeNotification): void => {
    const completedTurn = readCompletedTurn(notification)
    if (!completedTurn) return

    const turnKey = `${completedTurn.threadId}:${completedTurn.turnId}`
    if (seenTurnKeys.has(turnKey)) return
    seenTurnKeys.add(turnKey)
    seenTurnOrder.push(turnKey)
    while (seenTurnOrder.length > MAX_SEEN_TURNS) {
      const oldest = seenTurnOrder.shift()
      if (oldest) seenTurnKeys.delete(oldest)
    }

    void processCompletedTurn(completedTurn).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[web-push] Failed to process turn notification: ${message}`)
    })
  }

  const removeThreadHistory = async (threadIds: Iterable<string>): Promise<void> => {
    const excludedThreadIds = new Set(
      Array.from(threadIds, (threadId) => threadId.trim()).filter(Boolean),
    )
    if (excludedThreadIds.size === 0) return

    await mutateState((state) => {
      state.history = state.history.filter((item) => !excludedThreadIds.has(item.threadId))
      state.dismissals = state.dismissals.filter((item) => !excludedThreadIds.has(item.threadId))
    })
  }

  const handleRequest = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!req.url) {
      next()
      return
    }
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/codex-api/push/')) {
      next()
      return
    }

    void (async () => {
      const state = await statePromise

      if (req.method === 'GET' && url.pathname === '/codex-api/push/config') {
        setJson(res, 200, {
          data: {
            supported: true,
            publicKey: state.vapid.publicKey,
          },
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/push/history') {
        setJson(res, 200, {
          data: {
            items: state.history,
            unreadCount: state.history.filter((item) => item.readAt === null).length,
            dismissals: state.dismissals,
          },
        })
        return
      }

      const body = asRecord(await readJsonBody(req))
      const subscription = normalizeSubscription(body?.subscription)

      if (req.method === 'POST' && url.pathname === '/codex-api/push/history/read') {
        const ids = Array.isArray(body?.ids)
          ? new Set(body.ids.map(readString).filter(Boolean))
          : new Set<string>()
        const threadId = readString(body?.threadId)
        const markAll = body?.all === true
        if (!markAll && ids.size === 0 && !threadId) {
          setJson(res, 400, { error: 'Provide ids, threadId, or all' })
          return
        }

        const history = await mutateState((currentState) => {
          const readAt = new Date().toISOString()
          for (const item of currentState.history) {
            if (markAll || ids.has(item.id) || item.threadId === threadId) {
              item.readAt = item.readAt ?? readAt
            }
          }
          return currentState.history
        })
        setJson(res, 200, {
          data: {
            items: history,
            unreadCount: history.filter((item) => item.readAt === null).length,
            dismissals: (await statePromise).dismissals,
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/push/history/unread') {
        const threadId = readString(body?.threadId)
        const activityAt = readString(body?.activityAt)
        if (!threadId) {
          setJson(res, 400, { error: 'Provide threadId' })
          return
        }

        const result = await mutateState((currentState) => {
          const exactItem = activityAt
            ? currentState.history.find(
              (item) => item.threadId === threadId && item.completedAt === activityAt,
            )
            : undefined
          const item = exactItem ?? currentState.history.find(
            (candidate) => candidate.threadId === threadId,
          )
          if (item) item.readAt = null
          currentState.dismissals = currentState.dismissals.filter(
            (dismissal) => dismissal.threadId !== threadId,
          )
          return {
            items: currentState.history,
            unreadCount: currentState.history.filter((candidate) => candidate.readAt === null).length,
            dismissals: currentState.dismissals,
          }
        })
        setJson(res, 200, { data: result })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/push/history/dismiss') {
        const threadId = readString(body?.threadId)
        const activityAt = readString(body?.activityAt)
        if (!threadId || !activityAt) {
          setJson(res, 400, { error: 'Provide threadId and activityAt' })
          return
        }

        const result = await mutateState((currentState) => {
          const dismissedAt = new Date().toISOString()
          currentState.dismissals = [
            { threadId, activityAt, dismissedAt },
            ...currentState.dismissals.filter((item) => item.threadId !== threadId),
          ].slice(0, MAX_DISMISSALS)
          for (const item of currentState.history) {
            if (item.threadId === threadId && item.completedAt === activityAt) {
              item.readAt = item.readAt ?? dismissedAt
            }
          }
          return {
            items: currentState.history,
            unreadCount: currentState.history.filter((item) => item.readAt === null).length,
            dismissals: currentState.dismissals,
          }
        })
        setJson(res, 200, { data: result })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/push/subscribe') {
        if (!subscription) {
          setJson(res, 400, { error: 'Invalid push subscription' })
          return
        }
        const mode = normalizeMode(body?.mode)
        const now = new Date().toISOString()
        const deviceName = readString(body?.deviceName).slice(0, 120)
        const userAgent = readString(req.headers['user-agent']).slice(0, 500)

        const subscriptionCount = await mutateState((currentState) => {
          const existing = currentState.subscriptions.find(
            (entry) => entry.subscription.endpoint === subscription.endpoint,
          )
          if (existing) {
            existing.subscription = subscription
            existing.mode = mode
            existing.deviceName = deviceName || existing.deviceName
            existing.userAgent = userAgent
            existing.updatedAt = now
          } else {
            currentState.subscriptions.push({
              subscription,
              mode,
              deviceName,
              userAgent,
              createdAt: now,
              updatedAt: now,
            })
          }
          return currentState.subscriptions.length
        })

        setJson(res, 200, { data: { enabled: true, mode, subscriptionCount } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/push/unsubscribe') {
        if (!subscription) {
          setJson(res, 400, { error: 'Invalid push subscription' })
          return
        }
        const subscriptionCount = await mutateState((currentState) => {
          currentState.subscriptions = currentState.subscriptions.filter(
            (entry) => entry.subscription.endpoint !== subscription.endpoint,
          )
          return currentState.subscriptions.length
        })
        setJson(res, 200, { data: { enabled: false, subscriptionCount } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/push/test') {
        if (!subscription) {
          setJson(res, 400, { error: 'Invalid push subscription' })
          return
        }
        const entry = state.subscriptions.find(
          (candidate) => candidate.subscription.endpoint === subscription.endpoint,
        )
        if (!entry) {
          setJson(res, 404, { error: 'This device is not subscribed' })
          return
        }
        const result = await sendToEntry(
          entry,
          buildTestPayload('always', normalizeDestination(body?.url)),
        )
        if (result.status === 'expired') {
          await removeSubscriptions(new Set([subscription.endpoint]))
          setJson(res, 410, { error: 'This push subscription has expired' })
          return
        }
        if (result.status === 'failed') {
          setJson(res, 502, {
            error: `The push service could not deliver this test: ${result.message}`,
          })
          return
        }
        setJson(res, 200, { data: { sent: true } })
        return
      }

      setJson(res, 404, { error: 'Unknown push endpoint' })
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setJson(res, 500, { error: message })
    })
  }

  void statePromise.then((state) => {
    console.log(
      `[web-push] Ready (${state.subscriptions.length.toString()} subscribed device${state.subscriptions.length === 1 ? '' : 's'}, state ${stateFile}).`,
    )
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[web-push] Failed to initialize: ${message}`)
  })

  return {
    enabled: true,
    statusMessage: `Web Push initializing (state ${stateFile}).`,
    handleNotification,
    handleProjectBoardNotification,
    resolveProjectBoardQuestions,
    syncProjectBoardNativeRequests,
    handleRequest,
    removeThreadHistory,
  }
}
