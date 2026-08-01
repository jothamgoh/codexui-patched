<template>
  <Popover v-model:open="isOpen">
    <PopoverTrigger as-child>
      <button
        class="notification-trigger"
        :data-has-activity="runningThreads.length > 0 || unreadAttentionCount > 0"
        type="button"
        :aria-label="triggerLabel"
        :title="`${triggerLabel} (⌘J)`"
      >
        <Bell class="notification-trigger-icon" />
        <span v-if="runningThreads.length > 0 || unreadAttentionCount > 0" class="notification-trigger-statuses" aria-hidden="true">
          <span v-if="runningThreads.length > 0" class="notification-trigger-count is-running">
            <LoaderCircle />
            {{ compactCount(runningThreads.length) }}
          </span>
          <span v-if="unreadAttentionCount > 0" class="notification-trigger-count is-unread">
            <Circle />
            {{ compactCount(unreadAttentionCount) }}
          </span>
        </span>
      </button>
    </PopoverTrigger>

    <PopoverContent
      align="end"
      :side-offset="8"
      class="notification-popover"
      @open-auto-focus.prevent
    >
      <header class="notification-header">
        <div>
          <p class="notification-title">Notifications</p>
          <p class="notification-subtitle">{{ activitySummary }}</p>
        </div>
      </header>

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

      <div v-if="activeView === 'activity'" class="notification-activity" role="tabpanel">
        <div v-if="hasActivity" class="notification-sections">
          <section v-if="runningThreads.length > 0" class="notification-section">
            <div class="notification-section-header">
              <span>Running</span>
              <span class="notification-section-count">{{ runningThreads.length }}</span>
            </div>
            <button
              v-for="thread in runningThreads"
              :key="`running:${thread.id}`"
              class="notification-row"
              type="button"
              @click="openThread(thread.id)"
            >
              <span class="notification-row-icon is-running">
                <LoaderCircle />
              </span>
              <span class="notification-row-copy">
                <span class="notification-row-title">{{ threadTitle(thread) }}</span>
                <span class="notification-row-meta">
                  <span>In progress</span>
                  <span aria-hidden="true">·</span>
                  <span>{{ formatRelative(thread.updatedAtIso) }}</span>
                  <kbd v-if="shortcutNumber(thread.id)" class="notification-shortcut">
                    ⌘{{ shortcutNumber(thread.id) }}
                  </kbd>
                </span>
              </span>
            </button>
          </section>

          <section v-if="unreadThreads.length > 0" class="notification-section">
            <div class="notification-section-header">
              <span>Unread</span>
              <span class="notification-section-count">{{ unreadThreads.length }}</span>
            </div>
            <button
              v-for="thread in unreadThreads"
              :key="`unread:${thread.id}`"
              class="notification-row"
              type="button"
              @click="openThread(thread.id)"
            >
              <span class="notification-row-icon is-unread">
                <Circle />
              </span>
              <span class="notification-row-copy">
                <span class="notification-row-title-line">
                  <span class="notification-row-title">{{ threadTitle(thread) }}</span>
                  <span class="notification-unread-pill">Unread</span>
                </span>
                <span class="notification-row-meta">
                  <span>Completed — not opened</span>
                  <span aria-hidden="true">·</span>
                  <span>{{ formatRelative(thread.updatedAtIso) }}</span>
                  <kbd v-if="shortcutNumber(thread.id)" class="notification-shortcut">
                    ⌘{{ shortcutNumber(thread.id) }}
                  </kbd>
                </span>
              </span>
            </button>
          </section>

          <section v-if="recentHistory.length > 0" class="notification-section">
            <div class="notification-section-header">
              <span>Recently completed</span>
            </div>
            <div
              v-for="item in recentHistory"
              :key="item.id"
              class="notification-recent-row"
            >
              <button
                class="notification-row notification-recent-main"
                type="button"
                :style="recentRowStyle(item)"
                @click="openRecentItem(item)"
                @touchstart="onRecentTouchStart(item, $event)"
                @touchmove="onRecentTouchMove(item, $event)"
                @touchend="onRecentTouchEnd(item)"
                @touchcancel="resetRecentSwipe"
              >
                <span
                  class="notification-row-icon"
                  :class="item.status === 'failed' ? 'is-failed' : 'is-completed'"
                >
                  <CircleAlert v-if="item.status === 'failed'" />
                  <CheckCircle2 v-else />
                </span>
                <span class="notification-row-copy">
                  <span class="notification-row-title-line">
                    <span class="notification-row-title">{{ item.title }}</span>
                    <span v-if="item.isUnread" class="notification-unread-pill">Unread</span>
                  </span>
                  <span class="notification-row-meta">
                    <span>{{ item.status === 'failed' ? 'Failed' : 'Completed' }}</span>
                    <span aria-hidden="true">·</span>
                    <span>{{ formatRelative(item.completedAt) }}</span>
                    <kbd v-if="shortcutNumber(item.threadId)" class="notification-shortcut">
                      ⌘{{ shortcutNumber(item.threadId) }}
                    </kbd>
                  </span>
                  <span v-if="item.body" class="notification-row-preview">{{ item.body }}</span>
                </span>
              </button>
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
              v-if="canToggleRecentLimit"
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
          <p class="notification-empty-title">You're all caught up</p>
          <p>Running and recently completed chats will appear here.</p>
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
            <li>Open CodexUI from its new Home Screen icon.</li>
          </ol>

          <template v-else-if="status !== 'unsupported'">
            <label class="notification-mode-field">
              <span class="notification-mode-label">Turn completion</span>
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

          <p v-if="status === 'blocked'" class="notification-note">
            Allow CodexUI notifications in your browser and macOS settings, then reopen this panel.
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
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Bell,
  BellRing,
  CheckCircle2,
  Circle,
  CircleAlert,
  LoaderCircle,
  Mail,
  MailOpen,
  MoreHorizontal,
  Settings2,
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
import { updateSharedThreadReadState } from '../../api/codexGateway'
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
import type { UiThread } from '../../types/codex'
import { compactNotificationText } from '../../utils/notificationText'
import { formatCompactRelativeTime } from '../../utils/relativeTime'

type RecentActivityItem = {
  id: string
  threadId: string
  status: string
  title: string
  body: string
  completedAt: string
  isUnread: boolean
}

type ManualThreadUnreadOverride = {
  unread: boolean
  activityAt: string
}

const DEFAULT_RECENT_LIMIT = 6
const MAX_RECENT_ITEMS = 30
const relativeTimeNow = useRelativeTimeClock()

const props = defineProps<{
  threads: UiThread[]
  activeThreadId: string
}>()

const emit = defineEmits<{
  (event: 'selectThread', threadId: string): void
}>()

const isOpen = ref(false)
const activeView = ref<'activity' | 'settings'>('activity')
const history = ref<WebPushHistoryItem[]>([])
const dismissedActivityByThreadId = ref<Record<string, string>>({})
const recentLimit = ref(DEFAULT_RECENT_LIMIT)
const swipingRecentItemId = ref('')
const swipeOffsetX = ref(0)
const expandedActionItemId = ref('')
const manualUnreadByThreadId = ref<Record<string, ManualThreadUnreadOverride>>({})
const historyBusy = ref(false)
const historyError = ref('')
const telegramConfig = ref<TelegramNotificationConfig | null>(null)
const telegramBusy = ref(false)
const telegramError = ref('')
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let swipeStartX = 0
let swipeStartY = 0
let suppressRecentClickUntil = 0
let recentLongPressTimer: ReturnType<typeof setTimeout> | null = null
let recentLongPressTriggered = false

const {
  status,
  mode,
  isBusy,
  errorMessage,
  testMessage,
  isEnabled,
  initializeWebPushNotifications,
  enableWebPushNotifications,
  setTurnNotificationMode,
  testWebPushNotification,
} = useWebPushNotifications()

const runningThreads = computed(() => props.threads.filter((thread) => thread.inProgress))
const unreadThreads = computed(() =>
  props.threads.filter((thread) => isThreadUnread(thread) && !thread.inProgress),
)
const currentActivityThreadIds = computed(() =>
  new Set([
    ...runningThreads.value.map((thread) => thread.id),
    ...unreadThreads.value.map((thread) => thread.id),
  ]),
)
const allRecentHistory = computed<RecentActivityItem[]>(() => {
  const candidates: RecentActivityItem[] = []
  for (const item of history.value) {
    if (currentActivityThreadIds.value.has(item.threadId)) continue
    const thread = props.threads.find((candidate) => candidate.id === item.threadId)
    candidates.push({
      id: item.id,
      threadId: item.threadId,
      status: item.status,
      title: thread ? threadTitle(thread) : (normalizeLabel(item.title) || `Chat ${item.threadId.slice(0, 8)}`),
      body: compactNotificationText(item.body, '', 220),
      completedAt: item.completedAt,
      isUnread: item.readAt === null || Boolean(thread && isThreadUnread(thread)),
    })
  }
  for (const thread of props.threads) {
    if (currentActivityThreadIds.value.has(thread.id)) continue
    candidates.push({
      id: `thread:${thread.id}`,
      threadId: thread.id,
      status: 'completed',
      title: threadTitle(thread),
      body: normalizeLabel(thread.preview),
      completedAt: thread.updatedAtIso || thread.createdAtIso,
      isUnread: isThreadUnread(thread),
    })
  }
  candidates.sort((left, right) => {
    const leftTimestamp = Date.parse(left.completedAt)
    const rightTimestamp = Date.parse(right.completedAt)
    return (Number.isFinite(rightTimestamp) ? rightTimestamp : 0) -
      (Number.isFinite(leftTimestamp) ? leftTimestamp : 0)
  })

  const seen = new Set<string>()
  return candidates.filter((item) => {
    if (seen.has(item.threadId)) return false
    seen.add(item.threadId)
    return dismissedActivityByThreadId.value[item.threadId] !== item.completedAt
  }).slice(0, MAX_RECENT_ITEMS)
})
const recentHistory = computed(() => allRecentHistory.value.slice(0, recentLimit.value))
const shortcutThreadIds = computed(() => [
  ...runningThreads.value.map((thread) => thread.id),
  ...unreadThreads.value.map((thread) => thread.id),
  ...recentHistory.value.map((item) => item.threadId),
].slice(0, 9))
const hiddenRecentCount = computed(() =>
  Math.max(0, allRecentHistory.value.length - DEFAULT_RECENT_LIMIT),
)
const canToggleRecentLimit = computed(() =>
  allRecentHistory.value.length > DEFAULT_RECENT_LIMIT,
)
const attentionThreadIds = computed(() => {
  const ids = new Set(currentActivityThreadIds.value)
  for (const item of history.value) {
    if (item.readAt === null) ids.add(item.threadId)
  }
  return ids
})
const unreadAttentionCount = computed(() => [...attentionThreadIds.value]
  .filter((threadId) => !runningThreads.value.some((thread) => thread.id === threadId))
  .length)
const hasActivity = computed(() =>
  runningThreads.value.length > 0 ||
  unreadThreads.value.length > 0 ||
  recentHistory.value.length > 0,
)
const activitySummary = computed(() => {
  const parts: string[] = []
  if (runningThreads.value.length > 0) {
    parts.push(`${runningThreads.value.length.toString()} running`)
  }
  if (unreadAttentionCount.value > 0) parts.push(`${unreadAttentionCount.value.toString()} unread`)
  return parts.length > 0 ? parts.join(' · ') : 'No chats need attention'
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
    return 'CodexUI can alert you when a turn finishes, even while this app is closed.'
  }
  if (status.value === 'needs-install') {
    return 'iPhone only allows Web Push from a Home Screen web app.'
  }
  if (status.value === 'blocked') {
    return 'Notification permission was denied for CodexUI.'
  }
  if (status.value === 'unsupported') {
    return 'This browser or connection does not support secure Web Push.'
  }
  if (status.value === 'error') {
    return 'CodexUI could not finish notification setup.'
  }
  return 'Enable alerts for completed Codex turns on this iPhone or Mac.'
})

const telegramStatusLabel = computed(() => {
  if (telegramBusy.value) return 'Updating…'
  if (!telegramConfig.value) return 'Checking Telegram setup…'
  if (!telegramConfig.value.available) return 'No Telegram bot is configured on this server.'
  return telegramConfig.value.enabled
    ? 'On — turn completions are also sent to Telegram.'
    : 'Off — the bot setup is kept and can be re-enabled here.'
})

const threadActivitySignature = computed(() =>
  props.threads
    .map((thread) => `${thread.id}:${thread.inProgress ? '1' : '0'}:${thread.unread ? '1' : '0'}`)
    .join('|'),
)

watch(isOpen, (open) => {
  if (!open) return
  activeView.value = 'activity'
  recentLimit.value = DEFAULT_RECENT_LIMIT
  resetRecentSwipe()
  expandedActionItemId.value = ''
  void refreshHistory()
  void initializeWebPushNotifications(true)
  void refreshTelegramConfig()
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

onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
  clearRecentLongPress()
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

function openRecentItem(item: RecentActivityItem): void {
  if (Date.now() < suppressRecentClickUntil) return
  openThread(item.threadId)
}

function shortcutNumber(threadId: string): number {
  const index = shortcutThreadIds.value.indexOf(threadId)
  return index >= 0 ? index + 1 : 0
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
  openThread(threadId)
  return true
}

defineExpose({
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
      updateSharedThreadReadState(
        item.threadId,
        unread
          ? { unread: true }
          : { unread: false, readAtIso: activityAt },
      ),
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
    : MAX_RECENT_ITEMS
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
  return normalizeLabel(thread.title) || normalizeLabel(thread.preview) || `Chat ${thread.id.slice(0, 8)}`
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
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

.notification-section-header {
  @apply flex items-center gap-1.5 px-4 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide;
  color: var(--text-muted);
}

.notification-section-count {
  @apply inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px];
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.notification-row {
  @apply flex w-full items-start gap-3 px-4 py-2.5 text-left transition;
  color: var(--text-primary);
}

.notification-row:hover {
  background: var(--surface-muted);
}

.notification-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.notification-recent-row {
  @apply relative overflow-hidden;
  background: color-mix(in srgb, var(--destructive) 12%, var(--surface-muted));
}

.notification-recent-main {
  @apply relative z-10 pr-12;
  background: var(--surface-elevated);
  touch-action: pan-y;
  transition: transform 160ms ease, background-color 180ms ease;
}

.notification-recent-main:hover {
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

.notification-row-icon {
  @apply mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center;
  color: var(--text-muted);
}

.notification-row-icon > :deep(svg),
.notification-row-icon svg {
  @apply h-4 w-4;
}

.notification-row-icon.is-running {
  color: #3b82f6;
}

.notification-row-icon.is-running svg {
  animation: notification-spin 900ms linear infinite;
}

.notification-row-icon.is-unread {
  color: #22c55e;
}

.notification-row-icon.is-unread svg {
  @apply h-2.5 w-2.5;
  fill: currentColor;
}

.notification-row-icon.is-completed {
  color: #22c55e;
}

.notification-row-icon.is-failed {
  color: var(--destructive);
}

.notification-row-copy {
  @apply min-w-0 flex-1;
}

.notification-row-title-line {
  @apply flex min-w-0 items-center gap-2;
}

.notification-row-title {
  @apply min-w-0 flex-1 truncate text-sm font-medium;
  color: var(--text-primary);
}

.notification-unread-pill {
  @apply inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none;
  background: color-mix(in srgb, #22c55e 14%, transparent);
  color: #16a34a;
}

.notification-row-meta {
  @apply mt-0.5 flex items-center gap-1 text-xs;
  color: var(--text-muted);
}

.notification-row-preview {
  @apply mt-1 line-clamp-2 text-xs leading-4;
  color: var(--text-secondary);
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

  .notification-activity,
  .notification-settings {
    max-height: calc(100dvh - 12rem);
  }

  .notification-row {
    @apply min-h-12 gap-2.5 px-3 py-2.5;
  }

  .notification-section {
    @apply py-1.5;
  }

  .notification-more-button {
    @apply right-1.5 h-9 w-9;
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
