<template>
  <div class="mcp-hub">
    <div class="mcp-hub-header">
      <div>
        <h2 class="mcp-hub-title">MCP Servers</h2>
        <p class="mcp-hub-subtitle">Toggle Codex integrations, reload them, and inspect auth/runtime status.</p>
      </div>

      <div class="mcp-hub-actions">
        <button class="mcp-hub-button" type="button" :disabled="isBusy" @click="void refreshServers()">
          Refresh
        </button>
        <button class="mcp-hub-button mcp-hub-button-primary" type="button" :disabled="isBusy" @click="void reloadServers()">
          <IconTablerRefresh class="mcp-hub-button-icon" />
          Reload MCPs
        </button>
      </div>
    </div>

    <div class="mcp-hub-summary">
      <div class="mcp-hub-stat">
        <span class="mcp-hub-stat-value">{{ enabledCount }}</span>
        <span class="mcp-hub-stat-label">enabled</span>
      </div>
      <div class="mcp-hub-stat">
        <span class="mcp-hub-stat-value">{{ connectedCount }}</span>
        <span class="mcp-hub-stat-label">authenticated</span>
      </div>
      <div class="mcp-hub-stat">
        <span class="mcp-hub-stat-value">{{ totalTools }}</span>
        <span class="mcp-hub-stat-label">tools exposed</span>
      </div>
    </div>

    <p class="mcp-hub-note">
      Toggles write to your Codex MCP config and then reload the app-server MCP registry.
    </p>

    <div v-if="toast" class="mcp-hub-toast" :class="{ 'is-error': toast.type === 'error' }">
      {{ toast.text }}
    </div>

    <div v-if="isLoading" class="mcp-hub-empty">Loading MCP servers...</div>
    <div v-else-if="error" class="mcp-hub-empty mcp-hub-empty-error">{{ error }}</div>
    <div v-else-if="servers.length === 0" class="mcp-hub-empty">No MCP servers are configured.</div>

    <div v-else class="mcp-hub-grid">
      <article v-for="server in servers" :key="server.name" class="mcp-card">
        <div class="mcp-card-top">
          <div class="mcp-card-heading">
            <h3 class="mcp-card-title">{{ server.name }}</h3>
            <div class="mcp-card-badges">
              <span class="mcp-card-badge" :class="server.enabled ? 'is-enabled' : 'is-disabled'">
                {{ server.enabled ? 'Enabled' : 'Disabled' }}
              </span>
              <span class="mcp-card-badge" :class="authBadgeClass(server.authStatus)">
                {{ authBadgeLabel(server.authStatus) }}
              </span>
              <span class="mcp-card-badge">
                {{ transportLabel(server.transportType) }}
              </span>
            </div>
          </div>

          <label class="mcp-switch">
            <input
              :checked="server.enabled"
              type="checkbox"
              role="switch"
              :disabled="isBusyFor(server.name)"
              @change="void toggleServer(server.name, $event)"
            />
            <span class="mcp-switch-ui" />
          </label>
        </div>

        <dl class="mcp-card-meta">
          <div class="mcp-card-meta-row">
            <dt>Tools</dt>
            <dd>{{ server.toolCount }}</dd>
          </div>
          <div class="mcp-card-meta-row">
            <dt>Resources</dt>
            <dd>{{ server.resourceCount }}</dd>
          </div>
          <div class="mcp-card-meta-row">
            <dt>Templates</dt>
            <dd>{{ server.resourceTemplateCount }}</dd>
          </div>
        </dl>

        <p v-if="server.url" class="mcp-card-path">{{ server.url }}</p>
        <p v-else-if="server.command" class="mcp-card-path">
          {{ [server.command, ...server.args].join(' ') }}
        </p>
        <p v-else class="mcp-card-path mcp-card-path-muted">No transport details exposed in config.</p>

        <p v-if="server.bearerTokenEnvVar" class="mcp-card-detail">
          Token env: <code>{{ server.bearerTokenEnvVar }}</code>
        </p>
        <p v-if="server.envKeys.length > 0" class="mcp-card-detail">
          Env keys: <code>{{ server.envKeys.join(', ') }}</code>
        </p>
        <p v-if="server.toolNames.length > 0" class="mcp-card-detail">
          Tools: <code>{{ server.toolNames.join(', ') }}</code>
        </p>

        <div class="mcp-card-actions">
          <button class="mcp-hub-button" type="button" :disabled="isBusy" @click="void reloadServers()">
            Reload
          </button>
          <button
            v-if="server.authStatus === 'notLoggedIn'"
            class="mcp-hub-button mcp-hub-button-primary"
            type="button"
            :disabled="isBusyFor(server.name)"
            @click="void loginServer(server.name)"
          >
            Sign in
          </button>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  getMcpServers,
  reloadMcpServers,
  setMcpServerEnabled,
  startMcpServerOauthLogin,
  type McpServerRecord,
} from '../../api/codexGateway'
import IconTablerRefresh from '../icons/IconTablerRefresh.vue'

const servers = ref<McpServerRecord[]>([])
const isLoading = ref(false)
const error = ref('')
const busyTarget = ref('')
const toast = ref<{ text: string; type: 'success' | 'error' } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

const enabledCount = computed(() => servers.value.filter((server) => server.enabled).length)
const connectedCount = computed(() =>
  servers.value.filter((server) => server.authStatus === 'oAuth' || server.authStatus === 'bearerToken').length,
)
const totalTools = computed(() => servers.value.reduce((sum, server) => sum + server.toolCount, 0))
const isBusy = computed(() => busyTarget.value.length > 0)

function showToast(text: string, type: 'success' | 'error' = 'success'): void {
  toast.value = { text, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 3000)
}

function isBusyFor(name: string): boolean {
  return busyTarget.value === name || busyTarget.value === '__all__'
}

function authBadgeLabel(status: McpServerRecord['authStatus']): string {
  switch (status) {
    case 'oAuth':
      return 'OAuth ready'
    case 'bearerToken':
      return 'Token ready'
    case 'notLoggedIn':
      return 'Sign-in needed'
    case 'unsupported':
      return 'No auth'
    default:
      return 'Not loaded'
  }
}

function authBadgeClass(status: McpServerRecord['authStatus']): string {
  switch (status) {
    case 'oAuth':
    case 'bearerToken':
      return 'is-auth-ready'
    case 'notLoggedIn':
      return 'is-auth-pending'
    case 'unsupported':
      return 'is-auth-neutral'
    default:
      return 'is-auth-unknown'
  }
}

function transportLabel(transportType: McpServerRecord['transportType']): string {
  if (transportType === 'remote') return 'Remote'
  if (transportType === 'local') return 'Local'
  return 'Unknown'
}

async function refreshServers(): Promise<void> {
  isLoading.value = true
  error.value = ''
  try {
    servers.value = await getMcpServers()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Failed to load MCP servers'
  } finally {
    isLoading.value = false
  }
}

async function reloadServers(): Promise<void> {
  busyTarget.value = '__all__'
  error.value = ''
  try {
    await reloadMcpServers()
    servers.value = await getMcpServers()
    showToast('MCP servers reloaded.')
  } catch (caught) {
    showToast(caught instanceof Error ? caught.message : 'Failed to reload MCP servers', 'error')
  } finally {
    busyTarget.value = ''
  }
}

async function toggleServer(name: string, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null
  const nextChecked = input?.checked === true
  busyTarget.value = name
  error.value = ''
  try {
    servers.value = await setMcpServerEnabled(name, nextChecked)
    showToast(`${name} ${nextChecked ? 'enabled' : 'disabled'}.`)
  } catch (caught) {
    showToast(caught instanceof Error ? caught.message : `Failed to update ${name}`, 'error')
    await refreshServers()
  } finally {
    busyTarget.value = ''
  }
}

async function loginServer(name: string): Promise<void> {
  busyTarget.value = name
  error.value = ''
  try {
    const authorizationUrl = await startMcpServerOauthLogin(name)
    if (authorizationUrl) {
      window.open(authorizationUrl, '_blank', 'noopener,noreferrer')
      showToast(`Opened sign-in flow for ${name}.`)
    } else {
      showToast(`No authorization URL returned for ${name}.`, 'error')
    }
    servers.value = await getMcpServers()
  } catch (caught) {
    showToast(caught instanceof Error ? caught.message : `Failed to start sign-in for ${name}`, 'error')
  } finally {
    busyTarget.value = ''
  }
}

onMounted(() => {
  void refreshServers()
})
</script>

<style scoped>
@reference "tailwindcss";

.mcp-hub {
  @apply flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 sm:px-6;
}

.mcp-hub-header {
  @apply flex flex-col gap-3 border-b border-zinc-200 pb-4 lg:flex-row lg:items-end lg:justify-between;
}

.mcp-hub-title {
  @apply m-0 text-xl font-semibold tracking-tight text-zinc-950 sm:text-2xl;
}

.mcp-hub-subtitle {
  @apply mt-1 text-sm text-zinc-500;
}

.mcp-hub-actions {
  @apply flex w-full flex-wrap items-center gap-2 lg:w-auto;
}

.mcp-hub-button {
  @apply inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition hover:border-zinc-400 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50;
}

.mcp-hub-button-primary {
  @apply border-emerald-700 bg-emerald-700 text-white hover:border-emerald-800 hover:bg-emerald-800 hover:text-white;
}

.mcp-hub-button-icon {
  @apply h-4 w-4;
}

.mcp-hub-summary {
  @apply grid grid-cols-2 gap-2 sm:grid-cols-3;
}

.mcp-hub-stat {
  @apply rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-3 sm:px-4;
}

.mcp-hub-stat-value {
  @apply block text-2xl font-semibold text-zinc-950;
}

.mcp-hub-stat-label {
  @apply mt-1 block text-sm text-zinc-500;
}

.mcp-hub-note {
  @apply m-0 text-sm text-zinc-500;
}

.mcp-hub-toast {
  @apply rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800;
}

.mcp-hub-toast.is-error {
  @apply border-rose-200 bg-rose-50 text-rose-700;
}

.mcp-hub-empty {
  @apply rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-8 text-center text-sm text-zinc-500;
}

.mcp-hub-empty-error {
  @apply border-rose-200 bg-rose-50 text-rose-700;
}

.mcp-hub-grid {
  @apply grid gap-3 xl:grid-cols-2;
}

.mcp-card {
  @apply min-w-0 rounded-3xl border border-zinc-200 bg-white p-3 shadow-sm sm:p-4;
}

.mcp-card-top {
  @apply flex flex-wrap items-start justify-between gap-3;
}

.mcp-card-heading {
  @apply min-w-0 flex-1;
}

.mcp-card-title {
  @apply m-0 truncate text-lg font-semibold text-zinc-950;
}

.mcp-card-badges {
  @apply mt-2 flex flex-wrap gap-2;
}

.mcp-card-badge {
  @apply inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-medium text-zinc-600;
}

.mcp-card-badge.is-enabled {
  @apply border-emerald-200 bg-emerald-50 text-emerald-700;
}

.mcp-card-badge.is-disabled {
  @apply border-zinc-200 bg-zinc-100 text-zinc-500;
}

.mcp-card-badge.is-auth-ready {
  @apply border-sky-200 bg-sky-50 text-sky-700;
}

.mcp-card-badge.is-auth-pending {
  @apply border-amber-200 bg-amber-50 text-amber-700;
}

.mcp-card-badge.is-auth-neutral,
.mcp-card-badge.is-auth-unknown {
  @apply border-zinc-200 bg-zinc-50 text-zinc-600;
}

.mcp-switch {
  @apply relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center;
}

.mcp-switch input {
  @apply sr-only;
}

.mcp-switch-ui {
  @apply relative block h-7 w-12 rounded-full bg-zinc-300 transition;
}

.mcp-switch-ui::after {
  content: '';
  @apply absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition;
}

.mcp-switch input:checked + .mcp-switch-ui {
  @apply bg-emerald-600;
}

.mcp-switch input:checked + .mcp-switch-ui::after {
  transform: translateX(20px);
}

.mcp-switch input:disabled + .mcp-switch-ui {
  @apply opacity-50;
}

.mcp-card-meta {
  @apply mt-4 grid grid-cols-2 gap-2 rounded-2xl bg-zinc-50 p-3 sm:grid-cols-3;
}

.mcp-card-meta-row {
  @apply min-w-0;
}

.mcp-card-meta-row dt {
  @apply text-xs uppercase tracking-wide text-zinc-400;
}

.mcp-card-meta-row dd {
  @apply mt-1 text-sm font-medium text-zinc-800;
}

.mcp-card-path {
  @apply mt-4 max-w-full overflow-x-auto rounded-2xl bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 whitespace-nowrap;
}

.mcp-card-path-muted {
  @apply bg-zinc-100 text-zinc-500;
}

.mcp-card-detail {
  @apply mt-2 break-words text-sm text-zinc-600;
}

.mcp-card-detail code {
  @apply break-all rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[12px] text-zinc-800;
}

.mcp-card-actions {
  @apply mt-4 flex flex-wrap gap-2;
}

.mcp-hub-actions .mcp-hub-button {
  @apply flex-1 sm:flex-none;
}

.mcp-card-actions .mcp-hub-button {
  @apply flex-1 sm:flex-none;
}
</style>
