import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

async function loadModule(path) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

const { activityLinkFromQuery, queryWithoutActivityLink, voiceActivityFocus, voiceActivityNote, voiceActivityQuery, planPanelVoiceLanding } = await loadModule('../src/utils/voiceLanding.ts')
const { describeMicError, voiceMicStatus, formatElapsed, NOTHING_HEARD } = await loadModule('../src/utils/voiceMic.ts')

const code = 'c'.repeat(24)

test('an ?activity= link names a panel section; anything else opens the top', () => {
  assert.equal(activityLinkFromQuery({}), null)
  assert.equal(activityLinkFromQuery({ voice: code }), null, 'a voice code alone is a composer link, not a panel link')
  assert.deepEqual(activityLinkFromQuery({ activity: 'unread', voice: code }), { focus: 'unread', code })
  for (const focus of ['needs_you', 'running', 'unread', 'recent', 'all']) assert.equal(activityLinkFromQuery({ activity: focus }).focus, focus)
  assert.deepEqual(activityLinkFromQuery({ activity: 'everything' }), { focus: 'all', code: '' })
  assert.equal(activityLinkFromQuery({ activity: ['unread', 'running'] }), null)
})

test('opening the panel drops only the link keys from the URL', () => {
  assert.deepEqual(queryWithoutActivityLink({ activity: 'unread', voice: code, other: 'kept' }), { other: 'kept' })
  assert.deepEqual(voiceActivityQuery('running', code), { activity: 'running', voice: code })
})

test('lists and "didn\'t catch that" belong on the panel; choosers and composer results do not', () => {
  const result = (fields) => ({ heard: 'x', sections: {}, candidates: [], ...fields })
  for (const listType of ['needs_you', 'running', 'unread', 'recent']) {
    assert.equal(voiceActivityFocus(result({ action: 'list_chats', outcome: 'picker', listType })), listType)
    assert.equal(voiceActivityFocus(result({ action: 'list_chats', outcome: 'empty', listType })), listType)
  }
  assert.equal(voiceActivityFocus(result({ action: 'list_chats', outcome: 'picker' })), 'all')
  assert.equal(voiceActivityFocus(result({ action: 'other', outcome: 'not_understood' })), 'all')
  assert.equal(voiceActivityFocus(result({ action: 'open_chat', outcome: 'not_understood', reason: 'no_chats' })), 'all')
  assert.equal(voiceActivityFocus(result({ action: 'open_chat', outcome: 'picker', reason: 'close_call' })), null)
  assert.equal(voiceActivityFocus(result({ action: 'open_chat', outcome: 'picker', reason: 'no_match' })), null)
  assert.equal(voiceActivityFocus(result({ action: 'send_to_chat', outcome: 'picker', message: 'deploy it' })), null)
  assert.equal(voiceActivityFocus(result({ action: 'send_to_chat', outcome: 'send_ready', message: 'deploy it' })), null)
  assert.equal(voiceActivityFocus(result({ action: 'new_chat', outcome: 'new_chat' })), null)
})

test('the panel note repeats what was heard, and says when the list was empty', () => {
  assert.deepEqual(voiceActivityNote({ heard: 'show unread', outcome: 'picker', listType: 'unread' }), { lead: '', heard: 'show unread', note: '' })
  assert.deepEqual(voiceActivityNote({ heard: 'anything unread', outcome: 'empty', listType: 'unread' }), { lead: '', heard: 'anything unread', note: 'Nothing unread ✓' })
  assert.equal(voiceActivityNote({ heard: 'what needs me', outcome: 'empty', listType: 'needs_you' }).note, 'Nothing needs you ✓')
  assert.equal(voiceActivityNote({ heard: 'running?', outcome: 'empty', listType: 'running' }).note, 'Nothing running ✓')
  assert.deepEqual(voiceActivityNote({ heard: 'uh the thing', outcome: 'not_understood' }), { lead: "Didn't catch that", heard: 'uh the thing', note: '' })
})

test('a command said into the panel: lists and "didn\'t catch that" stay in the panel, the rest open their page', () => {
  const url = '/#/voice/x'
  const list = planPanelVoiceLanding({ action: 'list_chats', outcome: 'picker', listType: 'running', heard: "what's running" }, url)
  assert.deepEqual(list, { kind: 'panel', landing: { focus: 'running', voice: { lead: '', heard: "what's running", note: '' }, inPanel: true } })
  const empty = planPanelVoiceLanding({ action: 'list_chats', outcome: 'empty', listType: 'unread', heard: 'unread' }, url)
  assert.equal(empty.landing.voice.note, 'Nothing unread ✓')
  const missed = planPanelVoiceLanding({ action: 'other', outcome: 'not_understood', heard: 'mm' }, url)
  assert.equal(missed.landing.focus, 'all')
  assert.equal(missed.landing.voice.lead, "Didn't catch that")
  assert.equal(missed.landing.voice.note, 'Tap the mic to say it again.')
  for (const result of [
    { action: 'list_chats', outcome: 'open_chat', listType: 'needs_you', heard: 'what needs me' },
    { action: 'open_chat', outcome: 'open_chat', heard: 'open it' },
    { action: 'send_to_chat', outcome: 'send_ready', heard: 'tell it' },
    { action: 'send_to_chat', outcome: 'picker', heard: 'tell the stripe one' },
    { action: 'new_chat', outcome: 'new_chat', heard: 'new chat' },
    { action: 'list_chats', outcome: 'steps', heard: 'show unread and running' },
  ]) assert.deepEqual(planPanelVoiceLanding(result, url), { kind: 'page', url }, `${result.action} ${result.outcome}`)
})

test('steps never land on the panel, even when the first step is a list', () => {
  assert.equal(voiceActivityFocus({ action: 'list_chats', outcome: 'steps', listType: 'unread' }), null)
})

test('the mic says what it is doing and what to do after a failure', () => {
  assert.deepEqual(voiceMicStatus({ isStarting: false, state: 'idle', error: '', canRetry: false }), { phase: 'idle', text: '', canRetry: false })
  assert.equal(voiceMicStatus({ isStarting: true, state: 'idle', error: '', canRetry: false }).phase, 'starting')
  assert.equal(voiceMicStatus({ isStarting: false, state: 'recording', error: '', canRetry: false, elapsedMs: 7_400 }).text, 'Listening… 0:07 · tap to stop')
  assert.equal(voiceMicStatus({ isStarting: false, state: 'transcribing', error: '', canRetry: false }).text, 'Working…')
  assert.deepEqual(voiceMicStatus({ isStarting: false, state: 'idle', error: NOTHING_HEARD, canRetry: true }), { phase: 'error', text: NOTHING_HEARD, canRetry: true })
  assert.equal(formatElapsed(65_000), '1:05')
  assert.match(describeMicError(Object.assign(new Error('denied'), { name: 'NotAllowedError' })), /Microphone access is blocked/u)
  assert.match(describeMicError({ name: 'NotFoundError' }), /No microphone/u)
  assert.equal(describeMicError(new Error('Transcription failed.')), 'Voice command failed: Transcription failed. Tap the mic to try again.')
})
