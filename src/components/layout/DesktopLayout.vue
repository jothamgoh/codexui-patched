<template>
  <div ref="layoutRef" class="desktop-layout" :class="{ 'is-mobile': isMobile, 'is-keyboard-open': isKeyboardOpen }" :style="layoutStyle">
    <Teleport v-if="isMobile" to="body">
      <Transition name="drawer">
        <div v-if="!isSidebarCollapsed" class="mobile-drawer-backdrop" @click="$emit('close-sidebar')">
          <aside class="mobile-drawer" @click.stop>
            <slot name="sidebar" />
          </aside>
        </div>
      </Transition>
    </Teleport>

    <template v-if="!isMobile">
      <aside v-if="!isSidebarCollapsed" class="desktop-sidebar">
        <slot name="sidebar" />
      </aside>
      <button
        v-if="!isSidebarCollapsed"
        class="desktop-resize-handle"
        type="button"
        aria-label="Resize sidebar"
        @mousedown="onResizeHandleMouseDown"
      />
    </template>

    <section class="desktop-main">
      <slot name="content" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useMobile } from '../../composables/useMobile'
import { keepFieldAboveKeyboard, measureKeyboardLayout, raisesKeyboard } from '../../utils/keyboardViewport'

const props = withDefaults(
  defineProps<{
    isSidebarCollapsed?: boolean
  }>(),
  {
    isSidebarCollapsed: false,
  },
)

defineEmits<{
  'close-sidebar': []
}>()

const { isMobile } = useMobile()

const SIDEBAR_WIDTH_KEY = 'codex-web-local.sidebar-width.v1'
const MIN_SIDEBAR_WIDTH = 260
const MAX_SIDEBAR_WIDTH = 620
const DEFAULT_SIDEBAR_WIDTH = 320

function clampSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))
}

function loadSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH
  const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH
  return clampSidebarWidth(parsed)
}

const sidebarWidth = ref(loadSidebarWidth())
const layoutRef = ref<HTMLElement | null>(null)
const viewportHeightPx = ref<number | null>(null)
const viewportOffsetTopPx = ref(0)
/** The visible height while no field has focus, for telling a keyboard from a focused field. */
const restingHeightPx = ref(0)
let settleTimer: ReturnType<typeof setTimeout> | null = null
let focusFrame = 0

/**
 * Fits the layout to the part of the window above the keyboard, undoing iOS's pan to a field in
 * the layout (see keyboardViewport.ts). With `reveal`, the focused field is also kept in view.
 */
function syncViewport(focused: Element | null = document.activeElement, reveal = false): void {
  const field = raisesKeyboard(focused) ? focused : null
  const inLayout = field !== null && layoutRef.value?.contains(field) === true
  const before = viewportHeightPx.value
  const layout = measureKeyboardLayout(window, focused, field === null || inLayout)
  viewportHeightPx.value = layout.height
  viewportOffsetTopPx.value = layout.top
  if (layout.height === null) {
    restingHeightPx.value = Math.round(window.visualViewport?.height ?? window.innerHeight)
    document.documentElement.style.removeProperty('--visual-viewport-height')
  } else {
    document.documentElement.style.setProperty('--visual-viewport-height', `${layout.height}px`)
  }

  if (field === null || !inLayout || layout.height === null) return
  // The keyboard rose or grew over the field, or the field took focus under it.
  if (reveal || before === null || layout.height < before) {
    const keyboardTop = layout.top + layout.height
    void nextTick(() => keepFieldAboveKeyboard(field, keyboardTop, window))
  }
}

// Measure again once a burst of viewport events settles: a phone can report the keyboard's
// final size after its last event.
function settleViewport(): void {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    syncViewport()
  }, 150)
}

function onViewportChange(): void {
  syncViewport()
  settleViewport()
}

function onFocusIn(): void {
  if (raisesKeyboard(document.activeElement)) syncViewport(document.activeElement, true)
  else syncViewportNextFrame()
  settleViewport()
}

function onFocusOut(): void {
  syncViewportNextFrame()
  settleViewport()
}

// Focus leaving every field lets the layout down in the next frame: WebKit reports the keyboard
// gone only after it has slid away, and a layout held short until then leaves blank space under
// it. Not sooner: a tap moves focus on its mousedown and aims its click after, so a layout
// dropped in between would slide the tapped button out from under the finger.
function syncViewportNextFrame(): void {
  cancelAnimationFrame(focusFrame)
  focusFrame = requestAnimationFrame(() => syncViewport())
}

onMounted(() => {
  syncViewport()
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange)
  window.visualViewport?.addEventListener('resize', onViewportChange)
  window.visualViewport?.addEventListener('scroll', onViewportChange)
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
})

onUnmounted(() => {
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange)
  window.visualViewport?.removeEventListener('resize', onViewportChange)
  window.visualViewport?.removeEventListener('scroll', onViewportChange)
  document.removeEventListener('focusin', onFocusIn)
  document.removeEventListener('focusout', onFocusOut)
  if (settleTimer) clearTimeout(settleTimer)
  cancelAnimationFrame(focusFrame)
  document.documentElement.style.removeProperty('--visual-viewport-height')
})

const layoutStyle = computed(() => {
  const style: Record<string, string> = {}
  if (viewportHeightPx.value && viewportHeightPx.value > 0) {
    style['--layout-viewport-height'] = `${viewportHeightPx.value}px`
  }
  if (viewportOffsetTopPx.value > 0) {
    style['--layout-viewport-top'] = `${viewportOffsetTopPx.value}px`
  }
  if (isMobile.value || props.isSidebarCollapsed) {
    style['--sidebar-width'] = '0px'
    style['--layout-columns'] = 'minmax(0, 1fr)'
    return style
  }
  style['--sidebar-width'] = `${sidebarWidth.value}px`
  style['--layout-columns'] = 'var(--sidebar-width) 1px minmax(0, 1fr)'
  return style
})

const isKeyboardOpen = computed(() =>
  isMobile.value && viewportHeightPx.value !== null && restingHeightPx.value - viewportHeightPx.value > 120)

function saveSidebarWidth(value: number): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(value))
}

function onResizeHandleMouseDown(event: MouseEvent): void {
  event.preventDefault()
  const startX = event.clientX
  const startWidth = sidebarWidth.value

  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientX - startX
    sidebarWidth.value = clampSidebarWidth(startWidth + delta)
  }

  const onMouseUp = () => {
    saveSidebarWidth(sidebarWidth.value)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}
</script>

<style scoped>
@reference "tailwindcss";

.desktop-layout {
  @apply grid bg-slate-100 text-slate-900 overflow-hidden;
  position: fixed;
  inset: 0;
  top: var(--layout-viewport-top, 0px);
  width: 100%;
  height: 100vh;
  height: 100dvh;
  height: var(--layout-viewport-height, 100dvh);
  grid-template-columns: var(--layout-columns);
  overscroll-behavior: none;
  touch-action: manipulation;
}

.desktop-sidebar {
  @apply bg-slate-100 min-h-0 overflow-y-auto;
  overscroll-behavior: contain;
}

.desktop-resize-handle {
  @apply relative w-px cursor-col-resize bg-slate-300 hover:bg-slate-400 transition;
}

.desktop-resize-handle::before {
  content: '';
  @apply absolute -left-2 -right-2 top-0 bottom-0;
}

.desktop-main {
  @apply bg-white min-h-0 overflow-y-hidden overflow-x-visible;
  overscroll-behavior: none;
}

.mobile-drawer-backdrop {
  @apply fixed inset-0 z-40 bg-black/40;
}

.mobile-drawer {
  @apply absolute top-0 left-0 bottom-0 bg-slate-100 overflow-y-auto shadow-2xl;
  width: min(92vw, 26rem);
  max-width: calc(100vw - 0.75rem);
  overscroll-behavior: contain;
}

.drawer-enter-active,
.drawer-leave-active {
  @apply transition-opacity duration-200;
}

.drawer-enter-active .mobile-drawer,
.drawer-leave-active .mobile-drawer {
  transition: transform 200ms ease;
}

.drawer-enter-from {
  @apply opacity-0;
}

.drawer-enter-from .mobile-drawer {
  transform: translateX(-100%);
}

.drawer-leave-to {
  @apply opacity-0;
}

.drawer-leave-to .mobile-drawer {
  transform: translateX(-100%);
}
</style>
