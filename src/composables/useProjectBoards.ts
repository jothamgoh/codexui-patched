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
  updateProjectBoard,
  updateProjectBoardAgent,
  updateProjectBoardCard,
  type ProjectBoardAgentUpdateInput,
  type ProjectBoardCardUpdateInput,
  type ProjectBoardCommentInput,
  type ProjectBoardQuestionAnswerInput,
  type ProjectBoardUpdateInput,
} from '../api/projectBoards'
import { subscribeInPageRpcNotifications } from '../api/codexRpcClient'
import type {
  ProjectBoardAgentCreateInput,
  ProjectBoardCardCreateInput,
  ProjectBoardCreateInput,
  ProjectBoardSnapshot,
} from '../types/projectBoards'

export type ProjectBoardNeedsInput = {
  boardId: string
  featureId: string
  cardId: string
  questionId: string
  title: string
  message: string
}

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

export function projectBoardNeedsInputDeepLink(attention: ProjectBoardNeedsInput): string {
  const params = new URLSearchParams({
    feature: attention.featureId,
    question: attention.questionId,
  })
  return `#/board/${encodeURIComponent(attention.boardId)}?${params.toString()}`
}

export function openProjectBoardDeepLink(deepLink: string): void {
  if (typeof window === 'undefined') return
  window.focus()
  window.location.hash = deepLink.startsWith('#') ? deepLink.slice(1) : deepLink
}

export function showProjectBoardNeedsInputNotification(
  attention: ProjectBoardNeedsInput,
  deepLink: string,
  notifyWhenFocused: boolean,
): Notification | null {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return null
  if (Notification.permission !== 'granted') return null
  if (!notifyWhenFocused && document.visibilityState === 'visible' && document.hasFocus()) return null

  try {
    const notification = new Notification('CodexUI needs your input', {
      body: 'Open the project board to answer a question.',
      tag: `project-board-question:${attention.questionId}`,
      data: {
        url: deepLink,
        boardId: attention.boardId,
        featureId: attention.featureId,
        questionId: attention.questionId,
      },
    })
    notification.onclick = () => {
      notification.close()
      openProjectBoardDeepLink(deepLink)
    }
    return notification
  } catch {
    return null
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
    if (!attention || seenAttentionIds.has(attention.questionId)) return
    seenAttentionIds.add(attention.questionId)
    const deepLink = projectBoardNeedsInputDeepLink(attention)

    try {
      needsInputHandler?.(attention, deepLink)
    } catch {
      // A consumer callback must not stop future board events.
    }
    if (options.showBrowserNotifications !== false) {
      showProjectBoardNeedsInputNotification(attention, deepLink, options.notifyWhenFocused === true)
    }
  }

  function startLiveUpdates(): void {
    if (unsubscribe) return
    unsubscribe = subscribeInPageRpcNotifications((notification) => {
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
    startFeature: (featureId: string) =>
      mutate(() => startProjectBoardFeature(featureId)),
  }
}
