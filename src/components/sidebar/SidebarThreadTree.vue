<template>
  <section class="thread-tree-root">
    <section v-if="pinnedThreads.length > 0" class="pinned-section">
      <span class="pinned-section-label">Pinned</span>
      <ul class="thread-list">
        <li v-for="(thread, index) in pinnedThreads" :key="thread.id" class="thread-row-item">
          <SidebarMenuRow
            class="thread-row"
            :data-active="thread.id === selectedThreadId"
            :data-pinned="isPinned(thread.id)"
            :data-thread-dragging="isThreadDragging(thread.id)"
            :data-thread-drop-position="getThreadDropPosition('pinned', '', index)"
            :force-right-hover="isMobile"
            :draggable="isThreadReorderEnabled('pinned')"
            @dragstart="onThreadDragStart($event, thread.id, 'pinned', '', index)"
            @dragover="onThreadDragOver($event, 'pinned', '', index)"
            @drop="onThreadDrop($event, 'pinned', '')"
            @dragend="resetThreadDragState"
            @mouseleave="onThreadRowLeave(thread.id)"
          >
            <template #left>
              <span class="thread-left-stack">
                <span v-if="thread.inProgress || thread.unread" class="thread-status-indicator" :data-state="getThreadState(thread)" />
                <button class="thread-pin-button" type="button" title="pin" @click="togglePin(thread.id)">
                  <IconTablerPin class="thread-icon" />
                </button>
              </span>
            </template>
            <input
              v-if="renamingThreadId === thread.id"
              v-model="threadRenameDraft"
              class="thread-rename-input"
              :data-thread-rename-input="thread.id"
              type="text"
              aria-label="Chat name"
              @blur="commitThreadRename(thread)"
              @keydown.enter.prevent="commitThreadRename(thread)"
              @keydown.escape.prevent="cancelThreadRename"
            />
            <button v-else class="thread-main-button" type="button" :title="getThreadTitleTooltip(thread)" @click="onSelect(thread.id)" @keydown="onThreadKeyDown($event, thread.id, 'pinned', '')">
              <span class="thread-row-title-wrap">
                <span class="thread-row-title">{{ getThreadDisplayTitle(thread) }}</span>
                <IconTablerGitFork v-if="thread.hasWorktree" class="thread-row-worktree-icon" title="Worktree thread" />
              </span>
            </button>
            <template #right>
              <kbd v-if="showShortcutHints && getShortcutLabel(thread.id)" class="thread-shortcut-hint">
                {{ getShortcutLabel(thread.id) }}
              </kbd>
              <span v-else-if="getThreadStatusLabel(thread)" class="thread-status-label" :data-state="getThreadState(thread)">
                {{ getThreadStatusLabel(thread) }}
              </span>
              <span v-else class="thread-row-time">{{ formatRelative(thread.updatedAtIso || thread.createdAtIso) }}</span>
            </template>
            <template #right-hover>
              <span class="thread-row-actions">
                <button class="thread-rename-button" type="button" title="Edit chat name" @click="beginThreadRename(thread)">
                  <IconTablerFilePencil class="thread-icon" />
                </button>
                <button
                  class="thread-archive-button"
                  :data-confirm="isArchiveConfirming(thread.id)"
                  type="button"
                  title="archive_thread"
                  @click="onArchiveClick(thread.id)"
                >
                  <span v-if="isArchiveConfirming(thread.id)">confirm</span>
                  <IconTablerArchive v-else class="thread-icon" />
                </button>
              </span>
            </template>
          </SidebarMenuRow>
        </li>
      </ul>
    </section>

    <SidebarMenuRow
      as="header"
      class="thread-tree-header-row"
      :class="{ 'thread-tree-header-row--after-pinned': pinnedThreads.length > 0 }"
    >
      <span class="thread-tree-header">Threads</span>
      <template #right>
        <div ref="organizeMenuWrapRef" class="organize-menu-wrap">
          <button
            class="organize-menu-trigger"
            type="button"
            :aria-expanded="isOrganizeMenuOpen"
            aria-label="Organize threads"
            title="Organize threads"
            @click="toggleOrganizeMenu"
          >
            <IconTablerDots class="thread-icon" />
          </button>

          <div v-if="isOrganizeMenuOpen" class="organize-menu-panel" @click.stop>
            <p class="organize-menu-title">Organize</p>
            <button
              class="organize-menu-item"
              :data-active="threadViewMode === 'project'"
              type="button"
              @click="setThreadViewMode('project')"
            >
              <span>By project</span>
              <span v-if="threadViewMode === 'project'">✓</span>
            </button>
            <button
              class="organize-menu-item"
              :data-active="threadViewMode === 'chronological'"
              type="button"
              @click="setThreadViewMode('chronological')"
            >
              <span>Chronological list</span>
              <span v-if="threadViewMode === 'chronological'">✓</span>
            </button>
          </div>
        </div>
      </template>
    </SidebarMenuRow>

    <nav class="thread-status-filters" aria-label="Filter chats" title="⌘⌥[ / ⌘⌥] cycles filters">
      <button
        v-for="option in threadStatusFilterOptions"
        :key="option.value"
        class="thread-status-filter"
        :data-active="threadStatusFilter === option.value"
        type="button"
        @click="threadStatusFilter = option.value"
      >
        <span>{{ option.label }}</span>
        <span class="thread-status-filter-count">{{ option.count }}</span>
      </button>
    </nav>

    <p v-if="isThreadFilterActive && filteredGroups.length === 0" class="thread-tree-no-results">{{ noMatchingThreadsLabel }}</p>

    <p v-else-if="isLoading && groups.length === 0" class="thread-tree-loading">Loading threads...</p>

    <ul v-else-if="isChronologicalView" class="thread-list thread-list-global">
      <li v-for="(thread, index) in globalThreads" :key="thread.id" class="thread-row-item">
        <SidebarMenuRow
          class="thread-row"
          :data-active="thread.id === selectedThreadId"
          :data-pinned="isPinned(thread.id)"
          :data-thread-dragging="isThreadDragging(thread.id)"
          :data-thread-drop-position="getThreadDropPosition('global', '', index)"
          :force-right-hover="isMobile"
          :draggable="isThreadReorderEnabled('global')"
          @dragstart="onThreadDragStart($event, thread.id, 'global', '', index)"
          @dragover="onThreadDragOver($event, 'global', '', index)"
          @drop="onThreadDrop($event, 'global', '')"
          @dragend="resetThreadDragState"
          @mouseleave="onThreadRowLeave(thread.id)"
        >
          <template #left>
            <span class="thread-left-stack">
              <span
                v-if="thread.inProgress || thread.unread"
                class="thread-status-indicator"
                :data-state="getThreadState(thread)"
              />
              <button class="thread-pin-button" type="button" title="pin" @click="togglePin(thread.id)">
                <IconTablerPin class="thread-icon" />
              </button>
            </span>
          </template>
          <input
            v-if="renamingThreadId === thread.id"
            v-model="threadRenameDraft"
            class="thread-rename-input"
            :data-thread-rename-input="thread.id"
            type="text"
            aria-label="Chat name"
            @blur="commitThreadRename(thread)"
            @keydown.enter.prevent="commitThreadRename(thread)"
            @keydown.escape.prevent="cancelThreadRename"
          />
          <button v-else class="thread-main-button" type="button" :title="getThreadTitleTooltip(thread)" @click="onSelect(thread.id)" @keydown="onThreadKeyDown($event, thread.id, 'global', '')">
            <span class="thread-row-title-wrap">
              <span class="thread-row-title">{{ getThreadDisplayTitle(thread) }}</span>
              <IconTablerGitFork v-if="thread.hasWorktree" class="thread-row-worktree-icon" title="Worktree thread" />
            </span>
          </button>
          <template #right>
            <kbd v-if="showShortcutHints && getShortcutLabel(thread.id)" class="thread-shortcut-hint">
              {{ getShortcutLabel(thread.id) }}
            </kbd>
            <span v-else-if="getThreadStatusLabel(thread)" class="thread-status-label" :data-state="getThreadState(thread)">
              {{ getThreadStatusLabel(thread) }}
            </span>
            <span v-else class="thread-row-time">{{ formatRelative(thread.updatedAtIso || thread.createdAtIso) }}</span>
          </template>
          <template #right-hover>
            <span class="thread-row-actions">
              <button class="thread-rename-button" type="button" title="Edit chat name" @click="beginThreadRename(thread)">
                <IconTablerFilePencil class="thread-icon" />
              </button>
              <button
                class="thread-archive-button"
                :data-confirm="isArchiveConfirming(thread.id)"
                type="button"
                title="archive_thread"
                @click="onArchiveClick(thread.id)"
              >
                <span v-if="isArchiveConfirming(thread.id)">confirm</span>
                <IconTablerArchive v-else class="thread-icon" />
              </button>
            </span>
          </template>
        </SidebarMenuRow>
      </li>
    </ul>

    <div v-else ref="groupsContainerRef" class="thread-tree-groups" :style="groupsContainerStyle">
      <article
        v-for="group in filteredGroups"
        :key="group.projectName"
        :ref="(el) => setProjectGroupRef(group.projectName, el)"
        class="project-group"
        :data-project-name="group.projectName"
        :data-expanded="!isCollapsed(group.projectName)"
        :data-dragging="isDraggingProject(group.projectName)"
        :style="projectGroupStyle(group.projectName)"
      >
          <SidebarMenuRow
            as="div"
            class="project-header-row"
            role="button"
            tabindex="0"
            @click="toggleProjectCollapse(group.projectName)"
            @keydown="onProjectHeaderKeyDown($event, group.projectName)"
            @keydown.enter.prevent="toggleProjectCollapse(group.projectName)"
            @keydown.space.prevent="toggleProjectCollapse(group.projectName)"
          >
            <template #left>
              <span class="project-icon-stack">
                <span class="project-icon-folder">
                  <IconTablerFolder v-if="isCollapsed(group.projectName)" class="thread-icon" />
                  <IconTablerFolderOpen v-else class="thread-icon" />
                </span>
                <span class="project-icon-chevron">
                  <IconTablerChevronRight v-if="isCollapsed(group.projectName)" class="thread-icon" />
                  <IconTablerChevronDown v-else class="thread-icon" />
                </span>
              </span>
            </template>
            <span
              class="project-main-button"
              :data-dragging-handle="isDraggingProject(group.projectName)"
              @pointerdown="onProjectHandlePointerDown($event, group.projectName)"
            >
              <span class="project-title">{{ getProjectDisplayName(group.projectName) }}</span>
            </span>
            <template #right>
              <div class="project-hover-controls">
                <div :ref="(el) => setProjectMenuWrapRef(group.projectName, el)" class="project-menu-wrap">
                  <button
                    class="project-menu-trigger"
                    type="button"
                    title="project_menu"
                    @click.stop="toggleProjectMenu(group.projectName)"
                  >
                    <IconTablerDots class="thread-icon" />
                  </button>

                  <div v-if="isProjectMenuOpen(group.projectName)" class="project-menu-panel" @click.stop>
                    <template v-if="projectMenuMode === 'actions'">
                      <button class="project-menu-item" type="button" @click="openRenameProjectMenu(group.projectName)">
                        Edit name
                      </button>
                      <button
                        class="project-menu-item project-menu-item-danger"
                        type="button"
                        @click="onRemoveProject(group.projectName)"
                      >
                        Remove
                      </button>
                    </template>
                    <template v-else>
                      <label class="project-menu-label">Project name</label>
                      <input
                        v-model="projectRenameDraft"
                        class="project-menu-input"
                        type="text"
                        @input="onProjectNameInput(group.projectName)"
                      />
                    </template>
                  </div>
                </div>

                <button
                  class="thread-start-button"
                  type="button"
                  :aria-label="getNewThreadButtonAriaLabel(group.projectName)"
                  :title="getNewThreadButtonAriaLabel(group.projectName)"
                  @click.stop="onStartNewThread(group.projectName)"
                >
                  <IconTablerFilePencil class="thread-icon" />
                </button>
              </div>
            </template>
          </SidebarMenuRow>

          <ul v-if="hasThreads(group)" class="thread-list">
            <li v-for="(thread, index) in visibleThreads(group)" :key="thread.id" class="thread-row-item">
              <SidebarMenuRow
                class="thread-row"
                :data-active="thread.id === selectedThreadId"
                :data-pinned="isPinned(thread.id)"
                :data-thread-dragging="isThreadDragging(thread.id)"
                :data-thread-drop-position="getThreadDropPosition('project', group.projectName, index)"
                :force-right-hover="isMobile"
                :draggable="isThreadReorderEnabled('project')"
                @dragstart="onThreadDragStart($event, thread.id, 'project', group.projectName, index)"
                @dragover="onThreadDragOver($event, 'project', group.projectName, index)"
                @drop="onThreadDrop($event, 'project', group.projectName)"
                @dragend="resetThreadDragState"
                @mouseleave="onThreadRowLeave(thread.id)"
              >
                <template #left>
                  <span class="thread-left-stack">
                    <span
                      v-if="thread.inProgress || thread.unread"
                      class="thread-status-indicator"
                      :data-state="getThreadState(thread)"
                    />
                    <button class="thread-pin-button" type="button" title="pin" @click="togglePin(thread.id)">
                      <IconTablerPin class="thread-icon" />
                    </button>
                  </span>
                </template>
                <input
                  v-if="renamingThreadId === thread.id"
                  v-model="threadRenameDraft"
                  class="thread-rename-input"
                  :data-thread-rename-input="thread.id"
                  type="text"
                  aria-label="Chat name"
                  @blur="commitThreadRename(thread)"
                  @keydown.enter.prevent="commitThreadRename(thread)"
                  @keydown.escape.prevent="cancelThreadRename"
                />
                <button v-else class="thread-main-button" type="button" :title="getThreadTitleTooltip(thread)" @click="onSelect(thread.id)" @keydown="onThreadKeyDown($event, thread.id, 'project', group.projectName)">
                  <span class="thread-row-title-wrap">
                    <span class="thread-row-title">{{ getThreadDisplayTitle(thread) }}</span>
                    <IconTablerGitFork v-if="thread.hasWorktree" class="thread-row-worktree-icon" title="Worktree thread" />
                  </span>
                </button>
                <template #right>
                  <kbd v-if="showShortcutHints && getShortcutLabel(thread.id)" class="thread-shortcut-hint">
                    {{ getShortcutLabel(thread.id) }}
                  </kbd>
                  <span v-else-if="getThreadStatusLabel(thread)" class="thread-status-label" :data-state="getThreadState(thread)">
                    {{ getThreadStatusLabel(thread) }}
                  </span>
                  <span v-else class="thread-row-time">{{ formatRelative(thread.updatedAtIso || thread.createdAtIso) }}</span>
                </template>
                <template #right-hover>
                  <span class="thread-row-actions">
                    <button class="thread-rename-button" type="button" title="Edit chat name" @click="beginThreadRename(thread)">
                      <IconTablerFilePencil class="thread-icon" />
                    </button>
                    <button
                      class="thread-archive-button"
                      :data-confirm="isArchiveConfirming(thread.id)"
                      type="button"
                      title="archive_thread"
                      @click="onArchiveClick(thread.id)"
                    >
                      <span v-if="isArchiveConfirming(thread.id)">confirm</span>
                      <IconTablerArchive v-else class="thread-icon" />
                    </button>
                  </span>
                </template>
              </SidebarMenuRow>
            </li>
          </ul>

          <SidebarMenuRow v-else as="p" class="project-empty-row">
            <template #left>
              <span class="project-empty-spacer" />
            </template>
            <span class="project-empty">No threads</span>
          </SidebarMenuRow>

          <SidebarMenuRow v-if="hasHiddenThreads(group)" class="thread-show-more-row">
            <template #left>
              <span class="thread-show-more-spacer" />
            </template>
            <button class="thread-show-more-button" type="button" @click="toggleProjectExpansion(group.projectName)">
              {{ isExpanded(group.projectName) ? 'Show less' : 'Show more' }}
            </button>
          </SidebarMenuRow>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useMobile } from '../../composables/useMobile'
import { useRelativeTimeClock } from '../../composables/useRelativeTimeClock'
import { getThreadSummary } from '../../api/codexGateway'
import type { SetThreadPinnedIntent } from '../../utils/pinnedThreads'
import type { UiProjectGroup, UiThread } from '../../types/codex'
import { formatCompactRelativeTime } from '../../utils/relativeTime'
import IconTablerArchive from '../icons/IconTablerArchive.vue'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import IconTablerDots from '../icons/IconTablerDots.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerFolder from '../icons/IconTablerFolder.vue'
import IconTablerFolderOpen from '../icons/IconTablerFolderOpen.vue'
import IconTablerGitFork from '../icons/IconTablerGitFork.vue'
import IconTablerPin from '../icons/IconTablerPin.vue'
import SidebarMenuRow from './SidebarMenuRow.vue'

const props = defineProps<{
  groups: UiProjectGroup[]
  projectDisplayNameById: Record<string, string>
  pinnedThreadIds: string[]
  selectedThreadId: string
  isLoading: boolean
  searchQuery: string
  showShortcutHints: boolean
}>()

const { isMobile } = useMobile()
const relativeTimeNow = useRelativeTimeClock()

const emit = defineEmits<{
  select: [threadId: string]
  'shortcut-threads-change': [threadIds: string[]]
  'set-thread-pinned': [intent: SetThreadPinnedIntent]
  'set-pinned-threads-order': [threadIds: string[]]
  archive: [threadId: string]
  'rename-thread': [payload: { threadId: string; name: string }]
  'start-new-thread': [projectName: string]
  'rename-project': [payload: { projectName: string; displayName: string }]
  'remove-project': [projectName: string]
  'reorder-project': [payload: { projectName: string; toIndex: number }]
  'reorder-thread': [payload: { threadId: string; toIndex: number; projectName?: string; threadIds?: string[] }]
}>()

type PendingProjectDrag = {
  projectName: string
  fromIndex: number
  startClientX: number
  startClientY: number
  pointerOffsetY: number
  groupLeft: number
  groupWidth: number
  groupHeight: number
  groupOuterHeight: number
}

type ActiveProjectDrag = {
  projectName: string
  fromIndex: number
  pointerOffsetY: number
  groupLeft: number
  groupWidth: number
  groupHeight: number
  groupOuterHeight: number
  ghostTop: number
  dropTargetIndexFull: number | null
}

type DragPointerSample = {
  clientX: number
  clientY: number
}

type ThreadDragScope = 'pinned' | 'global' | 'project'
type ThreadDropPosition = 'before' | 'after'
type ThreadStatusFilter = 'all' | 'running' | 'unread'

type ActiveThreadDrag = {
  threadId: string
  scopeKey: string
  projectName: string
}

type ThreadDropTarget = {
  scopeKey: string
  index: number
  position: ThreadDropPosition
}

const DRAG_START_THRESHOLD_PX = 4
const PROJECT_GROUP_EXPANDED_GAP_PX = 6
const expandedProjects = ref<Record<string, boolean>>({})
const collapsedProjects = ref<Record<string, boolean>>({})
const pinnedThreadIds = computed(() => normalizeThreadIdArray(props.pinnedThreadIds))
const archiveConfirmThreadId = ref('')
const renamingThreadId = ref('')
const threadRenameDraft = ref('')
const threadStatusFilter = ref<ThreadStatusFilter>('all')
const retainedUnreadThreadIds = ref<string[]>([])
const openProjectMenuId = ref('')
const projectMenuMode = ref<'actions' | 'rename'>('actions')
const projectRenameDraft = ref('')
const groupsContainerRef = ref<HTMLElement | null>(null)
const pendingProjectDrag = ref<PendingProjectDrag | null>(null)
const activeProjectDrag = ref<ActiveProjectDrag | null>(null)
const activeThreadDrag = ref<ActiveThreadDrag | null>(null)
const threadDropTarget = ref<ThreadDropTarget | null>(null)
let pendingDragPointerSample: DragPointerSample | null = null
let dragPointerRafId: number | null = null
const suppressNextProjectToggleId = ref('')
const measuredHeightByProject = ref<Record<string, number>>({})
const projectGroupElementByName = new Map<string, HTMLElement>()
const projectMenuWrapElementByName = new Map<string, HTMLElement>()
const projectNameByElement = new WeakMap<HTMLElement, string>()
const organizeMenuWrapRef = ref<HTMLElement | null>(null)
const isOrganizeMenuOpen = ref(false)
const THREAD_VIEW_MODE_STORAGE_KEY = 'codex-web-local.thread-view-mode.v1'
const threadViewMode = ref<'project' | 'chronological'>(loadThreadViewMode())
const projectGroupResizeObserver =
  typeof window !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement
          const projectName = projectNameByElement.get(element)
          if (!projectName) continue
          updateMeasuredProjectHeight(projectName, element)
        }
      })
    : null
const COLLAPSED_STORAGE_KEY = 'codex-web-local.collapsed-projects.v1'
let pinnedThreadsHydrateToken = 0

function normalizeThreadIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const next: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const threadId = item.trim()
    if (threadId.length > 0 && !next.includes(threadId)) {
      next.push(threadId)
    }
  }
  return next
}

function loadCollapsedState(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, boolean>
  } catch {
    return {}
  }
}

function loadThreadViewMode(): 'project' | 'chronological' {
  if (typeof window === 'undefined') return 'project'

  const raw = window.localStorage.getItem(THREAD_VIEW_MODE_STORAGE_KEY)
  return raw === 'chronological' ? 'chronological' : 'project'
}

collapsedProjects.value = loadCollapsedState()

watch(
  collapsedProjects,
  (value) => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(value))
  },
  { deep: true },
)

watch(threadViewMode, (value) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_VIEW_MODE_STORAGE_KEY, value)
})

function currentUnreadThreadIds(): string[] {
  return props.groups.flatMap((group) =>
    group.threads.filter((thread) => thread.unread).map((thread) => thread.id),
  )
}

function retainUnreadThreads(threadIds: string[]): void {
  const retained = new Set(retainedUnreadThreadIds.value)
  for (const threadId of threadIds) retained.add(threadId)
  if (retained.size === retainedUnreadThreadIds.value.length) return
  retainedUnreadThreadIds.value = [...retained]
}

watch(threadStatusFilter, (filter) => {
  retainedUnreadThreadIds.value = filter === 'unread' ? currentUnreadThreadIds() : []
})

watch(currentUnreadThreadIds, (threadIds) => {
  if (threadStatusFilter.value === 'unread') retainUnreadThreads(threadIds)
})

const normalizedSearchQuery = computed(() => props.searchQuery.trim().toLowerCase())

const isSearchActive = computed(() => normalizedSearchQuery.value.length > 0)
const isThreadFilterActive = computed(() => isSearchActive.value || threadStatusFilter.value !== 'all')

function threadMatchesSearch(thread: UiThread): boolean {
  if (!isSearchActive.value) return true
  const q = normalizedSearchQuery.value
  return (
    thread.title.toLowerCase().includes(q) ||
    thread.preview.toLowerCase().includes(q)
  )
}

function threadMatchesStatus(thread: UiThread): boolean {
  if (threadStatusFilter.value === 'running') return thread.inProgress
  if (threadStatusFilter.value === 'unread') {
    return thread.unread || retainedUnreadThreadIds.value.includes(thread.id)
  }
  return true
}

function threadMatchesActiveFilters(thread: UiThread): boolean {
  return threadMatchesSearch(thread) && threadMatchesStatus(thread)
}

function onStatusFilterShortcut(event: KeyboardEvent): void {
  if (!event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey) return
  if (event.code !== 'BracketLeft' && event.code !== 'BracketRight') return

  event.preventDefault()
  const filters: ThreadStatusFilter[] = ['all', 'running', 'unread']
  const currentIndex = filters.indexOf(threadStatusFilter.value)
  const direction = event.code === 'BracketRight' ? 1 : -1
  threadStatusFilter.value = filters[(currentIndex + direction + filters.length) % filters.length]
}

const filteredGroups = computed<UiProjectGroup[]>(() => {
  if (!isThreadFilterActive.value) return props.groups
  return props.groups
    .map((group) => ({
      ...group,
      threads: group.threads.filter(threadMatchesActiveFilters),
    }))
    .filter((group) => group.threads.length > 0)
})

const isChronologicalView = computed(() => threadViewMode.value === 'chronological')

const globalThreads = computed<UiThread[]>(() => {
  const sourceGroups = filteredGroups.value
  const rows: UiThread[] = []

  for (const group of sourceGroups) {
    for (const thread of group.threads) {
      if (isPinned(thread.id)) continue
      rows.push(thread)
    }
  }

  return rows.sort((first, second) => {
    const firstTimestamp = new Date(first.updatedAtIso || first.createdAtIso).getTime()
    const secondTimestamp = new Date(second.updatedAtIso || second.createdAtIso).getTime()
    return secondTimestamp - firstTimestamp
  })
})

const threadById = computed(() => {
  const map = new Map<string, UiThread>()

  for (const group of props.groups) {
    for (const thread of group.threads) {
      map.set(thread.id, thread)
    }
  }

  return map
})

const threadStatusFilterOptions = computed<Array<{ value: ThreadStatusFilter; label: string; count: number }>>(() => {
  const threads = [...threadById.value.values()]
  return [
    { value: 'all', label: 'All', count: threads.length },
    { value: 'running', label: 'Running', count: threads.filter((thread) => thread.inProgress).length },
    { value: 'unread', label: 'Unread', count: threads.filter((thread) => thread.unread).length },
  ]
})

const noMatchingThreadsLabel = computed(() => {
  if (threadStatusFilter.value === 'running') return 'No running chats'
  if (threadStatusFilter.value === 'unread') return 'No unread chats'
  return 'No matching chats'
})

const pinnedThreadById = ref<Record<string, UiThread>>({})

const pinnedThreads = computed(() =>
  pinnedThreadIds.value
    .map((threadId) => threadById.value.get(threadId) ?? pinnedThreadById.value[threadId] ?? null)
    .filter((thread): thread is UiThread => thread !== null)
    .filter(threadMatchesActiveFilters),
)

const activeShortcutThreadIds = computed<string[]>(() => {
  const ids: string[] = []
  const seen = new Set<string>()
  const append = (thread: UiThread) => {
    if (!thread.id || seen.has(thread.id) || ids.length >= 9) return
    seen.add(thread.id)
    ids.push(thread.id)
  }

  pinnedThreads.value.forEach(append)
  if (isChronologicalView.value) {
    globalThreads.value.forEach(append)
  } else {
    for (const group of filteredGroups.value) {
      visibleThreads(group).forEach(append)
    }
  }

  return ids
})

const projectedDropProjectIndex = computed<number | null>(() => {
  const drag = activeProjectDrag.value
  if (!drag || drag.dropTargetIndexFull === null || props.groups.length === 0) return null

  const boundedDropIndex = Math.max(0, Math.min(drag.dropTargetIndexFull, props.groups.length))
  const projectedIndex = boundedDropIndex > drag.fromIndex ? boundedDropIndex - 1 : boundedDropIndex
  const boundedProjectedIndex = Math.max(0, Math.min(projectedIndex, props.groups.length - 1))
  return boundedProjectedIndex === drag.fromIndex ? null : boundedProjectedIndex
})

const layoutProjectOrder = computed<string[]>(() => {
  const sourceGroups = isThreadFilterActive.value ? filteredGroups.value : props.groups
  const names = sourceGroups.map((group) => group.projectName)
  const drag = activeProjectDrag.value
  const projectedIndex = projectedDropProjectIndex.value

  if (!drag || projectedIndex === null) {
    return names
  }

  const next = [...names]
  const [movedProject] = next.splice(drag.fromIndex, 1)
  if (!movedProject) {
    return names
  }
  next.splice(projectedIndex, 0, movedProject)
  return next
})

const layoutTopByProject = computed<Record<string, number>>(() => {
  const topByProject: Record<string, number> = {}
  let currentTop = 0

  for (const projectName of layoutProjectOrder.value) {
    topByProject[projectName] = currentTop
    currentTop += getProjectOuterHeight(projectName)
  }

  return topByProject
})

const groupsContainerStyle = computed<Record<string, string>>(() => {
  let totalHeight = 0
  for (const projectName of layoutProjectOrder.value) {
    totalHeight += getProjectOuterHeight(projectName)
  }

  return {
    height: `${Math.max(0, totalHeight)}px`,
  }
})

function formatRelative(value: string): string {
  return formatCompactRelativeTime(value, relativeTimeNow.value)
}

function isPinned(threadId: string): boolean {
  return pinnedThreadIds.value.includes(threadId)
}

function getShortcutLabel(threadId: string): string {
  const index = activeShortcutThreadIds.value.indexOf(threadId)
  return index >= 0 && index < 9 ? `⌘${index + 1}` : ''
}

function normalizeThreadLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getThreadDisplayTitle(thread: UiThread): string {
  return normalizeThreadLabel(thread.title) || normalizeThreadLabel(thread.preview) || `Chat ${thread.id.slice(0, 8)}`
}

function getThreadTitleTooltip(thread: UiThread): string {
  const title = getThreadDisplayTitle(thread)
  const preview = normalizeThreadLabel(thread.preview)
  return preview && preview !== title ? `${title}\n${preview}` : title
}

function getThreadStatusLabel(thread: UiThread): 'Running' | 'Unread' | '' {
  if (thread.inProgress) return 'Running'
  if (thread.unread) return 'Unread'
  return ''
}

function cacheVisiblePinnedThreads(): void {
  const pinnedSet = new Set(pinnedThreadIds.value)
  const next: Record<string, UiThread> = {}
  let changed = false

  for (const threadId of pinnedThreadIds.value) {
    const visibleThread = threadById.value.get(threadId)
    const cachedThread = pinnedThreadById.value[threadId]
    const thread = visibleThread ?? cachedThread
    if (!thread) continue
    next[threadId] = thread
    if (pinnedThreadById.value[threadId] !== thread) changed = true
  }

  for (const threadId of Object.keys(pinnedThreadById.value)) {
    if (!pinnedSet.has(threadId)) {
      changed = true
      break
    }
  }

  if (changed || Object.keys(next).length !== Object.keys(pinnedThreadById.value).length) {
    pinnedThreadById.value = next
  }
}

async function hydratePinnedThreadSummaries(): Promise<void> {
  const token = ++pinnedThreadsHydrateToken
  cacheVisiblePinnedThreads()

  const missingThreadIds = pinnedThreadIds.value.filter(
    (threadId) => !threadById.value.has(threadId) && !pinnedThreadById.value[threadId],
  )
  if (missingThreadIds.length === 0) return

  const summaries = await Promise.all(
    missingThreadIds.map((threadId) => getThreadSummary(threadId).catch(() => null)),
  )
  if (token !== pinnedThreadsHydrateToken) return

  const next = { ...pinnedThreadById.value }
  let changed = false
  for (const summary of summaries) {
    if (!summary || !pinnedThreadIds.value.includes(summary.id)) continue
    next[summary.id] = summary
    changed = true
  }
  if (changed) pinnedThreadById.value = next
}

function togglePin(threadId: string): void {
  const pinned = !isPinned(threadId)
  emit('set-thread-pinned', {
    threadId,
    pinned,
    beforeThreadId: pinned ? pinnedThreadIds.value[0] : undefined,
  })
}

function onSelect(threadId: string): void {
  emit('select', threadId)
}

function beginThreadRename(thread: UiThread): void {
  archiveConfirmThreadId.value = ''
  renamingThreadId.value = thread.id
  threadRenameDraft.value = getThreadDisplayTitle(thread)
  void nextTick(() => {
    const input = [...document.querySelectorAll<HTMLInputElement>('[data-thread-rename-input]')]
      .find((candidate) => candidate.dataset.threadRenameInput === thread.id)
    input?.focus()
    input?.select()
  })
}

function cancelThreadRename(): void {
  renamingThreadId.value = ''
  threadRenameDraft.value = ''
}

function commitThreadRename(thread: UiThread): void {
  if (renamingThreadId.value !== thread.id) return
  const name = normalizeThreadLabel(threadRenameDraft.value)
  cancelThreadRename()
  if (!name || name === getThreadDisplayTitle(thread)) return
  emit('rename-thread', { threadId: thread.id, name })
}

function isArchiveConfirming(threadId: string): boolean {
  return !isMobile.value && archiveConfirmThreadId.value === threadId
}

function archiveThread(threadId: string): void {
  archiveConfirmThreadId.value = ''
  if (isPinned(threadId)) {
    emit('set-thread-pinned', { threadId, pinned: false })
  }
  emit('archive', threadId)
}

function onArchiveClick(threadId: string): void {
  if (isMobile.value) {
    archiveThread(threadId)
    return
  }

  if (archiveConfirmThreadId.value !== threadId) {
    archiveConfirmThreadId.value = threadId
    return
  }

  archiveThread(threadId)
}

function getNewThreadButtonAriaLabel(projectName: string): string {
  return `start new thread ${getProjectDisplayName(projectName)}`
}

function onStartNewThread(projectName: string): void {
  emit('start-new-thread', projectName)
}

function onThreadRowLeave(threadId: string): void {
  if (archiveConfirmThreadId.value === threadId) {
    archiveConfirmThreadId.value = ''
  }
}

function getThreadScopeKey(scope: ThreadDragScope, projectName: string): string {
  return scope === 'project' ? `project:${projectName}` : scope
}

function isThreadReorderEnabled(_scope: ThreadDragScope): boolean {
  return !isThreadFilterActive.value
}

function getThreadIdsForScope(scope: ThreadDragScope, projectName: string): string[] {
  if (scope === 'pinned') return pinnedThreads.value.map((thread) => thread.id)
  if (scope === 'global') return globalThreads.value.map((thread) => thread.id)
  const group = props.groups.find((row) => row.projectName === projectName)
  return group ? projectThreads(group).map((thread) => thread.id) : []
}

function reorderLocalThreadIds(threadIds: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= threadIds.length || toIndex < 0 || toIndex >= threadIds.length) {
    return threadIds
  }
  if (fromIndex === toIndex) return threadIds

  const next = [...threadIds]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

function moveThreadInScope(scope: ThreadDragScope, projectName: string, threadId: string, toIndex: number): void {
  if (!isThreadReorderEnabled(scope)) return

  const scopeThreadIds = getThreadIdsForScope(scope, projectName)
  const fromIndex = scopeThreadIds.indexOf(threadId)
  if (fromIndex < 0) return

  const clampedToIndex = Math.max(0, Math.min(toIndex, scopeThreadIds.length - 1))
  if (fromIndex === clampedToIndex) return

  if (scope === 'pinned') {
    emit(
      'set-pinned-threads-order',
      reorderLocalThreadIds(scopeThreadIds, fromIndex, clampedToIndex),
    )
    return
  }

  emit('reorder-thread', {
    threadId,
    toIndex: clampedToIndex,
    projectName: scope === 'project' ? projectName : undefined,
    threadIds: scopeThreadIds,
  })
}

function onThreadDragStart(event: DragEvent, threadId: string, scope: ThreadDragScope, projectName: string, _index: number): void {
  if (!isThreadReorderEnabled(scope)) {
    event.preventDefault()
    return
  }

  activeThreadDrag.value = {
    threadId,
    scopeKey: getThreadScopeKey(scope, projectName),
    projectName,
  }
  threadDropTarget.value = null
  event.dataTransfer?.setData('text/plain', threadId)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

function onThreadDragOver(event: DragEvent, scope: ThreadDragScope, projectName: string, index: number): void {
  const drag = activeThreadDrag.value
  const scopeKey = getThreadScopeKey(scope, projectName)
  if (!drag || drag.scopeKey !== scopeKey) return

  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }

  const target = event.currentTarget
  const rect = target instanceof HTMLElement ? target.getBoundingClientRect() : null
  const position: ThreadDropPosition = rect && event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
  threadDropTarget.value = {
    scopeKey,
    index,
    position,
  }
}

function onThreadDrop(event: DragEvent, scope: ThreadDragScope, projectName: string): void {
  const drag = activeThreadDrag.value
  const target = threadDropTarget.value
  const scopeKey = getThreadScopeKey(scope, projectName)
  if (!drag || !target || drag.scopeKey !== scopeKey || target.scopeKey !== scopeKey) {
    resetThreadDragState()
    return
  }

  event.preventDefault()
  const scopeThreadIds = getThreadIdsForScope(scope, projectName)
  const fromIndex = scopeThreadIds.indexOf(drag.threadId)
  if (fromIndex < 0) {
    resetThreadDragState()
    return
  }

  const insertionIndex = target.index + (target.position === 'after' ? 1 : 0)
  const toIndex = insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex
  moveThreadInScope(scope, projectName, drag.threadId, toIndex)
  resetThreadDragState()
}

function resetThreadDragState(): void {
  activeThreadDrag.value = null
  threadDropTarget.value = null
}

function isThreadDragging(threadId: string): boolean {
  return activeThreadDrag.value?.threadId === threadId
}

function getThreadDropPosition(scope: ThreadDragScope, projectName: string, index: number): ThreadDropPosition | null {
  const target = threadDropTarget.value
  if (!target) return null
  if (target.scopeKey !== getThreadScopeKey(scope, projectName)) return null
  return target.index === index ? target.position : null
}

function onThreadKeyDown(event: KeyboardEvent, threadId: string, scope: ThreadDragScope, projectName: string): void {
  if (!event.altKey) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return

  const scopeThreadIds = getThreadIdsForScope(scope, projectName)
  const fromIndex = scopeThreadIds.indexOf(threadId)
  if (fromIndex < 0) return

  const delta = event.key === 'ArrowUp' ? -1 : 1
  const toIndex = Math.max(0, Math.min(fromIndex + delta, scopeThreadIds.length - 1))
  if (toIndex === fromIndex) return

  event.preventDefault()
  moveThreadInScope(scope, projectName, threadId, toIndex)
}

function getProjectDisplayName(projectName: string): string {
  return props.projectDisplayNameById[projectName] ?? projectName
}

function isProjectMenuOpen(projectName: string): boolean {
  return openProjectMenuId.value === projectName
}

function closeProjectMenu(): void {
  openProjectMenuId.value = ''
  projectMenuMode.value = 'actions'
  projectRenameDraft.value = ''
}

function toggleOrganizeMenu(): void {
  isOrganizeMenuOpen.value = !isOrganizeMenuOpen.value
}

function setThreadViewMode(mode: 'project' | 'chronological'): void {
  threadViewMode.value = mode
  isOrganizeMenuOpen.value = false
}

function toggleProjectMenu(projectName: string): void {
  if (openProjectMenuId.value === projectName) {
    closeProjectMenu()
    return
  }

  openProjectMenuId.value = projectName
  projectMenuMode.value = 'actions'
  projectRenameDraft.value = getProjectDisplayName(projectName)
}

function openRenameProjectMenu(projectName: string): void {
  openProjectMenuId.value = projectName
  projectMenuMode.value = 'rename'
  projectRenameDraft.value = getProjectDisplayName(projectName)
}

function onProjectNameInput(projectName: string): void {
  emit('rename-project', {
    projectName,
    displayName: projectRenameDraft.value,
  })
}

function onRemoveProject(projectName: string): void {
  emit('remove-project', projectName)
  closeProjectMenu()
}

function onProjectHeaderKeyDown(event: KeyboardEvent, projectName: string): void {
  if (!event.altKey) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return

  const currentIndex = props.groups.findIndex((group) => group.projectName === projectName)
  if (currentIndex < 0) return

  const delta = event.key === 'ArrowUp' ? -1 : 1
  const targetIndex = Math.max(0, Math.min(currentIndex + delta, props.groups.length - 1))
  if (targetIndex === currentIndex) return

  event.preventDefault()
  emit('reorder-project', {
    projectName,
    toIndex: targetIndex,
  })
}

function isExpanded(projectName: string): boolean {
  return expandedProjects.value[projectName] === true
}

function isCollapsed(projectName: string): boolean {
  return collapsedProjects.value[projectName] === true
}

function toggleProjectExpansion(projectName: string): void {
  expandedProjects.value = {
    ...expandedProjects.value,
    [projectName]: !isExpanded(projectName),
  }
}

function toggleProjectCollapse(projectName: string): void {
  if (suppressNextProjectToggleId.value === projectName) {
    suppressNextProjectToggleId.value = ''
    return
  }

  collapsedProjects.value = {
    ...collapsedProjects.value,
    [projectName]: !isCollapsed(projectName),
  }
}

function getProjectOuterHeight(projectName: string): number {
  const measuredHeight = measuredHeightByProject.value[projectName] ?? 0
  const drag = activeProjectDrag.value
  const dragHeight = drag?.projectName === projectName ? drag.groupHeight : null
  const baseHeight = dragHeight ?? measuredHeight
  const gap = isCollapsed(projectName) ? 0 : PROJECT_GROUP_EXPANDED_GAP_PX
  return Math.max(0, baseHeight + gap)
}

function setProjectMenuWrapRef(projectName: string, element: Element | ComponentPublicInstance | null): void {
  const htmlElement =
    element instanceof HTMLElement
      ? element
      : element && '$el' in element && element.$el instanceof HTMLElement
        ? element.$el
        : null

  if (htmlElement) {
    projectMenuWrapElementByName.set(projectName, htmlElement)
    return
  }

  projectMenuWrapElementByName.delete(projectName)
}

function isEventInsideOpenProjectMenu(event: Event): boolean {
  const projectName = openProjectMenuId.value
  if (!projectName) return false

  const openMenuWrapElement = projectMenuWrapElementByName.get(projectName)
  if (!openMenuWrapElement) return false

  const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : []
  if (eventPath.includes(openMenuWrapElement)) return true

  const target = event.target
  return target instanceof Node ? openMenuWrapElement.contains(target) : false
}

function onProjectMenuPointerDown(event: PointerEvent): void {
  if (isOrganizeMenuOpen.value) {
    const organizeElement = organizeMenuWrapRef.value
    const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : []
    const isInsideOrganizeMenu =
      !!organizeElement &&
      (eventPath.includes(organizeElement) || (event.target instanceof Node && organizeElement.contains(event.target)))

    if (!isInsideOrganizeMenu) {
      isOrganizeMenuOpen.value = false
    }
  }

  if (!openProjectMenuId.value) return
  if (isEventInsideOpenProjectMenu(event)) return
  closeProjectMenu()
}

function onProjectMenuFocusIn(event: FocusEvent): void {
  if (!openProjectMenuId.value) return
  if (isEventInsideOpenProjectMenu(event)) return
  closeProjectMenu()
}

function onWindowBlurForProjectMenu(): void {
  if (isOrganizeMenuOpen.value) {
    isOrganizeMenuOpen.value = false
  }
  if (!openProjectMenuId.value) return
  closeProjectMenu()
}

function bindProjectMenuDismissListeners(): void {
  window.addEventListener('pointerdown', onProjectMenuPointerDown, { capture: true })
  window.addEventListener('focusin', onProjectMenuFocusIn, { capture: true })
  window.addEventListener('blur', onWindowBlurForProjectMenu)
}

function unbindProjectMenuDismissListeners(): void {
  window.removeEventListener('pointerdown', onProjectMenuPointerDown, { capture: true })
  window.removeEventListener('focusin', onProjectMenuFocusIn, { capture: true })
  window.removeEventListener('blur', onWindowBlurForProjectMenu)
}

function updateMeasuredProjectHeight(projectName: string, element: HTMLElement): void {
  const nextHeight = element.getBoundingClientRect().height
  if (!Number.isFinite(nextHeight) || nextHeight <= 0) return

  const previousHeight = measuredHeightByProject.value[projectName]
  if (previousHeight !== undefined && Math.abs(previousHeight - nextHeight) < 0.5) {
    return
  }

  measuredHeightByProject.value = {
    ...measuredHeightByProject.value,
    [projectName]: nextHeight,
  }
}

function setProjectGroupRef(projectName: string, element: Element | ComponentPublicInstance | null): void {
  const previousElement = projectGroupElementByName.get(projectName)
  if (previousElement && previousElement !== element && projectGroupResizeObserver) {
    projectGroupResizeObserver.unobserve(previousElement)
  }

  const htmlElement =
    element instanceof HTMLElement
      ? element
      : element && '$el' in element && element.$el instanceof HTMLElement
        ? element.$el
        : null

  if (htmlElement) {
    projectGroupElementByName.set(projectName, htmlElement)
    projectNameByElement.set(htmlElement, projectName)
    updateMeasuredProjectHeight(projectName, htmlElement)
    projectGroupResizeObserver?.observe(htmlElement)
    return
  }

  if (previousElement) {
    projectGroupResizeObserver?.unobserve(previousElement)
  }

  projectGroupElementByName.delete(projectName)
}

function onProjectHandlePointerDown(event: PointerEvent, projectName: string): void {
  if (event.button !== 0) return
  if (pendingProjectDrag.value || activeProjectDrag.value) return

  const fromIndex = props.groups.findIndex((group) => group.projectName === projectName)
  const projectGroupElement = projectGroupElementByName.get(projectName)
  if (fromIndex < 0 || !projectGroupElement) return

  const groupRect = projectGroupElement.getBoundingClientRect()
  const groupGap = isCollapsed(projectName) ? 0 : PROJECT_GROUP_EXPANDED_GAP_PX
  pendingProjectDrag.value = {
    projectName,
    fromIndex,
    startClientX: event.clientX,
    startClientY: event.clientY,
    pointerOffsetY: event.clientY - groupRect.top,
    groupLeft: groupRect.left,
    groupWidth: groupRect.width,
    groupHeight: groupRect.height,
    groupOuterHeight: groupRect.height + groupGap,
  }

  event.preventDefault()
  bindProjectDragListeners()
}

function bindProjectDragListeners(): void {
  window.addEventListener('pointermove', onProjectDragPointerMove, { passive: false })
  window.addEventListener('pointerup', onProjectDragPointerUp)
  window.addEventListener('pointercancel', onProjectDragPointerCancel)
  window.addEventListener('keydown', onProjectDragKeyDown)
}

function unbindProjectDragListeners(): void {
  window.removeEventListener('pointermove', onProjectDragPointerMove)
  window.removeEventListener('pointerup', onProjectDragPointerUp)
  window.removeEventListener('pointercancel', onProjectDragPointerCancel)
  window.removeEventListener('keydown', onProjectDragKeyDown)
}

function onProjectDragPointerMove(event: PointerEvent): void {
  if (!pendingProjectDrag.value && !activeProjectDrag.value) return
  event.preventDefault()
  pendingDragPointerSample = {
    clientX: event.clientX,
    clientY: event.clientY,
  }
  scheduleProjectDragPointerFrame()
}

function onProjectDragPointerUp(event: PointerEvent): void {
  processProjectDragPointerSample({
    clientX: event.clientX,
    clientY: event.clientY,
  })

  const drag = activeProjectDrag.value
  if (drag && projectedDropProjectIndex.value !== null) {
    const currentProjectIndex = props.groups.findIndex((group) => group.projectName === drag.projectName)
    if (currentProjectIndex >= 0) {
      const toIndex = projectedDropProjectIndex.value
      if (toIndex !== currentProjectIndex) {
        emit('reorder-project', {
          projectName: drag.projectName,
          toIndex,
        })
      }
    }
  }

  resetProjectDragState()
}

function onProjectDragPointerCancel(): void {
  resetProjectDragState()
}

function onProjectDragKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (!pendingProjectDrag.value && !activeProjectDrag.value) return

  event.preventDefault()
  resetProjectDragState()
}

function resetProjectDragState(): void {
  if (dragPointerRafId !== null) {
    window.cancelAnimationFrame(dragPointerRafId)
    dragPointerRafId = null
  }
  pendingDragPointerSample = null
  pendingProjectDrag.value = null
  activeProjectDrag.value = null
  suppressNextProjectToggleId.value = ''
  unbindProjectDragListeners()
}

function scheduleProjectDragPointerFrame(): void {
  if (dragPointerRafId !== null) return

  dragPointerRafId = window.requestAnimationFrame(() => {
    dragPointerRafId = null
    if (!pendingDragPointerSample) return

    const sample = pendingDragPointerSample
    pendingDragPointerSample = null
    processProjectDragPointerSample(sample)
  })
}

function processProjectDragPointerSample(sample: DragPointerSample): void {
  const pending = pendingProjectDrag.value
  if (!activeProjectDrag.value && pending) {
    const deltaX = sample.clientX - pending.startClientX
    const deltaY = sample.clientY - pending.startClientY
    const distance = Math.hypot(deltaX, deltaY)
    if (distance < DRAG_START_THRESHOLD_PX) {
      return
    }

    closeProjectMenu()
    suppressNextProjectToggleId.value = pending.projectName
    activeProjectDrag.value = {
      projectName: pending.projectName,
      fromIndex: pending.fromIndex,
      pointerOffsetY: pending.pointerOffsetY,
      groupLeft: pending.groupLeft,
      groupWidth: pending.groupWidth,
      groupHeight: pending.groupHeight,
      groupOuterHeight: pending.groupOuterHeight,
      ghostTop: sample.clientY - pending.pointerOffsetY,
      dropTargetIndexFull: null,
    }
  }

  if (!activeProjectDrag.value) return
  updateProjectDropTarget(sample)
}

function updateProjectDropTarget(sample: DragPointerSample): void {
  const drag = activeProjectDrag.value
  if (!drag) return

  drag.ghostTop = sample.clientY - drag.pointerOffsetY
  if (!isPointerInProjectDropZone(sample)) {
    drag.dropTargetIndexFull = null
    return
  }

  const cursorY = sample.clientY
  const groupsContainer = groupsContainerRef.value
  if (!groupsContainer) {
    drag.dropTargetIndexFull = null
    return
  }

  const containerRect = groupsContainer.getBoundingClientRect()
  const projectIndexByName = new Map(props.groups.map((group, index) => [group.projectName, index]))
  const nonDraggedProjectNames = props.groups
    .map((group) => group.projectName)
    .filter((projectName) => projectName !== drag.projectName)

  let accumulatedTop = 0
  let nextDropTarget = props.groups.length

  for (const projectName of nonDraggedProjectNames) {
    const originalIndex = projectIndexByName.get(projectName)
    if (originalIndex === undefined) continue

    const groupOuterHeight = getProjectOuterHeight(projectName)
    const groupMiddleY = containerRect.top + accumulatedTop + groupOuterHeight / 2
    if (cursorY < groupMiddleY) {
      nextDropTarget = originalIndex
      break
    }

    accumulatedTop += groupOuterHeight
  }

  drag.dropTargetIndexFull = nextDropTarget
}

function isPointerInProjectDropZone(sample: DragPointerSample): boolean {
  const groupsContainer = groupsContainerRef.value
  if (!groupsContainer) return false

  const bounds = groupsContainer.getBoundingClientRect()
  const xInBounds = sample.clientX >= bounds.left && sample.clientX <= bounds.right
  const yInBounds = sample.clientY >= bounds.top - 32 && sample.clientY <= bounds.bottom + 32
  return xInBounds && yInBounds
}

function isDraggingProject(projectName: string): boolean {
  return activeProjectDrag.value?.projectName === projectName
}

function projectGroupStyle(projectName: string): Record<string, string> | undefined {
  const drag = activeProjectDrag.value
  const targetTop = layoutTopByProject.value[projectName] ?? 0
  const shouldElevateForMenu = openProjectMenuId.value === projectName

  if (!drag || drag.projectName !== projectName) {
    return {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      zIndex: shouldElevateForMenu ? '40' : '1',
      transform: `translate3d(0, ${targetTop}px, 0)`,
      willChange: 'transform',
      transition: 'transform 180ms ease',
    }
  }

  return {
    position: 'fixed',
    top: '0',
    left: `${drag.groupLeft}px`,
    width: `${drag.groupWidth}px`,
    height: `${drag.groupHeight}px`,
    zIndex: '50',
    pointerEvents: 'none',
    transform: `translate3d(0, ${drag.ghostTop}px, 0)`,
    willChange: 'transform',
    transition: 'transform 0ms linear',
  }
}

function projectThreads(group: UiProjectGroup): UiThread[] {
  return group.threads.filter((thread) => !isPinned(thread.id))
}

function visibleThreads(group: UiProjectGroup): UiThread[] {
  if (isThreadFilterActive.value) return projectThreads(group)
  if (isCollapsed(group.projectName)) return []

  const rows = projectThreads(group)
  return isExpanded(group.projectName) ? rows : rows.slice(0, 5)
}

function hasHiddenThreads(group: UiProjectGroup): boolean {
  if (isThreadFilterActive.value) return false
  return !isCollapsed(group.projectName) && projectThreads(group).length > 5
}

function hasThreads(group: UiProjectGroup): boolean {
  return projectThreads(group).length > 0
}

function getThreadState(thread: UiThread): 'working' | 'unread' | 'idle' {
  if (thread.inProgress) return 'working'
  if (thread.unread) return 'unread'
  return 'idle'
}

watch(
  () => props.groups.map((group) => group.projectName),
  (projectNames) => {
    const dragProjectName = activeProjectDrag.value?.projectName ?? pendingProjectDrag.value?.projectName ?? ''
    if (dragProjectName && !props.groups.some((group) => group.projectName === dragProjectName)) {
      resetProjectDragState()
    }

    const projectNameSet = new Set(projectNames)
    const nextMeasuredHeights = Object.fromEntries(
      Object.entries(measuredHeightByProject.value).filter(([projectName]) => projectNameSet.has(projectName)),
    ) as Record<string, number>

    if (Object.keys(nextMeasuredHeights).length !== Object.keys(measuredHeightByProject.value).length) {
      measuredHeightByProject.value = nextMeasuredHeights
    }
  },
)

watch(
  [pinnedThreadIds, () => props.groups],
  () => {
    void hydratePinnedThreadSummaries()
  },
)

watch(
  activeShortcutThreadIds,
  (threadIds) => emit('shortcut-threads-change', [...threadIds]),
  { immediate: true, flush: 'sync' },
)

const hasOpenDismissableMenu = computed(() => isOrganizeMenuOpen.value || openProjectMenuId.value !== '')

watch(hasOpenDismissableMenu, (isOpen) => {
  if (isOpen) {
    bindProjectMenuDismissListeners()
    return
  }

  unbindProjectMenuDismissListeners()
})

onMounted(() => {
  window.addEventListener('keydown', onStatusFilterShortcut)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onStatusFilterShortcut)
  for (const element of projectGroupElementByName.values()) {
    projectGroupResizeObserver?.unobserve(element)
  }
  projectGroupElementByName.clear()
  projectMenuWrapElementByName.clear()
  unbindProjectMenuDismissListeners()
  resetThreadDragState()
  resetProjectDragState()
})
</script>

<style scoped>
@reference "tailwindcss";

.thread-tree-root {
  @apply flex flex-col;
}

.pinned-section {
  @apply mb-1 pb-1;
}

.pinned-section-label {
  @apply block px-2.5 py-2 text-sm font-normal normal-case tracking-normal text-zinc-500 select-none;
}

.thread-tree-header-row {
  @apply cursor-default border-t border-zinc-200 pt-3 mt-2;
}

.thread-tree-header-row--after-pinned {
  @apply mt-1;
}

.thread-tree-header {
  @apply text-sm font-normal normal-case tracking-normal text-zinc-500 select-none;
}

.thread-status-filters {
  @apply mb-2 mt-1 grid grid-cols-3 gap-1 px-2.5;
}

.thread-status-filter {
  @apply flex min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-[11px] font-medium leading-4;
  background: var(--surface-muted);
  border-color: var(--border-soft);
  color: var(--text-tertiary);
}

.thread-status-filter:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.thread-status-filter[data-active='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}

.thread-status-filter-count {
  @apply tabular-nums opacity-70;
}

.organize-menu-wrap {
  @apply relative;
}

.organize-menu-trigger {
  @apply h-5 w-5 rounded-md text-zinc-500 flex items-center justify-center transition hover:bg-zinc-200/80 hover:text-zinc-700;
}

.organize-menu-panel {
  @apply absolute right-0 top-full mt-1 z-30 min-w-44 rounded-xl border border-zinc-200 bg-white/95 p-1.5 shadow-lg backdrop-blur-sm;
}

.organize-menu-title {
  @apply px-2 py-1 text-xs text-zinc-500;
}

.organize-menu-item {
  @apply w-full rounded-md px-2 py-1.5 text-sm leading-6 text-zinc-700 flex items-center justify-between hover:bg-zinc-100;
}

.organize-menu-item[data-active='true'] {
  @apply bg-zinc-100 text-zinc-900;
}

.thread-start-button {
  @apply h-5 w-5 rounded-md text-zinc-500 flex items-center justify-center transition hover:bg-zinc-200/80 hover:text-zinc-700;
}

.thread-tree-loading {
  @apply px-2.5 py-2 text-sm leading-6 text-zinc-500;
}

.thread-tree-no-results {
  @apply px-2.5 py-2 text-sm leading-6 text-zinc-400;
}

.thread-tree-groups {
  @apply pr-0.5 relative;
}

.project-group {
  @apply m-0 transition-shadow;
}

.project-group[data-dragging='true'] {
  @apply shadow-lg;
}

.project-header-row {
  @apply hover:bg-zinc-200/80 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400;
}

.project-main-button {
  @apply min-w-0 w-full text-left rounded px-0 py-0 flex items-center min-h-5 cursor-grab;
  touch-action: none;
}

.project-main-button[data-dragging-handle='true'] {
  @apply cursor-grabbing;
}

.project-icon-stack {
  @apply relative w-4 h-4 flex items-center justify-center text-zinc-500;
}

.project-icon-folder {
  @apply absolute inset-0 flex items-center justify-center opacity-100;
}

.project-icon-chevron {
  @apply absolute inset-0 items-center justify-center opacity-0 hidden;
}

.project-title {
  @apply text-sm leading-6 font-medium text-zinc-700 truncate select-none;
}

.project-menu-wrap {
  @apply relative;
}

.project-hover-controls {
  @apply flex items-center gap-1;
}

.project-menu-trigger {
  @apply h-5 w-5 rounded-md p-0 text-zinc-500 flex items-center justify-center hover:bg-zinc-200/80 hover:text-zinc-700;
}

.project-menu-panel {
  @apply absolute right-0 top-full mt-1 z-20 min-w-36 rounded-lg border border-zinc-200 bg-white p-1 shadow-md flex flex-col gap-0.5;
}

.project-menu-item {
  @apply rounded-md px-2 py-1.5 text-left text-sm leading-6 text-zinc-700 hover:bg-zinc-100;
}

.project-menu-item-danger {
  @apply text-rose-700 hover:bg-rose-50;
}

.project-menu-label {
  @apply px-2 pt-1 text-xs text-zinc-500;
}

.project-menu-input {
  @apply px-2 py-1 text-sm leading-6 text-zinc-800 bg-transparent border-none outline-none;
}

.project-empty-row {
  @apply cursor-default;
}

.project-empty-spacer {
  @apply block w-4 h-4;
}

.project-empty {
  @apply text-sm leading-6 text-zinc-400;
}

.thread-list {
  @apply list-none m-0 p-0 flex flex-col gap-1;
}

.thread-list-global {
  @apply pr-0.5;
}

.project-group > .thread-list {
  @apply mt-1;
}

.thread-row-item {
  @apply m-0;
}

.thread-row {
  @apply hover:bg-zinc-200/80;
}

.thread-row[draggable='true'] {
  @apply cursor-grab;
}

.thread-row[data-thread-dragging='true'] {
  @apply opacity-50;
}

.thread-row[data-thread-drop-position='before'] {
  box-shadow: inset 0 2px 0 rgb(59 130 246 / 0.75);
}

.thread-row[data-thread-drop-position='after'] {
  box-shadow: inset 0 -2px 0 rgb(59 130 246 / 0.75);
}

.thread-left-stack {
  @apply relative w-4 h-4 flex items-center justify-center;
}

.thread-pin-button {
  @apply absolute inset-0 w-4 h-4 rounded text-zinc-500 opacity-0 pointer-events-none transition flex items-center justify-center;
}

.thread-main-button {
  @apply min-w-0 w-full text-left rounded px-0 py-0 flex items-center min-h-5;
}

.thread-rename-input {
  @apply min-w-0 w-full rounded-md border px-1.5 py-0.5 text-sm leading-5 outline-none;
  background: var(--surface-elevated);
  border-color: var(--accent);
  color: var(--text-primary);
  box-shadow: 0 0 0 1px var(--accent-soft);
}

.thread-row-title-wrap {
  @apply min-w-0 inline-flex items-center gap-1;
}

.thread-row-title {
  @apply block text-sm leading-6 font-normal text-zinc-700 truncate whitespace-nowrap;
}

.thread-shortcut-hint {
  @apply inline-flex h-5 w-8 shrink-0 items-center justify-center rounded-md border px-1 font-sans text-[10px] font-medium leading-none;
  background: var(--surface-muted);
  border-color: var(--border-subtle);
  color: var(--text-tertiary);
}

.thread-status-label {
  @apply inline-flex h-4 w-14 shrink-0 items-center justify-center rounded-full border px-1 text-[9px] font-semibold uppercase leading-none tracking-wide;
}

.thread-status-label[data-state='working'] {
  background: rgb(16 185 129 / 0.12);
  border-color: rgb(16 185 129 / 0.35);
  color: rgb(5 150 105);
}

.thread-status-label[data-state='unread'] {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent-strong);
}

.thread-row-worktree-icon {
  @apply w-3 h-3 text-zinc-500 shrink-0;
}

.thread-status-indicator {
  @apply w-2.5 h-2.5 rounded-full;
}

.thread-row-time {
  @apply block text-xs leading-6 font-normal text-zinc-500 tabular-nums;
}

.thread-row-actions {
  @apply flex items-center gap-1;
}

.thread-rename-button,
.thread-archive-button {
  @apply h-4 w-4 rounded p-0 text-xs text-zinc-600 flex items-center justify-center;
}

.thread-rename-button:hover,
.thread-archive-button:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.thread-archive-button {
  @apply h-4 w-4;
}

.thread-archive-button[data-confirm='true'] {
  @apply h-5 w-auto px-1.5;
}

@media (max-width: 767px), (pointer: coarse) {
  .thread-row {
    @apply min-h-10;
  }

  .thread-main-button {
    @apply min-h-8;
  }

  .thread-row-title-wrap {
    @apply w-full items-start;
  }

  .thread-row-title {
    display: -webkit-box;
    overflow: hidden;
    white-space: normal;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    line-height: 1.25rem;
  }

  .thread-row-worktree-icon {
    @apply mt-1;
  }

  .thread-rename-button,
  .thread-archive-button {
    @apply h-8 w-8 rounded-lg;
  }

  .thread-rename-button .thread-icon,
  .thread-archive-button .thread-icon {
    @apply h-5 w-5;
  }

  .thread-archive-button[data-confirm='true'] {
    @apply h-8 w-auto px-3 text-sm font-medium;
  }
}

.thread-icon {
  @apply w-4 h-4;
}

.thread-show-more-row {
  @apply mt-1;
}

.thread-show-more-spacer {
  @apply block w-4 h-4;
}

.thread-show-more-button {
  @apply block mx-auto rounded-md px-2 py-1 text-sm leading-6 font-normal text-zinc-600 transition hover:text-zinc-800 hover:bg-zinc-200/80;
}

.project-header-row:hover .project-icon-folder {
  @apply opacity-0;
}

.project-header-row:hover .project-icon-chevron {
  @apply flex opacity-100;
}

.thread-row[data-active='true'] {
  @apply bg-zinc-200/90;
}

.thread-row[data-active='true'] .thread-row-title {
  @apply font-medium;
}

.thread-row:hover .thread-pin-button,
.thread-row:focus-within .thread-pin-button {
  @apply opacity-100 pointer-events-auto;
}

.thread-status-indicator[data-state='unread'] {
  width: 6.6667px;
  height: 6.6667px;
  @apply bg-blue-600;
}

.thread-status-indicator[data-state='working'] {
  @apply border-2 border-zinc-500 border-t-transparent bg-transparent animate-spin;
}

.thread-row:hover .thread-status-indicator[data-state='unread'],
.thread-row:hover .thread-status-indicator[data-state='working'],
.thread-row:focus-within .thread-status-indicator[data-state='unread'],
.thread-row:focus-within .thread-status-indicator[data-state='working'] {
  @apply opacity-0;
}
</style>
