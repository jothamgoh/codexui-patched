const NOTIFICATION_ICON = '/icons/codexui-192.png'
const NOTIFICATION_BADGE = '/icons/codexui-192.png'

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
      title: 'CodexUI',
      body: event.data?.text() || 'Codex finished responding',
    }
  }

  if (payload.mode === 'unfocused') {
    const openClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })
    if (openClients.some((client) => client.focused === true)) {
      return
    }
  }

  await self.registration.showNotification(payload.title || 'CodexUI', {
    body: payload.body || 'Codex finished responding',
    tag: payload.tag || undefined,
    icon: payload.icon || NOTIFICATION_ICON,
    badge: payload.badge || NOTIFICATION_BADGE,
    data: {
      url: normalizeDestination(payload.url),
    },
  })
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
