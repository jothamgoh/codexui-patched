<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useAttrs, watch } from 'vue'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import IconTablerMicrophone from '../icons/IconTablerMicrophone.vue'
import { useDictation } from '../../composables/useDictation'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ multiline?: boolean; label?: string; dictationDisabled?: boolean }>()
const model = defineModel<string>({ default: '' })
const emit = defineEmits<{ 'busy-change': [busy: boolean] }>()
const attrs = useAttrs()
const root = ref<HTMLElement | null>(null)
const pendingText = ref('')
const inserted = ref(false)
let hasFocusedField = false
function markFocused() { hasFocusedField = true }
let insertion = { value: '', start: 0, end: 0 }
const field = () => root.value?.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-dictation-target]')
const fieldLabel = computed(() => props.label || String(attrs['aria-label'] || attrs.placeholder || 'text'))
const fieldDisabled = computed(() => [attrs.disabled, attrs.readonly].some(value => value !== undefined && value !== false))

function candidate(text: string) {
  const words = props.multiline ? text : text.replace(/\s*\n\s*/g, ' ')
  if (model.value === insertion.value) {
    return { value: model.value.slice(0, insertion.start) + words + model.value.slice(insertion.end), caret: insertion.start + words.length }
  }
  const value = model.value + (model.value ? props.multiline ? '\n' : ' ' : '') + words
  return { value, caret: value.length }
}

const overflow = computed(() => {
  if (!pendingText.value) return ''
  const limit = Number(attrs.maxlength)
  return Number.isFinite(limit) && limit >= 0 && candidate(pendingText.value).value.length > limit
    ? `This field allows ${limit} characters. Shorten the text below or edit the field, then add it.` : ''
})

function applyTranscript() {
  if (!pendingText.value.trim() || overflow.value) return
  const result = candidate(pendingText.value)
  const restoreFocus = root.value?.contains(document.activeElement)
  model.value = result.value
  pendingText.value = ''
  inserted.value = true
  void nextTick(() => {
    if (!restoreFocus) return
    field()?.focus({ preventScroll: true })
    field()?.setSelectionRange(result.caret, result.caret)
  })
}

const dictation = useDictation({
  onTranscript(text) {
    pendingText.value = text
    applyTranscript()
  },
})
const { state, isStarting, canRetry, isSupported, errorMessage, startRecording, stopRecording, retryTranscription, cancelRecording } = dictation
const busy = computed(() => isStarting.value || state.value !== 'idle' || canRetry.value || !!pendingText.value)
const status = computed(() => errorMessage.value || (isStarting.value ? 'Opening microphone…'
  : state.value === 'recording' ? 'Recording… Stop when you’re ready.'
  : state.value === 'transcribing' ? 'Transcribing…'
  : pendingText.value ? 'Your words are saved below. Review them before adding.'
  : inserted.value ? 'Ready — review your words before saving.' : ''))
watch(busy, value => emit('busy-change', value), { flush: 'sync' })

function start() {
  const target = field()
  if (props.dictationDisabled || target?.disabled || target?.readOnly) return
  insertion = { value: model.value, start: hasFocusedField ? target?.selectionStart ?? model.value.length : model.value.length, end: hasFocusedField ? target?.selectionEnd ?? model.value.length : model.value.length }
  inserted.value = false
  void startRecording()
}

function cancel() {
  cancelRecording()
  pendingText.value = ''
  inserted.value = false
}

onBeforeUnmount(() => emit('busy-change', false))
</script>

<template>
  <div ref="root" class="dictation-field" :data-dictation-busy="busy || undefined">
    <div class="dictation-field-input">
      <component :is="multiline ? Textarea : Input" v-model="model" :aria-label="label" v-bind="$attrs" data-dictation-target @focus="markFocused" />
      <button
        v-if="isSupported"
        type="button"
        class="dictation-field-mic"
        :class="{ 'is-recording': state === 'recording' }"
        :aria-label="state === 'recording' ? `Stop dictating ${fieldLabel}` : `Dictate ${fieldLabel}`"
        :title="state === 'recording' ? 'Stop recording' : 'Use Codex voice input'"
        :aria-pressed="state === 'recording'"
        :disabled="isStarting || state === 'transcribing' || !!pendingText || canRetry || (state === 'idle' && (dictationDisabled || fieldDisabled))"
        @pointerdown.prevent
        @click="state === 'recording' ? stopRecording() : start()"
      >
        <span v-if="isStarting || state === 'transcribing'" class="dictation-field-spinner" aria-hidden="true" />
        <span v-else-if="state === 'recording'" class="dictation-field-stop" aria-hidden="true" />
        <IconTablerMicrophone v-else aria-hidden="true" />
      </button>
    </div>
    <div v-if="status" class="dictation-field-status">
      <span role="status" aria-live="polite" :class="{ 'text-destructive': errorMessage }">{{ status }}</span>
      <button v-if="canRetry" type="button" @click="retryTranscription">Retry transcription</button>
      <button v-if="busy || errorMessage" type="button" :aria-label="`Cancel dictation for ${fieldLabel}`" @click="cancel">Cancel</button>
    </div>
    <div v-if="pendingText" class="dictation-field-review">
      <Textarea v-model="pendingText" :aria-label="`Review dictation for ${fieldLabel}`" rows="3" />
      <p v-if="overflow" role="alert">{{ overflow }}</p>
      <button type="button" :disabled="!!overflow || !pendingText.trim()" @click="applyTranscript">Add text</button>
    </div>
  </div>
</template>

<style scoped>
@reference "../../style.css";
.dictation-field { @apply min-w-0 w-full text-foreground; }
.dictation-field-input { @apply relative; }
.dictation-field-input :deep([data-dictation-target]) { @apply pr-12; }
.dictation-field-mic { @apply absolute right-0.5 top-0.5 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring; }
.dictation-field-mic svg { @apply size-4; }
.dictation-field-mic.is-recording { @apply bg-destructive/10 text-destructive; }
.dictation-field-stop { @apply size-3 rounded-xs bg-current; }
.dictation-field-spinner { @apply size-4 animate-spin rounded-full border-2 border-current border-t-transparent; }
.dictation-field-status { @apply mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground; }
.dictation-field-status button, .dictation-field-review button { @apply text-foreground underline underline-offset-2 disabled:opacity-40; }
.dictation-field-review { @apply mt-2 space-y-2 rounded-md border border-input bg-muted/30 p-2 text-xs; }
.dictation-field-review p { @apply text-destructive; }
@media (pointer: coarse) {
  .dictation-field-input :deep([data-dictation-target]) { min-height: 48px; }
  .dictation-field-mic { @apply size-11; }
  .dictation-field-status button, .dictation-field-review button { min-height: 44px; }
}
</style>
