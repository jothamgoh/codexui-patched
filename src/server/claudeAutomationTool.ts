import { z } from 'zod'
import { AUTOMATION_DYNAMIC_TOOL_SPEC } from './automationService'
import type { ClaudeHostTool } from './claudeBackend'

/**
 * The scheduled-task tool Codex chats get as a dynamic tool, offered to
 * Claude chats as an in-process MCP tool with the same contract.
 */
const AUTOMATION_TOOL_SHAPE = {
  action: z.enum(['create', 'suggest_create', 'update', 'suggest_update', 'delete', 'view']),
  automationId: z.string().optional(),
  task: z.object({
    name: z.string().optional(),
    prompt: z.string().optional(),
    status: z.enum(['ACTIVE', 'PAUSED']).optional(),
    kind: z.enum(['heartbeat', 'cron']).optional()
      .describe('heartbeat runs in this chat; cron starts a new chat in a project folder.'),
    scheduleType: z.enum(['recurring', 'once']).optional()
      .describe('Use recurring for an RRULE schedule or once for one exact run.'),
    rrule: z.string().optional()
      .describe('For recurring tasks, an RFC 5545 RRULE without the RRULE: prefix. Wall-clock hours and weekdays are Singapore time (Asia/Singapore, GMT+8), for example FREQ=DAILY;BYHOUR=9;BYMINUTE=0.'),
    runAtIso: z.string().optional()
      .describe('For one-time tasks, the exact future ISO 8601 date-time to run, including an offset.'),
    cwd: z.string().optional(),
    targetThreadId: z.string().optional(),
    executionEnvironment: z.enum(['local', 'worktree']).optional(),
    model: z.string().optional(),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    notificationPolicy: z.enum(['always', 'failure', 'never']).optional(),
    timezone: z.string().optional(),
  }).optional(),
}

type DynamicToolHandler = (params: unknown) => Promise<unknown>

function readToolText(result: unknown): string {
  const items = (result as { contentItems?: Array<{ text?: unknown }> } | null)?.contentItems
  return Array.isArray(items) ? items.map((item) => (typeof item.text === 'string' ? item.text : '')).join('\n') : ''
}

export function createClaudeAutomationTool(handle: () => DynamicToolHandler): ClaudeHostTool {
  return {
    name: 'automation_update',
    description: `${AUTOMATION_DYNAMIC_TOOL_SPEC.description} Existing-chat tasks use kind heartbeat and this chat. New-chat project tasks use kind cron and a cwd; they use this chat's Claude model unless another model is given.`,
    shape: AUTOMATION_TOOL_SHAPE,
    async handler(context, args) {
      const task = args.task !== null && typeof args.task === 'object' ? args.task as Record<string, unknown> : null
      const withModel = task && task.kind === 'cron' && !task.model && context.model
        ? { ...args, task: { ...task, model: context.model } }
        : args
      return readToolText(await handle()({ threadId: context.threadId, turnId: context.turnId, arguments: withModel }))
    },
  }
}
