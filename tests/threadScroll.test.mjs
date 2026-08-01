import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const sourceUrl = new URL('../src/utils/threadScroll.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
const {
  shouldFollowConversationBottom,
  shouldForceThreadOpenToBottom,
} = await import(moduleUrl)

test('an existing thread opens at the bottom after its messages finish loading', () => {
  assert.equal(shouldForceThreadOpenToBottom('thread-1', true), false)
  assert.equal(shouldForceThreadOpenToBottom('thread-1', false), true)
  assert.equal(shouldForceThreadOpenToBottom('', false), false)
})

test('content follows the bottom until the user deliberately scrolls away', () => {
  assert.equal(shouldFollowConversationBottom(false), true)
  assert.equal(shouldFollowConversationBottom(true), false)
})
