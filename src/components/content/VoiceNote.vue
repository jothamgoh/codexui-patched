<template>
  <div class="voice-note" role="status" aria-label="Voice command">
    <div class="voice-note-copy">
      <p v-if="lead" class="voice-note-lead">{{ lead }}</p>
      <p v-if="heard" class="voice-note-heard"><span>Heard:</span> “{{ heard }}”</p>
      <p v-if="note" class="voice-note-note">{{ note }}</p>
      <p v-if="micStatus" class="voice-note-status">{{ micStatus }}</p>
    </div>
    <VoiceCommandMic v-model:status="micStatus" @navigate="emit('navigate', $event)" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import VoiceCommandMic from './VoiceCommandMic.vue'

/** What a voice command heard, with a mic to say it again. Shared by the panel and the voice choosers. */
withDefaults(defineProps<{ lead?: string; heard?: string; note?: string }>(), { lead: '', heard: '', note: '' })
const emit = defineEmits<{ (event: 'navigate', url: string): void }>()
const micStatus = ref('')
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

.voice-note-note {
  @apply font-medium;
  color: var(--text-primary);
}

.voice-note > :deep(.voice-command-mic) {
  @apply -my-1;
}
</style>
