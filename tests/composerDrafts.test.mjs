import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
