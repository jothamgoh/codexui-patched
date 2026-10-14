import assert from 'node:assert/strict'
import { request } from 'node:http'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { build } from 'esbuild'
import express from 'express'

const bundleDir = fileURLToPath(new URL('../output/test-bundles/', import.meta.url))
async function loadModule(path) {
  const outfile = join(bundleDir, `responseCompression-${process.pid}.mjs`)
  await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, outfile, format: 'esm', platform: 'node', logLevel: 'silent', packages: 'external' })
  try { return await import(pathToFileURL(outfile).href) } finally { await rm(outfile, { force: true }) }
}
const { createResponseCompression } = await loadModule('../src/server/responseCompression.ts')

// A chat page's worth of JSON, written the way the bridge writes it (setHeader + end).
const page = JSON.stringify({ result: { thread: { turns: Array.from({ length: 200 }, (_, i) => ({ id: `turn-${i}`, text: 'A reply with some words in it. '.repeat(4) })) } } })

async function serve(t) {
  const app = express()
  app.use(createResponseCompression())
  app.get('/codex-api/thread-page', (_req, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(page)
  })
  app.get('/codex-api/tiny', (_req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end('{"ok":true}')
  })
  app.get('/codex-api/events', (_req, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.write('event: ready\ndata: {"ok":true}\n\n')
    const later = setTimeout(() => res.end(), 500)
    res.on('close', () => clearTimeout(later))
  })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  return server.address().port
}

/** The response's headers, and its body as received (still compressed, if it was). */
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject).end()
  })
}

test('a chat page is sent gzipped to a client that accepts it, and unpacks to the same JSON', async (t) => {
  const port = await serve(t)
  const res = await get(port, '/codex-api/thread-page', { 'Accept-Encoding': 'gzip' })
  assert.equal(res.headers['content-encoding'], 'gzip')
  assert.ok(res.body.length < page.length / 3, `${res.body.length} bytes for ${page.length}`)
  assert.equal(gunzipSync(res.body).toString('utf8'), page)
})

test('a client that does not ask for gzip gets the page as it was', async (t) => {
  const port = await serve(t)
  const res = await get(port, '/codex-api/thread-page')
  assert.equal(res.headers['content-encoding'], undefined)
  assert.equal(res.body.toString('utf8'), page)
})

test('small replies are not worth compressing', async (t) => {
  const port = await serve(t)
  const res = await get(port, '/codex-api/tiny', { 'Accept-Encoding': 'gzip' })
  assert.equal(res.headers['content-encoding'], undefined)
  assert.equal(res.body.toString('utf8'), '{"ok":true}')
})

test('the live event stream is never compressed, so each event arrives at once', async (t) => {
  const port = await serve(t)
  const first = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/codex-api/events', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      res.once('data', (chunk) => { resolve({ headers: res.headers, chunk: chunk.toString('utf8') }); res.destroy() })
    }).on('error', reject).end()
  })
  assert.equal(first.headers['content-encoding'], undefined)
  assert.match(first.chunk, /^event: ready/)
})
