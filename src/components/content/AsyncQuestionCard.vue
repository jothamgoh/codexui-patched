<script setup lang="ts">
import { computed } from 'vue'
import { Check, MessageCircleQuestion } from '@lucide/vue'
import { Button } from '../ui/button'
import DictationField from './DictationField.vue'
import { encodeAsyncQuestionReply, type AsyncQuestion, type AsyncQuestionDraft } from '../../api/requestUserInput'

const props = defineProps<{
  question: AsyncQuestion
  draft: AsyncQuestionDraft
  answer?: string
  threadId: string
  submit?: (threadId: string, text: string) => Promise<void>
}>()
const sentAnswer = computed(() => props.answer ?? props.draft.sent)
const answerText = computed(() => props.draft.choice === -1 || !props.question.options.length
  ? props.draft.text.trim() : props.question.options[props.draft.choice] ?? '')
const busy = computed(() => props.draft.sending || props.draft.dictating)

async function send(): Promise<void> {
  if (!props.submit || busy.value || !answerText.value || sentAnswer.value !== undefined) return
  const answer = answerText.value
  props.draft.sending = true
  props.draft.error = ''
  try {
    await props.submit(props.threadId, encodeAsyncQuestionReply(props.question, answer))
    props.draft.sent = answer
  } catch (error) {
    props.draft.error = error instanceof Error ? error.message : 'Could not send your answer. Try again.'
  } finally { props.draft.sending = false }
}
</script>

<template>
  <form class="async-question-card" :aria-busy="draft.sending" @submit.prevent="send">
    <div class="async-question-status" role="status">
      <Check v-if="sentAnswer !== undefined" aria-hidden="true" /><MessageCircleQuestion v-else aria-hidden="true" />
      <span>{{ sentAnswer !== undefined ? 'Answer sent' : draft.sending ? 'Sending your answer…' : 'Question for you' }}</span>
    </div>
    <h3 class="async-question-title">{{ question.title }}</h3>
    <p v-if="sentAnswer !== undefined" class="async-question-answer">{{ sentAnswer }}</p>
    <template v-else>
      <div v-if="question.options.length" class="async-question-options" role="radiogroup" :aria-label="question.title">
        <label v-for="(option, index) in question.options" :key="index" class="async-question-option" :class="{ selected: draft.choice === index }">
          <input v-model="draft.choice" type="radio" :name="question.id" :value="index" :disabled="busy" />
          <span>{{ option }}</span>
        </label>
        <label class="async-question-option" :class="{ selected: draft.choice === -1 }">
          <input v-model="draft.choice" type="radio" :name="question.id" :value="-1" :disabled="busy" />
          <span>Write an answer</span>
        </label>
      </div>
      <DictationField v-if="draft.choice === -1 || !question.options.length" v-model="draft.text" label="Your answer" multiline :rows="3" :disabled="draft.sending" placeholder="Type or dictate your answer" @busy-change="draft.dictating = $event" />
      <p v-if="draft.error" class="async-question-error" role="alert">{{ draft.error }} Your answer is still here.</p>
      <div class="async-question-footer">
        <span>Codex can keep working while you decide.</span>
        <Button type="submit" :disabled="!submit || busy || !answerText">{{ draft.sending ? 'Sending…' : 'Send answer' }}</Button>
      </div>
    </template>
  </form>
</template>

<style scoped>
@reference "../../style.css";
.async-question-card { @apply my-3 min-w-0 rounded-2xl border border-border bg-background p-4 text-foreground; }
.async-question-status { @apply mb-3 flex items-center gap-2 text-xs text-muted-foreground; }
.async-question-status svg { @apply size-4 shrink-0; }
.async-question-title { @apply mb-3 text-base font-medium leading-6; overflow-wrap: anywhere; }
.async-question-options { @apply mb-3 flex flex-col gap-2; }
.async-question-option { @apply flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-sm hover:bg-muted/50; }
.async-question-option.selected { @apply border-foreground/50 bg-muted/50; }
.async-question-option:has(input:focus-visible) { @apply outline-2 outline-offset-2 outline-ring; }
.async-question-option input { @apply mt-1 shrink-0 accent-foreground; }
.async-question-option span, .async-question-answer { white-space: pre-wrap; overflow-wrap: anywhere; }
.async-question-answer { @apply text-sm; }
.async-question-error { @apply mt-3 text-sm text-destructive; }
.async-question-footer { @apply mt-4 flex flex-wrap items-center justify-between gap-3; }
.async-question-footer span { @apply text-xs text-muted-foreground; }
.async-question-footer button { @apply ml-auto min-h-11; }
</style>
