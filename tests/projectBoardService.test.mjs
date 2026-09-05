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
  let nextThread = 1
  return {
    calls,
    notifications,
    async rpc(method, params) {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: nextThread++ === 1 ? 'lead-thread' : `lead-thread-${nextThread - 1}` } }
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

test('any reusable profile can coordinate and a resumed chat uses the current selected profile', async (t) => {
  const { appServer, board, feature, service, store } = await createHarness(t)
  const withCoordinator = await service.createAgent({
    boardId: board.id,
    name: 'Research coordinator', role: 'custom', sandbox: 'read-only',
    instructions: 'Original coordinator instructions.', model: 'research-model', reasoningEffort: 'high',
  })
  const coordinator = withCoordinator.agents.find((agent) => agent.name === 'Research coordinator')
  await service.updateCard(feature.id, { assignedAgentId: coordinator.id })
  const started = await service.startFeature(feature.id, { allowWorkspaceWrite: true })
  assert.equal(started.runs[0].status, 'running')
  assert.equal(started.runs[0].agentId, coordinator.id)
  assert.equal(started.runs[0].requestedModel, 'research-model')
  assert.equal(started.runs[0].requestedReasoningEffort, 'high')

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
  assert.match(threadCall.params.developerInstructions, /any reusable agent profile can coordinate/u)
  assert.match(threadCall.params.developerInstructions, new RegExp(coordinator.id, 'u'))
  assert.match(threadCall.params.developerInstructions, /native subagents/u)
  assert.equal(threadCall.params.model, 'research-model')
  assert.equal(turnCall.params.model, 'research-model')
  assert.equal(turnCall.params.effort, 'high')
  assert.equal(turnCall.params.collaborationMode, undefined)
  assert.equal(turnCall.params.additionalContext.codexui_project_board_coordinator.kind, 'application')
  assert.match(turnCall.params.additionalContext.codexui_project_board_coordinator.value, new RegExp(coordinator.id, 'u'))
  assert.match(turnCall.params.input[0].text, /Original coordinator instructions/u)
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
  const taskSchema = PROJECT_BOARD_DYNAMIC_TOOL_SPEC.inputSchema.properties.plan.properties.tasks.items
  assert.ok(taskSchema.required.includes('agentId'))
  assert.ok(taskSchema.required.includes('taskPurpose'))
  assert.equal('agentRole' in taskSchema.properties, false)
  const contextResult = await service.handleDynamicToolCall(toolCall('lead-thread', 'read_context'))
  const context = JSON.parse(contextResult.contentItems[0].text)
  const profile = context.agents.find((agent) => agent.id === coordinator.id)
  assert.equal(profile.model, 'research-model')
  assert.equal(profile.reasoningEffort, 'high')

  await service.handleNotification({
    method: 'turn/completed',
    params: { threadId: 'lead-thread', turn: { id: 'lead-turn-1', status: 'failed' } },
  })
  await service.updateAgent(coordinator.id, { model: 'edited-profile-model', reasoningEffort: 'low' })
  const historicalRun = (await store.read()).runs.find((run) => run.id === started.runs[0].id)
  assert.equal(historicalRun.requestedModel, 'research-model')
  assert.equal(historicalRun.requestedReasoningEffort, 'high')
  const withReplacement = await service.createAgent({
    boardId: board.id,
    name: 'Replacement coordinator', role: 'custom', sandbox: 'read-only',
    instructions: 'Stale replacement instructions.', model: 'old-model', reasoningEffort: 'low',
  })
  const replacement = withReplacement.agents.find((agent) => agent.name === 'Replacement coordinator')
  await service.updateAgent(replacement.id, {
    instructions: 'Current replacement instructions.', model: 'current-model', reasoningEffort: 'medium',
  })
  await service.updateCard(feature.id, { assignedAgentId: replacement.id })
  await service.updateBoard(board.id, { agentIds: [coordinator.id] })
  await assert.rejects(service.startFeature(feature.id, { allowWorkspaceWrite: true }), /Enable the assigned agent on this board/u)
  await service.updateBoard(board.id, { agentIds: [coordinator.id, replacement.id, 'builtin-engineer'] })
  await service.startFeature(feature.id, { allowWorkspaceWrite: true })
  const resumedTurn = await waitFor(
    () => appServer.calls.filter((call) => call.method === 'turn/start')[1],
    'Replacement coordinator did not resume the feature chat',
  )
  const resume = appServer.calls.find((call) => call.method === 'thread/resume')
  assert.equal(appServer.calls.filter((call) => call.method === 'thread/start').length, 1)
  assert.equal(resume.params.threadId, 'lead-thread')
  assert.equal(resume.params.model, 'current-model')
  assert.equal(resume.params.dynamicTools, undefined)
  assert.match(resume.params.developerInstructions, /scheduled-task tool/u)
  assert.match(resume.params.developerInstructions, new RegExp(replacement.id, 'u'))
  const currentAssignment = resumedTurn.params.additionalContext.codexui_project_board_coordinator
  assert.equal(currentAssignment.kind, 'application')
  assert.match(currentAssignment.value, new RegExp(replacement.id, 'u'))
  assert.match(currentAssignment.value, /supersede earlier coordinator profiles/u)
  assert.doesNotMatch(currentAssignment.value, new RegExp(coordinator.id, 'u'))
  assert.match(resumedTurn.params.input[0].text, /Current replacement instructions/u)
  assert.doesNotMatch(resumedTurn.params.input[0].text, /Stale replacement instructions/u)
  assert.equal(resumedTurn.params.threadId, 'lead-thread')
  assert.equal(resumedTurn.params.model, 'current-model')
  assert.equal(resumedTurn.params.effort, 'medium')
  const resumedRun = (await store.read()).runs[0]
  assert.equal(resumedRun.agentId, replacement.id)
  assert.equal(resumedRun.requestedModel, 'current-model')
  assert.equal(resumedRun.requestedReasoningEffort, 'medium')
})

test('drives plan, dependency handoff, Needs You, answer, QA, and completion through the board tool', async (t) => {
  const { appServer, board, feature, service, store } = await createHarness(t)
  const withBuilder = await service.createAgent({
    boardId: board.id,
    name: 'Custom builder', role: 'custom', sandbox: 'workspace-write', instructions: 'Implement the feature.',
  })
  const builder = withBuilder.agents.find((agent) => agent.name === 'Custom builder')
  const withReviewer = await service.createAgent({
    boardId: board.id,
    name: 'Custom reviewer', role: 'custom', sandbox: 'read-only', instructions: 'Review the feature.',
  })
  const reviewer = withReviewer.agents.find((agent) => agent.name === 'Custom reviewer')
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
          agentId: builder.id,
          taskPurpose: 'work',
          dependsOn: [],
        },
        {
          key: 'qa',
          title: 'Validate project board',
          description: 'Check the implementation against its acceptance criteria.',
          acceptanceCriteria: 'All focused tests pass.',
          agentId: reviewer.id,
          taskPurpose: 'verification',
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
  assert.equal(implementation.assignedAgentId, builder.id)
  assert.equal(implementation.taskPurpose, 'work')
  assert.equal(qa.assignedAgentId, reviewer.id)
  assert.equal(qa.taskPurpose, 'verification')
  assert.deepEqual(qa.dependencyIds, [implementation.id])
  assert.deepEqual(JSON.parse(planResult.contentItems[0].text).tasks, [implementation, qa].map(
    ({ id, title, assignedAgentId, taskPurpose, dependencyIds }) => ({ id, title, assignedAgentId, taskPurpose, dependencyIds }),
  ))
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


test('plans read-only, preserves the reviewed task graph, and applies feature settings on each run', async (t) => {
  const { appServer, feature, store } = await createHarness(t)
  const service = new ProjectBoardService({ store, appServer, resolveExecutionSettings: async (settings) => {
    if (settings.model === 'unavailable') throw new Error('Selected model is unavailable.')
    return { model: settings.model || 'default-model', reasoningEffort: settings.reasoningEffort }
  } })
  await service.updateCard(feature.id, { model: 'feature-model', reasoningEffort: 'low', verificationPolicy: 'self' })
  await service.startFeature(feature.id, { mode: 'plan' })
  const planTurn = await waitFor(() => appServer.calls.find((call) => call.method === 'turn/start'), 'No planning turn')
  assert.equal(planTurn.params.model, 'feature-model')
  assert.equal(planTurn.params.effort, 'low')
  assert.equal(planTurn.params.sandboxPolicy.type, 'readOnly')
  assert.equal(planTurn.params.approvalPolicy, 'never')
  assert.equal(service.isPlanningThread('lead-thread'), true)
  assert.match(planTurn.params.input[0].text, /Plan this feature only/u)
  assert.deepEqual(appServer.calls.find((call) => call.method === 'thread/start').params.dynamicTools.map((tool) => tool.name), ['project_board_update'])
  await service.handleDynamicToolCall(toolCall('lead-thread', 'replace_plan', { plan: { summary: 'One deliberate implementation.', tasks: [
    { key: 'build', title: 'Build once', description: 'Implement the reviewed plan.', acceptanceCriteria: 'Works.', agentId: 'builtin-engineer', taskPurpose: 'work', dependsOn: [] },
  ] } }))
  const task = (await store.read()).cards.find((card) => card.parentCardId === feature.id)
  await assert.rejects(service.handleDynamicToolCall(toolCall('lead-thread', 'start_task', { taskId: task.id })), /read-only planning run/u)
  await assert.rejects(service.updateCard(feature.id, { model: 'other-model' }), /run to stop/u)
  await assert.rejects(service.updateCard(feature.id, { description: 'A different scope while planning.' }), /run to stop/u)
  await service.handleNotification({ method: 'turn/completed', params: { threadId: 'lead-thread', turn: { id: 'lead-turn-1', status: 'completed' } } })
  let snapshot = await store.read()
  assert.equal(snapshot.cards.find((card) => card.id === feature.id).planStatus, 'ready')
  assert.equal(snapshot.runs[0].requestedModel, 'feature-model')
  assert.equal(snapshot.runs[0].requestedReasoningEffort, 'low')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id).status, 'backlog')
  assert.equal(appServer.calls.filter((call) => call.method === 'turn/start').length, 1)
  await service.updateCard(feature.id, { model: 'unavailable' })
  await assert.rejects(service.startFeature(feature.id, { allowWorkspaceWrite: true }), /unavailable/u)
  assert.equal((await store.read()).runs.length, 1)
  await service.updateCard(feature.id, { model: '', reasoningEffort: '' })
  await service.startFeature(feature.id, { allowWorkspaceWrite: true })
  const execution = await waitFor(() => appServer.calls.filter((call) => call.method === 'turn/start')[1], 'No execution turn')
  assert.equal(execution.params.model, 'default-model')
  assert.equal(execution.params.effort, 'high')
  assert.equal(execution.params.sandboxPolicy.type, 'workspaceWrite')
  assert.equal(service.isPlanningThread('lead-thread'), false)
  assert.equal(appServer.calls.filter((call) => call.method === 'thread/start').length, 1)
  snapshot = await store.read()
  assert.equal(snapshot.cards.find((card) => card.parentCardId === feature.id).id, task.id)
  assert.equal(snapshot.runs[0].requestedModel, 'default-model')
  assert.equal(snapshot.runs[0].requestedReasoningEffort, 'high')
  assert.equal(snapshot.runs[1].requestedModel, 'feature-model')
  assert.equal(snapshot.runs[1].requestedReasoningEffort, 'low')
  await service.handleNotification({ method: 'turn/completed', params: { threadId: 'lead-thread', turn: { id: 'lead-turn-2', status: 'interrupted' } } })
})

test('imports a plan into linked feature cards once, scopes planner authority, and preserves unrelated work on failure', async (t) => {
  const { appServer, board, feature, service, store } = await createHarness(t)
  await service.startBoardPlan(board.id, { plan: 'Build a foundation, then the interface.', sourceThreadId: 'ordinary-chat', coordinatorAgentId: 'builtin-product', model: 'planner-model', reasoningEffort: 'low' }, 'User and assistant agreed on a small release.')
  const turn = await waitFor(() => appServer.calls.find((call) => call.method === 'turn/start'), 'No board planner')
  assert.equal(turn.params.sandboxPolicy.type, 'readOnly')
  assert.match(turn.params.input[0].text, /incomplete context from the linked planning chat/u)
  assert.equal(await service.isManagedThread('ordinary-chat'), false)
  assert.equal(await service.isManagedThread('lead-thread'), true)
  await assert.rejects(service.handleDynamicToolCall(toolCall('ordinary-chat', 'save_features')), /not attached/u)
  await assert.rejects(service.handleDynamicToolCall(toolCall('lead-thread', 'finish_feature')), /only save proposed feature cards/u)
  await assert.rejects(service.handleDynamicToolCall({ ...toolCall('lead-thread', 'save_features'), turnId: 'stale-turn' }), /exact active Lead turn/u)
  const features = [
    { key: 'base', title: 'Shared foundation', description: 'Shared types.', acceptanceCriteria: 'Foundation checked.', agentId: 'builtin-engineer', verificationPolicy: 'self', dependsOn: [] },
    { key: 'ui', title: 'Interface', description: 'Reuse the foundation.', acceptanceCriteria: 'Combined behavior checked.', agentId: 'builtin-lead', verificationPolicy: 'independent', dependsOn: ['base'] },
  ]
  const first = await service.handleDynamicToolCall(toolCall('lead-thread', 'save_features', { summary: 'Two features.', features }))
  const second = await service.handleDynamicToolCall(toolCall('lead-thread', 'save_features', { summary: 'Retry.', features }))
  assert.deepEqual(first, second)
  let snapshot = await store.read()
  assert.equal(snapshot.cards.filter((card) => card.type === 'feature').length, 3)
  const base = snapshot.cards.find((card) => card.title === 'Shared foundation')
  const ui = snapshot.cards.find((card) => card.title === 'Interface')
  assert.deepEqual(ui.dependencyIds, [base.id])
  assert.equal(ui.model, '')
  assert.equal(ui.autoRun, false)
  assert.equal(snapshot.boards[0].sourceThreadId, 'ordinary-chat')
  assert.equal(snapshot.runs[0].kind, 'board_plan')
  assert.equal(snapshot.runs[0].requestedModel, turn.params.model)
  assert.equal(snapshot.runs[0].requestedReasoningEffort, turn.params.effort)
  assert.equal(snapshot.runs[0].requestedModel, 'planner-model')
  assert.equal(snapshot.runs[0].requestedReasoningEffort, 'low')
  assert.deepEqual(new Set(snapshot.runs[0].createdCardIds), new Set([base.id, ui.id]))
  await service.handleNotification({ method: 'turn/completed', params: { threadId: 'lead-thread', turn: { id: 'lead-turn-1', status: 'completed' } } })
  await service.startBoardPlan(board.id, { plan: 'Consider an optional follow-up.' })
  await waitFor(() => appServer.calls.filter((call) => call.method === 'turn/start')[1], 'No resumed planner')
  await service.handleNotification({ method: 'turn/completed', params: { threadId: 'lead-thread', turn: { id: 'lead-turn-2', status: 'failed' } } })
  snapshot = await store.read()
  assert.equal(snapshot.runs[0].status, 'failed')
  assert.equal(snapshot.runs[1].requestedModel, 'planner-model')
  assert.equal(snapshot.runs[1].requestedReasoningEffort, 'low')
  assert.equal(snapshot.cards.find((card) => card.id === feature.id).status, 'backlog')
  assert.equal(snapshot.cards.find((card) => card.id === base.id).status, 'backlog')
  assert.equal(snapshot.cards.find((card) => card.id === ui.id).status, 'backlog')
})

test('runs only the approved ready queue and pauses at questions without answer-triggered restart', async (t) => {
  const { appServer, board, feature, service, store } = await createHarness(t)
  await service.updateCard(feature.id, { verificationPolicy: 'self' })
  let snapshot = await service.createCard({ boardId: board.id, title: 'Dependent feature', dependencyIds: [feature.id], verificationPolicy: 'self' })
  const second = snapshot.cards.find((card) => card.title === 'Dependent feature')
  await service.startBoardQueue(board.id, { featureIds: [second.id, feature.id], allowWorkspaceWrite: true })
  await waitFor(() => appServer.calls.find((call) => call.method === 'turn/start'), 'No first queue turn')
  await service.createCard({ boardId: board.id, title: 'Unapproved later feature' })
  await service.handleDynamicToolCall(toolCall('lead-thread', 'replace_plan', { plan: { summary: 'Build.', tasks: [
    { key: 'build', title: 'Build foundation', description: 'Work.', acceptanceCriteria: 'Checked.', agentId: 'builtin-engineer', taskPurpose: 'work', dependsOn: [] },
  ] } }))
  const task = (await store.read()).cards.find((card) => card.parentCardId === feature.id)
  await service.handleDynamicToolCall(toolCall('lead-thread', 'start_task', { taskId: task.id }))
  await service.handleDynamicToolCall(toolCall('lead-thread', 'complete_task', { taskId: task.id, summary: 'Foundation built and checked.' }))
  await service.handleDynamicToolCall(toolCall('lead-thread', 'finish_feature', { summary: 'Foundation ready.' }))
  await service.handleNotification({ method: 'turn/completed', params: { threadId: 'lead-thread', turn: { id: 'lead-turn-1', status: 'completed' } } })
  const nextTurn = await waitFor(() => appServer.calls.filter((call) => call.method === 'turn/start')[1], 'Dependent feature did not start')
  assert.match(nextTurn.params.input[0].text, /Foundation built and checked/u)
  assert.equal((await service.read()).queues[0].currentFeatureId, second.id)
  await service.handleDynamicToolCall({ ...toolCall('lead-thread-2', 'ask_user', { question: 'Choose the final copy.' }), turnId: 'lead-turn-2' })
  await service.handleNotification({ method: 'turn/completed', params: { threadId: 'lead-thread-2', turn: { id: 'lead-turn-2', status: 'completed' } } })
  snapshot = await service.read()
  assert.equal(snapshot.queues[0].status, 'paused')
  await service.answerQuestion(snapshot.questions[0].id, { answer: 'Use concise copy.' })
  await delay(60)
  assert.equal(appServer.calls.filter((call) => call.method === 'turn/start').length, 2)
  await service.startBoardQueue(board.id, { featureIds: [second.id], allowWorkspaceWrite: true })
  await waitFor(() => appServer.calls.filter((call) => call.method === 'turn/start')[2], 'Queue did not resume explicitly')
  await service.stopBoardQueue(board.id)
  assert.equal((await service.read()).queues[0].status, 'paused')
  await service.handleNotification({ method: 'codexui/appServer/exited', params: {} })
  assert.equal((await store.read()).cards.find((card) => card.title === 'Unapproved later feature').threadId, '')

  let resolveSettings
  let pendingSettings = true
  const raceService = new ProjectBoardService({ store, appServer, resolveExecutionSettings: async (settings) => {
    if (pendingSettings) return new Promise((resolve) => { resolveSettings = () => resolve(settings) })
    return settings
  } })
  const pendingQueue = raceService.startBoardQueue(board.id, { featureIds: [second.id], allowWorkspaceWrite: true })
  await waitFor(() => resolveSettings, 'Queue did not reach model lookup')
  await raceService.stopBoardQueue(board.id)
  await assert.rejects(raceService.startBoardQueue(board.id, { featureIds: [second.id], allowWorkspaceWrite: true }), /still settling/u)
  resolveSettings()
  await pendingQueue
  assert.equal((await raceService.read()).queues[0].status, 'paused')
  assert.equal((await store.read()).runs.filter((run) => run.status === 'running').length, 0)
  pendingSettings = false
  await raceService.startBoardQueue(board.id, { featureIds: [second.id], allowWorkspaceWrite: true })
  await waitFor(() => appServer.calls.filter((call) => call.method === 'turn/start')[3], 'Queue retry stayed stranded')
  assert.equal((await raceService.read()).queues[0].status, 'running')
  await raceService.handleNotification({ method: 'codexui/appServer/exited', params: {} })
  pendingSettings = true
  resolveSettings = undefined
  const pendingFeature = raceService.startFeature(second.id, { allowWorkspaceWrite: true })
  await waitFor(() => resolveSettings, 'Feature did not reach model lookup')
  await raceService.updateCard(second.id, { description: 'A revised scope requiring a fresh Start.' })
  resolveSettings()
  await assert.rejects(pendingFeature, /feature changed while starting/u)
  assert.equal((await store.read()).runs.filter((run) => run.status === 'running').length, 0)
})


test('pending automatic continuations respect queue pause, failure, replacement, and board controls', async (t) => {
  for (const scenario of ['pause', 'failure', 'replacement', 'automatic-off', 'automatic-off-standalone']) {
    const { appServer, board, feature, store } = await createHarness(t)
    const pending = new Map()
    let lookups = 0
    const service = new ProjectBoardService({ store, appServer, resolveExecutionSettings: async (settings) => {
      const lookup = ++lookups
      if (lookup === 2 || (scenario === 'replacement' && lookup === 3)) {
        return new Promise((resolve, reject) => pending.set(lookup, { resolve: () => resolve(settings), reject }))
      }
      return settings
    } })
    if (scenario === 'automatic-off-standalone') await service.startFeature(feature.id, { allowWorkspaceWrite: true })
    else await service.startBoardQueue(board.id, { featureIds: [feature.id], allowWorkspaceWrite: true })
    await waitFor(() => appServer.calls.find((call) => call.method === 'turn/start'), 'First queue turn did not start')
    await service.handleDynamicToolCall(toolCall('lead-thread', 'replace_plan', { plan: { summary: 'Work remains.', tasks: [
      { key: 'work', title: 'Remaining work', description: 'Continue the implementation.', acceptanceCriteria: 'Work checked.', agentId: 'builtin-engineer', taskPurpose: 'work', dependsOn: [] },
    ] } }))
    await service.handleNotification({ method: 'turn/completed', params: { threadId: 'lead-thread', turn: { id: 'lead-turn-1', status: 'completed' } } })
    await waitFor(() => pending.has(2), 'Automatic continuation did not reach model lookup')
    if (scenario.startsWith('automatic-off')) {
      await service.updateBoard(board.id, { autoDispatch: false })
      pending.get(2).resolve()
      await delay(60)
      const state = await service.read()
      assert.equal(appServer.calls.filter((call) => call.method === 'turn/start').length, 1)
      assert.equal(state.cards.find((card) => card.id === feature.id).status, 'backlog')
      assert.equal(state.runs.filter((run) => run.status === 'running').length, 0)
      if (scenario === 'automatic-off') assert.equal(state.queues[0].status, 'paused')
    } else if (scenario === 'failure') {
      pending.get(2).reject(new Error('Selected model became unavailable.'))
      await waitFor(() => appServer.notifications.some((notification) => notification.method === 'codexui/projectBoards/updated'
        && notification.params.cards.some((card) => card.id === feature.id && card.status === 'blocked')), 'Continuation failure was not recorded')
      const state = await service.read()
      assert.equal(state.queues[0].status, 'paused')
      assert.match(state.queues[0].reason, /model became unavailable/u)
      assert.equal(state.runs.filter((run) => run.status === 'running').length, 0)
    } else {
      await service.stopBoardQueue(board.id)
      if (scenario === 'pause') {
        pending.get(2).resolve()
        await delay(60)
        const state = await service.read()
        assert.equal(appServer.calls.filter((call) => call.method === 'turn/start').length, 1)
        assert.equal(state.queues[0].status, 'paused')
        assert.equal(state.runs.filter((run) => run.status === 'running').length, 0)
      } else {
        const replacement = service.startBoardQueue(board.id, { featureIds: [feature.id], allowWorkspaceWrite: true })
        await waitFor(() => pending.has(3), 'Replacement queue did not reach model lookup')
        pending.get(2).reject(new Error('Stale continuation failed after replacement.'))
        await delay(60)
        let state = await service.read()
        assert.equal(state.queues[0].status, 'running')
        assert.equal(state.cards.find((card) => card.id === feature.id).status, 'backlog')
        pending.get(3).resolve()
        await replacement
        await waitFor(() => appServer.calls.filter((call) => call.method === 'turn/start')[1], 'Replacement queue was stranded')
        state = await service.read()
        assert.equal(state.queues[0].status, 'running')
        assert.equal(state.runs[0].status, 'running')
      }
    }
    await service.handleNotification({ method: 'codexui/appServer/exited', params: {} })
  }
})
