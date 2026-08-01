import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(sourcePath) {
  const source = await readFile(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const storeSourceUrl = new URL('../src/server/threadMetadataStore.ts', import.meta.url)
const { ThreadMetadataStore } = await loadTypeScriptModule(storeSourceUrl)

test('migrates legacy metadata once and ignores later desktop snapshots', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-metadata-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let legacyTitle = 'Current title'
  let legacyUnread = ['current-thread']
  const stateFilePath = join(directory, 'metadata.json')
  const store = new ThreadMetadataStore({
    stateFilePath,
    readLegacyTitles: async () => ({ titles: { current: legacyTitle }, order: ['current'] }),
    readLegacyReadState: async () => ({
      readAtByThreadId: {},
      unreadThreadIds: legacyUnread,
      readOrder: [],
      version: 2,
    }),
  })

  assert.equal((await store.readTitles()).titles.current, 'Current title')
  assert.deepEqual((await store.readReadState()).unreadThreadIds, ['current-thread'])

  legacyTitle = 'Stale desktop title'
  legacyUnread = ['stale-thread']
  const reopened = new ThreadMetadataStore({
    stateFilePath,
    readLegacyTitles: async () => ({ titles: { current: legacyTitle }, order: ['current'] }),
    readLegacyReadState: async () => ({ unreadThreadIds: legacyUnread }),
  })
  assert.equal((await reopened.readTitles()).titles.current, 'Current title')
  assert.deepEqual((await reopened.readReadState()).unreadThreadIds, ['current-thread'])
})

test('serializes title and read mutations into the same atomic state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-metadata-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'metadata.json')
  const store = new ThreadMetadataStore({
    stateFilePath,
    readLegacyTitles: async () => ({}),
    readLegacyReadState: async () => ({}),
  })

  await Promise.all([
    store.updateTitle('thread-a', 'Alpha'),
    store.updateReadState('thread-a', true, ''),
    store.updateReadState('thread-b', false, '2026-07-28T12:00:00.000Z'),
  ])

  const reopened = new ThreadMetadataStore({
    stateFilePath,
    readLegacyTitles: async () => ({}),
    readLegacyReadState: async () => ({}),
  })
  assert.equal((await reopened.readTitles()).titles['thread-a'], 'Alpha')
  const readState = await reopened.readReadState()
  assert.deepEqual(readState.unreadThreadIds, ['thread-a'])
  assert.equal(readState.readAtByThreadId['thread-b'], '2026-07-28T12:00:00.000Z')
  assert.equal(readState.version, 2)
})
