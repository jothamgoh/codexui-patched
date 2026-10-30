/**
 * HTTP routes of the CodexUI Watch API (contract: codexui-watch/API.md, v1):
 *   GET  /codex-api/voice/shortcut/watch/feed                  the notification panel's sections
 *   GET  /codex-api/voice/shortcut/watch/chats                 every chat, pinned first, by project
 *   GET  /codex-api/voice/shortcut/watch/chat?id=&before=&limit=   one conversation
 *   POST /codex-api/voice/shortcut/watch/send|stop|answer|read|new
 *
 * Cloudflare Access lets service tokens through only under /codex-api/voice/shortcut*,
 * so the routes live there. Every request needs `Authorization: Bearer
 * $CODEXUI_WATCH_TOKEN`, from local and LAN addresses too; without the token
 * configured the routes answer 404. Payloads come from watchMapping.ts.
 */
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, isAbsolute } from 'node:path'
import type { UiThread } from '../../types/codex'
import { normalizeSummary, type VoiceSourceSnapshot } from '../voice/voiceContext'
import {
  collectVoiceSnapshot,
  collectVoiceSources,
  configuredBearerToken,
  HttpError,
  isAuthorizedShortcutRequest,
  readBody,
  setJson,
  within,
  type VoiceBridgeSources,
  type VoicePushSink,
} from '../voice/voiceRoutes'
import {
  buildChatList,
  buildChatPage,
  buildFeed,
  buildQuestionReply,
  isOpenQuestion,
  projectChoices,
  readTurnStatus,
  readWatchActivity,
  resolveProject,
  runningChatIds,
  runningLine,
  turnsOf,
  type WatchActivity,
  type WatchAgent,
} from './watchMapping'

export const WATCH_ENV = { token: 'CODEXUI_WATCH_TOKEN' } as const
export const WATCH_PREFIX = '/codex-api/voice/shortcut/watch/'

const MAX_JSON_BYTES = 64 * 1024
const MAX_TEXT_LENGTH = 20_000
const MAX_ID_LENGTH = 200
/** A list reads the turns of at most this many running chats for their working line, each within the time. */
const RUNNING_READS = 8
const RUNNING_READ_MS = 2_000
/**
 * Reading a long chat takes about a second, so lists show a working line
 * remembered from an earlier read and refresh it in the background once it
 * is older than FRESH_MS. A chat with no remembered line holds the list for
 * at most FIRST_WAIT_MS, then shows the generic line.
 */
const WORKING_LINE_FRESH_MS = 3_000
const WORKING_LINE_FIRST_WAIT_MS = 400
/** Pinned chats missing from the chat list are read one by one, as the panel does. */
const PINNED_READS = 8
const AGENTS: readonly WatchAgent[] = ['claude', 'codex']
const MISSING_CHAT = /not found|no rollout|unknown thread|invalid thread id|does not exist/iu

/** What the bridge exposes for the watch (codexAppServerBridge.ts), on top of the voice sources. */
export type WatchBridgeSources = VoiceBridgeSources & {
  /** thread/read with turns. Throws for a chat that does not exist. */
  readThread: (threadId: string) => Promise<Record<string, unknown> | null>
  isBoardManagedChat: (threadId: string) => Promise<boolean>
  /** The composer's send: resume the chat, then turn/start, which steers a reply that is running. */
  sendComposerMessage: (threadId: string, text: string, localPort?: number) => Promise<void>
  interruptTurn: (threadId: string, turnId: string) => Promise<void>
  respondToServerRequest: (payload: unknown) => Promise<void>
  /** Saves the chat as read up to `readAtIso` and tells every open client. */
  markThreadRead: (threadId: string, readAtIso: string) => Promise<void>
}

export type WatchPushSink = Pick<VoicePushSink, 'readHistory'> & {
  markHistoryRead: (selection: { threadId: string }) => Promise<unknown>
}

export type WatchRouteDeps = {
  bridge: WatchBridgeSources
  push: WatchPushSink
  env?: () => NodeJS.ProcessEnv
  now?: () => number
  /** For a new chat in a folder no listed chat uses yet. */
  isDirectory?: (path: string) => Promise<boolean>
  log?: (line: string) => void
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** The agent's own words, for a failure the user can act on. */
function backendError(error: unknown): HttpError {
  const message = error instanceof Error ? oneLine(error.message) : ''
  return new HttpError(502, message ? message.slice(0, 300) : 'The agent did not answer.')
}

function idOf(summary: unknown): string {
  const id = summary && typeof summary === 'object' ? (summary as Record<string, unknown>).id : ''
  return typeof id === 'string' ? id : ''
}

function readChatId(body: Record<string, unknown>): string {
  const id = typeof body.chatId === 'string' ? body.chatId.trim() : ''
  if (!id || id.length > MAX_ID_LENGTH) throw new HttpError(400, 'Expected "chatId".')
  return id
}

function readText(body: Record<string, unknown>): string {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new HttpError(400, 'Expected "text".')
  if (text.length > MAX_TEXT_LENGTH) throw new HttpError(413, 'The message is too long.')
  return text
}

export function createWatchHandler(deps: WatchRouteDeps) {
  const { bridge, push } = deps
  const env = deps.env ?? (() => process.env)
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.info(line))
  const isDirectory = deps.isDirectory ?? (async (path: string) => (await stat(path)).isDirectory())

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let payload: unknown
    try {
      payload = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || 'null')
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, 'Expected JSON.')
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'Expected a JSON object.')
    return payload as Record<string, unknown>
  }

  async function readChat(threadId: string): Promise<Record<string, unknown>> {
    let thread: Record<string, unknown> | null
    try {
      thread = await bridge.readThread(threadId)
    } catch (error) {
      throw error instanceof Error && MISSING_CHAT.test(error.message) ? new HttpError(404, 'Unknown chat.') : backendError(error)
    }
    if (!thread) throw new HttpError(404, 'Unknown chat.')
    return thread
  }

  async function readChatSummary(threadId: string): Promise<UiThread> {
    let summary: unknown
    try {
      summary = await bridge.readThreadSummary(threadId)
    } catch (error) {
      throw error instanceof Error && MISSING_CHAT.test(error.message) ? new HttpError(404, 'Unknown chat.') : backendError(error)
    }
    const thread = normalizeSummary(summary)
    if (!thread) throw new HttpError(404, 'Unknown chat.')
    return thread
  }

  /** The voice inbox's snapshot, plus pinned chats missing from the list, which the panel reads too. */
  async function listSnapshot(): Promise<VoiceSourceSnapshot> {
    const snapshot = await collectVoiceSnapshot(bridge, push, now())
    const listed = new Set([...snapshot.threadSummaries, ...(snapshot.extraSummaries ?? [])].map(idOf))
    const missing = (snapshot.pinnedThreadIds ?? []).filter((id) => !listed.has(id)).slice(0, PINNED_READS)
    if (missing.length === 0) return snapshot
    const pinned = (await Promise.all(missing.map((id) => within(bridge.readThreadSummary(id), null, 1_500)))).filter(Boolean)
    return { ...snapshot, extraSummaries: [...(snapshot.extraSummaries ?? []), ...pinned] }
  }

  const rememberedLines = new Map<string, { line: string; atMs: number }>()
  const lineReads = new Map<string, Promise<string | null>>()

  function refreshWorkingLine(id: string, activity: WatchActivity): Promise<string | null> {
    const inFlight = lineReads.get(id)
    if (inFlight) return inFlight
    const read = within(bridge.readThread(id), null, RUNNING_READ_MS)
      .then((thread) => {
        if (!thread) return null
        const line = runningLine(thread, activity.threads.get(id))
        rememberedLines.set(id, { line, atMs: now() })
        return line
      })
      .catch(() => null)
      .finally(() => lineReads.delete(id))
    lineReads.set(id, read)
    return read
  }

  async function readWorkingLines(activity: WatchActivity): Promise<Map<string, string>> {
    const ids = runningChatIds(activity).slice(0, RUNNING_READS)
    for (const id of rememberedLines.keys()) if (!ids.includes(id)) rememberedLines.delete(id)
    const lines = new Map<string, string>()
    await Promise.all(ids.map(async (id) => {
      const remembered = rememberedLines.get(id)
      if (remembered) {
        lines.set(id, remembered.line)
        if (now() - remembered.atMs >= WORKING_LINE_FRESH_MS) void refreshWorkingLine(id, activity)
        return
      }
      const line = await within(refreshWorkingLine(id, activity), null, WORKING_LINE_FIRST_WAIT_MS)
      if (line) lines.set(id, line)
    }))
    return lines
  }

  async function handleFeed(res: ServerResponse): Promise<void> {
    const activity = readWatchActivity(await listSnapshot())
    setJson(res, 200, buildFeed(activity, await readWorkingLines(activity), new Date(now()).toISOString()))
  }

  async function handleChats(res: ServerResponse): Promise<void> {
    const activity = readWatchActivity(await listSnapshot())
    setJson(res, 200, buildChatList(activity, await readWorkingLines(activity)))
  }

  async function handleChat(url: URL, res: ServerResponse): Promise<void> {
    const id = (url.searchParams.get('id') ?? '').trim()
    if (!id || id.length > MAX_ID_LENGTH) throw new HttpError(400, 'Expected ?id=<chat id>.')
    const rawLimit = url.searchParams.get('limit')
    if (rawLimit !== null && !/^\d{1,4}$/u.test(rawLimit.trim())) throw new HttpError(400, 'limit must be a whole number.')
    const before = url.searchParams.get('before')?.trim() || null
    const [thread, sources] = await Promise.all([readChat(id), collectVoiceSources(bridge, push, now())])
    // The chat's own flags (unread, section) come from the same panel selection as the lists.
    const { turns: _turns, ...summary } = thread
    const activity = readWatchActivity({ ...sources, threadSummaries: [summary], extraSummaries: [] })
    const page = buildChatPage({ thread, activity, before, limit: rawLimit === null ? undefined : Number(rawLimit) })
    if (!page) throw new HttpError(404, 'That turn is not in this chat.')
    setJson(res, 200, page)
  }

  async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const chatId = readChatId(body)
    const text = readText(body)
    await readChatSummary(chatId)
    if (await bridge.isBoardManagedChat(chatId)) throw new HttpError(409, 'A project board runs this chat. Continue it in CodexUI.')
    const mode = bridge.replyThreadIds().includes(chatId) ? 'steered' : 'sent'
    try {
      await bridge.sendComposerMessage(chatId, text, req.socket.localPort)
    } catch (error) {
      throw backendError(error)
    }
    log(`[watch] message ${mode}`)
    setJson(res, 200, { ok: true, mode })
  }

  async function handleStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chatId = readChatId(await readJson(req))
    const last = turnsOf(await readChat(chatId)).at(-1)
    const turnId = typeof last?.id === 'string' ? last.id : ''
    if (!last || !turnId || readTurnStatus(last.status) !== 'inProgress') {
      setJson(res, 200, { ok: true, idle: true })
      return
    }
    try {
      await bridge.interruptTurn(chatId, turnId)
    } catch (error) {
      throw backendError(error)
    }
    setJson(res, 200, { ok: true })
  }

  async function handleAnswer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const chatId = readChatId(body)
    const requestId = body.requestId
    if (typeof requestId !== 'number' || !Number.isInteger(requestId)) throw new HttpError(400, 'Expected "requestId".')
    const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
      ? body.answers as Record<string, unknown>
      : null
    if (!answers) throw new HttpError(400, 'Expected "answers".')
    const openRequest = () => bridge.listPendingServerRequests().find((request) => request.id === requestId && isOpenQuestion(request, chatId))
    const request = openRequest()
    if (!request) throw new HttpError(409, 'That question is no longer waiting for an answer.')
    const built = buildQuestionReply(request, answers)
    if ('error' in built) throw new HttpError(400, built.error)
    try {
      await bridge.respondToServerRequest(built.reply)
    } catch (error) {
      // Answered elsewhere, timed out or cancelled while this reply was on its way.
      if (!openRequest()) throw new HttpError(409, 'That question is no longer waiting for an answer.')
      throw backendError(error)
    }
    setJson(res, 200, { ok: true })
  }

  async function handleRead(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chatId = readChatId(await readJson(req))
    const thread = await readChatSummary(chatId)
    // What opening a chat from the notification panel saves: read up to its last activity, and its alerts read.
    try {
      await Promise.all([bridge.markThreadRead(chatId, thread.updatedAtIso), push.markHistoryRead({ threadId: chatId })])
    } catch (error) {
      throw backendError(error)
    }
    setJson(res, 200, { ok: true })
  }

  async function handleNew(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const project = typeof body.project === 'string' ? body.project.trim() : ''
    if (!project) throw new HttpError(400, 'Expected "project".')
    const agent = AGENTS.find((value) => value === body.agent)
    if (!agent) throw new HttpError(400, 'Expected "agent": "claude" or "codex".')
    const text = readText(body)
    const activity = readWatchActivity(await listSnapshot())
    let target = resolveProject(project, projectChoices(activity, buildChatList(activity, new Map())))
    if (!target && isAbsolute(project) && await isDirectory(project).catch(() => false)) {
      target = { name: basename(project), cwd: project }
    }
    if (!target) throw new HttpError(400, 'Unknown project. Use a project name from the chat list or a folder path.')
    let chatId: string
    try {
      chatId = (await bridge.startChat({ cwd: target.cwd, agent, message: text })).threadId
    } catch (error) {
      throw backendError(error)
    }
    log(`[watch] started a ${agent} chat`)
    setJson(res, 200, { ok: true, chatId })
  }

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!(req.url ?? '/').split('?')[0].startsWith(WATCH_PREFIX)) {
      next()
      return
    }
    // Parse against a fixed origin, so "//x" cannot become a host.
    const url = new URL(`http://localhost${req.url ?? '/'}`)
    if (!url.pathname.startsWith(WATCH_PREFIX)) {
      next()
      return
    }
    const route = `${req.method ?? 'GET'} ${url.pathname.slice(WATCH_PREFIX.length)}`
    void (async () => {
      try {
        const token = configuredBearerToken(env(), WATCH_ENV.token)
        if (!token) throw new HttpError(404, 'The watch API is not configured.')
        if (!isAuthorizedShortcutRequest(req, token)) {
          setJson(res, 401, { error: 'Not authorized.' }, { 'WWW-Authenticate': 'Bearer' })
          return
        }
        switch (route) {
          case 'GET feed': return await handleFeed(res)
          case 'GET chats': return await handleChats(res)
          case 'GET chat': return await handleChat(url, res)
          case 'POST send': return await handleSend(req, res)
          case 'POST stop': return await handleStop(req, res)
          case 'POST answer': return await handleAnswer(req, res)
          case 'POST read': return await handleRead(req, res)
          case 'POST new': return await handleNew(req, res)
          default: throw new HttpError(404, 'Unknown watch route.')
        }
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        // Never the words or ids, as in the voice log.
        if (status >= 500) log(`[watch] ${route} failed with ${String(status)}`)
        if (!res.headersSent) setJson(res, status, { error: error instanceof HttpError ? error.message : 'The watch request failed.' })
      }
    })()
  }
}

/** The handler as mounted by the production server and the Vite dev server. */
export function createServerWatchHandler(bridge: WatchBridgeSources, push: WatchPushSink) {
  return createWatchHandler({ bridge, push })
}
