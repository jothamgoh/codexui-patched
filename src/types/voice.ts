/** Shared by the voice command route (server) and the voice pages (PWA). */

export const VOICE_LIST_TYPES = ['needs_you', 'running', 'unread', 'recent'] as const
export type VoiceListType = typeof VOICE_LIST_TYPES[number]

export const VOICE_LIST_LABELS: Record<VoiceListType, string> = {
  needs_you: 'Needs you',
  running: 'Running',
  unread: 'Unread',
  recent: 'Recent',
}

export type VoiceAgent = 'claude' | 'codex'

export type VoiceAction = 'open_chat' | 'list_chats' | 'send_to_chat' | 'new_chat' | 'other'

export type VoiceChatRow = {
  threadId: string
  title: string
  projectName: string
  agent: VoiceAgent
  status: VoiceListType
  updatedAtIso: string
  summary: string
}

export type VoiceProjectOption = {
  /** The project folder, used as the new chat's cwd. */
  id: string
  label: string
}

/**
 * What the PWA shows. `open_chat`: go to the chat. `picker`: choose a chat.
 * `empty`: the requested list has nothing in it. `send_ready`: one clear chat
 * and a message, confirmed in the Shortcut. `new_chat`: the new-chat page,
 * filled in. `not_understood`: recent chats and what was heard.
 */
export type VoiceOutcome = 'open_chat' | 'picker' | 'empty' | 'send_ready' | 'new_chat' | 'not_understood'

export type VoiceResult = {
  heard: string
  action: VoiceAction
  outcome: VoiceOutcome
  reason?: string
  listType?: VoiceListType
  sections: Record<VoiceListType, VoiceChatRow[]>
  candidates: VoiceChatRow[]
  threadId?: string
  message?: string
  project?: VoiceProjectOption | null
  projectOptions?: VoiceProjectOption[]
  agent?: VoiceAgent | null
}

export type VoiceStoredResult = VoiceResult & {
  code: string
  createdAtIso: string
  expiresAtIso: string
}

export type VoiceShortcutResponse = {
  kind: 'notified' | 'confirm' | 'error'
  say: string
  confirm?: {
    question: string
    message: string
    chatTitle: string
    token: string
  }
}

/** Opaque, unguessable result codes: 24 base64url characters (144 bits). */
export const VOICE_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/u

export function isVoiceCode(value: unknown): value is string {
  return typeof value === 'string' && VOICE_CODE_PATTERN.test(value)
}

/** Where tapping the notification for a result should land. */
export function voiceResultPath(result: Pick<VoiceResult, 'outcome' | 'threadId' | 'message'>, code: string): string {
  if (result.outcome === 'open_chat' && result.threadId) return `/#/thread/${encodeURIComponent(result.threadId)}`
  if (result.outcome === 'send_ready' && result.threadId) {
    return `/#/thread/${encodeURIComponent(result.threadId)}?voice=${encodeURIComponent(code)}`
  }
  if (result.outcome === 'new_chat') return `/#/?voice=${encodeURIComponent(code)}`
  return `/#/voice/${encodeURIComponent(code)}`
}
