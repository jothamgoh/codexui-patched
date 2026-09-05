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
  showProjectBoardNotification,
  projectBoardNotificationDeepLink,
  projectBoardNotificationScope,
  projectBoardBatchCompletedNotification,
  isProjectBoardNotification,
  projectBoardNativeRequestNotification,
  projectBoardNotificationCopy,
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
const { collectProjectBoardActivity } = await importModule('../src/utils/projectBoardActivity.ts')

test('board activity shows an unlisted Lead and planning run once, preserving exact navigation context', () => {
  const snapshot = {
    boards: [{ id: 'board', name: 'Product fixes', planningThreadId: 'planning-chat' }],
    cards: [
      { id: 'feature', boardId: 'board', type: 'feature', title: 'Fix message rendering', status: 'working', threadId: '', lastRunId: 'run', updatedAtIso: '2026-09-07T01:00:00Z' },
      { id: 'task', parentCardId: 'feature', boardId: 'board', type: 'task', title: 'Internal implementation', status: 'working', threadId: 'child' },
    ],
    runs: [
      { id: 'run', boardId: 'board', cardId: 'feature', kind: 'execute', status: 'running', threadId: 'unlisted-lead' },
      { id: 'planning-run', boardId: 'board', cardId: '', kind: 'board_plan', status: 'queued', threadId: 'planning-chat' },
    ],
  }
  const running = collectProjectBoardActivity(snapshot)
  assert.deepEqual(running.map(({ featureId, threadId, status }) => ({ featureId, threadId, status })), [
    { featureId: 'feature', threadId: 'unlisted-lead', status: 'running' },
    { featureId: '', threadId: 'planning-chat', status: 'running' },
  ])
  assert.equal(running[0].title, 'Fix message rendering')
  snapshot.cards[0].status = 'needs_input'
  assert.equal(collectProjectBoardActivity(snapshot)[0].status, 'needs_input', 'Waiting questions belong in Needs you, not duplicated in Running')
  snapshot.cards[0].status = 'working'
  snapshot.runs[0].status = 'interrupted'
  snapshot.runs[0].error = 'The server restarted'
  snapshot.runs[1].status = 'succeeded'
  const stopped = collectProjectBoardActivity(snapshot)
  assert.equal(stopped.length, 2)
  assert.equal(stopped[1].status, 'review')
  assert.equal(stopped[1].threadId, 'planning-chat', 'Completed planning chats remain linked in the project')
  assert.equal(stopped[0].status, 'paused')
  assert.equal(stopped[0].summary, 'The server restarted')
})

const attention = {
  boardId: 'board / one',
  featureId: 'feature-1',
  cardId: 'task-1',
  questionId: 'question-1',
  title: 'Secret feature title',
  message: 'Secret question body',
}

test('native board approvals and questions use redacted stable Lead links and exclude child chats', () => {
  const snapshot = { boards: [{ id: 'board', planningThreadId: 'planner' }], cards: [{ id: 'feature', boardId: 'board', type: 'feature', threadId: 'lead' }, { id: 'task', boardId: 'board', type: 'task', threadId: 'child' }] }
  const request = { id: 51, method: 'item/commandExecution/requestApproval', params: { threadId: 'lead', turnId: 'turn-1', command: 'PRIVATE command', reason: 'PRIVATE context' } }
  const event = projectBoardNativeRequestNotification(snapshot, request, '2026-09-07T01:00:00Z')
  assert.equal(isProjectBoardNotification(event), true)
  assert.equal(event.requestKind, 'approval')
  assert.equal(JSON.stringify(event).includes('PRIVATE'), false)
  assert.equal(projectBoardNotificationCopy(event).title, 'Lead needs your approval')
  assert.equal(projectBoardNotificationDeepLink(event), '#/thread/lead?board=board&feature=feature')
  assert.notEqual(projectBoardNativeRequestNotification(snapshot, { ...request, params: { ...request.params, turnId: 'turn-2' } }, event.occurredAt).id, event.id)
  const question = projectBoardNativeRequestNotification(snapshot, { ...request, method: 'item/tool/requestUserInput', params: { ...request.params, threadId: 'planner' } }, event.occurredAt)
  assert.equal(question.featureId, '')
  assert.equal(question.requestKind, 'question')
  assert.equal(projectBoardNotificationCopy(question).title, 'Lead needs your input')
  for (const threadId of ['ordinary-chat', 'child']) assert.equal(projectBoardNativeRequestNotification(snapshot, { ...request, params: { ...request.params, threadId } }, event.occurredAt), null)
  assert.equal(projectBoardNativeRequestNotification(snapshot, { ...request, method: 'item/tool/call' }, event.occurredAt), null)
})

test('builds an exact Needs You deep link and deduplicates question events', () => {
  assert.equal(
    projectBoardNeedsInputDeepLink(attention),
    '#/board/board%20%2F%20one?feature=feature-1&question=question-1',
  )
  const seen = new Set()
  assert.equal(markProjectBoardAttentionSeen(seen, attention.questionId), true)
  assert.equal(markProjectBoardAttentionSeen(seen, attention.questionId), false)
  assert.equal(markProjectBoardAttentionSeen(seen, ''), false)
  assert.equal(projectBoardNotificationDeepLink({ ...attention, kind: 'completed', questionId: undefined, threadId: 'lead / one' }), '#/thread/lead%20%2F%20one?board=board+%2F+one&feature=feature-1')
  const batch = projectBoardBatchCompletedNotification('board / one', 'queue-1', '2026-09-07T01:00:00Z')
  assert.equal(isProjectBoardNotification(batch), true)
  assert.equal(isProjectBoardNotification({ ...batch, queueId: undefined }), false)
  assert.equal(projectBoardNotificationDeepLink(batch), '#/board/board%20%2F%20one')
  assert.equal(projectBoardNotificationScope(batch), 'project-board:board / one:batch:queue-1')
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
  assert.equal(showProjectBoardNotification({ kind: 'completed', quiet: true }), null)
  assert.equal(created.length, 1, 'Quiet queue feature outcomes must not create a browser banner')
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
  assert.equal(collectProjectBoardNotifications(waiting, finished)[0].threadId, 'lead')
  const queued = { ...waiting, queues: [{ boardId: 'board', status: 'running', featureIds: ['feature'] }] }
  assert.equal(collectProjectBoardNotifications(queued, finished)[0].quiet, true, 'Last selected feature is still quiet after its queue disappears')
  const userStopped = { ...initial, runs: [{ ...initial.runs[0], status: 'interrupted', stoppedByUser: true }] }
  assert.equal(collectProjectBoardNotifications(initial, userStopped)[0].quiet, true, 'User Stop stays in Activity without an unsolicited device alert')
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
  const quietOutcome = { ...event, id: 'quiet-completed', kind: 'completed', questionId: undefined, threadId: 'lead', quiet: true }
  assert.equal(await restarted.handleProjectBoardNotification(quietOutcome), true)
  assert.equal(globalThis.__boardPushDeliveries.length, 2)
  const quietStored = JSON.parse(await readFile(stateFile, 'utf8')).history[0]
  assert.equal(quietStored.projectBoard.quiet, true)
  assert.equal(quietStored.projectBoard.threadId, 'lead')
  assert.equal(await createWebPushTurnNotifier().handleProjectBoardNotification(quietOutcome), false, 'Quiet history remains deduplicated after restart')

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

  // Native approval alerts use the same enrolled-device sink and survive reload.
  process.env.CODEXUI_WEB_PUSH_STATE_FILE = stateFile
  const nativePush = createWebPushTurnNotifier()
  const nativeEvent = { id: 'project-board-native:lead:turn:51', kind: 'native_request', boardId: 'board', featureId: 'feature', cardId: 'feature', threadId: 'lead', requestId: 51, requestKind: 'approval', occurredAt: '2026-09-07T01:00:00Z' }
  const sentBefore = globalThis.__boardPushDeliveries.length
  assert.equal(await nativePush.handleProjectBoardNotification(nativeEvent), true)
  await new Promise(setImmediate)
  assert.equal(globalThis.__boardPushDeliveries.length, sentBefore + 2)
  assert.deepEqual(globalThis.__boardPushDeliveries.slice(-2).map(({ payload }) => [payload.title, payload.body, payload.url]), Array(2).fill(['Lead needs your approval', 'Open the Lead chat to review the request and continue.', '/#/thread/lead?board=board&feature=feature']))
  assert.equal(await createWebPushTurnNotifier().handleProjectBoardNotification(nativeEvent), false)
  await nativePush.syncProjectBoardNativeRequests([nativeEvent.id], '2026-09-07T01:01:00Z')
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).history[0].readAt, null)
  await nativePush.syncProjectBoardNativeRequests([], '2026-09-07T01:02:00Z')
  const resolvedNative = JSON.parse(await readFile(stateFile, 'utf8')).history[0]
  assert.equal(resolvedNative.status, 'resolved')
  assert.equal(resolvedNative.readAt, '2026-09-07T01:02:00Z')
  assert.equal(resolvedNative.projectBoard.requestId, 51)
  assert.equal(globalThis.__boardPushDeliveries.length, sentBefore + 2, 'Resolving a native request must not send another device notification')
})
