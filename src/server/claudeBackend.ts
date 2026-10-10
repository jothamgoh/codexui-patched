import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type {
  AccountInfo,
  EffortLevel,
  HookCallback,
  ModelInfo,
  Options,
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SlashCommand,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { getCodexUiChildEnv } from './envFile'
import { claudeComputerUseNeedsApproval, loadClaudeComputerUseMcpConfig } from './claudeComputerUse'
import { spawnThroughHost } from './claudeProcessHost'
import { ClaudeAccountSwitcher, resolveCSwapExecutable, type CSwapResult } from './claudeAccountSwitcher'
import {
  claudeConfigDir,
  isClaudeSessionActive,
  scanClaudeSessionRegistry,
  type ClaudeSessionRegistryScan,
  type ClaudeSessionState,
} from './claudeSessionRegistry'
import {
  addUsage,
  asRecord,
  buildTurnsFromChain,
  capToolOutput,
  emptyUsage,
  GOAL_CONTINUATION_TAG,
  MY_REQUEST_MARKER,
  parseTranscript,
  readApiUsage,
  readString,
  reasoningItemId,
  resolveMainChain,
  rewindPointForRollback,
  stringifyToolResult,
  textItemId,
  toolUseItem,
  truncateChain,
  type ClaudeTokenUsage,
  type ClaudeToolUse,
  type ClaudeTurn,
  type ThreadItem,
  type TranscriptEntry,
} from './claudeTranscript'

/**
 * Serves Claude Code chats through the Codex app-server protocol, so the
 * CodexUI frontend renders them with the same components as Codex chats.
 *
 * Chat ids are the Claude session id with a `claude-` prefix. History comes
 * from Claude Code's own transcripts, so chats started in the terminal,
 * Remote Control or here are the same sessions. Each active chat keeps one
 * Claude Code process with an open input stream: a message sent mid-reply
 * steers the running turn, and the process stays warm between turns.
 */

type Notification = { method: string; params: unknown }
type NotificationListener = (notification: Notification) => void
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

const THREAD_ID_PREFIX = 'claude-'
const MODEL_PROVIDER = 'anthropic'
const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_MODEL_ID = 'claude-default'
const ENCODED_MODEL_PREFIX = 'claude-model:'
const SKILL_PATH_PREFIX = 'claude-command:'
const RUNTIME_CACHE_MS = 10 * 60_000
const CLAUDE_SDK_USAGE_POLL_MS = 15 * 60_000
const LIST_CACHE_MS = 2_500
const COMMANDS_CACHE_MS = 10 * 60_000
const RUNNER_IDLE_MS = 15 * 60_000
const INTERRUPT_SETTLE_MS = 8_000
const SEARCH_FILE_LIMIT = 300
const SEARCH_MAX_BYTES = 40 * 1024 * 1024
const DEFAULT_CONTEXT_WINDOW = 200_000
const TRANSCRIPT_CACHE_BYTES = 96 * 1024 * 1024
/** A transcript written this recently by another Claude Code process is busy. */
const EXTERNAL_ACTIVITY_MS = 30_000
const CLAUDE_SESSION_POLL_MS = 5_000
const CLAUDE_LIMIT_CONTINUATION = 'Continue where you left off. Do not redo work that is already done.'
/** Writes this soon after CodexUI's own activity (titles, hooks) are its own. */
const OWN_WRITE_SLACK_MS = 10_000
const HUMAN_PROMPT_SCAN_BYTES = 256 * 1024
const SERVER_REQUEST_ID_BASE = 1_700_000_000
const GOAL_COMPLETE_MARKER = /^\s*GOAL COMPLETE\s*$/mu
const GOAL_BLOCKED_MARKER = /^\s*GOAL BLOCKED:?\s*(.*)$/mu
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
  notice?: string
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

export type ClaudePendingServerRequest = {
  id: number
  method: string
  params: unknown
  receivedAtIso: string
}

type ClaudeRuntimeState = {
  account: AccountInfo
  connected: boolean
  models: ModelInfo[]
}

type ClaudeLogin = {
  id: string
  child: SpawnedChild
  completion: Promise<void>
  timer: ReturnType<typeof setTimeout>
}

type SpawnedChild = {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  exitCode: number | null
  killed: boolean
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
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

export function isClaudeServerRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= SERVER_REQUEST_ID_BASE
}

function toSessionId(threadId: string): string {
  return threadId.slice(THREAD_ID_PREFIX.length)
}

function toThreadId(sessionId: string): string {
  return `${THREAD_ID_PREFIX}${sessionId}`
}

function toSeconds(ms: number | undefined | null): number {
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
  return Boolean(
    (account.tokenSource && account.tokenSource !== 'none') ||
    account.email ||
    account.organization ||
    account.subscriptionType,
  )
}

function emptyInput(): AsyncGenerator<SDKUserMessage> {
  return (async function* () {})()
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
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

  // Current SDK responses include the server-native rows and compatibility
  // fields for older clients. Prefer the native rows so each meter appears
  // once; fall back to the compatibility fields only when rows are absent.
  if (rows.length === 0) {
    const legacyRows: Array<[string, string]> = [
      ['five_hour', '5h limit'],
      ['seven_day', 'Weekly · all models'],
      ['seven_day_opus', 'Weekly · Opus'],
      ['seven_day_sonnet', 'Weekly · Sonnet'],
    ]
    for (const [key, label] of legacyRows) {
      const limit = asRecord(rateLimits?.[key])
      const usedPercent = normalizePercent(limit?.utilization)
      if (!limit || usedPercent === null) continue
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
  }
  return { plan: resolvedPlan, limits }
}

/** The installed Claude CLI, for sign-in and sign-out. */
function resolveClaudeExecutable(): string {
  const configured = process.env.CODEXUI_CLAUDE_PATH?.trim()
  if (configured) return configured
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, 'claude')
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // keep looking
    }
  }
  try {
    const require = createRequire(import.meta.url)
    const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'))
    const bundled = join(sdkDir, '..', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude')
    if (existsSync(bundled)) return bundled
  } catch {
    // fall through
  }
  return 'claude'
}

/** Claude Code's project folder name for a working directory. */
function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-')
}

// ── Persisted per-chat settings ─────────────────────────────────────────

type StoredGoal = {
  objective: string
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

type StoredThread = {
  cwd: string
  model: string
  effort: EffortLevel | null
  archived?: boolean
  createdAtMs: number
  /** Resume the next turn at this transcript entry (a rolled-back chat). */
  rewindAt?: string | null
  contextWindow?: number
  goal?: StoredGoal | null
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
        await writeFile(this.filePath, snapshot, { encoding: 'utf8', mode: 0o600 })
      })
      .catch((error) => {
        console.warn('[claude-backend] Failed to save chat settings:', error instanceof Error ? error.message : error)
      })
    return next
  }
}

// ── Transcripts ─────────────────────────────────────────────────────────

type ParsedTranscript = {
  mtimeMs: number
  /** File size when last read. */
  size: number
  /** Bytes parsed so far: everything up to the last complete line. */
  consumed: number
  entries: TranscriptEntry[]
  chain: TranscriptEntry[]
  title: string
  firstPrompt: string
  createdAtMs: number | null
}

function readTitle(entries: TranscriptEntry[]): { title: string; firstPrompt: string; createdAtMs: number | null } {
  let customTitle = ''
  let aiTitle = ''
  let firstPrompt = ''
  let createdAtMs: number | null = null
  for (const entry of entries) {
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') customTitle = entry.customTitle
    else if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') aiTitle = entry.aiTitle
    else if (entry.type === 'summary' && typeof entry.summary === 'string' && !aiTitle) aiTitle = entry.summary
    if (createdAtMs === null && typeof entry.timestamp === 'string') {
      const parsed = Date.parse(entry.timestamp)
      if (Number.isFinite(parsed)) createdAtMs = parsed
    }
    if (!firstPrompt && entry.type === 'user' && entry.isMeta !== true) {
      const content = asRecord(entry.message)?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((block) => readString(asRecord(block)?.text)).filter(Boolean).join('\n')
          : ''
      const request = text.split(MY_REQUEST_MARKER).at(-1) ?? text
      if (request.trim() && !request.includes('<local-command')) firstPrompt = request.trim().slice(0, 300)
    }
  }
  return { title: customTitle || aiTitle, firstPrompt, createdAtMs }
}

/** Complete lines between two byte offsets; a partly written last line waits. */
async function readAppendedLines(path: string, from: number, to: number): Promise<{ text: string; bytes: number } | null> {
  if (to <= from) return { text: '', bytes: 0 }
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(to - from)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from)
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1
    return { text: buffer.subarray(0, end).toString('utf8'), bytes: end }
  } finally {
    await handle.close()
  }
}

// ── Live turns ──────────────────────────────────────────────────────────

type LiveTurn = {
  turnId: string
  threadId: string
  sessionId: string
  cwd: string
  startedAtMs: number
  interrupted: boolean
  userMessage: SDKUserMessage | null
  tools: Map<string, ClaudeToolUse>
  textCounts: Map<string, number>
  reasoningCounts: Map<string, number>
  streamItems: Map<number, { type: 'text' | 'thinking'; itemId: string }>
  finalCounts: Map<string, number>
  usageMessageIds: Set<string>
  currentMessageId: string
  lastAgentText: string
  lastAgentItemId: string
  usage: ClaudeTokenUsage
  goalContinuation: boolean
  limitRecoveryAccountNumbers: number[]
  settled: boolean
}

type StartTurnExtra = {
  goalContinuation?: boolean
  limitRecoveryAccountNumbers?: readonly number[]
}

function runnerIsBusy(runner: SessionRunner): boolean {
  return Boolean(runner.activeTurn) || runner.pushedCommands.size > 0 || runner.backgroundTasks.length > 0
}

export function isClaudeHardLimitError(message: string): boolean {
  return /(?:you(?:'|’)ve\s+)?hit\s+your\s+(?:session|usage|weekly)\s+limit|(?:session|usage|weekly)\s+limit\s+(?:has\s+been\s+)?reached/iu.test(message)
}

type InputStream = {
  stream: AsyncGenerator<SDKUserMessage>
  push: (message: SDKUserMessage) => boolean
  release: () => void
}

function createInputStream(): InputStream {
  const pending: SDKUserMessage[] = []
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
    push(message) {
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

type SessionRunner = {
  sessionId: string
  /** File holding the current turn id for the cua relay, when Chrome goes through it. */
  cuaTurnFile: string | null
  /** Saved account active when this Claude process started; null if unknown. */
  accountNumber: number | null
  threadId: string
  cwd: string
  settingsKey: string
  query: Query
  input: InputStream
  activeTurn: LiveTurn | null
  pushedCommands: Map<string, SDKUserMessage>
  idleTimer: ReturnType<typeof setTimeout> | null
  interruptTimer: ReturnType<typeof setTimeout> | null
  totalUsage: ClaudeTokenUsage
  contextWindow: number
  /** Live background work (shell commands, subagents) that outlives a turn. */
  backgroundTasks: ClaudeBackgroundTask[]
  closed: boolean
}

export type ClaudeBackgroundTask = { id: string; type: string; description: string }

/** The non-ambient tasks of a `background_tasks_changed` message. */
function readBackgroundTasks(value: unknown): ClaudeBackgroundTask[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const task = asRecord(entry)
    const id = readString(task?.task_id)
    if (!task || !id || task.ambient === true) return []
    return [{ id, type: readString(task.task_type), description: readString(task.description) }]
  })
}

type UserContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const IMAGE_TYPES: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

async function readImageBlock(url: string): Promise<UserContentBlock | null> {
  const dataUrl = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/u)
  if (dataUrl) {
    return { type: 'image', source: { type: 'base64', media_type: dataUrl[1] as ImageMediaType, data: dataUrl[2] ?? '' } }
  }
  const path = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : url
  if (!path.startsWith('/')) return null
  const mediaType = IMAGE_TYPES[path.split('.').at(-1)?.toLowerCase() ?? '']
  if (!mediaType) return null
  try {
    const data = await readFile(path)
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } }
  } catch {
    return null
  }
}

/** Composer input in Codex shape, as one Claude user message. */
async function buildUserMessage(input: unknown, sessionId: string): Promise<SDKUserMessage | null> {
  const blocks = Array.isArray(input) ? input : []
  const texts: string[] = []
  const images: UserContentBlock[] = []
  const commands: string[] = []
  for (const block of blocks) {
    const record = asRecord(block)
    if (!record) continue
    if (record.type === 'text' && readString(record.text)) texts.push(readString(record.text))
    else if (record.type === 'image' || record.type === 'localImage') {
      const image = await readImageBlock(readString(record.url) || readString(record.path))
      if (image) images.push(image)
    } else if (record.type === 'skill') {
      const path = readString(record.path)
      const name = path.startsWith(SKILL_PATH_PREFIX) ? path.slice(SKILL_PATH_PREFIX.length) : readString(record.name)
      if (name && !commands.includes(name)) commands.push(name.replace(/^\//u, ''))
    }
  }
  let text = texts.join('\n')
    .replace(/my request for codex/giu, 'My request for Claude')
    .replace(/from an earlier Codex response/giu, 'from an earlier response')
  if (commands.length > 0 && !text.trimStart().startsWith('/')) {
    // A selected skill runs the way the CLI runs it: as the leading slash command.
    const [first, ...rest] = commands
    const extra = rest.length > 0 ? `\n\nAlso use these skills: ${rest.map((name) => `/${name}`).join(', ')}` : ''
    text = `/${first ?? ''} ${text}${extra}`.trim()
  }
  const content: UserContentBlock[] = []
  if (text.trim()) content.push({ type: 'text', text })
  content.push(...images)
  if (content.length === 0) return null
  return {
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content },
  }
}

function turnError(message: string) {
  return { message, codexErrorInfo: null, additionalDetails: null }
}

function toCodexUsage(usage: ClaudeTokenUsage): Record<string, number> {
  return { ...usage }
}

type QuestionRequest = {
  pending: ClaudePendingServerRequest
  questions: Array<{ id: string; text: string }>
  resolve: (answers: Record<string, string> | null) => void
}

type PermissionRequest = {
  pending: ClaudePendingServerRequest
  resolve: (accepted: boolean) => void
}

// ── Backend ─────────────────────────────────────────────────────────────

/** A CodexUI capability offered to Claude chats as an in-process MCP tool. */
export type ClaudeHostTool = {
  name: string
  description: string
  /** A zod raw shape describing the tool input. */
  shape: Record<string, unknown>
  handler: (
    context: { threadId: string; turnId: string; model: string },
    args: Record<string, unknown>,
  ) => Promise<string>
}

export type ClaudeBackendOptions = {
  /** Spawn Claude Code through a login-session host listening here. */
  hostSocketPath?: string
  tools?: ClaudeHostTool[]
  accountSwitcherPath?: string | null
  claudeConfigDir?: string
}

export class ClaudeBackend {
  private sdkPromise: Promise<SdkModule> | null = null
  private readonly listeners = new Set<NotificationListener>()
  private readonly runners = new Map<string, SessionRunner>()
  private readonly store: ClaudeThreadStore
  private readonly hostSocketPath: string
  private readonly tools: ClaudeHostTool[]
  private readonly claudeConfigDirectory: string
  readonly accounts: ClaudeAccountSwitcher
  private readonly metadataQueries = new Set<Query>()
  private accountGeneration = 0
  private changingAccount = false
  private runtimeCache: { at: number; value: ClaudeRuntimeState } | null = null
  private runtimePending: Promise<ClaudeRuntimeState> | null = null
  private usageCache: { at: number; value: ClaudeUsage } | null = null
  private usagePending: Promise<ClaudeUsage | null> | null = null
  private usageNextReadAt = 0
  private usageFailures = 0
  private listCache: { at: number; key: string; value: Promise<SDKSessionInfo[]> } | null = null
  private readonly commandsCache = new Map<string, { at: number; value: Promise<SlashCommand[]> }>()
  private readonly transcriptPaths = new Map<string, string>()
  private readonly transcriptCache = new Map<string, ParsedTranscript>()
  private readonly questions = new Map<number, QuestionRequest>()
  private readonly permissions = new Map<number, PermissionRequest>()
  private readonly computerUseAllowedThreads = new Set<string>()
  /** Each Chrome-capable runner's current turn id, read by the cua relay. */
  private readonly cuaTurnDirectory: string
  /** Best-known chat names, for notification titles. */
  private readonly sessionTitles = new Map<string, string>()
  private readonly humanSessions = new Map<string, { human: boolean; lastModified: number }>()
  /** When CodexUI last saw its own Claude process write each session. */
  private readonly ownActivityMs = new Map<string, number>()
  private claudeSessionStates = new Map<string, ClaudeSessionState>()
  private claudeSessionScan: Promise<ClaudeSessionRegistryScan> | null = null
  private claudeSessionStatesInitialized = false
  private claudeSessionTimer: ReturnType<typeof setInterval> | null = null
  private nextRequestId = SERVER_REQUEST_ID_BASE
  private login: ClaudeLogin | null = null

  constructor(storeFilePath: string, options: ClaudeBackendOptions = {}) {
    this.store = new ClaudeThreadStore(storeFilePath)
    this.cuaTurnDirectory = join(dirname(storeFilePath), 'codexui-cua-turns')
    this.hostSocketPath = options.hostSocketPath?.trim() ?? ''
    this.tools = options.tools ?? []
    this.claudeConfigDirectory = options.claudeConfigDir?.trim() || claudeConfigDir()
    this.accounts = new ClaudeAccountSwitcher({
      stateFilePath: join(dirname(storeFilePath), 'codexui-claude-accounts.json'),
      executable: options.accountSwitcherPath === undefined ? resolveCSwapExecutable() : options.accountSwitcherPath,
      run: (command, args) => this.runAccountCommand(command, args),
      isBusy: () => this.isClaudeBusy(),
      isAuthenticating: () => Boolean(this.login) || this.changingAccount,
      prepareSwitch: (options) => this.prepareAccountChange(options),
      accountChanged: () => this.accountChanged(),
    })
    this.accounts.start()
    void this.refreshClaudeSessionStates()
    this.claudeSessionTimer = setInterval(() => { void this.refreshClaudeSessionStates() }, CLAUDE_SESSION_POLL_MS)
    this.claudeSessionTimer.unref?.()
  }

  private sdk(): Promise<SdkModule> {
    this.sdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
    return this.sdkPromise
  }

  // ── Processes ──

  private spawnChild(command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): SpawnedChild {
    if (this.hostSocketPath) {
      return spawnThroughHost(this.hostSocketPath, {
        command,
        args,
        cwd: options.cwd,
        env: options.env as Record<string, string | undefined>,
      }, options.signal)
    }
    return spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  private baseOptions(cwd?: string): Options {
    const options: Options = {
      cwd: cwd || homedir(),
      env: getCodexUiChildEnv(),
      settingSources: ['user', 'project', 'local'],
      ...(process.env.CODEXUI_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.CODEXUI_CLAUDE_PATH } : {}),
    }
    if (this.hostSocketPath) {
      options.spawnClaudeCodeProcess = (spawnOptions: SpawnOptions): SpawnedProcess =>
        spawnThroughHost(this.hostSocketPath, {
          command: spawnOptions.command,
          args: spawnOptions.args,
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
        }, spawnOptions.signal) as unknown as SpawnedProcess
    }
    return options
  }

  private async runClaudeCommand(args: string[]): Promise<void> {
    const child = this.spawnChild(resolveClaudeExecutable(), args, { env: getCodexUiChildEnv() })
    child.stdin.end()
    await new Promise<void>((resolve, reject) => {
      let errorText = ''
      child.stderr.on('data', (chunk: Buffer) => { errorText += chunk.toString() })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(errorText.trim() || `Claude command exited with code ${String(code)}`))
      })
    })
  }

  private async runAccountCommand(command: string, args: string[]): Promise<CSwapResult> {
    const child = this.spawnChild(command, args, { env: getCodexUiChildEnv() })
    return new Promise((resolve, reject) => {
      let stdout = ''
      let settled = false
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(new Error('Claude account management timed out. Try refreshing accounts.'))
      }, 90_000)
      timer.unref?.()
      const finish = (error?: Error, code: number | null = null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve({ code, stdout })
      }
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.length > 1024 * 1024) {
          child.kill('SIGTERM')
          finish(new Error('Claude account response was too large.'))
        }
      })
      // Never return or log raw CLI errors: account tools handle credentials.
      child.stderr.on('data', () => undefined)
      child.once('error', () => finish(new Error('Could not start claude-swap in the Claude host.')))
      child.once('close', (code) => finish(undefined, code))
      child.stdin.on('error', () => undefined)
      child.stdin.end(args[0] === 'remove' ? 'y\n' : '')
    })
  }

  private async prepareAccountChange(options: { keepBusy?: boolean } = {}): Promise<void> {
    if (!options.keepBusy && await this.isClaudeBusy()) {
      throw new Error('Wait for Claude replies to finish before changing accounts.')
    }
    this.changingAccount = true
    this.accountGeneration += 1
    for (const query of this.metadataQueries) query.close()
    this.metadataQueries.clear()
    for (const runner of [...this.runners.values()]) {
      // A kept runner finishes on the login it started with; its next limit
      // error is attributed to that account, then recovered in a fresh process.
      if (options.keepBusy && runnerIsBusy(runner)) continue
      this.closeRunner(runner.sessionId, { expected: runner })
      runner.query.close()
    }
    if (this.runtimePending) await this.runtimePending.catch(() => undefined)
    this.runtimeCache = null
    this.usageCache = null
    this.commandsCache.clear()
  }

  private accountChanged(): void {
    this.accountGeneration += 1
    this.runtimeCache = null
    this.usageCache = null
    this.commandsCache.clear()
    this.changingAccount = false
    this.emit('account/updated', { provider: 'claude' })
  }

  // ── Runtime metadata ──

  private async readRuntime(force = false): Promise<ClaudeRuntimeState> {
    if (this.changingAccount || this.login) throw new Error('Claude account sign-in or switching is in progress.')
    const generation = this.accountGeneration
    const cached = this.runtimeCache
    if (!force && cached && Date.now() - cached.at < RUNTIME_CACHE_MS) return cached.value
    if (!force && cached?.value.connected) {
      // Serve the known catalog now and refresh it in the background, so a
      // turn after a quiet spell does not wait for a metadata process.
      if (!this.runtimePending) void this.readRuntime(true).catch(() => undefined)
      return cached.value
    }
    if (this.runtimePending) return this.runtimePending
    const pending = (async () => {
      const { query } = await this.sdk()
      if (generation !== this.accountGeneration || this.changingAccount || this.login) throw new Error('Claude account changed. Refresh accounts.')
      const runtimeQuery = query({ prompt: emptyInput(), options: this.baseOptions() })
      this.metadataQueries.add(runtimeQuery)
      try {
        const [models, account] = await Promise.race([
          Promise.all([runtimeQuery.supportedModels(), runtimeQuery.accountInfo()]),
          rejectAfter(45_000, 'Claude Code did not respond.'),
        ])
        const value = { account, connected: isClaudeConnected(account), models }
        if (generation !== this.accountGeneration) throw new Error('Claude account changed. Refresh to read the new account.')
        this.runtimeCache = { at: Date.now(), value }
        return value
      } finally {
        runtimeQuery.close()
        this.metadataQueries.delete(runtimeQuery)
      }
    })()
    this.runtimePending = pending
    try {
      return await pending
    } catch (error) {
      if (cached && generation === this.accountGeneration) return cached.value
      throw error
    } finally {
      if (this.runtimePending === pending) this.runtimePending = null
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
      authMethod: runtime.account.tokenSource ?? runtime.account.apiKeySource ?? (
        runtime.connected && runtime.account.apiProvider === 'firstParty' ? 'claude.ai' : null
      ),
      apiProvider: runtime.account.apiProvider ?? null,
    }
  }

  async readUsage(_force = false): Promise<ClaudeUsage | null> {
    const generation = this.accountGeneration
    const runtime = await this.readRuntime()
    if (!runtime.connected || runtime.account.apiProvider !== 'firstParty') return null
    const pool = await this.accounts.snapshot()
    if (pool.installed) {
      // One collector for both the active plan card and all saved accounts.
      // Never stack the SDK's usage requests on top of cswap's requests.
      const active = pool.accounts.find((account) => account.active)
      return {
        plan: runtime.account.subscriptionType ?? null,
        limits: (active?.limits ?? []).map((limit) => ({ ...limit, key: limit.label === '5 hours' ? 'five_hour' : 'seven_day' })),
        ...(active?.usageIsStale || active?.usageRateLimited ? { notice: 'Showing cached Claude usage while usage checks recover.' }
          : !active ? { notice: 'Save current login to see Claude usage.' } : {}),
      }
    }
    if (this.usagePending) return this.usagePending
    if (Date.now() < this.usageNextReadAt) return this.usageCache?.value ?? { plan: runtime.account.subscriptionType ?? null, limits: [], notice: 'Claude usage checks are cooling down. Try again later.' }
    this.usageNextReadAt = Date.now() + CLAUDE_SDK_USAGE_POLL_MS
    const pending = this.readSdkUsage(runtime, generation)
    this.usagePending = pending
    try { return await pending } finally { if (this.usagePending === pending) this.usagePending = null }
  }

  private async readSdkUsage(runtime: ClaudeRuntimeState, generation: number): Promise<ClaudeUsage | null> {
    const { query } = await this.sdk()
    if (generation !== this.accountGeneration || this.changingAccount || this.login) return null
    const usageQuery = query({ prompt: emptyInput(), options: this.baseOptions() })
    this.metadataQueries.add(usageQuery)
    try {
      const response = await Promise.race([
        usageQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        rejectAfter(45_000, 'Claude usage did not respond.'),
      ])
      const value = normalizeClaudeUsage(response, runtime.account.subscriptionType ?? null)
      if (generation !== this.accountGeneration) return null
      this.usageCache = { at: Date.now(), value }
      this.usageFailures = 0
      return value
    } catch (error) {
      if (generation !== this.accountGeneration) return null
      this.usageFailures += 1
      const detail = asRecord(error)
      const limited = detail?.status === 429 || /429|rate.?limit/iu.test(error instanceof Error ? error.message : '')
      const headers = detail?.headers
      const retryAfter = headers instanceof Headers ? headers.get('retry-after') : readString(asRecord(headers)?.['retry-after'])
      const serverDelay = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter || '') - Date.now()) || 0
      const delay = Math.max(serverDelay, limited ? 60 * 60_000 : Math.min(60 * 60_000, CLAUDE_SDK_USAGE_POLL_MS * 2 ** Math.min(this.usageFailures - 1, 3)))
      this.usageNextReadAt = Date.now() + delay
      const notice = limited ? 'Claude usage checks hit a 429. Showing cached usage; checks will resume after the cooldown.' : 'Claude usage refresh failed. Showing cached usage until the next check.'
      if (this.usageCache) {
        this.usageCache = { ...this.usageCache, value: { ...this.usageCache.value, notice } }
        return this.usageCache.value
      }
      return {
        plan: runtime.account.subscriptionType ?? null,
        limits: [],
        notice: limited ? 'Claude usage checks hit a 429. Checks are paused; Claude chats still work.' : 'Claude usage is temporarily unavailable. Checks will retry after the cooldown.',
      }
    } finally {
      usageQuery.close()
      this.metadataQueries.delete(usageQuery)
    }
  }

  async listModels(): Promise<Record<string, unknown>[]> {
    const runtime = await this.readRuntime()
    return runtime.connected ? runtime.models.map(runtimeModel) : []
  }

  /** Claude Code's skills and slash commands for a folder, as composer skills. */
  async listSkills(cwd: string): Promise<Record<string, unknown>> {
    if (this.changingAccount || this.login) throw new Error('Finish Claude sign-in or switching before loading skills.')
    const generation = this.accountGeneration
    const key = cwd || homedir()
    const cached = this.commandsCache.get(key)
    let pending = cached && Date.now() - cached.at < COMMANDS_CACHE_MS ? cached.value : null
    if (!pending) {
      pending = (async () => {
        const { query } = await this.sdk()
        if (generation !== this.accountGeneration || this.changingAccount || this.login) throw new Error('Claude account changed. Refresh skills.')
        const commandsQuery = query({ prompt: emptyInput(), options: this.baseOptions(existsSync(key) ? key : undefined) })
        this.metadataQueries.add(commandsQuery)
        try {
          const commands = await Promise.race([commandsQuery.supportedCommands(), rejectAfter(45_000, 'Claude Code did not list its commands.')])
          if (generation !== this.accountGeneration) throw new Error('Claude account changed. Refresh skills.')
          return commands
        } finally {
          commandsQuery.close()
          this.metadataQueries.delete(commandsQuery)
        }
      })()
      this.commandsCache.set(key, { at: Date.now(), value: pending })
      pending.catch(() => this.commandsCache.delete(key))
    }
    const commands = await pending
    return {
      data: [{
        cwd: key,
        skills: commands.map((command) => ({
          name: command.name,
          description: command.description || command.argumentHint || '',
          shortDescription: command.description || '',
          path: `${SKILL_PATH_PREFIX}${command.name}`,
          scope: 'user',
          enabled: true,
        })),
        errors: [],
      }],
    }
  }

  // ── Sign-in ──

  async startLogin(): Promise<{ loginId: string; authUrl: string }> {
    return this.accounts.exclusive(() => this.startLoginUnlocked())
  }

  private async startLoginUnlocked(): Promise<{ loginId: string; authUrl: string }> {
    this.cancelLogin()
    if ([...this.runners.values()].some((runner) => runner.activeTurn || runner.pushedCommands.size > 0)) {
      throw new Error('Wait for Claude replies to finish before adding an account.')
    }
    const pool = await this.accounts.snapshot()
    if (pool.installed && (await this.readProviderStatus().catch(() => null))?.connected) await this.accounts.saveCurrent()
    try { await this.prepareAccountChange() } finally { this.changingAccount = false }
    const child = this.spawnChild(resolveClaudeExecutable(), ['auth', 'login', '--claudeai'], {
      env: {
        ...getCodexUiChildEnv(),
        ...(process.platform === 'win32' ? {} : { BROWSER: '/usr/bin/false' }),
      },
    })
    let output = ''
    let resolveUrl: ((url: string) => void) | null = null
    let rejectUrl: ((error: Error) => void) | null = null
    const authUrlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve
      rejectUrl = reject
    })
    const appendOutput = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-32_768)
      const match = output.match(/https:\/\/(?:claude\.com|claude\.ai)\/[^\s\u001b\u0007]+/u)
      if (match && resolveUrl) {
        resolveUrl(match[0])
        resolveUrl = null
        rejectUrl = null
      }
    }
    child.stdout.on('data', appendOutput)
    child.stderr.on('data', appendOutput)
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        if (rejectUrl) {
          rejectUrl(new Error('Claude CLI ended before returning a login URL.'))
          resolveUrl = null
          rejectUrl = null
        }
        if (code === 0) resolve()
        else reject(new Error('Claude CLI rejected the sign-in.'))
      })
    })
    void completion.catch(() => undefined)
    try {
      const authUrl = await Promise.race([
        authUrlPromise,
        rejectAfter(15_000, 'Claude did not return a login URL.'),
      ])
      const id = randomUUID()
      const timer = setTimeout(() => {
        if (this.login?.id === id) this.cancelLogin()
      }, 10 * 60_000)
      timer.unref?.()
      this.login = { id, child, completion, timer }
      return { loginId: id, authUrl }
    } catch (error) {
      child.kill('SIGTERM')
      throw error
    }
  }

  async completeLogin(loginId: string, pastedCode: string): Promise<ClaudeProviderStatus> {
    return this.accounts.exclusive(() => this.completeLoginUnlocked(loginId, pastedCode))
  }

  private async completeLoginUnlocked(loginId: string, pastedCode: string): Promise<ClaudeProviderStatus> {
    const login = this.login
    if (!login || login.id !== loginId) throw new Error('This Claude login has expired. Start again.')
    const authorizationCode = pastedCode.trim()
    if (!authorizationCode) throw new Error('Paste the authorization code from Claude.')
    await this.accounts.drainReads()
    try {
      login.child.stdin.end(`${authorizationCode}\n`)
      await Promise.race([
        login.completion,
        rejectAfter(60_000, 'Claude sign-in timed out.'),
      ])
    } catch {
      throw new Error('Claude could not complete sign-in. Start again and paste the new authorization code.')
    } finally {
      this.cancelLogin()
    }
    this.accountChanged()
    const status = await this.readProviderStatus(true)
    if (!status.connected) throw new Error('Claude sign-in completed, but the saved account could not be read.')
    try { await this.accounts.saveCurrent() } catch {
      status.notice = 'Signed in, but this account was not saved for switching. Choose Save current login and try again.'
    }
    return status
  }

  cancelLogin(): void {
    if (!this.login) return
    clearTimeout(this.login.timer)
    if (!this.login.child.killed && this.login.child.exitCode === null) this.login.child.kill('SIGTERM')
    this.login = null
  }

  async logout(): Promise<void> {
    // Disable rotation before logging out so it cannot silently sign back in.
    const pool = await this.accounts.snapshot()
    await this.accounts.configure(false, pool.threshold)
    await this.accounts.exclusive(async () => {
      this.cancelLogin()
      try {
        await this.prepareAccountChange()
        await this.runClaudeCommand(['auth', 'logout'])
      } finally { this.accountChanged() }
    })
  }

  // ── Notifications ──

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(method: string, params: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener({ method, params })
      } catch (error) {
        console.warn('[claude-backend] Notification listener failed:', error instanceof Error ? error.message : error)
      }
    }
  }

  // ── Sessions and transcripts ──

  private async listAllSessions(): Promise<SDKSessionInfo[]> {
    const store = await this.store.read()
    const key = String(Object.keys(store.threads).length)
    if (this.listCache && this.listCache.key === key && Date.now() - this.listCache.at < LIST_CACHE_MS) {
      return this.listCache.value
    }
    const value = (async () => {
      const { listSessions } = await this.sdk()
      // Match the CLI's own /resume list: interactive sessions, plus the
      // programmatic sessions this app started. Other tools' headless runs stay out.
      const [interactive, everything] = await Promise.all([
        listSessions({ includeProgrammatic: false }),
        listSessions({ includeProgrammatic: true }),
      ])
      const byId = new Map(interactive.map((info) => [info.sessionId, info]))
      for (const info of everything) {
        if (byId.has(info.sessionId)) continue
        // Remote Control and phone chats are recorded like headless runs;
        // what sets them apart is that a person typed the prompts.
        if (store.threads[info.sessionId] || await this.hasHumanPrompt(info)) byId.set(info.sessionId, info)
      }
      // A Remote Control terminal writes a session before anyone chats in it;
      // sessions without a prompt have nothing to show.
      return [...byId.values()]
        .filter((info) => Boolean(info.firstPrompt?.trim()))
        .sort((a, b) => b.lastModified - a.lastModified)
    })()
    this.listCache = { at: Date.now(), key, value }
    value.catch(() => { if (this.listCache?.value === value) this.listCache = null })
    return value
  }

  /** Whether a person typed in this session, as opposed to a script or tool. */
  private async hasHumanPrompt(info: SDKSessionInfo): Promise<boolean> {
    const known = this.humanSessions.get(info.sessionId)
    if (known && (known.human || known.lastModified === info.lastModified)) return known.human
    const path = await this.findTranscriptPath(info.sessionId, info.cwd ?? '')
    if (!path) return false
    const handle = await open(path, 'r').catch(() => null)
    if (!handle) return false
    try {
      const buffer = Buffer.alloc(HUMAN_PROMPT_SCAN_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const head = buffer.subarray(0, bytesRead).toString('utf8')
      const human = head.includes('"turnOrigin":"human"') || head.includes('"origin":{"kind":"human"}')
      this.humanSessions.set(info.sessionId, { human, lastModified: info.lastModified })
      return human
    } finally {
      await handle.close()
    }
  }

  private invalidateList(): void {
    this.listCache = null
  }

  private async refreshClaudeSessionStates(): Promise<ClaudeSessionRegistryScan> {
    if (this.claudeSessionScan) return this.claudeSessionScan
    const previous = this.claudeSessionStates
    const hadPrevious = this.claudeSessionStatesInitialized
    const pending = scanClaudeSessionRegistry(this.claudeConfigDirectory).then((scan) => {
      this.claudeSessionStates = scan.states
      this.claudeSessionStatesInitialized = true
      if (hadPrevious) {
        const sessionIds = new Set([...previous.keys(), ...scan.states.keys()])
        for (const sessionId of sessionIds) {
          const wasActive = isClaudeSessionActive(previous.get(sessionId))
          const active = isClaudeSessionActive(scan.states.get(sessionId))
          if (wasActive === active) continue
          this.invalidateList()
          this.emit('thread/status/changed', {
            threadId: toThreadId(sessionId),
            status: { type: active ? 'active' : 'idle' },
          })
          if (!active) void this.accounts.tick()
        }
      }
      return scan
    })
    this.claudeSessionScan = pending
    try {
      return await pending
    } finally {
      if (this.claudeSessionScan === pending) this.claudeSessionScan = null
    }
  }

  private async isClaudeBusy(): Promise<boolean> {
    if (this.login || [...this.runners.values()].some(runnerIsBusy)) return true
    const scan = await this.refreshClaudeSessionStates()
    return scan.uncertain || [...scan.states.values()].some(isClaudeSessionActive)
  }

  private sessionIsActive(sessionId: string): boolean {
    return Boolean(this.liveTurnFor(sessionId)) || isClaudeSessionActive(this.claudeSessionStates.get(sessionId))
  }

  /** Claude Code stores each chat as `<config>/projects/<encoded cwd>/<session id>.jsonl`. */
  private async findTranscriptPath(sessionId: string, cwdHint = ''): Promise<string | null> {
    const cached = this.transcriptPaths.get(sessionId)
    if (cached && existsSync(cached)) return cached
    const projectsDir = join(this.claudeConfigDirectory, 'projects')
    if (cwdHint) {
      const direct = join(projectsDir, projectDirName(cwdHint), `${sessionId}.jsonl`)
      if (existsSync(direct)) {
        this.transcriptPaths.set(sessionId, direct)
        return direct
      }
    }
    const dirs = await readdir(projectsDir).catch(() => [] as string[])
    for (const dir of dirs) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) {
        this.transcriptPaths.set(sessionId, candidate)
        return candidate
      }
    }
    return null
  }

  private async readTranscript(sessionId: string, cwdHint = ''): Promise<ParsedTranscript | null> {
    const path = await this.findTranscriptPath(sessionId, cwdHint)
    if (!path) return null
    const info = await stat(path).catch(() => null)
    if (!info) return null
    const cached = this.transcriptCache.get(path)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      this.transcriptCache.delete(path)
      this.transcriptCache.set(path, cached)
      return cached
    }
    // Transcripts only grow: while Claude replies, parse just the new lines.
    const appended = cached && info.size >= cached.consumed
      ? await readAppendedLines(path, cached.consumed, info.size)
      : null
    const full = appended ? null : await readAppendedLines(path, 0, info.size)
    const delta = appended ?? full
    if (!delta) return cached ?? null
    const entries = appended && cached ? [...cached.entries, ...parseTranscript(delta.text)] : parseTranscript(delta.text)
    const consumed = (appended && cached ? cached.consumed : 0) + delta.bytes
    const { title, firstPrompt, createdAtMs } = readTitle(entries)
    const parsed: ParsedTranscript = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      consumed,
      entries,
      chain: resolveMainChain(entries),
      title,
      firstPrompt,
      createdAtMs,
    }
    this.transcriptCache.delete(path)
    this.transcriptCache.set(path, parsed)
    // Keep recently read chats by source size, not count: one long session
    // can be tens of megabytes.
    let cachedBytes = 0
    for (const [cachedPath, cachedTranscript] of [...this.transcriptCache].reverse()) {
      cachedBytes += cachedTranscript.size
      if (cachedBytes > TRANSCRIPT_CACHE_BYTES && cachedPath !== path) this.transcriptCache.delete(cachedPath)
    }
    return parsed
  }

  private liveTurnFor(sessionId: string): LiveTurn | null {
    return this.runners.get(sessionId)?.activeTurn ?? null
  }

  private threadPayload(
    sessionId: string,
    meta: { name: string; preview: string; cwd: string; createdAtMs: number | null; updatedAtMs: number | null },
    turns: unknown[] = [],
  ): Record<string, unknown> {
    return {
      id: toThreadId(sessionId),
      preview: meta.preview || meta.name,
      name: meta.name || null,
      modelProvider: MODEL_PROVIDER,
      createdAt: toSeconds(meta.createdAtMs ?? meta.updatedAtMs),
      updatedAt: toSeconds(meta.updatedAtMs ?? meta.createdAtMs),
      path: null,
      cwd: meta.cwd,
      cliVersion: 'claude-code',
      source: 'cli',
      gitInfo: null,
      status: { type: this.sessionIsActive(sessionId) ? 'active' : 'idle' },
      backgroundTasks: this.runners.get(sessionId)?.backgroundTasks ?? [],
      turns,
    }
  }

  private async threadFromInfo(info: SDKSessionInfo): Promise<Record<string, unknown>> {
    const stored = await this.store.get(info.sessionId)
    const name = info.customTitle || info.summary || ''
    if (name) this.sessionTitles.set(info.sessionId, name)
    return this.threadPayload(info.sessionId, {
      name,
      preview: info.firstPrompt || name,
      cwd: info.cwd || stored?.cwd || '',
      createdAtMs: info.createdAt ?? stored?.createdAtMs ?? null,
      updatedAtMs: info.lastModified,
    })
  }

  async listThreads(params: unknown): Promise<Record<string, unknown>[]> {
    const request = asRecord(params)
    const limit = typeof request?.limit === 'number' ? request.limit : 100
    const wantArchived = request?.archived === true
    const [sessions, store] = await Promise.all([this.listAllSessions(), this.store.read(), this.refreshClaudeSessionStates()])
    const threads: Record<string, unknown>[] = []
    const seen = new Set<string>()
    for (const info of sessions) {
      if ((store.threads[info.sessionId]?.archived === true) !== wantArchived) continue
      seen.add(info.sessionId)
      threads.push(await this.threadFromInfo(info))
      if (threads.length >= limit) break
    }
    // A chat started here has no transcript until Claude writes its first entry.
    for (const [sessionId, stored] of Object.entries(store.threads)) {
      if (seen.has(sessionId) || stored.archived === true || wantArchived || !this.liveTurnFor(sessionId)) continue
      threads.push(this.threadPayload(sessionId, {
        name: '', preview: '', cwd: stored.cwd, createdAtMs: stored.createdAtMs, updatedAtMs: Date.now(),
      }))
    }
    return threads
  }

  async searchThreads(params: unknown): Promise<Array<{ thread: Record<string, unknown>; snippet: string }>> {
    const request = asRecord(params)
    const term = readString(request?.searchTerm).trim().toLowerCase()
    const limit = typeof request?.limit === 'number' ? request.limit : 50
    if (!term) return []
    const [sessions, store] = await Promise.all([this.listAllSessions(), this.store.read(), this.refreshClaudeSessionStates()])
    const results: Array<{ thread: Record<string, unknown>; snippet: string }> = []
    for (const info of sessions.slice(0, SEARCH_FILE_LIMIT)) {
      if (store.threads[info.sessionId]?.archived === true) continue
      const title = `${info.customTitle ?? ''} ${info.summary} ${info.firstPrompt ?? ''}`
      let snippet = title.toLowerCase().includes(term) ? (info.firstPrompt || info.summary) : ''
      if (!snippet) snippet = await this.searchTranscriptText(info, term)
      if (!snippet) continue
      results.push({ thread: await this.threadFromInfo(info), snippet })
      if (results.length >= limit) break
    }
    return results
  }

  private async searchTranscriptText(info: SDKSessionInfo, term: string): Promise<string> {
    if ((info.fileSize ?? 0) > SEARCH_MAX_BYTES) return ''
    const path = await this.findTranscriptPath(info.sessionId, info.cwd ?? '')
    if (!path) return ''
    const raw = await readFile(path, 'utf8').catch(() => '')
    if (!raw.toLowerCase().includes(term)) return ''
    for (const entry of parseTranscript(raw)) {
      if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta === true) continue
      const content = asRecord(entry.message)?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((block) => {
            const record = asRecord(block)
            return record?.type === 'text' ? readString(record.text) : ''
          }).join('\n')
          : ''
      const index = text.toLowerCase().indexOf(term)
      if (index < 0) continue
      const start = Math.max(0, index - 100)
      return `${start > 0 ? '…' : ''}${text.slice(start, index + term.length + 160).replace(/\s+/gu, ' ').trim()}`
    }
    return ''
  }

  // ── RPC ──

  async rpc(method: string, params: unknown): Promise<unknown> {
    const request = asRecord(params) ?? {}
    const threadId = readString(request.threadId)
    switch (method) {
      case 'thread/start':
        return this.startThread(request)
      case 'thread/read':
        return { thread: await this.readThread(threadId, request.includeTurns === true) }
      case 'thread/turns/list':
        return { data: asRecord(await this.readThread(threadId, true))?.turns ?? [], nextCursor: null }
      case 'thread/resume':
        return this.resumeThread(threadId)
      case 'turn/start':
      case 'turn/steer':
        return this.startTurn(request)
      case 'turn/interrupt':
        return this.interrupt(threadId)
      case 'thread/backgroundTask/stop':
        return this.stopBackgroundTask(threadId, readString(request.taskId))
      case 'thread/name/set':
        return this.setName(threadId, readString(request.name))
      case 'thread/archive':
        await this.store.update(toSessionId(threadId), { archived: true })
        this.invalidateList()
        this.emit('thread/archived', { threadId })
        return {}
      case 'thread/unarchive':
        await this.store.update(toSessionId(threadId), { archived: false })
        this.invalidateList()
        this.emit('thread/unarchived', { threadId })
        return {}
      case 'thread/fork':
        return this.forkThread(request)
      case 'thread/rollback':
        return this.rollbackThread(threadId, typeof request.numTurns === 'number' ? request.numTurns : 0)
      case 'thread/unsubscribe':
        return {}
      case 'thread/goal/get':
        return { goal: await this.readGoal(threadId) }
      case 'thread/goal/set':
        return { goal: await this.setGoal(threadId, request) }
      case 'thread/goal/clear':
        return { cleared: await this.clearGoal(threadId) }
      default:
        throw new Error(`${method} is not available for Claude chats.`)
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
    const cwd = readString(request.cwd) || homedir()
    const stored = await this.store.update(sessionId, { cwd, model, effort, createdAtMs: Date.now() })
    this.invalidateList()
    const thread = this.threadPayload(sessionId, { name: '', preview: '', cwd, createdAtMs: stored.createdAtMs, updatedAtMs: stored.createdAtMs })
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

  private async readThread(threadId: string, includeTurns: boolean): Promise<Record<string, unknown>> {
    const sessionId = toSessionId(threadId)
    const [stored] = await Promise.all([this.store.get(sessionId), this.refreshClaudeSessionStates()])
    const transcript = await this.readTranscript(sessionId, stored?.cwd ?? '')
    if (!transcript && !stored) throw new Error(`Claude chat ${threadId} was not found.`)
    const live = this.liveTurnFor(sessionId)
    const chain = transcript
      ? (stored?.rewindAt ? truncateChain(transcript.chain, stored.rewindAt) : transcript.chain)
      : []
    let summary = buildTurnsFromChain(chain, stored?.cwd ?? '', { liveTurnId: live?.turnId ?? null })
    const externalTurnId = !live && isClaudeSessionActive(this.claudeSessionStates.get(sessionId))
      ? summary.turns.at(-1)?.id
      : null
    if (externalTurnId) summary = buildTurnsFromChain(chain, stored?.cwd ?? '', { liveTurnId: externalTurnId })
    if (transcript?.title) this.sessionTitles.set(sessionId, transcript.title)
    const meta = {
      name: transcript?.title ?? '',
      preview: transcript?.firstPrompt ?? '',
      cwd: summary.cwd || stored?.cwd || '',
      createdAtMs: transcript?.createdAtMs ?? stored?.createdAtMs ?? null,
      updatedAtMs: transcript?.mtimeMs ?? stored?.createdAtMs ?? null,
    }
    if (!includeTurns) return this.threadPayload(sessionId, meta)
    const turns: ClaudeTurn[] = [...summary.turns]
    if (live && !turns.some((turn) => turn.id === live.turnId)) {
      // Claude has not written the new prompt yet; keep the turn visible as running.
      const content = live.userMessage?.message.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map((block) => readString(asRecord(block)?.text)).join('\n') : ''
      turns.push({
        id: live.turnId,
        items: text ? [{ type: 'userMessage', id: live.turnId, content: [{ type: 'text', text }] }] : [],
        status: 'inProgress',
        error: null,
        startedAtMs: live.startedAtMs,
        completedAtMs: null,
      })
    }
    return this.threadPayload(sessionId, meta, turns.map(({ startedAtMs: _s, completedAtMs: _c, ...turn }) => turn))
  }

  private async resumeThread(threadId: string) {
    const sessionId = toSessionId(threadId)
    const stored = await this.store.get(sessionId)
    const thread = await this.readThread(threadId, false)
    void this.publishTranscriptUsage(sessionId, stored)
    return this.threadConfigResponse(thread, stored)
  }

  /** Context-window usage from history, so the composer meter shows before a reply. */
  private async publishTranscriptUsage(sessionId: string, stored: StoredThread | undefined): Promise<void> {
    try {
      const transcript = await this.readTranscript(sessionId, stored?.cwd ?? '')
      if (!transcript) return
      const summary = buildTurnsFromChain(transcript.chain, stored?.cwd ?? '')
      const last = summary.lastUsage
      const lastTurn = summary.turns.at(-1)
      if (!last || !lastTurn) return
      const contextWindow = stored?.contextWindow
        ?? (last.inputTokens > DEFAULT_CONTEXT_WINDOW || /\[1m\]/u.test(summary.model) ? 1_000_000 : DEFAULT_CONTEXT_WINDOW)
      this.emit('thread/tokenUsage/updated', {
        threadId: toThreadId(sessionId),
        turnId: lastTurn.id,
        tokenUsage: { total: toCodexUsage(summary.totalUsage), last: toCodexUsage(last), modelContextWindow: contextWindow },
      })
    } catch {
      // Usage is informational.
    }
  }

  /**
   * The previous CodexUI process ran this chat, and the Claude host stopped its
   * Claude process when that server went away. Its last transcript writes are
   * ours, so the external-activity guard must not refuse the continue message.
   */
  /** A chat CodexUI started or continued, and the user has not archived. */
  async isListedChat(threadId: string): Promise<boolean> {
    const stored = await this.store.get(toSessionId(threadId))
    return Boolean(stored && !stored.archived)
  }

  adoptInterruptedSession(threadId: string): void {
    this.ownActivityMs.set(toSessionId(threadId), Date.now())
  }

  private async setName(threadId: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return {}
    const sessionId = toSessionId(threadId)
    if (await this.findTranscriptPath(sessionId, (await this.store.get(sessionId))?.cwd ?? '')) {
      const { renameSession } = await this.sdk()
      await renameSession(sessionId, trimmed)
      this.ownActivityMs.set(sessionId, Date.now())
    }
    this.invalidateList()
    this.sessionTitles.set(sessionId, trimmed)
    this.emit('thread/name/updated', { threadId, threadName: trimmed })
    return {}
  }

  private async forkThread(request: Record<string, unknown>) {
    const sourceThreadId = readString(request.threadId)
    const sourceSessionId = toSessionId(sourceThreadId)
    const stored = await this.store.get(sourceSessionId)
    const sourcePath = await this.findTranscriptPath(sourceSessionId, stored?.cwd ?? '')
    if (!sourcePath) throw new Error('This Claude chat has no saved messages to continue from.')
    const { forkSession } = await this.sdk()
    const transcript = await this.readTranscript(sourceSessionId, stored?.cwd ?? '')
    const upTo = stored?.rewindAt ?? undefined
    const { sessionId } = await forkSession(sourceSessionId, {
      ...(upTo ? { upToMessageId: upTo } : {}),
      ...(transcript?.title ? { title: transcript.title } : {}),
    })
    const sourceCwd = stored?.cwd || buildTurnsFromChain(transcript?.chain ?? [], '').cwd
    const cwd = readString(request.cwd) || sourceCwd
    const forkedPath = await this.findTranscriptPath(sessionId, sourceCwd)
    if (forkedPath && cwd && cwd !== sourceCwd) {
      // Claude finds a session by its working folder, so a fork into a new
      // worktree moves to that folder's project directory.
      const targetDir = join(this.claudeConfigDirectory, 'projects', projectDirName(cwd))
      await mkdir(targetDir, { recursive: true })
      const target = join(targetDir, `${sessionId}.jsonl`)
      await rename(forkedPath, target)
      this.transcriptPaths.set(sessionId, target)
    }
    const next = await this.store.update(sessionId, {
      cwd,
      model: stored?.model ?? DEFAULT_MODEL_ID,
      effort: stored?.effort ?? null,
      createdAtMs: Date.now(),
      rewindAt: null,
      ...(stored?.contextWindow ? { contextWindow: stored.contextWindow } : {}),
    })
    this.invalidateList()
    const thread = await this.readThread(toThreadId(sessionId), true)
    this.emit('thread/started', { thread: { ...thread, turns: [] } })
    return this.threadConfigResponse(thread, next)
  }

  private async rollbackThread(threadId: string, numTurns: number) {
    const sessionId = toSessionId(threadId)
    if (this.liveTurnFor(sessionId)) throw new Error('Stop the current Claude reply before rolling back.')
    const stored = await this.store.get(sessionId)
    const transcript = await this.readTranscript(sessionId, stored?.cwd ?? '')
    if (!transcript) throw new Error('This Claude chat has no saved messages.')
    const chain = stored?.rewindAt ? truncateChain(transcript.chain, stored.rewindAt) : transcript.chain
    const summary = buildTurnsFromChain(chain, stored?.cwd ?? '')
    const point = rewindPointForRollback(chain, summary.turns, Math.floor(numTurns))
    if (!point) throw new Error('Claude chats keep their first message. Start a new chat to begin again.')
    await this.store.update(sessionId, { rewindAt: point.resumeAt })
    // The next reply must resume from the cut point, not the warm process.
    this.closeRunner(sessionId)
    return { thread: await this.readThread(threadId, true) }
  }

  // ── Goals ──

  private goalPayload(threadId: string, goal: StoredGoal | null | undefined) {
    return goal ? { threadId, ...goal } : null
  }

  private async readGoal(threadId: string) {
    const stored = await this.store.get(toSessionId(threadId))
    return this.goalPayload(threadId, stored?.goal)
  }

  private async setGoal(threadId: string, request: Record<string, unknown>) {
    const sessionId = toSessionId(threadId)
    const stored = await this.store.get(sessionId)
    const now = toSeconds(Date.now())
    const objective = readString(request.objective).trim() || stored?.goal?.objective || ''
    if (!objective) throw new Error('Set a goal before changing its status.')
    const status = typeof request.status === 'string' ? request.status as StoredGoal['status'] : (stored?.goal?.status ?? 'active')
    const goal: StoredGoal = {
      objective,
      status,
      tokenBudget: typeof request.tokenBudget === 'number' ? request.tokenBudget : stored?.goal?.tokenBudget ?? null,
      tokensUsed: stored?.goal?.objective === objective ? stored.goal.tokensUsed : 0,
      timeUsedSeconds: stored?.goal?.objective === objective ? stored.goal.timeUsedSeconds : 0,
      createdAt: stored?.goal?.objective === objective ? stored.goal.createdAt : now,
      updatedAt: now,
    }
    await this.store.update(sessionId, { goal })
    const payload = this.goalPayload(threadId, goal)
    this.emit('thread/goal/updated', { threadId, goal: payload })
    if (goal.status === 'active' && !this.liveTurnFor(sessionId)) {
      void this.continueGoal(threadId, goal).catch((error) => {
        console.warn('[claude-backend] Could not continue the goal:', error instanceof Error ? error.message : error)
      })
    }
    return payload
  }

  private async clearGoal(threadId: string): Promise<boolean> {
    const sessionId = toSessionId(threadId)
    const stored = await this.store.get(sessionId)
    if (!stored?.goal) return false
    await this.store.update(sessionId, { goal: null })
    this.emit('thread/goal/cleared', { threadId })
    return true
  }

  private async continueGoal(threadId: string, goal: StoredGoal): Promise<void> {
    const text = [
      GOAL_CONTINUATION_TAG,
      `Keep working toward this goal: ${goal.objective}`,
      '',
      'Pick up where you left off. When the goal is fully achieved, end your final message with a line that says exactly "GOAL COMPLETE".',
      'If you cannot continue without the user, end with a line "GOAL BLOCKED: <reason>".',
    ].join('\n')
    await this.startTurn({ threadId, input: [{ type: 'text', text }] }, { goalContinuation: true })
  }

  private async recordGoalProgress(turn: LiveTurn, status: string): Promise<void> {
    const stored = await this.store.get(turn.sessionId)
    const goal = stored?.goal
    if (!goal || goal.status !== 'active') return
    const next: StoredGoal = {
      ...goal,
      tokensUsed: goal.tokensUsed + turn.usage.totalTokens,
      timeUsedSeconds: goal.timeUsedSeconds + Math.round((Date.now() - turn.startedAtMs) / 1000),
      updatedAt: toSeconds(Date.now()),
    }
    const blocked = turn.lastAgentText.match(GOAL_BLOCKED_MARKER)
    if (GOAL_COMPLETE_MARKER.test(turn.lastAgentText)) next.status = 'complete'
    else if (blocked) next.status = 'blocked'
    else if (status === 'interrupted') next.status = 'paused'
    else if (status === 'failed') next.status = 'blocked'
    else if (next.tokenBudget && next.tokensUsed >= next.tokenBudget) next.status = 'budgetLimited'
    await this.store.update(turn.sessionId, { goal: next })
    this.emit('thread/goal/updated', { threadId: turn.threadId, goal: this.goalPayload(turn.threadId, next) })
  }

  // ── Turns ──

  private async startTurn(request: Record<string, unknown>, extra: StartTurnExtra = {}): Promise<unknown> {
    return this.accounts.exclusive(() => this.startTurnUnlocked(request, extra))
  }

  private async startTurnUnlocked(request: Record<string, unknown>, extra: StartTurnExtra = {}): Promise<unknown> {
    const threadId = readString(request.threadId)
    const sessionId = toSessionId(threadId)
    const userMessage = await buildUserMessage(request.input, sessionId)
    if (!userMessage) throw new Error('The message is empty.')

    // A reply is running: steer it. Claude reads the message at its next step.
    const running = this.runners.get(sessionId)
    if (running?.activeTurn && !running.closed) {
      if (!running.input.push(userMessage)) throw new Error('The Claude reply just finished. Send the message again.')
      running.pushedCommands.set(readString(userMessage.uuid), userMessage)
      return { turn: { id: running.activeTurn.turnId, items: [], status: 'inProgress', error: null } }
    }

    if (this.login) throw new Error('Finish or cancel the Claude account login before sending a new message.')
    await this.accounts.beforeTurn()

    const existing = await this.store.get(sessionId)
    const requested = await this.executionSettings(
      isClaudeModelId(request.model) ? request.model : existing?.model,
      toEffort(request.effort) ?? existing?.effort,
    )
    const cwd = readString(request.cwd) || existing?.cwd || homedir()
    let runner = this.runners.get(sessionId)
    // Check before saving anything: a refused send must not add another app's
    // session to the chats CodexUI lists as its own.
    await this.refreshClaudeSessionStates()
    const external = await this.externalActivity(sessionId, cwd)
    if ((isClaudeSessionActive(this.claudeSessionStates.get(sessionId)) || external.recent) && !runner) {
      throw new Error('This Claude session is active in another app, such as a terminal or Remote Control. Continue it there, or send again once it is idle.')
    }
    const stored = await this.store.update(sessionId, {
      model: requested.model,
      effort: requested.effort,
      ...(readString(request.cwd) ? { cwd: readString(request.cwd) } : {}),
      ...(existing ? {} : { createdAtMs: Date.now() }),
    })
    const settingsKey = `${stored.model}|${stored.effort ?? ''}|${cwd}`
    // A chat continued elsewhere since this process last ran must reload its history.
    if (runner && (runner.closed || runner.settingsKey !== settingsKey || external.since)) {
      this.closeRunner(sessionId)
      runner = undefined
    }
    if (!runner) runner = await this.createRunner(threadId, sessionId, stored, cwd, settingsKey)

    const turn = this.beginTurn(runner, readString(userMessage.uuid), cwd, userMessage)
    turn.goalContinuation = extra.goalContinuation === true
    turn.limitRecoveryAccountNumbers = [...new Set(extra.limitRecoveryAccountNumbers ?? [])]
    runner.pushedCommands.set(turn.turnId, userMessage)
    if (!runner.input.push(userMessage)) {
      this.finishTurn(runner, 'failed', 'Claude Code closed before the message was sent.')
      throw new Error('Claude Code closed before the message was sent. Send it again.')
    }
    if (stored.rewindAt) await this.store.update(sessionId, { rewindAt: null })
    return { turn: { id: turn.turnId, items: [], status: 'inProgress', error: null } }
  }

  /** Whether another Claude Code process has written this session. */
  private async externalActivity(sessionId: string, cwd: string): Promise<{ since: boolean; recent: boolean }> {
    const path = await this.findTranscriptPath(sessionId, cwd)
    const info = path ? await stat(path).catch(() => null) : null
    if (!info) return { since: false, recent: false }
    const own = this.ownActivityMs.get(sessionId) ?? 0
    const since = info.mtimeMs > own + OWN_WRITE_SLACK_MS
    return { since, recent: since && Date.now() - info.mtimeMs < EXTERNAL_ACTIVITY_MS }
  }

  private async createRunner(
    threadId: string,
    sessionId: string,
    stored: StoredThread,
    cwd: string,
    settingsKey: string,
  ): Promise<SessionRunner> {
    const sdk = await this.sdk()
    // A missing or broken computer-use plugin must not stop the chat itself.
    const computerUse = await loadClaudeComputerUseMcpConfig({
      sessionId,
      turnFile: join(this.cuaTurnDirectory, sessionId),
    }).catch((error: unknown) => {
      console.warn('[claude-backend] Computer use unavailable:', error instanceof Error ? error.message : error)
      return null
    })
    const computerUseMcp = computerUse?.server ?? null
    const computerUseApproval = Boolean(computerUseMcp) && claudeComputerUseNeedsApproval()
    const runtime = await this.readRuntime().catch(() => null)
    const modelInfo = runtime?.models.find((model) => model.value === toModelValue(stored.model))
    const transcriptPath = await this.findTranscriptPath(sessionId, cwd)
    const exists = Boolean(transcriptPath)
    const transcript = exists ? await this.readTranscript(sessionId, cwd) : null
    const history = transcript ? buildTurnsFromChain(transcript.chain, cwd) : null
    const input = createInputStream()
    const runner = {
      sessionId,
      accountNumber: this.accounts.activeAccountNumber(),
      threadId,
      cwd,
      settingsKey,
      input,
      activeTurn: null,
      pushedCommands: new Map(),
      idleTimer: null,
      interruptTimer: null,
      totalUsage: history?.totalUsage ?? emptyUsage(),
      contextWindow: stored.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      backgroundTasks: [],
      closed: false,
      cuaTurnFile: computerUse?.controlsChrome ? join(this.cuaTurnDirectory, sessionId) : null,
    } as unknown as SessionRunner

    const askQuestion: HookCallback = async (hookInput, toolUseId, { signal }) => {
      const record = asRecord(hookInput)
      const toolInput = asRecord(record?.tool_input) ?? {}
      const answers = await this.askUser(runner, toolUseId ?? '', toolInput, signal)
      if (!answers) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'The user did not answer the question.',
          },
        }
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...toolInput, answers },
        },
      }
    }

    const approveComputerUse: HookCallback = async (hookInput, toolUseId, { signal }) => {
      const record = asRecord(hookInput)
      const toolInput = asRecord(record?.tool_input) ?? {}
      const accepted = await this.askComputerUsePermission(
        runner,
        toolUseId ?? '',
        'Allow Claude to control this Mac?',
        'Claude requested a Computer Use action. Review the current task before allowing it.',
        signal,
      )
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: accepted ? 'allow' : 'deny',
          ...(accepted
            ? { updatedInput: toolInput }
            : { permissionDecisionReason: 'Computer Use was not approved.' }),
        },
      }
    }

    const options: Options = {
      ...this.baseOptions(cwd),
      model: toModelValue(stored.model),
      ...(stored.effort ? { effort: stored.effort } : {}),
      ...(exists ? { resume: sessionId } : { sessionId }),
      ...(exists && stored.rewindAt ? { resumeSessionAt: stored.rewindAt } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Chrome goes through computer use when it can, which works on any Claude
      // account. Otherwise use Claude in Chrome, which needs the extension signed
      // into the active account. Only conversational runners get either.
      ...(computerUse?.controlsChrome ? {} : { extraArgs: { chrome: null } }),
      includePartialMessages: true,
      // Stream readable reasoning, as Codex does, where the model supports it.
      ...(modelInfo?.supportsAdaptiveThinking ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
      hooks: {
        PreToolUse: [
          { matcher: 'AskUserQuestion', hooks: [askQuestion] },
          ...(computerUseApproval ? [{ matcher: 'mcp__cua_repl__js', hooks: [approveComputerUse] }] : []),
        ],
      },
      ...(computerUseMcp ? {
        onElicitation: async (request, { signal }) => {
          if (request.serverName !== 'cua_repl' || request.mode === 'url') return { action: 'decline' as const }
          if (!computerUseApproval) return { action: 'accept' as const }
          const accepted = await this.askComputerUsePermission(
            runner,
            '',
            request.title || 'Allow Claude to control this Mac?',
            request.description || request.message || 'Computer Use needs your approval to continue.',
            signal,
          )
          return { action: accepted ? 'accept' as const : 'decline' as const }
        },
      } : {}),
      // Headless Claude Code offers AskUserQuestion only when its host can
      // answer permission prompts. Bypass mode never prompts for other tools,
      // and the hook above answers the question before any prompt would.
      permissionPromptToolName: 'stdio',
    }
    const mcpServers: NonNullable<Options['mcpServers']> = {}
    if (computerUseMcp) mcpServers.cua_repl = computerUseMcp
    if (this.tools.length > 0) {
      mcpServers.codexui = sdk.createSdkMcpServer({
          name: 'codexui',
          version: '1.0.0',
          tools: this.tools.map((hostTool) => sdk.tool(
            hostTool.name,
            hostTool.description,
            hostTool.shape as Parameters<typeof sdk.tool>[2],
            async (args) => {
              try {
                const text = await hostTool.handler(
                  { threadId, turnId: runner.activeTurn?.turnId ?? '', model: stored.model },
                  asRecord(args) ?? {},
                )
                return { content: [{ type: 'text' as const, text: text || 'Done.' }] }
              } catch (error) {
                return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
              }
            },
          )),
        })
    }
    if (Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers
    runner.query = sdk.query({ prompt: input.stream, options })
    this.runners.set(sessionId, runner)
    void this.consumeRunner(runner)
    return runner
  }

  private beginTurn(runner: SessionRunner, turnId: string, cwd: string, userMessage: SDKUserMessage | null): LiveTurn {
    if (runner.cuaTurnFile) void this.recordCuaTurn(runner.cuaTurnFile, turnId)
    if (runner.idleTimer) clearTimeout(runner.idleTimer)
    runner.idleTimer = null
    const turn: LiveTurn = {
      turnId,
      threadId: runner.threadId,
      sessionId: runner.sessionId,
      cwd,
      startedAtMs: Date.now(),
      interrupted: false,
      userMessage,
      tools: new Map(),
      textCounts: new Map(),
      reasoningCounts: new Map(),
      streamItems: new Map(),
      finalCounts: new Map(),
      usageMessageIds: new Set(),
      currentMessageId: '',
      lastAgentText: '',
      lastAgentItemId: '',
      usage: emptyUsage(),
      goalContinuation: false,
      limitRecoveryAccountNumbers: [],
      settled: false,
    }
    runner.activeTurn = turn
    const turnPayload = { id: turnId, items: [], status: 'inProgress', error: null, startedAt: new Date(turn.startedAtMs).toISOString() }
    this.emit('turn/started', { threadId: runner.threadId, turn: turnPayload })
    this.emit('thread/status/changed', { threadId: runner.threadId, status: { type: 'active' } })
    this.invalidateList()
    return turn
  }

  private finishTurn(
    runner: SessionRunner,
    status: 'completed' | 'interrupted' | 'failed',
    errorMessage = '',
    options: { checkAccounts?: boolean } = {},
  ): void {
    const turn = runner.activeTurn
    if (!turn || turn.settled) return
    turn.settled = true
    runner.activeTurn = null
    runner.pushedCommands.delete(turn.turnId)
    if (runner.interruptTimer) clearTimeout(runner.interruptTimer)
    runner.interruptTimer = null
    const completedAtMs = Date.now()
    const durationMs = Math.max(0, completedAtMs - turn.startedAtMs)
    const items = turn.lastAgentText
      ? [{ type: 'agentMessage', id: turn.lastAgentItemId, text: turn.lastAgentText, phase: 'final_answer' }]
      : []
    const threadTitle = this.titleFor(turn.sessionId)
    this.emit('turn/completed', {
      threadId: turn.threadId,
      ...(threadTitle ? { threadTitle } : {}),
      durationMs,
      turn: {
        id: turn.turnId,
        items,
        status,
        error: status === 'failed' ? turnError(errorMessage || 'Claude stopped with an error.') : null,
        startedAt: new Date(turn.startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs,
      },
    })
    this.emit('thread/status/changed', { threadId: turn.threadId, status: { type: 'idle' } })
    this.invalidateList()
    void this.recordGoalProgress(turn, status).catch(() => undefined)
    this.cancelRequests(turn.turnId)
    this.scheduleIdleClose(runner)
    if (options.checkAccounts !== false) void this.accounts.tick()
  }

  private failTurn(runner: SessionRunner, turn: LiveTurn, errorMessage: string): void {
    const hardLimit = isClaudeHardLimitError(errorMessage)
    const exhaustedAccountNumber = hardLimit ? runner.accountNumber ?? this.accounts.activeAccountNumber() : null
    this.finishTurn(runner, 'failed', errorMessage, { checkAccounts: !hardLimit })
    if (hardLimit) {
      // This process cannot continue on the exhausted account. Retire it before
      // recovery so its own background commands cannot keep the global account
      // switch waiting forever. Other Claude runners still retain the busy guard.
      this.closeRunner(runner.sessionId, { expected: runner, immediately: true })
      void this.recoverLimitedTurn(turn, exhaustedAccountNumber)
    }
  }

  private async recoverLimitedTurn(turn: LiveTurn, exhaustedAccountNumber: number | null): Promise<void> {
    const attemptedAccountNumbers = [...new Set([
      ...turn.limitRecoveryAccountNumbers,
      ...(exhaustedAccountNumber === null ? [] : [exhaustedAccountNumber]),
    ])]
    const recovery = await this.accounts.recoverFromLimit(exhaustedAccountNumber, attemptedAccountNumbers)
    if (recovery.kind !== 'ready') return
    try {
      await this.startTurn({
        threadId: turn.threadId,
        input: [{ type: 'text', text: CLAUDE_LIMIT_CONTINUATION }],
      }, { limitRecoveryAccountNumbers: attemptedAccountNumbers })
    } catch (error) {
      console.warn(`[claude-backend] Could not continue rate-limited Claude session ${turn.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async recordCuaTurn(turnFile: string, turnId: string): Promise<void> {
    try {
      await mkdir(dirname(turnFile), { recursive: true, mode: 0o700 })
      await writeFile(turnFile, turnId, { mode: 0o600 })
    } catch (error) {
      console.warn('[claude-backend] Could not record the Chrome turn:', error instanceof Error ? error.message : error)
    }
  }

  /** Closing the process would kill background work, so wait until none is left. */
  private scheduleIdleClose(runner: SessionRunner): void {
    if (runner.closed || runner.activeTurn || runner.idleTimer || runner.backgroundTasks.length > 0) return
    runner.idleTimer = setTimeout(() => this.closeRunner(runner.sessionId, { expected: runner }), RUNNER_IDLE_MS)
    runner.idleTimer.unref?.()
  }

  private setBackgroundTasks(
    runner: SessionRunner,
    tasks: ClaudeBackgroundTask[],
    options: { checkAccounts?: boolean } = {},
  ): void {
    if (runner.backgroundTasks.length === 0 && tasks.length === 0) return
    runner.backgroundTasks = tasks
    this.emit('thread/backgroundTasks/updated', { threadId: runner.threadId, tasks })
    if (tasks.length > 0) {
      if (runner.idleTimer) clearTimeout(runner.idleTimer)
      runner.idleTimer = null
    } else {
      this.scheduleIdleClose(runner)
      if (options.checkAccounts !== false) void this.accounts.tick()
    }
  }

  private async stopBackgroundTask(threadId: string, taskId: string): Promise<Record<string, never>> {
    const runner = this.runners.get(toSessionId(threadId))
    if (!runner || runner.closed || !runner.backgroundTasks.some((task) => task.id === taskId)) {
      throw new Error('This background task has already finished.')
    }
    await runner.query.stopTask(taskId)
    return {}
  }

  private titleFor(sessionId: string): string {
    const known = this.sessionTitles.get(sessionId)
    if (known) return known
    for (const [path, transcript] of this.transcriptCache) {
      if (path.endsWith(`${sessionId}.jsonl`)) return transcript.title || transcript.firstPrompt.slice(0, 80)
    }
    return ''
  }

  private closeRunner(sessionId: string, options: { expected?: SessionRunner; immediately?: boolean } = {}): void {
    const runner = this.runners.get(sessionId)
    if (!runner || (options.expected && runner !== options.expected)) return
    if (runner.idleTimer) clearTimeout(runner.idleTimer)
    runner.idleTimer = null
    runner.closed = true
    this.runners.delete(sessionId)
    if (runner.cuaTurnFile) void rm(runner.cuaTurnFile, { force: true }).catch(() => undefined)
    this.setBackgroundTasks(runner, [], { checkAccounts: false })
    runner.input.release()
    if (runner.activeTurn) {
      runner.activeTurn.interrupted = true
      void runner.query.interrupt().catch(() => undefined)
    }
    // Closing the input normally gives Claude Code time to exit. A hard-limit
    // runner must close now because it cannot consume another command and may
    // still own a background process that would block account recovery.
    const close = (): void => {
      try {
        runner.query.close()
      } catch {
        // already closed
      }
    }
    if (options.immediately) {
      close()
      return
    }
    const timer = setTimeout(close, 10_000)
    timer.unref?.()
  }

  private async consumeRunner(runner: SessionRunner): Promise<void> {
    let failure = ''
    try {
      for await (const message of runner.query) this.handleMessage(runner, message)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      runner.closed = true
      if (this.runners.get(runner.sessionId) === runner) this.runners.delete(runner.sessionId)
      if (runner.cuaTurnFile) void rm(runner.cuaTurnFile, { force: true }).catch(() => undefined)
      if (runner.idleTimer) clearTimeout(runner.idleTimer)
      const turn = runner.activeTurn
      const hardLimitFailure = Boolean(turn && !turn.interrupted && isClaudeHardLimitError(failure))
      this.setBackgroundTasks(runner, [], { checkAccounts: !hardLimitFailure })
      if (turn) {
        if (turn.interrupted) this.finishTurn(runner, 'interrupted')
        else this.failTurn(runner, turn, failure || 'Claude Code stopped unexpectedly.')
      }
      if (failure && !turn?.interrupted) {
        console.warn(`[claude-backend] Claude session ${runner.sessionId} ended: ${failure}`)
      }
    }
  }

  private turnFor(runner: SessionRunner, commandUuid = ''): LiveTurn {
    if (runner.activeTurn) return runner.activeTurn
    // A message queued as the previous reply ended starts its own turn.
    const userMessage = commandUuid ? runner.pushedCommands.get(commandUuid) ?? null : null
    return this.beginTurn(runner, commandUuid || randomUUID(), runner.cwd, userMessage)
  }

  private handleMessage(runner: SessionRunner, message: SDKMessage): void {
    this.ownActivityMs.set(runner.sessionId, Date.now())
    const record = message as unknown as Record<string, unknown>
    if (typeof record.parent_tool_use_id === 'string' && record.parent_tool_use_id) return

    if (record.type === 'command_lifecycle') {
      const commandUuid = readString(record.command_uuid)
      if (record.state === 'started' && !runner.activeTurn && runner.pushedCommands.has(commandUuid)) {
        this.turnFor(runner, commandUuid)
      }
      if (record.state === 'completed') {
        runner.pushedCommands.delete(commandUuid)
        if (!runner.activeTurn) void this.accounts.tick()
      }
      return
    }

    if (message.type === 'rate_limit_event') {
      this.usageCache = null
      return
    }

    if (message.type === 'stream_event') {
      const turn = this.turnFor(runner)
      const event = message.event
      const itemParams = (item: ThreadItem) => ({ threadId: turn.threadId, turnId: turn.turnId, item })
      if (event.type === 'message_start') {
        turn.currentMessageId = event.message.id
        turn.streamItems.clear()
      } else if (event.type === 'content_block_start' && event.content_block.type === 'text') {
        const index = turn.textCounts.get(turn.currentMessageId) ?? 0
        turn.textCounts.set(turn.currentMessageId, index + 1)
        const itemId = textItemId(turn.currentMessageId, index)
        turn.streamItems.set(event.index, { type: 'text', itemId })
        this.emit('item/started', itemParams({ type: 'agentMessage', id: itemId, text: '' }))
      } else if (event.type === 'content_block_start' && (event.content_block.type === 'thinking' || event.content_block.type === 'redacted_thinking')) {
        const index = turn.reasoningCounts.get(turn.currentMessageId) ?? 0
        turn.reasoningCounts.set(turn.currentMessageId, index + 1)
        const itemId = reasoningItemId(turn.currentMessageId, index)
        turn.streamItems.set(event.index, { type: 'thinking', itemId })
        this.emit('item/started', itemParams({ type: 'reasoning', id: itemId, summary: [], content: [] }))
      } else if (event.type === 'content_block_delta') {
        const block = turn.streamItems.get(event.index)
        if (!block) return
        if (event.delta.type === 'text_delta' && block.type === 'text') {
          this.emit('item/agentMessage/delta', { threadId: turn.threadId, turnId: turn.turnId, itemId: block.itemId, delta: event.delta.text })
        } else if (event.delta.type === 'thinking_delta' && block.type === 'thinking') {
          this.emit('item/reasoning/summaryTextDelta', {
            threadId: turn.threadId, turnId: turn.turnId, itemId: block.itemId, delta: event.delta.thinking, summaryIndex: 0,
          })
        }
      }
      return
    }

    if (message.type === 'assistant') {
      const turn = this.turnFor(runner)
      const itemParams = (item: ThreadItem) => ({ threadId: turn.threadId, turnId: turn.turnId, item })
      const messageId = message.message.id
      const usage = readApiUsage(message.message.usage)
      if (usage) this.publishLiveUsage(runner, turn, usage, messageId)
      for (const block of message.message.content) {
        if (block.type === 'text') {
          const itemId = this.claimItemId(turn, messageId, 'text')
          if (!block.text.trim()) continue
          turn.lastAgentText = block.text
          turn.lastAgentItemId = itemId
          this.emit('item/completed', itemParams({ type: 'agentMessage', id: itemId, text: block.text }))
        } else if (block.type === 'thinking') {
          const itemId = this.claimItemId(turn, messageId, 'thinking')
          this.emit('item/completed', itemParams({ type: 'reasoning', id: itemId, summary: block.thinking ? [block.thinking] : [], content: [] }))
        } else if (block.type === 'tool_use') {
          const tool: ClaudeToolUse = { id: block.id, name: block.name, input: asRecord(block.input) ?? {} }
          turn.tools.set(tool.id, tool)
          this.emit('item/started', itemParams(toolUseItem(tool, turn.cwd, null)))
        }
      }
      return
    }

    if (message.type === 'user') {
      const content = message.message.content
      if (!Array.isArray(content)) return
      const turn = runner.activeTurn
      if (!turn) return
      for (const block of content) {
        const result = asRecord(block)
        if (result?.type !== 'tool_result') continue
        const tool = turn.tools.get(readString(result.tool_use_id))
        if (!tool) continue
        const outcome = {
          text: capToolOutput(stringifyToolResult(result.content)),
          isError: result.is_error === true,
          structured: (message as { tool_use_result?: unknown }).tool_use_result,
        }
        this.emit('item/completed', { threadId: turn.threadId, turnId: turn.turnId, item: toolUseItem(tool, turn.cwd, outcome) })
      }
      return
    }

    if (message.type === 'system') {
      if (record.subtype === 'background_tasks_changed') {
        this.setBackgroundTasks(runner, readBackgroundTasks(record.tasks))
        return
      }
      const turn = runner.activeTurn
      if (record.subtype === 'compact_boundary' && turn) {
        const item = { type: 'contextCompaction', id: readString(record.uuid) || randomUUID() }
        this.emit('item/started', { threadId: turn.threadId, turnId: turn.turnId, item })
        this.emit('item/completed', { threadId: turn.threadId, turnId: turn.turnId, item })
      }
      return
    }

    if (message.type === 'result') {
      const turn = runner.activeTurn
      const contextWindow = Object.values(message.modelUsage ?? {})
        .map((usage) => usage.contextWindow)
        .find((value) => typeof value === 'number' && value > 0)
      if (contextWindow && contextWindow !== runner.contextWindow) {
        runner.contextWindow = contextWindow
        void this.store.update(runner.sessionId, { contextWindow })
      }
      if (!turn) return
      if (turn.interrupted) {
        this.finishTurn(runner, 'interrupted')
      } else if (message.subtype === 'success' && !message.is_error) {
        this.finishTurn(runner, 'completed')
      } else {
        const detail = message.subtype === 'success' ? message.result : message.errors.join('\n')
        this.failTurn(runner, turn, detail)
      }
    }
  }

  /**
   * Claude Code emits one final message per content block, in stream order,
   * so the n-th final text block of a message is the n-th streamed one.
   */
  private claimItemId(turn: LiveTurn, messageId: string, type: 'text' | 'thinking'): string {
    const key = `${type}:${messageId}`
    const index = turn.finalCounts.get(key) ?? 0
    turn.finalCounts.set(key, index + 1)
    const streamCounts = type === 'text' ? turn.textCounts : turn.reasoningCounts
    if (index >= (streamCounts.get(messageId) ?? 0)) streamCounts.set(messageId, index + 1)
    return type === 'text' ? textItemId(messageId, index) : reasoningItemId(messageId, index)
  }

  private publishLiveUsage(runner: SessionRunner, turn: LiveTurn, usage: ClaudeTokenUsage, messageId: string): void {
    // Each content block repeats its message's usage; count a message once.
    if (turn.usageMessageIds.has(messageId)) return
    turn.usageMessageIds.add(messageId)
    turn.usage = addUsage(turn.usage, usage)
    runner.totalUsage = addUsage(runner.totalUsage, usage)
    this.emit('thread/tokenUsage/updated', {
      threadId: turn.threadId,
      turnId: turn.turnId,
      tokenUsage: {
        total: toCodexUsage(runner.totalUsage),
        last: toCodexUsage(usage),
        modelContextWindow: runner.contextWindow,
      },
    })
  }

  private async interrupt(threadId: string) {
    const sessionId = toSessionId(threadId)
    const runner = this.runners.get(sessionId)
    const turn = runner?.activeTurn
    if (!runner || !turn) return {}
    turn.interrupted = true
    this.cancelRequests(turn.turnId)
    await runner.query.interrupt().catch(() => undefined)
    // Claude Code normally ends the turn with a result; do not wait forever.
    runner.interruptTimer = setTimeout(() => {
      if (runner.activeTurn === turn) {
        this.finishTurn(runner, 'interrupted')
        this.closeRunner(sessionId, { expected: runner })
      }
    }, INTERRUPT_SETTLE_MS)
    runner.interruptTimer.unref?.()
    return {}
  }

  // ── Questions (AskUserQuestion) ──

  private async askUser(
    runner: SessionRunner,
    toolUseId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, string> | null> {
    const turn = runner.activeTurn
    const rawQuestions = Array.isArray(input.questions) ? input.questions.map(asRecord).filter(Boolean) as Array<Record<string, unknown>> : []
    if (!turn || rawQuestions.length === 0 || signal.aborted) return null
    const questions = rawQuestions.map((question, index) => ({ id: `q${String(index)}`, text: readString(question.question) }))
    const id = ++this.nextRequestId
    const pending: ClaudePendingServerRequest = {
      id,
      method: 'item/tool/requestUserInput',
      receivedAtIso: new Date().toISOString(),
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        itemId: toolUseId,
        questions: rawQuestions.map((question, index) => ({
          id: `q${String(index)}`,
          header: readString(question.header),
          question: readString(question.question),
          isOther: true,
          isSecret: false,
          options: (Array.isArray(question.options) ? question.options : []).map(asRecord).filter(Boolean).map((option) => ({
            label: readString(option?.label),
            description: readString(option?.description),
          })),
        })),
      },
    }
    const answers = await new Promise<Record<string, string> | null>((resolve) => {
      this.questions.set(id, { pending, questions, resolve })
      signal.addEventListener('abort', () => resolve(null), { once: true })
      this.emit('server/request', pending)
    })
    if (this.questions.delete(id)) {
      this.emit('server/request/resolved', {
        id, method: pending.method, threadId: turn.threadId, mode: answers ? 'manual' : 'cancelled', resolvedAtIso: new Date().toISOString(),
      })
    }
    return answers
  }

  private async askComputerUsePermission(
    runner: SessionRunner,
    itemId: string,
    title: string,
    reason: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const turn = runner.activeTurn
    if (!turn || signal.aborted) return false
    if (this.computerUseAllowedThreads.has(turn.threadId)) return true
    const id = ++this.nextRequestId
    const pending: ClaudePendingServerRequest = {
      id,
      method: 'item/permissions/requestApproval',
      receivedAtIso: new Date().toISOString(),
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        itemId,
        title,
        reason,
        permissionKind: 'computerUse',
        availableDecisions: ['accept', 'acceptForSession', 'decline'],
      },
    }
    const accepted = await new Promise<boolean>((resolve) => {
      this.permissions.set(id, { pending, resolve })
      signal.addEventListener('abort', () => resolve(false), { once: true })
      this.emit('server/request', pending)
    })
    if (this.permissions.delete(id)) {
      this.emit('server/request/resolved', {
        id, method: pending.method, threadId: turn.threadId, mode: accepted ? 'manual' : 'cancelled', resolvedAtIso: new Date().toISOString(),
      })
    }
    return accepted
  }

  private cancelRequests(turnId: string): void {
    for (const [id, request] of this.questions) {
      if (asRecord(request.pending.params)?.turnId !== turnId) continue
      request.resolve(null)
      if (this.questions.delete(id)) {
        this.emit('server/request/resolved', {
          id, method: request.pending.method, threadId: readString(asRecord(request.pending.params)?.threadId),
          mode: 'cancelled', resolvedAtIso: new Date().toISOString(),
        })
      }
    }
    for (const [id, request] of this.permissions) {
      if (asRecord(request.pending.params)?.turnId !== turnId) continue
      request.resolve(false)
      if (this.permissions.delete(id)) {
        this.emit('server/request/resolved', {
          id, method: request.pending.method, threadId: readString(asRecord(request.pending.params)?.threadId),
          mode: 'cancelled', resolvedAtIso: new Date().toISOString(),
        })
      }
    }
  }

  /**
   * Chats whose Claude process is doing work a restart would stop: a reply, a
   * queued message, background tasks, or a session Claude Code itself reports as
   * busy. Restart recovery records these at shutdown alongside the turn events.
   */
  activeThreadIds(): string[] {
    return [...this.runners.values()]
      .filter((runner) => !runner.closed && (runnerIsBusy(runner) || isClaudeSessionActive(this.claudeSessionStates.get(runner.sessionId))))
      .map((runner) => runner.threadId)
  }

  listPendingServerRequests(): ClaudePendingServerRequest[] {
    return [...this.questions.values(), ...this.permissions.values()].map((request) => request.pending)
  }

  ownsServerRequest(id: unknown): boolean {
    return typeof id === 'number' && (this.questions.has(id) || this.permissions.has(id))
  }

  async respondToServerRequest(payload: unknown): Promise<void> {
    const body = asRecord(payload)
    const id = body?.id
    const permission = typeof id === 'number' ? this.permissions.get(id) : undefined
    if (permission && typeof id === 'number') {
      const decision = readString(asRecord(body?.result)?.decision)
      const threadId = readString(asRecord(permission.pending.params)?.threadId)
      if (decision === 'acceptForSession' && threadId) this.computerUseAllowedThreads.add(threadId)
      permission.resolve(decision === 'accept' || decision === 'acceptForSession')
      return
    }
    const request = typeof id === 'number' ? this.questions.get(id) : undefined
    if (!request || typeof id !== 'number') throw new Error('This Claude question is no longer waiting for an answer.')
    if (asRecord(body?.error)) {
      request.resolve(null)
      return
    }
    const rawAnswers = asRecord(asRecord(body?.result)?.answers) ?? {}
    const answers: Record<string, string> = {}
    for (const question of request.questions) {
      const values = asRecord(rawAnswers[question.id])?.answers
      const text = Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string').join(', ') : ''
      if (question.text) answers[question.text] = text
    }
    request.resolve(answers)
  }

  dispose(): void {
    this.accounts.dispose()
    if (this.claudeSessionTimer) clearInterval(this.claudeSessionTimer)
    this.claudeSessionTimer = null
    this.cancelLogin()
    for (const sessionId of [...this.runners.keys()]) this.closeRunner(sessionId)
  }
}
