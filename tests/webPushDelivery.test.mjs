import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

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
  const pageMessages = []
  const shown = []
  const self = {
    addEventListener: (type, handler) => { listeners[type] = handler },
    skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => [{ focused, postMessage: (message) => pageMessages.push(message) }] },
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
  return { receipts, pageMessages, shown }
}

test('the service worker reports each push it receives and whether it showed it', async () => {
  const always = await runServiceWorkerPush({ title: 'Done', tag: 'turn-1', mode: 'always' })
  assert.equal(always.shown.length, 1)
  const receipt = { endpoint: 'https://push.example.test/device', tag: 'turn-1', shown: true, permission: 'granted', error: '' }
  assert.deepEqual(always.receipts, [{ url: '/codex-api/push/receipt', body: { ...receipt, via: 'worker' } }])
  assert.deepEqual(JSON.parse(JSON.stringify(always.pageMessages)), [{ type: 'codexui-push-receipt', receipt }], 'open pages can forward it when a gateway blocks the worker')

  const focused = await runServiceWorkerPush({ title: 'Done', tag: 'turn-2', mode: 'unfocused' }, { focused: true })
  assert.equal(focused.shown.length, 0)
  assert.equal(focused.receipts[0].body.shown, false, 'a push skipped because the app is focused is still reported')

  const failed = await runServiceWorkerPush({ title: 'Done', tag: 'turn-3', mode: 'always' }, { failShow: true })
  assert.equal(failed.receipts[0].body.shown, false)
  assert.match(failed.receipts[0].body.error, /blocked/u)
})

async function initializeWithPermission(permission) {
  const subscribes = []
  const storage = new Map()
  const subscription = { endpoint: 'https://push.example.test/stale', toJSON: () => ({ endpoint: 'https://push.example.test/stale', keys: { p256dh: 'k', auth: 'a' } }) }
  const registration = { pushManager: { getSubscription: async () => subscription } }
  Object.assign(globalThis, {
    window: globalThis,
    isSecureContext: true,
    PushManager: function PushManager() {},
    Notification: { permission },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    matchMedia: () => ({ matches: false }),
    fetch: async (url, options = {}) => {
      if (String(url).includes('/push/subscribe')) subscribes.push(JSON.parse(options.body))
      return { ok: true, json: async () => ({ data: { supported: true, publicKey: 'BPub' } }) }
    },
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/151.0.0.0', platform: 'MacIntel', maxTouchPoints: 0, serviceWorker: { getRegistration: async () => registration, register: async () => registration } } })
  const { outputFiles } = await build({ entryPoints: [new URL('../src/composables/useWebPushNotifications.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent', plugins: [{ name: 'vue-external', setup(b) { b.onResolve({ filter: /^vue$/ }, () => ({ path: import.meta.resolve('vue'), external: true })) } }] })
  const { useWebPushNotifications } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
  const push = useWebPushNotifications()
  await push.initializeWebPushNotifications(true)
  return { status: push.status.value, subscribes }
}

test('a device whose notification permission went back to "ask" is not treated as subscribed', async () => {
  const reset = await initializeWithPermission('default')
  assert.equal(reset.status, 'ready', 'the panel offers Enable again')
  assert.deepEqual(reset.subscribes, [], 'the stale subscription is not refreshed as if alerts worked')

  const granted = await initializeWithPermission('granted')
  assert.equal(granted.status, 'enabled')
  assert.equal(granted.subscribes[0].permission, 'granted', 'the server learns the real permission')
})
