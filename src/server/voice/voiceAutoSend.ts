/**
 * Which voice results the server sends or starts without a tap. Stricter than
 * routing: the chat or project must be one the router was sure of through two
 * agreeing signals (or Jev's own clear win), the message must be there, the
 * user must not have asked for a draft, and the setting must be on. Choosers
 * never qualify; in a command with several steps each step is judged alone.
 */
import type { VoiceBasis, VoiceResult, VoiceSettings } from '../../types/voice'

/**
 * The LLM alone (`llm`) is not enough: it needs the words or Jev to agree.
 * `default`: no project was named (Jev or the LLM sure, and no name in the words).
 */
export const AUTO_SEND_BASES: ReadonlySet<VoiceBasis> = new Set<VoiceBasis>(['jev', 'jev+words', 'jev+llm', 'llm+words', 'words', 'default'])

export type AutoSendSkip =
  | 'setting_off'
  | 'draft_only'
  /** Not a send or a new chat: a chooser, a list, opening a chat, "didn't catch that", steps. */
  | 'not_actionable'
  | 'not_sure'
  | 'no_message'
  | 'no_project'

export type AutoSendDecision = { auto: true; kind: 'send' | 'new_chat' } | { auto: false; skip: AutoSendSkip }

type Judged = Pick<VoiceResult, 'outcome' | 'threadId' | 'message' | 'project' | 'basis' | 'draftOnly'>

/** One result (or one step) on its own. */
export function decideAutoSend(result: Judged, settings: Pick<VoiceSettings, 'autoSend'>): AutoSendDecision {
  const kind = result.outcome === 'send_ready' ? 'send' : result.outcome === 'new_chat' ? 'new_chat' : null
  if (!kind) return { auto: false, skip: 'not_actionable' }
  if (!settings.autoSend) return { auto: false, skip: 'setting_off' }
  if (result.draftOnly) return { auto: false, skip: 'draft_only' }
  if (kind === 'send' && !result.threadId) return { auto: false, skip: 'not_sure' }
  if (kind === 'new_chat' && !result.project) return { auto: false, skip: 'no_project' }
  if (!result.message?.trim()) return { auto: false, skip: 'no_message' }
  if (!result.basis || !AUTO_SEND_BASES.has(result.basis)) return { auto: false, skip: 'not_sure' }
  return { auto: true, kind }
}

/** A `steps` result: each step judged alone, in order. Anything else: the result itself. */
export function decideAutoSendAll(result: Judged & { steps?: Judged[] }, settings: Pick<VoiceSettings, 'autoSend'>): AutoSendDecision[] {
  if (result.outcome === 'steps') return (result.steps ?? []).map((step) => decideAutoSend(step, settings))
  return [decideAutoSend(result, settings)]
}
