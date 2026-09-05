import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function importTypeScriptModule(path, replacements = []) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8')
  for (const [search, replacement] of replacements) {
    source = source.replaceAll(search, replacement)
  }
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const threadSource = await readFile(
  new URL('../src/utils/codexThreadSource.ts', import.meta.url),
  'utf8',
)
const compiledThreadSource = ts.transpileModule(threadSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const threadSourceModuleUrl = `data:text/javascript;base64,${Buffer.from(compiledThreadSource).toString('base64')}`
const boardEventSource = await readFile(new URL('../src/server/projectBoardNotificationEvents.ts', import.meta.url), 'utf8')
const boardEventModuleUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(boardEventSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`
const { createTurnNotificationRouter } = await importTypeScriptModule(
  '../src/server/turnNotificationRouter.ts',
  [['../utils/codexThreadSource.js', threadSourceModuleUrl], ['./projectBoardNotificationEvents.js', boardEventModuleUrl]],
)

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function createHarness({
  readThread,
  listThreads = async () => ({ data: [], nextCursor: null }),
  threadLookupTimeoutMs = 40,
  backfillRequestTimeoutMs = 40,
  readProjectBoards,
}) {
  let listener = null
  const telegram = []
  const webPush = []
  const removedHistory = []
  const boardPush = []
  const boardTelegram = []
  const boardPublished = []
  const bridge = {
    listThreads,
    readThread,
    readProjectBoards,
    publishLocalNotification(method, params) { boardPublished.push({ method, params }) },
    subscribeNotifications(nextListener) {
      listener = nextListener
      return () => { listener = null }
    },
  }
  const router = createTurnNotificationRouter({
    bridge,
    telegramTurnNotifier: {
      handleNotification(notification) { telegram.push(notification) },
      handleProjectBoardNotification(event) { boardTelegram.push(event) },
    },
    webPushTurnNotifier: {
      handleNotification(notification) { webPush.push(notification) },
      async handleProjectBoardNotification(event) { boardPush.push(event); return true },
      async removeThreadHistory(threadIds) {
        removedHistory.push([...threadIds])
      },
    },
    threadLookupTimeoutMs,
    backfillRequestTimeoutMs,
  })

  return {
    emit(notification) { listener?.(notification) },
    removedHistory,
    router,
    telegram,
    webPush,
    boardPush,
    boardTelegram,
    boardPublished,
  }
}

function completedNotification(threadId, turnId = 'turn-1') {
  return {
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status: 'completed' } },
    atIso: '2026-08-08T09:00:00.000Z',
  }
}

test('delivers an off-page interactive completion after authoritative lookup', async () => {
  const harness = createHarness({
    readThread: async (threadId) => ({ thread: { id: threadId, source: 'cli' } }),
  })

  harness.emit(completedNotification('off-page-interactive'))
  await delay(15)

  assert.equal(harness.telegram.length, 1)
  assert.equal(harness.webPush.length, 1)
  harness.router.dispose()
})

test('suppresses a newly spawned child completion even without thread-started', async () => {
  const harness = createHarness({
    readThread: async (threadId) => ({
      thread: {
        id: threadId,
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: 'parent-thread', depth: 2 },
          },
        },
      },
    }),
  })

  harness.emit(completedNotification('new-child'))
  await delay(15)

  assert.equal(harness.telegram.length, 0)
  assert.equal(harness.webPush.length, 0)
  assert.ok(harness.removedHistory.some((threadIds) => threadIds.includes('new-child')))
  harness.router.dispose()
})

test('fails open after a bounded source lookup timeout', async () => {
  const harness = createHarness({
    readThread: async () => await new Promise(() => {}),
    threadLookupTimeoutMs: 10,
  })

  harness.emit(completedNotification('temporarily-unreadable-thread'))
  await delay(25)

  assert.equal(harness.telegram.length, 1)
  assert.equal(harness.webPush.length, 1)
  harness.router.dispose()
})

test('does not gate completions on a stalled startup backfill', async () => {
  const harness = createHarness({
    listThreads: async () => await new Promise(() => {}),
    readThread: async (threadId) => ({ thread: { id: threadId, source: 'appServer' } }),
    backfillRequestTimeoutMs: 10,
  })

  harness.emit(completedNotification('interactive-during-backfill'))
  await delay(15)

  assert.equal(harness.telegram.length, 1)
  assert.equal(harness.webPush.length, 1)
  harness.router.dispose()
})

test('production and Vite dev servers share the notification router', async () => {
  const [httpServerSource, viteConfigSource] = await Promise.all([
    readFile(new URL('../src/server/httpServer.ts', import.meta.url), 'utf8'),
    readFile(new URL('../vite.config.ts', import.meta.url), 'utf8'),
  ])

  assert.match(httpServerSource, /createTurnNotificationRouter\(\{/u)
  assert.match(viteConfigSource, /createTurnNotificationRouter\(\{/u)
  assert.doesNotMatch(viteConfigSource, /webPushTurnNotifier\.handleNotification\(notification\)/u)
})

test('routes committed board outcomes once and suppresses Lead and planner turn spam', async () => {
  const baseline = {
    version: 1,
    boards: [{ id: 'board', planningThreadId: 'planner' }],
    cards: [{ id: 'feature', type: 'feature', boardId: 'board', status: 'working', threadId: 'lead' }],
    runs: [], questions: [], updatedAtIso: '2026-09-06T01:00:00Z',
  }
  const harness = createHarness({
    readThread: async (id) => ({ thread: { id, source: 'appServer' } }),
    readProjectBoards: async () => baseline,
  })
  harness.emit(completedNotification('lead'))
  harness.emit(completedNotification('planner'))
  const next = { ...baseline, version: 2, questions: [{ id: 'q', cardId: 'feature', boardId: 'board', status: 'open', createdAtIso: baseline.updatedAtIso }] }
  harness.emit({ method: 'codexui/projectBoards/updated', params: next })
  harness.emit({ method: 'codexui/projectBoards/updated', params: next })
  await delay(15)
  assert.equal(harness.telegram.length, 0)
  assert.equal(harness.webPush.length, 0)
  assert.equal(harness.boardPush.length, 1)
  assert.equal(harness.boardTelegram.length, 1)
  assert.equal(harness.boardPublished[0].method, 'codexui/projectBoards/notification')
  assert.equal(harness.boardPublished[0].params.questionId, 'q')
  harness.router.dispose()
})
