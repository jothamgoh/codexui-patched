import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { projectBoardTitleFromBrief } from '../lib/projectBoardTitle'
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
  ProjectBoardFeaturePlan,
  ProjectBoardPriority,
  ProjectBoardQuestion,
  ProjectBoardRun,
  ProjectBoardRunKind,
  ProjectBoardSnapshot,
  ProjectBoardStatus,
  ProjectBoardTaskPurpose,
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
const TASK_PURPOSES = new Set<ProjectBoardTaskPurpose>(['work', 'verification'])
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
    instructions: [
      'Own the requested outcome as a pragmatic delivery lead. Read the brief, acceptance criteria, project instructions, relevant existing work, and dependency handoffs before deciding what to do. Distinguish confirmed facts from assumptions. Keep the user’s goal and constraints current when they change direction; retain useful completed work.',
      'Plan the smallest coherent delivery. Split separately useful outcomes into feature cards; put shared groundwork in one prerequisite and keep tightly overlapping edits together. Within a feature, give each task a clear owner, inputs, output, and completion criteria. Respect Plan first: save a plan and wait for implementation to be started. Avoid a task or agent for every small edit.',
      'Delegate bounded specialist work when separate expertise or fresh context helps. Include the goal, relevant files or sources, constraints, selected profile instructions, expected handoff, and dependencies. Keep independent research parallel and writers coordinated. Do useful independent work while specialists run; collect their results before dependent work. Any suitable profile can coordinate, and a simple task can stay with one agent.',
      'Make routine reversible decisions using project conventions and state material assumptions briefly. Ask only for missing information or decisions that materially change scope, permissions, cost, or the result. For a blocking board decision, save one focused question with context, alternatives, and your recommendation, then stop dependent work until answered. Do not ask again for authorization already given.',
      'Inspect handoffs rather than accepting completion claims blindly. Follow the chosen verification policy, combine checks at the feature boundary, and repair concrete failures before requesting another review. Keep board state truthful. Finish with the outcome, relevant files or artifacts, checks actually run, and any remaining limitation. Never invent evidence or claim release/deployment from implementation alone.',
    ].join('\n\n'),
    sandbox: 'read-only',
  },
  {
    id: 'builtin-product',
    name: 'Product',
    role: 'product',
    description: 'Clarifies the user problem, scope, requirements, and acceptance criteria.',
    instructions: [
      'Turn the user’s goal into a buildable product brief. Identify who the change serves, the problem or job they need done, the current behavior, and the desired outcome. Read existing product decisions and workflows first. Use observed evidence; label assumptions and avoid inventing customer research or success metrics.',
      'Map the main journey and the important alternatives: first use, returning use, empty data, mistakes, interruption, retry, and completion. Consider the devices, accessibility needs, and constraints in the brief. Check how this feature overlaps existing or planned work and identify shared prerequisites.',
      'Recommend the smallest useful scope, with explicit exclusions and observable acceptance criteria. Describe behavior in concrete before/after examples when helpful. Separate decisions needed now from ideas that can wait. Do not turn possibilities into mandatory framework, integrations, or an exhaustive test matrix.',
      'Resolve routine details from context. For a consequential unresolved tradeoff, return a short question, alternatives, their practical impact, and a recommendation to the coordinator. Ask the user through the board question flow only when coordinating; delegated specialists return questions to their Lead.',
      'Hand off a concise brief: user/outcome, scope, key flows and failure cases, dependencies, acceptance criteria, assumptions, and unresolved decisions. Explain how to verify the product outcome. Do not edit implementation files. If assigned as Lead, coordinate the other roles using the board workflow while keeping this product perspective.',
    ].join('\n\n'),
    sandbox: 'read-only',
  },
  {
    id: 'builtin-design',
    name: 'Design',
    role: 'design',
    description: 'Defines flows, interaction details, states, and accessible UI behavior.',
    instructions: [
      'Design an understandable, usable path to the requested outcome. Inspect the existing product and design system, plus any reference explicitly requested by the user. Reuse established components, language, spacing, themes, and interaction patterns. Borrow a reference’s useful behavior rather than blindly copying its appearance.',
      'Specify the main flow, information hierarchy, primary action, and feedback. Cover relevant empty/loading/success/error states, interrupted work, retry, cancellation, and draft preservation. Make it clear what happened, what is happening, and what the user should do next; hide implementation detail that does not help their decision.',
      'Treat mobile as a complete interaction, not just a smaller screenshot. Check short screens, touch targets, keyboard and voice entry, safe areas, scrolling, reachable actions, and long content. Include keyboard navigation, focus restoration, accessible labels, contrast, and light/dark themes where supported.',
      'Keep the solution proportional to the feature. State meaningful tradeoffs and bring unresolved product choices to the coordinator. Hand off a compact flow and state specification with component reuse, responsive behavior, accessibility criteria, and a visual verification checklist. Do not claim a mockup or screenshot proves functionality. Do not edit implementation files unless the task explicitly asks you to.',
    ].join('\n\n'),
    sandbox: 'read-only',
  },
  {
    id: 'builtin-engineer',
    name: 'Engineer',
    role: 'engineering',
    description: 'Implements scoped changes and verifies the work it owns.',
    instructions: [
      'Implement the requested behavior in the existing architecture. Read project instructions, the relevant code and tests, acceptance criteria, and prerequisite handoffs. Inspect actual integration points before changing shared code. Preserve unrelated user work and follow repository conventions.',
      'Choose the smallest maintainable change that solves the whole problem. Prefer existing components and APIs; add abstractions only when current needs justify them. Handle important errors, cancellation, retries, persistence, and compatibility at affected boundaries. For UI work, implement responsive, accessible behavior and preserve drafts and focus.',
      'Coordinate ownership before edits overlap. Do not run concurrent writers in a shared project or replace another agent’s work without understanding it. If scope or an interface must change, return the impact and recommendation to the Lead before dependent work proceeds. Research unfamiliar or changing APIs in primary documentation.',
      'Verify the coherent feature with the checks that could expose real regressions. Reuse existing tests and add focused coverage for meaningful failure paths; do not mirror implementation details or test every tiny edit. Inspect the final diff, run required checks, and repair failures. Distinguish a simulated test, real execution, browser emulation, and physical-device evidence.',
      'Return the delivered behavior, relevant files/API contract, checks and their results, and unresolved limitations. Keep logs and handoffs concise. Do not claim an independent review you performed yourself. Follow existing user/repository authorization for publication or other external actions; implementation alone does not authorize them.',
    ].join('\n\n'),
    sandbox: 'workspace-write',
  },
  {
    id: 'builtin-qa',
    name: 'QA / Validator',
    role: 'qa',
    description: 'Independently checks the result against acceptance criteria.',
    instructions: [
      'Validate the delivered feature against its acceptance criteria using independent evidence. Read the brief, relevant code/diff, dependency contract, and claimed checks. Treat the implementer’s handoff as a guide to investigate, not proof of correctness.',
      'Check the main path and the failure or boundary cases that matter for this change: invalid input, empty/long content, cancellation, retry, stale state, persistence, or overlapping work as applicable. Run existing meaningful tests and add small focused probes only where coverage is missing. For UI changes, inspect rendering and interactions at the required desktop/mobile sizes, with keyboard, touch, themes, and voice where relevant.',
      'Prioritize concrete user-impacting defects. For each failure, give a reproducible trigger, expected versus actual behavior, affected file or surface, severity, and the smallest useful repair direction. Separate blocking defects from optional polish; avoid speculative objections and a sprawling test matrix.',
      'Remain read-only unless fixes were explicitly assigned. Return findings to the coordinator so it can reopen the affected work, preserve the handoff, repair it, and request verification again. Recheck the repair and affected dependencies. Do not silently mark failed checks as passed or waive the chosen verification policy.',
      'Return pass or fail with concise evidence, commands/checks actually performed, and unverified limitations. A passing test suite alone does not prove every acceptance criterion, a narrow browser is not a physical phone, and an unavailable environment must be reported as unverified.',
    ].join('\n\n'),
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
    plan: readString(record.plan),
    sourceThreadId: readString(record.sourceThreadId, 200),
    planningThreadId: readString(record.planningThreadId, 200),
    coordinatorAgentId: readString(record.coordinatorAgentId, 200),
    createdAtIso: readString(record.createdAtIso, 100) || new Date(0).toISOString(),
    updatedAtIso: readString(record.updatedAtIso, 100) || new Date(0).toISOString(),
  }
}

function normalizeCard(value: unknown, agents: ProjectBoardAgent[]): ProjectBoardCard | null {
  const record = asRecord(value)
  const id = readString(record?.id, 200)
  const boardId = readString(record?.boardId, 200)
  const title = readString(record?.title, 240)
  if (!record || !id || !boardId || !title) return null
  const type = record.type === 'task' || record.type === 'qa_batch' ? record.type : 'feature'
  const legacyVerification = record.taskPurpose === undefined && type === 'task'
    && agents.some((agent) => agent.id === record.assignedAgentId && agent.role === 'qa')
  return {
    id,
    boardId,
    parentCardId: readString(record.parentCardId, 200),
    type,
    taskPurpose: type === 'task' && (record.taskPurpose === 'verification' || legacyVerification) ? 'verification' : 'work',
    title,
    description: readString(record.description),
    acceptanceCriteria: readString(record.acceptanceCriteria),
    status: normalizeStatus(record.status),
    priority: normalizePriority(record.priority),
    verificationPolicy: normalizeVerificationPolicy(record.verificationPolicy),
    assignedAgentId: readString(record.assignedAgentId, 200),
    dependencyIds: readStringArray(record.dependencyIds),
    autoRun: record.autoRun === true,
    model: readString(record.model, 200),
    reasoningEffort: readString(record.reasoningEffort) ? normalizeReasoningEffort(record.reasoningEffort) : '',
    planSummary: readString(record.planSummary),
    planStatus: record.planStatus === 'ready' ? 'ready' : 'none',
    toolSchemaVersion: record.toolSchemaVersion === 2 ? 2 : 1,
    threadId: readString(record.threadId, 200),
    sourceThreadId: type === 'feature' ? readString(record.sourceThreadId, 200) : '',
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
  if (!record || !id || !boardId || (!cardId && record.kind !== 'board_plan')) return null
  const kind: ProjectBoardRunKind = record.kind === 'board_plan' ? 'board_plan' : record.kind === 'plan' ? 'plan' : 'execute'
  const allowedStatuses = new Set(['queued', 'running', 'succeeded', 'failed', 'interrupted'])
  const rawStatus = readString(record.status)
  const requestedReasoningEffort = readString(record.requestedReasoningEffort) as ReasoningEffort
  return {
    id,
    boardId,
    cardId,
    agentId: readString(record.agentId, 200),
    kind,
    createdCardIds: readStringArray(record.createdCardIds),
    status: allowedStatuses.has(rawStatus) ? rawStatus as ProjectBoardRun['status'] : 'failed',
    threadId: readString(record.threadId, 200),
    requestedModel: record.requestedModel === undefined ? undefined : readString(record.requestedModel, 200),
    requestedReasoningEffort: REASONING_EFFORTS.has(requestedReasoningEffort) ? requestedReasoningEffort : undefined,
    startedAtIso: readString(record.startedAtIso, 100),
    finishedAtIso: readString(record.finishedAtIso, 100),
    summary: readString(record.summary),
    error: readString(record.error),
  }
}

function readOptionalEffort(value: unknown): ReasoningEffort | '' {
  const effort = readString(value) as ReasoningEffort | ''
  if (effort && !REASONING_EFFORTS.has(effort)) throw new Error('Unknown reasoning effort.')
  return effort
}

function assertCardDependencies(snapshot: ProjectBoardSnapshot): void {
  const byId = new Map(snapshot.cards.map((card) => [card.id, card]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (card: ProjectBoardCard): void => {
    if (visited.has(card.id)) return
    if (visiting.has(card.id)) throw new Error('Feature dependencies cannot contain a cycle.')
    visiting.add(card.id)
    for (const id of card.dependencyIds) {
      const dependency = byId.get(id)
      if (!dependency || dependency.boardId !== card.boardId) throw new Error('Missing dependency: every dependency must exist on this board.')
      if (card.type !== 'qa_batch' && (dependency.type !== card.type || dependency.parentCardId !== card.parentCardId)) {
        throw new Error('Features depend on features; tasks depend on tasks inside the same feature.')
      }
      visit(dependency)
    }
    visiting.delete(card.id)
    visited.add(card.id)
  }
  for (const card of snapshot.cards) visit(card)
}

export function projectBoardFeatureFingerprint(feature: ProjectBoardCard): string {
  return JSON.stringify([feature.title, feature.description, feature.acceptanceCriteria, feature.assignedAgentId, feature.model, feature.reasoningEffort, feature.verificationPolicy, feature.dependencyIds])
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
    ...builtIns.map((agent) => {
      const saved = savedById.get(agent.id)
      // Starter text is maintained by the app. User-customized copies have
      // their own IDs and retain their saved instructions below.
      return saved ? { ...saved, instructions: agent.instructions, description: agent.description } : agent
    }),
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
      ? record.cards.map((card) => normalizeCard(card, agents)).filter((card): card is ProjectBoardCard => card !== null)
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

function verificationOrderingBlocker(snapshot: ProjectBoardSnapshot, task: ProjectBoardCard): string {
  if (task.type !== 'task' || task.taskPurpose !== 'verification') return ''
  const work = snapshot.cards.filter((entry) => entry.type === 'task'
    && entry.parentCardId === task.parentCardId && entry.taskPurpose === 'work')
  if (work.some((entry) => !task.dependencyIds.includes(entry.id))) {
    return 'Verification must depend on every work task.'
  }
  if (task.status === 'done' && work.some((entry) =>
    !entry.completedAtIso || !task.completedAtIso || entry.completedAtIso > task.completedAtIso)) {
    return 'Verification must be repeated after the latest work.'
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
    const blocker = dependencyBlocker(snapshot, task) || verificationOrderingBlocker(snapshot, task)
    if (blocker) return blocker
  }
  if (feature.verificationPolicy === 'independent' && !tasks.some((task) => task.taskPurpose === 'verification')) {
    return 'Independent verification task required'
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
    const explicitAgent = rawTask.agentId !== undefined
    const agent = explicitAgent
      ? roster.find((entry) => entry.id === readString(rawTask.agentId, 200))
      : roster.find((entry) => entry.role === role) ?? lead
    if (!agent) throw new Error(`Task ${key} must select an agent enabled for this board.`)
    if (rawTask.taskPurpose !== undefined && !TASK_PURPOSES.has(rawTask.taskPurpose)) {
      throw new Error(`Task ${key} has an unknown purpose.`)
    }
    const taskPurpose = rawTask.taskPurpose ?? (!explicitAgent && agent.role === 'qa' ? 'verification' : 'work')
    const dependencyIds = readStringArray(rawTask.dependsOn)
      .map((dependencyKey) => keyToId.get(dependencyKey) ?? '')
      .filter(Boolean)
    return {
      id: keyToId.get(key)!,
      boardId: board.id,
      parentCardId: feature.id,
      type: 'task',
      taskPurpose,
      title: readString(rawTask.title, 240) || key,
      description: readString(rawTask.description),
      acceptanceCriteria: readString(rawTask.acceptanceCriteria),
      status: 'backlog',
      priority: feature.priority,
      verificationPolicy: 'self',
      assignedAgentId: agent.id,
      dependencyIds,
      autoRun: true,
      model: '', reasoningEffort: '', planSummary: '', planStatus: 'none', toolSchemaVersion: 1,
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
    const blocker = verificationOrderingBlocker(planned, task)
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
        plan: '', sourceThreadId: '', planningThreadId: '', coordinatorAgentId: '',
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
        plan: '', sourceThreadId: '', planningThreadId: '', coordinatorAgentId: '',
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
            plan: 'plan' in changes ? readString(changes.plan) : board.plan,
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
        boardId: record.boardId === undefined ? undefined : readString(record.boardId, 200),
        name: readString(record.name, 120),
        role: normalizeAgentRole(record.role),
        description: readString(record.description, 500),
        instructions: readString(record.instructions),
        model: readString(record.model, 200),
        reasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
        sandbox: record.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only',
      }
      if (!input.name || !input.instructions) throw new Error('Agent name and instructions are required.')
      if (input.boardId !== undefined && !current.boards.some((board) => board.id === input.boardId)) {
        throw new Error('Board not found.')
      }
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
        boards: current.boards.map((board) => board.id === input.boardId
          ? { ...board, agentIds: [...board.agentIds, agent.id] }
          : board),
      }
    })
  }

  updateAgent(id: string, changesValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const existing = current.agents.find((agent) => agent.id === id)
      if (!existing) throw new Error('Agent not found.')
      if (existing.builtIn) throw new Error('Built-in agents are read-only. Create a custom agent instead.')
      const changes = asRecord(changesValue) ?? {}
      const changesAccess = 'sandbox' in changes && changes.sandbox !== existing.sandbox
      if (changesAccess && current.cards.some((card) => card.assignedAgentId === id)) {
        throw new Error('Create a new profile to change access after an agent has been assigned.')
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
      if ('taskPurpose' in record && !TASK_PURPOSES.has(record.taskPurpose as ProjectBoardTaskPurpose)) throw new Error('Unknown task purpose.')
      const description = readString(record.description)
      const title = readString(record.title, 240) || projectBoardTitleFromBrief(description)
      if (record.sourceThreadId !== undefined && (typeof record.sourceThreadId !== 'string'
        || record.sourceThreadId.trim().length > 200 || /[\s\u0000-\u001f\u007f]/u.test(record.sourceThreadId.trim()))) {
        throw new Error('The source chat ID must be a string of at most 200 characters without spaces or control characters.')
      }
      const sourceThreadId = readString(record.sourceThreadId, 200)
      if (sourceThreadId && record.type !== undefined && record.type !== 'feature') {
        throw new Error('Only a feature can reference a source chat.')
      }
      const input: ProjectBoardCardCreateInput = {
        boardId: readString(record.boardId, 200),
        parentCardId: readString(record.parentCardId, 200),
        type: record.type === 'task' || record.type === 'qa_batch' ? record.type : 'feature',
        taskPurpose: record.type === 'task' && record.taskPurpose === 'verification' ? 'verification' : 'work',
        title,
        description,
        acceptanceCriteria: readString(record.acceptanceCriteria),
        status: normalizeStatus(record.status),
        priority: normalizePriority(record.priority),
        verificationPolicy: normalizeVerificationPolicy(record.verificationPolicy),
        assignedAgentId: readString(record.assignedAgentId, 200),
        dependencyIds: readStringArray(record.dependencyIds),
        autoRun: record.autoRun === true,
        model: readString(record.model, 200),
        reasoningEffort: readOptionalEffort(record.reasoningEffort),
      }
      const board = current.boards.find((entry) => entry.id === input.boardId)
      if (!board) throw new Error('Project board not found.')
      if (!title) throw new Error('Add a brief or a title for this card.')
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
        taskPurpose: input.taskPurpose ?? 'work',
        title,
        description: input.description ?? '',
        acceptanceCriteria: input.acceptanceCriteria ?? '',
        status: input.status ?? 'backlog',
        priority: input.priority ?? 'normal',
        verificationPolicy: input.verificationPolicy ?? 'self',
        assignedAgentId: input.assignedAgentId || board.agentIds[0] || '',
        dependencyIds: input.dependencyIds ?? [],
        autoRun: input.autoRun === true,
        model: input.model ?? '', reasoningEffort: input.reasoningEffort ?? '', planSummary: '', planStatus: 'none', toolSchemaVersion: 1,
        threadId: '',
        sourceThreadId,
        lastRunId: '',
        summary: '',
        progressNote: '',
        createdAtIso: now.toISOString(),
        updatedAtIso: now.toISOString(),
        completedAtIso: '',
      }
      let next = { ...current, cards: [card, ...current.cards] }
      assertCardDependencies(next)
      const verificationBlocker = verificationOrderingBlocker(next, card)
      if (verificationBlocker) throw new Error(verificationBlocker)
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
      if ('taskPurpose' in changes && !TASK_PURPOSES.has(changes.taskPurpose as ProjectBoardTaskPurpose)) throw new Error('Unknown task purpose.')
      const workflowChange = ['title', 'description', 'acceptanceCriteria', 'status', 'verificationPolicy', 'assignedAgentId', 'taskPurpose', 'dependencyIds', 'model', 'reasoningEffort'].some((key) => key in changes)
      if (workflowChange) assertManualEdit(current, existing)
      const board = current.boards.find((entry) => entry.id === existing.boardId)
      if (!board) throw new Error('Project board not found.')
      const assignedAgentId = 'assignedAgentId' in changes
        ? readString(changes.assignedAgentId, 200)
        : existing.assignedAgentId
      const taskPurpose = existing.type === 'task' && 'taskPurpose' in changes
        ? changes.taskPurpose as ProjectBoardTaskPurpose
        : existing.taskPurpose
      if (existing.type === 'task' && existing.status === 'done'
        && (assignedAgentId !== existing.assignedAgentId || taskPurpose !== existing.taskPurpose)) {
        throw new Error('Reopen the completed task before changing its agent or purpose.')
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
          taskPurpose,
          autoRun: 'autoRun' in changes ? changes.autoRun === true : card.autoRun,
          model: 'model' in changes ? readString(changes.model, 200) : card.model,
          reasoningEffort: 'reasoningEffort' in changes ? readOptionalEffort(changes.reasoningEffort) : card.reasoningEffort,
          dependencyIds: 'dependencyIds' in changes ? readStringArray(changes.dependencyIds) : card.dependencyIds,
        }, 'status' in changes ? normalizeStatus(changes.status) : card.status, now)),
      }
      assertCardDependencies(next)
      const updated = next.cards.find((card) => card.id === id)!
      if (workflowChange) {
        if (updated.status !== existing.status && updated.status === 'needs_input') {
          throw new Error('Needs You is set by a question from the Lead.')
        }
        if (['working', 'review', 'done'].includes(updated.status)) {
          const blocker = dependencyBlocker(next, updated) || verificationOrderingBlocker(next, updated)
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
      if (existing.type === 'task' && existing.status === 'done' && updated.status !== 'done') {
        next.comments = [{ id: randomUUID(), boardId: existing.boardId, cardId: id, runId: '', author: 'You', text: `Reopened task. Previous handoff: ${existing.summary || '(none)'}`, createdAtIso: now.toISOString() }, ...next.comments]
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

  startRun(cardId: string, agentId: string, kind: ProjectBoardRunKind, expectedFingerprint?: string, settings?: { model: string; reasoningEffort: ReasoningEffort }, reopen = false): Promise<{ snapshot: ProjectBoardSnapshot; run: ProjectBoardRun }> {
    let createdRun!: ProjectBoardRun
    return this.mutate((current) => {
      const card = current.cards.find((entry) => entry.id === cardId)
      if (!card) throw new Error('Board card not found.')
      if (expectedFingerprint !== undefined && projectBoardFeatureFingerprint(card) !== expectedFingerprint) throw new Error('The feature changed while starting. Review its settings and start again.')
      if (card.type !== 'feature') throw new Error('Only features can start a Lead run; QA batches are not executable yet.')
      assertManualEdit(current, card)
      if (card.status === 'done') {
        if (!reopen) throw new Error('This feature is already done. Choose Reopen feature to send a follow-up.')
        const dependent = current.cards.find((entry) => entry.dependencyIds.includes(card.id) && ['working', 'done', 'review'].includes(entry.status))
        if (dependent) throw new Error(`Reopen dependent card "${dependent.title}" first.`)
      }
      if (kind === 'plan' && current.cards.some((entry) => entry.parentCardId === cardId && (entry.status === 'working' || entry.status === 'done'))) {
        throw new Error('This feature already has execution history. Continue its existing plan or reopen a task for repair.')
      }
      const blocker = kind === 'plan' ? '' : dependencyBlocker(current, card)
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
        createdCardIds: [],
        status: 'running',
        threadId: '',
        requestedModel: settings?.model,
        requestedReasoningEffort: settings?.reasoningEffort,
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

  startBoardPlan(boardId: string, agentId: string, plan: string, sourceThreadId: string, settings?: { model: string; reasoningEffort: ReasoningEffort }): Promise<{ snapshot: ProjectBoardSnapshot; run: ProjectBoardRun }> {
    let run!: ProjectBoardRun
    return this.mutate((current) => {
      const board = current.boards.find((entry) => entry.id === boardId)
      if (!board || !board.agentIds.includes(agentId)) throw new Error('Choose a coordinator enabled on this board.')
      if (current.runs.some((entry) => entry.boardId === boardId && entry.status === 'running')) throw new Error('Wait for this board’s active run to finish.')
      if (!readString(plan)) throw new Error('A project plan is required.')
      const now = this.now().toISOString()
      run = {
        id: randomUUID(), boardId, cardId: '', agentId, kind: 'board_plan', createdCardIds: [], status: 'running', threadId: '',
        requestedModel: settings?.model, requestedReasoningEffort: settings?.reasoningEffort,
        startedAtIso: now, finishedAtIso: '', summary: '', error: '',
      }
      return {
        ...current,
        runs: [run, ...current.runs],
        boards: current.boards.map((entry) => entry.id === boardId ? {
          ...entry, plan: readString(plan), sourceThreadId: readString(sourceThreadId, 200), coordinatorAgentId: agentId, updatedAtIso: now,
        } : entry),
      }
    }).then((snapshot) => ({ snapshot, run }))
  }

  saveBoardFeatures(boardId: string, result: ProjectBoardFeaturePlan, runId: string): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const run = current.runs.find((entry) => entry.id === runId && entry.boardId === boardId && entry.kind === 'board_plan' && entry.status === 'running')
      const board = current.boards.find((entry) => entry.id === boardId)
      if (!run || !board) throw new Error('Board planning run is no longer active.')
      if (run.createdCardIds.length) return current
      if (!Array.isArray(result.features) || !result.features.length || result.features.length > 30) throw new Error('Provide between 1 and 30 feature cards.')
      const ids = new Map<string, string>()
      for (const feature of result.features) {
        const key = readString(feature.key, 100)
        if (!key || ids.has(key) || current.cards.some((card) => card.id === key)) throw new Error('Feature keys must be unique and cannot reuse existing card IDs.')
        ids.set(key, randomUUID())
      }
      const now = this.now().toISOString()
      const cards: ProjectBoardCard[] = result.features.map((feature) => {
        if (!board.agentIds.includes(feature.agentId)) throw new Error('Every feature must choose an enabled agent.')
        const description = readString(feature.description)
        const title = readString(feature.title, 240) || projectBoardTitleFromBrief(description)
        if (!title) throw new Error('Every feature needs a brief or a title.')
        return {
          id: ids.get(readString(feature.key, 100))!, boardId, parentCardId: '', type: 'feature', taskPurpose: 'work', title,
          description, acceptanceCriteria: readString(feature.acceptanceCriteria), status: 'backlog', priority: 'normal',
          verificationPolicy: normalizeVerificationPolicy(feature.verificationPolicy), assignedAgentId: feature.agentId,
          dependencyIds: readStringArray(feature.dependsOn).map((key) => ids.get(key) ?? key),
          autoRun: false, model: '', reasoningEffort: '', planSummary: '', planStatus: 'none', toolSchemaVersion: 1, threadId: '', lastRunId: runId,
          summary: '', progressNote: 'Review the proposed feature before starting', createdAtIso: now, updatedAtIso: now, completedAtIso: '',
        }
      })
      const next = { ...current, cards: [...cards, ...current.cards], runs: current.runs.map((entry) => entry.id === runId ? { ...entry, createdCardIds: cards.map((card) => card.id) } : entry) }
      assertCardDependencies(next)
      return next
    })
  }

  completeFeaturePlan(featureId: string): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const feature = current.cards.find((card) => card.id === featureId)
      if (!feature) throw new Error('Feature not found.')
      if (feature.status === 'needs_input') return current
      const ready = current.cards.some((card) => card.parentCardId === featureId)
      return {
        ...current,
        cards: current.cards.map((card) => card.id === featureId ? cardWithStatus({ ...card, planStatus: ready ? 'ready' : 'none' }, ready ? 'backlog' : 'blocked', this.now(), ready ? 'Plan ready. Review the tasks, then Start work.' : 'No task plan was saved. Continue planning.') : card),
      }
    })
  }

  setRunThread(runId: string, threadId: string, toolSchemaVersion?: number): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const run = current.runs.find((entry) => entry.id === runId)
      if (!run) throw new Error('Feature run not found.')
      assertActiveRun(current, run.cardId, runId)
      if (current.cards.some((card) => card.id !== run.cardId && card.threadId === threadId)) throw new Error('This chat already belongs to another feature.')
      return {
        ...current,
        runs: current.runs.map((entry) => entry.id === runId ? { ...entry, threadId } : entry),
        cards: current.cards.map((card) => card.id === run.cardId ? { ...card, threadId, lastRunId: runId, toolSchemaVersion: toolSchemaVersion ?? card.toolSchemaVersion } : card),
        boards: current.boards.map((board) => board.id === run.boardId && run.kind === 'board_plan' ? { ...board, planningThreadId: threadId } : board),
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
              planSummary: readString(result.summary),
              planStatus: 'ready' as const,
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
    action: 'start' | 'complete' | 'block' | 'reopen',
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
      if (action === 'reopen') {
        const reason = readString(payload.summary) || readString(payload.blocker)
        if (!reason) throw new Error('A repair reason is required.')
        const dependent = current.cards.find((card) => card.dependencyIds.includes(taskId) && ['working', 'done', 'review'].includes(card.status))
        if (dependent) throw new Error(`Reopen dependent task "${dependent.title}" first.`)
        if (task.status === 'working') throw new Error('Block the active task before reopening it.')
        return recalculateParent({
          ...current,
          cards: current.cards.map((card) => card.id === taskId ? cardWithStatus(card, 'backlog', now, reason) : card),
          comments: [{ id: randomUUID(), boardId: feature.boardId, cardId: taskId, runId, author: 'Lead', text: `Reopened: ${reason}\nPrevious handoff: ${task.summary || '(none)'}`, createdAtIso: now.toISOString() }, ...current.comments],
        }, featureId, now)
      }
      if (action === 'start' || action === 'complete') {
        const blocker = dependencyBlocker(current, feature) || dependencyBlocker(current, task) || verificationOrderingBlocker(current, task)
        if (blocker) throw new Error(blocker)
        if (current.questions.some((question) => question.status === 'open' && (question.cardId === featureId || question.cardId === taskId))) {
          throw new Error('Answer the open question before continuing this task.')
        }
      }
      if (action === 'start' && task.status === 'working') return current
      if (action === 'start' && task.status === 'done') {
        throw new Error('This task is complete. Reopen it with a repair reason before starting it again.')
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
        cards: current.cards.map((entry) => run.cardId && (entry.id === run.cardId || (entry.parentCardId === run.cardId && entry.status === 'working'))
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
        cards: current.cards.map((card) => interruptedCardIds.has(card.id) || (card.parentCardId && interruptedCardIds.has(card.parentCardId) && card.status === 'working')
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
    const allowed = new Set(['title', 'description', 'acceptanceCriteria', 'status', 'priority', 'verificationPolicy', 'assignedAgentId', 'taskPurpose', 'autoRun', 'model', 'reasoningEffort', 'dependencyIds'])
    if (!updating) for (const field of ['boardId', 'parentCardId', 'type', 'dependencyIds', 'sourceThreadId']) allowed.add(field)
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
