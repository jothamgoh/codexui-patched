import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/server/hostFolders.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
const { listHostFolders } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const clientSource = await readFile(new URL('../src/api/hostFolders.ts', import.meta.url), 'utf8')
const clientCompiled = ts.transpileModule(clientSource, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
const { getHostFolders } = await import(`data:text/javascript;base64,${Buffer.from(clientCompiled).toString('base64')}`)

test('folder picker explains a missing server route without mislabeling folder errors', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  for (const [status, message, expected] of [
    [404, 'Unknown CodexUI API route.', /Restart the CodexUI service/u],
    [404, 'This folder is unavailable. Choose another folder or check the path.', /^This folder is unavailable\./u],
    [403, 'CodexUI cannot read this folder.', /^CodexUI cannot read this folder\.$/u],
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: message }), {
      status, headers: { 'Content-Type': 'application/json' },
    })
    await assert.rejects(getHostFolders(), { message: expected })
  }
})

test('folder picker can retry successfully after its server gains the route', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const listing = { path: '/projects', homePath: '/home', parentPath: '/', folders: [], truncated: false }
  let restarted = false
  const controller = new AbortController()
  globalThis.fetch = async (url, options) => {
    const query = new URL(url, 'http://localhost').searchParams
    assert.equal(query.get('path'), '/projects')
    assert.equal(query.get('showHidden'), 'true')
    assert.equal(options.signal, controller.signal)
    return restarted
      ? new Response(JSON.stringify({ data: listing }), { headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ error: 'Unknown CodexUI API route.' }), { status: 404 })
  }
  await assert.rejects(getHostFolders('/projects', true, controller.signal), /Restart/u)
  restarted = true
  assert.deepEqual(await getHostFolders('/projects', true, controller.signal), listing)
})

async function fixture(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'codexui-folders-')))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('host browsing returns folders only, supports symlinks and Home, and leaves files unchanged', async (t) => {
  const home = await fixture(t)
  await mkdir(join(home, 'Project 10'))
  await mkdir(join(home, 'Project 2'))
  await mkdir(join(home, '.hidden'))
  await writeFile(join(home, 'notes.txt'), 'Keep this file.\n')
  await symlink(join(home, 'Project 2'), join(home, 'linked-folder'))
  await symlink(join(home, 'missing'), join(home, 'broken-link'))
  const listing = await listHostFolders('', false, home)
  assert.deepEqual(listing.folders.map((folder) => folder.name), ['linked-folder', 'Project 2', 'Project 10'])
  assert.equal(listing.path, home)
  assert.equal(listing.homePath, home)
  assert.equal(listing.parentPath, dirname(home))
  assert.equal(listing.truncated, false)
  const linked = await listHostFolders(join(home, 'linked-folder'), false, home)
  assert.equal(linked.path, join(home, 'Project 2'))
  assert.deepEqual(linked.folders, [])
  assert.ok((await listHostFolders('~', true, home)).folders.some((folder) => folder.name === '.hidden'))
  assert.equal((await listHostFolders('~/Project 2', false, home)).path, linked.path)
  assert.equal(await readFile(join(home, 'notes.txt'), 'utf8'), 'Keep this file.\n')
})

test('host browsing rejects relative paths, files, and unavailable folders with useful errors', async (t) => {
  const home = await fixture(t)
  await writeFile(join(home, 'file.txt'), 'File')
  await assert.rejects(listHostFolders('relative/path', false, home), (error) => error.statusCode === 400)
  await assert.rejects(listHostFolders(join(home, 'file.txt'), false, home), (error) => error.statusCode === 400 && /not a file/u.test(error.message))
  await assert.rejects(listHostFolders(join(home, 'missing'), false, home), (error) => error.statusCode === 404)
})

test('host browsing reports denied directory access', { skip: process.getuid?.() === 0 }, async (t) => {
  const home = await fixture(t)
  const restricted = join(home, 'restricted')
  await mkdir(restricted)
  await chmod(restricted, 0)
  try {
    await assert.rejects(listHostFolders(restricted, false, home), (error) => error.statusCode === 403 && /permissions/u.test(error.message))
  } finally { await chmod(restricted, 0o700) }
})

test('large host directories return a bounded listing with an explicit truncation flag', async (t) => {
  const home = await fixture(t)
  await Promise.all(Array.from({ length: 501 }, (_, index) => mkdir(join(home, `folder-${index}`))))
  const listing = await listHostFolders(home)
  assert.equal(listing.folders.length, 500)
  assert.equal(listing.truncated, true)
})
