import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AccountInfo,
  EffortLevel,
  ModelInfo,
  Options,
  Query,
  SDKControlGetUsageResponse,
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
const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_MODEL_ID = 'claude-default'
const ENCODED_MODEL_PREFIX = 'claude-model:'
const RUNTIME_CACHE_MS = 30_000
const USAGE_CACHE_MS = 5 * 60_000
const LEGACY_MODEL_VALUES: Record<string, string> = {
  'claude-default': 'default',
  'claude-fable': 'fable',
  'claude-opus': 'opus',
  'claude-sonnet': 'sonnet',
  'claude-sonnet[1m]': 'sonnet[1m]',
  'claude-haiku': 'haiku',
}

export type ClaudeProviderStatus = {
  id: 'claude'
  label: 'Claude'
  connected: boolean
  email: string | null
  organization: string | null
  plan: string | null
  authMethod: string | null
  apiProvider: string | null
}

export type ClaudeUsageLimit = {
  key: string
  label: string
  usedPercent: number
  resetsAt: string | null
}

export type ClaudeUsage = {
  plan: string | null
  limits: ClaudeUsageLimit[]
  notice?: string
}

type ClaudeRuntimeState = {
  account: AccountInfo
  connected: boolean
  models: ModelInfo[]
}

type ClaudeLoginQuery = Query & {
  claudeAuthenticate(loginWithClaudeAi: boolean): Promise<{ manualUrl: string; automaticUrl?: string }>
  claudeOAuthCallback(authorizationCode: string, state: string): Promise<unknown>
  claudeOAuthWaitForCompletion(): Promise<unknown>
}

type ClaudeLogin = {
  id: string
  query: ClaudeLoginQuery
  state: string
  completion: Promise<unknown>
  timer: ReturnType<typeof setTimeout>
}

export function isClaudeThreadId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(THREAD_ID_PREFIX)
}

export function isClaudeModelId(value: unknown): value is string {
  return typeof value === 'string' && (
    Object.prototype.hasOwnProperty.call(LEGACY_MODEL_VALUES, value) ||
    value.startsWith(ENCODED_MODEL_PREFIX)
  )
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

function toModelValue(modelId: string): string {
  const legacy = LEGACY_MODEL_VALUES[modelId]
  if (legacy) return legacy
  if (!modelId.startsWith(ENCODED_MODEL_PREFIX)) return 'default'
  try {
    return decodeURIComponent(modelId.slice(ENCODED_MODEL_PREFIX.length)) || 'default'
  } catch {
    return 'default'
  }
}

function toModelId(value: string): string {
  const legacy = Object.entries(LEGACY_MODEL_VALUES).find(([, candidate]) => candidate === value)
  return legacy?.[0] ?? `${ENCODED_MODEL_PREFIX}${encodeURIComponent(value)}`
}

function defaultEffort(model: ModelInfo): EffortLevel | null {
  const levels = model.supportedEffortLevels ?? []
  if (!model.supportsEffort || levels.length === 0) return null
  const identity = `${model.displayName} ${model.description}`
  if (/Opus 5\.5/iu.test(identity) && levels.includes('medium')) return 'medium'
  if (/Opus 4\.7/iu.test(identity) && levels.includes('xhigh')) return 'xhigh'
  if (levels.includes('high')) return 'high'
  return levels[0] ?? null
}

function modelDisplayName(model: ModelInfo): string {
  const describedModel = model.description.match(/(?:currently\s+)?((?:Fable|Opus|Sonnet|Haiku)\s+\d+(?:\.\d+)?(?:\s+\(1M context\))?)/iu)?.[1]
  if (model.value === 'default' && describedModel) return `Claude · Default (${describedModel})`
  if (describedModel) return `Claude ${describedModel}`
  return `Claude ${model.displayName}`
}

export function runtimeModel(model: ModelInfo): Record<string, unknown> {
  const efforts = model.supportedEffortLevels ?? []
  return {
    id: toModelId(model.value),
    model: toModelId(model.value),
    upgrade: null,
    displayName: modelDisplayName(model),
    description: model.description,
    modelProvider: MODEL_PROVIDER,
    hidden: false,
    supportedReasoningEfforts: efforts.map((effort) => ({ reasoningEffort: effort, description: effort })),
    defaultReasoningEffort: defaultEffort(model),
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    isDefault: model.value === 'default',
  }
}

function isClaudeConnected(account: AccountInfo): boolean {
  if (account.apiProvider && account.apiProvider !== 'firstParty') return true
  return Boolean(account.tokenSource && account.tokenSource !== 'none')
}

function emptyInput(): AsyncGenerator<SDKUserMessage> {
  return (async function* () {})()
}

function holdingInput(): AsyncGenerator<SDKUserMessage> {
  return (async function* () { await new Promise<void>(() => undefined) })()
}

function normalizePercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

export function normalizeClaudeUsage(raw: unknown, plan: string | null): ClaudeUsage {
  const record = asRecord(raw)
  const rateLimits = asRecord(record?.rate_limits) ?? record
  const resolvedPlan = readString(record?.subscription_type) || plan
  const limits: ClaudeUsageLimit[] = []
  const rows = Array.isArray(rateLimits?.limits) ? rateLimits.limits : []
  for (const rawLimit of rows) {
    const limit = asRecord(rawLimit)
    const key = readString(limit?.kind)
    const usedPercent = normalizePercent(limit?.percent)
    if (!key || usedPercent === null) continue
    const scope = asRecord(limit?.scope)
    const model = readString(asRecord(scope?.model)?.display_name)
    const baseLabel = key === 'session' ? '5h limit'
      : key === 'weekly_all' ? 'Weekly · all models'
        : key === 'weekly_scoped' ? 'Weekly' : key.replace(/_/g, ' ')
    limits.push({
      key,
      label: model ? `${baseLabel} · ${model}` : baseLabel,
      usedPercent,
      resetsAt: readString(limit?.resets_at) || null,
    })
  }

  const legacyRows: Array<[string, string]> = [
    ['five_hour', '5h limit'],
    ['seven_day', 'Weekly · all models'],
    ['seven_day_opus', 'Weekly · Opus'],
    ['seven_day_sonnet', 'Weekly · Sonnet'],
  ]
  for (const [key, label] of legacyRows) {
    const limit = asRecord(rateLimits?.[key])
    const usedPercent = normalizePercent(limit?.utilization)
    if (!limit || usedPercent === null || limits.some((entry) => entry.key === key)) continue
    limits.push({ key, label, usedPercent, resetsAt: readString(limit.resets_at) || null })
  }
  const scoped = Array.isArray(rateLimits?.model_scoped) ? rateLimits.model_scoped : []
  for (const [index, rawLimit] of scoped.entries()) {
    const limit = asRecord(rawLimit)
    const label = readString(limit?.display_name)
    const usedPercent = normalizePercent(limit?.utilization)
    if (!label || usedPercent === null) continue
    limits.push({
      key: `model_scoped_${String(index)}`,
      label: `Weekly · ${label}`,
      usedPercent,
      resetsAt: readString(limit?.resets_at) || null,
    })
  }
  return { plan: resolvedPlan, limits }
}

async function runClaudeCommand(args: string[]): Promise<void> {
  const command = process.env.CODEXUI_CLAUDE_PATH?.trim() || 'claude'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let errorText = ''
    child.stderr.on('data', (chunk: Buffer) => { errorText += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(errorText.trim() || `Claude command exited with code ${String(code)}`))
    })
  })
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
  private runtimeCache: { at: number; value: ClaudeRuntimeState } | null = null
  private usageCache: { at: number; value: ClaudeUsage } | null = null
  private login: ClaudeLogin | null = null

  constructor(storeFilePath: string) {
    this.store = new ClaudeThreadStore(storeFilePath)
  }

  private sdk(): Promise<SdkModule> {
    this.sdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
    return this.sdkPromise
  }

  private queryOptions(): Options {
    return {
      cwd: process.cwd(),
      permissionMode: 'dontAsk',
      settingSources: ['user', 'project', 'local'],
      ...(process.env.CODEXUI_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.CODEXUI_CLAUDE_PATH } : {}),
    }
  }

  private async readRuntime(force = false): Promise<ClaudeRuntimeState> {
    if (!force && this.runtimeCache && Date.now() - this.runtimeCache.at < RUNTIME_CACHE_MS) {
      return this.runtimeCache.value
    }
    const { query } = await this.sdk()
    const runtimeQuery = query({ prompt: emptyInput(), options: this.queryOptions() })
    try {
      const [models, account] = await Promise.all([
        runtimeQuery.supportedModels(),
        runtimeQuery.accountInfo(),
      ])
      const value = { account, connected: isClaudeConnected(account), models }
      this.runtimeCache = { at: Date.now(), value }
      return value
    } finally {
      runtimeQuery.close()
    }
  }

  async readProviderStatus(force = false): Promise<ClaudeProviderStatus> {
    const runtime = await this.readRuntime(force)
    return {
      id: 'claude',
      label: 'Claude',
      connected: runtime.connected,
      email: runtime.account.email ?? null,
      organization: runtime.account.organization ?? null,
      plan: runtime.account.subscriptionType ?? null,
      authMethod: runtime.account.tokenSource ?? runtime.account.apiKeySource ?? null,
      apiProvider: runtime.account.apiProvider ?? null,
    }
  }

  async readUsage(force = false): Promise<ClaudeUsage | null> {
    const runtime = await this.readRuntime(force)
    if (!runtime.connected || runtime.account.apiProvider !== 'firstParty') return null
    if (!force && this.usageCache && Date.now() - this.usageCache.at < USAGE_CACHE_MS) {
      return this.usageCache.value
    }
    const { query } = await this.sdk()
    const usageQuery = query({ prompt: emptyInput(), options: this.queryOptions() })
    try {
      const response = await usageQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      const value = normalizeClaudeUsage(response satisfies SDKControlGetUsageResponse, runtime.account.subscriptionType ?? null)
      this.usageCache = { at: Date.now(), value }
      return value
    } catch (error) {
      if (this.usageCache) {
        const age = Math.max(1, Math.round((Date.now() - this.usageCache.at) / 60_000))
        return { ...this.usageCache.value, notice: `Claude usage refresh failed. Showing data from ${String(age)} min ago.` }
      }
      return {
        plan: runtime.account.subscriptionType ?? null,
        limits: [],
        notice: 'Claude usage is temporarily unavailable.',
      }
    } finally {
      usageQuery.close()
    }
  }

  async startLogin(): Promise<{ loginId: string; authUrl: string }> {
    this.cancelLogin()
    const { query } = await this.sdk()
    const loginQuery = query({ prompt: holdingInput(), options: this.queryOptions() }) as ClaudeLoginQuery
    try {
      await loginQuery.initializationResult()
      const response = await loginQuery.claudeAuthenticate(true)
      const authUrl = response.manualUrl
      const state = new URL(authUrl).searchParams.get('state') ?? ''
      if (!authUrl || !state) throw new Error('Claude did not return a valid login URL.')
      // Claude Code keeps the authentication flow active only while this
      // request is waiting. Start it before returning the manual URL, then
      // deliver the pasted callback through the same query process.
      const completion = loginQuery.claudeOAuthWaitForCompletion()
      void completion.catch(() => undefined)
      const id = randomUUID()
      const timer = setTimeout(() => {
        if (this.login?.id === id) this.cancelLogin()
      }, 10 * 60_000)
      timer.unref?.()
      this.login = { id, query: loginQuery, state, completion, timer }
      return { loginId: id, authUrl }
    } catch (error) {
      loginQuery.close()
      throw error
    }
  }

  async completeLogin(loginId: string, pastedCode: string): Promise<ClaudeProviderStatus> {
    const login = this.login
    if (!login || login.id !== loginId) throw new Error('This Claude login has expired. Start again.')
    const [authorizationCode, pastedState] = pastedCode.trim().split('#', 2)
    if (!authorizationCode) throw new Error('Paste the authorization code from Claude.')
    try {
      await login.query.claudeOAuthCallback(authorizationCode, pastedState || login.state)
      await login.completion
    } catch {
      throw new Error('Claude could not complete sign-in. Start again and paste the new authorization code.')
    } finally {
      this.cancelLogin()
    }
    this.runtimeCache = null
    this.usageCache = null
    return this.readProviderStatus(true)
  }

  cancelLogin(): void {
    if (!this.login) return
    clearTimeout(this.login.timer)
    this.login.query.close()
    this.login = null
  }

  async logout(): Promise<void> {
    this.cancelLogin()
    await runClaudeCommand(['auth', 'logout'])
    this.runtimeCache = null
    this.usageCache = null
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(method: string, params: unknown): void {
    for (const listener of this.listeners) listener({ method, params })
  }

  async listModels(): Promise<Record<string, unknown>[]> {
    const runtime = await this.readRuntime()
    return runtime.connected ? runtime.models.map(runtimeModel) : []
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

  private async executionSettings(requestedModel: unknown, requestedEffort: unknown): Promise<{
    model: string
    effort: EffortLevel | null
  }> {
    const runtime = await this.readRuntime()
    if (!runtime.connected) throw new Error('Claude is signed out. Sign in to Claude before starting a Claude turn.')
    const requestedModelId = isClaudeModelId(requestedModel) ? requestedModel : ''
    const requestedValue = requestedModelId ? toModelValue(requestedModelId) : 'default'
    const modelInfo = runtime.models.find((model) => model.value === requestedValue)
      ?? runtime.models.find((model) => model.value === 'default')
      ?? runtime.models[0]
    const model = modelInfo ? toModelId(modelInfo.value) : (requestedModelId || DEFAULT_MODEL_ID)
    const supportedEfforts = modelInfo?.supportedEffortLevels ?? EFFORT_LEVELS
    const effort = toEffort(requestedEffort)
    return {
      model,
      effort: effort && supportedEfforts.includes(effort) ? effort : (modelInfo ? defaultEffort(modelInfo) : effort),
    }
  }

  private async startThread(request: Record<string, unknown>): Promise<unknown> {
    const sessionId = randomUUID()
    const { model, effort } = await this.executionSettings(request.model, request.effort)
    const stored = await this.store.update(sessionId, {
      cwd: readString(request.cwd) || process.cwd(),
      model,
      effort,
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

    const existing = await this.store.get(sessionId)
    const requested = await this.executionSettings(
      isClaudeModelId(request.model) ? request.model : existing?.model,
      toEffort(request.effort) ?? existing?.effort,
    )
    const stored = await this.store.update(sessionId, {
      model: requested.model,
      effort: requested.effort,
      ...(readString(request.cwd) ? { cwd: readString(request.cwd) } : {}),
    })

    const { query, getSessionInfo } = await this.sdk()
    const exists = Boolean(await getSessionInfo(sessionId))
    const input = createInputStream(userMessage)
    const options: Options = {
      cwd: stored.cwd || undefined,
      model: toModelValue(stored.model),
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
    this.cancelLogin()
    for (const turn of this.liveTurns.values()) {
      turn.interrupted = true
      turn.release()
      void turn.query.interrupt().catch(() => undefined)
    }
    this.liveTurns.clear()
  }
}
