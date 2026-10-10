const NOTIFICATION_ICON = '/icons/agents-192.png'
const NOTIFICATION_BADGE = '/icons/agents-192.png'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  event.waitUntil(showPushNotification(event))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(openNotificationDestination(event.notification.data?.url))
})

async function showPushNotification(event) {
  let payload = {}
  try {
    payload = event.data?.json() ?? {}
  } catch {
    payload = {
      title: 'Agents',
      body: event.data?.text() || 'Codex finished responding',
    }
  }

  if (payload.mode === 'unfocused') {
    const openClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })
    if (openClients.some((client) => client.focused === true)) {
      await reportReceipt(payload.tag, false, '')
      return
    }
  }

  try {
    await self.registration.showNotification(payload.title || 'Agents', {
      body: payload.body || 'Codex finished responding',
      tag: payload.tag || undefined,
      icon: payload.icon || NOTIFICATION_ICON,
      badge: payload.badge || NOTIFICATION_BADGE,
      data: {
        url: normalizeDestination(payload.url),
      },
    })
  } catch (error) {
    await reportReceipt(payload.tag, false, String(error))
    throw error
  }
  await reportReceipt(payload.tag, true, '')
}

// Tell the server this device got the push and whether it showed it. A lost
// alert is then either undelivered (no receipt) or hidden by the OS (shown).
async function reportReceipt(tag, shown, error) {
  try {
    const subscription = await self.registration.pushManager.getSubscription()
    if (!subscription) return
    await fetch('/codex-api/push/receipt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        tag: tag || '',
        shown,
        permission: self.Notification?.permission || '',
        error,
      }),
    })
  } catch {
    // A receipt is diagnostic only; never let it block the notification.
  }
}

async function openNotificationDestination(rawDestination) {
  const destination = normalizeDestination(rawDestination)
  const destinationUrl = new URL(destination, self.location.origin)
  const openClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })

  const matchingClient = openClients.find((client) => {
    try {
      return new URL(client.url).origin === destinationUrl.origin
    } catch {
      return false
    }
  })

  if (matchingClient) {
    await matchingClient.focus()
    if ('navigate' in matchingClient) {
      await matchingClient.navigate(destinationUrl.href)
    }
    return
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(destinationUrl.href)
  }
}

function normalizeDestination(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return '/#/'
  }

  try {
    const destination = new URL(value, self.location.origin)
    if (destination.origin !== self.location.origin) {
      return '/#/'
    }
    return `${destination.pathname}${destination.search}${destination.hash}`
  } catch {
    return '/#/'
  }
}
