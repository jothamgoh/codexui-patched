<template>
  <div class="board-daily-view" :data-testid="view === 'needs-you' ? 'board-inbox' : 'board-runs'">
    <template v-if="view === 'needs-you'">
      <header class="daily-heading"><h3>Needs you</h3><p>Answer decisions and review work that needs a next step.</p></header>
      <div v-if="!questions.length && !attentionCards.length" class="daily-empty"><Check aria-hidden="true" /><strong>You’re all caught up</strong><p>Questions, blockers, and work ready for review will appear here.</p></div>
      <section v-if="questions.length" class="daily-section" aria-label="Open questions">
        <h4>Decisions <span>{{ questions.length }}</span></h4>
        <article v-for="question in questions" :key="question.id" class="daily-row question-row" :data-question-id="question.id">
          <div class="daily-row-content">
            <div class="daily-kicker"><CircleHelp aria-hidden="true" /><span>Needs an answer</span><time :datetime="question.createdAtIso">{{ formatTime(question.createdAtIso) }}</time></div>
            <h5>{{ question.prompt }}</h5>
            <p class="daily-owner">{{ featureFor(question.cardId)?.title || 'Feature unavailable' }} · {{ questionAgent(question) }}</p>
            <p v-if="taskFor(question.cardId)" class="daily-context">Task: {{ taskFor(question.cardId)?.title }}</p>
            <p v-else-if="featureFor(question.cardId)?.description" class="daily-context">{{ featureFor(question.cardId)?.description }}</p>
          </div>
          <Button type="button" :disabled="!featureFor(question.cardId)" @click="openQuestion(question)">Review & answer</Button>
        </article>
      </section>
      <section v-if="attentionCards.length" class="daily-section" aria-label="Work needing attention">
        <h4>Review & unblock <span>{{ attentionCards.length }}</span></h4>
        <article v-for="card in attentionCards" :key="card.id" class="daily-row" :data-attention-feature-id="card.id">
          <div class="daily-row-content">
            <div class="daily-kicker"><span class="daily-status" :data-status="card.status">{{ card.status === 'review' ? 'Ready for review' : card.status === 'blocked' ? 'Blocked' : 'Needs input' }}</span><span>{{ agentName(card.assignedAgentId) }}</span></div>
            <h5>{{ card.title }}</h5>
            <p class="daily-reason">{{ card.progressNote || card.summary || (card.status === 'review' ? 'Review the result and choose the next step.' : 'Open the feature to review its latest run and decide how to continue.') }}</p>
          </div>
          <Button type="button" variant="outline" @click="$emit('open-feature', card)">Open feature</Button>
        </article>
      </section>
    </template>
    <template v-else>
      <header class="daily-heading"><h3>Runs</h3><p>Recent planning and work attempts, with their saved outcomes and chats.</p></header>
      <div v-if="!boardRuns.length" class="daily-empty"><History aria-hidden="true" /><strong>No runs yet</strong><p>Plan features or start a feature to see what happened here.</p></div>
      <ol v-else class="daily-run-list" aria-label="Recent board runs">
        <li v-for="run in visibleRuns" :key="run.id" class="daily-row" :data-board-run-id="run.id">
          <div class="daily-row-content">
            <div class="daily-kicker"><span class="daily-status" :data-status="run.status">{{ runStatus(run) }}</span><span>{{ runKind(run) }}</span><time :datetime="run.startedAtIso">{{ formatTime(run.startedAtIso) }}</time></div>
            <h5>{{ featureFor(run.cardId)?.title || (run.kind === 'board_plan' ? 'Project feature plan' : 'Feature unavailable') }}</h5>
            <p class="daily-owner">{{ agentName(run.agentId) }} <span aria-hidden="true">·</span> {{ duration(run) }}</p>
            <p class="daily-settings">{{ requestedSettings(run) }}</p>
            <p v-if="run.error || run.summary" class="daily-reason">{{ run.error || run.summary }}</p>
          </div>
          <div class="daily-row-actions">
            <Button v-if="featureFor(run.cardId)" type="button" variant="outline" @click="openRunFeature(run)">Open feature</Button>
            <Button v-if="run.threadId" type="button" variant="ghost" @click="$emit('open-thread', run.threadId)"><MessageSquare aria-hidden="true" /> Open chat</Button>
          </div>
        </li>
      </ol>
      <Button v-if="visibleRuns.length < boardRuns.length" type="button" variant="outline" class="daily-load-more" @click="runLimit += 50">Show older runs</Button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDocumentVisibility, useNow } from '@vueuse/core'
import { Check, CircleHelp, History, MessageSquare } from '@lucide/vue'
import Button from '../ui/button/Button.vue'
import type { ProjectBoardCard, ProjectBoardQuestion, ProjectBoardRun, ProjectBoardSnapshot } from '../../types/projectBoards'

const props = defineProps<{
  view: 'needs-you' | 'runs'
  boardId: string
  snapshot: ProjectBoardSnapshot
  questions: ProjectBoardQuestion[]
  attentionCards: ProjectBoardCard[]
}>()
const emit = defineEmits<{
  'open-feature': [card: ProjectBoardCard, questionId?: string]
  'open-thread': [threadId: string]
}>()
const runLimit = ref(50)
const boardRuns = computed(() => props.snapshot.runs.filter((run) => run.boardId === props.boardId).sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso)))
const visibleRuns = computed(() => boardRuns.value.slice(0, runLimit.value))
watch(() => props.boardId, () => { runLimit.value = 50 })
const { now, pause, resume } = useNow({ controls: true, interval: 60_000 })
const visibility = useDocumentVisibility()
watch([visibility, () => props.view, () => visibleRuns.value.some((run) => run.status === 'running')], ([visible, view, hasRunning]) => {
  if (visible === 'visible' && view === 'runs' && hasRunning) resume()
  else pause()
}, { immediate: true })

function featureFor(cardId: string): ProjectBoardCard | undefined {
  const card = props.snapshot.cards.find((entry) => entry.id === cardId && entry.boardId === props.boardId)
  return card?.parentCardId ? props.snapshot.cards.find((entry) => entry.id === card.parentCardId && entry.boardId === props.boardId) : card
}
function taskFor(cardId: string): ProjectBoardCard | undefined { return props.snapshot.cards.find((card) => card.id === cardId && card.boardId === props.boardId && card.parentCardId) }
function agentName(id: string): string { return props.snapshot.agents.find((agent) => agent.id === id)?.name || 'Agent unavailable' }
function questionAgent(question: ProjectBoardQuestion): string {
  const card = props.snapshot.cards.find((entry) => entry.id === question.cardId)
  return agentName(card?.assignedAgentId || props.snapshot.runs.find((run) => run.id === question.runId)?.agentId || '')
}
function openQuestion(question: ProjectBoardQuestion): void {
  const feature = featureFor(question.cardId)
  if (feature) emit('open-feature', feature, question.id)
}
function openRunFeature(run: ProjectBoardRun): void { const feature = featureFor(run.cardId); if (feature) emit('open-feature', feature) }
function runKind(run: ProjectBoardRun): string { return run.kind === 'board_plan' ? 'Project planning' : run.kind === 'plan' ? 'Feature planning' : 'Feature work' }
function runStatus(run: ProjectBoardRun): string { return ({ queued: 'Queued', running: 'Working', succeeded: 'Completed', failed: 'Failed', interrupted: 'Interrupted' })[run.status] }
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
function duration(run: ProjectBoardRun): string {
  const started = Date.parse(run.startedAtIso)
  const ended = run.finishedAtIso ? Date.parse(run.finishedAtIso) : run.status === 'running' ? now.value.getTime() : NaN
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return run.status === 'queued' ? 'Not started' : 'Duration not recorded'
  const seconds = Math.max(0, Math.floor((ended - started) / 1_000))
  const elapsed = seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m`
  return `${elapsed}${run.status === 'running' ? ' so far' : ''}`
}
function requestedSettings(run: ProjectBoardRun): string {
  if (run.requestedModel === undefined && !run.requestedReasoningEffort) return 'Model settings were not recorded for this older run.'
  return `Requested: ${run.requestedModel || 'App default model'}${run.requestedReasoningEffort ? ` · ${run.requestedReasoningEffort} reasoning` : ''}`
}
</script>

<style scoped>
@reference "tailwindcss";
.board-daily-view { @apply min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-6; scrollbar-width: thin; }
.daily-heading { @apply mb-5; }
.daily-heading h3 { @apply m-0 text-lg font-semibold tracking-tight; }
.daily-heading p { @apply mt-1 mb-0 text-sm leading-5; color: var(--text-secondary); }
.daily-section { @apply mb-6; }
.daily-section h4 { @apply mb-2 flex items-center gap-2 text-xs font-semibold; color: var(--text-secondary); }
.daily-section h4 span { @apply rounded-full px-1.5 py-0.5 text-[10px]; background: var(--surface-muted); }
.daily-row { @apply mb-2 flex min-w-0 items-start justify-between gap-4 rounded-xl border p-4; background: var(--surface-elevated); border-color: var(--border-soft); }
.question-row { border-left: 3px solid color-mix(in srgb, var(--text-muted) 35%, #d97706); }
.daily-row-content { @apply min-w-0 flex-1; }
.daily-row h5 { @apply mt-2 mb-0 line-clamp-3 text-sm font-semibold leading-5; overflow-wrap: anywhere; }
.daily-kicker { @apply flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]; color: var(--text-muted); }
.daily-kicker svg { @apply h-3.5 w-3.5; }
.daily-status { @apply rounded-full px-2 py-0.5 font-medium; background: var(--surface-muted); color: var(--text-secondary); }
.daily-status[data-status='running'], .daily-status[data-status='queued'] { color: var(--accent-blue); }
.daily-status[data-status='succeeded'] { color: color-mix(in srgb, var(--text-primary) 30%, #16a34a); }
.daily-status[data-status='failed'], .daily-status[data-status='interrupted'], .daily-status[data-status='blocked'] { color: color-mix(in srgb, var(--text-primary) 30%, #dc2626); }
.daily-status[data-status='review'] { color: color-mix(in srgb, var(--text-primary) 30%, #8b5cf6); }
.daily-owner, .daily-settings { @apply mt-1.5 mb-0 text-xs leading-5; color: var(--text-secondary); overflow-wrap: anywhere; }
.daily-settings { color: var(--text-muted); }
.daily-context, .daily-reason { @apply mt-2 mb-0 line-clamp-3 whitespace-pre-wrap text-xs leading-5; color: var(--text-secondary); overflow-wrap: anywhere; }
.daily-row-actions { @apply flex shrink-0 flex-wrap items-center gap-1; }
.daily-row :deep(button) { @apply shrink-0; }
.daily-row-actions svg { @apply h-3.5 w-3.5; }
.daily-run-list { @apply m-0 list-none p-0; }
.daily-load-more { @apply mx-auto mt-3 flex; }
.daily-empty { @apply flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-5 py-12 text-center; border-color: var(--border-soft); }
.daily-empty svg { @apply mb-1 h-7 w-7; color: var(--text-muted); }
.daily-empty strong { @apply text-sm font-medium; }
.daily-empty p { @apply m-0 max-w-sm text-sm leading-5; color: var(--text-secondary); }
@media (max-width: 700px) {
  .board-daily-view { @apply flex-none overflow-visible pb-5; }
  .daily-row { @apply flex-col gap-3 p-3; }
  .daily-row > :deep(button), .daily-row-actions { @apply w-full; }
  .daily-row-actions :deep(button) { @apply flex-1; }
  .daily-row :deep(button), .daily-load-more { min-height: 44px; }
}
</style>
