import assert from 'node:assert/strict'
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
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}
const { normalizeSubAgentActivity } = await loadModule('../src/api/subAgentActivity.ts')
const { normalizeThreadMessagesV2 } = await loadModule('../src/api/normalizers/v2.ts')
const base = { id: 'activity-1', type: 'subAgentActivity', agentThreadId: 'child-1', agentPath: '/root/ui_review' }

test('normalizes persisted native and snake case activities with turn order and child identity', () => {
  const messages = normalizeThreadMessagesV2({ thread: { cwd: '/project', turns: [{
    id: 'turn-1', status: 'completed', items: [
      { ...base, kind: 'started' },
      { id: 'activity-2', type: 'sub_agent_activity', kind: 'interacted', agent_thread_id: 'child-1', agent_path: '/root/ui_review' },
    ],
  }] } })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].text, 'Ui review started working')
  assert.equal(messages[0].subAgentActivity.threadId, 'child-1')
  assert.equal(messages[1].text, 'Ui review updated')
  assert.equal(messages[1].turnId, 'turn-1')
  assert.equal(messages[1].orderKey, '000000:000001:000000')
  for (const message of messages) {
    assert.equal(message.isUnhandled, undefined)
    assert.equal(message.rawPayload, undefined)
  }
})

test('agent lifecycle comes from kind even when the activity item and parent turn completed', () => {
  for (const [kind, status, statusLabel] of [
    ['started', 'active', 'Started working'],
    ['interacted', 'updated', 'Updated'],
    ['interrupted', 'interrupted', 'Interrupted'],
    ['completed', 'completed', 'Finished'],
  ]) {
    const message = normalizeSubAgentActivity({ ...base, kind, status: 'completed' })
    assert.equal(message.subAgentActivity.status, status)
    assert.equal(message.subAgentActivity.statusLabel, statusLabel)
  }
})

test('retains explicit agent names and bounded task context without dumping raw payloads', () => {
  const message = normalizeSubAgentActivity({ ...base, kind: 'started', name: 'Ada', prompt: 'Review the mobile UI. '.repeat(100), internal: { secret: 'not for presentation' } })
  assert.equal(message.subAgentActivity.name, 'Ada')
  assert.equal(message.subAgentActivity.task.length, 600)
  assert.match(message.subAgentActivity.task, /…$/u)
  assert.doesNotMatch(JSON.stringify(message), /secret|internal/)
})

test('unknown kinds and incomplete optional data render a bounded neutral fallback', () => {
  for (const kind of ['future-event', 'toString', undefined]) {
    const message = normalizeSubAgentActivity({ id: 'event-1', type: 'subAgentActivity', kind, agentThreadId: {}, agentPath: '/root/' })
    assert.equal(message.text, 'Agent activity')
    assert.deepEqual(message.subAgentActivity, { threadId: null, name: 'Agent', status: 'unknown', statusLabel: 'Activity', task: null })
  }
  assert.equal(normalizeSubAgentActivity({ type: 'agentMessage', id: 'other' }), null)
})
