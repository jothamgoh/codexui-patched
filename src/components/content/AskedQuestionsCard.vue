<script setup lang="ts">
import { computed } from 'vue'
import { Check, ChevronRight, MessageCircleQuestion } from '@lucide/vue'
import type { AskedQuestionsData } from '../../types/codex'

const props = defineProps<{ data: AskedQuestionsData }>()
const STATUS_LABELS = { answered: 'You answered', unanswered: 'Not answered', waiting: 'Waiting for your answer' } as const
/** The collapsed line: each answer after its short header, or the questions nobody answered. */
const preview = computed(() => props.data.questions
  .map(({ header, question, answer }) => {
    const value = props.data.status === 'answered' ? answer || 'No answer' : question
    return header ? `${header}: ${value}` : value
  })
  .join(' · '))
</script>

<template>
  <details class="asked-questions-card" :data-status="data.status">
    <summary class="asked-questions-summary">
      <Check v-if="data.status === 'answered'" aria-hidden="true" class="asked-questions-icon" />
      <MessageCircleQuestion v-else aria-hidden="true" class="asked-questions-icon" />
      <span class="asked-questions-status">{{ STATUS_LABELS[data.status] }}</span>
      <span class="asked-questions-preview">{{ preview }}</span>
      <ChevronRight aria-hidden="true" class="asked-questions-chevron" />
    </summary>
    <dl class="asked-questions-list">
      <div v-for="(item, index) in data.questions" :key="index">
        <dt class="asked-questions-title">
          <span v-if="item.header" class="asked-questions-chip">{{ item.header }}</span>
          <span class="asked-questions-question">{{ item.question }}</span>
        </dt>
        <dd v-if="data.status === 'answered'" class="asked-questions-answer">{{ item.answer || 'No answer' }}</dd>
      </div>
    </dl>
  </details>
</template>

<style scoped>
@reference "../../style.css";
.asked-questions-card { @apply min-w-0 rounded-xl border border-border bg-background text-foreground; }
.asked-questions-summary { @apply flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-[13px] leading-5 text-muted-foreground; }
.asked-questions-summary::-webkit-details-marker { display: none; }
.asked-questions-summary:hover { @apply bg-muted/50; }
.asked-questions-summary:focus-visible { @apply outline-2 outline-offset-2 outline-ring; }
.asked-questions-icon { @apply size-4 shrink-0; }
.asked-questions-status { @apply shrink-0; }
.asked-questions-preview { @apply min-w-0 flex-1 truncate; }
.asked-questions-card[data-status='answered'] .asked-questions-preview { @apply font-medium text-foreground; }
.asked-questions-card[open] .asked-questions-preview { @apply invisible; }
.asked-questions-chevron { @apply size-4 shrink-0 transition-transform; }
.asked-questions-card[open] .asked-questions-chevron { transform: rotate(90deg); }
.asked-questions-list { @apply m-0 flex flex-col gap-4 border-t border-border px-3 py-3; }
.asked-questions-title { @apply flex flex-col items-start gap-1.5; }
.asked-questions-chip { @apply rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground; }
.asked-questions-question { @apply text-sm leading-6 text-muted-foreground; overflow-wrap: anywhere; }
.asked-questions-answer { @apply m-0 mt-1 text-sm font-medium leading-6; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (pointer: coarse) { .asked-questions-summary { min-height: 44px; } }
</style>
