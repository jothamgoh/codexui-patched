<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="host-folder-overlay" />
      <DialogContent class="host-folder-dialog" aria-describedby="host-folder-description">
        <header>
          <div><DialogTitle>Choose a folder</DialogTitle><p id="host-folder-description">Folders on the computer running CodexUI.</p></div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close folder browser" @click="emit('update:open', false)"><X /></Button>
        </header>
        <div class="host-folder-body">
          <nav aria-label="Folder navigation">
            <Button type="button" variant="outline" :disabled="loading" @click="navigate('')"><House />Home</Button>
            <Button type="button" variant="outline" :disabled="loading || !listing?.parentPath" @click="navigate(listing!.parentPath!)"><ArrowUp />Up</Button>
            <select v-if="roots.length" aria-label="Jump to a recent project" :disabled="loading" :value="''" @change="navigate(($event.target as HTMLSelectElement).value)">
              <option value="" disabled>Recent projects</option><option v-for="root in roots" :key="root.path" :value="root.path">{{ root.name }}</option>
            </select>
          </nav>
          <p class="host-folder-path" :title="listing?.path || requestedPath">{{ listing?.path || requestedPath || 'Home' }}</p>
          <details class="host-folder-manual">
            <summary>Path and hidden folders</summary>
            <div class="host-folder-path-entry">
              <DictationField v-model="pathDraft" label="Folder path" placeholder="Full folder path" autocomplete="off" :disabled="loading" @keydown.enter.prevent="navigate(pathDraft)" />
              <Button type="button" variant="outline" :disabled="loading || !pathDraft.trim()" @click="navigate(pathDraft)">Go</Button>
            </div>
            <label class="host-folder-hidden"><input v-model="showHidden" type="checkbox" :disabled="loading" />Show hidden folders</label>
          </details>
          <p v-if="error" class="host-folder-error" role="alert">{{ error }} <button type="button" @click="navigate(requestedPath)">Try again</button></p>
          <div class="host-folder-list" :aria-busy="loading" aria-label="Folders">
            <p v-if="loading" class="host-folder-empty" role="status"><LoaderCircle class="animate-spin" />Loading folders…</p>
            <template v-else-if="!error && listing">
              <Button v-for="folder in listing.folders" :key="folder.path" type="button" variant="ghost" class="host-folder-row" @click="navigate(folder.path)">
                <Folder /><span>{{ folder.name }}</span><ChevronRight />
              </Button>
              <p v-if="!listing.folders.length" class="host-folder-empty">No subfolders here. You can use this folder.</p>
            </template>
          </div>
          <p v-if="listing?.truncated && !loading && !error" class="host-folder-limit">Showing {{ listing.folders.length }} folders from a large directory. Enter a path to open a folder not listed here.</p>
        </div>
        <footer>
          <Button type="button" variant="ghost" @click="emit('update:open', false)">Cancel</Button>
          <Button type="button" :disabled="loading || !!error || !listing" @click="selectFolder">Use folder</Button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { ArrowUp, ChevronRight, Folder, House, LoaderCircle, X } from '@lucide/vue'
import Button from '../ui/button/Button.vue'
import DictationField from './DictationField.vue'
import { getHostFolders } from '../../api/hostFolders'
import type { HostFolderListing } from '../../types/hostFolders'

const props = withDefaults(defineProps<{ open: boolean; initialPath?: string; roots?: Array<{ path: string; name: string }> }>(), { initialPath: '', roots: () => [] })
const emit = defineEmits<{ 'update:open': [value: boolean]; select: [path: string] }>()
const listing = ref<HostFolderListing | null>(null)
const loading = ref(false)
const error = ref('')
const requestedPath = ref('')
const pathDraft = ref('')
const showHidden = ref(false)
let request: AbortController | undefined

async function navigate(path: string): Promise<void> {
  request?.abort()
  const current = new AbortController()
  request = current
  requestedPath.value = path
  error.value = ''
  loading.value = true
  try {
    const result = await getHostFolders(path, showHidden.value, current.signal)
    if (request !== current || !props.open) return
    listing.value = result
    pathDraft.value = result.path
  } catch (caught) {
    if (current.signal.aborted || request !== current) return
    error.value = caught instanceof Error ? caught.message : 'Could not browse folders.'
  } finally {
    if (request === current) loading.value = false
  }
}

function selectFolder(): void {
  if (!listing.value || loading.value || error.value) return
  emit('select', listing.value.path)
  emit('update:open', false)
}

watch(() => props.open, (open) => {
  if (open) {
    listing.value = null
    pathDraft.value = props.initialPath
    void navigate(props.initialPath)
  } else {
    request?.abort()
    request = undefined
    loading.value = false
  }
}, { immediate: true })
watch(showHidden, () => { if (props.open) void navigate(listing.value?.path || requestedPath.value) })
onBeforeUnmount(() => request?.abort())
</script>

<style scoped>
@reference "tailwindcss";
.host-folder-overlay { @apply fixed inset-0 z-[85] bg-black/40; }
.host-folder-dialog { @apply fixed top-1/2 left-1/2 z-[90] flex w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border shadow-2xl; height: min(40rem, 90dvh); background: var(--surface-elevated); border-color: var(--border-soft); color: var(--text-primary); }
header { @apply flex shrink-0 items-start justify-between gap-3 border-b p-4; border-color: var(--border-soft); }
header p, .host-folder-limit { @apply mt-1 mb-0 text-xs leading-5; color: var(--text-secondary); }
.host-folder-body { @apply flex min-h-0 flex-1 flex-col gap-3 p-4; }
nav { @apply flex shrink-0 items-center gap-2; }
nav select { @apply min-w-0 flex-1 rounded-md border px-2; height: 44px; background: var(--surface-elevated); border-color: var(--border-strong); }
.host-folder-path { @apply m-0 shrink-0 break-all text-sm; max-height: 3.5rem; overflow-y: auto; color: var(--text-secondary); }
.host-folder-manual { @apply shrink-0; }
.host-folder-manual summary { @apply min-h-11 cursor-pointer py-3 text-sm; }
.host-folder-path-entry { @apply mt-2 flex min-w-0 items-center gap-2; }
.host-folder-path-entry > :first-child { @apply min-w-0 flex-1; }
.host-folder-hidden { @apply mt-1 flex min-h-11 shrink-0 items-center gap-2 text-xs; color: var(--text-secondary); }
.host-folder-hidden input { @apply h-4 w-4; }
.host-folder-list { @apply min-h-0 flex-1 overflow-y-auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.host-folder-row { @apply h-auto min-h-11 w-full justify-start gap-3 whitespace-normal px-2 py-3 text-left; }
.host-folder-row span { @apply min-w-0 flex-1 break-words; overflow-wrap: anywhere; }
.host-folder-row:hover { background: var(--surface-hover); }
.host-folder-empty { @apply flex items-center justify-center gap-2 px-2 py-8 text-center text-sm; color: var(--text-secondary); }
.host-folder-error { @apply m-0 text-sm; color: var(--color-red-500, #ef4444); }
.host-folder-error button { @apply underline; }
footer { @apply flex shrink-0 justify-end gap-2 border-t p-4; border-color: var(--border-soft); }
svg { @apply h-4 w-4 shrink-0; }
header button, nav button, footer button, .host-folder-path-entry button { min-height: 44px; }
header button { min-width: 44px; }
@media (max-width: 640px) {
  .host-folder-dialog { @apply top-auto bottom-0 left-0 w-full translate-x-0 translate-y-0 rounded-b-none; height: min(42rem, 94dvh); }
  footer { padding-bottom: max(1rem, env(safe-area-inset-bottom)); }
  nav select, :deep(input[type='text']) { font-size: 16px; }
}
</style>
