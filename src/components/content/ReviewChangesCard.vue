<template>
  <section class="review-card" :aria-label="reviewSummaryLabel">
    <div class="review-card-heading">
      <button
        type="button"
        class="review-card-summary"
        :aria-expanded="panelOpen"
        :aria-label="reviewSummaryLabel"
        @click="openReview()"
      >
        <span class="review-card-icon" aria-hidden="true">
          <FileDiff />
        </span>
        <span class="review-card-copy">
          <strong>{{ cardTitle }}</strong>
          <span class="review-card-subtitle">
            <span class="review-stat review-stat-added">+{{ changes.additions }}</span>
            <span class="review-stat review-stat-removed">−{{ changes.deletions }}</span>
            <span class="review-card-hover-copy">Review changes <ArrowRight aria-hidden="true" /></span>
          </span>
        </span>
      </button>

      <div class="review-card-actions">
        <button type="button" class="review-card-button" @click="openReview()">Review</button>
        <button
          type="button"
          class="review-card-button review-card-button-icon"
          :disabled="actionBusy || !canApply"
          :aria-label="patchActionLabel"
          :aria-describedby="actionDisabledReason ? actionDescriptionId : undefined"
          :title="patchActionLabel"
          @click="onPatchAction"
        >
          <LoaderCircle v-if="actionBusy" class="review-spin" aria-hidden="true" />
          <Redo2 v-else-if="isUndone" aria-hidden="true" />
          <Undo2 v-else aria-hidden="true" />
        </button>
      </div>
    </div>

    <p v-if="actionDisabledReason" :id="actionDescriptionId" class="review-disabled-reason">
      {{ actionDisabledReason }}
    </p>

    <ul class="review-card-files">
      <li v-for="file in visibleFiles" :key="file.path">
        <button
          type="button"
          class="review-card-file"
          :aria-label="fileButtonLabel(file)"
          @click="openReview(file.path)"
        >
          <span
            class="review-file-kind"
            :data-kind="file.kind"
            role="img"
            :aria-label="fileChangeLabel(file)"
          >{{ kindLabel(file) }}</span>
          <span class="review-card-file-path" :title="file.path">{{ file.path }}</span>
          <span class="review-card-file-stats" aria-hidden="true">
            <span class="review-stat review-stat-added">+{{ file.additions }}</span>
            <span class="review-stat review-stat-removed">−{{ file.deletions }}</span>
          </span>
          <ChevronRight aria-hidden="true" />
        </button>
      </li>
    </ul>

    <button
      v-if="expandableHiddenFileCount > 0 || filesExpanded"
      type="button"
      class="review-card-expand"
      :aria-expanded="filesExpanded"
      @click="filesExpanded = !filesExpanded"
    >
      <ChevronDown :class="{ 'is-expanded': filesExpanded }" aria-hidden="true" />
      {{ filesExpanded ? 'Collapse files' : `Show ${expandableHiddenFileCount.toString()} more ${expandableHiddenFileCount === 1 ? 'file' : 'files'}` }}
    </button>

    <p v-if="filesTruncationMessage" class="review-truncation-note">
      {{ filesTruncationMessage }}
    </p>

    <p class="review-action-status" aria-live="polite" :data-tone="actionTone">
      {{ actionMessage }}
    </p>
  </section>

  <DialogRoot :open="panelOpen" @update:open="onPanelOpenChange">
    <DialogPortal>
      <DialogOverlay class="review-panel-overlay" />
      <DialogContent
        class="review-panel"
        aria-describedby="review-panel-description"
        @pointer-down-outside="preventOutsideClose"
        @interact-outside="preventOutsideClose"
      >
        <header class="review-panel-header">
          <div class="review-panel-title-wrap">
            <DialogTitle class="review-panel-title">Review changes</DialogTitle>
            <DialogDescription id="review-panel-description" class="review-panel-description">
              {{ fileCountLabel }}
              <span class="review-stat review-stat-added">+{{ changes.additions }}</span>
              <span class="review-stat review-stat-removed">−{{ changes.deletions }}</span>
            </DialogDescription>
          </div>
          <div class="review-panel-actions">
            <button
              type="button"
              class="review-toolbar-button"
              :class="{ 'is-active': wrapLines }"
              :aria-pressed="wrapLines"
              @click="wrapLines = !wrapLines"
            >
              <WrapText aria-hidden="true" />
              <span>Wrap</span>
            </button>
            <button
              type="button"
              class="review-toolbar-button"
              :disabled="actionBusy || !canApply"
              :aria-label="patchActionLabel"
              :aria-describedby="actionDisabledReason ? panelActionDescriptionId : undefined"
              :title="patchActionLabel"
              @click="onPatchAction"
            >
              <LoaderCircle v-if="actionBusy" class="review-spin" aria-hidden="true" />
              <Redo2 v-else-if="isUndone" aria-hidden="true" />
              <Undo2 v-else aria-hidden="true" />
              <span>{{ isUndone ? 'Reapply' : 'Undo' }}</span>
            </button>
            <button type="button" class="review-panel-close" aria-label="Close review" @click="closeReview">
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <p
          v-if="actionDisabledReason"
          :id="panelActionDescriptionId"
          class="review-panel-notice review-disabled-reason"
        >
          {{ actionDisabledReason }}
        </p>

        <nav class="review-file-nav" aria-label="Changed files">
          <button
            v-for="(file, index) in changes.files"
            :key="file.path"
            type="button"
            class="review-file-nav-item"
            :class="{ 'is-selected': selectedPath === file.path }"
            :aria-current="selectedPath === file.path ? 'true' : undefined"
            :aria-label="fileButtonLabel(file)"
            @click="focusFile(file.path, index)"
          >
            <span
              class="review-file-kind"
              :data-kind="file.kind"
              role="img"
              :aria-label="fileChangeLabel(file)"
            >{{ kindLabel(file) }}</span>
            <span :title="file.path">{{ displayFileName(file) }}</span>
            <span class="review-file-nav-stats" aria-hidden="true">
              <span class="review-stat review-stat-added">+{{ file.additions }}</span>
              <span class="review-stat review-stat-removed">−{{ file.deletions }}</span>
            </span>
          </button>
        </nav>

        <p v-if="filesTruncationMessage" class="review-panel-notice review-truncation-note">
          {{ filesTruncationMessage }}
        </p>

        <div class="review-panel-body" :class="{ 'is-wrapped': wrapLines }">
          <p v-if="changes.files.length === 0" class="review-empty-state">
            The changed-file list is too large to preview here.
            {{ actionDisabledReason || 'Undo remains available for the complete patch.' }}
          </p>
          <section
            v-for="(file, fileIndex) in changes.files"
            :id="fileDomId(fileIndex)"
            :key="file.path"
            class="review-file-diff"
            :data-review-path="file.path"
            :aria-labelledby="fileHeadingId(fileIndex)"
          >
            <header class="review-file-header">
              <span
                class="review-file-kind"
                :data-kind="file.kind"
                role="img"
                :aria-label="fileChangeLabel(file)"
              >{{ kindLabel(file) }}</span>
              <span :id="fileHeadingId(fileIndex)" class="review-file-header-path">
                <span v-if="file.previousPath" class="review-file-previous">{{ file.previousPath }} →</span>
                {{ file.path }}
              </span>
              <span class="review-file-header-stats">
                <span class="review-stat review-stat-added">+{{ file.additions }}</span>
                <span class="review-stat review-stat-removed">−{{ file.deletions }}</span>
              </span>
            </header>

            <div class="review-diff-code" role="list" :aria-label="`Changes in ${file.path}`">
              <div
                v-for="line in file.lines"
                :key="line.id"
                class="review-diff-line"
                :data-kind="line.kind"
                role="listitem"
                :aria-label="lineAriaLabel(line)"
              >
                <span class="review-line-number" aria-hidden="true">{{ line.oldLine ?? '' }}</span>
                <span class="review-line-number" aria-hidden="true">{{ line.newLine ?? '' }}</span>
                <code aria-hidden="true"><span class="review-line-marker">{{ line.marker }}</span>{{ line.text }}</code>
              </div>
            </div>
            <p v-if="file.isTruncated" class="review-file-truncation">
              This preview is shortened for performance ({{ file.lines.length }} of {{ file.totalLines }} diff lines retained).
            </p>
          </section>
        </div>

        <footer v-if="actionMessage" class="review-panel-status" aria-live="polite" :data-tone="actionTone">
          {{ actionMessage }}
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <DialogRoot :open="confirmOpen" @update:open="confirmOpen = $event">
    <DialogPortal>
      <DialogOverlay class="review-confirm-overlay" />
      <DialogContent
        class="review-confirm-dialog"
        role="alertdialog"
        aria-describedby="review-confirm-description"
        @open-auto-focus="focusConfirmCancel"
      >
        <DialogTitle class="review-confirm-title">Revert changes?</DialogTitle>
        <DialogDescription id="review-confirm-description" class="review-confirm-description">
          This action removes all of these changes. If newer edits overlap, CodexUI will stop without forcing them.
        </DialogDescription>
        <div class="review-confirm-actions">
          <button ref="confirmCancelRef" type="button" class="review-confirm-button" @click="confirmOpen = false">
            Cancel
          </button>
          <button type="button" class="review-confirm-button review-confirm-danger" @click="confirmUndo">
            Revert changes
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FileDiff,
  LoaderCircle,
  Redo2,
  Undo2,
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
import { applyReviewChanges } from '../../api/codexGateway'
import type {
  ReviewChangesData,
  ReviewDiffFile,
  ReviewDiffLine,
} from '../../types/codex'

const props = defineProps<{
  changes: ReviewChangesData
  threadId: string
  turnId: string
  disabled?: boolean
}>()

const filesExpanded = ref(false)
const panelOpen = ref(false)
const confirmOpen = ref(false)
const selectedPath = ref('')
const wrapLines = ref(false)
const actionBusy = ref(false)
const isUndone = ref(readStoredUndoneState())
const actionMessage = ref('')
const actionTone = ref<'success' | 'error' | ''>('')
const confirmCancelRef = ref<HTMLButtonElement | null>(null)

const domIdSuffix = computed(() => (props.turnId || 'turn').replace(/[^a-zA-Z0-9_-]/g, '-'))
const canApply = computed(() => Boolean(
  !props.disabled
  && !props.changes.actionUnavailableReason
  && props.threadId
  && props.turnId
  && props.changes.patchBatches.length > 0,
))
const visibleFiles = computed(() => filesExpanded.value ? props.changes.files : props.changes.files.slice(0, 3))
const expandableHiddenFileCount = computed(() => Math.max(0, props.changes.files.length - visibleFiles.value.length))
const unlistedFileCount = computed(() => Math.max(0, props.changes.fileCount - props.changes.files.length))
const basenameCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const file of props.changes.files) {
    const name = basename(file.path)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
})
const cardTitle = computed(() => {
  if (props.changes.fileCount === 1 && props.changes.files[0]) {
    return `Edited ${basename(props.changes.files[0].path)}`
  }
  return `Edited ${props.changes.fileCount.toString()} ${props.changes.fileCount === 1 ? 'file' : 'files'}`
})
const fileCountLabel = computed(() => {
  const count = props.changes.fileCount
  return `${count.toString()} ${count === 1 ? 'file' : 'files'} changed`
})
const reviewSummaryLabel = computed(() => (
  `${cardTitle.value}. ${lineChangesLabel(props.changes.additions, props.changes.deletions)}. Review changed files.`
))
const filesTruncationMessage = computed(() => {
  if (!props.changes.filesTruncated) return ''
  if (unlistedFileCount.value > 0) {
    return `${unlistedFileCount.value.toString()} more changed ${unlistedFileCount.value === 1 ? 'file is' : 'files are'} not shown.`
  }
  return 'Some changed files are not shown.'
})
const actionDisabledReason = computed(() => {
  if (actionBusy.value) return ''
  if (props.disabled) {
    return `Wait for the current turn to finish before ${isUndone.value ? 'reapplying' : 'undoing'} changes.`
  }
  if (!props.threadId || !props.turnId) return 'Undo is unavailable because this change is no longer attached to a turn.'
  if (props.changes.patchBatches.length === 0) return 'Undo is unavailable because no reversible patch was provided.'
  if (props.changes.actionUnavailableReason) return props.changes.actionUnavailableReason
  return ''
})
const actionDescriptionId = computed(() => `review-action-disabled-${domIdSuffix.value}`)
const panelActionDescriptionId = computed(() => `review-panel-action-disabled-${domIdSuffix.value}`)
const patchActionLabel = computed(() => {
  if (actionBusy.value) return isUndone.value ? 'Reapplying changes' : 'Reverting changes'
  if (actionDisabledReason.value) return actionDisabledReason.value
  return isUndone.value ? 'Reapply changes' : 'Undo changes'
})

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) || path
}

function reviewActionStorageKey(): string {
  return `codexui.review-changes.${props.threadId}.${props.turnId}`
}

function readStoredUndoneState(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(reviewActionStorageKey()) === 'undone'
  } catch {
    return false
  }
}

function storeUndoneState(undone: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (undone) {
      window.localStorage.setItem(reviewActionStorageKey(), 'undone')
    } else {
      window.localStorage.removeItem(reviewActionStorageKey())
    }
  } catch {
    // Storage can be unavailable in private browsing; the mounted card still stays accurate.
  }
}

function syncStoredUndoneState(event: StorageEvent): void {
  if (event.key !== reviewActionStorageKey()) return
  isUndone.value = event.newValue === 'undone'
  actionMessage.value = ''
  actionTone.value = ''
}

onMounted(() => window.addEventListener('storage', syncStoredUndoneState))
onBeforeUnmount(() => window.removeEventListener('storage', syncStoredUndoneState))

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

function lineChangesLabel(additions: number, deletions: number): string {
  const added = `${additions.toString()} ${additions === 1 ? 'addition' : 'additions'}`
  const removed = `${deletions.toString()} ${deletions === 1 ? 'deletion' : 'deletions'}`
  return `${added}, ${removed}`
}

function displayFileName(file: ReviewDiffFile): string {
  const name = basename(file.path)
  return (basenameCounts.value.get(name) ?? 0) > 1 ? file.path : name
}

function fileButtonLabel(file: ReviewDiffFile): string {
  const previousPath = file.previousPath ? ` from ${file.previousPath}` : ''
  return `${fileChangeLabel(file)} ${file.path}${previousPath}. ${lineChangesLabel(file.additions, file.deletions)}. Review changes.`
}

function fileDomId(index: number): string {
  return `review-file-${domIdSuffix.value}-${index.toString()}`
}

function fileHeadingId(index: number): string {
  return `review-file-heading-${domIdSuffix.value}-${index.toString()}`
}

function lineAriaLabel(line: ReviewDiffLine): string {
  if (line.kind === 'added') return `Added line ${line.newLine?.toString() ?? ''}: ${line.text}`
  if (line.kind === 'removed') return `Removed line ${line.oldLine?.toString() ?? ''}: ${line.text}`
  if (line.kind === 'context') return `Unchanged line ${line.newLine?.toString() ?? ''}: ${line.text}`
  return line.text || 'Diff section'
}

function openReview(path = ''): void {
  const index = path ? props.changes.files.findIndex((file) => file.path === path) : 0
  selectedPath.value = props.changes.files[Math.max(0, index)]?.path ?? ''
  panelOpen.value = true
  if (index > 0) scrollToFile(index)
}

function closeReview(): void {
  panelOpen.value = false
}

function onPanelOpenChange(open: boolean): void {
  panelOpen.value = open
}

function preventOutsideClose(event: Event): void {
  event.preventDefault()
}

function scrollToFile(index: number): void {
  void nextTick(() => {
    window.requestAnimationFrame(() => {
      document.getElementById(fileDomId(index))?.scrollIntoView({ block: 'start' })
    })
  })
}

function focusFile(path: string, index: number): void {
  selectedPath.value = path
  scrollToFile(index)
}

function onPatchAction(): void {
  if (actionBusy.value || !canApply.value) return
  if (isUndone.value) {
    void runPatchAction(false)
    return
  }
  confirmOpen.value = true
}

function focusConfirmCancel(event: Event): void {
  event.preventDefault()
  void nextTick(() => confirmCancelRef.value?.focus())
}

function confirmUndo(): void {
  confirmOpen.value = false
  void runPatchAction(true)
}

async function runPatchAction(reverse: boolean): Promise<void> {
  actionBusy.value = true
  actionMessage.value = reverse ? 'Reverting changes…' : 'Reapplying changes…'
  actionTone.value = ''
  try {
    const result = await applyReviewChanges(props.threadId, props.turnId, reverse, {
      additions: props.changes.additions,
      batchFingerprints: props.changes.patchBatches.map(({ id, cwd, fingerprint }) => ({ id, cwd, fingerprint })),
      changeCount: props.changes.changeCount,
      deletions: props.changes.deletions,
      fileCount: props.changes.fileCount,
    })
    if (result.status !== 'success') {
      if (result.state === 'undone' || result.state === 'applied') {
        const undone = result.state === 'undone'
        isUndone.value = undone
        storeUndoneState(undone)
        actionMessage.value = undone
          ? 'These changes are already reverted. You can reapply them.'
          : 'These changes are already applied. You can undo them.'
      } else {
        actionMessage.value = result.error || (reverse ? 'No changes were reverted.' : 'No changes were reapplied.')
      }
      actionTone.value = result.state === 'undone' || result.state === 'applied' ? 'success' : 'error'
      return
    }
    isUndone.value = reverse
    storeUndoneState(reverse)
    actionMessage.value = reverse ? 'Changes reverted.' : 'Changes reapplied.'
    actionTone.value = 'success'
  } catch (error) {
    actionMessage.value = error instanceof Error
      ? error.message
      : reverse ? 'Failed to revert changes.' : 'Failed to reapply changes.'
    actionTone.value = 'error'
  } finally {
    actionBusy.value = false
  }
}
</script>

<style scoped>
@reference "tailwindcss";

.review-card,
.review-panel {
  --review-added: #116b36;
  --review-added-bg: color-mix(in srgb, var(--review-added) 13%, transparent);
  --review-removed: #b42318;
  --review-removed-bg: color-mix(in srgb, var(--review-removed) 12%, transparent);
}

:global(html[data-theme='dark'] .review-card),
:global(html[data-theme='dark'] .review-panel) {
  --review-added: #73d99a;
  --review-added-bg: color-mix(in srgb, var(--review-added) 15%, transparent);
  --review-removed: #ff8f88;
  --review-removed-bg: color-mix(in srgb, var(--review-removed) 14%, transparent);
}

.review-card {
  @apply w-full overflow-hidden rounded-xl border;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-primary);
}

.review-card-heading {
  @apply flex min-h-16 items-center gap-2 p-2;
}

.review-card-summary {
  @apply flex min-w-0 flex-1 items-center gap-3 rounded-lg border-0 bg-transparent p-2 text-left outline-none;
}

.review-card-summary:hover {
  background: var(--surface-hover);
}

.review-card-summary:focus-visible,
.review-card-button:focus-visible,
.review-card-file:focus-visible,
.review-card-expand:focus-visible,
.review-toolbar-button:focus-visible,
.review-panel-close:focus-visible,
.review-file-nav-item:focus-visible,
.review-confirm-button:focus-visible {
  box-shadow: 0 0 0 2px var(--accent-soft), 0 0 0 1px var(--accent);
  outline: none;
}

.review-card-icon {
  @apply flex h-10 w-10 shrink-0 items-center justify-center rounded-lg;
  background: var(--surface-elevated);
  color: var(--text-secondary);
}

.review-card-icon svg {
  @apply h-5 w-5;
}

.review-card-copy {
  @apply flex min-w-0 flex-1 flex-col gap-0.5;
}

.review-card-copy strong {
  @apply truncate text-sm font-semibold;
}

.review-card-subtitle {
  @apply flex items-center gap-2 text-xs;
  color: var(--text-muted);
}

.review-card-hover-copy {
  @apply hidden items-center gap-1;
}

.review-card-hover-copy svg {
  @apply h-3 w-3;
}

@media (hover: hover) {
  .review-card-summary:hover .review-card-subtitle > .review-stat,
  .review-card-summary:focus-visible .review-card-subtitle > .review-stat {
    @apply hidden;
  }

  .review-card-summary:hover .review-card-hover-copy,
  .review-card-summary:focus-visible .review-card-hover-copy {
    @apply inline-flex;
  }
}

.review-stat {
  @apply font-mono text-[11px] font-semibold tabular-nums;
}

.review-stat-added {
  color: var(--review-added);
}

.review-stat-removed {
  color: var(--review-removed);
}

.review-card-actions {
  @apply flex shrink-0 items-center gap-1;
}

.review-card-button,
.review-toolbar-button,
.review-confirm-button {
  @apply inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium;
  border-color: var(--border-strong);
  background: var(--surface-elevated);
  color: var(--text-secondary);
}

.review-card-button:hover:not(:disabled),
.review-toolbar-button:hover:not(:disabled),
.review-confirm-button:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.review-card-button:disabled,
.review-toolbar-button:disabled {
  @apply cursor-not-allowed opacity-45;
}

.review-card-button-icon {
  @apply w-9 px-0;
}

.review-card-button-icon svg,
.review-toolbar-button svg {
  @apply h-4 w-4;
}

.review-spin {
  @apply animate-spin;
}

.review-card-files {
  @apply m-0 list-none border-t p-1;
  border-color: var(--border-soft);
}

.review-card-file {
  @apply flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border-0 bg-transparent px-3 text-left text-xs outline-none;
  color: var(--text-secondary);
}

.review-card-file:hover {
  background: var(--surface-hover);
}

.review-file-kind {
  @apply inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold;
  background: var(--surface-elevated);
  color: var(--text-muted);
}

.review-file-kind[data-kind='add'] {
  background: color-mix(in srgb, var(--review-added) 14%, var(--surface-elevated));
  color: var(--review-added);
}

.review-file-kind[data-kind='delete'] {
  background: color-mix(in srgb, var(--review-removed) 13%, var(--surface-elevated));
  color: var(--review-removed);
}

.review-file-kind[data-kind='update'] {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.review-card-file-path {
  @apply min-w-0 flex-1 truncate font-mono;
}

.review-card-file-stats {
  @apply flex shrink-0 gap-2;
}

.review-card-file > svg {
  @apply h-3.5 w-3.5 shrink-0;
  color: var(--text-faint);
}

.review-card-expand {
  @apply mb-1 ml-2 inline-flex min-h-8 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-xs outline-none;
  color: var(--text-muted);
}

.review-card-expand:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.review-card-expand svg {
  @apply h-3.5 w-3.5 transition-transform;
}

.review-card-expand svg.is-expanded {
  @apply rotate-180;
}

.review-action-status {
  @apply m-0 empty:hidden px-3 pb-2 text-xs;
  color: var(--text-muted);
}

.review-disabled-reason,
.review-truncation-note {
  @apply m-0 px-3 pb-2 text-xs leading-5;
  color: var(--text-muted);
}

.review-disabled-reason {
  overflow-wrap: anywhere;
}

.review-action-status[data-tone='success'],
.review-panel-status[data-tone='success'] {
  color: var(--review-added);
}

.review-action-status[data-tone='error'],
.review-panel-status[data-tone='error'] {
  color: var(--destructive);
}

.review-panel-overlay,
.review-confirm-overlay {
  @apply fixed inset-0;
  background: var(--overlay);
}

.review-panel-overlay {
  z-index: 150;
}

.review-panel {
  @apply fixed inset-y-0 right-0 flex min-w-0 flex-col border-l shadow-2xl outline-none;
  z-index: 151;
  width: min(76vw, 58rem);
  border-color: var(--border-strong);
  background: var(--content-bg);
  color: var(--text-primary);
}

.review-panel-header {
  @apply flex min-h-16 shrink-0 items-center justify-between gap-3 border-b px-4 py-2;
  border-color: var(--border-soft);
  padding-top: max(0.5rem, env(safe-area-inset-top));
}

.review-panel-title-wrap {
  @apply min-w-0;
}

.review-panel-title {
  @apply truncate text-base font-semibold;
}

.review-panel-description {
  @apply mt-0.5 flex items-center gap-2 text-xs;
  color: var(--text-muted);
}

.review-panel-actions {
  @apply flex shrink-0 items-center gap-1;
}

.review-toolbar-button.is-active {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border-strong));
  color: var(--accent-strong);
}

.review-panel-close {
  @apply inline-flex h-9 w-9 items-center justify-center rounded-lg border-0 bg-transparent outline-none;
  color: var(--text-tertiary);
}

.review-panel-close:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.review-panel-close svg {
  @apply h-5 w-5;
}

.review-panel-notice {
  @apply shrink-0 border-b px-3 py-2;
  border-color: var(--border-soft);
  background: var(--surface-muted);
}

.review-file-nav {
  @apply flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5;
  border-color: var(--border-soft);
  background: var(--surface-muted);
}

.review-file-nav-item {
  @apply inline-flex h-8 max-w-64 shrink-0 items-center gap-1.5 rounded-lg border border-transparent bg-transparent px-2 text-xs outline-none;
  color: var(--text-secondary);
}

.review-file-nav-item:hover {
  background: var(--surface-hover);
}

.review-file-nav-item.is-selected {
  border-color: var(--border-strong);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.review-file-nav-item > span:nth-child(2) {
  @apply truncate;
}

.review-file-nav-stats {
  @apply ml-1 flex gap-1.5;
}

.review-panel-body {
  @apply min-h-0 flex-1 overflow-auto p-3;
  overscroll-behavior: contain;
  padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
}

.review-empty-state {
  @apply m-0 rounded-xl border p-4 text-sm leading-6;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-secondary);
}

.review-file-diff {
  @apply mb-3 min-w-0 overflow-hidden rounded-xl border;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  scroll-margin-top: 0.75rem;
}

.review-file-header {
  @apply sticky top-0 z-[1] flex min-h-11 items-center gap-2 border-b px-3 text-xs;
  border-color: var(--border-soft);
  background: color-mix(in srgb, var(--surface-muted) 96%, transparent);
  backdrop-filter: blur(8px);
}

.review-file-header-path {
  @apply min-w-0 flex-1 truncate font-mono;
}

.review-file-previous {
  color: var(--text-muted);
}

.review-file-header-stats {
  @apply flex shrink-0 gap-2;
}

.review-diff-code {
  @apply min-w-full overflow-x-auto font-mono text-[12px] leading-5;
  font-variant-ligatures: none;
}

.review-diff-line {
  display: grid;
  grid-template-columns: 3.25rem 3.25rem minmax(max-content, 1fr);
  width: max-content;
  min-width: 100%;
}

.review-diff-line[data-kind='added'] {
  background: var(--review-added-bg);
}

.review-diff-line[data-kind='removed'] {
  background: var(--review-removed-bg);
}

.review-diff-line[data-kind='meta'] {
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-muted));
  color: var(--text-muted);
}

.review-line-number {
  @apply select-none border-r px-2 text-right tabular-nums;
  border-color: color-mix(in srgb, var(--border-soft) 75%, transparent);
  color: var(--text-faint);
}

.review-diff-line code {
  @apply block px-2;
  color: var(--text-primary);
  white-space: pre;
}

.review-line-marker {
  @apply inline-block w-4 select-none font-bold;
}

.review-diff-line[data-kind='added'] .review-line-marker {
  color: var(--review-added);
}

.review-diff-line[data-kind='removed'] .review-line-marker {
  color: var(--review-removed);
}

.review-file-truncation {
  @apply m-0 border-t px-3 py-2 text-xs leading-5;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-muted);
}

.review-panel-body.is-wrapped .review-diff-line {
  grid-template-columns: 3.25rem 3.25rem minmax(0, 1fr);
  width: 100%;
}

.review-panel-body.is-wrapped .review-diff-line code {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.review-panel-status {
  @apply shrink-0 border-t px-4 py-2 text-xs;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-muted);
  padding-bottom: max(0.5rem, env(safe-area-inset-bottom));
}

.review-confirm-overlay {
  z-index: 170;
}

.review-confirm-dialog {
  @apply fixed left-1/2 top-1/2 w-[min(calc(100vw-2rem),28rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border p-5 shadow-2xl outline-none;
  z-index: 171;
  border-color: var(--border-strong);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.review-confirm-title {
  @apply text-base font-semibold;
}

.review-confirm-description {
  @apply mt-2 text-sm leading-5;
  color: var(--text-secondary);
}

.review-confirm-actions {
  @apply mt-5 flex justify-end gap-2;
}

.review-confirm-danger {
  border-color: color-mix(in srgb, var(--destructive) 45%, var(--border-strong));
  background: var(--destructive);
  color: white;
}

.review-confirm-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--destructive) 88%, black);
  color: white;
}

@media (pointer: coarse) {
  .review-card-summary,
  .review-card-button,
  .review-card-file,
  .review-card-expand,
  .review-toolbar-button,
  .review-panel-close,
  .review-file-nav-item,
  .review-confirm-button {
    min-height: 44px;
  }

  .review-card-button-icon,
  .review-panel-close {
    min-width: 44px;
  }
}

@media (max-width: 640px), (pointer: coarse) and (max-width: 1024px) {
  .review-card-heading {
    @apply min-h-[4.5rem] items-stretch;
  }

  .review-card-summary {
    @apply min-h-11 p-1.5;
  }

  .review-card-actions {
    @apply items-center;
  }

  .review-card-actions .review-card-button:not(.review-card-button-icon) {
    @apply hidden;
  }

  .review-card-button-icon,
  .review-panel-close,
  .review-toolbar-button {
    @apply min-h-11 min-w-11;
  }

  .review-card-file {
    @apply h-11 px-2;
  }

  .review-panel {
    @apply inset-0 w-full border-0;
    height: 100dvh;
  }

  .review-panel-header {
    @apply min-h-16;
    padding-left: max(0.625rem, env(safe-area-inset-left));
    padding-right: max(0.625rem, env(safe-area-inset-right));
  }

  .review-toolbar-button {
    @apply px-2;
  }

  .review-toolbar-button span {
    @apply sr-only;
  }

  .review-file-nav {
    @apply py-2;
    padding-left: max(0.5rem, env(safe-area-inset-left));
    padding-right: max(0.5rem, env(safe-area-inset-right));
  }

  .review-file-nav-item {
    @apply h-11 max-w-52;
  }

  .review-panel-body {
    padding-top: 0.5rem;
    padding-right: max(0.5rem, env(safe-area-inset-right));
    padding-bottom: max(0.5rem, env(safe-area-inset-bottom));
    padding-left: max(0.5rem, env(safe-area-inset-left));
  }

  .review-panel-notice,
  .review-panel-status {
    padding-right: max(0.75rem, env(safe-area-inset-right));
    padding-left: max(0.75rem, env(safe-area-inset-left));
  }

  .review-file-header {
    @apply min-h-12 px-2;
  }

  .review-file-header-path {
    @apply text-[11px];
  }

  .review-diff-code {
    @apply text-[11px] leading-[1.15rem];
  }

  .review-diff-line {
    grid-template-columns: 2.75rem 2.75rem minmax(max-content, 1fr);
  }

  .review-panel-body.is-wrapped .review-diff-line {
    grid-template-columns: 2.75rem 2.75rem minmax(0, 1fr);
  }

  .review-confirm-dialog {
    @apply bottom-2 left-2 right-2 top-auto w-auto translate-x-0 translate-y-0 rounded-[1.25rem] p-4;
    left: max(0.5rem, env(safe-area-inset-left));
    right: max(0.5rem, env(safe-area-inset-right));
    padding-bottom: max(1rem, env(safe-area-inset-bottom));
  }

  .review-confirm-actions {
    @apply grid grid-cols-2;
  }

  .review-confirm-button {
    @apply h-11;
  }
}

@media (prefers-reduced-motion: reduce) {
  .review-card-expand svg {
    transition: none;
  }
}
</style>
