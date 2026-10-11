<template>
  <button
    v-if="dictation.isSupported.value"
    class="voice-command-mic"
    :class="[`is-${status.phase}`, `is-${size}`]"
    type="button"
    :aria-label="label"
    :title="label"
    :aria-busy="status.phase === 'starting' || status.phase === 'working'"
    :disabled="status.phase === 'working'"
    :style="{ '--voice-level': dictation.level.value.toFixed(3) }"
    @click="toggle"
  >
    <LoaderCircle v-if="status.phase === 'starting' || status.phase === 'working'" class="voice-command-mic-spin" aria-hidden="true" />
    <Square v-else-if="status.phase === 'recording'" class="voice-command-mic-stop" aria-hidden="true" />
    <Mic v-else aria-hidden="true" />
  </button>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { LoaderCircle, Mic, Square } from '@lucide/vue'
import { runVoiceCommandAudio, type VoiceCommandResponse } from '../../api/voice'
import { useDictation } from '../../composables/useDictation'
import { describeMicError, IDLE_MIC_STATUS, NOTHING_HEARD, voiceMicStatus, type VoiceMicStatus } from '../../utils/voiceMic'

/**
 * Say a voice command from inside the app: tap to record, tap to stop. The
 * recording goes to the same router as the iPhone Shortcut, and the host
 * decides where the result lands. Used by the notifications panel and the
 * voice notes on the panel and the choosers.
 */
withDefaults(defineProps<{ size?: 'regular' | 'compact' }>(), { size: 'regular' })
const emit = defineEmits<{ (event: 'result', response: VoiceCommandResponse): void }>()
/** Recording, working or error, for the host to show next to the button. */
const status = defineModel<VoiceMicStatus>('status', { default: () => IDLE_MIC_STATUS })

/** A failure the dictation helper does not word itself: a blocked mic, or nothing heard. */
const failure = ref('')

const dictation = useDictation<VoiceCommandResponse>({
  meter: true,
  upload: (audio, signal) => runVoiceCommandAudio(audio, signal),
  onTranscript: (response) => {
    // An empty transcript routes to "didn't catch that" with nothing heard; say so here instead.
    if (response.result.outcome === 'not_understood' && !response.result.heard) {
      failure.value = NOTHING_HEARD
      return
    }
    emit('result', response)
  },
  onError: (error) => { failure.value = describeMicError(error) },
})

function toggle(): void {
  if (dictation.state.value === 'recording') {
    dictation.stopRecording()
    return
  }
  failure.value = ''
  void dictation.startRecording()
}

/** Sends the last recording again after a failed upload. */
function retry(): void {
  failure.value = ''
  void dictation.retryTranscription()
}

defineExpose({ retry })

/** Recording time, ticking once a second while the mic is live. */
const elapsedMs = ref(0)
let clock: ReturnType<typeof setInterval> | null = null
function stopClock(): void {
  if (clock) clearInterval(clock)
  clock = null
}
watch(() => dictation.state.value, (state) => {
  stopClock()
  elapsedMs.value = 0
  if (state !== 'recording') return
  const started = Date.now()
  clock = setInterval(() => { elapsedMs.value = Date.now() - started }, 1000)
})
onBeforeUnmount(stopClock)

const label = computed(() => {
  if (status.value.phase === 'recording') return 'Stop and run the voice command'
  if (status.value.phase === 'working') return 'Working on the voice command'
  return 'Say a voice command'
})

watchEffect(() => {
  status.value = voiceMicStatus({
    isStarting: dictation.isStarting.value,
    state: dictation.state.value,
    error: failure.value || dictation.errorMessage.value,
    canRetry: dictation.canRetry.value,
    elapsedMs: elapsedMs.value,
  })
})
</script>

<style scoped>
.voice-command-mic {
  position: relative;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
  background: var(--surface-elevated);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}

.voice-command-mic.is-compact {
  width: 32px;
  height: 32px;
  border-color: transparent;
  background: transparent;
  color: var(--text-muted);
}

.voice-command-mic svg {
  position: relative;
  width: 18px;
  height: 18px;
}

/* Touch screens keep :hover after a tap, so only devices that really hover get it. */
@media (hover: hover) {
  .voice-command-mic:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--surface-muted);
  }

  .voice-command-mic.is-recording:hover:not(:disabled) {
    color: #fff;
    background: #d13438;
  }
}

/* Recording: a red stop button with a ring that follows the voice, so it is obvious the mic is live. */
.voice-command-mic.is-recording {
  color: #fff;
  border-color: #e5484d;
  background: #e5484d;
}

.voice-command-mic.is-recording .voice-command-mic-stop {
  width: 14px;
  height: 14px;
  fill: currentColor;
}

.voice-command-mic.is-recording::before,
.voice-command-mic.is-recording::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  pointer-events: none;
}

.voice-command-mic.is-recording::before {
  background: #e5484d;
  opacity: 0.28;
  transform: scale(calc(1 + var(--voice-level, 0) * 0.3));
  transition: transform 80ms linear;
}

.voice-command-mic.is-recording::after {
  border: 2px solid #e5484d;
  animation: voice-command-mic-pulse 1400ms ease-out infinite;
}

.voice-command-mic.is-working,
.voice-command-mic.is-starting {
  color: var(--accent);
}

.voice-command-mic-spin {
  animation: voice-command-mic-spin 800ms linear infinite;
}

.voice-command-mic.is-error {
  color: #e5484d;
}

.voice-command-mic:disabled {
  cursor: progress;
}

.voice-command-mic:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@keyframes voice-command-mic-pulse {
  from { transform: scale(1); opacity: 0.7; }
  to { transform: scale(1.4); opacity: 0; }
}

@keyframes voice-command-mic-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 640px) {
  .voice-command-mic.is-compact {
    width: 44px;
    height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .voice-command-mic.is-recording::after,
  .voice-command-mic-spin {
    animation: none;
  }

  .voice-command-mic.is-recording::before {
    transition: none;
  }
}
</style>
