<template>
  <component
    :is="canOpen ? RouterLink : 'div'"
    :to="canOpen ? { name: 'thread', params: { threadId: activity.threadId } } : undefined"
    :aria-label="canOpen ? `Open ${activity.name} subagent` : undefined"
    class="subagent-activity-card"
    :class="{ 'subagent-activity-card--link': canOpen }"
    :data-agent-status="activity.status"
    :data-agent-thread-id="activity.threadId ?? undefined"
  >
    <span class="subagent-activity-icon" aria-hidden="true"><Bot /></span>
    <span class="subagent-activity-content">
      <span class="subagent-activity-heading">
        <span class="subagent-activity-name">{{ activity.name }}</span>
        <span class="subagent-activity-status">{{ activity.statusLabel }}</span>
      </span>
      <span v-if="activity.task" class="subagent-activity-task">{{ activity.task }}</span>
    </span>
    <ChevronRight v-if="canOpen" class="subagent-activity-open" aria-hidden="true" />
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Bot, ChevronRight } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import type { SubAgentActivityData } from '../../types/codex'

const props = defineProps<{ activity: SubAgentActivityData; parentThreadId: string }>()
const canOpen = computed(() => Boolean(props.activity.threadId && props.activity.threadId !== props.parentThreadId))
</script>

<style scoped>
.subagent-activity-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--muted-foreground);
  text-decoration: none;
  font-size: 13px;
  line-height: 1.5;
}
.subagent-activity-card--link:hover { background: var(--muted); }
.subagent-activity-card--link:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.subagent-activity-icon { display: flex; flex: none; padding: 6px; border-radius: 8px; background: var(--muted); }
.subagent-activity-icon svg { width: 16px; height: 16px; }
.subagent-activity-content { display: block; flex: 1; min-width: 0; }
.subagent-activity-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
.subagent-activity-name { color: var(--foreground); font-weight: 500; overflow-wrap: anywhere; }
.subagent-activity-status { font-size: 12px; }
.subagent-activity-task { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; margin-top: 3px; }
.subagent-activity-open { flex: none; width: 14px; height: 14px; }
[data-agent-status='active'] .subagent-activity-status { color: var(--foreground); }
</style>
