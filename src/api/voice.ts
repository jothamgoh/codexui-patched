import { parseVoiceSettings, type VoiceProjectOption, type VoiceSettings, type VoiceStoredResult } from '../types/voice'

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

async function postVoice(path: string, body: unknown): Promise<VoiceStoredResult> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await readJson(response)
  if (response.status === 404) throw new VoiceResultExpiredError(typeof payload.error === 'string' ? payload.error : 'This voice result has expired.')
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Voice request failed (${response.status}).`)
  return payload.data as VoiceStoredResult
}

/** Stops a send still in its undo window. Safe to call twice; the answer says what happened. */
export function cancelVoiceDelivery(code: string): Promise<VoiceStoredResult> {
  return postVoice(`/codex-api/voice/${encodeURIComponent(code)}/cancel`, {})
}

/** A tap in a chooser: send the spoken message to this chat, or start the chat in this project. */
export function sendVoiceResult(code: string, target: { threadId: string } | { projectId: string }): Promise<VoiceStoredResult> {
  return postVoice(`/codex-api/voice/${encodeURIComponent(code)}/send`, target)
}

export type VoiceSettingsResponse = {
  settings: VoiceSettings
  projects: VoiceProjectOption[]
  /** The server's default project when Settings picks none (CODEXUI_VOICE_DEFAULT_PROJECT). */
  fallbackProject: VoiceProjectOption | null
}

async function settingsCall(init?: RequestInit): Promise<VoiceSettingsResponse> {
  const response = await fetch('/codex-api/voice/settings', { cache: 'no-store', ...init })
  const payload = await readJson(response)
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Voice settings failed (${response.status}).`)
  return {
    settings: parseVoiceSettings(payload.data),
    projects: Array.isArray(payload.projects) ? payload.projects as VoiceProjectOption[] : [],
    fallbackProject: (payload.fallbackProject as VoiceProjectOption | null | undefined) ?? null,
  }
}

export function getVoiceSettings(): Promise<VoiceSettingsResponse> {
  return settingsCall()
}

export function saveVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettingsResponse> {
  return settingsCall({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
}
