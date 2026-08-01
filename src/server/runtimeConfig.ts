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
}

export function readCodexUiRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): CodexUiRuntimeConfig {
  const requestedEffort = env.CODEXUI_DEFAULT_REASONING_EFFORT?.trim().toLowerCase() ?? ''
  return {
    defaultReasoningEffort: REASONING_EFFORTS.has(requestedEffort) ? requestedEffort : '',
  }
}
