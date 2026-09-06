import type { ProjectBoard, ProjectBoardAgent, ProjectBoardAgentOverride } from '../types/projectBoards'
import type { ReasoningEffort } from '../types/codex'

export type ProjectBoardTeamSettings = {
  agentIds: string[]
  coordinatorAgentId: string
  model: string
  reasoningEffort: ReasoningEffort | ''
  agentOverrides: Record<string, ProjectBoardAgentOverride>
}

/** Resolve this board's profile without mutating the reusable template. */
export function resolveProjectBoardAgent(board: ProjectBoard, agent: ProjectBoardAgent, inheritBoardDefaults = true): ProjectBoardAgent {
  const override = board.agentOverrides?.[agent.id]
  return {
    ...agent,
    instructions: override?.instructions ?? agent.instructions,
    // In delegation context, blanks inherit the executing Lead, which may have
    // feature-specific overrides. Only Lead startup and previews use the board fallback.
    model: (override?.model !== undefined ? override.model : agent.model) || (inheritBoardDefaults ? board.model : '') || '',
    reasoningEffort: (override?.reasoningEffort !== undefined ? override.reasoningEffort : agent.reasoningEffort) || (inheritBoardDefaults ? board.reasoningEffort : '') || '',
  }
}

export function hasProjectBoardTeamChanges(value: Record<string, unknown>): boolean {
  return ['agentIds', 'coordinatorAgentId', 'model', 'reasoningEffort', 'agentOverrides'].some((key) => key in value)
}

/** Excludes workflow updates; a pending launch must use one coherent Team snapshot. */
export function projectBoardTeamFingerprint(board: ProjectBoard): string {
  return JSON.stringify([board.agentIds, board.coordinatorAgentId || '', board.model || '', board.reasoningEffort || '', board.agentOverrides || {}])
}
