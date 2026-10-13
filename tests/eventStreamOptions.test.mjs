import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const bundleDir = fileURLToPath(new URL('../output/test-bundles/', import.meta.url))
async function loadModule(path) {
  const outfile = join(bundleDir, `eventStreamOptions-${process.pid}.mjs`)
  await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, outfile, format: 'esm', platform: 'node', logLevel: 'silent', packages: 'external' })
  try { return await import(pathToFileURL(outfile).href) } finally { await rm(outfile, { force: true }) }
}
const { parseEventStreamOptions, DEFAULT_EVENT_PING_MS } = await loadModule('../src/server/eventStreamOptions.ts')
const parse = (query) => parseEventStreamOptions(new URLSearchParams(query))

test('without parameters the stream is unchanged: every method, a ping every 5 s', () => {
  const options = parse('')
  assert.equal(options.pingMs, DEFAULT_EVENT_PING_MS)
  assert.equal(options.matches('item/agentMessage/delta'), true)
  assert.equal(options.matches('turn/completed'), true)
})

test('methods keeps exact names and trailing-* prefixes, and drops everything else', () => {
  const options = parse('methods=turn/completed, server/request*')
  assert.equal(options.matches('turn/completed'), true)
  assert.equal(options.matches('server/request'), true)
  assert.equal(options.matches('server/request/resolved'), true)
  assert.equal(options.matches('turn/started'), false)
  assert.equal(options.matches('item/agentMessage/delta'), false, 'streamed words are not sent to a quiet client')
})

test('ping is seconds, clamped to 5–300; junk falls back to 5 s', () => {
  assert.equal(parse('ping=60').pingMs, 60_000)
  assert.equal(parse('ping=1').pingMs, 5_000)
  assert.equal(parse('ping=99999').pingMs, 300_000)
  assert.equal(parse('ping=abc').pingMs, 5_000)
  assert.equal(parse('ping=-5').pingMs, 5_000)
})
