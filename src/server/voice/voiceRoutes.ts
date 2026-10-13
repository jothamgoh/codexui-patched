/**
 * HTTP routes for voice commands.
 *
 * Shortcut only, bearer token required (and disabled when the token is unset):
 *   POST /codex-api/voice/shortcut/command   audio body or {"text": "..."}
 *   POST /codex-api/voice/shortcut/confirm   {"token": "..."}
 * PWA, normal session auth only:
 *   GET  /codex-api/voice/<code>             a saved result, with what was sent for it so far
 *   POST /codex-api/voice/command            same router, no push; the app navigates itself.
 *                                            {"text": "...", "dryRun": true} routes without sending
 *   POST /codex-api/voice/<code>/cancel      cancels a send still in its undo window (idempotent)
 *   POST /codex-api/voice/<code>/send        {"threadId"} or {"projectId"}: a tap in a chooser sends
 *   GET|POST /codex-api/voice/settings       auto-send on or off, and the undo window
 *   GET  /codex-api/voice/inbox              the panel's lists, projects and settings; routes nothing
 *
 * Nothing outside /codex-api/voice/shortcut/ looks at the bearer token, and
 * nothing the PWA needs lives under it, so a Cloudflare Access service-token
 * app can cover exactly that prefix.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  DEFAULT_VOICE_SETTINGS,
  describeVoiceStep,
  isVoiceCode,
  parseVoiceSettings,
  voiceProjectPath,
  voiceResultPath,
  VOICE_LIST_LABELS,
  VOICE_SEND_DELAYS,
  type VoiceAgent,
  type VoiceProjectOption,
  type VoiceResult,
  type VoiceSettings,
  type VoiceShortcutResponse,
  type VoiceStepLink,
  type VoiceStoredResult,
} from '../../types/voice'
import type { ProjectBoardSnapshot } from '../../types/projectBoards'
import type { ActivityHistoryItem } from '../../utils/notificationActivity'
import { decideAutoSendAll, type AutoSendDecision } from './voiceAutoSend'
import { VoiceDeliveryQueue, type DeliveryOutcome, type DeliveryTarget, type DeliveryTimers } from './voiceDelivery'
import { askJev } from './jevClient'
import { buildVoiceContext, type VoiceSourceSnapshot } from './voiceContext'
import { decideWithLlm } from './voiceLlmRouter'
import { extractMessageWithLlm, type LlmEnv } from './voiceMessage'
import { allowsShortcutConfirm, routeVoiceCommand, type VoiceRouteTrace } from './voiceRouter'
import { VoiceResultStore } from './voiceStore'

export const VOICE_ENV = {
  shortcutToken: 'CODEXUI_VOICE_SHORTCUT_TOKEN',
  typesafeApiKey: 'CODEXUI_VOICE_TYPESAFE_API_KEY',
  anthropicApiKey: 'CODEXUI_VOICE_ANTHROPIC_API_KEY',
  anthropicWorkspaceId: 'CODEXUI_VOICE_ANTHROPIC_WORKSPACE_ID',
  deepseekApiKey: 'CODEXUI_VOICE_DEEPSEEK_API_KEY',
  kimiApiKey: 'CODEXUI_VOICE_KIMI_API_KEY',
  /** An absolute folder: where a new chat that names no project starts, unless Settings picks one. */
  defaultProject: 'CODEXUI_VOICE_DEFAULT_PROJECT',
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
  startChat: (input: { cwd: string; agent: VoiceAgent | null; message: string }) => Promise<{ threadId: string }>
  readVoiceSettings: () => Promise<unknown>
  writeVoiceSettings: (settings: VoiceSettings) => Promise<void>
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
    startChat: (input) => bridge.startChat(input),
    readSettings: async () => parseVoiceSettings(await bridge.readVoiceSettings()),
    writeSettings: (settings) => bridge.writeVoiceSettings(settings),
    notify: (notification) => push.sendCustomNotification(notification),
  })
}

export type VoiceRouteDeps = {
  collectSnapshot: () => Promise<VoiceSourceSnapshot>
  /** Returns the transcript; throws when transcription is unavailable. */
  transcribe: (audio: Buffer, contentType: string) => Promise<string>
  sendMessage: (threadId: string, text: string) => Promise<void>
  /** Starts a chat in the project folder with the agent (or the default) and sends the first message. */
  startChat: (input: { cwd: string; agent: VoiceAgent | null; message: string }) => Promise<{ threadId: string }>
  readSettings?: () => Promise<VoiceSettings>
  writeSettings?: (settings: VoiceSettings) => Promise<void>
  notify: (push: VoicePush) => Promise<{ sent: number; failed: number }>
  env?: () => NodeJS.ProcessEnv
  store?: VoiceResultStore
  /** For tests: the undo window's clock. */
  deliveryTimers?: DeliveryTimers
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
    case 'steps': {
      const steps = result.steps ?? []
      return { title: `${plural(steps.length, 'step')} · tap to choose`, body: steps.map((step) => describeVoiceStep(step).title).join(' · '), url, tag }
    }
    default:
      return { title: "Didn't catch that", body: `Heard: “${result.heard}”`, url, tag }
  }
}

const quoted = (message: string) => `“${message}”`

/** The sends and new chats a result makes without a tap: the result itself, or each sure step. */
export function planAutoDelivery(result: VoiceResult, stored: VoiceStoredResult, settings: Pick<VoiceSettings, 'autoSend'>): { decisions: AutoSendDecision[]; targets: DeliveryTarget[] } {
  const decisions = decideAutoSendAll(result, settings)
  const parts = result.outcome === 'steps'
    ? (result.steps ?? []).map((step, index) => ({ step, code: stored.steps?.[index]?.code ?? '' }))
    : [{ step: result, code: stored.code }]
  const targets = parts.flatMap(({ step, code }, index): DeliveryTarget[] => {
    const decision = decisions[index]
    if (!decision?.auto || !code) return []
    const message = step.message?.trim() ?? ''
    if (decision.kind === 'send') return [{ kind: 'send', code, threadId: step.threadId!, message, label: step.candidates[0]?.title ?? 'chat' }]
    return [{ kind: 'new_chat', code, cwd: step.project!.id, agent: step.agent ?? null, message, label: step.project!.label }]
  })
  return { decisions, targets }
}

const willDo = (target: DeliveryTarget) => (target.kind === 'send' ? `send to ${target.label}` : `start a new ${target.label} chat`)
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const needYou = (count: number) => `${plural(count, 'step')} ${count === 1 ? 'needs' : 'need'} you`

/** The notification while sends wait for their undo window. Tapping it opens the countdown with Cancel. */
export function buildPendingNotification(stored: VoiceStoredResult, targets: DeliveryTarget[], delaySeconds: number): VoicePush {
  const url = voiceResultPath(stored, stored.code)
  const tag = `voice:${stored.code}`
  const only = targets[0]
  if (stored.outcome !== 'steps' && only) {
    const title = only.kind === 'send' ? `Sending to ${only.label} in ${delaySeconds} s · tap to cancel` : `Starting new ${only.label} chat in ${delaySeconds} s · tap to cancel`
    return { title, body: quoted(only.message), url, tag }
  }
  const rest = (stored.steps?.length ?? 0) - targets.length
  return {
    title: `${capitalize(targets.map(willDo).join(' · '))} in ${delaySeconds} s`,
    body: `Tap to cancel${rest > 0 ? ` · ${needYou(rest)}` : ''}`,
    url,
    tag,
  }
}

function settledPart(outcome: DeliveryOutcome): string {
  const { target, state } = outcome
  if (state === 'sent') return target.kind === 'send' ? `sent to ${target.label} ✓` : `started new ${target.label} chat ✓`
  if (state === 'failed') return target.kind === 'send' ? `couldn't send to ${target.label}` : `couldn't start the ${target.label} chat`
  return target.kind === 'send' ? `cancelled ${target.label}` : `cancelled the ${target.label} chat`
}

/**
 * The notification once the window has passed; same tag, so it replaces the
 * countdown. Opens the chat, or what still needs a tap.
 */
export function buildSettledNotification(stored: VoiceStoredResult, outcomes: DeliveryOutcome[]): VoicePush {
  const tag = `voice:${stored.code}`
  const chatPath = (threadId: string) => `/#/thread/${encodeURIComponent(threadId)}`
  if (stored.outcome !== 'steps' && outcomes.length === 1) {
    const [{ target, state, threadId }] = outcomes
    if (state === 'sent' && threadId) {
      return target.kind === 'send'
        ? { title: `Sent ✓ · ${target.label}`, body: quoted(target.message), url: chatPath(threadId), tag }
        : { title: `Started ✓ · new ${target.label} chat`, body: quoted(target.message), url: chatPath(threadId), tag }
    }
    const retry = voiceResultPath(stored, stored.code)
    return target.kind === 'send'
      ? { title: `Couldn't send to ${target.label}`, body: `Tap to send it yourself · ${quoted(target.message)}`, url: retry, tag }
      : { title: `Couldn't start the ${target.label} chat`, body: `Tap to start it yourself · ${quoted(target.message)}`, url: retry, tag }
  }
  const title = capitalize(outcomes.map(settledPart).join(' · '))
  const delivered = new Set(outcomes.filter((outcome) => outcome.state === 'sent').map((outcome) => outcome.target.code))
  const remaining: VoiceStepLink[] = (stored.steps ?? []).filter((step) => !delivered.has(step.code))
  const lastChat = [...outcomes].reverse().find((outcome) => outcome.state === 'sent' && outcome.threadId)?.threadId
  if (remaining.length === 0 && lastChat) return { title, body: 'Tap to open', url: chatPath(lastChat), tag }
  // A chat to open needs the phone; when it is all that is left, the notification opens it.
  const [only] = remaining
  if (remaining.length === 1 && only.outcome === 'open_chat' && only.candidates[0]) {
    return { title, body: `Tap to open ${only.candidates[0].title}`, url: only.url, tag }
  }
  return { title, body: `${needYou(remaining.length)} · tap to choose`, url: voiceResultPath(stored, stored.code), tag }
}

/**
 * The project a new chat starts in when the command names none: the one picked
 * in Settings, else CODEXUI_VOICE_DEFAULT_PROJECT, else none (the chooser).
 */
export function resolveDefaultProject(settings: VoiceSettings, env: NodeJS.ProcessEnv, projects: VoiceProjectOption[]): VoiceProjectOption | null {
  const path = settings.defaultProject || voiceProjectPath(env[VOICE_ENV.defaultProject])
  if (!path) return null
  const trimmed = path.replace(/\/+$/u, '') || '/'
  return projects.find((project) => project.id === path || project.id === trimmed) ?? { id: trimmed, label: trimmed.split('/').filter(Boolean).at(-1) ?? trimmed }
}

function shortcutSay(result: VoiceStoredResult, push: VoicePush): string {
  return result.outcome === 'not_understood' ? push.title : push.title.replace(/ · /gu, ', ')
}

export function voicePathLabel(trace: VoiceRouteTrace): string {
  return trace.path === 'llm' ? `llm:${trace.fallback?.provider ?? 'unknown'}` : trace.path ?? 'none'
}

/** Who decided, what came out and how long it took. Never the transcript, titles or message. */
export function voiceLogLine(result: VoiceResult, trace: VoiceRouteTrace, totalMs: number): string {
  const path = voicePathLabel(trace)
  const jev = trace.calls.map((call) => `${call.ok ? 'ok' : call.reason}:${call.elapsedMs}ms`).join(',') || 'none'
  const fallback = trace.fallback ? ` fallback=${trace.fallback.reason} llm=${trace.fallback.ok ? 'ok' : 'failed'}:${trace.fallback.elapsedMs}ms` : ''
  const steps = result.steps ? ` steps=${result.steps.length}` : ''
  return `[voice] path=${path} outcome=${result.outcome}${result.reason ? ` reason=${result.reason}` : ''}${steps} jev=${jev}${fallback}${trace.extraction ? ` extraction=${trace.extraction}` : ''} total=${totalMs}ms`
}

export function createVoiceCommandHandler(deps: VoiceRouteDeps) {
  const env = deps.env ?? (() => process.env)
  const store = deps.store ?? new VoiceResultStore()
  const log = deps.log ?? ((line: string) => console.info(line))
  const fetchImpl = deps.fetchImpl ?? fetch
  let memorySettings: VoiceSettings = DEFAULT_VOICE_SETTINGS
  const readSettings = deps.readSettings ?? (async () => memorySettings)
  const writeSettings = deps.writeSettings ?? (async (settings: VoiceSettings) => { memorySettings = settings })
  const queue = new VoiceDeliveryQueue({ store, sendMessage: deps.sendMessage, startChat: deps.startChat, log, timers: deps.deliveryTimers })

  async function currentSettings(): Promise<VoiceSettings> {
    try {
      return parseVoiceSettings(await readSettings())
    } catch {
      return DEFAULT_VOICE_SETTINGS
    }
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let payload: unknown
    try {
      payload = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || 'null')
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, 'Expected JSON.')
    }
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  }

  /** The words to route, and whether the caller only wants to see the decision (`dryRun`). */
  async function readCommand(req: IncomingMessage): Promise<{ text: string; dryRun: boolean }> {
    const contentType = String(req.headers['content-type'] ?? '')
    if (/^application\/json/iu.test(contentType)) {
      const payload = await readJson(req)
      const text = payload.text
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Expected {"text": "..."}.')
      return { text: text.slice(0, MAX_TEXT_LENGTH), dryRun: payload.dryRun === true }
    }
    const audio = await readBody(req, MAX_AUDIO_BYTES)
    if (audio.length === 0) throw new HttpError(400, 'Expected audio or {"text": "..."}.')
    const multipart = toTranscribeMultipart(audio, contentType || 'application/octet-stream')
    try {
      return { text: (await deps.transcribe(multipart.body, multipart.contentType)).slice(0, MAX_TEXT_LENGTH), dryRun: false }
    } catch {
      throw new HttpError(502, 'Transcription failed.')
    }
  }

  type CommandRun = { result: VoiceResult; stored: VoiceStoredResult; trace: VoiceRouteTrace; totalMs: number; settings: VoiceSettings; plan: ReturnType<typeof planAutoDelivery> }

  /** A dry run judges auto-send as if it were on, so the live test measures the rule itself. */
  async function runCommand(text: string, options: { dryRun?: boolean } = {}): Promise<CommandRun> {
    const started = performance.now()
    const values = env()
    const [snapshot, settings] = await Promise.all([deps.collectSnapshot(), currentSettings()])
    const listed = buildVoiceContext(snapshot)
    const context = { ...listed, defaultProject: resolveDefaultProject(settings, values, listed.projects) }
    const llmEnv: LlmEnv = {
      anthropicApiKey: values[VOICE_ENV.anthropicApiKey]?.trim(),
      anthropicWorkspaceId: values[VOICE_ENV.anthropicWorkspaceId]?.trim(),
      deepseekApiKey: values[VOICE_ENV.deepseekApiKey]?.trim(),
      kimiApiKey: values[VOICE_ENV.kimiApiKey]?.trim(),
    }
    const { result, trace } = await routeVoiceCommand(text, context, {
      jev: (questions, state) => askJev(questions, state, { apiKey: values[VOICE_ENV.typesafeApiKey]?.trim() ?? '', fetchImpl }),
      extractWithLlm: (kind, transcript) => extractMessageWithLlm(kind, transcript, llmEnv, fetchImpl),
      decideWithLlm: (input) => decideWithLlm(input, llmEnv, fetchImpl),
    })
    const stored = store.save(result)
    const plan = planAutoDelivery(result, stored, options.dryRun ? { autoSend: true } : settings)
    const totalMs = Math.round(performance.now() - started)
    log(`${voiceLogLine(result, trace, totalMs)} auto=${autoLabel(plan.decisions)}${options.dryRun ? ' dry_run' : ''}`)
    return { result, stored, trace, totalMs, settings, plan }
  }

  /** Schedules the sure sends of a command. With no undo window they have gone out when this returns. */
  async function startAutoDelivery(run: CommandRun, push: boolean): Promise<{ scheduled: boolean; pending?: VoicePush; settled?: DeliveryOutcome[] }> {
    const { stored, plan, settings } = run
    if (plan.targets.length === 0) return { scheduled: false }
    const onSettled = push ? async (outcomes: DeliveryOutcome[]) => {
      await deps.notify(buildSettledNotification(store.get(stored.code) ?? stored, outcomes)).catch(() => undefined)
    } : undefined
    const settled = await queue.deliver(stored.code, plan.targets, { delaySeconds: settings.delaySeconds, trigger: 'auto', onSettled })
    if (settled) return { scheduled: true, settled }
    return { scheduled: true, pending: buildPendingNotification(store.get(stored.code) ?? stored, plan.targets, settings.delaySeconds) }
  }

  async function handleShortcutCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // By default the Shortcut stays linear: every outcome, including a send, arrives as a
    // notification and the user confirms in the app. `?confirm=shortcut` keeps the in-Shortcut
    // Send/Cancel flow for Shortcuts built for it.
    const confirmInShortcut = new URL(req.url ?? '/', 'http://localhost').searchParams.get('confirm') === 'shortcut'
    let run: CommandRun
    try {
      run = await runCommand((await readCommand(req)).text)
    } catch (error) {
      const say = error instanceof HttpError ? error.message : 'Voice command failed.'
      await deps.notify({ title: "Voice command didn't work", body: say, url: '/#/', tag: 'voice:error' }).catch(() => undefined)
      throw error
    }
    const { stored, trace } = run
    const push = buildVoiceNotification(stored)
    // Only a send Jev itself was sure of is confirmed in the Shortcut; any other send waits in the app.
    if (confirmInShortcut && stored.outcome === 'send_ready' && stored.threadId && stored.message && allowsShortcutConfirm(trace)) {
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
    // A Shortcut built for `?confirm=shortcut` keeps its old flow: nothing is sent without its confirm.
    const auto = confirmInShortcut ? { scheduled: false } as Awaited<ReturnType<typeof startAutoDelivery>> : await startAutoDelivery(run, true)
    if (auto.settled) {
      // Sent at once; the "Sent ✓" notification has gone out.
      const latest = store.get(stored.code) ?? stored
      setJson(res, 200, { kind: 'notified', say: shortcutSay(latest, buildSettledNotification(latest, auto.settled)) } satisfies VoiceShortcutResponse)
      return
    }
    const shown = auto.pending ?? push
    const delivery = await deps.notify(shown).catch(() => ({ sent: 0, failed: 1 }))
    const response: VoiceShortcutResponse = {
      kind: 'notified',
      say: delivery.sent > 0 ? shortcutSay(stored, shown) : `${shortcutSay(stored, shown)} (no device received the notification)`,
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
    const { text, dryRun } = await readCommand(req)
    const run = await runCommand(text, { dryRun })
    // No push: the user is looking at the app, which shows the countdown. The timer is
    // still the server's, so closing the app does not stop the send.
    if (!dryRun) await startAutoDelivery(run, false)
    const { stored, trace, totalMs, plan } = run
    const latest = store.get(stored.code) ?? stored
    // Who decided, how long it took and what would go out without a tap, for the live test
    // (scripts/voice-live-test.mjs).
    const meta = {
      path: voicePathLabel(trace),
      totalMs,
      ...(trace.fallback ? { fallback: trace.fallback.reason } : {}),
      autoSend: plan.decisions.map((decision) => (decision.auto ? decision.kind : `skip:${decision.skip}`)),
      ...(dryRun ? { dryRun: true } : {}),
    }
    setJson(res, 200, { data: { code: stored.code, url: voiceResultPath(latest, stored.code), result: latest, meta } })
  }

  function handleCancel(code: string, res: ServerResponse): void {
    if (!store.get(code)) throw new HttpError(404, 'This voice result has expired.')
    queue.cancel(code)
    setJson(res, 200, { data: store.get(code) })
  }

  /** A tap in a chooser: sends the spoken message to the chosen chat, or starts the chosen project's chat. */
  async function handleTapSend(code: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const result = store.get(code)
    if (!result) throw new HttpError(404, 'This voice result has expired.')
    const body = await readJson(req)
    const state = result.delivery?.state
    // A second tap while it is waiting or after it went out changes nothing.
    if (state === 'pending' || state === 'sending' || state === 'sent') {
      setJson(res, 200, { data: result })
      return
    }
    if (result.draftOnly) throw new HttpError(409, 'You asked for a draft. Open the chat to send it.')
    const message = result.message?.trim() ?? ''
    if (!message) throw new HttpError(409, 'There is no message to send.')
    let target: DeliveryTarget
    if (typeof body.threadId === 'string') {
      const offered = [...result.candidates, ...Object.values(result.sections).flat()]
      const row = offered.find((entry) => entry.threadId === body.threadId)
      if (!row) throw new HttpError(400, 'Choose one of the chats offered.')
      target = { kind: 'send', code, threadId: row.threadId, message, label: row.title }
    } else if (typeof body.projectId === 'string' && result.outcome === 'new_chat') {
      const offered = [result.project, ...(result.projectOptions ?? [])].filter((value): value is NonNullable<typeof value> => Boolean(value))
      const project = offered.find((entry) => entry.id === body.projectId)
      if (!project) throw new HttpError(400, 'Choose one of the projects offered.')
      target = { kind: 'new_chat', code, cwd: project.id, agent: result.agent ?? null, message, label: project.label }
    } else {
      throw new HttpError(400, 'Expected {"threadId": "..."} or {"projectId": "..."}.')
    }
    const settings = await currentSettings()
    await queue.deliver(code, [target], { delaySeconds: settings.delaySeconds, trigger: 'tap' })
    setJson(res, 200, { data: store.get(code) })
  }

  /** The settings, the projects to choose a default from, and the fallback from the environment. */
  async function settingsPayload(settings: VoiceSettings) {
    const projects = buildVoiceContext(await deps.collectSnapshot()).projects
    const fallback = resolveDefaultProject({ ...settings, defaultProject: '' }, env(), projects)
    return { data: settings, projects, fallbackProject: fallback }
  }

  /**
   * What a phone app shows before anyone speaks: the panel's sections (the same lists
   * a spoken "what's unread" answers from), the projects and the settings. No Jev call.
   */
  async function handleInbox(res: ServerResponse): Promise<void> {
    const [snapshot, settings] = await Promise.all([deps.collectSnapshot(), currentSettings()])
    const { sections, projects } = buildVoiceContext(snapshot)
    setJson(res, 200, { data: { sections, projects, settings } })
  }

  async function handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      setJson(res, 200, await settingsPayload(await currentSettings()))
      return
    }
    const body = await readJson(req)
    if ('autoSend' in body && typeof body.autoSend !== 'boolean') throw new HttpError(400, 'autoSend must be true or false.')
    if ('delaySeconds' in body && !(VOICE_SEND_DELAYS as readonly unknown[]).includes(body.delaySeconds)) {
      throw new HttpError(400, `delaySeconds must be one of ${VOICE_SEND_DELAYS.join(', ')}.`)
    }
    if ('defaultProject' in body && body.defaultProject !== '' && !voiceProjectPath(body.defaultProject)) {
      throw new HttpError(400, 'defaultProject must be an absolute folder path, or empty for none.')
    }
    const next = parseVoiceSettings({ ...(await currentSettings()), ...body })
    await writeSettings(next)
    setJson(res, 200, await settingsPayload(next))
  }

  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
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
        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/codex-api/voice/settings') return await handleSettings(req, res)
        if (req.method === 'GET' && url.pathname === '/codex-api/voice/inbox') return await handleInbox(res)
        const [code, verb, ...extra] = url.pathname.slice('/codex-api/voice/'.length).split('/')
        if (req.method === 'POST' && isVoiceCode(code) && extra.length === 0 && verb === 'cancel') return handleCancel(code, res)
        if (req.method === 'POST' && isVoiceCode(code) && extra.length === 0 && verb === 'send') return await handleTapSend(code, req, res)
        if (req.method === 'GET' && isVoiceCode(code) && verb === undefined) {
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
  /** On shutdown: sends still in their undo window are dropped, not sent, and logged. */
  return Object.assign(handler, { dispose: () => queue.dispose(), queue })
}

function autoLabel(decisions: AutoSendDecision[]): string {
  return decisions.map((decision) => (decision.auto ? decision.kind : decision.skip)).join(',') || 'none'
}
