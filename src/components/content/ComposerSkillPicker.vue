<template>
  <div v-if="visible" ref="rootRef" class="skill-picker" :style="positionStyle">
    <div class="skill-picker-header">
      <input
        ref="searchInputRef"
        v-model="query"
        class="skill-picker-search"
        type="text"
        placeholder="Search skills..."
        @keydown.escape.prevent="$emit('close')"
        @keydown.enter.prevent="selectHighlighted"
        @keydown.arrow-down.prevent="moveHighlight(1)"
        @keydown.arrow-up.prevent="moveHighlight(-1)"
      />
    </div>
    <ul v-if="filtered.length > 0" class="skill-picker-list" role="listbox">
      <li v-for="(skill, idx) in filtered" :key="skill.path">
        <button
          class="skill-picker-item"
          :class="{ 'is-highlighted': idx === highlightIndex }"
          type="button"
          @click="$emit('select', skill)"
          @pointerenter="highlightIndex = idx"
        >
          <span class="skill-picker-name">{{ skill.name }}</span>
          <span v-if="skill.description" class="skill-picker-desc">{{ skill.description }}</span>
        </button>
      </li>
    </ul>
    <div v-else class="skill-picker-empty">No skills found</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

export type SkillOption = {
  name: string
  description: string
  path: string
}

const props = defineProps<{
  skills: SkillOption[]
  visible: boolean
  anchorBottom?: number
  anchorLeft?: number
}>()

const emit = defineEmits<{
  select: [skill: SkillOption]
  close: []
}>()

const rootRef = ref<HTMLElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)
const query = ref('')
const highlightIndex = ref(0)

const filtered = computed(() => {
  const q = query.value.toLowerCase().trim()
  if (!q) return props.skills
  return props.skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  )
})

const positionStyle = computed(() => {
  const styles: Record<string, string> = {}
  if (props.anchorBottom != null) styles.bottom = `${props.anchorBottom}px`
  if (props.anchorLeft != null) styles.left = `${props.anchorLeft}px`
  return styles
})

function moveHighlight(delta: number): void {
  if (filtered.value.length === 0) return
  highlightIndex.value = (highlightIndex.value + delta + filtered.value.length) % filtered.value.length
}

function selectHighlighted(): void {
  const skill = filtered.value[highlightIndex.value]
  if (!skill) return
  emit('select', skill)
}

function shouldAutoFocusSearch(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

watch(() => props.visible, (v) => {
  if (v) {
    query.value = ''
    highlightIndex.value = 0
    if (shouldAutoFocusSearch()) {
      nextTick(() => searchInputRef.value?.focus())
    }
  }
})

watch(query, () => {
  highlightIndex.value = 0
})
</script>

<style scoped>
@reference "tailwindcss";

.skill-picker {
  @apply absolute z-40 w-72 max-sm:w-[calc(100vw-2rem)] max-h-64 rounded-xl border shadow-lg flex flex-col overflow-hidden;
  background: var(--surface-elevated);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.skill-picker-header {
  @apply p-2 border-b;
  border-color: var(--border-soft);
}

.skill-picker-search {
  @apply w-full rounded-lg border px-2.5 py-1.5 text-base sm:text-sm outline-none transition;
  background: var(--surface-muted);
  border-color: var(--border-soft);
  color: var(--text-primary);
}

.skill-picker-search::placeholder {
  color: var(--text-muted);
}

.skill-picker-search:focus {
  background: var(--surface-elevated);
  border-color: var(--border-strong);
}

.skill-picker-list {
  @apply m-0 list-none p-1 overflow-y-auto flex-1;
}

.skill-picker-item {
  @apply flex w-full flex-col items-start gap-0.5 rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-left transition;
}

.skill-picker-item:hover {
  background: var(--surface-hover);
}

.skill-picker-item.is-highlighted {
  background: var(--surface-active);
}

.skill-picker-name {
  @apply text-sm font-medium;
  color: var(--text-primary);
}

.skill-picker-desc {
  @apply text-xs line-clamp-1;
  color: var(--text-muted);
}

.skill-picker-empty {
  @apply p-3 text-center text-sm;
  color: var(--text-muted);
}
</style>
