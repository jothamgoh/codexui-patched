<template>
  <Popover v-model:open="isOpen">
    <PopoverTrigger as-child>
      <Button
        class="new-thread-folder-trigger"
        variant="ghost"
        type="button"
        :disabled="disabled"
        aria-label="Choose workspace folder"
      >
        <span class="new-thread-folder-trigger-label">{{ selectedLabel }}</span>
        <IconTablerChevronDown class="new-thread-folder-trigger-chevron" />
      </Button>
    </PopoverTrigger>

    <PopoverContent
      class="new-thread-folder-popover"
      align="center"
      side="bottom"
      :side-offset="10"
      :collision-padding="12"
      @open-auto-focus="onOpenAutoFocus"
    >
      <div v-if="!isAdding" class="new-thread-folder-panel">
        <div class="new-thread-folder-heading">
          <span class="new-thread-folder-title">Workspace</span>
          <span class="new-thread-folder-subtitle">Choose where the new chat can edit files</span>
        </div>

        <Input
          ref="searchInputRef"
          v-model="searchQuery"
          class="new-thread-folder-search"
          type="search"
          inputmode="search"
          enterkeyhint="search"
          autocomplete="off"
          placeholder="Search projects"
          aria-label="Search projects"
          @keydown.esc.prevent="closeOrClearSearch"
        />

        <div class="new-thread-folder-options" role="listbox" aria-label="Workspace folders">
          <Button
            v-for="option in filteredOptions"
            :key="option.value"
            class="new-thread-folder-option"
            :class="{ 'is-selected': option.value === modelValue }"
            variant="ghost"
            type="button"
            role="option"
            :aria-selected="option.value === modelValue"
            @click="selectOption(option.value)"
          >
            <IconTablerFolder class="new-thread-folder-option-icon" />
            <span class="new-thread-folder-option-copy">
              <span class="new-thread-folder-option-label">{{ option.label }}</span>
              <span class="new-thread-folder-option-path">{{ option.value }}</span>
            </span>
            <Check v-if="option.value === modelValue" class="new-thread-folder-option-check" />
          </Button>

          <p v-if="filteredOptions.length === 0" class="new-thread-folder-empty">No matching projects</p>
        </div>

        <Button class="new-thread-folder-add" variant="ghost" type="button" @click="startAdding">
          <Plus class="new-thread-folder-add-icon" />
          <span>Add new project</span>
        </Button>
      </div>

      <form v-else class="new-thread-folder-add-panel" @submit.prevent="confirmAdd">
        <div class="new-thread-folder-heading">
          <span class="new-thread-folder-title">Add a project</span>
          <span class="new-thread-folder-subtitle">Enter a project name or an absolute folder path</span>
        </div>
        <Input
          ref="addInputRef"
          v-model="addDraft"
          class="new-thread-folder-add-input"
          type="text"
          autocomplete="off"
          placeholder="Project name or absolute path"
          aria-label="Project name or absolute path"
          @keydown.esc.prevent="cancelAdd"
        />
        <div class="new-thread-folder-add-actions">
          <Button variant="outline" type="button" @click="cancelAdd">Back</Button>
          <Button type="submit" :disabled="!addDraft.trim()">Open</Button>
        </div>
      </form>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { Check, Plus } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerFolder from '../icons/IconTablerFolder.vue'

type FolderOption = {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: FolderOption[]
  placeholder?: string
  defaultAddValue?: string
  disabled?: boolean
}>(), {
  placeholder: 'Choose folder',
  defaultAddValue: '',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  add: [value: string]
}>()

const isOpen = ref(false)
const isAdding = ref(false)
const searchQuery = ref('')
const addDraft = ref('')
const searchInputRef = ref<InstanceType<typeof Input> | null>(null)
const addInputRef = ref<InstanceType<typeof Input> | null>(null)

const selectedLabel = computed(() =>
  props.options.find((option) => option.value === props.modelValue)?.label
  ?? props.placeholder,
)

const filteredOptions = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  if (!query) return props.options
  return props.options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query)
    || option.value.toLocaleLowerCase().includes(query),
  )
})

function selectOption(value: string): void {
  emit('update:modelValue', value)
  isOpen.value = false
}

function closeOrClearSearch(): void {
  if (searchQuery.value) {
    searchQuery.value = ''
    return
  }
  isOpen.value = false
}

function startAdding(): void {
  isAdding.value = true
  addDraft.value = props.defaultAddValue.trim()
  void nextTick(() => addInputRef.value?.$el?.focus())
}

function confirmAdd(): void {
  const value = addDraft.value.trim()
  if (!value) return
  emit('add', value)
  isOpen.value = false
}

function cancelAdd(): void {
  isAdding.value = false
  addDraft.value = ''
  void nextTick(() => searchInputRef.value?.$el?.focus())
}

function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  if (typeof window === 'undefined' || !window.matchMedia('(pointer: fine)').matches) return
  void nextTick(() => searchInputRef.value?.$el?.focus())
}

watch(isOpen, (open) => {
  if (open) return
  isAdding.value = false
  searchQuery.value = ''
  addDraft.value = ''
})
</script>

<style scoped>
@reference "tailwindcss";

.new-thread-folder-trigger {
  @apply h-auto max-w-[min(88vw,40rem)] gap-1.5 rounded-xl px-2 py-1 text-2xl font-normal leading-[1.05] sm:text-[2.5rem];
  color: var(--text-tertiary) !important;
}

.new-thread-folder-trigger:hover,
.new-thread-folder-trigger[aria-expanded='true'] {
  background: var(--surface-hover) !important;
  color: var(--text-primary) !important;
}

.new-thread-folder-trigger-label {
  @apply min-w-0 truncate;
}

.new-thread-folder-trigger-chevron {
  @apply mt-0 h-4 w-4 shrink-0 sm:h-5 sm:w-5;
}

:global(.new-thread-folder-popover) {
  width: min(24rem, calc(100vw - 1.5rem));
  max-height: min(32rem, calc(var(--reka-popover-content-available-height) - 0.5rem));
  overflow: hidden;
  padding: 0.5rem;
  border-color: var(--border-strong);
  background: var(--surface-elevated);
  color: var(--text-primary);
  box-shadow: 0 18px 55px color-mix(in srgb, var(--overlay) 70%, transparent);
}

.new-thread-folder-panel,
.new-thread-folder-add-panel {
  @apply flex min-h-0 flex-col gap-2;
}

.new-thread-folder-heading {
  @apply flex flex-col gap-0.5 px-1 py-0.5;
}

.new-thread-folder-title {
  @apply text-sm font-semibold;
  color: var(--text-primary);
}

.new-thread-folder-subtitle {
  @apply text-xs leading-4;
  color: var(--text-tertiary);
}

.new-thread-folder-search,
.new-thread-folder-add-input {
  border-color: var(--border-strong) !important;
  background: var(--surface-muted) !important;
  color: var(--text-primary) !important;
}

.new-thread-folder-options {
  @apply -mx-0.5 flex max-h-[min(18rem,42dvh)] min-h-0 flex-col gap-0.5 overflow-y-auto px-0.5;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.new-thread-folder-option {
  @apply h-auto w-full justify-start gap-2.5 whitespace-normal rounded-lg px-2 py-2 text-left;
  color: var(--text-primary) !important;
}

.new-thread-folder-option:hover,
.new-thread-folder-option:focus-visible,
.new-thread-folder-option.is-selected {
  background: var(--surface-hover) !important;
}

.new-thread-folder-option-icon,
.new-thread-folder-option-check,
.new-thread-folder-add-icon {
  @apply h-4 w-4 shrink-0;
  color: var(--text-tertiary);
}

.new-thread-folder-option-copy {
  @apply flex min-w-0 flex-1 flex-col gap-0.5;
}

.new-thread-folder-option-label {
  @apply truncate text-sm font-medium;
  color: var(--text-primary);
}

.new-thread-folder-option-path {
  @apply truncate text-xs font-normal;
  color: var(--text-tertiary);
}

.new-thread-folder-empty {
  @apply m-0 px-2 py-5 text-center text-sm;
  color: var(--text-tertiary);
}

.new-thread-folder-add {
  @apply h-9 w-full justify-start gap-2 rounded-lg px-2;
  border-top: 1px solid var(--border-soft);
  color: var(--text-primary) !important;
}

.new-thread-folder-add:hover {
  background: var(--surface-hover) !important;
}

.new-thread-folder-add-actions {
  @apply flex items-center justify-end gap-2 pt-1;
}

@media (max-width: 639px) {
  :global(.new-thread-folder-popover) {
    max-height: min(28rem, calc(var(--reka-popover-content-available-height) - 0.25rem));
  }

  .new-thread-folder-search,
  .new-thread-folder-add-input {
    font-size: 16px !important;
  }
}
</style>
