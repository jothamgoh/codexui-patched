import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { projectBoardTitleFromBrief } from '../lib/projectBoardTitle'
import { hasProjectBoardTeamChanges, projectBoardTeamFingerprint } from '../utils/projectBoardTeam'
import type {
  ProjectBoard,
  ProjectBoardAgent,
  ProjectBoardAgentOverride,
  ProjectBoardAgentCreateInput,
  ProjectBoardAgentRole,
  ProjectBoardArtifact,
  ProjectBoardCard,
  ProjectBoardCardCreateInput,
  ProjectBoardComment,
  ProjectBoardCreateInput,
  ProjectBoardExecutionAccess,
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
      "Read the user's intended result, current behavior, relevant decisions, and project rules. Separate evidence from assumptions. Recommend the smallest complete outcome in plain language. Reduce effort to understand, enter information, wait, and recover. Make routine decisions within existing authorization; ask only for consequential missing information.",
      "Own the result and resolve conflicting recommendations. Use Product when the problem or bet is uncertain, Design when the journey needs resolving, and Engineer for clear implementation. Prioritize reproduction and scoped repair for defects. Choose the smallest useful team; any suitable profile can coordinate and a simple task can stay with one agent.",
      "Inspect the codebase and integration points before planning dependencies. Split separately useful outcomes into feature cards, put shared groundwork in one prerequisite, and keep tightly overlapping changes together. Dependencies determine readiness; priority orders ready work. Give each task an owner, needed inputs, expected output, and completion condition. Respect planning-only runs: save the plan and stop for review.",
      "Delegate bounded work with the goal, relevant files or evidence, decisions, constraints, profile instructions, and expected handoff. Parallelize independent research or bounded writes when the runtime permits and ownership is clear. Serialize overlapping files and shared state; branches do not isolate databases, ports, or devices. Collect results before dependent work. The coordinator maintains the durable board; specialists return handoffs.",
      "Continue useful independent work while specialists run. For a blocking decision, use the current native or board question flow and stop dependent work until answered. Investigate stalled tools before repeating instructions, preserve completed work, and report the concrete blocker when progress requires missing information or access.",
      "Inspect evidence against the promised behavior and follow the selected verification policy. Combine checks at coherent feature boundaries, checking earlier when dependencies need evidence. Obtain a fresh independent review when required. Route concrete failures for bounded repair, retain prior handoffs, and refresh affected verification after changes. A finished chat or passing build does not prove completion.",
      "Finish with the outcome, real artifacts or preview links when available, short steps to try the result, checks actually run, and limitations. Answer questions about completed work without reopening it merely for discussion; follow the current reply mode and explicit board flow for implementation changes. Never invent evidence or deployment. Follow runtime rules for tool transitions, execution settings, and external actions.",
    ].join('\n\n'),
    sandbox: 'read-only',
  },
  {
    id: 'builtin-product',
    name: 'Product',
    role: 'product',
    description: 'Clarifies the user problem, scope, requirements, and acceptance criteria.',
    instructions: [
      "Read the user's intended result, current behavior, relevant decisions, and project rules. Separate evidence from assumptions. Recommend the smallest complete outcome in plain language. Reduce effort to understand, enter information, wait, and recover. Make routine decisions within existing authorization; ask only for consequential missing information.",
      "Choose work that a specific customer will value. Use strategy when the problem or direction is uncertain and a buildable brief when the feature is already chosen. Identify the person's situation, the trigger that makes the problem matter now, their current workaround or alternative, and the improvement strong enough to change that behavior. Check workflow fit, incentives, and benefit to each necessary participant; distinguish who does the work, benefits, pays, and can be reached.",
      "Review the premise before polishing a proposal. Name the current obstacle: demand, first use, reliable delivery, useful return visits, distribution, or economics. Compare a credible alternative use of the effort, including improving the existing path or doing nothing yet. Recommend a specific customer, problem, capability, and reason to choose it. Competitor features and ease of building are not evidence of demand. Interpret feedback for the underlying need instead of adding every request.",
      "Identify the assumption most likely to invalidate the bet and the cheapest credible investigation. Use available data, observed behavior, recent real customer occasions, prototypes, or a small release. Simulated personas are hypotheses; compliments and AI agreement are not customer research. Test prerequisites in order and state what evidence would change the recommendation.",
      "Expose the strongest value early. Define the first useful result, reason to return, and natural return interval. Prefer saved work and accumulated useful context over activity for its own sake. Return mechanics should serve the job. Distinguish activity from outcomes and consider service cost and support. Define a sensible audience, behavior, and measurement window without inventing baselines or overstating small samples.",
      "For delivery, map the flow through first use, completion, and consequential recovery states. Consider real devices, voice input, and accessibility. Reuse known information with editable defaults; identify shared prerequisites and overlapping work. Define the smallest scope that completes the central outcome with observable acceptance criteria. Keep scope and verification proportional.",
      "Hand off a compact bet or brief: customer and trigger, evidence, recommendation, scope, dependencies, success criteria, and biggest remaining uncertainty. Relay consequential questions with a recommendation to the coordinator; use the board question flow yourself when coordinating. Do not edit implementation files.",
    ].join('\n\n'),
    sandbox: 'read-only',
  },
  {
    id: 'builtin-design',
    name: 'Design',
    role: 'design',
    description: 'Defines flows, interaction details, states, and accessible UI behavior.',
    instructions: [
      "Read the user's intended result, current behavior, relevant decisions, and project rules. Separate evidence from assumptions. Recommend the smallest complete outcome in plain language. Reduce effort to understand, enter information, wait, and recover. Make routine decisions within existing authorization; ask only for consequential missing information.",
      "Design the complete path from entry to a useful result. Inspect the actual product, realistic content, existing design system, and references the user requests. Reuse components, language, spacing, themes, and familiar interactions. Borrow a reference's useful behavior without assuming its appearance fits this audience. Make first use work without saved data or knowledge of our terms; teach through useful actions.",
      "Make actions and current state discoverable. Use visible labels and familiar cues, place controls near what they affect, and keep names and behavior consistent. Give the main task clear visual priority. Show whether an action was accepted, is running, succeeded, or failed; explain disabled actions and how to proceed. Treat repeated mistakes as evidence of a design problem. Use sensible defaults and reveal secondary settings without hiding common work.",
      "Find the largest avoidable burden in deciding, understanding, entering information, waiting, switching context, or recovering. Reuse known information with a visible, editable result. Preserve drafts and show information at the decision point. Support leaving and returning where the product can. Keep an extra step when it prevents a costly mistake and explain its consequence. Fewer taps or a shorter screen is not automatically easier.",
      "Specify the flow, hierarchy, exact labels, and states that matter, including empty, loading, long content, success, error, and recovery. Use coherent type, spacing, alignment, contrast, and icons. Write in the customer's words with specific actions and outcomes. Errors explain what happened and what to do next. Only promise saving or recovery the system can verify; keep architecture jargon out of user flows.",
      "Treat mobile as a full interaction: short screens, reachable touch targets, keyboard and voice entry, safe areas, zoom/reflow, scrolling, and long text. Keep recording state understandable without obstructing the text being entered. Include keyboard access, focus restoration, accessible names, contrast, and supported themes. Inspect interaction and appearance; a static narrow screenshot cannot establish phone behavior.",
      "Hand off a compact flow and state specification with component reuse, exact copy, responsive behavior, accessibility criteria, and the visual checks that matter. Explain meaningful tradeoffs and return unresolved product decisions to the coordinator. Do not claim a mockup proves functionality or edit implementation files unless assigned. Follow the board workflow when coordinating.",
    ].join('\n\n'),
    sandbox: 'read-only',
  },
  {
    id: 'builtin-engineer',
    name: 'Engineer',
    role: 'engineering',
    description: 'Implements scoped changes and verifies the work it owns.',
    instructions: [
      "Read the user's intended result, current behavior, relevant decisions, and project rules. Separate evidence from assumptions. Recommend the smallest complete outcome in plain language. Reduce effort to understand, enter information, wait, and recover. Make routine decisions within existing authorization; ask only for consequential missing information.",
      "Deliver integrated behavior in the established architecture. Inspect integration points, code, tests, acceptance criteria, and handoffs before editing. Preserve unrelated user work. Prefer existing components and APIs; add abstractions only for a concrete current need. Follow the project's stack and tooling; technology preferences do not mandate rewrites or integrations.",
      "Make agreements across boundaries checkable. Keep API schemas, types, runtime validation, and real routes aligned using the project's contract path. Specify data, error, and state-transition contracts; static types alone do not validate network data. Check meaningful valid/invalid inputs and invariants. For streaming, account for ordering, completion, cancellation, and failures. Enforce authorization and ownership on the server and consider older open clients during rollout.",
      "Handle affected errors, timeouts, retries, interruption, stale responses, and duplicate requests. Preserve drafts and focus, and implement the agreed responsive, accessible, and voice-entry behavior. Persist and recover long-running work when the product promises it, without adding a job framework by default. Keep transactions clear and short where applicable; review migrations and data recovery. Return useful status and errors without exposing private data.",
      "Coordinate ownership before edits overlap. Independent bounded writes may run in parallel when the runtime permits and files and shared state are independent; serialize overlap, including shared databases, ports, or devices. Understand another agent's changes before replacing them. Explain material scope or interface changes before dependent work. Research unfamiliar or changing APIs in primary documentation.",
      "Keep development reproducible and inspectable. Reuse setup and verification tools; automate repeated work only when useful. Complete the coherent feature boundary, then run affected checks and the relevant user journey. Add focused coverage for important failures or invariants, not tests that mirror every edit. Check earlier when dependencies need evidence, repeat affected checks after repairs, and complete required release checks. Inspect the final diff.",
      "Hand off the delivered behavior, relevant files and contract or data changes, exact checks and results, a real preview link or reproduction steps when available, and limitations. Label mocks, emulation, and actual device evidence. A build is not user success, self-checking is not independent review, and implementation alone does not authorize publication. Follow existing user and repository authorization.",
    ].join('\n\n'),
    sandbox: 'workspace-write',
  },
  {
    id: 'builtin-qa',
    name: 'QA / Validator',
    role: 'qa',
    description: 'Independently checks the result against acceptance criteria.',
    instructions: [
      "Read the user's intended result, current behavior, relevant decisions, and project rules. Separate evidence from assumptions. Recommend the smallest complete outcome in plain language. Reduce effort to understand, enter information, wait, and recover. Make routine decisions within existing authorization; ask only for consequential missing information.",
      "Verify the promised behavior with independent evidence. Read the request, acceptance criteria, relevant design, diff, dependency contracts, and claimed checks. Treat the implementer's handoff as a guide, not proof. Prioritize inability to finish, wrong results, lost work, unauthorized access, duplicates, and broken recovery. Choose checks with known expected results or invariants rather than a second AI's confidence.",
      "Match evidence to the claim. Inspect small copy or spacing changes directly without creating a suite to mirror them. Use behavior tests for rules and boundaries, integration or shared cases for contracts, and write/reload/readback for persistence. Exercise actual journeys and disclose mocked boundaries. Use representative cases and a domain rubric for AI quality; mocked transport proves plumbing only. Compare equivalent before/after scenarios for performance rather than impressions.",
      "Select the main path and meaningful boundaries: invalid, empty or long content, repeats, slow networks, interruption, stale state, and return. Scale checks to the change. For UI work, inspect discovery, completion, and recovery at required desktop/mobile sizes with relevant keyboard, touch, themes, and voice.",
      "Reuse the project's verifier, feature map, fixtures, and setup when present; discover actual cases rather than inventing commands or a parallel QA system. Use isolated test data and existing authorization for external calls, writes, devices, and migrations. Never reset shared data just to simplify a check. For device-specific behavior, read current device instructions, confirm the authorized target, inspect meaningful results, and perform cleanup. Android evidence does not establish iPhone Safari behavior.",
      "Report concrete defects with a reproducible trigger, expected versus observed result, affected surface, severity, and the smallest useful repair direction. Separate blocking failures from optional polish. Remain read-only unless fixes are assigned; return findings to the coordinator for bounded repair, then recheck the repair and affected dependencies. Do not weaken assertions, hide failures, repeatedly rerun until green, or waive the chosen verification policy. Distinguish product, test, and environment failures.",
      "Return pass, fail, or blocked with the criterion, revision and environment, observed checks, evidence, and untested boundaries. Redact private data. A screenshot proves appearance, not persistence or authorization; a passing suite does not prove every criterion, and a narrow browser is not a physical phone. Mark unavailable checks as unverified.",
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
    reasoningEffort: '',
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
    reasoningEffort: readString(record.reasoningEffort) ? normalizeReasoningEffort(record.reasoningEffort) : '',
    sandbox: record.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only',
    builtIn: record.builtIn === true,
    createdAtIso: readString(record.createdAtIso, 100) || new Date(0).toISOString(),
    updatedAtIso: readString(record.updatedAtIso, 100) || new Date(0).toISOString(),
  }
}

export function readProjectBoardExecutionAccess(value: unknown, fallback: ProjectBoardExecutionAccess = 'full-access'): ProjectBoardExecutionAccess {
  if (value === undefined) return fallback
  if (value !== 'full-access' && value !== 'project') throw new Error('Unknown board execution access.')
  return value
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
    executionAccess: record.executionAccess === 'project' ? 'project' : 'full-access',
    autoDispatch: record.autoDispatch !== false,
    maxConcurrentRuns: 1,
    plan: readString(record.plan),
    sourceThreadId: readString(record.sourceThreadId, 200),
    planningThreadId: readString(record.planningThreadId, 200),
    coordinatorAgentId: readString(record.coordinatorAgentId, 200),
    model: readString(record.model, 200),
    reasoningEffort: readOptionalEffort(record.reasoningEffort),
    agentOverrides: readBoardAgentOverrides(record.agentOverrides),
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
    toolSchemaVersion: record.toolSchemaVersion === 3 ? 3 : record.toolSchemaVersion === 2 ? 2 : 1,
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
  const kind: ProjectBoardRunKind = record.kind === 'follow_up' ? 'follow_up' : record.kind === 'board_plan' ? 'board_plan' : record.kind === 'plan' ? 'plan' : 'execute'
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
    stoppedByUser: record.stoppedByUser === true ? true : undefined,
    threadId: readString(record.threadId, 200),
    requestedModel: record.requestedModel === undefined ? undefined : readString(record.requestedModel, 200),
    requestedReasoningEffort: REASONING_EFFORTS.has(requestedReasoningEffort) ? requestedReasoningEffort : undefined,
    observedModel: record.observedModel === undefined ? undefined : readString(record.observedModel, 200),
    observedReasoningEffort: REASONING_EFFORTS.has(record.observedReasoningEffort as ReasoningEffort) ? record.observedReasoningEffort as ReasoningEffort : undefined,
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

function readTeamString(value: unknown, field: string, maxLength = 200): string {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${field} must be text.`)
  if (typeof value === 'string' && value.length > maxLength) throw new Error(`${field} is too long.`)
  return readString(value, maxLength)
}

function readBoardAgentOverrides(value: unknown): Record<string, ProjectBoardAgentOverride> {
  if (value === undefined) return {}
  const record = asRecord(value)
  if (!record) throw new Error('Agent overrides must be an object.')
  return Object.fromEntries(Object.entries(record).map(([id, raw]) => {
    const fields = asRecord(raw)
    if (!fields || Object.keys(fields).some((key) => !['instructions', 'model', 'reasoningEffort'].includes(key))) throw new Error('Agent overrides only support instructions, model, and reasoningEffort.')
    const override: ProjectBoardAgentOverride = {}
    if ('instructions' in fields) {
      override.instructions = readTeamString(fields.instructions, 'Agent instructions', 20_000)
      if (!override.instructions) throw new Error('Agent instructions cannot be empty; remove the override to restore the template.')
    }
    if ('model' in fields) override.model = readTeamString(fields.model, 'Agent model')
    if ('reasoningEffort' in fields) override.reasoningEffort = readOptionalEffort(readTeamString(fields.reasoningEffort, 'Agent reasoning effort'))
    return [id, override]
  }))
}

function readBoardTeam(record: Record<string, unknown>, agents: ProjectBoardAgent[], existing?: ProjectBoard) {
  const knownIds = new Set(agents.map((agent) => agent.id))
  if ('agentIds' in record && (!Array.isArray(record.agentIds) || record.agentIds.some((id) => typeof id !== 'string' || !knownIds.has(id)))) throw new Error('Every team member must be a known agent.')
  const agentIds = 'agentIds' in record ? readStringArray(record.agentIds) : existing?.agentIds ?? [...knownIds]
  if (!agentIds.length) throw new Error('A board must have at least one agent.')
  const coordinatorAgentId = 'coordinatorAgentId' in record ? readTeamString(record.coordinatorAgentId, 'Coordinator agent') : existing?.coordinatorAgentId ?? ''
  if (coordinatorAgentId && !agentIds.includes(coordinatorAgentId)) throw new Error('The default Lead must be enabled on this board.')
  const agentOverrides = 'agentOverrides' in record ? readBoardAgentOverrides(record.agentOverrides) : existing?.agentOverrides ?? {}
  if (Object.keys(agentOverrides).some((id) => !agentIds.includes(id))) throw new Error('Agent overrides must belong to enabled team members. Remove their overrides when removing members.')
  return {
    agentIds, coordinatorAgentId, agentOverrides,
    model: 'model' in record ? readTeamString(record.model, 'Board model') : existing?.model ?? '',
    reasoningEffort: 'reasoningEffort' in record ? readOptionalEffort(readTeamString(record.reasoningEffort, 'Board reasoning effort')) : existing?.reasoningEffort ?? '',
  }
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
      return saved ? {
        ...saved, instructions: agent.instructions, description: agent.description,
        // The old maintained starters forced high reasoning. Blank now inherits
        // the source chat; custom profiles below retain their explicit settings.
        reasoningEffort: saved.reasoningEffort === 'high' ? '' : saved.reasoningEffort,
      } : agent
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
      .map((board) => ({ ...board,
        coordinatorAgentId: board.agentIds.includes(board.coordinatorAgentId) ? board.coordinatorAgentId : '',
        agentOverrides: Object.fromEntries(Object.entries(board.agentOverrides ?? {}).filter(([id]) => board.agentIds.includes(id))),
      }))
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
    ?? roster.find((agent) => agent.id === board.coordinatorAgentId)
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
        ...readBoardTeam(input, current.agents),
        executionAccess: 'full-access',
        autoDispatch: true,
        maxConcurrentRuns: 1,
        plan: '', sourceThreadId: '', planningThreadId: '',
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
        executionAccess: readProjectBoardExecutionAccess(record.executionAccess),
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
        ...readBoardTeam(record, current.agents),
        executionAccess: input.executionAccess!,
        autoDispatch: true,
        maxConcurrentRuns: 1,
        plan: '', sourceThreadId: '', planningThreadId: '',
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
      if (hasProjectBoardTeamChanges(changes) && current.runs.some((run) => run.boardId === id && ['running', 'queued'].includes(run.status))) throw new Error('Stop running board work before changing its Team.')
      const executionAccess = readProjectBoardExecutionAccess(changes.executionAccess, existing.executionAccess)
      if ('maxConcurrentRuns' in changes && changes.maxConcurrentRuns !== 1) {
        throw new Error('Project boards currently support one active feature per board.')
      }
      const makeDefault = changes.isDefault === true
      const team = readBoardTeam(changes, current.agents, existing)
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
            ...team,
            executionAccess,
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
        reasoningEffort: readOptionalEffort(record.reasoningEffort),
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
        reasoningEffort: input.reasoningEffort ?? '',
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
            ? readOptionalEffort(changes.reasoningEffort)
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
          coordinatorAgentId: board.coordinatorAgentId === id ? '' : board.coordinatorAgentId,
          agentOverrides: Object.fromEntries(Object.entries(board.agentOverrides ?? {}).filter(([agentId]) => agentId !== id)),
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
        assignedAgentId: input.assignedAgentId || board.coordinatorAgentId || board.agentIds[0] || '',
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
      const familyIds = new Set(featureCards(current, target).map((card) => card.id))
      if (current.runs.some((run) => familyIds.has(run.cardId) && (run.status === 'running' || run.status === 'queued'))) {
        throw new Error('Stop running work before deleting this card.')
      }
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

  startRun(cardId: string, agentId: string, kind: ProjectBoardRunKind, expectedFingerprint?: string, settings?: { model: string; reasoningEffort: ReasoningEffort }, reopen = false, expectedTeam?: string): Promise<{ snapshot: ProjectBoardSnapshot; run: ProjectBoardRun }> {
    let createdRun!: ProjectBoardRun
    return this.mutate((current) => {
      const card = current.cards.find((entry) => entry.id === cardId)
      if (!card) throw new Error('Board card not found.')
      const board = current.boards.find((entry) => entry.id === card.boardId)
      if (expectedTeam !== undefined && (!board || projectBoardTeamFingerprint(board) !== expectedTeam)) throw new Error('The board Team changed while starting. Review its settings and start again.')
      if (expectedFingerprint !== undefined && projectBoardFeatureFingerprint(card) !== expectedFingerprint) throw new Error('The feature changed while starting. Review its settings and start again.')
      if (card.type !== 'feature') throw new Error('Only features can start a Lead run; QA batches are not executable yet.')
      assertManualEdit(current, card)
      if (kind === 'follow_up' && (card.status !== 'done' || !card.threadId)) throw new Error('Follow-up conversations require a completed feature chat.')
      if (card.status === 'done' && kind !== 'follow_up') {
        if (!reopen) throw new Error('This feature is already done. Choose Reopen feature to send a follow-up.')
        const dependent = current.cards.find((entry) => entry.dependencyIds.includes(card.id) && ['working', 'done', 'review'].includes(entry.status))
        if (dependent) throw new Error(`Reopen dependent card "${dependent.title}" first.`)
      }
      if (kind === 'plan' && current.cards.some((entry) => entry.parentCardId === cardId && (entry.status === 'working' || entry.status === 'done'))) {
        throw new Error('This feature already has execution history. Continue its existing plan or reopen a task for repair.')
      }
      const blocker = kind === 'plan' || kind === 'follow_up' ? '' : dependencyBlocker(current, card)
      if (blocker) throw new Error(blocker)
      if (kind !== 'follow_up' && current.runs.some((run) => run.boardId === card.boardId && run.kind !== 'follow_up' && run.status === 'running')) {
        throw new Error('Wait for this board’s active run to finish.')
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
        cards: current.cards.map((entry) => entry.id === cardId && kind !== 'follow_up'
          ? cardWithStatus(entry, 'working', now, kind === 'plan' ? 'Lead is planning' : `${agent.name} is working`)
          : entry),
      }
      next = recalculateParent(next, card.parentCardId, now)
      return next
    }).then((snapshot) => ({ snapshot, run: createdRun }))
  }

  startBoardPlan(boardId: string, agentId: string, plan: string, sourceThreadId: string, settings?: { model: string; reasoningEffort: ReasoningEffort }, expectedTeam?: string): Promise<{ snapshot: ProjectBoardSnapshot; run: ProjectBoardRun }> {
    let run!: ProjectBoardRun
    return this.mutate((current) => {
      const board = current.boards.find((entry) => entry.id === boardId)
      if (!board || !board.agentIds.includes(agentId)) throw new Error('Choose a coordinator enabled on this board.')
      if (expectedTeam !== undefined && projectBoardTeamFingerprint(board) !== expectedTeam) throw new Error('The board Team changed while starting. Review its settings and start again.')
      if (current.runs.some((entry) => entry.boardId === boardId && entry.kind !== 'follow_up' && entry.status === 'running')) throw new Error('Wait for this board’s active run to finish.')
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
          autoRun: false, model: readString(feature.model, 200), reasoningEffort: readOptionalEffort(feature.reasoningEffort), planSummary: '', planStatus: 'none', toolSchemaVersion: 1, threadId: '', sourceThreadId: board.sourceThreadId, lastRunId: runId,
          summary: '', progressNote: 'Review the proposed feature before starting', createdAtIso: now, updatedAtIso: now, completedAtIso: '',
        }
      })
      const next = { ...current, cards: [...cards, ...current.cards], runs: current.runs.map((entry) => entry.id === runId ? { ...entry, createdCardIds: cards.map((card) => card.id) } : entry) }
      assertCardDependencies(next)
      return next
    })
  }

  saveDraftPlan(inputValue: unknown): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const input = asRecord(inputValue)
      if (!input || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== current.version) {
        throw new Error('The board changed. Read its latest plan before saving again.')
      }
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
      const boardId = readString(input.boardId, 200).toLowerCase()
      const projectPath = readString(input.projectPath, 4_000)
      const sourceThreadId = readString(input.sourceThreadId, 200)
      if (!uuid.test(boardId)) throw new Error('A stable board UUID is required.')
      if (!projectPath) throw new Error('A project folder is required.')
      if (typeof input.sourceThreadId !== 'string' || !sourceThreadId || input.sourceThreadId.trim().length > 200 || /[\s\u0000-\u001f\u007f]/u.test(sourceThreadId)) {
        throw new Error('A valid source chat ID is required.')
      }
      if (typeof input.summary !== 'string') throw new Error('A plan summary is required.')
      if (!Array.isArray(input.features) || !input.features.length || input.features.length > 30) throw new Error('Provide between 1 and 30 feature cards.')
      const existingBoard = current.boards.find((board) => board.id === boardId)
      if (existingBoard && existingBoard.projectPath !== projectPath) throw new Error('The board belongs to a different project.')
      if (current.runs.some((run) => run.boardId === boardId && run.kind !== 'follow_up' && (run.status === 'running' || run.status === 'queued'))) {
        throw new Error('Wait for this board’s active run to stop before revising its plan.')
      }
      const now = this.now().toISOString()
      const board: ProjectBoard = {
        ...(existingBoard ?? {
          id: boardId, projectPath,
          projectName: readString(input.projectName, 200) || projectPath.split('/').filter(Boolean).at(-1) || 'Project',
          name: 'Project board', isDefault: !current.boards.some((entry) => entry.projectPath === projectPath),
          agentIds: current.agents.map((agent) => agent.id), executionAccess: 'full-access', autoDispatch: true, maxConcurrentRuns: 1,
          plan: '', sourceThreadId: '', planningThreadId: '', coordinatorAgentId: '', model: '', reasoningEffort: '', agentOverrides: {}, createdAtIso: now, updatedAtIso: now,
        }),
        name: readString(input.name, 120) || existingBoard?.name || 'Project board',
        plan: readString(input.summary), sourceThreadId, updatedAtIso: now,
      }
      const ids = new Set<string>()
      const savedCards = input.features.map((value) => {
        const feature = asRecord(value)
        const id = readString(feature?.id, 200).toLowerCase()
        if (!feature || !uuid.test(id) || ids.has(id)) throw new Error('Feature IDs must be unique stable UUIDs.')
        ids.add(id)
        const allowed = new Set(['id', 'title', 'description', 'acceptanceCriteria', 'agentId', 'verificationPolicy', 'dependsOn', 'model', 'reasoningEffort'])
        if (Object.keys(feature).some((field) => !allowed.has(field))) throw new Error('Draft plans can only change feature briefs, dependencies, and agent settings.')
        const existing = current.cards.find((card) => card.id === id)
        if (existing && (existing.boardId !== boardId || existing.type !== 'feature' || existing.status !== 'backlog'
          || existing.threadId || current.cards.some((card) => card.parentCardId === id) || current.runs.some((run) => run.cardId === id))) {
          throw new Error('Only unstarted Backlog features on this board can be revised. Keep existing work and add a follow-up feature instead.')
        }
        if (existing) assertManualEdit(current, existing)
        if (typeof feature.description !== 'string' || typeof feature.acceptanceCriteria !== 'string') throw new Error('Every feature needs a brief and acceptance criteria.')
        const description = readString(feature.description)
        const title = (feature.title === undefined ? existing?.title : readString(feature.title, 240)) || projectBoardTitleFromBrief(description)
        if (!title) throw new Error('Every feature needs a brief or a title.')
        if (!Array.isArray(feature.dependsOn) || feature.dependsOn.some((dependency) => typeof dependency !== 'string' || !uuid.test(dependency))) throw new Error('Feature dependencies must be card UUIDs.')
        const assignedAgentId = feature.agentId === undefined ? existing?.assignedAgentId || board.coordinatorAgentId || board.agentIds[0] || '' : readString(feature.agentId, 200)
        if (!board.agentIds.includes(assignedAgentId)) throw new Error('Every feature must choose an enabled agent.')
        if (feature.verificationPolicy !== undefined && !VERIFICATION_POLICIES.has(feature.verificationPolicy as ProjectBoardVerificationPolicy)) throw new Error('Unknown verification policy.')
        const card: ProjectBoardCard = {
          ...(existing ?? {
            id, boardId, parentCardId: '', type: 'feature', taskPurpose: 'work', title: '', description: '', acceptanceCriteria: '',
            status: 'backlog', priority: 'normal', verificationPolicy: 'self', assignedAgentId: '', dependencyIds: [], autoRun: false,
            model: '', reasoningEffort: '', planSummary: '', planStatus: 'none', toolSchemaVersion: 1, threadId: '', lastRunId: '',
            summary: '', progressNote: '', createdAtIso: now, updatedAtIso: now, completedAtIso: '',
          }),
          title, description, acceptanceCriteria: readString(feature.acceptanceCriteria), assignedAgentId,
          verificationPolicy: feature.verificationPolicy === undefined ? existing?.verificationPolicy ?? 'self' : normalizeVerificationPolicy(feature.verificationPolicy),
          dependencyIds: readStringArray(feature.dependsOn).map((dependency) => dependency.toLowerCase()),
          model: feature.model === undefined ? existing?.model ?? '' : readString(feature.model, 200),
          reasoningEffort: feature.reasoningEffort === undefined ? existing?.reasoningEffort ?? '' : readOptionalEffort(feature.reasoningEffort),
          sourceThreadId, autoRun: false, progressNote: 'Review the proposed feature before starting', updatedAtIso: now,
        }
        return card
      })
      const next = {
        ...current,
        boards: existingBoard ? current.boards.map((entry) => entry.id === boardId ? board : entry) : [board, ...current.boards],
        cards: [...savedCards.filter((card) => !current.cards.some((entry) => entry.id === card.id)), ...current.cards.map((card) => savedCards.find((entry) => entry.id === card.id) ?? card)],
      }
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

  confirmRunSettings(runId: string, threadId: string, settings: { model: string; reasoningEffort: ReasoningEffort }): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => ({ ...current, runs: current.runs.map((run) =>
      run.id === runId && run.threadId === threadId && run.status === 'running'
        ? { ...run, observedModel: settings.model, observedReasoningEffort: settings.reasoningEffort } : run) }))
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
        cards: current.cards.map((card) => card.id === run.cardId && run.kind !== 'follow_up' ? { ...card, threadId, lastRunId: runId, toolSchemaVersion: toolSchemaVersion ?? card.toolSchemaVersion } : card),
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

  reopenFollowUp(runId: string, reasonValue: unknown, taskId = '', assertCanReopen: () => void = () => undefined): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const run = current.runs.find((entry) => entry.id === runId && entry.status === 'running')
      const feature = current.cards.find((card) => card.id === run?.cardId && card.type === 'feature')
      const reason = readString(reasonValue)
      if (!run || run.kind !== 'follow_up' || !feature || feature.status !== 'done') throw new Error('This completed feature conversation is no longer available to reopen.')
      if (!reason) throw new Error('A repair reason is required before reopening the feature.')
      if (current.runs.some((entry) => entry.boardId === run.boardId && entry.id !== runId && entry.kind !== 'follow_up' && entry.status === 'running')) throw new Error('Another feature is running on this board. Continue the conversation and retry reopening when it finishes.')
      const dependent = current.cards.find((card) => card.dependencyIds.includes(feature.id) && ['working', 'done', 'review'].includes(card.status))
      if (dependent) throw new Error(`Reopen dependent card "${dependent.title}" first.`)
      const repairCandidates = current.cards.filter((card) => card.parentCardId === feature.id
        && !current.cards.some((dependent) => dependent.dependencyIds.includes(card.id) && ['working', 'done', 'review'].includes(dependent.status)))
      const task = taskId ? current.cards.find((card) => card.id === taskId && card.parentCardId === feature.id)
        : repairCandidates.find((card) => card.taskPurpose === 'verification') ?? repairCandidates.at(-1)
      if (taskId && !task) throw new Error('Task does not belong to this feature.')
      if (!task) throw new Error('Choose an affected task whose dependents can be reopened first.')
      if (task?.status === 'working') throw new Error('Block the active task before reopening it.')
      if (task && current.cards.some((card) => card.dependencyIds.includes(task.id) && ['working', 'done', 'review'].includes(card.status))) throw new Error('Reopen dependent verification tasks before reopening the completed work.')
      assertCanReopen()
      const now = this.now()
      return {
        ...current,
        runs: current.runs.map((entry) => entry.id === runId ? { ...entry, kind: 'execute' as const } : entry),
        cards: current.cards.map((card) => card.id === feature.id ? cardWithStatus({ ...card, lastRunId: runId }, 'working', now, `Reopened: ${reason}`)
          : card.id === task?.id ? cardWithStatus(card, 'backlog', now, reason) : card),
        comments: [{ id: randomUUID(), boardId: run.boardId, cardId: task?.id || feature.id, runId, author: 'Lead', text: `Reopened: ${reason}\nPrevious handoff: ${task?.summary || feature.summary || '(none)'}`, createdAtIso: now.toISOString() }, ...current.comments],
      }
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

  failRun(runId: string, errorValue: unknown, status: 'failed' | 'interrupted' = 'failed', stoppedByUser = false): Promise<ProjectBoardSnapshot> {
    return this.mutate((current) => {
      const run = current.runs.find((entry) => entry.id === runId)
      if (!run || run.status !== 'running') return current
      const card = current.cards.find((entry) => entry.id === run.cardId)
      const now = this.now()
      const error = readString(errorValue) || 'Agent run failed.'
      let next: ProjectBoardSnapshot = {
        ...current,
        cards: current.cards.map((entry) => run.kind !== 'follow_up' && run.cardId && (entry.id === run.cardId || (entry.parentCardId === run.cardId && entry.status === 'working'))
          ? cardWithStatus({ ...entry, summary: entry.summary || error }, 'blocked', now, error)
          : entry),
        runs: current.runs.map((entry) => entry.id === runId ? {
          ...entry,
          status,
          stoppedByUser: stoppedByUser || undefined,
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
      const interruptedRuns = current.runs.filter((run) => run.status === 'running' || run.status === 'queued')
      const interruptedCardIds = new Set(interruptedRuns.filter((run) => run.kind !== 'follow_up').map((run) => run.cardId))
      if (interruptedRuns.length === 0) return current
      const now = this.now()
      let next: ProjectBoardSnapshot = {
        ...current,
        runs: current.runs.map((run) => run.status === 'running' || run.status === 'queued' ? {
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
