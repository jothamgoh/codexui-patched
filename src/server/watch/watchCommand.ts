/**
 * POST command for the watch (contract: codexui-watch/API.md): the voice
 * router's result as one plan of the watch's kinds, and the plans and choices
 * kept for command/run and for a tap on a choice. Only a sure send, new chat or
 * stop gets a code; anything less sure becomes a choice to tap, as on the
 * iPhone, where only a sure command goes out without a tap. Plans live in
 * memory for two minutes and nothing runs until command/run.
 */
import { VOICE_LIST_LABELS, type VoiceChatRow, type VoiceListType, type VoiceResult } from '../../types/voice'
import { AUTO_SEND_BASES, decideAutoSend } from '../voice/voiceAutoSend'
import { normalizeTranscript } from '../voice/voiceMessage'
import { VOICE_THRESHOLDS } from '../voice/voiceRouter'
import { EMPTY_LIST_SAY } from '../voice/voiceRoutes'
import { createVoiceCode, ExpiringMap } from '../voice/voiceStore'
import { listRow, type ChatRow, type WatchActivity } from './watchMapping'

export type WatchCommandKind = 'open' | 'list' | 'send' | 'new' | 'stop' | 'summarize' | 'choose' | 'none'

export type WatchCommandReply = {
  code: string | null
  kind: WatchCommandKind
  say: string
  text: string | null
  chats: ChatRow[]
  section: VoiceListType | null
  newChats: Array<{ project: string; text: string }>
}

/** What command/run carries out. New chats are always Claude. */
export type WatchPlan =
  | { kind: 'send'; chatIds: string[]; text: string }
  | { kind: 'new'; chats: Array<{ cwd: string; text: string }> }
  | { kind: 'stop'; chatIds: string[] }

/** What a tap on one of a choice's chats does with that chat. */
export type WatchChoice = { action: 'open' | 'send' | 'stop' | 'summarize'; text: string | null; chatIds: string[] }

export type PlannedCommand = { reply: Omit<WatchCommandReply, 'code'>; plan: WatchPlan | null; choice: WatchChoice | null }

export type PlanInputs = {
  activity: WatchActivity
  workingLines: ReadonlyMap<string, string>
  /** Chats a project board runs: the watch never sends to them, as POST send refuses. */
  boardChatIds: ReadonlySet<string>
}

export const WATCH_PLAN_TTL_MS = 2 * 60_000
const TITLE_LENGTH = 40
const NOT_CAUGHT = "I didn't catch that."
const BOARD_SAY = 'A project board runs that chat. Continue it in CodexUI.'
const CHOOSE_SAY: Record<WatchChoice['action'], string> = {
  open: 'Open which chat?',
  send: 'Send to which chat?',
  stop: 'Stop which chat?',
  summarize: 'Catch up on which chat?',
}
const SECTION_CHATS: Record<VoiceListType, string> = {
  unread: 'unread chats',
  running: 'running chats',
  needs_you: 'chats that need you',
  recent: 'recent chats',
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

function title(chat: VoiceChatRow): string {
  return chat.title.length > TITLE_LENGTH ? `${chat.title.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : chat.title
}

/** "Release notes", or "3 unread chats" for a whole section. */
function targetsLabel(chats: VoiceChatRow[], group?: VoiceListType): string {
  if (group === 'needs_you') return `${plural(chats.length, 'chat')} that ${chats.length === 1 ? 'needs' : 'need'} you`
  if (group) return plural(chats.length, `${group.replace('_', ' ')} chat`)
  return chats.length === 1 ? title(chats[0]) : plural(chats.length, 'chat')
}

function answer(kind: WatchCommandKind, say: string, fields: Partial<Omit<WatchCommandReply, 'code' | 'kind' | 'say'>> = {}, plan: WatchPlan | null = null): PlannedCommand {
  return { reply: { kind, say, text: null, chats: [], section: null, newChats: [], ...fields }, plan, choice: null }
}

function none(say: string): PlannedCommand {
  return answer('none', say)
}

function isSure(result: VoiceResult): boolean {
  return !result.draftOnly && Boolean(result.basis && AUTO_SEND_BASES.has(result.basis))
}

/** A reply runs a turn, or waits on the user's answer to one: something to stop. */
function isWorking(activity: WatchActivity, threadId: string): boolean {
  const section = activity.sectionOf.get(threadId)
  return section === 'running' || section === 'needs_you' || activity.threads.get(threadId)?.inProgress === true
}

type Rows = (chats: VoiceChatRow[]) => ChatRow[]

function choose(action: WatchChoice['action'], say: string, chats: VoiceChatRow[], text: string | null, rows: Rows): PlannedCommand {
  return {
    reply: { kind: 'choose', say, text, chats: rows(chats), section: null, newChats: [] },
    plan: null,
    choice: { action, text, chatIds: chats.map((chat) => chat.threadId) },
  }
}

function planSend(result: VoiceResult, inputs: PlanInputs, rows: Rows): PlannedCommand {
  const text = result.message?.trim() ?? ''
  const chats = result.candidates
  if (!text || chats.length === 0) return none(NOT_CAUGHT)
  // The watch cannot hold a draft: the chat opens and the words stay unsent.
  if (result.draftOnly) {
    return chats.length === 1 ? answer('open', `Not sent: open ${title(chats[0])} to send it`, { chats: rows(chats) }) : none('Say it without “draft” to send it.')
  }
  // Code chose a whole section; one chat must be as sure as an iPhone auto-send, else a tap confirms it.
  if (!result.group && !decideAutoSend(result, { autoSend: true }).auto) return choose('send', `Send to ${title(chats[0])}?`, chats.slice(0, 1), text, rows)
  const allowed = chats.filter((chat) => !inputs.boardChatIds.has(chat.threadId))
  if (allowed.length === 0) return none(BOARD_SAY)
  return answer('send', `Send to ${targetsLabel(allowed, result.group)}`, { text, chats: rows(allowed) }, { kind: 'send', chatIds: allowed.map((chat) => chat.threadId), text })
}

function planNew(result: VoiceResult): PlannedCommand {
  const text = result.message?.trim() ?? ''
  const { project } = result
  if (result.draftOnly) return none('Say it without “draft” to start it.')
  // A project the LLM alone picked is a guess; the watch has no project chooser to confirm it with.
  if (!project || !isSure(result)) return none('Which project? Say “new chat in”, then its name.')
  if (!text) return none(`What should the new ${project.label} chat do?`)
  return answer('new', `New Claude chat in ${project.label}`, { newChats: [{ project: project.label, text }] }, { kind: 'new', chats: [{ cwd: project.id, text }] })
}

function planStop(result: VoiceResult, inputs: PlanInputs, rows: Rows): PlannedCommand {
  const working = result.candidates.filter((chat) => isWorking(inputs.activity, chat.threadId))
  if (working.length === 0) {
    if (result.group === 'running' || result.group === 'needs_you') return none(EMPTY_LIST_SAY[result.group])
    return none(result.candidates.length === 1 ? `${title(result.candidates[0])} isn't running.` : 'None of those chats is running.')
  }
  if (!result.group && !isSure(result)) return choose('stop', `Stop ${title(working[0])}?`, working.slice(0, 1), null, rows)
  return answer('stop', `Stop ${targetsLabel(working, result.group)}`, { chats: rows(working) }, { kind: 'stop', chatIds: working.map((chat) => chat.threadId) })
}

function planChoose(result: VoiceResult, rows: Rows): PlannedCommand {
  const chats = result.candidates.slice(0, VOICE_THRESHOLDS.pickerMax)
  if (chats.length === 0) return none(NOT_CAUGHT)
  const action: WatchChoice['action'] = result.action === 'stop_chats' ? 'stop'
    : result.action === 'summarize_chats' ? 'summarize'
    : result.action === 'send_to_chat' && result.message?.trim() && !result.draftOnly ? 'send'
    : 'open'
  return choose(action, CHOOSE_SAY[action], chats, action === 'send' ? result.message?.trim() ?? null : null, rows)
}

function planList(result: VoiceResult): PlannedCommand {
  const section = result.listType ?? 'recent'
  const count = result.candidates.length
  return answer('list', count === 0 ? EMPTY_LIST_SAY[section] : `${VOICE_LIST_LABELS[section]}: ${plural(count, 'chat')}`, { section })
}

function emptyGroupSay(result: VoiceResult): string {
  const group = result.group ?? 'unread'
  if (result.action === 'send_to_chat') return `No ${SECTION_CHATS[group]} to send to.`
  return EMPTY_LIST_SAY[group]
}

function notUnderstoodSay(result: VoiceResult): string {
  if (result.reason === 'no_message' && result.group) return `What should I send to the ${SECTION_CHATS[result.group]}?`
  if (result.reason === 'fragment') return 'Which chat? Open it, or say its name.'
  if (result.reason === 'no_chats') return 'There are no chats yet.'
  return NOT_CAUGHT
}

function planResult(result: VoiceResult, inputs: PlanInputs): PlannedCommand {
  const rows: Rows = (chats) => chats.map((chat) => listRow(inputs.activity, chat, inputs.workingLines))
  const first = result.candidates[0]
  switch (result.outcome) {
    case 'open_chat':
      return first ? answer('open', `Open ${title(first)}`, { chats: rows([first]) }) : none(NOT_CAUGHT)
    case 'send_ready':
      return planSend(result, inputs, rows)
    case 'new_chat':
      return planNew(result)
    case 'stop_ready':
      return planStop(result, inputs, rows)
    case 'summarize_ready':
      return answer('summarize', `Catch up on ${targetsLabel(result.candidates, result.group)}`, { chats: rows(result.candidates) })
    case 'picker':
      return result.action === 'list_chats' ? planList(result) : planChoose(result, rows)
    case 'empty':
      return result.action === 'list_chats' ? planList(result) : none(emptyGroupSay(result))
    default:
      return none(notUnderstoodSay(result))
  }
}

/** Several steps make one plan only when they are the same kind: new chats, stops, catch-ups, or one message to several chats. */
function mergeSteps(planned: PlannedCommand[]): PlannedCommand {
  const kinds = new Set(planned.map((entry) => entry.reply.kind))
  const [kind] = kinds
  const chats = [...new Map(planned.flatMap((entry) => entry.reply.chats).map((chat) => [chat.id, chat])).values()]
  if (planned.length > 0 && kinds.size === 1) {
    if (kind === 'new') {
      const newChats = planned.flatMap((entry) => entry.reply.newChats)
      const projects = new Set(newChats.map((chat) => chat.project))
      const say = `${plural(newChats.length, 'new Claude chat')}${projects.size === 1 ? ` in ${[...projects][0]}` : ''}`
      return answer('new', say, { newChats }, { kind: 'new', chats: planned.flatMap((entry) => (entry.plan?.kind === 'new' ? entry.plan.chats : [])) })
    }
    if (kind === 'stop') return answer('stop', `Stop ${plural(chats.length, 'chat')}`, { chats }, { kind: 'stop', chatIds: chats.map((chat) => chat.id) })
    if (kind === 'summarize') return answer('summarize', `Catch up on ${plural(chats.length, 'chat')}`, { chats })
    const texts = new Set(planned.map((entry) => entry.reply.text))
    if (kind === 'send' && texts.size === 1) {
      const text = planned[0].reply.text ?? ''
      return answer('send', `Send to ${plural(chats.length, 'chat')}`, { text, chats }, { kind: 'send', chatIds: chats.map((chat) => chat.id), text })
    }
  }
  return none('That was several things. Say them one at a time.')
}

/** The router's result as the watch's plan. */
export function planWatchCommand(result: VoiceResult, inputs: PlanInputs): PlannedCommand {
  if (result.outcome !== 'steps') return planResult(result, inputs)
  return mergeSteps((result.steps ?? []).map((step) => planResult(step, inputs)))
}

/** A tap on one of a choice's chats: what was asked, with that chat, sure because the user picked it. */
export function planChoice(choice: WatchChoice, chat: VoiceChatRow, inputs: PlanInputs): PlannedCommand {
  const base = { heard: '', sections: inputs.activity.context.sections, candidates: [chat], threadId: chat.threadId, basis: 'screen' as const }
  switch (choice.action) {
    case 'send':
      return planResult({ ...base, action: 'send_to_chat', outcome: 'send_ready', message: choice.text ?? '' }, inputs)
    case 'stop':
      return planResult({ ...base, action: 'stop_chats', outcome: 'stop_ready' }, inputs)
    case 'summarize':
      return planResult({ ...base, action: 'summarize_chats', outcome: 'summarize_ready' }, inputs)
    default:
      return planResult({ ...base, action: 'open_chat', outcome: 'open_chat' }, inputs)
  }
}

type PlanEntry = { plan: WatchPlan; state: 'planned' | 'ran' | 'cancelled' }

function choiceKey(text: string): string {
  return normalizeTranscript(text).toLowerCase()
}

/** Plans waiting for command/run, and choices waiting for a tap; in memory for two minutes. */
export class WatchPlanStore {
  private readonly plans: ExpiringMap<PlanEntry>
  private readonly choices: ExpiringMap<WatchChoice>

  constructor(now: () => number, private readonly newCode: () => string = createVoiceCode) {
    this.plans = new ExpiringMap(WATCH_PLAN_TTL_MS, now)
    this.choices = new ExpiringMap(WATCH_PLAN_TTL_MS, now)
  }

  save(plan: WatchPlan): string {
    const code = this.newCode()
    this.plans.set(code, { plan, state: 'planned' })
    return code
  }

  /** The plan, once: a second take, or one after cancel or expiry, gets null. */
  take(code: string): WatchPlan | null {
    const entry = this.plans.get(code)
    if (!entry || entry.state !== 'planned') return null
    entry.state = 'ran'
    return entry.plan
  }

  cancel(code: string): 'cancelled' | 'ran' | 'unknown' {
    const entry = this.plans.get(code)
    if (!entry) return 'unknown'
    if (entry.state === 'ran') return 'ran'
    entry.state = 'cancelled'
    return 'cancelled'
  }

  remember(text: string, choice: WatchChoice): void {
    this.choices.set(choiceKey(text), choice)
  }

  /** The same words again with one of the offered chats open: what to do with it, once. */
  takeChoice(text: string, chatId: string): WatchChoice | null {
    const key = choiceKey(text)
    const choice = this.choices.get(key)
    if (!choice?.chatIds.includes(chatId)) return null
    this.choices.take(key)
    return choice
  }
}
