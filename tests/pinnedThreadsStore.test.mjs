import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(sourcePath, replacements = {}) {
  let source = await readFile(sourcePath, 'utf8')
  for (const [from, to] of Object.entries(replacements)) {
    source = source.replace(from, to)
  }
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const utilsSourceUrl = new URL('../src/utils/pinnedThreads.ts', import.meta.url)
const utilsSource = await readFile(utilsSourceUrl, 'utf8')
const compiledUtils = ts.transpileModule(utilsSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const utilsModuleUrl = `data:text/javascript;base64,${Buffer.from(compiledUtils).toString('base64')}`
const storeSourceUrl = new URL('../src/server/pinnedThreadsStore.ts', import.meta.url)
const { PinnedThreadsStore } = await loadTypeScriptModule(storeSourceUrl, {
  "'../utils/pinnedThreads'": `'${utilsModuleUrl}'`,
})

test('migrates pins once and then ignores changes to the legacy host state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-pins-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'pins.json')
  let legacyThreadIds = ['first', 'second']
  const store = new PinnedThreadsStore({
    stateFilePath,
    readLegacyThreadIds: async () => legacyThreadIds,
    now: () => new Date('2026-07-28T12:00:00.000Z'),
  })

  assert.deepEqual((await store.read()).threadIds, ['first', 'second'])
  legacyThreadIds = ['old-host-snapshot']

  const reopenedStore = new PinnedThreadsStore({
    stateFilePath,
    readLegacyThreadIds: async () => legacyThreadIds,
  })
  assert.deepEqual((await reopenedStore.read()).threadIds, ['first', 'second'])
})

test('persists individual pin intents across store instances', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-pins-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'pins.json')
  const store = new PinnedThreadsStore({
    stateFilePath,
    readLegacyThreadIds: async () => ['first'],
  })

  await store.update({ threadId: 'second', pinned: true, beforeThreadId: 'first' })
  await store.update({ threadId: 'first', pinned: false })

  const reopenedStore = new PinnedThreadsStore({
    stateFilePath,
    readLegacyThreadIds: async () => ['stale'],
  })
  const state = await reopenedStore.read()
  assert.deepEqual(state.threadIds, ['second'])
  assert.equal(state.version, 3)
})

test('rejects stale full-list membership while allowing reorder', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-pins-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new PinnedThreadsStore({
    stateFilePath: join(directory, 'pins.json'),
    readLegacyThreadIds: async () => ['first', 'second'],
  })

  const rejected = await store.reorder(['old', 'first'])
  assert.equal(rejected.accepted, false)
  assert.deepEqual(rejected.threadIds, ['first', 'second'])

  const reordered = await store.reorder(['second', 'first'])
  assert.equal(reordered.accepted, true)
  assert.deepEqual(reordered.threadIds, ['second', 'first'])
  assert.equal(reordered.version, 2)
})
