<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AppWindow } from '@lucide/vue'
import { getChatGptAppAutoQuit, setChatGptAppAutoQuit } from '../../api/codexGateway'

const enabled = ref(true)
const loaded = ref(false)
const saving = ref(false)
const error = ref('')

onMounted(async () => {
  try {
    enabled.value = await getChatGptAppAutoQuit()
    loaded.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load this setting.'
  }
})

async function changeSetting(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const next = input.checked
  saving.value = true
  error.value = ''
  try {
    enabled.value = await setChatGptAppAutoQuit(next)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not save this setting.'
  } finally {
    saving.value = false
    input.checked = enabled.value
  }
}
</script>

<template>
  <div class="chatgpt-app-setting">
    <label class="chatgpt-app-setting-row">
      <AppWindow aria-hidden="true" class="chatgpt-app-setting-icon" />
      <span class="chatgpt-app-setting-copy">
        <span class="chatgpt-app-setting-title">Close ChatGPT after computer use</span>
        <span class="chatgpt-app-setting-description">10 minutes after a Claude chat opened it · all devices</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label="Close ChatGPT after computer use"
        :checked="enabled"
        :disabled="!loaded || saving"
        @change="changeSetting"
      />
    </label>
    <p class="chatgpt-app-setting-scope">Frees its memory. Never closes the app if you opened it yourself.</p>
    <p v-if="error" class="chatgpt-app-setting-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
@reference "../../style.css";
.chatgpt-app-setting { @apply w-full; }
.chatgpt-app-setting-row { @apply flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground; }
.chatgpt-app-setting-icon { @apply size-5 shrink-0; }
.chatgpt-app-setting-copy { @apply flex min-w-0 flex-1 flex-col; }
.chatgpt-app-setting-title { @apply text-[15px] leading-5; }
.chatgpt-app-setting-description { @apply text-[11px] leading-4; }
.chatgpt-app-setting-row input { @apply h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-muted-foreground/35 p-0.5 transition-colors checked:bg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60; }
.chatgpt-app-setting-row input::before { content: ''; @apply block size-4 rounded-full bg-background shadow-sm transition-transform; }
.chatgpt-app-setting-row input:checked::before { transform: translateX(16px); }
.chatgpt-app-setting-scope { @apply px-2.5 pb-1 text-[11px] leading-4 text-muted-foreground; }
.chatgpt-app-setting-error { @apply px-2.5 pb-1 text-[11px] leading-4 text-destructive; }
</style>
