/**
 * Phrase rules for what only a caller with a screen turns on (the watch,
 * through VoiceRouteOptions): whole panel sections as targets ("all unread"),
 * stop and summarize commands, and replies to the chat open on the screen.
 * Code decides these, never a model. Pure: no I/O.
 */
import type { VoiceListType } from '../../types/voice'
import { cleanMessage, extractSendByRule, stripFillers } from './voiceMessage'

/** A whole section acts on at most this many chats, in panel order. */
export const CHAT_GROUP_LIMIT = 6

// --- Whole sections ----------------------------------------------------------

const STATE = String.raw`(unread|finished|done|completed?|running|working|busy|active|in progress|still (?:running|going|working)|waiting(?: (?:on|for) (?:me|you|my (?:answer|input|reply|approval|decision)))?|need(?:s|ing)? (?:me|you|my (?:answer|input|attention|approval|reply|decision)|an? (?:answer|reply|decision)|approval|attention|input))`
const NOUN = String.raw`(?:chats?|ones?|threads?|conversations?|sessions?|agents?)`
const PLURAL = String.raw`(?:chats|ones|threads|conversations|sessions|agents)`
const QUANTIFIER = String.raw`(?:all|every|each)(?:\s+of)?(?:\s+(?:the|my|those|these))?`
const RELATIVE = String.raw`(?:that|which|who)(?:\s+(?:are|is|have|has|were|was))?(?:\s+still)?`

const GROUP_PATTERNS = [
  // all unread, all my unread chats, every running one
  new RegExp(String.raw`\b${QUANTIFIER}\s+${STATE}(?:\s+${NOUN})?\b`, 'iu'),
  // every chat that finished, all that need me, all the ones that are running
  new RegExp(String.raw`\b${QUANTIFIER}(?:\s+${NOUN})?\s+${RELATIVE}\s+${STATE}\b`, 'iu'),
  // everything that needs me, everything unread
  new RegExp(String.raw`\beverything\s+(?:(?:that|which)(?:'s|\s+is|\s+has)?\s+)?${STATE}\b`, 'iu'),
  // my unread chats, the running ones
  new RegExp(String.raw`\b(?:the|my|those|these)\s+${STATE}\s+${PLURAL}\b`, 'iu'),
  // the chats that need me, chats waiting for me
  new RegExp(String.raw`\b(?:(?:the|my)\s+)?${PLURAL}\s+(?:${RELATIVE}\s+${STATE}|(waiting(?:\s+(?:on|for)\s+(?:me|you))?))\b`, 'iu'),
]
/** Only where a target is expected: "stop running chats". */
const BARE_GROUP = new RegExp(String.raw`^${STATE}\s+${PLURAL}\b`, 'iu')

function sectionOf(state: string): VoiceListType {
  const word = state.toLowerCase()
  if (/^(?:unread|finished|done|completed?)$/u.test(word)) return 'unread'
  if (/^(?:waiting|need)/u.test(word)) return 'needs_you'
  return 'running'
}

export type ChatGroupMatch = { section: VoiceListType; index: number; end: number }

/** The first words that name a whole panel section: "all unread", "every chat that finished", "all that need me". */
export function findChatGroup(text: string): ChatGroupMatch | null {
  let best: ChatGroupMatch | null = null
  for (const pattern of GROUP_PATTERNS) {
    const match = pattern.exec(text)
    if (!match) continue
    const found = { section: sectionOf(match.slice(1).find(Boolean) ?? ''), index: match.index, end: match.index + match[0].length }
    if (!best || found.index < best.index || (found.index === best.index && found.end > best.end)) best = found
  }
  return best
}

// --- What a stop or summarize acts on -----------------------------------------

export type ChatTarget =
  | { kind: 'group'; section: VoiceListType }
  /** Nothing named, or "it", "this chat": the open chat. */
  | { kind: 'self' }
  /** "all", "everything", "all my chats". */
  | { kind: 'everything' }
  | { kind: 'named'; words: string }

/** Words for the chat open on the screen. */
export const SELF_REFERENCE = /^(?:it|this|that|them|they|him|her|you|this (?:chat|one|thread|conversation|session|agent)|the (?:chat|agent|thread|conversation)|claude|codex)$/iu
const EVERYTHING = /^(?:all|everything|everyone|everybody|it all|all of (?:them|it)|them all|every chat|every one|all (?:the |my |of my |of the )?(?:chats|agents|threads|conversations))$/iu
/** Sections said as a question: "summarize what finished this morning". */
const SECTION_QUESTIONS: Array<[RegExp, VoiceListType]> = [
  [/^what(?:'s|\s+has|\s+have)?\s+(?:just\s+)?(?:finished|done|completed|come in|replied)\b/iu, 'unread'],
  [/^what(?:'s|\s+is|\s+are)?\s+(?:still\s+)?(?:running|working|going)\b/iu, 'running'],
  [/^what\s+(?:needs|is waiting (?:on|for))\s+me\b/iu, 'needs_you'],
]
const CLAUSE_BREAK = /\s*[,;.!?]\s+|\s+(?:because|since|cause|cuz|it's|it is|they're)\s+/iu

export function readChatTarget(words: string): ChatTarget {
  const rest = words
    .replace(/^[\s,:;.!?—-]+|[\s,:;.!?]+$/gu, '')
    .replace(/^(?:on|about|of|for|with|from|in|to)\s+/iu, '')
    .trim()
  if (!rest) return { kind: 'self' }
  const group = findChatGroup(rest)
  if (group?.index === 0) return { kind: 'group', section: group.section }
  const bare = BARE_GROUP.exec(rest)
  if (bare) return { kind: 'group', section: sectionOf(bare[1] ?? '') }
  for (const [pattern, section] of SECTION_QUESTIONS) if (pattern.test(rest)) return { kind: 'group', section }
  const named = (rest.split(CLAUSE_BREAK)[0] ?? '')
    .replace(/^(?:whatever|what)\s+/iu, '')
    .replace(/\s+(?:is|was|'s|are|has been|have been)\s+(?:doing|working on|running|up to)$/iu, '')
    .replace(/\s+(?:right now|now|please|for me|again)$/iu, '')
    .trim()
  if (!named || SELF_REFERENCE.test(named)) return { kind: 'self' }
  if (EVERYTHING.test(named)) return { kind: 'everything' }
  return { kind: 'named', words: named }
}

/** "… and then summarise what each did": a second request, which the LLM splits into steps instead. */
const ANOTHER_REQUEST = /\b(?:and|then|also|after that)\s+(?:then\s+|also\s+)?(?:stop|cancel|halt|pause|summari[sz]e|recap|catch|tell|ask|send|open|show|start|create|make|give|reply|message|what)\b/iu

const STOP_VERB = /^(?:stop|cancel|halt|pause|interrupt|kill|abort|terminate)\b[\s,]*/iu

function readStop(text: string): ChatCommand | null {
  const verb = STOP_VERB.exec(text)
  if (!verb) return null
  const rest = text.slice(verb[0].length)
  if (ANOTHER_REQUEST.test(rest)) return null
  const target = readChatTarget(rest)
  // "stop using tabs", "stop it from deleting files": an instruction for the agent, not a stop.
  if (target.kind === 'named' && (/^[a-z]+ing\b/iu.test(target.words) || /\bfrom\s+[a-z]+ing\b/iu.test(rest))) return null
  return { kind: 'stop', target }
}

/** Catching up names everything when it names nothing; summarizing names the open chat. */
const CATCH_UP = /^(?:catch me up|catch up|fill me in|brief me|update me|bring me up to (?:speed|date)|what did i miss|what have i missed|what'd i miss)\b[\s,]*/iu
const SUMMARIZE = /^(?:summari[sz]e|recap|sum up|give me (?:a |an |the )?(?:quick |short |brief )?(?:summary|recap|rundown|update|tl;?dr)|tl;?dr)\b[\s,]*/iu
const ASKS_WHAT_A_CHAT_SAID = [
  /^what\s+(?:did|has|have|had)\s+(.+?)\s+(?:say|said|reply|replied|answer|answered|come back with|find|found|figure out|figured out|conclude|concluded|do|done|been up to|get done|finish|finished|end up with)\b/iu,
  /^what(?:'s|\s+is|\s+was|\s+has)\s+(.+?)\s+(?:saying|been saying|been up to|been doing)\b/iu,
  /^how\s+(?:did|is|was|are|has)\s+(.+?)\s+(?:go|going|gone|get on|turn out|turned out|doing)\b/iu,
]

function readSummarize(text: string): ChatCommand | null {
  for (const pattern of ASKS_WHAT_A_CHAT_SAID) {
    const match = pattern.exec(text)
    if (match) return ANOTHER_REQUEST.test(text) ? null : { kind: 'summarize', target: readChatTarget(match[1] ?? '') }
  }
  const catchUp = CATCH_UP.exec(text)
  const lead = catchUp ?? SUMMARIZE.exec(text)
  if (!lead) return null
  const rest = text.slice(lead[0].length)
  if (ANOTHER_REQUEST.test(rest)) return null
  const target = readChatTarget(rest)
  if (catchUp && target.kind === 'self' && !rest.trim()) return { kind: 'summarize', target: { kind: 'everything' } }
  return { kind: 'summarize', target }
}

// --- Sends to a whole section ---------------------------------------------------

/** The send rules' words for one chat stand in for the section, so those rules cut the message. */
const GROUP_STAND_IN = 'the group chat'
const SEND_VERB = String.raw`(?:tell|ask|let|have|get|remind|instruct|message|ping|reply(?: back)?|respond|answer|write|send|say|post)(?:\s+(?:to|in|into))?`
const SEND_LEAD = new RegExp(String.raw`^${SEND_VERB}$`, 'iu')
/** "the deploy is done, tell all unread": the message comes first, so the LLM cuts it. */
const SEND_LAST = new RegExp(String.raw`(?:^|[\s,;:])${SEND_VERB}$`, 'iu')
const SEND_QUOTED = /^(?:send|say|write|post|reply|type)\s+(.+?)\s+(?:to|in|into)$/iu
const MESSAGE_LEAD = /^[\s,:;—-]*(?:(?:um+|uh+|so|like|basically|and)[\s,]+)*(?:(?:tell|ask)\s+(?:it|them|each one|everyone)\s+)?(?:(?:to|that|know that|know|whether|if|saying|with)\s+)?/iu

function readGroupSend(text: string): ChatCommand | null {
  const group = findChatGroup(text)
  if (!group) return null
  const { section } = group
  const before = text.slice(0, group.index).trim()
  const after = text.slice(group.end)
  const rule = extractSendByRule(`${before} ${GROUP_STAND_IN}${after}`.trim())
  if (rule && /^(?:to\s+)?(?:the\s+)?group chat$/iu.test(rule.chatPhrase ?? '')) return { kind: 'send_group', section, message: rule.message }
  // The message is left to the LLM when these cannot cut it ('').
  if (SEND_LEAD.test(before)) return { kind: 'send_group', section, message: cleanMessage(after.replace(MESSAGE_LEAD, '')) }
  const quoted = SEND_QUOTED.exec(before)
  if (quoted && !after.trim()) return { kind: 'send_group', section, message: cleanMessage(quoted[1] ?? '') }
  if (/^(?:for|to)?$/iu.test(before) && /^\s*[,:;—-]/u.test(after)) {
    return { kind: 'send_group', section, message: cleanMessage(after.replace(/^\s*[,:;—-]+/u, '').replace(MESSAGE_LEAD, '')) }
  }
  if (SEND_LAST.test(before) && !after.replace(/[\s.!?]+/gu, '')) return { kind: 'send_group', section, message: '' }
  return null
}

// --- Replies to the open chat ---------------------------------------------------

/** "reply with yes", "say: ship it", "respond, sounds good". */
const REPLY_VERB = /^(?:reply|respond|answer|say)(?:\s+back)?(?:\s+(?:with|saying)\b|\s*[,:])\s*(.+)$/iu
/** "reply yes go ahead", "say thanks"; not "say it again", which is the message itself. */
const REPLY_BARE = /^(?:reply|say)\s+(?!(?:it|that|this|to|so|again|something|what|back)\b)(.+)$/iu
const TELL_SELF = /^(?:tell|ask)\s+(?:it|them|him|her|claude|codex|the agent|this chat|this one)\b[\s,:]*(?:(?:to|that)\s+)?(.+)$/iu

/** The message of a reply-style command for the open chat, or null when it names another chat or is not one. */
function readReply(text: string): string | null {
  const rule = extractSendByRule(text)
  if (rule) return SELF_REFERENCE.test(rule.chatPhrase ?? '') ? rule.message : null
  const match = TELL_SELF.exec(text) ?? REPLY_VERB.exec(text) ?? REPLY_BARE.exec(text)
  if (!match || /^to\s/iu.test(match[1] ?? '')) return null
  return cleanMessage(match[1] ?? '') || null
}

// --- One command --------------------------------------------------------------

export type ChatCommand =
  | { kind: 'stop'; target: ChatTarget }
  | { kind: 'summarize'; target: ChatTarget }
  /** A send to a whole section; `message` is '' when the rules could not cut it. */
  | { kind: 'send_group'; section: VoiceListType; message: string }
  | { kind: 'reply'; message: string }

/**
 * A command the rules settle without Jev, or null for the usual routing.
 * `actions`: stop, summarize and whole sections; `openChat`: replies to it.
 */
export function readChatCommand(heard: string, options: { actions: boolean; openChat: boolean }): ChatCommand | null {
  const text = stripFillers(heard)
  if (!text) return null
  if (options.actions) {
    const command = readStop(text) ?? readSummarize(text) ?? readGroupSend(text)
    if (command) return command
  }
  if (!options.openChat) return null
  const message = readReply(text)
  return message ? { kind: 'reply', message } : null
}

/** The user's own words, without filler: a plain message for the open chat. */
export function ownWords(heard: string): string {
  return cleanMessage(stripFillers(heard))
}
