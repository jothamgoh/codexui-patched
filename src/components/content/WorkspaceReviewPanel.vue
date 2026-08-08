<template>
  <DialogRoot :open="open" :modal="!isDockedReview" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="workspace-review-overlay" />
      <DialogContent
        class="workspace-review-panel"
        aria-describedby="workspace-review-description"
        @pointer-down-outside="preventOutsideClose"
        @interact-outside="preventOutsideClose"
      >
        <header class="workspace-review-header">
          <div class="workspace-review-heading">
            <div class="workspace-review-title-row">
              <DialogTitle class="workspace-review-title">Review</DialogTitle>
              <Popover v-model:open="sourceMenuOpen">
                <PopoverTrigger as-child>
                  <Button variant="ghost" size="sm" class="workspace-review-source-trigger">
                    {{ selectedSourceLabel }}
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent class="workspace-review-source-menu" align="start" :side-offset="6">
                  <button
                    v-for="option in sourceOptions"
                    :key="option.value"
                    type="button"
                    class="workspace-review-menu-item"
                    :class="{ 'is-selected': selectedSource === option.value }"
                    @click="selectSource(option.value)"
                  >
                    <span>{{ option.label }}</span>
                    <Check v-if="selectedSource === option.value" aria-hidden="true" />
                  </button>
                </PopoverContent>
              </Popover>
            </div>

            <DialogDescription id="workspace-review-description" class="workspace-review-description">
              <template v-if="changes">
                {{ fileCountLabel }}
                <span class="workspace-review-stat is-added">+{{ changes.additions }}</span>
                <span class="workspace-review-stat is-removed">−{{ changes.deletions }}</span>
              </template>
              <template v-else>{{ sourceDescription }}</template>
            </DialogDescription>
          </div>

          <div class="workspace-review-actions">
            <Button
              variant="ghost"
              size="icon"
              class="workspace-review-action"
              :disabled="isLoading"
              aria-label="Refresh changes"
              title="Refresh changes"
              @click="refreshReview"
            >
              <RefreshCw :class="{ 'is-spinning': isLoading }" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="workspace-review-action"
              :class="{ 'is-active': wrapLines }"
              :aria-pressed="wrapLines"
              aria-label="Wrap diff lines"
              title="Wrap diff lines"
              @click="wrapLines = !wrapLines"
            >
              <WrapText aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="workspace-review-action"
              aria-label="Close review"
              title="Close review"
              @click="emit('update:open', false)"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div v-if="selectedSource === 'branch'" class="workspace-review-branch-bar">
          <span class="workspace-review-current-branch" :title="status?.currentBranch || 'HEAD'">
            <GitBranch aria-hidden="true" />
            {{ status?.currentBranch || 'HEAD' }}
          </span>
          <ArrowRight aria-hidden="true" />
          <Popover v-model:open="branchMenuOpen">
            <PopoverTrigger as-child>
              <Button variant="outline" size="sm" class="workspace-review-base-trigger">
                <span>{{ selectedBaseBranch?.name || 'Select branch' }}</span>
                <ChevronDown aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              class="workspace-review-branch-menu"
              align="start"
              :side-offset="6"
              @open-auto-focus="preventTouchPopoverAutofocus"
            >
              <Input
                v-model="branchQuery"
                class="workspace-review-branch-search"
                aria-label="Search branches"
                placeholder="Search branches"
              />
              <div class="workspace-review-branch-list" aria-label="Base branches">
                <button
                  v-for="branch in filteredBaseBranches"
                  :key="branch.ref"
                  type="button"
                  class="workspace-review-menu-item"
                  :class="{ 'is-selected': selectedBaseBranchRef === branch.ref }"
                  :aria-pressed="selectedBaseBranchRef === branch.ref"
                  @click="selectBaseBranch(branch.ref)"
                >
                  <span :title="branch.name">{{ branch.name }}</span>
                  <Check v-if="selectedBaseBranchRef === branch.ref" aria-hidden="true" />
                </button>
                <p v-if="filteredBaseBranches.length === 0" class="workspace-review-menu-empty">
                  No branches found
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <nav v-if="changes?.files.length" class="workspace-review-file-nav" aria-label="Changed files">
          <button
            v-for="(file, index) in changes.files"
            :key="file.path"
            type="button"
            class="workspace-review-file-nav-item"
            :class="{ 'is-selected': selectedPath === file.path }"
            :aria-current="selectedPath === file.path ? 'true' : undefined"
            :aria-label="fileButtonLabel(file)"
            @click="focusFile(file.path, index)"
          >
            <span class="workspace-review-file-kind" :data-kind="file.kind">{{ kindLabel(file) }}</span>
            <span :title="file.path">{{ displayFileName(file) }}</span>
            <span class="workspace-review-file-stats" aria-hidden="true">
              <span class="workspace-review-stat is-added">+{{ file.additions }}</span>
              <span class="workspace-review-stat is-removed">−{{ file.deletions }}</span>
            </span>
          </button>
        </nav>

        <p v-if="omittedUntrackedFiles > 0" class="workspace-review-notice">
          {{ omittedUntrackedFiles }} additional untracked
          {{ omittedUntrackedFiles === 1 ? 'file was' : 'files were' }} omitted to keep Review responsive.
        </p>

        <main class="workspace-review-body" :class="{ 'is-wrapped': wrapLines }">
          <div v-if="isLoading && !changes" class="workspace-review-state" role="status">
            <LoaderCircle class="is-spinning" aria-hidden="true" />
            <strong>Loading changes…</strong>
          </div>
          <div v-else-if="loadError" class="workspace-review-state is-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <strong>Couldn’t load changes</strong>
            <p>{{ loadError }}</p>
            <Button variant="outline" @click="refreshReview">Retry</Button>
          </div>
          <div v-else-if="!changes || changes.fileCount === 0" class="workspace-review-state">
            <FileDiff aria-hidden="true" />
            <strong>{{ emptyStateTitle }}</strong>
            <p>{{ emptyStateDescription }}</p>
          </div>
          <template v-else>
            <p v-if="changes.filesTruncated" class="workspace-review-notice is-inline">
              Some changed files are not shown in this preview.
            </p>
            <section
              v-for="(file, fileIndex) in changes.files"
              :id="fileDomId(fileIndex)"
              :key="file.path"
              class="workspace-review-file-diff"
              :aria-labelledby="fileHeadingId(fileIndex)"
            >
              <header class="workspace-review-file-header">
                <span class="workspace-review-file-kind" :data-kind="file.kind">{{ kindLabel(file) }}</span>
                <span :id="fileHeadingId(fileIndex)" class="workspace-review-file-path">
                  <span v-if="file.previousPath" class="workspace-review-previous-path">
                    {{ file.previousPath }} →
                  </span>
                  {{ file.path }}
                </span>
                <span class="workspace-review-file-stats">
                  <span class="workspace-review-stat is-added">+{{ file.additions }}</span>
                  <span class="workspace-review-stat is-removed">−{{ file.deletions }}</span>
                </span>
              </header>

              <div class="workspace-review-code" role="list" :aria-label="`Changes in ${file.path}`">
                <div
                  v-for="line in file.lines"
                  :key="line.id"
                  class="workspace-review-line"
                  :data-kind="line.kind"
                  role="listitem"
                  :aria-label="lineAriaLabel(line)"
                >
                  <span class="workspace-review-line-number" aria-hidden="true">{{ line.oldLine ?? '' }}</span>
                  <span class="workspace-review-line-number" aria-hidden="true">{{ line.newLine ?? '' }}</span>
                  <code aria-hidden="true"><span class="workspace-review-line-marker">{{ line.marker }}</span>{{ line.text }}</code>
                </div>
              </div>
              <p v-if="file.isTruncated" class="workspace-review-file-truncation">
                This preview is shortened for performance ({{ file.lines.length }} of {{ file.totalLines }} diff lines retained).
              </p>
            </section>
          </template>
        </main>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileDiff,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  WrapText,
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
import { getGitWorkspaceReview } from '../../api/codexGateway'
import type {
  GitWorkspaceBaseBranch,
  GitWorkspaceReviewSource,
  GitWorkspaceStatus,
  ReviewChangesData,
  ReviewDiffFile,
  ReviewDiffLine,
} from '../../types/codex'

type ReviewPanelSource = 'last-turn' | GitWorkspaceReviewSource

const props = withDefaults(defineProps<{
  open: boolean
  threadId: string
  cwd: string
  status: GitWorkspaceStatus | null
  lastTurnChanges?: ReviewChangesData | null
  initialSource?: ReviewPanelSource
  refreshKey?: number
}>(), {
  lastTurnChanges: null,
  initialSource: 'uncommitted',
  refreshKey: 0,
})

const emit = defineEmits<{
  'update:open': [open: boolean]
}>()

const selectedSource = ref<ReviewPanelSource>(props.initialSource)
const selectedBaseBranchRef = ref('')
const selectedPath = ref('')
const sourceMenuOpen = ref(false)
const branchMenuOpen = ref(false)
const branchQuery = ref('')
const wrapLines = ref(false)
const isLoading = ref(false)
const loadError = ref('')
const loadedChanges = ref<ReviewChangesData | null>(null)
const omittedUntrackedFiles = ref(0)
let requestToken = 0
const isDockedReview = useMediaQuery('(min-width: 1280px) and (pointer: fine)')

const sourceOptions = computed<Array<{ value: ReviewPanelSource; label: string }>>(() => [
  { value: 'last-turn', label: 'Last Turn' },
  { value: 'uncommitted', label: 'Uncommitted' },
  { value: 'unstaged', label: 'Unstaged' },
  { value: 'staged', label: 'Staged' },
  { value: 'branch', label: 'Branch' },
])

const selectedSourceLabel = computed(() => (
  sourceOptions.value.find((option) => option.value === selectedSource.value)?.label ?? 'Review'
))

const changes = computed(() => (
  selectedSource.value === 'last-turn' ? props.lastTurnChanges ?? null : loadedChanges.value
))

const baseBranches = computed(() => props.status?.baseBranches ?? [])
const selectedBaseBranch = computed<GitWorkspaceBaseBranch | null>(() => (
  baseBranches.value.find((branch) => branch.ref === selectedBaseBranchRef.value) ?? null
))
const filteredBaseBranches = computed(() => {
  const query = branchQuery.value.trim().toLocaleLowerCase()
  return baseBranches.value
    .filter((branch) => !query || branch.name.toLocaleLowerCase().includes(query))
    .slice(0, 100)
})

const basenameCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const file of changes.value?.files ?? []) {
    const name = basename(file.path)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
})

const fileCountLabel = computed(() => {
  const count = changes.value?.fileCount ?? 0
  return `${count.toString()} ${count === 1 ? 'file' : 'files'} changed`
})

const sourceDescription = computed(() => {
  if (selectedSource.value === 'last-turn') return 'Changes from the most recent Codex turn'
  if (selectedSource.value === 'unstaged') return 'Working tree changes that are not staged'
  if (selectedSource.value === 'staged') return 'Changes currently staged for commit'
  if (selectedSource.value === 'branch') return 'Changes on this branch compared with a base branch'
  return 'All staged, unstaged, and untracked changes'
})

const emptyStateTitle = computed(() => {
  if (selectedSource.value === 'last-turn') return 'No latest turn changes'
  if (selectedSource.value === 'unstaged') return 'No unstaged changes'
  if (selectedSource.value === 'staged') return 'No staged changes'
  if (selectedSource.value === 'branch') return selectedBaseBranch.value ? 'No branch changes' : 'Select a branch'
  return 'No uncommitted changes'
})

const emptyStateDescription = computed(() => {
  if (selectedSource.value === 'last-turn') return 'The latest saved turn has no file changes to review.'
  if (selectedSource.value === 'unstaged') return 'Working tree edits will appear here.'
  if (selectedSource.value === 'staged') return 'Stage a change to review it here.'
  if (selectedSource.value === 'branch') {
    return selectedBaseBranch.value
      ? `This branch matches ${selectedBaseBranch.value.name}.`
      : 'Choose a base branch to compare with the current branch.'
  }
  return 'Changes in this project will appear here.'
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    selectedSource.value = props.initialSource
    ensureBaseBranch()
    void refreshReview()
  },
)

watch(
  () => props.refreshKey,
  () => {
    if (props.open && selectedSource.value !== 'last-turn') void refreshReview()
  },
)

watch(
  () => [props.threadId, props.cwd] as const,
  () => {
    requestToken += 1
    selectedBaseBranchRef.value = ''
    selectedPath.value = ''
    branchQuery.value = ''
    loadedChanges.value = null
    omittedUntrackedFiles.value = 0
    loadError.value = ''
    isLoading.value = false
  },
)

watch(
  () => props.status?.baseBranches,
  () => {
    const changed = ensureBaseBranch()
    if (changed && props.open && selectedSource.value === 'branch') {
      clearLoadedReview()
      void refreshReview()
    }
  },
  { deep: true },
)

function ensureBaseBranch(): boolean {
  if (selectedBaseBranch.value) return false
  const previousRef = selectedBaseBranchRef.value
  const defaultRef = props.status?.defaultBaseBranch ?? ''
  selectedBaseBranchRef.value = baseBranches.value.some((branch) => branch.ref === defaultRef)
    ? defaultRef
    : baseBranches.value[0]?.ref ?? ''
  return selectedBaseBranchRef.value !== previousRef
}

function clearLoadedReview(): void {
  requestToken += 1
  selectedPath.value = ''
  loadedChanges.value = null
  omittedUntrackedFiles.value = 0
  isLoading.value = false
  loadError.value = ''
}

function selectSource(source: ReviewPanelSource): void {
  sourceMenuOpen.value = false
  selectedSource.value = source
  clearLoadedReview()
  if (source === 'branch') ensureBaseBranch()
  void refreshReview()
}

function selectBaseBranch(branch: string): void {
  branchMenuOpen.value = false
  branchQuery.value = ''
  if (selectedBaseBranchRef.value === branch) return
  selectedBaseBranchRef.value = branch
  clearLoadedReview()
  void refreshReview()
}

function preventTouchPopoverAutofocus(event: Event): void {
  if (window.matchMedia('(pointer: coarse)').matches) event.preventDefault()
}

async function refreshReview(): Promise<void> {
  if (!props.open) return
  if (selectedSource.value === 'last-turn') {
    requestToken += 1
    isLoading.value = false
    loadError.value = ''
    loadedChanges.value = null
    omittedUntrackedFiles.value = 0
    return
  }
  if (!props.cwd.trim()) return
  if (selectedSource.value === 'branch' && !selectedBaseBranchRef.value) {
    loadedChanges.value = null
    return
  }

  const token = ++requestToken
  isLoading.value = true
  loadedChanges.value = null
  omittedUntrackedFiles.value = 0
  loadError.value = ''
  try {
    const result = await getGitWorkspaceReview(
      props.threadId,
      selectedSource.value,
      selectedSource.value === 'branch' ? selectedBaseBranchRef.value : undefined,
    )
    if (token !== requestToken) return
    if (result.baseBranch) selectedBaseBranchRef.value = result.baseBranch.ref
    loadedChanges.value = result.changes
    omittedUntrackedFiles.value = result.omittedUntrackedFiles
    selectedPath.value = result.changes?.files[0]?.path ?? ''
  } catch (error) {
    if (token !== requestToken) return
    loadedChanges.value = null
    omittedUntrackedFiles.value = 0
    loadError.value = error instanceof Error ? error.message : 'Review failed to load.'
  } finally {
    if (token === requestToken) isLoading.value = false
  }
}

function preventOutsideClose(event: Event): void {
  event.preventDefault()
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) || path
}

function kindLabel(file: ReviewDiffFile): string {
  if (file.previousPath) return 'R'
  if (file.kind === 'add') return 'A'
  if (file.kind === 'delete') return 'D'
  return 'M'
}

function fileChangeLabel(file: ReviewDiffFile): string {
  if (file.previousPath) return 'Renamed'
  if (file.kind === 'add') return 'Added'
  if (file.kind === 'delete') return 'Deleted'
  return 'Modified'
}

function displayFileName(file: ReviewDiffFile): string {
  const name = basename(file.path)
  return (basenameCounts.value.get(name) ?? 0) > 1 ? file.path : name
}

function fileButtonLabel(file: ReviewDiffFile): string {
  return `${fileChangeLabel(file)} ${file.path}. ${file.additions} additions, ${file.deletions} deletions.`
}

function lineAriaLabel(line: ReviewDiffLine): string {
  if (line.kind === 'added') return `Added line ${line.newLine?.toString() ?? ''}: ${line.text}`
  if (line.kind === 'removed') return `Removed line ${line.oldLine?.toString() ?? ''}: ${line.text}`
  if (line.kind === 'context') return `Unchanged line ${line.newLine?.toString() ?? ''}: ${line.text}`
  return line.text || 'Diff section'
}

function fileDomId(index: number): string {
  return `workspace-review-file-${index.toString()}`
}

function fileHeadingId(index: number): string {
  return `workspace-review-file-heading-${index.toString()}`
}

function focusFile(path: string, index: number): void {
  selectedPath.value = path
  void nextTick(() => {
    window.requestAnimationFrame(() => {
      document.getElementById(fileDomId(index))?.scrollIntoView({ block: 'start' })
    })
  })
}
</script>

<style scoped>
@reference "tailwindcss";

.workspace-review-panel {
  --workspace-review-added: #116b36;
  --workspace-review-added-bg: color-mix(in srgb, var(--workspace-review-added) 13%, transparent);
  --workspace-review-removed: #b42318;
  --workspace-review-removed-bg: color-mix(in srgb, var(--workspace-review-removed) 12%, transparent);
}

:global(html[data-theme='dark'] .workspace-review-panel) {
  --workspace-review-added: #73d99a;
  --workspace-review-added-bg: color-mix(in srgb, var(--workspace-review-added) 15%, transparent);
  --workspace-review-removed: #ff8f88;
  --workspace-review-removed-bg: color-mix(in srgb, var(--workspace-review-removed) 14%, transparent);
}

.workspace-review-overlay {
  @apply fixed inset-0;
  z-index: 150;
  background: var(--overlay);
}

.workspace-review-panel {
  @apply fixed inset-y-0 right-0 flex min-w-0 flex-col border-l shadow-2xl outline-none;
  z-index: 151;
  width: min(64rem, max(34rem, 46vw));
  border-color: var(--border-strong);
  background: var(--content-bg);
  color: var(--text-primary);
}

.workspace-review-header {
  @apply flex min-h-16 shrink-0 items-center justify-between gap-3 border-b px-4 py-2;
  border-color: var(--border-soft);
  padding-top: max(0.5rem, env(safe-area-inset-top));
}

.workspace-review-heading {
  @apply min-w-0 flex-1;
}

.workspace-review-title-row {
  @apply flex min-w-0 items-center gap-2;
}

.workspace-review-title {
  @apply truncate text-base font-semibold;
}

.workspace-review-source-trigger {
  @apply max-w-44 min-w-0 justify-start px-2;
  color: var(--text-secondary);
}

.workspace-review-source-trigger svg,
.workspace-review-base-trigger svg {
  @apply h-3.5 w-3.5 shrink-0;
}

.workspace-review-description {
  @apply mt-0.5 flex min-w-0 items-center gap-2 truncate text-xs;
  color: var(--text-muted);
}

.workspace-review-actions {
  @apply flex shrink-0 items-center gap-0.5;
}

.workspace-review-action {
  color: var(--text-tertiary);
}

.workspace-review-action:hover,
.workspace-review-action.is-active {
  color: var(--text-primary);
}

.workspace-review-action.is-active {
  background: var(--accent-soft);
}

.workspace-review-action svg {
  @apply h-4 w-4;
}

.workspace-review-branch-bar {
  @apply flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-muted);
}

.workspace-review-current-branch {
  @apply flex min-w-0 items-center gap-1.5 truncate font-mono;
}

.workspace-review-current-branch svg,
.workspace-review-branch-bar > svg {
  @apply h-3.5 w-3.5 shrink-0;
}

.workspace-review-base-trigger {
  @apply min-w-0 max-w-72 justify-between font-mono;
}

.workspace-review-base-trigger span {
  @apply truncate;
}

:global(.workspace-review-source-menu) {
  width: 13rem !important;
  gap: 0.125rem !important;
  padding: 0.25rem !important;
  z-index: 165 !important;
}

:global(.workspace-review-branch-menu) {
  width: min(22rem, calc(100vw - 1rem)) !important;
  gap: 0.375rem !important;
  padding: 0.375rem !important;
  z-index: 165 !important;
}

.workspace-review-menu-item {
  @apply flex min-h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border-0 bg-transparent px-2.5 text-left text-sm outline-none;
  color: var(--text-secondary);
}

.workspace-review-menu-item:hover,
.workspace-review-menu-item:focus-visible,
.workspace-review-menu-item.is-selected {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.workspace-review-menu-item span {
  @apply min-w-0 truncate;
}

.workspace-review-menu-item svg {
  @apply h-4 w-4 shrink-0;
  color: var(--accent);
}

.workspace-review-branch-search {
  @apply h-9;
  background: var(--surface-elevated);
}

.workspace-review-branch-list {
  @apply max-h-64 overflow-y-auto;
  overscroll-behavior: contain;
}

.workspace-review-menu-empty {
  @apply m-0 px-3 py-5 text-center text-xs;
  color: var(--text-muted);
}

.workspace-review-file-nav {
  @apply flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5;
  border-color: var(--border-soft);
  background: var(--surface-muted);
}

.workspace-review-file-nav-item {
  @apply inline-flex h-8 max-w-64 shrink-0 items-center gap-1.5 rounded-lg border border-transparent bg-transparent px-2 text-xs outline-none;
  color: var(--text-secondary);
}

.workspace-review-file-nav-item:hover {
  background: var(--surface-hover);
}

.workspace-review-file-nav-item:focus-visible,
.workspace-review-file-nav-item.is-selected {
  border-color: var(--border-strong);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.workspace-review-file-nav-item > span:nth-child(2) {
  @apply truncate;
}

.workspace-review-file-kind {
  @apply inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold;
  background: var(--surface-elevated);
  color: var(--text-muted);
}

.workspace-review-file-kind[data-kind='add'] {
  background: color-mix(in srgb, var(--workspace-review-added) 14%, var(--surface-elevated));
  color: var(--workspace-review-added);
}

.workspace-review-file-kind[data-kind='delete'] {
  background: color-mix(in srgb, var(--workspace-review-removed) 13%, var(--surface-elevated));
  color: var(--workspace-review-removed);
}

.workspace-review-file-kind[data-kind='update'] {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.workspace-review-file-stats {
  @apply flex shrink-0 gap-1.5;
}

.workspace-review-stat {
  @apply font-mono text-[11px] font-semibold tabular-nums;
}

.workspace-review-stat.is-added {
  color: var(--workspace-review-added);
}

.workspace-review-stat.is-removed {
  color: var(--workspace-review-removed);
}

.workspace-review-notice {
  @apply m-0 shrink-0 border-b px-4 py-2 text-xs leading-5;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-muted);
}

.workspace-review-notice.is-inline {
  @apply mb-3 rounded-xl border;
}

.workspace-review-body {
  @apply min-h-0 flex-1 overflow-auto p-3;
  overscroll-behavior: contain;
  padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
}

.workspace-review-state {
  @apply mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-2 px-5 py-10 text-center;
  color: var(--text-muted);
}

.workspace-review-state > svg {
  @apply mb-2 h-7 w-7;
}

.workspace-review-state strong {
  @apply text-sm font-semibold;
  color: var(--text-primary);
}

.workspace-review-state p {
  @apply m-0 text-sm leading-5;
}

.workspace-review-state.is-error > svg,
.workspace-review-state.is-error p {
  color: var(--destructive);
}

.workspace-review-file-diff {
  @apply mb-3 min-w-0 overflow-hidden rounded-xl border;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  scroll-margin-top: 0.75rem;
}

.workspace-review-file-header {
  @apply sticky top-0 z-[1] flex min-h-11 items-center gap-2 border-b px-3 text-xs;
  border-color: var(--border-soft);
  background: color-mix(in srgb, var(--surface-muted) 96%, transparent);
  backdrop-filter: blur(8px);
}

.workspace-review-file-path {
  @apply min-w-0 flex-1 truncate font-mono;
}

.workspace-review-previous-path {
  color: var(--text-muted);
}

.workspace-review-code {
  @apply min-w-full overflow-x-auto font-mono text-[12px] leading-5;
  font-variant-ligatures: none;
}

.workspace-review-line {
  display: grid;
  grid-template-columns: 3.25rem 3.25rem minmax(max-content, 1fr);
  width: max-content;
  min-width: 100%;
}

.workspace-review-line[data-kind='added'] {
  background: var(--workspace-review-added-bg);
}

.workspace-review-line[data-kind='removed'] {
  background: var(--workspace-review-removed-bg);
}

.workspace-review-line[data-kind='meta'] {
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-muted));
  color: var(--text-muted);
}

.workspace-review-line-number {
  @apply select-none border-r px-2 text-right tabular-nums;
  border-color: color-mix(in srgb, var(--border-soft) 75%, transparent);
  color: var(--text-faint);
}

.workspace-review-line code {
  @apply block px-2;
  color: var(--text-primary);
  white-space: pre;
}

.workspace-review-line-marker {
  @apply inline-block w-4 select-none font-bold;
}

.workspace-review-line[data-kind='added'] .workspace-review-line-marker {
  color: var(--workspace-review-added);
}

.workspace-review-line[data-kind='removed'] .workspace-review-line-marker {
  color: var(--workspace-review-removed);
}

.workspace-review-file-truncation {
  @apply m-0 border-t px-3 py-2 text-xs leading-5;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-muted);
}

.workspace-review-body.is-wrapped .workspace-review-line {
  grid-template-columns: 3.25rem 3.25rem minmax(0, 1fr);
  width: 100%;
}

.workspace-review-body.is-wrapped .workspace-review-line code {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.is-spinning {
  animation: workspace-review-spin 0.8s linear infinite;
}

@keyframes workspace-review-spin {
  to { transform: rotate(360deg); }
}

@media (pointer: coarse) {
  .workspace-review-source-trigger,
  .workspace-review-base-trigger,
  .workspace-review-action,
  .workspace-review-menu-item,
  .workspace-review-file-nav-item {
    min-height: 44px;
  }

  .workspace-review-action {
    min-width: 44px;
  }
}

@media (max-width: 640px), (pointer: coarse) and (max-width: 1024px) {
  .workspace-review-panel {
    @apply inset-0 w-full border-0;
    height: var(--visual-viewport-height, 100dvh);
  }

  .workspace-review-header {
    @apply min-h-16 gap-1 px-2;
    padding-left: max(0.5rem, env(safe-area-inset-left));
    padding-right: max(0.5rem, env(safe-area-inset-right));
  }

  .workspace-review-title {
    @apply text-sm;
  }

  .workspace-review-source-trigger {
    @apply max-w-32;
  }

  .workspace-review-description {
    @apply max-w-[52vw];
  }

  .workspace-review-branch-bar {
    @apply grid min-h-[4.25rem] grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)] px-2;
    padding-left: max(0.5rem, env(safe-area-inset-left));
    padding-right: max(0.5rem, env(safe-area-inset-right));
  }

  .workspace-review-base-trigger {
    @apply max-w-none;
  }

  .workspace-review-file-nav {
    @apply py-2;
    padding-left: max(0.5rem, env(safe-area-inset-left));
    padding-right: max(0.5rem, env(safe-area-inset-right));
  }

  .workspace-review-file-nav-item {
    @apply max-w-52;
  }

  .workspace-review-body {
    padding-top: 0.5rem;
    padding-right: max(0.5rem, env(safe-area-inset-right));
    padding-bottom: max(0.5rem, env(safe-area-inset-bottom));
    padding-left: max(0.5rem, env(safe-area-inset-left));
  }

  .workspace-review-file-header {
    @apply min-h-12 px-2;
  }

  .workspace-review-file-path {
    @apply text-[11px];
  }

  .workspace-review-code {
    @apply text-[11px] leading-[1.15rem];
  }

  .workspace-review-line {
    grid-template-columns: 2.75rem 2.75rem minmax(max-content, 1fr);
  }

  .workspace-review-body.is-wrapped .workspace-review-line {
    grid-template-columns: 2.75rem 2.75rem minmax(0, 1fr);
  }

  :global(.workspace-review-source-menu),
  :global(.workspace-review-branch-menu) {
    max-height: min(60dvh, var(--reka-popover-content-available-height)) !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .is-spinning {
    animation-duration: 1.6s;
  }
}
</style>
