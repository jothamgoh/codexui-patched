<template>
  <article class="automation-proposal-card">
    <header class="automation-proposal-heading">
      <span class="automation-proposal-icon"><CalendarClock aria-hidden="true" /></span>
      <div class="automation-proposal-title">
        <p class="automation-proposal-eyebrow">{{ eyebrow }}</p>
        <h3>{{ task?.name || proposal.draft.name || 'Scheduled task' }}</h3>
      </div>
      <span
        v-if="proposal.status === 'accepted'"
        class="automation-proposal-status"
        :data-status="task?.status ?? 'REMOVED'"
      >
        {{ statusLabel }}
      </span>
    </header>

    <p class="automation-proposal-prompt">
      {{ task?.prompt || proposal.draft.prompt }}
    </p>

    <dl class="automation-proposal-details">
      <div class="automation-proposal-frequency">
        <dt>Frequency</dt>
        <dd>{{ frequencyLabel }}</dd>
        <small>{{ cadenceLabel }}</small>
      </div>
      <div>
        <dt>Destination</dt>
        <dd>{{ destinationLabel }}</dd>
        <small>{{ destinationHelp }}</small>
      </div>
      <div v-if="proposal.status === 'accepted' && task?.nextRunAtIso">
        <dt>Next run</dt>
        <dd>{{ nextRunLabel }}</dd>
      </div>
    </dl>

    <footer v-if="proposal.status === 'pending'" class="automation-proposal-actions">
      <Button type="button" variant="ghost" size="sm" @click="$emit('resolve', proposal.id, false)">
        Cancel
      </Button>
      <Button type="button" size="sm" @click="$emit('resolve', proposal.id, true)">
        {{ proposal.action === 'update' ? 'Apply changes' : 'Create scheduled task' }}
      </Button>
    </footer>
    <footer v-else class="automation-proposal-actions">
      <RouterLink class="automation-proposal-link" to="/scheduled">
        Open scheduled tasks
      </RouterLink>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { CalendarClock } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import type { AutomationProposal, AutomationTask } from '../../types/automations'
import {
  automationStatusLabel,
  describeAutomationCadence,
  describeAutomationFrequency,
  formatAutomationDateTime,
} from '../../utils/automations'

const props = defineProps<{
  proposal: AutomationProposal
  task?: AutomationTask
}>()

defineEmits<{
  resolve: [id: string, accept: boolean]
}>()

const schedule = computed(() => props.task ?? props.proposal.draft)
const eyebrow = computed(() => {
  if (props.proposal.status === 'accepted') return props.proposal.action === 'update' ? 'Updated' : 'Created'
  return props.proposal.action === 'update' ? 'Proposed update' : 'Proposed'
})
const statusLabel = computed(() => props.task ? automationStatusLabel(props.task) : 'Removed')
const frequencyLabel = computed(() => describeAutomationFrequency(schedule.value))
const cadenceLabel = computed(() => describeAutomationCadence(schedule.value))
const destinationLabel = computed(() => schedule.value.kind === 'heartbeat' ? 'This chat' : 'New project chat')
const destinationHelp = computed(() => schedule.value.kind === 'heartbeat'
  ? 'Continues with this conversation’s context'
  : 'Starts a fresh result chat for each run')
const nextRunLabel = computed(() => props.task?.nextRunAtIso
  ? formatAutomationDateTime(props.task.nextRunAtIso, props.task.timezone)
  : '')
</script>

<style scoped>
.automation-proposal-card {
  width: min(100%, 38rem);
  margin: 0 auto;
  padding: 1rem;
  border: 1px solid color-mix(in srgb, var(--primary, #2563eb) 24%, var(--border, #e5e7eb));
  border-radius: .9rem;
  background: color-mix(in srgb, var(--accent) 5%, var(--surface-elevated));
  box-shadow: 0 2px 10px rgb(15 23 42 / 5%);
}

.automation-proposal-heading {
  display: flex;
  gap: .7rem;
  align-items: center;
}

.automation-proposal-title {
  min-width: 0;
  flex: 1;
}

.automation-proposal-title h3 {
  margin: .08rem 0 0;
  overflow: hidden;
  font-size: .95rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.automation-proposal-icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  flex: 0 0 auto;
  place-items: center;
  border-radius: .55rem;
  background: color-mix(in srgb, var(--primary, #2563eb) 14%, transparent);
  color: var(--accent);
}

.automation-proposal-icon svg {
  width: 1rem;
  height: 1rem;
}

.automation-proposal-eyebrow {
  margin: 0;
  color: var(--accent);
  font-size: .68rem;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: .04em;
}

.automation-proposal-status {
  flex: 0 0 auto;
  padding: .2rem .48rem;
  border-radius: 999px;
  background: color-mix(in srgb, #10b981 14%, transparent);
  color: color-mix(in srgb, #10b981 72%, var(--text-primary));
  font-size: .68rem;
  font-weight: 650;
}

.automation-proposal-status[data-status='PAUSED'],
.automation-proposal-status[data-status='REMOVED'] {
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.automation-proposal-prompt {
  display: -webkit-box;
  overflow: hidden;
  margin: .8rem 0;
  color: var(--muted-foreground, #667085);
  font-size: .82rem;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.automation-proposal-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .5rem;
  margin: 0;
}

.automation-proposal-details > div {
  min-width: 0;
  padding: .62rem;
  border-radius: .55rem;
  background: color-mix(in srgb, var(--muted, #f3f4f6) 80%, transparent);
}

.automation-proposal-frequency {
  grid-column: span 2;
}

.automation-proposal-details dt {
  color: var(--muted-foreground, #667085);
  font-size: .65rem;
}

.automation-proposal-details dd {
  margin: .16rem 0 0;
  font-size: .78rem;
  font-weight: 620;
  line-height: 1.35;
}

.automation-proposal-details small {
  display: block;
  margin-top: .18rem;
  overflow: hidden;
  color: var(--muted-foreground, #667085);
  font-size: .67rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.automation-proposal-actions {
  display: flex;
  justify-content: flex-end;
  gap: .4rem;
  margin-top: .8rem;
}

.automation-proposal-link {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  padding: 0 .7rem;
  border: 1px solid var(--border-soft);
  border-radius: .45rem;
  color: var(--text-primary);
  font-size: .78rem;
  font-weight: 600;
  text-decoration: none;
}

.automation-proposal-link:hover {
  background: var(--surface-muted);
}

@media (max-width: 520px) {
  .automation-proposal-card {
    padding: .85rem;
  }

  .automation-proposal-details {
    grid-template-columns: 1fr;
  }

  .automation-proposal-frequency {
    grid-column: auto;
  }

  .automation-proposal-details small {
    white-space: normal;
  }
}
</style>
