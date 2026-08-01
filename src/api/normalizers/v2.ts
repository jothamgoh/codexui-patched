import type {
  Thread,
  ThreadItem,
  ThreadReadResponse,
  ThreadListResponse,
  UserInput,
} from '../appServerDtos'
import type {
  CommandExecutionData,
  McpAppResultData,
  ResponseTextAnnotation,
  ToolCallData,
  UiFileAttachment,
  UiMessage,
  UiProjectGroup,
  UiThread,
} from '../../types/codex'
import { formatMcpToolCallPresentation, readMcpAppResult } from '../toolCallPresentation'

function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function toProjectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.at(-1) || cwd || 'unknown-project'
}

function toRawPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function normalizeThreadItemType(type: string): string {
  const normalized = type.trim()
  if (!normalized) return normalized

  switch (normalized) {
    case 'user_message': return 'userMessage'
    case 'agent_message': return 'agentMessage'
    case 'command_execution': return 'commandExecution'
    case 'file_change': return 'fileChange'
    case 'mcp_tool_call': return 'mcpToolCall'
    case 'dynamic_tool_call': return 'dynamicToolCall'
    case 'collab_agent_tool_call': return 'collabAgentToolCall'
    case 'web_search': return 'webSearch'
    case 'image_view': return 'imageView'
    case 'entered_review_mode': return 'enteredReviewMode'
    case 'exited_review_mode': return 'exitedReviewMode'
    case 'context_compaction': return 'contextCompaction'
    default:
      return normalized
  }
}

function normalizeToolCallStatus(value: unknown): 'inProgress' | 'completed' | 'failed' {
  if (value === 'inProgress' || value === 'in_progress' || value === 'pending') return 'inProgress'
  if (value === 'failed') return 'failed'
  return 'completed'
}

function readWebSearchQuery(item: Record<string, unknown>): string {
  const directQuery = typeof item.query === 'string' ? item.query.trim() : ''
  if (directQuery.length > 0) return directQuery

  const action =
    item.action !== null && typeof item.action === 'object' && !Array.isArray(item.action)
      ? (item.action as Record<string, unknown>)
      : null
  if (!action) return ''

  const actionType = typeof action.type === 'string' ? action.type : ''
  if (actionType === 'search') {
    const query = typeof action.query === 'string' ? action.query.trim() : ''
    if (query.length > 0) return query
    const queries = Array.isArray(action.queries)
      ? action.queries
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : []
    return queries.join(', ')
  }

  if (actionType === 'openPage') {
    const url = typeof action.url === 'string' ? action.url.trim() : ''
    if (url.length > 0) return url
  }

  if (actionType === 'findInPage') {
    const pattern = typeof action.pattern === 'string' ? action.pattern.trim() : ''
    if (pattern.length > 0) return pattern
  }

  return ''
}

function toMessageOrderKey(turnIndex: number, itemIndex: number, messageIndex: number): string {
  return [
    String(turnIndex).padStart(6, '0'),
    String(itemIndex).padStart(6, '0'),
    String(messageIndex).padStart(6, '0'),
  ].join(':')
}

const FILE_ATTACHMENT_LINE = /^##\s+(.+?):\s+(.+?)\s*$/
const FILES_MENTIONED_MARKER = /^#\s*files mentioned by the user\s*:?\s*$/i

function extractFileAttachments(value: string): UiFileAttachment[] {
  const markerIdx = value.split('\n').findIndex((line) => FILES_MENTIONED_MARKER.test(line.trim()))
  if (markerIdx < 0) return []
  const lines = value.split('\n').slice(markerIdx + 1)
  const attachments: UiFileAttachment[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(FILE_ATTACHMENT_LINE)
    if (!m) break
    const label = m[1]?.trim()
    const path = m[2]?.trim().replace(/\s+\((?:lines?\s+\d+(?:-\d+)?)\)\s*$/, '')
    if (label && path) attachments.push({ label, path })
  }
  return attachments
}

function summarizeFallbackItem(
  itemType: string,
  item: ThreadItem,
): {
  role: UiMessage['role']
  text: string
  isUnhandled: boolean
  toolCall?: ToolCallData
  mcpApp?: McpAppResultData
} {
  const raw = item as Record<string, unknown>

  switch (itemType) {
    case 'plan':
      {
        const text = typeof raw.text === 'string' ? raw.text.trim() : ''
        return {
          role: 'assistant',
          text: text || 'Plan updated',
          isUnhandled: false,
        }
      }
    case 'fileChange':
      {
        const changes = Array.isArray(raw.changes) ? raw.changes : []
        const status = typeof raw.status === 'string' ? raw.status : 'unknown'
        return {
          role: 'system',
          text: `File change${changes.length === 1 ? '' : 's'}: ${String(changes.length)} (${status})`,
          isUnhandled: true,
        }
      }
    case 'mcpToolCall':
      {
        const status = normalizeToolCallStatus(raw.status)
        const verb = status === 'inProgress' ? 'Calling' : status === 'failed' ? 'Failed' : 'Called'
        const presentation = formatMcpToolCallPresentation(raw, status)
        const mcpApp = readMcpAppResult(raw, status)
        const toolCall: ToolCallData = {
          kind: 'mcp',
          ...presentation,
          status,
          progress: '',
        }
        return {
          role: 'system',
          text: `${verb} ${presentation.label}`,
          isUnhandled: true,
          toolCall,
          mcpApp,
        }
      }
    case 'collabAgentToolCall':
      {
        const status = normalizeToolCallStatus(raw.status)
        const verb = status === 'inProgress' ? 'Running' : status === 'failed' ? 'Failed' : 'Ran'
        const tool = typeof raw.tool === 'string' ? raw.tool : 'tool'
        const toolCall: ToolCallData = {
          kind: 'collab',
          label: tool,
          detail: 'Collaboration',
          status,
          progress: '',
        }
        return {
          role: 'system',
          text: `${verb} collaboration tool: ${tool}`,
          isUnhandled: true,
          toolCall,
        }
      }
    case 'webSearch':
      {
        const query = readWebSearchQuery(raw)
        const toolCall: ToolCallData = {
          kind: 'web',
          label: 'Web search',
          detail: query,
          status: 'completed',
          progress: '',
        }
        return {
          role: 'system',
          text: query ? `Searched web for ${query}` : 'Searched web',
          isUnhandled: true,
          toolCall,
        }
      }
    case 'imageView':
      {
        const path = typeof raw.path === 'string' ? raw.path : ''
        return {
          role: 'system',
          text: path ? `Viewed image: ${path}` : 'Viewed image',
          isUnhandled: true,
        }
      }
    case 'enteredReviewMode':
      {
        const review = typeof raw.review === 'string' ? raw.review : ''
        return {
          role: 'system',
          text: review ? `Entered review mode: ${review}` : 'Entered review mode',
          isUnhandled: true,
        }
      }
    case 'exitedReviewMode':
      {
        const review = typeof raw.review === 'string' ? raw.review : ''
        return {
          role: 'system',
          text: review ? `Exited review mode: ${review}` : 'Exited review mode',
          isUnhandled: true,
        }
      }
    case 'contextCompaction':
      return {
        role: 'system',
        text: 'Context compacted',
        isUnhandled: true,
      }
    default:
      return {
        role: 'system',
        text: `Unsupported item: ${itemType || item.type}`,
        isUnhandled: true,
      }
  }
}

function extractCodexUserRequestText(value: string): string {
  const markerRegex = /(?:^|\n)\s{0,3}#{0,6}\s*my request for codex\s*:?\s*/giu
  const matches = Array.from(value.matchAll(markerRegex))
  if (matches.length === 0) {
    return value.trim()
  }

  const lastMatch = matches.at(-1)
  if (!lastMatch || typeof lastMatch.index !== 'number') {
    return value.trim()
  }

  const markerOffset = lastMatch.index + lastMatch[0].length
  return value.slice(markerOffset).trim()
}

function extractResponseAnnotations(itemId: string, value: string): ResponseTextAnnotation[] {
  const match = value.match(/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/iu)
  if (!match?.[1]) return []

  try {
    const parsed = JSON.parse(match[1]) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed.flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const record = entry as Record<string, unknown>
      const text = typeof record.text === 'string' ? record.text.trim() : ''
      if (!text) return []
      const annotation = typeof record.annotation === 'string' ? record.annotation.trim() : ''
      return [{
        id: `${itemId}:response-annotation:${index}`,
        text,
        ...(annotation ? { annotation } : {}),
      }]
    })
  } catch {
    return []
  }
}

function parseUserMessageContent(
  itemId: string,
  content: UserInput[] | undefined,
): {
  text: string
  images: string[]
  fileAttachments: UiFileAttachment[]
  responseAnnotations: ResponseTextAnnotation[]
  rawBlocks: UiMessage[]
} {
  if (!Array.isArray(content)) {
    return { text: '', images: [], fileAttachments: [], responseAnnotations: [], rawBlocks: [] }
  }

  const textChunks: string[] = []
  const images: string[] = []
  const rawBlocks: UiMessage[] = []

  for (const [index, block] of content.entries()) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      textChunks.push(block.text)
    }
    if (block.type === 'image' && typeof block.url === 'string' && block.url.trim().length > 0) {
      images.push(block.url.trim())
    }

    if (block.type !== 'text' && block.type !== 'image' && block.type !== 'mention') {
      rawBlocks.push({
        id: `${itemId}:user-content:${index}`,
        role: 'user',
        text: `Unsupported user content: ${block.type}`,
        messageType: `userContent.${block.type}`,
        rawPayload: toRawPayload(block),
        isUnhandled: true,
      })
    }
  }

  const fullText = textChunks.join('\n')
  const fileAttachments = extractFileAttachments(fullText)
  const responseAnnotations = extractResponseAnnotations(itemId, fullText)

  return {
    text: extractCodexUserRequestText(fullText),
    images,
    fileAttachments,
    responseAnnotations,
    rawBlocks,
  }
}

function toUiMessages(item: ThreadItem): UiMessage[] {
  const itemType = normalizeThreadItemType(item.type)
  const rawItem = item as Record<string, unknown>

  if (itemType === 'agentMessage') {
    const text = typeof rawItem.text === 'string' ? rawItem.text : ''
    return [
      {
        id: item.id,
        role: 'assistant',
        text,
        messageType: itemType,
      },
    ]
  }

  if (itemType === 'userMessage') {
    const parsed = parseUserMessageContent(item.id, rawItem.content as UserInput[] | undefined)
    const messages: UiMessage[] = []
    const hasRenderableUserContent = parsed.text.length > 0
      || parsed.images.length > 0
      || parsed.fileAttachments.length > 0
      || parsed.responseAnnotations.length > 0

    if (hasRenderableUserContent) {
      messages.push({
        id: item.id,
        role: 'user',
        text: parsed.text,
        images: parsed.images,
        fileAttachments: parsed.fileAttachments.length > 0 ? parsed.fileAttachments : undefined,
        responseAnnotations: parsed.responseAnnotations.length > 0 ? parsed.responseAnnotations : undefined,
        messageType: itemType,
      })
    }

    messages.push(...parsed.rawBlocks)
    if (messages.length === 0) {
      return []
    }

    return messages
  }

  if (itemType === 'reasoning') {
    return []
  }

  if (
    itemType === 'dynamicToolCall'
    && typeof rawItem.tool === 'string'
    && rawItem.tool === 'automation_update'
  ) {
    return []
  }

  if (itemType === 'commandExecution') {
    const raw = item as Record<string, unknown>
    const status = normalizeCommandStatus(raw.status)
    const cmd = typeof raw.command === 'string' ? raw.command : ''
    const cwd = typeof raw.cwd === 'string' ? raw.cwd : null
    const aggregatedOutput = typeof raw.aggregatedOutput === 'string' ? raw.aggregatedOutput : ''
    const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : null
    return [
      {
        id: item.id,
        role: 'system' as const,
        text: cmd,
        messageType: itemType,
        commandExecution: { command: cmd, cwd, status, aggregatedOutput, exitCode },
      },
    ]
  }

  const summary = summarizeFallbackItem(itemType, item)
  return [
    {
      id: item.id,
      role: summary.role,
      text: summary.text,
      messageType: itemType || item.type,
      rawPayload: summary.isUnhandled ? toRawPayload(item) : undefined,
      isUnhandled: summary.isUnhandled,
      toolCall: summary.toolCall,
      mcpApp: summary.mcpApp,
    },
  ]
}

function normalizeCommandStatus(value: unknown): CommandExecutionData['status'] {
  if (value === 'completed' || value === 'failed' || value === 'declined' || value === 'interrupted') return value
  if (value === 'inProgress' || value === 'in_progress') return 'inProgress'
  return 'completed'
}

function pickThreadName(summary: Thread): string {
  const raw = summary as Record<string, unknown>
  const direct = [
    raw.name,
    raw.title,
    raw.threadName,
    raw.thread_name,
    summary.preview,
  ]
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return ''
}

function toThreadTitle(summary: Thread): string {
  const named = pickThreadName(summary)
  return named.length > 0 ? named : 'Untitled thread'
}

function normalizeThreadRuntimeStatus(value: unknown): UiThread['runtimeStatus'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const type = (value as Record<string, unknown>).type
  if (type === 'active' || type === 'idle' || type === 'notLoaded' || type === 'systemError') {
    return type
  }
  return undefined
}

export function normalizeThreadV2(summary: Thread): UiThread {
  const rawSummary = summary as Record<string, unknown>
  const cwd = typeof rawSummary.cwd === 'string' ? rawSummary.cwd : summary.cwd
  const runtimeStatus = normalizeThreadRuntimeStatus(rawSummary.status)
  const hasWorktree =
    rawSummary.isWorktree === true ||
    rawSummary.worktree === true ||
    rawSummary.worktreeId !== undefined ||
    rawSummary.worktreePath !== undefined ||
    cwd.includes('/.codex/worktrees/') ||
    cwd.includes('/.git/worktrees/')

  return {
    id: summary.id,
    title: toThreadTitle(summary),
    projectName: toProjectName(summary.cwd),
    cwd: summary.cwd,
    hasWorktree,
    createdAtIso: toIso(summary.createdAt),
    updatedAtIso: toIso(summary.updatedAt),
    preview: summary.preview,
    runtimeStatus,
    unread: false,
    inProgress: runtimeStatus === 'active',
  }
}

function groupThreadsByProject(threads: UiThread[]): UiProjectGroup[] {
  const grouped = new Map<string, UiThread[]>()
  for (const thread of threads) {
    const rows = grouped.get(thread.projectName)
    if (rows) rows.push(thread)
    else grouped.set(thread.projectName, [thread])
  }

  return Array.from(grouped.entries())
    .map(([projectName, projectThreads]) => ({
      projectName,
      threads: projectThreads.sort(
        (a, b) => new Date(b.updatedAtIso).getTime() - new Date(a.updatedAtIso).getTime(),
      ),
    }))
    .sort((a, b) => {
      const aLast = new Date(a.threads[0]?.updatedAtIso ?? 0).getTime()
      const bLast = new Date(b.threads[0]?.updatedAtIso ?? 0).getTime()
      return bLast - aLast
    })
}

export function normalizeThreadGroupsV2(payload: ThreadListResponse): UiProjectGroup[] {
  const uiThreads = payload.data.map(normalizeThreadV2)
  return groupThreadsByProject(uiThreads)
}

export function normalizeThreadMessagesV2(payload: ThreadReadResponse, turnIndexOffset = 0): UiMessage[] {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  const messages: UiMessage[] = []
  for (let pageTurnIndex = 0; pageTurnIndex < turns.length; pageTurnIndex++) {
    const turn = turns[pageTurnIndex]
    const turnIndex = turnIndexOffset + pageTurnIndex
    const items = Array.isArray(turn.items) ? turn.items : []
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex]
      const itemMessages = toUiMessages(item)
      for (let messageIndex = 0; messageIndex < itemMessages.length; messageIndex += 1) {
        const msg = itemMessages[messageIndex]
        messages.push({
          ...msg,
          turnId: turn.id,
          turnIndex,
          orderKey: toMessageOrderKey(turnIndex, itemIndex, messageIndex),
        })
      }
    }
  }
  return messages
}

export function getInProgressTurnStateV2(payload: ThreadReadResponse): { isInProgress: boolean; activeTurnId: string } {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  const latestTurn = turns.at(-1)
  if (latestTurn?.status === 'inProgress') {
    return {
      isInProgress: true,
      activeTurnId: typeof latestTurn.id === 'string' ? latestTurn.id : '',
    }
  }
  return {
    isInProgress: false,
    activeTurnId: '',
  }
}

export function hasInProgressTurnV2(payload: ThreadReadResponse): boolean {
  return getInProgressTurnStateV2(payload).isInProgress
}
