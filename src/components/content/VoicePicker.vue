<template>
  <section class="voice-picker" aria-label="Voice result">
    <header class="voice-picker-header">
      <h1 class="voice-picker-title">{{ title }}</h1>
      <VoiceCommandMic v-model:status="micStatus" @navigate="emit('navigate', $event)" />
    </header>
    <p v-if="micStatus" class="voice-picker-status" role="status">{{ micStatus }}</p>

    <p v-if="isLoading" class="voice-picker-status" role="status">Loading…</p>
    <div v-else-if="loadError" class="voice-picker-empty" role="alert">
      <p>{{ loadError }}</p>
      <button class="voice-picker-link" type="button" @click="emit('openHome')">Go to chats</button>
    </div>

    <template v-else-if="result">
      <p class="voice-picker-heard"><span>Heard:</span> “{{ result.heard }}”</p>
      <div v-if="result.message" class="voice-picker-message">
        <p><span>Message:</span> “{{ result.message }}”</p>
        <p class="voice-picker-hint">Tapping a chat opens it with the message typed in. Nothing is sent until you tap Send.</p>
      </div>


      <h2 v-if="listHeading" class="voice-picker-subheading">{{ listHeading }}</h2>
      <ul v-if="rows.length > 0" class="voice-picker-rows">
        <li v-for="(row, index) in rows" :key="row.threadId">
          <button type="button" class="voice-picker-row" :aria-label="`Open ${row.title}`" @click="select(row.threadId)">
            <span class="voice-picker-dot" :class="`is-${row.status}`" :title="VOICE_LIST_LABELS[row.status]" aria-hidden="true" />
            <span class="voice-picker-row-copy">
              <span class="voice-picker-row-title">
                {{ row.title }}
                <span v-if="index === 0 && isCloseCall" class="voice-picker-best">best match</span>
              </span>
              <span class="voice-picker-row-meta">{{ row.projectName }} · {{ row.agent === 'claude' ? 'Claude' : 'Codex' }} · {{ statusLabel(row) }}</span>
              <span v-if="row.summary" class="voice-picker-row-summary">{{ row.summary }}</span>
            </span>
          </button>
        </li>
      </ul>
      <p v-else class="voice-picker-empty">No chats to show.</p>

      <button v-if="canShowRecent" class="voice-picker-link" type="button" @click="showRecent = true">Not these? Recent chats</button>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getVoiceResult, VoiceResultExpiredError } from '../../api/voice'
import { useRelativeTimeClock } from '../../composables/useRelativeTimeClock'
import { VOICE_LIST_LABELS, VOICE_LIST_TYPES, type VoiceChatRow, type VoiceStoredResult } from '../../types/voice'
import { formatCompactRelativeTime } from '../../utils/relativeTime'
import { voiceActivityFocus, type ActivityFocus } from '../../utils/voiceLanding'
import VoiceCommandMic from './VoiceCommandMic.vue'

const RECENT_ROWS = 10

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
const micStatus = ref('')

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
const isCloseCall = computed(() => !showRecent.value && result.value?.outcome === 'picker' && result.value.reason !== 'no_match')

const rows = computed<VoiceChatRow[]>(() => {
  const value = result.value
  if (!value) return []
  if (showRecent.value) return panelRows.value
  if (value.reason === 'no_match') return value.candidates.length > 0 ? value.candidates : panelRows.value
  return value.candidates
})

const title = computed(() => {
  const value = result.value
  if (!value) return loadError.value ? 'Voice' : 'Chats'
  if (showRecent.value) return 'Recent chats'
  if (value.message) return 'Send to which chat?'
  return 'Which chat?'
})

const listHeading = computed(() => {
  const value = result.value
  if (!value || showRecent.value) return ''
  return value.reason === 'no_match' ? 'Recent chats' : ''
})

const canShowRecent = computed(() => Boolean(result.value) && !showRecent.value && result.value?.reason !== 'no_match')

function statusLabel(row: VoiceChatRow): string {
  const age = formatCompactRelativeTime(row.updatedAtIso, now.value)
  const ageText = age === 'n/a' ? '' : age === 'now' ? 'just now' : `${age} ago`
  if (row.status === 'running') return ageText ? `running · ${ageText}` : 'running'
  if (row.status === 'needs_you') return ageText ? `needs you · ${ageText}` : 'needs you'
  return ageText || VOICE_LIST_LABELS[row.status].toLowerCase()
}

function select(threadId: string): void {
  if (!result.value) return
  emit('select', { threadId, code: result.value.code, carryMessage: Boolean(result.value.message) })
}

</script>

<style scoped>
.voice-picker { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 640px; margin: 0 auto; padding: 16px; color: var(--text-primary); overflow-y: auto; }
.voice-picker-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.voice-picker-title { font-size: 20px; font-weight: 600; }
.voice-picker-row:focus-visible, .voice-picker-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.voice-picker-status { font-size: 13px; color: var(--text-muted); }
.voice-picker-heard, .voice-picker-message { border: 1px solid var(--border-soft); border-radius: 10px; background: var(--surface-muted); padding: 10px 12px; font-size: 14px; color: var(--text-secondary); overflow-wrap: anywhere; }
.voice-picker-heard span, .voice-picker-message span { color: var(--text-muted); }
.voice-picker-message { border-color: var(--accent-soft); background: var(--accent-soft); color: var(--text-primary); }
.voice-picker-hint { margin-top: 4px; font-size: 12px; color: var(--text-muted); }
.voice-picker-subheading { font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.voice-picker-rows { display: flex; flex-direction: column; border: 1px solid var(--border-soft); border-radius: 12px; overflow: hidden; }
.voice-picker-rows li + li { border-top: 1px solid var(--border-soft); }
.voice-picker-row { display: flex; align-items: flex-start; gap: 12px; width: 100%; min-height: 56px; padding: 12px 14px; text-align: left; background: var(--surface-elevated); color: var(--text-primary); cursor: pointer; }
.voice-picker-row:hover { background: var(--surface-hover); }
.voice-picker-dot { width: 8px; height: 8px; margin-top: 7px; border-radius: 999px; background: var(--text-faint); flex-shrink: 0; }
.voice-picker-dot.is-needs_you { background: #e0af68; }
.voice-picker-dot.is-running { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.voice-picker-dot.is-unread { background: #9ece6a; }
.voice-picker-row-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.voice-picker-row-title { font-size: 15px; font-weight: 500; overflow-wrap: anywhere; }
.voice-picker-best { margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 11px; font-weight: 500; white-space: nowrap; }
.voice-picker-row-meta { font-size: 12px; color: var(--text-muted); }
.voice-picker-row-summary { font-size: 13px; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.voice-picker-empty { padding: 16px 4px; font-size: 14px; color: var(--text-muted); }
.voice-picker-link { align-self: flex-start; min-height: 44px; padding: 0 2px; color: var(--accent); background: none; font-size: 14px; cursor: pointer; }
</style>
