<template>
  <div class="scheduled-hub">
    <header class="scheduled-header">
      <div>
        <h2>Scheduled tasks</h2>
        <p>Run something once or repeat it automatically. The CodexUI server keeps schedules running when this browser is closed.</p>
      </div>
      <Button type="button" @click="openCreate">
        <Plus aria-hidden="true" />
        New task
      </Button>
    </header>

    <div class="scheduled-toolbar">
      <label class="scheduled-search">
        <Search aria-hidden="true" />
        <Input v-model="query" type="search" placeholder="Search scheduled tasks" />
      </label>
      <div class="scheduled-filters" role="group" aria-label="Task status">
        <Button
          v-for="option in filterOptions"
          :key="option.value"
          type="button"
          size="sm"
          :variant="filter === option.value ? 'secondary' : 'ghost'"
          @click="filter = option.value"
        >
          {{ option.label }}
          <span>{{ option.count }}</span>
        </Button>
      </div>
    </div>

    <p v-if="error" class="scheduled-alert" role="alert">{{ error }}</p>
    <div v-if="isLoading && tasks.length === 0" class="scheduled-empty">Loading scheduled tasks…</div>

    <div v-else class="scheduled-layout">
      <main class="scheduled-main">
        <div v-if="filteredTasks.length === 0" class="scheduled-empty">
          <CalendarClock aria-hidden="true" />
          <strong>{{ query ? 'No matching tasks' : 'No scheduled tasks yet' }}</strong>
          <span>Create one here, or ask Codex in a new chat to schedule something.</span>
        </div>

        <article
          v-for="task in filteredTasks"
          :key="task.id"
          class="scheduled-task-card"
          :data-status="task.status"
        >
          <div class="scheduled-task-heading">
            <span class="scheduled-task-icon"><CalendarClock aria-hidden="true" /></span>
            <div class="scheduled-task-title">
              <div>
                <h3>{{ task.name }}</h3>
                <span class="scheduled-status" :data-active="task.status === 'ACTIVE' && taskStatusLabel(task) !== 'Completed'">
                  {{ taskStatusLabel(task) }}
                </span>
              </div>
              <p>{{ task.prompt }}</p>
            </div>
            <div class="scheduled-task-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                title="Run now"
                :disabled="busyTaskId === task.id"
                @click="void runNow(task)"
              >
                <Play aria-hidden="true" />
                Run now
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                :title="taskToggleLabel(task)"
                :disabled="busyTaskId === task.id"
                @click="void toggleStatus(task)"
              >
                <Pause v-if="task.status === 'ACTIVE' && !isCompletedTask(task)" aria-hidden="true" />
                <RotateCcw v-else aria-hidden="true" />
                {{ taskToggleLabel(task) }}
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" title="Edit" @click="openEdit(task)">
                <Pencil aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Delete"
                @click="confirmDeleteTask = task"
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div class="scheduled-cadence-row">
            <span class="scheduled-cadence-badge" :data-once="isOneTimeAutomation(task)">
              {{ describeAutomationCadence(task) }}
            </span>
          </div>

          <dl class="scheduled-task-meta">
            <div>
              <dt>Frequency</dt>
              <dd><Clock3 aria-hidden="true" /> {{ describeAutomationFrequency(task) }}</dd>
            </div>
            <div>
              <dt>Next run</dt>
              <dd>{{ task.nextRunAtIso ? formatDateTime(task.nextRunAtIso, task.timezone) : taskStatusLabel(task) }}</dd>
            </div>
            <div>
              <dt>Destination</dt>
              <dd v-if="task.kind === 'heartbeat'"><MessageSquare aria-hidden="true" /> Existing chat</dd>
              <dd v-else><Folder aria-hidden="true" /> New chat · {{ basename(task.cwd) }}</dd>
            </div>
          </dl>

          <button
            v-if="task.kind === 'heartbeat' && task.targetThreadId"
            class="scheduled-target-link"
            type="button"
            @click="$emit('select-thread', task.targetThreadId)"
          >
            Open attached chat
          </button>
        </article>
      </main>

      <aside class="scheduled-runs">
        <div class="scheduled-runs-heading">
          <div>
            <History aria-hidden="true" />
            <h3>Previous runs</h3>
          </div>
          <span v-if="unreadRunCount">{{ unreadRunCount }} unread</span>
        </div>

        <div v-if="visibleRuns.length === 0" class="scheduled-runs-empty">No runs yet.</div>
        <article
          v-for="run in visibleRuns"
          :key="run.id"
          class="scheduled-run"
          :data-unread="run.unread"
          :data-status="run.status"
        >
          <button
            class="scheduled-run-main"
            type="button"
            :disabled="!run.threadId"
            @click="openRun(run)"
          >
            <span class="scheduled-run-status">
              <CheckCircle2 v-if="run.status === 'succeeded'" aria-hidden="true" />
              <Clock3 v-else-if="run.status === 'running' || run.status === 'queued'" aria-hidden="true" />
              <AlertCircle v-else aria-hidden="true" />
            </span>
            <span class="scheduled-run-copy">
              <strong>{{ run.automationName }}</strong>
              <small>{{ runStatusLabel(run) }} · {{ formatDateTime(run.startedAtIso) }}</small>
              <span v-if="run.error">{{ run.error }}</span>
            </span>
            <span v-if="run.unread" class="scheduled-unread-dot" aria-label="Unread" />
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Archive run"
            @click="void $emit('update-run', run.id, { archived: true })"
          >
            <Archive aria-hidden="true" />
          </Button>
        </article>
      </aside>
    </div>

    <div v-if="editorOpen" class="scheduled-dialog-backdrop" @click.self="closeEditor">
      <section class="scheduled-dialog" role="dialog" aria-modal="true" aria-labelledby="scheduled-editor-title">
        <header>
          <div>
            <h2 id="scheduled-editor-title">{{ editingTask ? 'Edit scheduled task' : 'New scheduled task' }}</h2>
            <p>CodexUI’s server owns and runs this task even when the PWA is closed.</p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" @click="closeEditor">
            <X aria-hidden="true" />
          </Button>
        </header>

        <form class="scheduled-form" @submit.prevent="void saveTask">
          <label>
            <span>Name</span>
            <Input v-model="draft.name" required placeholder="Daily project check" />
          </label>
          <label>
            <span>Instructions</span>
            <Textarea v-model="draft.prompt" required rows="4" placeholder="What should Codex do?" />
          </label>

          <fieldset>
            <legend>Destination</legend>
            <div class="scheduled-segmented">
              <Button
                type="button"
                size="sm"
                :variant="draft.kind === 'heartbeat' ? 'secondary' : 'ghost'"
                @click="draft.kind = 'heartbeat'"
              >
                <MessageSquare aria-hidden="true" /> Existing chat
              </Button>
              <Button
                type="button"
                size="sm"
                :variant="draft.kind === 'cron' ? 'secondary' : 'ghost'"
                @click="draft.kind = 'cron'"
              >
                <Folder aria-hidden="true" /> New chat
              </Button>
            </div>
          </fieldset>

          <label v-if="draft.kind === 'heartbeat'">
            <span>Chat</span>
            <select v-model="draft.targetThreadId" required>
              <option value="" disabled>Choose a chat</option>
              <option v-for="thread in sortedThreads" :key="thread.id" :value="thread.id">
                {{ thread.title }}
              </option>
            </select>
          </label>
          <label v-else>
            <span>Project folder</span>
            <Input v-model="draft.cwd" required placeholder="/Users/you/project" />
          </label>

          <div v-if="draft.kind === 'cron'" class="scheduled-form-grid">
            <label>
              <span>Environment</span>
              <select v-model="draft.executionEnvironment">
                <option value="worktree">Background worktree</option>
                <option value="local">Project folder directly</option>
              </select>
            </label>
            <label>
              <span>Notifications</span>
              <select v-model="draft.notificationPolicy">
                <option value="always">Every run</option>
                <option value="failure">Failures only</option>
                <option value="never">Never</option>
              </select>
            </label>
          </div>

          <fieldset>
            <legend>Schedule type</legend>
            <div class="scheduled-segmented scheduled-schedule-type">
              <Button
                type="button"
                size="sm"
                :variant="draft.scheduleType === 'once' ? 'secondary' : 'ghost'"
                @click="selectScheduleType('once')"
              >
                One time
              </Button>
              <Button
                type="button"
                size="sm"
                :variant="draft.scheduleType === 'recurring' ? 'secondary' : 'ghost'"
                @click="selectScheduleType('recurring')"
              >
                Repeating
              </Button>
            </div>
            <p class="scheduled-field-help">
              {{ draft.scheduleType === 'once'
                ? 'Runs once at the selected date and time, then marks itself completed.'
                : 'Keeps running at the frequency you choose until you pause it.' }}
            </p>
          </fieldset>

          <div v-if="draft.scheduleType === 'once'" class="scheduled-form-grid">
            <label>
              <span>Date</span>
              <Input v-model="onceDate" type="date" :min="minimumOnceDate" required />
            </label>
            <label>
              <span>Time</span>
              <Input v-model="onceTime" type="time" required />
            </label>
          </div>

          <template v-else>
            <fieldset>
              <legend>Repeat</legend>
              <div class="scheduled-preset-grid">
                <Button
                  v-for="preset in schedulePresets"
                  :key="preset.value"
                  type="button"
                  size="sm"
                  :variant="schedulePreset === preset.value ? 'secondary' : 'ghost'"
                  @click="selectPreset(preset.value)"
                >
                  {{ preset.label }}
                </Button>
              </div>
            </fieldset>

            <div v-if="schedulePreset === 'interval'" class="scheduled-form-grid">
              <label>
                <span>Every</span>
                <Input v-model="intervalAmount" type="number" min="1" max="999" />
              </label>
              <label>
                <span>Unit</span>
                <select v-model="intervalUnit">
                  <option value="MINUTELY">minutes</option>
                  <option value="HOURLY">hours</option>
                  <option value="DAILY">days</option>
                </select>
              </label>
            </div>
            <label v-else-if="schedulePreset === 'custom'">
              <span>RFC 5545 RRULE</span>
              <Input v-model="draft.rrule" required placeholder="FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" />
            </label>
            <label v-else-if="schedulePreset !== 'hourly'">
              <span>At</span>
              <Input v-model="scheduleTime" type="time" required />
            </label>
          </template>

          <div class="scheduled-preview" aria-live="polite">
            <CalendarClock aria-hidden="true" />
            <span>
              <strong>{{ draftScheduleLabel }}</strong>
              <small>{{ draftScheduleHelp }}</small>
            </span>
          </div>
          <p class="scheduled-timezone-note">
            <Globe2 aria-hidden="true" />
            Singapore time (GMT+8)
          </p>

          <div class="scheduled-form-grid">
            <label>
              <span>Model</span>
              <select v-model="draft.model">
                <option value="">Use current default</option>
                <option v-for="model in models" :key="model" :value="model">{{ model }}</option>
              </select>
            </label>
            <label>
              <span>Reasoning</span>
              <select v-model="draft.reasoningEffort">
                <option v-for="effort in reasoningOptions" :key="effort" :value="effort">{{ effort }}</option>
              </select>
            </label>
          </div>

          <label class="scheduled-toggle-row">
            <span>
              <strong>Active</strong>
              <small>Paused tasks keep their settings but do not run.</small>
            </span>
            <input v-model="isDraftActive" type="checkbox" />
          </label>

          <footer>
            <Button type="button" variant="ghost" @click="closeEditor">Cancel</Button>
            <Button type="submit" :disabled="isSaving || !isDraftScheduleValid">
              {{ isSaving ? 'Saving…' : editingTask ? 'Save changes' : 'Create task' }}
            </Button>
          </footer>
        </form>
      </section>
    </div>

    <div v-if="confirmDeleteTask" class="scheduled-dialog-backdrop" @click.self="confirmDeleteTask = null">
      <section class="scheduled-confirm" role="alertdialog" aria-modal="true">
        <h2>Delete “{{ confirmDeleteTask.name }}”?</h2>
        <p>Past run chats remain available, but this schedule cannot be recovered.</p>
        <footer>
          <Button type="button" variant="ghost" @click="confirmDeleteTask = null">Cancel</Button>
          <Button type="button" variant="destructive" :disabled="isSaving" @click="void deleteTask">Delete</Button>
        </footer>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  AlertCircle,
  Archive,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Folder,
  Globe2,
  History,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from '@lucide/vue'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import type {
  AutomationDraft,
  AutomationRun,
  AutomationScheduleType,
  AutomationTask,
} from '../../types/automations'
import type { ReasoningEffort, UiThread } from '../../types/codex'
import {
  automationStatusLabel,
  describeAutomationCadence,
  describeAutomationFrequency,
  formatAutomationDateTime,
  isOneTimeAutomation,
} from '../../utils/automations'

const props = defineProps<{
  tasks: AutomationTask[]
  runs: AutomationRun[]
  isLoading: boolean
  error: string
  threads: UiThread[]
  defaultCwd: string
  models: string[]
  currentThreadId: string
}>()

const emit = defineEmits<{
  create: [draft: AutomationDraft]
  update: [id: string, changes: Partial<AutomationDraft>]
  delete: [id: string]
  run: [id: string]
  'select-thread': [threadId: string]
  'update-run': [id: string, changes: { unread?: boolean; archived?: boolean }]
}>()

type Filter = 'all' | 'active' | 'paused' | 'completed'
type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'interval' | 'custom'

const query = ref('')
const filter = ref<Filter>('all')
const editorOpen = ref(false)
const editingTask = ref<AutomationTask | null>(null)
const confirmDeleteTask = ref<AutomationTask | null>(null)
const busyTaskId = ref('')
const isSaving = ref(false)
const schedulePreset = ref<SchedulePreset>('daily')
const scheduleTime = ref('09:00')
const onceDate = ref('')
const onceTime = ref('09:00')
const intervalAmount = ref('1')
const intervalUnit = ref<'MINUTELY' | 'HOURLY' | 'DAILY'>('HOURLY')
const reasoningOptions: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const schedulePresets: Array<{ value: SchedulePreset; label: string }> = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'interval', label: 'Interval' },
  { value: 'custom', label: 'Custom' },
]

const draft = reactive<AutomationDraft>(createEmptyDraft())
const isDraftActive = computed({
  get: () => draft.status === 'ACTIVE',
  set: (active: boolean) => { draft.status = active ? 'ACTIVE' : 'PAUSED' },
})
const sortedThreads = computed(() =>
  [...props.threads].sort((left, right) => Date.parse(right.updatedAtIso) - Date.parse(left.updatedAtIso)),
)
const filterOptions = computed(() => [
  { value: 'all' as const, label: 'All', count: props.tasks.length },
  { value: 'active' as const, label: 'Active', count: props.tasks.filter((task) => task.status === 'ACTIVE' && !isCompletedTask(task)).length },
  { value: 'paused' as const, label: 'Paused', count: props.tasks.filter((task) => task.status === 'PAUSED' && !isCompletedTask(task)).length },
  { value: 'completed' as const, label: 'Completed', count: props.tasks.filter(isCompletedTask).length },
])
const filteredTasks = computed(() => {
  const normalizedQuery = query.value.trim().toLowerCase()
  return props.tasks.filter((task) => {
    if (filter.value === 'active' && (task.status !== 'ACTIVE' || isCompletedTask(task))) return false
    if (filter.value === 'paused' && (task.status !== 'PAUSED' || isCompletedTask(task))) return false
    if (filter.value === 'completed' && !isCompletedTask(task)) return false
    if (!normalizedQuery) return true
    return `${task.name} ${task.prompt} ${task.cwd}`.toLowerCase().includes(normalizedQuery)
  })
})
const visibleRuns = computed(() => props.runs.filter((run) => !run.archived).slice(0, 18))
const unreadRunCount = computed(() => props.runs.filter((run) => run.unread && !run.archived).length)
const minimumOnceDate = computed(() => singaporeDateTimeParts(new Date()).date)
const draftSchedule = computed(() => ({
  ...draft,
  rrule: schedulePreset.value === 'custom' ? draft.rrule : buildRrule(),
  runAtIso: draft.scheduleType === 'once' ? buildOneTimeIso() : '',
}))
const draftScheduleLabel = computed(() => {
  if (draft.scheduleType === 'once' && !draftSchedule.value.runAtIso) return 'Choose a date and time'
  return describeAutomationFrequency(draftSchedule.value)
})
const draftScheduleHelp = computed(() => draft.scheduleType === 'once'
  ? 'This task stops after that run.'
  : `${describeAutomationCadence(draftSchedule.value)} until you pause it.`)
const isDraftScheduleValid = computed(() => {
  if (draft.scheduleType === 'recurring') return Boolean(draftSchedule.value.rrule)
  const runAt = Date.parse(draftSchedule.value.runAtIso)
  return Number.isFinite(runAt) && (draft.status === 'PAUSED' || runAt > Date.now())
})

function createEmptyDraft(): AutomationDraft {
  return {
    name: '',
    prompt: '',
    status: 'ACTIVE',
    kind: props.currentThreadId ? 'heartbeat' : 'cron',
    scheduleType: 'recurring',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    runAtIso: '',
    cwd: props.defaultCwd,
    targetThreadId: props.currentThreadId,
    executionEnvironment: 'worktree',
    model: '',
    reasoningEffort: 'xhigh',
    notificationPolicy: 'always',
    timezone: 'Asia/Singapore',
  }
}

function assignDraft(value: AutomationDraft): void {
  Object.assign(draft, value)
}

function openCreate(): void {
  editingTask.value = null
  assignDraft(createEmptyDraft())
  schedulePreset.value = 'daily'
  scheduleTime.value = '09:00'
  setOnceControls()
  intervalAmount.value = '1'
  intervalUnit.value = 'HOURLY'
  editorOpen.value = true
}

function openEdit(task: AutomationTask): void {
  editingTask.value = task
  assignDraft({
    name: task.name,
    prompt: task.prompt,
    status: task.status,
    kind: task.kind,
    scheduleType: isOneTimeAutomation(task) ? 'once' : task.scheduleType,
    rrule: task.rrule,
    runAtIso: task.runAtIso || task.nextRunAtIso || task.lastRunAtIso,
    cwd: task.cwd,
    targetThreadId: task.targetThreadId,
    executionEnvironment: task.executionEnvironment,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
    notificationPolicy: task.notificationPolicy,
    timezone: task.timezone,
  })
  inferScheduleControls(task.rrule)
  setOnceControls(task.runAtIso || task.nextRunAtIso || task.lastRunAtIso)
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
  editingTask.value = null
}

function selectPreset(preset: SchedulePreset): void {
  schedulePreset.value = preset
  if (preset !== 'custom') draft.rrule = buildRrule()
}

function selectScheduleType(scheduleType: AutomationScheduleType): void {
  draft.scheduleType = scheduleType
  if (scheduleType === 'once' && !onceDate.value) setOnceControls()
}

function singaporeDateTimeParts(value: Date | string): { date: string; time: string } {
  const date = typeof value === 'string' ? new Date(value) : value
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  }
}

function setOnceControls(value = ''): void {
  const source = value && Number.isFinite(Date.parse(value))
    ? new Date(value)
    : new Date(Date.now() + 24 * 60 * 60 * 1000)
  const parts = singaporeDateTimeParts(source)
  onceDate.value = parts.date
  onceTime.value = value ? parts.time : '09:00'
}

function buildOneTimeIso(): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(onceDate.value) || !/^\d{2}:\d{2}$/u.test(onceTime.value)) return ''
  const timestamp = Date.parse(`${onceDate.value}T${onceTime.value}:00+08:00`)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}

function timeParts(): { hour: number; minute: number } {
  const [hourValue, minuteValue] = scheduleTime.value.split(':').map(Number)
  return {
    hour: Number.isFinite(hourValue) ? hourValue : 9,
    minute: Number.isFinite(minuteValue) ? minuteValue : 0,
  }
}

function buildRrule(): string {
  const { hour, minute } = timeParts()
  if (schedulePreset.value === 'hourly') return 'FREQ=HOURLY;INTERVAL=1'
  if (schedulePreset.value === 'interval') {
    return `FREQ=${intervalUnit.value};INTERVAL=${Math.max(1, Math.floor(Number(intervalAmount.value) || 1))}`
  }
  if (schedulePreset.value === 'weekdays') {
    return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`
  }
  if (schedulePreset.value === 'weekly') {
    return `FREQ=WEEKLY;BYDAY=MO;BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`
  }
  return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`
}

function inferScheduleControls(rrule: string): void {
  const rule = rrule.toUpperCase()
  const hour = /BYHOUR=(\d+)/u.exec(rule)?.[1] ?? '9'
  const minute = /BYMINUTE=(\d+)/u.exec(rule)?.[1] ?? '0'
  scheduleTime.value = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  if (rule === 'FREQ=HOURLY;INTERVAL=1' || rule === 'FREQ=HOURLY') {
    schedulePreset.value = 'hourly'
  } else if (rule.includes('BYDAY=MO,TU,WE,TH,FR')) {
    schedulePreset.value = 'weekdays'
  } else if (rule.startsWith('FREQ=WEEKLY') && rule.includes('BYDAY=MO')) {
    schedulePreset.value = 'weekly'
  } else if (rule.startsWith('FREQ=DAILY') && !rule.includes('INTERVAL=')) {
    schedulePreset.value = 'daily'
  } else if (/^FREQ=(MINUTELY|HOURLY|DAILY);INTERVAL=\d+$/u.test(rule)) {
    schedulePreset.value = 'interval'
    intervalUnit.value = /^FREQ=(MINUTELY|HOURLY|DAILY)/u.exec(rule)?.[1] as typeof intervalUnit.value
    intervalAmount.value = /INTERVAL=(\d+)/u.exec(rule)?.[1] ?? '1'
  } else {
    schedulePreset.value = 'custom'
  }
}

async function saveTask(): Promise<void> {
  isSaving.value = true
  try {
    const payload: AutomationDraft = {
      ...draft,
      rrule: schedulePreset.value === 'custom' ? draft.rrule : buildRrule(),
      runAtIso: draft.scheduleType === 'once' ? buildOneTimeIso() : '',
      cwd: draft.kind === 'cron' ? draft.cwd : '',
      targetThreadId: draft.kind === 'heartbeat' ? draft.targetThreadId : '',
    }
    if (editingTask.value) emit('update', editingTask.value.id, payload)
    else emit('create', payload)
    closeEditor()
  } finally {
    window.setTimeout(() => { isSaving.value = false }, 250)
  }
}

async function toggleStatus(task: AutomationTask): Promise<void> {
  if (isCompletedTask(task) || (
    isOneTimeAutomation(task)
    && task.status === 'PAUSED'
    && Date.parse(task.runAtIso || task.lastRunAtIso) <= Date.now()
  )) {
    openEdit(task)
    draft.status = 'ACTIVE'
    setOnceControls()
    return
  }
  busyTaskId.value = task.id
  try {
    emit('update', task.id, { status: task.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })
  } finally {
    window.setTimeout(() => { busyTaskId.value = '' }, 250)
  }
}

async function runNow(task: AutomationTask): Promise<void> {
  busyTaskId.value = task.id
  try {
    emit('run', task.id)
  } finally {
    window.setTimeout(() => { busyTaskId.value = '' }, 500)
  }
}

async function deleteTask(): Promise<void> {
  const task = confirmDeleteTask.value
  if (!task) return
  isSaving.value = true
  try {
    emit('delete', task.id)
    confirmDeleteTask.value = null
  } finally {
    window.setTimeout(() => { isSaving.value = false }, 250)
  }
}

function openRun(run: AutomationRun): void {
  if (!run.threadId) return
  if (run.unread) emit('update-run', run.id, { unread: false })
  emit('select-thread', run.threadId)
}

function basename(path: string): string {
  return path.replace(/\/+$/u, '').split('/').pop() || path || 'Project'
}

function formatDateTime(value: string, timezone = 'Asia/Singapore'): string {
  return formatAutomationDateTime(value, timezone, { includeYear: false })
}

function taskStatusLabel(task: AutomationTask): string {
  return automationStatusLabel(task)
}

function isCompletedTask(task: AutomationTask): boolean {
  return isOneTimeAutomation(task) && Boolean(task.lastRunAtIso) && !task.nextRunAtIso
}

function taskToggleLabel(task: AutomationTask): string {
  if (isCompletedTask(task)) return 'Schedule again'
  if (task.status === 'ACTIVE') return 'Pause'
  if (isOneTimeAutomation(task) && Date.parse(task.runAtIso || task.lastRunAtIso) <= Date.now()) return 'Schedule again'
  return 'Resume'
}

function runStatusLabel(run: AutomationRun): string {
  if (run.status === 'succeeded') return 'Completed'
  if (run.status === 'running' || run.status === 'queued') return 'Running'
  if (run.status === 'interrupted') return 'Interrupted'
  return 'Failed'
}
</script>

<style scoped>
.scheduled-hub {
  width: min(76rem, 100%);
  height: 100%;
  min-height: 0;
  margin: 0 auto;
  padding: clamp(1rem, 3vw, 2.5rem);
  color: var(--text-primary);
  overflow-y: auto;
}

.scheduled-header,
.scheduled-toolbar,
.scheduled-task-heading,
.scheduled-runs-heading,
.scheduled-runs-heading > div,
.scheduled-run,
.scheduled-run-main,
.scheduled-dialog > header,
.scheduled-form footer,
.scheduled-confirm footer {
  display: flex;
  align-items: center;
}

.scheduled-header {
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.scheduled-header h2,
.scheduled-dialog h2,
.scheduled-confirm h2 {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 650;
}

.scheduled-header p,
.scheduled-dialog header p,
.scheduled-confirm p {
  margin: .3rem 0 0;
  color: var(--muted-foreground, #667085);
  font-size: .9rem;
}

.scheduled-header button svg,
.scheduled-task-actions svg,
.scheduled-run button svg,
.scheduled-dialog button svg {
  width: 1rem;
  height: 1rem;
}

.scheduled-toolbar {
  gap: .75rem;
  justify-content: space-between;
  margin-bottom: 1.1rem;
}

.scheduled-search {
  position: relative;
  width: min(24rem, 100%);
}

.scheduled-search > svg {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: .7rem;
  width: 1rem;
  height: 1rem;
  transform: translateY(-50%);
  color: var(--muted-foreground, #667085);
}

.scheduled-search input {
  padding-left: 2.25rem;
}

.scheduled-filters,
.scheduled-segmented,
.scheduled-preset-grid {
  display: flex;
  gap: .25rem;
  padding: .2rem;
  border-radius: .65rem;
  background: var(--muted, #f3f4f6);
}

.scheduled-filters button span {
  color: var(--muted-foreground, #667085);
  font-size: .7rem;
}

.scheduled-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(17rem, 21rem);
  gap: 1rem;
  align-items: start;
}

.scheduled-main {
  display: grid;
  gap: .75rem;
}

.scheduled-task-card,
.scheduled-runs,
.scheduled-empty,
.scheduled-dialog,
.scheduled-confirm {
  border: 1px solid var(--border-soft);
  border-radius: .9rem;
  background: var(--surface-elevated);
  box-shadow: 0 1px 2px rgb(15 23 42 / 4%);
}

.scheduled-task-card {
  padding: 1rem;
}

.scheduled-task-heading {
  align-items: flex-start;
  gap: .8rem;
}

.scheduled-task-icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  flex: 0 0 auto;
  place-items: center;
  border-radius: .55rem;
  background: color-mix(in srgb, var(--primary, #2563eb) 12%, transparent);
  color: var(--primary, #2563eb);
}

.scheduled-task-icon svg {
  width: 1rem;
  height: 1rem;
}

.scheduled-task-title {
  min-width: 0;
  flex: 1;
}

.scheduled-task-title > div {
  display: flex;
  gap: .5rem;
  align-items: center;
}

.scheduled-task-title h3,
.scheduled-runs-heading h3 {
  margin: 0;
  overflow: hidden;
  font-size: .95rem;
  font-weight: 630;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scheduled-task-title p {
  display: -webkit-box;
  overflow: hidden;
  margin: .3rem 0 0;
  color: var(--muted-foreground, #667085);
  font-size: .82rem;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.scheduled-status {
  padding: .1rem .4rem;
  border-radius: 999px;
  background: var(--muted, #f3f4f6);
  color: var(--muted-foreground, #667085);
  font-size: .65rem;
  font-weight: 650;
}

.scheduled-status[data-active='true'] {
  background: color-mix(in srgb, #10b981 14%, transparent);
  color: color-mix(in srgb, #10b981 72%, var(--text-primary));
}

.scheduled-task-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  flex: 0 0 auto;
  gap: .05rem;
}

.scheduled-cadence-row {
  margin: .65rem 0 0 2.8rem;
}

.scheduled-cadence-badge {
  display: inline-flex;
  align-items: center;
  min-height: 1.5rem;
  padding: .15rem .5rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--primary, #2563eb) 9%, transparent);
  color: var(--primary, #2563eb);
  font-size: .68rem;
  font-weight: 620;
}

.scheduled-cadence-badge[data-once='true'] {
  background: color-mix(in srgb, #8b5cf6 12%, transparent);
  color: color-mix(in srgb, #8b5cf6 78%, var(--text-primary));
}

.scheduled-task-meta {
  display: grid;
  grid-template-columns: 1.35fr 1fr 1fr;
  gap: .55rem;
  margin: .75rem 0 0 2.8rem;
  padding: 0;
}

.scheduled-task-meta > div {
  min-width: 0;
  padding: .58rem .65rem;
  border-radius: .55rem;
  background: var(--surface-muted);
}

.scheduled-task-meta dt {
  color: var(--muted-foreground, #667085);
  font-size: .65rem;
}

.scheduled-task-meta dd {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: .3rem;
  margin: .16rem 0 0;
  font-size: .73rem;
  font-weight: 590;
  line-height: 1.35;
}

.scheduled-task-meta svg {
  width: .85rem;
  height: .85rem;
}

.scheduled-target-link {
  margin: .7rem 0 0 2.8rem;
  border: 0;
  background: none;
  color: var(--primary, #2563eb);
  font-size: .75rem;
  cursor: pointer;
}

.scheduled-runs {
  position: sticky;
  top: 1rem;
  overflow: hidden;
}

.scheduled-runs-heading {
  justify-content: space-between;
  padding: .85rem 1rem;
  border-bottom: 1px solid var(--border, #e5e7eb);
}

.scheduled-runs-heading > div {
  gap: .45rem;
}

.scheduled-runs-heading svg {
  width: 1rem;
  height: 1rem;
  color: var(--muted-foreground, #667085);
}

.scheduled-runs-heading > span {
  color: var(--primary, #2563eb);
  font-size: .7rem;
}

.scheduled-run {
  gap: .25rem;
  padding: .25rem .35rem .25rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border, #e5e7eb) 70%, transparent);
}

.scheduled-run:last-child {
  border-bottom: 0;
}

.scheduled-run[data-unread='true'] {
  background: color-mix(in srgb, var(--primary, #2563eb) 6%, transparent);
}

.scheduled-run-main {
  min-width: 0;
  flex: 1;
  gap: .55rem;
  padding: .65rem .3rem .65rem .8rem;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.scheduled-run-main:disabled {
  cursor: default;
}

.scheduled-run-status {
  display: grid;
  place-items: center;
  color: #10b981;
}

.scheduled-run[data-status='failed'] .scheduled-run-status,
.scheduled-run[data-status='interrupted'] .scheduled-run-status {
  color: #ef4444;
}

.scheduled-run[data-status='running'] .scheduled-run-status {
  color: var(--primary, #2563eb);
}

.scheduled-run-copy {
  min-width: 0;
  flex: 1;
}

.scheduled-run-copy strong,
.scheduled-run-copy small,
.scheduled-run-copy > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scheduled-run-copy strong {
  font-size: .78rem;
  font-weight: 600;
}

.scheduled-run-copy small,
.scheduled-run-copy > span {
  margin-top: .1rem;
  color: var(--muted-foreground, #667085);
  font-size: .68rem;
}

.scheduled-unread-dot {
  width: .42rem;
  height: .42rem;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--primary, #2563eb);
}

.scheduled-empty,
.scheduled-runs-empty {
  display: grid;
  min-height: 12rem;
  place-items: center;
  align-content: center;
  gap: .4rem;
  padding: 2rem;
  color: var(--muted-foreground, #667085);
  text-align: center;
}

.scheduled-empty > svg {
  width: 1.5rem;
  height: 1.5rem;
}

.scheduled-runs-empty {
  min-height: 8rem;
  border: 0;
  font-size: .8rem;
}

.scheduled-alert {
  margin: 0 0 1rem;
  padding: .7rem .85rem;
  border-radius: .6rem;
  background: color-mix(in srgb, #ef4444 10%, transparent);
  color: #dc2626;
  font-size: .82rem;
}

.scheduled-dialog-backdrop {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: grid;
  overflow-y: auto;
  padding: 1rem;
  place-items: center;
  background: rgb(0 0 0 / 48%);
  backdrop-filter: blur(2px);
}

.scheduled-dialog {
  width: min(42rem, 100%);
  max-height: min(52rem, calc(100dvh - 2rem));
  overflow-y: auto;
  padding: 1.2rem;
}

.scheduled-dialog > header {
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1rem;
}

.scheduled-form {
  display: grid;
  gap: 1rem;
}

.scheduled-form label,
.scheduled-form fieldset {
  display: grid;
  min-width: 0;
  gap: .4rem;
  margin: 0;
  padding: 0;
  border: 0;
}

.scheduled-form label > span,
.scheduled-form legend {
  color: var(--muted-foreground, #667085);
  font-size: .74rem;
  font-weight: 600;
}

.scheduled-form select {
  min-height: 2.35rem;
  width: 100%;
  padding: 0 .7rem;
  border: 1px solid var(--input);
  border-radius: .45rem;
  background: var(--surface-muted);
  color: var(--text-primary);
  font: inherit;
  font-size: .85rem;
}

.scheduled-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .75rem;
}

.scheduled-field-help {
  max-width: 34rem;
  margin: 0;
  color: var(--text-secondary);
  font-size: .72rem;
  line-height: 1.4;
}

.scheduled-schedule-type {
  width: min(22rem, 100%);
}

.scheduled-schedule-type button {
  flex: 1;
}

.scheduled-preview {
  display: flex;
  align-items: flex-start;
  gap: .65rem;
  padding: .75rem;
  border: 1px solid color-mix(in srgb, var(--primary, #2563eb) 18%, var(--border-soft));
  border-radius: .65rem;
  background: color-mix(in srgb, var(--primary, #2563eb) 5%, var(--surface-muted));
}

.scheduled-preview > svg {
  width: 1rem;
  height: 1rem;
  flex: 0 0 auto;
  margin-top: .08rem;
  color: var(--primary, #2563eb);
}

.scheduled-preview strong,
.scheduled-preview small {
  display: block;
}

.scheduled-preview strong {
  font-size: .82rem;
  font-weight: 630;
}

.scheduled-preview small {
  margin-top: .15rem;
  color: var(--text-secondary);
  font-size: .7rem;
}

.scheduled-timezone-note {
  display: flex;
  align-items: center;
  gap: .4rem;
  margin: -.35rem 0 0;
  color: var(--text-secondary);
  font-size: .74rem;
}

.scheduled-timezone-note svg {
  width: .85rem;
  height: .85rem;
}

.scheduled-segmented,
.scheduled-preset-grid {
  width: fit-content;
  flex-wrap: wrap;
}

.scheduled-segmented svg {
  width: .9rem;
  height: .9rem;
}

.scheduled-toggle-row {
  display: flex !important;
  align-items: center;
  justify-content: space-between;
  padding: .75rem !important;
  border: 1px solid var(--border-soft) !important;
  border-radius: .65rem;
}

.scheduled-toggle-row > span strong,
.scheduled-toggle-row > span small {
  display: block;
}

.scheduled-toggle-row > span strong {
  color: inherit;
  font-size: .84rem;
}

.scheduled-toggle-row > span small {
  margin-top: .1rem;
  font-size: .68rem;
  font-weight: 400;
}

.scheduled-toggle-row input {
  width: 1.1rem;
  height: 1.1rem;
}

.scheduled-form footer,
.scheduled-confirm footer {
  justify-content: flex-end;
  gap: .45rem;
  padding-top: .3rem;
}

.scheduled-confirm {
  width: min(25rem, 100%);
  padding: 1.2rem;
}

@media (max-width: 860px) {
  .scheduled-hub {
    padding: .8rem .65rem 2rem;
  }

  .scheduled-header {
    align-items: flex-start;
  }

  .scheduled-header p {
    max-width: 19rem;
  }

  .scheduled-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .scheduled-search {
    width: 100%;
  }

  .scheduled-filters {
    width: fit-content;
  }

  .scheduled-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .scheduled-runs {
    position: static;
    order: -1;
  }

  .scheduled-runs .scheduled-run:nth-of-type(n + 7) {
    display: none;
  }

  .scheduled-task-heading {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .scheduled-task-actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
    margin-top: -.25rem;
  }

  .scheduled-task-meta,
  .scheduled-cadence-row,
  .scheduled-target-link {
    margin-left: 0;
  }

  .scheduled-task-meta {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .scheduled-dialog-backdrop {
    align-items: end;
    padding: 0;
  }

  .scheduled-dialog {
    width: 100%;
    max-height: 92dvh;
    border-radius: 1rem 1rem 0 0;
    padding: 1rem;
  }
}

@media (max-width: 520px) {
  .scheduled-header h2 {
    font-size: 1.15rem;
  }

  .scheduled-header p {
    display: none;
  }

  .scheduled-form-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .scheduled-task-meta {
    grid-template-columns: minmax(0, 1fr);
  }

  .scheduled-task-card {
    padding: .85rem;
  }
}

</style>
