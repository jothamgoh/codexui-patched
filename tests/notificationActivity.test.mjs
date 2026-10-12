import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

async function loadModule(path) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

const { selectNotificationActivity, isThreadInBackground, isThreadRunning } = await loadModule('../src/utils/notificationActivity.ts')
const { legacyPanelSelection } = await loadModule('./fixtures/legacyNotificationPanel.ts')
const panelSource = await readFile(new URL('../src/components/content/NotificationSettingsButton.vue', import.meta.url), 'utf8')

const minutesAgo = (minutes) => new Date(Date.UTC(2026, 9, 11, 12, 0, 0) - minutes * 60_000).toISOString()

function thread(id, overrides = {}) {
  return {
    id,
    title: `Chat ${id}`,
    projectName: 'demo-app',
    cwd: '/work/demo-app',
    hasWorktree: false,
    createdAtIso: minutesAgo(600),
    updatedAtIso: minutesAgo(30),
    preview: `Preview for ${id}`,
    unread: false,
    inProgress: false,
    ...overrides,
  }
}

function historyItem(id, threadId, overrides = {}) {
  return { id, threadId, turnId: `turn-${id}`, status: 'completed', title: `History ${id}`, body: `**Done** with ${id}`, completedAt: minutesAgo(20), readAt: null, ...overrides }
}

/** Mirrors the panel's own isThreadUnread with manual overrides. */
function unreadWithOverrides(overrides) {
  return (row) => {
    const override = overrides[row.id]
    if (override && override.activityAt === row.updatedAtIso) return override.unread
    return row.unread
  }
}

function projectNew(selection, threads) {
  return {
    activityThreadIds: selection.activityThreads.map((row) => row.id),
    // The question text came after the old panel; it is checked on its own below.
    requestAttention: selection.requestAttention.map(({ detail: _detail, ...item }) => item),
    waitingThreadIds: [...selection.waitingThreadIds],
    boardWorkActivity: selection.boardWorkActivity,
    runningThreadIds: [...selection.runningThreadIds],
    runningThreads: selection.runningThreads.map((row) => row.id),
    runningActivity: selection.runningActivity,
    unreadThreads: selection.unreadThreads.map((row) => row.id),
    visibleHistory: selection.visibleHistory.map((item) => item.id),
    allRecentHistory: selection.allRecentHistory,
    unreadActivity: selection.unreadActivity,
    helpers: threads.map((row) => selection.hasWorkingHelpers(row.id)),
  }
}

function assertSameAsLegacy(fixture, label) {
  const { props, history, dismissed, manualUnread = {} } = fixture
  const legacy = legacyPanelSelection(props, history, dismissed, manualUnread)
  const current = projectNew(selectNotificationActivity({
    ...props,
    history,
    dismissedActivityByThreadId: dismissed,
    isThreadUnread: unreadWithOverrides(manualUnread),
  }), props.threads)
  const { helpers, ...comparable } = current
  const legacyComparable = Object.fromEntries(Object.keys(comparable).map((key) => [key, legacy[key]]))
  assert.deepEqual(comparable, legacyComparable, label)
  assert.equal(helpers.length, props.threads.length)
  return { legacy, current }
}

function richFixture() {
  const threads = [
    thread('lead', { title: 'Payments refactor', updatedAtIso: minutesAgo(5) }),
    thread('helper-running', { title: 'Helper: tests', isInternalSubagent: true, parentThreadId: 'lead', inProgress: true, updatedAtIso: minutesAgo(1) }),
    thread('helper-idle', { title: 'Helper: lint', parentThreadId: 'lead', updatedAtIso: minutesAgo(2), unread: true }),
    thread('running', { title: 'Export job', inProgress: true, updatedAtIso: minutesAgo(3) }),
    thread('background', { title: 'Long build', hasBackgroundTasks: true, updatedAtIso: minutesAgo(8) }),
    thread('unread-a', { title: 'Email bounces', unread: true, updatedAtIso: minutesAgo(12) }),
    thread('unread-b', { title: '  Spaced\n  title  ', unread: true, updatedAtIso: minutesAgo(40) }),
    thread('waiting', { title: 'Needs approval', unread: true, updatedAtIso: minutesAgo(15) }),
    thread('board-lead', { title: 'Board lead', inProgress: true, updatedAtIso: minutesAgo(4) }),
    thread('board-feature', { title: 'Board feature chat', unread: true, updatedAtIso: minutesAgo(6) }),
    thread('recent-a', { title: 'Old docs', updatedAtIso: minutesAgo(90) }),
    thread('recent-b', { title: '', preview: 'Only a preview', updatedAtIso: minutesAgo(120) }),
    thread('dismissed', { title: 'Dismissed chat', updatedAtIso: minutesAgo(50) }),
    thread('manual-read', { title: 'Marked read', unread: true, updatedAtIso: minutesAgo(25) }),
    thread('manual-unread', { title: 'Marked unread', updatedAtIso: minutesAgo(26) }),
    thread('no-time', { title: 'No timestamps', updatedAtIso: '', createdAtIso: '' }),
  ]
  const boardActivity = [
    { boardId: 'b1', featureId: 'f1', threadId: 'board-feature', title: 'Feature one', boardName: 'Board', status: 'running', updatedAtIso: minutesAgo(6), summary: 'Working' },
    { boardId: 'b1', featureId: 'f2', threadId: '', title: 'Feature two', boardName: 'Board', status: 'running', updatedAtIso: minutesAgo(7), summary: '' },
    { boardId: 'b1', featureId: 'f3', threadId: 'gone-thread', title: 'Feature three', boardName: 'Board', status: 'blocked', updatedAtIso: minutesAgo(70), summary: 'Stuck on tests' },
  ]
  const pendingRequests = [
    { id: 1, method: 'item/commandExecution/requestApproval', threadId: 'waiting', receivedAtIso: minutesAgo(14) },
    { id: 2, method: 'item/tool/requestUserInput', threadId: 'waiting', receivedAtIso: minutesAgo(13) },
    { id: 3, method: 'item/tool/requestUserInput', threadId: 'helper-idle', receivedAtIso: minutesAgo(2) },
    { id: 4, method: 'item/tool/requestUserInput', threadId: '', receivedAtIso: minutesAgo(2) },
    { id: 5, method: 'item/fileChange/requestApproval', threadId: 'unknown-thread', receivedAtIso: minutesAgo(1) },
  ]
  const history = [
    historyItem('h-unread-a', 'unread-a', { completedAt: minutesAgo(12) }),
    historyItem('h-recent-a', 'recent-a', { completedAt: minutesAgo(10), readAt: minutesAgo(9) }),
    historyItem('h-helper', 'helper-idle'),
    historyItem('h-board', 'board-lead'),
    historyItem('h-dismissed', 'dismissed', { completedAt: minutesAgo(50) }),
    historyItem('h-running', 'running', { completedAt: minutesAgo(35) }),
    historyItem('h-orphan', 'deleted-thread', { title: '', completedAt: minutesAgo(45) }),
    historyItem('h-failed', 'recent-b', { status: 'failed', completedAt: minutesAgo(60), readAt: minutesAgo(59) }),
    historyItem('h-board-question', 'board:b1', { projectBoard: { id: 'pb1', kind: 'question', boardId: 'b1', featureId: 'f1', questionId: 'q1', occurredAt: minutesAgo(5) }, completedAt: minutesAgo(5) }),
    historyItem('h-board-done', 'board:b1:f3', { status: 'failed', projectBoard: { id: 'pb2', kind: 'completed', boardId: 'b1', featureId: 'f3', threadId: 'gone-thread', occurredAt: minutesAgo(65) }, completedAt: minutesAgo(65) }),
    historyItem('h-native', 'board:b1:f1', { projectBoard: { id: 'pb3', kind: 'native_request', boardId: 'b1', featureId: 'f1', threadId: 'waiting', requestId: 1, occurredAt: minutesAgo(14) }, completedAt: minutesAgo(14) }),
  ]
  return {
    props: {
      threads,
      activeThreadId: '',
      boardThreadIds: ['board-lead'],
      boardActivity,
      boardActivityTitles: { f1: 'Feature one title', b1: 'Board name' },
      threadSources: { 'helper-idle': { isInternalSubagent: true, parentThreadId: 'lead' } },
      pinnedThreadIds: ['recent-a', 'unread-a', 'not-listed'],
      pendingRequests,
      boardAttention: [{ questionId: 'q1', boardId: 'b1', featureId: 'f1', title: 'Pick a color', prompt: 'Which?', createdAtIso: minutesAgo(5) }],
    },
    history,
    dismissed: { dismissed: minutesAgo(50) },
    manualUnread: {
      'manual-read': { unread: false, activityAt: minutesAgo(25) },
      'manual-unread': { unread: true, activityAt: minutesAgo(26) },
    },
  }
}

test('the shared selection matches the old panel logic on a fixture with every kind of chat', () => {
  const { current } = assertSameAsLegacy(richFixture(), 'rich fixture')
  // Spot-check the semantics the voice route relies on, so the fixture really exercises them.
  assert.ok(current.waitingThreadIds.includes('waiting'))
  assert.ok(!current.activityThreadIds.includes('helper-running'), 'helper sub-chats are excluded')
  assert.ok(!current.activityThreadIds.includes('board-lead'), 'board-managed chats are excluded')
  assert.ok(!current.activityThreadIds.includes('board-feature'), 'board activity chats are excluded')
  assert.ok(current.runningThreads.includes('lead'), 'a lead with a running helper counts as running')
  assert.ok(current.runningThreads.includes('background'), 'background work counts as running')
  assert.ok(!current.unreadThreads.includes('waiting'), 'needs-you chats are not also unread')
  assert.ok(current.unreadThreads.includes('manual-unread') && !current.unreadThreads.includes('manual-read'))
  assert.ok(!current.allRecentHistory.some((item) => item.threadId === 'dismissed'), 'dismissed activity is hidden')
  assert.ok(current.allRecentHistory.some((item) => item.threadId === 'deleted-thread'), 'history keeps chats no longer listed')
  assert.ok(!current.allRecentHistory.some((item) => item.threadId === 'recent-a'), 'pinned chats are left out of Recent')
})

test('the shared selection matches the old panel logic on empty and minimal inputs', () => {
  assertSameAsLegacy({ props: { threads: [], activeThreadId: '', boardAttention: [] }, history: [], dismissed: {} }, 'empty')
  assertSameAsLegacy({ props: { threads: [thread('only', { unread: true })], activeThreadId: '', boardAttention: [] }, history: [], dismissed: {} }, 'one unread')
  assertSameAsLegacy({ props: { threads: [thread('only', { inProgress: true })], activeThreadId: '', boardAttention: [] }, history: [], dismissed: {} }, 'one running')
})

test('the shared selection caps recent activity at 30 rows exactly like the panel', () => {
  const threads = Array.from({ length: 45 }, (_, index) => thread(`t${index}`, { updatedAtIso: minutesAgo(index * 3) }))
  const history = Array.from({ length: 30 }, (_, index) => historyItem(`h${index}`, `t${index * 2}`, { completedAt: minutesAgo(index * 3 + 1), readAt: index % 3 ? null : minutesAgo(1) }))
  const { current } = assertSameAsLegacy({ props: { threads, activeThreadId: '', boardAttention: [] }, history, dismissed: { t4: minutesAgo(12) } }, 'cap')
  assert.equal(current.allRecentHistory.length, 30)
})

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('the shared selection matches the old panel logic on 300 random fixtures', () => {
  const random = mulberry32(20261011)
  const pick = (values) => values[Math.floor(random() * values.length)]
  for (let round = 0; round < 300; round += 1) {
    const count = 1 + Math.floor(random() * 14)
    const ids = Array.from({ length: count }, (_, index) => `r${round}-${index}`)
    const threads = ids.map((id, index) => thread(id, {
      unread: random() < 0.4,
      inProgress: random() < 0.2,
      hasBackgroundTasks: random() < 0.1,
      updatedAtIso: random() < 0.05 ? 'not a date' : minutesAgo(Math.floor(random() * 300)),
      title: random() < 0.1 ? '' : `Title ${index}`,
      ...(index > 0 && random() < 0.2 ? { parentThreadId: pick(ids.slice(0, index)), isInternalSubagent: true } : {}),
    }))
    const boardThreadIds = ids.filter(() => random() < 0.1)
    const boardActivity = ids.filter(() => random() < 0.1).map((id, index) => ({
      boardId: 'b', featureId: `f${index}`, threadId: random() < 0.2 ? '' : id, title: `Feature ${index}`, boardName: 'Board',
      status: pick(['running', 'paused', 'blocked', 'review', 'needs_input', 'done', 'backlog']), updatedAtIso: minutesAgo(Math.floor(random() * 300)), summary: random() < 0.5 ? 'Summary' : '',
    }))
    const pendingRequests = ids.filter(() => random() < 0.15).map((id, index) => ({
      id: index + 1, method: pick(['item/commandExecution/requestApproval', 'item/tool/requestUserInput']), threadId: id, receivedAtIso: minutesAgo(index),
    }))
    const history = ids.filter(() => random() < 0.5).map((id, index) => historyItem(`h${round}-${index}`, random() < 0.1 ? `missing-${index}` : id, {
      completedAt: minutesAgo(Math.floor(random() * 300)), readAt: random() < 0.5 ? null : minutesAgo(1), status: pick(['completed', 'failed']),
    }))
    const dismissed = Object.fromEntries(history.filter(() => random() < 0.2).map((item) => [item.threadId, item.completedAt]))
    const boardAttention = boardActivity.filter(() => random() < 0.3).map((item, index) => ({ questionId: `q${index}`, boardId: item.boardId, featureId: item.featureId, title: 'Q', prompt: 'Q?', createdAtIso: minutesAgo(index) }))
    const pinnedThreadIds = ids.filter(() => random() < 0.15)
    const manualUnread = Object.fromEntries(threads.filter(() => random() < 0.1).map((row) => [row.id, { unread: random() < 0.5, activityAt: random() < 0.7 ? row.updatedAtIso : minutesAgo(999) }]))
    assertSameAsLegacy({ props: { threads, activeThreadId: '', boardThreadIds, boardActivity, pendingRequests, boardAttention, boardActivityTitles: {}, pinnedThreadIds }, history, dismissed, manualUnread }, `random round ${round}`)
  }
})

test('the panel reads its sections from the shared selection instead of its own copy', () => {
  assert.match(panelSource, /selectNotificationActivity\(\{/u)
  assert.doesNotMatch(panelSource, /collectThreadHelpers\(/u)
  assert.doesNotMatch(panelSource, /candidates\.sort\(/u)
})

test('a chat whose reply finished but whose background work runs is running, in the background', () => {
  const backgroundOnly = thread('background', { inProgress: false, hasBackgroundTasks: true })
  const replying = thread('replying', { inProgress: true, hasBackgroundTasks: true })
  assert.equal(isThreadRunning(backgroundOnly), true, 'it stays in the running filter and section')
  assert.equal(isThreadInBackground(backgroundOnly), true)
  assert.equal(isThreadInBackground(replying), false, 'a live reply is never shown as background work')
  assert.equal(isThreadInBackground(thread('idle', { inProgress: false })), false)
})

test('a chat waiting for an answer shows the question it asks', () => {
  const selection = selectNotificationActivity({
    threads: [thread('ask', { inProgress: true }), thread('approve', { inProgress: true })],
    boardAttention: [],
    pendingRequests: [
      { id: 5, method: 'item/tool/requestUserInput', threadId: 'ask', receivedAtIso: minutesAgo(1), params: { threadId: 'ask', questions: [{ id: 'q0', question: 'Which cutoff should I use?' }, { id: 'q1', question: 'Keep pinned chats?' }] } },
      { id: 6, method: 'item/commandExecution/requestApproval', threadId: 'approve', receivedAtIso: minutesAgo(2), params: { threadId: 'approve', command: 'rm -rf build' } },
    ],
    history: [],
    dismissedActivityByThreadId: {},
  })
  const byThread = Object.fromEntries(selection.requestAttention.map((item) => [item.threadId, item]))
  assert.equal(byThread.ask.label, 'Answer needed')
  assert.equal(byThread.ask.detail, 'Which cutoff should I use? (+1 more question)')
  assert.equal(byThread.approve.label, 'Approval needed')
  assert.equal(byThread.approve.detail, '', 'an approval never shows its command line')
})
