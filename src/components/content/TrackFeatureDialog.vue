<template>
  <DialogRoot :open="open" @update:open="!busy && $emit('update:open', $event)">
    <DialogPortal><DialogOverlay class="track-overlay" />
      <DialogContent class="track-dialog" aria-describedby="track-description" @open-auto-focus="initialize" @interact-outside="(busy || isDictating) && $event.preventDefault()" @escape-key-down="(busy || isDictating) && $event.preventDefault()">
        <header><div><DialogTitle>Track on board</DialogTitle><p id="track-description">Give this work a feature card and its own Lead chat. Your original conversation stays linked.</p></div><Button variant="ghost" size="icon-sm" aria-label="Close tracking" :disabled="busy || isDictating" @click="$emit('update:open', false)"><X /></Button></header>
        <form @submit.prevent="submit"><fieldset :disabled="busy" class="track-fields">
          <p v-if="error" role="alert" class="track-error">{{ error }}</p>
          <label><span>Brief</span><DictationField v-model="draft.description" label="Feature brief" v-bind="voiceField('brief')" multiline rows="6" maxlength="12000" placeholder="What should the Lead achieve? Include important decisions from this chat." /></label>
          <label><span>Title <small>optional</small></span><DictationField v-model="draft.title" label="Feature title" v-bind="voiceField('title')" maxlength="200" :placeholder="suggestedTitle || 'Generated from your brief'" /></label>
          <p v-if="!draft.title.trim() && suggestedTitle" class="track-help">Title: {{ suggestedTitle }}</p>
          <label><span>Board</span><select v-model="draft.boardId" aria-label="Track destination board" :disabled="Boolean(createdFeatureId)"><option v-for="board in boards" :key="board.id" :value="board.id">{{ board.name }}</option><option v-if="!boards.length" value="">Create a project board</option></select></label>
          <details><summary>Lead and model settings</summary>
            <label><span>Lead</span><select v-model="draft.assignedAgentId" aria-label="Feature Lead"><option v-for="agent in eligibleAgents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
            <BoardExecutionSettings v-model:model="draft.model" v-model:reasoning-effort="draft.reasoningEffort" :inherited-model="lead?.model" :inherited-effort="lead?.reasoningEffort" />
          </details>
          <p class="track-help">Starts with a read-only plan. Review it in the Lead chat, then choose Continue work when ready.</p>
          <button v-if="!createdFeatureId" class="track-plan-link" type="button" :disabled="busy || isDictating" @click="$emit('plan-project', draft.description)">Have a larger plan? Create several feature cards</button>
          <footer><Button type="button" variant="ghost" :disabled="busy || isDictating" @click="$emit('update:open', false)">Cancel</Button><Button type="submit" :disabled="busy || isDictating || !validTitle || !draft.assignedAgentId"><LoaderCircle v-if="busy" class="animate-spin" />{{ busy ? 'Opening Lead chat…' : createdFeatureId ? 'Retry opening chat' : 'Create feature & plan' }}</Button></footer>
        </fieldset></form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { LoaderCircle, X } from '@lucide/vue'
import Button from '../ui/button/Button.vue'
import DictationField from './DictationField.vue'
import BoardExecutionSettings from './BoardExecutionSettings.vue'
import { projectBoardTitleFromBrief } from '../../lib/projectBoardTitle'
import type { ProjectBoard, ProjectBoardAgent, ProjectBoardCardCreateInput } from '../../types/projectBoards'
import type { ReasoningEffort } from '../../types/codex'

const props = defineProps<{ open: boolean; sourceThreadId: string; initialBrief: string; boards: ProjectBoard[]; agents: ProjectBoardAgent[]; createdFeatureId: string; onTrack: (draft: ProjectBoardCardCreateInput) => Promise<void> }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; 'plan-project': [brief: string] }>()
const busy = ref(false)
const error = ref('')
const busyVoiceFields = reactive(new Set<string>())
const isDictating = computed(() => busyVoiceFields.size > 0)
const draft = reactive({ boardId: '', title: '', description: '', assignedAgentId: '', model: '', reasoningEffort: '' as ReasoningEffort | '' })
const suggestedTitle = computed(() => projectBoardTitleFromBrief(draft.description))
const validTitle = computed(() => draft.title.trim() || suggestedTitle.value)
const board = computed(() => props.boards.find((entry) => entry.id === draft.boardId))
const eligibleAgents = computed(() => props.agents.filter((agent) => !board.value || board.value.agentIds.includes(agent.id)))
const lead = computed(() => eligibleAgents.value.find((agent) => agent.id === draft.assignedAgentId))
let initializedSource = ''
function voiceField(key: string) {
  return { dictationDisabled: busy.value || (isDictating.value && !busyVoiceFields.has(key)), onBusyChange: (value: boolean) => { if (value) busyVoiceFields.add(key); else busyVoiceFields.delete(key) } }
}
function chooseLead() {
  if (!eligibleAgents.value.some((agent) => agent.id === draft.assignedAgentId)) draft.assignedAgentId = eligibleAgents.value.find((agent) => agent.role === 'lead')?.id || eligibleAgents.value[0]?.id || ''
}
function initialize() {
  if (initializedSource === props.sourceThreadId && draft.description) return
  initializedSource = props.sourceThreadId
  Object.assign(draft, { boardId: props.boards.find((entry) => entry.isDefault)?.id || props.boards[0]?.id || '', title: '', description: props.initialBrief, model: '', reasoningEffort: '', assignedAgentId: '' })
  chooseLead(); error.value = ''
}
watch(eligibleAgents, chooseLead)
watch(() => props.boards, (boards) => {
  if (!draft.boardId && boards.length) draft.boardId = boards.find((entry) => entry.isDefault)?.id || boards[0]!.id
})
watch(() => props.createdFeatureId, (id) => {
  if (id && !draft.title.trim()) draft.title = suggestedTitle.value
})
async function submit() {
  if (busy.value || isDictating.value || !validTitle.value) return
  busy.value = true; error.value = ''
  try {
    await props.onTrack({ ...draft, sourceThreadId: props.sourceThreadId, type: 'feature' })
    draft.description = ''; initializedSource = ''; emit('update:open', false)
  } catch (caught) { error.value = caught instanceof Error ? caught.message : 'Could not track this feature.' }
  finally { busy.value = false }
}
</script>

<style scoped>
@reference "tailwindcss";
.track-overlay { @apply fixed inset-0 z-[65] bg-black/40; }
.track-dialog { @apply fixed top-1/2 left-1/2 z-[70] max-h-[92dvh] w-[calc(100%_-_2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border shadow-2xl; background: var(--surface-elevated); border-color: var(--border-soft); color: var(--text-primary); }
header { @apply flex items-start justify-between gap-3 border-b p-5; border-color: var(--border-soft); }
header p, .track-help { @apply mt-2 mb-0 text-xs leading-5 break-words; color: var(--text-secondary); }
form { @apply p-5; }
.track-fields { @apply m-0 flex min-w-0 flex-col gap-4 border-0 p-0; }
label { @apply flex min-w-0 flex-col gap-1.5 text-sm; }
label > span, summary { @apply text-xs font-medium; color: var(--text-secondary); }
small { @apply font-normal; color: var(--text-tertiary); }
select { @apply h-10 w-full min-w-0 rounded-md border px-2; background: var(--surface-elevated); border-color: var(--border-strong); }
details > label { @apply my-3; }
summary { @apply cursor-pointer py-2; }
.track-plan-link { @apply text-left text-xs underline; color: var(--text-secondary); }
footer { @apply flex items-center justify-end gap-2; }
svg { @apply h-4 w-4; }
.track-error { @apply m-0 text-sm; color: var(--color-red-500, #ef4444); }
@media (max-width: 640px) { .track-dialog { @apply top-auto bottom-0 left-0 max-h-[94dvh] w-full translate-x-0 translate-y-0 rounded-b-none; } form { padding-bottom: max(1.25rem, env(safe-area-inset-bottom)); } button, select, summary { min-height: 44px; } header button { min-width: 44px; } select { font-size: 16px; } }
</style>
