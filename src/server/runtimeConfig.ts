const REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
])

export type CodexUiRuntimeConfig = {
  defaultReasoningEffort: string
  /** Model id for new chats, e.g. `claude-default`. Empty keeps the Codex default. */
  defaultModel: string
}

export function readCodexUiRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): CodexUiRuntimeConfig {
  const requestedEffort = env.CODEXUI_DEFAULT_REASONING_EFFORT?.trim().toLowerCase() ?? ''
  return {
    defaultReasoningEffort: REASONING_EFFORTS.has(requestedEffort) ? requestedEffort : '',
    defaultModel: env.CODEXUI_DEFAULT_MODEL?.trim() ?? '',
  }
}
