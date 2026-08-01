<template>
  <header class="content-header">
    <div class="content-leading">
      <slot name="leading" />
    </div>
    <div class="content-title-group">
      <h1 class="content-title">{{ title }}</h1>
      <div v-if="$slots.meta" class="content-meta">
        <slot name="meta" />
      </div>
    </div>
    <div class="content-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>

<style scoped>
@reference "tailwindcss";

.content-header {
  @apply relative z-10 w-full min-h-12 sm:min-h-14 flex items-center gap-2 sm:gap-3 px-2 sm:px-3 pt-3 sm:pt-4 pb-2 bg-white;
}

.content-title-group {
  @apply min-w-0 flex-1;
}

.content-title {
  @apply m-0 truncate text-base font-semibold leading-6 text-slate-900 max-sm:text-xs max-sm:font-medium;
}

.content-meta {
  @apply min-w-0;
}

.content-actions {
  @apply flex items-center justify-end gap-1;
}

.content-leading {
  @apply flex items-center gap-1;
}
</style>
