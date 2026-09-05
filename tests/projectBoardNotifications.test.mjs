import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
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
const utilityModuleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`

async function importModule(path, replacements = []) {
  let text = await readFile(new URL(path, import.meta.url), 'utf8')
  for (const [from, to] of replacements) text = text.replaceAll(from, to)
  const result = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(result).toString('base64')}`)
}

const { collectProjectBoardNotifications, projectBoardThreadIds } = await importModule('../src/server/projectBoardNotificationEvents.ts')

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

test('notifies authoritative board outcomes, not successful intermediate lead turns', () => {
  const initial = {
    boards: [{ id: 'board', planningThreadId: 'planner' }],
    cards: [{ id: 'feature', boardId: 'board', type: 'feature', status: 'working', threadId: 'lead' }],
    runs: [{ id: 'run', boardId: 'board', cardId: 'feature', kind: 'execute', status: 'running', threadId: 'lead' }],
    questions: [],
    updatedAtIso: '2026-09-06T01:00:00Z',
  }
  const paused = { ...initial, runs: [{ ...initial.runs[0], status: 'succeeded' }] }
  assert.deepEqual(collectProjectBoardNotifications(initial, paused), [])
  const question = { id: 'question', boardId: 'board', cardId: 'feature', status: 'open', createdAtIso: initial.updatedAtIso, prompt: 'PRIVATE' }
  const waiting = { ...paused, questions: [question] }
  const [questionEvent] = collectProjectBoardNotifications(paused, waiting)
  assert.equal(questionEvent.kind, 'question')
  assert.equal(questionEvent.featureId, 'feature')
  assert.equal(JSON.stringify(questionEvent).includes('PRIVATE'), false)
  assert.deepEqual(collectProjectBoardNotifications(waiting, waiting), [])
  const finished = { ...waiting, cards: [{ ...initial.cards[0], status: 'done', completedAtIso: initial.updatedAtIso }] }
  assert.deepEqual(collectProjectBoardNotifications(waiting, finished).map((event) => event.kind), ['completed'])
  const failed = { ...initial, runs: [{ ...initial.runs[0], status: 'interrupted', error: 'PRIVATE error' }] }
  assert.deepEqual(collectProjectBoardNotifications(initial, failed).map((event) => event.kind), ['failed'])
  const planned = { ...initial, runs: [{ id: 'plan', boardId: 'board', cardId: '', kind: 'board_plan', status: 'succeeded', threadId: 'planner' }] }
  assert.deepEqual(collectProjectBoardNotifications(initial, planned).map((event) => event.kind), ['plan_ready'])
  assert.deepEqual([...projectBoardThreadIds(initial)].sort(), ['lead', 'planner'])
})

test('board delivery reuses the durable inbox and device/Telegram preferences with redacted exact links', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'codexui-board-notifications-'))
  const previousFetch = globalThis.fetch
  const envNames = ['CODEX_HOME', 'CODEXUI_WEB_PUSH_STATE_FILE', 'CODEXUI_WEB_PUSH_PUBLIC_KEY', 'CODEXUI_WEB_PUSH_PRIVATE_KEY', 'CODEXUI_TELEGRAM_BOT_TOKEN', 'CODEXUI_TELEGRAM_CHAT_ID', 'CODEXUI_PUBLIC_BASE_URL', 'CODEXUI_TELEGRAM_NOTIFICATIONS']
  const previousEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]))
  t.after(async () => {
    globalThis.fetch = previousFetch
    delete globalThis.__boardPushDeliveries
    for (const key of envNames) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    await rm(temporary, { recursive: true, force: true })
  })
  const stateFile = join(temporary, 'push.json')
  const isolatedHome = join(temporary, 'isolated-codex')
  const hostHome = join(temporary, '.codex')
  await mkdir(isolatedHome)
  await mkdir(hostHome)
  Object.assign(process.env, {
    CODEX_HOME: isolatedHome,
    CODEXUI_WEB_PUSH_STATE_FILE: stateFile,
    CODEXUI_WEB_PUSH_PUBLIC_KEY: '',
    CODEXUI_WEB_PUSH_PRIVATE_KEY: '',
    CODEXUI_TELEGRAM_BOT_TOKEN: 'test-token',
    CODEXUI_TELEGRAM_CHAT_ID: 'test-chat',
    CODEXUI_PUBLIC_BASE_URL: 'https://example.test',
    CODEXUI_TELEGRAM_NOTIFICATIONS: 'true',
  })
  await writeFile(stateFile, JSON.stringify({
    vapid: { publicKey: 'test-public', privateKey: 'test-private' },
    subscriptions: ['always', 'unfocused'].map((mode) => ({
      subscription: { endpoint: `https://push.example.test/${mode}`, keys: { p256dh: 'test', auth: 'test' } },
      mode,
    })),
    history: [],
    dismissals: [],
  }))
  globalThis.__boardPushDeliveries = []
  const pushStub = `data:text/javascript,${encodeURIComponent('export default { generateVAPIDKeys() { throw new Error("unexpected key generation") }, async sendNotification(subscription, payload) { globalThis.__boardPushDeliveries.push({ subscription, payload: JSON.parse(payload) }); } }')}`
  const require = createRequire(import.meta.url)
  let textSource = await readFile(new URL('../src/utils/notificationText.ts', import.meta.url), 'utf8')
  textSource = textSource.replace("'markdown-it'", JSON.stringify(pathToFileURL(require.resolve('markdown-it')).href))
  const textModule = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(textSource, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`
  const osStub = `data:text/javascript,${encodeURIComponent(`export const homedir = () => ${JSON.stringify(temporary)}`)}`
  const { createWebPushTurnNotifier } = await importModule('../src/server/webPushTurnNotifier.ts', [
    ["'web-push'", JSON.stringify(pushStub)],
    ["'node:os'", JSON.stringify(osStub)],
    ['../utils/notificationText', textModule],
    ['../utils/projectBoardNotifications', utilityModuleUrl],
  ])
  const event = { id: 'project-board-question:q / 1', kind: 'question', boardId: 'b / 1', featureId: 'f-1', cardId: 'f-1', questionId: 'q / 1', occurredAt: '2026-09-06T01:00:00Z' }
  const notifier = createWebPushTurnNotifier()
  assert.equal(await notifier.handleProjectBoardNotification(event), true)
  assert.equal(await notifier.handleProjectBoardNotification(event), false)
  assert.equal(globalThis.__boardPushDeliveries.length, 2)
  for (const { payload } of globalThis.__boardPushDeliveries) {
    assert.equal(payload.url, '/#/board/b%20%2F%201?feature=f-1&question=q+%2F+1')
    assert.equal(payload.tag, event.id)
    assert.equal(payload.body, 'Open the project board to answer a question.')
  }
  assert.deepEqual(globalThis.__boardPushDeliveries.map(({ payload }) => payload.mode).sort(), ['always', 'unfocused'])
  const stored = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(stored.history.length, 1)
  assert.equal(stored.history[0].projectBoard.questionId, event.questionId)
  const restarted = createWebPushTurnNotifier()
  assert.equal(await restarted.handleProjectBoardNotification(event), false)
  assert.equal(globalThis.__boardPushDeliveries.length, 2)
  await restarted.resolveProjectBoardQuestions([event.questionId], '2026-09-06T02:00:00Z')
  const resolved = JSON.parse(await readFile(stateFile, 'utf8')).history[0]
  assert.equal(resolved.status, 'answered')
  assert.equal(resolved.readAt, '2026-09-06T02:00:00Z')
  assert.equal(globalThis.__boardPushDeliveries.length, 2)

  const telegramSent = []
  globalThis.fetch = async (_url, options) => { telegramSent.push(JSON.parse(options.body)); return { ok: true } }
  const { createTelegramTurnNotifier } = await importModule('../src/server/telegramTurnNotifier.ts', [
    ["'node:os'", JSON.stringify(osStub)],
    ['../utils/projectBoardNotifications', utilityModuleUrl],
  ])
  const telegram = createTelegramTurnNotifier()
  telegram.handleProjectBoardNotification(event)
  telegram.handleProjectBoardNotification(event)
  assert.equal(telegramSent.length, 1)
  assert.match(telegramSent[0].text, /https:\/\/example\.test\/#\/board\/b%20%2F%201\?feature=f-1&question=q\+%2F\+1/u)
  process.env.CODEXUI_TELEGRAM_NOTIFICATIONS = 'false'
  createTelegramTurnNotifier().handleProjectBoardNotification({ ...event, id: 'other' })
  assert.equal(telegramSent.length, 1)

  // A separate CODEX_HOME must never inherit the host's subscribers or preferences.
  const hostPush = JSON.stringify(stored)
  await writeFile(join(hostHome, 'codexui-web-push.json'), hostPush)
  await writeFile(join(isolatedHome, 'codexui-web-push.json'), JSON.stringify({ ...stored, subscriptions: [], history: [] }))
  process.env.CODEXUI_WEB_PUSH_STATE_FILE = ''
  const isolatedPush = createWebPushTurnNotifier()
  await isolatedPush.handleProjectBoardNotification({ ...event, id: 'isolated-run' })
  assert.equal(globalThis.__boardPushDeliveries.length, 2)
  assert.equal(await readFile(join(hostHome, 'codexui-web-push.json'), 'utf8'), hostPush)
  assert.equal(JSON.parse(await readFile(join(isolatedHome, 'codexui-web-push.json'), 'utf8')).history[0].id, 'isolated-run')
  await writeFile(join(hostHome, 'codexui-telegram-notifications.json'), JSON.stringify({ enabled: true }))
  await writeFile(join(isolatedHome, 'codexui-telegram-notifications.json'), JSON.stringify({ enabled: false }))
  process.env.CODEXUI_TELEGRAM_NOTIFICATIONS = 'true'
  const isolatedTelegram = createTelegramTurnNotifier()
  assert.equal(isolatedTelegram.enabled, false)
  isolatedTelegram.handleProjectBoardNotification({ ...event, id: 'isolated-run' })
  assert.equal(telegramSent.length, 1)
})
