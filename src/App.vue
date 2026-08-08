<template>
  <DesktopLayout :is-sidebar-collapsed="isSidebarCollapsed" @close-sidebar="setSidebarCollapsed(true)">
    <template #sidebar>
      <section class="sidebar-root">
        <SidebarThreadControls
          v-if="!isSidebarCollapsed"
          class="sidebar-thread-controls-host"
          :is-sidebar-collapsed="isSidebarCollapsed"
          :show-new-thread-button="false"
          @toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"
          @start-new-thread="onStartNewThreadFromToolbar"
        />

        <nav v-if="!isSidebarCollapsed" class="sidebar-primary-nav" aria-label="Primary">
          <button class="sidebar-primary-link" type="button" @click="onStartNewThreadFromToolbar">
            <IconTablerFilePencil class="sidebar-primary-link-icon" />
            <span>New chat</span>
          </button>
        </nav>

        <SidebarThreadTree :groups="projectGroups" :project-display-name-by-id="projectDisplayNameById"
          v-if="!isSidebarCollapsed"
          :pinned-thread-ids="pinnedThreadIds"
          :selected-thread-id="selectedThreadId" :is-loading="isLoadingThreads"
          search-query=""
          :show-shortcut-hints="isCommandKeyHeld"
          @select="onSelectThread"
          @shortcut-threads-change="onShortcutThreadsChange"
          @set-thread-pinned="updatePinnedThread"
          @set-pinned-threads-order="reorderPinnedThreads"
          @archive="onArchiveThread" @rename-thread="onRenameThread" @start-new-thread="onStartNewThread" @rename-project="onRenameProject"
          @remove-project="onRemoveProject" @reorder-project="onReorderProject"
          @reorder-thread="onReorderThread" />

        <div v-if="!isSidebarCollapsed" class="sidebar-bottom-stack">
          <section class="sidebar-tools" aria-label="Sidebar tools">
            <button
              class="sidebar-tools-toggle"
              type="button"
              :aria-expanded="isSidebarToolsOpen"
              @click="toggleSidebarTools"
            >
              <span>Tools</span>
              <IconTablerChevronDown class="sidebar-tools-toggle-icon" :data-open="isSidebarToolsOpen" />
            </button>

            <div v-if="isSidebarToolsOpen" class="sidebar-tools-panel">
              <button
                class="sidebar-primary-link"
                :class="{ 'is-active': isChatSearchOpen }"
                type="button"
                :aria-pressed="isChatSearchOpen"
                @click="openChatSearch"
              >
                <IconTablerSearch class="sidebar-primary-link-icon" />
                <span>Search</span>
                <span v-if="!isMobile" class="sidebar-primary-shortcut">{{ chatSearchShortcutLabel }}</span>
              </button>

              <button
                class="sidebar-primary-link"
                :class="{ 'is-active': isScheduledRoute }"
                type="button"
                @click="openScheduledHub"
              >
                <CalendarClock class="sidebar-primary-link-icon" />
                <span>Scheduled tasks</span>
                <span v-if="automationUnreadRunCount" class="sidebar-primary-count">
                  {{ automationUnreadRunCount }}
                </span>
              </button>

              <button
                class="sidebar-primary-link"
                :class="{ 'is-active': isSkillsRoute }"
                type="button"
                @click="openSkillsHub"
              >
                <IconTablerPuzzle class="sidebar-primary-link-icon" />
                <span>Skills Hub</span>
              </button>

              <button
                class="sidebar-primary-link"
                :class="{ 'is-active': isMcpRoute }"
                type="button"
                @click="openMcpHub"
              >
                <IconTablerPlug class="sidebar-primary-link-icon" />
                <span>MCPs</span>
              </button>

              <button
                class="sidebar-primary-link"
                :class="{ 'is-active': isPluginsRoute }"
                type="button"
                @click="openPluginsHub"
              >
                <Blocks class="sidebar-primary-link-icon" />
                <span>Plugins</span>
              </button>

              <div class="sidebar-tools-settings">
                <span class="sidebar-tools-settings-label">Settings</span>
                <ThemeToggleButton
                  variant="sidebar"
                  :is-dark-theme="isDarkTheme"
                  :label="themeToggleLabel"
                  @toggle="toggleTheme"
                />
              </div>
            </div>
          </section>

          <RateLimitsSummary
            class="sidebar-rate-limits"
            :rate-limits="accountRateLimits"
            :refresh-rate-limits="refreshAccountRateLimits"
            :use-rate-limit-reset="useRateLimitReset"
            :is-using-rate-limit-reset="isUsingRateLimitReset"
          />
        </div>
      </section>
    </template>

    <template #content>
      <section class="content-root">
        <ContentHeader :title="contentTitle">
          <template #leading>
            <SidebarThreadControls
              v-if="isSidebarCollapsed || isMobile"
              class="sidebar-thread-controls-header-host"
              :is-sidebar-collapsed="isSidebarCollapsed"
              :show-new-thread-button="true"
              @toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"
              @start-new-thread="onStartNewThreadFromToolbar"
            />
          </template>
          <template v-if="selectedThreadProjectLabel" #meta>
            <span class="content-project-label" :title="selectedThread?.cwd || selectedThreadProjectLabel">
              <IconTablerFolder class="content-project-label-icon" />
              <span class="content-project-label-text">{{ selectedThreadProjectLabel }}</span>
            </span>
          </template>
          <template #actions>
            <NotificationSettingsButton
              ref="notificationSettingsRef"
              :threads="notificationThreads"
              :active-thread-id="selectedThreadId"
              @select-thread="onSelectThread"
            />
          </template>
        </ContentHeader>

        <section class="content-body">
          <template v-if="isScheduledRoute">
            <ScheduledTasksHub
              :tasks="automationSnapshot.tasks"
              :runs="automationSnapshot.runs"
              :is-loading="isLoadingAutomations"
              :error="automationError"
              :threads="notificationThreads"
              :default-cwd="newThreadCwd"
              :models="availableModelIds"
              :current-thread-id="selectedThreadId"
              @create="onCreateAutomation"
              @update="onUpdateAutomation"
              @delete="onDeleteAutomation"
              @run="onRunAutomation"
              @select-thread="onSelectThread"
              @update-run="onUpdateAutomationRun"
            />
          </template>
          <template v-else-if="isSkillsRoute">
            <SkillsHub @skills-changed="onSkillsChanged" />
          </template>
          <template v-else-if="isMcpRoute">
            <McpHub />
          </template>
          <template v-else-if="isPluginsRoute">
            <PluginsHub :cwd="composerCwd" @plugins-changed="onPluginsChanged" />
          </template>
          <template v-else-if="isHomeRoute">
            <div class="content-grid">
              <div class="new-thread-empty">
                <p class="new-thread-hero">Let's build</p>
                <NewThreadFolderPicker :model-value="newThreadCwd"
                  :options="newThreadFolderOptions" placeholder="Choose folder"
                  :default-add-value="defaultNewProjectName"
                  :disabled="false" @update:model-value="onSelectNewThreadFolder"
                  @add="onAddNewProject" />
              </div>

              <ThreadComposer ref="threadComposerRef" :active-thread-id="composerThreadContextId"
                :cwd="composerCwd"
                :models="availableModelIds" :selected-model="selectedModelId"
                :selected-reasoning-effort="selectedReasoningEffort" :skills="installedSkills"
                :threads="composerThreadMentions"
                :thread-token-usage="null"
                :show-context-usage="false"
                :goal="null"
                :turn-activity-label="composerTurnActivityLabel"
                :is-turn-in-progress="false"
                :is-interrupting-turn="false" @submit="onSubmitThreadMessage"
                @set-goal="onSetGoal" @clear-goal="onClearGoal" @update-goal-status="onUpdateGoalStatus"
                @update:selected-model="onSelectModel" @update:selected-reasoning-effort="onSelectReasoningEffort" />
            </div>
          </template>
          <template v-else>
            <div class="content-grid">
              <div class="content-thread">
                <ThreadConversation :messages="filteredMessages" :is-loading="isLoadingMessages"
                  :active-thread-id="composerThreadContextId" :scroll-state="selectedThreadScrollState"
                  :has-earlier-messages="selectedThreadHasEarlierMessages"
                  :is-loading-earlier-messages="isLoadingSelectedThreadEarlierMessages"
                  :earlier-load-error="selectedThreadEarlierLoadError"
                  :live-overlay="liveOverlay"
                  :pending-requests="selectedThreadServerRequests"
                  :is-turn-in-progress="isSelectedThreadInProgress"
                  :is-forking-thread="isForkingThread"
                  :is-rolling-back="isRollingBack"
                  :thread-cwd="selectedThread?.cwd ?? ''"
                  :thread-has-worktree="selectedThread?.hasWorktree === true"
                  :automation-proposals="selectedAutomationProposals"
                  :automation-tasks="automationSnapshot.tasks"
                  @update-scroll-state="onUpdateThreadScrollState"
                  @load-earlier="loadEarlierMessages()"
                  @respond-server-request="onRespondServerRequest"
                  @resolve-automation-proposal="onResolveAutomationProposal"
                  @add-response-annotation="onAddResponseAnnotation"
                  @fork="onForkThread"
                  @rollback="onRollback" />
              </div>

              <div class="composer-with-queue">
                <QueuedMessages
                  :messages="selectedThreadQueuedMessages"
                  @steer="steerQueuedMessage"
                  @delete="removeQueuedMessage"
                />
                <ThreadComposer ref="threadComposerRef" :active-thread-id="composerThreadContextId"
                  :cwd="composerCwd"
                  :models="availableModelIds"
                  :selected-model="selectedModelId" :selected-reasoning-effort="selectedReasoningEffort"
                  :skills="installedSkills"
                  :threads="composerThreadMentions"
                  :thread-token-usage="composerThreadTokenUsage"
                  :show-context-usage="true"
                  :goal="selectedThreadGoal"
                  :turn-activity-label="composerTurnActivityLabel"
                  :is-turn-in-progress="isSelectedThreadInProgress" :is-interrupting-turn="isInterruptingTurn"
                  :has-queue-above="selectedThreadQueuedMessages.length > 0"
                  @submit="onSubmitThreadMessage" @update:selected-model="onSelectModel"
                  @update:selected-reasoning-effort="onSelectReasoningEffort" @interrupt="onInterruptTurn"
                  @set-goal="onSetGoal" @clear-goal="onClearGoal" @update-goal-status="onUpdateGoalStatus" />
              </div>
            </div>
          </template>
        </section>
      </section>
    </template>
  </DesktopLayout>
  <ChatSearchDialog
    :open="isChatSearchOpen"
    :threads="notificationThreads"
    :pinned-thread-ids="pinnedThreadIds"
    :project-display-name-by-id="projectDisplayNameById"
    @close="closeChatSearch"
    @select="onSelectSearchThread"
  />
  <div class="build-badge" aria-label="Worktree name">
    WT {{ worktreeName }}
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Blocks, CalendarClock } from '@lucide/vue'
import { useRoute, useRouter } from 'vue-router'
import DesktopLayout from './components/layout/DesktopLayout.vue'
import SidebarThreadTree from './components/sidebar/SidebarThreadTree.vue'
import ContentHeader from './components/content/ContentHeader.vue'
import ThreadConversation from './components/content/ThreadConversation.vue'
import ThreadComposer from './components/content/ThreadComposer.vue'
import QueuedMessages from './components/content/QueuedMessages.vue'
import NewThreadFolderPicker from './components/content/NewThreadFolderPicker.vue'
import SkillsHub from './components/content/SkillsHub.vue'
import McpHub from './components/content/McpHub.vue'
import PluginsHub from './components/content/PluginsHub.vue'
import ScheduledTasksHub from './components/content/ScheduledTasksHub.vue'
import ChatSearchDialog from './components/content/ChatSearchDialog.vue'
import RateLimitsSummary from './components/content/RateLimitsSummary.vue'
import ThemeToggleButton from './components/content/ThemeToggleButton.vue'
import NotificationSettingsButton from './components/content/NotificationSettingsButton.vue'
import SidebarThreadControls from './components/sidebar/SidebarThreadControls.vue'
import IconTablerChevronDown from './components/icons/IconTablerChevronDown.vue'
import IconTablerFilePencil from './components/icons/IconTablerFilePencil.vue'
import IconTablerFolder from './components/icons/IconTablerFolder.vue'
import IconTablerPlug from './components/icons/IconTablerPlug.vue'
import IconTablerPuzzle from './components/icons/IconTablerPuzzle.vue'
import IconTablerSearch from './components/icons/IconTablerSearch.vue'
import { useDesktopState } from './composables/useDesktopState'
import { useMobile } from './composables/useMobile'
import { usePinnedThreads } from './composables/usePinnedThreads'
import { useAutomations } from './composables/useAutomations'
import { useTheme } from './composables/useTheme'
import {
  getHomeDirectory,
  getProjectRootSuggestion,
  openProjectRoot,
  type PluginMentionParam,
  type ThreadMentionParam,
} from './api/codexGateway'
import type { ReasoningEffort, ResponseTextAnnotation, ThreadScrollState, UiMessage, UiThread } from './types/codex'
import type { AutomationDraft } from './types/automations'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'codex-web-local.sidebar-collapsed.v1'
const SIDEBAR_TOOLS_OPEN_STORAGE_KEY = 'codex-web-local.sidebar-tools-open.v1'
const NEW_THREAD_CWD_STORAGE_KEY = 'codex-web-local.new-thread-cwd.v1'
const worktreeName = import.meta.env.VITE_WORKTREE_NAME ?? 'unknown'

const {
  projectGroups,
  projectDisplayNameById,
  selectedThread,
  selectedThreadGoal,
  selectedThreadTokenUsage,
  selectedThreadScrollState,
  selectedThreadServerRequests,
  selectedLiveOverlay,
  selectedThreadId,
  availableModelIds,
  selectedModelId,
  selectedReasoningEffort,
  accountRateLimits,
  installedSkills,
  messages,
  selectedThreadHasEarlierMessages,
  isLoadingSelectedThreadEarlierMessages,
  selectedThreadEarlierLoadError,
  isLoadingThreads,
  isLoadingMessages,
  isSendingMessage,
  isInterruptingTurn,
  isUsingRateLimitReset,
  refreshAll,
  refreshThreadReadState,
  refreshAccountRateLimits,
  useRateLimitReset,
  refreshSkills,
  loadEarlierMessages,
  selectThread,
  selectThreadFromSearch,
  setThreadScrollState,
  archiveThreadById,
  renameThread,
  createThreadWithGoal,
  sendMessageToSelectedThread,
  sendMessageToNewThread,
  setGoalForSelectedThread,
  clearGoalForSelectedThread,
  updateSelectedThreadGoalStatus,
  interruptSelectedThreadTurn,
  continueSelectedThreadInNewChat,
  isForkingThread,
  rollbackSelectedThread,
  isRollingBack,
  selectedThreadQueuedMessages,
  removeQueuedMessage,
  steerQueuedMessage,
  setSelectedModelId,
  setSelectedReasoningEffort,
  respondToPendingServerRequest,
  renameProject,
  removeProject,
  reorderProject,
  reorderThread,
  pinProjectToTop,
  requestBrowserTurnNotificationsPermission,
  startPolling,
  stopPolling,
} = useDesktopState()

const route = useRoute()
const router = useRouter()
const { isMobile } = useMobile()
const { isDarkTheme, toggleTheme } = useTheme()
const {
  pinnedThreadIds,
  refreshPinnedThreads,
  reorderPinnedThreads,
  updatePinnedThread,
  dispose: disposePinnedThreads,
} = usePinnedThreads()
const {
  snapshot: automationSnapshot,
  isLoading: isLoadingAutomations,
  error: automationError,
  refresh: refreshAutomations,
  start: startAutomations,
  stop: stopAutomations,
  create: createAutomation,
  update: updateAutomation,
  remove: removeAutomation,
  runNow: runAutomationNow,
  resolveProposal: resolveAutomationProposal,
  updateRun: updateAutomationRun,
} = useAutomations()
const isRouteSyncInProgress = ref(false)
const hasInitialized = ref(false)
const newThreadCwd = ref(loadNewThreadCwd())
const isSidebarCollapsed = ref(loadSidebarCollapsed())
const isSidebarToolsOpen = ref(loadSidebarToolsOpen())
const isChatSearchOpen = ref(false)
const defaultNewProjectName = ref('New Project (1)')
const homeDirectory = ref('')
const visibleThreadIdsForShortcuts = ref<string[]>([])
const hasVisibleThreadShortcutOrder = ref(false)
const isCommandKeyHeld = ref(false)
const threadComposerRef = ref<{
  toggleDictation: () => void
  addResponseAnnotation: (annotation: ResponseTextAnnotation) => void
  focusComposer: () => void
} | null>(null)
const notificationSettingsRef = ref<{
  toggleActivityCenter: () => boolean
  isActivityCenterOpen: () => boolean
  selectActivityShortcut: (index: number) => boolean
} | null>(null)
let lastAppResumeRefreshAt = 0
const chatSearchShortcutLabel = /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? '⌘K' : 'Ctrl K'

const routeThreadId = computed(() => {
  const rawThreadId = route.params.threadId
  return typeof rawThreadId === 'string' ? rawThreadId : ''
})

const knownThreadIdSet = computed(() => {
  const ids = new Set<string>(pinnedThreadIds.value)
  for (const group of projectGroups.value) {
    for (const thread of group.threads) {
      ids.add(thread.id)
    }
  }
  return ids
})

const notificationThreads = computed<UiThread[]>(() => {
  const threads: UiThread[] = []
  const seen = new Set<string>()
  for (const group of projectGroups.value) {
    for (const thread of group.threads) {
      if (!thread.id || seen.has(thread.id)) continue
      seen.add(thread.id)
      threads.push(thread)
    }
  }
  return threads.sort((left, right) => {
    const leftTimestamp = Date.parse(left.updatedAtIso)
    const rightTimestamp = Date.parse(right.updatedAtIso)
    return (Number.isFinite(rightTimestamp) ? rightTimestamp : 0) -
      (Number.isFinite(leftTimestamp) ? leftTimestamp : 0)
  })
})

const shortcutThreadIds = computed(() => {
  if (hasVisibleThreadShortcutOrder.value) {
    return visibleThreadIdsForShortcuts.value
  }

  const ids: string[] = []
  const seen = new Set<string>()

  for (const threadId of pinnedThreadIds.value) {
    if (!threadId || seen.has(threadId)) continue
    seen.add(threadId)
    ids.push(threadId)
  }

  for (const group of projectGroups.value) {
    for (const thread of group.threads) {
      if (!thread.id || seen.has(thread.id)) continue
      seen.add(thread.id)
      ids.push(thread.id)
    }
  }

  return ids
})

const isHomeRoute = computed(() => route.name === 'home')
const isScheduledRoute = computed(() => route.name === 'scheduled')
const isSkillsRoute = computed(() => route.name === 'skills')
const isMcpRoute = computed(() => route.name === 'mcps')
const isPluginsRoute = computed(() => route.name === 'plugins')

watch(
  isHomeRoute,
  (isHome) => {
    if (isHome && selectedThreadId.value) {
      void selectThread('')
    }
  },
  { immediate: true, flush: 'sync' },
)

const selectedThreadProjectLabel = computed(() => {
  if (isHomeRoute.value || isScheduledRoute.value || isSkillsRoute.value || isMcpRoute.value || isPluginsRoute.value) return ''
  const thread = selectedThread.value
  if (!thread) return ''
  return projectDisplayNameById.value[thread.projectName] ?? thread.projectName
})
const themeToggleLabel = computed(() => (isDarkTheme.value ? 'Switch to light mode' : 'Switch to dark mode'))
const contentTitle = computed(() => {
  if (isScheduledRoute.value) return 'Scheduled tasks'
  if (isSkillsRoute.value) return 'Skills'
  if (isMcpRoute.value) return 'MCPs'
  if (isPluginsRoute.value) return 'Plugins'
  if (isHomeRoute.value) return 'New thread'
  return selectedThread.value?.title ?? 'Choose a thread'
})
const filteredMessages = computed(() => {
  const recoveredConnectionFailureIds = findRecoveredConnectionFailureIds(messages.value)
  return messages.value.filter((message) =>
    !recoveredConnectionFailureIds.has(message.id) &&
    shouldShowConversationMessage(message),
  )
})
const liveOverlay = computed(() => selectedLiveOverlay.value)
const composerTurnActivityLabel = computed(() => liveOverlay.value?.activityLabel ?? 'Thinking')
const composerThreadContextId = computed(() => (isHomeRoute.value ? '__new-thread__' : selectedThreadId.value))
const composerThreadTokenUsage = computed(() => (isHomeRoute.value ? null : selectedThreadTokenUsage.value))
const composerCwd = computed(() => {
  if (isHomeRoute.value) return newThreadCwd.value.trim()
  return selectedThread.value?.cwd?.trim() ?? ''
})
const composerThreadMentions = computed<ThreadMentionParam[]>(() => {
  const mentions: ThreadMentionParam[] = []
  const seen = new Set<string>()
  for (const group of projectGroups.value) {
    for (const thread of group.threads) {
      if (!thread.id || seen.has(thread.id)) continue
      seen.add(thread.id)
      mentions.push({
        id: thread.id,
        name: thread.title || thread.preview || 'Untitled chat',
        path: `thread://${thread.id}`,
      })
    }
  }
  return mentions
})
const selectedAutomationProposals = computed(() =>
  automationSnapshot.value.proposals.filter(
    (proposal) => proposal.status !== 'dismissed' && proposal.threadId === selectedThreadId.value,
  ).sort(
    (a, b) => Date.parse(a.createdAtIso) - Date.parse(b.createdAtIso),
  ),
)
const automationUnreadRunCount = computed(() =>
  automationSnapshot.value.runs.filter((run) => run.unread && !run.archived).length,
)
const isSelectedThreadInProgress = computed(() => !isHomeRoute.value && selectedThread.value?.inProgress === true)
const newThreadFolderOptions = computed(() => {
  const options: Array<{ value: string; label: string }> = []
  const seenCwds = new Set<string>()

  for (const group of projectGroups.value) {
    const cwd = group.threads[0]?.cwd?.trim() ?? ''
    if (!cwd || seenCwds.has(cwd)) continue
    seenCwds.add(cwd)
    options.push({
      value: cwd,
      label: projectDisplayNameById.value[group.projectName] ?? group.projectName,
    })
  }

  const selectedCwd = newThreadCwd.value.trim()
  if (selectedCwd && !seenCwds.has(selectedCwd)) {
    options.unshift({
      value: selectedCwd,
      label: getPathLeafName(selectedCwd),
    })
  }

  return options
})
onMounted(() => {
  window.addEventListener('keydown', onWindowKeyDown)
  window.addEventListener('keyup', onWindowKeyUp)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('pageshow', onAppResume)
  document.addEventListener('visibilitychange', onAppResume)
  void initialize()
  startAutomations()
  void loadHomeDirectory()
  void refreshDefaultProjectName()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeyDown)
  window.removeEventListener('keyup', onWindowKeyUp)
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('pageshow', onAppResume)
  document.removeEventListener('visibilitychange', onAppResume)
  disposePinnedThreads()
  stopAutomations()
  stopPolling()
})

function onAppResume(): void {
  if (document.visibilityState !== 'visible') return
  const now = Date.now()
  if (now - lastAppResumeRefreshAt < 750) return
  lastAppResumeRefreshAt = now
  void refreshThreadReadState()
  void refreshPinnedThreads()
  void refreshAutomations()
}

function onSkillsChanged(): void {
  void refreshSkills()
}

function onPluginsChanged(): void {
  void refreshSkills()
}

function openChatSearch(): void {
  isChatSearchOpen.value = true
  if (isMobile.value) setSidebarCollapsed(true)
}

function closeChatSearch(): void {
  isChatSearchOpen.value = false
}

function toggleSidebarTools(): void {
  setSidebarToolsOpen(!isSidebarToolsOpen.value)
}

function setSidebarToolsOpen(nextValue: boolean): void {
  if (isSidebarToolsOpen.value === nextValue) return
  isSidebarToolsOpen.value = nextValue
  saveSidebarToolsOpen(nextValue)
}

function openSkillsHub(): void {
  setSidebarToolsOpen(true)
  void router.push({ name: 'skills' })
  if (isMobile.value) setSidebarCollapsed(true)
}

function openScheduledHub(): void {
  setSidebarToolsOpen(true)
  void router.push({ name: 'scheduled' })
  if (isMobile.value) setSidebarCollapsed(true)
}

function openMcpHub(): void {
  setSidebarToolsOpen(true)
  void router.push({ name: 'mcps' })
  if (isMobile.value) setSidebarCollapsed(true)
}

function openPluginsHub(): void {
  setSidebarToolsOpen(true)
  void router.push({ name: 'plugins' })
  if (isMobile.value) setSidebarCollapsed(true)
}

function onSelectThread(threadId: string): void {
  if (!threadId) return
  if (route.name === 'thread' && routeThreadId.value === threadId) return
  void router.push({ name: 'thread', params: { threadId } })
  if (isMobile.value) setSidebarCollapsed(true)
}

async function onSelectSearchThread(thread: UiThread): Promise<void> {
  closeChatSearch()
  const loadThread = selectThreadFromSearch(thread)
  if (route.name !== 'thread' || routeThreadId.value !== thread.id) {
    await router.push({ name: 'thread', params: { threadId: thread.id } })
  }
  if (isMobile.value) setSidebarCollapsed(true)
  await loadThread
}

function onArchiveThread(threadId: string): void {
  void archiveThreadById(threadId)
}

function onRenameThread(payload: { threadId: string; name: string }): void {
  void renameThread(payload.threadId, payload.name)
}

function onShortcutThreadsChange(threadIds: string[]): void {
  hasVisibleThreadShortcutOrder.value = true
  visibleThreadIdsForShortcuts.value = [...threadIds]
}

async function onStartNewThread(projectName: string): Promise<void> {
  const projectGroup = projectGroups.value.find((group) => group.projectName === projectName)
  const projectCwd = projectGroup?.threads[0]?.cwd?.trim() ?? ''
  if (projectCwd) {
    newThreadCwd.value = projectCwd
    saveNewThreadCwd(projectCwd)
  }
  if (isMobile.value) setSidebarCollapsed(true)
  if (!isHomeRoute.value) {
    await router.push({ name: 'home' })
  }
  focusComposerSoon()
}

async function onStartNewThreadFromToolbar(): Promise<void> {
  if (!newThreadCwd.value.trim()) {
    const cwd = selectedThread.value?.cwd?.trim() ?? ''
    if (cwd) {
      newThreadCwd.value = cwd
      saveNewThreadCwd(cwd)
    }
  }
  if (isMobile.value) setSidebarCollapsed(true)
  if (!isHomeRoute.value) {
    await router.push({ name: 'home' })
  }
  focusComposerSoon()
}

function focusComposerSoon(): void {
  if (isMobile.value) return
  nextTick(() => {
    window.requestAnimationFrame(() => {
      threadComposerRef.value?.focusComposer()
    })
  })
}

function onRenameProject(payload: { projectName: string; displayName: string }): void {
  renameProject(payload.projectName, payload.displayName)
}

function onRemoveProject(projectName: string): void {
  removeProject(projectName)
}

function onReorderProject(payload: { projectName: string; toIndex: number }): void {
  reorderProject(payload.projectName, payload.toIndex)
}

function onReorderThread(payload: { threadId: string; toIndex: number; projectName?: string; threadIds?: string[] }): void {
  reorderThread(payload.threadId, payload.toIndex, payload.projectName ?? '', payload.threadIds)
}

function onUpdateThreadScrollState(payload: { threadId: string; state: ThreadScrollState }): void {
  setThreadScrollState(payload.threadId, payload.state)
}

function onRespondServerRequest(payload: { id: number; result?: unknown; error?: { code?: number; message: string } }): void {
  void respondToPendingServerRequest(payload)
}

function onCreateAutomation(draft: AutomationDraft): void {
  void createAutomation(draft)
}

function onUpdateAutomation(id: string, changes: Partial<AutomationDraft>): void {
  void updateAutomation(id, changes)
}

function onDeleteAutomation(id: string): void {
  void removeAutomation(id)
}

function onRunAutomation(id: string): void {
  requestBrowserTurnNotificationsPermission()
  void runAutomationNow(id)
}

function onUpdateAutomationRun(id: string, changes: { unread?: boolean; archived?: boolean }): void {
  void updateAutomationRun(id, changes)
}

function onResolveAutomationProposal(id: string, accept: boolean): void {
  void resolveAutomationProposal(id, accept)
}

function setSidebarCollapsed(nextValue: boolean): void {
  if (isSidebarCollapsed.value === nextValue) return
  isSidebarCollapsed.value = nextValue
  saveSidebarCollapsed(nextValue)
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Meta') {
    isCommandKeyHeld.value = true
  }
  if (event.defaultPrevented) return
  if (!event.ctrlKey && !event.metaKey) return
  if (event.shiftKey || event.altKey) return

  if (event.key.toLowerCase() === 'k') {
    event.preventDefault()
    if (!event.repeat) openChatSearch()
    return
  }

  if (event.metaKey && event.key.toLowerCase() === 'j') {
    event.preventDefault()
    if (!event.repeat) {
      const isOpen = notificationSettingsRef.value?.toggleActivityCenter()
      if (isOpen === false) focusComposerSoon()
    }
    return
  }

  if (event.metaKey && event.key.toLowerCase() === 'u') {
    event.preventDefault()
    if (!event.repeat) {
      threadComposerRef.value?.toggleDictation()
    }
    return
  }

  const shortcutIndex = getThreadShortcutIndex(event)
  if (shortcutIndex >= 0) {
    if (notificationSettingsRef.value?.isActivityCenterOpen()) {
      const selected = notificationSettingsRef.value.selectActivityShortcut(shortcutIndex)
      if (selected) event.preventDefault()
      return
    }
    const threadId = shortcutThreadIds.value[shortcutIndex]
    if (!threadId) return
    event.preventDefault()
    onSelectThread(threadId)
    return
  }

  if (event.key.toLowerCase() === 'b') {
    event.preventDefault()
    setSidebarCollapsed(!isSidebarCollapsed.value)
  }
}

function onWindowKeyUp(event: KeyboardEvent): void {
  if (event.key === 'Meta') {
    isCommandKeyHeld.value = false
  }
}

function onWindowBlur(): void {
  isCommandKeyHeld.value = false
}

function getThreadShortcutIndex(event: KeyboardEvent): number {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)
  return match ? Number(match[1]) - 1 : -1
}

function onAddResponseAnnotation(annotation: ResponseTextAnnotation): void {
  threadComposerRef.value?.addResponseAnnotation(annotation)
}

function onSubmitThreadMessage(payload: { text: string; imageUrls: string[]; fileAttachments: Array<{ label: string; path: string; fsPath: string }>; responseTextAnnotations: ResponseTextAnnotation[]; skills: Array<{ name: string; path: string }>; plugins: PluginMentionParam[]; threads: ThreadMentionParam[]; mode: 'steer' | 'queue' }): void {
  requestBrowserTurnNotificationsPermission()
  const text = payload.text
  if (isHomeRoute.value) {
    void submitFirstMessageForNewThread(
      text,
      payload.imageUrls,
      payload.skills,
      payload.fileAttachments,
      payload.responseTextAnnotations,
      payload.plugins,
      payload.threads,
    )
    return
  }
  void sendMessageToSelectedThread(
    text,
    payload.imageUrls,
    payload.skills,
    payload.mode,
    payload.fileAttachments,
    payload.responseTextAnnotations,
    payload.plugins,
    payload.threads,
  )
}

async function onSetGoal(payload: { objective: string }): Promise<void> {
  const objective = payload.objective.trim()
  if (!objective) return

  requestBrowserTurnNotificationsPermission()
  if (isHomeRoute.value) {
    try {
      const threadId = await createThreadWithGoal(objective, newThreadCwd.value)
      if (!threadId) return
      await router.replace({ name: 'thread', params: { threadId } })
    } catch {
      // Error is already reflected in shared state.
    }
    return
  }

  try {
    await setGoalForSelectedThread(objective)
  } catch {
    // Error is already reflected in shared state.
  }
}

function onClearGoal(): void {
  if (isHomeRoute.value) return
  void clearGoalForSelectedThread()
}

function onUpdateGoalStatus(payload: { status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete' }): void {
  if (isHomeRoute.value) return
  void updateSelectedThreadGoalStatus(payload.status)
}

function onSelectNewThreadFolder(cwd: string): void {
  const nextCwd = cwd.trim()
  newThreadCwd.value = nextCwd
  saveNewThreadCwd(nextCwd)
}

async function onAddNewProject(rawInput: string): Promise<void> {
  const normalizedInput = rawInput.trim()
  if (!normalizedInput) return

  const isPath = looksLikePath(normalizedInput)
  const baseDir = await resolveProjectBaseDirectory()
  const targetPath = isPath
    ? normalizedInput
    : joinPath(baseDir, normalizedInput)
  if (!targetPath) return

  try {
    const normalizedPath = await openProjectRoot(targetPath, {
      createIfMissing: !isPath,
      label: isPath ? '' : normalizedInput,
    })
    if (normalizedPath) {
      newThreadCwd.value = normalizedPath
      saveNewThreadCwd(normalizedPath)
      pinProjectToTop(getPathLeafName(normalizedPath))
      void refreshDefaultProjectName()
    }
  } catch {
    // Error is surfaced on next request if path is invalid.
  }
}

async function resolveProjectBaseDirectory(): Promise<string> {
  const baseDir = getProjectBaseDirectory()
  if (baseDir) return baseDir
  try {
    const loadedHomeDirectory = await getHomeDirectory()
    if (loadedHomeDirectory) {
      homeDirectory.value = loadedHomeDirectory
      return loadedHomeDirectory
    }
  } catch {
    // Fallback handled by empty return.
  }
  return ''
}

function looksLikePath(value: string): boolean {
  if (!value) return false
  if (value.startsWith('~/')) return true
  if (value.startsWith('/')) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

async function refreshDefaultProjectName(): Promise<void> {
  const baseDir = getProjectBaseDirectory()
  if (!baseDir) {
    defaultNewProjectName.value = 'New Project (1)'
    return
  }

  try {
    const suggestion = await getProjectRootSuggestion(baseDir)
    defaultNewProjectName.value = suggestion.name || 'New Project (1)'
  } catch {
    defaultNewProjectName.value = 'New Project (1)'
  }
}

function getProjectBaseDirectory(): string {
  const selected = newThreadCwd.value.trim()
  if (selected) return getPathParent(selected)
  const first = newThreadFolderOptions.value[0]?.value?.trim() ?? ''
  if (first) return getPathParent(first)
  return homeDirectory.value.trim()
}

async function loadHomeDirectory(): Promise<void> {
  try {
    homeDirectory.value = await getHomeDirectory()
  } catch {
    homeDirectory.value = ''
  }
}

function getPathParent(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const slashIndex = trimmed.lastIndexOf('/')
  if (slashIndex <= 0) return ''
  return trimmed.slice(0, slashIndex)
}

function getPathLeafName(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const slashIndex = trimmed.lastIndexOf('/')
  if (slashIndex < 0) return trimmed
  return trimmed.slice(slashIndex + 1)
}

function joinPath(parent: string, child: string): string {
  const normalizedParent = parent.trim().replace(/\/+$/, '')
  const normalizedChild = child.trim().replace(/^\/+/, '')
  if (!normalizedParent || !normalizedChild) return ''
  return `${normalizedParent}/${normalizedChild}`
}

function onSelectModel(modelId: string): void {
  void setSelectedModelId(modelId)
}

function onSelectReasoningEffort(effort: ReasoningEffort | ''): void {
  void setSelectedReasoningEffort(effort)
}

function onInterruptTurn(): void {
  void interruptSelectedThreadTurn()
}

function onRollback(payload: { turnIndex: number }): void {
  void rollbackSelectedThread(payload.turnIndex)
}

async function onForkThread(payload: { turnIndex: number; target: 'workspace' | 'worktree' }): Promise<void> {
  try {
    const threadId = await continueSelectedThreadInNewChat(payload.turnIndex, payload.target)
    if (!threadId) return
    await router.replace({ name: 'thread', params: { threadId } })
  } catch {
    // Error is already reflected in shared state.
  }
}

function loadSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
}

function saveSidebarCollapsed(value: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, value ? '1' : '0')
}

function loadSidebarToolsOpen(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(SIDEBAR_TOOLS_OPEN_STORAGE_KEY) === '1'
}

function saveSidebarToolsOpen(value: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SIDEBAR_TOOLS_OPEN_STORAGE_KEY, value ? '1' : '0')
}

function loadNewThreadCwd(): string {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(NEW_THREAD_CWD_STORAGE_KEY)?.trim() ?? ''
}

function saveNewThreadCwd(value: string): void {
  if (typeof window === 'undefined') return
  const normalized = value.trim()
  if (!normalized) {
    window.localStorage.removeItem(NEW_THREAD_CWD_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(NEW_THREAD_CWD_STORAGE_KEY, normalized)
}

function normalizeMessageType(rawType: string | undefined, role: string): string {
  const normalized = (rawType ?? '').trim()
  if (normalized.length > 0) {
    return normalized
  }
  return role.trim() || 'message'
}

function shouldShowConversationMessage(message: UiMessage): boolean {
  const type = normalizeMessageType(message.messageType, message.role)
  if (type === 'worked') return true
  if (type === 'turnActivity.live' || type === 'turnError.live' || type === 'agentReasoning.live') return false
  if (type === 'commandExecution') {
    const command = message.commandExecution
    if (!command) return false
    return command.status !== 'completed' || command.exitCode !== 0
  }
  if (type === 'mcpToolCall') {
    return Boolean(message.mcpApp) || message.toolCall?.status === 'failed'
  }
  if (type === 'webSearch' || type === 'collabAgentToolCall') {
    return message.toolCall?.status === 'failed'
  }
  if (type === 'fileChange' || type === 'contextCompaction') return false
  if (type === 'turnDiff') return (message.reviewChanges?.fileCount ?? 0) > 0
  return true
}

function findRecoveredConnectionFailureIds(items: UiMessage[]): Set<string> {
  const recoveredIds = new Set<string>()
  for (let failureIndex = 0; failureIndex < items.length; failureIndex += 1) {
    const failure = items[failureIndex]
    if (
      failure.toolCall?.status !== 'failed' ||
      failure.toolCall.statusLabel !== 'Connection issue'
    ) {
      continue
    }

    for (let candidateIndex = failureIndex + 1; candidateIndex < items.length; candidateIndex += 1) {
      const candidate = items[candidateIndex]
      if (candidate.turnId !== failure.turnId) {
        if (failure.turnId && candidate.turnId) break
        continue
      }
      if (
        candidate.toolCall?.status === 'completed' &&
        candidate.messageType === failure.messageType &&
        candidate.toolCall.kind === failure.toolCall.kind &&
        candidate.toolCall.label === failure.toolCall.label &&
        candidate.toolCall.detail === failure.toolCall.detail
      ) {
        recoveredIds.add(failure.id)
        break
      }
    }
  }
  return recoveredIds
}

async function initialize(): Promise<void> {
  await Promise.all([
    refreshAll(),
    refreshPinnedThreads(),
  ])
  hasInitialized.value = true
  await syncThreadSelectionWithRoute()
  startPolling()
}

async function syncThreadSelectionWithRoute(): Promise<void> {
  if (isRouteSyncInProgress.value) return
  isRouteSyncInProgress.value = true

  try {
    if (route.name === 'home' || route.name === 'skills' || route.name === 'mcps' || route.name === 'plugins') {
      if (selectedThreadId.value !== '') {
        await selectThread('')
      }
      return
    }

    if (route.name === 'thread') {
      const threadId = routeThreadId.value
      if (!threadId) return

      if (!knownThreadIdSet.value.has(threadId)) {
        await router.replace({ name: 'home' })
        return
      }

      if (selectedThreadId.value !== threadId) {
        await selectThread(threadId)
      }
      return
    }

  } finally {
    isRouteSyncInProgress.value = false
  }
}

watch(
  () =>
    [
      route.name,
      routeThreadId.value,
      isLoadingThreads.value,
      knownThreadIdSet.value.has(routeThreadId.value),
      selectedThreadId.value,
    ] as const,
  async () => {
    if (!hasInitialized.value) return
    await syncThreadSelectionWithRoute()
  },
)

watch(
  () => selectedThreadId.value,
  async (threadId) => {
    if (!hasInitialized.value) return
    if (isRouteSyncInProgress.value) return
    if (isHomeRoute.value || isScheduledRoute.value || isSkillsRoute.value || isMcpRoute.value || isPluginsRoute.value) return

    if (!threadId) {
      if (route.name !== 'home') {
        await router.replace({ name: 'home' })
      }
      return
    }

    if (route.name === 'thread' && routeThreadId.value === threadId) return
    await router.replace({ name: 'thread', params: { threadId } })
  },
)

watch(
  () => newThreadFolderOptions.value,
  (options) => {
    if (options.length === 0) {
      newThreadCwd.value = ''
      return
    }
    const hasSelected = options.some((option) => option.value === newThreadCwd.value)
    if (!hasSelected) {
      newThreadCwd.value = options[0].value
    }
    void refreshDefaultProjectName()
  },
  { immediate: true },
)

watch(
  () => newThreadCwd.value,
  () => {
    void refreshDefaultProjectName()
  },
)

watch(
  () => isScheduledRoute.value || isSkillsRoute.value || isMcpRoute.value || isPluginsRoute.value,
  (isToolsRoute) => {
    if (isToolsRoute) setSidebarToolsOpen(true)
  },
  { immediate: true },
)

watch(isMobile, (mobile) => {
  if (mobile && !isSidebarCollapsed.value) {
    setSidebarCollapsed(true)
  }
})

async function submitFirstMessageForNewThread(
  text: string,
  imageUrls: string[] = [],
  skills: Array<{ name: string; path: string }> = [],
  fileAttachments: Array<{ label: string; path: string; fsPath: string }> = [],
  responseTextAnnotations: ResponseTextAnnotation[] = [],
  plugins: PluginMentionParam[] = [],
  threads: ThreadMentionParam[] = [],
): Promise<void> {
  try {
    const threadId = await sendMessageToNewThread(
      text,
      newThreadCwd.value,
      imageUrls,
      skills,
      fileAttachments,
      responseTextAnnotations,
      plugins,
      threads,
    )
    if (!threadId) return
    await router.replace({ name: 'thread', params: { threadId } })
  } catch {
    // Error is already reflected in state.
  }
}
</script>

<style scoped>
@reference "tailwindcss";

.sidebar-root {
  @apply min-h-full py-4 px-3 flex flex-col gap-3 select-none;
}

.sidebar-root input,
.sidebar-root textarea {
  @apply select-text;
}

.content-root {
  @apply h-full min-h-0 w-full flex flex-col overflow-y-hidden overflow-x-visible bg-white;
  overscroll-behavior: none;
}

.sidebar-thread-controls-host {
  @apply px-0 pb-1;
}

.sidebar-primary-nav {
  @apply flex flex-col gap-1;
}

.sidebar-primary-link {
  @apply flex h-9 w-full items-center gap-3 rounded-lg border-0 bg-transparent px-2.5 text-left text-[15px] leading-6 font-normal text-zinc-600 transition hover:bg-zinc-200/70 hover:text-zinc-900;
}

.sidebar-primary-link.is-active {
  @apply bg-zinc-200/80 text-zinc-900;
}

.sidebar-primary-link-icon {
  @apply h-5 w-5 shrink-0 text-zinc-500;
}

.sidebar-primary-shortcut {
  @apply ml-auto rounded border px-1.5 py-0.5 text-[10px] leading-none;
  border-color: var(--border-strong);
  color: var(--text-muted);
}

.sidebar-primary-count {
  @apply ml-auto min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none;
  background: var(--accent-blue-soft, #dbeafe);
  color: var(--accent-blue, #2563eb);
}

.sidebar-bottom-stack {
  @apply mt-auto flex flex-col gap-2 pt-2;
}

.sidebar-tools {
  @apply flex flex-col gap-1;
}

.sidebar-tools-toggle {
  @apply flex h-8 w-full items-center justify-between rounded-lg border-0 bg-transparent px-2.5 text-left text-sm leading-6 font-normal text-zinc-500 transition hover:bg-zinc-200/70 hover:text-zinc-800;
}

.sidebar-tools-toggle-icon {
  @apply h-4 w-4 shrink-0 transition-transform text-zinc-500;
}

.sidebar-tools-toggle-icon[data-open='true'] {
  @apply rotate-180;
}

.sidebar-tools-panel {
  @apply flex flex-col gap-1;
}

.sidebar-tools-settings {
  @apply mt-1 flex flex-col gap-1 border-t pt-2;
  border-color: var(--border-soft);
}

.sidebar-tools-settings-label {
  @apply px-2.5 text-[11px] font-medium uppercase tracking-wide;
  color: var(--text-muted);
}

.sidebar-skills-link {
  @apply mx-1.5 flex h-7 items-center rounded-md border-0 bg-transparent px-2.5 text-[13px] leading-5 text-zinc-600 transition hover:bg-zinc-200/80 hover:text-zinc-900 cursor-pointer;
}

.sidebar-skills-link.is-active {
  @apply bg-zinc-200 text-zinc-900 font-medium;
}

.sidebar-rate-limits {
  @apply mx-0;
}

.sidebar-thread-controls-header-host {
  @apply ml-1;
}

.content-project-label {
  @apply mt-0.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-4;
  background: var(--surface-muted);
  color: var(--text-tertiary);
}

.content-project-label-icon {
  @apply h-3 w-3 shrink-0;
}

.content-project-label-text {
  @apply truncate;
}

.content-body {
  @apply flex-1 min-h-0 w-full flex flex-col gap-2 pt-1 pb-0 sm:pb-4 overflow-y-hidden overflow-x-visible;
  overscroll-behavior: none;
}

.content-error {
  @apply m-0 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700;
}

.content-grid {
  @apply flex-1 min-h-0 flex flex-col gap-2.5;
  overscroll-behavior: none;
}

.content-thread {
  @apply flex-1 min-h-0;
  overscroll-behavior: none;
}

.composer-with-queue {
  @apply w-full;
  overscroll-behavior: none;
}

.content-thread :deep(.conversation-list),
.composer-with-queue :deep(.queued-messages-inner),
.composer-with-queue :deep(.thread-composer-input) {
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.new-thread-empty {
  @apply flex-1 min-h-0 flex flex-col items-center justify-center gap-0.5 px-3 sm:px-6;
}

.new-thread-hero {
  @apply m-0 text-2xl sm:text-[2.5rem] font-normal leading-[1.05] text-zinc-900;
}

.build-badge {
  @apply hidden;
}

</style>
