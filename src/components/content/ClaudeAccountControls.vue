<template>
  <section class="claude-accounts" aria-label="Saved Claude accounts">
    <header>Claude accounts <span v-if="pool">{{ pool.accounts.length }} saved</span></header>
    <template v-if="pool?.installed">
      <label class="account-label" for="claude-active-account">Account for all Claude chats</label>
      <select id="claude-active-account" aria-label="Active Claude account" :value="pool.pendingAccountNumber ?? pool.activeAccountNumber ?? ''" :disabled="disabled || pool.switching || !pool.accounts.length" @change="emit('switch', Number(($event.target as HTMLSelectElement).value))">
        <option value="" disabled>Save your current login first</option>
        <option v-for="account in pool.accounts" :key="account.number" :value="account.number">
          {{ account.alias || account.email }}{{ account.active ? ' · active' : '' }}
        </option>
      </select>
      <label class="auto-row">
        <input type="checkbox" aria-label="Automatically switch Claude accounts" :checked="pool.enabled" :disabled="disabled || pool.switching" @change="emit('configure', ($event.target as HTMLInputElement).checked, pool.threshold)">
        <span>Auto switch at</span>
        <select aria-label="Claude automatic switch threshold" :value="pool.threshold" :disabled="disabled || pool.switching" @change="emit('configure', pool.enabled, Number(($event.target as HTMLSelectElement).value))">
          <option v-for="threshold in thresholds" :key="threshold" :value="threshold">{{ threshold }}% used</option>
        </select>
      </label>
      <p>Switches after replies finish. Chats and folders stay together. Uses this Mac’s default Claude login.</p>
      <p class="poll-note">CodexUI checks cswap each minute. cswap schedules usage requests and 429 backoff.</p>
      <div class="account-actions">
        <button type="button" :disabled="disabled || pool.switching || !connected" @click="emit('save')">Save current login</button>
        <button type="button" :disabled="disabled || pool.switching" @click="emit('add')">Add another account</button>
      </div>
      <p v-if="pool.notice" class="account-notice" role="status">{{ pool.notice }}</p>
      <details v-if="pool.accounts.length" class="account-usage">
        <summary>Manage saved accounts</summary>
        <div v-for="account in pool.accounts" :key="account.number" class="saved-account">
          <div class="saved-account-header" :class="{ 'is-confirming': removeConfirm === account.number }">
            <strong>{{ account.alias || account.email }}</strong>
            <button type="button" :aria-label="`${removeConfirm === account.number ? 'Confirm remove' : 'Remove'} ${account.email}`" :disabled="disabled || pool.switching" @click="removeAccount(account.number)">{{ removeConfirm === account.number ? 'Confirm remove' : 'Remove' }}</button>
            <button v-if="removeConfirm === account.number" type="button" @click="removeConfirm = null">Cancel</button>
          </div>
          <span v-if="removeConfirm === account.number">Removes the saved login from switching. Keeps your chats and current sign-in.</span>
          <span v-if="account.disabled">Excluded from auto switch</span>
          <span v-if="account.usageIsStale || account.usageRateLimited">Cached usage{{ account.usageRateLimited ? ' · checks paused after 429' : '' }}</span>
          <template v-if="account.limits.length">
            <div v-for="limit in account.limits" :key="limit.label" class="limit">
              <span>{{ limit.label }} · {{ Math.round(100 - limit.usedPercent) }}% left</span>
              <progress max="100" :value="100 - limit.usedPercent" :aria-label="`${account.email} ${limit.label} remaining`" />
            </div>
          </template>
          <span v-else>{{ account.usageStatus === 'relogin_required' ? 'Sign in again to use this account' : 'Usage unavailable' }}</span>
        </div>
      </details>
    </template>
    <p v-else>Install claude-swap on the host to save and switch Claude accounts.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ClaudeAccountPool } from '../../types/claudeAccounts'
const props = defineProps<{ pool: ClaudeAccountPool | null; disabled: boolean; connected: boolean }>()
const emit = defineEmits<{
  switch: [number: number]
  configure: [enabled: boolean, threshold: number]
  save: []
  add: []
  remove: [number: number]
}>()
const removeConfirm = ref<number | null>(null)
function removeAccount(number: number): void {
  if (removeConfirm.value !== number) { removeConfirm.value = number; return }
  removeConfirm.value = null
  emit('remove', number)
}
const thresholds = computed(() => [...new Set([75, 80, 90, 95, 99, props.pool?.threshold ?? 90])].sort((a, b) => a - b))
</script>

<style scoped>
@reference "tailwindcss";
.claude-accounts { @apply rounded-lg border p-2; background: var(--surface-soft); border-color: var(--border-subtle); color: var(--text-primary); }
header { @apply mb-2 flex justify-between gap-2 text-[11px] font-medium uppercase; }
header span { @apply text-[10px] font-normal normal-case; color: var(--text-muted); }
.account-label { @apply mb-1 block text-[10px]; }
select { @apply min-w-0 rounded-md border px-1.5 py-1.5 text-[11px] disabled:opacity-50; max-width: 100%; background: var(--surface-primary); border-color: var(--border-subtle); }
#claude-active-account { @apply w-full; }
.auto-row { @apply my-2 flex items-center gap-1.5 text-[10px]; }
.auto-row select { @apply ml-auto; }
input { @apply shrink-0; }
p { @apply m-0 text-[10px] leading-4; color: var(--text-muted); }
.account-actions { @apply my-2 flex flex-wrap gap-1.5; }
button { @apply rounded-md border px-2 py-1.5 text-[10px] font-medium disabled:opacity-50; background: var(--surface-primary); border-color: var(--border-subtle); }
button:hover { background: var(--surface-hover); }
.account-notice { @apply mt-1; }
.account-usage { @apply mt-2 text-[10px]; }
summary { @apply cursor-pointer; }
.saved-account { @apply mt-2 border-t pt-2; border-color: var(--border-soft); }
.saved-account strong { @apply block break-all font-medium; }
.saved-account-header { @apply flex flex-wrap items-center justify-between gap-1; }
.saved-account-header strong { @apply min-w-0 flex-1; }
.saved-account-header button { @apply shrink-0; }
.saved-account-header.is-confirming { @apply justify-start; }
.saved-account-header.is-confirming strong { @apply basis-full; }
.poll-note { @apply mt-1; }
.saved-account > span { @apply block; color: var(--text-muted); }
.limit { @apply mt-1; }
.limit span { color: var(--text-muted); }
progress { @apply block h-1.5 w-full overflow-hidden rounded-full; }
progress::-webkit-progress-bar { background: var(--surface-muted); }
progress::-webkit-progress-value { background: var(--text-secondary); }
progress::-moz-progress-bar { background: var(--text-secondary); }
</style>
