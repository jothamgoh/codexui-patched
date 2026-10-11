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
        <VoiceNote class="voice-picker-note" :heard="result.heard" @result="emit('navigate', $event.url)" />
        <div v-if="result.message" class="voice-picker-message">
          <p><span>Message:</span> “{{ result.message }}”</p>
          <p class="voice-picker-hint">{{ messageHint }}</p>
        </div>

        <section v-if="steps.length > 0" class="voice-picker-section" aria-label="Steps">
          <div class="voice-picker-section-header">
            <span>Steps</span>
            <span class="voice-picker-section-count">{{ steps.length }}</span>
            <button v-if="stepsWaiting" class="voice-picker-cancel-all" type="button" @click="void cancelWaiting()">Cancel ({{ seconds }}&nbsp;s)</button>
          </div>
          <div v-for="(step, index) in steps" :key="step.code" class="voice-picker-row">
          <NotificationRow
            tone="pinned"
            :title="step.title"
            v-bind="stepPill(step, index)"
            :preview="step.detail"
            wrap-meta
            :class="{ 'is-done': step.done }"
            :aria-label="`Step ${index + 1}: ${step.title}`"
            @click="void tapStep(step)"
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
          <button v-if="step.oneTap" class="voice-picker-edit" type="button" :aria-label="`Edit step ${index + 1} first`" @click="openStep(step)">Edit first</button>
          </div>
        </section>

        <section v-else class="voice-picker-section" :aria-label="listHeading">
          <div class="voice-picker-section-header">
            <span>{{ listHeading }}</span>
            <span class="voice-picker-section-count">{{ rows.length }}</span>
          </div>
          <div v-for="(row, index) in rows" :key="row.threadId" class="voice-picker-row">
          <NotificationRow
            :tone="ROW_TONES[row.status]"
            :title="row.title"
            v-bind="rowPill(row, index)"
            :preview="row.summary"
            wrap-meta
            :aria-label="sendsOnTap ? `Send to ${row.title}` : `Open ${row.title}`"
            @click="void tapRow(row.threadId)"
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
          <button v-if="sendsOnTap" class="voice-picker-edit" type="button" :aria-label="`Edit first, then send to ${row.title}`" @click="select(row.threadId)">Edit first</button>
          </div>
          <p v-if="rows.length === 0" class="voice-picker-empty">No chats to show.</p>
        </section>

        <p v-if="steps.length > 0" class="voice-picker-footnote">{{ stepsFootnote }}</p>
        <p v-if="actionError" class="voice-picker-error" role="alert">{{ actionError }}</p>
        <div class="voice-picker-none" role="group" aria-label="None of these">
          <span>None of these?</span>
          <VoiceCommandMic size="compact" @result="emit('navigate', $event.url)" />
          <span class="voice-picker-none-say">Say it again</span>
          <button v-if="canShowRecent" class="voice-picker-link" type="button" @click="showRecent = true">Recent chats</button>
        </div>
      </template>
    </div>

    <div v-if="toast" class="voice-picker-toast" :class="`is-${toast.tone}`" role="status" aria-label="Voice send">
      <span class="voice-picker-toast-text">{{ toast.title }}</span>
      <button v-if="toast.action" type="button" class="voice-picker-toast-action" @click="void toast.action.run()">{{ toast.action.label }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CircleHelp, ListFilter, MessageSquare, Send, SquarePen } from '@lucide/vue'
import { getVoiceResult, getVoiceSettings, sendVoiceResult, VoiceResultExpiredError } from '../../api/voice'
import { useVoiceDelivery } from '../../composables/useVoiceDelivery'
import type { VoiceDelivery } from '../../types/voice'
import { deliveryPill, describeDelivery, isDeliveryActive } from '../../utils/voiceDelivery'
import VoiceCommandMic from './VoiceCommandMic.vue'
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
const actionError = ref('')
/** Auto-send on: a tap in a chooser sends (or starts) at once, honouring the undo window. */
const tapSends = ref(false)
void getVoiceSettings().then((answer) => { tapSends.value = answer.settings.autoSend }).catch(() => { tapSends.value = false })
const { seconds, cancel, refresh } = useVoiceDelivery(result)
/** The code whose send the toast follows: this result, or one step. */
const toastCode = ref('')

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

type StepRow = {
  code: string
  url: string
  title: string
  detail: string
  meta: string[]
  kind: 'open' | 'send' | 'new' | 'list' | 'unknown'
  done: boolean
  delivery?: VoiceDelivery
  /** A tap sends it or starts it at once. */
  oneTap: boolean
  link: VoiceStepLink
}

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

/** A send or new chat step that one tap can do: sure of its chat or project, with words, not a draft. */
function stepSendsOnTap(step: VoiceStepLink): boolean {
  if (!tapSends.value || step.draftOnly || !step.message || isDeliveryActive(step.delivery)) return false
  if (step.outcome === 'send_ready') return Boolean(step.candidates[0])
  return step.outcome === 'new_chat' && Boolean(step.project)
}

const steps = computed<StepRow[]>(() => (result.value?.outcome === 'steps' ? result.value.steps ?? [] : []).map((step) => ({
  code: step.code,
  url: step.url,
  ...describeVoiceStep(step),
  meta: stepMeta(step),
  kind: stepKind(step),
  done: doneSteps.value.has(step.code) || step.delivery?.state === 'sent',
  delivery: step.delivery,
  oneTap: stepSendsOnTap(step),
  link: step,
})))

const stepsWaiting = computed(() => steps.value.some((step) => step.delivery?.state === 'pending'))

function stepPill(step: StepRow, index: number): { pill: string; pillTone: 'unread' | 'attention' | 'accent' } {
  if (step.delivery && step.delivery.state !== 'cancelled') return deliveryPill(step.delivery, seconds.value)
  if (step.done) return { pill: 'Done', pillTone: 'unread' }
  const next = steps.value.findIndex((entry) => !entry.done && !(entry.delivery && entry.delivery.state !== 'cancelled'))
  return index === next ? { pill: 'Next', pillTone: 'accent' } : { pill: '', pillTone: 'unread' }
}

const stepsFootnote = computed(() => {
  const done = steps.value.filter((step) => step.delivery?.state === 'sent').length
  if (done === steps.value.length) return 'All done.'
  return done > 0 ? 'Steps marked ✓ already went out. Tap the others to do them.' : 'Tap a step to do it. Come back here for the next one.'
})

/** One tap on a step: send or start it when it is sure, otherwise open its page. */
async function tapStep(step: StepRow): Promise<void> {
  const delivery = step.delivery
  if (delivery?.state === 'sent' && delivery.threadId) {
    emit('navigate', `/#/thread/${encodeURIComponent(delivery.threadId)}`)
    return
  }
  if (delivery?.state === 'pending' || delivery?.state === 'sending') return
  if (!step.oneTap) {
    openStep(step)
    return
  }
  const target = step.link.outcome === 'send_ready'
    ? { threadId: step.link.candidates[0].threadId }
    : { projectId: step.link.project!.id }
  await runTap(step.code, target)
}

async function runTap(code: string, target: { threadId: string } | { projectId: string }): Promise<void> {
  actionError.value = ''
  try {
    const answer = await sendVoiceResult(code, target)
    toastCode.value = code
    if (answer.code === result.value?.code) result.value = answer
    else await refresh()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'Could not send it.'
  }
}

async function cancelWaiting(): Promise<void> {
  if (!result.value) return
  toastCode.value = toastCode.value || result.value.code
  await cancel(result.value.code).catch(() => null)
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

/** A send chooser where one tap sends: auto-send on, words to send, not a draft. */
const sendsOnTap = computed(() => Boolean(tapSends.value && result.value?.message && !result.value.draftOnly && result.value.outcome === 'picker'))

const subtitle = computed(() => {
  if (!result.value) return 'Voice command'
  if (result.value.outcome === 'steps') return 'Sure steps run by themselves. Tap any other step to do it.'
  if (isNoMatch.value) return sendsOnTap.value ? 'No chat matched. Tap one to send it there.' : 'No chat matched what you said'
  if (sendsOnTap.value) return 'Tap a chat to send it there'
  return result.value.message ? 'Pick the chat for this message' : 'A few chats matched what you said'
})

const messageHint = computed(() => (sendsOnTap.value
  ? 'Tapping a chat sends the message. Edit first opens it typed in instead.'
  : 'Tapping a chat opens it with the message typed in. Nothing is sent until you tap Send.'))

/** The toast after a one-tap send: Undo while it waits, View once it has gone. */
const toast = computed(() => {
  const value = result.value
  if (!value || !toastCode.value) return null
  const delivery = toastCode.value === value.code ? value.delivery : value.steps?.find((step) => step.code === toastCode.value)?.delivery
  if (!delivery) return null
  const copy = describeDelivery(delivery, seconds.value)
  const code = toastCode.value
  if (delivery.state === 'pending') return { title: copy.title, tone: copy.tone, action: { label: 'Undo', run: () => cancel(code).catch(() => null) } }
  if (delivery.state === 'sent' && delivery.threadId) {
    const threadId = delivery.threadId
    return { title: copy.title, tone: copy.tone, action: { label: 'View', run: async () => emit('navigate', `/#/thread/${encodeURIComponent(threadId)}`) } }
  }
  return { title: copy.title, tone: copy.tone, action: null }
})

const listHeading = computed(() => {
  if (showRecent.value || isNoMatch.value) return 'Recent chats'
  return 'Possible chats'
})

const canShowRecent = computed(() => Boolean(result.value) && result.value?.outcome !== 'steps' && !showRecent.value && !isNoMatch.value)

function rowPill(row: VoiceChatRow, index: number): { pill: string; pillTone: 'unread' | 'attention' | 'accent' } {
  const delivery = result.value?.delivery
  if (delivery && delivery.kind === 'send' && delivery.threadId === row.threadId && delivery.state !== 'cancelled') return deliveryPill(delivery, seconds.value)
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

/** A chooser row: sends there at once when one tap sends; otherwise opens the chat (with the words typed in). */
async function tapRow(threadId: string): Promise<void> {
  const delivery = result.value?.delivery
  if (sendsOnTap.value && !(delivery && delivery.state !== 'cancelled' && delivery.state !== 'failed')) {
    await runTap(result.value!.code, { threadId })
    return
  }
  if (delivery?.state === 'sent' && delivery.threadId) {
    emit('navigate', `/#/thread/${encodeURIComponent(delivery.threadId)}`)
    return
  }
  if (sendsOnTap.value) return
  select(threadId)
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

.voice-picker-row {
  @apply flex items-stretch;
}

.voice-picker-row > :deep(.notification-row) {
  @apply min-w-0 flex-1;
}

.voice-picker-edit {
  @apply my-1.5 mr-3 flex min-h-11 shrink-0 items-center self-center rounded-md border px-3 text-xs font-medium;
  border-color: var(--border-strong);
  color: var(--text-secondary);
  background: var(--surface-elevated);
}

.voice-picker-cancel-all {
  @apply ml-auto flex min-h-11 items-center rounded-md px-3 text-xs font-semibold normal-case tracking-normal;
  background: var(--accent);
  color: #fff;
}

.voice-picker-none {
  @apply mx-2 mt-1 flex flex-wrap items-center gap-2 border-t px-2 pt-2 text-xs;
  border-color: var(--border-soft);
  color: var(--text-muted);
}

.voice-picker-none .voice-picker-link {
  @apply mx-0 ml-auto;
}

.voice-picker-toast {
  @apply fixed left-1/2 z-50 flex min-h-14 w-[calc(100%-24px)] max-w-md -translate-x-1/2 items-center gap-3 rounded-xl border py-2 pl-4 pr-2 text-sm font-semibold shadow-lg;
  bottom: calc(16px + env(safe-area-inset-bottom));
  border-color: var(--border-strong);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.voice-picker-toast-text {
  @apply min-w-0 flex-1;
  overflow-wrap: anywhere;
}

.voice-picker-toast-action {
  @apply min-h-11 min-w-16 shrink-0 rounded-lg px-4 text-sm font-bold;
  background: var(--accent);
  color: #fff;
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
