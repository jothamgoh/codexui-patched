import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import { VOICE_LIST_TYPES, type VoiceListType, type VoiceStoredResult } from '../types/voice'
import { voiceCodeFromQuery } from './voicePrefill'

/**
 * `/#/?activity=<focus>[&voice=<code>]` opens the notification panel on a
 * section. Voice lists and "didn't catch that" land there instead of a
 * separate page, because the panel already is the app's list of chats.
 */

/** A panel section to bring into view, or `all` for the top of the panel. */
export type ActivityFocus = VoiceListType | 'all'

export type ActivityLink = { focus: ActivityFocus; code: string }

/** What the panel says about the voice command that opened it. */
export type VoiceActivityNote = { lead: string; heard: string; note: string }

/** `inPanel`: said into the open panel's mic, so the panel keeps its size instead of becoming a sheet. */
export type ActivityLanding = { focus: ActivityFocus; voice: VoiceActivityNote | null; inPanel?: boolean }

const EMPTY_NOTES: Record<VoiceListType, string> = {
  needs_you: 'Nothing needs you ✓',
  running: 'Nothing running ✓',
  unread: 'Nothing unread ✓',
  recent: 'No recent chats',
}

export const EXPIRED_VOICE_NOTE: VoiceActivityNote = { lead: 'That voice link has expired. Say it again.', heard: '', note: '' }

function isActivityFocus(value: string): value is ActivityFocus {
  return value === 'all' || (VOICE_LIST_TYPES as readonly string[]).includes(value)
}

export function activityLinkFromQuery(query: LocationQuery): ActivityLink | null {
  const value = query.activity
  if (typeof value !== 'string') return null
  return { focus: isActivityFocus(value) ? value : 'all', code: voiceCodeFromQuery(query) }
}

export function queryWithoutActivityLink(query: LocationQuery): LocationQueryRaw {
  const next: LocationQueryRaw = { ...query }
  delete next.activity
  delete next.voice
  return next
}

/** The panel section a voice result belongs on, or null when it needs its own chooser. */
export function voiceActivityFocus(result: Pick<VoiceStoredResult, 'action' | 'outcome' | 'listType'>): ActivityFocus | null {
  if (result.outcome === 'steps') return null
  if (result.action === 'list_chats') return result.listType ?? 'all'
  if (result.outcome === 'not_understood') return 'all'
  return null
}

export function voiceActivityQuery(focus: ActivityFocus, code: string): LocationQueryRaw {
  return { activity: focus, voice: code }
}

export function voiceActivityNote(result: Pick<VoiceStoredResult, 'heard' | 'outcome' | 'listType'>): VoiceActivityNote {
  const lead = result.outcome === 'not_understood' ? "Didn't catch that" : ''
  const note = result.outcome === 'empty' && result.listType ? EMPTY_NOTES[result.listType] : ''
  return { lead, heard: result.heard, note }
}

/**
 * Where a command said into the panel's own mic lands. Lists and "didn't catch
 * that" stay in the panel (it is already the list of chats); everything else,
 * including a list with one chat, goes to the page the result's link opens.
 */
export type PanelVoiceLanding = { kind: 'panel'; landing: ActivityLanding } | { kind: 'page'; url: string }

export function planPanelVoiceLanding(result: Pick<VoiceStoredResult, 'action' | 'outcome' | 'listType' | 'heard'>, url: string): PanelVoiceLanding {
  const staysInPanel = result.outcome === 'not_understood' || (result.action === 'list_chats' && (result.outcome === 'picker' || result.outcome === 'empty'))
  const focus = staysInPanel ? voiceActivityFocus(result) : null
  if (!focus) return { kind: 'page', url }
  const voice = voiceActivityNote(result)
  // The panel's mic is right there; say how to try again.
  if (result.outcome === 'not_understood') voice.note = 'Tap the mic to say it again.'
  return { kind: 'panel', landing: { focus, voice, inPanel: true } }
}
