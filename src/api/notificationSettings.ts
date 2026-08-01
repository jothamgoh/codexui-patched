export type TelegramNotificationConfig = {
  available: boolean
  enabled: boolean
}

type NotificationApiResponse<T> = {
  data?: T
  error?: string
}

async function callTelegramApi<T>(init?: RequestInit): Promise<T> {
  const response = await fetch('/codex-api/telegram/config', init)
  let payload: NotificationApiResponse<T> | null = null
  try {
    payload = await response.json() as NotificationApiResponse<T>
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Telegram request failed with HTTP ${response.status.toString()}`)
  }
  if (!payload?.data) {
    throw new Error('Notification server returned an invalid response')
  }
  return payload.data
}

export async function getTelegramNotificationConfig(): Promise<TelegramNotificationConfig> {
  return callTelegramApi<TelegramNotificationConfig>()
}

export async function setTelegramNotificationsEnabled(
  enabled: boolean,
): Promise<TelegramNotificationConfig> {
  return callTelegramApi<TelegramNotificationConfig>({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}
