import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import ts from 'typescript'

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

test('the page never shows alerts through the service worker registration', () => {
  assert.doesNotMatch(desktopStateSource, /registration\.showNotification\(/u)
})

// Bundles a composable with every module matching `stubbed` replaced by functions
// that call globalThis.__pageApi; a name it lacks resolves to null.
async function importWithStubbedApi(entry, stubbed) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    plugins: [{ name: 'stubbed-api', setup(b) {
      b.onResolve({ filter: /^vue$/ }, () => ({ path: import.meta.resolve('vue'), external: true }))
      b.onResolve({ filter: stubbed }, ({ path, importer }) => ({ path: `${importer}?${path}`, namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, async ({ path }) => {
        const [importer, specifier] = path.split('?')
        const ast = ts.createSourceFile(importer, await readFile(importer, 'utf8'), ts.ScriptTarget.Latest, true)
        const names = ast.statements
          .filter((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === specifier && node.importClause && !node.importClause.isTypeOnly)
          .flatMap((node) => node.importClause.namedBindings?.elements ?? [])
          .filter((element) => !element.isTypeOnly)
          .map((element) => (element.propertyName ?? element.name).text)
        return { contents: names.map((name) => `export const ${name} = (...args) => (globalThis.__pageApi.${name} ?? (async () => null))(...args)`).join('\n') }
      })
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

// A background CodexUI tab with notification permission granted. It records each
// banner the page creates itself, which bypasses Web Push and the device setting.
function openBackgroundPage(t, settings) {
  const banners = []
  class FakeNotification {
    static permission = 'granted'
    constructor(title, options) { banners.push({ title, tag: options.tag }) }
    close() {}
  }
  const storage = new Map(Object.entries(settings))
  const names = ['window', 'document', 'Notification', '__pageApi']
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  const value = {
    window: {
      Notification: FakeNotification,
      localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, item) => storage.set(key, String(item)), removeItem: (key) => storage.delete(key) },
      matchMedia: () => ({ matches: false }),
      setTimeout: () => 0,
      clearTimeout() {},
      focus() {},
      location: { hash: '' },
    },
    document: { visibilityState: 'hidden', hasFocus: () => false },
    Notification: FakeNotification,
    __pageApi: {},
  }
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: value[name] })
  t.after(() => names.forEach((name, index) => previous[index]
    ? Object.defineProperty(globalThis, name, previous[index])
    : delete globalThis[name]))
  return banners
}

const deviceCases = [
  ['subscribed to Web Push', { 'codex-web-local.turn-notification-mode.v1': 'unfocused', 'codex-web-local.web-push-enabled.v1': 'true' }, 0],
  ['set to Never', { 'codex-web-local.turn-notification-mode.v1': 'off' }, 0],
  ['not subscribed', { 'codex-web-local.turn-notification-mode.v1': 'unfocused' }, 1],
]

test('a background page alerts for a finished chat only when Web Push does not and the device is not set to Never', async (t) => {
  const { useDesktopState } = await importWithStubbedApi('../src/composables/useDesktopState.ts', /\/api\/codexGateway$/)
  for (const [device, settings, expected] of deviceCases) {
    await t.test(device, async (st) => {
      const banners = openBackgroundPage(st, settings)
      let stream
      Object.assign(globalThis.__pageApi, {
        subscribeCodexNotifications: (callbacks) => { stream = callbacks; return () => {} },
        getThreadAudience: async () => 'interactive',
        getPendingServerRequests: async () => [],
      })
      const state = useDesktopState()
      state.startPolling()
      stream.onNotification({ method: 'turn/completed', params: { threadId: 'chat-1', turn: { id: 'turn-1', status: 'completed' } } })
      for (let index = 0; index < 12; index++) await Promise.resolve()
      state.stopPolling()
      assert.equal(banners.length, expected)
    })
  }
})

test('a background page alerts for a board event only when Web Push does not and the device is not set to Never', async (t) => {
  const { useProjectBoards } = await importWithStubbedApi('../src/composables/useProjectBoards.ts', /\/api\/(projectBoards|codexRpcClient)$/)
  const event = { id: 'board-event-1', kind: 'batch_completed', boardId: 'board', featureId: '', cardId: '', queueId: 'queue-1', occurredAt: '2026-10-14T00:00:00.000Z' }
  for (const [device, settings, expected] of deviceCases) {
    await t.test(device, (st) => {
      const banners = openBackgroundPage(st, settings)
      let notify
      globalThis.__pageApi.subscribeInPageRpcNotifications = (listener) => { notify = listener; return () => {} }
      const boards = useProjectBoards({ showBrowserNotifications: true })
      boards.startLiveUpdates()
      notify({ method: 'codexui/projectBoards/notification', params: event })
      boards.stopLiveUpdates()
      assert.equal(banners.length, expected)
    })
  }
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
  assert.equal(always.shown[0].options.renotify, true, 'a repeated tag still pops up instead of replacing silently')
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

async function initializeWithPermission(permission, { workerVersion } = {}) {
  const subscribes = []
  const permissionRequests = []
  const storage = new Map()
  const subscription = { endpoint: 'https://push.example.test/stale', toJSON: () => ({ endpoint: 'https://push.example.test/stale', keys: { p256dh: 'k', auth: 'a' } }) }
  const active = workerVersion === undefined ? null : {
    postMessage: (message, [port]) => { if (message.type === 'codexui-sw-version' && workerVersion) port.postMessage({ version: workerVersion }) },
  }
  const registration = { active, pushManager: { getSubscription: async () => subscription } }
  Object.assign(globalThis, {
    window: globalThis,
    isSecureContext: true,
    PushManager: function PushManager() {},
    Notification: { permission, requestPermission: async () => { permissionRequests.push('asked'); return permission } },
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
  return { push, status: push.status.value, subscribes, permissionRequests }
}

test('a device whose notification permission went back to "ask" is not treated as subscribed', async () => {
  const reset = await initializeWithPermission('default')
  assert.equal(reset.status, 'ready', 'the panel offers Enable again')
  assert.deepEqual(reset.subscribes, [], 'the stale subscription is not refreshed as if alerts worked')

  const granted = await initializeWithPermission('granted')
  assert.equal(granted.status, 'enabled')
  assert.equal(granted.subscribes[0].permission, 'granted', 'the server learns the real permission')
})

test('choosing an alert mode never asks for permission; only the Enable button does', async () => {
  const { push, permissionRequests } = await initializeWithPermission('default')
  await push.setTurnNotificationMode('always')
  assert.deepEqual(permissionRequests, [], 'iPhone denies requests made outside a tap, silently and for good')
  assert.match(push.errorMessage.value, /Enable notifications/u)
  await push.enableWebPushNotifications()
  assert.deepEqual(permissionRequests, ['asked'])
})

test('each page load reports which service worker version is running', async () => {
  const current = await initializeWithPermission('granted', { workerVersion: 'receipts-2' })
  assert.equal(current.subscribes[0].workerVersion, 'receipts-2')
  const outdated = await initializeWithPermission('granted', { workerVersion: '' })
  assert.equal(outdated.subscribes[0].workerVersion, 'no-answer', 'an older worker that cannot answer is visible')

  let reply
  const listeners = {}
  vm.runInNewContext(serviceWorkerSource, { self: { addEventListener: (type, handler) => { listeners[type] = handler }, skipWaiting() {}, clients: {} }, URL, console })
  listeners.message({ data: { type: 'codexui-sw-version' }, ports: [{ postMessage: (message) => { reply = message } }] })
  assert.match(reply.version, /^receipts-/u)
})

test('a chat waiting for an answer alerts with the question and opens that chat', async () => {
  const { mkdir, mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  // Inside the checkout, so web-push resolves from its node_modules.
  const cacheDir = new URL('../node_modules/.cache/', import.meta.url).pathname
  await mkdir(cacheDir, { recursive: true })
  const bundleDir = await mkdtemp(join(cacheDir, 'codexui-web-push-test-'))
  try {
    const outfile = join(bundleDir, 'webPushTurnNotifier.mjs')
    await build({ entryPoints: [new URL('../src/server/webPushTurnNotifier.ts', import.meta.url).pathname], outfile, bundle: true, platform: 'node', format: 'esm', external: ['web-push', 'markdown-it'], logLevel: 'silent' })
    const { buildInputRequestPayload } = await import(pathToFileURL(outfile).href)
    const question = { id: 'input-request:claude-abc:5', requestId: 5, threadId: 'claude-abc', kind: 'question', detail: `Which cutoff should I use? ${'Context. '.repeat(40)}`, moreQuestions: 0, occurredAt: '2026-10-12T10:00:00.000Z' }
    const payload = buildInputRequestPayload(question, 'Clean up old chats', 'unfocused')
    assert.equal(payload.title, 'Answer needed · Clean up old chats')
    assert.match(payload.body, /^Which cutoff should I use\?/u)
    assert.ok(payload.body.length <= 180, 'the body fits a lock-screen alert')
    assert.equal(payload.url, '/#/thread/claude-abc')
    assert.equal(payload.tag, question.id, 'a repeated alert for the same request replaces the earlier one')
    assert.equal(payload.mode, 'unfocused', 'each device keeps its own alert mode')

    const approval = buildInputRequestPayload({ ...question, kind: 'approval', detail: '' }, '', 'always')
    assert.deepEqual({ title: approval.title, body: approval.body }, { title: 'Approval needed', body: 'Your approval is needed to continue.' })
  } finally {
    await rm(bundleDir, { recursive: true, force: true })
  }
})
