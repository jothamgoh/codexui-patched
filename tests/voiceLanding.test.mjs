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

const { activityLinkFromQuery, queryWithoutActivityLink, voiceActivityFocus, voiceActivityNote, voiceActivityQuery } = await loadModule('../src/utils/voiceLanding.ts')

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
