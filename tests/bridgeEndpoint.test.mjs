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
  const compiled = ts.transpileModule(`
    const asRecord = (value) => value && typeof value === 'object' ? value : null;
    const readNestedString = (value, first, second) => value?.[first]?.[second] || '';
    export class NotificationHarness {
      pendingServerRequests = new Map();
      notificationListeners = new Set();
      reviewMutationGate = { markTurnStarted() {}, markTurnCompleted() {} };
      ${method.getText(ast)}
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
  bridge.emitNotification(completed)
  bridge.emitNotification(completed)
  assert.deepEqual([...bridge.pendingServerRequests.keys()], [3, 4])
  assert.deepEqual(events.filter((event) => event.method === 'server/request/resolved').map((event) => [event.params.id, event.params.mode]), [[1, 'cancelled'], [2, 'cancelled']])
})
