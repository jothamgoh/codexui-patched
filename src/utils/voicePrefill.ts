import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { VoiceAgent, VoiceProjectOption, VoiceStoredResult } from '../types/voice'
import type { ChatProvider } from './chatProvider'

/** The home composer's draft key (App.vue composerThreadContextId). */
export const NEW_THREAD_DRAFT_KEY = '__new-thread__'

export type VoicePrefillPlan = {
  draftKey: string
  message: string
  /** New chat only: the project folder to select. */
  cwd?: string
  agent?: VoiceAgent | null
  openProjectPicker: boolean
  projectChoices: VoiceProjectOption[]
  banner: { heard: string; note?: string }
}

/**
 * What a `?voice=<code>` link fills in. On a chat: the message, typed into that
 * chat's composer. On home: the new-chat composer with project, agent and
 * message; with the project picker open when the project was unclear.
 */
export function planVoicePrefill(result: VoiceStoredResult, target: { route: 'thread'; threadId: string } | { route: 'home' }): VoicePrefillPlan | null {
  const message = result.message ?? ''
  const banner = { heard: result.heard }
  if (target.route === 'thread') {
    if (!message) return null
    return { draftKey: target.threadId, message, openProjectPicker: false, projectChoices: [], banner }
  }
  if (result.action === 'new_chat') {
    const project = result.project ?? null
    return {
      draftKey: NEW_THREAD_DRAFT_KEY,
      message,
      ...(project ? { cwd: project.id } : {}),
      agent: result.agent ?? null,
      openProjectPicker: !project,
      projectChoices: project ? [] : (result.projectOptions ?? []).slice(0, 3),
      banner,
    }
  }
  if (!message) return null
  // A send whose chat could not be opened lands here: keep the words.
  return {
    draftKey: NEW_THREAD_DRAFT_KEY,
    message,
    openProjectPicker: false,
    projectChoices: [],
    banner: { ...banner, note: 'That chat could not be opened. Pick the chat, or start a new one with this message.' },
  }
}

/** The model to select for a spoken agent, or null to keep the current one. */
export function modelForVoiceAgent(
  agent: VoiceAgent | null | undefined,
  currentModelId: string,
  models: ReadonlyArray<{ id: string; provider: ChatProvider }>,
): string | null {
  if (!agent) return null
  const provider: ChatProvider = agent === 'claude' ? 'anthropic' : 'openai'
  const current = models.find((model) => model.id === currentModelId)
  if (current?.provider === provider) return null
  return models.find((model) => model.provider === provider)?.id ?? null
}

export function voiceCodeFromQuery(query: LocationQuery): string {
  const value = query.voice
  return typeof value === 'string' ? value : ''
}

export function queryWithoutVoice(query: LocationQuery): LocationQueryRaw {
  const next: LocationQueryRaw = { ...query }
  delete next.voice
  return next
}

/** Only the voice code survives a fallback redirect; other keys belonged to the old page. */
export function voiceQueryOnly(query: LocationQuery): LocationQueryRaw {
  const code = voiceCodeFromQuery(query)
  return code ? { voice: code } : {}
}
