import type { ReasoningEffort } from './codex'

export type ProjectBoardStatus =
  | 'backlog'
  | 'working'
  | 'needs_input'
  | 'review'
  | 'blocked'
  | 'done'

export type ProjectBoardCardType = 'feature' | 'task' | 'qa_batch'
export type ProjectBoardTaskPurpose = 'work' | 'verification'
export type ProjectBoardVerificationPolicy = 'none' | 'self' | 'independent' | 'batch'
export type ProjectBoardPriority = 'low' | 'normal' | 'high' | 'urgent'
export type ProjectBoardAgentRole = 'lead' | 'product' | 'design' | 'engineering' | 'qa' | 'custom'
export type ProjectBoardAgentSandbox = 'read-only' | 'workspace-write'
export type ProjectBoardRunKind = 'plan' | 'execute' | 'board_plan'
export type ProjectBoardRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'

export type ProjectBoardAgent = {
  id: string
  name: string
  role: ProjectBoardAgentRole
  description: string
  instructions: string
  model: string
  reasoningEffort: ReasoningEffort
  sandbox: ProjectBoardAgentSandbox
  builtIn: boolean
  createdAtIso: string
  updatedAtIso: string
}

export type ProjectBoard = {
  id: string
  projectPath: string
  projectName: string
  name: string
  isDefault: boolean
  agentIds: string[]
  autoDispatch: boolean
  maxConcurrentRuns: number
  plan: string
  sourceThreadId: string
  planningThreadId: string
  coordinatorAgentId: string
  createdAtIso: string
  updatedAtIso: string
}

export type ProjectBoardArtifact = {
  id: string
  cardId: string
  runId: string
  label: string
  path: string
  createdAtIso: string
}

export type ProjectBoardCard = {
  id: string
  boardId: string
  parentCardId: string
  type: ProjectBoardCardType
  taskPurpose: ProjectBoardTaskPurpose
  title: string
  description: string
  acceptanceCriteria: string
  status: ProjectBoardStatus
  priority: ProjectBoardPriority
  verificationPolicy: ProjectBoardVerificationPolicy
  assignedAgentId: string
  dependencyIds: string[]
  autoRun: boolean
  model: string
  reasoningEffort: ReasoningEffort | ''
  planSummary: string
  planStatus: 'none' | 'ready'
  /** Dynamic tool schema installed when the persistent chat was created. */
  toolSchemaVersion: number
  threadId: string
  lastRunId: string
  summary: string
  progressNote: string
  createdAtIso: string
  updatedAtIso: string
  completedAtIso: string
}

export type ProjectBoardQuestion = {
  id: string
  boardId: string
  cardId: string
  runId: string
  prompt: string
  status: 'open' | 'answered'
  answer: string
  createdAtIso: string
  answeredAtIso: string
}

export type ProjectBoardComment = {
  id: string
  boardId: string
  cardId: string
  runId: string
  author: string
  text: string
  createdAtIso: string
}

export type ProjectBoardRun = {
  id: string
  boardId: string
  cardId: string
  agentId: string
  kind: ProjectBoardRunKind
  createdCardIds: string[]
  status: ProjectBoardRunStatus
  threadId: string
  // Launch request settings, not independently observed runtime telemetry. Absent on legacy runs.
  requestedModel?: string
  requestedReasoningEffort?: ReasoningEffort
  startedAtIso: string
  finishedAtIso: string
  summary: string
  error: string
}

export type ProjectBoardSnapshot = {
  boards: ProjectBoard[]
  cards: ProjectBoardCard[]
  agents: ProjectBoardAgent[]
  questions: ProjectBoardQuestion[]
  comments: ProjectBoardComment[]
  artifacts: ProjectBoardArtifact[]
  runs: ProjectBoardRun[]
  queues?: ProjectBoardQueue[]
  schemaVersion: number
  version: number
  updatedAtIso: string
}

export type ProjectBoardCreateInput = {
  projectPath: string
  projectName: string
  name?: string
  isDefault?: boolean
}

export type ProjectBoardCardCreateInput = {
  boardId: string
  parentCardId?: string
  type?: ProjectBoardCardType
  taskPurpose?: ProjectBoardTaskPurpose
  title?: string
  description?: string
  acceptanceCriteria?: string
  status?: ProjectBoardStatus
  priority?: ProjectBoardPriority
  verificationPolicy?: ProjectBoardVerificationPolicy
  assignedAgentId?: string
  dependencyIds?: string[]
  autoRun?: boolean
  model?: string
  reasoningEffort?: ReasoningEffort | ''
}

export type ProjectBoardAgentCreateInput = {
  /** Enable the new profile on this board; omitted means library only. */
  boardId?: string
  name: string
  role?: ProjectBoardAgentRole
  description?: string
  instructions: string
  model?: string
  reasoningEffort?: ReasoningEffort
  sandbox?: ProjectBoardAgentSandbox
}

export type ProjectBoardPlanTask = {
  key: string
  title: string
  description: string
  acceptanceCriteria: string
  agentId?: string
  /** Compatibility for plans created before explicit agent assignment. */
  agentRole?: ProjectBoardAgentRole
  taskPurpose?: ProjectBoardTaskPurpose
  dependsOn: string[]
}

export type ProjectBoardPlanResult = {
  summary: string
  tasks: ProjectBoardPlanTask[]
}

export type ProjectBoardQueue = {
  boardId: string
  status: 'running' | 'paused'
  featureIds: string[]
  currentFeatureId: string
  reason: string
}

export type ProjectBoardFeaturePlan = {
  summary: string
  features: Array<{
    key: string
    title?: string
    description: string
    acceptanceCriteria: string
    agentId: string
    verificationPolicy: ProjectBoardVerificationPolicy
    /** Other proposed feature keys or existing feature IDs on this board. */
    dependsOn: string[]
  }>
}

export type ProjectBoardStartInput = {
  allowWorkspaceWrite?: boolean
  mode?: 'plan' | 'execute'
}

export type ProjectBoardPlanInput = {
  plan: string
  sourceThreadId?: string
  coordinatorAgentId?: string
  model?: string
  reasoningEffort?: ReasoningEffort | ''
}
