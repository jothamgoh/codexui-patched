<template>
  <button
    v-if="dictation.isSupported.value"
    class="voice-command-mic"
    :class="{ 'is-recording': dictation.state.value === 'recording' }"
    type="button"
    :aria-label="label"
    :title="label"
    :disabled="isRunning || dictation.state.value === 'transcribing'"
    @click="toggle"
  >
    <Mic v-if="dictation.state.value !== 'recording'" aria-hidden="true" />
    <Square v-else aria-hidden="true" />
  </button>
</template>

<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { Mic, Square } from '@lucide/vue'
import { runVoiceCommand } from '../../api/voice'
import { useDictation } from '../../composables/useDictation'

/** Say another voice command from inside the app; emits the page its result opens. */
const emit = defineEmits<{ (event: 'navigate', url: string): void }>()
/** Recording, working or error text for the host to show next to the button. */
const status = defineModel<string>('status', { default: '' })

const isRunning = ref(false)
const runError = ref('')

const dictation = useDictation({
  onTranscript: (text) => { void run(text) },
})

async function run(text: string): Promise<void> {
  isRunning.value = true
  runError.value = ''
  try {
    const { url } = await runVoiceCommand(text)
    emit('navigate', url)
  } catch (error) {
    runError.value = error instanceof Error ? error.message : 'Voice command failed.'
  } finally {
    isRunning.value = false
  }
}

function toggle(): void {
  if (dictation.state.value === 'recording') void dictation.stopRecording()
  else void dictation.startRecording()
}

const label = computed(() => (dictation.state.value === 'recording' ? 'Stop and run the voice command' : 'Say a voice command'))

watchEffect(() => {
  status.value = runError.value || (isRunning.value ? 'Working on it…' : dictation.state.value === 'idle' ? dictation.errorMessage.value : dictation.statusText.value)
})
</script>

<style scoped>
.voice-command-mic {
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
}

.voice-command-mic svg {
  width: 18px;
  height: 18px;
}

.voice-command-mic.is-recording {
  color: #f7768e;
  border-color: #f7768e;
}

.voice-command-mic:disabled {
  opacity: 0.5;
  cursor: default;
}

.voice-command-mic:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
