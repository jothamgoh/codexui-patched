import type { ProjectBoard, ProjectBoardAgent } from '../types/projectBoards'
import type { ProjectBoardTeamSettings } from './projectBoardTeam'

export function createBoardTeamDraft(agents: ProjectBoardAgent[], board?: Partial<ProjectBoard>): ProjectBoardTeamSettings {
  const agentIds = [...(board?.agentIds ?? agents.filter((agent) => agent.builtIn).map((agent) => agent.id))]
  if (!agentIds.length && agents[0]) agentIds.push(agents[0].id)
  const coordinatorAgentId = board?.coordinatorAgentId || agents.find((agent) => agentIds.includes(agent.id) && agent.role === 'lead')?.id || agentIds[0] || ''
  return { agentIds, coordinatorAgentId, model: board?.model || '', reasoningEffort: board?.reasoningEffort || '',
    agentOverrides: Object.fromEntries(Object.entries(board?.agentOverrides ?? {}).map(([id, overrides]) => [id, { ...overrides }])) }
}
