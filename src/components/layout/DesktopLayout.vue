<template>
  <div class="desktop-layout" :class="{ 'is-mobile': isMobile, 'is-keyboard-open': isKeyboardOpen }" :style="layoutStyle">
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
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useMobile } from '../../composables/useMobile'

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
const viewportHeightPx = ref<number | null>(null)
const keyboardOpen = ref(false)
let viewportHeightRafId = 0
let viewportStabilizeTimer: ReturnType<typeof setTimeout> | null = null
const isIOS =
  typeof navigator !== 'undefined' &&
  (/iP(ad|hone|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

function isEditableTarget(target: Element | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tagName = target.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

function commitViewportMetrics(height: number): void {
  if (height > 0) {
    viewportHeightPx.value = height
    document.documentElement.style.setProperty('--visual-viewport-height', `${height}px`)
  }
  const active = document.activeElement
  keyboardOpen.value =
    isMobile.value &&
    isEditableTarget(active) &&
    typeof window !== 'undefined' &&
    window.innerHeight - height > 120
}

function readViewportHeight(): number {
  if (typeof window === 'undefined') {
    return 0
  }
  const viewport = window.visualViewport
  return Math.round(viewport?.height ?? window.innerHeight)
}

function updateViewportHeight(): void {
  if (typeof window === 'undefined') return
  const height = readViewportHeight()
  const active = document.activeElement
  const shouldStabilize = isIOS && isEditableTarget(active)

  if (viewportStabilizeTimer) {
    clearTimeout(viewportStabilizeTimer)
    viewportStabilizeTimer = null
  }

  if (!shouldStabilize) {
    commitViewportMetrics(height)
    return
  }

  viewportStabilizeTimer = setTimeout(() => {
    viewportStabilizeTimer = null
    commitViewportMetrics(readViewportHeight())
  }, 90)
}

function requestViewportHeightUpdate(): void {
  if (typeof window === 'undefined') return
  if (viewportHeightRafId !== 0) {
    window.cancelAnimationFrame(viewportHeightRafId)
  }
  viewportHeightRafId = window.requestAnimationFrame(() => {
    viewportHeightRafId = 0
    updateViewportHeight()
  })
}

onMounted(() => {
  updateViewportHeight()
  window.addEventListener('resize', requestViewportHeightUpdate)
  window.visualViewport?.addEventListener('resize', requestViewportHeightUpdate)
})

onUnmounted(() => {
  window.removeEventListener('resize', requestViewportHeightUpdate)
  window.visualViewport?.removeEventListener('resize', requestViewportHeightUpdate)
  if (viewportStabilizeTimer) {
    clearTimeout(viewportStabilizeTimer)
    viewportStabilizeTimer = null
  }
  if (viewportHeightRafId !== 0) {
    window.cancelAnimationFrame(viewportHeightRafId)
    viewportHeightRafId = 0
  }
  document.documentElement.style.removeProperty('--visual-viewport-height')
})

const layoutStyle = computed(() => {
  const style: Record<string, string> = {}
  if (viewportHeightPx.value && viewportHeightPx.value > 0) {
    style['--layout-viewport-height'] = `${viewportHeightPx.value}px`
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

const isKeyboardOpen = computed(() => keyboardOpen.value)

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
