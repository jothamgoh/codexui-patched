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

/**
 * Sends each request to Codex or Claude. Requests about a `claude-` chat, and
 * new chats started with a Claude model, go to Claude; chat and model lists
 * merge both; everything else stays with Codex.
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
    if (method === 'thread/list') return this.listThreads(params)
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
    const codexResult = await this.readCodexList('thread/list', params)
    // Claude chats join the first page only; Codex's cursor pages its own list.
    if (asRecord(params)?.cursor) return codexResult
    let claudeThreads: Array<Record<string, unknown>> = []
    try {
      claudeThreads = await this.claude.listThreads(params)
    } catch (error) {
      console.warn('[claude-backend] Failed to list Claude chats:', error instanceof Error ? error.message : error)
    }
    const codexThreads = Array.isArray(codexResult.data) ? codexResult.data : []
    const data = [...codexThreads, ...claudeThreads].sort((a, b) => readUpdatedAt(b) - readUpdatedAt(a))
    return { ...codexResult, data }
  }

  private async listModels(params: unknown): Promise<unknown> {
    const codexResult = await this.readCodexList('model/list', params)
    const codexModels = Array.isArray(codexResult.data) ? codexResult.data : []
    let claudeModels: Array<Record<string, unknown>> = []
    try {
      claudeModels = await this.claude.listModels()
    } catch (error) {
      console.warn('[claude-backend] Failed to list Claude models:', error instanceof Error ? error.message : error)
    }
    return { ...codexResult, data: [...codexModels, ...claudeModels] }
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
    return this.codex.respondToServerRequest(payload)
  }

  listPendingServerRequests(): PendingRequest[] {
    return this.codex.listPendingServerRequests()
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
