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

const { planVoicePrefill, modelForVoiceAgent, queryWithoutVoice, voiceQueryOnly, voiceCodeFromQuery, NEW_THREAD_DRAFT_KEY } = await loadModule('../src/utils/voicePrefill.ts')

const sections = { needs_you: [], running: [], unread: [], recent: [] }
const base = { code: 'c'.repeat(24), createdAtIso: '', expiresAtIso: '', sections, candidates: [], heard: 'what was said' }
const hrAi = { id: '/work/hr-ai', label: 'hr-ai' }

test('a chat link types the message into that chat', () => {
  const plan = planVoicePrefill({ ...base, action: 'send_to_chat', outcome: 'picker', message: 'deploy it' }, { route: 'thread', threadId: 't1' })
  assert.deepEqual(plan, { draftKey: 't1', message: 'deploy it', openProjectPicker: false, projectChoices: [], banner: { heard: 'what was said' } })
  assert.equal(planVoicePrefill({ ...base, action: 'open_chat', outcome: 'open_chat' }, { route: 'thread', threadId: 't1' }), null, 'nothing to type')
})

test('a new-chat link fills project, agent and message; an unclear project opens the picker', () => {
  const clear = planVoicePrefill({ ...base, action: 'new_chat', outcome: 'new_chat', message: 'fix it', project: hrAi, agent: 'codex' }, { route: 'home' })
  assert.equal(clear.draftKey, NEW_THREAD_DRAFT_KEY)
  assert.equal(clear.cwd, '/work/hr-ai')
  assert.equal(clear.agent, 'codex')
  assert.equal(clear.openProjectPicker, false)
  const options = [hrAi, { id: '/a', label: 'a' }, { id: '/b', label: 'b' }, { id: '/c', label: 'c' }]
  const unclear = planVoicePrefill({ ...base, action: 'new_chat', outcome: 'new_chat', message: 'fix it', project: null, projectOptions: options, agent: null }, { route: 'home' })
  assert.equal(unclear.cwd, undefined)
  assert.equal(unclear.openProjectPicker, true)
  assert.deepEqual(unclear.projectChoices, options.slice(0, 3))
  const noMessage = planVoicePrefill({ ...base, action: 'new_chat', outcome: 'new_chat', message: '', project: hrAi, agent: null }, { route: 'home' })
  assert.equal(noMessage.message, '', 'a new chat with no words still selects the project')
})

test('a send that lands on home keeps its words with a note', () => {
  const plan = planVoicePrefill({ ...base, action: 'send_to_chat', outcome: 'send_ready', threadId: 'gone', message: 'deploy it' }, { route: 'home' })
  assert.equal(plan.draftKey, NEW_THREAD_DRAFT_KEY)
  assert.equal(plan.message, 'deploy it')
  assert.match(plan.banner.note, /could not be opened/u)
  assert.equal(planVoicePrefill({ ...base, action: 'list_chats', outcome: 'picker' }, { route: 'home' }), null)
})

test('the spoken agent picks a model of that provider, or keeps the current one', () => {
  const models = [{ id: 'gpt', provider: 'openai' }, { id: 'claude-a', provider: 'anthropic' }, { id: 'claude-b', provider: 'anthropic' }]
  assert.equal(modelForVoiceAgent('claude', 'gpt', models), 'claude-a')
  assert.equal(modelForVoiceAgent('claude', 'claude-b', models), null, 'already a Claude model')
  assert.equal(modelForVoiceAgent('codex', 'claude-b', models), 'gpt')
  assert.equal(modelForVoiceAgent(null, 'gpt', models), null)
  assert.equal(modelForVoiceAgent('claude', 'gpt', [{ id: 'gpt', provider: 'openai' }]), null, 'no Claude model available yet')
})

test('voice query helpers keep or drop only the code', () => {
  const query = { voice: 'c'.repeat(24), board: 'b1' }
  assert.equal(voiceCodeFromQuery(query), 'c'.repeat(24))
  assert.equal(voiceCodeFromQuery({ voice: ['a', 'b'] }), '')
  assert.deepEqual(queryWithoutVoice(query), { board: 'b1' })
  assert.deepEqual(voiceQueryOnly(query), { voice: 'c'.repeat(24) })
  assert.deepEqual(voiceQueryOnly({ board: 'b1' }), {})
})
