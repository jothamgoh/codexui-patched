import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function compileTypeScriptModule(sourcePath, replacements = []) {
  let source = await readFile(sourcePath, 'utf8')
  for (const [search, replacement] of replacements) source = source.replace(search, replacement)
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
}

const codexErrorsUrl = await compileTypeScriptModule(
  new URL('../src/api/codexErrors.ts', import.meta.url),
)
const bridgeEndpointUrl = await compileTypeScriptModule(
  new URL('../src/api/bridgeEndpoint.ts', import.meta.url),
  [["from './codexErrors'", `from '${codexErrorsUrl}'`]],
)
const { callBridgeEndpoint } = await import(bridgeEndpointUrl)

test('unwraps a valid bridge result envelope', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(JSON.stringify({ result: { ok: true } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  assert.deepEqual(await callBridgeEndpoint('/test', {}, 'test'), { ok: true })
})

test('explains frontend/server version skew when an API path returns SPA HTML', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response('<!doctype html><title>CodexUI</title>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })

  await assert.rejects(
    callBridgeEndpoint('/codex-api/new-route', {}, 'new-route'),
    (error) => (
      error?.code === 'invalid_response'
      && error.message.includes('newer CodexUI frontend than the running server')
    ),
  )
})

test('preserves a JSON API error from the server', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Unknown CodexUI API route.' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })

  await assert.rejects(
    callBridgeEndpoint('/codex-api/missing', {}, 'missing'),
    (error) => error?.status === 404 && error.message === 'Unknown CodexUI API route.',
  )
})

test('completed turns clear only their own pending approval and question UI without sending an answer', async () => {
  // Exercise the real notification method without constructing the bridge or
  // starting a Codex process, reading credentials, or loading notification sinks.
  const source = await readFile(new URL('../src/server/codexAppServerBridge.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('bridge.ts', source, ts.ScriptTarget.Latest, true)
  const processClass = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'AppServerProcess')
  const method = processClass.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'emitNotification')
  const cleanup = processClass.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'clearPendingServerRequestsForTurn')
  const compiled = ts.transpileModule(`
    const asRecord = (value) => value && typeof value === 'object' ? value : null;
    const readNestedString = (value, first, second) => value?.[first]?.[second] || '';
    export class NotificationHarness {
      pendingServerRequests = new Map();
      notificationListeners = new Set();
      reviewMutationGate = { markTurnStarted() {}, markTurnCompleted() {} };
      ${method.getText(ast)}
      ${cleanup.getText(ast)}
    }
  `, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  const { NotificationHarness } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
  const bridge = new NotificationHarness()
  const events = []
  bridge.notificationListeners.add((event) => events.push(event))
  for (const [id, method, threadId, turnId] of [
    [1, 'item/commandExecution/requestApproval', 'lead', 'turn-1'],
    [2, 'item/tool/requestUserInput', 'lead', 'turn-1'],
    [3, 'item/tool/requestUserInput', 'lead', 'turn-2'],
    [4, 'item/tool/requestUserInput', 'other-chat', 'turn-1'],
  ]) bridge.pendingServerRequests.set(id, { id, method, params: { threadId, turnId } })
  const completed = { method: 'turn/completed', params: { threadId: 'lead', turn: { id: 'turn-1', status: 'interrupted' } } }
  bridge.clearPendingServerRequestsForTurn('lead', 'turn-1')
  bridge.emitNotification(completed)
  bridge.emitNotification(completed)
  assert.deepEqual([...bridge.pendingServerRequests.keys()], [3, 4])
  assert.deepEqual(events.filter((event) => event.method === 'server/request/resolved').map((event) => [event.params.id, event.params.mode]), [[1, 'cancelled'], [2, 'cancelled']])
  bridge.emitNotification({ method: 'turn/completed', params: { threadId: 'lead', turn: { id: 'turn-2', status: 'completed' } } })
  assert.deepEqual([...bridge.pendingServerRequests.keys()], [4])
  assert.deepEqual(events.filter((event) => event.method === 'server/request/resolved').map((event) => event.params.id), [1, 2, 3])
})

async function bridgeRouteHarness(path, dependencies) {
  // Run the actual route branch without initializing Codex, user stores, or
  // notification sinks. Validation and forwarding remain production code.
  const source = await readFile(new URL('../src/server/codexAppServerBridge.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('bridge.ts', source, ts.ScriptTarget.Latest, true)
  let route
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast).includes(`url.pathname === '${path}'`)) route = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(route, `Missing production route ${path}`)
  const compiled = ts.transpileModule(`
    export function createHarness(dependencies) {
      const { appServer, projectBoardService, projectBoardThreadIds, withBoardPlanningContext, automationService } = dependencies;
      const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      const readJsonBody = async (request) => request.body;
      const basename = (path) => path.split('/').filter(Boolean).at(-1);
      const setJson = (response, status, body) => Object.assign(response, { status, body });
      return async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        ${route.getText(ast)}
      };
    }
  `, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  return (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)).createHarness(dependencies)
}

test('ordinary steering advertises optional board planning without changing native input or turn identity', async () => {
  const calls = []
  const route = await bridgeRouteHarness('/codex-api/rpc', {
    appServer: { rpc: async (method, params) => { calls.push({ method, params }); return { accepted: true } } },
    withBoardPlanningContext: (params, port) => ({ ...params, additionalContext: { ...params.additionalContext, optionalBoard: { kind: 'application', value: `Local helper on ${port}` } } }),
  })
  const params = { threadId: 'existing-chat', expectedTurnId: 'active-turn', clientUserMessageId: 'reply-id', input: [{ type: 'text', text: 'Make a separate board for the new initiative.' }], additionalContext: { prior: { kind: 'application', value: 'Keep this context' } } }
  const response = {}
  await route({ url: '/codex-api/rpc', method: 'POST', socket: { localPort: 12345 }, body: { method: 'turn/steer', params } }, response)
  assert.equal(response.status, 200)
  assert.equal(calls[0].method, 'turn/steer')
  assert.equal(calls[0].params.input, params.input)
  assert.equal(calls[0].params.expectedTurnId, 'active-turn')
  assert.equal(calls[0].params.clientUserMessageId, 'reply-id')
  assert.equal(calls[0].params.additionalContext.prior, params.additionalContext.prior)
  assert.match(calls[0].params.additionalContext.optionalBoard.value, /12345/u)
  assert.deepEqual(Object.keys(params.additionalContext), ['prior'])
})

test('a feature Lead can save a separate board draft using its verified project while store guards remain authoritative', async () => {
  const calls = []
  const drafts = []
  let thread = { id: 'managed-lead', cwd: '/verified/project' }
  let saveError = ''
  const route = await bridgeRouteHarness('/codex-api/project-board-planning', {
    appServer: { rpc: async (method, params) => { calls.push({ method, params }); return { thread } } },
    projectBoardService: {
      isManagedThread: async () => true,
      saveDraftPlan: async (input) => { drafts.push(input); if (saveError) throw new Error(saveError); return { version: 12 } },
    },
  })
  const request = { url: '/codex-api/project-board-planning', method: 'POST', body: {
    sourceThreadId: 'managed-lead', boardId: 'NEW-BOARD', expectedVersion: 11,
    projectPath: '/client-spoof', projectName: 'Spoofed', summary: 'A separate initiative.', features: [{ id: 'NEW-FEATURE' }],
  } }
  const response = {}
  await route(request, response)
  assert.equal(response.status, 200)
  assert.deepEqual(calls[0], { method: 'thread/read', params: { threadId: 'managed-lead', includeTurns: false } })
  assert.equal(drafts[0].projectPath, '/verified/project')
  assert.equal(drafts[0].projectName, 'project')
  assert.equal(drafts[0].boardId, 'new-board')
  assert.equal(drafts[0].sourceThreadId, 'managed-lead')
  assert.equal(drafts[0].expectedVersion, 11)
  assert.equal(drafts[0].features, request.body.features)
  assert.deepEqual(response.body.data.featureIds, ['new-feature'])
  assert.match(response.body.data.message, /No work started/u)

  thread = { ...thread, id: 'different-thread' }
  await assert.rejects(route(request, {}), /project is unavailable/u)
  assert.equal(drafts.length, 1, 'A mismatched native chat must never reach the store')
  thread = { id: 'managed-lead', cwd: '/verified/project' }
  for (const error of ['Wait for this board’s active run to stop before revising its plan.', 'The board changed. Read its latest plan before saving again.']) {
    saveError = error
    await assert.rejects(route(request, {}), (caught) => caught.message === error)
  }
})
