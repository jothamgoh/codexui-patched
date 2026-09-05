<script setup lang="ts">
import { onMounted } from 'vue'
import { MessageCircleQuestion } from '@lucide/vue'
import { useQuestionPreference } from '../../composables/useQuestionPreference'

const { available, enabled, error, refreshAvailability, setEnabled } = useQuestionPreference()
onMounted(() => { void refreshAvailability() })

function changeSetting(event: Event): void {
  const input = event.target as HTMLInputElement
  setEnabled(input.checked)
  input.checked = enabled.value
}
</script>

<template>
  <div v-if="available" class="question-setting">
    <label class="question-setting-row">
      <MessageCircleQuestion aria-hidden="true" class="question-setting-icon" />
      <span class="question-setting-copy">
        <span class="question-setting-title">Questions in new chats</span>
        <span class="question-setting-description">Optional questions outside Plan mode · this browser</span>
      </span>
      <input type="checkbox" role="switch" aria-label="Questions in new chats" :checked="enabled" @change="changeSetting" />
    </label>
    <p class="question-setting-scope">Existing chats keep their current setting.</p>
    <p v-if="error" class="question-setting-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
@reference "../../style.css";
.question-setting { @apply w-full; }
.question-setting-row { @apply flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground; }
.question-setting-icon { @apply size-5 shrink-0; }
.question-setting-copy { @apply flex min-w-0 flex-1 flex-col; }
.question-setting-title { @apply text-[15px] leading-5; }
.question-setting-description { @apply text-[11px] leading-4; }
.question-setting-row input { @apply h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-muted-foreground/35 p-0.5 transition-colors checked:bg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring; }
.question-setting-row input::before { content: ''; @apply block size-4 rounded-full bg-background shadow-sm transition-transform; }
.question-setting-row input:checked::before { transform: translateX(16px); }
.question-setting-scope { @apply px-2.5 pb-1 text-[11px] leading-4 text-muted-foreground; }
.question-setting-error { @apply px-2.5 pb-1 text-[11px] leading-4 text-destructive; }
</style>
