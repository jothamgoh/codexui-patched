import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const cache = new URL('../node_modules/.cache/', import.meta.url).pathname
await mkdir(cache, { recursive: true })
const directory = await mkdtemp(join(cache, 'restart-resume-test-'))
test.after(() => rm(directory, { recursive: true, force: true }))
const outfile = join(directory, 'restartResume.mjs')
await build({ entryPoints: [new URL('../src/server/restartResume.ts', import.meta.url).pathname], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { ActiveTurnTracker, RESTART_CONTINUE_TEXT, continueInterruptedTurns, recordInterruptedTurns, takeInterruptedTurns } = await import(pathToFileURL(outfile).href)

test('tracks replies this server runs, not Claude sessions active in other apps', () => {
  const tracker = new ActiveTurnTracker()
  tracker.observe({ method: 'turn/started', params: { threadId: 'codex-1', turn: { id: 't1' } } })
  tracker.observe({ method: 'turn/started', params: { threadId: 'claude-a', turn: { id: 't2' } } })
  tracker.observe({ method: 'thread/status/changed', params: { threadId: 'claude-terminal', status: { type: 'active' } } })
  tracker.observe({ method: 'turn/completed', params: { threadId: 'codex-1', turn: { id: 't1' } } })
  tracker.observe({ method: 'item/agentMessage/delta', params: { threadId: 'other' } })
  assert.deepEqual(tracker.threadIds(), ['claude-a'])
})

test('a chat whose reply ended while background tasks run is still interrupted by a restart', () => {
  const tracker = new ActiveTurnTracker()
  tracker.observe({ method: 'turn/started', params: { threadId: 'claude-bg', turn: { id: 't1' } } })
  tracker.observe({ method: 'thread/backgroundTasks/updated', params: { threadId: 'claude-bg', tasks: [{ id: 'b1', type: 'local_bash', description: 'npm run build' }] } })
  tracker.observe({ method: 'turn/completed', params: { threadId: 'claude-bg', turn: { id: 't1' } } })
  assert.deepEqual(tracker.threadIds(), ['claude-bg'])
  tracker.observe({ method: 'thread/backgroundTasks/updated', params: { threadId: 'claude-bg', tasks: [] } })
  assert.deepEqual(tracker.threadIds(), [])
})

test('an interruption record is continued once, and never when stale', async () => {
  const path = join(directory, 'interrupted.json')
  recordInterruptedTurns(path, ['claude-a', 'codex-1', 'claude-a'], 1_000)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(takeInterruptedTurns(path, 2_000), ['claude-a', 'codex-1'])
  assert.deepEqual(takeInterruptedTurns(path, 2_000), [], 'the record is consumed')

  recordInterruptedTurns(path, ['claude-a'], 0)
  assert.deepEqual(takeInterruptedTurns(path, 11 * 60_000), [], 'a stop long ago is not a restart')

  recordInterruptedTurns(path, ['claude-a'], 0)
  recordInterruptedTurns(path, [], 0)
  assert.deepEqual(takeInterruptedTurns(path, 1), [], 'a clean shutdown clears an older record')
})

test('continues direct chats only, and one failure does not stop the rest', async () => {
  const calls = []
  const rpc = async (method, params) => {
    calls.push([method, params.threadId])
    if (method === 'thread/resume' && params.threadId === 'helper') return { thread: { id: 'helper', source: { subagent: { thread_spawn: { parent_thread_id: 'codex-1' } } } } }
    if (method === 'thread/resume' && params.threadId === 'broken') throw new Error('gone')
    if (method === 'turn/start') assert.deepEqual(params.input, [{ type: 'text', text: RESTART_CONTINUE_TEXT }])
    return { thread: { id: params.threadId, source: 'cli' } }
  }
  const result = await continueInterruptedTurns(['claude-a', 'board-lead', 'helper', 'broken', 'codex-1'], rpc, async (id) => id === 'board-lead')
  assert.deepEqual(result, { continued: ['claude-a', 'codex-1'], skipped: ['board-lead', 'helper'], failed: ['broken'] })
  assert.deepEqual(calls.filter(([method]) => method === 'turn/start').map(([, id]) => id), ['claude-a', 'codex-1'])
})
