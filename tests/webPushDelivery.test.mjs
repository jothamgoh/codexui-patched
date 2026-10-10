import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const notificationSettingsSource = await readFile(
  new URL('../src/composables/useWebPushNotifications.ts', import.meta.url),
  'utf8',
)
const desktopStateSource = await readFile(
  new URL('../src/composables/useDesktopState.ts', import.meta.url),
  'utf8',
)
const serviceWorkerSource = await readFile(
  new URL('../public/sw.js', import.meta.url),
  'utf8',
)
const indexHtmlSource = await readFile(
  new URL('../index.html', import.meta.url),
  'utf8',
)

test('the PWA manifest includes credentials for authenticated deployments', () => {
  assert.match(
    indexHtmlSource,
    /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/u,
  )
})

test('the test action delegates notification display to server Web Push', () => {
  assert.match(notificationSettingsSource, /await sendWebPushTest\(/u)
  assert.doesNotMatch(notificationSettingsSource, /\.showNotification\(/u)
})

test('subscribed turn completion does not create a duplicate local notification', () => {
  assert.match(desktopStateSource, /if \(isWebPushLocallyEnabled\(\)\) \{/u)
  assert.doesNotMatch(desktopStateSource, /registration\.showNotification\(/u)
})

test('the service worker remains the single Web Push display source', () => {
  const showNotificationCalls = serviceWorkerSource.match(/self\.registration\.showNotification\(/gu) ?? []
  assert.equal(showNotificationCalls.length, 1)
})

async function runServiceWorkerPush(payload, { focused = false, failShow = false } = {}) {
  const listeners = {}
  const receipts = []
  const shown = []
  const self = {
    addEventListener: (type, handler) => { listeners[type] = handler },
    skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => [{ focused }] },
    Notification: { permission: 'granted' },
    location: { origin: 'https://agents.example.test' },
    registration: {
      pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example.test/device' }) },
      showNotification: async (title, options) => {
        if (failShow) throw new Error('blocked')
        shown.push({ title, options })
      },
    },
  }
  const fetch = async (url, options) => { receipts.push({ url, body: JSON.parse(options.body) }); return { ok: true } }
  vm.runInNewContext(serviceWorkerSource, { self, fetch, URL, console })
  let done
  listeners.push({ data: { json: () => payload }, waitUntil: (promise) => { done = promise } })
  await done?.catch(() => {})
  return { receipts, shown }
}

test('the service worker reports each push it receives and whether it showed it', async () => {
  const always = await runServiceWorkerPush({ title: 'Done', tag: 'turn-1', mode: 'always' })
  assert.equal(always.shown.length, 1)
  assert.deepEqual(always.receipts, [{ url: '/codex-api/push/receipt', body: { endpoint: 'https://push.example.test/device', tag: 'turn-1', shown: true, permission: 'granted', error: '' } }])

  const focused = await runServiceWorkerPush({ title: 'Done', tag: 'turn-2', mode: 'unfocused' }, { focused: true })
  assert.equal(focused.shown.length, 0)
  assert.equal(focused.receipts[0].body.shown, false, 'a push skipped because the app is focused is still reported')

  const failed = await runServiceWorkerPush({ title: 'Done', tag: 'turn-3', mode: 'always' }, { failShow: true })
  assert.equal(failed.receipts[0].body.shown, false)
  assert.match(failed.receipts[0].body.error, /blocked/u)
})
