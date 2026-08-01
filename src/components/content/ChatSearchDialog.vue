<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="chat-search-backdrop"
      @mousedown.self="emit('close')"
    >
      <section
        ref="dialogRef"
        class="chat-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-search-title"
        aria-describedby="chat-search-description"
        @keydown="onDialogKeydown"
      >
        <h2 id="chat-search-title" class="sr-only">Search chats</h2>
        <p id="chat-search-description" class="sr-only">Search commands and past chats.</p>

        <header class="chat-search-header">
          <Search class="chat-search-header-icon" aria-hidden="true" />
          <input
            ref="searchInputRef"
            v-model="query"
            class="chat-search-input"
            type="search"
            inputmode="search"
            enterkeyhint="go"
            placeholder="Search chats"
            aria-label="Search chats"
            aria-controls="chat-search-results"
            aria-autocomplete="list"
            :aria-activedescendant="highlightedRowId"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <span v-if="isSearching" class="chat-search-spinner" aria-label="Searching" />
          <button class="chat-search-close" type="button" aria-label="Close search" @click="emit('close')">
            <X aria-hidden="true" />
          </button>
        </header>

        <div id="chat-search-results" class="chat-search-results" role="listbox">
          <template v-for="section in sections" :key="section.key">
            <section v-if="section.rows.length > 0" class="chat-search-section">
              <div class="chat-search-section-label">
                <Pin v-if="section.icon === 'pin'" aria-hidden="true" />
                <Clock3 v-else-if="section.icon === 'recent'" aria-hidden="true" />
                <Search v-else aria-hidden="true" />
                <span>{{ section.label }}</span>
              </div>

              <button
                v-for="row in section.rows"
                :id="rowDomId(row.index)"
                :key="row.thread.id"
                class="chat-search-row"
                :class="{ 'is-highlighted': row.index === highlightedIndex }"
                type="button"
                role="option"
                :aria-selected="row.index === highlightedIndex"
                :data-search-index="row.index"
                @mouseenter="highlightedIndex = row.index"
                @click="selectRow(row)"
              >
                <span class="chat-search-row-main">
                  <span class="chat-search-row-title">{{ row.thread.title || 'Untitled chat' }}</span>
                  <span class="chat-search-row-meta">
                    <span class="chat-search-row-project">
                      <Folder aria-hidden="true" />
                      {{ projectLabel(row.thread) }}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{{ formatRelative(row.thread) }}</span>
                  </span>
                  <span v-if="row.snippet" class="chat-search-row-snippet">{{ row.snippet }}</span>
                </span>
                <span class="chat-search-row-open" aria-hidden="true">↵</span>
              </button>
            </section>
          </template>

          <div v-if="showEmptyState" class="chat-search-empty" aria-live="polite">
            <Search aria-hidden="true" />
            <strong>{{ emptyTitle }}</strong>
            <span>{{ emptyDescription }}</span>
          </div>
        </div>

        <footer class="chat-search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>esc</kbd> Close</span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Clock3, Folder, Pin, Search, X } from '@lucide/vue'
import { searchThreads, type ThreadSearchResult } from '../../api/codexGateway'
import { useRelativeTimeClock } from '../../composables/useRelativeTimeClock'
import type { UiThread } from '../../types/codex'
import { compactNotificationText } from '../../utils/notificationText'
import { formatCompactRelativeTime } from '../../utils/relativeTime'

type SearchRow = ThreadSearchResult & {
  index: number
}

type SearchSection = {
  key: string
  label: string
  icon: 'pin' | 'recent' | 'search'
  rows: SearchRow[]
}

const props = defineProps<{
  open: boolean
  threads: UiThread[]
  pinnedThreadIds: string[]
  projectDisplayNameById: Record<string, string>
}>()

const emit = defineEmits<{
  close: []
  select: [thread: UiThread]
}>()

const query = ref('')
const remoteResults = ref<ThreadSearchResult[]>([])
const hasRemoteResponse = ref(false)
const isSearching = ref(false)
const searchFailed = ref(false)
const highlightedIndex = ref(0)
const dialogRef = ref<HTMLElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)
const relativeTimeNow = useRelativeTimeClock()
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchRevision = 0

const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase())

const sortedThreads = computed(() =>
  [...props.threads].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAtIso || left.createdAtIso)
    const rightTime = Date.parse(right.updatedAtIso || right.createdAtIso)
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
  }),
)

const pinnedThreads = computed(() => {
  const threadById = new Map(props.threads.map((thread) => [thread.id, thread]))
  return props.pinnedThreadIds
    .map((threadId) => threadById.get(threadId) ?? null)
    .filter((thread): thread is UiThread => thread !== null)
})

const recentThreads = computed(() => {
  const pinnedIds = new Set(props.pinnedThreadIds)
  return sortedThreads.value.filter((thread) => !pinnedIds.has(thread.id)).slice(0, 12)
})

const localSearchResults = computed<ThreadSearchResult[]>(() => {
  const searchValue = normalizedQuery.value
  if (!searchValue) return []

  return sortedThreads.value
    .filter((thread) => {
      const project = projectLabel(thread).toLocaleLowerCase()
      return (
        thread.title.toLocaleLowerCase().includes(searchValue) ||
        thread.preview.toLocaleLowerCase().includes(searchValue) ||
        project.includes(searchValue) ||
        thread.cwd.toLocaleLowerCase().includes(searchValue)
      )
    })
    .slice(0, 30)
    .map((thread) => ({
      thread,
      snippet: compactNotificationText(thread.preview, '', 220),
    }))
})

const effectiveSearchResults = computed(() =>
  hasRemoteResponse.value && !searchFailed.value
    ? remoteResults.value
    : localSearchResults.value,
)

const sections = computed<SearchSection[]>(() => {
  const definitions: Array<Omit<SearchSection, 'rows'> & { results: ThreadSearchResult[] }> =
    normalizedQuery.value
      ? [{
          key: 'results',
          label: 'Search results',
          icon: 'search',
          results: effectiveSearchResults.value,
        }]
      : [
          {
            key: 'pinned',
            label: 'Pinned chats',
            icon: 'pin',
            results: pinnedThreads.value.map((thread) => ({
              thread,
              snippet: compactNotificationText(thread.preview, '', 180),
            })),
          },
          {
            key: 'recent',
            label: 'Recent chats',
            icon: 'recent',
            results: recentThreads.value.map((thread) => ({
              thread,
              snippet: compactNotificationText(thread.preview, '', 180),
            })),
          },
        ]

  let index = 0
  return definitions.map((section) => ({
    key: section.key,
    label: section.label,
    icon: section.icon,
    rows: section.results.map((result) => ({
      ...result,
      index: index++,
    })),
  }))
})

const flatRows = computed(() => sections.value.flatMap((section) => section.rows))
const highlightedRowId = computed(() =>
  flatRows.value.length > 0 ? rowDomId(highlightedIndex.value) : undefined,
)
const showEmptyState = computed(() => flatRows.value.length === 0 && !isSearching.value)
const emptyTitle = computed(() =>
  normalizedQuery.value ? 'No chats found' : 'No recent chats yet',
)
const emptyDescription = computed(() => {
  if (!normalizedQuery.value) return 'Your recent conversations will appear here.'
  if (searchFailed.value) return 'Message search is temporarily unavailable. Try again.'
  return 'Try a different title, message, or project name.'
})

function projectLabel(thread: UiThread): string {
  return props.projectDisplayNameById[thread.projectName] ?? thread.projectName
}

function formatRelative(thread: UiThread): string {
  return formatCompactRelativeTime(
    thread.updatedAtIso || thread.createdAtIso,
    relativeTimeNow.value,
  )
}

function rowDomId(index: number): string {
  return `chat-search-result-${index.toString()}`
}

function selectRow(row: SearchRow): void {
  emit('select', row.thread)
}

function scrollHighlightedIntoView(): void {
  void nextTick(() => {
    dialogRef.value
      ?.querySelector<HTMLElement>(`[data-search-index="${highlightedIndex.value.toString()}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }

  const rowCount = flatRows.value.length
  if (rowCount === 0) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    highlightedIndex.value = (highlightedIndex.value + 1) % rowCount
    scrollHighlightedIntoView()
    return
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    highlightedIndex.value = (highlightedIndex.value - 1 + rowCount) % rowCount
    scrollHighlightedIntoView()
    return
  }

  if (event.key === 'Enter' && !event.isComposing) {
    const row = flatRows.value[highlightedIndex.value]
    if (!row) return
    event.preventDefault()
    selectRow(row)
  }
}

function clearSearchTimer(): void {
  if (!searchTimer) return
  clearTimeout(searchTimer)
  searchTimer = null
}

watch(
  () => props.open,
  (isOpen) => {
    searchRevision += 1
    clearSearchTimer()
    if (!isOpen) return

    query.value = ''
    remoteResults.value = []
    hasRemoteResponse.value = false
    isSearching.value = false
    searchFailed.value = false
    highlightedIndex.value = 0
    void nextTick(() => {
      searchInputRef.value?.focus()
      searchInputRef.value?.select()
    })
  },
)

watch(query, (nextQuery) => {
  clearSearchTimer()
  const searchValue = nextQuery.trim()
  const revision = ++searchRevision
  remoteResults.value = []
  hasRemoteResponse.value = false
  searchFailed.value = false
  highlightedIndex.value = 0

  if (!props.open || !searchValue) {
    isSearching.value = false
    return
  }

  isSearching.value = true
  searchTimer = setTimeout(() => {
    searchTimer = null
    void searchThreads(searchValue, 50)
      .then((results) => {
        if (revision !== searchRevision || !props.open) return
        remoteResults.value = results
        hasRemoteResponse.value = true
      })
      .catch(() => {
        if (revision !== searchRevision || !props.open) return
        searchFailed.value = true
      })
      .finally(() => {
        if (revision === searchRevision) {
          isSearching.value = false
        }
      })
  }, 180)
})

watch(
  () => flatRows.value.length,
  (rowCount) => {
    if (rowCount === 0) {
      highlightedIndex.value = 0
      return
    }
    highlightedIndex.value = Math.min(highlightedIndex.value, rowCount - 1)
  },
)

onBeforeUnmount(() => {
  searchRevision += 1
  clearSearchTimer()
})
</script>

<style scoped>
@reference "tailwindcss";

.chat-search-backdrop {
  @apply fixed inset-0 z-[140] flex items-start justify-center px-4;
  padding-top: min(12vh, 7rem);
  padding-bottom: 1rem;
  background: var(--overlay);
}

.chat-search-dialog {
  @apply flex w-full max-w-[42rem] flex-col overflow-hidden rounded-2xl border shadow-2xl;
  max-height: min(72dvh, 42rem);
  border-color: var(--border-strong);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.chat-search-header {
  @apply flex min-h-14 items-center gap-3 border-b px-4;
  border-color: var(--border-soft);
}

.chat-search-header-icon {
  @apply h-5 w-5 shrink-0;
  color: var(--text-muted);
}

.chat-search-input {
  @apply min-w-0 flex-1 border-0 bg-transparent py-4 text-[16px] outline-none;
  color: var(--text-primary);
}

.chat-search-input::placeholder {
  color: var(--text-muted);
}

.chat-search-input::-webkit-search-cancel-button {
  display: none;
}

.chat-search-close {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent;
  color: var(--text-tertiary);
}

.chat-search-close:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.chat-search-close svg {
  @apply h-4 w-4;
}

.chat-search-spinner {
  @apply h-4 w-4 shrink-0 animate-spin rounded-full border-2;
  border-color: var(--border-strong);
  border-top-color: var(--accent);
}

.chat-search-results {
  @apply min-h-0 flex-1 overflow-y-auto px-2 py-2;
}

.chat-search-section + .chat-search-section {
  @apply mt-2;
}

.chat-search-section-label {
  @apply flex items-center gap-1.5 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide;
  color: var(--text-muted);
}

.chat-search-section-label svg {
  @apply h-3.5 w-3.5;
}

.chat-search-row {
  @apply flex w-full items-center gap-3 rounded-xl border-0 bg-transparent px-3 py-2.5 text-left outline-none;
  color: var(--text-primary);
}

.chat-search-row:hover,
.chat-search-row.is-highlighted {
  background: var(--surface-hover);
}

.chat-search-row:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.chat-search-row-main {
  @apply flex min-w-0 flex-1 flex-col;
}

.chat-search-row-title {
  @apply truncate text-sm font-medium;
}

.chat-search-row-meta {
  @apply mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px];
  color: var(--text-muted);
}

.chat-search-row-project {
  @apply flex min-w-0 items-center gap-1 truncate;
}

.chat-search-row-project svg {
  @apply h-3 w-3 shrink-0;
}

.chat-search-row-snippet {
  @apply mt-1 line-clamp-2 text-xs leading-4;
  color: var(--text-secondary);
}

.chat-search-row-open {
  @apply hidden shrink-0 text-xs sm:inline;
  color: var(--text-faint);
}

.chat-search-empty {
  @apply flex min-h-52 flex-col items-center justify-center px-6 text-center;
  color: var(--text-muted);
}

.chat-search-empty svg {
  @apply mb-3 h-6 w-6;
}

.chat-search-empty strong {
  @apply text-sm font-medium;
  color: var(--text-secondary);
}

.chat-search-empty span {
  @apply mt-1 max-w-sm text-xs leading-5;
}

.chat-search-footer {
  @apply flex items-center gap-5 border-t px-4 py-2 text-[11px];
  border-color: var(--border-soft);
  color: var(--text-muted);
}

.chat-search-footer span {
  @apply flex items-center gap-1;
}

.chat-search-footer kbd {
  @apply inline-flex min-w-5 items-center justify-center rounded border px-1 py-0.5 font-sans;
  border-color: var(--border-strong);
  background: var(--surface-muted);
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .chat-search-backdrop {
    @apply items-end px-2 pb-2;
    padding-top: max(env(safe-area-inset-top), 0.5rem);
    padding-bottom: max(env(safe-area-inset-bottom), 0.5rem);
  }

  .chat-search-dialog {
    @apply max-w-none rounded-[1.25rem];
    max-height: calc(100dvh - max(env(safe-area-inset-top), 0.5rem) - max(env(safe-area-inset-bottom), 0.5rem));
  }

  .chat-search-header {
    @apply min-h-14 px-3;
  }

  .chat-search-results {
    @apply px-1.5;
  }

  .chat-search-row {
    @apply px-3 py-3;
  }

  .chat-search-row-snippet {
    @apply line-clamp-2 text-[13px] leading-[1.15rem];
  }

  .chat-search-footer {
    @apply hidden;
  }
}
</style>
