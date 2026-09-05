<script setup lang="ts">
import { computed, ref } from 'vue'
import { MessageCircleQuestion } from '@lucide/vue'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import DictationField from './DictationField.vue'
import { readRequestQuestions, requestQuestionAnswerValues, type RequestQuestionDraft } from '../../api/requestUserInput'
import type { UiServerRequest, UiServerRequestReply } from '../../types/codex'

const props = defineProps<{ request: UiServerRequest; draft: RequestQuestionDraft }>()
const emit = defineEmits<{ respond: [reply: UiServerRequestReply] }>()
const questions = computed(() => readRequestQuestions(props.request.params))
const questionIndex = computed({ get: () => props.draft.index, set: (value: number) => { props.draft.index = value } })
const answers = computed(() => props.draft.answers)
const dictationBusy = ref(false)
const current = computed(() => questions.value[questionIndex.value])
const answer = computed(() => {
  const id = current.value?.id ?? ''
  let value = answers.value.get(id)
  if (!value) {
    value = { choice: null, text: '' }
    answers.value.set(id, value)
  }
  return answers.value.get(id)!
})
const sending = computed(() => props.request.replyState === 'sending')
const busy = computed(() => sending.value || dictationBusy.value)
const hasAnswer = computed(() => current.value && requestQuestionAnswerValues(current.value, answer.value).length > 0)
const isLastQuestion = computed(() => questionIndex.value === questions.value.length - 1)
const showText = computed(() => current.value && (current.value.options.length === 0 || answer.value.choice === -1))
const inputLabel = computed(() => current.value?.options.length ? 'Your answer' : current.value?.question || 'Your answer')

function recommended(label: string): boolean { return /\s*\(recommended\)$/iu.test(label) }
function optionLabel(label: string): string { return label.replace(/\s*\(recommended\)$/iu, '') }

function continueQuestion(): void {
  if (busy.value || !hasAnswer.value) return
  if (!isLastQuestion.value) { questionIndex.value += 1; return }
  if (questions.value.some((question) => requestQuestionAnswerValues(question, answers.value.get(question.id)).length === 0)) return
  emit('respond', {
    id: props.request.id,
    result: { answers: Object.fromEntries(questions.value.map((question) => [
      question.id, { answers: requestQuestionAnswerValues(question, answers.value.get(question.id)) },
    ])) },
  })
}
</script>

<template>
  <form class="question-card" :aria-busy="sending" @submit.prevent="continueQuestion">
    <div class="question-card-status" role="status">
      <MessageCircleQuestion aria-hidden="true" />
      <span>{{ sending ? 'Sending your answer…' : 'Waiting for your answer' }}</span>
      <span v-if="questions.length > 1" class="question-card-count">{{ questionIndex + 1 }} of {{ questions.length }}</span>
    </div>
    <fieldset v-if="current" :key="current.id" :disabled="sending" class="question-card-fields">
      <legend class="question-card-title">{{ current.question || current.header || 'What would you like to do?' }}</legend>
      <p v-if="current.header && current.question" class="question-card-topic">{{ current.header }}</p>
      <div v-if="current.options.length" class="question-card-options" role="radiogroup" :aria-label="current.question || current.header">
        <label v-for="(option, index) in current.options" :key="index" class="question-card-option" :class="{ 'is-selected': answer.choice === index }">
          <input v-model="answer.choice" type="radio" :name="`question-${request.id}-${current.id}`" :value="index" :disabled="busy" />
          <span class="question-card-option-content">
            <span class="question-card-option-heading">
              <span>{{ optionLabel(option.label) }}</span>
              <span v-if="recommended(option.label)" class="question-card-recommended">Recommended</span>
            </span>
            <span v-if="option.description" class="question-card-option-description">{{ option.description }}</span>
          </span>
        </label>
        <label v-if="current.isOther" class="question-card-option" :class="{ 'is-selected': answer.choice === -1 }">
          <input v-model="answer.choice" type="radio" :name="`question-${request.id}-${current.id}`" :value="-1" :disabled="busy" />
          <span class="question-card-option-heading">Other</span>
        </label>
      </div>
      <div v-if="showText" class="question-card-freeform">
        <Input v-if="current.isSecret" v-model="answer.text" type="password" :aria-label="inputLabel" autocomplete="off" placeholder="Type here" :disabled="sending" />
        <DictationField v-else v-model="answer.text" multiline :label="inputLabel" placeholder="Type here" :rows="3" :disabled="sending" @busy-change="dictationBusy = $event" />
      </div>
    </fieldset>
    <p v-else class="question-card-error" role="alert">This question couldn’t be displayed. Stop the turn and ask Codex to try again.</p>
    <p v-if="request.replyError" class="question-card-error" role="alert">{{ request.replyError }} Your answer is still here; try submitting again.</p>
    <div class="question-card-footer">
      <p>Codex will continue after you answer.</p>
      <div class="question-card-actions">
        <Button v-if="questionIndex > 0" type="button" variant="ghost" size="sm" :disabled="busy" @click="questionIndex -= 1">Back</Button>
        <Button type="submit" size="sm" :disabled="busy || !hasAnswer">{{ sending ? 'Sending…' : isLastQuestion ? 'Submit' : 'Continue' }}</Button>
      </div>
    </div>
  </form>
</template>

<style scoped>
@reference "../../style.css";
.question-card { @apply w-full min-w-0 rounded-2xl border border-border bg-background p-4 text-foreground shadow-sm; }
.question-card-status { @apply mb-3 flex items-center gap-2 text-xs text-muted-foreground; }
.question-card-status svg { @apply size-4 shrink-0; }
.question-card-count { @apply ml-auto tabular-nums; }
.question-card-fields { @apply m-0 min-w-0 border-0 p-0; }
.question-card-title { @apply mb-1 w-full text-base font-medium leading-6; overflow-wrap: anywhere; }
.question-card-topic { @apply mb-3 text-xs text-muted-foreground; }
.question-card-options { @apply mt-3 flex flex-col gap-2; }
.question-card-option { @apply flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-sm hover:bg-muted/50; }
.question-card-option:has(input:focus-visible) { @apply outline-2 outline-offset-2 outline-ring; }
.question-card-option:has(input:disabled) { @apply cursor-default opacity-60; }
.question-card-option.is-selected { @apply border-foreground/50 bg-muted/50; }
.question-card-option input { @apply mt-1 shrink-0 accent-foreground; }
.question-card-option-content { @apply min-w-0; }
.question-card-option-heading { @apply flex flex-wrap items-center gap-x-2 gap-y-1 font-medium; overflow-wrap: anywhere; }
.question-card-recommended { @apply rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground; }
.question-card-option-description { @apply mt-1 block text-xs leading-5 text-muted-foreground; overflow-wrap: anywhere; }
.question-card-freeform { @apply mt-3; }
.question-card-error { @apply mt-3 text-sm text-destructive; }
.question-card-footer { @apply mt-4 flex flex-wrap items-center justify-between gap-3; }
.question-card-footer p { @apply text-xs text-muted-foreground; }
.question-card-actions { @apply ml-auto flex gap-2; }
@media (pointer: coarse) { .question-card-actions :deep(button) { min-height: 44px; } }
</style>
