import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { computed, isReactive, nextTick, reactive } from 'vue'
import { createPinia } from 'pinia'

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

async function loadComposerDraftStore() {
  const utilitySource = await readFile(sourceUrl, 'utf8')
  const utilityModuleUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(utilitySource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText).toString('base64')}`
  const storeSource = await readFile(storeSourceUrl, 'utf8')
  const compiledStore = ts.transpileModule(storeSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
    .replace("from 'pinia'", `from '${import.meta.resolve('pinia')}'`)
    .replace("from '../utils/composerDrafts'", `from '${utilityModuleUrl}'`)
  const storeModuleUrl = `data:text/javascript;base64,${Buffer.from(compiledStore).toString('base64')}`
  return import(storeModuleUrl)
}

const sourceUrl = new URL('../src/utils/composerDrafts.ts', import.meta.url)
const storeSourceUrl = new URL('../src/stores/composerDrafts.ts', import.meta.url)
const {
  clearComposerDraft,
  ensureComposerDraft,
  updateComposerResponseAnnotation,
} = await loadTypeScriptModule(sourceUrl)

test('keeps complete composer drafts independent by thread', () => {
  const drafts = {}
  const first = ensureComposerDraft(drafts, 'thread-1')
  first.text = 'First draft'
  first.selectedPlugins.push({ id: 'plugin-1', name: 'plugin', displayName: 'Plugin', path: 'plugin://one' })
  first.fileAttachments.push({ label: 'notes.md', path: '/tmp/notes.md', fsPath: '/tmp/notes.md' })
  first.responseTextAnnotations.push({ id: 'annotation-1', text: 'Selected response', annotation: 'Check this' })

  const second = ensureComposerDraft(drafts, 'thread-2')
  second.text = 'Second draft'

  assert.equal(ensureComposerDraft(drafts, 'thread-1').text, 'First draft')
  assert.equal(ensureComposerDraft(drafts, 'thread-1').selectedPlugins.length, 1)
  assert.equal(ensureComposerDraft(drafts, 'thread-1').fileAttachments.length, 1)
  assert.equal(ensureComposerDraft(drafts, 'thread-1').responseTextAnnotations.length, 1)
  assert.equal(ensureComposerDraft(drafts, 'thread-2').text, 'Second draft')
})

test('sending clears only the active thread draft', () => {
  const drafts = {}
  ensureComposerDraft(drafts, 'thread-1').text = 'Send me'
  ensureComposerDraft(drafts, 'thread-2').text = 'Keep me'

  clearComposerDraft(drafts, 'thread-1')

  assert.equal(ensureComposerDraft(drafts, 'thread-1').text, '')
  assert.equal(ensureComposerDraft(drafts, 'thread-2').text, 'Keep me')
})

test('a newly created reactive draft enables submit when text changes', async () => {
  const drafts = reactive({})
  const activeDraft = computed(() => ensureComposerDraft(drafts, '__new-thread__'))
  const canSubmit = computed(() => activeDraft.value.text.trim().length > 0)

  assert.equal(canSubmit.value, false)

  activeDraft.value.text = 'Ready to send'
  await nextTick()

  assert.equal(canSubmit.value, true)
})

test('a newly created Pinia draft enables submit when text changes', async () => {
  const { useComposerDraftStore } = await loadComposerDraftStore()
  const store = useComposerDraftStore(createPinia())
  const firstDraft = store.draftFor('__new-thread__')

  assert.equal(isReactive(firstDraft), true)

  const activeDraft = computed(() => store.draftFor('__new-thread__'))
  const annotations = computed(() => activeDraft.value.responseTextAnnotations)
  const draftText = computed({
    get: () => activeDraft.value.text,
    set: (value) => { activeDraft.value.text = value },
  })
  const canSubmit = computed(() => draftText.value.trim().length > 0)

  assert.equal(annotations.value.length, 0)
  assert.equal(canSubmit.value, false)

  draftText.value = 'Ready to send'
  await nextTick()

  assert.equal(canSubmit.value, true)
})

test('annotation comments remain part of their thread draft', () => {
  const drafts = {}
  ensureComposerDraft(drafts, 'thread-1').responseTextAnnotations.push({
    id: 'annotation-1',
    text: 'Selected response',
  })

  updateComposerResponseAnnotation(drafts, 'thread-1', 'annotation-1', '  Updated note  ')

  assert.equal(
    ensureComposerDraft(drafts, 'thread-1').responseTextAnnotations[0].annotation,
    'Updated note',
  )
})

test('Pinia composer drafts stay memory-only', async () => {
  const storeSource = await readFile(storeSourceUrl, 'utf8')
  assert.doesNotMatch(storeSource, /localStorage|sessionStorage|persist/iu)
})
