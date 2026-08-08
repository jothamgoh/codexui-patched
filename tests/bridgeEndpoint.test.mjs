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
