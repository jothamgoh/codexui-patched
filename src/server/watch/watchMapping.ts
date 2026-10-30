/**
 * The CodexUI Watch API's payloads (contract: codexui-watch/API.md, v1), built
 * from what the web app already reads: thread/read turns and items, which Codex
 * chats and Claude chats (claudeBackend.ts) share, and the notification panel's
 * selection as the voice inbox builds it (voiceContext.ts). Pure: no I/O.
 */
import markdownit from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import type { UserInput } from '../../api/appServerDtos'
import { parseUserMessageContent } from '../../api/normalizers/v2'
import {
  readRequestQuestions,
  requestQuestionAnswerValues,
  type RequestQuestion,
  type RequestQuestionAnswer,
} from '../../api/requestUserInput'
import type { UiThread } from '../../types/codex'
import { VOICE_LIST_LABELS, VOICE_LIST_TYPES, type VoiceChatRow, type VoiceListType } from '../../types/voice'
import { isClaudeThreadId } from '../../utils/chatProvider'
import { formatDuration } from '../../utils/conversationMessages'
import { inputRequestSummary, readInputRequestDetail } from '../../utils/inputRequestNotifications'
import { activityThreadTitle } from '../../utils/notificationActivity'
import { compactNotificationText, markdownToNotificationText, removeWritingBlockMarkers } from '../../utils/notificationText'
import { GOAL_CONTINUATION_TAG } from '../claudeTranscript'
import { RESTART_CONTINUE_TEXT } from '../restartResume'
import { buildVoiceContext, flagThreads, normalizeSummary, type VoiceSourceSnapshot } from '../voice/voiceContext'
import type { VoiceContext } from '../voice/voiceRouter'

// ── Contract types ───────────────────────────────────────────────────────

export type WatchAgent = 'claude' | 'codex'
export type ChatState = 'needsYou' | 'running' | 'done' | 'stopped' | 'failed' | 'idle'

export type ChatRow = {
  id: string
  title: string
  project: string
  agent: WatchAgent
  state: ChatState
  unread: boolean
  pinned: boolean
  line: string
  updatedAt: string
}

export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'bullet'; text: string; ordered?: number }
  | { type: 'quote'; text: string }
  | { type: 'code'; lines: number; language?: string; preview: string }
  | { type: 'table'; rows: number; preview: string }

export type TurnStatus = 'completed' | 'inProgress' | 'interrupted' | 'failed'

export type Turn = {
  id: string
  status: TurnStatus
  user: string | null
  userNote: string | null
  reply: Block[]
  steps: string | null
  workedFor: string | null
  error: string | null
}

export type QuestionOption = { label: string; description: string | null }
export type Question = {
  id: string
  header: string | null
  text: string
  multiSelect: boolean
  options: QuestionOption[]
  allowOther: boolean
}
export type PendingQuestion = { requestId: number; questions: Question[] }

export type Feed = {
  generatedAt: string
  summary: { needsYou: number; running: number; unread: number }
  sections: Array<{ id: VoiceListType; title: string; chats: ChatRow[] }>
}

export type ChatList = { pinned: ChatRow[]; projects: Array<{ name: string; cwd: string; chats: ChatRow[] }> }

export type ChatPage = {
  chat: ChatRow
  hasEarlier: boolean
  turns: Turn[]
  working: { line: string; since: string } | null
  backgroundTasks: number
  question: PendingQuestion | null
}

/** The question card's reply (RequestUserInputCard.vue), for Claude and Codex alike. */
export type QuestionReply = { id: number; result: { answers: Record<string, { answers: string[] }> } }

export type PendingRequest = { id: number; method: string; params: unknown }

// ── Limits ───────────────────────────────────────────────────────────────

const RECENT_LIMIT = 10
const PROJECT_CHAT_LIMIT = 25
const DEFAULT_TURN_LIMIT = 4
const MAX_TURN_LIMIT = 20
/** Same length as the voice inbox's one-line summaries. */
const LINE_LENGTH = 160
const MAX_REPLY_BLOCKS = 60
const MAX_BLOCK_TEXT = 2_000
const MAX_PREVIEW = 120
const MAX_USER_TEXT = 2_000
const MAX_ERROR_TEXT = 300
const USER_INPUT_METHOD = 'item/tool/requestUserInput'

// ── Small readers ────────────────────────────────────────────────────────

type RawRecord = Record<string, unknown>

function asRecord(value: unknown): RawRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function records(value: unknown): RawRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is RawRecord => entry !== null) : []
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

function basename(path: string): string {
  return path.replace(/\/+$/u, '').split('/').at(-1) || path
}

function timeOf(iso: string): number {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? time : 0
}

/** Unix seconds, as Codex and Claude turns and threads carry them, to ISO 8601. */
function secondsToIso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null
}

function agentOf(threadId: string): WatchAgent {
  return isClaudeThreadId(threadId) ? 'claude' : 'codex'
}

export function turnsOf(thread: RawRecord): RawRecord[] {
  return records(thread.turns)
}

function itemsOf(turn: RawRecord): RawRecord[] {
  return records(turn.items)
}

export function readTurnStatus(value: unknown): TurnStatus {
  return value === 'inProgress' || value === 'interrupted' || value === 'failed' ? value : 'completed'
}

function backgroundTaskCount(thread: RawRecord): number {
  return Array.isArray(thread.backgroundTasks) ? thread.backgroundTasks.length : 0
}

// ── Markdown to blocks ───────────────────────────────────────────────────

// The default preset parses pipe tables, which the chat renderer also shows.
const markdown = markdownit({ html: true, linkify: false, typographer: false })

/** Inline Markdown stays as written; images are left out, their alt text kept. */
function inlineText(source: string): string {
  return clip(source.replace(/!\[([^\]]*)\]\([^)]*\)/gu, (_match, alt: string) => alt.trim()).trim(), MAX_BLOCK_TEXT)
}

function codeBlock(token: Token): Block {
  const body = token.content.replace(/\n$/u, '')
  const lines = body ? body.split('\n') : []
  const preview = clip((lines.find((line) => line.trim()) ?? '').trim(), MAX_PREVIEW)
  const language = token.type === 'fence' ? token.info.trim().split(/\s+/u)[0] ?? '' : ''
  return language
    ? { type: 'code', lines: lines.length, language, preview }
    : { type: 'code', lines: lines.length, preview }
}

/** Data rows, and the header row as plain text. */
function tableBlock(tokens: Token[]): Block {
  let rows = 0
  let inHead = false
  const header: string[] = []
  for (const token of tokens) {
    if (token.type === 'thead_open') inHead = true
    else if (token.type === 'thead_close') inHead = false
    else if (token.type === 'tr_open' && !inHead) rows += 1
    else if (token.type === 'inline' && inHead) header.push(markdownToNotificationText(token.content))
  }
  return { type: 'table', rows, preview: clip(header.filter(Boolean).join(' · '), MAX_PREVIEW) }
}

/**
 * A reply as blocks for a small screen. Each list item's first paragraph is a
 * bullet (nested lists are flattened); later paragraphs in the item are `p`.
 */
export function markdownToBlocks(source: string): Block[] {
  const tokens = markdown.parse(removeWritingBlockMarkers(source), {})
  const blocks: Block[] = []
  const items: Array<{ level: number; ordered?: number; done: boolean }> = []
  let quoteDepth = 0
  const paragraph = (text: string): Block => (quoteDepth > 0 ? { type: 'quote', text } : { type: 'p', text })
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    switch (token.type) {
      case 'blockquote_open':
        quoteDepth += 1
        break
      case 'blockquote_close':
        quoteDepth -= 1
        break
      case 'list_item_open': {
        const number = Number.parseInt(token.info, 10)
        items.push({ level: token.level, ordered: Number.isFinite(number) ? number : undefined, done: false })
        break
      }
      case 'list_item_close':
        items.pop()
        break
      case 'heading_open': {
        const text = inlineText(tokens[index + 1]?.content ?? '')
        if (text) blocks.push({ type: 'h', text })
        index += 2
        break
      }
      case 'paragraph_open': {
        const text = inlineText(tokens[index + 1]?.content ?? '')
        index += 2
        if (!text) break
        const item = items.at(-1)
        if (item && !item.done && token.level === item.level + 1) {
          item.done = true
          blocks.push(item.ordered === undefined ? { type: 'bullet', text } : { type: 'bullet', text, ordered: item.ordered })
        } else {
          blocks.push(paragraph(text))
        }
        break
      }
      case 'fence':
      case 'code_block':
        blocks.push(codeBlock(token))
        break
      case 'table_open': {
        let end = index
        while (end < tokens.length && tokens[end].type !== 'table_close') end += 1
        blocks.push(tableBlock(tokens.slice(index, end + 1)))
        index = end
        break
      }
      case 'html_block': {
        const text = clip(oneLine(token.content.replace(/<[^>]+>/gu, ' ')), MAX_BLOCK_TEXT)
        if (text) blocks.push(paragraph(text))
        break
      }
      default:
        break
    }
  }
  return blocks.length > MAX_REPLY_BLOCKS
    ? [...blocks.slice(0, MAX_REPLY_BLOCKS), { type: 'p', text: '… The rest is in CodexUI.' }]
    : blocks
}

// ── Turns the chat started itself ────────────────────────────────────────

/** The text both backends send to continue a chat whose usage limit has reset. */
const LIMIT_CONTINUATION_TEXT = 'Continue where you left off. Do not redo work that is already done.'
/** buildTurnsFromChain shows Claude's goal continuation prompt as this. */
const GOAL_CONTINUATION_SHOWN = 'Continue working toward the goal'
const SCHEDULE_WAKEUP_TOOLS = new Set(['ScheduleWakeup', 'Schedule wakeup'])

/**
 * Why a turn started without the user, from its first message's raw text, or
 * null for a message the user wrote. `scheduledPrompts` are the prompts earlier
 * turns handed to ScheduleWakeup, which come back as the wakeup's message.
 */
export function selfStartedNote(raw: string, scheduledPrompts: ReadonlySet<string> = new Set()): string | null {
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('<task-notification>')) return 'Background task finished'
  if (text === RESTART_CONTINUE_TEXT || text.startsWith('Continue where you left off. A restart interrupted this session')) {
    return 'Continued after restart'
  }
  if (text === LIMIT_CONTINUATION_TEXT) return 'Continued after usage limit'
  if (text.startsWith('<<autonomous-loop') || scheduledPrompts.has(text)) return 'Scheduled check'
  if (text.startsWith(GOAL_CONTINUATION_TAG) || text.startsWith('Keep working toward this goal') || text === GOAL_CONTINUATION_SHOWN) {
    return 'Goal step'
  }
  if (text.startsWith('Another Claude session sent a message')) return 'Message from a helper'
  return null
}

function wakeupPrompts(turn: RawRecord): string[] {
  return itemsOf(turn).flatMap((item) => {
    if (item.type !== 'mcpToolCall' || !SCHEDULE_WAKEUP_TOOLS.has(readString(item.tool))) return []
    const prompt = readString(asRecord(item.arguments)?.prompt).trim()
    return prompt ? [prompt] : []
  })
}

/**
 * What the user wrote, without CodexUI's own wrappers: the composer's request
 * marker, and the "# Response annotations" block, of which only the user's
 * comments are kept. `raw` is the text as sent, for self-start detection.
 */
export function readUserMessage(item: RawRecord): { raw: string; words: string } {
  const content = Array.isArray(item.content) ? item.content as UserInput[] : []
  const raw = content.flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
  const parsed = parseUserMessageContent(readString(item.id), content)
  const comments = parsed.responseAnnotations.flatMap((annotation) => (annotation.annotation ? [annotation.annotation] : []))
  const words = [...comments, parsed.text].filter(Boolean).join('\n\n')
    || parsed.responseAnnotations.map((annotation) => `“${clip(oneLine(annotation.text), 80)}”`).join('\n')
    || (parsed.images.length > 0 ? 'Image' : '')
  return { raw, words }
}

// ── Turns ────────────────────────────────────────────────────────────────

/** The turn's answer: its last agent message that is not commentary; while running, only a final answer. */
function replyText(items: RawRecord[], status: TurnStatus): string {
  const messages = items.filter((item) => item.type === 'agentMessage' && readString(item.text).trim())
  if (status === 'inProgress') return readString(messages.filter((item) => item.phase === 'final_answer').at(-1)?.text)
  return readString((messages.filter((item) => item.phase !== 'commentary').at(-1) ?? messages.at(-1))?.text)
}

/** "Worked · 5 commands, 2 edits", or null for a turn that only answered. */
export function stepsSummary(items: RawRecord[], status: TurnStatus = 'completed'): string | null {
  let commands = 0
  let edits = 0
  let searches = 0
  let tools = 0
  const helpers = new Set<string>()
  for (const item of items) {
    switch (item.type) {
      case 'commandExecution':
        commands += 1
        break
      case 'fileChange':
        edits += 1
        break
      case 'webSearch':
        searches += 1
        break
      case 'subAgentActivity':
        helpers.add(readString(item.agentThreadId) || readString(item.id))
        break
      case 'mcpToolCall':
      case 'collabAgentToolCall':
        tools += 1
        break
      case 'dynamicToolCall':
        // The web app hides CodexUI's own scheduled-task tool, so it is not a step here either.
        if (item.tool !== 'automation_update') tools += 1
        break
      default:
        break
    }
  }
  const parts = [
    commands ? plural(commands, 'command') : '',
    edits ? plural(edits, 'edit') : '',
    searches ? plural(searches, 'search', 'searches') : '',
    helpers.size ? plural(helpers.size, 'helper') : '',
    tools ? plural(tools, 'tool call') : '',
  ].filter(Boolean)
  return parts.length > 0 ? `${status === 'inProgress' ? 'Working' : 'Worked'} · ${parts.join(', ')}` : null
}

function workedFor(turn: RawRecord): string | null {
  const started = typeof turn.startedAt === 'number' ? turn.startedAt : null
  const completed = typeof turn.completedAt === 'number' ? turn.completedAt : null
  const durationMs = typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs)
    ? turn.durationMs
    : started !== null && completed !== null ? (completed - started) * 1000 : null
  return durationMs === null || durationMs < 0 ? null : formatDuration(durationMs)
}

function turnError(turn: RawRecord): string | null {
  return clip(oneLine(readString(asRecord(turn.error)?.message)), MAX_ERROR_TEXT) || null
}

function toWatchTurn(turn: RawRecord, scheduledPrompts: ReadonlySet<string> = new Set()): Turn {
  const items = itemsOf(turn)
  const status = readTurnStatus(turn.status)
  let userNote: string | null = null
  let first = true
  const said: string[] = []
  for (const item of items) {
    if (item.type !== 'userMessage') continue
    const message = readUserMessage(item)
    const note = selfStartedNote(message.raw, scheduledPrompts)
    if (first) userNote = note
    first = false
    // A message steered into the turn keeps its words even when the turn started itself.
    if (!note && message.words) said.push(message.words)
  }
  const reply = replyText(items, status)
  return {
    id: readString(turn.id),
    status,
    user: said.length > 0 ? clip(said.join('\n\n'), MAX_USER_TEXT) : null,
    userNote,
    reply: reply ? markdownToBlocks(reply) : [],
    steps: stepsSummary(items, status),
    workedFor: status === 'inProgress' ? null : workedFor(turn),
    error: status === 'failed' ? turnError(turn) : null,
  }
}

/** Turns `start` to `end` (exclusive); earlier turns still feed the ScheduleWakeup prompts. */
export function toWatchTurns(turns: RawRecord[], start = 0, end = turns.length): Turn[] {
  const scheduled = new Set<string>()
  const mapped: Turn[] = []
  for (let index = 0; index < end; index += 1) {
    if (index >= start) mapped.push(toWatchTurn(turns[index], scheduled))
    for (const prompt of wakeupPrompts(turns[index])) scheduled.add(prompt)
  }
  return mapped
}

// ── The plain-words working line ─────────────────────────────────────────

function quoted(text: string, max = 40): string {
  return `“${clip(oneLine(text), max)}”`
}

function gerund(verb: string): string {
  const word = verb.toLowerCase()
  const stem = /[^aeiou]e$/u.test(word)
    ? word.slice(0, -1)
    : /^(?:run|stop|plan|get|set|put|scan|drop|ship|tag|log)$/u.test(word) ? `${word}${word.at(-1) ?? ''}` : word
  return `${stem.charAt(0).toUpperCase()}${stem.slice(1)}ing`
}

function looksLikePath(value: string): boolean {
  return /^\S+$/u.test(value) && (value.includes('/') || /\.[A-Za-z0-9]{1,8}$/u.test(value))
}

/** A shell command as a few words: the program and its first arguments, never the whole line. */
function commandWords(command: string): string {
  let text = command.trim()
  const wrapped = text.match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/u)
  if (wrapped) text = wrapped[2] ?? ''
  const segments = text.split(/\s*(?:&&|\|\||;|\n)\s*/u).map((segment) => segment.trim()).filter(Boolean)
  const main = segments.find((segment) => !/^(?:cd|export|set|source|\.)\s/u.test(segment)) ?? segments[0] ?? ''
  const words = (main.split('|')[0] ?? '').trim().split(/\s+/u).filter(Boolean)
  while (words.length > 1 && /^[A-Za-z_]\w*=/u.test(words[0] ?? '')) words.shift()
  const shown = words.slice(0, 3).map((word) => (word.includes('/') ? basename(word.replace(/^['"]|['"]$/gu, '')) : word))
  return clip(shown.join(' '), 40)
}

function describeCommand(item: RawRecord): string {
  const actions = records(item.commandActions)
  if (actions.length > 0 && actions.every((action) => action.type === 'read')) {
    const names = [...new Set(actions.map((action) => readString(action.name) || basename(readString(action.path))).filter(Boolean))]
    if (names.length === 0) return 'Reading files'
    return names.length === 1 ? `Reading ${names[0]}` : `Reading ${names[0]} and ${plural(names.length - 1, 'more file', 'more files')}`
  }
  const first = actions[0]
  if (first?.type === 'listFiles') return 'Listing files'
  if (first?.type === 'search') return readString(first.query) ? `Searching for ${quoted(readString(first.query))}` : 'Searching files'
  const words = commandWords(readString(first?.command) || readString(item.command))
  return words ? `Running ${words}` : 'Running a command'
}

function describeFileChange(item: RawRecord): string {
  const names = [...new Set(records(item.changes).map((change) => basename(readString(change.path))).filter(Boolean))]
  if (names.length === 0) return 'Editing files'
  return names.length === 1 ? `Editing ${names[0]}` : `Editing ${plural(names.length, 'file')}`
}

function describeWebSearch(item: RawRecord): string {
  const action = asRecord(item.action)
  if (action?.type === 'openPage') {
    try {
      return `Reading ${new URL(readString(action.url)).hostname.replace(/^www\./u, '')}`
    } catch {
      return 'Reading a web page'
    }
  }
  const query = readString(item.query) || readString(action?.query)
  return query ? `Searching the web for ${quoted(query)}` : 'Searching the web'
}

function describeToolCall(item: RawRecord): string {
  const tool = readString(item.tool).trim()
  const server = readString(item.server).trim()
  // Claude's own tools arrive labelled "Read file", "Search files" and so on, their target as the server.
  const label = tool.match(/^([A-Z][a-z]+)(?:\s+(.+))?$/u)
  if (label) {
    const [, verb = '', object = ''] = label
    const target = looksLikePath(server) ? basename(server) : object.toLowerCase()
    return target ? `${gerund(verb)} ${target}` : gerund(verb)
  }
  // A Claude tool without a label keeps its own name, such as CronCreate.
  if (/^(?:[A-Z][a-z]+){2,}$/u.test(tool)) return `Using ${tool.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase()}`
  const name = (server || tool).replace(/[_-]+/gu, ' ').trim()
  return name ? `Using ${name}` : 'Using a tool'
}

function firstSentence(text: string): string {
  const plain = markdownToNotificationText(text)
  const sentence = plain.match(/^(.+?[.!?])(?:\s|$)/u)?.[1] ?? plain
  return clip(sentence, 90)
}

function describeStep(item: RawRecord): string | null {
  switch (item.type) {
    case 'userMessage':
    case 'reasoning':
      return 'Thinking'
    case 'plan':
      return 'Planning'
    case 'agentMessage':
      return item.phase === 'final_answer' ? 'Writing the reply' : firstSentence(readString(item.text)) || 'Writing'
    case 'commandExecution':
      return describeCommand(item)
    case 'fileChange':
      return describeFileChange(item)
    case 'webSearch':
      return describeWebSearch(item)
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return describeToolCall(item)
    case 'subAgentActivity':
    case 'collabAgentToolCall':
      return 'Working with a helper'
    case 'askedQuestions':
      return 'Waiting for your answer'
    case 'contextCompaction':
      return 'Compacting the conversation'
    case 'imageView':
      return 'Looking at an image'
    case 'sleep':
      return 'Waiting'
    default:
      return null
  }
}

/** What a running turn is doing now, in plain words, from its latest step. */
export function workingLine(turn: RawRecord): string {
  const items = itemsOf(turn)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const line = describeStep(items[index])
    if (line) return line
  }
  return 'Thinking'
}

/** A running chat's line: the reply's current step, else its background work. */
export function runningLine(thread: RawRecord | null, flags?: Pick<UiThread, 'inProgress' | 'hasBackgroundTasks'>): string {
  const last = thread ? turnsOf(thread).at(-1) : undefined
  if (last && readTurnStatus(last.status) === 'inProgress') return workingLine(last)
  const background = thread ? backgroundTaskCount(thread) : 0
  if (background > 0) return background === 1 ? 'A background task is running' : `${String(background)} background tasks are running`
  if (flags?.hasBackgroundTasks) return 'Background tasks are running'
  if (flags?.inProgress) return 'Working'
  return 'Helpers are working'
}

// ── Chat rows, the feed and the chat list ────────────────────────────────

/**
 * The panel's view of the chats, as the voice inbox builds it, plus what the
 * rows need: open requests and the latest push-history result per chat.
 */
export type WatchActivity = {
  context: VoiceContext
  threads: Map<string, UiThread>
  /** Every listed chat once: panel sections in order, then the other chats. */
  rows: VoiceChatRow[]
  sectionOf: Map<string, VoiceListType>
  pendingRequests: PendingRequest[]
  /** The first open request of each chat, which the panel shows. */
  requests: Map<string, PendingRequest>
  lastResult: Map<string, { status: string; completedAt: string }>
  pinned: string[]
  labels: Record<string, string>
}

export function readWatchActivity(snapshot: VoiceSourceSnapshot): WatchActivity {
  const context = buildVoiceContext(snapshot)
  const rows: VoiceChatRow[] = []
  const sectionOf = new Map<string, VoiceListType>()
  for (const type of VOICE_LIST_TYPES) {
    for (const row of context.sections[type]) {
      sectionOf.set(row.threadId, type)
      rows.push(row)
    }
  }
  rows.push(...context.otherChats)
  const requests = new Map<string, PendingRequest>()
  for (const request of snapshot.pendingRequests) {
    const threadId = readString(asRecord(request.params)?.threadId)
    if (threadId && !requests.has(threadId)) requests.set(threadId, request)
  }
  const lastResult = new Map<string, { status: string; completedAt: string }>()
  for (const item of snapshot.history) {
    if (item.projectBoard) continue
    const known = lastResult.get(item.threadId)
    if (!known || timeOf(item.completedAt) > timeOf(known.completedAt)) {
      lastResult.set(item.threadId, { status: item.status, completedAt: item.completedAt })
    }
  }
  return {
    context,
    threads: new Map(flagThreads(snapshot).map((thread) => [thread.id, thread])),
    rows,
    sectionOf,
    pendingRequests: snapshot.pendingRequests,
    requests,
    lastResult,
    pinned: snapshot.pinnedThreadIds ?? [],
    labels: snapshot.workspaceRoots.labels,
  }
}

/** Chats whose working line needs their turns read. */
export function runningChatIds(activity: WatchActivity): string[] {
  return activity.context.sections.running.map((row) => row.threadId)
}

function requestLine(request: PendingRequest | undefined): string {
  const asked = request ? readInputRequestDetail(request.method, request.params) : null
  const summary = asked ? oneLine(inputRequestSummary(asked)) : ''
  if (summary) return clip(summary, LINE_LENGTH)
  return asked?.kind === 'approval' ? 'Approval needed' : 'Answer needed'
}

/**
 * A listed chat's row. Lists use what the panel knows without reading each chat:
 * the open request, the running step, else the push history's result and the
 * panel's one-line summary (the reply's first words, or the chat's preview).
 */
function listRow(activity: WatchActivity, row: VoiceChatRow, workingLines: ReadonlyMap<string, string>): ChatRow {
  const id = row.threadId
  const section = activity.sectionOf.get(id)
  const result = activity.lastResult.get(id)
  let state: ChatState
  let line: string
  if (section === 'needs_you') {
    state = 'needsYou'
    line = requestLine(activity.requests.get(id))
  } else if (section === 'running') {
    state = 'running'
    line = workingLines.get(id) ?? runningLine(null, activity.threads.get(id))
  } else {
    state = result?.status === 'failed' ? 'failed' : result || section === 'unread' ? 'done' : 'idle'
    line = row.summary || (state === 'failed' ? 'Failed' : '')
  }
  return {
    id,
    title: row.title,
    project: row.projectName,
    agent: row.agent,
    state,
    unread: section === 'unread',
    pinned: activity.pinned.includes(id),
    line,
    updatedAt: row.updatedAtIso,
  }
}

/** The notification panel's sections, each chat once, in priority order. */
export function buildFeed(activity: WatchActivity, workingLines: ReadonlyMap<string, string>, generatedAt: string): Feed {
  const sections = VOICE_LIST_TYPES.map((id) => {
    const rows = activity.context.sections[id]
    return {
      id,
      title: VOICE_LIST_LABELS[id],
      chats: (id === 'recent' ? rows.slice(0, RECENT_LIMIT) : rows).map((row) => listRow(activity, row, workingLines)),
    }
  })
  const count = (id: VoiceListType) => sections.find((section) => section.id === id)?.chats.length ?? 0
  return {
    generatedAt,
    summary: { needsYou: count('needs_you'), running: count('running'), unread: count('unread') },
    sections,
  }
}

/** Every listed chat: pinned first, then by project, as the sidebar groups them. */
export function buildChatList(activity: WatchActivity, workingLines: ReadonlyMap<string, string>): ChatList {
  const rows = activity.rows.map((row) => listRow(activity, row, workingLines))
  const byId = new Map(rows.map((row) => [row.id, row]))
  const projects = new Map<string, { name: string; cwd: string; chats: ChatRow[] }>()
  // Newest first, so projects are created in the order of their newest chat.
  for (const row of [...rows].sort((left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt))) {
    let project = projects.get(row.project)
    if (!project) {
      const folder = activity.context.projects.find((option) => option.label === row.project)?.id
      project = { name: row.project, cwd: folder ?? activity.threads.get(row.id)?.cwd ?? '', chats: [] }
      projects.set(row.project, project)
    }
    // The sidebar shows pinned chats only in Pinned.
    if (!row.pinned && project.chats.length < PROJECT_CHAT_LIMIT) project.chats.push(row)
  }
  return {
    pinned: activity.pinned.flatMap((id) => byId.get(id) ?? []),
    projects: [...projects.values()],
  }
}

// ── One chat ─────────────────────────────────────────────────────────────

/** The chat's row from its own turns, which also know when a reply stopped or failed. */
function chatRow(thread: RawRecord, turns: RawRecord[], activity: WatchActivity): ChatRow {
  const id = readString(thread.id)
  const listed = activity.rows.find((row) => row.threadId === id)
  const flagged = activity.threads.get(id) ?? normalizeSummary(thread)
  const section = activity.sectionOf.get(id)
  const request = activity.requests.get(id)
  const last = turns.at(-1)
  const status = last ? readTurnStatus(last.status) : null
  let state: ChatState
  let line: string
  if (request) {
    state = 'needsYou'
    line = requestLine(request)
  } else if (status === 'inProgress' || backgroundTaskCount(thread) > 0 || section === 'running' || flagged?.inProgress) {
    state = 'running'
    line = runningLine(thread, flagged ?? undefined)
  } else if (status === 'failed') {
    state = 'failed'
    line = (last && turnError(last)) || 'Failed'
  } else if (status === 'interrupted') {
    state = 'stopped'
    line = 'Stopped'
  } else if (last) {
    state = 'done'
    line = compactNotificationText(replyText(itemsOf(last), 'completed'), 'Done', LINE_LENGTH)
  } else {
    state = 'idle'
    line = clip(oneLine(flagged?.preview ?? ''), LINE_LENGTH)
  }
  return {
    id,
    title: listed?.title ?? (flagged ? activityThreadTitle(flagged) : 'Chat'),
    project: listed?.projectName ?? (flagged ? activity.labels[flagged.cwd] || flagged.projectName : ''),
    agent: agentOf(id),
    state,
    unread: section === 'unread',
    pinned: activity.pinned.includes(id),
    line,
    updatedAt: listed?.updatedAtIso ?? flagged?.updatedAtIso ?? '',
  }
}

function clampTurnLimit(value: unknown): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_TURN_LIMIT
  return Math.min(Math.max(limit, 1), MAX_TURN_LIMIT)
}

/**
 * One conversation: `limit` turns, oldest first, ending at the newest turn or
 * just before `before`. null when `before` is not a turn of this chat.
 */
export function buildChatPage(input: {
  thread: RawRecord
  activity: WatchActivity
  before?: string | null
  limit?: number
}): ChatPage | null {
  const { thread, activity } = input
  const turns = turnsOf(thread)
  const end = input.before ? turns.findIndex((turn) => readString(turn.id) === input.before) : turns.length
  if (end < 0) return null
  const start = Math.max(0, end - clampTurnLimit(input.limit))
  const last = turns.at(-1)
  const working = last && readTurnStatus(last.status) === 'inProgress'
    ? {
        line: workingLine(last),
        since: secondsToIso(last.startedAt) ?? secondsToIso(thread.updatedAt) ?? new Date(activity.context.nowMs).toISOString(),
      }
    : null
  const id = readString(thread.id)
  return {
    chat: chatRow(thread, turns, activity),
    hasEarlier: start > 0,
    turns: toWatchTurns(turns, start, end),
    working,
    backgroundTasks: backgroundTaskCount(thread),
    question: pendingQuestion(activity.pendingRequests, id),
  }
}

// ── Questions ────────────────────────────────────────────────────────────

function toWatchQuestion(question: RequestQuestion): Question {
  return {
    id: question.id,
    header: question.header.trim() || null,
    // The card's own fallbacks.
    text: question.question.trim() || question.header.trim() || 'What would you like to do?',
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({ label: option.label, description: option.description.trim() || null })),
    allowOther: question.isOther || question.options.length === 0,
  }
}

/** The chat's open question (Claude's AskUserQuestion or Codex's request_user_input), if any. */
function pendingQuestion(requests: ReadonlyArray<PendingRequest>, chatId: string): PendingQuestion | null {
  for (const request of requests) {
    if (request.method !== USER_INPUT_METHOD || readString(asRecord(request.params)?.threadId) !== chatId) continue
    const questions = readRequestQuestions(request.params).map(toWatchQuestion)
    if (questions.length > 0) return { requestId: request.id, questions }
  }
  return null
}

export function isOpenQuestion(request: PendingRequest, chatId: string): boolean {
  return request.method === USER_INPUT_METHOD && readString(asRecord(request.params)?.threadId) === chatId
}

const RECOMMENDED_SUFFIX = /\s*\(recommended\)$/iu

/** The watch's labels or free text as the card's draft: picked option indexes, -1 for Other. */
function cardAnswer(question: RequestQuestion, given: string[]): RequestQuestionAnswer | null {
  const optionIndex = (value: string) => question.options.findIndex((option) =>
    option.label === value || option.label.replace(RECOMMENDED_SUFFIX, '') === value)
  if (question.options.length === 0) return { choice: null, text: given[0] ?? '' }
  if (question.multiSelect) {
    const choices: number[] = []
    const other: string[] = []
    for (const value of given) {
      const index = optionIndex(value)
      if (index < 0) other.push(value)
      else if (!choices.includes(index)) choices.push(index)
    }
    if (other.length > 0 && !question.isOther) return null
    return { choice: null, choices: other.length > 0 ? [...choices, -1] : choices, text: other.join(', ') }
  }
  if (given.length > 1) return null
  if (given.length === 0) return { choice: null, text: '' }
  const index = optionIndex(given[0] ?? '')
  if (index >= 0) return { choice: index, text: '' }
  return question.isOther ? { choice: -1, text: given[0] ?? '' } : null
}

/**
 * The reply the web app's question card sends for the same picks, built with
 * the card's own functions, or the reason the answers do not fit the question.
 */
export function buildQuestionReply(request: PendingRequest, answers: Record<string, unknown>): { reply: QuestionReply } | { error: string } {
  const questions = readRequestQuestions(request.params)
  if (questions.length === 0) return { error: 'This question cannot be answered from the watch.' }
  const result: QuestionReply['result']['answers'] = {}
  for (const question of questions) {
    const raw = answers[question.id]
    const given = (Array.isArray(raw) ? raw : []).filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim()).filter(Boolean)
    const asked = clip(oneLine(question.question || question.header || question.id), 60)
    const answer = cardAnswer(question, given)
    if (!answer) return { error: `Choose from the options for “${asked}”.` }
    const values = requestQuestionAnswerValues(question, answer)
    if (values.length === 0) return { error: `Answer “${asked}”.` }
    result[question.id] = { answers: values }
  }
  return { reply: { id: request.id, result: { answers: result } } }
}

// ── Projects for a new chat ──────────────────────────────────────────────

export type ProjectChoice = { name: string; cwd: string }

/** The projects the chat list shows, then the voice inbox's (recent chat folders and saved roots). */
export function projectChoices(activity: WatchActivity, list: ChatList): ProjectChoice[] {
  return [
    ...list.projects.filter((project) => project.cwd).map(({ name, cwd }) => ({ name, cwd })),
    ...activity.context.projects.map((project) => ({ name: project.label, cwd: project.id })),
  ]
}

/** A project by its folder or its name (any case). */
export function resolveProject(value: string, choices: ReadonlyArray<ProjectChoice>): ProjectChoice | null {
  const wanted = value.trim()
  if (!wanted) return null
  const folder = wanted.replace(/\/+$/u, '') || '/'
  return choices.find((choice) => choice.cwd === wanted || choice.cwd === folder)
    ?? choices.find((choice) => choice.name === wanted)
    ?? choices.find((choice) => choice.name.toLowerCase() === wanted.toLowerCase())
    ?? null
}
