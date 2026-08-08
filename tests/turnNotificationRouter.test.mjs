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
const { createTurnNotificationRouter } = await importTypeScriptModule(
  '../src/server/turnNotificationRouter.ts',
  [['../utils/codexThreadSource.js', threadSourceModuleUrl]],
)

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function createHarness({
  readThread,
  listThreads = async () => ({ data: [], nextCursor: null }),
  threadLookupTimeoutMs = 40,
  backfillRequestTimeoutMs = 40,
}) {
  let listener = null
  const telegram = []
  const webPush = []
  const removedHistory = []
  const bridge = {
    listThreads,
    readThread,
    subscribeNotifications(nextListener) {
      listener = nextListener
      return () => { listener = null }
    },
  }
  const router = createTurnNotificationRouter({
    bridge,
    telegramTurnNotifier: {
      handleNotification(notification) { telegram.push(notification) },
    },
    webPushTurnNotifier: {
      handleNotification(notification) { webPush.push(notification) },
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
