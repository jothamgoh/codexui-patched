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
          <button
            class="sidebar-primary-link"
            :class="{ 'is-active': isBoardsRoute }"
            type="button"
            @click="openBoardsHub"
          >
            <SquareKanban class="sidebar-primary-link-icon" />
            <span>Project boards</span>
            <span v-if="projectBoardNeedsInputCount" class="sidebar-primary-count is-attention">
              {{ projectBoardNeedsInputCount }}
            </span>
          </button>
        </nav>

        <SidebarThreadTree :groups="sidebarProjectGroups" :board-threads="boardThreads" :project-display-name-by-id="projectDisplayNameById"
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
                <UiFontSizeControl
                  :model-value="uiFontSize"
                  @update:model-value="setUiFontSize"
                />
                <SpeedSettingControl
                  v-if="fastModeAvailable"
                  :model-value="fastModeEnabled"
                  :is-saving="isUpdatingFastMode"
                  :error="fastModeError"
                  @update:model-value="setFastModeEnabled"
                />
                <QuestionSettingControl />
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
      <section
        class="content-root"
        :class="{
          'has-workspace-review': workspaceReviewOpen,
          'has-board-detail': isBoardsRoute && Boolean(activeProjectBoardFeature),
        }"
      >
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
          <template v-if="contentProjectLabel" #meta>
            <span class="content-project-label" :title="contentProjectPath || contentProjectLabel">
              <IconTablerFolder class="content-project-label-icon" />
              <span class="content-project-label-text">{{ contentProjectLabel }}</span>
            </span>
          </template>
          <template #actions>
            <Button v-if="route.name === 'thread' && selectedThreadId && !selectedChatBoard" type="button" variant="ghost" size="icon-sm" title="Track on board" aria-label="Track on board" @click="openTrackFeature"><SquareKanban /></Button>
            <WorkspaceSummaryButton
              v-if="showWorkspaceSummary"
              :thread-id="selectedThreadId"
              :cwd="selectedThread?.cwd ?? ''"
              :thread-in-progress="isSelectedThreadInProgress"
              :last-turn-changes="latestTurnReviewChanges"
              @review-open-change="workspaceReviewOpen = $event"
            />
            <NotificationSettingsButton
              ref="notificationSettingsRef"
              :threads="notificationThreads"
              :active-thread-id="selectedThreadId"
              :board-attention="projectBoardAttention"
              :board-thread-ids="boardManagedThreadIds"
              :board-activity-titles="boardActivityTitles"
              :board-activity="boardActivity"
              :pending-requests="pendingServerRequests"
              @select-thread="onSelectThread"
              @select-board-question="openProjectBoardQuestion"
            />
          </template>
        </ContentHeader>

        <section class="content-body">
          <template v-if="isBoardsRoute">
            <ProjectBoardsHub
              :snapshot="projectBoardSnapshot"
              :pending-requests="pendingServerRequests"
              :is-loading="isLoadingProjectBoards"
              :is-mutating="isMutatingProjectBoards"
              :error="projectBoardError"
              :projects="projectBoardProjectOptions"
              :initial-board-id="routeBoardId"
              :initial-feature-id="routeFeatureId"
              :initial-question-id="routeQuestionId"
              :initial-project-path="routeBoardProjectPath"
              @select-project="openProjectBoardProject"
              @select-board="openProjectBoard"
              @select-feature="setProjectBoardFeature"
              :actions="{
                ensureBoard: onEnsureProjectBoard, createBoard: onCreateProjectBoard,
                updateBoard: updateProjectBoard, createAgent: createProjectBoardAgent, updateAgent: updateProjectBoardAgent,
                createCard: onCreateProjectBoardCard, updateCard: updateProjectBoardCard,
                deleteCard: deleteProjectBoardCard, addComment: onAddProjectBoardComment,
                answerQuestion: onAnswerProjectBoardQuestion, startFeature: onStartProjectBoardFeature,
                stopFeature: stopProjectBoardFeature,
                startQueue: startProjectBoardQueue, stopQueue: stopProjectBoardQueue,
                clearError: clearProjectBoardError,
              }"
              @plan-board="openBoardPlanner"
              @select-thread="onSelectThread"
            />
          </template>
          <template v-else-if="isScheduledRoute">
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
              <section v-if="selectedChatBoard" class="board-chat-context" aria-label="Tracked work">
                <div class="board-chat-links">
                  <SquareKanban aria-hidden="true" />
                  <button type="button" class="board-chat-feature" @click="openLinkedFeature">{{ selectedChatFeature?.title || selectedChatBoard.name + ' · Planning' }}</button>
                  <span class="board-chat-status">{{ selectedChatStatus }}</span>
                  <button type="button" @click="openProjectBoard(selectedChatBoard.id)">View board</button>
                </div>
                <p v-if="projectBoardError" role="alert">{{ projectBoardError }} <button type="button" @click="clearProjectBoardError">Dismiss</button></p>
                <p v-if="selectedChatQuestion"><button type="button" @click="openProjectBoardQuestion({ boardId: selectedChatBoard.id, featureId: selectedChatFeature!.id, questionId: selectedChatQuestion.id })">Answer needed: {{ selectedChatQuestion.prompt }}</button></p>
                <p v-else-if="selectedChatNativeQuestion">Answer the request in this chat to continue.</p>
                <p v-else-if="selectedChatRun?.error">{{ selectedChatRun.error }}</p>
                <details v-if="selectedChatFeature && !selectedChatIsRunning" ref="boardChatOptionsRef" class="board-chat-options"><summary>{{ selectedChatFeature.status === 'done' ? 'Reopen to continue' : boardReplyMode === 'plan' ? 'Plan only' : 'Continue work' }}<span v-if="boardChatSendDisabled && !selectedChatQuestion && !selectedChatNativeQuestion"> · choose access</span></summary><div class="board-chat-reply-controls">
                  <label v-if="canPlanChatFeature"><span>Next message</span><select v-model="boardReplyMode" aria-label="Lead reply mode"><option value="plan">Plan only</option><option value="execute">Continue work</option></select></label>
                  <span v-else>Continue this feature</span>
                  <label v-if="selectedChatFeature.status === 'done'"><input v-model="boardReplyReopen" type="checkbox" />Reopen feature</label>
                  <label v-if="boardReplyMode === 'execute' && chatLeadNeedsWrite"><input v-model="boardReplyWrite" type="checkbox" />Allow workspace changes</label>
                  <button type="button" @click="openLinkedFeature">Lead settings</button>
                  <button v-if="selectedChatFeature.sourceThreadId || selectedChatBoard.sourceThreadId" type="button" @click="onSelectThread(selectedChatFeature.sourceThreadId || selectedChatBoard.sourceThreadId)">Original chat</button>
                </div></details>
                <p v-if="(selectedChatIsRunning || !selectedChatFeature) && (selectedChatFeature?.sourceThreadId || selectedChatBoard.sourceThreadId)" class="board-chat-source"><button type="button" @click="onSelectThread(selectedChatFeature?.sourceThreadId || selectedChatBoard.sourceThreadId)">Original chat</button></p>
              </section>
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

              <div class="composer-with-queue" @focusin="collapseBoardReplyOptions">
                <QueuedMessages
                  :messages="selectedThreadQueuedMessages"
                  @steer="steerQueuedMessage"
                  @delete="removeQueuedMessage"
                />
                <ThreadComposer ref="threadComposerRef" :active-thread-id="composerThreadContextId"
                  :submit-message="selectedChatBoard ? onSubmitBoardChatMessage : undefined"
                  :send-disabled="Boolean(selectedChatBoard) && boardChatSendDisabled"
                  :hide-model-settings="Boolean(selectedChatBoard)"
                  :cwd="composerCwd"
                  :models="availableModelIds"
                  :selected-model="selectedModelId" :selected-reasoning-effort="selectedReasoningEffort"
                  :skills="installedSkills"
                  :threads="composerThreadMentions"
                  :thread-token-usage="composerThreadTokenUsage"
                  :show-context-usage="true"
                  :goal="selectedThreadGoal"
                  :turn-activity-label="composerTurnActivityLabel"
                  :is-turn-in-progress="isSelectedThreadInProgress" :is-interrupting-turn="isInterruptingTurn || Boolean(selectedChatFeature && isMutatingProjectBoards)"
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
  <TrackFeatureDialog v-model:open="trackFeatureOpen" :source-thread-id="trackSourceThreadId"
    :initial-brief="trackInitialBrief" :boards="trackBoards" :agents="projectBoardSnapshot.agents"
    :created-feature-id="trackCreatedFeatureId" :on-track="onTrackFeature" @plan-project="openTrackProjectPlan" />
  <BoardPlanDialog
    v-model:open="boardPlanDialogOpen"
    :board-id="boardPlanTargetId" :source-thread-id="boardPlanSourceThreadId"
    :initial-plan="boardPlanInitialText" :initial-project-path="boardPlanProjectPath"
    :initial-coordinator-id="boardPlanTarget?.coordinatorAgentId"
    :projects="projectBoardProjectOptions" :agents="boardPlanAgents"
    :on-plan="onPlanProjectBoard"
  />
  <div class="build-badge" aria-label="Worktree name">
    WT {{ worktreeName }}
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Blocks, CalendarClock, SquareKanban } from '@lucide/vue'
import { useRoute, useRouter } from 'vue-router'
import DesktopLayout from './components/layout/DesktopLayout.vue'
import SidebarThreadTree from './components/sidebar/SidebarThreadTree.vue'
import ContentHeader from './components/content/ContentHeader.vue'
import ThreadConversation from './components/content/ThreadConversation.vue'
import ThreadComposer, { type SubmitPayload } from './components/content/ThreadComposer.vue'
import TrackFeatureDialog from './components/content/TrackFeatureDialog.vue'
import { useComposerDraftStore } from './stores/composerDrafts'
import { collectProjectBoardActivity } from './utils/projectBoardActivity'
import QueuedMessages from './components/content/QueuedMessages.vue'
import NewThreadFolderPicker from './components/content/NewThreadFolderPicker.vue'
import SkillsHub from './components/content/SkillsHub.vue'
import McpHub from './components/content/McpHub.vue'
import PluginsHub from './components/content/PluginsHub.vue'
import ScheduledTasksHub from './components/content/ScheduledTasksHub.vue'
import ProjectBoardsHub from './components/content/ProjectBoardsHub.vue'
import BoardPlanDialog, { type BoardPlanDraft } from './components/content/BoardPlanDialog.vue'
import Button from './components/ui/button/Button.vue'
import ChatSearchDialog from './components/content/ChatSearchDialog.vue'
import RateLimitsSummary from './components/content/RateLimitsSummary.vue'
import ThemeToggleButton from './components/content/ThemeToggleButton.vue'
import UiFontSizeControl from './components/content/UiFontSizeControl.vue'
import SpeedSettingControl from './components/content/SpeedSettingControl.vue'
import NotificationSettingsButton from './components/content/NotificationSettingsButton.vue'
import QuestionSettingControl from './components/content/QuestionSettingControl.vue'
import WorkspaceSummaryButton from './components/content/WorkspaceSummaryButton.vue'
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
import { useProjectBoards } from './composables/useProjectBoards'
import { useTheme } from './composables/useTheme'
import { useUiFontSize } from './composables/useUiFontSize'
import {
  getHomeDirectory,
  getProjectRootSuggestion,
  openProjectRoot,
  getThreadSummary,
  type PluginMentionParam,
  type ThreadMentionParam,
} from './api/codexGateway'
import type { ReasoningEffort, ResponseTextAnnotation, ThreadScrollState, UiMessage, UiThread, UiProjectGroup } from './types/codex'
import type { AutomationDraft } from './types/automations'
import type { ProjectBoardCardCreateInput, ProjectBoardCreateInput, ProjectBoardStatus } from './types/projectBoards'

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
  pendingServerRequests,
  selectedThreadActiveTurnId,
  prepareThreadMessageInput,
  selectedLiveOverlay,
  selectedThreadId,
  availableModelIds,
  selectedModelId,
  selectedReasoningEffort,
  setBoardManagedThreadIds,
  fastModeAvailable,
  fastModeEnabled,
  isUpdatingFastMode,
  fastModeError,
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
  setFastModeEnabled,
  refreshFastModePreference,
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
const { uiFontSize, setUiFontSize } = useUiFontSize()
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
const {
  snapshot: projectBoardSnapshot,
  isLoading: isLoadingProjectBoards,
  isMutating: isMutatingProjectBoards,
  error: projectBoardError,
  needsInputCount: projectBoardNeedsInputCount,
  load: refreshProjectBoards,
  start: startProjectBoards,
  stop: stopProjectBoards,
  ensureDefaultBoard: ensureProjectBoard,
  createBoard: createProjectBoard,
  updateBoard: updateProjectBoard,
  createAgent: createProjectBoardAgent,
  updateAgent: updateProjectBoardAgent,
  createCard: createProjectBoardCard,
  updateCard: updateProjectBoardCard,
  deleteCard: deleteProjectBoardCard,
  addComment: addProjectBoardComment,
  answerQuestion: answerProjectBoardQuestion,
  startFeature: startProjectBoardFeature,
  stopFeature: stopProjectBoardFeature,
  sendChatMessage: sendProjectBoardChatMessage,
  planBoard: planProjectBoard,
  startQueue: startProjectBoardQueue,
  stopQueue: stopProjectBoardQueue,
  clearError: clearProjectBoardError,
} = useProjectBoards({ showBrowserNotifications: true })
const composerDraftStore = useComposerDraftStore()
const boardActivity = computed(() => collectProjectBoardActivity(projectBoardSnapshot.value))
const boardPendingThreadIds = computed(() => new Set(pendingServerRequests.value.map((request) => request.threadId).filter(Boolean)))
const boardThreads = computed(() => Object.fromEntries(boardActivity.value.filter((item) => item.threadId).map((item) => [item.threadId, {
  boardId: item.boardId, featureId: item.featureId, title: item.title,
  status: (boardPendingThreadIds.value.has(item.threadId) ? 'needs_input' : item.status === 'running' || item.status === 'paused' ? 'working' : item.status) as ProjectBoardStatus,
}])))
const sidebarProjectGroups = computed<UiProjectGroup[]>(() => {
  const groups = projectGroups.value.map((group) => ({ ...group, threads: group.threads.map((thread) => boardThreads.value[thread.id]?.status === 'needs_input' ? { ...thread, inProgress: false } : thread) }))
  const known = new Set(groups.flatMap((group) => group.threads.map((thread) => thread.id)))
  for (const activity of boardActivity.value) {
    if (!activity.threadId || known.has(activity.threadId)) continue
    const board = projectBoardSnapshot.value.boards.find((entry) => entry.id === activity.boardId)
    if (!board) continue
    let group = groups.find((entry) => entry.threads.some((thread) => thread.cwd === board.projectPath) || entry.projectName === board.projectName)
    if (!group) { group = { projectName: board.projectName, threads: [] }; groups.push(group) }
    group.threads.unshift({ id: activity.threadId, title: activity.title, projectName: group.projectName, cwd: board.projectPath,
      createdAtIso: activity.updatedAtIso, updatedAtIso: activity.updatedAtIso, preview: activity.summary,
      inProgress: activity.status === 'running' && !boardPendingThreadIds.value.has(activity.threadId), unread: false, hasWorktree: false })
    known.add(activity.threadId)
  }
  return groups
})
const selectedChatFeature = computed(() => projectBoardSnapshot.value.cards.find((card) => card.type === 'feature' && card.threadId && card.threadId === selectedThreadId.value))
const selectedChatBoard = computed(() => projectBoardSnapshot.value.boards.find((board) => selectedChatFeature.value
  ? board.id === selectedChatFeature.value.boardId : Boolean(board.planningThreadId) && board.planningThreadId === selectedThreadId.value))
const selectedChatRun = computed(() => projectBoardSnapshot.value.runs.find((run) => run.threadId === selectedThreadId.value && selectedThreadId.value))
const selectedChatIsRunning = computed(() => Boolean(selectedChatRun.value && ['running', 'queued'].includes(selectedChatRun.value.status)))
const selectedChatQuestion = computed(() => projectBoardSnapshot.value.questions.find((question) => question.status === 'open' && Boolean(selectedChatFeature.value) && (question.cardId === selectedChatFeature.value?.id || projectBoardSnapshot.value.cards.some((card) => card.id === question.cardId && card.parentCardId === selectedChatFeature.value?.id))))
const selectedChatNativeQuestion = computed(() => selectedThreadServerRequests.value.length > 0)
const selectedChatStatus = computed(() => selectedChatQuestion.value || selectedChatNativeQuestion.value ? 'Needs you' : selectedChatIsRunning.value ? 'Working' : selectedChatFeature.value?.status === 'done' ? 'Done' : selectedChatFeature.value?.planStatus === 'ready' || (selectedChatRun.value?.kind === 'board_plan' && selectedChatRun.value.status === 'succeeded') ? 'Plan ready' : 'Paused')
const canPlanChatFeature = computed(() => !projectBoardSnapshot.value.cards.some((card) => card.parentCardId === selectedChatFeature.value?.id && card.status !== 'backlog'))
const chatLeadNeedsWrite = computed(() => {
  const board = selectedChatBoard.value
  return Boolean(board && projectBoardSnapshot.value.agents.some((agent) => board.agentIds.includes(agent.id) && agent.sandbox === 'workspace-write'))
})
const boardChatOptionsRef = ref<HTMLDetailsElement | null>(null)
function collapseBoardReplyOptions(event: FocusEvent): void {
  if (isMobile.value && event.target instanceof HTMLTextAreaElement && boardChatOptionsRef.value) boardChatOptionsRef.value.open = false
}
const boardReplyMode = ref<'plan' | 'execute'>('execute')
const boardReplyWrite = ref(false)
const boardReplyReopen = ref(false)
watch([() => selectedThreadId.value, () => selectedChatRun.value?.id, () => selectedChatIsRunning.value], () => {
  boardReplyWrite.value = false; boardReplyReopen.value = false
  boardReplyMode.value = canPlanChatFeature.value && selectedChatRun.value?.kind === 'plan' && selectedChatFeature.value?.planStatus !== 'ready' ? 'plan' : 'execute'
})
const boardChatSendDisabled = computed(() => Boolean(selectedChatQuestion.value || selectedChatNativeQuestion.value)
  || (selectedChatIsRunning.value ? !selectedThreadActiveTurnId.value : Boolean(selectedChatFeature.value && (
    (selectedChatFeature.value.status === 'done' && !boardReplyReopen.value)
    || (boardReplyMode.value === 'execute' && chatLeadNeedsWrite.value && !boardReplyWrite.value)))))
const trackFeatureOpen = ref(false)
const trackSourceThreadId = ref('')
const trackProjectPath = ref('')
const trackInitialBrief = ref('')
const trackCreatedFeatureId = ref('')
const trackBoards = computed(() => projectBoardSnapshot.value.boards.filter((board) => board.projectPath === trackProjectPath.value))
const pendingLeadNavigation = ref<{ featureId: string; route: string } | null>(null)
watch(() => projectBoardSnapshot.value, (snapshot) => {
  const pending = pendingLeadNavigation.value
  if (!pending) return
  if (route.fullPath !== pending.route) { pendingLeadNavigation.value = null; return }
  const feature = snapshot.cards.find((card) => card.id === pending.featureId)
  if (feature?.threadId) { pendingLeadNavigation.value = null; onSelectThread(feature.threadId) }
  else if (feature && !snapshot.runs.some((run) => run.cardId === feature.id && ['running', 'queued'].includes(run.status))) pendingLeadNavigation.value = null
})
const boardPlanDialogOpen = ref(false)
const boardPlanTargetId = ref('')
const boardPlanSourceThreadId = ref('')
const boardPlanInitialText = ref('')
const boardPlanProjectPath = ref('')
const boardPlanTarget = computed(() => projectBoardSnapshot.value.boards.find((board) => board.id === boardPlanTargetId.value))
const boardPlanAgents = computed(() => projectBoardSnapshot.value.agents.filter((agent) => !boardPlanTarget.value || boardPlanTarget.value.agentIds.includes(agent.id)))
const boardManagedThreadIds = computed(() => Array.from(new Set([
  ...projectBoardSnapshot.value.cards.map((card) => card.threadId),
  ...projectBoardSnapshot.value.boards.map((board) => board.planningThreadId),
  ...projectBoardSnapshot.value.runs.map((run) => run.threadId),
].filter(Boolean))))
const boardActivityTitles = computed(() => Object.fromEntries([
  ...projectBoardSnapshot.value.boards.map((board) => [board.id, board.name]),
  ...projectBoardSnapshot.value.cards.map((card) => [card.id, card.title]),
]))
watch(boardManagedThreadIds, (ids) => setBoardManagedThreadIds(ids), { immediate: true })
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
const routeBoardId = computed(() => {
  const rawBoardId = route.params.boardId
  return typeof rawBoardId === 'string' ? rawBoardId : ''
})
const routeFeatureId = computed(() => typeof route.query.feature === 'string' ? route.query.feature : '')
const routeQuestionId = computed(() => typeof route.query.question === 'string' ? route.query.question : '')
const routeBoardProjectPath = computed(() => typeof route.query.project === 'string' ? route.query.project : '')

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
const isBoardsRoute = computed(() => route.name === 'boards' || route.name === 'board')
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
  if (isHomeRoute.value || isScheduledRoute.value || isBoardsRoute.value || isSkillsRoute.value || isMcpRoute.value || isPluginsRoute.value) return ''
  const thread = selectedThread.value
  if (!thread) return ''
  return projectDisplayNameById.value[thread.projectName] ?? thread.projectName
})
const activeProjectBoard = computed(() => projectBoardSnapshot.value.boards.find((board) => board.id === routeBoardId.value) ?? null)
const activeProjectBoardFeature = computed(() => projectBoardSnapshot.value.cards.find((card) => card.id === routeFeatureId.value && card.boardId === activeProjectBoard.value?.id && !card.parentCardId))
const contentProjectLabel = computed(() => activeProjectBoard.value?.projectName || selectedThreadProjectLabel.value)
const contentProjectPath = computed(() => activeProjectBoard.value?.projectPath || selectedThread.value?.cwd || '')
const themeToggleLabel = computed(() => (isDarkTheme.value ? 'Switch to light mode' : 'Switch to dark mode'))
const contentTitle = computed(() => {
  if (isScheduledRoute.value) return 'Scheduled tasks'
  if (isBoardsRoute.value) return activeProjectBoard.value?.name ?? 'Project boards'
  if (isSkillsRoute.value) return 'Skills'
  if (isMcpRoute.value) return 'MCPs'
  if (isPluginsRoute.value) return 'Plugins'
  if (isHomeRoute.value) return 'New thread'
  return selectedChatFeature.value?.title || (selectedChatBoard.value ? `${selectedChatBoard.value.name} · Planning` : selectedThread.value?.title) || 'Choose a thread'
})
const filteredMessages = computed(() => {
  const recoveredConnectionFailureIds = findRecoveredConnectionFailureIds(messages.value)
  return messages.value.filter((message) =>
    !recoveredConnectionFailureIds.has(message.id) &&
    shouldShowConversationMessage(message),
  )
})
const latestTurnReviewChanges = computed(() => {
  const latestTurnIndex = messages.value.reduce((latest, message) => {
    return typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)
      ? Math.max(latest, message.turnIndex)
      : latest
  }, -1)
  if (latestTurnIndex < 0) return null
  return messages.value.find((message) => (
    message.turnIndex === latestTurnIndex && message.reviewChanges
  ))?.reviewChanges ?? null
})
const workspaceReviewOpen = ref(false)
const showWorkspaceSummary = computed(() => Boolean(
  !isHomeRoute.value
  && !isScheduledRoute.value
  && !isBoardsRoute.value
  && !isSkillsRoute.value
  && !isMcpRoute.value
  && !isPluginsRoute.value
  && selectedThreadId.value
  && selectedThread.value?.cwd?.trim(),
))
watch(
  () => [selectedThreadId.value, showWorkspaceSummary.value] as const,
  ([threadId, showSummary], [previousThreadId]) => {
    if (!showSummary || threadId !== previousThreadId) workspaceReviewOpen.value = false
  },
)
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
const projectBoardAttention = computed(() => projectBoardSnapshot.value.questions
  .filter((question) => question.status === 'open')
  .map((question) => {
    const card = projectBoardSnapshot.value.cards.find((entry) => entry.id === question.cardId)
    const feature = card?.type === 'feature' || card?.type === 'qa_batch'
      ? card
      : projectBoardSnapshot.value.cards.find((entry) => entry.id === card?.parentCardId)
    return {
      questionId: question.id,
      boardId: question.boardId,
      featureId: feature?.id ?? question.cardId,
      title: feature?.title ?? card?.title ?? 'Feature needs your input',
      prompt: question.prompt,
      createdAtIso: question.createdAtIso,
    }
  }))
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
const projectBoardProjectOptions = computed(() => newThreadFolderOptions.value.map((option) => ({
  path: option.value,
  name: option.label,
})))
onMounted(() => {
  window.addEventListener('keydown', onWindowKeyDown)
  window.addEventListener('keyup', onWindowKeyUp)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('pageshow', onAppResume)
  document.addEventListener('visibilitychange', onAppResume)
  void initialize()
  startAutomations()
  startProjectBoards()
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
  stopProjectBoards()
  stopPolling()
})

function onAppResume(): void {
  if (document.visibilityState !== 'visible') return
  const now = Date.now()
  if (now - lastAppResumeRefreshAt < 750) return
  lastAppResumeRefreshAt = now
  void refreshThreadReadState()
  void refreshFastModePreference()
  void refreshPinnedThreads()
  void refreshAutomations()
  void refreshProjectBoards()
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
  if (nextValue) void refreshFastModePreference()
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

function openBoardsHub(): void {
  const currentProjectPath = selectedThread.value?.cwd?.trim() || newThreadCwd.value.trim()
  const projectBoards = projectBoardSnapshot.value.boards.filter((board) => board.projectPath === currentProjectPath)
  const board = projectBoards.find((entry) => entry.isDefault) ?? projectBoards[0]
  void router.push(board ? { name: 'board', params: { boardId: board.id } } : { name: 'boards' })
  if (isMobile.value) setSidebarCollapsed(true)
}

function openProjectBoardProject(projectPath: string): void {
  const boards = projectBoardSnapshot.value.boards.filter((board) => board.projectPath === projectPath)
  const board = boards.find((entry) => entry.isDefault) ?? boards[0]
  void router.push(board ? { name: 'board', params: { boardId: board.id } } : { name: 'boards', query: { project: projectPath } })
}

function openProjectBoard(boardId: string): void {
  if (!boardId) return
  void router.push({ name: 'board', params: { boardId } })
  if (isMobile.value) setSidebarCollapsed(true)
}

function setProjectBoardFeature(featureId: string, boardId = routeBoardId.value, questionId = ''): void {
  if (!boardId) return
  void router.replace({
    name: 'board',
    params: { boardId },
    query: featureId ? { feature: featureId, ...(questionId ? { question: questionId } : {}) } : {},
  })
}

function openProjectBoardQuestion(payload: { boardId: string; featureId: string; questionId: string }): void {
  void router.push({
    name: 'board',
    params: { boardId: payload.boardId },
    query: { feature: payload.featureId, question: payload.questionId },
  })
  if (isMobile.value) setSidebarCollapsed(true)
}

async function onEnsureProjectBoard(input: ProjectBoardCreateInput): Promise<void> {
  const next = await ensureProjectBoard(input)
  const board = next.boards.find((entry) => entry.projectPath === input.projectPath && entry.isDefault)
    ?? next.boards.find((entry) => entry.projectPath === input.projectPath)
  if (board) openProjectBoard(board.id)
}

async function onCreateProjectBoard(input: ProjectBoardCreateInput): Promise<void> {
  const previousIds = new Set(projectBoardSnapshot.value.boards.map((board) => board.id))
  const next = await createProjectBoard(input)
  const created = next.boards.find((board) => !previousIds.has(board.id))
  if (created) openProjectBoard(created.id)
}

async function onCreateProjectBoardCard(input: ProjectBoardCardCreateInput): Promise<void> {
  const previousIds = new Set(projectBoardSnapshot.value.cards.map((card) => card.id))
  const next = await createProjectBoardCard(input)
  const created = next.cards.find((card) => !previousIds.has(card.id))
  if (created) setProjectBoardFeature(created.id, created.boardId)
}

async function onAddProjectBoardComment(cardId: string, text: string): Promise<void> {
  await addProjectBoardComment(cardId, { text })
}

async function onAnswerProjectBoardQuestion(questionId: string, answer: string): Promise<void> {
  await answerProjectBoardQuestion(questionId, { answer })
}

async function onStartProjectBoardFeature(featureId: string, allowWorkspaceWrite: boolean, mode: 'plan' | 'execute' = 'execute'): Promise<void> {
  requestBrowserTurnNotificationsPermission()
  const origin = route.fullPath
  const snapshot = await startProjectBoardFeature(featureId, allowWorkspaceWrite, mode)
  if (route.fullPath !== origin) return
  const feature = snapshot.cards.find((card) => card.id === featureId)
  if (feature?.threadId) onSelectThread(feature.threadId)
  else pendingLeadNavigation.value = { featureId, route: origin }
}

function openLinkedFeature(): void {
  if (!selectedChatBoard.value) return
  if (selectedChatFeature.value) setProjectBoardFeature(selectedChatFeature.value.id, selectedChatBoard.value.id)
  else openProjectBoard(selectedChatBoard.value.id)
}

async function onSubmitBoardChatMessage(payload: SubmitPayload): Promise<void> {
  const threadId = selectedThreadId.value
  if (!selectedChatBoard.value || boardChatSendDisabled.value) throw new Error('Resolve the request or choose how to continue before sending.')
  const options = { expectedTurnId: selectedChatIsRunning.value ? selectedThreadActiveTurnId.value : undefined,
    mode: boardReplyMode.value, allowWorkspaceWrite: boardReplyWrite.value, reopenAndSend: boardReplyReopen.value }
  const prepared = await prepareThreadMessageInput(threadId, payload)
  requestBrowserTurnNotificationsPermission()
  try { await sendProjectBoardChatMessage(threadId, { ...prepared, ...options, clientUserMessageId: crypto.randomUUID() }) }
  catch (error) { clearProjectBoardError(); throw error }
}

function openTrackFeature(): void {
  clearProjectBoardError()
  if (trackSourceThreadId.value !== selectedThreadId.value || !projectBoardSnapshot.value.cards.some((card) => card.id === trackCreatedFeatureId.value)) trackCreatedFeatureId.value = ''
  trackSourceThreadId.value = selectedThreadId.value
  trackProjectPath.value = selectedThread.value?.cwd || newThreadCwd.value
  trackInitialBrief.value = composerDraftStore.draftFor(selectedThreadId.value).text.trim()
    || [...messages.value].reverse().find((message) => message.role === 'user' && message.text.trim())?.text.slice(0, 12000) || ''
  trackFeatureOpen.value = true
}

function openTrackProjectPlan(brief: string): void {
  trackFeatureOpen.value = false
  openChatBoardPlan()
  if (brief.trim() && (brief !== trackInitialBrief.value || composerDraftStore.draftFor(trackSourceThreadId.value).text.trim())) boardPlanInitialText.value = brief
}

async function onTrackFeature(draft: ProjectBoardCardCreateInput): Promise<void> {
  let boardId = draft.boardId
  if (!boardId) {
    const projectName = projectBoardProjectOptions.value.find((project) => project.path === trackProjectPath.value)?.name
      || trackProjectPath.value.split('/').filter(Boolean).at(-1) || 'Project'
    const snapshot = await ensureProjectBoard({ projectPath: trackProjectPath.value, projectName })
    boardId = snapshot.boards.find((board) => board.projectPath === trackProjectPath.value && board.isDefault)?.id || ''
    if (!boardId) throw new Error('Could not find the project board.')
  }
  if (!trackCreatedFeatureId.value) {
    const previousIds = new Set(projectBoardSnapshot.value.cards.map((card) => card.id))
    const snapshot = await createProjectBoardCard({ ...draft, boardId })
    trackCreatedFeatureId.value = snapshot.cards.find((card) => !previousIds.has(card.id))?.id || ''
    if (!trackCreatedFeatureId.value) throw new Error('Could not find the new feature.')
  } else {
    await updateProjectBoardCard(trackCreatedFeatureId.value, { title: draft.title || undefined, description: draft.description,
      assignedAgentId: draft.assignedAgentId, model: draft.model, reasoningEffort: draft.reasoningEffort })
  }
  await onStartProjectBoardFeature(trackCreatedFeatureId.value, false, 'plan')
  trackCreatedFeatureId.value = ''
}

function openChatBoardPlan(): void {
  clearProjectBoardError()
  boardPlanTargetId.value = ''
  boardPlanSourceThreadId.value = selectedThreadId.value
  boardPlanProjectPath.value = selectedThread.value?.cwd || newThreadCwd.value
  boardPlanInitialText.value = [...messages.value].reverse().find((message) => message.role === 'assistant' && message.text.trim() && !message.commandExecution && !message.toolCall)?.text.slice(0, 12000) || ''
  boardPlanDialogOpen.value = true
}

function openBoardPlanner(boardId: string): void {
  clearProjectBoardError()
  const board = projectBoardSnapshot.value.boards.find((entry) => entry.id === boardId)
  boardPlanTargetId.value = boardId
  boardPlanSourceThreadId.value = board?.sourceThreadId || ''
  boardPlanProjectPath.value = board?.projectPath || ''
  boardPlanInitialText.value = board?.plan || ''
  boardPlanDialogOpen.value = true
}

async function onPlanProjectBoard(draft: BoardPlanDraft): Promise<void> {
  let boardId = draft.boardId
  if (!boardId) {
    const projectPath = await openProjectRoot(draft.projectPath, { createIfMissing: draft.createFolder })
    const previousIds = new Set(projectBoardSnapshot.value.boards.map((board) => board.id))
    const projectName = projectBoardProjectOptions.value.find((project) => project.path === projectPath)?.name || projectPath.split('/').filter(Boolean).at(-1) || 'Project'
    const snapshot = await createProjectBoard({ projectPath, projectName, name: draft.name, isDefault: !projectBoardSnapshot.value.boards.some((board) => board.projectPath === projectPath) })
    boardId = snapshot.boards.find((board) => !previousIds.has(board.id))?.id || ''
    if (!boardId) throw new Error('Could not find the new board.')
    // A retry after planning fails must reuse the board already created.
    boardPlanTargetId.value = boardId
    const board = snapshot.boards.find((entry) => entry.id === boardId)
    if (board && draft.coordinatorAgentId && !board.agentIds.includes(draft.coordinatorAgentId)) await updateProjectBoard(boardId, { agentIds: [...board.agentIds, draft.coordinatorAgentId] })
  }
  requestBrowserTurnNotificationsPermission()
  await planProjectBoard(boardId, draft)
  openProjectBoard(boardId)
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
  if (isMobile.value) setSidebarCollapsed(true)
  if (route.name === 'thread' && routeThreadId.value === threadId) return
  void router.push({ name: 'thread', params: { threadId } })
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
  const feature = projectBoardSnapshot.value.cards.find((card) => card.type === 'feature' && card.threadId === payload.threadId)
  if (feature) void updateProjectBoardCard(feature.id, { title: payload.name }).catch(() => {})
  else void renameThread(payload.threadId, payload.name)
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
  if (selectedChatFeature.value && selectedChatIsRunning.value) {
    void stopProjectBoardFeature(selectedChatFeature.value.id, selectedChatRun.value?.id).catch(() => {})
  } else void interruptSelectedThreadTurn()
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
  // Board updates and approval requests must not wait for chat/account hydration.
  startPolling()
  await Promise.all([
    refreshAll(),
    refreshPinnedThreads(),
  ])
  hasInitialized.value = true
  await syncThreadSelectionWithRoute()
}

async function syncThreadSelectionWithRoute(): Promise<void> {
  if (isRouteSyncInProgress.value) return
  isRouteSyncInProgress.value = true
  const requestedRoute = route.fullPath

  try {
    if (
      route.name === 'home'
      || route.name === 'scheduled'
      || route.name === 'boards'
      || route.name === 'board'
      || route.name === 'skills'
      || route.name === 'mcps'
      || route.name === 'plugins'
    ) {
      if (selectedThreadId.value !== '') {
        await selectThread('')
      }
      return
    }

    if (route.name === 'thread') {
      const threadId = routeThreadId.value
      if (!threadId) return

      if (!knownThreadIdSet.value.has(threadId)) {
        try {
          // A newly spawned child may not have reached the thread list yet.
          const thread = await getThreadSummary(threadId)
          if (route.fullPath === requestedRoute) await selectThreadFromSearch(thread)
        } catch {
          if (route.fullPath === requestedRoute) await router.replace({ name: 'home' })
        }
        return
      }

      if (selectedThreadId.value !== threadId) {
        await selectThread(threadId)
      }
      return
    }

  } finally {
    isRouteSyncInProgress.value = false
    if (route.fullPath !== requestedRoute) void syncThreadSelectionWithRoute()
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
    if (isHomeRoute.value || isScheduledRoute.value || isBoardsRoute.value || isSkillsRoute.value || isMcpRoute.value || isPluginsRoute.value) return

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
}, { immediate: true })

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

@media (min-width: 1280px) and (pointer: fine) {
  .content-root.has-workspace-review {
    padding-right: min(64rem, max(34rem, 46vw));
  }

  .content-root.has-board-detail {
    padding-right: min(42rem, 44vw);
  }
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

.sidebar-primary-count.is-attention {
  @apply bg-amber-100 text-amber-800;
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

.board-chat-context { flex: 0 0 auto; margin: 0 12px; padding: 8px 10px; border: 1px solid var(--border-soft); border-radius: 10px; color: var(--text-secondary); font-size: 12px; }
.board-chat-links, .board-chat-reply-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.board-chat-links svg { width: 14px; height: 14px; flex-shrink: 0; }
.board-chat-links .board-chat-feature { flex: 1; min-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; font-weight: 600; color: var(--text-primary); }
.board-chat-context button { cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.board-chat-status { color: var(--text-tertiary); }
.board-chat-context p[role="alert"] { white-space: normal; overflow-wrap: anywhere; }
.board-chat-context p { margin: 5px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-chat-reply-controls { margin-top: 6px; }
.board-chat-options summary { cursor: pointer; padding: 5px 0; }
.board-chat-reply-controls label { display: flex; align-items: center; gap: 6px; }
.board-chat-reply-controls select { padding: 4px; background: var(--surface-elevated); border: 1px solid var(--border-soft); border-radius: 5px; }
@media (max-width: 640px) { .board-chat-context { margin: 0 8px; padding: 0 8px; } .board-chat-context button, .board-chat-reply-controls label, .board-chat-options summary { min-height: 44px; }
  .board-chat-options summary { display: flex; align-items: center; gap: 4px; } .board-chat-reply-controls select { min-height: 44px; font-size: 16px; } .board-chat-context p { margin: 0; } }

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
