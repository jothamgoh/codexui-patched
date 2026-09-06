<template>
  <details v-if="helpers.length" class="thread-helpers">
    <summary>
      <span>{{ helpers.length }} {{ helpers.length === 1 ? 'helper' : 'helpers' }}</span>
      <span v-if="workingCount" class="thread-helpers-count">{{ workingCount }} working</span>
    </summary>
    <div class="thread-helpers-list">
      <button v-for="helper in helpers" :key="helper.id" type="button"
        :aria-label="`View helper ${helper.title || 'Agent'}`" @click="emit('selectThread', helper.id)">
        <Bot aria-hidden="true" />
        <span class="thread-helper-name">{{ helper.title || 'Agent' }}</span>
        <span class="thread-helper-state">{{ waitingThreadIds.has(helper.id) ? 'Needs you' : helper.inProgress ? 'Working' : helper.runtimeStatus === 'systemError' ? 'Issue' : 'Idle' }}</span>
      </button>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Bot } from '@lucide/vue'
import type { UiThread } from '../../types/codex'

const props = defineProps<{ helpers: UiThread[]; waitingThreadIds: Set<string> }>()
const emit = defineEmits<{ (event: 'selectThread', threadId: string): void }>()
const workingCount = computed(() => props.helpers.filter((helper) => helper.inProgress && !props.waitingThreadIds.has(helper.id)).length)
</script>

<style scoped>
.thread-helpers { margin: 0 10px 6px 36px; min-width: 0; color: var(--text-secondary); font-size: 12px; }
.thread-helpers summary { cursor: pointer; min-height: 44px; align-content: center; padding: 6px 0; }
.thread-helpers-count { margin-left: 8px; color: var(--text-muted); }
.thread-helpers-list { max-height: 220px; overflow-y: auto; border-left: 1px solid var(--border-soft); padding-left: 8px; }
.thread-helpers button { display: flex; gap: 8px; align-items: center; width: 100%; min-height: 44px; padding: 8px 6px; text-align: left; cursor: pointer; border-radius: 6px; }
.thread-helpers button:hover { background: var(--surface-muted); }
.thread-helpers button:focus-visible, .thread-helpers summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.thread-helpers svg { width: 14px; height: 14px; flex-shrink: 0; }
.thread-helper-name { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.thread-helper-state { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
</style>
