import type { ReasoningEffort } from './codex'

export type ProjectBoardStatus =
  | 'backlog'
  | 'working'
  | 'needs_input'
  | 'review'
  | 'blocked'
  | 'done'

export type ProjectBoardCardType = 'feature' | 'task' | 'qa_batch'
export type ProjectBoardVerificationPolicy = 'none' | 'self' | 'independent' | 'batch'
export type ProjectBoardPriority = 'low' | 'normal' | 'high' | 'urgent'
export type ProjectBoardAgentRole = 'lead' | 'product' | 'design' | 'engineering' | 'qa' | 'custom'
export type ProjectBoardAgentSandbox = 'read-only' | 'workspace-write'
export type ProjectBoardRunKind = 'plan' | 'execute'
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
  title: string
  description: string
  acceptanceCriteria: string
  status: ProjectBoardStatus
  priority: ProjectBoardPriority
  verificationPolicy: ProjectBoardVerificationPolicy
  assignedAgentId: string
  dependencyIds: string[]
  autoRun: boolean
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
  status: ProjectBoardRunStatus
  threadId: string
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
  title: string
  description?: string
  acceptanceCriteria?: string
  status?: ProjectBoardStatus
  priority?: ProjectBoardPriority
  verificationPolicy?: ProjectBoardVerificationPolicy
  assignedAgentId?: string
  dependencyIds?: string[]
  autoRun?: boolean
}

export type ProjectBoardAgentCreateInput = {
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
  agentRole: ProjectBoardAgentRole
  dependsOn: string[]
}

export type ProjectBoardPlanResult = {
  summary: string
  tasks: ProjectBoardPlanTask[]
}
