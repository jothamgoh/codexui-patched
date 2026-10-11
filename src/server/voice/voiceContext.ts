/**
 * Builds the voice router's view of the chats from server-side sources, using
 * the notification panel's own selection (src/utils/notificationActivity.ts),
 * so a spoken "what's unread" lists what the panel lists.
 *
 * The browser derives a few flags itself (unread, running, helper chats); this
 * module mirrors those rules: useDesktopState's applyThreadFlags for unread,
 * App.vue's board derivations, and normalizeThreadV2 for helper ancestry.
 */
import { normalizeThreadV2 } from '../../api/normalizers/v2'
import type { Thread } from '../../api/appServerDtos'
import type { UiThread } from '../../types/codex'
import type { ProjectBoardSnapshot } from '../../types/projectBoards'
import { VOICE_LIST_TYPES, type VoiceChatRow, type VoiceListType, type VoiceProjectOption } from '../../types/voice'
import { activityThreadTitle, selectNotificationActivity, type ActivityHistoryItem, type BoardAttentionItem } from '../../utils/notificationActivity'
import { collectProjectBoardActivity } from '../../utils/projectBoardActivity'
import type { VoiceContext } from './voiceRouter'

export type VoiceSourceSnapshot = {
  /** thread/list rows from both backends (raw app-server summaries). */
  threadSummaries: unknown[]
  /** Raw summaries of running chats missing from the list, such as helper sub-chats. */
  extraSummaries?: unknown[]
  titles: Record<string, string>
  readState: { readAtByThreadId: Record<string, string>; unreadThreadIds: string[] }
  activeTurnThreadIds: string[]
  backgroundThreadIds: string[]
  pendingRequests: Array<{ id: number; method: string; params: unknown; receivedAtIso?: string }>
  history: ActivityHistoryItem[]
  dismissals: Array<{ threadId: string; activityAt: string }>
  boardSnapshot: ProjectBoardSnapshot | null
  workspaceRoots: { order: string[]; labels: Record<string, string> }
  nowMs: number
}

const SUMMARY_LENGTH = 160

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function oneLine(value: string): string {
  const line = value.replace(/\s+/gu, ' ').trim()
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…` : line
}

function hasActivityAfterRead(readAtIso: string, updatedAtIso: string): boolean {
  const readAt = Date.parse(readAtIso)
  const updatedAt = Date.parse(updatedAtIso)
  if (Number.isFinite(readAt) && Number.isFinite(updatedAt)) return updatedAt > readAt
  return readAtIso !== updatedAtIso
}

function normalizeSummary(value: unknown): UiThread | null {
  const record = asRecord(value)
  if (!record || typeof record.id !== 'string' || !record.id || typeof record.cwd !== 'string') return null
  try {
    return normalizeThreadV2({ preview: '', createdAt: 0, updatedAt: 0, ...record } as unknown as Thread)
  } catch {
    return null
  }
}

function isWorktreePath(cwd: string): boolean {
  return /\/\.(?:codex|claude|git)\/worktrees\//u.test(cwd)
}

function leafName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

/** The flags the browser computes for each chat, from server state. */
export function flagThreads(snapshot: VoiceSourceSnapshot): UiThread[] {
  const active = new Set(snapshot.activeTurnThreadIds)
  const background = new Set(snapshot.backgroundThreadIds)
  const unreadByEvent = new Set(snapshot.readState.unreadThreadIds)
  const seen = new Set<string>()
  const threads: UiThread[] = []
  for (const raw of [...snapshot.threadSummaries, ...(snapshot.extraSummaries ?? [])]) {
    const thread = normalizeSummary(raw)
    if (!thread || seen.has(thread.id)) continue
    seen.add(thread.id)
    const title = snapshot.titles[thread.id]
    const inProgress = thread.inProgress || active.has(thread.id)
    const hasBackgroundTasks = thread.hasBackgroundTasks === true || background.has(thread.id)
    const readAt = snapshot.readState.readAtByThreadId[thread.id]
    const helper = thread.isInternalSubagent === true || Boolean(thread.parentThreadId)
    const unread = !helper && !inProgress && !hasBackgroundTasks &&
      (unreadByEvent.has(thread.id) || (typeof readAt === 'string' && readAt.length > 0 && hasActivityAfterRead(readAt, thread.updatedAtIso)))
    threads.push({ ...thread, ...(title ? { title } : {}), inProgress, hasBackgroundTasks, unread })
  }
  return threads
}

/** App.vue's board derivations: managed chat ids, activity, titles and open questions. */
export function boardInputs(snapshot: ProjectBoardSnapshot | null) {
  if (!snapshot) return { boardThreadIds: [], boardActivity: [], boardActivityTitles: {}, boardAttention: [] as BoardAttentionItem[] }
  const boardThreadIds = Array.from(new Set([
    ...snapshot.cards.map((card) => card.threadId),
    ...snapshot.boards.map((board) => board.planningThreadId),
    ...snapshot.runs.map((run) => run.threadId),
  ].filter((id): id is string => Boolean(id))))
  const boardActivityTitles = Object.fromEntries([
    ...snapshot.boards.map((board) => [board.id, board.name]),
    ...snapshot.cards.map((card) => [card.id, card.title]),
  ])
  const boardAttention: BoardAttentionItem[] = snapshot.questions
    .filter((question) => question.status === 'open')
    .map((question) => {
      const card = snapshot.cards.find((entry) => entry.id === question.cardId)
      const feature = card?.type === 'feature' || card?.type === 'qa_batch'
        ? card
        : snapshot.cards.find((entry) => entry.id === card?.parentCardId)
      return {
        questionId: question.id,
        boardId: question.boardId,
        featureId: feature?.id ?? question.cardId,
        title: feature?.title ?? card?.title ?? 'Feature needs your input',
        prompt: question.prompt,
        createdAtIso: question.createdAtIso,
      }
    })
  return { boardThreadIds, boardActivity: collectProjectBoardActivity(snapshot), boardActivityTitles, boardAttention }
}

export function buildVoiceContext(snapshot: VoiceSourceSnapshot): VoiceContext {
  const threads = flagThreads(snapshot)
  const board = boardInputs(snapshot.boardSnapshot)
  const pendingRequests = snapshot.pendingRequests.map((request) => {
    const threadId = asRecord(request.params)?.threadId
    return {
      id: request.id,
      method: request.method,
      threadId: typeof threadId === 'string' ? threadId : '',
      receivedAtIso: request.receivedAtIso ?? new Date(snapshot.nowMs).toISOString(),
    }
  })
  const selection = selectNotificationActivity({
    threads,
    boardThreadIds: board.boardThreadIds,
    boardActivity: board.boardActivity,
    boardActivityTitles: board.boardActivityTitles,
    boardAttention: board.boardAttention,
    pendingRequests,
    history: snapshot.history,
    dismissedActivityByThreadId: Object.fromEntries(snapshot.dismissals.map((item) => [item.threadId, item.activityAt])),
  })

  const chats = new Map(selection.activityThreads.map((thread) => [thread.id, thread]))
  const projectLabel = (thread: UiThread) => snapshot.workspaceRoots.labels[thread.cwd] || thread.projectName
  const used = new Set<string>()
  const toRow = (threadId: string, status: VoiceListType, summary?: string): VoiceChatRow | null => {
    const thread = chats.get(threadId)
    if (!thread || used.has(threadId)) return null
    used.add(threadId)
    return {
      threadId,
      title: activityThreadTitle(thread),
      projectName: projectLabel(thread),
      agent: threadId.startsWith('claude-') ? 'claude' : 'codex',
      status,
      updatedAtIso: thread.updatedAtIso || thread.createdAtIso,
      summary: oneLine(summary || thread.preview || ''),
    }
  }
  const rows = (items: Array<VoiceChatRow | null>) => items.filter((row): row is VoiceChatRow => row !== null)

  // Panel order. Board items and helper sub-chats are not voice targets.
  const sections: Record<VoiceListType, VoiceChatRow[]> = {
    needs_you: rows(selection.requestAttention.filter((item) => !item.board).map((item) => toRow(item.threadId, 'needs_you'))),
    running: rows(selection.runningActivity.filter((item) => !item.board).map((item) => toRow(item.threadId, 'running'))),
    unread: rows(selection.unreadActivity.filter((item) => !item.projectBoard).map((item) => toRow(item.threadId, 'unread', item.body))),
    recent: rows(selection.allRecentHistory.filter((item) => !item.projectBoard).map((item) => toRow(item.threadId, 'recent', item.body))),
  }
  const otherChats = rows(selection.activityThreads
    .slice()
    .sort((left, right) => Date.parse(right.updatedAtIso || '0') - Date.parse(left.updatedAtIso || '0'))
    .map((thread) => toRow(thread.id, 'recent')))

  // Projects: folders of recent chats first, then saved workspace roots.
  const projects: VoiceProjectOption[] = []
  const seenFolders = new Set<string>()
  const seenNames = new Set<string>()
  const addProject = (cwd: string, label: string) => {
    const folder = cwd.trim()
    if (!folder || isWorktreePath(folder) || seenFolders.has(folder) || seenNames.has(label)) return
    seenFolders.add(folder)
    seenNames.add(label)
    projects.push({ id: folder, label })
  }
  const byRecency = [...threads].sort((left, right) => Date.parse(right.updatedAtIso || '0') - Date.parse(left.updatedAtIso || '0'))
  for (const thread of byRecency) {
    if (thread.isInternalSubagent || thread.parentThreadId || board.boardThreadIds.includes(thread.id)) continue
    addProject(thread.cwd, projectLabel(thread))
  }
  for (const root of snapshot.workspaceRoots.order) addProject(root, snapshot.workspaceRoots.labels[root] || leafName(root))

  for (const type of VOICE_LIST_TYPES) sections[type] = sections[type] ?? []
  return { sections, otherChats, projects, nowMs: snapshot.nowMs }
}
