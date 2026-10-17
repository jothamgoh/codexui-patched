<script setup lang="ts">
import { Check, MessageCircleQuestion } from '@lucide/vue'
import type { AskedQuestionsData } from '../../types/codex'

defineProps<{ data: AskedQuestionsData }>()
const STATUS_LABELS = { answered: 'You answered', unanswered: 'Not answered', waiting: 'Waiting for your answer' } as const
</script>

<template>
  <section class="asked-questions-card" :data-status="data.status">
    <p class="asked-questions-status">
      <Check v-if="data.status === 'answered'" aria-hidden="true" />
      <MessageCircleQuestion v-else aria-hidden="true" />
      <span>{{ STATUS_LABELS[data.status] }}</span>
    </p>
    <dl class="asked-questions-list">
      <div v-for="(item, index) in data.questions" :key="index">
        <dt class="asked-questions-title">
          <span v-if="item.header" class="asked-questions-chip">{{ item.header }}</span>
          <span class="asked-questions-question">{{ item.question }}</span>
        </dt>
        <dd v-if="data.status === 'answered'" class="asked-questions-answer">{{ item.answer || 'No answer' }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
@reference "../../style.css";
.asked-questions-card { @apply min-w-0 rounded-2xl border border-border bg-background p-4 text-foreground; }
.asked-questions-status { @apply mb-3 flex items-center gap-2 text-xs text-muted-foreground; }
.asked-questions-status svg { @apply size-4 shrink-0; }
.asked-questions-list { @apply m-0 flex flex-col gap-4; }
.asked-questions-title { @apply flex flex-col items-start gap-1.5; }
.asked-questions-chip { @apply rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground; }
.asked-questions-question { @apply text-sm leading-6 text-muted-foreground; overflow-wrap: anywhere; }
.asked-questions-answer { @apply m-0 mt-1 text-sm font-medium leading-6; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
