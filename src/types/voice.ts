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
 * and a message, typed in for the user to send. `new_chat`: the new-chat page,
 * filled in. `steps`: several requests in one command, each a row to tap.
 * `not_understood`: recent chats and what was heard.
 */
export type VoiceOutcome = 'open_chat' | 'picker' | 'empty' | 'send_ready' | 'new_chat' | 'steps' | 'not_understood'

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
  /** `steps` only: each request routed on its own, in the order said. */
  steps?: VoiceResult[]
}

/** A saved step of a `steps` result: what it does, and the link that does it. */
export type VoiceStepLink = Pick<VoiceResult, 'action' | 'outcome' | 'listType' | 'candidates' | 'message' | 'project' | 'agent'> & {
  code: string
  url: string
}

export type VoiceStoredResult = Omit<VoiceResult, 'steps'> & {
  code: string
  createdAtIso: string
  expiresAtIso: string
  steps?: VoiceStepLink[]
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

/** A step's row: what tapping it does, and the words or chat it concerns. */
export function describeVoiceStep(step: Pick<VoiceResult, 'action' | 'outcome' | 'listType' | 'candidates' | 'message' | 'project'>): { title: string; detail: string } {
  const chat = step.candidates[0]
  const quoted = step.message ? `“${step.message}”` : ''
  if (step.action === 'list_chats') return { title: `${VOICE_LIST_LABELS[step.listType ?? 'recent']} chats`, detail: '' }
  if (step.outcome === 'new_chat') return { title: step.project ? `New chat in ${step.project.label}` : 'New chat', detail: quoted }
  if (step.outcome === 'send_ready' && chat) return { title: `Send to ${chat.title}`, detail: quoted }
  if (step.outcome === 'open_chat' && chat) return { title: `Open ${chat.title}`, detail: quoted || chat.projectName }
  if (step.outcome === 'picker') {
    return step.action === 'send_to_chat'
      ? { title: 'Send to which chat?', detail: quoted }
      : { title: 'Open which chat?', detail: step.candidates.slice(0, 3).map((row) => row.title).join(' · ') }
  }
  return { title: "Didn't catch this part", detail: '' }
}
