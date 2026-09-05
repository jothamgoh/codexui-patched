import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

async function compileTypeScriptModule(sourcePath, replacements = []) {
  let source = await readFile(sourcePath, 'utf8')
  for (const [search, replacement] of replacements) source = source.replace(search, replacement)
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
}

const storeSourceUrl = new URL('../src/server/projectBoardStore.ts', import.meta.url)
const storeModuleUrl = await compileTypeScriptModule(storeSourceUrl)
const { ProjectBoardStore } = await import(storeModuleUrl)
const serviceSourceUrl = new URL('../src/server/projectBoardService.ts', import.meta.url)
const serviceModuleUrl = await compileTypeScriptModule(serviceSourceUrl, [
  ["from './projectBoardStore'", `from '${storeModuleUrl}'`],
])
const { ProjectBoardService, PROJECT_BOARD_DYNAMIC_TOOL_SPEC } = await import(serviceModuleUrl)

const delay = (milliseconds = 10) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await delay()
  }
  throw new Error(message)
}

function createFakeAppServer() {
  const calls = []
  const notifications = []
  let nextTurn = 1
  return {
    calls,
    notifications,
    async rpc(method, params) {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'lead-thread' } }
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      if (method === 'turn/start') return { turn: { id: `lead-turn-${String(nextTurn++)}` } }
      return {}
    },
    publishLocalNotification(method, params) {
      notifications.push({ method, params })
    },
  }
}

async function createHarness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-project-board-service-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'project'))
  const projectPath = await realpath(join(directory, 'project'))
  const store = new ProjectBoardStore({
    stateFilePath: join(directory, 'project-boards.json'),
    now: () => new Date('2026-09-05T04:00:00.000Z'),
  })
  const appServer = createFakeAppServer()
  const service = new ProjectBoardService({
    store,
    appServer,
    prepareThreadStartParams: (params) => ({
      ...params,
      dynamicTools: [{ name: 'automation_update' }],
      developerInstructions: 'Keep the existing scheduled-task tool available.',
    }),
  })
  let snapshot = await service.ensureDefaultBoard({
    projectPath,
    projectName: 'Fake project',
  })
  const board = snapshot.boards[0]
  snapshot = await service.createCard({
    boardId: board.id,
    title: 'Build the project board',
    description: 'Create a durable dashboard for feature progress.',
    acceptanceCriteria: 'The Lead can plan, hand off, ask a question, and finish.',
    verificationPolicy: 'independent',
    assignedAgentId: 'builtin-lead',
    autoRun: true,
  })
  const feature = snapshot.cards.find((card) => card.type === 'feature')
  return { appServer, board, feature, service, store }
}

function toolCall(threadId, action, fields = {}) {
  return {
    threadId,
    turnId: 'lead-turn-1',
    arguments: { action, ...fields },
  }
}

test('constructs a native Lead chat while preserving other dynamic tools', async (t) => {
  const { appServer, board, feature, service, store } = await createHarness(t)
  const started = await service.startFeature(feature.id, { allowWorkspaceWrite: true })
  assert.equal(started.runs[0].status, 'running')

  const turnCall = await waitFor(
    () => appServer.calls.find((call) => call.method === 'turn/start'),
    'Lead turn was not started',
  )
  const threadCall = appServer.calls.find((call) => call.method === 'thread/start')
  assert.ok(threadCall)
  assert.equal(threadCall.params.cwd, board.projectPath)
  assert.equal(threadCall.params.sandbox, 'workspace-write')
  assert.equal(threadCall.params.approvalPolicy, 'on-request')
  assert.equal(turnCall.params.approvalPolicy, 'on-request')
  assert.equal(turnCall.params.sandboxPolicy.type, 'workspaceWrite')
  assert.deepEqual(
    threadCall.params.dynamicTools.map((tool) => tool.name),
    ['automation_update', 'project_board_update'],
  )
  assert.match(threadCall.params.developerInstructions, /scheduled-task tool/u)
  assert.match(threadCall.params.developerInstructions, /Lead orchestrator/u)
  assert.match(threadCall.params.developerInstructions, /native subagents/u)
  assert.equal(turnCall.params.threadId, 'lead-thread')
  assert.equal(turnCall.params.cwd, board.projectPath)
  assert.match(turnCall.params.input[0].text, /Build the project board/u)
  assert.match(turnCall.params.input[0].text, /project_board_update with read_context/u)
  assert.match(turnCall.params.input[0].text, /Product \(product, read-only\)/u)

  const persisted = await store.read()
  assert.equal(persisted.cards.find((card) => card.id === feature.id)?.threadId, 'lead-thread')
  assert.equal(persisted.runs[0].threadId, 'lead-thread')
  assert.ok(
    appServer.notifications.some((notification) => notification.method === 'codexui/projectBoards/updated'),
  )
  assert.equal(PROJECT_BOARD_DYNAMIC_TOOL_SPEC.name, 'project_board_update')
})

test('drives plan, dependency handoff, Needs You, answer, QA, and completion through the board tool', async (t) => {
  const { appServer, feature, service, store } = await createHarness(t)
  await service.startFeature(feature.id, { allowWorkspaceWrite: true })
  await waitFor(
    () => appServer.calls.find((call) => call.method === 'turn/start'),
    'Initial Lead turn was not started',
  )

  const readResult = await service.handleDynamicToolCall(toolCall('lead-thread', 'read_context'))
  assert.equal(readResult.success, true)
  assert.match(readResult.contentItems[0].text, /Build the project board/u)

  const planResult = await service.handleDynamicToolCall(toolCall('lead-thread', 'replace_plan', {
    plan: {
      summary: 'Implement first, then validate independently.',
      tasks: [
        {
          key: 'implementation',
          title: 'Implement project board',
          description: 'Build the native project board.',
          acceptanceCriteria: 'Persistent UI and service are implemented.',
          agentRole: 'engineering',
          dependsOn: [],
        },
        {
          key: 'qa',
          title: 'Validate project board',
          description: 'Check the implementation against its acceptance criteria.',
          acceptanceCriteria: 'All focused tests pass.',
          agentRole: 'qa',
          dependsOn: ['implementation'],
        },
      ],
    },
  }))
  assert.match(planResult.contentItems[0].text, /Saved 2 tasks/u)
  let snapshot = await store.read()
  const implementation = snapshot.cards.find((card) => card.title === 'Implement project board')
  const qa = snapshot.cards.find((card) => card.title === 'Validate project board')
  assert.ok(implementation)
  assert.ok(qa)
  assert.deepEqual(qa.dependencyIds, [implementation.id])
  assert.equal(implementation.lastRunId, snapshot.runs[0].id)

  await assert.rejects(
    service.handleDynamicToolCall(toolCall('lead-thread', 'start_task', { taskId: qa.id })),
    /waiting for dependency/u,
  )
  await service.handleDynamicToolCall(toolCall('lead-thread', 'start_task', {
    taskId: implementation.id,
  }))
  await service.handleDynamicToolCall(toolCall('lead-thread', 'complete_task', {
    taskId: implementation.id,
    summary: 'Implementation complete with focused unit tests.',
    artifacts: [{ label: 'Board service', path: 'src/server/projectBoardService.ts' }],
  }))

  const questionText = 'Should QA include the optional browser smoke test?'
  const questionResult = await service.handleDynamicToolCall(toolCall('lead-thread', 'ask_user', {
    taskId: qa.id,
    question: questionText,
  }))
  assert.match(questionResult.contentItems[0].text, /Question saved/u)
  snapshot = await store.read()
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.status, 'needs_input')
  assert.equal(snapshot.questions[0].prompt, questionText)
  assert.equal(snapshot.questions[0].runId, snapshot.runs[0].id)
  assert.equal(snapshot.artifacts[0].runId, snapshot.runs[0].id)
  assert.ok(appServer.notifications.some((notification) => (
    notification.method === 'codexui/projectBoards/attention'
    && notification.params.featureId === feature.id
    && notification.params.questionId === snapshot.questions[0].id
  )))

  await service.handleNotification({
    method: 'item/completed',
    params: {
      threadId: 'lead-thread',
      turnId: 'lead-turn-1',
      item: { type: 'agentMessage', text: 'Waiting for the user decision.' },
    },
  })
  await service.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: 'lead-thread',
      turn: { id: 'lead-turn-1', status: 'completed' },
    },
  })
  snapshot = await store.read()
  assert.equal(snapshot.runs[0].status, 'succeeded')
  assert.equal(snapshot.runs[0].summary, 'Waiting for the user decision.')

  await service.answerQuestion(snapshot.questions[0].id, { answer: 'Yes, include it.' })
  const resumedTurn = await waitFor(
    () => appServer.calls.filter((call) => call.method === 'turn/start')[1],
    'Lead did not resume after the answer',
  )
  assert.ok(appServer.calls.some((call) => call.method === 'thread/resume' && call.params.threadId === 'lead-thread'))
  assert.match(resumedTurn.params.input[0].text, /Continue orchestrating/u)
  assert.match(resumedTurn.params.input[0].text, /Yes, include it\./u)

  await service.handleDynamicToolCall({
    ...toolCall('lead-thread', 'start_task', { taskId: qa.id }),
    turnId: 'lead-turn-2',
  })
  await service.handleDynamicToolCall({
    ...toolCall('lead-thread', 'complete_task', {
      taskId: qa.id,
      summary: 'Independent QA passed, including the browser smoke test.',
      artifacts: [{ label: 'Test report', path: 'documentation/project-boards/PROGRESS.md' }],
    }),
    turnId: 'lead-turn-2',
  })
  const finishResult = await service.handleDynamicToolCall({
    ...toolCall('lead-thread', 'finish_feature', {
      summary: 'Implementation and independent QA are complete.',
    }),
    turnId: 'lead-turn-2',
  })
  assert.match(finishResult.contentItems[0].text, /Feature marked done/u)

  await service.handleNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'lead-thread', turnId: 'lead-turn-2', delta: 'Feature complete.' },
  })
  await service.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: 'lead-thread',
      turn: { id: 'lead-turn-2', status: 'completed' },
    },
  })
  snapshot = await store.read()
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.status, 'done')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.summary, 'Implementation and independent QA are complete.')
  assert.equal(snapshot.questions[0].status, 'answered')
  assert.equal(snapshot.questions[0].answer, 'Yes, include it.')
  assert.equal(snapshot.runs.filter((run) => run.cardId === feature.id).length, 2)
  assert.ok(snapshot.runs.filter((run) => run.cardId === feature.id).every((run) => run.status === 'succeeded'))
  assert.deepEqual(
    new Set(snapshot.artifacts.map((artifact) => artifact.path)),
    new Set([
      'src/server/projectBoardService.ts',
      'documentation/project-boards/PROGRESS.md',
    ]),
  )
})

test('records failed Lead turns as blocked and does not report false completion', async (t) => {
  const { appServer, feature, service, store } = await createHarness(t)
  await service.startFeature(feature.id, { allowWorkspaceWrite: true })
  await waitFor(
    () => appServer.calls.find((call) => call.method === 'turn/start'),
    'Lead turn was not started',
  )

  await service.handleNotification({
    method: 'error',
    params: {
      threadId: 'lead-thread',
      turnId: 'lead-turn-1',
      error: { message: 'The model connection failed.' },
    },
  })
  await service.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: 'lead-thread',
      turn: { id: 'lead-turn-1', status: 'failed' },
    },
  })

  await assert.rejects(service.handleDynamicToolCall(toolCall('lead-thread', 'comment', { comment: 'A late write' })), /exact active Lead turn/u)
  const snapshot = await store.read()
  assert.equal(snapshot.runs[0].status, 'failed')
  assert.equal(snapshot.runs[0].error, 'The model connection failed.')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.status, 'blocked')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id)?.completedAtIso, '')
})


test('requires explicit write consent and scopes mutations to the active feature turn', async (t) => {
  const { appServer, board, feature, service, store } = await createHarness(t)
  await assert.rejects(service.startFeature(feature.id), /Confirm workspace-write access/u)
  assert.equal((await store.read()).runs.length, 0)
  assert.equal(appServer.calls.length, 0)
  const withBatch = await service.createCard({ boardId: board.id, type: 'qa_batch', title: 'Combined checks' })
  const batch = withBatch.cards.find((card) => card.type === 'qa_batch')
  await assert.rejects(service.startFeature(batch.id, { allowWorkspaceWrite: true }), /QA-batch execution is not available/u)
  await service.startFeature(feature.id, { allowWorkspaceWrite: true })
  await waitFor(() => appServer.calls.find((call) => call.method === 'turn/start'), 'Lead turn was not started')
  const aliasPath = join(board.projectPath, '..', 'project-alias')
  await symlink(board.projectPath, aliasPath, 'dir')
  for (const projectPath of [board.projectPath + '/', aliasPath]) {
    const withAlias = await service.createBoard({ projectPath, name: 'Aliased project' })
    const aliasBoard = withAlias.boards[0]
    const withFeature = await service.createCard({ boardId: aliasBoard.id, title: 'Conflicting feature' })
    const aliasFeature = withFeature.cards.find((card) => card.boardId === aliasBoard.id)
    await assert.rejects(service.startFeature(aliasFeature.id, { allowWorkspaceWrite: true }), /Another feature is running/u)
  }
  const missingPath = join(board.projectPath, 'missing')
  const withMissing = await service.createBoard({ projectPath: missingPath, name: 'Missing project' })
  const withMissingFeature = await service.createCard({ boardId: withMissing.boards[0].id, title: 'Unavailable feature' })
  const missingFeature = withMissingFeature.cards.find((card) => card.boardId === withMissing.boards[0].id)
  await assert.rejects(service.startFeature(missingFeature.id, { allowWorkspaceWrite: true }), /Project folder is unavailable/u)
  assert.equal((await store.read()).runs.length, 1)
  for (const turnId of ['', 'another-turn']) {
    await assert.rejects(service.handleDynamicToolCall({
      ...toolCall('lead-thread', 'comment', { comment: 'Stale update' }), turnId,
    }), /exact active Lead turn/u)
  }
  await assert.rejects(service.handleDynamicToolCall(toolCall('lead-thread', 'comment', {
    cardId: batch.id, comment: 'Wrong feature',
  })), /feature/u)
  await service.handleDynamicToolCall(toolCall('lead-thread', 'comment', { comment: 'Current update' }))
  const snapshot = await store.read()
  assert.equal(snapshot.comments.length, 1)
  assert.equal(snapshot.comments[0].runId, snapshot.runs[0].id)

  await service.handleDynamicToolCall(toolCall('lead-thread', 'ask_user', { question: 'First decision?' }))
  const firstQuestion = (await store.read()).questions[0]
  await service.handleDynamicToolCall(toolCall('lead-thread', 'ask_user', { question: 'Second decision?' }))
  await service.handleDynamicToolCall(toolCall('lead-thread', 'ask_user', { question: '  First decision?  ' }))
  const attention = appServer.notifications.filter((notification) => notification.method === 'codexui/projectBoards/attention').at(-1)
  assert.equal(attention.params.questionId, firstQuestion.id)
  assert.equal(attention.params.message, firstQuestion.prompt)
  assert.equal((await store.read()).questions.length, 2)
})

test('app-server exit interrupts pending and active turns, releases locks, and requires fresh consent', async (t) => {
  for (const pendingResponse of [false, true]) {
    const { appServer, feature, service, store } = await createHarness(t)
    const rpc = appServer.rpc.bind(appServer)
    let releaseTurn
    appServer.rpc = async (method, params) => {
      const result = await rpc(method, params)
      if (method === 'turn/start' && pendingResponse) {
        return new Promise((resolve) => { releaseTurn = () => resolve(result) })
      }
      return result
    }
    await service.startFeature(feature.id, { allowWorkspaceWrite: true })
    await waitFor(() => appServer.calls.find((call) => call.method === 'turn/start'), 'Lead turn was not started')
    await service.handleNotification({ method: 'codexui/appServer/exited', params: { message: 'Codex app-server exited unexpectedly' } })
    releaseTurn?.()
    let snapshot = await store.read()
    assert.equal(snapshot.runs[0].status, 'interrupted')
    assert.equal(snapshot.cards.find((card) => card.id === feature.id).status, 'blocked')
    await assert.rejects(service.handleDynamicToolCall(toolCall('lead-thread', 'comment', { comment: 'Late write' })), /exact active Lead turn/u)
    await assert.rejects(service.startFeature(feature.id), /Confirm workspace-write access/u)
    appServer.rpc = rpc
    await service.startFeature(feature.id, { allowWorkspaceWrite: true })
    await waitFor(() => appServer.calls.filter((call) => call.method === 'turn/start')[1], 'Project lock remained stranded')
    await service.handleNotification({ method: 'turn/completed', params: { threadId: 'lead-thread', turn: { id: 'lead-turn-1', status: 'completed' } } })
    snapshot = await store.read()
    assert.equal(snapshot.runs[0].status, 'running')
    assert.equal(snapshot.runs[1].status, 'interrupted')
    const resume = appServer.calls.find((call) => call.method === 'thread/resume')
    assert.equal(resume.params.approvalPolicy, 'on-request')
    assert.equal(resume.params.sandbox, 'workspace-write')
  }
})
