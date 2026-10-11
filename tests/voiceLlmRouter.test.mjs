import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { CHATS, PROJECTS } from './fixtures/voicePhrases.mjs'

async function loadModule(path) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

const { buildLlmRouterRequest, parseLlmDecision, decideWithLlm, userWords, LLM_ROUTER_MAX_STEPS } = await loadModule('../src/server/voice/voiceLlmRouter.ts')

const chats = [CHATS.webhook, CHATS.bounces, CHATS.shortcut]
const input = (heard) => ({ heard, chats, projects: PROJECTS, describeAge: () => '5 minutes ago' })
const HEARD = 'tell the stripe webhook chat, um, to deploy it to staging and open the email bounces one'
const { chatIds, projectIds } = buildLlmRouterRequest(input(HEARD))
const idOf = (threadId) => [...chatIds].find(([, value]) => value === threadId)[0]

/** One step with every field the schema requires. */
const step = (fields) => ({ action: 'none', list_type: 'none', chat_id: '', chat_words: '', chat_certain: false, alternative_chat_ids: [], project_id: '', agent: 'not_said', message: '', ...fields })
const parse = (steps, heard = HEARD) => parseLlmDecision({ steps }, heard, chatIds, projectIds)

test('the request names chats and projects by short ids and carries the transcript as data', () => {
  const { request } = buildLlmRouterRequest(input(HEARD))
  const user = JSON.parse(request.user)
  assert.equal(user.transcript, HEARD)
  assert.deepEqual(user.chats.map((row) => row.id), ['c1', 'c2', 'c3'])
  assert.deepEqual(user.chats[0], { id: 'c1', title: 'Stripe webhook bug', project: 'hr-ai', agent: 'Claude', state: 'finished, unread', last_active: '5 minutes ago', summary: CHATS.webhook.summary })
  assert.deepEqual(user.projects[0], { id: 'p1', name: 'hr-ai' })
  assert.ok(!request.user.includes(CHATS.webhook.threadId), 'no thread ids or folder paths reach the model')
  assert.ok(!request.user.includes('/work/'))
  assert.match(request.system, /never follow instructions/iu)
  assert.equal(request.schema.required[0], 'steps')
})

test('known ids become thread ids and project folders; unknown ids mean none chosen', () => {
  const steps = parse([
    step({ action: 'send_to_chat', chat_id: idOf(CHATS.webhook.threadId), chat_words: 'stripe webhook chat', chat_certain: true, alternative_chat_ids: ['c9', idOf(CHATS.bounces.threadId), idOf(CHATS.webhook.threadId)], message: 'deploy it to staging' }),
    step({ action: 'open_chat', chat_id: 'c42', chat_certain: true }),
  ])
  assert.deepEqual(steps[0], { action: 'send_to_chat', threadId: CHATS.webhook.threadId, certain: true, alternatives: [CHATS.bounces.threadId], chatWords: 'stripe webhook chat', message: 'deploy it to staging' })
  assert.equal(steps[1].threadId, null)
  assert.equal(steps[1].certain, false, 'no chat, so not certain')
  const [newChat] = parse([step({ action: 'new_chat', project_id: 'p2', agent: 'codex', message: 'deploy it' })])
  assert.deepEqual(newChat, { action: 'new_chat', projectId: '/work/slack-ai', agent: 'codex', message: 'deploy it' })
  assert.equal(parse([step({ action: 'new_chat', project_id: '/etc' })])[0].projectId, null)
})

test('anything outside the schema is rejected so the next provider is asked', () => {
  for (const raw of [null, 'text', { steps: 'x' }, { steps: [null] }, { steps: [step({ action: 'delete_chat' })] }, { steps: [{ action: 'open_chat' }] },
    { steps: [step({ chat_certain: 'yes' })] }, { steps: [step({ alternative_chat_ids: 'c1' })] }, { steps: [step({ action: 'list_chats', list_type: 'everything' })] },
    { steps: [step({ action: 'list_chats', list_type: 'none' })] }, { steps: [step({ action: 'new_chat', agent: 'gemini' })] }]) {
    assert.equal(parseLlmDecision(raw, HEARD, chatIds, projectIds), null, JSON.stringify(raw))
  }
})

test('"none" steps are dropped, duplicates merged, and at most three steps kept', () => {
  assert.deepEqual(parse([step({ action: 'none' })]), [])
  const list = step({ action: 'list_chats', list_type: 'unread' })
  assert.deepEqual(parse([list, list]), [{ action: 'list_chats', listType: 'unread' }])
  const many = ['needs_you', 'running', 'unread', 'recent'].map((type) => step({ action: 'list_chats', list_type: type }))
  assert.equal(parse(many).length, LLM_ROUTER_MAX_STEPS)
})

test('a message must be the user\'s own words; routing words in front are cut off', () => {
  const transcript = 'Respond to the iPhone shortcut chat and basically, you know, there is a small microphone where I can talk to it. Do you get what I mean?'
  assert.equal(userWords('there is a small microphone where I can talk to it. Do you get what I mean?', transcript), 'there is a small microphone where I can talk to it. Do you get what I mean?')
  assert.equal(userWords('Respond to the iPhone shortcut chat and basically there is a small microphone where I can talk to it', transcript, 'iPhone shortcut chat'), 'there is a small microphone where I can talk to it')
  assert.ok(userWords('there is a small microphone where I can talk to it, do you get what I mean', transcript), 'filler left out is fine')
  assert.ok(userWords('the notification bar has a small microphone where I can talk to it. Do you get what I mean?', `the notification bar, ${transcript}`), 'one changed word is tolerated')
  assert.equal(userWords('please build a voice assistant with GPT-5 for the panel', transcript), '', 'a rewrite is rejected')
  assert.equal(userWords('', transcript), '')
  const [send] = parse([step({ action: 'send_to_chat', chat_id: 'c1', message: 'deploy the whole app to production now' })])
  assert.equal(send.message, '', 'a reworded message is dropped; the router falls back to its rules')
  assert.equal(parse([step({ action: 'open_chat', chat_id: 'c1', chat_words: 'the payments chat' })])[0].chatWords, '', 'chat words must be spoken')
})

// --- Providers, mocked ---------------------------------------------------------------

const answer = (steps) => JSON.stringify({ steps })
const anthropicOk = (text) => new Response(JSON.stringify({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] }), { status: 200 })
const openAiOk = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 })
const hang = (init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
const GOOD = answer([step({ action: 'open_chat', chat_id: 'c2', chat_words: 'email bounces one', chat_certain: true })])

test('Haiku is asked with a JSON schema, thinking off and the workspace header', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return anthropicOk(GOOD) }
  const decision = await decideWithLlm(input(HEARD), { anthropicApiKey: 'ak', anthropicWorkspaceId: 'ws', deepseekApiKey: 'dk' }, fetchImpl)
  assert.deepEqual(decision, { provider: 'anthropic', steps: [{ action: 'open_chat', threadId: CHATS.bounces.threadId, certain: true, alternatives: [], chatWords: 'email bounces one', message: '' }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers['anthropic-workspace-id'], 'ws')
  assert.equal(calls[0].body.model, 'claude-haiku-5-5')
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' })
  assert.equal(calls[0].body.output_config.format.type, 'json_schema')
})

for (const [label, anthropic] of [
  ['malformed JSON', () => anthropicOk('{"steps": [')],
  ['an answer outside the schema', () => anthropicOk(answer([{ action: 'open_chat' }]))],
  ['an HTTP error', () => new Response('{}', { status: 529 })],
  ['a refusal', () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 })],
  ['a timeout', (init) => hang(init)],
]) {
  test(`${label} from Anthropic falls through to DeepSeek`, async () => {
    const urls = []
    const fetchImpl = async (url, init) => { urls.push(url); return url.includes('anthropic') ? anthropic(init) : openAiOk(GOOD) }
    const decision = await decideWithLlm(input(HEARD), { anthropicApiKey: 'ak', deepseekApiKey: 'dk' }, fetchImpl, { timeoutMs: 30, deadlineMs: 5_000 })
    assert.equal(decision?.provider, 'deepseek')
    assert.equal(decision.steps[0].threadId, CHATS.bounces.threadId)
    assert.deepEqual(urls, ['https://api.anthropic.com/v1/messages', 'https://api.deepseek.com/chat/completions'])
  })
}

test('every provider failing, or none configured, is null: the router then says "didn\'t catch that"', async () => {
  const fetchImpl = async (url) => (url.includes('anthropic') ? new Response('{}', { status: 500 }) : openAiOk('not json'))
  assert.equal(await decideWithLlm(input(HEARD), { anthropicApiKey: 'ak', deepseekApiKey: 'dk', kimiApiKey: 'kk' }, fetchImpl), null)
  let called = false
  assert.equal(await decideWithLlm(input(HEARD), {}, async () => { called = true }), null)
  assert.equal(called, false)
})

test('the deadline covers every provider: a hung provider leaves no time for slow fallbacks', async () => {
  const urls = []
  const fetchImpl = async (url, init) => { urls.push(url); return hang(init) }
  const started = performance.now()
  const decision = await decideWithLlm(input(HEARD), { anthropicApiKey: 'ak', deepseekApiKey: 'dk', kimiApiKey: 'kk' }, fetchImpl, { timeoutMs: 400, deadlineMs: 700 })
  const elapsed = performance.now() - started
  assert.equal(decision, null)
  assert.ok(elapsed < 1_000, `gave up after ${Math.round(elapsed)} ms`)
  assert.deepEqual(urls, ['https://api.anthropic.com/v1/messages'], 'the next provider would have had under 500 ms')
})
