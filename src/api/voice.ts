import type { VoiceStoredResult } from '../types/voice'

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

export type VoiceCommandResponse = { code: string; url: string; result: VoiceStoredResult }

/**
 * The in-app mic: the recording goes straight to the same router as the
 * Shortcut, which transcribes it. Nothing is pushed; the app navigates itself.
 */
export async function runVoiceCommandAudio(audio: { body: Uint8Array<ArrayBuffer>; contentType: string }, signal?: AbortSignal): Promise<VoiceCommandResponse> {
  const response = await fetch('/codex-api/voice/command', { method: 'POST', headers: { 'Content-Type': audio.contentType }, body: audio.body, signal })
  const payload = await readJson(response)
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Voice command failed (${response.status}).`)
  return payload.data as VoiceCommandResponse
}
