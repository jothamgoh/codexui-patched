<template>
  <Popover v-model:open="summaryOpen">
    <PopoverTrigger as-child>
      <Button
        v-if="threadId && cwd"
        ref="summaryTriggerRef"
        variant="ghost"
        size="icon"
        class="workspace-summary-trigger"
        aria-label="Toggle summary"
        title="Summary"
      >
        <ListTree aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="workspace-summary-popover" align="end" :side-offset="6">
      <header class="workspace-summary-header">
        <div>
          <strong>Summary</strong>
          <span v-if="repositoryName">{{ repositoryName }}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="isLoadingStatus"
          aria-label="Refresh environment"
          title="Refresh environment"
          @click="refreshStatus"
        >
          <RefreshCw :class="{ 'is-spinning': isLoadingStatus }" aria-hidden="true" />
        </Button>
      </header>

      <section class="workspace-summary-section" aria-labelledby="workspace-environment-heading">
        <h2 id="workspace-environment-heading">Environment</h2>

        <div v-if="isLoadingStatus && !status" class="workspace-summary-state" role="status">
          <LoaderCircle class="is-spinning" aria-hidden="true" />
          Loading repository…
        </div>
        <div v-else-if="statusError" class="workspace-summary-state is-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{{ statusError }}</span>
          <Button variant="outline" size="sm" @click="refreshStatus">Retry</Button>
        </div>
        <template v-else-if="status">
          <button
            type="button"
            class="workspace-summary-row"
            :disabled="isSwitchingBranch || threadInProgress"
            @click="openBranchDialog"
          >
            <span class="workspace-summary-row-icon"><GitBranch aria-hidden="true" /></span>
            <span class="workspace-summary-row-copy">
              <strong>{{ currentBranchLabel }}</strong>
              <span>{{ branchSubtext }}</span>
            </span>
            <ChevronRight aria-hidden="true" />
          </button>

          <button type="button" class="workspace-summary-row" @click="openReview('uncommitted')">
            <span class="workspace-summary-row-icon"><FileDiff aria-hidden="true" /></span>
            <span class="workspace-summary-row-copy">
              <strong>Changes</strong>
              <span>{{ changesSubtext }}</span>
            </span>
            <span v-if="status.isDirty" class="workspace-summary-dot" aria-label="Uncommitted changes" />
            <ChevronRight aria-hidden="true" />
          </button>

          <p v-if="status.counts.conflicted > 0" class="workspace-summary-conflict">
            <TriangleAlert aria-hidden="true" />
            {{ status.counts.conflicted }} conflicted
            {{ status.counts.conflicted === 1 ? 'file needs' : 'files need' }} attention.
          </p>
        </template>
      </section>
    </PopoverContent>
  </Popover>

  <DialogRoot :open="branchDialogOpen" @update:open="onBranchDialogOpenChange">
    <DialogPortal>
      <DialogOverlay class="workspace-branch-overlay" />
      <DialogContent
        class="workspace-branch-dialog"
        aria-describedby="workspace-branch-description"
        @open-auto-focus="focusBranchSearch"
        @close-auto-focus="restoreSummaryFocus"
      >
        <header ref="branchDialogFocusRef" class="workspace-branch-header" tabindex="-1">
          <div class="workspace-branch-heading">
            <DialogTitle>Switch branch</DialogTitle>
            <DialogDescription id="workspace-branch-description">
              Your safe local edits stay with the worktree. Git will stop if checkout would overwrite them.
            </DialogDescription>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close branch picker" @click="branchDialogOpen = false">
            <X aria-hidden="true" />
          </Button>
        </header>

        <div class="workspace-branch-search-wrap">
          <Search aria-hidden="true" />
          <Input
            ref="branchSearchRef"
            v-model="branchQuery"
            class="workspace-branch-search"
            aria-label="Search branches"
            placeholder="Search branches"
          />
        </div>

        <p v-if="branchActionMessage" class="workspace-branch-message" :data-tone="branchActionTone" aria-live="polite">
          {{ branchActionMessage }}
        </p>
        <ul v-if="branchBlockedPaths.length > 0" class="workspace-branch-blocked-paths" aria-label="Files blocking checkout">
          <li v-for="path in branchBlockedPaths" :key="path" :title="path">{{ path }}</li>
        </ul>

        <div class="workspace-branch-list" aria-label="Branches">
          <button
            v-for="branch in filteredBranches"
            :key="branch.name"
            type="button"
            class="workspace-branch-row"
            :class="{ 'is-current': branch.current }"
            :aria-current="branch.current ? 'true' : undefined"
            :disabled="branch.current || isSwitchingBranch || threadInProgress"
            @click="switchBranch(branch.name)"
          >
            <GitBranch aria-hidden="true" />
            <span>
              <strong :title="branch.name">{{ branch.name }}</strong>
              <small v-if="branch.current && uncommittedFileCount > 0">
                Uncommitted: {{ uncommittedFileCount }}
                {{ uncommittedFileCount === 1 ? 'file' : 'files' }}
              </small>
              <small v-else-if="branch.current">Current branch</small>
            </span>
            <LoaderCircle v-if="pendingBranch === branch.name" class="is-spinning" aria-hidden="true" />
            <Check v-else-if="branch.current" aria-hidden="true" />
          </button>

          <p v-if="filteredBranches.length === 0" class="workspace-branch-empty">
            No branches found
          </p>
        </div>

        <footer v-if="branchActionTone === 'blocked'" class="workspace-branch-footer">
          <Button variant="outline" @click="branchDialogOpen = false">Cancel</Button>
          <Button @click="openReview('uncommitted')">Review changes</Button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <WorkspaceReviewPanel
    v-model:open="reviewOpen"
    :thread-id="threadId"
    :cwd="cwd"
    :status="status"
    :last-turn-changes="lastTurnChanges"
    :initial-source="reviewInitialSource"
    :refresh-key="reviewRefreshKey"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Check,
  ChevronRight,
  CircleAlert,
  FileDiff,
  GitBranch,
  ListTree,
  LoaderCircle,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from '@lucide/vue'
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  getGitWorkspaceStatus,
  subscribeCodexInPageNotifications,
  switchGitWorkspaceBranch,
} from '../../api/codexGateway'
import type {
  GitWorkspaceReviewSource,
  GitWorkspaceStatus,
  ReviewChangesData,
} from '../../types/codex'
import WorkspaceReviewPanel from './WorkspaceReviewPanel.vue'

type ReviewPanelSource = 'last-turn' | GitWorkspaceReviewSource

const props = withDefaults(defineProps<{
  threadId: string
  cwd: string
  threadInProgress?: boolean
  lastTurnChanges?: ReviewChangesData | null
}>(), {
  threadInProgress: false,
  lastTurnChanges: null,
})

const emit = defineEmits<{
  'branch-changed': [branch: string]
  'review-open-change': [open: boolean]
}>()

const summaryOpen = ref(false)
const branchDialogOpen = ref(false)
const reviewOpen = ref(false)
const reviewInitialSource = ref<ReviewPanelSource>('uncommitted')
const reviewRefreshKey = ref(0)
const status = ref<GitWorkspaceStatus | null>(null)
const isLoadingStatus = ref(false)
const statusError = ref('')
const branchQuery = ref('')
const isSwitchingBranch = ref(false)
const pendingBranch = ref('')
const branchActionMessage = ref('')
const branchActionTone = ref<'success' | 'error' | 'blocked' | ''>('')
const branchBlockedPaths = ref<string[]>([])
const summaryTriggerRef = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const branchSearchRef = ref<{ $el?: HTMLInputElement } | HTMLInputElement | null>(null)
const branchDialogFocusRef = ref<HTMLElement | null>(null)
let statusRequestToken = 0
let branchRequestToken = 0
let unsubscribeWorkspaceNotifications: (() => void) | null = null

const repositoryName = computed(() => {
  const root = status.value?.root || props.cwd
  return root.split('/').filter(Boolean).at(-1) ?? ''
})

const currentBranchLabel = computed(() => {
  if (status.value?.currentBranch) return status.value.currentBranch
  return status.value?.detachedHead ? 'Detached HEAD' : 'Branch unavailable'
})

const uncommittedFileCount = computed(() => {
  const counts = status.value?.counts
  if (!counts) return 0
  return counts.total
})

const branchSubtext = computed(() => {
  if (props.threadInProgress) return 'Wait for the current turn to finish before switching'
  if (status.value?.countsTruncated) {
    return uncommittedFileCount.value > 0
      ? `Uncommitted: ${uncommittedFileCount.value.toString()}+ files`
      : 'Uncommitted changes'
  }
  if (uncommittedFileCount.value > 0) {
    return `Uncommitted: ${uncommittedFileCount.value.toString()} ${uncommittedFileCount.value === 1 ? 'file' : 'files'}`
  }
  return 'Switch branch'
})

const changesSubtext = computed(() => {
  if (!status.value?.isDirty) return 'No uncommitted changes'
  const counts = status.value?.counts
  if (!counts) return 'Uncommitted changes'
  const parts = [
    counts.staged > 0 ? `${counts.staged.toString()} staged` : '',
    counts.unstaged > 0 ? `${counts.unstaged.toString()} unstaged` : '',
    counts.untracked > 0 ? `${counts.untracked.toString()} untracked` : '',
    counts.conflicted > 0 ? `${counts.conflicted.toString()} conflicted` : '',
  ].filter(Boolean)
  if (status.value.countsTruncated) {
    return parts.length > 0 ? `${parts.join(' · ')} · more changes` : 'Uncommitted changes'
  }
  return parts.join(' · ') || 'Uncommitted changes'
})

const filteredBranches = computed(() => {
  const query = branchQuery.value.trim().toLocaleLowerCase()
  return (status.value?.branches ?? [])
    .filter((branch) => !query || branch.name.toLocaleLowerCase().includes(query))
    .slice(0, 100)
})

watch(summaryOpen, (open) => {
  if (open) void refreshStatus()
})

watch(
  () => [props.threadId, props.cwd] as const,
  () => {
    statusRequestToken += 1
    branchRequestToken += 1
    summaryOpen.value = false
    status.value = null
    isLoadingStatus.value = false
    statusError.value = ''
    branchDialogOpen.value = false
    reviewOpen.value = false
    branchQuery.value = ''
    branchActionMessage.value = ''
    branchActionTone.value = ''
    branchBlockedPaths.value = []
    isSwitchingBranch.value = false
    pendingBranch.value = ''
  },
)

onMounted(() => {
  unsubscribeWorkspaceNotifications = subscribeCodexInPageNotifications((notification) => {
    if (notification.method !== 'git-workspace/changed') return
    if (summaryOpen.value || branchDialogOpen.value || reviewOpen.value) void refreshStatus()
    if (reviewOpen.value) reviewRefreshKey.value += 1
  })
})

onUnmounted(() => {
  unsubscribeWorkspaceNotifications?.()
  unsubscribeWorkspaceNotifications = null
})

watch(
  () => props.threadInProgress,
  (inProgress, wasInProgress) => {
    if (inProgress || !wasInProgress) return
    if (summaryOpen.value || branchDialogOpen.value) void refreshStatus()
    if (reviewOpen.value) reviewRefreshKey.value += 1
  },
)

watch(reviewOpen, (open, wasOpen) => {
  emit('review-open-change', open)
  if (!open && wasOpen) focusSummaryTrigger()
})

async function refreshStatus(): Promise<void> {
  if (!props.threadId || !props.cwd) return
  const token = ++statusRequestToken
  isLoadingStatus.value = true
  statusError.value = ''
  try {
    const result = await getGitWorkspaceStatus(props.threadId)
    if (token !== statusRequestToken) return
    status.value = result
  } catch (error) {
    if (token !== statusRequestToken) return
    status.value = null
    statusError.value = error instanceof Error ? error.message : 'Repository details could not be loaded.'
  } finally {
    if (token === statusRequestToken) isLoadingStatus.value = false
  }
}

function openBranchDialog(): void {
  summaryOpen.value = false
  branchQuery.value = ''
  branchActionMessage.value = props.threadInProgress
    ? 'Wait for the current Codex turn to finish before switching branches.'
    : ''
  branchActionTone.value = props.threadInProgress ? 'error' : ''
  branchBlockedPaths.value = []
  branchDialogOpen.value = true
}

function onBranchDialogOpenChange(open: boolean): void {
  branchDialogOpen.value = open
  if (!open) {
    branchQuery.value = ''
    pendingBranch.value = ''
  }
}

function focusBranchSearch(event: Event): void {
  event.preventDefault()
  void nextTick(() => {
    if (window.matchMedia('(pointer: coarse)').matches) {
      branchDialogFocusRef.value?.focus({ preventScroll: true })
      return
    }
    const target = branchSearchRef.value
    if (target instanceof HTMLInputElement) target.focus()
    else target?.$el?.focus()
  })
}

function focusSummaryTrigger(): void {
  void nextTick(() => {
    const target = summaryTriggerRef.value
    if (target instanceof HTMLElement) target.focus({ preventScroll: true })
    else target?.$el?.focus({ preventScroll: true })
  })
}

function restoreSummaryFocus(event: Event): void {
  event.preventDefault()
  focusSummaryTrigger()
}

async function switchBranch(branch: string): Promise<void> {
  if (isSwitchingBranch.value || props.threadInProgress || !branch) return
  const token = ++branchRequestToken
  const threadId = props.threadId
  const cwd = props.cwd
  isSwitchingBranch.value = true
  pendingBranch.value = branch
  branchActionMessage.value = `Switching to ${branch}…`
  branchActionTone.value = ''
  branchBlockedPaths.value = []
  try {
    const result = await switchGitWorkspaceBranch(threadId, branch)
    if (token !== branchRequestToken || props.threadId !== threadId || props.cwd !== cwd) return
    if (result.status === 'success') {
      branchActionMessage.value = `Switched to ${result.currentBranch || branch}.`
      branchActionTone.value = 'success'
      branchBlockedPaths.value = []
      await refreshStatus()
      if (token !== branchRequestToken || props.threadId !== threadId || props.cwd !== cwd) return
      reviewRefreshKey.value += 1
      emit('branch-changed', result.currentBranch || branch)
      branchDialogOpen.value = false
      return
    }
    branchActionMessage.value = result.error || (
      result.status === 'blocked'
        ? 'Commit or stash the changes that would be overwritten, then try again.'
        : 'Git could not switch branches.'
    )
    branchActionTone.value = result.status === 'blocked' ? 'blocked' : 'error'
    branchBlockedPaths.value = result.details?.paths?.slice(0, 20) ?? []
  } catch (error) {
    if (token !== branchRequestToken || props.threadId !== threadId || props.cwd !== cwd) return
    branchActionMessage.value = error instanceof Error ? error.message : 'Git could not switch branches.'
    branchActionTone.value = 'error'
    branchBlockedPaths.value = []
  } finally {
    if (token === branchRequestToken && props.threadId === threadId && props.cwd === cwd) {
      isSwitchingBranch.value = false
      pendingBranch.value = ''
    }
  }
}

function openReview(source: ReviewPanelSource): void {
  summaryOpen.value = false
  branchDialogOpen.value = false
  reviewInitialSource.value = source
  reviewOpen.value = true
}
</script>

<style scoped>
@reference "tailwindcss";

.workspace-summary-trigger {
  color: var(--text-tertiary);
}

.workspace-summary-trigger:hover {
  color: var(--text-primary);
}

.workspace-summary-trigger svg {
  @apply h-[18px] w-[18px];
}

:global(.workspace-summary-popover) {
  width: min(20rem, calc(100vw - 1rem)) !important;
  gap: 0 !important;
  padding: 0.375rem !important;
  z-index: 120 !important;
}

.workspace-summary-header {
  @apply flex min-h-11 items-center justify-between gap-2 px-2;
}

.workspace-summary-header > div {
  @apply flex min-w-0 flex-col;
}

.workspace-summary-header strong {
  @apply text-sm font-semibold;
  color: var(--text-primary);
}

.workspace-summary-header span {
  @apply truncate text-[11px];
  color: var(--text-muted);
}

.workspace-summary-header button {
  color: var(--text-tertiary);
}

.workspace-summary-section {
  @apply mt-1 rounded-lg border p-1;
  border-color: var(--border-soft);
  background: var(--surface-muted);
}

.workspace-summary-section h2 {
  @apply m-0 px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em];
  color: var(--text-muted);
}

.workspace-summary-row {
  @apply flex min-h-12 w-full min-w-0 items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left outline-none;
  color: var(--text-secondary);
}

.workspace-summary-row:hover,
.workspace-summary-row:focus-visible {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.workspace-summary-row:disabled {
  @apply cursor-not-allowed opacity-60;
}

.workspace-summary-row-icon {
  @apply flex h-8 w-8 shrink-0 items-center justify-center rounded-lg;
  background: var(--surface-elevated);
  color: var(--text-tertiary);
}

.workspace-summary-row-icon svg {
  @apply h-4 w-4;
}

.workspace-summary-row-copy {
  @apply flex min-w-0 flex-1 flex-col;
}

.workspace-summary-row-copy strong {
  @apply truncate text-xs font-medium;
}

.workspace-summary-row-copy span {
  @apply truncate text-[11px];
  color: var(--text-muted);
}

.workspace-summary-row > svg {
  @apply h-4 w-4 shrink-0;
  color: var(--text-faint);
}

.workspace-summary-dot {
  @apply h-2 w-2 shrink-0 rounded-full;
  background: var(--accent);
}

.workspace-summary-state {
  @apply flex min-h-24 flex-col items-center justify-center gap-2 px-3 py-4 text-center text-xs;
  color: var(--text-muted);
}

.workspace-summary-state > svg {
  @apply h-4 w-4;
}

.workspace-summary-state.is-error span,
.workspace-summary-state.is-error > svg {
  color: var(--destructive);
}

.workspace-summary-conflict {
  @apply m-1 flex items-start gap-1.5 rounded-lg px-2 py-2 text-[11px] leading-4;
  background: color-mix(in srgb, var(--destructive) 8%, var(--surface-elevated));
  color: var(--destructive);
}

.workspace-summary-conflict svg {
  @apply mt-0.5 h-3.5 w-3.5 shrink-0;
}

.workspace-branch-overlay {
  @apply fixed inset-0;
  z-index: 170;
  background: var(--overlay);
}

.workspace-branch-dialog {
  @apply fixed left-1/2 top-1/2 flex max-h-[min(42rem,calc(100dvh-2rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border shadow-2xl outline-none;
  z-index: 171;
  border-color: var(--border-strong);
  background: var(--surface-elevated);
  color: var(--text-primary);
  --workspace-summary-success: #116b36;
}

:global(html[data-theme='dark'] .workspace-branch-dialog) {
  --workspace-summary-success: #73d99a;
}

.workspace-branch-header {
  @apply flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3;
  border-color: var(--border-soft);
}

.workspace-branch-heading {
  @apply min-w-0;
}

.workspace-branch-heading > :first-child {
  @apply text-base font-semibold;
}

.workspace-branch-heading > :last-child {
  @apply mt-1 block text-xs leading-5;
  color: var(--text-muted);
}

.workspace-branch-search-wrap {
  @apply mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-lg border px-2;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-muted);
}

.workspace-branch-search-wrap:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.workspace-branch-search-wrap > svg {
  @apply h-4 w-4 shrink-0;
}

.workspace-branch-search {
  @apply h-10 border-0 px-0 shadow-none focus-visible:ring-0;
}

.workspace-branch-message {
  @apply mx-3 mb-0 mt-2 rounded-lg px-3 py-2 text-xs leading-5;
  background: var(--surface-muted);
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.workspace-branch-message[data-tone='success'] {
  color: var(--workspace-summary-success);
}

.workspace-branch-message[data-tone='error'],
.workspace-branch-message[data-tone='blocked'] {
  background: color-mix(in srgb, var(--destructive) 8%, var(--surface-muted));
  color: var(--destructive);
}

.workspace-branch-blocked-paths {
  @apply mx-3 mb-0 mt-1 max-h-28 list-none overflow-y-auto rounded-lg border p-1;
  border-color: color-mix(in srgb, var(--destructive) 25%, var(--border-soft));
  background: var(--surface-muted);
}

.workspace-branch-blocked-paths li {
  @apply truncate rounded px-2 py-1 font-mono text-[11px];
  color: var(--text-secondary);
}

.workspace-branch-list {
  @apply min-h-0 flex-1 overflow-y-auto p-3;
  overscroll-behavior: contain;
}

.workspace-branch-row {
  @apply flex min-h-12 w-full min-w-0 items-center gap-2 rounded-lg border-0 bg-transparent px-2.5 text-left outline-none;
  color: var(--text-secondary);
}

.workspace-branch-row:hover:not(:disabled),
.workspace-branch-row:focus-visible,
.workspace-branch-row.is-current {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.workspace-branch-row:disabled:not(.is-current) {
  @apply cursor-not-allowed opacity-45;
}

.workspace-branch-row > svg {
  @apply h-4 w-4 shrink-0;
}

.workspace-branch-row > span {
  @apply flex min-w-0 flex-1 flex-col;
}

.workspace-branch-row strong {
  @apply truncate text-sm font-medium;
}

.workspace-branch-row small {
  @apply truncate text-[11px];
  color: var(--text-muted);
}

.workspace-branch-row.is-current > svg:last-child {
  color: var(--accent);
}

.workspace-branch-empty {
  @apply m-0 py-8 text-center text-xs;
  color: var(--text-muted);
}

.workspace-branch-footer {
  @apply flex shrink-0 justify-end gap-2 border-t px-4 py-3;
  border-color: var(--border-soft);
}

.is-spinning {
  animation: workspace-summary-spin 0.8s linear infinite;
}

@keyframes workspace-summary-spin {
  to { transform: rotate(360deg); }
}

@media (pointer: coarse) {
  .workspace-summary-trigger,
  .workspace-summary-row,
  .workspace-branch-row,
  .workspace-branch-header button,
  .workspace-branch-footer button {
    min-height: 44px;
  }

  .workspace-summary-trigger,
  .workspace-branch-header button {
    min-width: 44px;
  }
}

@media (max-width: 640px), (pointer: coarse) and (max-width: 1024px) {
  :global(.workspace-summary-popover) {
    width: calc(100vw - 1rem) !important;
    max-height: min(75dvh, var(--reka-popover-content-available-height)) !important;
  }

  .workspace-summary-row {
    @apply min-h-14;
  }

  .workspace-branch-dialog {
    @apply inset-0 max-h-none w-full translate-x-0 translate-y-0 rounded-none border-0;
    height: var(--visual-viewport-height, 100dvh);
  }

  .workspace-branch-header {
    padding-top: max(0.75rem, env(safe-area-inset-top));
    padding-left: max(0.75rem, env(safe-area-inset-left));
    padding-right: max(0.75rem, env(safe-area-inset-right));
  }

  .workspace-branch-search-wrap,
  .workspace-branch-message,
  .workspace-branch-blocked-paths {
    margin-left: max(0.75rem, env(safe-area-inset-left));
    margin-right: max(0.75rem, env(safe-area-inset-right));
  }

  .workspace-branch-list {
    padding-left: max(0.75rem, env(safe-area-inset-left));
    padding-right: max(0.75rem, env(safe-area-inset-right));
    padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
  }

  .workspace-branch-row {
    @apply min-h-14;
  }

  .workspace-branch-footer {
    @apply grid grid-cols-2;
    padding-right: max(0.75rem, env(safe-area-inset-right));
    padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
    padding-left: max(0.75rem, env(safe-area-inset-left));
  }
}

@media (prefers-reduced-motion: reduce) {
  .is-spinning {
    animation-duration: 1.6s;
  }
}
</style>
