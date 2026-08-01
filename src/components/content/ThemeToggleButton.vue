<template>
  <button
    class="theme-toggle-button"
    :data-variant="variant"
    type="button"
    :aria-label="label"
    :title="label"
    @click="$emit('toggle')"
  >
    <IconTablerSun v-if="isDarkTheme" class="theme-toggle-button-icon" />
    <IconTablerMoon v-else class="theme-toggle-button-icon" />
    <span v-if="variant === 'sidebar'" class="theme-toggle-button-label">
      {{ isDarkTheme ? 'Light mode' : 'Dark mode' }}
    </span>
  </button>
</template>

<script setup lang="ts">
import IconTablerMoon from '../icons/IconTablerMoon.vue'
import IconTablerSun from '../icons/IconTablerSun.vue'

withDefaults(defineProps<{
  isDarkTheme: boolean
  label: string
  variant?: 'icon' | 'sidebar'
}>(), {
  variant: 'icon',
})

defineEmits<{
  toggle: []
}>()
</script>

<style scoped>
@reference "tailwindcss";

.theme-toggle-button {
  @apply inline-flex h-8 w-8 items-center justify-center rounded-full border transition;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-secondary);
}

.theme-toggle-button:hover {
  border-color: var(--border-strong);
  background: var(--surface-muted);
  color: var(--text-primary);
}

.theme-toggle-button[data-variant='sidebar'] {
  @apply h-9 w-full justify-start gap-3 rounded-lg border-0 bg-transparent px-2.5 text-left text-[15px] font-normal;
  color: var(--text-secondary);
}

.theme-toggle-button[data-variant='sidebar']:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.theme-toggle-button-icon {
  @apply h-4.5 w-4.5 shrink-0;
}

.theme-toggle-button-label {
  @apply leading-6;
}
</style>
