import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(sourcePath) {
  let source = await readFile(sourcePath, 'utf8')
  source = source.replace(
    "import rrulePackage from 'rrule'",
    `import rrulePackage from '${import.meta.resolve('rrule')}'`,
  )
  source = source.replace(
    "import { DEFAULT_AUTOMATION_TIME_ZONE } from '../types/automations'",
    "const DEFAULT_AUTOMATION_TIME_ZONE = 'Asia/Singapore'",
  )
  source = source.replaceAll(/import type .*? from .*?\n/gu, '')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const storeSourceUrl = new URL('../src/server/automationStore.ts', import.meta.url)
const { AutomationStore, nextOccurrenceIso } = await loadTypeScriptModule(storeSourceUrl)

test('computes the next RFC 5545 occurrence', () => {
  assert.equal(
    nextOccurrenceIso(
      'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      new Date('2026-07-28T10:00:00.000Z'),
      '2026-07-28T00:00:00.000Z',
    ),
    '2026-07-29T01:00:00.000Z',
  )
})

test('interprets wall-clock schedules in Singapore time', () => {
  assert.equal(
    nextOccurrenceIso(
      'FREQ=DAILY;COUNT=1;BYHOUR=0;BYMINUTE=51',
      new Date('2026-07-28T16:45:06.771Z'),
      '2026-07-28T16:45:06.771Z',
    ),
    '2026-07-28T16:51:06.771Z',
  )
})

test('persists, edits, pauses, and deletes scheduled tasks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'automations.json')
  let now = new Date('2026-07-28T08:00:00.000Z')
  const store = new AutomationStore({ stateFilePath, now: () => now })

  let snapshot = await store.create({
    name: 'Daily status',
    prompt: 'Summarize the project.',
    kind: 'cron',
    cwd: '/tmp/project',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
  })
  const id = snapshot.tasks[0].id
  assert.equal(snapshot.tasks[0].nextRunAtIso, '2026-07-29T01:00:00.000Z')

  now = new Date('2026-07-28T08:05:00.000Z')
  snapshot = await store.update(id, { status: 'PAUSED', name: 'Paused status' })
  assert.equal(snapshot.tasks[0].status, 'PAUSED')
  assert.equal(snapshot.tasks[0].nextRunAtIso, '')

  const reopened = new AutomationStore({ stateFilePath, now: () => now })
  assert.equal((await reopened.read()).tasks[0].name, 'Paused status')
  snapshot = await reopened.delete(id)
  assert.equal(snapshot.tasks.length, 0)
})

test('records runs and recovers interrupted work after restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'automations.json')
  let now = new Date('2026-07-28T08:00:00.000Z')
  const store = new AutomationStore({ stateFilePath, now: () => now })
  const snapshot = await store.create({
    name: 'Follow up',
    prompt: 'Continue the check.',
    kind: 'heartbeat',
    targetThreadId: 'thread-1',
    rrule: 'FREQ=HOURLY',
  })
  await store.startRun(snapshot.tasks[0], 'schedule')

  now = new Date('2026-07-28T08:10:00.000Z')
  const recovered = await new AutomationStore({ stateFilePath, now: () => now }).recoverInterruptedRuns()
  assert.equal(recovered.runs[0].status, 'interrupted')
  assert.equal(recovered.runs[0].unread, true)
})

test('stores a chat proposal and applies it only after confirmation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new AutomationStore({
    stateFilePath: join(directory, 'automations.json'),
    now: () => new Date('2026-07-28T08:00:00.000Z'),
  })
  let snapshot = await store.createProposal('create', 'thread-1', 'turn-1', '', {
    name: 'Proposed task',
    prompt: 'Check this.',
    kind: 'heartbeat',
    targetThreadId: 'thread-1',
    rrule: 'FREQ=DAILY',
  })
  assert.equal(snapshot.tasks.length, 0)
  assert.equal(snapshot.proposals[0].turnId, 'turn-1')
  snapshot = await store.resolveProposal(snapshot.proposals[0].id, true)
  assert.equal(snapshot.tasks[0].name, 'Proposed task')
  assert.equal(snapshot.proposals[0].status, 'accepted')
  assert.equal(snapshot.proposals[0].resolvedAutomationId, snapshot.tasks[0].id)
})

test('accepts a proposal at most once across concurrent clients', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new AutomationStore({
    stateFilePath: join(directory, 'automations.json'),
    now: () => new Date('2026-07-28T08:00:00.000Z'),
  })
  const proposed = await store.createProposal('create', 'thread-1', 'turn-1', '', {
    name: 'One task',
    prompt: 'Run once per day.',
    kind: 'heartbeat',
    targetThreadId: 'thread-1',
    rrule: 'FREQ=DAILY',
  })
  const proposalId = proposed.proposals[0].id
  const results = await Promise.allSettled([
    store.resolveProposal(proposalId, true),
    store.resolveProposal(proposalId, true),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal((await store.read()).tasks.length, 1)
})

test('direct AI confirmation accepts the matching proposal without creating a duplicate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new AutomationStore({
    stateFilePath: join(directory, 'automations.json'),
    now: () => new Date('2026-07-28T08:00:00.000Z'),
  })
  const draft = {
    name: 'Confirmed in chat',
    prompt: 'Check this once per day.',
    kind: 'heartbeat',
    targetThreadId: 'thread-1',
    rrule: 'FREQ=DAILY',
  }
  await store.createProposal('create', 'thread-1', 'turn-1', '', draft)
  let snapshot = await store.confirmDirectCreate('thread-1', 'turn-1', draft)
  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.proposals[0].status, 'accepted')
  assert.equal(snapshot.proposals[0].resolvedAutomationId, snapshot.tasks[0].id)

  snapshot = await store.confirmDirectCreate('thread-1', 'turn-1', draft)
  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.proposals.length, 1)
})

test('startup reconciles a legacy direct create with its pending proposal', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'automations.json')
  let now = new Date('2026-07-28T08:00:00.000Z')
  const store = new AutomationStore({ stateFilePath, now: () => now })
  const draft = {
    name: 'Legacy confirmation',
    prompt: 'Check this once per day.',
    kind: 'heartbeat',
    targetThreadId: 'thread-1',
    rrule: 'FREQ=DAILY',
  }
  await store.createProposal('create', 'thread-1', 'turn-1', '', draft)
  now = new Date('2026-07-28T08:01:00.000Z')
  await store.create(draft)

  const snapshot = await new AutomationStore({
    stateFilePath,
    now: () => new Date('2026-07-28T08:02:00.000Z'),
  }).recoverInterruptedRuns()
  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.proposals[0].status, 'accepted')
  assert.equal(snapshot.proposals[0].resolvedAutomationId, snapshot.tasks[0].id)
})

test('recovers legacy proposal turn anchors from Codex session history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'automations.json')
  const sessionsDirectoryPath = join(directory, 'sessions')
  const sessionDayPath = join(sessionsDirectoryPath, '2026', '08', '01')
  await mkdir(sessionDayPath, { recursive: true })
  await writeFile(stateFilePath, JSON.stringify({
    tasks: [],
    runs: [],
    proposals: [{
      id: 'legacy-proposal',
      action: 'create',
      automationId: '',
      resolvedAutomationId: 'legacy-task',
      threadId: 'thread-legacy',
      turnId: '',
      draft: {
        name: 'Verify production deployment',
        prompt: 'Inspect the deployment once.',
        kind: 'heartbeat',
        targetThreadId: 'thread-legacy',
        rrule: 'FREQ=DAILY;COUNT=1',
      },
      createdAtIso: '2026-08-01T04:29:40.676Z',
      status: 'accepted',
    }],
    schemaVersion: 3,
    version: 1,
    updatedAtIso: '2026-08-01T04:29:40.676Z',
  }))
  await writeFile(
    join(sessionDayPath, 'rollout-2026-08-01T12-13-03-thread-legacy.jsonl'),
    `${JSON.stringify({
      timestamp: '2026-08-01T04:29:40.635Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: 'tools.automation_update Verify production deployment',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-original' },
      },
    })}\n`,
  )

  const snapshot = await new AutomationStore({
    stateFilePath,
    sessionsDirectoryPath,
    now: () => new Date('2026-08-01T08:00:00.000Z'),
  }).read()
  assert.equal(snapshot.proposals[0].turnId, 'turn-original')
  assert.equal(JSON.parse(await readFile(stateFilePath, 'utf8')).proposals[0].turnId, 'turn-original')
})

test('startup migrates legacy UTC next-run timestamps to Singapore time', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'automations.json')
  await writeFile(stateFilePath, JSON.stringify({
    tasks: [{
      id: 'legacy-task',
      name: 'Legacy task',
      prompt: 'Run in Singapore time.',
      status: 'ACTIVE',
      kind: 'heartbeat',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      cwd: '',
      targetThreadId: 'thread-1',
      executionEnvironment: 'local',
      model: '',
      reasoningEffort: 'xhigh',
      notificationPolicy: 'always',
      createdAtIso: '2026-07-28T00:00:00.000Z',
      updatedAtIso: '2026-07-28T00:00:00.000Z',
      nextRunAtIso: '2026-07-29T09:00:00.000Z',
      lastRunAtIso: '',
    }],
    runs: [],
    proposals: [],
    version: 1,
    updatedAtIso: '2026-07-28T00:00:00.000Z',
  }))
  const snapshot = await new AutomationStore({
    stateFilePath,
    now: () => new Date('2026-07-28T10:00:00.000Z'),
  }).recoverInterruptedRuns()
  assert.equal(snapshot.schemaVersion, 3)
  assert.equal(snapshot.tasks[0].timezone, 'Asia/Singapore')
  assert.equal(snapshot.tasks[0].nextRunAtIso, '2026-07-29T01:00:00.000Z')
})

test('runs a one-time task once and marks it completed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let now = new Date('2026-08-01T08:00:00.000Z')
  const store = new AutomationStore({
    stateFilePath: join(directory, 'automations.json'),
    now: () => now,
  })

  let snapshot = await store.create({
    name: 'One-time check',
    prompt: 'Check the deployment once.',
    kind: 'heartbeat',
    targetThreadId: 'thread-1',
    scheduleType: 'once',
    runAtIso: '2026-08-01T09:30:00.000Z',
  })
  const task = snapshot.tasks[0]
  assert.equal(task.scheduleType, 'once')
  assert.equal(task.nextRunAtIso, '2026-08-01T09:30:00.000Z')

  now = new Date('2026-08-01T09:30:00.000Z')
  snapshot = (await store.startRun(task, 'schedule')).snapshot
  assert.equal(snapshot.tasks[0].status, 'PAUSED')
  assert.equal(snapshot.tasks[0].nextRunAtIso, '')
  assert.equal(snapshot.tasks[0].lastRunAtIso, now.toISOString())
})

test('treats legacy COUNT=1 RRULE tasks as one-time runs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let now = new Date('2026-08-01T08:00:00.000Z')
  const store = new AutomationStore({
    stateFilePath: join(directory, 'automations.json'),
    now: () => now,
  })
  const snapshot = await store.create({
    name: 'Legacy one-time check',
    prompt: 'Run the legacy task once.',
    kind: 'heartbeat',
    targetThreadId: 'thread-1',
    rrule: 'FREQ=DAILY;COUNT=1;BYHOUR=17;BYMINUTE=0;BYSECOND=0',
  })

  now = new Date(snapshot.tasks[0].nextRunAtIso)
  const started = (await store.startRun(snapshot.tasks[0], 'schedule')).snapshot
  assert.equal(started.tasks[0].status, 'PAUSED')
  assert.equal(started.tasks[0].nextRunAtIso, '')
})

test('rejects a one-time task scheduled in the past', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-automations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new AutomationStore({
    stateFilePath: join(directory, 'automations.json'),
    now: () => new Date('2026-08-01T08:00:00.000Z'),
  })

  await assert.rejects(store.create({
    name: 'Too late',
    prompt: 'Do this once.',
    kind: 'heartbeat',
    targetThreadId: 'thread-1',
    scheduleType: 'once',
    runAtIso: '2026-08-01T07:59:00.000Z',
  }), /future/u)
})
