import type { ProjectBoardNotification } from '../utils/projectBoardNotifications'

export type WebPushMode = 'unfocused' | 'always'

export type WebPushConfig = {
  supported: boolean
  publicKey: string
}

export type WebPushHistoryItem = {
  id: string
  threadId: string
  turnId: string
  status: string
  title: string
  body: string
  completedAt: string
  readAt: string | null
  projectBoard?: ProjectBoardNotification
}

export type WebPushHistory = {
  items: WebPushHistoryItem[]
  unreadCount: number
  dismissals: WebPushHistoryDismissal[]
}

export type WebPushHistoryDismissal = {
  threadId: string
  activityAt: string
  dismissedAt: string
}

type PushApiResponse<T> = {
  data?: T
  error?: string
}

async function callPushApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/codex-api/push/${path}`, init)
  let payload: PushApiResponse<T> | null = null
  try {
    payload = await response.json() as PushApiResponse<T>
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Notification request failed with HTTP ${response.status.toString()}`)
  }
  if (!payload?.data) {
    throw new Error('Notification server returned an invalid response')
  }
  return payload.data
}

export async function getWebPushConfig(): Promise<WebPushConfig> {
  return callPushApi<WebPushConfig>('config')
}

export async function getWebPushHistory(): Promise<WebPushHistory> {
  return callPushApi<WebPushHistory>('history')
}

export async function markWebPushHistoryRead(options: {
  ids?: string[]
  threadId?: string
  all?: boolean
}): Promise<WebPushHistory> {
  return callPushApi<WebPushHistory>('history/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })
}

export async function markWebPushHistoryUnread(
  threadId: string,
  activityAt: string,
): Promise<WebPushHistory> {
  return callPushApi<WebPushHistory>('history/unread', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, activityAt }),
  })
}

export async function dismissWebPushHistoryActivity(
  threadId: string,
  activityAt: string,
): Promise<WebPushHistory> {
  return callPushApi<WebPushHistory>('history/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, activityAt }),
  })
}

export async function saveWebPushSubscription(
  subscription: PushSubscriptionJSON,
  mode: WebPushMode,
  deviceName: string,
): Promise<void> {
  await callPushApi('subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, mode, deviceName }),
  })
}

export async function removeWebPushSubscription(subscription: PushSubscriptionJSON): Promise<void> {
  await callPushApi('unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription }),
  })
}

export async function sendWebPushTest(
  subscription: PushSubscriptionJSON,
  url: string,
): Promise<void> {
  await callPushApi('test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, url }),
  })
}
