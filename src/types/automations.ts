import type { ReasoningEffort } from './codex'

export const DEFAULT_AUTOMATION_TIME_ZONE = 'Asia/Singapore'

export type AutomationStatus = 'ACTIVE' | 'PAUSED'
export type AutomationKind = 'heartbeat' | 'cron'
export type AutomationScheduleType = 'recurring' | 'once'
export type AutomationExecutionEnvironment = 'local' | 'worktree'
export type AutomationNotificationPolicy = 'always' | 'failure' | 'never'
export type AutomationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'

export type AutomationTask = {
  id: string
  name: string
  prompt: string
  status: AutomationStatus
  kind: AutomationKind
  scheduleType: AutomationScheduleType
  rrule: string
  runAtIso: string
  cwd: string
  targetThreadId: string
  executionEnvironment: AutomationExecutionEnvironment
  model: string
  reasoningEffort: ReasoningEffort
  notificationPolicy: AutomationNotificationPolicy
  timezone: string
  createdAtIso: string
  updatedAtIso: string
  nextRunAtIso: string
  lastRunAtIso: string
}

export type AutomationRun = {
  id: string
  automationId: string
  automationName: string
  status: AutomationRunStatus
  trigger: 'schedule' | 'manual'
  threadId: string
  startedAtIso: string
  finishedAtIso: string
  error: string
  unread: boolean
  archived: boolean
}

export type AutomationDraft = {
  name: string
  prompt: string
  status: AutomationStatus
  kind: AutomationKind
  scheduleType: AutomationScheduleType
  rrule: string
  runAtIso: string
  cwd: string
  targetThreadId: string
  executionEnvironment: AutomationExecutionEnvironment
  model: string
  reasoningEffort: ReasoningEffort
  notificationPolicy: AutomationNotificationPolicy
  timezone: string
}

export type AutomationProposal = {
  id: string
  action: 'create' | 'update'
  automationId: string
  resolvedAutomationId: string
  threadId: string
  turnId: string
  draft: Partial<AutomationDraft>
  createdAtIso: string
  status: 'pending' | 'accepted' | 'dismissed'
}

export type AutomationSnapshot = {
  tasks: AutomationTask[]
  runs: AutomationRun[]
  proposals: AutomationProposal[]
  schemaVersion: number
  version: number
  updatedAtIso: string
}
