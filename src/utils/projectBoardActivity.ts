import type { ProjectBoardSnapshot } from '../types/projectBoards'

export type ProjectBoardActivity = {
  boardId: string
  featureId: string
  threadId: string
  title: string
  boardName: string
  status: 'running' | 'needs_input' | 'review' | 'blocked' | 'paused' | 'done' | 'backlog'
  updatedAtIso: string
  summary: string
}

/** Board state remains discoverable even before its Lead reaches the chat list. */
export function collectProjectBoardActivity(snapshot: ProjectBoardSnapshot): ProjectBoardActivity[] {
  const boards = new Map(snapshot.boards.map((board) => [board.id, board]))
  const activity: ProjectBoardActivity[] = []
  for (const card of snapshot.cards) {
    if (card.type === 'task' || !boards.has(card.boardId)) continue
    const runs = snapshot.runs.filter((run) => run.cardId === card.id)
    const activeRun = runs.find((run) => run.status === 'queued' || run.status === 'running')
    const latestRun = runs.find((run) => run.id === card.lastRunId) || runs[0]
    activity.push({
      boardId: card.boardId,
      featureId: card.id,
      threadId: activeRun?.threadId || card.threadId || latestRun?.threadId || '',
      title: card.title,
      boardName: boards.get(card.boardId)!.name,
      status: card.status === 'needs_input' ? 'needs_input' : activeRun ? 'running' : card.status === 'working' ? 'paused' : card.status,
      updatedAtIso: card.updatedAtIso,
      summary: latestRun?.error || card.progressNote || card.summary || '',
    })
  }
  for (const board of snapshot.boards) {
    const runs = snapshot.runs.filter((run) => run.boardId === board.id && run.kind === 'board_plan')
    const activeRun = runs.find((run) => run.status === 'queued' || run.status === 'running')
    const latestRun = activeRun || runs[0]
    if (!latestRun || !(latestRun.threadId || board.planningThreadId)) continue
    activity.push({
      boardId: board.id,
      featureId: '',
      threadId: latestRun.threadId || board.planningThreadId,
      title: `Plan ${board.name}`,
      boardName: board.name,
      status: activeRun ? 'running' : latestRun.status === 'succeeded' ? 'review' : 'blocked',
      updatedAtIso: latestRun.finishedAtIso || latestRun.startedAtIso || board.updatedAtIso,
      summary: latestRun.error || latestRun.summary || '',
    })
  }
  return activity
}
