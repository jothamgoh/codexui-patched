/**
 * HTTP routes of the CodexUI Watch API (contract: codexui-watch/API.md, v1):
 *   GET  /codex-api/voice/shortcut/watch/feed                  the notification panel's sections
 *   GET  /codex-api/voice/shortcut/watch/chats                 every chat, pinned first, by project
 *   GET  /codex-api/voice/shortcut/watch/ping                       reachability and token check
 *   POST /codex-api/voice/shortcut/watch/transcribe                 audio body in, { text } out
 *   GET  /codex-api/voice/shortcut/watch/chat?id=&before=&limit=   one conversation
 *   POST /codex-api/voice/shortcut/watch/send|stop|answer|read|new
 *   POST /codex-api/voice/shortcut/watch/command                    spoken words in, a plan out; changes nothing
 *   POST /codex-api/voice/shortcut/watch/command/run|cancel         carries out a plan once, or drops it
 *   POST /codex-api/voice/shortcut/watch/summaries                  each chat's latest reply in a sentence or two
 *
 * Cloudflare Access lets service tokens through only under /codex-api/voice/shortcut*,
 * so the routes live there. Every request needs `Authorization: Bearer
 * $CODEXUI_WATCH_TOKEN`, from local and LAN addresses too; without the token
 * configured the routes answer 404. Payloads come from watchMapping.ts and
 * watchCommand.ts.
 */
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, isAbsolute } from 'node:path'
import type { UiThread } from '../../types/codex'
import { isVoiceCode, parseVoiceSettings, type VoiceChatRow } from '../../types/voice'
import { isClaudeThreadId } from '../../utils/chatProvider'
import { activityThreadTitle } from '../../utils/notificationActivity'
import { boardInputs, normalizeSummary, type VoiceSourceSnapshot } from '../voice/voiceContext'
import { routeVoiceCommand } from '../voice/voiceRouter'
import {
  collectVoiceSnapshot,
  collectVoiceSources,
  configuredBearerToken,
  createVoiceRouterDeps,
  HttpError,
  isAuthorizedShortcutRequest,
  readBody,
  resolveDefaultProject,
  setJson,
  toTranscribeMultipart,
  voiceLlmEnv,
  voicePathLabel,
  within,
  type VoiceBridgeSources,
  type VoicePushSink,
  type VoiceSources,
} from '../voice/voiceRoutes'
import { planChoice, planWatchCommand, WatchPlanStore, type PlanInputs, type PlannedCommand, type WatchCommandReply, type WatchPlan } from './watchCommand'
import {
  buildChatList,
  buildChatPage,
  buildFeed,
  buildQuestionReply,
  chatTitleOf,
  isOpenQuestion,
  latestReply,
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
import { SUMMARY_TIMEOUT_MS, SummaryCache, summarizeReply } from './watchSummaries'

export const WATCH_ENV = { token: 'CODEXUI_WATCH_TOKEN' } as const
export const WATCH_PREFIX = '/codex-api/voice/shortcut/watch/'

const MAX_JSON_BYTES = 64 * 1024
/** A watch recording of a minute or two in AAC is well under this. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
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
/** A pinned read's own limit; lists wait at most FIRST_WAIT for one not yet remembered, and refresh after FRESH. */
const PINNED_READ_MS = 5_000
const PINNED_FIRST_WAIT_MS = 300
const PINNED_FRESH_MS = 60_000
const AGENTS: readonly WatchAgent[] = ['claude', 'codex']
const MISSING_CHAT = /not found|no rollout|unknown thread|invalid thread id|does not exist/iu
/** A minute or two of dictation is well under this. */
const MAX_COMMAND_LENGTH = 4_000
const MAX_VISIBLE_CHATS = 50
const MAX_SUMMARY_CHATS = 8
/** The open chat, when it is not in the list, is read within this. */
const SCREEN_CHAT_READ_MS = 2_000

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
  /** Jev, the LLM fallback and the summaries' Claude Haiku calls. */
  fetchImpl?: typeof fetch
  /** Each chat's read and summary together. */
  summaryTimeoutMs?: number
}

/** The chat open on the watch, and the chats on its screen, from a command's `context`. Anything malformed is left out. */
function readScreen(value: unknown): { chatId: string | null; visibleChatIds: string[] } {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const chatId = typeof record.chatId === 'string' ? record.chatId.trim() : ''
  const visible = Array.isArray(record.visibleChatIds) ? record.visibleChatIds : []
  return {
    chatId: chatId && chatId.length <= MAX_ID_LENGTH ? chatId : null,
    visibleChatIds: visible.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH).slice(0, MAX_VISIBLE_CHATS),
  }
}

function readCode(body: Record<string, unknown>): string {
  if (!isVoiceCode(body.code)) throw new HttpError(400, 'Expected "code".')
  return body.code
}

type ChatSummary = { chatId: string; title: string; turnId: string | null; summary: string | null }
type RunOutcome = { chatId: string | null; error: HttpError | null }

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
  const fetchImpl = deps.fetchImpl ?? fetch
  const summaryTimeoutMs = deps.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS
  const plans = new WatchPlanStore(now)
  const summaries = new SummaryCache()

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
  // Old pinned chats are read one by one, and an unloaded one can take seconds
  // or never answer, so their summaries are remembered like working lines.
  const rememberedPinned = new Map<string, { summary: unknown; atMs: number }>()
  const pinnedReads = new Map<string, Promise<unknown>>()

  function refreshPinned(id: string): Promise<unknown> {
    const inFlight = pinnedReads.get(id)
    if (inFlight) return inFlight
    const read = within(bridge.readThreadSummary(id), null, PINNED_READ_MS)
      .then((summary) => {
        rememberedPinned.set(id, { summary, atMs: now() })
        return summary
      })
      .catch(() => null)
      .finally(() => pinnedReads.delete(id))
    pinnedReads.set(id, read)
    return read
  }

  async function listSnapshot(): Promise<VoiceSourceSnapshot> {
    const snapshot = await collectVoiceSnapshot(bridge, push, now())
    const listed = new Set([...snapshot.threadSummaries, ...(snapshot.extraSummaries ?? [])].map(idOf))
    const missing = (snapshot.pinnedThreadIds ?? []).filter((id) => !listed.has(id)).slice(0, PINNED_READS)
    for (const id of rememberedPinned.keys()) if (!missing.includes(id)) rememberedPinned.delete(id)
    if (missing.length === 0) return snapshot
    const pinned = (await Promise.all(missing.map(async (id) => {
      const remembered = rememberedPinned.get(id)
      if (remembered) {
        if (now() - remembered.atMs >= PINNED_FRESH_MS) void refreshPinned(id)
        return remembered.summary
      }
      return within(refreshPinned(id), null, PINNED_FIRST_WAIT_MS)
    }))).filter(Boolean)
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

  /** Words from a watch recording, through the same transcriber as the web app's mic. Never logged. */
  async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const audio = await readBody(req, MAX_AUDIO_BYTES)
    if (audio.length === 0) throw new HttpError(400, 'Expected audio.')
    const multipart = toTranscribeMultipart(audio, String(req.headers['content-type'] ?? '') || 'audio/mp4')
    let text: string
    try {
      text = await bridge.transcribe(multipart.body, multipart.contentType)
    } catch {
      throw new HttpError(502, 'Transcription failed.')
    }
    setJson(res, 200, { text: text.trim().slice(0, MAX_TEXT_LENGTH) })
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

  /** The chat open on the watch as the router sees chats; null when it cannot be read. */
  async function screenChat(chatId: string, activity: WatchActivity, titles: Record<string, string>): Promise<VoiceChatRow | null> {
    const listed = activity.rows.find((row) => row.threadId === chatId)
    if (listed) return listed
    const thread = normalizeSummary(await within(bridge.readThreadSummary(chatId), null, SCREEN_CHAT_READ_MS))
    if (!thread) return null
    return {
      threadId: thread.id,
      title: activityThreadTitle(titles[thread.id] ? { ...thread, title: titles[thread.id] } : thread),
      projectName: activity.labels[thread.cwd] || thread.projectName,
      agent: isClaudeThreadId(thread.id) ? 'claude' : 'codex',
      status: 'recent',
      updatedAtIso: thread.updatedAtIso || thread.createdAtIso,
      summary: '',
    }
  }

  /**
   * Spoken words in, a plan out, through the iPhone's voice router with what the
   * watch shows. Changes nothing: send, new and stop plans get a code for
   * command/run. The words are never logged.
   */
  async function handleCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now()
    const body = await readJson(req)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new HttpError(400, 'Expected "text".')
    if (text.length > MAX_COMMAND_LENGTH) throw new HttpError(413, 'The command is too long.')
    const screen = readScreen(body.context)
    const values = env()
    const [snapshot, settings] = await Promise.all([listSnapshot(), within(bridge.readVoiceSettings(), null)])
    const activity = readWatchActivity(snapshot)
    const workingLines = new Map([...rememberedLines].map(([id, remembered]) => [id, remembered.line]))
    const inputs: PlanInputs = { activity, workingLines, boardChatIds: new Set(boardInputs(snapshot.boardSnapshot).boardThreadIds) }
    const openChat = screen.chatId ? await screenChat(screen.chatId, activity, snapshot.titles) : null
    // A tap on a choice comes back as the same words with that chat open: no second routing.
    const choice = openChat ? plans.takeChoice(text, openChat.threadId) : null
    let planned: PlannedCommand
    let path = 'choice'
    if (choice && openChat) {
      planned = planChoice(choice, openChat, inputs)
    } else {
      const context = { ...activity.context, defaultProject: resolveDefaultProject(parseVoiceSettings(settings), values, activity.context.projects) }
      const { result, trace } = await routeVoiceCommand(text, context, createVoiceRouterDeps(values, fetchImpl), {
        openChat,
        visibleChatIds: screen.visibleChatIds,
        chatActions: true,
      })
      planned = planWatchCommand(result, inputs)
      path = `${voicePathLabel(trace)} outcome=${result.outcome}`
    }
    if (planned.choice) plans.remember(text, planned.choice)
    const code = planned.plan ? plans.save(planned.plan) : null
    log(`[watch] command kind=${planned.reply.kind} path=${path} total=${String(Math.round(performance.now() - started))}ms`)
    setJson(res, 200, { code, ...planned.reply } satisfies WatchCommandReply)
  }

  async function attempt(work: () => Promise<string | null>): Promise<RunOutcome> {
    try {
      return { chatId: await work(), error: null }
    } catch (error) {
      return { chatId: null, error: error instanceof HttpError ? error : backendError(error) }
    }
  }

  /** Sends go through the composer path (steering a running reply), stops interrupt each running turn, new chats are Claude. */
  async function runPlan(plan: WatchPlan, localPort: number | undefined): Promise<RunOutcome[]> {
    if (plan.kind === 'send') {
      return Promise.all(plan.chatIds.map((chatId) => attempt(async () => {
        if (await bridge.isBoardManagedChat(chatId)) throw new HttpError(409, 'A project board runs this chat. Continue it in CodexUI.')
        await bridge.sendComposerMessage(chatId, plan.text, localPort)
        return chatId
      })))
    }
    if (plan.kind === 'stop') {
      return Promise.all(plan.chatIds.map((chatId) => attempt(async () => {
        const last = turnsOf(await readChat(chatId)).at(-1)
        const turnId = typeof last?.id === 'string' ? last.id : ''
        if (!last || !turnId || readTurnStatus(last.status) !== 'inProgress') return null
        await bridge.interruptTurn(chatId, turnId)
        return chatId
      })))
    }
    // One at a time, as the voice route starts them.
    const outcomes: RunOutcome[] = []
    for (const { cwd, text } of plan.chats) outcomes.push(await attempt(async () => (await bridge.startChat({ cwd, agent: 'claude', message: text })).threadId))
    return outcomes
  }

  /** Carries out a plan exactly once: the code is spent before anything runs. */
  async function handleCommandRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const plan = plans.take(readCode(await readJson(req)))
    if (!plan) throw new HttpError(404, 'That plan has expired, was cancelled or has already run.')
    const outcomes = await runPlan(plan, req.socket.localPort)
    const chatIds = outcomes.flatMap((outcome) => (outcome.chatId ? [outcome.chatId] : []))
    const failed = outcomes.filter((outcome) => outcome.error)
    log(`[watch] command ran kind=${plan.kind} targets=${String(outcomes.length)} done=${String(chatIds.length)} failed=${String(failed.length)}`)
    const [first] = failed
    if (chatIds.length === 0 && first?.error) throw first.error
    setJson(res, 200, { ok: true, chatIds })
  }

  async function handleCommandCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const state = plans.cancel(readCode(await readJson(req)))
    if (state === 'unknown') throw new HttpError(404, 'That plan has expired.')
    if (state === 'ran') throw new HttpError(409, 'That plan has already run.')
    log('[watch] command cancelled')
    setJson(res, 200, { ok: true })
  }

  /** One chat's latest reply, summarized within the time; the title even when there is no summary. */
  async function summarizeChat(chatId: string, sources: VoiceSources, counts: Record<'summarized' | 'cached' | 'none', number>): Promise<ChatSummary> {
    const deadline = performance.now() + summaryTimeoutMs
    const thread = await within(bridge.readThread(chatId), null, summaryTimeoutMs)
    if (!thread) {
      counts.none += 1
      return { chatId, title: '', turnId: null, summary: null }
    }
    const { turns: _turns, ...listed } = thread
    const title = chatTitleOf(thread, readWatchActivity({ ...sources, threadSummaries: [listed], extraSummaries: [] }))
    const reply = latestReply(thread)
    if (!reply) {
      counts.none += 1
      return { chatId, title, turnId: null, summary: null }
    }
    const left = () => Math.max(0, deadline - performance.now())
    const llmEnv = voiceLlmEnv(env())
    const { summary, cached } = summaries.get(chatId, reply.turnId, reply.text, () => summarizeReply({ title, reply: reply.text }, llmEnv, fetchImpl, left()))
    const text = await within(summary, null, left())
    counts[text === null ? 'none' : cached ? 'cached' : 'summarized'] += 1
    return { chatId, title, turnId: reply.turnId, summary: text }
  }

  /** On demand only: nothing is summarized when a reply finishes. Neither replies nor summaries are logged. */
  async function handleSummaries(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now()
    const ids = (await readJson(req)).chatIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SUMMARY_CHATS
      || !ids.every((id) => typeof id === 'string' && id.trim() && id.length <= MAX_ID_LENGTH)) {
      throw new HttpError(400, `Expected "chatIds": 1 to ${String(MAX_SUMMARY_CHATS)} chat ids.`)
    }
    const chatIds = [...new Set((ids as string[]).map((id) => id.trim()))]
    const sources = await collectVoiceSources(bridge, push, now())
    const counts = { summarized: 0, cached: 0, none: 0 }
    const entries = await Promise.all(chatIds.map((chatId) => summarizeChat(chatId, sources, counts)))
    log(`[watch] summaries chats=${String(chatIds.length)} summarized=${String(counts.summarized)} cached=${String(counts.cached)} none=${String(counts.none)} total=${String(Math.round(performance.now() - started))}ms`)
    setJson(res, 200, { summaries: entries })
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
          case 'GET ping': return setJson(res, 200, { ok: true })
          case 'GET feed': return await handleFeed(res)
          case 'GET chats': return await handleChats(res)
          case 'GET chat': return await handleChat(url, res)
          case 'POST transcribe': return await handleTranscribe(req, res)
          case 'POST send': return await handleSend(req, res)
          case 'POST stop': return await handleStop(req, res)
          case 'POST answer': return await handleAnswer(req, res)
          case 'POST read': return await handleRead(req, res)
          case 'POST new': return await handleNew(req, res)
          case 'POST command': return await handleCommand(req, res)
          case 'POST command/run': return await handleCommandRun(req, res)
          case 'POST command/cancel': return await handleCommandCancel(req, res)
          case 'POST summaries': return await handleSummaries(req, res)
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
