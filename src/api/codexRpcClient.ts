import type { RpcEnvelope, RpcMethodCatalog } from '../types/codex'
import { CodexApiError, extractErrorMessage } from './codexErrors'

type RpcRequestBody = {
  method: string
  params?: unknown
}

export type RpcNotification = {
  method: string
  params: unknown
  atIso: string
}

type ServerRequestReplyBody = {
  id: number
  result?: unknown
  error?: {
    code?: number
    message: string
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  const body: RpcRequestBody = { method, params: params ?? null }

  let response: Response
  try {
    response = await fetch('/codex-api/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new CodexApiError(
      error instanceof Error ? error.message : `RPC ${method} failed before request was sent`,
      { code: 'network_error', method },
    )
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `RPC ${method} failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method,
        status: response.status,
      },
    )
  }

  const envelope = payload as RpcEnvelope<T> | null
  if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) {
    throw new CodexApiError(`RPC ${method} returned malformed envelope`, {
      code: 'invalid_response',
      method,
      status: response.status,
    })
  }
  return envelope.result
}

export async function fetchRpcMethodCatalog(): Promise<string[]> {
  const response = await fetch('/codex-api/meta/methods')

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Method catalog failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'meta/methods',
        status: response.status,
      },
    )
  }

  const catalog = payload as RpcMethodCatalog
  return Array.isArray(catalog.data) ? catalog.data : []
}

export async function fetchRpcNotificationCatalog(): Promise<string[]> {
  const response = await fetch('/codex-api/meta/notifications')

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Notification catalog failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'meta/notifications',
        status: response.status,
      },
    )
  }

  const catalog = payload as RpcMethodCatalog
  return Array.isArray(catalog.data) ? catalog.data : []
}

function toNotification(value: unknown): RpcNotification | null {
  const record = asRecord(value)
  if (!record) return null
  if (typeof record.method !== 'string' || record.method.length === 0) return null

  const atIso = typeof record.atIso === 'string' && record.atIso.length > 0
    ? record.atIso
    : new Date().toISOString()

  return {
    method: record.method,
    params: record.params ?? null,
    atIso,
  }
}

export type SubscribeOptions = {
  onNotification: (value: RpcNotification) => void
  onReconnect?: () => void
}

const MAX_RECONNECT_DELAY = 30000
const INITIAL_RECONNECT_DELAY = 1000
const inPageNotificationListeners = new Set<(value: RpcNotification) => void>()

export function subscribeInPageRpcNotifications(
  listener: (value: RpcNotification) => void,
): () => void {
  inPageNotificationListeners.add(listener)
  return () => {
    inPageNotificationListeners.delete(listener)
  }
}

export function subscribeRpcNotifications(
  onNotificationOrOpts: ((value: RpcNotification) => void) | SubscribeOptions,
): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const opts: SubscribeOptions =
    typeof onNotificationOrOpts === 'function'
      ? { onNotification: onNotificationOrOpts }
      : onNotificationOrOpts

  let closed = false
  let source: EventSource | null = null
  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let reconnectDelay = INITIAL_RECONNECT_DELAY
  let hasConnectedOnce = false

  const scheduleReconnect = () => {
    if (closed) return
    if (reconnectTimer !== null) return

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      if (closed) return
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
      connectTransport()
    }, reconnectDelay)
  }

  const handleParsedNotification = (parsed: unknown) => {
    const notification = toNotification(parsed)
    if (!notification || notification.method === 'ready') {
      return
    }
    opts.onNotification(notification)
    for (const listener of inPageNotificationListeners) {
      listener(notification)
    }
  }

  const clearTransport = () => {
    if (source) {
      source.close()
      source = null
    }
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
      socket = null
    }
  }

  const handleConnected = () => {
    reconnectDelay = INITIAL_RECONNECT_DELAY
    if (hasConnectedOnce) {
      opts.onReconnect?.()
    }
    hasConnectedOnce = true
  }

  const connectSSE = () => {
    if (typeof EventSource === 'undefined') return
    if (closed) return

    clearTransport()

    source = new EventSource('/codex-api/events')

    source.onopen = () => {
      handleConnected()
    }

    source.onmessage = (event) => {
      try {
        handleParsedNotification(JSON.parse(event.data) as unknown)
      } catch {
        // Ignore malformed event payloads and keep stream alive.
      }
    }

    source.onerror = () => {
      if (closed) return
      if (source) {
        source.close()
        source = null
      }
      scheduleReconnect()
    }
  }

  const connectWebSocket = () => {
    if (typeof WebSocket === 'undefined') {
      connectSSE()
      return
    }
    if (closed) return

    clearTransport()

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/codex-api/ws`)
    socket = ws

    ws.onopen = () => {
      if (socket !== ws) return
      handleConnected()
    }

    ws.onmessage = (event) => {
      if (socket !== ws) return
      if (typeof event.data !== 'string') return
      try {
        handleParsedNotification(JSON.parse(event.data) as unknown)
      } catch {
        // Ignore malformed event payloads and keep stream alive.
      }
    }

    ws.onerror = () => {
      if (socket !== ws) return
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }

    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      if (closed) return
      scheduleReconnect()
    }
  }

  const connectTransport = () => {
    if (typeof WebSocket !== 'undefined') {
      connectWebSocket()
      return
    }
    connectSSE()
  }

  const handleReconnect = () => {
    if (closed) return
    const isSocketClosed = !socket || socket.readyState === WebSocket.CLOSED
    const isSourceClosed = typeof EventSource !== 'undefined' && (!source || source.readyState === EventSource.CLOSED)
    if (isSocketClosed && isSourceClosed) {
      reconnectDelay = INITIAL_RECONNECT_DELAY
      connectTransport()
    }
  }

  connectTransport()

  window.addEventListener('focus', handleReconnect)
  window.addEventListener('online', handleReconnect)

  return () => {
    closed = true
    window.removeEventListener('focus', handleReconnect)
    window.removeEventListener('online', handleReconnect)
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    clearTransport()
  }
}

export async function respondServerRequest(body: ServerRequestReplyBody): Promise<void> {
  let response: Response
  try {
    response = await fetch('/codex-api/server-requests/respond', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new CodexApiError(
      error instanceof Error ? error.message : 'Failed to reply to server request',
      { code: 'network_error', method: 'server-requests/respond' },
    )
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Server request reply failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'server-requests/respond',
        status: response.status,
      },
    )
  }
}

export async function fetchPendingServerRequests(): Promise<unknown[]> {
  const response = await fetch('/codex-api/server-requests/pending')

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Pending server requests failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'server-requests/pending',
        status: response.status,
      },
    )
  }

  const record = asRecord(payload)
  const data = record?.data
  return Array.isArray(data) ? data : []
}
