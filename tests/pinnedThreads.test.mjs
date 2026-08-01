import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const sourceUrl = new URL('../src/utils/pinnedThreads.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
const {
  applyPinnedThreadIntent,
  hasSamePinnedThreadMembership,
  normalizePinnedThreadIds,
} = await import(moduleUrl)

test('normalizes persisted pin IDs without duplicates or blanks', () => {
  assert.deepEqual(
    normalizePinnedThreadIds([' first ', '', 'second', 'first', null]),
    ['first', 'second'],
  )
})

test('pins a thread before the requested existing pin', () => {
  assert.deepEqual(
    applyPinnedThreadIntent(['first', 'second'], {
      threadId: 'new',
      pinned: true,
      beforeThreadId: 'second',
    }),
    ['first', 'new', 'second'],
  )
})

test('unpins only the requested thread', () => {
  assert.deepEqual(
    applyPinnedThreadIntent(['first', 'second', 'third'], {
      threadId: 'second',
      pinned: false,
    }),
    ['first', 'third'],
  )
})

test('rapid pin changes preserve their final optimistic order', () => {
  const afterPin = applyPinnedThreadIntent(['first'], {
    threadId: 'second',
    pinned: true,
    beforeThreadId: 'first',
  })
  const afterUnpin = applyPinnedThreadIntent(afterPin, {
    threadId: 'first',
    pinned: false,
  })
  assert.deepEqual(afterUnpin, ['second'])
})

test('reordering accepts only the existing pinned membership', () => {
  assert.equal(
    hasSamePinnedThreadMembership(['first', 'second'], ['second', 'first']),
    true,
  )
  assert.equal(
    hasSamePinnedThreadMembership(['first', 'second'], ['old', 'first']),
    false,
  )
  assert.equal(
    hasSamePinnedThreadMembership(['first', 'second'], ['first']),
    false,
  )
})
