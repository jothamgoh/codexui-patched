<template>
  <DialogRoot :open="open" @update:open="$emit('update:open', $event)">
    <DialogPortal><DialogOverlay class="plan-overlay" />
      <DialogContent class="plan-dialog" aria-describedby="board-plan-description" @open-auto-focus="initializeDraft">
        <header><div><DialogTitle>{{ sourceThreadId ? 'Turn this chat into a board' : 'Plan project features' }}</DialogTitle>
          <p id="board-plan-description">Give your coordinator the goal or an existing plan. It will propose feature cards and dependencies for you to review.</p></div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close planning" :disabled="busy" @click="$emit('update:open', false)"><X /></Button>
        </header>
        <form @submit.prevent="submit">
          <p v-if="localError" class="plan-error" role="alert">{{ localError }}</p>
          <label v-if="!boardId"><span>Project</span><select v-model="draft.projectPath" aria-label="Plan project"><option v-for="project in projects" :key="project.path" :value="project.path">{{ project.name }}</option><option value="__new__">Open or create a project folder…</option></select></label>
          <template v-if="!boardId && draft.projectPath === '__new__'">
            <label><span>Project folder</span><Input v-model="draft.folderPath" required placeholder="Full path to the project folder" /></label>
            <label class="plan-checkbox"><input v-model="draft.createFolder" type="checkbox" /><span>Create this folder if it does not exist</span></label>
          </template>
          <label v-if="!boardId"><span>Board name</span><Input v-model="draft.name" required maxlength="120" placeholder="Project delivery" /></label>
          <label><span>Goal or plan</span><Textarea v-model="draft.plan" class="plan-text" required maxlength="20000" rows="9" placeholder="Describe the overall result, paste your plan, or name a plan file in this project. Include what is already done." /></label>
          <p v-if="sourceThreadId" class="plan-help">Includes a bounded excerpt of this chat and links back to it. Paste any important older decisions into the plan.</p>
          <label><span>Project coordinator</span><select v-model="draft.coordinatorAgentId" aria-label="Project coordinator"><option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
          <BoardExecutionSettings v-model:model="draft.model" v-model:reasoning-effort="draft.reasoningEffort" :inherited-model="coordinator?.model" :inherited-effort="coordinator?.reasoningEffort" inherit-label="Use coordinator settings" label="Coordinator" :show-specialist-note="false" />
          <p class="plan-help">Planning reads project context and saves cards. Implementation starts when you choose a feature or run the selected queue.</p>
          <footer><Button type="button" variant="ghost" :disabled="busy" @click="$emit('update:open', false)">Cancel</Button><Button type="submit" :disabled="busy || !draft.plan.trim() || !draft.coordinatorAgentId"><LoaderCircle v-if="busy" class="animate-spin" />{{ busy ? 'Starting planning…' : 'Create feature plan' }}</Button></footer>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { LoaderCircle, X } from '@lucide/vue'
import Button from '../ui/button/Button.vue'
import Input from '../ui/input/Input.vue'
import Textarea from '../ui/textarea/Textarea.vue'
import BoardExecutionSettings from './BoardExecutionSettings.vue'
import type { ProjectBoardAgent } from '../../types/projectBoards'
import type { ReasoningEffort } from '../../types/codex'
import type { ProjectBoardPlanInput } from '../../api/projectBoards'

export type BoardPlanDraft = ProjectBoardPlanInput & { boardId: string; projectPath: string; createFolder: boolean; name: string }
const props = defineProps<{ open: boolean; boardId?: string; sourceThreadId?: string; initialPlan?: string; initialProjectPath?: string; initialCoordinatorId?: string; projects: { path: string; name: string }[]; agents: ProjectBoardAgent[]; onPlan: (draft: BoardPlanDraft) => Promise<void> }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const busy = ref(false)
const localError = ref('')
const initializedFor = ref('')
const draft = reactive({ projectPath: '', folderPath: '', createFolder: false, name: 'Project delivery', plan: '', coordinatorAgentId: '', model: '', reasoningEffort: '' as ReasoningEffort | '' })
const coordinator = computed(() => props.agents.find((agent) => agent.id === draft.coordinatorAgentId))
function initializeDraft(): void {
  localError.value = ''
  const key = `${props.boardId ?? ''}:${props.sourceThreadId ?? ''}`
  if (initializedFor.value === key && draft.plan) return
  initializedFor.value = key
  draft.projectPath = props.initialProjectPath || props.projects[0]?.path || '__new__'
  if (draft.projectPath !== '__new__' && !props.projects.some((project) => project.path === draft.projectPath)) {
    draft.folderPath = draft.projectPath
    draft.projectPath = '__new__'
  }
  draft.plan = props.initialPlan ?? ''
  draft.coordinatorAgentId = props.initialCoordinatorId || props.agents.find((agent) => agent.role === 'lead')?.id || props.agents[0]?.id || ''
  draft.model = ''; draft.reasoningEffort = ''
}
async function submit(): Promise<void> {
  if (busy.value) return
  busy.value = true; localError.value = ''
  try {
    await props.onPlan({ boardId: props.boardId || '', sourceThreadId: props.sourceThreadId, name: draft.name, projectPath: draft.projectPath === '__new__' ? draft.folderPath.trim() : draft.projectPath, createFolder: draft.projectPath === '__new__' && draft.createFolder, plan: draft.plan, coordinatorAgentId: draft.coordinatorAgentId, model: draft.model, reasoningEffort: draft.reasoningEffort })
    draft.plan = ''; emit('update:open', false)
  } catch (caught) { localError.value = caught instanceof Error ? caught.message : 'Could not start planning.' }
  finally { busy.value = false }
}
</script>

<style scoped>
@reference "tailwindcss";
.plan-overlay { @apply fixed inset-0 z-[65] bg-black/40; }
.plan-dialog { @apply fixed top-1/2 left-1/2 z-[70] max-h-[92dvh] w-[calc(100%_-_2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border shadow-2xl; background: var(--surface-elevated); border-color: var(--border-soft); color: var(--text-primary); }
header { @apply sticky top-0 z-10 flex items-start justify-between gap-4 border-b p-5; background: var(--surface-elevated); border-color: var(--border-soft); }
header p, .plan-help { @apply mt-2 mb-0 text-xs leading-5; color: var(--text-secondary); }
form { @apply flex flex-col gap-4 p-5; }
label { @apply flex min-w-0 flex-col gap-1.5; }
label > span { @apply text-xs font-medium; color: var(--text-secondary); }
select { @apply h-10 rounded-md border px-2 text-sm; background: var(--surface-elevated); border-color: var(--border-strong); }
.plan-checkbox { @apply flex-row items-center gap-2; }
.plan-text { min-height: 12rem; field-sizing: fixed; }
footer { @apply flex items-center justify-end gap-2; }
svg { @apply h-4 w-4; }
.plan-error { @apply m-0 text-sm; color: var(--color-red-500, #ef4444); }
@media (max-width: 640px) { .plan-dialog { @apply top-auto bottom-0 left-0 max-h-[94dvh] w-full translate-x-0 translate-y-0 rounded-b-none; } }
</style>
