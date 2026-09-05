import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import ts from 'typescript'

// Exercise the actual composable with deferred bridge responses, without a
// browser, app-server, persistent user state, or exported production test hooks.
const entry = fileURLToPath(new URL('../src/composables/useDesktopState.ts', import.meta.url))
const ast = ts.createSourceFile(entry, await readFile(entry, 'utf8'), ts.ScriptTarget.Latest, true)
const gatewayImport = ast.statements.find((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text.endsWith('/codexGateway'))
const gatewayNames = gatewayImport.importClause.namedBindings.elements.filter((node) => !node.isTypeOnly).map((node) => node.name.text)
const { outputFiles } = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{
  name: 'desktop-history-fixture',
  setup(build) {
    build.onResolve({ filter: /^vue$/ }, () => ({ path: import.meta.resolve('vue'), external: true }))
    build.onResolve({ filter: /codexGateway$/ }, () => ({ path: 'gateway', namespace: 'fixture' }))
    build.onResolve({ filter: /useWebPushNotifications$/ }, () => ({ path: 'notifications', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'gateway'
      ? gatewayNames.map((name) => `export const ${name}=(...args)=>globalThis.__historyGateway.${name}(...args);`).join('\n')
      : "export const getLocalTurnNotificationMode=()=> 'off'; export const isWebPushLocallyEnabled=()=>false;" }))
  },
}] })
const { useDesktopState } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
const message = (text, overrides = {}) => ({ id: 'answer', role: 'assistant', text, messageType: 'agentMessage', turnId: 'turn-1', turnIndex: 50, orderKey: '000050:000002:000000', ...overrides })
const page = (messages, isInProgress = true) => ({ messages, isInProgress, activeTurnId: isInProgress ? 'turn-1' : '', turnSummaries: [], startTurnIndex: 50, endTurnIndex: 51, totalTurns: 51, hasEarlier: true })

function fixture(t) {
  const storage = new Map()
  let timerId = 0
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }, setTimeout: () => ++timerId, clearTimeout() {} }
  const reads = []
  let stream
  let rollbackResult = []
  globalThis.__historyGateway = new Proxy({
    getThreadMessagesWithStatus: (threadId, options) => new Promise((resolve) => reads.push({ threadId, options, resolve })),
    getThreadGoal: async () => null,
    resumeThread: async () => ({ model: 'fixture-model', reasoningEffort: 'low' }),
    subscribeCodexNotifications: (callbacks) => { stream = callbacks; return () => {} },
    getPendingServerRequests: async () => [],
    getThreadGroups: async () => [{ projectName: 'fixture', threads: [{ id: 'chat-1', projectName: 'fixture', cwd: '/fixture', title: 'Fixture', updatedAtIso: '2026-09-06T00:00:00.000Z', createdAtIso: '2026-09-06T00:00:00.000Z', runtimeStatus: 'idle' }] }],
    getThreadTitleCache: async () => ({ titles: {}, order: [] }),
    getSharedThreadReadState: async () => null,
    getWorkspaceRootsState: async () => ({ order: [], labels: {}, active: [] }),
    rollbackThread: async () => rollbackResult,
  }, { get: (target, key) => target[key] ?? (async () => null) })
  const state = useDesktopState()
  state.startPolling()
  t.after(() => { state.stopPolling(); delete globalThis.window; delete globalThis.__historyGateway })
  return {
    state, reads,
    async read() { const pending = state.selectThread('chat-1'); await flush(); assert.ok(reads.length); return { pending, response: reads.at(-1) } },
    emit(method, params) { stream.onNotification({ method, params: { threadId: 'chat-1', turnId: 'turn-1', ...params } }) },
    setRollback(messages) { rollbackResult = messages },
    answers() { return state.messages.value.filter((item) => item.id === 'answer') },
  }
}

test('history hydration retains streamed text, canonical order and a single item through later deltas', async (t) => {
  const f = fixture(t)
  const first = await f.read()
  f.emit('item/agentMessage/delta', { itemId: 'answer', delta: 'Hello world' })
  first.response.resolve(page([message('Hello')]))
  await first.pending
  assert.equal(f.answers().length, 1)
  assert.equal(f.answers()[0].text, 'Hello world')
  assert.equal(f.answers()[0].turnIndex, 50)
  assert.equal(f.answers()[0].orderKey, '000050:000002:000000')
  f.emit('item/agentMessage/delta', { itemId: 'answer', delta: '!' })
  assert.equal(f.answers().length, 1)
  assert.equal(f.answers()[0].text, 'Hello world!')
  for (const staleText of ['Hello', '']) {
    const stale = await f.read()
    stale.response.resolve(page([message(staleText)]))
    await stale.pending
    assert.equal(f.answers()[0].text, 'Hello world!', 'Repeated incomplete snapshots cannot erase hydrated text')
  }
  f.emit('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Done.', phase: 'final_answer' } })
  assert.equal(f.answers().length, 1)
  assert.equal(f.answers()[0].text, 'Done.', 'Authoritative completion may replace text with a shorter answer')
  assert.equal(f.answers()[0].phase, 'final_answer')
  f.emit('item/completed', { item: { id: 'answer', type: 'agentMessage', text: '', phase: 'final_answer' } })
  assert.equal(f.answers()[0].text, '', 'An explicit empty completion is authoritative too')
})

test('out-of-order reads and stale lifecycle state cannot overwrite a final response', async (t) => {
  const f = fixture(t)
  const older = await f.read()
  const newer = await f.read()
  newer.response.resolve(page([message('Final answer', { phase: 'final_answer' })], false))
  await newer.pending
  older.response.resolve(page([message('')]))
  await older.pending
  assert.equal(f.answers()[0].text, 'Final answer')
  assert.equal(f.state.selectedLiveOverlay.value, null)

  const beforeCompletion = await f.read()
  f.emit('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Short.', phase: 'final_answer' } })
  f.emit('thread/status/changed', { status: { type: 'idle' } })
  beforeCompletion.response.resolve(page([message('Final answer')]))
  await beforeCompletion.pending
  assert.equal(f.answers()[0].text, 'Short.')
  assert.equal(f.state.selectedLiveOverlay.value, null, 'Fresh completion stays idle after an older running snapshot')
})

test('fresh completed history corrects an ahead-of-stream hydration estimate', async (t) => {
  const f = fixture(t)
  const hydrated = await f.read()
  hydrated.response.resolve(page([message('Hello world')]))
  await hydrated.pending
  // HTTP history can arrive before the corresponding SSE delta. There is no
  // stream offset to infer overlap; the final authoritative result resolves it.
  f.emit('item/agentMessage/delta', { itemId: 'answer', delta: ' world' })
  const completed = await f.read()
  completed.response.resolve(page([message('Hello world', { phase: 'final_answer' })], false))
  await completed.pending
  assert.equal(f.answers().length, 1)
  assert.equal(f.answers()[0].text, 'Hello world')
})

test('an unrelated live item cannot hide a fuller history item', async (t) => {
  const f = fixture(t)
  const pending = await f.read()
  f.emit('item/agentMessage/delta', { itemId: 'answer', delta: 'Hello' })
  pending.response.resolve(page([message('Hello')]))
  await pending.pending
  f.emit('item/agentMessage/delta', { itemId: 'answer', delta: '!' })
  const fuller = await f.read()
  f.emit('item/agentMessage/delta', { itemId: 'other', delta: 'Separate update' })
  fuller.response.resolve(page([message('Hello! A complete explanation.')]))
  await fuller.pending
  assert.equal(f.answers()[0].text, 'Hello! A complete explanation.')
})

test('rollback removes messages and rejects a pre-rollback history response', async (t) => {
  const f = fixture(t)
  const initial = await f.read()
  initial.response.resolve(page([message('Remove this answer')], false))
  await initial.pending
  const stale = await f.read()
  f.setRollback([])
  const rollingBack = f.state.rollbackSelectedThread(50)
  await flush()
  stale.response.resolve(page([message('Remove this answer')], false))
  await stale.pending
  await flush()
  // Rollback's normal refresh has its own, newer request.
  f.reads.at(-1).resolve(page([], false))
  await rollingBack
  assert.deepEqual(f.state.messages.value, [])
})
