<script setup lang="ts">
import { computed, reactive } from 'vue'
import { Users } from '@lucide/vue'
import Button from '../ui/button/Button.vue'
import BoardExecutionSettings from './BoardExecutionSettings.vue'
import DictationField from './DictationField.vue'
import type { ProjectBoard, ProjectBoardAgent, ProjectBoardAgentOverride } from '../../types/projectBoards'
import { resolveProjectBoardAgent, type ProjectBoardTeamSettings } from '../../utils/projectBoardTeam'

const props = withDefaults(defineProps<{
  modelValue: ProjectBoardTeamSettings
  agents: ProjectBoardAgent[]
  sourceThreadId?: string
  disabled?: boolean
}>(), { sourceThreadId: '', disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: ProjectBoardTeamSettings]; 'busy-change': [busy: boolean] }>()
const dictating = reactive(new Set<string>())
const expandedAgents = reactive(new Set<string>())
const selectedAgents = computed(() => props.modelValue.agentIds.flatMap((id) => props.agents.find((agent) => agent.id === id) ?? []))
const availableAgents = computed(() => props.agents.filter((agent) => !props.modelValue.agentIds.includes(agent.id)))
const effective = (agent: ProjectBoardAgent) => resolveProjectBoardAgent(props.modelValue as ProjectBoard, agent)
const override = (agentId: string) => props.modelValue.agentOverrides[agentId] ?? {}
const customized = (agentId: string) => Object.keys(override(agentId)).length > 0
function update(changes: Partial<ProjectBoardTeamSettings>) {
  emit('update:modelValue', { ...props.modelValue, ...changes })
}
function setOverride(agentId: string, changes: Partial<ProjectBoardAgentOverride>) {
  update({ agentOverrides: { ...props.modelValue.agentOverrides, [agentId]: { ...override(agentId), ...changes } } })
}
function reset(agentId: string) {
  const overrides = { ...props.modelValue.agentOverrides }
  delete overrides[agentId]
  update({ agentOverrides: overrides })
}
function addAgent(event: Event) {
  const select = event.target as HTMLSelectElement
  if (select.value) update({ agentIds: [...props.modelValue.agentIds, select.value] })
  select.value = ''
}
function removeAgent(id: string) {
  const overrides = { ...props.modelValue.agentOverrides }
  delete overrides[id]
  update({ agentIds: props.modelValue.agentIds.filter((agentId) => agentId !== id), agentOverrides: overrides })
}
function voiceField(agentId: string) {
  return {
    dictationDisabled: props.disabled || (dictating.size > 0 && !dictating.has(agentId)),
    onBusyChange: (busy: boolean) => { if (busy) dictating.add(agentId); else dictating.delete(agentId); emit('busy-change', dictating.size > 0) },
  }
}
function sourceLabel(agent: ProjectBoardAgent) {
  const saved = override(agent.id)
  if ('model' in saved || 'reasoningEffort' in saved) return 'This board’s agent settings'
  return agent.model || agent.reasoningEffort ? 'Shared template defaults' : 'Follows board defaults'
}
</script>

<template>
  <section class="team-settings" aria-label="Team & settings">
    <div class="team-heading"><Users aria-hidden="true" /><h3>Team &amp; settings</h3></div>
    <p class="team-help">Choose a default for this board, then override individual agents only when needed. Prompts edited here stay on this board.</p>
    <fieldset :disabled="disabled" class="team-fields">
      <BoardExecutionSettings :model="modelValue.model" :reasoning-effort="modelValue.reasoningEffort" :source-thread-id="sourceThreadId"
        label="Board default" inherit-label="Use app defaults" :show-specialist-note="false"
        @update:model="update({ model: $event })" @update:reasoning-effort="update({ reasoningEffort: $event })" />
      <label class="team-coordinator"><span>Coordinator / default Lead</span>
        <select :value="modelValue.coordinatorAgentId" aria-label="Project coordinator" :disabled="dictating.size > 0" @change="update({ coordinatorAgentId: ($event.target as HTMLSelectElement).value })">
          <option v-for="agent in selectedAgents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
        </select>
        <small>Plans the board and leads new features. Each feature can choose another Lead.</small>
      </label>
      <div class="team-agents">
        <details v-for="agent in selectedAgents" :key="agent.id" class="team-agent" @toggle="($event.target as HTMLDetailsElement).open && expandedAgents.add(agent.id)">
          <summary>
            <span class="team-agent-name">{{ agent.name }}<small>{{ agent.id === modelValue.coordinatorAgentId ? 'Coordinator / Lead' : agent.role }}</small></span>
            <span class="team-agent-status">{{ customized(agent.id) ? 'Customized here' : 'View prompt & settings' }}</span>
          </summary>
          <div v-if="expandedAgents.has(agent.id)" class="team-agent-body">
            <p class="team-help">{{ agent.description }}</p>
            <BoardExecutionSettings :model="override(agent.id).model ?? agent.model" :reasoning-effort="override(agent.id).reasoningEffort ?? agent.reasoningEffort"
              :inherited-model="modelValue.model" :inherited-effort="modelValue.reasoningEffort" :source-thread-id="sourceThreadId"
              :label="agent.name" inherit-label="Follow board / Lead" :show-specialist-note="false"
              @update:model="setOverride(agent.id, { model: $event })" @update:reasoning-effort="setOverride(agent.id, { reasoningEffort: $event })" />
            <p class="team-help">{{ sourceLabel(agent) }}. Specialists with inherited settings follow their feature’s Lead.</p>
            <label><span>{{ agent.name }} prompt</span>
              <DictationField :model-value="effective(agent).instructions" :label="`${agent.name} prompt`" v-bind="voiceField(agent.id)" multiline rows="7" maxlength="20000" required
                @update:model-value="setOverride(agent.id, { instructions: $event })" />
            </label>
            <p class="team-help">Role instructions. The app adds the feature brief, handoffs and coordination rules at run time.</p>
            <div class="team-agent-actions">
              <Button v-if="customized(agent.id)" type="button" size="sm" variant="outline" :disabled="dictating.size > 0" @click="reset(agent.id)">Reset to template</Button>
              <Button v-if="agent.id !== modelValue.coordinatorAgentId" type="button" size="sm" variant="ghost" :disabled="dictating.size > 0" @click="removeAgent(agent.id)">Remove from team</Button>
            </div>
          </div>
        </details>
      </div>
      <label v-if="availableAgents.length"><span>Add an agent from your shared library</span>
        <select aria-label="Add team agent" :disabled="dictating.size > 0" @change="addAgent"><option value="">Choose an agent…</option><option v-for="agent in availableAgents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select>
      </label>
    </fieldset>
  </section>
</template>

<style scoped>
.team-settings { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.team-heading { display: flex; align-items: center; gap: 8px; }
.team-heading svg { width: 17px; height: 17px; }
.team-heading h3 { margin: 0; font-size: 14px; font-weight: 600; }
.team-help, small { font-size: 12px; line-height: 1.5; color: var(--text-secondary); margin: 0; overflow-wrap: anywhere; }
.team-fields { display: flex; flex-direction: column; gap: 16px; min-width: 0; margin: 0; padding: 0; border: 0; }
label { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
label > span { font-size: 12px; font-weight: 500; }
select { width: 100%; min-width: 0; min-height: 44px; border: 1px solid var(--border-strong); border-radius: 6px; padding: 8px; color: var(--text-primary); background: var(--surface-elevated); font-size: 14px; }
.team-agents { display: flex; flex-direction: column; gap: 8px; }
.team-agent { border: 1px solid var(--border-soft); border-radius: 8px; min-width: 0; }
summary { cursor: pointer; min-height: 56px; padding: 10px 12px; display: flex; align-items: center; gap: 10px; }
summary::before { content: '▸'; color: var(--text-muted); }
details[open] > summary::before { content: '▾'; }
.team-agent-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.team-agent-name small { display: block; font-weight: 400; }
.team-agent-status { max-width: 45%; font-size: 11px; color: var(--text-secondary); text-align: right; }
.team-agent-body { display: flex; flex-direction: column; gap: 12px; padding: 0 12px 12px; }
.team-agent-actions { display: flex; flex-wrap: wrap; gap: 8px; }
summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (max-width: 640px) { select { font-size: 16px; } .team-agent-actions button { min-height: 44px; } }
</style>
