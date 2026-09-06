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

function fixture(t, gateway = {}) {
  const storage = new Map()
  let timerId = 0
  const timers = new Map()
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }, setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id }, clearTimeout: (id) => timers.delete(id) }
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
    ...gateway,
  }, { get: (target, key) => target[key] ?? (async () => null) })
  const state = useDesktopState()
  state.startPolling()
  t.after(() => { state.stopPolling(); delete globalThis.window; delete globalThis.__historyGateway })
  return {
    state, reads,
    async read() { const pending = state.selectThread('chat-1'); await flush(); assert.ok(reads.length); return { pending, response: reads.at(-1) } },
    emit(method, params) { stream.onNotification({ method, params: { threadId: 'chat-1', turnId: 'turn-1', ...params } }) },
    async runTimers(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback() } await flush() },
    setRollback(messages) { rollbackResult = messages },
    answers() { return state.messages.value.filter((item) => item.id === 'answer') },
  }
}

test('native helper ancestry survives sparse lists and stays scoped to its own thread', async (t) => {
  const f = fixture(t)
  await f.state.refreshAll({ loadSelectedThread: false })
  f.emit('thread/started', { thread: { id: 'chat-1', source: { subAgent: { thread_spawn: { parent_thread_id: 'lead' } } } } })
  assert.equal(f.state.projectGroups.value[0].threads[0].parentThreadId, 'lead', 'A metadata-only event replaces the equal-looking sidebar row')
  assert.equal(f.state.projectGroups.value[0].threads[0].isInternalSubagent, true)
  f.emit('thread/started', { thread: { id: 'unlisted-child', source: { subAgent: { thread_spawn: { parent_thread_id: 'chat-1' } } } } })
  assert.equal(f.state.threadSourceById.value['unlisted-child'].parentThreadId, 'chat-1')
  assert.equal(f.state.threadSourceById.value['chat-1'].parentThreadId, 'lead', 'Envelope IDs cannot reassign the actual child')
  f.emit('thread/started', { thread: { id: 'chat-1' } })
  await f.state.refreshAll({ loadSelectedThread: false })
  assert.equal(f.state.projectGroups.value[0].threads[0].parentThreadId, 'lead')
  assert.equal(f.state.threadSourceById.value['unlisted-child'].isInternalSubagent, true, 'Unlisted ancestry remains available for nested grouping')
})

test('history restores matching helper ancestry and completion does not mark it unread', async (t) => {
  let audienceReads = 0
  let unreadWrites = 0
  const f = fixture(t, {
    getThreadAudience: async () => { audienceReads++; return 'internalSubagent' },
    updateSharedThreadReadState: async (_id, update) => { if (update.unread) unreadWrites++; return null },
  })
  await f.state.refreshAll({ loadSelectedThread: false })
  f.emit('turn/completed', { turn: { id: 'unknown-source-turn', status: 'completed' } })
  await flush()
  assert.equal(audienceReads, 1, 'A listed chat with missing source still resolves its audience')
  assert.equal(unreadWrites, 0)
  const first = await f.read()
  first.response.resolve({ ...page([], false), threadSource: { threadId: 'other-thread', isInternalSubagent: true, parentThreadId: 'wrong-parent' } })
  await first.pending
  assert.equal(f.state.threadSourceById.value['chat-1'], undefined, 'A mismatched history response must not attach another chat’s parent')
  const matching = await f.read()
  matching.response.resolve({ ...page([], false), threadSource: { threadId: 'chat-1', isInternalSubagent: true, parentThreadId: 'lead' } })
  await matching.pending
  assert.equal(f.state.selectedThread.value.parentThreadId, 'lead')
  await f.state.selectThread('')
  f.emit('turn/completed', { turn: { id: 'helper-turn', status: 'completed' } })
  await flush()
  assert.equal(audienceReads, 1, 'Known native source avoids another metadata request')
  assert.equal(unreadWrites, 0)
  assert.equal(f.state.projectGroups.value[0].threads[0].unread, false)
})

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

test('overlapping cold loads retain earlier pages loaded before the later tail response', async (t) => {
  const f = fixture(t)
  const first = await f.read()
  const second = await f.read()
  first.response.resolve(page([message('Latest final answer', { phase: 'final_answer' })], false))
  await first.pending
  const earlier = f.state.loadEarlierMessages('chat-1')
  await flush()
  f.reads.at(-1).resolve({
    ...page([message('Earlier text', { id: 'earlier-answer', turnId: 'turn-0', turnIndex: 49, orderKey: '000049:000002:000000' })], false),
    startTurnIndex: 30, endTurnIndex: 50,
    turnSummaries: [{ turnId: 'turn-0', durationMs: 1200 }],
  })
  await earlier
  second.response.resolve(page([message('Latest final answer', { phase: 'final_answer' })], false))
  await second.pending
  assert.equal(f.state.messages.value.find((item) => item.id === 'earlier-answer')?.text, 'Earlier text')
  assert.equal(f.state.messages.value.some((item) => item.id === 'turn-summary:turn-0'), true)
  assert.equal(f.answers()[0].text, 'Latest final answer')
  const nextEarlier = f.state.loadEarlierMessages('chat-1')
  await flush()
  assert.equal(f.reads.at(-1).options.beforeTurnIndex, 30)
  f.reads.at(-1).resolve({ ...page([], false), startTurnIndex: 10, endTurnIndex: 30 })
  await nextEarlier
})

test('completed work stays visible through turn completion and delayed history without duplicates', async (t) => {
  const f = fixture(t)
  const initial = await f.read()
  initial.response.resolve(page([]))
  await initial.pending
  f.emit('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'Tests pass', exitCode: 0 } })
  f.emit('item/completed', { item: { id: 'tool', type: 'mcpToolCall', server: 'fixture', tool: 'inspect', status: 'completed', result: { content: [{ type: 'text', text: 'Checked' }] } } })
  f.emit('item/started', { item: { id: 'unfinished-command', type: 'commandExecution', command: 'pending' } })
  f.emit('item/started', { item: { id: 'unfinished-tool', type: 'mcpToolCall', server: 'fixture', tool: 'pending' } })
  f.emit('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Done.', phase: 'final_answer' } })
  const work = f.state.messages.value.filter((item) => item.id === 'command' || item.id === 'tool')
  assert.equal(work.length, 2)
  f.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
  const assertVisible = () => {
    for (const item of work) assert.equal(f.state.messages.value.filter((row) => row.id === item.id).length, 1, `${item.id} remains visible exactly once`)
    assert.equal(f.answers()[0].text, 'Done.')
    assert.equal(f.state.messages.value.at(-1).id, 'answer')
    assert.equal(f.state.messages.value.some((item) => item.id.startsWith('unfinished-')), false)
  }
  assertVisible()
  const incomplete = await f.read()
  incomplete.response.resolve(page([message('Done.', { phase: 'final_answer' })], false))
  await incomplete.pending
  assertVisible()
  const hydrated = await f.read()
  hydrated.response.resolve(page([...work.map((item, index) => ({ ...item, turnIndex: 50, orderKey: `000050:00000${index}:000000` })), message('Done.', { phase: 'final_answer' })], false))
  await hydrated.pending
  assertVisible()
  for (const item of work) assert.equal(f.state.messages.value.find((row) => row.id === item.id).turnIndex, 50)
})

test('selected history loads while startup metadata is pending and overlapping lists share a request', async (t) => {
  const lists = []
  const limits = []
  const starts = []
  let finishModels
  const f = fixture(t, {
    getThreadGroups: () => new Promise((resolve) => lists.push(resolve)),
    getAvailableModelCatalog: () => new Promise((resolve) => { finishModels = resolve }),
    getCurrentModelConfig: async () => ({ model: 'fixture-model', reasoningEffort: 'low', fastModeEnabled: true }),
    getCodexUiRuntimeConfig: async () => ({ defaultReasoningEffort: 'low' }),
    getAccountRateLimits: () => new Promise((resolve) => limits.push(resolve)),
    startThread: async (...args) => { starts.push(args); return { threadId: '' } },
  })
  const startup = f.state.refreshAll({ loadSelectedThread: false })
  const overlapping = f.state.refreshAll({ loadSelectedThread: false })
  const selected = await f.read()
  assert.equal(lists.length, 1)
  assert.equal(selected.response.options.limit, 5)
  selected.response.resolve(page([message('Ready before optional metadata')], false))
  await selected.pending
  assert.equal(f.answers()[0].text, 'Ready before optional metadata')
  f.emit('thread/name/updated', { threadName: 'Updated' })
  const afterNotification = f.state.refreshAll({ loadSelectedThread: false })
  lists[0]([])
  await flush()
  assert.equal(lists.length, 2, 'A notification newer than the shared list still triggers a fresh read')
  lists[1]([])
  await Promise.all([startup, overlapping, afterNotification])
  assert.equal(f.reads.length, 1, 'Background startup does not also load the saved chat')
  await f.state.selectThread('')
  await f.state.setSelectedModelId('fixture-model')
  await f.state.setSelectedReasoningEffort('high')
  const send = f.state.sendMessageToNewThread('A new request', '/fixture')
  await flush()
  assert.equal(starts.length, 0, 'Sending waits for preferences without delaying readable history')
  await f.state.setSelectedModelId('another-model')
  finishModels({ ids: ['fixture-model', 'another-model'], fastServiceTierByModel: { 'fixture-model': 'priority' } })
  limits.forEach((resolve) => resolve(null))
  await send
  assert.equal(starts[0][1], 'fixture-model', 'A pending send retains the model chosen at submission')
  assert.equal(starts[0][2], 'priority')
  assert.equal(f.state.selectedReasoningEffort.value, 'high', 'A choice made while metadata loaded is preserved')
})

test('concurrent cold selection shares resume but keeps independently ordered history reads', async (t) => {
  let resumeCount = 0
  let finishResume
  const f = fixture(t, {
    resumeThread: () => { resumeCount += 1; return new Promise((resolve) => { finishResume = resolve }) },
  })
  const first = f.state.selectThread('chat-1')
  const second = f.state.selectThread('chat-1')
  await flush()
  assert.equal(resumeCount, 1)
  assert.equal(f.reads.length, 0)
  finishResume({ model: 'fixture-model', reasoningEffort: 'low' })
  await flush()
  assert.equal(f.reads.length, 2)
  f.reads[1].resolve(page([message('Newest final', { phase: 'final_answer' })], false))
  await second
  f.reads[0].resolve(page([message('Older snapshot')]))
  await first
  assert.equal(f.answers()[0].text, 'Newest final')
})

test('skills load only the requested workspace and late results cannot replace the current workspace', async (t) => {
  const requests = []
  const f = fixture(t, {
    getSkillsList: (cwds) => new Promise((resolve) => requests.push({ cwds, resolve })),
  })
  const first = f.state.refreshSkills('/first')
  const same = f.state.refreshSkills('/first')
  const current = f.state.refreshSkills('/current')
  assert.deepEqual(requests.map((request) => request.cwds), [['/first'], ['/current']])
  requests[1].resolve([{ name: 'Current skill', path: '/current/SKILL.md' }])
  await current
  requests[0].resolve([{ name: 'Old skill', path: '/first/SKILL.md' }])
  await Promise.all([first, same])
  assert.equal(f.state.installedSkills.value[0].name, 'Current skill')
  const reconnect = f.state.refreshSkills()
  assert.deepEqual(requests.at(-1).cwds, ['/current'], 'An untargeted refresh keeps the selected new-chat folder')
  requests.at(-1).resolve([])
  await reconnect
})

test('tail refreshes stay small and restore the previous catch-up window after a gap', async (t) => {
  const f = fixture(t)
  const first = await f.read()
  first.response.resolve(page([message('Earlier answer')], false))
  await first.pending
  const current = await f.read()
  assert.equal(current.response.options.limit, 5)
  current.response.resolve({ ...page([message('Recent answer')], false), startTurnIndex: 51, endTurnIndex: 56, totalTurns: 56 })
  await current.pending
  assert.equal(f.reads.length, 2)
  const afterGap = await f.read()
  afterGap.response.resolve({ ...page([message('Latest answer')], false), startTurnIndex: 60, endTurnIndex: 65, totalTurns: 65 })
  await flush()
  assert.equal(f.reads.at(-1).options.limit, 20)
  f.reads.at(-1).resolve({
    ...page([message('Gap answer', { id: 'gap-answer', turnIndex: 57 }), message('Latest answer')], false),
    startTurnIndex: 45, endTurnIndex: 65, totalTurns: 65,
  })
  await afterGap.pending
  assert.equal(f.state.messages.value.find((item) => item.id === 'gap-answer')?.text, 'Gap answer')
})

test('streaming bursts update live content without replaying history, then completion reconciles once', async (t) => {
  let listReads = 0
  const f = fixture(t, { getThreadGroups: async () => {
    listReads += 1
    return [{ projectName: 'fixture', threads: [{ id: 'chat-1', projectName: 'fixture', cwd: '/fixture', title: 'Fixture', runtimeStatus: 'idle' }] }]
  } })
  const initial = await f.read()
  initial.response.resolve(page([message('')]))
  await initial.pending
  f.emit('item/started', { item: { id: 'command', type: 'commandExecution', command: 'check' } })
  f.emit('item/started', { item: { id: 'reasoning', type: 'reasoning' } })
  f.emit('item/started', { item: { id: 'tool', type: 'mcpToolCall', server: 'fixture', tool: 'check' } })
  for (let batch = 0; batch < 10; batch++) {
    for (let index = 0; index < 10; index++) {
      f.emit('item/agentMessage/delta', { itemId: 'answer', delta: 'x' })
      f.emit('item/commandExecution/outputDelta', { itemId: 'command', delta: 'log\n' })
      f.emit('item/reasoning/summaryTextDelta', { itemId: 'reasoning', delta: 'Thinking' })
      f.emit('item/mcpToolCall/progress', { itemId: 'tool', message: 'Checking' })
      f.emit('thread/tokenUsage/updated', { tokenUsage: {} })
      f.emit('account/rateLimits/updated', { rateLimits: {} })
    }
    await f.runTimers(220)
    assert.equal(f.reads.length, 1)
    assert.equal(listReads, 0)
  }
  assert.equal(f.answers()[0].text, 'x'.repeat(100))
  assert.equal(f.state.messages.value.find((item) => item.id === 'command').commandExecution.aggregatedOutput, 'log\n'.repeat(100))
  f.emit('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Done', phase: 'final_answer' } })
  f.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
  await f.runTimers(220)
  await flush()
  assert.equal(listReads, 1)
  assert.equal(f.reads.length, 2)
  f.reads[1].resolve(page([message('Done', { phase: 'final_answer' })], false))
  await flush()
  await f.runTimers(900)
  assert.equal(f.reads.length, 2, 'Turn completion cancels the redundant item-completion fallback')
  assert.equal(f.answers()[0].text, 'Done')
})

test('pending approvals and questions replace generic thinking without ending the active turn', async (t) => {
  const f = fixture(t)
  const loading = await f.read()
  f.emit('server/request', { id: 10, method: 'item/commandExecution/requestApproval', params: { threadId: 'chat-1', turnId: 'turn-1', command: 'check' } })
  assert.equal(f.state.isLoadingMessages.value, true)
  assert.equal(f.state.selectedLiveOverlay.value.activityLabel, 'Waiting for approval')
  loading.response.resolve(page([message('Check requested')]))
  await loading.pending
  assert.equal(f.state.selectedThreadActiveTurnId.value, 'turn-1')
  assert.equal(f.state.selectedLiveOverlay.value.activityLabel, 'Waiting for approval')
  f.emit('server/request/resolved', { id: 10 })
  assert.equal(f.state.selectedLiveOverlay.value.activityLabel, 'Thinking')
  f.emit('server/request', { id: 11, method: 'item/tool/requestUserInput', params: { threadId: 'chat-1', turnId: 'turn-1', questions: [] } })
  assert.equal(f.state.selectedLiveOverlay.value.activityLabel, 'Waiting for your answer')
  f.emit('server/request/resolved', { id: 11 })
  f.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
  assert.equal(f.state.selectedLiveOverlay.value, null)
})
