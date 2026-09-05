import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import type {
  ProjectBoard,
  ProjectBoardAgent,
  ProjectBoardCard,
  ProjectBoardPlanResult,
  ProjectBoardSnapshot,
} from '../types/projectBoards'
import { ProjectBoardStore } from './projectBoardStore'

type RpcClient = {
  rpc: (method: string, params: unknown) => Promise<unknown>
  publishLocalNotification: (method: string, params: unknown) => void
}

type ProjectBoardServiceOptions = {
  store: ProjectBoardStore
  appServer: RpcClient
  prepareThreadStartParams?: (params: unknown) => Record<string, unknown>
}

type ActiveFeatureRun = {
  runId: string
  featureId: string
  boardId: string
  projectPath: string
  threadId: string
  turnId: string
  responseText: string
  error: string
  workspaceWrite: boolean
  finishing: boolean
}

const MAX_AUTO_CONTINUATIONS = 3

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readThreadId(payload: unknown): string {
  const record = asRecord(payload)
  return readString(asRecord(record?.thread)?.id) || readString(record?.threadId)
}

function readTurnId(payload: unknown): string {
  const record = asRecord(payload)
  return readString(asRecord(record?.turn)?.id) || readString(record?.turnId)
}

function dynamicToolText(text: string): { contentItems: Array<{ type: 'inputText'; text: string }>; success: boolean } {
  return { contentItems: [{ type: 'inputText', text }], success: true }
}

function appendDeveloperInstructions(paramsValue: unknown, instructions: string): Record<string, unknown> {
  const params = asRecord(paramsValue) ?? {}
  const currentTools = Array.isArray(params.dynamicTools) ? params.dynamicTools : []
  const tools = currentTools.filter((entry) => asRecord(entry)?.name !== 'project_board_update')
  return {
    ...params,
    dynamicTools: [...tools, PROJECT_BOARD_DYNAMIC_TOOL_SPEC],
    developerInstructions: [readString(params.developerInstructions), instructions].filter(Boolean).join('\n\n'),
  }
}

function roleLabel(agent: ProjectBoardAgent): string {
  return `${agent.name} (${agent.role}, ${agent.sandbox}) — id: ${agent.id}`
}

function featureContext(
  snapshot: ProjectBoardSnapshot,
  board: ProjectBoard,
  feature: ProjectBoardCard,
): Record<string, unknown> {
  const roster = snapshot.agents.filter((agent) => board.agentIds.includes(agent.id))
  const tasks = snapshot.cards.filter((card) => card.parentCardId === feature.id)
  const taskIds = new Set(tasks.map((task) => task.id))
  return {
    board: {
      id: board.id,
      name: board.name,
      projectPath: board.projectPath,
      autoDispatch: board.autoDispatch,
    },
    feature,
    tasks,
    agents: roster.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      instructions: agent.instructions,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      sandbox: agent.sandbox,
    })),
    questions: snapshot.questions.filter((question) =>
      question.cardId === feature.id || taskIds.has(question.cardId),
    ),
    comments: snapshot.comments.filter((comment) =>
      comment.cardId === feature.id || taskIds.has(comment.cardId),
    ).slice(0, 50),
    artifacts: snapshot.artifacts.filter((artifact) =>
      artifact.cardId === feature.id || taskIds.has(artifact.cardId),
    ).slice(0, 100),
  }
}

function buildCoordinatorInstructions(agent: ProjectBoardAgent): string {
  return [
    `Current coordinator profile ID: ${agent.id}. Apply this exact profile's full instructions from the current durable context and read_context result. This assignment and these board instructions supersede earlier coordinator profiles and board instructions in this chat. Other roster profiles are available for delegation; their instructions are not your own.`,
    'Your profile is coordinating this CodexUI project-board feature. Lead is an assignment for this run: any reusable agent profile can coordinate work, including profiles normally used as specialists.',
    'The project board is the durable source of truth. Chat status and turn completion are not proof that work is done.',
    'Use the project_board_update tool for every plan, handoff, task transition, question, artifact, and final feature transition.',
    'Assign each planned task to an exact agentId from the roster; role labels are descriptive and do not select a unique agent. Set taskPurpose to work or verification according to the task, not the profile role.',
    'Use Codex native subagents when separate context or specialist work is useful. Include the selected profile instructions and complete task context when delegating because child agents begin with fresh context. Use the profile model and reasoningEffort where native delegation supports those overrides; do not claim unsupported settings were applied.',
    'Any delegated agent may coordinate further native subagents when the runtime permits it. Keep delegation within the runtime concurrency and depth limits. Only this coordinating thread updates the durable board; children return concrete handoffs to it.',
    'The coordinator and native subagents share the thread sandbox. Agent role instructions are guidance, not separate filesystem permissions. Delegate read-only research in parallel when useful, and never run concurrent writers in this project.',
    'A subagent cannot ask the user directly. If any specialist needs a decision, call project_board_update with action ask_user, then stop this turn.',
    'Before starting a task, ensure its dependencies are done. Call start_task, delegate or perform the work, then call complete_task with a concrete summary and artifacts, or block_task with a precise reason.',
    'Keep the task graph and tests small. Validate at the larger feature boundary when implementation tasks are independent; do not add tests after every small task. Run earlier checks only when a dependent task needs that evidence.',
    'For self verification, include meaningful combined verification in the work handoff. For independent verification, create one task with taskPurpose verification after and dependent on all work tasks, then obtain a fresh delegated review with concrete checks against the acceptance criteria. Any suitable profile can verify, including the same reusable profile in a separate run; a different profile name alone is not independent evidence. For batch verification, leave the completed feature in Review; batch execution is currently manual.',
    'Do not deploy, merge, publish, or perform another external side effect unless the feature explicitly authorizes it.',
  ].filter(Boolean).join('\n\n')
}

function buildFeaturePrompt(
  snapshot: ProjectBoardSnapshot,
  board: ProjectBoard,
  feature: ProjectBoardCard,
  continuation: boolean,
): string {
  const roster = snapshot.agents.filter((agent) => board.agentIds.includes(agent.id))
  const context = featureContext(snapshot, board, feature)
  return [
    continuation
      ? 'Continue orchestrating this feature from its durable board state.'
      : 'Plan and carry out this feature using the durable project board.',
    `Feature: ${feature.title}`,
    feature.description ? `Brief:\n${feature.description}` : '',
    feature.acceptanceCriteria ? `Acceptance criteria:\n${feature.acceptanceCriteria}` : '',
    `Verification policy: ${feature.verificationPolicy}`,
    `Available reusable agent profiles:\n${roster.map(roleLabel).join('\n')}`,
    'First call project_board_update with read_context. If there is no plan, create the smallest useful task graph with replace_plan. Then execute ready tasks, using native subagents where their independent context or specialist review is useful.',
    'When all required tasks are complete, call finish_feature with a concise summary. If a human decision is required, call ask_user once with one focused question.',
    `Current durable context:\n${JSON.stringify(context)}`,
  ].filter(Boolean).join('\n\n')
}

function planFromArguments(args: Record<string, unknown>): ProjectBoardPlanResult {
  const plan = asRecord(args.plan) ?? args
  return {
    summary: readString(plan.summary),
    tasks: Array.isArray(plan.tasks) ? plan.tasks.map((value) => {
      const task = asRecord(value) ?? {}
      return {
        key: readString(task.key),
        title: readString(task.title),
        description: readString(task.description),
        acceptanceCriteria: readString(task.acceptanceCriteria),
        agentId: task.agentId === undefined ? undefined : readString(task.agentId),
        taskPurpose: (task.taskPurpose === undefined ? undefined : readString(task.taskPurpose)) as ProjectBoardPlanResult['tasks'][number]['taskPurpose'],
        agentRole: (readString(task.agentRole) || undefined) as ProjectBoardPlanResult['tasks'][number]['agentRole'],
        dependsOn: Array.isArray(task.dependsOn)
          ? task.dependsOn.map((value) => readString(value)).filter(Boolean)
          : [],
      }
    }) : [],
  }
}

function cardTerminalStatus(card: ProjectBoardCard): boolean {
  return card.status === 'done' || card.status === 'review' || card.status === 'needs_input' || card.status === 'blocked'
}

export const PROJECT_BOARD_DYNAMIC_TOOL_SPEC = {
  name: 'project_board_update',
  description: 'Read and update the durable CodexUI project board for the feature this chat coordinates. Use this for plans, task handoffs, questions, artifacts, and completion.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: [
          'read_context',
          'replace_plan',
          'start_task',
          'complete_task',
          'block_task',
          'ask_user',
          'attach_artifact',
          'comment',
          'finish_feature',
        ],
      },
      taskId: { type: 'string' },
      cardId: { type: 'string' },
      summary: { type: 'string' },
      blocker: { type: 'string' },
      question: { type: 'string' },
      comment: { type: 'string' },
      artifact: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['path'],
      },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
      plan: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'title', 'description', 'acceptanceCriteria', 'agentId', 'taskPurpose', 'dependsOn'],
              properties: {
                key: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                acceptanceCriteria: { type: 'string' },
                agentId: { type: 'string', description: 'Exact ID of the assigned reusable profile from the board roster.' },
                taskPurpose: { type: 'string', enum: ['work', 'verification'] },
                dependsOn: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        required: ['summary', 'tasks'],
      },
    },
  },
} satisfies Record<string, unknown>

export class ProjectBoardService {
  private readonly store: ProjectBoardStore
  private readonly appServer: RpcClient
  private readonly prepareThreadStartParams: (params: unknown) => Record<string, unknown>
  private readonly activeRunsById = new Map<string, ActiveFeatureRun>()
  private readonly workspaceWriteByFeatureId = new Map<string, boolean>()
  private processGeneration = 0
  private readonly activeFeatureIds = new Set<string>()
  private readonly activeProjectPaths = new Set<string>()
  private readonly autoContinuationsByFeatureId = new Map<string, number>()

  constructor(options: ProjectBoardServiceOptions) {
    this.store = options.store
    this.appServer = options.appServer
    this.prepareThreadStartParams = options.prepareThreadStartParams ?? ((params) => asRecord(params) ?? {})
  }

  async start(): Promise<void> {
    this.publish(await this.store.recoverInterruptedRuns())
  }

  read(): Promise<ProjectBoardSnapshot> {
    return this.store.read()
  }

  async ensureDefaultBoard(input: unknown): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.ensureDefaultBoard(input))
  }

  async createBoard(input: unknown): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.createBoard(input))
  }

  async updateBoard(id: string, changes: unknown): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.updateBoard(id, changes))
  }

  async deleteBoard(id: string): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.deleteBoard(id))
  }

  async createAgent(input: unknown): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.createAgent(input))
  }

  async updateAgent(id: string, changes: unknown): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.updateAgent(id, changes))
  }

  async deleteAgent(id: string): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.deleteAgent(id))
  }

  async createCard(input: unknown): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.createCard(input))
  }

  async updateCard(id: string, changes: unknown): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.updateCard(id, changes))
  }

  async deleteCard(id: string): Promise<ProjectBoardSnapshot> {
    return this.publish(await this.store.deleteCard(id))
  }

  async addComment(cardId: string, input: unknown): Promise<ProjectBoardSnapshot> {
    const record = asRecord(input) ?? {}
    return this.publish(await this.store.addComment(cardId, record.text, record.author))
  }

  async answerQuestion(questionId: string, input: unknown): Promise<ProjectBoardSnapshot> {
    const record = asRecord(input) ?? {}
    const before = await this.store.read()
    const wasOpen = before.questions.some((question) => question.id === questionId && question.status === 'open')
    const snapshot = this.publish(await this.store.answerQuestion(questionId, record.answer))
    const answered = snapshot.questions.find((question) => question.id === questionId)
    const card = snapshot.cards.find((entry) => entry.id === answered?.cardId)
    const feature = card?.type === 'feature'
      ? card
      : snapshot.cards.find((entry) => entry.id === card?.parentCardId)
    const board = snapshot.boards.find((entry) => entry.id === feature?.boardId)
    if (wasOpen && feature && board?.autoDispatch && !this.activeFeatureIds.has(feature.id)) {
      this.queueContinuation(feature.id)
    }
    return snapshot
  }

  startFeature(featureId: string, input: unknown = {}): Promise<ProjectBoardSnapshot> {
    return this.startFeatureRun(featureId, false, asRecord(input)?.allowWorkspaceWrite === true)
  }

  private async startFeatureRun(featureId: string, continuation: boolean, allowWorkspaceWrite: boolean): Promise<ProjectBoardSnapshot> {
    const generation = this.processGeneration
    const snapshot = await this.store.read()
    const feature = snapshot.cards.find((card) => card.id === featureId)
    const board = snapshot.boards.find((entry) => entry.id === feature?.boardId)
    if (!feature || !board) throw new Error('Feature or board not found.')
    if (feature.type !== 'feature') throw new Error('Only features can start a Lead run. QA-batch execution is not available yet.')
    let projectPath: string
    try {
      projectPath = await realpath(board.projectPath)
      if (!(await stat(projectPath)).isDirectory()) throw new Error('Not a directory')
    } catch {
      throw new Error('Project folder is unavailable. Choose an existing directory before starting.')
    }
    if (generation !== this.processGeneration) throw new Error('Codex app-server exited. Select Start to retry this feature.')
    if (this.activeFeatureIds.has(featureId)) throw new Error('This feature is already running.')
    if (this.activeProjectPaths.has(projectPath)) {
      throw new Error('Another feature is running in this project. Let it finish before starting this one.')
    }
    const roster = snapshot.agents.filter((agent) => board.agentIds.includes(agent.id))
    const workspaceWrite = roster.some((agent) => agent.sandbox === 'workspace-write')
    if (workspaceWrite && !allowWorkspaceWrite) {
      throw new Error('Confirm workspace-write access before starting. The Lead and all native subagents share permission to edit project files.')
    }
    const assignedAgent = roster.find((agent) => agent.id === feature.assignedAgentId)
    if (feature.assignedAgentId && !assignedAgent) {
      throw new Error('Enable the assigned agent on this board or choose another Lead.')
    }
    const lead = assignedAgent ?? roster.find((agent) => agent.role === 'lead') ?? roster[0]
    if (!lead) throw new Error('Add an agent to this board before starting.')

    this.activeFeatureIds.add(feature.id)
    this.activeProjectPaths.add(projectPath)
    try {
      const { snapshot: startedSnapshot, run } = await this.store.startRun(feature.id, lead.id, 'execute')
      if (generation !== this.processGeneration) {
        this.publish(await this.store.failRun(run.id, 'Codex app-server exited while this run was starting.', 'interrupted'))
        throw new Error('Codex app-server exited. Select Start to retry this feature.')
      }
      if (!continuation) this.autoContinuationsByFeatureId.delete(feature.id)
      this.workspaceWriteByFeatureId.set(feature.id, allowWorkspaceWrite)
      const context: ActiveFeatureRun = {
        runId: run.id,
        featureId: feature.id,
        boardId: board.id,
        projectPath,
        threadId: '',
        turnId: '',
        responseText: '',
        error: '',
        workspaceWrite,
        finishing: false,
      }
      this.activeRunsById.set(run.id, context)
      this.publish(startedSnapshot)
      void this.executeFeature(context, continuation)
      return startedSnapshot
    } catch (error) {
      this.activeFeatureIds.delete(feature.id)
      this.activeProjectPaths.delete(projectPath)
      throw error
    }
  }

  async handleDynamicToolCall(paramsValue: unknown): Promise<unknown> {
    const params = asRecord(paramsValue) ?? {}
    const args = asRecord(params.arguments) ?? {}
    const threadId = readString(params.threadId)
    const action = readString(args.action)
    if (!threadId) throw new Error('A Lead thread ID is required.')
    const snapshot = await this.store.read()
    const feature = snapshot.cards.find((card) => card.threadId === threadId && card.type === 'feature')
    const board = snapshot.boards.find((entry) => entry.id === feature?.boardId)
    if (!feature || !board) throw new Error('This chat is not attached to a project-board feature.')
    if (action === 'read_context') {
      return dynamicToolText(JSON.stringify(featureContext(snapshot, board, feature)))
    }
    const activeRun = [...this.activeRunsById.values()].find((run) => run.threadId === threadId)
    if (!activeRun || activeRun.finishing || activeRun.featureId !== feature.id
      || !activeRun.turnId || readString(params.turnId) !== activeRun.turnId) {
      throw new Error('Board updates require the exact active Lead turn. Start or resume the feature from its board.')
    }
    const runId = activeRun.runId
    if (action === 'replace_plan') {
      const next = this.publish(await this.store.replacePlan(feature.id, planFromArguments(args), runId))
      const tasks = next.cards.filter((card) => card.parentCardId === feature.id)
        .map(({ id, title, assignedAgentId, taskPurpose, dependencyIds }) => ({ id, title, assignedAgentId, taskPurpose, dependencyIds }))
      return dynamicToolText(JSON.stringify({ message: `Saved ${String(tasks.length)} tasks to the durable board.`, tasks }))
    }

    const taskId = readString(args.taskId)
    if (action === 'start_task' || action === 'complete_task' || action === 'block_task') {
      if (!taskId) throw new Error('taskId is required.')
      const transition = action === 'start_task' ? 'start' : action === 'complete_task' ? 'complete' : 'block'
      this.publish(await this.store.updateTaskFromAgent(feature.id, taskId, transition, args, runId))
      return dynamicToolText(action === 'start_task' ? 'Task marked working.' : action === 'complete_task' ? 'Task handoff saved as done.' : 'Task marked blocked.')
    }
    if (action === 'ask_user') {
      const cardId = readString(args.cardId) || taskId || feature.id
      const prompt = readString(args.question).slice(0, 5_000)
      const next = this.publish(await this.store.askQuestion(feature.id, cardId, prompt, runId))
      const question = next.questions.find((entry) => entry.cardId === cardId && entry.status === 'open' && entry.prompt === prompt)
      if (!question) throw new Error('The saved board question could not be found.')
      this.appServer.publishLocalNotification('codexui/projectBoards/attention', {
        boardId: board.id,
        projectPath: board.projectPath,
        featureId: feature.id,
        cardId,
        questionId: question.id,
        title: feature.title,
        message: question.prompt,
      })
      return dynamicToolText('Question saved. Stop this turn and wait for the user to answer from the board.')
    }
    if (action === 'attach_artifact') {
      const cardId = readString(args.cardId) || taskId || feature.id
      this.publish(await this.store.attachArtifact(feature.id, cardId, args.artifact, runId))
      return dynamicToolText('Artifact attached to the board.')
    }
    if (action === 'comment') {
      const cardId = readString(args.cardId) || taskId || feature.id
      this.publish(await this.store.addComment(cardId, args.comment, 'Lead', runId, feature.id))
      return dynamicToolText('Comment added to the board.')
    }
    if (action === 'finish_feature') {
      this.publish(await this.store.finishFeature(feature.id, args.summary, runId))
      return dynamicToolText(feature.verificationPolicy === 'batch' ? 'Feature is ready for batch QA.' : 'Feature marked done.')
    }
    throw new Error(`Unsupported project board action: ${action || '(missing)'}`)
  }

  async handleNotification(notification: { method: string; params: unknown }): Promise<void> {
    const params = asRecord(notification.params)
    if (notification.method === 'codexui/appServer/exited') {
      this.processGeneration += 1
      this.workspaceWriteByFeatureId.clear()
      this.autoContinuationsByFeatureId.clear()
      const contexts = [...this.activeRunsById.values()]
      for (const context of contexts) context.finishing = true
      const results = await Promise.allSettled(contexts.map(async (context) => {
        try {
          this.publish(await this.store.failRun(context.runId, readString(params?.message) || 'Codex app-server exited.', 'interrupted'))
        } finally {
          this.releaseContext(context)
        }
      }))
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      return
    }
    const threadId = readString(params?.threadId)
    const context = [...this.activeRunsById.values()].find((run) => run.threadId === threadId)
    if (!context || context.finishing) return

    const notificationTurnId = readTurnId(notification.params)
    if (notification.method === 'turn/started' && !context.turnId) {
      context.turnId = notificationTurnId
      return
    }
    if (!context.turnId || notificationTurnId !== context.turnId) return
    if (notification.method === 'item/agentMessage/delta') {
      if (typeof params?.delta === 'string') context.responseText += params.delta
      return
    }
    if (notification.method === 'item/completed') {
      const item = asRecord(params?.item)
      if (item?.type === 'agentMessage' && typeof item.text === 'string') context.responseText = item.text
      return
    }
    if (notification.method === 'error') {
      context.error = readString(asRecord(params?.error)?.message) || 'Codex reported an error.'
      return
    }
    if (notification.method === 'turn/plan/updated') {
      const plan = Array.isArray(params?.plan) ? params.plan : []
      const activeStep = plan.map(asRecord).find((entry) => entry?.status === 'inProgress')
      const step = readString(activeStep?.step)
      if (step) this.publish(await this.store.updateFeatureRuntime(context.featureId, { progressNote: step }))
      return
    }
    if (notification.method !== 'turn/completed') return

    const turn = asRecord(params?.turn)
    context.error ||= readString(asRecord(turn?.error)?.message)
    await this.finishFeatureTurn(context, readString(turn?.status) || 'failed')
  }

  private async executeFeature(context: ActiveFeatureRun, continuation: boolean): Promise<void> {
    const assertActive = () => {
      if (this.activeRunsById.get(context.runId) !== context || context.finishing) throw new Error('The Lead run was interrupted.')
    }
    try {
      let snapshot = await this.store.read()
      const run = snapshot.runs.find((entry) => entry.id === context.runId)
      const feature = snapshot.cards.find((card) => card.id === run?.cardId)
      const board = snapshot.boards.find((entry) => entry.id === feature?.boardId)
      const lead = snapshot.agents.find((agent) => agent.id === run?.agentId)
      if (!run || !feature || !board || !lead) throw new Error('Feature run context is incomplete.')
      assertActive()

      const threadParams = {
        cwd: context.projectPath,
        model: lead.model || null,
        approvalPolicy: 'on-request',
        sandbox: context.workspaceWrite ? 'workspace-write' : 'read-only',
        persistExtendedHistory: true,
        personality: 'pragmatic',
      }
      const preparedThreadParams = appendDeveloperInstructions(
        this.prepareThreadStartParams(threadParams),
        buildCoordinatorInstructions(lead),
      )
      let threadId = feature.threadId
      if (threadId) {
        // Resume supports instruction overrides, but not a new dynamic tool list.
        // Refresh the selected profile while keeping the feature's existing chat.
        await this.appServer.rpc('thread/resume', {
          ...threadParams,
          threadId,
          developerInstructions: preparedThreadParams.developerInstructions,
        })
        assertActive()
      } else {
        const started = await this.appServer.rpc(
          'thread/start',
          preparedThreadParams,
        )
        assertActive()
        threadId = readThreadId(started)
        if (!threadId) throw new Error('Codex did not create a Lead chat.')
      }
      snapshot = this.publish(await this.store.setRunThread(run.id, threadId))
      assertActive()
      if (!feature.threadId) {
        await this.appServer.rpc('thread/name/set', { threadId, name: feature.title }).catch(() => undefined)
        assertActive()
      }
      context.threadId = threadId
      const currentFeature = snapshot.cards.find((card) => card.id === feature.id) ?? feature
      const startedTurn = await this.appServer.rpc('turn/start', {
        threadId,
        clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text: buildFeaturePrompt(snapshot, board, currentFeature, continuation) }],
        // Loaded threads can ignore resume overrides. Application context is a
        // per-turn developer message and preserves the native collaboration mode.
        // Keep long profile instructions in the full durable context: native
        // additional-context fragments are capped at 1,000 tokens each.
        additionalContext: {
          codexui_project_board_coordinator: {
            kind: 'application',
            value: buildCoordinatorInstructions(lead),
          },
        },
        cwd: context.projectPath,
        approvalPolicy: 'on-request',
        sandboxPolicy: context.workspaceWrite
          ? { type: 'workspaceWrite', writableRoots: [], readOnlyAccess: { type: 'fullAccess' }, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
          : { type: 'readOnly', access: { type: 'fullAccess' } },
        model: lead.model || null,
        effort: lead.reasoningEffort,
        serviceTier: null,
        summary: 'auto',
        personality: 'pragmatic',
      })
      if (this.activeRunsById.get(run.id) !== context || context.finishing) return
      const turnId = readTurnId(startedTurn)
      if (!turnId || (context.turnId && context.turnId !== turnId)) throw new Error('Codex did not return the expected Lead turn.')
      context.turnId = turnId
    } catch (error) {
      if (this.activeRunsById.get(context.runId) !== context || context.finishing) return
      context.finishing = true
      try {
        this.publish(await this.store.failRun(context.runId, error instanceof Error ? error.message : 'Feature run failed.'))
      } finally {
        this.workspaceWriteByFeatureId.delete(context.featureId)
        this.releaseContext(context)
      }
    }
  }

  private async finishFeatureTurn(context: ActiveFeatureRun, turnStatus: string): Promise<void> {
    context.finishing = true
    let continueFeature = false
    try {
      if (turnStatus !== 'completed') {
        this.workspaceWriteByFeatureId.delete(context.featureId)
        this.publish(await this.store.failRun(context.runId, context.error || `Codex turn ended with status ${turnStatus}.`, turnStatus === 'interrupted' ? 'interrupted' : 'failed'))
        return
      }
      this.publish(await this.store.completeRun(context.runId, context.responseText))
      const snapshot = this.publish(await this.store.recalculateFeature(context.featureId))
      const feature = snapshot.cards.find((card) => card.id === context.featureId)
      if (!feature || cardTerminalStatus(feature)) {
        this.autoContinuationsByFeatureId.delete(context.featureId)
        if (feature?.status !== 'needs_input') this.workspaceWriteByFeatureId.delete(context.featureId)
        return
      }
      const board = snapshot.boards.find((entry) => entry.id === feature.boardId)
      if (!board?.autoDispatch) return
      const tasks = snapshot.cards.filter((card) => card.parentCardId === feature.id)
      const continuationCount = this.autoContinuationsByFeatureId.get(feature.id) ?? 0
      if (tasks.length === 0 || continuationCount >= MAX_AUTO_CONTINUATIONS) {
        this.publish(await this.store.updateFeatureRuntime(feature.id, {
          status: 'blocked',
          progressNote: tasks.length === 0 ? 'Lead stopped before creating a task plan' : 'Lead stopped making progress; review the feature chat',
        }))
        this.workspaceWriteByFeatureId.delete(feature.id)
        return
      }
      this.autoContinuationsByFeatureId.set(feature.id, continuationCount + 1)
      continueFeature = true
    } finally {
      this.releaseContext(context)
    }
    if (continueFeature) this.queueContinuation(context.featureId)
  }

  private releaseContext(context: ActiveFeatureRun): void {
    if (this.activeRunsById.get(context.runId) !== context) return
    this.activeRunsById.delete(context.runId)
    this.activeFeatureIds.delete(context.featureId)
    this.activeProjectPaths.delete(context.projectPath)
  }

  private queueContinuation(featureId: string): void {
    // Consent belongs to this service session. Answers and restarts cannot grant it.
    const generation = this.processGeneration
    const timer = setTimeout(() => {
      if (generation !== this.processGeneration || !this.workspaceWriteByFeatureId.has(featureId) || this.activeFeatureIds.has(featureId)) return
      void this.startFeatureRun(featureId, true, this.workspaceWriteByFeatureId.get(featureId) === true).catch(async (error) => {
        if (this.activeFeatureIds.has(featureId)) return
        this.publish(await this.store.updateFeatureRuntime(featureId, {
          status: 'blocked',
          progressNote: error instanceof Error ? error.message : 'Feature could not continue.',
        }))
      })
    }, 25)
    timer.unref?.()
  }

  private publish(snapshot: ProjectBoardSnapshot): ProjectBoardSnapshot {
    this.appServer.publishLocalNotification('codexui/projectBoards/updated', snapshot)
    return snapshot
  }
}
