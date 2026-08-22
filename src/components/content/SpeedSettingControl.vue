<template>
  <div class="speed-setting-control-wrap">
    <label class="speed-setting-control">
      <Zap class="speed-setting-icon" aria-hidden="true" />
      <span class="speed-setting-copy">
        <span class="speed-setting-label">Speed</span>
        <span class="speed-setting-description">
          {{ description }}
        </span>
      </span>
      <select
        class="speed-setting-select"
        :value="modelValue ? 'fast' : 'standard'"
        :disabled="isSaving"
        aria-label="Speed setting for all devices"
        @change="onChange"
      >
        <option value="standard">Standard</option>
        <option value="fast">Fast</option>
      </select>
    </label>
    <span v-if="error" class="speed-setting-error" role="alert">{{ error }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Zap } from '@lucide/vue'

const props = defineProps<{
  modelValue: boolean
  isSaving: boolean
  error: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const description = computed(() => {
  if (props.isSaving) return 'Saving for all devices…'
  return props.modelValue
    ? '1.5× speed, increased usage · all devices'
    : 'Default speed · all devices'
})

function onChange(event: Event): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLSelectElement)) return
  emit('update:modelValue', target.value === 'fast')
}
</script>

<style scoped>
@reference "tailwindcss";

.speed-setting-control-wrap {
  @apply flex w-full flex-col;
}

.speed-setting-control {
  @apply flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 transition;
  color: var(--text-secondary);
}

.speed-setting-control:hover,
.speed-setting-control:focus-within {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.speed-setting-icon {
  @apply h-5 w-5 shrink-0;
}

.speed-setting-copy {
  @apply flex min-w-0 flex-1 flex-col;
}

.speed-setting-label {
  @apply text-[15px] leading-5;
}

.speed-setting-description {
  @apply text-[11px] leading-4;
  color: var(--text-muted);
}

.speed-setting-select {
  @apply h-8 shrink-0 rounded-lg border px-2 text-sm outline-none transition focus:ring-2 disabled:cursor-wait disabled:opacity-60;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-primary);
  --tw-ring-color: var(--ring);
}

.speed-setting-error {
  @apply px-2.5 pb-1 text-[11px] leading-4 text-rose-600;
}
</style>
