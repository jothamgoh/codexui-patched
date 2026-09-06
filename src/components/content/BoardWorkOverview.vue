<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowUpRight, FolderKanban, Plus } from '@lucide/vue'
import Button from '../ui/button/Button.vue'
import type { ProjectBoardSnapshot } from '../../types/projectBoards'
import type { UiServerRequest } from '../../types/codex'
import type { ProjectBoardActivity } from '../../utils/projectBoardActivity'

const props = defineProps<{
  snapshot: ProjectBoardSnapshot
  activity: ProjectBoardActivity[]
  pendingRequests: UiServerRequest[]
  projects: Array<{ path: string; name: string }>
  isLoading: boolean
  error: string
}>()
const emit = defineEmits<{
  'select-board': [boardId: string]
  'select-feature': [featureId: string, boardId: string, questionId?: string]
  'select-thread': [threadId: string]
  'select-project': [projectPath: string]
  'plan-project': []
}>()
const selectedProject = ref('')
const projectPath = computed(() => selectedProject.value || props.projects[0]?.path || '')
const rows = computed(() => props.activity.map((activity) => {
  const card = props.snapshot.cards.find((entry) => entry.id === activity.featureId)
  const request = props.pendingRequests.find((entry) => entry.threadId === activity.threadId)
  const question = props.snapshot.questions.find((entry) => activity.featureId && entry.status === 'open' && entry.boardId === activity.boardId
    && (entry.cardId === activity.featureId || props.snapshot.cards.some((task) => task.id === entry.cardId && task.parentCardId === activity.featureId)))
  const runs = props.snapshot.runs.filter((run) => activity.featureId ? run.cardId === activity.featureId : run.boardId === activity.boardId && run.kind === 'board_plan')
  const run = runs.find((entry) => entry.status === 'running' || entry.status === 'queued')
    || runs.find((entry) => entry.id === card?.lastRunId) || runs[0]
  const agentName = props.snapshot.agents.find((agent) => agent.id === run?.agentId)?.name || ''
  const status = request || question ? 'needs_input' : activity.status
  const label = request ? request.method.includes('requestApproval') ? 'Approval needed' : 'Answer needed'
    : question || status === 'needs_input' ? 'Answer needed'
    : status === 'running' ? run?.kind === 'execute' ? 'Working' : 'Planning'
    : status === 'review' ? activity.featureId ? 'Needs review' : 'Plan ready'
    : status === 'blocked' ? 'Blocked' : status === 'paused' ? 'Paused' : status === 'done' ? 'Done' : 'Ready'
  return { ...activity, status, label, agentName, questionId: question?.id || '',
    summary: question?.prompt || (request ? 'Open the Lead chat to answer and continue.' : status === 'done' ? card?.summary || activity.summary : activity.summary),
    actionLabel: question ? 'Answer question' : request ? 'Open request' : status === 'running' ? 'Open Lead chat' : status === 'done' ? 'Review result' : 'Review work',
    openChat: Boolean(activity.threadId && !question && (request || status === 'running' || status === 'done')),
  }
}).sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso)))
const needsYou = computed(() => rows.value.filter((row) => ['needs_input', 'review', 'blocked', 'paused'].includes(row.status)))
const currentLeads = computed(() => rows.value.filter((row) => row.status === 'running'))
const results = computed(() => rows.value.filter((row) => row.status === 'done'))
const sections = computed(() => [
  { id: 'needs-you', title: 'Needs you', items: needsYou.value },
  { id: 'working', title: 'Current Leads', items: currentLeads.value },
  { id: 'results', title: 'Recent results', items: results.value.slice(0, 6) },
].filter((section) => section.items.length))
const boards = computed(() => props.snapshot.boards.map((board) => {
  const features = rows.value.filter((row) => row.boardId === board.id && props.snapshot.cards.some((card) => card.id === row.featureId && card.type === 'feature'))
  const done = features.filter((row) => row.status === 'done').length
  const working = currentLeads.value.filter((row) => row.boardId === board.id).length
  const attention = needsYou.value.filter((row) => row.boardId === board.id).length
  return { ...board, total: features.length, done, working, attention }
}).sort((a, b) => Number(Boolean(b.attention || b.working)) - Number(Boolean(a.attention || a.working)) || b.updatedAtIso.localeCompare(a.updatedAtIso)))
function openRow(row: (typeof rows.value)[number]): void {
  if (row.openChat) emit('select-thread', row.threadId)
  else if (row.featureId) emit('select-feature', row.featureId, row.boardId, row.questionId)
  else emit('select-board', row.boardId)
}
</script>

<template>
  <div class="work-overview" data-testid="board-work-overview">
    <header class="overview-heading">
      <div><h2>All work</h2><p>Requests, Leads and results across your boards.</p></div>
      <Button type="button" variant="outline" @click="$emit('plan-project')"><Plus aria-hidden="true" /> New plan</Button>
    </header>
    <p v-if="error" class="overview-error" role="alert">{{ error }}</p>
    <p v-if="isLoading && !boards.length" role="status">Loading your boards…</p>
    <template v-else>
      <div v-if="boards.length" class="overview-counts" aria-label="Work summary">
        <span><strong>{{ needsYou.length }}</strong> need you</span>
        <span><strong>{{ currentLeads.length }}</strong> working</span>
        <span><strong>{{ results.length }}</strong> done</span>
      </div>
      <section v-for="section in sections" :key="section.id" class="overview-section" :aria-label="section.title" :data-overview-section="section.id">
        <h3>{{ section.title }}<span>{{ section.items.length }}</span></h3>
        <div class="overview-rows">
          <article v-for="row in section.items" :key="`${row.boardId}:${row.featureId}`" class="work-row">
            <div class="work-row-copy">
              <div class="work-row-meta"><span class="work-status" :data-status="row.status">{{ row.label }}</span><button type="button" @click="$emit('select-board', row.boardId)">{{ row.boardName }}</button></div>
              <h4>{{ row.title }}</h4>
              <p v-if="row.summary" class="work-row-summary">{{ row.summary }}</p>
              <p v-if="row.agentName" class="work-agent">{{ row.agentName }}<template v-if="row.agentName.toLowerCase() !== 'lead'"> · Lead</template></p>
            </div>
            <Button type="button" variant="outline" @click="openRow(row)">{{ row.actionLabel }}<ArrowUpRight aria-hidden="true" /></Button>
          </article>
        </div>
      </section>
      <section class="overview-section" aria-label="Your boards">
        <h3>Your boards<span>{{ boards.length }}</span></h3>
        <div v-if="boards.length" class="overview-boards">
          <article v-for="board in boards" :key="board.id" class="overview-board">
            <p class="board-project"><FolderKanban aria-hidden="true" />{{ board.projectName }}</p>
            <h4>{{ board.name }}</h4>
            <p>{{ board.total ? `${board.done} of ${board.total} features done` : 'Ready for your first feature' }}<span v-if="board.attention"> · {{ board.attention }} need you</span><span v-else-if="board.working"> · {{ board.working }} working</span></p>
            <progress v-if="board.total" :value="board.done" :max="board.total" :aria-label="`${board.name} feature progress`" />
            <Button type="button" variant="outline" @click="$emit('select-board', board.id)">Open board<ArrowUpRight aria-hidden="true" /></Button>
          </article>
        </div>
        <p v-else class="overview-empty">Use a board when you want to review a larger plan and track its features. Start in a project or create a new plan.</p>
        <form v-if="projects.length" class="overview-project-picker" @submit.prevent="projectPath && $emit('select-project', projectPath)">
          <label><span>Open a project board</span><select :value="projectPath" aria-label="Project for board" @change="selectedProject = ($event.target as HTMLSelectElement).value"><option v-for="project in projects" :key="project.path" :value="project.path">{{ project.name }}</option></select></label>
          <Button type="submit" variant="outline" :disabled="!projectPath">Open project</Button>
        </form>
      </section>
    </template>
  </div>
</template>

<style scoped>
@reference "../../style.css";
.work-overview { @apply min-h-0 flex-1 overflow-y-auto p-5 text-foreground; }
.overview-heading, .overview-section { @apply mx-auto w-full max-w-5xl; }
.overview-heading { @apply flex items-start justify-between gap-4; }
h2 { @apply m-0 text-xl font-semibold tracking-tight; }
.overview-heading p, .overview-empty { @apply mt-2 text-sm leading-6 text-muted-foreground; }
.overview-heading button { @apply shrink-0; }
.overview-counts { @apply mx-auto my-5 flex max-w-5xl flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground; }
.overview-counts strong { @apply mr-1 text-foreground; }
.overview-section { @apply mt-6; }
h3 { @apply mb-3 flex items-center gap-2 text-sm font-semibold; }
h3 > span { @apply rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground; }
.overview-rows { @apply overflow-hidden rounded-xl border border-border; }
.work-row { @apply flex items-center justify-between gap-5 border-b border-border p-4 last:border-0; }
.work-row-copy { @apply min-w-0 flex-1; }
.work-row-meta { @apply mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground; }
.work-row-meta button { @apply max-w-full truncate text-left underline-offset-2 hover:underline; }
.work-status { @apply font-medium; }
.work-status[data-status="needs_input"], .work-status[data-status="blocked"] { color: var(--color-amber-500, #d97706); }
.work-status[data-status="running"] { color: var(--color-blue-500, #3b82f6); }
.work-status[data-status="done"] { color: var(--color-green-500, #22c55e); }
h4 { @apply m-0 text-sm font-medium leading-6 break-words; overflow-wrap: anywhere; }
.work-row-summary { @apply mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground; overflow-wrap: anywhere; }
.work-agent { @apply mt-2 text-xs text-muted-foreground; }
.work-row > button { @apply shrink-0; }
.overview-boards { @apply grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3; }
.overview-board { @apply flex min-w-0 flex-col gap-2 rounded-xl border border-border p-4; }
.board-project { @apply m-0 flex items-center gap-2 text-xs text-muted-foreground; overflow-wrap: anywhere; }
.overview-board > p:not(.board-project) { @apply text-xs leading-5 text-muted-foreground; }
progress { @apply h-1.5 w-full overflow-hidden rounded-full; accent-color: var(--foreground); }
.overview-board > button { @apply mt-auto w-full; }
.overview-project-picker { @apply mt-5 flex items-end gap-3; }
.overview-project-picker label { @apply flex min-w-0 max-w-sm flex-1 flex-col gap-2 text-xs text-muted-foreground; }
select { @apply h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground; }
.overview-error { @apply mx-auto mt-4 max-w-5xl text-sm text-destructive; }
svg { @apply size-4 shrink-0; }
@media (max-width: 700px) {
  .work-overview { @apply p-3; padding-bottom: max(1rem, env(safe-area-inset-bottom)); }
  .overview-heading { @apply gap-2; }
  .overview-heading p { @apply text-xs; }
  .overview-counts { @apply gap-x-4 text-xs; }
  .work-row { @apply items-stretch gap-3 p-3; flex-direction: column; }
  .work-row > button { @apply w-full; }
  button, select { min-height: 44px; }
  select { font-size: 16px; }
  .work-row-meta button { @apply py-1; }
}
</style>
