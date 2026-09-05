import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ProjectBoard,
  ProjectBoardAgent,
  ProjectBoardAgentCreateInput,
  ProjectBoardAgentRole,
  ProjectBoardArtifact,
  ProjectBoardCard,
  ProjectBoardCardCreateInput,
  ProjectBoardComment,
  ProjectBoardCreateInput,
  ProjectBoardPlanResult,
  ProjectBoardPriority,
  ProjectBoardQuestion,
  ProjectBoardRun,
  ProjectBoardRunKind,
  ProjectBoardSnapshot,
  ProjectBoardStatus,
  ProjectBoardVerificationPolicy,
} from '../types/projectBoards'
import type { ReasoningEffort } from '../types/codex'

type ProjectBoardStoreOptions = {
  stateFilePath: string
  now?: () => Date
}

const SCHEMA_VERSION = 1
const MAX_CARDS = 2_000
const MAX_RUNS = 4_000
const MAX_COMMENTS = 8_000
const MAX_ARTIFACTS = 4_000
const MAX_QUESTIONS = 2_000
const STATUSES = new Set<ProjectBoardStatus>([
  'backlog', 'working', 'needs_input', 'review', 'blocked', 'done',
])
const PRIORITIES = new Set<ProjectBoardPriority>(['low', 'normal', 'high', 'urgent'])
const VERIFICATION_POLICIES = new Set<ProjectBoardVerificationPolicy>([
  'none', 'self', 'independent', 'batch',
])
const AGENT_ROLES = new Set<ProjectBoardAgentRole>([
  'lead', 'product', 'design', 'engineering', 'qa', 'custom',
])
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])

const BUILT_IN_AGENT_INPUTS: Array<{
  id: string
  name: string
  role: ProjectBoardAgentRole
  description: string
  instructions: string
  sandbox: 'read-only' | 'workspace-write'
}> = [
  {
    id: 'builtin-lead',
    name: 'Lead',
    role: 'lead',
    description: 'Plans the feature, routes work, and keeps acceptance criteria coherent.',
    instructions: 'Act as the feature lead. Decompose work into the fewest clear tasks, preserve user intent, identify dependencies, and use explicit acceptance criteria. Escalate decisions that materially change scope.',
    sandbox: 'read-only',
  },
  {
    id: 'builtin-product',
    name: 'Product',
    role: 'product',
    description: 'Clarifies the user problem, scope, requirements, and acceptance criteria.',
    instructions: 'Act as a pragmatic product manager. Clarify the problem, scope, edge cases, and measurable acceptance criteria. Prefer concrete decisions over lengthy prose. Do not edit implementation files.',
    sandbox: 'read-only',
  },
  {
    id: 'builtin-design',
    name: 'Design',
    role: 'design',
    description: 'Defines flows, interaction details, states, and accessible UI behavior.',
    instructions: 'Act as a product designer working within the existing design system. Define the smallest coherent interaction, all important empty/loading/error states, responsive behavior, and accessibility expectations. Do not replace established patterns without a reason.',
    sandbox: 'read-only',
  },
  {
    id: 'builtin-engineer',
    name: 'Engineer',
    role: 'engineering',
    description: 'Implements scoped changes and verifies the work it owns.',
    instructions: 'Act as the implementation engineer. Inspect the repository conventions, make the requested change with minimal unrelated edits, add proportionate tests, and report exact files changed and verification performed.',
    sandbox: 'workspace-write',
  },
  {
    id: 'builtin-qa',
    name: 'QA / Validator',
    role: 'qa',
    description: 'Independently checks the result against acceptance criteria.',
    instructions: 'Act as an independent validator. Test the implemented behavior against every acceptance criterion, inspect relevant diffs and failure paths, and report reproducible evidence. Do not silently fix issues; block with precise findings unless the task explicitly permits fixes.',
    sandbox: 'read-only',
  },
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown, maxLength = 20_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((entry) => readString(entry, 200)).filter(Boolean)))
}

function isMissingFileError(error: unknown): boolean {
  return asRecord(error)?.code === 'ENOENT'
}

function normalizeStatus(value: unknown): ProjectBoardStatus {
  const status = readString(value) as ProjectBoardStatus
  return STATUSES.has(status) ? status : 'backlog'
}

function normalizePriority(value: unknown): ProjectBoardPriority {
  const priority = readString(value) as ProjectBoardPriority
  return PRIORITIES.has(priority) ? priority : 'normal'
}

function normalizeVerificationPolicy(value: unknown): ProjectBoardVerificationPolicy {
  const policy = readString(value) as ProjectBoardVerificationPolicy
  return VERIFICATION_POLICIES.has(policy) ? policy : 'self'
}

function normalizeAgentRole(value: unknown): ProjectBoardAgentRole {
  const role = readString(value) as ProjectBoardAgentRole
  return AGENT_ROLES.has(role) ? role : 'custom'
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  const effort = readString(value) as ReasoningEffort
  return REASONING_EFFORTS.has(effort) ? effort : 'high'
}

function builtInAgents(now: Date): ProjectBoardAgent[] {
  const timestamp = now.toISOString()
  return BUILT_IN_AGENT_INPUTS.map((agent) => ({
    ...agent,
    model: '',
    reasoningEffort: 'high',
    builtIn: true,
    createdAtIso: timestamp,
    updatedAtIso: timestamp,
  }))
}

function normalizeAgent(value: unknown): ProjectBoardAgent | null {
  const record = asRecord(value)
  const id = readString(record?.id, 200)
  const name = readString(record?.name, 120)
  if (!record || !id || !name) return null
  return {
    id,
    name,
    role: normalizeAgentRole(record.role),
    description: readString(record.description, 500),
    instructions: readString(record.instructions),
    model: readString(record.model, 200),
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
    sandbox: record.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only',
    builtIn: record.builtIn === true,
    createdAtIso: readString(record.createdAtIso, 100) || new Date(0).toISOString(),
    updatedAtIso: readString(record.updatedAtIso, 100) || new Date(0).toISOString(),
  }
}

function normalizeBoard(value: unknown): ProjectBoard | null {
  const record = asRecord(value)
  const id = readString(record?.id, 200)
  const projectPath = readString(record?.projectPath, 4_000)
  if (!record || !id || !projectPath) return null
  return {
    id,
    projectPath,
    projectName: readString(record.projectName, 200) || projectPath.split('/').filter(Boolean).at(-1) || 'Project',
    name: readString(record.name, 120) || 'Project board',
    isDefault: record.isDefault === true,
    agentIds: readStringArray(record.agentIds),
    autoDispatch: record.autoDispatch !== false,
    maxConcurrentRuns: 1,
    createdAtIso: readString(record.createdAtIso, 100) || new Date(0).toISOString(),
    updatedAtIso: readString(record.updatedAtIso, 100) || new Date(0).toISOString(),
  }
}

function normalizeCard(value: unknown): ProjectBoardCard | null {
  const record = asRecord(value)
  const id = readString(record?.id, 200)
  const boardId = readString(record?.boardId, 200)
  const title = readString(record?.title, 240)
  if (!record || !id || !boardId || !title) return null
  const type = record.type === 'task' || record.type === 'qa_batch' ? record.type : 'feature'
  return {
    id,
    boardId,
    parentCardId: readString(record.parentCardId, 200),
    type,
    title,
    description: readString(record.description),
    acceptanceCriteria: readString(record.acceptanceCriteria),
    status: normalizeStatus(record.status),
    priority: normalizePriority(record.priority),
    verificationPolicy: normalizeVerificationPolicy(record.verificationPolicy),
    assignedAgentId: readString(record.assignedAgentId, 200),
    dependencyIds: readStringArray(record.dependencyIds),
    autoRun: record.autoRun === true,
    threadId: readString(record.threadId, 200),
    lastRunId: readString(record.lastRunId, 200),
    summary: readString(record.summary),
    progressNote: readString(record.progressNote, 1_000),
    createdAtIso: readString(record.createdAtIso, 100) || new Date(0).toISOString(),
    updatedAtIso: readString(record.updatedAtIso, 100) || new Date(0).toISOString(),
    completedAtIso: readString(record.completedAtIso, 100),
  }
}

function normalizeQuestion(value: unknown): ProjectBoardQuestion | null {
  const record = asRecord(value)
  const id = readString(record?.id, 200)
  const boardId = readString(record?.boardId, 200)
  const cardId = readString(record?.cardId, 200)
  const prompt = readString(record?.prompt, 5_000)
  if (!record || !id || !boardId || !cardId || !prompt) return null
  return {
    id,
    boardId,
    cardId,
    runId: readString(record.runId, 200),
    prompt,
    status: record.status === 'answered' ? 'answered' : 'open',
    answer: readString(record.answer, 10_000),
    createdAtIso: readString(record.createdAtIso, 100) || new Date(0).toISOString(),
    answeredAtIso: readString(record.answeredAtIso, 100),
  }
}

function normalizeComment(value: unknown): ProjectBoardComment | null {
  const record = asRecord(value)
  const id = readString(record?.id, 200)
  const boardId = readString(record?.boardId, 200)
  const cardId = readString(record?.cardId, 200)
  const text = readString(record?.text, 10_000)
  if (!record || !id || !boardId || !cardId || !text) return null
  return {
    id,
    boardId,
    cardId,
    runId: readString(record.runId, 200),
    author: readString(record.author, 120) || 'You',
    text,
    createdAtIso: readString(record.createdAtIso, 100) || new Date(0).toISOString(),
  }
}

function normalizeArtifact(value: unknown): ProjectBoardArtifact | null {
  const record = asRecord(value)
  const id = readString(record?.id, 200)
  const cardId = readString(record?.cardId, 200)
  const path = readString(record?.path, 4_000)
  if (!record || !id || !cardId || !path) return null
  return {
    id,
    cardId,
    runId: readString(record.runId, 200),
    label: readString(record.label, 240) || path.split('/').filter(Boolean).at(-1) || 'Artifact',
    path,
    createdAtIso: readString(record.createdAtIso, 100) || new Date(0).toISOString(),
  }
}

function normalizeRun(value: unknown): ProjectBoardRun | null {
  const record = asRecord(value)
  const id = readString(record?.id, 200)
  const boardId = readString(record?.boardId, 200)
  const cardId = readString(record?.cardId, 200)
  if (!record || !id || !boardId || !cardId) return null
  const kind: ProjectBoardRunKind = record.kind === 'plan' ? 'plan' : 'execute'
  const allowedStatuses = new Set(['queued', 'running', 'succeeded', 'failed', 'interrupted'])
  const rawStatus = readString(record.status)
  return {
    id,
    boardId,
    cardId,
    agentId: readString(record.agentId, 200),
    kind,
    status: allowedStatuses.has(rawStatus) ? rawStatus as ProjectBoardRun['status'] : 'failed',
    threadId: readString(record.threadId, 200),
    startedAtIso: readString(record.startedAtIso, 100),
    finishedAtIso: readString(record.finishedAtIso, 100),
    summary: readString(record.summary),
    error: readString(record.error),
  }
}

function emptySnapshot(now: Date): ProjectBoardSnapshot {
  return {
    boards: [],
    cards: [],
    agents: builtInAgents(now),
    questions: [],
    comments: [],
    artifacts: [],
    runs: [],
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    updatedAtIso: now.toISOString(),
  }
}

function normalizeSnapshot(value: unknown, now: Date): ProjectBoardSnapshot {
  const record = asRecord(value)
  if (!record || record.schemaVersion !== SCHEMA_VERSION
    || !['boards', 'cards', 'agents', 'questions', 'comments', 'artifacts', 'runs'].every((field) => Array.isArray(record[field]))) {
    throw new Error('Project board data has an unsupported schema or invalid shape; the saved file was left unchanged.')
  }
  const savedAgents = Array.isArray(record.agents)
    ? record.agents.map(normalizeAgent).filter((agent): agent is ProjectBoardAgent => agent !== null)
    : []
  const builtIns = builtInAgents(now)
  const savedById = new Map(savedAgents.map((agent) => [agent.id, agent]))
  const agents = [
    ...builtIns.map((agent) => savedById.get(agent.id) ?? agent),
    ...savedAgents.filter((agent) => !BUILT_IN_AGENT_INPUTS.some((builtIn) => builtIn.id === agent.id)),
  ]
  const knownAgentIds = new Set(agents.map((agent) => agent.id))
  const fallbackAgentIds = builtIns.map((agent) => agent.id)
  const boards = Array.isArray(record.boards)
    ? record.boards.map(normalizeBoard).filter((board): board is ProjectBoard => board !== null)
      .map((board) => ({
        ...board,
        agentIds: board.agentIds.filter((id) => knownAgentIds.has(id)),
      }))
      .map((board) => ({ ...board, agentIds: board.agentIds.length > 0 ? board.agentIds : fallbackAgentIds }))
    : []
  return {
    boards,
    cards: Array.isArray(record.cards)
      ? record.cards.map(normalizeCard).filter((card): card is ProjectBoardCard => card !== null)
      : [],
    agents,
    questions: Array.isArray(record.questions)
      ? record.questions.map(normalizeQuestion).filter((question): question is ProjectBoardQuestion => question !== null)
      : [],
    comments: Array.isArray(record.comments)
      ? record.comments.map(normalizeComment).filter((comment): comment is ProjectBoardComment => comment !== null)
      : [],
    artifacts: Array.isArray(record.artifacts)
      ? record.artifacts.map(normalizeArtifact).filter((artifact): artifact is ProjectBoardArtifact => artifact !== null)
      : [],
    runs: Array.isArray(record.runs)
      ? record.runs.map(normalizeRun).filter((run): run is ProjectBoardRun => run !== null)
      : [],
    schemaVersion: SCHEMA_VERSION,
    version: typeof record.version === 'number' && Number.isFinite(record.version)
      ? Math.max(1, Math.floor(record.version))
      : 1,
    updatedAtIso: readString(record.updatedAtIso, 100) || now.toISOString(),
  }
}

function cardWithStatus(card: ProjectBoardCard, status: ProjectBoardStatus, now: Date, progressNote = card.progressNote): ProjectBoardCard {
  return {
    ...card,
    status,
    progressNote,
    updatedAtIso: now.toISOString(),
    completedAtIso: status === 'done' ? card.completedAtIso || now.toISOString() : '',
  }
}

function featureCards(snapshot: ProjectBoardSnapshot, card: ProjectBoardCard): ProjectBoardCard[] {
  const featureId = card.parentCardId || card.id
  return snapshot.cards.filter((entry) => entry.id === featureId || entry.parentCardId === featureId)
}

function assertActiveRun(snapshot: ProjectBoardSnapshot, featureId: string, runId: string): void {
  if (runId && !snapshot.runs.some((run) => run.id === runId && run.cardId === featureId && run.status === 'running')) {
    throw new Error('This feature run is no longer active.')
  }
}

function assertManualEdit(snapshot: ProjectBoardSnapshot, card: ProjectBoardCard): void {
  const ids = new Set(featureCards(snapshot, card).map((entry) => entry.id))
  if (snapshot.runs.some((run) => ids.has(run.cardId) && (run.status === 'running' || run.status === 'queued'))) {
    throw new Error('Wait for the feature run to stop before changing its workflow.')
  }
  if (snapshot.questions.some((question) => ids.has(question.cardId) && question.status === 'open')) {
    throw new Error('Answer the open questions before changing this feature.')
  }
}

function dependencyBlocker(snapshot: ProjectBoardSnapshot, card: ProjectBoardCard): string {
  for (const id of card.dependencyIds) {
    const dependency = snapshot.cards.find((entry) => entry.id === id)
    if (!dependency) return `Missing dependency: ${id}`
    if (dependency.status !== 'done') return `Task is waiting for dependency: ${dependency.title}.`
  }
  return ''
}

function qaOrderingBlocker(snapshot: ProjectBoardSnapshot, task: ProjectBoardCard): string {
  const agent = snapshot.agents.find((entry) => entry.id === task.assignedAgentId)
  if (agent?.role !== 'qa') return ''
  const implementation = snapshot.cards.filter((entry) => {
    const owner = snapshot.agents.find((candidate) => candidate.id === entry.assignedAgentId)
    return entry.parentCardId === task.parentCardId && entry.id !== task.id
      && (owner?.role === 'engineering' || (owner?.sandbox === 'workspace-write' && owner.role !== 'qa'))
  })
  if (implementation.some((entry) => !task.dependencyIds.includes(entry.id))) {
    return 'QA must depend on every implementation task.'
  }
  if (task.status === 'done' && implementation.some((entry) =>
    !entry.completedAtIso || !task.completedAtIso || entry.completedAtIso > task.completedAtIso)) {
    return 'QA must be repeated after the latest implementation.'
  }
  return ''
}

function featureCompletionBlocker(snapshot: ProjectBoardSnapshot, feature: ProjectBoardCard): string {
  const cards = featureCards(snapshot, feature)
  if (snapshot.questions.some((question) => question.status === 'open' && cards.some((card) => card.id === question.cardId))) {
    return 'Answer the open questions before finishing this feature.'
  }
  const dependency = dependencyBlocker(snapshot, feature)
  if (dependency) return dependency
  const tasks = cards.filter((card) => card.parentCardId === feature.id)
  if (!tasks.length) return 'Create and complete a task plan before finishing the feature.'
  if (tasks.some((task) => task.status !== 'done')) return 'All required tasks must be done before finishing the feature.'
  for (const task of tasks) {
    const blocker = dependencyBlocker(snapshot, task) || qaOrderingBlocker(snapshot, task)
    if (blocker) return blocker
  }
  if (feature.verificationPolicy === 'independent' && !tasks.some((task) =>
    snapshot.agents.some((agent) => agent.id === task.assignedAgentId && agent.role === 'qa'))) {
    return 'Independent QA task required'
  }
  return ''
}

function assertNoExternalDependencies(snapshot: ProjectBoardSnapshot, removedIds: Set<string>): void {
  const dependent = snapshot.cards.find((card) => !removedIds.has(card.id) && card.dependencyIds.some((id) => removedIds.has(id)))
  if (dependent) throw new Error(`Delete dependent card "${dependent.title}" before deleting or replacing these cards.`)
}

function validatePlanDependencies(result: ProjectBoardPlanResult): void {
  const tasks = Array.isArray(result.tasks) ? result.tasks : []
  if (tasks.length > 30) throw new Error('A feature plan can contain at most 30 tasks.')
  const keys = new Set<string>()
  for (const task of tasks) {
    const key = readString(task.key, 100)
    if (!key || keys.has(key)) throw new Error('The Lead returned duplicate or missing task keys.')
    keys.add(key)
  }
  const dependencies = new Map<string, string[]>()
  for (const task of tasks) {
    const key = readString(task.key, 100)
    const dependsOn = readStringArray(task.dependsOn)
    for (const dependency of dependsOn) {
      if (!keys.has(dependency)) throw new Error(`Task ${key} depends on unknown task ${dependency}.`)
      if (dependency === key) throw new Error(`Task ${key} cannot depend on itself.`)
    }
    dependencies.set(key, dependsOn)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): void => {
    if (visited.has(key)) return
    if (visiting.has(key)) throw new Error('The Lead returned a cyclic task plan.')
    visiting.add(key)
    for (const dependency of dependencies.get(key) ?? []) visit(dependency)
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of keys) visit(key)
}

function buildPlanCards(
  snapshot: ProjectBoardSnapshot,
  feature: ProjectBoardCard,
  board: ProjectBoard,
  result: ProjectBoardPlanResult,
  now: Date,
): ProjectBoardCard[] {
  const rawTasks = Array.isArray(result.tasks) ? result.tasks : []
  if (rawTasks.length === 0) throw new Error('The Lead did not produce any tasks.')
  validatePlanDependencies(result)
  const keyToId = new Map(rawTasks.map((task) => [readString(task.key, 100), randomUUID()]))
  const roster = snapshot.agents.filter((agent) => board.agentIds.includes(agent.id))
  const lead = roster.find((agent) => agent.id === feature.assignedAgentId)
    ?? roster.find((agent) => agent.role === 'lead')
    ?? roster[0]
  const tasks: ProjectBoardCard[] = rawTasks.map((rawTask) => {
    const key = readString(rawTask.key, 100)
    const role = normalizeAgentRole(rawTask.agentRole)
    const agent = roster.find((entry) => entry.role === role) ?? lead
    const dependencyIds = readStringArray(rawTask.dependsOn)
      .map((dependencyKey) => keyToId.get(dependencyKey) ?? '')
      .filter(Boolean)
    return {
      id: keyToId.get(key)!,
      boardId: board.id,
      parentCardId: feature.id,
      type: 'task',
      title: readString(rawTask.title, 240) || key,
      description: readString(rawTask.description),
      acceptanceCriteria: readString(rawTask.acceptanceCriteria),
      status: 'backlog',
      priority: feature.priority,
      verificationPolicy: 'self',
      assignedAgentId: agent?.id ?? '',
      dependencyIds,
      autoRun: true,
      threadId: '',
      lastRunId: '',
      summary: '',
      progressNote: dependencyIds.length > 0 ? 'Waiting for dependencies' : 'Ready to start',
      createdAtIso: now.toISOString(),
      updatedAtIso: now.toISOString(),
      completedAtIso: '',
    }
  })
  const planned = { ...snapshot, cards: [...snapshot.cards.filter((card) => card.parentCardId !== feature.id), ...tasks] }
  for (const task of tasks) {
    const blocker = qaOrderingBlocker(planned, task)
    if (blocker) throw new Error(blocker)
  }
  return tasks
}

function recalculateParent(snapshot: ProjectBoardSnapshot, parentCardId: string, now: Date): ProjectBoardSnapshot {
  if (!parentCardId) return snapshot
  const parent = snapshot.cards.find((card) => card.id === parentCardId)
  if (!parent) return snapshot
  const children = snapshot.cards.filter((card) => card.parentCardId === parentCardId)
  if (children.length === 0) return snapshot

  let status: ProjectBoardStatus = 'backlog'
  let progressNote = `${children.filter((child) => child.status === 'done').length}/${children.length} tasks complete`
  if (snapshot.questions.some((question) => question.status === 'open'
    && (question.cardId === parent.id || children.some((child) => child.id === question.cardId)))) {
    status = 'needs_input'
    progressNote = 'A task needs your input'
  } else if (children.some((child) => child.status === 'blocked')) {
    status = 'blocked'
    progressNote = 'A task is blocked'
  } else if (children.every((child) => child.status === 'done')) {
    const blocker = featureCompletionBlocker(snapshot, parent)
    if (blocker) {
      status = 'blocked'
      progressNote = blocker
    } else {
      status = parent.status === 'done' || parent.status === 'review' ? parent.status : 'working'
      progressNote = status === 'done' ? 'All tasks complete'
        : status === 'review' ? 'Ready for batch QA' : 'Tasks complete; waiting for the Lead to finish'
    }
  } else if (children.some((child) => child.status === 'working' || child.status === 'done')) {
    status = 'working'
  }

  return {
    ...snapshot,
    cards: snapshot.cards.map((card) => card.id === parentCardId ? cardWithStatus(card, status, now, progressNote) : card),
  }
}

export class ProjectBoardStore {
  private readonly stateFilePath: string
  private readonly now: () => Date
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(options: ProjectBoardStoreOptions) {
    this.stateFilePath = options.stateFilePath
    this.now = options.now ?? (() => new Date())
  }

  read(): Promise<ProjectBoardSnapshot> {
    return this.enqueue(() => this.load())
  }

  ensureDefaultBoard(inputValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const input = asRecord(inputValue) ?? {}
      const projectPath = readString(input.projectPath, 4_000)
      if (!projectPath) throw new Error('A project folder is required.')
      if (current.boards.some((board) => board.projectPath === projectPath)) return current
      const now = this.now()
      const board: ProjectBoard = {
        id: randomUUID(),
        projectPath,
        projectName: readString(input.projectName, 200) || projectPath.split('/').filter(Boolean).at(-1) || 'Project',
        name: 'Project board',
        isDefault: true,
        agentIds: current.agents.map((agent) => agent.id),
        autoDispatch: true,
        maxConcurrentRuns: 1,
        createdAtIso: now.toISOString(),
        updatedAtIso: now.toISOString(),
      }
      return { ...current, boards: [board, ...current.boards] }
    })
  }

  createBoard(inputValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const record = asRecord(inputValue) ?? {}
      const input: ProjectBoardCreateInput = {
        projectPath: readString(record.projectPath, 4_000),
        projectName: readString(record.projectName, 200),
        name: readString(record.name, 120),
        isDefault: record.isDefault === true,
      }
      if (!input.projectPath) throw new Error('A project folder is required.')
      const projectBoards = current.boards.filter((board) => board.projectPath === input.projectPath)
      const now = this.now()
      const makeDefault = input.isDefault === true || projectBoards.length === 0
      const board: ProjectBoard = {
        id: randomUUID(),
        projectPath: input.projectPath,
        projectName: input.projectName || input.projectPath.split('/').filter(Boolean).at(-1) || 'Project',
        name: input.name || (projectBoards.length === 0 ? 'Project board' : `Board ${String(projectBoards.length + 1)}`),
        isDefault: makeDefault,
        agentIds: current.agents.map((agent) => agent.id),
        autoDispatch: true,
        maxConcurrentRuns: 1,
        createdAtIso: now.toISOString(),
        updatedAtIso: now.toISOString(),
      }
      return {
        ...current,
        boards: [board, ...current.boards.map((entry) =>
          makeDefault && entry.projectPath === input.projectPath ? { ...entry, isDefault: false } : entry,
        )],
      }
    })
  }

  updateBoard(id: string, changesValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const existing = current.boards.find((board) => board.id === id)
      if (!existing) throw new Error('Project board not found.')
      const changes = asRecord(changesValue) ?? {}
      if ('maxConcurrentRuns' in changes && changes.maxConcurrentRuns !== 1) {
        throw new Error('Project boards currently support one active feature per project.')
      }
      const makeDefault = changes.isDefault === true
      const knownAgentIds = new Set(current.agents.map((agent) => agent.id))
      const agentIds = 'agentIds' in changes
        ? readStringArray(changes.agentIds).filter((agentId) => knownAgentIds.has(agentId))
        : existing.agentIds
      if (agentIds.length === 0) throw new Error('A board must have at least one agent.')
      const now = this.now()
      return {
        ...current,
        boards: current.boards.map((board) => {
          if (makeDefault && board.projectPath === existing.projectPath && board.id !== id) {
            return { ...board, isDefault: false, updatedAtIso: now.toISOString() }
          }
          if (board.id !== id) return board
          return {
            ...board,
            name: 'name' in changes ? readString(changes.name, 120) || existing.name : existing.name,
            isDefault: makeDefault || ('isDefault' in changes ? changes.isDefault === true : existing.isDefault),
            agentIds,
            autoDispatch: 'autoDispatch' in changes ? changes.autoDispatch !== false : existing.autoDispatch,
            maxConcurrentRuns: 1,
            updatedAtIso: now.toISOString(),
          }
        }),
      }
    })
  }

  deleteBoard(id: string): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const board = current.boards.find((entry) => entry.id === id)
      if (!board) throw new Error('Project board not found.')
      if (current.runs.some((run) => run.boardId === id && run.status === 'running')) {
        throw new Error('Stop running work before deleting this board.')
      }
      const boardCardIds = new Set(current.cards.filter((card) => card.boardId === id).map((card) => card.id))
      const replacementId = board.isDefault
        ? current.boards.find((entry) => entry.id !== id && entry.projectPath === board.projectPath)?.id
        : undefined
      const remainingBoards = current.boards
        .filter((entry) => entry.id !== id)
        .map((entry) => entry.id === replacementId ? { ...entry, isDefault: true } : entry)
      return {
        ...current,
        boards: remainingBoards,
        cards: current.cards.filter((card) => card.boardId !== id),
        questions: current.questions.filter((question) => !boardCardIds.has(question.cardId)),
        comments: current.comments.filter((comment) => !boardCardIds.has(comment.cardId)),
        artifacts: current.artifacts.filter((artifact) => !boardCardIds.has(artifact.cardId)),
        runs: current.runs.filter((run) => run.boardId !== id),
      }
    })
  }

  createAgent(inputValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const record = asRecord(inputValue) ?? {}
      const input: ProjectBoardAgentCreateInput = {
        name: readString(record.name, 120),
        role: normalizeAgentRole(record.role),
        description: readString(record.description, 500),
        instructions: readString(record.instructions),
        model: readString(record.model, 200),
        reasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
        sandbox: record.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only',
      }
      if (!input.name || !input.instructions) throw new Error('Agent name and instructions are required.')
      const now = this.now()
      const agent: ProjectBoardAgent = {
        id: randomUUID(),
        name: input.name,
        role: input.role ?? 'custom',
        description: input.description ?? '',
        instructions: input.instructions,
        model: input.model ?? '',
        reasoningEffort: input.reasoningEffort ?? 'high',
        sandbox: input.sandbox ?? 'read-only',
        builtIn: false,
        createdAtIso: now.toISOString(),
        updatedAtIso: now.toISOString(),
      }
      return {
        ...current,
        agents: [...current.agents, agent],
        boards: current.boards.map((board) => ({ ...board, agentIds: [...board.agentIds, agent.id] })),
      }
    })
  }

  updateAgent(id: string, changesValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const existing = current.agents.find((agent) => agent.id === id)
      if (!existing) throw new Error('Agent not found.')
      if (existing.builtIn) throw new Error('Built-in agents are read-only. Create a custom agent instead.')
      const changes = asRecord(changesValue) ?? {}
      const changesRole = 'role' in changes && normalizeAgentRole(changes.role) !== existing.role
      const changesAccess = 'sandbox' in changes && changes.sandbox !== existing.sandbox
      if ((changesRole || changesAccess) && current.cards.some((card) => card.assignedAgentId === id)) {
        throw new Error('Create a new profile to change role or access after an agent has been assigned.')
      }
      const now = this.now()
      return {
        ...current,
        agents: current.agents.map((agent) => agent.id !== id ? agent : {
          ...agent,
          name: 'name' in changes ? readString(changes.name, 120) || agent.name : agent.name,
          role: 'role' in changes ? normalizeAgentRole(changes.role) : agent.role,
          description: 'description' in changes ? readString(changes.description, 500) : agent.description,
          instructions: 'instructions' in changes ? readString(changes.instructions) || agent.instructions : agent.instructions,
          model: 'model' in changes ? readString(changes.model, 200) : agent.model,
          reasoningEffort: 'reasoningEffort' in changes
            ? normalizeReasoningEffort(changes.reasoningEffort)
            : agent.reasoningEffort,
          sandbox: 'sandbox' in changes
            ? changes.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only'
            : agent.sandbox,
          updatedAtIso: now.toISOString(),
        }),
      }
    })
  }

  deleteAgent(id: string): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const existing = current.agents.find((agent) => agent.id === id)
      if (!existing) throw new Error('Agent not found.')
      if (existing.builtIn) throw new Error('Built-in agents cannot be deleted.')
      if (current.cards.some((card) => card.assignedAgentId === id)) {
        throw new Error('Reassign cards before deleting this agent.')
      }
      return {
        ...current,
        agents: current.agents.filter((agent) => agent.id !== id),
        boards: current.boards.map((board) => ({
          ...board,
          agentIds: board.agentIds.filter((agentId) => agentId !== id),
        })),
      }
    })
  }

  createCard(inputValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const record = asRecord(inputValue) ?? {}
      this.assertPublicCardFields(record)
      if ('status' in record && record.status !== 'backlog') throw new Error('New cards must start in Backlog.')
      const input: ProjectBoardCardCreateInput = {
        boardId: readString(record.boardId, 200),
        parentCardId: readString(record.parentCardId, 200),
        type: record.type === 'task' || record.type === 'qa_batch' ? record.type : 'feature',
        title: readString(record.title, 240),
        description: readString(record.description),
        acceptanceCriteria: readString(record.acceptanceCriteria),
        status: normalizeStatus(record.status),
        priority: normalizePriority(record.priority),
        verificationPolicy: normalizeVerificationPolicy(record.verificationPolicy),
        assignedAgentId: readString(record.assignedAgentId, 200),
        dependencyIds: readStringArray(record.dependencyIds),
        autoRun: record.autoRun === true,
      }
      const board = current.boards.find((entry) => entry.id === input.boardId)
      if (!board) throw new Error('Project board not found.')
      if (!input.title) throw new Error('A card title is required.')
      const parent = current.cards.find((card) => card.id === input.parentCardId && card.boardId === board.id && card.type === 'feature')
      if ((input.type === 'task' && !parent) || (input.parentCardId && (input.type !== 'task' || !parent))) {
        throw new Error('Tasks must belong to a feature on this board; other cards cannot be nested.')
      }
      if (parent) assertManualEdit(current, parent)
      if (input.assignedAgentId && !board.agentIds.includes(input.assignedAgentId)) {
        throw new Error('Assigned agent is not enabled for this board.')
      }
      const invalidDependencyId = (input.dependencyIds ?? []).find((dependencyId) =>
        !current.cards.some((card) => card.id === dependencyId && card.boardId === board.id),
      )
      if (invalidDependencyId) throw new Error('Every dependency must already exist on this board.')
      const now = this.now()
      const card: ProjectBoardCard = {
        id: randomUUID(),
        boardId: board.id,
        parentCardId: input.parentCardId ?? '',
        type: input.type ?? 'feature',
        title: input.title,
        description: input.description ?? '',
        acceptanceCriteria: input.acceptanceCriteria ?? '',
        status: input.status ?? 'backlog',
        priority: input.priority ?? 'normal',
        verificationPolicy: input.verificationPolicy ?? 'self',
        assignedAgentId: input.assignedAgentId || board.agentIds[0] || '',
        dependencyIds: input.dependencyIds ?? [],
        autoRun: input.autoRun === true,
        threadId: '',
        lastRunId: '',
        summary: '',
        progressNote: '',
        createdAtIso: now.toISOString(),
        updatedAtIso: now.toISOString(),
        completedAtIso: '',
      }
      let next = { ...current, cards: [card, ...current.cards] }
      const qaBlocker = qaOrderingBlocker(next, card)
      if (qaBlocker) throw new Error(qaBlocker)
      next = recalculateParent(next, card.parentCardId, now)
      return next
    })
  }

  updateCard(id: string, changesValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const existing = current.cards.find((card) => card.id === id)
      if (!existing) throw new Error('Board card not found.')
      const changes = asRecord(changesValue) ?? {}
      this.assertPublicCardFields(changes, true)
      if ('status' in changes && !STATUSES.has(changes.status as ProjectBoardStatus)) throw new Error('Unknown card status.')
      const workflowChange = ['status', 'verificationPolicy', 'assignedAgentId'].some((key) => key in changes)
      if (workflowChange) assertManualEdit(current, existing)
      const board = current.boards.find((entry) => entry.id === existing.boardId)
      if (!board) throw new Error('Project board not found.')
      const assignedAgentId = 'assignedAgentId' in changes
        ? readString(changes.assignedAgentId, 200)
        : existing.assignedAgentId
      if (existing.type === 'task' && existing.status === 'done' && assignedAgentId !== existing.assignedAgentId) {
        throw new Error('Reopen the completed task before changing its agent.')
      }
      if (assignedAgentId && !board.agentIds.includes(assignedAgentId)) {
        throw new Error('Assigned agent is not enabled for this board.')
      }
      const now = this.now()
      let next: ProjectBoardSnapshot = {
        ...current,
        cards: current.cards.map((card) => card.id !== id ? card : cardWithStatus({
          ...card,
          title: 'title' in changes ? readString(changes.title, 240) || card.title : card.title,
          description: 'description' in changes ? readString(changes.description) : card.description,
          acceptanceCriteria: 'acceptanceCriteria' in changes
            ? readString(changes.acceptanceCriteria)
            : card.acceptanceCriteria,
          priority: 'priority' in changes ? normalizePriority(changes.priority) : card.priority,
          verificationPolicy: 'verificationPolicy' in changes
            ? normalizeVerificationPolicy(changes.verificationPolicy)
            : card.verificationPolicy,
          assignedAgentId,
          autoRun: 'autoRun' in changes ? changes.autoRun === true : card.autoRun,
        }, 'status' in changes ? normalizeStatus(changes.status) : card.status, now)),
      }
      const updated = next.cards.find((card) => card.id === id)!
      if (workflowChange) {
        if (updated.status !== existing.status && updated.status === 'needs_input') {
          throw new Error('Needs You is set by a question from the Lead.')
        }
        if (['working', 'review', 'done'].includes(updated.status)) {
          const blocker = dependencyBlocker(next, updated) || qaOrderingBlocker(next, updated)
          if (blocker) throw new Error(blocker)
        }
        if (updated.status === 'done') {
          if (updated.type !== 'feature' && existing.status !== 'done') {
            throw new Error('Task completion requires a recorded agent handoff.')
          }
          if (updated.type === 'feature') {
            const blocker = featureCompletionBlocker(next, updated)
            if (blocker) throw new Error(blocker)
            if (updated.verificationPolicy === 'batch') throw new Error('Batch verification remains in Review until batch QA is available.')
          }
        }
        if (existing.status === 'done' && updated.status !== 'done') {
          const dependent = next.cards.find((card) => card.dependencyIds.includes(id) && ['working', 'done', 'review'].includes(card.status))
          if (dependent) throw new Error(`Reopen dependent card "${dependent.title}" first.`)
        }
      }
      next = recalculateParent(next, existing.parentCardId, now)
      return next
    })
  }

  deleteCard(id: string): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const target = current.cards.find((card) => card.id === id)
      if (!target) throw new Error('Board card not found.')
      assertManualEdit(current, target)
      const ids = new Set([id])
      let changed = true
      while (changed) {
        changed = false
        for (const card of current.cards) {
          if (ids.has(card.parentCardId) && !ids.has(card.id)) {
            ids.add(card.id)
            changed = true
          }
        }
      }
      if (current.runs.some((run) => ids.has(run.cardId) && run.status === 'running')) {
        throw new Error('Stop running work before deleting this card.')
      }
      assertNoExternalDependencies(current, ids)
      let next: ProjectBoardSnapshot = {
        ...current,
        cards: current.cards.filter((card) => !ids.has(card.id)),
        questions: current.questions.filter((question) => !ids.has(question.cardId)),
        comments: current.comments.filter((comment) => !ids.has(comment.cardId)),
        artifacts: current.artifacts.filter((artifact) => !ids.has(artifact.cardId)),
        runs: current.runs.filter((run) => !ids.has(run.cardId)),
      }
      next = recalculateParent(next, target.parentCardId, this.now())
      return next
    })
  }

  addComment(cardId: string, textValue: unknown, authorValue: unknown = 'You', runId = '', featureId = ''): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const card = current.cards.find((entry) => entry.id === cardId)
      const text = readString(textValue, 10_000)
      if (!card) throw new Error('Board card not found.')
      if (runId) {
        if (card.id !== featureId && card.parentCardId !== featureId) throw new Error('Comment card does not belong to this feature.')
        assertActiveRun(current, featureId, runId)
      }
      if (!text) throw new Error('A comment is required.')
      const comment: ProjectBoardComment = {
        id: randomUUID(),
        boardId: card.boardId,
        cardId,
        runId,
        author: readString(authorValue, 120) || 'You',
        text,
        createdAtIso: this.now().toISOString(),
      }
      return { ...current, comments: [comment, ...current.comments] }
    })
  }

  answerQuestion(questionId: string, answerValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const question = current.questions.find((entry) => entry.id === questionId)
      const answer = readString(answerValue, 10_000)
      if (!question || question.status !== 'open') throw new Error('This question no longer needs an answer.')
      if (!answer) throw new Error('An answer is required.')
      const now = this.now()
      const comment: ProjectBoardComment = {
        id: randomUUID(),
        boardId: question.boardId,
        cardId: question.cardId,
        runId: '',
        author: 'You',
        text: `Answer: ${answer}`,
        createdAtIso: now.toISOString(),
      }
      const card = current.cards.find((entry) => entry.id === question.cardId)
      let next: ProjectBoardSnapshot = {
        ...current,
        questions: current.questions.map((entry) => entry.id === questionId ? {
          ...entry,
          status: 'answered',
          answer,
          answeredAtIso: now.toISOString(),
        } : entry),
        comments: [comment, ...current.comments],
        cards: current.cards.map((entry) => entry.id === question.cardId
          && !current.questions.some((other) => other.id !== questionId && other.cardId === question.cardId && other.status === 'open')
          ? cardWithStatus(entry, 'backlog', now, 'Answer received; ready to resume')
          : entry),
      }
      next = recalculateParent(next, card?.parentCardId ?? '', now)
      return next
    })
  }

  startRun(cardId: string, agentId: string, kind: ProjectBoardRunKind): Promise<{ snapshot: ProjectBoardSnapshot; run: ProjectBoardRun }> {
    let createdRun!: ProjectBoardRun
    return this.mutate((current) => {
      const card = current.cards.find((entry) => entry.id === cardId)
      if (!card) throw new Error('Board card not found.')
      if (card.type !== 'feature') throw new Error('Only features can start a Lead run; QA batches are not executable yet.')
      assertManualEdit(current, card)
      const blocker = dependencyBlocker(current, card)
      if (blocker) throw new Error(blocker)
      if (current.runs.some((run) => run.cardId === cardId && run.status === 'running')) {
        throw new Error('This card already has a running agent.')
      }
      const agent = current.agents.find((entry) => entry.id === agentId)
      if (!agent) throw new Error('Assigned agent not found.')
      const now = this.now()
      createdRun = {
        id: randomUUID(),
        boardId: card.boardId,
        cardId,
        agentId,
        kind,
        status: 'running',
        threadId: '',
        startedAtIso: now.toISOString(),
        finishedAtIso: '',
        summary: '',
        error: '',
      }
      let next: ProjectBoardSnapshot = {
        ...current,
        runs: [createdRun, ...current.runs],
        cards: current.cards.map((entry) => entry.id === cardId
          ? cardWithStatus(entry, 'working', now, kind === 'plan' ? 'Lead is planning' : `${agent.name} is working`)
          : entry),
      }
      next = recalculateParent(next, card.parentCardId, now)
      return next
    }).then((snapshot) => ({ snapshot, run: createdRun }))
  }

  setRunThread(runId: string, threadId: string): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const run = current.runs.find((entry) => entry.id === runId)
      if (!run) throw new Error('Feature run not found.')
      assertActiveRun(current, run.cardId, runId)
      if (current.cards.some((card) => card.id !== run.cardId && card.threadId === threadId)) throw new Error('This chat already belongs to another feature.')
      return {
        ...current,
        runs: current.runs.map((entry) => entry.id === runId ? { ...entry, threadId } : entry),
        cards: current.cards.map((card) => card.id === run.cardId ? { ...card, threadId, lastRunId: runId } : card),
      }
    })
  }

  replacePlan(featureId: string, result: ProjectBoardPlanResult, runId = ''): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      assertActiveRun(current, featureId, runId)
      const feature = current.cards.find((card) => card.id === featureId && card.type === 'feature')
      const board = current.boards.find((entry) => entry.id === feature?.boardId)
      if (!feature || !board) throw new Error('Feature or board not found.')
      const existingChildren = current.cards.filter((card) => card.parentCardId === feature.id)
      if (existingChildren.some((card) => card.status === 'working' || card.status === 'done')) {
        throw new Error('The plan cannot be replaced after task execution has started.')
      }
      const now = this.now()
      const tasks = buildPlanCards(current, feature, board, result, now)
      const removedIds = new Set(existingChildren.map((card) => card.id))
      assertNoExternalDependencies(current, removedIds)
      if (current.questions.some((question) => question.status === 'open' && (question.cardId === featureId || removedIds.has(question.cardId)))) {
        throw new Error('Answer the open questions before replacing the plan.')
      }
      return {
        ...current,
        cards: [
          ...tasks.map((task) => ({ ...task, lastRunId: runId })),
          ...current.cards
            .filter((card) => !removedIds.has(card.id))
            .map((card) => card.id === feature.id ? {
              ...card,
              status: 'working' as const,
              summary: readString(result.summary),
              lastRunId: runId,
              progressNote: `0/${tasks.length} tasks complete`,
              updatedAtIso: now.toISOString(),
            } : card),
        ],
        questions: current.questions.filter((question) => !removedIds.has(question.cardId)),
        comments: current.comments.filter((comment) => !removedIds.has(comment.cardId)),
        artifacts: current.artifacts.filter((artifact) => !removedIds.has(artifact.cardId)),
        runs: current.runs.filter((run) => !removedIds.has(run.cardId)),
      }
    })
  }

  updateTaskFromAgent(
    featureId: string,
    taskId: string,
    action: 'start' | 'complete' | 'block',
    payloadValue: unknown,
    runId = '',
  ): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      assertActiveRun(current, featureId, runId)
      const feature = current.cards.find((card) => card.id === featureId && card.type === 'feature')
      const task = current.cards.find((card) => card.id === taskId && card.parentCardId === featureId)
      if (!feature || !task) throw new Error('Task does not belong to this feature.')
      const payload = asRecord(payloadValue) ?? {}
      const now = this.now()
      if (action === 'start' || action === 'complete') {
        const blocker = dependencyBlocker(current, feature) || dependencyBlocker(current, task) || qaOrderingBlocker(current, task)
        if (blocker) throw new Error(blocker)
        if (current.questions.some((question) => question.status === 'open' && (question.cardId === featureId || question.cardId === taskId))) {
          throw new Error('Answer the open question before continuing this task.')
        }
      }
      if (action === 'start' && task.status === 'working') return current
      if (action === 'start' && task.status === 'done') {
        throw new Error('A completed task cannot be started again. Create a follow-up task instead.')
      }
      if (action === 'complete' && task.status === 'done') return current
      if (action === 'complete' && task.status !== 'working') {
        throw new Error('Start the task before marking it complete.')
      }
      const summary = readString(payload.summary)
      if (action === 'complete' && !summary) throw new Error('A completed task requires a summary.')
      const blocker = readString(payload.blocker) || readString(payload.summary)
      if (action === 'block' && !blocker) throw new Error('A blocked task requires a reason.')
      const status: ProjectBoardStatus = action === 'start' ? 'working' : action === 'complete' ? 'done' : 'blocked'
      const progressNote = action === 'start' ? 'Agent is working' : action === 'complete' ? 'Task complete' : blocker
      const artifactValues = Array.isArray(payload.artifacts) ? payload.artifacts : []
      const artifacts: ProjectBoardArtifact[] = artifactValues.slice(0, 50).map((value) => {
        const artifact = asRecord(value) ?? {}
        const path = readString(artifact.path, 4_000)
        return {
          id: randomUUID(),
          cardId: task.id,
          runId,
          label: readString(artifact.label, 240) || path.split('/').filter(Boolean).at(-1) || 'Artifact',
          path,
          createdAtIso: now.toISOString(),
        }
      }).filter((artifact) => artifact.path)
      let next: ProjectBoardSnapshot = {
        ...current,
        cards: current.cards.map((card) => card.id === task.id
          ? cardWithStatus({ ...card, summary: summary || blocker || card.summary, lastRunId: runId }, status, now, progressNote)
          : card),
        artifacts: [...artifacts, ...current.artifacts],
      }
      next = recalculateParent(next, feature.id, now)
      return next
    })
  }

  askQuestion(featureId: string, cardId: string, promptValue: unknown, runId = ''): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      assertActiveRun(current, featureId, runId)
      const feature = current.cards.find((card) => card.id === featureId && card.type === 'feature')
      const card = current.cards.find((entry) => entry.id === cardId)
      const prompt = readString(promptValue, 5_000)
      if (!feature || !card || (card.id !== feature.id && card.parentCardId !== feature.id)) {
        throw new Error('Question card does not belong to this feature.')
      }
      if (!prompt) throw new Error('A question is required.')
      const existing = current.questions.find((question) =>
        question.cardId === cardId && question.status === 'open' && question.prompt === prompt,
      )
      if (existing) return current
      const now = this.now()
      const question: ProjectBoardQuestion = {
        id: randomUUID(),
        boardId: card.boardId,
        cardId,
        runId,
        prompt,
        status: 'open',
        answer: '',
        createdAtIso: now.toISOString(),
        answeredAtIso: '',
      }
      let next: ProjectBoardSnapshot = {
        ...current,
        questions: [question, ...current.questions],
        cards: current.cards.map((entry) => entry.id === cardId
          ? cardWithStatus(entry, 'needs_input', now, 'Waiting for your answer')
          : entry),
      }
      next = recalculateParent(next, card.parentCardId, now)
      if (card.id === feature.id) {
        next = {
          ...next,
          cards: next.cards.map((entry) => entry.id === feature.id
            ? cardWithStatus(entry, 'needs_input', now, 'Waiting for your answer')
            : entry),
        }
      }
      return next
    })
  }

  attachArtifact(featureId: string, cardId: string, artifactValue: unknown, runId = ''): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      assertActiveRun(current, featureId, runId)
      const feature = current.cards.find((card) => card.id === featureId && card.type === 'feature')
      const card = current.cards.find((entry) => entry.id === cardId)
      const artifact = asRecord(artifactValue) ?? {}
      const path = readString(artifact.path, 4_000)
      if (!feature || !card || (card.id !== feature.id && card.parentCardId !== feature.id)) {
        throw new Error('Artifact card does not belong to this feature.')
      }
      if (!path) throw new Error('An artifact path is required.')
      const entry: ProjectBoardArtifact = {
        id: randomUUID(),
        cardId,
        runId,
        label: readString(artifact.label, 240) || path.split('/').filter(Boolean).at(-1) || 'Artifact',
        path,
        createdAtIso: this.now().toISOString(),
      }
      return { ...current, artifacts: [entry, ...current.artifacts] }
    })
  }

  completeRun(runId: string, summaryValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const run = current.runs.find((entry) => entry.id === runId)
      if (!run || run.status !== 'running') return current
      const now = this.now()
      const summary = readString(summaryValue)
      return {
        ...current,
        runs: current.runs.map((entry) => entry.id === runId ? {
          ...entry,
          status: 'succeeded',
          summary: summary || entry.summary,
          error: '',
          finishedAtIso: now.toISOString(),
        } : entry),
      }
    })
  }

  recalculateFeature(featureId: string): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => recalculateParent(current, featureId, this.now()))
  }

  finishFeature(featureId: string, summaryValue: unknown, runId = ''): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      assertActiveRun(current, featureId, runId)
      const feature = current.cards.find((card) => card.id === featureId && card.type === 'feature')
      if (!feature) throw new Error('Feature not found.')
      const blocker = featureCompletionBlocker(current, feature)
      if (blocker) throw new Error(blocker)
      const status = feature.verificationPolicy === 'batch' ? 'review' : 'done'
      return {
        ...current,
        cards: current.cards.map((card) => card.id === featureId
          ? cardWithStatus({ ...card, summary: readString(summaryValue) || card.summary, lastRunId: runId }, status, this.now(),
            status === 'review' ? 'Ready for batch QA' : 'All tasks complete')
          : card),
      }
    })
  }

  updateFeatureRuntime(featureId: string, changes: { progressNote?: string; status?: 'blocked' }): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const feature = current.cards.find((card) => card.id === featureId && card.type === 'feature')
      if (!feature) throw new Error('Feature not found.')
      return {
        ...current,
        cards: current.cards.map((card) => card.id === featureId
          ? cardWithStatus({ ...card, ...changes }, changes.status ?? card.status, this.now())
          : card),
      }
    })
  }

  failRun(runId: string, errorValue: unknown, status: 'failed' | 'interrupted' = 'failed'): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const run = current.runs.find((entry) => entry.id === runId)
      if (!run || run.status !== 'running') return current
      const card = current.cards.find((entry) => entry.id === run.cardId)
      const now = this.now()
      const error = readString(errorValue) || 'Agent run failed.'
      let next: ProjectBoardSnapshot = {
        ...current,
        cards: current.cards.map((entry) => entry.id === run.cardId || (entry.parentCardId === run.cardId && entry.status === 'working')
          ? cardWithStatus({ ...entry, summary: entry.summary || error }, 'blocked', now, error)
          : entry),
        runs: current.runs.map((entry) => entry.id === runId ? {
          ...entry,
          status,
          finishedAtIso: now.toISOString(),
          error,
        } : entry),
      }
      next = recalculateParent(next, card?.parentCardId ?? '', now)
      return next
    })
  }

  recoverInterruptedRuns(): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const interruptedCardIds = new Set(current.runs
        .filter((run) => run.status === 'running' || run.status === 'queued')
        .map((run) => run.cardId))
      if (interruptedCardIds.size === 0) return current
      const now = this.now()
      let next: ProjectBoardSnapshot = {
        ...current,
        runs: current.runs.map((run) => interruptedCardIds.has(run.cardId) && (run.status === 'running' || run.status === 'queued') ? {
          ...run,
          status: 'interrupted',
          finishedAtIso: now.toISOString(),
          error: 'CodexUI restarted before this run finished.',
        } : run),
        cards: current.cards.map((card) => interruptedCardIds.has(card.id) || (interruptedCardIds.has(card.parentCardId) && card.status === 'working')
          ? cardWithStatus(card, 'blocked', now, 'CodexUI restarted; retry this card')
          : card),
      }
      for (const cardId of interruptedCardIds) {
        const parentId = next.cards.find((card) => card.id === cardId)?.parentCardId ?? ''
        next = recalculateParent(next, parentId, now)
      }
      return next
    })
  }

  private mutate(mutator: (current: ProjectBoardSnapshot) => ProjectBoardSnapshot): Promise<ProjectBoardSnapshot> {
    return this.enqueue(async () => {
      const current = await this.load()
      const next = mutator(current)
      if (next === current) return current
      for (const [field, limit] of Object.entries({ cards: MAX_CARDS, runs: MAX_RUNS, comments: MAX_COMMENTS, artifacts: MAX_ARTIFACTS, questions: MAX_QUESTIONS })) {
        if ((next[field as keyof ProjectBoardSnapshot] as unknown[]).length > limit) {
          throw new Error(`Project board ${field} capacity (${limit}) reached. Remove old board data before adding more.`)
        }
      }
      const versioned: ProjectBoardSnapshot = {
        ...next,
        schemaVersion: SCHEMA_VERSION,
        version: current.version + 1,
        updatedAtIso: this.now().toISOString(),
      }
      await this.save(versioned)
      return versioned
    })
  }

  private assertPublicCardFields(record: Record<string, unknown>, updating = false): void {
    const allowed = new Set(['title', 'description', 'acceptanceCriteria', 'status', 'priority', 'verificationPolicy', 'assignedAgentId', 'autoRun'])
    if (!updating) for (const field of ['boardId', 'parentCardId', 'type', 'dependencyIds']) allowed.add(field)
    const unknown = Object.keys(record).find((field) => !allowed.has(field))
    if (unknown) throw new Error(`Card field "${unknown}" is server-owned or cannot be changed here.`)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async load(): Promise<ProjectBoardSnapshot> {
    try {
      const raw = await readFile(this.stateFilePath, 'utf8')
      return normalizeSnapshot(JSON.parse(raw) as unknown, this.now())
    } catch (error) {
      if (isMissingFileError(error)) return emptySnapshot(this.now())
      if (error instanceof SyntaxError) throw new Error('Project board data is not valid JSON.')
      throw error
    }
  }

  private async save(snapshot: ProjectBoardSnapshot): Promise<void> {
    await mkdir(dirname(this.stateFilePath), { recursive: true })
    const temporaryPath = `${this.stateFilePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
      await rename(temporaryPath, this.stateFilePath)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}
