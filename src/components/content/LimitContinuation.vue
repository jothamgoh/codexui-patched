<template>
  <div class="limit-continuation" role="status">
    <div class="limit-continuation-inner">
      <span class="limit-continuation-text">Claude switched accounts but could not resume this chat automatically.</span>
      <button class="limit-continuation-button" type="button" :disabled="sending" @click="onContinue">Continue</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{ continue: [] }>()

const sending = ref(false)

function onContinue(): void {
  sending.value = true
  emit('continue')
  // The banner disappears once the server reports the continuation started.
  setTimeout(() => { sending.value = false }, 3000)
}
</script>

<style scoped>
@reference "tailwindcss";

.limit-continuation {
  @apply w-full max-w-[42rem] mx-auto px-3 sm:px-5;
}

.limit-continuation-inner {
  @apply flex items-center gap-2 rounded-t-2xl border-x border-t border-amber-300 bg-amber-50/90 px-3 py-1.5;
}

.limit-continuation-text {
  @apply min-w-0 flex-1 text-sm text-amber-900;
}

.limit-continuation-button {
  @apply shrink-0 rounded-md border border-amber-400 bg-white px-3 py-1 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-60;
}
</style>
