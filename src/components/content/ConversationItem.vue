<template>
  <li ref="element" :style="mounted ? undefined : { height: `${height}px` }" :data-virtualized="!mounted || undefined">
    <slot v-if="mounted" />
  </li>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ eager: boolean; pinned: boolean; estimatedHeight: number }>()
const emit = defineEmits<{ resized: [] }>()
const element = ref<HTMLElement | null>(null)
const nearby = ref(props.eager)
const height = ref(props.estimatedHeight)
const mounted = computed(() => props.pinned || nearby.value)
let intersection: IntersectionObserver | null = null
let resize: ResizeObserver | null = null

onMounted(() => {
  const target = element.value!
  intersection = new IntersectionObserver(([entry]) => {
    if (!entry) return
    // Keep focus and an in-progress text selection intact while scrolling.
    const selection = window.getSelection()
    if (!entry.isIntersecting && (target.contains(document.activeElement)
      || (selection && !selection.isCollapsed && target.contains(selection.anchorNode)))) return
    if (!entry.isIntersecting && mounted.value) height.value = target.getBoundingClientRect().height
    nearby.value = entry.isIntersecting
  }, { root: target.closest('.conversation-list'), rootMargin: '1200px 0px' })
  intersection.observe(target)
  resize = new ResizeObserver(() => {
    if (!mounted.value) return
    const nextHeight = target.getBoundingClientRect().height
    if (nextHeight > 0 && Math.abs(nextHeight - height.value) > 1) {
      height.value = nextHeight
      emit('resized')
    }
  })
  resize.observe(target)
})

watch(mounted, async () => { await nextTick(); emit('resized') })
onBeforeUnmount(() => { intersection?.disconnect(); resize?.disconnect() })
</script>
