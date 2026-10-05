import { homedir } from 'node:os'

/**
 * Maps Claude Code transcripts and stream messages onto the Codex thread-item
 * shapes the CodexUI frontend renders. Pure functions shared by live replies
 * and history reads, so both produce the same item ids and shapes.
 */

export type ThreadItem = Record<string, unknown>

export type ClaudeToolUse = { id: string; name: string; input: Record<string, unknown> }

export type ClaudeToolOutcome = {
  text: string
  isError: boolean
  /** The tool's structured output (`toolUseResult` in transcripts, `tool_use_result` in streams). */
  structured: unknown
}

export type ClaudeTurn = {
  id: string
  items: ThreadItem[]
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  error: { message: string; codexErrorInfo: null; additionalDetails: null } | null
  startedAtMs: number | null
  completedAtMs: number | null
  durationMs?: number
}

export type ClaudeTokenUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type ClaudeTranscriptSummary = {
  turns: ClaudeTurn[]
  lastUsage: ClaudeTokenUsage | null
  totalUsage: ClaudeTokenUsage
  model: string
  cwd: string
}

const INTERRUPT_MARKERS = [
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]

/** Marks the prompt CodexUI sends to keep a Claude chat working on its goal. */
export const GOAL_CONTINUATION_TAG = '<codexui-goal-continuation>'

export const MY_REQUEST_MARKER = /(#{1,6}\s*my request for (?:codex|claude)\s*:?\s*)/iu

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function textItemId(messageId: string, index: number): string {
  return `${messageId}:text:${String(index)}`
}

export function reasoningItemId(messageId: string, index: number): string {
  return `${messageId}:reasoning:${String(index)}`
}

export function emptyUsage(): ClaudeTokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }
}

/** Token counts for one Anthropic API usage object, as Codex token-usage fields. */
export function readApiUsage(value: unknown): ClaudeTokenUsage | null {
  const usage = asRecord(value)
  if (!usage) return null
  const input = readNumber(usage.input_tokens)
  const cacheRead = readNumber(usage.cache_read_input_tokens)
  const cacheCreation = readNumber(usage.cache_creation_input_tokens)
  const output = readNumber(usage.output_tokens)
  const thinking = readNumber(asRecord(usage.output_tokens_details)?.thinking_tokens)
  const inputTokens = input + cacheRead + cacheCreation
  if (inputTokens === 0 && output === 0) return null
  return {
    inputTokens,
    cachedInputTokens: cacheRead,
    outputTokens: output,
    reasoningOutputTokens: thinking,
    totalTokens: inputTokens + output,
  }
}

export function addUsage(total: ClaudeTokenUsage, next: ClaudeTokenUsage): ClaudeTokenUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + next.reasoningOutputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
  }
}

// ── Tool calls ───────────────────────────────────────────────────────────

export function stringifyToolResult(content: unknown): string {
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

function displayPath(value: unknown, cwd: string): string {
  const path = readString(value).trim()
  if (!path) return ''
  if (cwd && (path === cwd || path.startsWith(`${cwd.replace(/\/+$/u, '')}/`))) {
    return path.slice(cwd.replace(/\/+$/u, '').length + 1) || path
  }
  const home = homedir()
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

function firstLine(value: unknown, limit = 200): string {
  const text = readString(value).trim().split('\n')[0] ?? ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Unified-diff hunks for a Claude `structuredPatch`. */
export function structuredPatchToDiff(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const hunks: string[] = []
  for (const raw of value) {
    const hunk = asRecord(raw)
    if (!hunk || !Array.isArray(hunk.lines)) continue
    const lines = hunk.lines.filter((line): line is string => typeof line === 'string')
    hunks.push([
      `@@ -${String(readNumber(hunk.oldStart))},${String(readNumber(hunk.oldLines))} +${String(readNumber(hunk.newStart))},${String(readNumber(hunk.newLines))} @@`,
      ...lines,
    ].join('\n'))
  }
  return hunks.length > 0 ? `${hunks.join('\n')}\n` : ''
}

function fileChanges(tool: ClaudeToolUse, outcome: ClaudeToolOutcome): Array<Record<string, unknown>> {
  const result = asRecord(outcome.structured)
  if (!result || result.staged === true) return []
  const path = readString(result.filePath) || readString(tool.input.file_path)
  if (!path) return []
  if (tool.name === 'Write' && result.type === 'create') {
    return [{ path, kind: { type: 'add' }, diff: readString(result.content) }]
  }
  const diff = structuredPatchToDiff(result.structuredPatch)
  return diff ? [{ path, kind: { type: 'update', move_path: null }, diff }] : []
}

function exitCodeFrom(text: string): number | null {
  const match = text.match(/^(?:Error: )?Exit code (\d+)/mu)
  return match ? Number.parseInt(match[1] ?? '1', 10) : null
}

function commandItem(tool: ClaudeToolUse, cwd: string, outcome: ClaudeToolOutcome | null, interrupted: boolean): ThreadItem {
  const structured = asRecord(outcome?.structured)
  let status = outcome ? (outcome.isError ? 'failed' : 'completed') : (interrupted ? 'interrupted' : 'inProgress')
  let aggregatedOutput = ''
  let exitCode: number | null = null
  if (outcome && structured && !outcome.isError) {
    aggregatedOutput = [readString(structured.stdout), readString(structured.stderr)].filter((part) => part.length > 0).join('\n')
    if (!aggregatedOutput && outcome.text) aggregatedOutput = outcome.text
    exitCode = 0
    if (structured.interrupted === true) status = 'interrupted'
  } else if (outcome) {
    aggregatedOutput = outcome.text
    exitCode = outcome.isError ? exitCodeFrom(outcome.text) ?? 1 : 0
    if (outcome.isError && /interrupted by user/iu.test(outcome.text)) status = 'interrupted'
  }
  return {
    type: 'commandExecution',
    id: tool.id,
    command: readString(tool.input.command),
    cwd,
    status,
    aggregatedOutput,
    exitCode,
  }
}

const TOOL_LABELS: Record<string, string> = {
  Read: 'Read file',
  NotebookRead: 'Read notebook',
  Glob: 'Find files',
  Grep: 'Search files',
  LS: 'List files',
  TodoWrite: 'Update plan',
  TaskCreate: 'Update plan',
  TaskUpdate: 'Update plan',
  TaskList: 'Check plan',
  TaskGet: 'Check plan',
  AskUserQuestion: 'Ask question',
  Skill: 'Use skill',
  SlashCommand: 'Run command',
  EnterPlanMode: 'Plan',
  BashOutput: 'Read command output',
  TaskOutput: 'Read task output',
  KillShell: 'Stop command',
  KillBash: 'Stop command',
  TaskStop: 'Stop task',
  ToolSearch: 'Load tools',
  ListMcpResourcesTool: 'List MCP resources',
  ReadMcpResourceTool: 'Read MCP resource',
  Monitor: 'Watch',
  ScheduleWakeup: 'Schedule wakeup',
  EnterWorktree: 'Enter worktree',
  ExitWorktree: 'Exit worktree',
}

function toolDetail(tool: ClaudeToolUse, cwd: string): string {
  const input = tool.input
  switch (tool.name) {
    case 'Read':
    case 'NotebookRead':
    case 'LS':
      return displayPath(input.file_path ?? input.notebook_path ?? input.path, cwd)
    case 'Glob':
    case 'Grep': {
      const pattern = firstLine(input.pattern)
      const where = displayPath(input.path, cwd)
      return where ? `${pattern} in ${where}` : pattern
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos.map(asRecord) : []
      const done = todos.filter((todo) => todo?.status === 'completed').length
      return todos.length > 0 ? `${String(done)} of ${String(todos.length)} done` : ''
    }
    case 'AskUserQuestion': {
      const questions = Array.isArray(input.questions) ? input.questions.map(asRecord) : []
      return firstLine(questions[0]?.question)
    }
    case 'Skill':
      return firstLine(input.skill ?? input.command ?? input.name)
    default: {
      for (const key of ['file_path', 'path', 'url', 'query', 'pattern', 'description', 'command', 'prompt', 'skill']) {
        const value = input[key]
        if (typeof value === 'string' && value.trim()) {
          return key.endsWith('path') ? displayPath(value, cwd) : firstLine(value)
        }
      }
      return ''
    }
  }
}

function mcpResult(outcome: ClaudeToolOutcome | null): { result: unknown; error: unknown } {
  if (!outcome) return { result: null, error: null }
  if (outcome.isError) return { result: null, error: { message: outcome.text || 'The tool call failed.' } }
  return { result: { content: [{ type: 'text', text: outcome.text }] }, error: null }
}

/** Codex thread item for one Claude tool call. */
export function toolUseItem(
  tool: ClaudeToolUse,
  cwd: string,
  outcome: ClaudeToolOutcome | null,
  options: { interrupted?: boolean } = {},
): ThreadItem {
  const interrupted = options.interrupted === true
  const status = outcome ? (outcome.isError ? 'failed' : 'completed') : (interrupted ? 'failed' : 'inProgress')

  if (tool.name === 'Bash' || tool.name === 'PowerShell') return commandItem(tool, cwd, outcome, interrupted)

  if (tool.name === 'Edit' || tool.name === 'MultiEdit' || tool.name === 'Write' || tool.name === 'NotebookEdit') {
    return {
      type: 'fileChange',
      id: tool.id,
      status: outcome ? (outcome.isError ? 'failed' : 'completed') : (interrupted ? 'declined' : 'inProgress'),
      changes: outcome && !outcome.isError ? fileChanges(tool, outcome) : [],
    }
  }

  if (tool.name === 'WebSearch') {
    const query = firstLine(tool.input.query, 300)
    return { type: 'webSearch', id: tool.id, query, action: { type: 'search', query }, status }
  }
  if (tool.name === 'WebFetch') {
    const url = readString(tool.input.url)
    return { type: 'webSearch', id: tool.id, query: url, action: { type: 'openPage', url }, status }
  }

  if (tool.name === 'Task' || tool.name === 'Agent') {
    const kind = outcome ? (outcome.isError ? 'interrupted' : 'completed') : (interrupted ? 'interrupted' : 'started')
    const name = readString(tool.input.subagent_type) || 'Agent'
    const task = readString(tool.input.description) || firstLine(tool.input.prompt, 600)
    return { type: 'subAgentActivity', id: tool.id, kind, name, prompt: task, agentThreadId: null }
  }

  if (tool.name === 'ExitPlanMode') {
    const plan = readString(tool.input.plan)
    if (plan.trim()) return { type: 'plan', id: tool.id, text: plan }
  }

  const mcp = tool.name.match(/^mcp__(.+?)__(.+)$/u)
  if (mcp) {
    return {
      type: 'mcpToolCall',
      id: tool.id,
      server: (mcp[1] ?? '').replace(/_/gu, ' '),
      tool: mcp[2] ?? tool.name,
      arguments: tool.input,
      status,
      ...mcpResult(outcome),
    }
  }

  return {
    type: 'mcpToolCall',
    id: tool.id,
    server: toolDetail(tool, cwd),
    tool: TOOL_LABELS[tool.name] ?? tool.name,
    arguments: tool.input,
    status,
    ...mcpResult(outcome),
  }
}

// ── User content ─────────────────────────────────────────────────────────

type UserContent = { text: string; images: string[] }

function readImageBlock(block: Record<string, unknown>): string {
  const source = asRecord(block.source)
  if (source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
    return `data:${source.media_type};base64,${source.data}`
  }
  if (source?.type === 'url' && typeof source.url === 'string') return source.url
  return ''
}

/** Text and images a person sent, as opposed to tool results filed as user turns. */
export function readUserContent(content: unknown): UserContent | null {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return null
  const texts: string[] = []
  const images: string[] = []
  let hasToolResult = false
  for (const raw of content) {
    const block = asRecord(raw)
    if (block?.type === 'text') texts.push(readString(block.text))
    else if (block?.type === 'image') {
      const url = readImageBlock(block)
      if (url) images.push(url)
    } else if (block?.type === 'tool_result') hasToolResult = true
  }
  if (hasToolResult && texts.length === 0 && images.length === 0) return null
  if (texts.length === 0 && images.length === 0) return null
  return { text: texts.join('\n'), images }
}

export function isInterruptMarker(text: string): boolean {
  const trimmed = text.trim()
  return INTERRUPT_MARKERS.some((marker) => trimmed.startsWith(marker))
}

function readTag(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u'))
  return match ? (match[1] ?? '') : null
}

/**
 * The text a person typed for a slash-command entry, or null when the entry
 * is a command's local output, which the CLI files as a user message.
 */
export function normalizeCommandText(text: string): string | null {
  if (text.includes('<local-command-stdout>') || text.includes('<local-command-stderr>')
    || text.includes('<local-command-caveat>')) return null
  const name = readTag(text, 'command-name')
  if (name === null) return text
  const args = (readTag(text, 'command-args') ?? '').trim()
  const command = name.trim().startsWith('/') ? name.trim() : `/${name.trim()}`
  if (!args) return command
  // Keep the composer's request marker first so the frontend still finds it.
  const marker = args.match(MY_REQUEST_MARKER)
  if (marker?.index !== undefined) {
    const end = marker.index + marker[0].length
    return `${args.slice(0, end)}${command} ${args.slice(end).trimStart()}`
  }
  return `${command} ${args}`
}

function userMessageItem(id: string, content: UserContent): ThreadItem {
  return {
    type: 'userMessage',
    id,
    content: [
      ...(content.text ? [{ type: 'text', text: content.text }] : []),
      ...content.images.map((url) => ({ type: 'image', url })),
    ],
  }
}

// ── Transcripts ──────────────────────────────────────────────────────────

export type TranscriptEntry = Record<string, unknown>

const MAX_TOOL_OUTPUT_CHARS = 64 * 1024

/** Command output and tool errors the conversation shows, bounded like Codex's. */
export function capToolOutput(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (output truncated)`
    : text
}

/**
 * Drop what the conversation never renders: whole original files kept for
 * Claude's own undo, file contents returned by Read, and system-prompt
 * snapshots. Large chats otherwise hold hundreds of megabytes in memory.
 */
function pruneEntry(entry: TranscriptEntry): TranscriptEntry {
  const result = asRecord(entry.toolUseResult)
  if (result) {
    const kept: Record<string, unknown> = {}
    for (const key of ['type', 'filePath', 'structuredPatch', 'stdout', 'stderr', 'interrupted', 'staged']) {
      if (key in result) kept[key] = result[key]
    }
    if (result.type === 'create' && typeof result.content === 'string') kept.content = result.content
    if (typeof kept.stdout === 'string') kept.stdout = capToolOutput(kept.stdout)
    if (typeof kept.stderr === 'string') kept.stderr = capToolOutput(kept.stderr)
    entry.toolUseResult = kept
  }
  const attachment = asRecord(entry.attachment)
  if (attachment && attachment.type !== 'queued_command') entry.attachment = { type: attachment.type }
  const message = asRecord(entry.message)
  if (message && Array.isArray(message.content)) {
    message.content = message.content.map((raw) => {
      const block = asRecord(raw)
      if (block?.type === 'tool_result') {
        return { ...block, content: capToolOutput(stringifyToolResult(block.content)) }
      }
      if (block?.type === 'tool_use' && EDIT_TOOLS.has(readString(block.name))) {
        // Edits render from their recorded patch; the request bodies are not shown.
        const input = asRecord(block.input) ?? {}
        return { ...block, input: { file_path: input.file_path, notebook_path: input.notebook_path } }
      }
      return raw
    })
  }
  return entry
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export function parseTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = asRecord(JSON.parse(line))
      if (entry) entries.push(pruneEntry(entry))
    } catch {
      // A partially written last line is normal while Claude is replying.
    }
  }
  return entries
}

const CHAIN_TYPES = new Set(['user', 'assistant', 'attachment', 'system'])

/**
 * The active conversation: walk back from the newest entry through parent
 * links. Rewound branches drop out naturally; compaction boundaries continue
 * through their logical parent so earlier history stays visible.
 */
export function resolveMainChain(entries: TranscriptEntry[]): TranscriptEntry[] {
  const byUuid = new Map<string, TranscriptEntry>()
  let leaf: TranscriptEntry | null = null
  for (const entry of entries) {
    if (typeof entry.uuid !== 'string' || entry.isSidechain === true) continue
    if (!CHAIN_TYPES.has(readString(entry.type))) continue
    byUuid.set(entry.uuid, entry)
    leaf = entry
  }
  const chain: TranscriptEntry[] = []
  const seen = new Set<string>()
  let current: TranscriptEntry | undefined = leaf ?? undefined
  while (current && !seen.has(readString(current.uuid))) {
    seen.add(readString(current.uuid))
    chain.push(current)
    const parent = readString(current.parentUuid) || readString(current.logicalParentUuid)
    current = parent ? byUuid.get(parent) : undefined
  }
  return chain.reverse()
}

/** Cut a chain after `entryUuid` (inclusive), for a rewound conversation. */
export function truncateChain(chain: TranscriptEntry[], entryUuid: string): TranscriptEntry[] {
  const index = chain.findIndex((entry) => entry.uuid === entryUuid)
  return index >= 0 ? chain.slice(0, index + 1) : chain
}

function timestampMs(entry: TranscriptEntry): number | null {
  const value = Date.parse(readString(entry.timestamp))
  return Number.isFinite(value) ? value : null
}

function readQueuedPrompt(attachment: Record<string, unknown>): UserContent | null {
  const mode = readString(attachment.commandMode)
  if (mode && mode !== 'prompt') return null
  return readUserContent(attachment.prompt)
}

export function buildTurnsFromChain(
  chain: TranscriptEntry[],
  fallbackCwd: string,
  options: { liveTurnId?: string | null } = {},
): ClaudeTranscriptSummary {
  const outcomes = new Map<string, ClaudeToolOutcome>()
  for (const entry of chain) {
    if (entry.type !== 'user') continue
    const content = asRecord(entry.message)?.content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      const block = asRecord(raw)
      if (block?.type !== 'tool_result') continue
      outcomes.set(readString(block.tool_use_id), {
        text: capToolOutput(stringifyToolResult(block.content)),
        isError: block.is_error === true,
        structured: entry.toolUseResult,
      })
    }
  }

  const turns: ClaudeTurn[] = []
  const textCounts = new Map<string, number>()
  const reasoningCounts = new Map<string, number>()
  let current = null as ClaudeTurn | null
  let cwd = fallbackCwd
  let model = ''
  let lastUsage: ClaudeTokenUsage | null = null
  let totalUsage = emptyUsage()
  const countedMessages = new Set<string>()
  const toolTurns = new Map<string, { turn: ClaudeTurn; tool: ClaudeToolUse; index: number }>()

  const startTurn = (id: string, at: number | null): ClaudeTurn => {
    const turn: ClaudeTurn = { id, items: [], status: 'completed', error: null, startedAtMs: at, completedAtMs: at }
    turns.push(turn)
    current = turn
    return turn
  }
  const ensureTurn = (entry: TranscriptEntry, at: number | null): ClaudeTurn =>
    current ?? startTurn(`${readString(entry.uuid)}:turn`, at)

  for (const entry of chain) {
    const at = timestampMs(entry)
    if (typeof entry.cwd === 'string' && entry.cwd) cwd = entry.cwd
    const type = readString(entry.type)

    if (type === 'user') {
      if (entry.isMeta === true) {
        if (current && at !== null) current.completedAtMs = at
        continue
      }
      if (entry.isCompactSummary === true) {
        ensureTurn(entry, at).items.push({ type: 'contextCompaction', id: readString(entry.uuid) })
        continue
      }
      const content = readUserContent(asRecord(entry.message)?.content)
      if (!content) {
        if (current && at !== null) current.completedAtMs = at
        continue
      }
      if (isInterruptMarker(content.text)) {
        if (current) {
          current.status = 'interrupted'
          if (at !== null) current.completedAtMs = at
        }
        continue
      }
      const text = content.text.trimStart().startsWith(GOAL_CONTINUATION_TAG)
        ? 'Continue working toward the goal'
        : normalizeCommandText(content.text)
      if (text === null) continue
      const turn = startTurn(readString(entry.uuid), at)
      turn.items.push(userMessageItem(readString(entry.uuid), { text, images: content.images }))
      continue
    }

    if (type === 'attachment') {
      const attachment = asRecord(entry.attachment)
      if (attachment?.type !== 'queued_command') continue
      const content = readQueuedPrompt(attachment)
      if (!content) continue
      const turn = ensureTurn(entry, at)
      turn.items.push(userMessageItem(readString(entry.uuid), content))
      if (at !== null) turn.completedAtMs = at
      continue
    }

    if (type === 'system') {
      // Hooks such as Stop run after the last message and still belong to the turn.
      if (current && at !== null) current.completedAtMs = at
      if (entry.subtype === 'compact_boundary') {
        ensureTurn(entry, at).items.push({ type: 'contextCompaction', id: readString(entry.uuid) })
      }
      continue
    }

    if (type !== 'assistant') continue
    const message = asRecord(entry.message)
    if (!message || !Array.isArray(message.content)) continue
    const turn = ensureTurn(entry, at)
    if (at !== null) turn.completedAtMs = at
    const messageId = readString(message.id) || readString(entry.uuid)
    if (typeof message.model === 'string' && message.model && message.model !== '<synthetic>') model = message.model
    const usage = readApiUsage(message.usage)
    if (usage && !countedMessages.has(messageId)) {
      countedMessages.add(messageId)
      lastUsage = usage
      totalUsage = addUsage(totalUsage, usage)
    }
    const isApiError = entry.isApiErrorMessage === true

    for (const raw of message.content) {
      const block = asRecord(raw)
      if (!block) continue
      if (block.type === 'text') {
        const index = textCounts.get(messageId) ?? 0
        textCounts.set(messageId, index + 1)
        const text = readString(block.text)
        if (!text.trim()) continue
        turn.items.push({ type: 'agentMessage', id: textItemId(messageId, index), text })
        if (isApiError) {
          turn.status = 'failed'
          turn.error = { message: text, codexErrorInfo: null, additionalDetails: null }
        }
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const index = reasoningCounts.get(messageId) ?? 0
        reasoningCounts.set(messageId, index + 1)
        const thinking = readString(block.thinking)
        turn.items.push({ type: 'reasoning', id: reasoningItemId(messageId, index), summary: thinking ? [thinking] : [], content: [] })
      } else if (block.type === 'tool_use') {
        const tool: ClaudeToolUse = {
          id: readString(block.id),
          name: readString(block.name),
          input: asRecord(block.input) ?? {},
        }
        const index = turn.items.length
        turn.items.push(toolUseItem(tool, cwd, outcomes.get(tool.id) ?? null))
        toolTurns.set(tool.id, { turn, tool, index })
      }
    }
  }

  // Tool calls that never returned ended with their turn: an interrupt, a
  // crash, or a reply still running (left in progress for the live turn).
  for (const { turn, tool, index } of toolTurns.values()) {
    if (outcomes.has(tool.id) || turn.id === options.liveTurnId) continue
    turn.items[index] = toolUseItem(tool, cwd, null, { interrupted: true })
  }

  for (const turn of turns) {
    if (turn.id === options.liveTurnId) {
      turn.status = 'inProgress'
      continue
    }
    if (turn.startedAtMs !== null && turn.completedAtMs !== null && turn.items.length > 1) {
      turn.durationMs = Math.max(0, turn.completedAtMs - turn.startedAtMs)
    }
    const answers = turn.items.filter((item) => item.type === 'agentMessage')
    answers.forEach((item, index) => {
      item.phase = index === answers.length - 1 && turn.status === 'completed' ? 'final_answer' : 'commentary'
    })
  }

  return { turns, lastUsage, totalUsage, model, cwd }
}

/** The kept turn's last chain entry, for rolling back `dropTurns` turns. */
export function rewindPointForRollback(chain: TranscriptEntry[], turns: ClaudeTurn[], dropTurns: number): {
  resumeAt: string
} | null {
  if (dropTurns < 1 || dropTurns >= turns.length) return null
  const firstDropped = turns[turns.length - dropTurns]
  if (!firstDropped) return null
  const dropIndex = chain.findIndex((entry) => entry.uuid === firstDropped.id)
  if (dropIndex <= 0) return null
  const resumeAt = readString(chain[dropIndex - 1]?.uuid)
  return resumeAt ? { resumeAt } : null
}
