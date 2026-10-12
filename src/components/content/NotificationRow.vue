<template>
  <button class="notification-row" type="button">
    <span class="notification-row-icon" :class="`is-${tone}`">
      <slot name="icon">
        <CircleAlert v-if="tone === 'failed'" />
        <LoaderCircle v-else-if="tone === 'running'" />
        <BackgroundWorkMark v-else-if="tone === 'background'" />
        <Circle v-else-if="tone === 'unread'" />
        <Pin v-else-if="tone === 'pinned'" />
        <SquareKanban v-else-if="tone === 'board'" />
        <CheckCircle2 v-else />
      </slot>
    </span>
    <span class="notification-row-copy">
      <span class="notification-row-title-line">
        <span class="notification-row-title">{{ title }}</span>
        <span v-if="pill" class="notification-unread-pill" :class="pillTone === 'unread' ? '' : `is-${pillTone}`">{{ pill }}</span>
      </span>
      <span class="notification-row-meta" :class="{ 'is-wrapping': wrapMeta }"><slot name="meta" /></span>
      <span v-if="preview" class="notification-row-preview">{{ preview }}</span>
      <slot />
    </span>
  </button>
</template>

<script setup lang="ts">
import { CheckCircle2, Circle, CircleAlert, LoaderCircle, Pin, SquareKanban } from '@lucide/vue'
import BackgroundWorkMark from './BackgroundWorkMark.vue'

/**
 * One chat row in the notification panel's look. The panel and the voice
 * choosers both use it, so the app has a single list style.
 */
withDefaults(defineProps<{
  tone: 'failed' | 'running' | 'background' | 'unread' | 'completed' | 'pinned' | 'board'
  title: string
  pill?: string
  pillTone?: 'unread' | 'attention' | 'accent'
  preview?: string
  wrapMeta?: boolean
}>(), {
  pill: '',
  pillTone: 'unread',
  preview: '',
  wrapMeta: false,
})
</script>

<style scoped>
@reference "tailwindcss";

.notification-row {
  @apply flex w-full items-start gap-3 px-4 py-2.5 text-left transition;
  color: var(--text-primary);
}

.notification-row:hover {
  background: var(--surface-muted);
}

.notification-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.notification-row-icon {
  @apply mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center;
  color: var(--text-muted);
}

.notification-row-icon :deep(svg) {
  @apply h-4 w-4;
}

.notification-row-icon.is-running {
  color: #3b82f6;
}

.notification-row-icon.is-running :deep(svg) {
  animation: notification-row-spin 900ms linear infinite;
}

.notification-row-icon.is-unread {
  color: #22c55e;
}

.notification-row-icon.is-unread :deep(svg) {
  @apply h-2.5 w-2.5;
  fill: currentColor;
}

.notification-row-icon.is-completed {
  color: #22c55e;
}

.notification-row-icon.is-failed {
  color: var(--destructive);
}

.notification-row-copy {
  @apply min-w-0 flex-1;
}

.notification-row-title-line {
  @apply flex min-w-0 items-center gap-2;
}

.notification-row-title {
  @apply min-w-0 flex-1 truncate text-sm font-medium;
  color: var(--text-primary);
}

.notification-unread-pill {
  @apply inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none;
  background: color-mix(in srgb, #22c55e 14%, transparent);
  color: #16a34a;
}

.notification-unread-pill.is-attention {
  background: color-mix(in srgb, #d97706 14%, transparent);
  color: var(--text-warning, #d97706);
}

.notification-unread-pill.is-accent {
  background: var(--accent-soft);
  color: var(--accent);
}

.notification-row-meta {
  @apply mt-0.5 flex items-center gap-1 text-xs;
  color: var(--text-muted);
}

.notification-row-meta.is-wrapping {
  @apply flex-wrap;
}

.notification-row-preview {
  @apply mt-1 line-clamp-2 text-xs leading-4;
  color: var(--text-secondary);
}

@keyframes notification-row-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .notification-row {
    @apply min-h-12 gap-2.5 px-3 py-2.5;
  }
}
</style>
