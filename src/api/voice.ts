import type { VoiceResult, VoiceStoredResult } from '../types/voice'

export class VoiceResultExpiredError extends Error {}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function getVoiceResult(code: string): Promise<VoiceStoredResult> {
  const response = await fetch(`/codex-api/voice/${encodeURIComponent(code)}`, { cache: 'no-store' })
  const payload = await readJson(response)
  if (response.status === 404) throw new VoiceResultExpiredError(typeof payload.error === 'string' ? payload.error : 'This voice result has expired.')
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Could not load the voice result (${response.status}).`)
  return payload.data as VoiceStoredResult
}

/** The in-app mic: same router as the Shortcut, but the app navigates itself and nothing is pushed. */
export async function runVoiceCommand(text: string): Promise<{ code: string; url: string; result: VoiceResult }> {
  const response = await fetch('/codex-api/voice/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const payload = await readJson(response)
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Voice command failed (${response.status}).`)
  return payload.data as { code: string; url: string; result: VoiceResult }
}
