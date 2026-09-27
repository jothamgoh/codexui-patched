import { randomUUID } from 'node:crypto'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  EffortLevel,
  Options,
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

/**
 * Serves Claude Code chats through the Codex app-server protocol, so the
 * existing CodexUI frontend renders them without a separate code path.
 *
 * Claude chat ids are the Claude session id with a `claude-` prefix. History
 * comes from Claude Code's own transcripts via the Agent SDK; a running reply
 * is one SDK query whose input stream stays open, so steering is a push.
 */

type Notification = { method: string; params: unknown }
type NotificationListener = (notification: Notification) => void
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

const THREAD_ID_PREFIX = 'claude-'
const MODEL_PROVIDER = 'anthropic'

export const CLAUDE_MODELS = [
  { id: 'claude-opus', alias: 'opus', displayName: 'Claude Opus', description: 'Claude Code with the latest Opus model.' },
  { id: 'claude-sonnet', alias: 'sonnet', displayName: 'Claude Sonnet', description: 'Claude Code with the latest Sonnet model.' },
  { id: 'claude-haiku', alias: 'haiku', displayName: 'Claude Haiku', description: 'Claude Code with the latest Haiku model.' },
] as const

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_MODEL_ID = 'claude-opus'

export function isClaudeThreadId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(THREAD_ID_PREFIX)
}

export function isClaudeModelId(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_MODELS.some((model) => model.id === value)
}

function toSessionId(threadId: string): string {
  return threadId.slice(THREAD_ID_PREFIX.length)
}

function toThreadId(sessionId: string): string {
  return `${THREAD_ID_PREFIX}${sessionId}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toSeconds(ms: number | undefined): number {
  return Math.floor((ms ?? Date.now()) / 1000)
}

function toEffort(value: unknown): EffortLevel | null {
  return typeof value === 'string' && (EFFORT_LEVELS as string[]).includes(value) ? value as EffortLevel : null
}

function toModelAlias(modelId: string): string {
  return CLAUDE_MODELS.find((model) => model.id === modelId)?.alias ?? 'opus'
}

// ── Persisted per-chat settings ─────────────────────────────────────────

type StoredThread = {
  cwd: string
  model: string
  effort: EffortLevel | null
  archived?: boolean
  createdAtMs: number
}

type StoreFile = { threads: Record<string, StoredThread> }

class ClaudeThreadStore {
  private cache: StoreFile | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async read(): Promise<StoreFile> {
    if (this.cache) return this.cache
    try {
      const parsed = asRecord(JSON.parse(await readFile(this.filePath, 'utf8')))
      this.cache = { threads: (asRecord(parsed?.threads) ?? {}) as Record<string, StoredThread> }
    } catch {
      this.cache = { threads: {} }
    }
    return this.cache
  }

  async get(sessionId: string): Promise<StoredThread | undefined> {
    return (await this.read()).threads[sessionId]
  }

  async update(sessionId: string, patch: Partial<StoredThread>): Promise<StoredThread> {
    const state = await this.read()
    const base: StoredThread = state.threads[sessionId]
      ?? { cwd: '', model: DEFAULT_MODEL_ID, effort: null, createdAtMs: Date.now() }
    const next: StoredThread = { ...base, ...patch }
    state.threads[sessionId] = next
    const snapshot = JSON.stringify(state, null, 2)
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        await writeFile(this.filePath, snapshot, 'utf8')
      })
      .catch((error) => {
        console.warn('[claude-backend] Failed to save chat settings:', error instanceof Error ? error.message : error)
      })
    return next
  }
}

// ── Transcript → Codex thread items ─────────────────────────────────────

type ToolUse = { id: string; name: string; input: Record<string, unknown> }
type ToolResult = { text: string; isError: boolean }

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const record = asRecord(block)
      return record?.type === 'text' ? readString(record.text) : ''
    })
    .filter(Boolean)
    .join('\n')
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const candidates = [input.file_path, input.path, input.pattern, input.url, input.query, input.description, input.prompt]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().split('\n')[0].slice(0, 200)
  }
  return name
}

function toToolItem(tool: ToolUse, cwd: string, result: ToolResult | null): Record<string, unknown> {
  const status = result ? (result.isError ? 'failed' : 'completed') : 'inProgress'
  if (tool.name === 'Bash') {
    return {
      type: 'commandExecution',
      id: tool.id,
      command: readString(tool.input.command),
      cwd,
      status,
      aggregatedOutput: result?.text ?? '',
      exitCode: result ? (result.isError ? 1 : 0) : null,
    }
  }
  return {
    type: 'mcpToolCall',
    id: tool.id,
    // The tool row shows `server` as its detail line, so carry what the tool
    // acted on there rather than a server name Claude tools do not have.
    server: summarizeToolInput(tool.name, tool.input),
    tool: tool.name,
    arguments: tool.input,
    status,
    result: result && !result.isError ? { content: [{ type: 'text', text: result.text }] } : null,
    error: result?.isError ? { message: result.text } : null,
  }
}

function textItemId(messageId: string, textIndex: number): string {
  return `${messageId}:text:${String(textIndex)}`
}

/** Text a user typed, as opposed to tool results Claude Code files as user turns. */
function readUserText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const texts = content
    .map((block) => asRecord(block))
    .filter((block) => block?.type === 'text')
    .map((block) => readString(block?.text))
  return texts.length > 0 ? texts.join('\n') : null
}

type TranscriptMessage = { type: string; uuid: string; message: unknown; parent_tool_use_id: string | null }
type SteerMessage = { id: string; text: string }

/**
 * Messages sent mid-reply, keyed by the transcript entry they followed. Claude
 * Code files them as `queued_command` attachments, which the SDK's message
 * reader leaves out, so they are read from the transcript file directly.
 */
export function readSteerMessages(transcript: string): Map<string, SteerMessage[]> {
  const steers = new Map<string, SteerMessage[]>()
  for (const line of transcript.split('\n')) {
    if (!line.includes('"queued_command"')) continue
    let entry: Record<string, unknown> | null = null
    try {
      entry = asRecord(JSON.parse(line))
    } catch {
      continue
    }
    const attachment = asRecord(entry?.attachment)
    if (entry?.type !== 'attachment' || attachment?.type !== 'queued_command') continue
    const text = readUserText(attachment.prompt)
    const parentUuid = readString(entry.parentUuid)
    if (!text || !parentUuid) continue
    const list = steers.get(parentUuid) ?? []
    list.push({ id: readString(entry.uuid) || `${parentUuid}:steer:${String(list.length)}`, text })
    steers.set(parentUuid, list)
  }
  return steers
}

export function buildTurnsFromTranscript(
  messages: TranscriptMessage[],
  cwd: string,
  steers: Map<string, SteerMessage[]> = new Map(),
): Array<{ id: string; items: Record<string, unknown>[]; status: string; error: null }> {
  const turns: Array<{ id: string; items: Record<string, unknown>[]; status: string; error: null }> = []
  const toolResults = new Map<string, ToolResult>()
  const textCounts = new Map<string, number>()

  for (const entry of messages) {
    const message = asRecord(entry.message)
    if (entry.type !== 'user' || !Array.isArray(message?.content)) continue
    for (const block of message.content) {
      const record = asRecord(block)
      if (record?.type !== 'tool_result') continue
      toolResults.set(readString(record.tool_use_id), {
        text: stringifyToolResult(record.content),
        isError: record.is_error === true,
      })
    }
  }

  const appendEntry = (entry: TranscriptMessage, message: Record<string, unknown>): void => {
    if (entry.type === 'user') {
      const text = readUserText(message.content)
      if (text === null) return
      turns.push({
        id: entry.uuid,
        status: 'completed',
        error: null,
        items: [{ type: 'userMessage', id: entry.uuid, content: [{ type: 'text', text }] }],
      })
      return
    }

    if (entry.type !== 'assistant' || !Array.isArray(message.content)) return
    if (turns.length === 0) {
      turns.push({ id: `${entry.uuid}:turn`, status: 'completed', error: null, items: [] })
    }
    const turn = turns[turns.length - 1]
    const messageId = readString(message.id) || entry.uuid
    for (const block of message.content) {
      const record = asRecord(block)
      if (record?.type === 'text') {
        const index = textCounts.get(messageId) ?? 0
        textCounts.set(messageId, index + 1)
        const text = readString(record.text)
        if (text.trim()) turn.items.push({ type: 'agentMessage', id: textItemId(messageId, index), text })
      } else if (record?.type === 'tool_use') {
        const tool: ToolUse = {
          id: readString(record.id),
          name: readString(record.name),
          input: asRecord(record.input) ?? {},
        }
        turn.items.push(toToolItem(tool, cwd, toolResults.get(tool.id) ?? null))
      }
    }
  }

  for (const entry of messages) {
    if (entry.parent_tool_use_id) continue
    const message = asRecord(entry.message)
    if (!message) continue
    appendEntry(entry, message)
    const turn = turns[turns.length - 1]
    for (const steer of steers.get(entry.uuid) ?? []) {
      turn?.items.push({ type: 'userMessage', id: steer.id, content: [{ type: 'text', text: steer.text }] })
    }
  }

  return turns
}

const transcriptPaths = new Map<string, string>()

/** Claude Code stores each chat as `<config>/projects/<encoded cwd>/<session id>.jsonl`. */
async function findTranscriptPath(sessionId: string): Promise<string | null> {
  const cached = transcriptPaths.get(sessionId)
  if (cached) return cached
  const projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  const dirs = await readdir(projectsDir).catch(() => [] as string[])
  for (const dir of dirs) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
    if (await access(candidate).then(() => true, () => false)) {
      transcriptPaths.set(sessionId, candidate)
      return candidate
    }
  }
  return null
}

// ── Live turns ──────────────────────────────────────────────────────────

type LiveTurn = {
  turnId: string
  query: Query
  push: (message: SDKUserMessage) => boolean
  release: () => void
  interrupted: boolean
}

function createInputStream(first: SDKUserMessage) {
  const pending: SDKUserMessage[] = [first]
  let released = false
  let wake: (() => void) | null = null
  const notify = () => {
    const resume = wake
    wake = null
    resume?.()
  }

  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (pending.length > 0) {
        const next = pending.shift()
        if (next) yield next
      }
      if (released) return
      await new Promise<void>((resolve) => { wake = resolve })
    }
  }

  return {
    stream: stream(),
    push(message: SDKUserMessage): boolean {
      if (released) return false
      pending.push(message)
      notify()
      return true
    },
    release() {
      released = true
      notify()
    },
  }
}

type UserContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number]

function buildUserMessage(input: unknown, sessionId: string): SDKUserMessage | null {
  const blocks = Array.isArray(input) ? input : []
  const content: UserContentBlock[] = []
  for (const block of blocks) {
    const record = asRecord(block)
    if (record?.type === 'text' && readString(record.text)) {
      content.push({ type: 'text', text: readString(record.text) })
    }
    const url = readString(record?.url)
    const dataUrl = record?.type === 'image' ? url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/u) : null
    if (dataUrl) {
      const mediaType = dataUrl[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: dataUrl[2] } })
    }
  }
  if (content.length === 0) return null
  return {
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content },
  }
}

// ── Backend ─────────────────────────────────────────────────────────────

export class ClaudeBackend {
  private sdkPromise: Promise<SdkModule> | null = null
  private readonly listeners = new Set<NotificationListener>()
  private readonly liveTurns = new Map<string, LiveTurn>()
  private readonly store: ClaudeThreadStore

  constructor(storeFilePath: string) {
    this.store = new ClaudeThreadStore(storeFilePath)
  }

  private sdk(): Promise<SdkModule> {
    this.sdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
    return this.sdkPromise
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(method: string, params: unknown): void {
    for (const listener of this.listeners) listener({ method, params })
  }

  listModels(): Record<string, unknown>[] {
    return CLAUDE_MODELS.map((model) => ({
      id: model.id,
      model: model.id,
      upgrade: null,
      displayName: model.displayName,
      description: model.description,
      hidden: false,
      supportedReasoningEfforts: EFFORT_LEVELS.map((effort) => ({ reasoningEffort: effort, description: effort })),
      defaultReasoningEffort: 'high',
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      isDefault: false,
    }))
  }

  private async toThread(sessionId: string, info: SDKSessionInfo | undefined, turns: unknown[] = []) {
    const stored = await this.store.get(sessionId)
    const name = info?.customTitle || info?.summary || ''
    return {
      id: toThreadId(sessionId),
      preview: info?.firstPrompt || name,
      name: name || null,
      modelProvider: MODEL_PROVIDER,
      createdAt: toSeconds(info?.createdAt ?? stored?.createdAtMs ?? info?.lastModified),
      updatedAt: toSeconds(info?.lastModified ?? stored?.createdAtMs),
      path: null,
      cwd: info?.cwd || stored?.cwd || '',
      cliVersion: 'claude-code',
      source: 'cli',
      gitInfo: null,
      status: { type: this.liveTurns.has(sessionId) ? 'active' : 'idle' },
      turns,
    }
  }

  async listThreads(params: unknown): Promise<Record<string, unknown>[]> {
    const request = asRecord(params)
    const limit = typeof request?.limit === 'number' ? request.limit : 100
    const wantArchived = request?.archived === true
    const { listSessions } = await this.sdk()
    const [sessions, store] = await Promise.all([listSessions({ limit: limit * 2 }), this.store.read()])
    const threads = []
    for (const info of sessions) {
      if ((store.threads[info.sessionId]?.archived === true) !== wantArchived) continue
      threads.push(await this.toThread(info.sessionId, info))
      if (threads.length >= limit) break
    }
    return threads
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    const request = asRecord(params) ?? {}
    switch (method) {
      case 'thread/start':
        return this.startThread(request)
      case 'thread/read':
        return { thread: await this.readThread(readString(request.threadId), request.includeTurns === true) }
      case 'thread/resume':
        return this.resumeThread(readString(request.threadId))
      case 'turn/start':
      case 'turn/steer':
        return this.startTurn(request)
      case 'turn/interrupt':
        return this.interrupt(readString(request.threadId))
      case 'thread/name/set':
        return this.setName(readString(request.threadId), readString(request.name))
      case 'thread/archive':
        await this.store.update(toSessionId(readString(request.threadId)), { archived: true })
        return {}
      case 'thread/unarchive':
        await this.store.update(toSessionId(readString(request.threadId)), { archived: false })
        return {}
      case 'thread/goal/get':
        return { goal: null }
      default:
        throw new Error(`${method} is not available for Claude chats yet.`)
    }
  }

  private async startThread(request: Record<string, unknown>): Promise<unknown> {
    const sessionId = randomUUID()
    const model = isClaudeModelId(request.model) ? request.model : DEFAULT_MODEL_ID
    const stored = await this.store.update(sessionId, {
      cwd: readString(request.cwd) || process.cwd(),
      model,
      effort: null,
      createdAtMs: Date.now(),
    })
    const thread = await this.toThread(sessionId, undefined)
    this.emit('thread/started', { thread })
    return this.threadConfigResponse(thread, stored)
  }

  private threadConfigResponse(thread: Record<string, unknown>, stored: StoredThread | undefined) {
    return {
      thread,
      model: stored?.model ?? DEFAULT_MODEL_ID,
      modelProvider: MODEL_PROVIDER,
      cwd: thread.cwd,
      approvalPolicy: 'never',
      sandbox: { type: 'dangerFullAccess' },
      reasoningEffort: stored?.effort ?? null,
    }
  }

  private async readThread(threadId: string, includeTurns: boolean) {
    const sessionId = toSessionId(threadId)
    const { getSessionInfo, getSessionMessages } = await this.sdk()
    const info = await getSessionInfo(sessionId)
    if (!info && !(await this.store.get(sessionId))) {
      throw new Error(`Claude chat ${threadId} was not found.`)
    }
    if (!includeTurns || !info) return this.toThread(sessionId, info)

    const cwd = info.cwd || (await this.store.get(sessionId))?.cwd || ''
    const transcriptPath = await findTranscriptPath(sessionId)
    const steers = transcriptPath
      ? readSteerMessages(await readFile(transcriptPath, 'utf8').catch(() => ''))
      : new Map<string, SteerMessage[]>()
    const turns = buildTurnsFromTranscript(await getSessionMessages(sessionId), cwd, steers)
    const live = this.liveTurns.get(sessionId)
    const lastTurn = turns[turns.length - 1]
    if (live && lastTurn) lastTurn.status = 'inProgress'
    return this.toThread(sessionId, info, turns)
  }

  private async resumeThread(threadId: string) {
    const sessionId = toSessionId(threadId)
    const { getSessionInfo } = await this.sdk()
    const thread = await this.toThread(sessionId, await getSessionInfo(sessionId))
    return this.threadConfigResponse(thread, await this.store.get(sessionId))
  }

  private async setName(threadId: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return {}
    const { renameSession } = await this.sdk()
    await renameSession(toSessionId(threadId), trimmed)
    this.emit('thread/name/updated', { threadId, threadName: trimmed })
    return {}
  }

  private async interrupt(threadId: string) {
    const live = this.liveTurns.get(toSessionId(threadId))
    if (live) {
      live.interrupted = true
      await live.query.interrupt().catch(() => undefined)
    }
    return {}
  }

  private async startTurn(request: Record<string, unknown>): Promise<unknown> {
    const threadId = readString(request.threadId)
    const sessionId = toSessionId(threadId)
    const userMessage = buildUserMessage(request.input, sessionId)
    if (!userMessage) throw new Error('The message is empty.')

    // A reply is running: steer it. Claude reads the message at its next step.
    const live = this.liveTurns.get(sessionId)
    if (live) {
      if (!live.push(userMessage)) throw new Error('The Claude reply just finished. Send the message again.')
      return { turn: { id: live.turnId, items: [], status: 'inProgress', error: null } }
    }

    const stored = await this.store.update(sessionId, {
      ...(isClaudeModelId(request.model) ? { model: request.model } : {}),
      ...(toEffort(request.effort) ? { effort: toEffort(request.effort) } : {}),
      ...(readString(request.cwd) ? { cwd: readString(request.cwd) } : {}),
    })

    const { query, getSessionInfo } = await this.sdk()
    const exists = Boolean(await getSessionInfo(sessionId))
    const input = createInputStream(userMessage)
    const options: Options = {
      cwd: stored.cwd || undefined,
      model: toModelAlias(stored.model),
      ...(stored.effort ? { effort: stored.effort } : {}),
      ...(exists ? { resume: sessionId } : { sessionId }),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      ...(process.env.CODEXUI_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.CODEXUI_CLAUDE_PATH } : {}),
    }

    const turnId = readString(userMessage.uuid)
    const turn: LiveTurn = {
      turnId,
      query: query({ prompt: input.stream, options }),
      push: input.push,
      release: input.release,
      interrupted: false,
    }
    this.liveTurns.set(sessionId, turn)

    const turnPayload = { id: turnId, items: [], status: 'inProgress', error: null }
    this.emit('turn/started', { threadId, turn: turnPayload })
    this.emit('thread/status/changed', { threadId, status: { type: 'active' } })
    void this.runTurn(threadId, sessionId, turn, stored.cwd)
    return { turn: turnPayload }
  }

  private async runTurn(threadId: string, sessionId: string, turn: LiveTurn, cwd: string): Promise<void> {
    const { turnId } = turn
    const tools = new Map<string, ToolUse>()
    const streamedTextCounts = new Map<string, number>()
    const finalTextCounts = new Map<string, number>()
    const blockItemIds = new Map<number, string>()
    let currentMessageId = ''
    let completion: { status: string; error: { message: string; codexErrorInfo: null; additionalDetails: null } | null } | null = null

    const itemParams = (item: Record<string, unknown>) => ({ threadId, turnId, item })

    const handle = (message: SDKMessage) => {
      if ('parent_tool_use_id' in message && message.parent_tool_use_id) return

      if (message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'message_start') {
          currentMessageId = event.message.id
          blockItemIds.clear()
        } else if (event.type === 'content_block_start' && event.content_block.type === 'text') {
          const index = streamedTextCounts.get(currentMessageId) ?? 0
          streamedTextCounts.set(currentMessageId, index + 1)
          const itemId = textItemId(currentMessageId, index)
          blockItemIds.set(event.index, itemId)
          this.emit('item/started', itemParams({ type: 'agentMessage', id: itemId, text: '' }))
        } else if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
          this.emit('item/started', itemParams({ type: 'reasoning', id: `${currentMessageId}:reasoning:${String(event.index)}`, summary: [], content: [] }))
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const itemId = blockItemIds.get(event.index)
          if (itemId) this.emit('item/agentMessage/delta', { threadId, turnId, itemId, delta: event.delta.text })
        }
        return
      }

      if (message.type === 'assistant') {
        const messageId = message.message.id
        for (const block of message.message.content) {
          if (block.type === 'text') {
            const index = finalTextCounts.get(messageId) ?? 0
            finalTextCounts.set(messageId, index + 1)
            this.emit('item/completed', itemParams({ type: 'agentMessage', id: textItemId(messageId, index), text: block.text }))
          } else if (block.type === 'tool_use') {
            const tool: ToolUse = { id: block.id, name: block.name, input: asRecord(block.input) ?? {} }
            tools.set(tool.id, tool)
            this.emit('item/started', itemParams(toToolItem(tool, cwd, null)))
          }
        }
        return
      }

      if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          const record = asRecord(block)
          if (record?.type !== 'tool_result') continue
          const tool = tools.get(readString(record.tool_use_id))
          if (!tool) continue
          const result = { text: stringifyToolResult(record.content), isError: record.is_error === true }
          this.emit('item/completed', itemParams(toToolItem(tool, cwd, result)))
        }
        return
      }

      if (message.type === 'result') {
        if (turn.interrupted) {
          completion = { status: 'interrupted', error: null }
        } else if (message.subtype === 'success' && !message.is_error) {
          completion = { status: 'completed', error: null }
        } else {
          const detail = message.subtype === 'success' ? message.result : message.errors.join('\n')
          completion = { status: 'failed', error: { message: detail || 'Claude stopped with an error.', codexErrorInfo: null, additionalDetails: null } }
        }
        // One reply per query: closing the input lets the Claude process exit.
        turn.release()
      }
    }

    try {
      for await (const message of turn.query) handle(message)
    } catch (error) {
      if (!completion) {
        completion = turn.interrupted
          ? { status: 'interrupted', error: null }
          : { status: 'failed', error: { message: error instanceof Error ? error.message : String(error), codexErrorInfo: null, additionalDetails: null } }
      }
    } finally {
      turn.release()
      this.liveTurns.delete(sessionId)
      const final = completion ?? { status: turn.interrupted ? 'interrupted' : 'failed', error: null }
      this.emit('turn/completed', { threadId, turn: { id: turnId, items: [], ...final } })
      this.emit('thread/status/changed', { threadId, status: { type: 'idle' } })
    }
  }

  dispose(): void {
    for (const turn of this.liveTurns.values()) {
      turn.interrupted = true
      turn.release()
      void turn.query.interrupt().catch(() => undefined)
    }
    this.liveTurns.clear()
  }
}
