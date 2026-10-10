<template>
  <div v-if="tasks.length > 0" class="background-tasks">
    <div class="background-tasks-inner">
      <button class="background-tasks-summary" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
        <span class="background-tasks-pulse" aria-hidden="true" />
        <span class="background-tasks-label">{{ summary }}</span>
        <svg class="background-tasks-chevron" :class="{ 'is-open': expanded }" xmlns="http://www.w3.org/2000/svg"
          width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <ul v-if="expanded" class="background-tasks-list">
        <li v-for="task in tasks" :key="task.id" class="background-task-row">
          <span class="background-task-type">{{ typeLabel(task.type) }}</span>
          <span class="background-task-text" :title="task.description">{{ task.description || 'Background task' }}</span>
          <button class="background-task-stop" type="button" title="Stop this background task" @click="$emit('stop', task.id)">Stop</button>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { UiBackgroundTask } from '../../api/codexGateway'

const props = defineProps<{ tasks: UiBackgroundTask[] }>()

defineEmits<{ stop: [taskId: string] }>()

const expanded = ref(false)

const summary = computed(() => {
  const count = props.tasks.length
  return `${count} background ${count === 1 ? 'task' : 'tasks'} running`
})

const TYPE_LABELS: Record<string, string> = {
  local_bash: 'Command',
  local_agent: 'Agent',
  local_workflow: 'Workflow',
  mcp_task: 'Tool',
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? 'Task'
}
</script>

<style scoped>
@reference "tailwindcss";

.background-tasks {
  @apply w-full max-w-[42rem] mx-auto px-3 sm:px-5;
}

.background-tasks-inner {
  @apply flex max-h-[30dvh] flex-col overflow-y-auto rounded-t-2xl border-x border-t border-zinc-300 bg-zinc-50/80 px-3 py-1;
}

.background-tasks-summary {
  @apply flex w-full min-w-0 items-center gap-2 border-0 bg-transparent py-1 text-left text-sm text-zinc-700;
}

.background-tasks-pulse {
  @apply h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500;
}

.background-tasks-label {
  @apply min-w-0 flex-1 truncate;
}

.background-tasks-chevron {
  @apply h-4 w-4 shrink-0 text-zinc-400 transition-transform;
}

.background-tasks-chevron.is-open {
  @apply rotate-180;
}

.background-tasks-list {
  @apply m-0 flex list-none flex-col gap-px p-0 pb-1;
}

.background-task-row {
  @apply flex min-w-0 items-center gap-2 py-1 text-sm;
}

.background-task-type {
  @apply shrink-0 rounded-md bg-zinc-200/80 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600;
}

.background-task-text {
  @apply min-w-0 flex-1 truncate text-zinc-700;
}

.background-task-stop {
  @apply shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100;
}
</style>
