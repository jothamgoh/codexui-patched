import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(sourcePath) {
  const source = await readFile(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const storeSourceUrl = new URL('../src/server/projectBoardStore.ts', import.meta.url)
const { ProjectBoardStore } = await loadTypeScriptModule(storeSourceUrl)

async function createFixture(t, nowIso = '2026-09-05T02:00:00.000Z') {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-project-boards-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFilePath = join(directory, 'nested', 'project-boards.json')
  let now = new Date(nowIso)
  const store = new ProjectBoardStore({ stateFilePath, now: () => now })
  return {
    directory,
    stateFilePath,
    store,
    advance(milliseconds = 1_000) {
      now = new Date(now.getTime() + milliseconds)
    },
    reopen() {
      return new ProjectBoardStore({ stateFilePath, now: () => now })
    },
  }
}

async function createBoardAndFeature(store, feature = {}) {
  let snapshot = await store.ensureDefaultBoard({
    projectPath: '/tmp/codexui-board-project',
    projectName: 'Board project',
  })
  const board = snapshot.boards[0]
  snapshot = await store.createCard({
    boardId: board.id,
    title: feature.title ?? 'Build activity dashboard',
    description: 'Track feature progress across chats.',
    acceptanceCriteria: 'Progress and questions survive a restart.',
    verificationPolicy: feature.verificationPolicy ?? 'self',
    assignedAgentId: feature.assignedAgentId ?? 'builtin-lead',
    autoRun: feature.autoRun ?? false,
  })
  return {
    board,
    feature: snapshot.cards.find((card) => card.boardId === board.id && card.type === 'feature'),
    snapshot,
  }
}

function planTask(overrides) {
  return {
    key: 'task',
    title: 'Task',
    description: 'Do the scoped work.',
    acceptanceCriteria: 'The scoped work is complete.',
    agentRole: 'engineering',
    dependsOn: [],
    ...overrides,
  }
}

test('persists one default and optional additional boards with custom agent rosters', async (t) => {
  const fixture = await createFixture(t)
  let snapshot = await fixture.store.ensureDefaultBoard({
    projectPath: '/tmp/alpha-project',
    projectName: 'Alpha',
  })
  const firstDefault = snapshot.boards[0]
  const versionAfterDefault = snapshot.version

  snapshot = await fixture.store.ensureDefaultBoard({
    projectPath: '/tmp/alpha-project',
    projectName: 'A stale duplicate name',
  })
  assert.equal(snapshot.boards.length, 1)
  assert.equal(snapshot.version, versionAfterDefault)

  snapshot = await fixture.store.createBoard({
    projectPath: '/tmp/alpha-project',
    projectName: 'Alpha',
    name: 'Release board',
  })
  const releaseBoard = snapshot.boards.find((board) => board.name === 'Release board')
  assert.ok(releaseBoard)
  assert.equal(releaseBoard.isDefault, false)
  assert.equal(snapshot.boards.find((board) => board.id === firstDefault.id)?.isDefault, true)

  snapshot = await fixture.store.createBoard({
    projectPath: '/tmp/alpha-project',
    projectName: 'Alpha',
    name: 'New default',
    isDefault: true,
  })
  assert.equal(
    snapshot.boards.filter((board) => board.projectPath === '/tmp/alpha-project' && board.isDefault).length,
    1,
  )
  assert.equal(snapshot.boards.find((board) => board.name === 'New default')?.isDefault, true)

  const initialRosters = snapshot.boards.map((board) => ({ id: board.id, agentIds: board.agentIds }))
  await assert.rejects(fixture.store.createAgent({
    boardId: 'missing-board', name: 'Invalid membership', instructions: 'Inspect the result.',
  }), /Board not found/u)
  snapshot = await fixture.store.createAgent({ name: 'Library researcher', instructions: 'Research when assigned.' })
  assert.deepEqual(snapshot.boards.map((board) => ({ id: board.id, agentIds: board.agentIds })), initialRosters)
  assert.equal(snapshot.agents.find((agent) => agent.name === 'Library researcher').boardId, undefined)

  snapshot = await fixture.store.createAgent({
    boardId: releaseBoard.id,
    name: 'Accessibility reviewer',
    role: 'custom',
    description: 'Checks keyboard and screen-reader behavior.',
    instructions: 'Review the existing UI and report accessibility issues with evidence.',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sandbox: 'read-only',
  })
  const customAgent = snapshot.agents.find((agent) => agent.name === 'Accessibility reviewer')
  assert.ok(customAgent)
  assert.equal(customAgent.builtIn, false)
  assert.ok(snapshot.boards.find((board) => board.id === releaseBoard.id).agentIds.includes(customAgent.id))
  assert.deepEqual(
    snapshot.boards.filter((board) => board.id !== releaseBoard.id).map((board) => ({ id: board.id, agentIds: board.agentIds })),
    initialRosters.filter((board) => board.id !== releaseBoard.id),
  )

  fixture.advance()
  snapshot = await fixture.store.updateBoard(releaseBoard.id, {
    agentIds: ['builtin-lead', customAgent.id],
    isDefault: true,
  })
  assert.deepEqual(
    snapshot.boards.find((board) => board.id === releaseBoard.id)?.agentIds,
    ['builtin-lead', customAgent.id],
  )
  assert.equal(snapshot.boards.find((board) => board.id === releaseBoard.id)?.isDefault, true)
  assert.equal(snapshot.boards.find((board) => board.name === 'New default')?.isDefault, false)

  snapshot = await fixture.store.createCard({ boardId: releaseBoard.id, title: 'Review accessibility', assignedAgentId: customAgent.id })
  const feature = snapshot.cards.find((card) => card.title === 'Review accessibility')
  snapshot = await fixture.store.updateAgent(customAgent.id, { role: 'qa' })
  await assert.rejects(fixture.store.updateAgent(customAgent.id, { sandbox: 'workspace-write' }), /new profile/u)
  snapshot = await fixture.store.createCard({
    boardId: releaseBoard.id, parentCardId: feature.id, type: 'task',
    title: 'Inspect the interaction', assignedAgentId: customAgent.id,
  })
  assert.equal(snapshot.cards.find((card) => card.title === 'Inspect the interaction').taskPurpose, 'work')

  const reopened = await fixture.reopen().read()
  assert.equal(reopened.schemaVersion, 1)
  assert.equal(reopened.version, snapshot.version)
  assert.equal(reopened.boards.length, 3)
  assert.equal(reopened.agents.find((agent) => agent.id === customAgent.id)?.instructions, customAgent.instructions)
  assert.deepEqual(
    reopened.boards.find((board) => board.id === releaseBoard.id)?.agentIds,
    ['builtin-lead', customAgent.id],
  )
})

test('validates a Lead plan and enforces task dependencies', async (t) => {
  const fixture = await createFixture(t)
  const { feature } = await createBoardAndFeature(fixture.store, {
    verificationPolicy: 'independent',
  })

  await assert.rejects(
    fixture.store.replacePlan(feature.id, {
      summary: 'Invalid cyclic plan',
      tasks: [
        planTask({ key: 'engineer', dependsOn: ['qa'] }),
        planTask({ key: 'qa', agentRole: 'qa', dependsOn: ['engineer'] }),
      ],
    }),
    /cyclic task plan/u,
  )
  await assert.rejects(
    fixture.store.replacePlan(feature.id, {
      summary: 'Invalid missing dependency',
      tasks: [planTask({ key: 'engineer', dependsOn: ['missing'] })],
    }),
    /depends on unknown task/u,
  )
  await assert.rejects(fixture.store.replacePlan(feature.id, {
    summary: 'QA cannot run before implementation.',
    tasks: [planTask({ key: 'engineer' }), planTask({ key: 'qa', agentRole: 'qa' })],
  }), /Verification must depend on every work task/u)

  let snapshot = await fixture.store.replacePlan(feature.id, {
    summary: 'Engineer, then independent QA.',
    tasks: [
      planTask({ key: 'engineer', title: 'Implement dashboard' }),
      planTask({
        key: 'qa',
        title: 'Validate dashboard',
        agentRole: 'qa',
        dependsOn: ['engineer'],
      }),
    ],
  })
  const tasks = snapshot.cards.filter((card) => card.parentCardId === feature.id)
  const engineer = tasks.find((card) => card.title === 'Implement dashboard')
  const qa = tasks.find((card) => card.title === 'Validate dashboard')
  assert.ok(engineer)
  assert.ok(qa)
  assert.deepEqual(qa.dependencyIds, [engineer.id])
  assert.equal(snapshot.agents.find((agent) => agent.id === engineer.assignedAgentId)?.role, 'engineering')
  assert.equal(snapshot.agents.find((agent) => agent.id === qa.assignedAgentId)?.role, 'qa')
  assert.equal(engineer.taskPurpose, 'work')
  assert.equal(qa.taskPurpose, 'verification')

  await assert.rejects(
    fixture.store.updateTaskFromAgent(feature.id, qa.id, 'start', {}),
    /waiting for dependency: Implement dashboard/u,
  )

  snapshot = await fixture.store.updateTaskFromAgent(feature.id, engineer.id, 'start', {})
  assert.equal(snapshot.cards.find((card) => card.id === engineer.id)?.status, 'working')
  await assert.rejects(
    fixture.store.updateTaskFromAgent(feature.id, engineer.id, 'complete', {}),
    /requires a summary/u,
  )
  snapshot = await fixture.store.updateTaskFromAgent(feature.id, engineer.id, 'complete', {
    summary: 'Implemented the dashboard.',
    artifacts: [{ label: 'Implementation', path: 'src/ProjectBoard.vue' }],
  })
  assert.equal(snapshot.cards.find((card) => card.id === engineer.id)?.status, 'done')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.status, 'working')
  assert.equal(snapshot.artifacts[0].runId, '')

  snapshot = await fixture.store.updateTaskFromAgent(feature.id, qa.id, 'start', {})
  snapshot = await fixture.store.updateTaskFromAgent(feature.id, qa.id, 'complete', {
    summary: 'All acceptance criteria pass.',
  })
  assert.equal(snapshot.cards.find((card) => card.id === qa.id)?.status, 'done')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.status, 'working')
  snapshot = await fixture.store.finishFeature(feature.id, 'Implementation and independent QA complete.')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.status, 'done')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.progressNote, 'All tasks complete')
})

test('assigns same-role profiles by identity and verifies by task purpose', async (t) => {
  const { store } = await createFixture(t)
  const { board, feature } = await createBoardAndFeature(store, { verificationPolicy: 'independent' })
  await store.createAgent({ boardId: board.id, name: 'Researcher', role: 'custom', instructions: 'Research the requested behavior.' })
  let snapshot = await store.createAgent({ boardId: board.id, name: 'Reviewer', role: 'custom', instructions: 'Independently review the delivered behavior.' })
  const researcher = snapshot.agents.find((agent) => agent.name === 'Researcher')
  const reviewer = snapshot.agents.find((agent) => agent.name === 'Reviewer')
  await store.updateBoard(board.id, { agentIds: ['builtin-lead', researcher.id, reviewer.id] })

  for (const agentId of ['missing-agent', 'builtin-qa', '']) {
    await assert.rejects(store.replacePlan(feature.id, {
      summary: 'Invalid assignment must not fall back to a role.',
      tasks: [planTask({ agentId, agentRole: 'custom', taskPurpose: 'work' })],
    }), /must select an agent enabled for this board/u)
  }
  await assert.rejects(store.replacePlan(feature.id, {
    summary: 'Invalid purpose.',
    tasks: [planTask({ agentId: researcher.id, taskPurpose: 'unknown' })],
  }), /unknown purpose/u)
  await assert.rejects(store.replacePlan(feature.id, {
    summary: 'Read-only work also needs to finish before verification.',
    tasks: [
      planTask({ key: 'research', agentId: researcher.id, taskPurpose: 'work' }),
      planTask({ key: 'review', agentId: reviewer.id, taskPurpose: 'verification' }),
    ],
  }), /Verification must depend on every work task/u)

  snapshot = await store.replacePlan(feature.id, {
    summary: 'Research then a fresh independent review.',
    tasks: [
      planTask({ key: 'research', title: 'Research', agentId: researcher.id, taskPurpose: 'work' }),
      planTask({ key: 'review', title: 'Review', agentId: reviewer.id, taskPurpose: 'verification', dependsOn: ['research'] }),
    ],
  })
  const work = snapshot.cards.find((card) => card.title === 'Research')
  const verification = snapshot.cards.find((card) => card.title === 'Review')
  assert.equal(work.assignedAgentId, researcher.id)
  assert.equal(verification.assignedAgentId, reviewer.id)
  await assert.rejects(store.updateTaskFromAgent(feature.id, verification.id, 'start', {}), /waiting for dependency/u)

  // Changing profile tags cannot turn work into verification or remove a review.
  await store.updateAgent(researcher.id, { role: 'qa' })
  snapshot = await store.updateAgent(reviewer.id, { role: 'engineering' })
  assert.equal(snapshot.cards.find((card) => card.id === work.id).taskPurpose, 'work')
  assert.equal(snapshot.cards.find((card) => card.id === verification.id).taskPurpose, 'verification')
  for (const task of [work, verification]) {
    await store.updateTaskFromAgent(feature.id, task.id, 'start', {})
    await store.updateTaskFromAgent(feature.id, task.id, 'complete', { summary: 'Completed with evidence.' })
  }
  snapshot = await store.finishFeature(feature.id, 'Researched and independently checked.')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id).status, 'done')
})

test('migrates legacy QA tasks once while explicit assignments do not inherit profile workflow', async (t) => {
  const fixture = await createFixture(t)
  const { store, stateFilePath } = fixture
  const { board, feature } = await createBoardAndFeature(store)
  let snapshot = await store.createAgent({ boardId: board.id, name: 'Legacy reviewer', role: 'qa', instructions: 'Review the result.' })
  const reviewer = snapshot.agents.find((agent) => agent.name === 'Legacy reviewer')
  await store.updateBoard(board.id, { agentIds: ['builtin-lead', 'builtin-engineer', reviewer.id] })
  snapshot = await store.replacePlan(feature.id, {
    summary: 'Explicit assignments default to work even for a QA profile.',
    tasks: [planTask({ agentId: reviewer.id, agentRole: 'qa' })],
  })
  assert.equal(snapshot.cards.find((card) => card.parentCardId === feature.id).taskPurpose, 'work')

  snapshot = await store.replacePlan(feature.id, {
    summary: 'Legacy role-based plan.',
    tasks: [planTask({ key: 'work' }), planTask({ key: 'review', agentRole: 'qa', dependsOn: ['work'] })],
  })
  for (const card of snapshot.cards) delete card.taskPurpose
  await writeFile(stateFilePath, JSON.stringify(snapshot))
  snapshot = await fixture.reopen().read()
  const review = snapshot.cards.find((card) => card.assignedAgentId === reviewer.id)
  assert.equal(snapshot.cards.find((card) => card.id === feature.id).taskPurpose, 'work')
  assert.equal(snapshot.cards.find((card) => card.assignedAgentId === 'builtin-engineer').taskPurpose, 'work')
  assert.equal(review.taskPurpose, 'verification')
  await assert.rejects(store.updateTaskFromAgent(feature.id, review.id, 'start', {}), /waiting for dependency/u)

  await store.updateAgent(reviewer.id, { role: 'custom' })
  snapshot = await fixture.reopen().read()
  assert.equal(snapshot.cards.find((card) => card.id === review.id).taskPurpose, 'verification')
  const persisted = JSON.parse(await readFile(stateFilePath, 'utf8'))
  assert.equal(persisted.cards.find((card) => card.id === review.id).taskPurpose, 'verification')
})

test('independent and batch verification policies gate completion honestly', async (t) => {
  const fixture = await createFixture(t)
  let created = await createBoardAndFeature(fixture.store, {
    title: 'Independent feature',
    verificationPolicy: 'independent',
  })
  const independent = created.feature
  let snapshot = await fixture.store.replacePlan(independent.id, {
    summary: 'Implementation only is not enough.',
    tasks: [planTask({ key: 'implementation', title: 'Implementation' })],
  })
  const implementation = snapshot.cards.find((card) => card.parentCardId === independent.id)
  snapshot = await fixture.store.updateTaskFromAgent(independent.id, implementation.id, 'start', {})
  snapshot = await fixture.store.updateTaskFromAgent(independent.id, implementation.id, 'complete', {
    summary: 'Implemented but not independently checked.',
  })
  assert.equal(snapshot.cards.find((card) => card.id === independent.id)?.status, 'blocked')
  assert.equal(
    snapshot.cards.find((card) => card.id === independent.id)?.progressNote,
    'Independent verification task required',
  )

  snapshot = await fixture.store.createCard({
    boardId: created.board.id,
    title: 'Small related feature',
    verificationPolicy: 'batch',
  })
  const batchFeature = snapshot.cards.find((card) => card.title === 'Small related feature')
  snapshot = await fixture.store.replacePlan(batchFeature.id, {
    summary: 'Implement now and validate with the release batch.',
    tasks: [planTask({ key: 'small-change', title: 'Small change' })],
  })
  const smallChange = snapshot.cards.find((card) => card.parentCardId === batchFeature.id)
  snapshot = await fixture.store.updateTaskFromAgent(batchFeature.id, smallChange.id, 'start', {})
  snapshot = await fixture.store.updateTaskFromAgent(batchFeature.id, smallChange.id, 'complete', {
    summary: 'Small change implemented.',
  })
  snapshot = await fixture.store.finishFeature(batchFeature.id, 'Ready for combined verification.')
  assert.equal(snapshot.cards.find((card) => card.id === batchFeature.id)?.status, 'review')
  assert.equal(snapshot.cards.find((card) => card.id === batchFeature.id)?.progressNote, 'Ready for batch QA')

  snapshot = await fixture.store.createCard({
    boardId: created.board.id,
    type: 'qa_batch',
    title: 'Release verification',
    verificationPolicy: 'independent',
    assignedAgentId: 'builtin-qa',
    dependencyIds: [batchFeature.id],
  })
  const qaBatch = snapshot.cards.find((card) => card.type === 'qa_batch')
  assert.ok(qaBatch)
  assert.deepEqual(qaBatch.dependencyIds, [batchFeature.id])
  assert.equal(qaBatch.assignedAgentId, 'builtin-qa')
  await assert.rejects(fixture.store.startRun(qaBatch.id, 'builtin-qa', 'execute'), /QA batches are not executable/u)
  await assert.rejects(fixture.store.updateCard(batchFeature.id, { status: 'done' }), /Batch verification remains in Review/u)

  const reopened = await fixture.reopen().read()
  assert.equal(reopened.cards.find((card) => card.id === batchFeature.id)?.status, 'review')
  assert.deepEqual(reopened.cards.find((card) => card.id === qaBatch.id)?.dependencyIds, [batchFeature.id])
})

test('persists Needs You questions, accepts one answer, and resumes parent progress', async (t) => {
  const fixture = await createFixture(t)
  const { feature } = await createBoardAndFeature(fixture.store)
  let snapshot = await fixture.store.replacePlan(feature.id, {
    summary: 'One decision is needed.',
    tasks: [planTask({ key: 'decision', title: 'Choose the interaction' })],
  })
  const taskCard = snapshot.cards.find((card) => card.parentCardId === feature.id)
  const { run } = await fixture.store.startRun(feature.id, 'builtin-lead', 'execute')

  snapshot = await fixture.store.askQuestion(
    feature.id,
    taskCard.id,
    'Should the detail open beside the board or on a separate page?',
    run.id,
  )
  const question = snapshot.questions[0]
  assert.equal(question.status, 'open')
  assert.equal(question.runId, run.id)
  assert.equal(snapshot.cards.find((card) => card.id === taskCard.id)?.status, 'needs_input')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.status, 'needs_input')

  const deduplicated = await fixture.store.askQuestion(
    feature.id,
    taskCard.id,
    question.prompt,
    run.id,
  )
  assert.equal(deduplicated.questions.length, 1)
  assert.equal(deduplicated.version, snapshot.version)

  fixture.advance()
  snapshot = await fixture.store.answerQuestion(question.id, 'Open it beside the board.')
  assert.equal(snapshot.questions[0].status, 'answered')
  assert.equal(snapshot.questions[0].answer, 'Open it beside the board.')
  assert.equal(snapshot.cards.find((card) => card.id === taskCard.id)?.status, 'backlog')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.status, 'backlog')
  assert.equal(snapshot.comments[0].author, 'You')
  assert.equal(snapshot.comments[0].text, 'Answer: Open it beside the board.')
  await assert.rejects(
    fixture.store.answerQuestion(question.id, 'A conflicting second answer.'),
    /no longer needs an answer/u,
  )

  const reopened = await fixture.reopen().read()
  assert.equal(reopened.questions[0].status, 'answered')
  assert.equal(reopened.questions[0].answeredAtIso, snapshot.questions[0].answeredAtIso)
})

test('restart recovery interrupts active runs without claiming the work succeeded', async (t) => {
  const fixture = await createFixture(t)
  const { feature } = await createBoardAndFeature(fixture.store)
  let { snapshot, run } = await fixture.store.startRun(feature.id, 'builtin-lead', 'execute')
  snapshot = await fixture.store.setRunThread(run.id, 'lead-thread-before-restart')
  snapshot = await fixture.store.replacePlan(feature.id, { summary: 'Implement.', tasks: [planTask({})] }, run.id)
  const task = snapshot.cards.find((card) => card.parentCardId === feature.id)
  await fixture.store.updateTaskFromAgent(feature.id, task.id, 'start', {}, run.id)
  assert.equal(snapshot.runs.find((entry) => entry.id === run.id)?.status, 'running')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.status, 'working')

  fixture.advance(30_000)
  const recovered = await fixture.reopen().recoverInterruptedRuns()
  const recoveredRun = recovered.runs.find((entry) => entry.id === run.id)
  assert.equal(recoveredRun.status, 'interrupted')
  assert.equal(recoveredRun.threadId, 'lead-thread-before-restart')
  assert.equal(recoveredRun.requestedModel, undefined, 'Legacy runs do not infer settings from the current profile')
  assert.equal(recoveredRun.requestedReasoningEffort, undefined)
  assert.match(recoveredRun.error, /restarted before this run finished/u)
  assert.equal(recovered.cards.find((card) => card.id === feature.id)?.status, 'blocked')
  assert.equal(recovered.cards.find((card) => card.id === task.id)?.status, 'blocked')
  assert.equal(
    recovered.cards.find((card) => card.id === feature.id)?.progressNote,
    'CodexUI restarted; retry this card',
  )

  const secondRecovery = await fixture.reopen().recoverInterruptedRuns()
  assert.equal(secondRecovery.version, recovered.version)
  assert.equal(secondRecovery.runs.find((entry) => entry.id === run.id)?.status, 'interrupted')
})

test('public edits cannot forge ownership, bypass live workflow, or finish with an unresolved question', async (t) => {
  const { store } = await createFixture(t)
  const { board, feature } = await createBoardAndFeature(store)
  await assert.rejects(store.createCard({ boardId: board.id, title: 'Forged', status: 'done' }), /must start in Backlog/u)
  for (const field of ['threadId', 'summary', 'progressNote', 'lastRunId', 'completedAtIso']) {
    await assert.rejects(store.updateCard(feature.id, { [field]: 'forged' }), /server-owned/u)
  }
  await assert.rejects(store.updateCard(feature.id, { status: 'done' }), /task plan/u)
  const { run } = await store.startRun(feature.id, 'builtin-lead', 'execute')
  await store.setRunThread(run.id, 'owned-lead-thread')
  let snapshot = await store.replacePlan(feature.id, { summary: 'Implement.', tasks: [planTask({})] }, run.id)
  const task = snapshot.cards.find((card) => card.parentCardId === feature.id)
  assert.equal(task.lastRunId, run.id)
  await assert.rejects(store.updateCard(task.id, { status: 'done' }), /feature run to stop/u)
  await assert.rejects(store.updateCard(task.id, { taskPurpose: 'verification' }), /feature run to stop/u)
  await assert.rejects(store.deleteCard(task.id), /feature run to stop/u)
  await store.updateTaskFromAgent(feature.id, task.id, 'start', {}, run.id)
  await store.updateTaskFromAgent(feature.id, task.id, 'complete', { summary: 'Implemented and checked.' }, run.id)
  snapshot = await store.addComment(task.id, 'Handoff recorded.', 'Lead', run.id, feature.id)
  assert.equal(snapshot.comments[0].runId, run.id)

  // These mutations share the same queue: the finish sees the preceding question.
  const [questionResult, finishResult] = await Promise.allSettled([
    store.askQuestion(feature.id, feature.id, 'Approve the completed behavior?', run.id),
    store.finishFeature(feature.id, 'Must not commit.', run.id),
  ])
  assert.equal(questionResult.status, 'fulfilled')
  assert.equal(finishResult.status, 'rejected')
  assert.match(finishResult.reason.message, /open questions/u)
  snapshot = await store.askQuestion(feature.id, feature.id, 'A second decision?', run.id)
  await store.completeRun(run.id, 'Waiting for answers.')
  await assert.rejects(store.updateCard(feature.id, { status: 'done' }), /open questions/u)
  await assert.rejects(store.attachArtifact(feature.id, task.id, { path: 'stale.txt' }, run.id), /no longer active/u)
  snapshot = await store.answerQuestion(snapshot.questions[0].id, 'Approved.')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id).status, 'needs_input')
  snapshot = await store.answerQuestion(snapshot.questions.find((question) => question.status === 'open').id, 'Approved.')
  await assert.rejects(store.updateCard(task.id, { status: 'backlog' }).then(() => store.updateCard(task.id, { status: 'done' })), /recorded agent handoff/u)
  await store.updateTaskFromAgent(feature.id, task.id, 'start', {})
  await store.updateTaskFromAgent(feature.id, task.id, 'complete', { summary: 'Rechecked after the answers.' })
  snapshot = await store.finishFeature(feature.id, 'All decisions and checks complete.')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id).status, 'done')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id).threadId, 'owned-lead-thread')
})

test('dependency references survive deletion attempts and stale QA cannot finish a feature', async (t) => {
  const fixture = await createFixture(t)
  const { store, stateFilePath } = fixture
  const { feature } = await createBoardAndFeature(store, { verificationPolicy: 'independent' })
  let snapshot = await store.replacePlan(feature.id, {
    summary: 'Implementation then QA.',
    tasks: [planTask({ key: 'implementation' }), planTask({ key: 'qa', agentRole: 'qa', dependsOn: ['implementation'] })],
  })
  const implementation = snapshot.cards.find((card) => card.assignedAgentId === 'builtin-engineer')
  const qa = snapshot.cards.find((card) => card.assignedAgentId === 'builtin-qa')
  await assert.rejects(store.deleteCard(implementation.id), /Delete dependent card/u)
  for (const task of [implementation, qa]) {
    await store.updateTaskFromAgent(feature.id, task.id, 'start', {})
    fixture.advance()
    snapshot = await store.updateTaskFromAgent(feature.id, task.id, 'complete', { summary: 'Completed with evidence.' })
  }
  await assert.rejects(store.updateCard(implementation.id, { status: 'backlog' }), /Reopen dependent card/u)
  await assert.rejects(store.updateCard(implementation.id, { assignedAgentId: 'builtin-qa' }), /Reopen the completed task/u)
  await assert.rejects(store.updateCard(implementation.id, { taskPurpose: 'verification' }), /Reopen the completed task/u)
  const oldQaCompletedAt = snapshot.cards.find((card) => card.id === qa.id).completedAtIso
  snapshot.cards.find((card) => card.id === implementation.id).completedAtIso = '2026-09-06T02:00:00.000Z'
  await writeFile(stateFilePath, JSON.stringify(snapshot))
  await assert.rejects(store.finishFeature(feature.id, 'Stale QA must fail.'), /Verification must be repeated/u)
  assert.equal((await store.read()).cards.find((card) => card.id === qa.id).completedAtIso, oldQaCompletedAt)

  // Corrupt dependency references are never interpreted as satisfied.
  snapshot.cards = snapshot.cards.filter((card) => card.id !== implementation.id)
  snapshot.cards.find((card) => card.id === qa.id).status = 'backlog'
  await writeFile(stateFilePath, JSON.stringify(snapshot))
  await assert.rejects(store.updateTaskFromAgent(feature.id, qa.id, 'start', {}), /Missing dependency/u)
  await assert.rejects(store.updateCard(qa.id, { status: 'working' }), /Missing dependency/u)
})

test('capacity and unsupported state reject writes without discarding durable data', async (t) => {
  const { store, stateFilePath } = await createFixture(t)
  const { board, feature, snapshot } = await createBoardAndFeature(store)
  snapshot.cards = Array.from({ length: 2_000 }, (_, index) => ({ ...feature, id: `existing-${index}` }))
  await writeFile(stateFilePath, JSON.stringify(snapshot))
  const fullState = await readFile(stateFilePath, 'utf8')
  await assert.rejects(store.createCard({ boardId: board.id, title: 'Overflow' }), /cards capacity/u)
  assert.equal(await readFile(stateFilePath, 'utf8'), fullState)
  assert.equal((await store.read()).cards.length, 2_000)
  for (const malformed of [null, {}, { ...snapshot, schemaVersion: 2 }, { ...snapshot, cards: null }]) {
    const original = JSON.stringify(malformed)
    await writeFile(stateFilePath, original)
    await assert.rejects(store.ensureDefaultBoard({ projectPath: '/tmp/another-project' }), /unsupported schema or invalid shape/u)
    assert.equal(await readFile(stateFilePath, 'utf8'), original)
  }
})


test('edits feature dependencies without cycles and reopens repairs without losing handoffs', async (t) => {
  const { store } = await createFixture(t)
  const { board, feature } = await createBoardAndFeature(store)
  let snapshot = await store.createCard({ boardId: board.id, title: 'Dependent interface', model: 'selected-model', reasoningEffort: 'medium' })
  const second = snapshot.cards.find((card) => card.title === 'Dependent interface')
  await assert.rejects(store.startRun(second.id, 'builtin-lead', 'execute', 'stale-feature-state'), /feature changed while starting/u)
  await store.updateCard(second.id, { dependencyIds: [feature.id] })
  await assert.rejects(store.updateCard(feature.id, { dependencyIds: [second.id] }), /cycle/u)
  await assert.rejects(store.updateCard(second.id, { dependencyIds: ['missing'] }), /Missing dependency/u)
  await assert.rejects(store.updateCard(second.id, { reasoningEffort: 'invented' }), /Unknown reasoning/u)
  await assert.rejects(store.startRun(second.id, 'builtin-lead', 'execute'), /waiting for dependency/u)
  const plan = await store.startRun(second.id, 'builtin-lead', 'plan')
  await store.completeRun(plan.run.id, 'Can plan before the foundation exists.')
  snapshot = await store.replacePlan(feature.id, { summary: 'Build and verify.', tasks: [
    planTask({ key: 'build', title: 'Build' }), planTask({ key: 'review', title: 'Review', agentRole: 'qa', dependsOn: ['build'] }),
  ] })
  const build = snapshot.cards.find((card) => card.title === 'Build')
  const review = snapshot.cards.find((card) => card.title === 'Review')
  for (const task of [build, review]) {
    await store.updateTaskFromAgent(feature.id, task.id, 'start', {})
    await store.updateTaskFromAgent(feature.id, task.id, 'complete', { summary: `${task.title} original evidence.` })
  }
  await assert.rejects(store.updateTaskFromAgent(feature.id, build.id, 'reopen', { summary: 'Repair integration.' }), /Reopen dependent task/u)
  await store.updateTaskFromAgent(feature.id, review.id, 'reopen', { summary: 'Recheck after repairs.' })
  snapshot = await store.updateTaskFromAgent(feature.id, build.id, 'reopen', { summary: 'Repair integration.' })
  assert.equal(snapshot.cards.find((card) => card.id === build.id).status, 'backlog')
  assert.equal(snapshot.cards.find((card) => card.id === build.id).summary, 'Build original evidence.')
  assert.ok(snapshot.comments.some((comment) => comment.text.includes('Previous handoff: Build original evidence.')))
  assert.equal(snapshot.cards.find((card) => card.id === second.id).model, 'selected-model')
})
