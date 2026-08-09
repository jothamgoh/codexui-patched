<template>
  <label class="ui-font-size-control">
    <span class="ui-font-size-mark" aria-hidden="true">Aa</span>
    <span class="ui-font-size-copy">
      <span class="ui-font-size-label">UI font size</span>
      <span class="ui-font-size-description">This device only</span>
    </span>
    <select
      class="ui-font-size-select"
      :value="modelValue"
      aria-label="UI font size for this device"
      @change="onChange"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
  </label>
</template>

<script setup lang="ts">
import { UI_FONT_SIZES, normalizeUiFontSize, type UiFontSize } from '../../utils/uiFontSize'

defineProps<{
  modelValue: UiFontSize
}>()

const emit = defineEmits<{
  'update:modelValue': [value: UiFontSize]
}>()

const options = UI_FONT_SIZES.map((value) => ({
  value,
  label: `${value} px`,
}))

function onChange(event: Event): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLSelectElement)) return
  emit('update:modelValue', normalizeUiFontSize(target.value))
}
</script>

<style scoped>
@reference "tailwindcss";

.ui-font-size-control {
  @apply flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 transition;
  color: var(--text-secondary);
}

.ui-font-size-control:hover,
.ui-font-size-control:focus-within {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.ui-font-size-mark {
  @apply inline-flex h-5 w-5 shrink-0 items-center justify-center text-xs font-semibold tracking-tight;
}

.ui-font-size-copy {
  @apply flex min-w-0 flex-1 flex-col;
}

.ui-font-size-label {
  @apply text-[15px] leading-5;
}

.ui-font-size-description {
  @apply text-[11px] leading-4;
  color: var(--text-muted);
}

.ui-font-size-select {
  @apply h-8 shrink-0 rounded-lg border px-2 text-sm outline-none transition focus:ring-2;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-primary);
  --tw-ring-color: var(--ring);
}
</style>
