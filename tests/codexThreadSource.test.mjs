import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const sourceUrl = new URL('../src/utils/codexThreadSource.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
const {
  CODEX_SUBAGENT_SOURCE_KINDS,
  CodexThreadAudienceTracker,
  classifyCodexThreadSource,
  isInternalSubagentThread,
  isSubagentSourceKind,
  loadInternalSubagentThreadIds,
  readCodexNotificationThreadId,
  readCodexThreadAudience,
  readInternalSubagentThreadIdFromNotification,
  readSubagentParentThreadId,
  resolveCodexThreadAudience,
} = await import(moduleUrl)

test('classifies the current v2 spawned-subagent source and reads its parent', () => {
  const thread = {
    id: 'child-thread',
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: 'parent-thread',
          depth: 1,
        },
      },
    },
  }

  assert.deepEqual(classifyCodexThreadSource(thread), {
    kind: 'internalSubagent',
    isInternalSubagent: true,
    parentThreadId: 'parent-thread',
  })
})

test('supports legacy lowercase and camel-case persisted source shapes', () => {
  assert.equal(isInternalSubagentThread({
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: 'legacy-parent',
        },
      },
    },
  }), true)

  assert.equal(readSubagentParentThreadId({
    subAgent: {
      threadSpawn: {
        parentThreadId: 'camel-parent',
      },
    },
  }), 'camel-parent')
})

test('classifies non-spawn subagent modes as internal', () => {
  for (const mode of ['review', 'compact', 'memory_consolidation']) {
    assert.equal(
      isInternalSubagentThread({ source: { subAgent: mode } }),
      true,
      mode,
    )
  }
})

test('recognizes app-server subagent source-kind string variants', () => {
  for (const sourceKind of [
    'subAgent',
    'subAgentReview',
    'subAgentCompact',
    'subAgentThreadSpawn',
    'subAgentOther',
    'subagent_thread_spawn',
    'SUB-AGENT-MEMORY-CONSOLIDATION',
  ]) {
    assert.equal(isSubagentSourceKind(sourceKind), true, sourceKind)
    assert.equal(isInternalSubagentThread(sourceKind), true, sourceKind)
  }
})

test('uses normalized parent-thread markers even when source metadata is absent', () => {
  assert.equal(isInternalSubagentThread({ parentThreadId: 'parent-a' }), true)
  assert.equal(isInternalSubagentThread({ parent_thread_id: 'parent-b' }), true)
  assert.equal(readSubagentParentThreadId({
    source: { parent_thread_id: 'parent-c' },
  }), 'parent-c')
})

test('keeps ordinary and unknown interactive sources visible', () => {
  for (const sourceKind of ['cli', 'vscode', 'exec', 'appServer', 'unknown', 'system']) {
    assert.deepEqual(classifyCodexThreadSource({ source: sourceKind }), {
      kind: 'interactive',
      isInternalSubagent: false,
      parentThreadId: null,
    }, sourceKind)
    assert.equal(readCodexThreadAudience({ source: sourceKind }), 'interactive')
  }

  assert.equal(isInternalSubagentThread(null), false)
  assert.equal(isInternalSubagentThread({}), false)
  assert.equal(readCodexThreadAudience({}), 'unknown')
  assert.equal(isInternalSubagentThread({ source: 'vscode', parentThreadId: '  ' }), false)
})

test('does not infer subagent status from user-visible titles or previews', () => {
  assert.equal(isInternalSubagentThread({
    source: 'vscode',
    title: 'Subagent investigation',
    preview: 'Spawn another worker to help',
  }), false)
})

test('tracks child threads from thread-started notifications without title heuristics', () => {
  const tracker = new CodexThreadAudienceTracker()
  const childStarted = {
    method: 'thread/started',
    params: {
      thread: {
        id: 'child-thread',
        source: { subAgent: 'review' },
      },
    },
  }
  const childCompleted = {
    method: 'turn/completed',
    params: { threadId: 'child-thread', turn: { id: 'turn-1' } },
  }
  const parentCompleted = {
    method: 'turn/completed',
    params: { threadId: 'parent-thread', turn: { id: 'turn-2' } },
  }

  assert.equal(readCodexNotificationThreadId(childStarted), 'child-thread')
  assert.equal(readInternalSubagentThreadIdFromNotification(childStarted), 'child-thread')
  assert.equal(tracker.observeNotification(childStarted), 'internalSubagent')
  assert.equal(tracker.observeNotification(childStarted), 'internalSubagent')
  assert.equal(tracker.observeNotification(childCompleted), 'internalSubagent')
  assert.equal(tracker.observeNotification(parentCompleted), 'unknown')
})

test('authoritatively resolves off-page interactive and child completions', async () => {
  const tracker = new CodexThreadAudienceTracker()
  const reads = []
  const readThread = async (threadId) => {
    reads.push(threadId)
    if (threadId === 'off-page-interactive') {
      return { thread: { id: threadId, source: 'cli' } }
    }
    return {
      thread: {
        id: threadId,
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: 'parent-thread', depth: 1 },
          },
        },
      },
    }
  }

  assert.equal(
    await resolveCodexThreadAudience('off-page-interactive', tracker, readThread),
    'interactive',
  )
  assert.equal(
    await resolveCodexThreadAudience('new-child-without-started-event', tracker, readThread),
    'internalSubagent',
  )
  assert.equal(
    await resolveCodexThreadAudience('off-page-interactive', tracker, readThread),
    'interactive',
  )
  assert.deepEqual(reads, ['off-page-interactive', 'new-child-without-started-event'])
})

test('backfills current and archived subagent thread IDs across paginated lists', async () => {
  const calls = []
  const pages = new Map([
    ['false:', {
      data: [
        { id: 'child-current-1', source: { subAgent: 'compact' } },
        { id: 'interactive-noise', source: 'appServer' },
      ],
      nextCursor: 'page-2',
    }],
    ['false:page-2', {
      data: [{ id: 'child-current-2', source: 'subAgentThreadSpawn' }],
      nextCursor: null,
    }],
    ['true:', {
      data: [{ id: 'child-archived', source: { subagent: 'review' } }],
      nextCursor: null,
    }],
  ])

  const threadIds = await loadInternalSubagentThreadIds(async (params) => {
    calls.push(params)
    return pages.get(`${String(params.archived)}:${params.cursor ?? ''}`)
  })

  assert.deepEqual([...threadIds].sort(), [
    'child-archived',
    'child-current-1',
    'child-current-2',
  ])
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].sourceKinds, [...CODEX_SUBAGENT_SOURCE_KINDS])
  assert.deepEqual(calls.map((call) => call.archived), [false, false, true])
})

test('stops pagination when an app-server cursor repeats', async () => {
  let calls = 0
  const threadIds = await loadInternalSubagentThreadIds(async () => {
    calls += 1
    return {
      data: [{ id: `child-${calls.toString()}`, source: { subAgent: 'other' } }],
      nextCursor: 'stuck',
    }
  })

  assert.equal(calls, 4)
  assert.deepEqual([...threadIds].sort(), ['child-1', 'child-2', 'child-3', 'child-4'])
})
