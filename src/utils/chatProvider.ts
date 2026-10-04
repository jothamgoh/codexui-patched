export type ChatProvider = 'openai' | 'anthropic'

/** Claude Code chats are served under `claude-<session id>`. */
export function isClaudeThreadId(threadId: string | null | undefined): boolean {
  return typeof threadId === 'string' && threadId.startsWith('claude-')
}

export function providerForThreadId(threadId: string | null | undefined): ChatProvider {
  return isClaudeThreadId(threadId) ? 'anthropic' : 'openai'
}

export function providerForModelId(
  modelId: string,
  models: ReadonlyArray<{ id: string; provider: ChatProvider }>,
): ChatProvider {
  return models.find((model) => model.id === modelId)?.provider
    ?? (modelId.startsWith('claude-') ? 'anthropic' : 'openai')
}
