import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectBoardSnapshot } from '../types/projectBoards'

/** Bundled read-only skill; no global skill installation or user config edits. */
export function boardPlanningSkillPath(): string {
  const directory = dirname(fileURLToPath(import.meta.url))
  const packaged = join(directory, 'skills/codexui-board-planning/SKILL.md')
  return existsSync(packaged) ? packaged : join(directory, '../../skills/codexui-board-planning/SKILL.md')
}

export function withBoardPlanningContext(value: unknown, localPort: number | undefined): unknown {
  if (!value || typeof value !== 'object' || !localPort) return value
  const params = value as Record<string, unknown>
  if (typeof params.threadId !== 'string' || !params.threadId) return value
  return {
    ...params,
    additionalContext: {
      ...(params.additionalContext && typeof params.additionalContext === 'object' ? params.additionalContext : {}),
      codexui_optional_board_planning: {
        kind: 'application',
        value: `Only when the user explicitly asks to create/revise a plan in a board or review board work, use the skill at ${JSON.stringify(boardPlanningSkillPath())}. Ordinary tasks and ordinary planning stay in chat. Skill helper connection: --url http://127.0.0.1:${localPort} --thread ${JSON.stringify(params.threadId)}. Saving board cards is planning only; implementation starts through the board's explicit run controls.`,
      },
    },
  }
}

export function boardPlanningContext(snapshot: ProjectBoardSnapshot, projectPath: string, sourceThreadId: string, boardId = '', featureId = '', options: { offset?: number; fullPlan?: boolean } = {}): Record<string, unknown> {
  const boards = snapshot.boards.filter((board) => board.projectPath === projectPath)
  const linked = boards.filter((board) => board.sourceThreadId === sourceThreadId)
  const board = boardId ? boards.find((entry) => entry.id === boardId) : linked.length === 1 ? linked[0] : undefined
  if (boardId && !board) throw new Error('Choose a board in this chat’s project.')
  const features = snapshot.cards.filter((card) => card.boardId === board?.id && card.type === 'feature')
  const feature = features.find((card) => card.id === featureId)
  if (featureId && !feature) throw new Error('Choose a feature in this board.')
  const tasks = feature ? snapshot.cards.filter((card) => card.parentCardId === feature.id) : []
  const ownedIds = new Set(feature ? [feature.id, ...tasks.map((task) => task.id)] : [])
  const offset = Number.isSafeInteger(options.offset) && options.offset! > 0 ? options.offset! : 0
  const page = features.slice(offset, offset + 30)
  return {
    version: snapshot.version, projectPath, sourceThreadId,
    boards: boards.map((entry) => ({ id: entry.id, name: entry.name, sourceThreadId: entry.sourceThreadId })),
    board: board ? { id: board.id, name: board.name, summary: options.fullPlan ? board.plan : board.plan.slice(0, 3000),
      summaryTruncated: !options.fullPlan && board.plan.length > 3000, sourceThreadId: board.sourceThreadId } : null,
    features: page.map((card) => ({
      id: card.id, title: card.title, status: card.status, dependsOn: card.dependencyIds,
      summary: card.summary.slice(0, 200), threadId: card.threadId,
      agentId: card.assignedAgentId, model: card.model, reasoningEffort: card.reasoningEffort,
      verificationPolicy: card.verificationPolicy,
      editableDraft: card.status === 'backlog' && !card.threadId && !snapshot.runs?.some((run) => run.cardId === card.id)
        && !snapshot.cards.some((entry) => entry.parentCardId === card.id),
    })),
    totalFeatureCount: features.length,
    nextOffset: offset + page.length < features.length ? offset + page.length : null,
    agents: snapshot.agents.filter((agent) => !board || board.agentIds.includes(agent.id))
      .map(({ id, name, role, description, model, reasoningEffort }) => ({ id, name, role, description, model, reasoningEffort })),
    ...(feature ? { feature, tasks,
      artifacts: snapshot.artifacts.filter((artifact) => ownedIds.has(artifact.cardId)),
      questions: snapshot.questions.filter((question) => ownedIds.has(question.cardId) && question.status === 'open') } : {}),
  }
}
