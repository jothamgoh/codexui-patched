<template>
  <div class="provider-status-stack">
    <section class="provider-accounts" aria-label="AI provider accounts">
      <header class="provider-accounts-header">
        <p>Accounts</p>
        <button type="button" :disabled="isRefreshing" title="Refresh accounts" @click="void refresh(true)">
          <IconTablerRefresh :class="{ 'is-spinning': isRefreshing }" />
        </button>
      </header>

      <div v-for="provider in providerRows" :key="provider.id" class="provider-row">
        <span class="provider-dot" :class="{ 'is-connected': provider.connected }" />
        <div class="provider-copy">
          <strong>{{ provider.label }}</strong>
          <span>{{ providerMeta(provider) }}</span>
        </div>
        <button
          v-if="provider.connected"
          class="provider-action"
          type="button"
          :disabled="busyProvider === provider.id"
          @click="void onLogout(provider.id)"
        >
          {{ logoutConfirm === provider.id ? 'Confirm' : 'Sign out' }}
        </button>
        <button
          v-else
          class="provider-action"
          type="button"
          :disabled="busyProvider === provider.id"
          @click="void onLogin(provider.id)"
        >
          Sign in
        </button>
      </div>

      <form v-if="pendingClaudeLogin" class="claude-login" aria-label="Finish adding Claude account" @submit.prevent="void finishClaudeLogin()">
        <strong>Finish adding the Claude account</strong>
        <p>Sign in on the Claude page. Copy the authorization code it shows, return to CodexUI, and paste it below. Use a private window if Claude opens the account already saved here.</p>
        <label for="claude-authorization-code">Paste Claude authorization code</label>
        <input id="claude-authorization-code" v-model="claudeCode" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" placeholder="Paste code from Claude here">
        <div class="claude-login-actions">
          <a :href="pendingClaudeLogin.authUrl" target="_blank" rel="noopener noreferrer">Open Claude sign-in</a>
          <button type="submit" :disabled="!claudeCode.trim() || busyProvider === 'claude'">Save account</button>
          <button type="button" :disabled="busyProvider === 'claude'" @click="void cancelClaudeLogin()">Cancel</button>
        </div>
      </form>

      <p v-if="errorMessage" class="provider-error" role="alert">{{ errorMessage }}</p>
    </section>

    <ClaudeAccountControls
      :pool="claudeAccounts"
      :disabled="isAccountBusy || isRefreshing || busyProvider === 'claude' || Boolean(pendingClaudeLogin)"
      :connected="Boolean(statuses?.claude.connected)"
      @switch="(number) => void updateClaudeAccounts(() => switchClaudeAccount(number))"
      @configure="(enabled, threshold) => void updateClaudeAccounts(() => configureClaudeAccounts(enabled, threshold))"
      @save="void updateClaudeAccounts(saveClaudeAccount)"
      @remove="(number) => void updateClaudeAccounts(() => removeClaudeAccount(number))"
      @add="void onLogin('claude')"
    />

    <section v-if="statuses?.claude.connected" class="claude-usage" aria-label="Claude usage remaining">
      <header class="claude-usage-header">
        <div>
          <p>Claude usage</p>
          <span v-if="claudeUsage?.plan">{{ formatPlan(claudeUsage.plan) }}</span>
        </div>
        <button type="button" :disabled="isUsageRefreshing" title="Refresh Claude usage" @click="void refreshClaudeUsage(true)">
          <IconTablerRefresh :class="{ 'is-spinning': isUsageRefreshing }" />
        </button>
      </header>
      <div v-if="claudeUsage?.limits.length" class="claude-limit-list">
        <div v-for="limit in claudeUsage.limits" :key="limit.key" class="claude-limit-row">
          <div class="claude-limit-copy">
            <strong>{{ limit.label }}</strong>
            <span>{{ remainingLabel(limit.usedPercent) }}<template v-if="limit.resetsAt"> · {{ resetLabel(limit.resetsAt) }}</template></span>
          </div>
          <progress max="100" :value="remainingPercent(limit.usedPercent)" :aria-label="`${limit.label} usage remaining`" />
        </div>
      </div>
      <p v-else class="provider-note">{{ claudeUsage?.notice || 'Claude usage is not available for this login method.' }}</p>
      <p v-if="claudeUsage?.limits.length && claudeUsage.notice" class="provider-note">{{ claudeUsage.notice }}</p>
    </section>

    <RateLimitsSummary
      v-if="statuses?.codex.connected"
      provider-label="Codex"
      :rate-limits="rateLimits"
      :refresh-rate-limits="refreshRateLimits"
      :use-rate-limit-reset="useRateLimitReset"
      :is-using-rate-limit-reset="isUsingRateLimitReset"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AccountRateLimitsState } from '../../api/codexGateway'
import {
  completeClaudeLogin,
  cancelClaudeProviderLogin,
  configureClaudeAccounts,
  getClaudeAccounts,
  getClaudeUsage,
  getProviderStatuses,
  logoutProvider,
  startProviderLogin,
  saveClaudeAccount,
  removeClaudeAccount,
  switchClaudeAccount,
  type ClaudeUsage,
  type ProviderId,
  type ProviderLogin,
  type ProviderStatus,
  type ProviderStatuses,
} from '../../api/providerAccounts'
import IconTablerRefresh from '../icons/IconTablerRefresh.vue'
import RateLimitsSummary from './RateLimitsSummary.vue'
import ClaudeAccountControls from './ClaudeAccountControls.vue'
import type { ClaudeAccountPool } from '../../types/claudeAccounts'

const props = defineProps<{
  rateLimits: AccountRateLimitsState | null
  refreshRateLimits?: () => Promise<void> | void
  useRateLimitReset?: () => Promise<void> | void
  isUsingRateLimitReset?: boolean
}>()

const emit = defineEmits<{ 'providers-changed': [] }>()
const statuses = ref<ProviderStatuses | null>(null)
const claudeUsage = ref<ClaudeUsage | null>(null)
const pendingClaudeLogin = ref<ProviderLogin | null>(null)
const claudeCode = ref('')
const isRefreshing = ref(false)
const isUsageRefreshing = ref(false)
const busyProvider = ref<ProviderId | ''>('')
const logoutConfirm = ref<ProviderId | ''>('')
const errorMessage = ref('')
const claudeAccounts = ref<ClaudeAccountPool | null>(null)
const isAccountBusy = ref(false)
let accountPoll: ReturnType<typeof setInterval> | null = null
let isAccountPolling = false
let codexLoginPoll: ReturnType<typeof setInterval> | null = null

const providerRows = computed<ProviderStatus[]>(() => statuses.value
  ? [statuses.value.claude, statuses.value.codex]
  : [
      { id: 'claude', label: 'Claude', connected: false, email: null, organization: null, plan: null, authMethod: null, apiProvider: null },
      { id: 'codex', label: 'Codex', connected: false, email: null, organization: null, plan: null, authMethod: null, apiProvider: null },
    ])

onMounted(() => {
  void refresh()
  accountPoll = setInterval(() => { void pollClaudeAccounts() }, 15_000)
})
onBeforeUnmount(() => {
  stopCodexLoginPoll()
  if (accountPoll) clearInterval(accountPoll)
})

async function pollClaudeAccounts(): Promise<void> {
  if (isAccountPolling || isAccountBusy.value || busyProvider.value === 'claude') return
  isAccountPolling = true
  try {
    const next = await getClaudeAccounts()
    const changed = claudeAccounts.value && next.activeAccountNumber !== claudeAccounts.value.activeAccountNumber
    claudeAccounts.value = next
    if (changed) { await refresh(true); emit('providers-changed') }
  } catch { /* A transient poll failure is retried on the next interval. */ }
  finally { isAccountPolling = false }
}

async function updateClaudeAccounts(action: () => Promise<ClaudeAccountPool>): Promise<void> {
  isAccountBusy.value = true
  errorMessage.value = ''
  try {
    claudeAccounts.value = await action()
    await refresh(true)
    emit('providers-changed')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not update Claude accounts.'
  } finally { isAccountBusy.value = false }
}

async function refresh(force = false): Promise<void> {
  if (isRefreshing.value) return
  isRefreshing.value = true
  errorMessage.value = ''
  try {
    const [providers, accounts] = await Promise.all([getProviderStatuses(force), getClaudeAccounts(force)])
    statuses.value = providers
    claudeAccounts.value = accounts
    if (statuses.value.claude.connected) await refreshClaudeUsage(force)
    else claudeUsage.value = null
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not read provider accounts.'
  } finally {
    isRefreshing.value = false
  }
}

async function refreshClaudeUsage(force = false): Promise<void> {
  if (isUsageRefreshing.value || !statuses.value?.claude.connected) return
  isUsageRefreshing.value = true
  try {
    claudeUsage.value = await getClaudeUsage(force)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not read Claude usage.'
  } finally {
    isUsageRefreshing.value = false
  }
}

async function onLogin(provider: ProviderId): Promise<void> {
  busyProvider.value = provider
  errorMessage.value = ''
  logoutConfirm.value = ''
  // Open synchronously while the click still carries a user gesture. Browsers
  // otherwise block the OAuth tab because the URL arrives after an API await.
  const authWindow = window.open('about:blank', '_blank')
  if (authWindow) authWindow.opener = null
  try {
    const login = await startProviderLogin(provider)
    if (authWindow) authWindow.location.replace(login.authUrl)
    if (provider === 'claude') {
      pendingClaudeLogin.value = login
      claudeCode.value = ''
    } else {
      startCodexLoginPoll()
    }
  } catch (error) {
    authWindow?.close()
    errorMessage.value = error instanceof Error ? error.message : `Could not start ${provider} login.`
  } finally {
    busyProvider.value = ''
  }
}

async function finishClaudeLogin(): Promise<void> {
  const login = pendingClaudeLogin.value
  const code = claudeCode.value.trim()
  if (!login || !code) return
  busyProvider.value = 'claude'
  errorMessage.value = ''
  try {
    const status = await completeClaudeLogin(login.loginId, code)
    clearClaudeLogin()
    await refresh(true)
    if (status.notice) errorMessage.value = status.notice
    emit('providers-changed')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not complete Claude login.'
  } finally {
    busyProvider.value = ''
  }
}

async function onLogout(provider: ProviderId): Promise<void> {
  if (logoutConfirm.value !== provider) {
    logoutConfirm.value = provider
    return
  }
  busyProvider.value = provider
  errorMessage.value = ''
  try {
    await logoutProvider(provider)
    if (provider === 'claude') clearClaudeLogin()
    await refresh(true)
    emit('providers-changed')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : `Could not sign out of ${provider}.`
  } finally {
    busyProvider.value = ''
    logoutConfirm.value = ''
  }
}

function startCodexLoginPoll(): void {
  stopCodexLoginPoll()
  let attempts = 0
  codexLoginPoll = setInterval(() => {
    attempts += 1
    void getProviderStatuses(true).then((next) => {
      statuses.value = next
      if (next.codex.connected) {
        stopCodexLoginPoll()
        emit('providers-changed')
        void props.refreshRateLimits?.()
      } else if (attempts >= 60) {
        stopCodexLoginPoll()
        errorMessage.value = 'Codex sign-in is still pending. Refresh after completing it.'
      }
    }).catch(() => {})
  }, 2_000)
}

function stopCodexLoginPoll(): void {
  if (codexLoginPoll) clearInterval(codexLoginPoll)
  codexLoginPoll = null
}

function clearClaudeLogin(): void {
  pendingClaudeLogin.value = null
  claudeCode.value = ''
}

async function cancelClaudeLogin(): Promise<void> {
  busyProvider.value = 'claude'
  try { await cancelClaudeProviderLogin(); clearClaudeLogin(); await refresh(true) }
  catch (error) { errorMessage.value = error instanceof Error ? error.message : 'Could not cancel Claude sign-in.' }
  finally { busyProvider.value = '' }
}

function providerMeta(provider: ProviderStatus): string {
  if (provider.notice) return provider.notice
  if (!provider.connected) return 'Not signed in'
  return [provider.email, provider.plan ? formatPlan(provider.plan) : '', provider.organization].filter(Boolean).join(' · ') || 'Connected'
}

function formatPlan(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase())
}

function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - Math.round(usedPercent)))
}

function remainingLabel(usedPercent: number): string {
  return `${String(remainingPercent(usedPercent))}% left`
}

function resetLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `resets ${date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}
</script>

<style scoped>
@reference "tailwindcss";

.provider-status-stack { @apply flex flex-col gap-2; }
.provider-accounts,
.claude-usage { @apply rounded-lg border p-2; background: var(--surface-soft); border-color: var(--border-subtle); color: var(--text-primary); }
.provider-accounts-header,
.claude-usage-header { @apply mb-1.5 flex items-start justify-between gap-2; }
.provider-accounts-header p,
.claude-usage-header p { @apply m-0 text-[11px] leading-4 font-medium uppercase; }
.provider-accounts-header button,
.claude-usage-header button { @apply inline-flex h-5 w-5 items-center justify-center rounded-md disabled:opacity-50; color: var(--text-muted); }
.provider-accounts-header button:hover,
.claude-usage-header button:hover { background: var(--surface-hover); color: var(--text-primary); }
.provider-accounts-header svg,
.claude-usage-header svg { @apply h-3.5 w-3.5; }
.is-spinning { animation: provider-spin 800ms linear infinite; }
@keyframes provider-spin { to { transform: rotate(360deg); } }
.provider-row { @apply flex items-center gap-2 border-t py-1.5 first:border-t-0; border-color: var(--border-soft); }
.provider-dot { @apply h-2 w-2 shrink-0 rounded-full; background: var(--text-faint); }
.provider-dot.is-connected { background: #22c55e; }
.provider-copy { @apply flex min-w-0 flex-1 flex-col; }
.provider-copy strong { @apply text-[11px] leading-4 font-medium; }
.provider-copy span { @apply truncate text-[10px] leading-4; color: var(--text-muted); }
.provider-action,
.claude-login button { @apply shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium disabled:opacity-50; border-color: var(--border-subtle); background: var(--surface-primary); }
.provider-action:hover,
.claude-login button:hover { background: var(--surface-hover); }
.claude-login { @apply mt-1.5 border-t pt-2; border-color: var(--border-soft); }
.claude-login > strong { @apply block text-[11px] leading-4 font-medium; }
.claude-login p,
.provider-error,
.provider-note { @apply m-0 text-[10px] leading-4; color: var(--text-muted); }
.claude-login p { @apply mt-1; }
.claude-login label { @apply mt-2 block text-[10px] font-medium; }
.claude-login input { @apply mt-1.5 w-full rounded-md border px-2 py-1.5 text-[11px] outline-none; border-color: var(--border-subtle); background: var(--surface-primary); }
.claude-login-actions { @apply mt-1.5 flex flex-wrap items-center gap-1.5; }
.claude-login-actions a { @apply mr-auto text-[10px] underline; color: var(--text-secondary); }
.provider-error { @apply mt-1.5; color: var(--destructive); }
.claude-usage-header span { @apply text-[10px]; color: var(--text-muted); }
.claude-limit-row + .claude-limit-row { @apply mt-1.5 border-t pt-1.5; border-color: var(--border-soft); }
.claude-limit-copy { @apply flex items-start justify-between gap-2; }
.claude-limit-copy strong { @apply text-[11px] leading-4 font-medium; }
.claude-limit-copy span { @apply text-right text-[10px] leading-4; color: var(--text-muted); }
.claude-limit-row progress { @apply mt-1 h-1.5 w-full overflow-hidden rounded-full; }
.claude-limit-row progress::-webkit-progress-bar { background: var(--surface-muted); }
.claude-limit-row progress::-webkit-progress-value { background: var(--text-secondary); }
.claude-limit-row progress::-moz-progress-bar { background: var(--text-secondary); }
</style>
