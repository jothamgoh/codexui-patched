<template>
  <div class="plugins-hub">
    <div class="plugins-hub-header">
      <div>
        <h2 class="plugins-hub-title">Plugins</h2>
        <p class="plugins-hub-subtitle">
          Add or remove plugins shared with the ChatGPT and Codex desktop experience.
        </p>
      </div>
      <button class="plugins-hub-button" type="button" :disabled="isBusy" @click="void refreshCatalog(true)">
        <RefreshCw class="plugins-hub-button-icon" aria-hidden="true" />
        Refresh
      </button>
    </div>

    <div class="plugins-hub-summary">
      <div class="plugins-hub-stat">
        <span class="plugins-hub-stat-value">{{ installedCount }}</span>
        <span class="plugins-hub-stat-label">installed</span>
      </div>
      <div class="plugins-hub-stat">
        <span class="plugins-hub-stat-value">{{ enabledCount }}</span>
        <span class="plugins-hub-stat-label">ready to use</span>
      </div>
      <div class="plugins-hub-stat">
        <span class="plugins-hub-stat-value">{{ numberFormatter.format(plugins.length) }}</span>
        <span class="plugins-hub-stat-label">in catalog</span>
      </div>
    </div>

    <label class="plugins-hub-search">
      <Search class="plugins-hub-search-icon" aria-hidden="true" />
      <input
        v-model="query"
        type="search"
        placeholder="Search plugins..."
        aria-label="Search plugins"
      />
      <span v-if="query.trim()" class="plugins-hub-search-count">
        {{ filteredAvailablePlugins.length }} found
      </span>
    </label>

    <div v-if="toast" class="plugins-hub-toast" :class="{ 'is-error': toast.type === 'error' }" role="status">
      {{ toast.text }}
    </div>

    <div v-if="loadErrors.length > 0" class="plugins-hub-warning">
      <strong>Some marketplaces could not be loaded.</strong>
      <span>{{ loadErrors[0]?.message }}</span>
    </div>

    <div v-if="isLoading && plugins.length === 0" class="plugins-hub-empty">Loading plugins...</div>
    <div v-else-if="error && plugins.length === 0" class="plugins-hub-empty is-error">
      {{ error }}
    </div>
    <div v-else class="plugins-hub-sections">
      <section v-for="section in sections" :key="section.id" class="plugins-hub-section">
        <div class="plugins-hub-section-header">
          <div>
            <h3>{{ section.title }}</h3>
            <p>{{ section.description }}</p>
          </div>
          <span>{{ section.plugins.length }}</span>
        </div>

        <div v-if="section.plugins.length > 0" class="plugins-hub-grid">
          <article v-for="plugin in section.plugins" :key="plugin.id" class="plugins-hub-card">
            <div class="plugins-hub-card-heading">
              <span class="plugins-hub-card-icon" aria-hidden="true">
                <Blocks />
              </span>
              <div class="plugins-hub-card-title-wrap">
                <h4>{{ plugin.displayName }}</h4>
                <p v-if="plugin.developerName">{{ plugin.developerName }}</p>
              </div>
              <span class="plugins-hub-status" :class="pluginStatusClass(plugin)">
                {{ pluginStatusLabel(plugin) }}
              </span>
            </div>

            <p class="plugins-hub-card-description">
              {{ plugin.description || plugin.longDescription || 'No description provided.' }}
            </p>

            <div class="plugins-hub-card-meta">
              <span v-if="plugin.category">{{ plugin.category }}</span>
              <span v-if="plugin.capabilities.length > 0">{{ plugin.capabilities.slice(0, 3).join(' · ') }}</span>
              <span v-if="plugin.version">v{{ plugin.version }}</span>
            </div>

            <div class="plugins-hub-card-actions">
              <button
                class="plugins-hub-details-button"
                type="button"
                @click="openPluginDetails(plugin)"
              >
                View details
              </button>
              <button
                v-if="!plugin.installed"
                class="plugins-hub-button plugins-hub-button-primary"
                type="button"
                :disabled="isBusy || !canInstall(plugin)"
                @click="void addPlugin(plugin)"
              >
                {{ isBusyFor(plugin.id, 'install') ? 'Adding...' : installButtonLabel(plugin) }}
              </button>
              <button
                v-else-if="canRemove(plugin)"
                class="plugins-hub-button plugins-hub-button-danger"
                type="button"
                :disabled="isBusy"
                @click="void removePlugin(plugin)"
              >
                <Trash2 class="plugins-hub-button-icon" aria-hidden="true" />
                {{ isBusyFor(plugin.id, 'uninstall') ? 'Removing...' : 'Remove' }}
              </button>
              <span v-else class="plugins-hub-managed-label">
                <Check aria-hidden="true" />
                Managed installation
              </span>
            </div>
          </article>
        </div>
        <div v-else class="plugins-hub-empty plugins-hub-empty-compact">
          {{ section.emptyText }}
        </div>
      </section>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="detailPlugin"
      class="plugins-hub-modal-backdrop"
      role="presentation"
      @mousedown.self="closePluginDetails"
    >
      <section
        class="plugins-hub-modal"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="`plugin-detail-${detailPlugin.id}`"
      >
        <div class="plugins-hub-modal-header">
          <span class="plugins-hub-modal-icon" aria-hidden="true"><Blocks /></span>
          <div class="plugins-hub-modal-title-wrap">
            <h2 :id="`plugin-detail-${detailPlugin.id}`">{{ detailPlugin.displayName }}</h2>
            <p>{{ detailPlugin.developerName || detailPlugin.marketplaceName }}</p>
          </div>
          <button
            class="plugins-hub-modal-close"
            type="button"
            aria-label="Close plugin details"
            @click="closePluginDetails"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div class="plugins-hub-modal-content">
          <p class="plugins-hub-modal-description">
            {{ detailPlugin.longDescription || detailPlugin.description || 'No description provided.' }}
          </p>

          <dl class="plugins-hub-modal-facts">
            <div>
              <dt>Status</dt>
              <dd>{{ pluginStatusLabel(detailPlugin) }}</dd>
            </div>
            <div v-if="detailPlugin.category">
              <dt>Category</dt>
              <dd>{{ detailPlugin.category }}</dd>
            </div>
            <div>
              <dt>Marketplace</dt>
              <dd>{{ detailPlugin.marketplaceName }}</dd>
            </div>
            <div v-if="detailPlugin.version">
              <dt>Version</dt>
              <dd>{{ detailPlugin.version }}</dd>
            </div>
            <div>
              <dt>Connection</dt>
              <dd>{{ detailPlugin.authPolicy === 'ON_INSTALL' ? 'Connect when added' : 'Connect when first used' }}</dd>
            </div>
            <div v-if="detailPlugin.sourceType">
              <dt>Source</dt>
              <dd>{{ detailPlugin.sourceType }}</dd>
            </div>
          </dl>

          <div v-if="detailPlugin.capabilities.length > 0" class="plugins-hub-modal-capabilities">
            <h3>Capabilities</h3>
            <div>
              <span v-for="capability in detailPlugin.capabilities" :key="capability">{{ capability }}</span>
            </div>
          </div>

          <div class="plugins-hub-modal-identifier">
            <span>Plugin ID</span>
            <code>{{ detailPlugin.id }}</code>
          </div>
        </div>

        <div class="plugins-hub-modal-actions">
          <button class="plugins-hub-button" type="button" @click="closePluginDetails">Close</button>
          <button
            v-if="!detailPlugin.installed"
            class="plugins-hub-button plugins-hub-button-primary"
            type="button"
            :disabled="isBusy || !canInstall(detailPlugin)"
            @click="void addPlugin(detailPlugin)"
          >
            {{ isBusyFor(detailPlugin.id, 'install') ? 'Adding...' : installButtonLabel(detailPlugin) }}
          </button>
          <button
            v-else-if="canRemove(detailPlugin)"
            class="plugins-hub-button plugins-hub-button-danger"
            type="button"
            :disabled="isBusy"
            @click="void removePlugin(detailPlugin)"
          >
            <Trash2 class="plugins-hub-button-icon" aria-hidden="true" />
            {{ isBusyFor(detailPlugin.id, 'uninstall') ? 'Removing...' : 'Remove' }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Blocks, Check, RefreshCw, Search, Trash2, X } from '@lucide/vue'
import {
  getPluginCatalog,
  installPlugin,
  uninstallPlugin,
  type PluginCatalogItem,
} from '../../api/codexGateway'

const props = defineProps<{
  cwd?: string
}>()

const emit = defineEmits<{
  'plugins-changed': []
}>()

const numberFormatter = new Intl.NumberFormat()
const plugins = ref<PluginCatalogItem[]>([])
const loadErrors = ref<Array<{ marketplacePath: string; message: string }>>([])
const query = ref('')
const isLoading = ref(false)
const error = ref('')
const busyAction = ref<{ pluginId: string; action: 'install' | 'uninstall' } | null>(null)
const toast = ref<{ text: string; type: 'success' | 'error' } | null>(null)
const detailPlugin = ref<PluginCatalogItem | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

const installedPlugins = computed(() => plugins.value.filter((plugin) => plugin.installed))
const installedCount = computed(() => installedPlugins.value.length)
const enabledCount = computed(() => installedPlugins.value.filter((plugin) => plugin.enabled).length)
const filteredInstalledPlugins = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  if (!normalizedQuery) return installedPlugins.value
  return installedPlugins.value.filter((plugin) =>
    plugin.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || plugin.name.toLocaleLowerCase().includes(normalizedQuery)
      || plugin.description.toLocaleLowerCase().includes(normalizedQuery)
      || plugin.developerName.toLocaleLowerCase().includes(normalizedQuery),
  )
})
const filteredAvailablePlugins = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  const available = plugins.value.filter((plugin) => !plugin.installed)
  if (!normalizedQuery) return available.filter((plugin) => plugin.featured)
  return available
    .filter((plugin) =>
      plugin.displayName.toLocaleLowerCase().includes(normalizedQuery)
        || plugin.name.toLocaleLowerCase().includes(normalizedQuery)
        || plugin.description.toLocaleLowerCase().includes(normalizedQuery)
        || plugin.developerName.toLocaleLowerCase().includes(normalizedQuery)
        || plugin.category.toLocaleLowerCase().includes(normalizedQuery),
    )
    .slice(0, 100)
})
const isBusy = computed(() => busyAction.value !== null || isLoading.value)
const sections = computed(() => [
  {
    id: 'installed',
    title: 'Installed',
    description: 'These plugins are shared with the local desktop Codex runtime.',
    plugins: filteredInstalledPlugins.value,
    emptyText: query.value.trim() ? `No installed plugins found for "${query.value.trim()}".` : 'No plugins are installed.',
  },
  {
    id: 'available',
    title: query.value.trim() ? 'Search results' : 'Featured plugins',
    description: query.value.trim()
      ? 'Results from the full plugin catalog.'
      : 'Search to browse the full plugin catalog.',
    plugins: filteredAvailablePlugins.value,
    emptyText: query.value.trim() ? `No plugins found for "${query.value.trim()}".` : 'No featured plugins are available.',
  },
])

function showToast(text: string, type: 'success' | 'error' = 'success'): void {
  toast.value = { text, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 4000)
}

function canInstall(plugin: PluginCatalogItem): boolean {
  return !plugin.installed
    && plugin.availability === 'AVAILABLE'
    && plugin.installPolicy !== 'NOT_AVAILABLE'
}

function canRemove(plugin: PluginCatalogItem): boolean {
  return plugin.installed
    && plugin.installPolicy !== 'INSTALLED_BY_DEFAULT'
    && plugin.installPolicySource !== 'IMPLICIT_CANONICAL_APP'
}

function installButtonLabel(plugin: PluginCatalogItem): string {
  if (plugin.availability === 'DISABLED_BY_ADMIN') return 'Blocked by admin'
  if (plugin.installPolicy === 'NOT_AVAILABLE') return 'Unavailable'
  return 'Add'
}

function pluginStatusLabel(plugin: PluginCatalogItem): string {
  if (plugin.availability === 'DISABLED_BY_ADMIN') return 'Blocked'
  if (!plugin.installed) return 'Available'
  return plugin.enabled ? 'Ready' : 'Disabled'
}

function pluginStatusClass(plugin: PluginCatalogItem): string {
  if (plugin.availability === 'DISABLED_BY_ADMIN') return 'is-blocked'
  if (!plugin.installed) return 'is-available'
  return plugin.enabled ? 'is-ready' : 'is-disabled'
}

function isBusyFor(pluginId: string, action: 'install' | 'uninstall'): boolean {
  return busyAction.value?.pluginId === pluginId && busyAction.value.action === action
}

function openPluginDetails(plugin: PluginCatalogItem): void {
  detailPlugin.value = plugin
}

function closePluginDetails(): void {
  detailPlugin.value = null
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && detailPlugin.value) {
    closePluginDetails()
  }
}

async function refreshCatalog(forceRefetch = false): Promise<void> {
  isLoading.value = true
  error.value = ''
  try {
    const result = await getPluginCatalog(props.cwd, forceRefetch)
    plugins.value = result.plugins
    loadErrors.value = result.loadErrors
    if (detailPlugin.value) {
      detailPlugin.value = result.plugins.find((plugin) => plugin.id === detailPlugin.value?.id) ?? null
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Failed to load plugins'
  } finally {
    isLoading.value = false
  }
}

async function addPlugin(plugin: PluginCatalogItem): Promise<void> {
  if (!canInstall(plugin)) return
  busyAction.value = { pluginId: plugin.id, action: 'install' }
  try {
    const result = await installPlugin(plugin)
    await refreshCatalog()
    const suffix = result.appsNeedingAuth > 0
      ? ' You may be asked to connect it when first used.'
      : ''
    showToast(`${plugin.displayName} added.${suffix}`)
    emit('plugins-changed')
  } catch (caught) {
    showToast(caught instanceof Error ? caught.message : `Failed to add ${plugin.displayName}`, 'error')
  } finally {
    busyAction.value = null
  }
}

async function removePlugin(plugin: PluginCatalogItem): Promise<void> {
  if (!canRemove(plugin)) return
  const confirmed = window.confirm(`Remove the ${plugin.displayName} plugin from this Codex installation?`)
  if (!confirmed) return

  busyAction.value = { pluginId: plugin.id, action: 'uninstall' }
  try {
    await uninstallPlugin(plugin.id)
    await refreshCatalog()
    showToast(`${plugin.displayName} removed.`)
    emit('plugins-changed')
  } catch (caught) {
    showToast(caught instanceof Error ? caught.message : `Failed to remove ${plugin.displayName}`, 'error')
  } finally {
    busyAction.value = null
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  void refreshCatalog()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<style scoped>
@reference "tailwindcss";

.plugins-hub {
  @apply mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-y-auto p-3 sm:p-6;
}

.plugins-hub-header {
  @apply flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between;
  border-color: var(--border-soft);
}

.plugins-hub-title {
  @apply m-0 text-xl font-semibold tracking-tight sm:text-2xl;
  color: var(--text-primary);
}

.plugins-hub-subtitle {
  @apply mt-1 text-sm;
  color: var(--text-muted);
}

.plugins-hub-summary {
  @apply grid grid-cols-3 gap-2;
}

.plugins-hub-stat {
  @apply rounded-xl border px-3 py-3 sm:px-4;
  border-color: var(--border-soft);
  background: var(--surface-muted);
}

.plugins-hub-stat-value {
  @apply block text-xl font-semibold sm:text-2xl;
  color: var(--text-primary);
}

.plugins-hub-stat-label {
  @apply mt-0.5 block text-xs sm:text-sm;
  color: var(--text-muted);
}

.plugins-hub-search {
  @apply flex min-h-11 items-center gap-2 rounded-xl border px-3 transition;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-tertiary);
}

.plugins-hub-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-soft);
}

.plugins-hub-search-icon {
  @apply h-4 w-4 shrink-0;
}

.plugins-hub-search input {
  @apply min-w-0 flex-1 border-0 bg-transparent p-0 text-base outline-none sm:text-sm;
  color: var(--text-primary);
}

.plugins-hub-search input::placeholder {
  color: var(--text-muted);
}

.plugins-hub-search-count {
  @apply whitespace-nowrap text-xs;
  color: var(--text-muted);
}

.plugins-hub-toast,
.plugins-hub-warning {
  @apply flex flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-sm;
  border-color: rgb(167 243 208);
  background: rgb(236 253 245);
  color: rgb(6 95 70);
}

.plugins-hub-toast.is-error,
.plugins-hub-warning {
  border-color: rgb(254 202 202);
  background: rgb(254 242 242);
  color: rgb(185 28 28);
}

:global(html[data-theme='dark']) .plugins-hub-toast {
  border-color: rgb(6 78 59);
  background: rgb(2 44 34);
  color: rgb(167 243 208);
}

:global(html[data-theme='dark']) .plugins-hub-toast.is-error,
:global(html[data-theme='dark']) .plugins-hub-warning {
  border-color: rgb(127 29 29);
  background: rgb(69 10 10);
  color: rgb(254 202 202);
}

.plugins-hub-sections,
.plugins-hub-section {
  @apply flex flex-col gap-3;
}

.plugins-hub-section + .plugins-hub-section {
  @apply mt-2 border-t pt-5;
  border-color: var(--border-soft);
}

.plugins-hub-section-header {
  @apply flex items-start justify-between gap-3;
}

.plugins-hub-section-header h3 {
  @apply m-0 text-base font-semibold;
  color: var(--text-primary);
}

.plugins-hub-section-header p {
  @apply mt-0.5 text-xs sm:text-sm;
  color: var(--text-muted);
}

.plugins-hub-section-header > span {
  @apply inline-flex min-w-6 items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold;
  background: var(--surface-active);
  color: var(--text-secondary);
}

.plugins-hub-grid {
  @apply grid grid-cols-1 gap-3 md:grid-cols-2;
}

.plugins-hub-card {
  @apply flex min-w-0 flex-col gap-3 rounded-2xl border p-4;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
}

.plugins-hub-card-heading {
  @apply flex min-w-0 items-start gap-3;
}

.plugins-hub-card-icon {
  @apply inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl;
  background: var(--surface-active);
  color: var(--text-secondary);
}

.plugins-hub-card-icon svg {
  @apply h-4 w-4;
}

.plugins-hub-card-title-wrap {
  @apply min-w-0 flex-1;
}

.plugins-hub-card-title-wrap h4 {
  @apply m-0 truncate text-sm font-semibold;
  color: var(--text-primary);
}

.plugins-hub-card-title-wrap p {
  @apply mt-0.5 truncate text-xs;
  color: var(--text-muted);
}

.plugins-hub-status {
  @apply shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold;
  background: var(--surface-active);
  color: var(--text-secondary);
}

.plugins-hub-status.is-ready {
  background: rgb(209 250 229);
  color: rgb(4 120 87);
}

.plugins-hub-status.is-blocked {
  background: rgb(254 226 226);
  color: rgb(185 28 28);
}

:global(html[data-theme='dark']) .plugins-hub-status.is-ready {
  background: rgb(6 78 59);
  color: rgb(167 243 208);
}

:global(html[data-theme='dark']) .plugins-hub-status.is-blocked {
  background: rgb(127 29 29);
  color: rgb(254 202 202);
}

.plugins-hub-card-description {
  @apply m-0 line-clamp-3 text-sm leading-5;
  color: var(--text-secondary);
}

.plugins-hub-card-meta {
  @apply flex min-h-5 flex-wrap gap-x-2 gap-y-1 text-xs;
  color: var(--text-muted);
}

.plugins-hub-card-actions {
  @apply mt-auto flex flex-wrap items-center justify-end gap-2;
}

.plugins-hub-details-button {
  @apply mr-auto border-0 bg-transparent p-0 text-xs font-medium transition;
  color: var(--text-secondary);
}

.plugins-hub-details-button:hover {
  color: var(--text-primary);
  text-decoration: underline;
}

.plugins-hub-button {
  @apply inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50;
  border-color: var(--border-medium);
  background: var(--surface-elevated);
  color: var(--text-secondary);
}

.plugins-hub-button:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.plugins-hub-button-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: white;
}

.plugins-hub-button-primary:hover:not(:disabled) {
  filter: brightness(0.92);
  color: white;
}

.plugins-hub-button-danger {
  border-color: rgb(254 202 202);
  color: rgb(185 28 28);
}

.plugins-hub-button-danger:hover:not(:disabled) {
  background: rgb(254 242 242);
  color: rgb(153 27 27);
}

:global(html[data-theme='dark']) .plugins-hub-button-danger {
  border-color: rgb(127 29 29);
  color: rgb(252 165 165);
}

:global(html[data-theme='dark']) .plugins-hub-button-danger:hover:not(:disabled) {
  background: rgb(69 10 10);
  color: rgb(254 202 202);
}

.plugins-hub-button-icon {
  @apply h-4 w-4;
}

.plugins-hub-managed-label {
  @apply inline-flex items-center gap-1.5 text-xs;
  color: var(--text-muted);
}

.plugins-hub-managed-label svg {
  @apply h-3.5 w-3.5;
}

.plugins-hub-empty {
  @apply rounded-xl border border-dashed px-4 py-8 text-center text-sm;
  border-color: var(--border-medium);
  background: var(--surface-muted);
  color: var(--text-muted);
}

.plugins-hub-empty.is-error {
  border-color: rgb(254 202 202);
  color: rgb(185 28 28);
}

.plugins-hub-empty-compact {
  @apply py-5;
}

.plugins-hub-modal-backdrop {
  @apply fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4;
}

.plugins-hub-modal {
  @apply flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl border shadow-2xl sm:max-w-2xl sm:rounded-2xl;
  border-color: var(--border-medium);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.plugins-hub-modal-header {
  @apply flex items-start gap-3 border-b p-4 sm:p-5;
  border-color: var(--border-soft);
}

.plugins-hub-modal-icon {
  @apply inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl;
  background: var(--surface-active);
  color: var(--text-secondary);
}

.plugins-hub-modal-icon svg {
  @apply h-5 w-5;
}

.plugins-hub-modal-title-wrap {
  @apply min-w-0 flex-1;
}

.plugins-hub-modal-title-wrap h2 {
  @apply m-0 text-lg font-semibold;
  color: var(--text-primary);
}

.plugins-hub-modal-title-wrap p {
  @apply mt-0.5 text-sm;
  color: var(--text-muted);
}

.plugins-hub-modal-close {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent transition;
  color: var(--text-tertiary);
}

.plugins-hub-modal-close:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.plugins-hub-modal-close svg {
  @apply h-4 w-4;
}

.plugins-hub-modal-content {
  @apply flex min-h-0 flex-col gap-5 overflow-y-auto p-4 sm:p-5;
}

.plugins-hub-modal-description {
  @apply m-0 whitespace-pre-line text-sm leading-6;
  color: var(--text-secondary);
}

.plugins-hub-modal-facts {
  @apply m-0 grid grid-cols-1 gap-2 sm:grid-cols-2;
}

.plugins-hub-modal-facts > div {
  @apply rounded-xl border px-3 py-2;
  border-color: var(--border-soft);
  background: var(--surface-muted);
}

.plugins-hub-modal-facts dt {
  @apply text-[10px] font-semibold uppercase tracking-wide;
  color: var(--text-muted);
}

.plugins-hub-modal-facts dd {
  @apply m-0 mt-0.5 text-sm;
  color: var(--text-primary);
}

.plugins-hub-modal-capabilities {
  @apply flex flex-col gap-2;
}

.plugins-hub-modal-capabilities h3 {
  @apply m-0 text-sm font-semibold;
  color: var(--text-primary);
}

.plugins-hub-modal-capabilities > div {
  @apply flex flex-wrap gap-1.5;
}

.plugins-hub-modal-capabilities span {
  @apply rounded-full px-2 py-1 text-xs;
  background: var(--surface-active);
  color: var(--text-secondary);
}

.plugins-hub-modal-identifier {
  @apply flex min-w-0 flex-col gap-1 text-xs;
  color: var(--text-muted);
}

.plugins-hub-modal-identifier code {
  @apply overflow-x-auto rounded-lg px-2 py-1.5 font-mono text-[11px];
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.plugins-hub-modal-actions {
  @apply flex items-center justify-end gap-2 border-t p-4 sm:px-5;
  border-color: var(--border-soft);
}
</style>
