<template>
  <fieldset class="execution-settings">
    <legend>{{ label }}</legend>
    <div class="execution-fields">
      <label><span>{{ label }} model</span>
        <select :value="model" :aria-label="`${label} model`" @change="$emit('update:model', ($event.target as HTMLSelectElement).value)">
          <option value="">{{ inheritLabel }}</option>
          <option v-if="model && !catalog?.models.some(entry => entry.id === model)" :value="model" disabled>{{ model }} · unavailable</option>
          <option v-for="entry in catalog?.models ?? []" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
        </select>
      </label>
      <label><span>{{ label }} reasoning</span>
        <select :value="reasoningEffort" :aria-label="`${label} reasoning`" @change="$emit('update:reasoningEffort', ($event.target as HTMLSelectElement).value as ReasoningEffort | '')">
          <option v-if="allowInheritedEffort" value="">{{ inheritLabel }}</option>
          <option v-if="reasoningEffort && !availableEfforts.includes(reasoningEffort)" :value="reasoningEffort" disabled>{{ reasoningEffort }} · unsupported</option>
          <option v-for="effort in availableEfforts" :key="effort" :value="effort">{{ effortLabel(effort) }}</option>
        </select>
      </label>
    </div>
    <p v-if="error" class="execution-error" role="alert">{{ error }} <button type="button" @click="load">Retry</button></p>
    <p v-else-if="!catalog" role="status">Loading available models…</p>
    <p v-else>Using {{ effectiveModel || 'the app default' }} · {{ effortLabel(effectiveEffort) }} reasoning.</p>
    <p v-if="unsupported" class="execution-error">This model does not support {{ effectiveEffort }} reasoning. Choose another level.</p>
    <p v-if="showSpecialistNote">These settings apply to the Lead. Specialists use their own agent settings.</p>
  </fieldset>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getProjectBoardModels } from '../../api/projectBoards'
import type { ProjectBoardModelCatalog } from '../../types/projectBoardModels'
import type { ReasoningEffort } from '../../types/codex'

const props = withDefaults(defineProps<{
  model: string
  reasoningEffort: ReasoningEffort | ''
  inheritedModel?: string
  inheritedEffort?: ReasoningEffort | ''
  inheritLabel?: string
  label?: string
  showSpecialistNote?: boolean
  allowInheritedEffort?: boolean
}>(), { inheritedModel: '', inheritedEffort: '', inheritLabel: 'Use Lead settings', label: 'Lead', showSpecialistNote: true, allowInheritedEffort: true })
defineEmits<{ 'update:model': [value: string]; 'update:reasoningEffort': [value: ReasoningEffort | ''] }>()
const catalog = ref<ProjectBoardModelCatalog | null>(null)
const error = ref('')
const effectiveModel = computed(() => props.model || props.inheritedModel || catalog.value?.defaultModel || '')
const selectedModel = computed(() => catalog.value?.models.find((entry) => entry.id === effectiveModel.value))
const effectiveEffort = computed(() => props.reasoningEffort || props.inheritedEffort || catalog.value?.defaultReasoningEffort || 'medium')
const availableEfforts = computed(() => selectedModel.value?.reasoningEfforts ?? [])
const unsupported = computed(() => availableEfforts.value.length > 0 && !availableEfforts.value.includes(effectiveEffort.value))
const effortLabels: Record<string, string> = { xhigh: 'Extra high', low: 'Light' }
const effortLabel = (value: string) => effortLabels[value] || (value[0]?.toUpperCase() ?? '') + value.slice(1)
async function load(): Promise<void> {
  error.value = ''
  try { catalog.value = await getProjectBoardModels() }
  catch (caught) { error.value = caught instanceof Error ? caught.message : 'Could not load models.' }
}
onMounted(() => { void load() })
</script>

<style scoped>
@reference "tailwindcss";
.execution-settings { @apply min-w-0 rounded-lg border p-3; border-color: var(--border-soft); }
legend { @apply px-1 text-xs font-medium; color: var(--text-secondary); }
.execution-fields { @apply grid grid-cols-1 gap-3 sm:grid-cols-2; }
label { @apply flex min-w-0 flex-col gap-1; }
label span { @apply text-xs; color: var(--text-secondary); }
select { @apply h-10 w-full min-w-0 rounded-md border px-2 text-sm; color: var(--text-primary); background: var(--surface-elevated); border-color: var(--border-strong); }
p { @apply mt-2 mb-0 text-xs leading-5; color: var(--text-tertiary); }
.execution-error { color: var(--color-red-500, #ef4444); }
button { @apply underline; }
</style>
