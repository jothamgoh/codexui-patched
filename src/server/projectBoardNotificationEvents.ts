import type { ProjectBoardSnapshot } from '../types/projectBoards'
import type { ProjectBoardNotification } from '../utils/projectBoardNotifications'

/** Observe committed board snapshots, never model text or generic turn completion. */
export function collectProjectBoardNotifications(
  previous: ProjectBoardSnapshot,
  next: ProjectBoardSnapshot,
): ProjectBoardNotification[] {
  const events: ProjectBoardNotification[] = []
  const previousQuestions = new Map(previous.questions.map((question) => [question.id, question]))
  for (const question of next.questions) {
    if (question.status !== 'open' || previousQuestions.get(question.id)?.status === 'open') continue
    const card = next.cards.find((candidate) => candidate.id === question.cardId)
    if (!card) continue
    events.push({
      id: `project-board-question:${question.id}`,
      kind: 'question',
      boardId: question.boardId,
      featureId: card.parentCardId || card.id,
      cardId: card.id,
      questionId: question.id,
      occurredAt: question.createdAtIso,
    })
  }

  const previousRuns = new Map(previous.runs.map((run) => [run.id, run]))
  for (const run of next.runs) {
    if (previousRuns.get(run.id)?.status === run.status) continue
    const failed = run.status === 'failed' || run.status === 'interrupted'
    const planReady = run.kind === 'board_plan' && run.status === 'succeeded'
    if (!failed && !planReady) continue
    const card = next.cards.find((candidate) => candidate.id === run.cardId)
    events.push({
      id: `project-board-run:${run.id}:${run.status}`,
      kind: failed ? 'failed' : 'plan_ready',
      boardId: run.boardId,
      featureId: card ? card.parentCardId || card.id : '',
      cardId: run.cardId,
      occurredAt: run.finishedAtIso || next.updatedAtIso,
    })
  }

  const previousCards = new Map(previous.cards.map((card) => [card.id, card]))
  for (const card of next.cards) {
    if (card.type !== 'feature' || card.status !== 'done' || previousCards.get(card.id)?.status === 'done') continue
    events.push({
      id: `project-board-completed:${card.id}:${card.completedAtIso || card.updatedAtIso}`,
      kind: 'completed',
      boardId: card.boardId,
      featureId: card.id,
      cardId: card.id,
      ...(card.threadId ? { threadId: card.threadId } : {}),
      ...(previous.queues?.some((queue) => queue.status === 'running' && queue.boardId === card.boardId && queue.featureIds.includes(card.id)) ? { quiet: true } : {}),
      occurredAt: card.completedAtIso || card.updatedAtIso,
    })
  }
  return events
}

export function projectBoardThreadIds(snapshot: ProjectBoardSnapshot): Set<string> {
  return new Set([
    ...snapshot.cards.map((card) => card.threadId),
    ...snapshot.runs.map((run) => run.threadId),
    ...snapshot.boards.map((board) => board.planningThreadId),
  ].filter(Boolean))
}
