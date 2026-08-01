<template>
  <div v-if="messages.length > 0" class="queued-messages">
    <div class="queued-messages-inner">
    <div v-for="msg in messages" :key="msg.id" class="queued-row">
      <svg class="queued-row-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="queued-row-text">
        {{ msg.text || selectionCountLabel(msg.responseTextAnnotations?.length ?? 0) }}
      </span>
      <span
        v-if="msg.text && (msg.responseTextAnnotations?.length ?? 0) > 0"
        class="queued-row-selection-count"
      >
        {{ selectionCountLabel(msg.responseTextAnnotations?.length ?? 0) }}
      </span>
      <div class="queued-row-actions">
        <button class="queued-row-steer" type="button" title="Send now without interrupting work" @click="$emit('steer', msg.id)">Steer</button>
        <button class="queued-row-delete" type="button" aria-label="Delete queued message" title="Delete queued message" @click="$emit('delete', msg.id)">
          <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
          </svg>
        </button>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ResponseTextAnnotation } from '../../types/codex'

defineProps<{
  messages: Array<{ id: string; text: string; responseTextAnnotations?: ResponseTextAnnotation[] }>
}>()

defineEmits<{
  steer: [messageId: string]
  delete: [messageId: string]
}>()

function selectionCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'selection' : 'selections'}`
}
</script>

<style scoped>
@reference "tailwindcss";

.queued-messages {
  @apply w-full max-w-[42rem] mx-auto px-3 sm:px-5;
}

.queued-messages-inner {
  @apply flex max-h-[30dvh] flex-col gap-px overflow-y-auto rounded-t-2xl border-x border-t border-zinc-300 bg-zinc-50/80 px-3 py-1.5;
}

.queued-row {
  @apply flex min-w-0 items-center gap-2 rounded-lg py-1 text-sm;
}

.queued-row-icon {
  @apply h-4 w-4 shrink-0 text-zinc-400;
}

.queued-row-text {
  @apply min-w-0 flex-1 truncate text-zinc-700;
}

.queued-row-selection-count {
  @apply shrink-0 rounded-md bg-zinc-200/80 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600;
}

.queued-row-actions {
  @apply flex shrink-0 items-center gap-1;
}

.queued-row-steer {
  @apply rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100;
}

.queued-row-delete {
  @apply inline-flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-700;
}
</style>
