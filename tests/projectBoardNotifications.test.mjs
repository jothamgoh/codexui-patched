import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const sourceUrl = new URL('../src/utils/projectBoardNotifications.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const {
  markProjectBoardAttentionSeen,
  projectBoardNeedsInputDeepLink,
  showProjectBoardNeedsInputNotification,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const attention = {
  boardId: 'board / one',
  featureId: 'feature-1',
  cardId: 'task-1',
  questionId: 'question-1',
  title: 'Secret feature title',
  message: 'Secret question body',
}

test('builds an exact Needs You deep link and deduplicates question events', () => {
  assert.equal(
    projectBoardNeedsInputDeepLink(attention),
    '#/board/board%20%2F%20one?feature=feature-1&question=question-1',
  )
  const seen = new Set()
  assert.equal(markProjectBoardAttentionSeen(seen, attention.questionId), true)
  assert.equal(markProjectBoardAttentionSeen(seen, attention.questionId), false)
  assert.equal(markProjectBoardAttentionSeen(seen, ''), false)
})

test('does not notify without permission and redacts board content when permitted', (t) => {
  const previousNotification = globalThis.Notification
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  t.after(() => {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: previousNotification })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  })

  const created = []
  class FakeNotification {
    static permission = 'denied'
    constructor(title, options) {
      this.title = title
      this.options = options
      this.onclick = null
      created.push(this)
    }
    close() {}
  }
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FakeNotification })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { visibilityState: 'hidden', hasFocus: () => false },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { focus() {}, location: { hash: '' } },
  })

  const deepLink = projectBoardNeedsInputDeepLink(attention)
  assert.equal(showProjectBoardNeedsInputNotification(attention, deepLink, false), null)
  assert.equal(created.length, 0)

  FakeNotification.permission = 'granted'
  const notification = showProjectBoardNeedsInputNotification(attention, deepLink, false)
  assert.ok(notification)
  assert.equal(notification.title, 'CodexUI needs your input')
  assert.equal(notification.options.body, 'Open the project board to answer a question.')
  assert.equal(notification.options.body.includes(attention.message), false)
  assert.equal(notification.options.body.includes(attention.title), false)
  assert.equal(notification.options.tag, 'project-board-question:question-1')
})
