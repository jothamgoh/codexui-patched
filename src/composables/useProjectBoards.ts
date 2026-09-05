import { computed, ref } from 'vue'
import {
  addProjectBoardComment,
  answerProjectBoardQuestion,
  createProjectBoard,
  createProjectBoardAgent,
  createProjectBoardCard,
  deleteProjectBoard,
  deleteProjectBoardAgent,
  deleteProjectBoardCard,
  ensureDefaultProjectBoard,
  getProjectBoards,
  isProjectBoardSnapshot,
  startProjectBoardFeature,
  planProjectBoard,
  startProjectBoardQueue,
  stopProjectBoardQueue,
  updateProjectBoard,
  updateProjectBoardAgent,
  updateProjectBoardCard,
  type ProjectBoardAgentUpdateInput,
  type ProjectBoardCardUpdateInput,
  type ProjectBoardCommentInput,
  type ProjectBoardQuestionAnswerInput,
  type ProjectBoardUpdateInput,
  type ProjectBoardPlanInput,
} from '../api/projectBoards'
import { subscribeInPageRpcNotifications } from '../api/codexRpcClient'
import { isWebPushLocallyEnabled } from './useWebPushNotifications'
import type {
  ProjectBoardAgentCreateInput,
  ProjectBoardCardCreateInput,
  ProjectBoardCreateInput,
  ProjectBoardSnapshot,
} from '../types/projectBoards'
import {
  markProjectBoardAttentionSeen,
  projectBoardNeedsInputDeepLink,
  showProjectBoardNotification,
  isProjectBoardNotification,
  type ProjectBoardNeedsInput,
} from '../utils/projectBoardNotifications'

export type { ProjectBoardNeedsInput } from '../utils/projectBoardNotifications'

export type ProjectBoardNeedsInputHandler = (
  attention: ProjectBoardNeedsInput,
  deepLink: string,
) => void

export type UseProjectBoardsOptions = {
  onNeedsInput?: ProjectBoardNeedsInputHandler
  showBrowserNotifications?: boolean
  notifyWhenFocused?: boolean
}

const emptySnapshot = (): ProjectBoardSnapshot => ({
  boards: [],
  cards: [],
  agents: [],
  questions: [],
  comments: [],
  artifacts: [],
  runs: [],
  schemaVersion: 1,
  version: 0,
  updatedAtIso: '',
})

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toNeedsInput(value: unknown): ProjectBoardNeedsInput | null {
  const record = asRecord(value)
  const boardId = readString(record?.boardId)
  const featureId = readString(record?.featureId)
  const questionId = readString(record?.questionId)
  if (!record || !boardId || !featureId || !questionId) return null
  return {
    boardId,
    featureId,
    cardId: readString(record.cardId) || featureId,
    questionId,
    title: readString(record.title) || 'Feature needs your input',
    message: readString(record.message),
  }
}

export function useProjectBoards(options: UseProjectBoardsOptions = {}) {
  const snapshot = ref<ProjectBoardSnapshot>(emptySnapshot())
  const isLoading = ref(false)
  const mutationCount = ref(0)
  const error = ref('')
  const seenAttentionIds = new Set<string>()
  let unsubscribe: (() => void) | null = null
  let needsInputHandler = options.onNeedsInput

  const isMutating = computed(() => mutationCount.value > 0)
  const openQuestions = computed(() => snapshot.value.questions.filter((question) => question.status === 'open'))
  const needsInputCount = computed(() => openQuestions.value.length)

  function applySnapshot(next: ProjectBoardSnapshot): ProjectBoardSnapshot {
    if (next.version >= snapshot.value.version) snapshot.value = next
    return snapshot.value
  }

  async function load(): Promise<void> {
    isLoading.value = true
    error.value = ''
    try {
      applySnapshot(await getProjectBoards())
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : 'Failed to load project boards.'
    } finally {
      isLoading.value = false
    }
  }

  function handleNeedsInput(value: unknown): void {
    const attention = toNeedsInput(value)
    if (!attention || !markProjectBoardAttentionSeen(seenAttentionIds, attention.questionId)) return
    const deepLink = projectBoardNeedsInputDeepLink(attention)

    try {
      needsInputHandler?.(attention, deepLink)
    } catch {
      // A consumer callback must not stop future board events.
    }
  }

  function startLiveUpdates(): void {
    if (unsubscribe) return
    unsubscribe = subscribeInPageRpcNotifications((notification) => {
      if (notification.method === 'codexui/projectBoards/notification') {
        const event = notification.params
        if (isProjectBoardNotification(event) && options.showBrowserNotifications !== false && !isWebPushLocallyEnabled()) {
          showProjectBoardNotification(event, options.notifyWhenFocused === true)
        }
        return
      }
      if (notification.method === 'codexui/projectBoards/updated') {
        if (isProjectBoardSnapshot(notification.params)) applySnapshot(notification.params)
        return
      }
      if (notification.method === 'codexui/projectBoards/attention') {
        handleNeedsInput(notification.params)
      }
    })
    void load()
  }

  function stopLiveUpdates(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  async function mutate(operation: () => Promise<ProjectBoardSnapshot>): Promise<ProjectBoardSnapshot> {
    mutationCount.value += 1
    error.value = ''
    try {
      return applySnapshot(await operation())
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : 'Project board update failed.'
      throw caught
    } finally {
      mutationCount.value = Math.max(0, mutationCount.value - 1)
    }
  }

  function setNeedsInputHandler(handler?: ProjectBoardNeedsInputHandler): void {
    needsInputHandler = handler
  }

  return {
    snapshot,
    isLoading,
    isMutating,
    error,
    clearError: () => { error.value = '' },
    openQuestions,
    needsInputCount,
    load,
    start: startLiveUpdates,
    stop: stopLiveUpdates,
    startLiveUpdates,
    stopLiveUpdates,
    setNeedsInputHandler,
    ensureDefaultBoard: (input: ProjectBoardCreateInput) =>
      mutate(() => ensureDefaultProjectBoard(input)),
    createBoard: (input: ProjectBoardCreateInput) =>
      mutate(() => createProjectBoard(input)),
    updateBoard: (id: string, changes: ProjectBoardUpdateInput) =>
      mutate(() => updateProjectBoard(id, changes)),
    deleteBoard: (id: string) =>
      mutate(() => deleteProjectBoard(id)),
    createAgent: (input: ProjectBoardAgentCreateInput) =>
      mutate(() => createProjectBoardAgent(input)),
    updateAgent: (id: string, changes: ProjectBoardAgentUpdateInput) =>
      mutate(() => updateProjectBoardAgent(id, changes)),
    deleteAgent: (id: string) =>
      mutate(() => deleteProjectBoardAgent(id)),
    createCard: (input: ProjectBoardCardCreateInput) =>
      mutate(() => createProjectBoardCard(input)),
    updateCard: (id: string, changes: ProjectBoardCardUpdateInput) =>
      mutate(() => updateProjectBoardCard(id, changes)),
    deleteCard: (id: string) =>
      mutate(() => deleteProjectBoardCard(id)),
    addComment: (cardId: string, input: ProjectBoardCommentInput) =>
      mutate(() => addProjectBoardComment(cardId, input)),
    answerQuestion: (questionId: string, input: ProjectBoardQuestionAnswerInput) =>
      mutate(() => answerProjectBoardQuestion(questionId, input)),
    startFeature: (featureId: string, allowWorkspaceWrite = false, mode: 'plan' | 'execute' = 'execute') =>
      mutate(() => startProjectBoardFeature(featureId, allowWorkspaceWrite, mode)),
    planBoard: (boardId: string, input: ProjectBoardPlanInput) =>
      mutate(() => planProjectBoard(boardId, input)),
    startQueue: (boardId: string, featureIds: string[], allowWorkspaceWrite: boolean) =>
      mutate(() => startProjectBoardQueue(boardId, featureIds, allowWorkspaceWrite)),
    stopQueue: (boardId: string) => mutate(() => stopProjectBoardQueue(boardId)),
  }
}
