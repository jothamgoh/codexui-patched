import { randomUUID } from 'node:crypto'
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import rrulePackage from 'rrule'
import type {
  AutomationDraft,
  AutomationProposal,
  AutomationRun,
  AutomationRunStatus,
  AutomationSnapshot,
  AutomationTask,
} from '../types/automations'
import { DEFAULT_AUTOMATION_TIME_ZONE } from '../types/automations'
import type { ReasoningEffort } from '../types/codex'

type AutomationStoreOptions = {
  stateFilePath: string
  sessionsDirectoryPath?: string
  now?: () => Date
}

const MAX_RUNS = 250
const MAX_PROPOSALS = 100
const AUTOMATION_SCHEMA_VERSION = 3
const { rrulestr } = rrulePackage
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTimeZone(value: unknown): string {
  const candidate = readString(value)
  const normalized = /^(?:SGT|GMT\s*\+?\s*8|UTC\s*\+?\s*8)$/iu.test(candidate)
    ? DEFAULT_AUTOMATION_TIME_ZONE
    : candidate || DEFAULT_AUTOMATION_TIME_ZONE
  try {
    new Intl.DateTimeFormat('en', { timeZone: normalized }).format()
    return normalized
  } catch {
    return DEFAULT_AUTOMATION_TIME_ZONE
  }
}

function normalizeRrule(value: unknown): string {
  const normalized = readString(value).replace(/^RRULE:/iu, '').toUpperCase()
  if (!normalized) return 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
  rrulestr(`RRULE:${normalized}`)
  return normalized
}

function normalizeDraft(value: unknown): AutomationDraft {
  const record = asRecord(value) ?? {}
  const kind = record.kind === 'heartbeat' ? 'heartbeat' : 'cron'
  const rawEffort = readString(record.reasoningEffort) as ReasoningEffort
  const scheduleType = record.scheduleType === 'once' ? 'once' : 'recurring'
  return {
    name: readString(record.name) || 'Scheduled task',
    prompt: readString(record.prompt),
    status: record.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    kind,
    scheduleType,
    rrule: normalizeRrule(record.rrule),
    runAtIso: scheduleType === 'once' ? readString(record.runAtIso) : '',
    cwd: readString(record.cwd),
    targetThreadId: kind === 'heartbeat' ? readString(record.targetThreadId) : '',
    executionEnvironment: record.executionEnvironment === 'worktree' ? 'worktree' : 'local',
    model: readString(record.model),
    reasoningEffort: REASONING_EFFORTS.has(rawEffort) ? rawEffort : 'xhigh',
    notificationPolicy:
      record.notificationPolicy === 'failure' || record.notificationPolicy === 'never'
        ? record.notificationPolicy
        : 'always',
    timezone: normalizeTimeZone(record.timezone),
  }
}

function validateDraft(draft: AutomationDraft): void {
  if (!draft.prompt) throw new Error('A task prompt is required.')
  if (draft.kind === 'heartbeat' && !draft.targetThreadId) {
    throw new Error('An existing-chat task requires a target chat.')
  }
  if (draft.kind === 'cron' && !draft.cwd) {
    throw new Error('A new-chat task requires a project folder.')
  }
  if (draft.scheduleType === 'once' && !Number.isFinite(Date.parse(draft.runAtIso))) {
    throw new Error('A one-time task requires a valid run date and time.')
  }
}

function draftKey(value: unknown): string {
  return JSON.stringify(normalizeDraft(value))
}

function taskMatchesDraft(task: AutomationTask, draft: AutomationDraft): boolean {
  return draftKey(task) === draftKey(draft)
}

function taskWasSavedAfterProposal(task: AutomationTask, proposal: AutomationProposal): boolean {
  const taskTime = Date.parse(task.createdAtIso)
  const proposalTime = Date.parse(proposal.createdAtIso)
  return Number.isFinite(taskTime) && Number.isFinite(proposalTime) && taskTime >= proposalTime
}

function createTask(draft: AutomationDraft, now: Date): AutomationTask {
  const nextRunAtIso = draft.status === 'ACTIVE'
    ? nextRunForDraft(draft, now, now.toISOString())
    : ''
  if (draft.status === 'ACTIVE' && !nextRunAtIso) {
    throw new Error('The next run must be in the future.')
  }
  return {
    id: randomUUID(),
    ...draft,
    createdAtIso: now.toISOString(),
    updatedAtIso: now.toISOString(),
    nextRunAtIso,
    lastRunAtIso: '',
  }
}

function normalizeTask(value: unknown): AutomationTask | null {
  const record = asRecord(value)
  const id = readString(record?.id)
  if (!record || !id) return null
  const draft = normalizeDraft(record)
  return {
    id,
    ...draft,
    createdAtIso: readString(record.createdAtIso) || new Date(0).toISOString(),
    updatedAtIso: readString(record.updatedAtIso) || new Date(0).toISOString(),
    nextRunAtIso: readString(record.nextRunAtIso),
    lastRunAtIso: readString(record.lastRunAtIso),
  }
}

function normalizeRun(value: unknown): AutomationRun | null {
  const record = asRecord(value)
  const id = readString(record?.id)
  const automationId = readString(record?.automationId)
  if (!record || !id || !automationId) return null
  const statusValues = new Set<AutomationRunStatus>(['queued', 'running', 'succeeded', 'failed', 'interrupted'])
  const rawStatus = readString(record.status) as AutomationRunStatus
  return {
    id,
    automationId,
    automationName: readString(record.automationName) || 'Scheduled task',
    status: statusValues.has(rawStatus) ? rawStatus : 'failed',
    trigger: record.trigger === 'manual' ? 'manual' : 'schedule',
    threadId: readString(record.threadId),
    startedAtIso: readString(record.startedAtIso),
    finishedAtIso: readString(record.finishedAtIso),
    error: readString(record.error),
    unread: record.unread === true,
    archived: record.archived === true,
  }
}

function normalizeProposal(value: unknown): AutomationProposal | null {
  const record = asRecord(value)
  const id = readString(record?.id)
  if (!record || !id) return null
  return {
    id,
    action: record.action === 'update' ? 'update' : 'create',
    automationId: readString(record.automationId),
    resolvedAutomationId: readString(record.resolvedAutomationId),
    threadId: readString(record.threadId),
    turnId: readString(record.turnId),
    draft: normalizeDraft(record.draft),
    createdAtIso: readString(record.createdAtIso) || new Date(0).toISOString(),
    status: record.status === 'accepted' || record.status === 'dismissed' ? record.status : 'pending',
  }
}

function emptySnapshot(now: Date): AutomationSnapshot {
  return {
    tasks: [],
    runs: [],
    proposals: [],
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    version: 1,
    updatedAtIso: now.toISOString(),
  }
}

function normalizeSnapshot(value: unknown, now: Date): AutomationSnapshot | null {
  const record = asRecord(value)
  if (!record) return null
  return {
    tasks: Array.isArray(record.tasks)
      ? record.tasks.map(normalizeTask).filter((task): task is AutomationTask => task !== null)
      : [],
    runs: Array.isArray(record.runs)
      ? record.runs.map(normalizeRun).filter((run): run is AutomationRun => run !== null).slice(0, MAX_RUNS)
      : [],
    proposals: Array.isArray(record.proposals)
      ? record.proposals
        .map(normalizeProposal)
        .filter((proposal): proposal is AutomationProposal => proposal !== null)
        .slice(0, MAX_PROPOSALS)
      : [],
    schemaVersion:
      typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
        ? Math.max(1, Math.floor(record.schemaVersion))
        : 1,
    version:
      typeof record.version === 'number' && Number.isFinite(record.version)
        ? Math.max(1, Math.floor(record.version))
        : 1,
    updatedAtIso: readString(record.updatedAtIso) || now.toISOString(),
  }
}

function isMissingFileError(error: unknown): boolean {
  return asRecord(error)?.code === 'ENOENT'
}

type SessionAutomationEvent = {
  timestamp: number
  turnId: string
  searchablePayload: string
}

function sessionDateDirectories(sessionsDirectoryPath: string, createdAtIso: string): string[] {
  const createdAt = Date.parse(createdAtIso)
  if (!Number.isFinite(createdAt)) return []
  return [-1, 0, 1].map((dayOffset) => {
    const date = new Date(createdAt + dayOffset * 24 * 60 * 60 * 1_000)
    return join(
      sessionsDirectoryPath,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    )
  })
}

async function readSessionAutomationEvents(
  sessionsDirectoryPath: string,
  threadId: string,
  proposals: AutomationProposal[],
): Promise<SessionAutomationEvent[]> {
  const directoryPaths = new Set(
    proposals.flatMap((proposal) => sessionDateDirectories(sessionsDirectoryPath, proposal.createdAtIso)),
  )
  const sessionFilePaths = new Set<string>()
  for (const directoryPath of directoryPaths) {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
          sessionFilePaths.add(join(directoryPath, entry.name))
        }
      }
    } catch {
      // Session history is optional recovery data. A missing or unreadable day must not block the scheduler.
    }
  }

  const events: SessionAutomationEvent[] = []
  for (const sessionFilePath of sessionFilePaths) {
    let raw = ''
    try {
      raw = await readFile(sessionFilePath, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line.includes('automation_update') || !line.includes('turn_id')) continue
      try {
        const record = asRecord(JSON.parse(line))
        const payload = asRecord(record?.payload)
        const metadata = asRecord(payload?.internal_chat_message_metadata_passthrough)
        const turnId = readString(metadata?.turn_id)
        const timestamp = Date.parse(readString(record?.timestamp))
        if (!turnId || !Number.isFinite(timestamp)) continue
        events.push({
          timestamp,
          turnId,
          searchablePayload: JSON.stringify(payload).toLocaleLowerCase(),
        })
      } catch {
        // Ignore individual incomplete or malformed session-log lines.
      }
    }
  }
  return events
}

async function recoverLegacyProposalTurnIds(
  snapshot: AutomationSnapshot,
  sessionsDirectoryPath: string,
): Promise<AutomationSnapshot> {
  const missingByThreadId = new Map<string, AutomationProposal[]>()
  for (const proposal of snapshot.proposals) {
    if (proposal.turnId || !proposal.threadId) continue
    const proposals = missingByThreadId.get(proposal.threadId)
    if (proposals) proposals.push(proposal)
    else missingByThreadId.set(proposal.threadId, [proposal])
  }
  if (missingByThreadId.size === 0) return snapshot

  const recoveredTurnIds = new Map<string, string>()
  await Promise.all([...missingByThreadId.entries()].map(async ([threadId, proposals]) => {
    const events = await readSessionAutomationEvents(sessionsDirectoryPath, threadId, proposals)
    for (const proposal of proposals) {
      const createdAt = Date.parse(proposal.createdAtIso)
      const taskName = readString(proposal.draft.name).toLocaleLowerCase()
      if (!Number.isFinite(createdAt) || !taskName) continue
      const closest = events
        .filter((event) =>
          Math.abs(event.timestamp - createdAt) <= 2 * 60 * 1_000
          && event.searchablePayload.includes(taskName),
        )
        .sort((left, right) => Math.abs(left.timestamp - createdAt) - Math.abs(right.timestamp - createdAt))[0]
      if (closest) recoveredTurnIds.set(proposal.id, closest.turnId)
    }
  }))
  if (recoveredTurnIds.size === 0) return snapshot

  return {
    ...snapshot,
    proposals: snapshot.proposals.map((proposal) => {
      const turnId = recoveredTurnIds.get(proposal.id)
      return turnId ? { ...proposal, turnId } : proposal
    }),
  }
}

type ZonedDateParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const zonedDateFormatters = new Map<string, Intl.DateTimeFormat>()

function zonedDateParts(date: Date, timezone: string): ZonedDateParts {
  let formatter = zonedDateFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    zonedDateFormatters.set(timezone, formatter)
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

function instantToFloatingDate(date: Date, timezone: string): Date {
  const parts = zonedDateParts(date, timezone)
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    date.getUTCMilliseconds(),
  ))
}

function floatingDateToInstant(date: Date, timezone: string): Date {
  const wallTime = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  )
  let candidate = wallTime
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = zonedDateParts(new Date(candidate), timezone)
    const representedWallTime = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      date.getUTCMilliseconds(),
    )
    const adjustment = wallTime - representedWallTime
    candidate += adjustment
    if (adjustment === 0) break
  }
  return new Date(candidate)
}

export function nextOccurrenceIso(
  rrule: string,
  after: Date,
  createdAtIso: string,
  timezone = DEFAULT_AUTOMATION_TIME_ZONE,
): string {
  const normalizedTimeZone = normalizeTimeZone(timezone)
  const createdAt = new Date(createdAtIso)
  const dtstart = instantToFloatingDate(
    Number.isFinite(createdAt.getTime()) ? createdAt : after,
    normalizedTimeZone,
  )
  const rule = rrulestr(`RRULE:${normalizeRrule(rrule)}`, {
    dtstart,
  })
  const nextFloating = rule.after(instantToFloatingDate(after, normalizedTimeZone), false)
  return nextFloating ? floatingDateToInstant(nextFloating, normalizedTimeZone).toISOString() : ''
}

function nextRunForDraft(draft: AutomationDraft, after: Date, createdAtIso: string): string {
  if (draft.scheduleType === 'once') {
    const runAt = new Date(draft.runAtIso)
    return Number.isFinite(runAt.getTime()) && runAt.getTime() > after.getTime()
      ? runAt.toISOString()
      : ''
  }
  return nextOccurrenceIso(draft.rrule, after, createdAtIso, draft.timezone)
}

function isOneTimeSchedule(task: AutomationTask): boolean {
  return task.scheduleType === 'once' || /(?:^|;)COUNT=1(?:;|$)/iu.test(task.rrule)
}

export class AutomationStore {
  private readonly stateFilePath: string
  private readonly sessionsDirectoryPath: string
  private readonly now: () => Date
  private operationQueue: Promise<void> = Promise.resolve()
  private attemptedLegacyAnchorRecovery = false

  constructor(options: AutomationStoreOptions) {
    this.stateFilePath = options.stateFilePath
    this.sessionsDirectoryPath = options.sessionsDirectoryPath ?? ''
    this.now = options.now ?? (() => new Date())
  }

  read(): Promise<AutomationSnapshot> {
    return this.enqueue(() => this.load())
  }

  create(draftValue: unknown): Promise<AutomationSnapshot> {
    return this.mutate((current) => {
      const draft = normalizeDraft(draftValue)
      validateDraft(draft)
      const now = this.now()
      const task = createTask(draft, now)
      return { ...current, tasks: [task, ...current.tasks] }
    })
  }

  confirmDirectCreate(threadId: string, turnId: string, draftValue: unknown): Promise<AutomationSnapshot> {
    return this.mutate((current) => {
      const draft = normalizeDraft(draftValue)
      validateDraft(draft)
      const key = draftKey(draft)
      const pendingProposal = current.proposals.find((proposal) =>
        proposal.threadId === threadId
        && proposal.action === 'create'
        && proposal.status === 'pending'
        && draftKey(proposal.draft) === key,
      )
      const existingAcceptedProposal = current.proposals.find((proposal) =>
        proposal.threadId === threadId
        && proposal.action === 'create'
        && proposal.status === 'accepted'
        && draftKey(proposal.draft) === key
        && current.tasks.some((task) => task.id === proposal.resolvedAutomationId),
      )
      if (existingAcceptedProposal) return current

      const legacyDirectTask = pendingProposal
        ? current.tasks.find((task) =>
          taskMatchesDraft(task, draft) && taskWasSavedAfterProposal(task, pendingProposal),
        )
        : undefined
      const now = this.now()
      const task = legacyDirectTask ?? createTask(draft, now)
      const tasks = legacyDirectTask ? current.tasks : [task, ...current.tasks]
      const proposals = pendingProposal
        ? current.proposals.map((proposal) =>
          proposal.id === pendingProposal.id
            ? { ...proposal, status: 'accepted' as const, resolvedAutomationId: task.id }
            : proposal,
        )
        : [{
          id: randomUUID(),
          action: 'create' as const,
          automationId: '',
          resolvedAutomationId: task.id,
          threadId,
          turnId,
          draft,
          createdAtIso: now.toISOString(),
          status: 'accepted' as const,
        }, ...current.proposals].slice(0, MAX_PROPOSALS)

      return { ...current, tasks, proposals }
    })
  }

  update(id: string, changesValue: unknown): Promise<AutomationSnapshot> {
    return this.mutate((current) => {
      const index = current.tasks.findIndex((task) => task.id === id)
      if (index < 0) throw new Error('Scheduled task not found.')
      const existing = current.tasks[index]
      const changes = asRecord(changesValue) ?? {}
      const draft = normalizeDraft({ ...existing, ...changes })
      validateDraft(draft)
      const now = this.now()
      const scheduleChanged =
        draft.scheduleType !== existing.scheduleType
        || draft.rrule !== existing.rrule
        || draft.runAtIso !== existing.runAtIso
        || draft.timezone !== existing.timezone
        || draft.status !== existing.status
      const nextRunAtIso = draft.status === 'ACTIVE'
        ? scheduleChanged
          ? nextRunForDraft(draft, now, existing.createdAtIso)
          : existing.nextRunAtIso || nextRunForDraft(draft, now, existing.createdAtIso)
        : ''
      if (draft.status === 'ACTIVE' && !nextRunAtIso) {
        throw new Error('The next run must be in the future.')
      }
      const task: AutomationTask = {
        ...existing,
        ...draft,
        updatedAtIso: now.toISOString(),
        nextRunAtIso,
      }
      const tasks = [...current.tasks]
      tasks.splice(index, 1, task)
      return { ...current, tasks }
    })
  }

  delete(id: string): Promise<AutomationSnapshot> {
    return this.mutate((current) => ({
      ...current,
      tasks: current.tasks.filter((task) => task.id !== id),
      proposals: current.proposals.filter((proposal) => proposal.automationId !== id),
    }))
  }

  createProposal(
    action: 'create' | 'update',
    threadId: string,
    turnId: string,
    automationId: string,
    draft: unknown,
  ): Promise<AutomationSnapshot> {
    return this.mutate((current) => {
      const proposal: AutomationProposal = {
        id: randomUUID(),
        action,
        automationId,
        resolvedAutomationId: '',
        threadId,
        turnId,
        draft: normalizeDraft(draft),
        createdAtIso: this.now().toISOString(),
        status: 'pending',
      }
      return {
        ...current,
        proposals: [proposal, ...current.proposals].slice(0, MAX_PROPOSALS),
      }
    })
  }

  resolveProposal(id: string, accept: boolean): Promise<AutomationSnapshot> {
    return this.mutate((current) => {
      const proposal = current.proposals.find((entry) => entry.id === id)
      if (!proposal || proposal.status !== 'pending') throw new Error('Task proposal is no longer pending.')

      let tasks = current.tasks
      let resolvedAutomationId = proposal.automationId
      if (accept) {
        const draft = normalizeDraft(proposal.draft)
        validateDraft(draft)

        const now = this.now()
        if (proposal.action === 'create') {
          const task = createTask(draft, now)
          resolvedAutomationId = task.id
          tasks = [task, ...tasks]
        } else {
          const index = tasks.findIndex((task) => task.id === proposal.automationId)
          if (index < 0) throw new Error('Scheduled task not found.')
          const existing = tasks[index]
          const nextRunAtIso = draft.status === 'ACTIVE'
            ? nextRunForDraft(draft, now, existing.createdAtIso)
            : ''
          if (draft.status === 'ACTIVE' && !nextRunAtIso) {
            throw new Error('The next run must be in the future.')
          }
          const task: AutomationTask = {
            ...existing,
            ...draft,
            updatedAtIso: now.toISOString(),
            nextRunAtIso,
          }
          tasks = [...tasks]
          tasks.splice(index, 1, task)
        }
      }

      return {
        ...current,
        tasks,
        proposals: current.proposals.map((entry) =>
          entry.id === id
            ? {
              ...entry,
              resolvedAutomationId: accept ? resolvedAutomationId : '',
              status: accept ? 'accepted' : 'dismissed',
            }
            : entry,
        ),
      }
    })
  }

  startRun(task: AutomationTask, trigger: 'schedule' | 'manual'): Promise<{ snapshot: AutomationSnapshot; run: AutomationRun }> {
    let createdRun!: AutomationRun
    return this.mutate((current) => {
      const now = this.now()
      createdRun = {
        id: randomUUID(),
        automationId: task.id,
        automationName: task.name,
        status: 'running',
        trigger,
        threadId: '',
        startedAtIso: now.toISOString(),
        finishedAtIso: '',
        error: '',
        unread: false,
        archived: false,
      }
      return {
        ...current,
        tasks: current.tasks.map((entry) =>
          entry.id === task.id
            ? {
              ...entry,
              lastRunAtIso: now.toISOString(),
              status:
                trigger === 'schedule' && isOneTimeSchedule(entry)
                  ? 'PAUSED'
                  : entry.status,
              nextRunAtIso:
                trigger === 'schedule' && entry.status === 'ACTIVE'
                  ? isOneTimeSchedule(entry)
                    ? ''
                    : nextOccurrenceIso(entry.rrule, now, entry.createdAtIso, entry.timezone)
                  : entry.nextRunAtIso,
            }
            : entry,
        ),
        runs: [createdRun, ...current.runs].slice(0, MAX_RUNS),
      }
    }).then((snapshot) => ({ snapshot, run: createdRun }))
  }

  updateRun(
    runId: string,
    changes: Partial<Pick<AutomationRun, 'status' | 'threadId' | 'finishedAtIso' | 'error' | 'unread' | 'archived'>>,
  ): Promise<AutomationSnapshot> {
    return this.mutate((current) => ({
      ...current,
      runs: current.runs.map((run) => run.id === runId ? { ...run, ...changes } : run),
    }))
  }

  recoverInterruptedRuns(): Promise<AutomationSnapshot> {
    return this.mutate((current) => {
      const nowDate = this.now()
      const now = nowDate.toISOString()
      const tasks = current.schemaVersion < 2
        ? current.tasks.map((task) => ({
          ...task,
          timezone: DEFAULT_AUTOMATION_TIME_ZONE,
          nextRunAtIso:
            task.status === 'ACTIVE'
              ? nextOccurrenceIso(
                task.rrule,
                nowDate,
                task.createdAtIso,
                DEFAULT_AUTOMATION_TIME_ZONE,
              )
              : '',
        }))
        : current.tasks
      const proposals = current.proposals.map((proposal) => {
        if (proposal.status !== 'pending') return proposal
        const task = proposal.action === 'create'
          ? tasks.find((entry) =>
            taskMatchesDraft(entry, normalizeDraft(proposal.draft))
            && taskWasSavedAfterProposal(entry, proposal),
          )
          : tasks.find((entry) =>
            entry.id === proposal.automationId
            && taskMatchesDraft(entry, normalizeDraft(proposal.draft))
            && Date.parse(entry.updatedAtIso) >= Date.parse(proposal.createdAtIso),
          )
        return task
          ? { ...proposal, status: 'accepted' as const, resolvedAutomationId: task.id }
          : proposal
      })
      return {
        ...current,
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        tasks,
        proposals,
        runs: current.runs.map((run) =>
          run.status === 'running' || run.status === 'queued'
            ? { ...run, status: 'interrupted', finishedAtIso: now, error: 'CodexUI restarted before this run finished.', unread: true }
            : run,
        ),
      }
    })
  }

  private mutate(mutator: (current: AutomationSnapshot) => AutomationSnapshot): Promise<AutomationSnapshot> {
    return this.enqueue(async () => {
      const current = await this.load()
      const next = mutator(current)
      const versioned = {
        ...next,
        version: current.version + 1,
        updatedAtIso: this.now().toISOString(),
      }
      await this.write(versioned)
      return versioned
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.operationQueue.then(operation)
    this.operationQueue = queued.then(() => undefined, () => undefined)
    return queued
  }

  private async load(): Promise<AutomationSnapshot> {
    try {
      const raw = await readFile(this.stateFilePath, 'utf8')
      let state = normalizeSnapshot(JSON.parse(raw), this.now())
      if (!state) throw new Error('CodexUI scheduled task state is invalid.')
      if (!this.attemptedLegacyAnchorRecovery && this.sessionsDirectoryPath) {
        this.attemptedLegacyAnchorRecovery = true
        const recovered = await recoverLegacyProposalTurnIds(state, this.sessionsDirectoryPath)
        if (recovered !== state) {
          state = {
            ...recovered,
            version: state.version + 1,
            updatedAtIso: this.now().toISOString(),
          }
          await this.write(state)
        }
      }
      return state
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    const state = emptySnapshot(this.now())
    await this.write(state)
    return state
  }

  private async write(state: AutomationSnapshot): Promise<void> {
    const temporaryPath = `${this.stateFilePath}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.stateFilePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
