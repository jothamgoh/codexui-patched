/**
 * HTTP routes for voice commands.
 *
 * Shortcut only, bearer token required (and disabled when the token is unset):
 *   POST /codex-api/voice/shortcut/command   audio body or {"text": "..."}
 *   POST /codex-api/voice/shortcut/confirm   {"token": "..."}
 * PWA, normal session auth only:
 *   GET  /codex-api/voice/<code>             a saved result
 *   POST /codex-api/voice/command            same router, no push; the app navigates itself
 *
 * Nothing outside /codex-api/voice/shortcut/ looks at the bearer token, and
 * nothing the PWA needs lives under it, so a Cloudflare Access service-token
 * app can cover exactly that prefix.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  isVoiceCode,
  voiceResultPath,
  VOICE_LIST_LABELS,
  type VoiceResult,
  type VoiceShortcutResponse,
  type VoiceStoredResult,
} from '../../types/voice'
import type { ProjectBoardSnapshot } from '../../types/projectBoards'
import type { ActivityHistoryItem } from '../../utils/notificationActivity'
import { askJev } from './jevClient'
import { buildVoiceContext, type VoiceSourceSnapshot } from './voiceContext'
import { extractMessageWithLlm } from './voiceMessage'
import { routeVoiceCommand, type VoiceRouteTrace } from './voiceRouter'
import { VoiceResultStore } from './voiceStore'

export const VOICE_ENV = {
  shortcutToken: 'CODEXUI_VOICE_SHORTCUT_TOKEN',
  typesafeApiKey: 'CODEXUI_VOICE_TYPESAFE_API_KEY',
  anthropicApiKey: 'CODEXUI_VOICE_ANTHROPIC_API_KEY',
  anthropicWorkspaceId: 'CODEXUI_VOICE_ANTHROPIC_WORKSPACE_ID',
  deepseekApiKey: 'CODEXUI_VOICE_DEEPSEEK_API_KEY',
  kimiApiKey: 'CODEXUI_VOICE_KIMI_API_KEY',
} as const

/** A shorter configured token is treated as unset. */
export const MIN_SHORTCUT_TOKEN_LENGTH = 24
const MAX_JSON_BYTES = 16 * 1024
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_TEXT_LENGTH = 2_000
const SHORTCUT_PREFIX = '/codex-api/voice/shortcut/'

export type VoicePush = { title: string; body: string; url: string; tag: string }

/** What the bridge exposes for voice commands (codexAppServerBridge.ts). */
export type VoiceBridgeSources = {
  listThreads: () => Promise<unknown[]>
  readThreadSummary: (threadId: string) => Promise<unknown>
  readTitles: () => Promise<Record<string, string>>
  readReadState: () => Promise<{ readAtByThreadId: Record<string, string>; unreadThreadIds: string[] }>
  replyThreadIds: () => string[]
  backgroundThreadIds: () => string[]
  listPendingServerRequests: () => Array<{ id: number; method: string; params: unknown; receivedAtIso?: string }>
  readProjectBoards: () => Promise<ProjectBoardSnapshot>
  readWorkspaceRoots: () => Promise<{ order: string[]; labels: Record<string, string> }>
  readPinnedThreadIds: () => Promise<string[]>
  transcribe: (audio: Buffer, contentType: string) => Promise<string>
  sendMessage: (threadId: string, text: string) => Promise<void>
}

export type VoicePushSink = {
  sendCustomNotification: (push: VoicePush) => Promise<{ sent: number; failed: number }>
  readHistory: () => Promise<{ items: ActivityHistoryItem[]; dismissals: Array<{ threadId: string; activityAt: string }> }>
}

const SOURCE_TIMEOUT_MS = 3_000
const MAX_EXTRA_SUMMARIES = 8

async function within<T>(promise: Promise<T>, fallback: T, timeoutMs = SOURCE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Gathers everything the router needs; a slow or failing source degrades to empty. */
export async function collectVoiceSnapshot(bridge: VoiceBridgeSources, push: VoicePushSink, now = Date.now()): Promise<VoiceSourceSnapshot> {
  const [threadSummaries, titles, readState, boardSnapshot, workspaceRoots, history, pinnedThreadIds] = await Promise.all([
    within(bridge.listThreads(), [] as unknown[]),
    within(bridge.readTitles(), {} as Record<string, string>),
    within(bridge.readReadState(), { readAtByThreadId: {}, unreadThreadIds: [] }),
    within(bridge.readProjectBoards().then((value): ProjectBoardSnapshot | null => value), null),
    within(bridge.readWorkspaceRoots(), { order: [], labels: {} }),
    within(push.readHistory(), { items: [], dismissals: [] }),
    within(bridge.readPinnedThreadIds(), [] as string[]),
  ])
  const replyThreadIds = bridge.replyThreadIds()
  // Running helper sub-chats are not in the main list; read them so their parent counts as running.
  const listed = new Set(threadSummaries.map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>).id : '')))
  const missing = replyThreadIds.filter((id) => !listed.has(id)).slice(0, MAX_EXTRA_SUMMARIES)
  const extraSummaries = (await Promise.all(missing.map((id) => within(bridge.readThreadSummary(id), null, 1_500)))).filter(Boolean)
  return {
    threadSummaries,
    extraSummaries,
    titles,
    readState,
    activeTurnThreadIds: replyThreadIds,
    backgroundThreadIds: bridge.backgroundThreadIds(),
    pendingRequests: bridge.listPendingServerRequests(),
    history: history.items,
    dismissals: history.dismissals,
    boardSnapshot,
    workspaceRoots,
    pinnedThreadIds,
    nowMs: now,
  }
}

/** The handler as mounted by the production server and the Vite dev server. */
export function createServerVoiceHandler(bridge: VoiceBridgeSources, push: VoicePushSink) {
  return createVoiceCommandHandler({
    collectSnapshot: () => collectVoiceSnapshot(bridge, push),
    transcribe: (audio, contentType) => bridge.transcribe(audio, contentType),
    sendMessage: (threadId, text) => bridge.sendMessage(threadId, text),
    notify: (notification) => push.sendCustomNotification(notification),
  })
}

export type VoiceRouteDeps = {
  collectSnapshot: () => Promise<VoiceSourceSnapshot>
  /** Returns the transcript; throws when transcription is unavailable. */
  transcribe: (audio: Buffer, contentType: string) => Promise<string>
  sendMessage: (threadId: string, text: string) => Promise<void>
  notify: (push: VoicePush) => Promise<{ sent: number; failed: number }>
  env?: () => NodeJS.ProcessEnv
  store?: VoiceResultStore
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function setJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(JSON.stringify(payload))
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new HttpError(413, 'Request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** null when the Shortcut routes are disabled. */
export function configuredShortcutToken(env: NodeJS.ProcessEnv): string | null {
  const token = (env[VOICE_ENV.shortcutToken] ?? '').trim()
  return token.length >= MIN_SHORTCUT_TOKEN_LENGTH ? token : null
}

export function isAuthorizedShortcutRequest(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(header)
  if (!match) return false
  return timingSafeEqual(digest(match[1]), digest(token))
}

/** The transcribe proxy expects the same multipart body the app's mic sends. */
export function toTranscribeMultipart(audio: Buffer, contentType: string): { body: Buffer; contentType: string } {
  if (/^multipart\/form-data/iu.test(contentType)) return { body: audio, contentType }
  const mimeType = /^audio\//iu.test(contentType) ? contentType.split(';')[0].trim() : 'audio/mp4'
  const extension = (mimeType.split('/')[1] ?? 'm4a').replace(/^x-/u, '').replace(/[^a-z0-9]/giu, '') || 'm4a'
  const boundary = `----codexui-voice-${digest(String(Date.now()) + Math.random()).toString('hex').slice(0, 16)}`
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.${extension}"\r\nContent-Type: ${mimeType}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, audio, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

const EMPTY_LIST_SAY: Record<string, string> = {
  needs_you: 'Nothing waiting on you ✓',
  running: 'Nothing running ✓',
  unread: 'Nothing unread ✓',
  recent: 'No recent chats',
}

/** What the notification says and where tapping it goes. Pure, for tests. */
export function buildVoiceNotification(result: VoiceStoredResult): VoicePush {
  const url = voiceResultPath(result, result.code)
  const tag = `voice:${result.code}`
  const first = result.candidates[0]
  const names = result.candidates.slice(0, 2).map((row) => row.title).join(' · ')
  const more = result.candidates.length > 2 ? ` · +${result.candidates.length - 2}` : ''
  switch (result.outcome) {
    case 'open_chat':
      return { title: first ? `${first.projectName} · ${first.title}` : 'Chat', body: 'Tap to open', url, tag }
    case 'empty': {
      const others = result.sections.running.length
      return { title: EMPTY_LIST_SAY[result.listType ?? 'recent'], body: others && result.listType !== 'running' ? `${plural(others, 'chat')} still running` : `Heard: “${result.heard}”`, url, tag }
    }
    case 'picker': {
      if (result.action === 'list_chats' && result.listType) {
        const label = VOICE_LIST_LABELS[result.listType].toLowerCase()
        return { title: `${plural(result.candidates.length, 'chat')} · ${label}`, body: `${names}${more}`, url, tag }
      }
      if (result.message) return { title: 'Send to which chat?', body: `“${result.message}” · tap to choose`, url, tag }
      return { title: `${plural(result.candidates.length, 'possible chat')}`, body: `Tap to choose · “${result.heard}”`, url, tag }
    }
    case 'send_ready':
      return { title: `Ready to send · ${first?.title ?? 'chat'}`, body: `“${result.message}” · tap to review`, url, tag }
    case 'new_chat':
      return {
        title: result.project ? `New ${result.project.label} chat ready` : 'New chat ready · pick a project',
        body: result.message ? `“${result.message}” · tap to start` : 'Tap to start',
        url,
        tag,
      }
    default:
      return { title: "Didn't catch that", body: `Heard: “${result.heard}”`, url, tag }
  }
}

function shortcutSay(result: VoiceStoredResult, push: VoicePush): string {
  return result.outcome === 'not_understood' ? push.title : push.title.replace(/ · /gu, ', ')
}

export function createVoiceCommandHandler(deps: VoiceRouteDeps) {
  const env = deps.env ?? (() => process.env)
  const store = deps.store ?? new VoiceResultStore()
  const log = deps.log ?? ((line: string) => console.info(line))
  const fetchImpl = deps.fetchImpl ?? fetch

  async function readCommandText(req: IncomingMessage): Promise<string> {
    const contentType = String(req.headers['content-type'] ?? '')
    if (/^application\/json/iu.test(contentType)) {
      let payload: unknown
      try {
        payload = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || 'null')
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(400, 'Expected JSON.')
      }
      const text = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).text : undefined
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Expected {"text": "..."}.')
      return text.slice(0, MAX_TEXT_LENGTH)
    }
    const audio = await readBody(req, MAX_AUDIO_BYTES)
    if (audio.length === 0) throw new HttpError(400, 'Expected audio or {"text": "..."}.')
    const multipart = toTranscribeMultipart(audio, contentType || 'application/octet-stream')
    try {
      return (await deps.transcribe(multipart.body, multipart.contentType)).slice(0, MAX_TEXT_LENGTH)
    } catch {
      throw new HttpError(502, 'Transcription failed.')
    }
  }

  async function runCommand(text: string): Promise<{ stored: VoiceStoredResult; trace: VoiceRouteTrace }> {
    const started = performance.now()
    const values = env()
    const snapshot = await deps.collectSnapshot()
    const context = buildVoiceContext(snapshot)
    const { result, trace } = await routeVoiceCommand(text, context, {
      jev: (questions, state) => askJev(questions, state, { apiKey: values[VOICE_ENV.typesafeApiKey]?.trim() ?? '', fetchImpl }),
      extractWithLlm: (kind, transcript) => extractMessageWithLlm(kind, transcript, {
        anthropicApiKey: values[VOICE_ENV.anthropicApiKey]?.trim(),
        anthropicWorkspaceId: values[VOICE_ENV.anthropicWorkspaceId]?.trim(),
        deepseekApiKey: values[VOICE_ENV.deepseekApiKey]?.trim(),
        kimiApiKey: values[VOICE_ENV.kimiApiKey]?.trim(),
      }, fetchImpl),
    })
    const stored = store.save(result)
    // No transcript, titles or message in logs.
    log(`[voice] outcome=${result.outcome}${result.reason ? ` reason=${result.reason}` : ''} jev=${trace.calls.map((call) => `${call.ok ? 'ok' : call.reason}:${call.elapsedMs}ms`).join(',') || 'none'}${trace.extraction ? ` extraction=${trace.extraction}` : ''} total=${Math.round(performance.now() - started)}ms`)
    return { stored, trace }
  }

  async function handleShortcutCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const text = await readCommandText(req)
    const { stored } = await runCommand(text)
    const push = buildVoiceNotification(stored)
    if (stored.outcome === 'send_ready' && stored.threadId && stored.message) {
      const chatTitle = stored.candidates[0]?.title ?? 'this chat'
      const token = store.createConfirmation({ threadId: stored.threadId, message: stored.message, chatTitle, code: stored.code })
      const response: VoiceShortcutResponse = {
        kind: 'confirm',
        say: `Send to ${chatTitle}?`,
        confirm: { question: `Send “${stored.message}” to ${chatTitle}?`, message: stored.message, chatTitle, token },
      }
      setJson(res, 200, response)
      return
    }
    const delivery = await deps.notify(push).catch(() => ({ sent: 0, failed: 1 }))
    const response: VoiceShortcutResponse = {
      kind: 'notified',
      say: delivery.sent > 0 ? shortcutSay(stored, push) : `${shortcutSay(stored, push)} (no device received the notification)`,
    }
    setJson(res, 200, response)
  }

  async function handleShortcutConfirm(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let token: unknown
    try {
      token = (JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || 'null') as Record<string, unknown> | null)?.token
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, 'Expected JSON.')
    }
    const confirmation = typeof token === 'string' && isVoiceCode(token) ? store.takeConfirmation(token) : null
    if (!confirmation) {
      const response: VoiceShortcutResponse = { kind: 'error', say: 'That confirmation has expired. Say it again.' }
      setJson(res, 410, response)
      return
    }
    try {
      await deps.sendMessage(confirmation.threadId, confirmation.message)
    } catch {
      log('[voice] send failed')
      const response: VoiceShortcutResponse = { kind: 'error', say: `Could not send to ${confirmation.chatTitle}.` }
      setJson(res, 502, response)
      return
    }
    log('[voice] sent confirmed message')
    await deps.notify({
      title: `Sent ✓ · ${confirmation.chatTitle}`,
      body: 'Tap to watch',
      url: `/#/thread/${encodeURIComponent(confirmation.threadId)}`,
      tag: `voice:${confirmation.code}`,
    }).catch(() => undefined)
    const response: VoiceShortcutResponse = { kind: 'notified', say: 'Sent ✓' }
    setJson(res, 200, response)
  }

  async function handleAppCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const text = await readCommandText(req)
    const { stored } = await runCommand(text)
    setJson(res, 200, { data: { code: stored.code, url: voiceResultPath(stored, stored.code), result: stored } })
  }

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    // Only the path matters; parse it relative to a fixed origin so "//x" cannot become a host.
    const path = (req.url ?? '/').split('?')[0]
    if (!path.startsWith('/codex-api/voice/')) {
      next()
      return
    }
    const url = new URL(`http://localhost${req.url ?? '/'}`)
    if (!url.pathname.startsWith('/codex-api/voice/')) {
      next()
      return
    }
    void (async () => {
      try {
        if (url.pathname.startsWith(SHORTCUT_PREFIX)) {
          const token = configuredShortcutToken(env())
          if (!token) throw new HttpError(404, 'Voice shortcut is not configured.')
          if (!isAuthorizedShortcutRequest(req, token)) {
            setJson(res, 401, { kind: 'error', say: 'Not authorized.' }, { 'WWW-Authenticate': 'Bearer' })
            return
          }
          if (req.method === 'POST' && url.pathname === `${SHORTCUT_PREFIX}command`) return await handleShortcutCommand(req, res)
          if (req.method === 'POST' && url.pathname === `${SHORTCUT_PREFIX}confirm`) return await handleShortcutConfirm(req, res)
          throw new HttpError(404, 'Unknown voice route.')
        }
        if (req.method === 'POST' && url.pathname === '/codex-api/voice/command') return await handleAppCommand(req, res)
        const code = url.pathname.slice('/codex-api/voice/'.length)
        if (req.method === 'GET' && isVoiceCode(code)) {
          const result = store.get(code)
          if (!result) throw new HttpError(404, 'This voice result has expired.')
          setJson(res, 200, { data: result })
          return
        }
        throw new HttpError(404, 'Unknown voice route.')
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        if (status === 500) log(`[voice] error: ${error instanceof Error ? error.name : 'unknown'}`)
        const message = error instanceof HttpError ? error.message : 'Voice command failed.'
        if (url.pathname.startsWith(SHORTCUT_PREFIX)) setJson(res, status, { kind: 'error', say: message } satisfies VoiceShortcutResponse)
        else setJson(res, status, { error: message })
      }
    })()
  }
}
