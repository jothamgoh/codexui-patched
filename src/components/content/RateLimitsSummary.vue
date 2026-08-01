<template>
  <section class="rate-limits" aria-label="Rate limits remaining">
    <div class="rate-limits-header">
      <div>
        <p class="rate-limits-eyebrow">Usage remaining</p>
        <p v-if="accountMeta" class="rate-limits-meta">{{ accountMeta }}</p>
      </div>
      <button
        class="rate-limits-refresh"
        type="button"
        :disabled="isRefreshing || !refreshRateLimits"
        aria-label="Refresh rate limits"
        title="Refresh rate limits"
        @click="void onRefreshRateLimits()"
      >
        <IconTablerRefresh class="rate-limits-refresh-icon" :class="{ 'is-spinning': isRefreshing }" />
      </button>
    </div>

    <div v-if="availableResetCount > 0" class="rate-limit-resets">
      <div class="rate-limit-resets-copy">
        <p class="rate-limit-resets-count">{{ resetCountLabel }}</p>
        <p v-if="nextResetCreditExpiryLabel" class="rate-limit-resets-expiry">{{ nextResetCreditExpiryLabel }}</p>
      </div>
      <button
        class="rate-limit-reset-button"
        type="button"
        :disabled="isUsingRateLimitReset || !useRateLimitReset"
        :data-confirm="isResetConfirming"
        @click="void onUseRateLimitReset()"
      >
        <IconTablerRefresh class="rate-limit-reset-button-icon" :class="{ 'is-spinning': isUsingRateLimitReset }" />
        <span>{{ resetButtonLabel }}</span>
      </button>
    </div>

    <template v-if="entries.length > 0">
      <section v-for="entry in entries" :key="entry.key" class="rate-limits-group">
        <header v-if="entry.label" class="rate-limits-group-header">{{ entry.label }}</header>

        <div v-for="row in entry.rows" :key="row.key" class="rate-limits-row">
          <div class="rate-limits-row-copy">
            <div class="rate-limits-row-label">{{ row.label }}</div>
            <div class="rate-limits-row-description">
              <span>{{ remainingPercentLabel(row.usedPercent) }}</span>
              <span v-if="row.resetLabel">{{ row.resetLabel }}</span>
            </div>
          </div>

          <div class="rate-limits-row-progress">
            <progress
              class="rate-limits-progress"
              max="100"
              :value="remainingPercent(row.usedPercent)"
              aria-label="Usage remaining"
            />
          </div>
        </div>
      </section>
    </template>
    <p v-else class="rate-limits-empty">No rate-limit data yet. Reload this page once.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AccountRateLimitsState } from '../../api/codexGateway'
import IconTablerRefresh from '../icons/IconTablerRefresh.vue'

type LimitRow = {
  key: string
  label: string
  usedPercent: number
  resetLabel: string
  windowDurationMins: number | null
}

const props = defineProps<{
  rateLimits: AccountRateLimitsState | null
  refreshRateLimits?: () => Promise<void> | void
  useRateLimitReset?: () => Promise<void> | void
  isUsingRateLimitReset?: boolean
}>()

const isRefreshing = ref(false)
const isResetConfirming = ref(false)

const availableResetCount = computed(() =>
  Math.max(0, Math.round(props.rateLimits?.rateLimitResetCredits.availableCount ?? 0)),
)

const resetCountLabel = computed(() => {
  const count = availableResetCount.value
  return `${count} ${count === 1 ? 'reset' : 'resets'} available`
})

const nextResetCreditExpiryLabel = computed(() => {
  const nextCredit = [...(props.rateLimits?.rateLimitResetCredits.credits ?? [])]
    .filter((credit) => credit.status === 'available' && credit.expiresAt)
    .sort((a, b) => Date.parse(a.expiresAt ?? '') - Date.parse(b.expiresAt ?? ''))[0]
  if (!nextCredit?.expiresAt) return ''

  return `Next expires ${formatResetDate(new Date(nextCredit.expiresAt))}`
})

const resetButtonLabel = computed(() => {
  if (props.isUsingRateLimitReset) return 'Using...'
  return isResetConfirming.value ? 'Confirm reset' : 'Use reset'
})

const entries = computed(() => {
  const snapshots = Object.values(props.rateLimits?.byLimitId ?? {})
  const fallback = props.rateLimits?.defaultSnapshot
  if (snapshots.length === 0 && fallback) snapshots.push(fallback)

  return snapshots
    .map((snapshot, index) => {
      const rows: LimitRow[] = []
      if (snapshot.primary) {
        rows.push({
          key: `${snapshot.limitId ?? 'default'}-primary`,
          label: usageWindowLabel(snapshot.primary.windowDurationMins),
          usedPercent: snapshot.primary.usedPercent,
          resetLabel: resetLabel(snapshot.primary.resetsAt),
          windowDurationMins: snapshot.primary.windowDurationMins,
        })
      }
      if (snapshot.secondary) {
        rows.push({
          key: `${snapshot.limitId ?? 'default'}-secondary`,
          label: usageWindowLabel(snapshot.secondary.windowDurationMins),
          usedPercent: snapshot.secondary.usedPercent,
          resetLabel: resetLabel(snapshot.secondary.resetsAt),
          windowDurationMins: snapshot.secondary.windowDurationMins,
        })
      }

      return {
        key: snapshot.limitId ?? `default-${index}`,
        label: snapshot.limitName ?? snapshot.limitId ?? (snapshots.length > 1 ? `Limit ${index + 1}` : ''),
        rows,
      }
    })
    .filter((entry) => entry.rows.length > 0)
})

const accountMeta = computed(() => {
  const snapshot = props.rateLimits?.defaultSnapshot ?? Object.values(props.rateLimits?.byLimitId ?? {})[0] ?? null
  if (!snapshot) return ''

  const parts: string[] = []
  if (snapshot.planType && snapshot.planType !== 'unknown') {
    parts.push(`${snapshot.planType[0].toUpperCase()}${snapshot.planType.slice(1)} plan`)
  }
  if (snapshot.credits?.unlimited) {
    parts.push('Unlimited credits')
  } else if (snapshot.credits?.balance) {
    parts.push(`Balance ${snapshot.credits.balance}`)
  } else if (snapshot.credits?.hasCredits) {
    parts.push('Credits available')
  }
  return parts.join(' · ')
})

async function onRefreshRateLimits(): Promise<void> {
  if (!props.refreshRateLimits || isRefreshing.value) return
  isResetConfirming.value = false
  isRefreshing.value = true
  try {
    await props.refreshRateLimits()
  } finally {
    isRefreshing.value = false
  }
}

async function onUseRateLimitReset(): Promise<void> {
  if (!props.useRateLimitReset || props.isUsingRateLimitReset) return
  if (!isResetConfirming.value) {
    isResetConfirming.value = true
    return
  }

  try {
    await props.useRateLimitReset()
    isResetConfirming.value = false
  } catch {
    // Error copy is surfaced by the parent state; keep confirmation armed for retry.
  }
}

function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - Math.round(usedPercent)))
}

function remainingPercentLabel(usedPercent: number): string {
  return `${remainingPercent(usedPercent)}% left`
}

function usageWindowLabel(windowDurationMins: number | null): string {
  if (!windowDurationMins || windowDurationMins <= 0) return 'Usage limit'
  if (windowDurationMins % 10080 === 0) {
    const weeks = Math.round(windowDurationMins / 10080)
    return `${weeks}w limit`
  }
  if (windowDurationMins % 1440 === 0) {
    const days = Math.round(windowDurationMins / 1440)
    return `${days}d limit`
  }
  if (windowDurationMins % 60 === 0) {
    const hours = Math.round(windowDurationMins / 60)
    return `${hours}h limit`
  }
  return `${windowDurationMins}m limit`
}

function resetLabel(resetsAt: number | null): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return ''
  return `Resets ${formatResetDate(new Date(resetsAt * 1000))}`
}

function formatResetDate(resetDate: Date): string {
  const now = new Date()
  const sameDay =
    resetDate.getFullYear() === now.getFullYear() &&
    resetDate.getMonth() === now.getMonth() &&
    resetDate.getDate() === now.getDate()
  const formatted = sameDay
    ? resetDate.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    })
    : resetDate.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  return formatted
}
</script>

<style scoped>
@reference "tailwindcss";

.rate-limits {
  @apply rounded-lg border p-2;
  background: var(--surface-soft);
  border-color: var(--border-subtle);
  color: var(--text-primary);
}

.rate-limits-header {
  @apply mb-1.5 flex items-start justify-between gap-2;
}

.rate-limits-eyebrow {
  @apply m-0 text-[11px] leading-4 font-medium uppercase tracking-normal;
  color: var(--text-primary);
}

.rate-limits-meta {
  @apply mt-0.5 text-[10px] leading-4;
  color: var(--text-muted);
}

.rate-limits-refresh {
  @apply inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-transparent transition disabled:cursor-not-allowed disabled:opacity-50;
  color: var(--text-muted);
}

.rate-limits-refresh:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.rate-limits-refresh-icon {
  @apply h-3.5 w-3.5;
}

.rate-limits-refresh-icon.is-spinning {
  animation: rate-limits-spin 800ms linear infinite;
}

.rate-limit-resets {
  @apply mb-2 flex items-center justify-between gap-2 rounded-md border px-2 py-1.5;
  background: var(--surface-primary);
  border-color: var(--border-soft);
}

.rate-limit-resets-copy {
  @apply min-w-0;
}

.rate-limit-resets-count,
.rate-limit-resets-expiry {
  @apply m-0 text-[11px] leading-4;
}

.rate-limit-resets-count {
  color: var(--text-primary);
}

.rate-limit-resets-expiry {
  @apply text-[10px];
  color: var(--text-muted);
}

.rate-limit-reset-button {
  @apply inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] leading-4 font-medium transition disabled:cursor-not-allowed disabled:opacity-50;
  background: var(--surface-soft);
  border-color: var(--border-subtle);
  color: var(--text-primary);
}

.rate-limit-reset-button:hover:not(:disabled) {
  background: var(--surface-hover);
}

.rate-limit-reset-button[data-confirm='true'] {
  border-color: var(--border-strong);
}

.rate-limit-reset-button-icon {
  @apply h-3 w-3;
}

.rate-limit-reset-button-icon.is-spinning {
  animation: rate-limits-spin 800ms linear infinite;
}

@keyframes rate-limits-spin {
  to {
    transform: rotate(360deg);
  }
}

.rate-limits-group + .rate-limits-group {
  @apply mt-1.5 border-t pt-1.5;
  border-color: var(--border-soft);
}

.rate-limits-group-header {
  @apply mb-1 text-[10px] font-medium uppercase tracking-normal;
  color: var(--text-faint);
}

.rate-limits-row + .rate-limits-row {
  @apply mt-1.5;
}

.rate-limits-row-copy {
  @apply flex items-start justify-between gap-2;
}

.rate-limits-row-label {
  @apply shrink-0 text-[11px] leading-4 font-medium;
  color: var(--text-primary);
}

.rate-limits-row-description {
  @apply flex min-w-0 flex-col items-end gap-0.5 text-right text-[10px] leading-4;
  color: var(--text-muted);
}

.rate-limits-row-progress {
  @apply mt-1;
}

.rate-limits-progress {
  @apply h-1.5 w-full overflow-hidden rounded-full;
}

.rate-limits-progress::-webkit-progress-bar {
  border-radius: 9999px;
  background: var(--surface-muted);
}

.rate-limits-progress::-webkit-progress-value {
  border-radius: 9999px;
  background: var(--text-secondary);
}

.rate-limits-progress::-moz-progress-bar {
  border-radius: 9999px;
  background: var(--text-secondary);
}

.rate-limits-empty {
  @apply m-0 text-[11px] leading-4;
  color: var(--text-muted);
}
</style>
