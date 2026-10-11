import type { DictationState } from '../composables/useDictation'

/** What the voice mic is doing, for the host to show next to it. */
export type VoiceMicPhase = 'idle' | 'starting' | 'recording' | 'working' | 'error'

export type VoiceMicStatus = { phase: VoiceMicPhase; text: string; canRetry: boolean }

export const IDLE_MIC_STATUS: VoiceMicStatus = { phase: 'idle', text: '', canRetry: false }

/** Words for a microphone or routing failure that tell the user what to do next. */
export function describeMicError(error: unknown): string {
  const name = error instanceof Error || (error && typeof error === 'object' && 'name' in error) ? String((error as { name: unknown }).name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow the microphone for this app in your browser or iPhone settings, then tap the mic again.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device.'
  if (name === 'NotReadableError') return 'The microphone is busy in another app. Close it there and tap the mic again.'
  const message = error instanceof Error ? error.message : ''
  return message ? `Voice command failed: ${message.replace(/\.?$/u, '.')} Tap the mic to try again.` : 'Voice command failed. Tap the mic to try again.'
}

export const NOTHING_HEARD = "Didn't hear anything. Tap the mic and try again."

/** "0:07": how long the mic has been recording. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function voiceMicStatus(input: { isStarting: boolean; state: DictationState; error: string; canRetry: boolean; elapsedMs?: number }): VoiceMicStatus {
  if (input.isStarting) return { phase: 'starting', text: 'Opening the microphone…', canRetry: false }
  if (input.state === 'recording') return { phase: 'recording', text: `Listening… ${formatElapsed(input.elapsedMs ?? 0)} · tap to stop`, canRetry: false }
  if (input.state === 'transcribing') return { phase: 'working', text: 'Working…', canRetry: false }
  if (input.error) return { phase: 'error', text: input.error, canRetry: input.canRetry }
  return IDLE_MIC_STATUS
}
