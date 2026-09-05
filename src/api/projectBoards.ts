import type {
  ProjectBoard,
  ProjectBoardAgent,
  ProjectBoardAgentCreateInput,
  ProjectBoardCard,
  ProjectBoardCardCreateInput,
  ProjectBoardCreateInput,
  ProjectBoardSnapshot,
} from '../types/projectBoards'
import type { ReasoningEffort } from '../types/codex'
import type { ProjectBoardModelCatalog } from '../types/projectBoardModels'

export type ProjectBoardUpdateInput = Partial<Pick<
  ProjectBoard,
  'name' | 'isDefault' | 'agentIds' | 'autoDispatch' | 'plan' | 'coordinatorAgentId'
>>

export type ProjectBoardAgentUpdateInput = Partial<Pick<
  ProjectBoardAgent,
  'name' | 'role' | 'description' | 'instructions' | 'model' | 'reasoningEffort' | 'sandbox'
>>

export type ProjectBoardCardUpdateInput = Partial<Pick<
  ProjectBoardCard,
  | 'title'
  | 'description'
  | 'acceptanceCriteria'
  | 'status'
  | 'priority'
  | 'verificationPolicy'
  | 'taskPurpose'
  | 'assignedAgentId'
  | 'autoRun'
  | 'dependencyIds'
  | 'model'
  | 'reasoningEffort'
>>

export type ProjectBoardPlanInput = {
  plan: string
  sourceThreadId?: string
  coordinatorAgentId?: string
  model?: string
  reasoningEffort?: ReasoningEffort | ''
}

export type ProjectBoardChatMessageInput = {
  input: Array<Record<string, unknown>>
  clientUserMessageId?: string
  expectedTurnId?: string
  attachments?: unknown[]
  mode?: 'plan' | 'execute'
  allowWorkspaceWrite?: boolean
  reopenAndSend?: boolean
}

export type ProjectBoardCommentInput = {
  text: string
  author?: string
}

export type ProjectBoardQuestionAnswerInput = {
  answer: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function isProjectBoardSnapshot(value: unknown): value is ProjectBoardSnapshot {
  const snapshot = asRecord(value)
  return Boolean(
    snapshot
    && Array.isArray(snapshot.boards)
    && Array.isArray(snapshot.cards)
    && Array.isArray(snapshot.agents)
    && Array.isArray(snapshot.questions)
    && Array.isArray(snapshot.comments)
    && Array.isArray(snapshot.artifacts)
    && Array.isArray(snapshot.runs)
    && typeof snapshot.schemaVersion === 'number'
    && typeof snapshot.version === 'number',
  )
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

async function requestProjectBoardSnapshot(path: string, init?: RequestInit): Promise<ProjectBoardSnapshot> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Project board request could not be sent.')
  }

  const payload = await response.json().catch(() => null) as unknown
  const envelope = asRecord(payload)
  if (!response.ok) {
    const message = envelope?.error
    throw new Error(typeof message === 'string'
      ? message
      : `Project board request failed (${response.status.toString()}).`)
  }

  const snapshot = envelope?.data
  if (!isProjectBoardSnapshot(snapshot)) {
    throw new Error('Project board response was invalid.')
  }
  return snapshot
}

function projectBoardPath(path: string): string {
  return `/codex-api/${path}`
}

export function getProjectBoards(): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(projectBoardPath('project-boards'))
}

export function ensureDefaultProjectBoard(input: ProjectBoardCreateInput): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath('project-boards/ensure'),
    jsonRequest('POST', input),
  )
}

export function createProjectBoard(input: ProjectBoardCreateInput): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath('project-boards'),
    jsonRequest('POST', input),
  )
}

export function updateProjectBoard(
  boardId: string,
  changes: ProjectBoardUpdateInput,
): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath(`project-boards/${encodeURIComponent(boardId)}`),
    jsonRequest('PATCH', changes),
  )
}

export function deleteProjectBoard(boardId: string): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath(`project-boards/${encodeURIComponent(boardId)}`),
    { method: 'DELETE' },
  )
}

export function createProjectBoardAgent(input: ProjectBoardAgentCreateInput): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath('project-board-agents'),
    jsonRequest('POST', input),
  )
}

export function updateProjectBoardAgent(
  agentId: string,
  changes: ProjectBoardAgentUpdateInput,
): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath(`project-board-agents/${encodeURIComponent(agentId)}`),
    jsonRequest('PATCH', changes),
  )
}

export function deleteProjectBoardAgent(agentId: string): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath(`project-board-agents/${encodeURIComponent(agentId)}`),
    { method: 'DELETE' },
  )
}

export function createProjectBoardCard(input: ProjectBoardCardCreateInput): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath('project-board-cards'),
    jsonRequest('POST', input),
  )
}

export function updateProjectBoardCard(
  cardId: string,
  changes: ProjectBoardCardUpdateInput,
): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath(`project-board-cards/${encodeURIComponent(cardId)}`),
    jsonRequest('PATCH', changes),
  )
}

export function deleteProjectBoardCard(cardId: string): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath(`project-board-cards/${encodeURIComponent(cardId)}`),
    { method: 'DELETE' },
  )
}

export function addProjectBoardComment(
  cardId: string,
  input: ProjectBoardCommentInput,
): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath(`project-board-cards/${encodeURIComponent(cardId)}/comments`),
    jsonRequest('POST', input),
  )
}

export function answerProjectBoardQuestion(
  questionId: string,
  input: ProjectBoardQuestionAnswerInput,
): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath(`project-board-questions/${encodeURIComponent(questionId)}/answer`),
    jsonRequest('POST', input),
  )
}

export function startProjectBoardFeature(featureId: string, allowWorkspaceWrite = false, mode: 'plan' | 'execute' = 'execute'): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(
    projectBoardPath(`project-board-cards/${encodeURIComponent(featureId)}/start`),
    jsonRequest('POST', { allowWorkspaceWrite, mode }),
  )
}

export function stopProjectBoardFeature(featureId: string, expectedRunId?: string): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(projectBoardPath(`project-board-cards/${encodeURIComponent(featureId)}/stop`), jsonRequest('POST', { expectedRunId }))
}

export function planProjectBoard(boardId: string, input: ProjectBoardPlanInput): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(projectBoardPath(`project-boards/${encodeURIComponent(boardId)}/plan`), jsonRequest('POST', input))
}

export function sendProjectBoardChatMessage(threadId: string, input: ProjectBoardChatMessageInput): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(projectBoardPath(`project-board-threads/${encodeURIComponent(threadId)}/messages`), jsonRequest('POST', input))
}

export function startProjectBoardQueue(boardId: string, featureIds: string[], allowWorkspaceWrite: boolean): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(projectBoardPath(`project-boards/${encodeURIComponent(boardId)}/queue`), jsonRequest('POST', { featureIds, allowWorkspaceWrite }))
}

export function stopProjectBoardQueue(boardId: string): Promise<ProjectBoardSnapshot> {
  return requestProjectBoardSnapshot(projectBoardPath(`project-boards/${encodeURIComponent(boardId)}/queue`), { method: 'DELETE' })
}

export async function getProjectBoardModels(): Promise<ProjectBoardModelCatalog> {
  const response = await fetch(projectBoardPath('project-board-models'))
  const payload = asRecord(await response.json().catch(() => null))
  const data = asRecord(payload?.data)
  if (!response.ok || !Array.isArray(data?.models)) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not load model settings.')
  return data as ProjectBoardModelCatalog
}
