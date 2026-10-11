<template>
  <Popover v-model:open="isOpen">
    <PopoverTrigger as-child>
      <button
        class="notification-trigger"
        :data-has-activity="runningActivity.length > 0 || totalAttentionCount > 0"
        type="button"
        :aria-label="triggerLabel"
        :title="`${triggerLabel} (⌘J)`"
      >
        <Bell class="notification-trigger-icon" />
        <span v-if="runningActivity.length > 0 || totalAttentionCount > 0" class="notification-trigger-statuses" aria-hidden="true">
          <span v-if="runningActivity.length > 0" class="notification-trigger-count is-running">
            <LoaderCircle />
            {{ compactCount(runningActivity.length) }}
          </span>
          <span v-if="totalAttentionCount > 0" class="notification-trigger-count is-unread">
            <Circle />
            {{ compactCount(totalAttentionCount) }}
          </span>
        </span>
      </button>
    </PopoverTrigger>

    <PopoverContent
      align="end"
      :side-offset="8"
      class="notification-popover"
      :class="{ 'is-landing': landing && !landing.inPanel }"
      @open-auto-focus.prevent
    >
      <header class="notification-header">
        <div>
          <p class="notification-title">Notifications</p>
          <p class="notification-subtitle">
            <template v-for="(part, index) in activitySummary.split(' · ')" :key="index">
              <span v-if="index > 0" aria-hidden="true"> · </span><span class="notification-subtitle-part">{{ part }}</span>
            </template>
          </p>
        </div>
        <button
          v-if="activeView === 'activity' && unreadAttentionCount > 0"
          class="notification-mark-all"
          type="button"
          aria-label="Mark all as read"
          :disabled="markAllReadBusy"
          :aria-busy="markAllReadBusy"
          @click="void markAllActivityRead()"
        >
          <LoaderCircle v-if="markAllReadBusy" class="notification-mark-all-icon is-spinning" />
          <MailOpen v-else class="notification-mark-all-icon" />
          <span class="notification-mark-all-label">{{ markAllReadBusy ? 'Marking…' : 'Mark all as read' }}</span>
          <span class="notification-mark-all-short" aria-hidden="true">{{ markAllReadBusy ? 'Marking…' : 'Read all' }}</span>
        </button>
        <VoiceCommandMic
          ref="voiceMicRef"
          v-model:status="voiceMicStatus"
          class="notification-voice-mic"
          size="compact"
          @result="onPanelVoiceResult"
        />
        <button class="notification-close" type="button" aria-label="Close notifications" @click="isOpen = false">
          <X />
        </button>
      </header>

      <div
        v-if="voiceMicStatus.phase !== 'idle'"
        class="notification-mic-status"
        :class="`is-${voiceMicStatus.phase}`"
        role="status"
        aria-label="Voice mic"
      >
        <LoaderCircle v-if="voiceMicStatus.phase === 'working' || voiceMicStatus.phase === 'starting'" class="notification-mic-status-icon is-spinning" aria-hidden="true" />
        <CircleAlert v-else-if="voiceMicStatus.phase === 'error'" class="notification-mic-status-icon" aria-hidden="true" />
        <span v-else class="notification-mic-status-dot" aria-hidden="true" />
        <span class="notification-mic-status-text">{{ voiceMicStatus.text }}</span>
        <button v-if="voiceMicStatus.canRetry" class="notification-mic-status-retry" type="button" @click="voiceMicRef?.retry()">Retry</button>
      </div>

      <VoiceNote
        v-if="landing?.voice"
        class="notification-voice"
        :lead="landing.voice.lead"
        :heard="landing.voice.heard"
        :note="showLandingNote ? landing.voice.note : ''"
        :mic="false"
      />

      <div class="notification-tabs" role="tablist" aria-label="Notification views">
        <button
          class="notification-tab"
          :class="{ 'is-active': activeView === 'activity' }"
          type="button"
          role="tab"
          :aria-selected="activeView === 'activity'"
          @click="activeView = 'activity'"
        >
          Activity
        </button>
        <button
          class="notification-tab"
          :class="{ 'is-active': activeView === 'settings' }"
          type="button"
          role="tab"
          :aria-selected="activeView === 'settings'"
          @click="activeView = 'settings'"
        >
          <Settings2 class="notification-tab-icon" />
          Settings
        </button>
      </div>

      <div v-if="activeView === 'activity'" class="notification-activity-toolbar">
        <div class="notification-filter" role="group" aria-label="Activity filter">
          <button
            class="notification-filter-button"
            :class="{ 'is-active': activityFilter === 'all' }"
            type="button"
            :aria-pressed="activityFilter === 'all'"
            @click="activityFilter = 'all'"
          >
            All
          </button>
          <button
            class="notification-filter-button"
            :class="{ 'is-active': activityFilter === 'unread' }"
            type="button"
            :aria-pressed="activityFilter === 'unread'"
            @click="activityFilter = 'unread'"
          >
            Unread
            <span class="notification-filter-count">{{ compactCount(totalAttentionCount) }}</span>
          </button>
        </div>
      </div>

      <div
        v-if="activeView === 'activity'"
        ref="activityScrollRef"
        class="notification-activity"
        role="tabpanel"
        @touchstart.passive="stopLandingScroll"
        @wheel.passive="stopLandingScroll"
        @pointerdown="stopLandingScroll"
      >
        <p v-if="helpersLoading" class="px-3 py-2 text-xs text-muted-foreground" role="status">Loading helper activity…</p>
        <div v-else-if="helpersError" class="flex items-center gap-2 px-3 text-xs" role="status">
          <span class="min-w-0 flex-1">{{ helpersError }}</span>
          <button type="button" class="min-h-11 px-2 underline" @click="emit('refreshHelpers')">Retry</button>
        </div>
        <div v-if="hasVisibleActivity" class="notification-sections">
          <section v-if="needsYouCount > 0" class="notification-section" v-bind="sectionMarker('needs_you')">
            <div class="notification-section-header">
              <span>Needs you</span>
              <span class="notification-section-count">{{ needsYouCount }}</span>
            </div>
            <div v-for="item in boardAttention" :key="`board:${item.questionId}`">
            <NotificationRow
              tone="failed"
              :title="item.title"
              pill="Needs you"
              pill-tone="attention"
              :preview="item.prompt"
              @click="openBoardQuestion(item)"
            >
              <template #meta>
                <span class="notification-board-label"><SquareKanban />{{ boardNameFor(item.boardId) }}</span>
                <span aria-hidden="true">·</span><span>{{ formatRelative(item.createdAtIso) }}</span>
              </template>
            </NotificationRow>
            <ThreadHelpers :helpers="threadHelpers.helpersByOwnerId[boardActivity?.find((work) => work.boardId === item.boardId && work.featureId === item.featureId)?.threadId || ''] || []" :waiting-thread-ids="waitingThreadIds" @select-thread="openThread" />
            </div>
            <div v-for="item in requestAttention" :key="`request:${item.threadId}`">
            <NotificationRow
              tone="failed"
              :title="item.title"
              :pill="item.label"
              pill-tone="attention"
              :preview="`Open the chat to ${item.label === 'Approval needed' ? 'review and approve or decline.' : 'answer and continue.'}`"
              @click="openThread(item.threadId)"
            >
              <template #meta>
                <span v-if="item.board" class="notification-board-label"><SquareKanban />{{ item.board.boardName }}</span>
                <span v-else>Chat</span><span aria-hidden="true">·</span><span>{{ formatRelative(item.receivedAtIso) }}</span>
              </template>
            </NotificationRow>
            <ThreadHelpers :helpers="threadHelpers.helpersByOwnerId[item.threadId] || []" :waiting-thread-ids="waitingThreadIds" @select-thread="openThread" />
            </div>
          </section>

          <template v-if="activityFilter === 'all'">
            <section v-if="pinnedRows.length > 0" class="notification-section" aria-label="Pinned chats">
              <div class="notification-section-header">
                <Pin class="notification-section-icon" />
                <span>Pinned</span>
                <span class="notification-section-count">{{ pinnedRows.length }}</span>
              </div>
              <div
                v-for="row in pinnedRows"
                :key="`pinned:${row.threadId}`"
                class="notification-recent-row"
              >
                <NotificationRow
                  class="notification-recent-main"
                  :tone="row.tone"
                  :title="row.title"
                  :pill="row.pill"
                  :pill-tone="row.tone === 'failed' ? 'attention' : 'unread'"
                  @click="openThread(row.threadId)"
                >
                  <template #meta>
                    <span>{{ row.statusLabel }}</span>
                    <span aria-hidden="true">·</span>
                    <span>{{ formatRelative(row.activityAt) }}</span>
                    <kbd v-if="shortcutNumber(row.threadId)" class="notification-shortcut">
                      ⌘{{ shortcutNumber(row.threadId) }}
                    </kbd>
                  </template>
                </NotificationRow>
                <button
                  class="notification-more-button"
                  type="button"
                  :aria-label="`Unpin ${row.title}`"
                  title="Unpin"
                  @click.stop="setPinned(row.threadId, false)"
                >
                  <PinOff />
                </button>
              </div>
            </section>

            <section v-if="boardWorkActivity.length > 0" class="notification-section notification-board-work" aria-label="Board work">
              <div class="notification-section-header">
                <SquareKanban class="notification-section-icon" />
                <span>Board work</span>
                <span class="notification-section-count">{{ boardWorkActivity.length }}</span>
              </div>
              <div v-for="item in boardWorkActivity" :key="`board-work:${item.boardId}:${item.featureId}`">
                <div class="notification-board-work-row">
                <NotificationRow
                  class="notification-board-main"
                  :tone="item.status === 'running' ? 'running' : 'board'"
                  :title="item.title"
                  wrap-meta
                  :aria-label="`${item.threadId ? 'Open Lead chat' : 'Open feature'} for ${item.title}`"
                  @click="item.threadId ? openThread(item.threadId) : openActivityBoard(item)"
                >
                  <template #meta>
                    <span class="notification-board-status" :data-status="item.status">{{ boardWorkStatusLabel(item) }}</span>
                    <span aria-hidden="true">·</span><span>{{ item.threadId ? 'Lead chat' : 'Starting Lead' }}</span>
                    <kbd v-if="shortcutNumber(`board:${item.boardId}:${item.featureId}`)" class="notification-shortcut">⌘{{ shortcutNumber(`board:${item.boardId}:${item.featureId}`) }}</kbd>
                  </template>
                  <span class="notification-board-name">{{ item.boardName }}</span>
                </NotificationRow>
                <button class="notification-board-open" type="button" :aria-label="`View board for ${item.title}`" @click="openActivityBoard(item)">
                  <SquareKanban /><span>Board</span>
                </button>
                </div>
                <ThreadHelpers :helpers="threadHelpers.helpersByOwnerId[item.threadId] || []" :waiting-thread-ids="waitingThreadIds" @select-thread="openThread" />
              </div>
            </section>

            <section v-if="listedRunningThreads.length > 0" class="notification-section" aria-label="Chats running" v-bind="sectionMarker('running')">
              <div class="notification-section-header">
                <span>Chats running</span>
                <span class="notification-section-count">{{ listedRunningThreads.length }}</span>
              </div>
              <div v-for="thread in listedRunningThreads" :key="`running:${thread.id}`">
              <NotificationRow tone="running" :title="threadTitle(thread)" @click="openThread(thread.id)">
                <template #meta>
                  <span>In progress</span>
                  <span aria-hidden="true">·</span>
                  <span>{{ formatRelative(thread.updatedAtIso) }}</span>
                  <kbd v-if="shortcutNumber(thread.id)" class="notification-shortcut">
                    ⌘{{ shortcutNumber(thread.id) }}
                  </kbd>
                </template>
              </NotificationRow>
              <ThreadHelpers :helpers="threadHelpers.helpersByOwnerId[thread.id] || []" :waiting-thread-ids="waitingThreadIds" @select-thread="openThread" />
              </div>
            </section>

            <section v-if="listedUnreadThreads.length > 0" class="notification-section" v-bind="sectionMarker('unread')">
              <div class="notification-section-header">
                <span>Unread</span>
                <span class="notification-section-count">{{ listedUnreadThreads.length }}</span>
              </div>
              <NotificationRow
                v-for="thread in listedUnreadThreads"
                :key="`unread:${thread.id}`"
                tone="unread"
                :title="threadTitle(thread)"
                pill="Unread"
                @click="openThread(thread.id)"
              >
                <template #meta>
                  <span>Completed — not opened</span>
                  <span aria-hidden="true">·</span>
                  <span>{{ formatRelative(thread.updatedAtIso) }}</span>
                  <kbd v-if="shortcutNumber(thread.id)" class="notification-shortcut">
                    ⌘{{ shortcutNumber(thread.id) }}
                  </kbd>
                </template>
              </NotificationRow>
            </section>
          </template>

          <section v-if="visibleRecentHistory.length > 0" class="notification-section" v-bind="sectionMarker(activityFilter === 'unread' ? 'unread' : 'recent')">
            <div class="notification-section-header">
              <span>{{ activityFilter === 'unread' ? 'Unread' : 'Recent activity' }}</span>
              <span v-if="activityFilter === 'unread'" class="notification-section-count">
                {{ unreadAttentionCount }}
              </span>
            </div>
            <div
              v-for="item in visibleRecentHistory"
              :key="item.id"
              class="notification-recent-row"
            >
              <NotificationRow
                class="notification-recent-main"
                :tone="isAttentionStatus(item.status) ? 'failed' : 'completed'"
                :title="item.title"
                :pill="item.isUnread ? 'Unread' : ''"
                :pill-tone="isAttentionStatus(item.status) ? 'attention' : 'unread'"
                :preview="item.body"
                :style="recentRowStyle(item)"
                @click="openRecentItem(item)"
                @touchstart="onRecentTouchStart(item, $event)"
                @touchmove="onRecentTouchMove(item, $event)"
                @touchend="onRecentTouchEnd(item)"
                @touchcancel="resetRecentSwipe"
              >
                <template #meta>
                  <span>{{ activityStatusLabel(item) }}</span>
                  <span aria-hidden="true">·</span>
                  <span>{{ formatRelative(item.completedAt) }}</span>
                  <kbd v-if="shortcutNumber(item.threadId)" class="notification-shortcut">
                    ⌘{{ shortcutNumber(item.threadId) }}
                  </kbd>
                </template>
              </NotificationRow>
              <button
                class="notification-more-button"
                type="button"
                :aria-label="`More actions for ${item.title}`"
                :aria-expanded="expandedActionItemId === item.id"
                title="More actions"
                @click.stop="toggleRecentActions(item)"
              >
                <MoreHorizontal />
              </button>
              <div
                v-if="expandedActionItemId === item.id"
                class="notification-row-actions"
                role="group"
                :aria-label="`Actions for ${item.title}`"
              >
                <button
                  type="button"
                  @click.stop="void setRecentActivityUnread(item, !item.isUnread)"
                >
                  <MailOpen v-if="item.isUnread" />
                  <Mail v-else />
                  {{ item.isUnread ? 'Mark read' : 'Mark unread' }}
                </button>
                <button
                  v-if="!item.projectBoard"
                  type="button"
                  @click.stop="setPinned(item.threadId, !pinnedThreadIdSet.has(item.threadId))"
                >
                  <PinOff v-if="pinnedThreadIdSet.has(item.threadId)" />
                  <Pin v-else />
                  {{ pinnedThreadIdSet.has(item.threadId) ? 'Unpin' : 'Pin' }}
                </button>
                <button
                  v-if="item.projectBoard"
                  type="button"
                  @click.stop="openActivityBoard(item.projectBoard)"
                >
                  <SquareKanban />
                  View board
                </button>
                <button
                  v-if="activityFilter === 'all' || item.source === 'history'"
                  class="is-destructive"
                  type="button"
                  @click.stop="void dismissRecentActivity(item)"
                >
                  <X />
                  Dismiss
                </button>
              </div>
            </div>
            <button
              v-if="activityFilter === 'all' && canToggleRecentLimit"
              class="notification-show-more"
              type="button"
              @click="toggleRecentLimit"
            >
              {{ recentLimit > DEFAULT_RECENT_LIMIT ? 'Show fewer' : `Show ${hiddenRecentCount.toString()} more` }}
            </button>
          </section>
        </div>

        <div v-else-if="historyBusy" class="notification-empty">
          <LoaderCircle class="notification-empty-icon is-spinning" />
          <p>Checking chat activity…</p>
        </div>

        <div v-else class="notification-empty">
          <CheckCircle2 class="notification-empty-icon" />
          <p class="notification-empty-title">
            {{ activityFilter === 'unread' ? 'No unread notifications' : "You're all caught up" }}
          </p>
          <p>
            {{ activityFilter === 'unread'
              ? 'Switch to All to see recent activity.'
              : 'Chat and project board activity will appear here.' }}
          </p>
        </div>

        <p v-if="historyError" class="notification-error" role="alert">{{ historyError }}</p>
      </div>

      <div v-else class="notification-settings" role="tabpanel">
        <section class="notification-setting-group">
          <div>
            <p class="notification-setting-title">Web Push</p>
            <p class="notification-setting-status" :data-status="pushIndicatorStatus">{{ statusLabel }}</p>
          </div>

          <p class="notification-setting-description">{{ statusDescription }}</p>

          <ol v-if="status === 'needs-install'" class="notification-install-steps">
            <li>Open this site in Safari.</li>
            <li>Tap Share, then Add to Home Screen.</li>
            <li>Open Agents from its new Home Screen icon.</li>
          </ol>

          <template v-else-if="status !== 'unsupported'">
            <label class="notification-mode-field">
              <span class="notification-mode-label">Chat and board alerts</span>
              <select
                class="notification-mode-select"
                :value="mode"
                :disabled="isBusy || status === 'blocked'"
                @change="onModeChange"
              >
                <option value="off">Never</option>
                <option value="unfocused">Only when unfocused</option>
                <option value="always">Always</option>
              </select>
            </label>

            <div class="notification-settings-actions">
              <button
                v-if="!isEnabled && status !== 'blocked'"
                class="notification-primary-action"
                type="button"
                :disabled="isBusy"
                @click="void enableWebPushNotifications()"
              >
                <LoaderCircle v-if="isBusy" class="notification-action-icon is-spinning" />
                <BellRing v-else class="notification-action-icon" />
                <span>{{ isBusy ? 'Enabling…' : 'Enable notifications' }}</span>
              </button>

              <button
                v-if="isEnabled"
                class="notification-secondary-action"
                type="button"
                :disabled="isBusy"
                @click="void testWebPushNotification()"
              >
                <LoaderCircle v-if="isBusy" class="notification-action-icon is-spinning" />
                <Bell v-else class="notification-action-icon" />
                <span>{{ isBusy ? 'Sending…' : 'Send test' }}</span>
              </button>
            </div>
          </template>

          <p v-if="status === 'blocked' && isIOS" class="notification-note">
            On iPhone, open Settings → Notifications → Agents and turn on Allow Notifications, then reopen this panel.
            If Agents is not listed there, remove it from the Home Screen, add it again from Safari, and tap Allow when asked.
          </p>
          <p v-else-if="status === 'blocked'" class="notification-note">
            Allow Agents notifications in your browser and macOS settings, then reopen this panel.
          </p>
          <p v-if="errorMessage" class="notification-error" role="alert">{{ errorMessage }}</p>
          <p v-if="testMessage" class="notification-success" role="status">
            {{ testMessage }}
            <span>If no banner appeared, allow Google Chrome in macOS Settings → Notifications.</span>
          </p>
        </section>

        <section class="notification-setting-group">
          <div class="notification-toggle-row">
            <div>
              <p class="notification-setting-title">Telegram fallback</p>
              <p class="notification-setting-description">
                Send turn-complete links through the existing bot. Turning this off keeps its setup.
              </p>
            </div>
            <button
              class="notification-switch"
              :data-enabled="telegramConfig?.enabled === true"
              type="button"
              role="switch"
              :aria-checked="telegramConfig?.enabled === true"
              :aria-label="telegramConfig?.enabled ? 'Disable Telegram notifications' : 'Enable Telegram notifications'"
              :disabled="telegramBusy || telegramConfig?.available !== true"
              @click="void toggleTelegramNotifications()"
            >
              <span class="notification-switch-thumb" />
            </button>
          </div>
          <p class="notification-note">
            {{ telegramStatusLabel }}
          </p>
          <p v-if="telegramError" class="notification-error" role="alert">{{ telegramError }}</p>
        </section>

        <section class="notification-setting-group" aria-label="Voice commands">
          <div class="notification-toggle-row">
            <div>
              <p class="notification-setting-title">Auto-send voice commands</p>
              <p class="notification-setting-description">
                A clear send or new chat goes out without a tap. Say “draft” or “don't send” to only type it in.
              </p>
            </div>
            <button
              class="voice-setting-switch"
              type="button"
              role="switch"
              :aria-checked="voiceSettings?.autoSend === true"
              aria-label="Auto-send voice commands"
              :disabled="voiceBusy || !voiceSettings"
              @click="void saveVoice({ autoSend: !voiceSettings?.autoSend })"
            >
              <span class="notification-switch" :data-enabled="voiceSettings?.autoSend === true"><span class="notification-switch-thumb" /></span>
            </button>
          </div>
          <label class="notification-mode-field">
            <span class="notification-mode-label">Undo window</span>
            <select
              class="notification-mode-select voice-setting-select"
              :value="voiceSettings?.delaySeconds ?? 0"
              :disabled="voiceBusy || !voiceSettings || !voiceSettings.autoSend"
              @change="void saveVoice({ delaySeconds: Number(($event.target as HTMLSelectElement).value) as VoiceSendDelay })"
            >
              <option v-for="delay in VOICE_SEND_DELAYS" :key="delay" :value="delay">{{ delay === 0 ? 'Send immediately' : `${delay} s to cancel` }}</option>
            </select>
          </label>
          <label class="notification-mode-field">
            <span class="notification-mode-label">Default project for voice new chats</span>
            <select
              class="notification-mode-select voice-setting-select"
              :value="voiceSettings?.defaultProject ?? ''"
              :disabled="voiceBusy || !voiceSettings"
              @change="void saveVoice({ defaultProject: ($event.target as HTMLSelectElement).value })"
            >
              <option value="">{{ voiceFallbackProject ? `${voiceFallbackProject.label} (server)` : 'None: ask me' }}</option>
              <option v-for="project in voiceProjects" :key="project.id" :value="project.id">{{ project.label }}</option>
            </select>
          </label>
          <p class="notification-note">
            Used when you name no project, for example “find me hotels in Johor Bahru”. A project you name always wins.
          </p>
          <p v-if="voiceError" class="notification-error" role="alert">{{ voiceError }}</p>
        </section>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  Bell,
  BellRing,
  CheckCircle2,
  CircleAlert,
  Circle,
  LoaderCircle,
  Mail,
  MailOpen,
  MoreHorizontal,
  Pin,
  PinOff,
  Settings2,
  SquareKanban,
  X,
} from '@lucide/vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  dismissWebPushHistoryActivity,
  getWebPushHistory,
  markWebPushHistoryRead,
  markWebPushHistoryUnread,
  type WebPushHistory,
  type WebPushHistoryItem,
} from '../../api/webPush'
import { getThreadSummary, updateSharedThreadReadState } from '../../api/codexGateway'
import { subscribeInPageRpcNotifications } from '../../api/codexRpcClient'
import {
  getTelegramNotificationConfig,
  setTelegramNotificationsEnabled,
  type TelegramNotificationConfig,
} from '../../api/notificationSettings'
import {
  useWebPushNotifications,
  type TurnNotificationMode,
} from '../../composables/useWebPushNotifications'
import { useRelativeTimeClock } from '../../composables/useRelativeTimeClock'
import type { UiServerRequest, UiThread } from '../../types/codex'
import type { SetThreadPinnedIntent } from '../../utils/pinnedThreads'
import { formatCompactRelativeTime } from '../../utils/relativeTime'
import { openProjectBoardDeepLink, projectBoardNotificationDeepLink, type ProjectBoardNotification } from '../../utils/projectBoardNotifications'
import type { ProjectBoardActivity } from '../../utils/projectBoardActivity'
import type { ThreadSourceMap } from '../../utils/threadHelpers'
import {
  activityThreadTitle,
  isThreadRunning,
  MAX_RECENT_ACTIVITY_ITEMS,
  selectNotificationActivity,
  type RecentActivityItem,
  type RunningActivityItem,
} from '../../utils/notificationActivity'
import { planPanelVoiceLanding, type ActivityFocus, type ActivityLanding } from '../../utils/voiceLanding'
import { IDLE_MIC_STATUS, type VoiceMicStatus } from '../../utils/voiceMic'
import { getVoiceSettings, saveVoiceSettings, type VoiceCommandResponse, type VoiceSettingsResponse } from '../../api/voice'
import { VOICE_SEND_DELAYS, type VoiceProjectOption, type VoiceSendDelay, type VoiceSettings } from '../../types/voice'
import NotificationRow from './NotificationRow.vue'
import VoiceCommandMic from './VoiceCommandMic.vue'
import VoiceNote from './VoiceNote.vue'
import ThreadHelpers from './ThreadHelpers.vue'

type ManualThreadUnreadOverride = {
  unread: boolean
  activityAt: string
}

type ActivityFilter = 'all' | 'unread'

type PinnedRow = {
  threadId: string
  title: string
  activityAt: string
  tone: 'failed' | 'running' | 'unread' | 'pinned'
  statusLabel: string
  pill: string
}

const DEFAULT_RECENT_LIMIT = 6
const LANDING_HIGHLIGHT_MS = 2400
const LANDING_SCROLL_WAIT_MS = 6000
const relativeTimeNow = useRelativeTimeClock()

const props = defineProps<{
  threads: UiThread[]
  activeThreadId: string
  boardThreadIds?: string[]
  boardActivityTitles?: Record<string, string>
  boardActivity?: ProjectBoardActivity[]
  threadSources?: ThreadSourceMap
  helpersLoading?: boolean
  helpersError?: string
  pendingRequests?: UiServerRequest[]
  pinnedThreadIds?: string[]
  boardAttention: Array<{
    questionId: string
    boardId: string
    featureId: string
    title: string
    prompt: string
    createdAtIso: string
  }>
}>()

const emit = defineEmits<{
  (event: 'selectThread', threadId: string): void
  (event: 'refreshHelpers'): void
  (event: 'setThreadPinned', intent: SetThreadPinnedIntent): void
  (event: 'selectBoardQuestion', payload: { boardId: string; featureId: string; questionId: string }): void
  /** The in-app link of a voice command said into the panel's mic. */
  (event: 'openVoiceResult', url: string): void
}>()

const isOpen = ref(false)
const activeView = ref<'activity' | 'settings'>('activity')
const activityFilter = ref<ActivityFilter>('all')
const history = ref<WebPushHistoryItem[]>([])
const dismissedActivityByThreadId = ref<Record<string, string>>({})
const recentLimit = ref(DEFAULT_RECENT_LIMIT)
const swipingRecentItemId = ref('')
const swipeOffsetX = ref(0)
const expandedActionItemId = ref('')
const manualUnreadByThreadId = ref<Record<string, ManualThreadUnreadOverride>>({})
/** Pinned chats outside the loaded sidebar pages, fetched when the popover opens. */
const fetchedPinnedThreadById = ref<Record<string, UiThread>>({})
const historyBusy = ref(false)
const historyError = ref('')
const markAllReadBusy = ref(false)
const telegramConfig = ref<TelegramNotificationConfig | null>(null)
const telegramBusy = ref(false)
const voiceSettings = ref<VoiceSettings | null>(null)
const voiceProjectList = ref<VoiceProjectOption[]>([])
const voiceFallbackProject = ref<VoiceProjectOption | null>(null)
const voiceBusy = ref(false)
const voiceError = ref('')
/** The workspace roots, plus a saved default that is no longer one of them. */
const voiceProjects = computed(() => {
  const saved = voiceSettings.value?.defaultProject ?? ''
  const listed = voiceProjectList.value
  if (!saved || listed.some((project) => project.id === saved)) return listed
  return [...listed, { id: saved, label: saved.split('/').filter(Boolean).at(-1) ?? saved }]
})
const telegramError = ref('')
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let swipeStartX = 0
let swipeStartY = 0
let suppressRecentClickUntil = 0
let recentLongPressTimer: ReturnType<typeof setTimeout> | null = null
let recentLongPressTriggered = false
/** Set while the panel is open from a deep link (`?activity=`), such as a voice command. */
const landing = ref<ActivityLanding | null>(null)
const voiceMicRef = ref<{ retry: () => void } | null>(null)
const voiceMicStatus = ref<VoiceMicStatus>(IDLE_MIC_STATUS)
/** The section to scroll to once it has rows; the panel may still be loading. */
const pendingLandingFocus = ref<ActivityFocus | null>(null)
const highlightedSection = ref<ActivityFocus | ''>('')
const activityScrollRef = ref<HTMLElement | null>(null)
let landingHighlightTimer: ReturnType<typeof setTimeout> | null = null
let landingScrollTimer: ReturnType<typeof setTimeout> | null = null

const {
  status,
  mode,
  isBusy,
  errorMessage,
  testMessage,
  isEnabled,
  isIOS,
  initializeWebPushNotifications,
  enableWebPushNotifications,
  setTurnNotificationMode,
  testWebPushNotification,
} = useWebPushNotifications()

const activity = computed(() => selectNotificationActivity({
  threads: props.threads,
  threadSources: props.threadSources,
  boardThreadIds: props.boardThreadIds,
  boardActivity: props.boardActivity,
  boardActivityTitles: props.boardActivityTitles,
  boardAttention: props.boardAttention,
  pendingRequests: props.pendingRequests,
  history: history.value,
  dismissedActivityByThreadId: dismissedActivityByThreadId.value,
  pinnedThreadIds: props.pinnedThreadIds,
  isThreadUnread,
}))
const threadHelpers = computed(() => activity.value.threadHelpers)
const requestAttention = computed(() => activity.value.requestAttention)
const waitingThreadIds = computed(() => activity.value.waitingThreadIds)
const hasWorkingHelpers = (threadId: string) => activity.value.hasWorkingHelpers(threadId)
const needsYouCount = computed(() => props.boardAttention.length + requestAttention.value.length)
const boardWorkActivity = computed(() => activity.value.boardWorkActivity)
const runningThreads = computed(() => activity.value.runningThreads)
const runningActivity = computed(() => activity.value.runningActivity)
const unreadThreads = computed(() => activity.value.unreadThreads)
const visibleHistory = computed(() => activity.value.visibleHistory)
const allRecentHistory = computed(() => activity.value.allRecentHistory)
const unreadActivity = computed(() => activity.value.unreadActivity)
const pinnedThreadIdSet = computed(() => new Set(props.pinnedThreadIds ?? []))
const pinnedThreads = computed(() => (props.pinnedThreadIds ?? []).flatMap((threadId) => {
  const thread = props.threads.find((candidate) => candidate.id === threadId) ?? fetchedPinnedThreadById.value[threadId]
  return thread ? [thread] : []
}))
const listedRunningThreads = computed(() => runningThreads.value.filter((thread) => !pinnedThreadIdSet.value.has(thread.id)))
const listedUnreadThreads = computed(() => unreadThreads.value.filter((thread) => !pinnedThreadIdSet.value.has(thread.id)))
const pinnedRows = computed<PinnedRow[]>(() => {
  const unreadIds = new Set(unreadActivity.value.map((item) => item.threadId))
  return pinnedThreads.value.map((thread) => {
    const latest = visibleHistory.value.reduce<WebPushHistoryItem | undefined>((best, item) =>
      item.threadId === thread.id && (!best || Date.parse(item.completedAt) > Date.parse(best.completedAt)) ? item : best, undefined)
    const isUnread = unreadIds.has(thread.id) || isThreadUnread(thread)
    const activityAt = thread.updatedAtIso || thread.createdAtIso
    const row = { threadId: thread.id, title: threadTitle(thread), activityAt, pill: isUnread ? 'Unread' : '' }
    if (waitingThreadIds.value.has(thread.id)) return { ...row, tone: 'failed', statusLabel: 'Waiting for you', pill: 'Needs you' }
    if (isThreadRunning(thread) || hasWorkingHelpers(thread.id)) return { ...row, tone: 'running', statusLabel: 'In progress', pill: '' }
    if (latest && isAttentionStatus(latest.status)) {
      return { ...row, tone: 'failed', activityAt: latest.completedAt, statusLabel: activityStatusLabel({ status: latest.status, projectBoard: latest.projectBoard }) }
    }
    return { ...row, tone: isUnread ? 'unread' : 'pinned', statusLabel: isUnread ? 'Completed — not opened' : 'Pinned' }
  })
})
const recentHistory = computed(() => allRecentHistory.value.slice(0, recentLimit.value))
const visibleRecentHistory = computed(() =>
  activityFilter.value === 'unread' ? unreadActivity.value : recentHistory.value,
)
const shortcutThreadIds = computed(() => [...new Set(
  activityFilter.value === 'unread'
    ? unreadActivity.value.map((item) => item.threadId)
    : [
      ...pinnedRows.value.map((row) => row.threadId),
      ...runningActivity.value.map((item) => item.id),
      ...unreadThreads.value.map((thread) => thread.id),
      ...recentHistory.value.map((item) => item.threadId),
    ],
)].slice(0, 9))
const hiddenRecentCount = computed(() =>
  Math.max(0, allRecentHistory.value.length - DEFAULT_RECENT_LIMIT),
)
const canToggleRecentLimit = computed(() =>
  activityFilter.value === 'all' && allRecentHistory.value.length > DEFAULT_RECENT_LIMIT,
)
const unreadAttentionCount = computed(() => unreadActivity.value.length)
const totalAttentionCount = computed(() => unreadAttentionCount.value + needsYouCount.value)
const hasUnreadActivity = computed(() => unreadActivity.value.length > 0)
const hasActivity = computed(() =>
  pinnedRows.value.length > 0 ||
  boardWorkActivity.value.length > 0 ||
  runningActivity.value.length > 0 ||
  unreadThreads.value.length > 0 ||
  recentHistory.value.length > 0,
)
const hasVisibleActivity = computed(() =>
  needsYouCount.value > 0 || (activityFilter.value === 'unread' ? hasUnreadActivity.value : hasActivity.value),
)
const activitySummary = computed(() => {
  const parts: string[] = []
  if (runningActivity.value.length > 0) {
    parts.push(`${runningActivity.value.length.toString()} running`)
  }
  const waitingBoardWork = boardWorkActivity.value.filter((item) => item.status !== 'running').length
  if (waitingBoardWork > 0) parts.push(`${waitingBoardWork.toString()} board ${waitingBoardWork === 1 ? 'item' : 'items'} waiting`)
  if (needsYouCount.value > 0) parts.push(`${needsYouCount.value.toString()} need you`)
  if (unreadAttentionCount.value > 0) parts.push(`${unreadAttentionCount.value.toString()} unread`)
  return parts.length > 0 ? parts.join(' · ') : 'No work needs attention'
})
/** The voice result's "nothing here" note, until live activity shows that section has rows. */
const showLandingNote = computed(() => {
  const value = landing.value
  if (!value?.voice?.note) return false
  const liveCount: Record<ActivityFocus, number> = {
    all: 0,
    needs_you: needsYouCount.value,
    running: runningActivity.value.length,
    unread: unreadAttentionCount.value,
    recent: allRecentHistory.value.length,
  }
  return liveCount[value.focus] === 0
})
const triggerLabel = computed(() => `Notifications: ${activitySummary.value}`)

const pushIndicatorStatus = computed(() => {
  if (isEnabled.value) return 'enabled'
  if (status.value === 'blocked' || status.value === 'error') return 'attention'
  return 'inactive'
})

const statusLabel = computed(() => {
  if (status.value === 'enabled') return 'Enabled on this device'
  if (status.value === 'loading') return 'Checking this device…'
  if (status.value === 'needs-install') return 'Home Screen app required'
  if (status.value === 'blocked') return 'Blocked'
  if (status.value === 'unsupported') return 'Unavailable'
  if (status.value === 'error') return 'Needs attention'
  return 'Not enabled'
})

const statusDescription = computed(() => {
  if (status.value === 'enabled') {
    return 'Get chat completions and board questions, stopped runs, and finished features, even while this app is closed.'
  }
  if (status.value === 'needs-install') {
    return 'iPhone only allows Web Push from a Home Screen web app.'
  }
  if (status.value === 'blocked') {
    return 'Notification permission was denied for Agents.'
  }
  if (status.value === 'unsupported') {
    return 'This browser or connection does not support secure Web Push.'
  }
  if (status.value === 'error') {
    return 'Agents could not finish notification setup.'
  }
  return 'Enable chat and project board alerts on this device.'
})

const telegramStatusLabel = computed(() => {
  if (telegramBusy.value) return 'Updating…'
  if (!telegramConfig.value) return 'Checking Telegram setup…'
  if (!telegramConfig.value.available) return 'No Telegram bot is configured on this server.'
  return telegramConfig.value.enabled
    ? 'On — chat and board alerts are also sent to Telegram.'
    : 'Off — the bot setup is kept and can be re-enabled here.'
})

const threadActivitySignature = computed(() =>
  props.threads
    .map((thread) => `${thread.id}:${isThreadRunning(thread) ? '1' : '0'}:${thread.unread ? '1' : '0'}`)
    .join('|'),
)

watch(isOpen, (open) => {
  if (!open) {
    clearLanding()
    return
  }
  emit('refreshHelpers')
  activeView.value = 'activity'
  activityFilter.value = 'all'
  recentLimit.value = DEFAULT_RECENT_LIMIT
  resetRecentSwipe()
  expandedActionItemId.value = ''
  if (landing.value) applyLandingFocus(landing.value.focus)
  void refreshHistory()
  void fetchMissingPinnedThreads()
  void initializeWebPushNotifications(true)
  void refreshTelegramConfig()
  void refreshVoiceSettings()
})

watch(() => props.pinnedThreadIds, () => {
  if (isOpen.value) void fetchMissingPinnedThreads()
})

watch(threadActivitySignature, () => {
  if (!isOpen.value) return
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshHistory()
  }, 350)
})

watch(
  () => props.activeThreadId,
  (threadId) => {
    if (threadId) void markThreadHistoryRead(threadId)
  },
  { immediate: true },
)

// Keep the landing section at the top while the panel's data arrives (sections above it can
// appear later), until the user touches the list. Highlight it once, when it first shows.
watch(
  () => [
    pendingLandingFocus.value,
    activityScrollRef.value,
    activityFilter.value,
    needsYouCount.value,
    pinnedRows.value.length,
    boardWorkActivity.value.length,
    listedRunningThreads.value.length,
    listedUnreadThreads.value.length,
    visibleRecentHistory.value.length,
    props.helpersLoading,
    props.helpersError,
  ] as const,
  async ([focus]) => {
    if (!focus) return
    await nextTick()
    const container = activityScrollRef.value
    const section = container?.querySelector<HTMLElement>(`[data-activity-section="${focus}"]`)
    if (!container || !section || pendingLandingFocus.value !== focus) return
    container.scrollTop += section.getBoundingClientRect().top - container.getBoundingClientRect().top
    if (landingHighlightTimer) return
    highlightedSection.value = focus
    landingHighlightTimer = setTimeout(() => { highlightedSection.value = '' }, LANDING_HIGHLIGHT_MS)
  },
  { flush: 'post' },
)

function stopLandingScroll(): void {
  pendingLandingFocus.value = null
}

onBeforeUnmount(() => {
  clearLanding()
  unsubscribeBoardNotifications()
  if (refreshTimer) clearTimeout(refreshTimer)
  clearRecentLongPress()
})

const unsubscribeBoardNotifications = subscribeInPageRpcNotifications((notification) => {
  if (notification.method === 'codexui/projectBoards/notification' || notification.method === 'codexui/projectBoards/historyUpdated') void refreshHistory()
})

void refreshHistory()
void initializeWebPushNotifications()

async function refreshHistory(): Promise<void> {
  historyBusy.value = true
  historyError.value = ''
  try {
    const result = await getWebPushHistory()
    applyHistoryResult(result)
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : 'Could not load recent notifications'
  } finally {
    historyBusy.value = false
  }
}

async function markThreadHistoryRead(threadId: string): Promise<void> {
  try {
    const result = await markWebPushHistoryRead({ threadId })
    applyHistoryResult(result)
  } catch {
    // Navigation should still work if the activity read marker cannot be saved.
  }
}

async function markAllActivityRead(): Promise<void> {
  if (markAllReadBusy.value || unreadAttentionCount.value === 0) return

  const threadsToMark = props.threads.filter((thread) =>
    !isThreadRunning(thread) && (
      isThreadUnread(thread) ||
      history.value.some((item) => item.threadId === thread.id && item.readAt === null)
    ),
  )
  const previousOverrides = { ...manualUnreadByThreadId.value }
  const nextOverrides = { ...previousOverrides }
  for (const thread of threadsToMark) {
    nextOverrides[thread.id] = {
      unread: false,
      activityAt: thread.updatedAtIso,
    }
  }

  markAllReadBusy.value = true
  historyError.value = ''
  expandedActionItemId.value = ''
  manualUnreadByThreadId.value = nextOverrides

  try {
    const [historyResult] = await Promise.all([
      markWebPushHistoryRead({ all: true }),
      ...threadsToMark.map((thread) => updateSharedThreadReadState(thread.id, {
        unread: false,
        readAtIso: thread.updatedAtIso,
      })),
    ])
    applyHistoryResult(historyResult)
  } catch (error) {
    manualUnreadByThreadId.value = previousOverrides
    historyError.value = error instanceof Error ? error.message : 'Could not mark all notifications as read'
    void refreshHistory()
  } finally {
    markAllReadBusy.value = false
  }
}

function applyVoiceSettings(answer: VoiceSettingsResponse): void {
  voiceSettings.value = answer.settings
  voiceProjectList.value = answer.projects
  voiceFallbackProject.value = answer.fallbackProject
}

async function refreshVoiceSettings(): Promise<void> {
  voiceError.value = ''
  try {
    applyVoiceSettings(await getVoiceSettings())
  } catch (error) {
    voiceError.value = error instanceof Error ? error.message : 'Could not load voice settings'
  }
}

async function saveVoice(patch: Partial<VoiceSettings>): Promise<void> {
  if (voiceBusy.value) return
  voiceBusy.value = true
  voiceError.value = ''
  try {
    applyVoiceSettings(await saveVoiceSettings(patch))
  } catch (error) {
    voiceError.value = error instanceof Error ? error.message : 'Could not save voice settings'
  } finally {
    voiceBusy.value = false
  }
}

async function refreshTelegramConfig(): Promise<void> {
  telegramError.value = ''
  try {
    telegramConfig.value = await getTelegramNotificationConfig()
  } catch (error) {
    telegramError.value = error instanceof Error ? error.message : 'Could not load Telegram settings'
  }
}

async function toggleTelegramNotifications(): Promise<void> {
  if (telegramBusy.value || !telegramConfig.value?.available) return
  telegramBusy.value = true
  telegramError.value = ''
  try {
    telegramConfig.value = await setTelegramNotificationsEnabled(!telegramConfig.value.enabled)
  } catch (error) {
    telegramError.value = error instanceof Error ? error.message : 'Could not update Telegram settings'
  } finally {
    telegramBusy.value = false
  }
}

function openThread(threadId: string): void {
  if (!threadId) return
  const thread = props.threads.find((candidate) => candidate.id === threadId)
  if (thread) {
    manualUnreadByThreadId.value = {
      ...manualUnreadByThreadId.value,
      [threadId]: {
        unread: false,
        activityAt: thread.updatedAtIso,
      },
    }
    void updateSharedThreadReadState(threadId, {
      unread: false,
      readAtIso: thread.updatedAtIso,
    }).catch(() => {
      // The normal thread selection flow retries; keep navigation responsive.
    })
  }
  void markThreadHistoryRead(threadId)
  emit('selectThread', threadId)
  isOpen.value = false
}

function setPinned(threadId: string, pinned: boolean): void {
  expandedActionItemId.value = ''
  emit('setThreadPinned', { threadId, pinned, beforeThreadId: pinned ? props.pinnedThreadIds?.[0] : undefined })
}

async function fetchMissingPinnedThreads(): Promise<void> {
  const missing = (props.pinnedThreadIds ?? []).filter((threadId) =>
    !props.threads.some((thread) => thread.id === threadId) && !fetchedPinnedThreadById.value[threadId])
  if (missing.length === 0) return
  const summaries = await Promise.all(missing.map((threadId) => getThreadSummary(threadId).catch(() => null)))
  const next = { ...fetchedPinnedThreadById.value }
  for (const summary of summaries) if (summary) next[summary.id] = summary
  fetchedPinnedThreadById.value = next
}

function openBoardQuestion(item: { boardId: string; featureId: string; questionId: string }): void {
  void markWebPushHistoryRead({ ids: [`project-board-question:${item.questionId}`] }).then(applyHistoryResult).catch(() => {})
  isOpen.value = false
  emit('selectBoardQuestion', item)
}

function openRunningItem(item: RunningActivityItem): void {
  if (item.threadId) openThread(item.threadId)
  else if (item.board) openActivityBoard(item.board)
}

function boardNameFor(boardId: string): string {
  return props.boardActivity?.find((item) => item.boardId === boardId)?.boardName || 'Project board'
}

function boardWorkStatusLabel(item: ProjectBoardActivity): string {
  if (item.status !== 'running' && hasWorkingHelpers(item.threadId)) return 'Helpers working'
  if (item.status === 'running' && item.runKind === 'follow_up') return 'Conversation'
  return ({ running: 'Working', paused: 'Paused', blocked: 'Blocked', review: 'Needs review', needs_input: 'Waiting for you', done: 'Complete', backlog: 'Not started' })[item.status]
}

function openActivityBoard(item: { boardId: string; featureId: string }): void {
  isOpen.value = false
  openProjectBoardDeepLink(projectBoardNotificationDeepLink({ boardId: item.boardId, featureId: item.featureId }))
}

function openRecentItem(item: RecentActivityItem): void {
  if (Date.now() < suppressRecentClickUntil) return
  if (item.projectBoard) {
    void markThreadHistoryRead(item.threadId)
    isOpen.value = false
    const activity = boardItemForEvent(item.projectBoard)
    const threadId = item.projectBoard.threadId || activity?.threadId
    if ((item.projectBoard.kind === 'completed' || item.projectBoard.kind === 'native_request') && threadId) openThread(threadId)
    else openProjectBoardDeepLink(projectBoardNotificationDeepLink(item.projectBoard))
    return
  }
  openThread(item.threadId)
}

function isAttentionStatus(status: string): boolean {
  return status === 'failed' || status === 'question' || status === 'native_request'
}

function activityStatusLabel(item: Pick<RecentActivityItem, 'status' | 'projectBoard'>): string {
  if (item.status === 'failed') return 'Needs attention'
  if (item.status === 'question') return 'Question'
  if (item.status === 'answered') return 'Answered'
  if (item.status === 'plan_ready') return 'Plan ready'
  if (item.status === 'batch_completed') return 'Selected features complete'
  if (item.status === 'resolved') return 'Resolved'
  if (item.status === 'native_request') return item.projectBoard?.requestKind === 'approval' ? 'Approval needed' : 'Answer needed'
  return item.projectBoard ? 'Feature complete' : 'Completed'
}

function boardItemForEvent(event: ProjectBoardNotification): ProjectBoardActivity | undefined {
  return props.boardActivity?.find((item) => item.boardId === event.boardId && item.featureId === event.featureId)
}

function shortcutNumber(threadId: string): number {
  const index = shortcutThreadIds.value.indexOf(threadId)
  return index >= 0 ? index + 1 : 0
}

function sectionMarker(section: ActivityFocus): Record<string, unknown> {
  return { 'data-activity-section': section, class: { 'is-landing-focus': highlightedSection.value === section } }
}

/** Opens the panel on a section, for links such as a voice command's notification. */
function openActivityCenter(next: ActivityLanding): void {
  landing.value = next
  if (isOpen.value) applyLandingFocus(next.focus)
  else isOpen.value = true
}

function applyLandingFocus(focus: ActivityFocus): void {
  activeView.value = 'activity'
  // The Unread filter is the panel's own view of exactly the unread chats.
  activityFilter.value = focus === 'unread' ? 'unread' : 'all'
  highlightedSection.value = ''
  if (landingHighlightTimer) clearTimeout(landingHighlightTimer)
  landingHighlightTimer = null
  if (activityScrollRef.value) activityScrollRef.value.scrollTop = 0
  pendingLandingFocus.value = focus === 'all' ? null : focus
  if (landingScrollTimer) clearTimeout(landingScrollTimer)
  // Stop following after a few seconds, so a later update cannot yank the list.
  landingScrollTimer = setTimeout(stopLandingScroll, LANDING_SCROLL_WAIT_MS)
}

function openVoiceResult(url: string): void {
  isOpen.value = false
  emit('openVoiceResult', url)
}

/** A command said into the panel's mic: lists and "didn't catch that" stay here; the rest opens its page. */
function onPanelVoiceResult(response: VoiceCommandResponse): void {
  const plan = planPanelVoiceLanding(response.result, response.url)
  if (plan.kind === 'panel') openActivityCenter(plan.landing)
  else openVoiceResult(plan.url)
}

function clearLanding(): void {
  landing.value = null
  pendingLandingFocus.value = null
  highlightedSection.value = ''
  if (landingHighlightTimer) clearTimeout(landingHighlightTimer)
  if (landingScrollTimer) clearTimeout(landingScrollTimer)
  landingHighlightTimer = null
  landingScrollTimer = null
}

function toggleActivityCenter(): boolean {
  if (!isOpen.value) activeView.value = 'activity'
  isOpen.value = !isOpen.value
  return isOpen.value
}

function isActivityCenterOpen(): boolean {
  return isOpen.value
}

function selectActivityShortcut(index: number): boolean {
  if (!isOpen.value) return false
  const threadId = shortcutThreadIds.value[index]
  if (!threadId) return false
  const runningItem = runningActivity.value.find((candidate) => candidate.id === threadId)
  if (runningItem) {
    openRunningItem(runningItem)
    return true
  }
  const item = visibleRecentHistory.value.find((candidate) => candidate.threadId === threadId)
  if (item) openRecentItem(item)
  else openThread(threadId)
  return true
}

defineExpose({
  openActivityCenter,
  toggleActivityCenter,
  isActivityCenterOpen,
  selectActivityShortcut,
})

async function dismissRecentActivity(item: RecentActivityItem): Promise<void> {
  const previous = dismissedActivityByThreadId.value[item.threadId]
  dismissedActivityByThreadId.value = {
    ...dismissedActivityByThreadId.value,
    [item.threadId]: item.completedAt,
  }
  resetRecentSwipe()
  expandedActionItemId.value = ''
  try {
    const result = await dismissWebPushHistoryActivity(item.threadId, item.completedAt)
    applyHistoryResult(result)
  } catch (error) {
    const next = { ...dismissedActivityByThreadId.value }
    if (previous) next[item.threadId] = previous
    else delete next[item.threadId]
    dismissedActivityByThreadId.value = next
    historyError.value = error instanceof Error ? error.message : 'Could not dismiss this notification'
  }
}

async function setRecentActivityUnread(
  item: RecentActivityItem,
  unread: boolean,
): Promise<void> {
  const thread = props.threads.find((candidate) => candidate.id === item.threadId)
  const activityAt = thread?.updatedAtIso || item.completedAt
  const previous = manualUnreadByThreadId.value[item.threadId]
  manualUnreadByThreadId.value = {
    ...manualUnreadByThreadId.value,
    [item.threadId]: { unread, activityAt },
  }
  expandedActionItemId.value = ''
  historyError.value = ''

  try {
    const [historyResult] = await Promise.all([
      unread
        ? markWebPushHistoryUnread(item.threadId, item.completedAt)
        : markWebPushHistoryRead({ threadId: item.threadId }),
      !item.projectBoard ? updateSharedThreadReadState(
        item.threadId,
        unread
          ? { unread: true }
          : { unread: false, readAtIso: activityAt },
      ) : Promise.resolve(),
    ])
    applyHistoryResult(historyResult)
  } catch (error) {
    const next = { ...manualUnreadByThreadId.value }
    if (previous) next[item.threadId] = previous
    else delete next[item.threadId]
    manualUnreadByThreadId.value = next
    historyError.value = error instanceof Error ? error.message : 'Could not update this notification'
    void refreshHistory()
  }
}

function applyHistoryResult(result: WebPushHistory): void {
  history.value = result.items
  dismissedActivityByThreadId.value = Object.fromEntries(
    (result.dismissals ?? []).map((item) => [item.threadId, item.activityAt]),
  )
}

function toggleRecentLimit(): void {
  recentLimit.value = recentLimit.value > DEFAULT_RECENT_LIMIT
    ? DEFAULT_RECENT_LIMIT
    : MAX_RECENT_ACTIVITY_ITEMS
}

function recentRowStyle(item: RecentActivityItem): Record<string, string> | undefined {
  if (swipingRecentItemId.value !== item.id) return undefined
  return {
    transform: `translateX(${swipeOffsetX.value.toString()}px)`,
    transition: 'none',
  }
}

function toggleRecentActions(item: RecentActivityItem): void {
  resetRecentSwipe()
  expandedActionItemId.value = expandedActionItemId.value === item.id ? '' : item.id
}

function onRecentTouchStart(item: RecentActivityItem, event: TouchEvent): void {
  const touch = event.touches[0]
  if (!touch) return
  clearRecentLongPress()
  recentLongPressTriggered = false
  swipingRecentItemId.value = item.id
  swipeOffsetX.value = 0
  swipeStartX = touch.clientX
  swipeStartY = touch.clientY
  recentLongPressTimer = setTimeout(() => {
    recentLongPressTimer = null
    recentLongPressTriggered = true
    suppressRecentClickUntil = Date.now() + 650
    swipingRecentItemId.value = ''
    swipeOffsetX.value = 0
    expandedActionItemId.value = item.id
  }, 550)
}

function onRecentTouchMove(item: RecentActivityItem, event: TouchEvent): void {
  if (swipingRecentItemId.value !== item.id) return
  const touch = event.touches[0]
  if (!touch) return
  const deltaX = touch.clientX - swipeStartX
  const deltaY = touch.clientY - swipeStartY
  if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8) clearRecentLongPress()
  if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 8) {
    resetRecentSwipe()
    return
  }
  if (deltaX >= 0) {
    swipeOffsetX.value = 0
    return
  }
  if (Math.abs(deltaX) > 8) {
    suppressRecentClickUntil = Date.now() + 450
    if (event.cancelable) event.preventDefault()
  }
  swipeOffsetX.value = Math.max(-88, deltaX)
}

function onRecentTouchEnd(item: RecentActivityItem): void {
  clearRecentLongPress()
  if (recentLongPressTriggered) {
    recentLongPressTriggered = false
    resetRecentSwipe()
    return
  }
  if (swipingRecentItemId.value !== item.id) return
  if (swipeOffsetX.value <= -52) {
    void dismissRecentActivity(item)
    return
  }
  resetRecentSwipe()
}

function resetRecentSwipe(): void {
  clearRecentLongPress()
  swipingRecentItemId.value = ''
  swipeOffsetX.value = 0
}

function clearRecentLongPress(): void {
  if (!recentLongPressTimer) return
  clearTimeout(recentLongPressTimer)
  recentLongPressTimer = null
}

function isThreadUnread(thread: UiThread): boolean {
  const override = manualUnreadByThreadId.value[thread.id]
  if (override && override.activityAt === thread.updatedAtIso) return override.unread
  return thread.unread
}

function threadTitle(thread: UiThread): string {
  return activityThreadTitle(thread)
}

function formatRelative(value: string): string {
  const formatted = formatCompactRelativeTime(value, relativeTimeNow.value)
  return formatted === 'n/a' ? 'recently' : formatted
}

function compactCount(value: number): string {
  return value > 99 ? '99+' : value.toString()
}

function onModeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value !== 'off' && value !== 'unfocused' && value !== 'always') return
  void setTurnNotificationMode(value as TurnNotificationMode)
}
</script>

<style scoped>
@reference "tailwindcss";

.notification-trigger {
  @apply relative inline-flex h-8 min-w-8 items-center justify-center rounded-full border px-1.5 transition;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-secondary);
}

.notification-trigger[data-has-activity='true'] {
  @apply gap-1.5;
}

.notification-trigger:hover {
  border-color: var(--border-strong);
  background: var(--surface-muted);
  color: var(--text-primary);
}

.notification-trigger-icon {
  @apply h-4.5 w-4.5;
}

.notification-trigger-statuses {
  @apply inline-flex items-center gap-1;
}

.notification-trigger-count {
  @apply inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-bold tabular-nums leading-none;
  color: #ffffff;
}

.notification-trigger-count svg {
  @apply h-2.5 w-2.5 shrink-0;
}

.notification-trigger-count.is-running {
  background: #3b82f6;
}

.notification-trigger-count.is-running svg {
  animation: notification-spin 900ms linear infinite;
}

.notification-trigger-count.is-unread {
  background: #22c55e;
  color: #052e16;
}

.notification-trigger-count.is-unread svg {
  @apply h-2 w-2;
  fill: currentColor;
}

:global(.notification-popover) {
  width: min(30rem, calc(100vw - 1rem));
  max-height: min(42rem, calc(100dvh - 5rem));
  gap: 0;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.notification-header {
  @apply flex items-start justify-between gap-3 px-4 pb-3 pt-4;
}

.notification-mark-all {
  @apply inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.notification-mark-all:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.notification-mark-all:disabled {
  cursor: wait;
  opacity: 0.65;
}

.notification-mark-all-icon {
  @apply h-3.5 w-3.5 shrink-0;
}

.notification-mark-all-short {
  @apply hidden;
}

.notification-header > div:first-child {
  @apply min-w-0 flex-1;
}

/* Only the phone sheet needs a close button; elsewhere a click outside or Escape closes it. */
.notification-close {
  @apply -mr-2 -mt-1.5 hidden h-11 w-11 shrink-0 items-center justify-center rounded-full transition;
  color: var(--text-muted);
}

.notification-close:hover {
  background: var(--surface-muted);
  color: var(--text-primary);
}

.notification-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.notification-close svg {
  @apply h-5 w-5;
}

.notification-voice {
  @apply mx-4 mb-2;
}

.notification-voice-mic {
  @apply -mt-1;
}

/* The summary wraps between its parts, never inside one. */
.notification-subtitle-part {
  white-space: nowrap;
}

.notification-mic-status {
  @apply mx-4 mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium leading-5;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.notification-mic-status.is-recording {
  border-color: color-mix(in srgb, #e5484d 45%, transparent);
  background: color-mix(in srgb, #e5484d 10%, var(--surface-elevated));
  color: var(--text-primary);
}

.notification-mic-status.is-error {
  border-color: color-mix(in srgb, #e5484d 45%, transparent);
  color: var(--text-primary);
}

.notification-mic-status-text {
  @apply min-w-0 flex-1;
  overflow-wrap: anywhere;
}

.notification-mic-status-icon {
  @apply h-3.5 w-3.5 shrink-0;
}

.notification-mic-status.is-error .notification-mic-status-icon {
  color: #e5484d;
}

.notification-mic-status-dot {
  @apply h-2 w-2 shrink-0 rounded-full;
  background: #e5484d;
  animation: notification-mic-blink 1200ms ease-in-out infinite;
}

.notification-mic-status-retry {
  @apply -my-1 inline-flex min-h-8 shrink-0 items-center rounded-md px-2 text-xs font-semibold;
  color: var(--accent);
}

.notification-mic-status-retry:hover {
  background: var(--surface-elevated);
}

@keyframes notification-mic-blink {
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .notification-mic-status-dot {
    animation: none;
  }
}

.notification-title {
  @apply text-sm font-semibold;
  color: var(--text-primary);
}

.notification-subtitle {
  @apply mt-0.5 text-xs;
  color: var(--text-muted);
}

.notification-tabs {
  @apply mx-4 mb-2 grid grid-cols-2 rounded-lg p-1;
  background: var(--surface-muted);
}

.notification-tab {
  @apply inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition;
  color: var(--text-muted);
}

.notification-tab:hover {
  color: var(--text-primary);
}

.notification-tab.is-active {
  background: var(--surface-elevated);
  color: var(--text-primary);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text-primary) 12%, transparent);
}

.notification-activity-toolbar {
  @apply mx-4 mb-2;
}

.notification-filter {
  @apply grid grid-cols-2 rounded-lg p-1;
  background: var(--surface-muted);
}

.notification-filter-button {
  @apply inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition;
  color: var(--text-muted);
}

.notification-filter-button:hover {
  color: var(--text-primary);
}

.notification-filter-button.is-active {
  background: var(--surface-elevated);
  color: var(--text-primary);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text-primary) 12%, transparent);
}

.notification-filter-count {
  @apply inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] tabular-nums;
  background: color-mix(in srgb, #22c55e 14%, transparent);
  color: #16a34a;
}

.notification-tab-icon {
  @apply h-3.5 w-3.5;
}

.notification-activity,
.notification-settings {
  max-height: min(34rem, calc(100dvh - 13rem));
  overflow-y: auto;
  overscroll-behavior: contain;
}

.notification-sections {
  @apply pb-2;
}

.notification-section {
  @apply border-t py-2;
  border-color: var(--border-soft);
}

/* The section a deep link opened the panel on. Drawn over the rows, which paint their own backgrounds. */
.notification-section.is-landing-focus {
  position: relative;
}

.notification-section.is-landing-focus::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: none;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 3px 0 0 var(--accent);
  animation: notification-landing-focus 2400ms ease-out forwards;
}

@keyframes notification-landing-focus {
  0%,
  45% {
    opacity: 1;
  }

  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .notification-section.is-landing-focus::after {
    animation: none;
  }
}

.notification-section-header {
  @apply flex items-center gap-1.5 px-4 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide;
  color: var(--text-muted);
}

.notification-section-count {
  @apply inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px];
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.notification-section-icon {
  @apply h-3.5 w-3.5;
}

.notification-board-work-row {
  @apply flex min-w-0 items-center pr-3;
}

.notification-row.notification-board-main {
  @apply min-w-0 flex-1 pr-2;
}

.notification-board-status {
  @apply font-medium;
  color: var(--text-secondary);
}

.notification-board-status[data-status='running'] {
  color: var(--accent-blue);
}

.notification-board-name {
  @apply mt-1 block truncate text-[11px];
  color: var(--text-muted);
}

.notification-board-label {
  @apply inline-flex min-w-0 items-center gap-1 truncate;
}

.notification-board-label svg {
  @apply h-3 w-3 shrink-0;
}

.notification-board-open {
  @apply inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium transition;
  color: var(--text-secondary);
}

.notification-board-open svg {
  @apply h-3.5 w-3.5;
}

.notification-board-open:hover {
  background: var(--surface-muted);
  color: var(--text-primary);
}

.notification-board-open:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.notification-recent-row {
  @apply relative overflow-hidden;
  background: color-mix(in srgb, var(--destructive) 12%, var(--surface-muted));
}

.notification-row.notification-recent-main {
  @apply relative z-10 pr-12;
  background: var(--surface-elevated);
  touch-action: pan-y;
  transition: transform 160ms ease, background-color 180ms ease;
}

.notification-row.notification-recent-main:hover {
  background: var(--surface-muted);
}

.notification-more-button {
  @apply absolute right-2 top-2 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full transition;
  color: var(--text-muted);
}

.notification-more-button:hover,
.notification-more-button[aria-expanded='true'] {
  background: var(--surface-muted);
  color: var(--text-primary);
}

.notification-more-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.notification-more-button svg {
  @apply h-4 w-4;
}

.notification-row-actions {
  @apply relative z-20 flex items-center gap-1 border-t px-3 py-2;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
}

.notification-row-actions button {
  @apply inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition;
  color: var(--text-secondary);
}

.notification-row-actions button:hover {
  background: var(--surface-muted);
  color: var(--text-primary);
}

.notification-row-actions button.is-destructive {
  color: var(--destructive);
}

.notification-row-actions button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.notification-row-actions svg {
  @apply h-3.5 w-3.5;
}

.notification-show-more {
  @apply mx-4 mt-1 flex min-h-8 items-center rounded-md px-2 text-xs font-medium transition;
  color: var(--text-secondary);
}

.notification-show-more:hover {
  background: var(--surface-muted);
  color: var(--text-primary);
}

.notification-shortcut {
  @apply hidden h-4 min-w-6 shrink-0 items-center justify-center rounded border px-1 text-[9px] font-medium leading-none;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-muted);
  font-family: inherit;
}

@media (min-width: 641px) {
  .notification-shortcut {
    @apply inline-flex;
  }
}

.notification-empty {
  @apply flex min-h-44 flex-col items-center justify-center px-6 py-8 text-center text-xs leading-5;
  color: var(--text-muted);
}

.notification-empty-icon {
  @apply mb-2 h-6 w-6;
  color: #22c55e;
}

.notification-empty-title {
  @apply text-sm font-medium;
  color: var(--text-primary);
}

.notification-settings {
  @apply border-t;
  border-color: var(--border-soft);
}

.notification-setting-group {
  @apply px-4 py-4;
}

.notification-setting-group + .notification-setting-group {
  @apply border-t;
  border-color: var(--border-soft);
}

.notification-setting-title {
  @apply text-sm font-semibold;
  color: var(--text-primary);
}

.notification-setting-status {
  @apply mt-0.5 text-xs;
  color: var(--text-muted);
}

.notification-setting-status[data-status='enabled'] {
  color: #22c55e;
}

.notification-setting-status[data-status='attention'] {
  color: #f97316;
}

.notification-setting-description {
  @apply mt-2 text-xs leading-4;
  color: var(--text-secondary);
}

.notification-install-steps {
  @apply mt-3 list-decimal space-y-1 pl-5 text-xs leading-5;
  color: var(--text-secondary);
}

.notification-mode-field {
  @apply mt-4 flex items-center justify-between gap-3 border-t pt-4;
  border-color: var(--border-soft);
}

.notification-mode-label {
  @apply text-sm font-medium;
  color: var(--text-primary);
}

.notification-mode-select {
  @apply min-h-9 max-w-48 rounded-lg border px-2.5 text-sm outline-none;
  border-color: var(--border-strong);
  background: var(--surface-muted);
  color: var(--text-primary);
}

.notification-mode-select:focus {
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.notification-settings-actions {
  @apply mt-4 flex flex-wrap gap-2;
}

.notification-primary-action,
.notification-secondary-action {
  @apply inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60;
}

.notification-primary-action {
  background: var(--surface-inverse);
  color: var(--primary-foreground);
}

.notification-secondary-action {
  border: 1px solid var(--border-strong);
  background: var(--surface-muted);
  color: var(--text-primary);
}

.notification-primary-action:hover:not(:disabled),
.notification-secondary-action:hover:not(:disabled) {
  filter: brightness(0.96);
}

.notification-action-icon {
  @apply h-4 w-4;
}

.notification-toggle-row {
  @apply flex items-start justify-between gap-4;
}

.notification-toggle-row .notification-setting-description {
  @apply mt-1;
}

.notification-switch {
  @apply relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50;
  border-color: var(--border-strong);
  background: var(--surface-muted);
}

.notification-switch[data-enabled='true'] {
  border-color: #22c55e;
  background: #22c55e;
}

.voice-setting-switch {
  @apply -my-2.5 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-lg disabled:cursor-not-allowed disabled:opacity-50;
}

.voice-setting-switch .notification-switch {
  @apply mt-0 block;
}

.voice-setting-switch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.voice-setting-select {
  @apply min-h-11;
}

.notification-switch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.notification-switch-thumb {
  @apply absolute left-0.5 top-0.5 h-4.5 w-4.5 rounded-full transition;
  background: var(--surface-elevated);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text-primary) 22%, transparent);
}

.notification-switch[data-enabled='true'] .notification-switch-thumb {
  transform: translateX(1.25rem);
}

.notification-note,
.notification-error,
.notification-success {
  @apply mt-3 text-xs leading-4;
}

.notification-note {
  color: var(--text-muted);
}

.notification-error {
  @apply px-4 pb-3;
  color: var(--destructive);
}

.notification-setting-group .notification-error {
  @apply px-0 pb-0;
}

.notification-success {
  color: #15803d;
}

.notification-success span {
  @apply mt-1 block;
  color: var(--text-muted);
}

:global(html[data-theme='dark']) .notification-success {
  color: #86efac;
}

.is-spinning {
  animation: notification-spin 800ms linear infinite;
}

@keyframes notification-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  :global(.notification-popover) {
    width: min(32rem, calc(100vw - 0.25rem));
    max-height: calc(100dvh - 4.5rem);
  }

  /* Opened from a link, the panel is the page: a full-height sheet down to the home indicator. */
  :global(.notification-popover.is-landing) {
    height: var(--reka-popover-content-available-height, calc(100dvh - 4.5rem));
    max-height: var(--reka-popover-content-available-height, calc(100dvh - 4.5rem));
  }

  :global(.notification-popover.is-landing) .notification-activity,
  :global(.notification-popover.is-landing) .notification-settings {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    padding-bottom: env(safe-area-inset-bottom);
  }

  .notification-close {
    @apply inline-flex;
  }

  .notification-voice-mic {
    @apply -mt-1.5 -mr-1;
  }

  .notification-header {
    @apply gap-2;
  }

  .notification-mic-status-retry {
    @apply min-h-11;
  }

  .notification-mark-all-label {
    @apply hidden;
  }

  .notification-mark-all-short {
    @apply inline;
  }

  .notification-mark-all,
  .notification-tab,
  .notification-filter-button,
  .notification-show-more {
    @apply min-h-11;
  }

  .notification-activity,
  .notification-settings {
    max-height: calc(100dvh - 12rem);
  }

  .notification-row.notification-recent-main {
    @apply pr-12;
  }

  .notification-row.notification-board-main {
    @apply pr-3;
  }

  .notification-section {
    @apply py-1.5;
  }

  .notification-more-button {
    @apply right-1 top-0.5 h-11 w-11;
  }

  .notification-row-actions {
    @apply gap-2 px-3.5 py-2.5;
  }

  .notification-row-actions button {
    @apply min-h-9 flex-1 justify-center;
  }

  .notification-mode-field {
    @apply items-start;
  }

  .notification-mode-select {
    max-width: 11rem;
  }

  .notification-primary-action,
  .notification-secondary-action {
    @apply w-full;
  }
}
</style>
