import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { projectBoardNotificationCopy, projectBoardNotificationDeepLink, type ProjectBoardNotification } from '../utils/projectBoardNotifications'

type BridgeNotification = {
  method: string
  params: unknown
  atIso: string
}

type TurnCompletedNotification = {
  threadId: string
  turnId: string
  status: string
  threadTitle: string
  threadUrl: string
  errorMessage: string
  durationMs: number | null
  boardMessage?: string
}

type TelegramConfig = {
  botToken: string
  chatId: string
  publicBaseUrl: string
  source: string
}

export type TelegramTurnNotifier = {
  enabled: boolean
  statusMessage: string
  handleNotification: (notification: BridgeNotification) => void
  handleProjectBoardNotification: (event: ProjectBoardNotification) => void
  handleRequest: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
}

const TELEGRAM_PREFERENCE_FILE = join(homedir(), '.codex', 'codexui-telegram-notifications.json')
const MAX_REQUEST_BODY_BYTES = 16 * 1024

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function normalizeEnvValue(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readPublicBaseUrlFromEnv(env: Record<string, string | undefined>): string {
  return (
    normalizeEnvValue(env.CODEXUI_PUBLIC_BASE_URL) ||
    normalizeEnvValue(env.CODEXUI_BASE_URL) ||
    normalizeEnvValue(env.PUBLIC_BASE_URL) ||
    normalizeEnvValue(env.PUBLIC_URL)
  )
}

function resolveTelegramConfig(): TelegramConfig | null {
  const botToken =
    normalizeEnvValue(process.env.CODEXUI_TELEGRAM_BOT_TOKEN) ||
    normalizeEnvValue(process.env.TELEGRAM_BOT_TOKEN)
  const chatId =
    normalizeEnvValue(process.env.CODEXUI_TELEGRAM_CHAT_ID) ||
    normalizeEnvValue(process.env.TELEGRAM_CHAT_ID) ||
    normalizeEnvValue(process.env.MY_TELEGRAM_CHAT_ID)
  if (!botToken || !chatId) return null

  return {
    botToken,
    chatId,
    publicBaseUrl: readPublicBaseUrlFromEnv(process.env),
    source: 'environment variables',
  }
}

function isExplicitlyDisabled(): boolean {
  const raw = normalizeEnvValue(process.env.CODEXUI_TELEGRAM_NOTIFICATIONS).toLowerCase()
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no'
}

function readPersistedEnabledPreference(): boolean | null {
  try {
    const parsed = JSON.parse(readFileSync(TELEGRAM_PREFERENCE_FILE, 'utf8')) as unknown
    const record = asRecord(parsed)
    return typeof record?.enabled === 'boolean' ? record.enabled : null
  } catch {
    return null
  }
}

function writeEnabledPreference(enabled: boolean): void {
  mkdirSync(dirname(TELEGRAM_PREFERENCE_FILE), { recursive: true })
  const temporaryPath = `${TELEGRAM_PREFERENCE_FILE}.${process.pid.toString()}.tmp`
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  renameSync(temporaryPath, TELEGRAM_PREFERENCE_FILE)
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
    if (size > MAX_REQUEST_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function normalizePublicBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim()
  if (!trimmed) return ''

  const withProtocol = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`
  const withoutHash = withProtocol.split('#')[0] ?? withProtocol
  return withoutHash.replace(/\/+$/u, '')
}

function buildThreadUrl(publicBaseUrl: string, threadId: string): string {
  if (!publicBaseUrl || !threadId) return ''
  return `${publicBaseUrl}/#/thread/${threadId}`
}

function readThreadTitle(params: Record<string, unknown>, turn: Record<string, unknown>): string {
  const fromParams =
    readString(params.threadTitle) ||
    readString(params.threadName) ||
    readString(params.title)
  if (fromParams) return fromParams

  return readString(turn.threadTitle) || readString(turn.threadName) || readString(turn.title)
}

function readTurnCompletedNotification(notification: BridgeNotification, publicBaseUrl: string): TurnCompletedNotification | null {
  if (notification.method !== 'turn/completed') return null

  const params = asRecord(notification.params)
  if (!params) return null

  const turn = asRecord(params.turn)
  if (!turn) return null

  const threadId = readString(params.threadId)
  const turnId = readString(turn.id)
  const status = readString(turn.status) || 'completed'
  const automation = asRecord(params.codexuiAutomation)
  const notificationPolicy = readString(automation?.notificationPolicy)
  if (
    notificationPolicy === 'never' ||
    (notificationPolicy === 'failure' && status !== 'failed')
  ) {
    return null
  }
  const threadTitle = readThreadTitle(params, turn)
  const threadUrl = buildThreadUrl(publicBaseUrl, threadId)
  const errorMessage = readString(asRecord(turn.error)?.message)
  const durationMs = readNumber(params.durationMs) ?? readNumber(turn.durationMs)

  if (!threadId || !turnId) return null
  return { threadId, turnId, status, threadTitle, threadUrl, errorMessage, durationMs }
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return ''
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`

  const minutes = Math.floor(durationMs / 60000)
  const seconds = Math.round((durationMs % 60000) / 1000)
  return `${String(minutes)}m ${String(seconds)}s`
}

function truncateMessage(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}

function formatTelegramMessage(notification: TurnCompletedNotification): string {
  const lines = [notification.boardMessage || 'codex complete']
  if (notification.threadUrl) lines.push(notification.threadUrl)
  return lines.join('\n')
}

export function createTelegramTurnNotifier(): TelegramTurnNotifier {
  const config = resolveTelegramConfig()
  const persistedPreference = readPersistedEnabledPreference()
  let enabled = Boolean(config) && (persistedPreference ?? !isExplicitlyDisabled())

  const seenTurnKeys = new Set<string>()
  const seenTurnOrder: string[] = []
  const seenTurnLimit = 300
  const normalizedPublicBaseUrl = normalizePublicBaseUrl(config?.publicBaseUrl ?? '')

  const sendNotification = async (turnCompleted: TurnCompletedNotification): Promise<void> => {
    if (!config) return
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: formatTelegramMessage(turnCompleted),
        disable_web_page_preview: true,
      }),
    })

    if (response.ok) return
    const responseText = await response.text()
    const details = truncateMessage(responseText.trim(), 300)
    console.warn(`[telegram] Failed to send turn notification: HTTP ${String(response.status)} ${details}`)
  }

  const handleNotification = (notification: BridgeNotification) => {
    if (!enabled) return
    const turnCompleted = readTurnCompletedNotification(notification, normalizedPublicBaseUrl)
    if (!turnCompleted) return

    const dedupeKey = `${turnCompleted.threadId}:${turnCompleted.turnId}`
    if (seenTurnKeys.has(dedupeKey)) return
    seenTurnKeys.add(dedupeKey)
    seenTurnOrder.push(dedupeKey)

    while (seenTurnOrder.length > seenTurnLimit) {
      const oldest = seenTurnOrder.shift()
      if (!oldest) break
      seenTurnKeys.delete(oldest)
    }

    void sendNotification(turnCompleted).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[telegram] Failed to send turn notification: ${message}`)
    })
  }

  const handleProjectBoardNotification = (event: ProjectBoardNotification): void => {
    if (!enabled || seenTurnKeys.has(event.id)) return
    seenTurnKeys.add(event.id)
    seenTurnOrder.push(event.id)
    while (seenTurnOrder.length > seenTurnLimit) {
      const oldest = seenTurnOrder.shift()
      if (oldest) seenTurnKeys.delete(oldest)
    }
    const copy = projectBoardNotificationCopy(event)
    void sendNotification({
      threadId: '',
      turnId: event.id,
      status: event.kind,
      threadTitle: '',
      threadUrl: normalizedPublicBaseUrl ? `${normalizedPublicBaseUrl}/${projectBoardNotificationDeepLink(event)}` : '',
      errorMessage: '',
      durationMs: null,
      boardMessage: `${copy.title}\n${copy.body}`,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[telegram] Failed to send board notification: ${message}`)
    })
  }

  const handleRequest = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!req.url) {
      next()
      return
    }
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/codex-api/telegram/config') {
      next()
      return
    }

    void (async () => {
      if (req.method === 'GET') {
        setJson(res, 200, {
          data: {
            available: Boolean(config),
            enabled,
          },
        })
        return
      }

      if (req.method === 'POST') {
        const payload = asRecord(await readJsonBody(req))
        if (typeof payload?.enabled !== 'boolean') {
          setJson(res, 400, { error: 'Invalid body: enabled must be a boolean' })
          return
        }
        if (payload.enabled && !config) {
          setJson(res, 409, { error: 'Telegram is not configured on this server' })
          return
        }

        enabled = payload.enabled
        writeEnabledPreference(enabled)
        console.log(`[telegram] Turn notifications ${enabled ? 'enabled' : 'disabled'} from notification settings.`)
        setJson(res, 200, {
          data: {
            available: Boolean(config),
            enabled,
          },
        })
        return
      }

      setJson(res, 405, { error: 'Method not allowed' })
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setJson(res, 500, { error: message })
    })
  }

  return {
    get enabled() {
      return enabled
    },
    statusMessage: !config
      ? 'Telegram turn notifications unavailable (missing bot token/chat id).'
      : `Telegram turn notifications ${enabled ? 'enabled' : 'disabled'} (${config.source}${normalizedPublicBaseUrl ? `, base URL ${normalizedPublicBaseUrl}` : ', no public base URL configured'}).`,
    handleNotification,
    handleProjectBoardNotification,
    handleRequest,
  }
}
