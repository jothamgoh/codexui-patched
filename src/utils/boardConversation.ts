import type { ProjectBoard, ProjectBoardSnapshot } from '../types/projectBoards'

/** Reuse the board's planning context, or a real feature Lead for manual boards. */
export function boardConversation(board: ProjectBoard, snapshot: ProjectBoardSnapshot): { threadId: string; label: string } | null {
  if (board.sourceThreadId) return { threadId: board.sourceThreadId, label: 'Open original chat' }
  if (board.planningThreadId) return { threadId: board.planningThreadId, label: 'Open planning chat' }
  const features = snapshot.cards.filter((card) => card.boardId === board.id && card.type === 'feature')
  const latestRun = snapshot.runs.filter((run) => run.boardId === board.id && run.threadId && features.some((card) => card.id === run.cardId))
    .sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso))[0]
  const threadId = latestRun?.threadId || features.filter((card) => card.threadId).sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso))[0]?.threadId
  return threadId ? { threadId, label: 'Open latest Lead chat' } : null
}
