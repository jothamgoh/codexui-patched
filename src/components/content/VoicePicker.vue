<template>
  <section class="voice-picker" aria-label="Voice result">
    <div class="voice-picker-card">
      <header class="voice-picker-header">
        <h1 class="voice-picker-title">{{ title }}</h1>
        <p class="voice-picker-subtitle">{{ subtitle }}</p>
      </header>

      <p v-if="isLoading" class="voice-picker-status" role="status">Loading…</p>
      <div v-else-if="loadError" class="voice-picker-error" role="alert">
        <p>{{ loadError }}</p>
        <button class="voice-picker-link" type="button" @click="emit('openHome')">Go to chats</button>
      </div>

      <template v-else-if="result">
        <VoiceNote class="voice-picker-note" :heard="result.heard" @navigate="emit('navigate', $event)" />
        <div v-if="result.message" class="voice-picker-message">
          <p><span>Message:</span> “{{ result.message }}”</p>
          <p class="voice-picker-hint">Tapping a chat opens it with the message typed in. Nothing is sent until you tap Send.</p>
        </div>

        <section v-if="steps.length > 0" class="voice-picker-section" aria-label="Steps">
          <div class="voice-picker-section-header">
            <span>Steps</span>
            <span class="voice-picker-section-count">{{ steps.length }}</span>
          </div>
          <NotificationRow
            v-for="(step, index) in steps"
            :key="step.code"
            tone="pinned"
            :title="step.title"
            v-bind="stepPill(step, index)"
            :preview="step.detail"
            wrap-meta
            :class="{ 'is-done': step.done }"
            :aria-label="`Step ${index + 1}: ${step.title}`"
            @click="openStep(step)"
          >
            <template #icon>
              <Send v-if="step.kind === 'send'" />
              <SquarePen v-else-if="step.kind === 'new'" />
              <ListFilter v-else-if="step.kind === 'list'" />
              <CircleHelp v-else-if="step.kind === 'unknown'" />
              <MessageSquare v-else />
            </template>
            <template #meta>
              <span>Step {{ index + 1 }}</span>
              <template v-for="part in step.meta" :key="part">
                <span aria-hidden="true">·</span>
                <span>{{ part }}</span>
              </template>
            </template>
          </NotificationRow>
        </section>

        <section v-else class="voice-picker-section" :aria-label="listHeading">
          <div class="voice-picker-section-header">
            <span>{{ listHeading }}</span>
            <span class="voice-picker-section-count">{{ rows.length }}</span>
          </div>
          <NotificationRow
            v-for="(row, index) in rows"
            :key="row.threadId"
            :tone="ROW_TONES[row.status]"
            :title="row.title"
            v-bind="rowPill(row, index)"
            :preview="row.summary"
            wrap-meta
            :aria-label="`Open ${row.title}`"
            @click="select(row.threadId)"
          >
            <template #meta>
              <span>{{ row.projectName }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ row.agent === 'claude' ? 'Claude' : 'Codex' }}</span>
              <template v-for="part in statusParts(row)" :key="part">
                <span aria-hidden="true">·</span>
                <span>{{ part }}</span>
              </template>
            </template>
          </NotificationRow>
          <p v-if="rows.length === 0" class="voice-picker-empty">No chats to show.</p>
        </section>

        <p v-if="steps.length > 0" class="voice-picker-footnote">Each step opens its page. Come back here for the next one.</p>
        <button v-if="canShowRecent" class="voice-picker-link" type="button" @click="showRecent = true">Not these? Recent chats</button>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CircleHelp, ListFilter, MessageSquare, Send, SquarePen } from '@lucide/vue'
import { getVoiceResult, VoiceResultExpiredError } from '../../api/voice'
import { useRelativeTimeClock } from '../../composables/useRelativeTimeClock'
import { describeVoiceStep, VOICE_LIST_TYPES, type VoiceChatRow, type VoiceListType, type VoiceStepLink, type VoiceStoredResult } from '../../types/voice'
import { formatCompactRelativeTime } from '../../utils/relativeTime'
import { voiceActivityFocus, type ActivityFocus } from '../../utils/voiceLanding'
import NotificationRow from './NotificationRow.vue'
import VoiceNote from './VoiceNote.vue'

/**
 * The voice choosers: which chat to open on a close call, which chat gets a
 * spoken message, what to open when nothing matched, or the steps of a command
 * that asked for several things. Lists and "didn't catch that" go to the
 * notification panel instead; this page uses its rows.
 */

const RECENT_ROWS = 10

/** The panel's icon for each kind of chat. */
const ROW_TONES: Record<VoiceListType, 'failed' | 'running' | 'unread' | 'completed'> = {
  needs_you: 'failed',
  running: 'running',
  unread: 'unread',
  recent: 'completed',
}

const props = defineProps<{ code: string }>()
const emit = defineEmits<{
  (event: 'select', payload: { threadId: string; code: string; carryMessage: boolean }): void
  (event: 'newChat', code: string): void
  /** Lists and "didn't catch that" belong on the notification panel. */
  (event: 'openActivity', payload: { focus: ActivityFocus; code: string }): void
  (event: 'navigate', path: string): void
  (event: 'openHome'): void
}>()

const now = useRelativeTimeClock()
const result = ref<VoiceStoredResult | null>(null)
const isLoading = ref(false)
const loadError = ref('')
const showRecent = ref(false)

async function load(code: string): Promise<void> {
  isLoading.value = true
  loadError.value = ''
  showRecent.value = false
  try {
    const loaded = await getVoiceResult(code)
    if (code !== props.code) return
    if (loaded.outcome === 'new_chat') {
      emit('newChat', code)
      return
    }
    const focus = voiceActivityFocus(loaded)
    if (focus) {
      emit('openActivity', { focus, code })
      return
    }
    result.value = loaded
  } catch (error) {
    if (code !== props.code) return
    result.value = null
    loadError.value = error instanceof VoiceResultExpiredError
      ? 'This voice result has expired. Say it again.'
      : error instanceof Error ? error.message : 'Could not load this voice result.'
  } finally {
    if (code === props.code) isLoading.value = false
  }
}

watch(() => props.code, (code) => { void load(code) }, { immediate: true })

const panelRows = computed<VoiceChatRow[]>(() => result.value ? VOICE_LIST_TYPES.flatMap((type) => result.value!.sections[type]).slice(0, RECENT_ROWS) : [])
const isNoMatch = computed(() => result.value?.reason === 'no_match')
const isCloseCall = computed(() => !showRecent.value && result.value?.outcome === 'picker' && !isNoMatch.value)

const rows = computed<VoiceChatRow[]>(() => {
  const value = result.value
  if (!value) return []
  if (showRecent.value) return panelRows.value
  if (isNoMatch.value) return value.candidates.length > 0 ? value.candidates : panelRows.value
  return value.candidates
})

type StepRow = { code: string; url: string; title: string; detail: string; meta: string[]; kind: 'open' | 'send' | 'new' | 'list' | 'unknown'; done: boolean }

/** Steps already tapped, per result, for this browser session: they show as done when the user comes back. */
const doneSteps = ref<Set<string>>(new Set())
const doneKey = (code: string) => `codexui.voice-steps.${code}`
watch(() => props.code, (code) => {
  try { doneSteps.value = new Set(JSON.parse(sessionStorage.getItem(doneKey(code)) ?? '[]') as string[]) } catch { doneSteps.value = new Set() }
}, { immediate: true })

function stepKind(step: VoiceStepLink): StepRow['kind'] {
  if (step.action === 'list_chats') return 'list'
  if (step.outcome === 'new_chat') return 'new'
  if (step.outcome === 'not_understood') return 'unknown'
  return step.action === 'send_to_chat' ? 'send' : 'open'
}

function stepMeta(step: VoiceStepLink): string[] {
  const chat = step.candidates[0]
  if (step.action === 'list_chats') return [step.outcome === 'empty' ? 'None right now' : `${step.candidates.length} ${step.candidates.length === 1 ? 'chat' : 'chats'}`]
  if (step.outcome === 'new_chat') return [step.agent === 'claude' ? 'Claude' : step.agent === 'codex' ? 'Codex' : '', step.project ? '' : 'Pick a project'].filter(Boolean)
  if (step.outcome === 'picker') return [`${step.candidates.length} possible chats`]
  if (chat && (step.outcome === 'open_chat' || step.outcome === 'send_ready')) return [chat.projectName, chat.agent === 'claude' ? 'Claude' : 'Codex']
  return []
}

const steps = computed<StepRow[]>(() => (result.value?.outcome === 'steps' ? result.value.steps ?? [] : []).map((step) => ({
  code: step.code,
  url: step.url,
  ...describeVoiceStep(step),
  meta: stepMeta(step),
  kind: stepKind(step),
  done: doneSteps.value.has(step.code),
})))

function stepPill(step: StepRow, index: number): { pill: string; pillTone: 'unread' | 'attention' | 'accent' } {
  if (step.done) return { pill: 'Done', pillTone: 'unread' }
  const next = steps.value.findIndex((entry) => !entry.done)
  return index === next ? { pill: 'Next', pillTone: 'accent' } : { pill: '', pillTone: 'unread' }
}

function openStep(step: StepRow): void {
  const done = new Set(doneSteps.value).add(step.code)
  doneSteps.value = done
  try { sessionStorage.setItem(doneKey(props.code), JSON.stringify([...done])) } catch { /* private mode: done marks just do not persist */ }
  emit('navigate', step.url)
}

const title = computed(() => {
  const value = result.value
  if (!value) return 'Voice'
  if (value.outcome === 'steps') return `You asked for ${steps.value.length} things`
  if (value.message) return 'Send to which chat?'
  return 'Which chat?'
})

const subtitle = computed(() => {
  if (!result.value) return 'Voice command'
  if (result.value.outcome === 'steps') return 'Tap each step to do it. Nothing is sent until you tap Send.'
  if (isNoMatch.value) return 'No chat matched what you said'
  return result.value.message ? 'Pick the chat for this message' : 'A few chats matched what you said'
})

const listHeading = computed(() => {
  if (showRecent.value || isNoMatch.value) return 'Recent chats'
  return 'Possible chats'
})

const canShowRecent = computed(() => Boolean(result.value) && result.value?.outcome !== 'steps' && !showRecent.value && !isNoMatch.value)

function rowPill(row: VoiceChatRow, index: number): { pill: string; pillTone: 'unread' | 'attention' | 'accent' } {
  if (index === 0 && isCloseCall.value) return { pill: 'Best match', pillTone: 'accent' }
  if (row.status === 'needs_you') return { pill: 'Needs you', pillTone: 'attention' }
  if (row.status === 'unread') return { pill: 'Unread', pillTone: 'unread' }
  return { pill: '', pillTone: 'unread' }
}

/** The panel's wording: what the chat is doing, then how long ago. */
function statusParts(row: VoiceChatRow): string[] {
  const age = formatCompactRelativeTime(row.updatedAtIso, now.value)
  const state = row.status === 'running' ? 'In progress' : row.status === 'needs_you' ? 'Waiting for you' : ''
  return [state, age === 'n/a' ? '' : age].filter(Boolean)
}

function select(threadId: string): void {
  if (!result.value) return
  emit('select', { threadId, code: result.value.code, carryMessage: Boolean(result.value.message) })
}
</script>

<style scoped>
@reference "tailwindcss";

.voice-picker {
  @apply mx-auto w-full overflow-y-auto p-4;
  max-width: 32rem;
  color: var(--text-primary);
}

.voice-picker-card {
  @apply overflow-hidden rounded-lg border pb-2;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
}

.voice-picker-header {
  @apply px-4 pb-3 pt-4;
}

.voice-picker-title {
  @apply text-sm font-semibold;
  color: var(--text-primary);
}

.voice-picker-subtitle {
  @apply mt-0.5 text-xs;
  color: var(--text-muted);
}

.voice-picker-note,
.voice-picker-message {
  @apply mx-4 mb-2;
}

.voice-picker-message {
  @apply rounded-lg border px-3 py-2.5 text-xs leading-5;
  border-color: var(--accent-soft);
  background: var(--accent-soft);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.voice-picker-message span {
  color: var(--text-muted);
}

.voice-picker-hint {
  @apply mt-1;
  color: var(--text-muted);
}

.voice-picker-section {
  @apply border-t py-2;
  border-color: var(--border-soft);
}

.voice-picker-section-header {
  @apply flex items-center gap-1.5 px-4 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide;
  color: var(--text-muted);
}

.voice-picker-section-count {
  @apply inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px];
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.voice-picker-section :deep(.notification-row.is-done) {
  opacity: 0.6;
}

.voice-picker-footnote {
  @apply px-4 pb-1 pt-1 text-xs;
  color: var(--text-muted);
}

.voice-picker-status,
.voice-picker-empty {
  @apply px-4 py-2 text-xs;
  color: var(--text-muted);
}

.voice-picker-error {
  @apply px-4 pb-2 text-sm;
  color: var(--text-secondary);
}

.voice-picker-link {
  @apply mx-2 flex min-h-11 items-center rounded-md px-2 text-xs font-medium transition;
  color: var(--accent);
}

.voice-picker-link:hover {
  background: var(--surface-muted);
}

.voice-picker-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

@media (max-width: 640px) {
  .voice-picker {
    @apply px-0.5 py-2;
  }
}
</style>
