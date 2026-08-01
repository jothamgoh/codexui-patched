import type { AutomationSnapshot, AutomationTask } from '../types/automations'
import { AutomationStore } from './automationStore'

type RpcClient = {
  rpc: (method: string, params: unknown) => Promise<unknown>
  publishLocalNotification: (method: string, params: unknown) => void
}

type AutomationServiceOptions = {
  store: AutomationStore
  appServer: RpcClient
  createWorktree: (cwd: string) => Promise<string>
  dynamicToolSpec: Record<string, unknown>
  now?: () => Date
}

const TICK_INTERVAL_MS = 15_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readThreadId(payload: unknown): string {
  const record = asRecord(payload)
  return readString(asRecord(record?.thread)?.id) || readString(record?.threadId)
}

function readTurnStatus(params: unknown): string {
  const record = asRecord(params)
  return readString(asRecord(record?.turn)?.status) || readString(record?.status)
}

function readThreadIdFromNotification(params: unknown): string {
  const record = asRecord(params)
  return readString(record?.threadId) || readString(asRecord(record?.thread)?.id)
}

function dynamicToolText(text: string): { contentItems: Array<{ type: 'inputText'; text: string }>; success: boolean } {
  return { contentItems: [{ type: 'inputText', text }], success: true }
}

export const AUTOMATION_DYNAMIC_TOOL_SPEC = {
  name: 'automation_update',
  description:
    'Create, propose, edit, pause, resume, delete, or view scheduled tasks. Use suggest_create/suggest_update when the user has not explicitly confirmed the exact task. Use create/update/delete only after an explicit request or confirmation. When the user confirms an existing suggestion, call create/update with the same task details so the proposal becomes the confirmed task; do not propose it again.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'suggest_create', 'update', 'suggest_update', 'delete', 'view'],
      },
      automationId: { type: 'string' },
      task: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string' },
          status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
          kind: { type: 'string', enum: ['heartbeat', 'cron'] },
          scheduleType: {
            type: 'string',
            enum: ['recurring', 'once'],
            description: 'Use recurring for an RRULE schedule or once for one exact run.',
          },
          rrule: {
            type: 'string',
            description: 'For recurring tasks, an RFC 5545 RRULE without the RRULE: prefix. Wall-clock hours and weekdays are Singapore time (Asia/Singapore, GMT+8), for example FREQ=DAILY;BYHOUR=9;BYMINUTE=0.',
          },
          runAtIso: {
            type: 'string',
            description: 'For one-time tasks, the exact future ISO 8601 date-time to run, including an offset.',
          },
          cwd: { type: 'string' },
          targetThreadId: { type: 'string' },
          executionEnvironment: { type: 'string', enum: ['local', 'worktree'] },
          model: { type: 'string' },
          reasoningEffort: {
            type: 'string',
            enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          },
          notificationPolicy: { type: 'string', enum: ['always', 'failure', 'never'] },
          timezone: { type: 'string' },
        },
      },
    },
  },
} satisfies Record<string, unknown>

export class AutomationService {
  private readonly store: AutomationStore
  private readonly appServer: RpcClient
  private readonly createWorktree: (cwd: string) => Promise<string>
  private readonly dynamicToolSpec: Record<string, unknown>
  private readonly now: () => Date
  private readonly runContextByThreadId = new Map<string, { runId: string; task: AutomationTask }>()
  private readonly activeAutomationIds = new Set<string>()
  private tickTimer: NodeJS.Timeout | null = null
  private tickInProgress = false

  constructor(options: AutomationServiceOptions) {
    this.store = options.store
    this.appServer = options.appServer
    this.createWorktree = options.createWorktree
    this.dynamicToolSpec = options.dynamicToolSpec
    this.now = options.now ?? (() => new Date())
  }

  async start(): Promise<void> {
    if (this.tickTimer) return
    const snapshot = await this.store.recoverInterruptedRuns()
    this.publish(snapshot)
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
    this.tickTimer.unref()
    void this.tick()
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  async read(): Promise<AutomationSnapshot> {
    return this.store.read()
  }

  async create(draft: unknown): Promise<AutomationSnapshot> {
    return this.publish(await this.store.create(draft))
  }

  async update(id: string, changes: unknown): Promise<AutomationSnapshot> {
    return this.publish(await this.store.update(id, changes))
  }

  async delete(id: string): Promise<AutomationSnapshot> {
    return this.publish(await this.store.delete(id))
  }

  async resolveProposal(id: string, accept: boolean): Promise<AutomationSnapshot> {
    return this.publish(await this.store.resolveProposal(id, accept))
  }

  async runNow(id: string): Promise<AutomationSnapshot> {
    const snapshot = await this.store.read()
    const task = snapshot.tasks.find((entry) => entry.id === id)
    if (!task) throw new Error('Scheduled task not found.')
    void this.execute(task, 'manual')
    return snapshot
  }

  async updateRun(id: string, changes: { unread?: boolean; archived?: boolean }): Promise<AutomationSnapshot> {
    return this.publish(await this.store.updateRun(id, changes))
  }

  augmentThreadStartParams(params: unknown): Record<string, unknown> {
    const record = asRecord(params) ?? {}
    const currentTools = Array.isArray(record.dynamicTools) ? record.dynamicTools : []
    const tools = currentTools.filter((entry) => asRecord(entry)?.name !== 'automation_update')
    return {
      ...record,
      dynamicTools: [...tools, this.dynamicToolSpec],
      developerInstructions: [
        readString(record.developerInstructions),
        'You can manage scheduled tasks with automation_update. For an unconfirmed or ambiguous schedule, propose it first. Existing-chat tasks use kind heartbeat and the current thread ID. New-chat project tasks use kind cron and a cwd. Use scheduleType recurring plus an RRULE for repeating work. Use scheduleType once plus runAtIso for a one-time task. Interpret RRULE wall-clock time and one-time requests in Singapore time (Asia/Singapore, GMT+8).',
      ].filter(Boolean).join('\n\n'),
    }
  }

  async handleDynamicToolCall(paramsValue: unknown): Promise<unknown> {
    const params = asRecord(paramsValue) ?? {}
    const args = asRecord(params.arguments) ?? {}
    const action = readString(args.action)
    const automationId = readString(args.automationId)
    const threadId = readString(params.threadId)
    const turnId = readString(params.turnId)
    const rawTask = asRecord(args.task) ?? {}
    const task = {
      ...rawTask,
      ...(rawTask.kind === 'heartbeat' && !readString(rawTask.targetThreadId) ? { targetThreadId: threadId } : {}),
    }

    if (action === 'view') {
      const snapshot = await this.store.read()
      return dynamicToolText(JSON.stringify({
        tasks: snapshot.tasks.map(({ id, name, status, kind, scheduleType, rrule, runAtIso, nextRunAtIso }) => ({
          id, name, status, kind, scheduleType, rrule, runAtIso, nextRunAtIso,
        })),
      }))
    }
    if (action === 'suggest_create' || action === 'suggest_update') {
      const snapshot = await this.store.createProposal(
        action === 'suggest_update' ? 'update' : 'create',
        threadId,
        turnId,
        automationId,
        task,
      )
      this.publish(snapshot)
      const proposal = snapshot.proposals[0]
      return dynamicToolText(`Proposed scheduled task ${proposal.id}. The user can review and confirm it inline.`)
    }
    if (action === 'create') {
      const snapshot = this.publish(await this.store.confirmDirectCreate(threadId, turnId, task))
      const created = snapshot.proposals
        .find((proposal) =>
          proposal.threadId === threadId
          && proposal.action === 'create'
          && proposal.status === 'accepted',
        )
      const savedTask = snapshot.tasks.find((entry) => entry.id === created?.resolvedAutomationId)
      return dynamicToolText(`Created scheduled task "${savedTask?.name ?? 'Scheduled task'}".`)
    }
    if (action === 'update') {
      if (!automationId) throw new Error('automationId is required for update.')
      const snapshot = await this.update(automationId, task)
      const updated = snapshot.tasks.find((entry) => entry.id === automationId)
      return dynamicToolText(`Updated scheduled task "${updated?.name ?? automationId}".`)
    }
    if (action === 'delete') {
      if (!automationId) throw new Error('automationId is required for delete.')
      await this.delete(automationId)
      return dynamicToolText('Deleted the scheduled task.')
    }
    throw new Error(`Unsupported automation action: ${action || '(missing)'}`)
  }

  async handleNotification(notification: { method: string; params: unknown }): Promise<void> {
    if (notification.method !== 'turn/completed') return
    const threadId = readThreadIdFromNotification(notification.params)
    const context = this.runContextByThreadId.get(threadId)
    if (!threadId || !context) return
    const params = asRecord(notification.params)
    if (params) {
      params.codexuiAutomation = {
        id: context.task.id,
        name: context.task.name,
        runId: context.runId,
        notificationPolicy: context.task.notificationPolicy,
      }
    }
    const runId = context.runId
    this.runContextByThreadId.delete(threadId)
    const status = readTurnStatus(notification.params)
    const succeeded = !status || status === 'completed'
    const snapshot = await this.store.updateRun(runId, {
      status: succeeded ? 'succeeded' : 'failed',
      finishedAtIso: this.now().toISOString(),
      error: succeeded ? '' : `Codex turn ended with status ${status}.`,
      unread: true,
    })
    const run = snapshot.runs.find((entry) => entry.id === runId)
    if (run) this.activeAutomationIds.delete(run.automationId)
    this.publish(snapshot)
  }

  private async tick(): Promise<void> {
    if (this.tickInProgress) return
    this.tickInProgress = true
    try {
      const snapshot = await this.store.read()
      const now = this.now().getTime()
      const due = snapshot.tasks.filter((task) => {
        const nextRunAt = Date.parse(task.nextRunAtIso)
        return task.status === 'ACTIVE' && Number.isFinite(nextRunAt) && nextRunAt <= now
      })
      for (const task of due) {
        void this.execute(task, 'schedule')
      }
    } finally {
      this.tickInProgress = false
    }
  }

  private async execute(task: AutomationTask, trigger: 'schedule' | 'manual'): Promise<void> {
    if (this.activeAutomationIds.has(task.id)) return
    this.activeAutomationIds.add(task.id)
    const { snapshot: startedSnapshot, run } = await this.store.startRun(task, trigger)
    this.publish(startedSnapshot)

    try {
      let threadId = task.targetThreadId
      if (task.kind === 'heartbeat') {
        await this.appServer.rpc('thread/resume', {
          threadId,
          persistExtendedHistory: true,
        }).catch(() => undefined)
      } else {
        const cwd =
          task.executionEnvironment === 'worktree'
            ? await this.createWorktree(task.cwd)
            : task.cwd
        const startResult = await this.appServer.rpc('thread/start', this.augmentThreadStartParams({
          cwd,
          ...(task.model ? { model: task.model } : {}),
        }))
        threadId = readThreadId(startResult)
      }
      if (!threadId) throw new Error('The scheduled run could not create or resume a chat.')

      this.runContextByThreadId.set(threadId, { runId: run.id, task })
      await this.store.updateRun(run.id, { threadId })
      await this.appServer.rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text: task.prompt }],
        ...(task.model ? { model: task.model } : {}),
        ...(task.reasoningEffort ? { effort: task.reasoningEffort } : {}),
      })
    } catch (error) {
      this.activeAutomationIds.delete(task.id)
      for (const [threadId, context] of this.runContextByThreadId) {
        if (context.runId === run.id) this.runContextByThreadId.delete(threadId)
      }
      const snapshot = await this.store.updateRun(run.id, {
        status: 'failed',
        finishedAtIso: this.now().toISOString(),
        error: error instanceof Error ? error.message : 'Scheduled run failed.',
        unread: true,
      })
      this.publish(snapshot)
    }
  }

  private publish(snapshot: AutomationSnapshot): AutomationSnapshot {
    this.appServer.publishLocalNotification('codexui/automations/updated', snapshot)
    return snapshot
  }
}
