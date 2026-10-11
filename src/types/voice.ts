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

/**
 * What made the router sure of the chat or project it picked: Jev on its own
 * (`jev`), Jev with the spoken words (`jev+words`), the LLM with Jev's top two
 * (`jev+llm`), the LLM with the spoken words (`llm+words`), the words alone
 * (`words`, a rule), or the LLM alone (`llm`). `default`: the command named
 * no project, so the default project was used. Only a sure send or a new chat
 * with a project has one.
 */
export type VoiceBasis = 'jev' | 'jev+words' | 'jev+llm' | 'llm+words' | 'words' | 'llm' | 'default'

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
  /** `send_ready`, or `new_chat` with a project: what made the pick sure. */
  basis?: VoiceBasis
  /** The user asked only to type it in ("draft…", "don't send"): never sent or started without a tap. */
  draftOnly?: boolean
  /** `steps` only: each request routed on its own, in the order said. */
  steps?: VoiceResult[]
}

/** Undo windows the user can choose, in seconds. 0 sends at once. */
export const VOICE_SEND_DELAYS = [0, 3, 5, 10] as const
export type VoiceSendDelay = typeof VOICE_SEND_DELAYS[number]

/** Saved on the server, so the Shortcut and every device follow the same choice. */
export type VoiceSettings = {
  /** Clear sends and new chats go out without a tap. */
  autoSend: boolean
  /** Seconds to wait, with Cancel, before sending. */
  delaySeconds: VoiceSendDelay
  /** Folder for a new chat that names no project ('' for none: the project chooser). */
  defaultProject: string
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { autoSend: true, delaySeconds: 0, defaultProject: '' }

/** An absolute folder path, or '' when it is not one. */
export function voiceProjectPath(value: unknown): string {
  return typeof value === 'string' && value.trim().startsWith('/') ? value.trim() : ''
}

/** Anything unknown or missing falls back to the default, field by field. */
export function parseVoiceSettings(value: unknown): VoiceSettings {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const delay = record.delaySeconds
  return {
    autoSend: typeof record.autoSend === 'boolean' ? record.autoSend : DEFAULT_VOICE_SETTINGS.autoSend,
    delaySeconds: (VOICE_SEND_DELAYS as readonly unknown[]).includes(delay) ? delay as VoiceSendDelay : DEFAULT_VOICE_SETTINGS.delaySeconds,
    defaultProject: voiceProjectPath(record.defaultProject),
  }
}

/**
 * A send or new chat the server does itself: on its own for a sure command
 * (`auto`), or right after a tap in a chooser (`tap`). `pending` waits for the
 * undo window; `sending` has started and can no longer be cancelled.
 */
export type VoiceDeliveryState = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed'

export type VoiceDelivery = {
  kind: 'send' | 'new_chat'
  state: VoiceDeliveryState
  trigger: 'auto' | 'tap'
  delaySeconds: number
  /** Milliseconds until it goes out, as of when the server answered; 0 once it has. */
  remainingMs: number
  /** The chat it goes to; for a new chat, the chat once started. */
  threadId?: string
  /** The chat's title, or the new chat's project. */
  label: string
  message: string
}

/** A saved step of a `steps` result: what it does, and the link that does it. */
export type VoiceStepLink = Pick<VoiceResult, 'action' | 'outcome' | 'listType' | 'candidates' | 'message' | 'project' | 'agent' | 'draftOnly'> & {
  code: string
  url: string
  delivery?: VoiceDelivery
}

export type VoiceStoredResult = Omit<VoiceResult, 'steps'> & {
  code: string
  createdAtIso: string
  expiresAtIso: string
  steps?: VoiceStepLink[]
  /** Set once the server sends it or starts it, or will after the undo window. */
  delivery?: VoiceDelivery
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
export function voiceResultPath(result: Pick<VoiceResult, 'outcome' | 'threadId' | 'message'> & { delivery?: VoiceDelivery }, code: string): string {
  // A new chat the server already started opens that chat.
  const started = result.delivery?.kind === 'new_chat' && result.delivery.state === 'sent' ? result.delivery.threadId : undefined
  if (started) return `/#/thread/${encodeURIComponent(started)}?voice=${encodeURIComponent(code)}`
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
