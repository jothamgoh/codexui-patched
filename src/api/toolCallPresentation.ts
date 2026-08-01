import type { McpAppResultData, ToolCallData } from '../types/codex'

type ToolCallStatus = ToolCallData['status']

export type McpToolCallPresentation = Pick<
  ToolCallData,
  'label' | 'detail' | 'description' | 'statusLabel' | 'tone'
>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function humanizeActionName(value: string): string {
  const normalized = value
    .split('.')
    .at(-1)
    ?.replace(/_v\d+$/iu, '')
    .replace(/[_-]+/gu, ' ')
    .trim() ?? ''
  if (!normalized) return 'Tool'

  const words = normalized.split(/\s+/u)
  const trailingVerb = words.at(-1)?.toLocaleLowerCase()
  if (
    words.length > 1
    && (trailingVerb === 'search' || trailingVerb === 'list' || trailingVerb === 'read')
  ) {
    words.unshift(words.pop() ?? '')
  }

  const phrase = words.join(' ').toLocaleLowerCase()
  return `${phrase.charAt(0).toLocaleUpperCase()}${phrase.slice(1)}`
}

function readResultMessage(
  item: Record<string, unknown>,
): { message: string; type: string; subjects: string[] } {
  const result = asRecord(item.result)
  const content = Array.isArray(result?.content) ? result.content : []

  for (const entry of content) {
    const block = asRecord(entry)
    const text = readString(block?.text)
    if (!text) continue
    try {
      const parsed = asRecord(JSON.parse(text))
      const message = readString(parsed?.message)
      if (message) {
        return {
          message,
          type: readString(parsed?.type),
          subjects: Array.isArray(parsed?.details)
            ? parsed.details.map(readString).filter(Boolean)
            : [],
        }
      }
    } catch {
      return { message: text, type: '', subjects: [] }
    }
  }

  const structured = asRecord(result?.structuredContent)
  const structuredMessage = readString(structured?.error_message)
    || readString(structured?.errorMessage)
    || readString(structured?.message)
  if (structuredMessage) {
    return {
      message: structuredMessage,
      type: readString(structured?.error_code)
        || readString(structured?.errorCode)
        || readString(structured?.type),
      subjects: [],
    }
  }

  const error = asRecord(item.error)
  return {
    message: readString(item.error) || readString(error?.message),
    type: readString(error?.type) || readString(error?.code),
    subjects: [],
  }
}

function classifyFailure(
  failure: { message: string; type: string },
): Pick<McpToolCallPresentation, 'statusLabel' | 'tone'> {
  const type = failure.type.toLocaleLowerCase()
  const message = failure.message.toLocaleLowerCase()

  if (type.includes('no_availability') || message.includes('no availability')) {
    return { statusLabel: 'Unavailable', tone: 'warning' }
  }
  if (message.includes('pre-sale period') || message.includes('not yet available for sale')) {
    return { statusLabel: 'Not available yet', tone: 'warning' }
  }
  if (
    type.includes('timeout')
    || type.includes('network')
    || type.includes('connection')
    || message.includes('fetch failed')
    || message.includes('failed to fetch')
    || message.includes('network error')
    || message.includes('network request failed')
    || message.includes('connection reset')
    || message.includes('connection refused')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('temporarily unavailable')
    || /\b(?:502|503|504)\b/u.test(message)
  ) {
    return { statusLabel: 'Connection issue', tone: 'warning' }
  }
  if (
    type.includes('not_found')
    || type.includes('not_resolved')
    || type.includes('no_results')
    || type.includes('no_match')
    || message.includes('could not find')
    || message.includes('no results')
    || message.includes('no flights found')
    || message.includes('no trains found')
  ) {
    return { statusLabel: 'No results', tone: 'warning' }
  }
  return { statusLabel: 'Failed', tone: 'error' }
}

export function formatMcpToolCallPresentation(
  item: Record<string, unknown>,
  status: ToolCallStatus,
): McpToolCallPresentation {
  const appContext = asRecord(item.appContext)
  const appName = readString(appContext?.appName)
  const server = readString(item.server) || 'MCP'
  const tool = readString(item.tool) || 'tool'
  const actionName = readString(appContext?.actionName) || tool
  const failure = status === 'failed'
    ? readResultMessage(item)
    : { message: '', type: '', subjects: [] }
  const failurePresentation = status === 'failed'
    ? classifyFailure(failure)
    : { statusLabel: '', tone: 'neutral' as const }
  const subjectSuffix = failure.subjects.length > 0
    ? ` (${failure.subjects.join(', ')})`
    : ''

  return {
    label: appName || humanizeActionName(tool),
    detail: appName ? humanizeActionName(actionName) : server,
    description: failure.message ? `${failure.message}${subjectSuffix}` : '',
    statusLabel: failurePresentation.statusLabel,
    tone: failurePresentation.tone,
  }
}

export function readMcpAppResult(
  item: Record<string, unknown>,
  status: ToolCallStatus,
): McpAppResultData | undefined {
  if (status !== 'completed') return undefined

  const appContext = asRecord(item.appContext)
  const result = asRecord(item.result)
  const resultMeta = asRecord(result?._meta)
  const resourceUri = readString(appContext?.resourceUri)
    || readString(item.mcpAppResourceUri)
    || readString(resultMeta?.['openai/outputTemplate'])
    || readString(resultMeta?.['ui/resourceUri'])
  if (!resourceUri || !result || result.structuredContent == null) return undefined

  return {
    server: readString(item.server) || 'MCP',
    tool: readString(item.tool) || 'tool',
    appName: readString(appContext?.appName) || humanizeActionName(readString(item.tool)),
    resourceUri,
    toolInput: item.arguments ?? {},
    structuredContent: result.structuredContent,
    resultMeta: resultMeta ?? {},
  }
}
