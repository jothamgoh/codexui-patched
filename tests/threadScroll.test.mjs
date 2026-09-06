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
  didScrollAwayFromConversationBottom,
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

test('turn-end collapse and virtual row measurement do not cancel bottom-follow', () => {
  const before = { scrollTop: 4400, scrollHeight: 5000, clientHeight: 600 }
  // A collapse clamps the scroll position, then late final text adds height.
  const collapsed = { ...before, scrollTop: 3400, scrollHeight: 4000 }
  const finalText = { ...collapsed, scrollHeight: 4600 }
  assert.equal(didScrollAwayFromConversationBottom(before, collapsed), false)
  assert.equal(didScrollAwayFromConversationBottom(collapsed, finalText), false)
  // An estimated history row becomes shorter while the viewport is settling.
  assert.equal(didScrollAwayFromConversationBottom(before, { ...before, scrollTop: 4200, scrollHeight: 4800 }), false)
  // Expanding the viewport clamps scrollTop too, without any row changing size.
  assert.equal(didScrollAwayFromConversationBottom(before, { ...before, scrollTop: 4200, clientHeight: 800 }), false)
  assert.equal(didScrollAwayFromConversationBottom(before, { ...before, scrollTop: 4392, clientHeight: 500 }), false, 'Composer focus can move upward before the viewport resize callback')
})

test('real upward scrolling pauses follow while downward scrolling and initial layout do not', () => {
  const atBottom = { scrollTop: 4400, scrollHeight: 5000, clientHeight: 600 }
  const readingHistory = { ...atBottom, scrollTop: 4100 }
  assert.equal(didScrollAwayFromConversationBottom(atBottom, readingHistory), true)
  assert.equal(didScrollAwayFromConversationBottom(readingHistory, atBottom), false)
  assert.equal(didScrollAwayFromConversationBottom(null, atBottom), false)
  assert.equal(didScrollAwayFromConversationBottom(atBottom, { ...atBottom, scrollTop: 4399.5 }), false)
  assert.equal(didScrollAwayFromConversationBottom(atBottom, { ...readingHistory, scrollHeight: 5100 }), true, 'Scrolling up while new text streams must pause follow')
  assert.equal(didScrollAwayFromConversationBottom(atBottom, { ...readingHistory, scrollHeight: 4800 }), true, 'Movement beyond a layout clamp is still user scrolling')
  assert.equal(didScrollAwayFromConversationBottom({ ...atBottom, scrollTop: 0 }, { ...atBottom, scrollTop: -40 }), false, 'Top overscroll is not movement into older history')
})

test('completion replay keeps final answers after work and summaries inside their own turn', async () => {
  const source = await readFile(new URL('../src/utils/conversationMessages.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022,
  } }).outputText
  const { sortMessagesByOrder, insertTurnSummaryMessages } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`,
  )
  const messages = [
    { id: 'request', role: 'user', text: 'Build it', turnId: 'first', orderKey: '000001:000000' },
    { id: 'answer', role: 'assistant', phase: 'final_answer', text: 'Done', turnId: 'first', orderKey: '000001:000001' },
    { id: 'late-tool', role: 'system', text: 'Tests pass', turnId: 'first', orderKey: '000001:000002' },
    { id: 'next-request', role: 'user', text: 'Next', turnId: 'second', orderKey: '000002:000000' },
    { id: 'comment', role: 'assistant', phase: 'commentary', text: 'Working', turnId: 'second', orderKey: '000002:000001' },
  ]
  const result = insertTurnSummaryMessages(sortMessagesByOrder(messages), [
    { turnId: 'first', durationMs: 62000 }, { turnId: 'second', durationMs: 1000 },
  ])
  assert.deepEqual(result.map((message) => message.id), [
    'request', 'late-tool', 'turn-summary:first', 'answer', 'next-request', 'comment',
  ])
  assert.equal(result[2].text, 'Worked for 1m 2s')
  // The only remembered summary may belong to a turn outside the loaded page.
  assert.deepEqual(insertTurnSummaryMessages(messages, [{ turnId: 'unloaded', durationMs: 1000 }]), messages)
  // Older app-servers have no phase field; retain their final assistant fallback within the turn.
  assert.deepEqual(insertTurnSummaryMessages([
    { ...messages[1], phase: undefined },
  ], [{ turnId: 'first', durationMs: 0 }]).map((message) => message.id), ['turn-summary:first', 'answer'])
  // A late live item can temporarily carry a key beyond the following turn.
  const staleOrder = [messages[1], messages[3], { ...messages[2], orderKey: '000003:000000' }, messages[0]]
  const expected = ['request', 'late-tool', 'answer', 'next-request']
  assert.deepEqual(sortMessagesByOrder(staleOrder).map((message) => message.id), expected)
  assert.deepEqual(sortMessagesByOrder([...staleOrder].reverse()).map((message) => message.id), expected)
})
