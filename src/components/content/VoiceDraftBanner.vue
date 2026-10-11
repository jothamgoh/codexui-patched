<template>
  <div class="voice-draft-banner" role="status">
    <Mic class="voice-draft-banner-icon" aria-hidden="true" />
    <div class="voice-draft-banner-copy">
      <p><span>From voice:</span> “{{ heard }}”</p>
      <p v-if="note" class="voice-draft-banner-note">{{ note }}</p>
      <div v-if="projectChoices.length > 0" class="voice-draft-banner-projects" role="group" aria-label="Which project?">
        <span>Which project?</span>
        <button v-for="project in projectChoices" :key="project.id" type="button" @click="emit('chooseProject', project.id)">{{ project.label }}</button>
      </div>
    </div>
    <button class="voice-draft-banner-dismiss" type="button" aria-label="Dismiss voice note" @click="emit('dismiss')">
      <X aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { Mic, X } from '@lucide/vue'
import type { VoiceProjectOption } from '../../types/voice'

withDefaults(defineProps<{ heard: string; note?: string; projectChoices?: VoiceProjectOption[] }>(), { note: '', projectChoices: () => [] })
const emit = defineEmits<{
  (event: 'dismiss'): void
  (event: 'chooseProject', projectId: string): void
}>()
</script>

<style scoped>
.voice-draft-banner { display: flex; align-items: flex-start; gap: 8px; margin: 0 auto 8px; width: 100%; max-width: 880px; padding: 8px 10px; border: 1px solid var(--accent-soft); border-radius: 10px; background: var(--accent-soft); color: var(--text-primary); font-size: 13px; }
.voice-draft-banner-icon { width: 16px; height: 16px; margin-top: 2px; color: var(--accent); flex-shrink: 0; }
.voice-draft-banner-copy { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.voice-draft-banner-copy span { color: var(--text-muted); }
.voice-draft-banner-note { margin-top: 2px; color: var(--text-secondary); }
.voice-draft-banner-projects { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.voice-draft-banner-projects button { min-height: 32px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface-elevated); color: var(--text-primary); cursor: pointer; }
.voice-draft-banner-dismiss { display: grid; place-items: center; width: 32px; height: 32px; margin: -4px -4px -4px 0; border-radius: 8px; color: var(--text-muted); background: none; cursor: pointer; flex-shrink: 0; }
.voice-draft-banner-dismiss svg { width: 16px; height: 16px; }
.voice-draft-banner-dismiss:hover { background: var(--surface-hover); }
.voice-draft-banner-dismiss:focus-visible, .voice-draft-banner-projects button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
