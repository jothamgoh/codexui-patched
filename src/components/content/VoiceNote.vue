<template>
  <div class="voice-note" role="status" aria-label="Voice command">
    <div class="voice-note-copy">
      <p v-if="lead" class="voice-note-lead">{{ lead }}</p>
      <p v-if="heard" class="voice-note-heard"><span>Heard:</span> “{{ heard }}”</p>
      <p v-if="note" class="voice-note-note">{{ note }}</p>
      <p v-if="micStatus.text" class="voice-note-status" :class="{ 'is-error': micStatus.phase === 'error' }">{{ micStatus.text }}</p>
    </div>
    <VoiceCommandMic v-if="mic" v-model:status="micStatus" @result="emit('result', $event)" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { VoiceCommandResponse } from '../../api/voice'
import { IDLE_MIC_STATUS, type VoiceMicStatus } from '../../utils/voiceMic'
import VoiceCommandMic from './VoiceCommandMic.vue'

/**
 * What a voice command heard, optionally with a mic to say it again. Shared by
 * the panel (whose header has its own mic) and the voice choosers.
 */
withDefaults(defineProps<{ lead?: string; heard?: string; note?: string; mic?: boolean }>(), { lead: '', heard: '', note: '', mic: true })
const emit = defineEmits<{ (event: 'result', response: VoiceCommandResponse): void }>()
const micStatus = ref<VoiceMicStatus>(IDLE_MIC_STATUS)
</script>

<style scoped>
@reference "tailwindcss";

.voice-note {
  @apply flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-5;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.voice-note-copy {
  @apply min-w-0 flex-1;
  overflow-wrap: anywhere;
}

.voice-note-lead {
  @apply text-sm font-semibold;
  color: var(--text-primary);
}

.voice-note-heard > span,
.voice-note-status {
  color: var(--text-muted);
}

.voice-note-status.is-error {
  color: #e5484d;
}

.voice-note-note {
  @apply font-medium;
  color: var(--text-primary);
}

.voice-note > :deep(.voice-command-mic) {
  @apply -my-1;
}
</style>
