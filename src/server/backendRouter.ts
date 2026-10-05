import { isClaudeModelId, isClaudeThreadId } from './claudeBackend'

type Notification = { method: string; params: unknown }
type NotificationListener = (notification: Notification) => void

/** The Codex app-server surface the HTTP bridge uses. */
export type CodexBackend<PendingRequest> = {
  rpc(method: string, params: unknown): Promise<unknown>
  onNotification(listener: NotificationListener): () => void
  respondToServerRequest(payload: unknown): Promise<void>
  listPendingServerRequests(): PendingRequest[]
  publishLocalNotification(method: string, params: unknown): void
  reserveReviewMutation(): () => void
  dispose(): void
}

/** The Claude Code surface, speaking the same protocol for `claude-` chats. */
export type ClaudeRouteTarget = {
  rpc(method: string, params: unknown): Promise<unknown>
  onNotification(listener: NotificationListener): () => void
  listThreads(params: unknown): Promise<Array<Record<string, unknown>>>
  listModels(): Promise<Array<Record<string, unknown>>>
  searchThreads(params: unknown): Promise<Array<{ thread: Record<string, unknown>; snippet: string }>>
  listSkills(cwd: string): Promise<unknown>
  listPendingServerRequests(): Array<{ id: number; method: string; params: unknown; receivedAtIso: string }>
  ownsServerRequest(id: unknown): boolean
  respondToServerRequest(payload: unknown): Promise<void>
  dispose(): void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readUpdatedAt(thread: unknown): number {
  const value = asRecord(thread)?.updatedAt
  return typeof value === 'number' ? value : 0
}

const GPT_6_1_SOL_MODEL = {
  id: 'gpt-6.1-sol',
  model: 'gpt-6.1-sol',
  displayName: 'GPT-6.1-Sol',
  description: 'Near-Astra performance for complex work at a lower cost.',
  modelProvider: 'openai',
  isDefault: false,
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((reasoningEffort) => ({ reasoningEffort })),
  defaultReasoningEffort: 'medium',
}

/**
 * Sends each request to Codex or Claude. Requests about a `claude-` chat, and
 * new chats started with a Claude model, go to Claude; chat lists, search and
 * model lists merge both; everything else stays with Codex.
 */
export class BackendRouter<PendingRequest> implements CodexBackend<PendingRequest> {
  constructor(
    private readonly codex: CodexBackend<PendingRequest>,
    private readonly claude: ClaudeRouteTarget,
  ) {}

  async rpc(method: string, params: unknown): Promise<unknown> {
    const request = asRecord(params)
    if (isClaudeThreadId(request?.threadId)) return this.claude.rpc(method, params)
    if (method === 'thread/start' && isClaudeModelId(request?.model)) return this.claude.rpc(method, params)
    if (method === 'thread/list' && isClaudeThreadId(request?.ancestorThreadId)) {
      return { data: [], nextCursor: null }
    }
    if (method === 'skills/list' && request?.provider === 'claude') {
      const cwds = Array.isArray(request.cwds) ? request.cwds.filter((cwd): cwd is string => typeof cwd === 'string') : []
      return this.claude.listSkills(cwds[0] ?? '')
    }
    if (method === 'thread/list') return this.listThreads(params)
    if (method === 'thread/search') return this.searchThreads(params)
    if (method === 'model/list') return this.listModels(params)
    try {
      return await this.codex.rpc(method, params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (method !== 'thread/read' || !request?.threadId || !/thread not loaded/iu.test(message)) throw error
      // State-db rows can outlive the app-server's in-memory thread registry.
      // Native clients resume a saved thread before reading its transcript.
      await this.codex.rpc('thread/resume', { threadId: request.threadId, excludeTurns: true })
      return this.codex.rpc(method, params)
    }
  }

  /** One backend failing must not hide the other's chats or models. */
  private async readCodexList(method: string, params: unknown): Promise<Record<string, unknown>> {
    try {
      return asRecord(await this.codex.rpc(method, params)) ?? {}
    } catch (error) {
      console.warn(`[codex-bridge] ${method} failed:`, error instanceof Error ? error.message : error)
      return { data: [], nextCursor: null }
    }
  }

  private async listThreads(params: unknown): Promise<unknown> {
    const request = asRecord(params)
    // Claude has no Codex subagent ancestry metadata. Keep source-filtered and
    // cursor pages native to Codex; Claude chats join only the main first page.
    if (request?.cursor || Array.isArray(request?.sourceKinds) || request?.ancestorThreadId) {
      return this.readCodexList('thread/list', params)
    }
    const [codexResult, claudeThreads] = await Promise.all([
      this.readCodexList('thread/list', params),
      this.claude.listThreads(params).catch((error: unknown) => {
        console.warn('[claude-backend] Failed to list Claude chats:', error instanceof Error ? error.message : error)
        return [] as Array<Record<string, unknown>>
      }),
    ])
    const codexThreads = Array.isArray(codexResult.data) ? codexResult.data : []
    const data = [...codexThreads, ...claudeThreads].sort((a, b) => readUpdatedAt(b) - readUpdatedAt(a))
    return { ...codexResult, data }
  }

  private async searchThreads(params: unknown): Promise<unknown> {
    const [codexResult, claudeResults] = await Promise.all([
      this.readCodexList('thread/search', params),
      this.claude.searchThreads(params).catch((error: unknown) => {
        console.warn('[claude-backend] Failed to search Claude chats:', error instanceof Error ? error.message : error)
        return []
      }),
    ])
    const codexRows = Array.isArray(codexResult.data) ? codexResult.data : []
    const limit = typeof asRecord(params)?.limit === 'number' ? asRecord(params)?.limit as number : 50
    const data = [...codexRows, ...claudeResults]
      .sort((a, b) => readUpdatedAt(asRecord(b)?.thread) - readUpdatedAt(asRecord(a)?.thread))
      .slice(0, limit)
    return { ...codexResult, data }
  }

  private async listModels(params: unknown): Promise<unknown> {
    const [codexResult, claudeModels] = await Promise.all([
      this.readCodexList('model/list', params),
      this.claude.listModels().catch((error: unknown) => {
        console.warn('[claude-backend] Failed to list Claude models:', error instanceof Error ? error.message : error)
        return [] as Array<Record<string, unknown>>
      }),
    ])
    const codexModels = Array.isArray(codexResult.data) ? codexResult.data : []
    const hasGpt61Sol = codexModels.some((model) => {
      const record = asRecord(model)
      return record?.id === GPT_6_1_SOL_MODEL.id || record?.model === GPT_6_1_SOL_MODEL.model
    })
    return {
      ...codexResult,
      data: [...codexModels, ...(hasGpt61Sol ? [] : [GPT_6_1_SOL_MODEL]), ...claudeModels],
    }
  }

  onNotification(listener: NotificationListener): () => void {
    const unsubscribeCodex = this.codex.onNotification(listener)
    const unsubscribeClaude = this.claude.onNotification(listener)
    return () => {
      unsubscribeCodex()
      unsubscribeClaude()
    }
  }

  respondToServerRequest(payload: unknown): Promise<void> {
    if (this.claude.ownsServerRequest(asRecord(payload)?.id)) return this.claude.respondToServerRequest(payload)
    return this.codex.respondToServerRequest(payload)
  }

  listPendingServerRequests(): PendingRequest[] {
    return [
      ...this.codex.listPendingServerRequests(),
      ...this.claude.listPendingServerRequests() as unknown as PendingRequest[],
    ]
  }

  publishLocalNotification(method: string, params: unknown): void {
    this.codex.publishLocalNotification(method, params)
  }

  reserveReviewMutation(): () => void {
    return this.codex.reserveReviewMutation()
  }

  dispose(): void {
    this.codex.dispose()
    this.claude.dispose()
  }
}
