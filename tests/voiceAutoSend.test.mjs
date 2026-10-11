import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test, { mock } from 'node:test'
import { build } from 'esbuild'
import { CHATS, DEFAULT_PROJECT, PROJECTS, buildContext } from './fixtures/voicePhrases.mjs'

async function loadModule(path) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

const { decideAutoSend, decideAutoSendAll, AUTO_SEND_BASES } = await loadModule('../src/server/voice/voiceAutoSend.ts')
const { VoiceDeliveryQueue, voiceChatModel } = await loadModule('../src/server/voice/voiceDelivery.ts')
const { VoiceResultStore } = await loadModule('../src/server/voice/voiceStore.ts')
const { routeVoiceCommand } = await loadModule('../src/server/voice/voiceRouter.ts')
const { askJev, JEV_MODEL } = await loadModule('../src/server/voice/jevClient.ts')
const { parseVoiceSettings, DEFAULT_VOICE_SETTINGS } = await loadModule('../src/types/voice.ts')

const ON = { autoSend: true }
const OFF = { autoSend: false }
const send = (fields = {}) => ({ outcome: 'send_ready', threadId: CHATS.webhook.threadId, message: 'deploy it', basis: 'jev', candidates: [CHATS.webhook], ...fields })
const newChat = (fields = {}) => ({ outcome: 'new_chat', project: PROJECTS[0], message: 'fix the build', basis: 'words', candidates: [], ...fields })
const verdict = (decision) => (decision.auto ? decision.kind : `skip:${decision.skip}`)

// --- The decision table ----------------------------------------------------------------

test('auto-send decision table', () => {
  const rows = [
    ['clear Jev send', send(), ON, 'send'],
    ['Jev and the words agree', send({ basis: 'jev+words' }), ON, 'send'],
    ['LLM sure and Jev top two', send({ basis: 'jev+llm' }), ON, 'send'],
    ['LLM and the words agree', send({ basis: 'llm+words' }), ON, 'send'],
    ['LLM alone', send({ basis: 'llm' }), ON, 'skip:not_sure'],
    ['no basis recorded', send({ basis: undefined }), ON, 'skip:not_sure'],
    ['empty message', send({ message: '  ' }), ON, 'skip:no_message'],
    ['draft only', send({ draftOnly: true }), ON, 'skip:draft_only'],
    ['setting off', send(), OFF, 'skip:setting_off'],
    ['chooser with a message', { outcome: 'picker', message: 'deploy it', candidates: [CHATS.webhook, CHATS.checkout] }, ON, 'skip:not_actionable'],
    ['open a chat', { outcome: 'open_chat', threadId: CHATS.webhook.threadId, candidates: [CHATS.webhook] }, ON, 'skip:not_actionable'],
    ['steps as a whole', { outcome: 'steps', candidates: [] }, ON, 'skip:not_actionable'],
    ['list', { outcome: 'picker', listType: 'unread', candidates: [] }, ON, 'skip:not_actionable'],
    ["didn't catch that", { outcome: 'not_understood', candidates: [] }, ON, 'skip:not_actionable'],
    ['new chat, project named', newChat(), ON, 'new_chat'],
    ['new chat, Jev sure of the project', newChat({ basis: 'jev' }), ON, 'new_chat'],
    ['new chat, default project', newChat({ basis: 'default', project: DEFAULT_PROJECT }), ON, 'new_chat'],
    ['new chat, project only from the LLM', newChat({ basis: 'llm' }), ON, 'skip:not_sure'],
    ['new chat, no project', newChat({ project: null, basis: undefined }), ON, 'skip:no_project'],
    ['new chat, no message', newChat({ message: '' }), ON, 'skip:no_message'],
    ['new chat, draft only', newChat({ draftOnly: true }), ON, 'skip:draft_only'],
    ['new chat, setting off', newChat(), OFF, 'skip:setting_off'],
  ]
  for (const [label, result, settings, want] of rows) assert.equal(verdict(decideAutoSend(result, settings)), want, label)
  assert.ok(!AUTO_SEND_BASES.has('llm'))
})

test('each step is judged alone; open and list steps never run themselves', () => {
  const steps = { outcome: 'steps', candidates: [], steps: [send(), { outcome: 'open_chat', threadId: CHATS.bounces.threadId, candidates: [CHATS.bounces] }, newChat({ basis: 'llm' }), newChat({ basis: 'default', project: DEFAULT_PROJECT }), { outcome: 'picker', message: 'x', candidates: [] }] }
  assert.deepEqual(decideAutoSendAll(steps, ON).map(verdict), ['send', 'skip:not_actionable', 'skip:not_sure', 'new_chat', 'skip:not_actionable'])
  assert.deepEqual(decideAutoSendAll(steps, OFF).map(verdict), ['skip:setting_off', 'skip:not_actionable', 'skip:setting_off', 'skip:setting_off', 'skip:not_actionable'])
  assert.deepEqual(decideAutoSendAll(send(), ON).map(verdict), ['send'])
})

// --- Through the router: what each kind of command decides -----------------------------

function fakeJev(script) {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    const pass = 'action' in body.questions ? 'pass1' : 'pass2'
    const answers = {}
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === 'noul') { answers[id] = { type: 'noul', noul: script[pass]?.[id] ?? 0.03 }; continue }
      const keys = Object.keys(question.criteria)
      const wanted = script[pass]?.[id] ?? {}
      const used = Object.values(wanted).reduce((sum, value) => sum + value, 0)
      const rest = keys.filter((key) => !(key in wanted))
      const probabilities = Object.fromEntries(keys.map((key) => [key, key in wanted ? wanted[key] : (1 - used) / rest.length]))
      const [choice, top] = Object.entries(probabilities).sort((left, right) => right[1] - left[1])[0]
      answers[id] = { type: 'choice', choice, confidence: (top - 1 / keys.length) / (1 - 1 / keys.length), probabilities }
    }
    return new Response(JSON.stringify({ model: JEV_MODEL, answers }), { status: 200 })
  }
}
const routerDeps = (script, decision = null) => ({
  jev: (questions, state) => askJev(questions, state, { apiKey: 'k', fetchImpl: fakeJev(script), timeoutMs: 100 }),
  extractWithLlm: async () => null,
  decideWithLlm: async () => (decision ? { steps: decision, provider: 'anthropic' } : null),
})
const sureSend = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.93 } } }
const route = async (say, script, decision, context = buildContext()) => (await routeVoiceCommand(say, context, routerDeps(script, decision))).result

test('opt-out phrases are sends that are typed in, never sent', async () => {
  assert.equal(verdict(decideAutoSend(await route('tell the stripe webhook chat to deploy it', sureSend), ON)), 'send')
  for (const say of [
    'draft a message to the stripe webhook chat saying deploy it',
    'tell the stripe webhook chat to deploy it, don\'t send it',
    'tell the stripe webhook chat to deploy it but do not send yet',
    'just type deploy it in the stripe webhook chat',
    'tell the stripe webhook chat to deploy it, I\'ll send it myself',
    'tell the stripe webhook chat to deploy it, let me check it first',
    'tell the stripe webhook chat to deploy it without sending',
  ]) {
    const result = await route(say, sureSend)
    assert.equal(result.outcome, 'send_ready', say)
    assert.equal(result.message, 'deploy it', say)
    assert.equal(verdict(decideAutoSend(result, ON)), 'skip:draft_only', say)
  }
})

test('a close call is a chooser, and a chooser never sends itself', async () => {
  const close = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.45, [CHATS.checkout.threadId]: 0.4 } } }
  const result = await route('tell the stripe one to deploy it', close)
  assert.equal(result.outcome, 'picker')
  assert.equal(verdict(decideAutoSend(result, ON)), 'skip:not_actionable')
})

test('the LLM path sends only when the words or Jev agree', async () => {
  const unsure = { pass1: { action: { send_to_chat: 0.6, other: 0.3 } } }
  const llm = (threadKey, fields) => [{ action: 'send_to_chat', threadId: CHATS[threadKey].threadId, certain: true, alternatives: [], chatWords: '', message: 'add a mic', draftOnly: false, ...fields }]
  const agreed = await route('tell the iPhone shortcut chat to add a mic', unsure, llm('shortcut', { chatWords: 'iPhone shortcut chat' }))
  assert.equal(agreed.basis, 'llm+words')
  assert.equal(verdict(decideAutoSend(agreed, ON)), 'send')
  const alone = await route('tell the mobile layout one to add a mic', unsure, llm('login', {}))
  assert.equal(alone.outcome, 'send_ready')
  assert.equal(verdict(decideAutoSend(alone, ON)), 'skip:not_sure', 'the LLM alone pre-types it')
})

test('a standalone task starts in the default project; with no default it waits for a project tap', async () => {
  const task = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { not_named: 0.94 } } }
  const withDefault = await route('find me the best hotels in Johor Bahru', task, null, buildContext({ defaultProject: DEFAULT_PROJECT }))
  assert.equal(verdict(decideAutoSend(withDefault, ON)), 'new_chat')
  const without = await route('find me the best hotels in Johor Bahru', task)
  assert.equal(verdict(decideAutoSend(without, ON)), 'skip:no_project')
})

test('steps: sure sends and new chats run, the rest wait for a tap', async () => {
  const compound = { pass1: { action: { send_to_chat: 0.9 }, compound: 0.9 } }
  const decision = [
    { action: 'send_to_chat', threadId: CHATS.webhook.threadId, certain: true, alternatives: [], chatWords: 'stripe webhook chat', message: 'deploy it', draftOnly: false },
    { action: 'open_chat', threadId: CHATS.bounces.threadId, certain: true, alternatives: [], chatWords: 'email bounces chat', message: '', draftOnly: false },
    { action: 'new_chat', projectId: PROJECTS[0].id, projectNamed: true, agent: null, message: 'fix the quiz', draftOnly: false },
    { action: 'send_to_chat', threadId: CHATS.login.threadId, certain: true, alternatives: [], chatWords: '', message: 'merge it', draftOnly: false },
  ]
  const result = await route('tell the stripe webhook chat to deploy it, open the email bounces chat, new chat in hr-ai to fix the quiz and tell the mobile one to merge it', compound, decision)
  assert.equal(result.outcome, 'steps')
  assert.deepEqual(decideAutoSendAll(result, ON).map(verdict), ['send', 'skip:not_actionable', 'new_chat', 'skip:not_sure'])
})

test('settings parse field by field with safe defaults', () => {
  assert.deepEqual(DEFAULT_VOICE_SETTINGS, { autoSend: true, delaySeconds: 0, defaultProject: '' })
  assert.deepEqual(parseVoiceSettings(null), DEFAULT_VOICE_SETTINGS)
  assert.deepEqual(parseVoiceSettings({ autoSend: false, delaySeconds: 5, defaultProject: '/work/notes' }), { autoSend: false, delaySeconds: 5, defaultProject: '/work/notes' })
  assert.deepEqual(parseVoiceSettings({ autoSend: 'yes', delaySeconds: 7, defaultProject: 'relative/path' }), DEFAULT_VOICE_SETTINGS)
})

test('a voice new chat uses the spoken agent, else the configured default model', () => {
  const isClaude = (id) => id.startsWith('claude-')
  assert.equal(voiceChatModel(null, 'claude-default', isClaude), 'claude-default')
  assert.equal(voiceChatModel(null, '', isClaude), undefined)
  assert.equal(voiceChatModel('codex', 'claude-default', isClaude), undefined, 'Codex picks its own default')
  assert.equal(voiceChatModel('codex', 'gpt-x', isClaude), 'gpt-x')
  assert.equal(voiceChatModel('claude', 'gpt-x', isClaude), 'claude-default')
  assert.equal(voiceChatModel('claude', 'claude-opus', isClaude), 'claude-opus')
})

// --- The undo window, with fake timers ---------------------------------------------------

const T0 = Date.UTC(2026, 9, 11, 9, 41, 0)

function setup(t, { sendFails = false, startFails = false } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 })
  t.after(() => mock.timers.reset())
  const sent = []
  const started = []
  const logs = []
  const store = new VoiceResultStore()
  const queue = new VoiceDeliveryQueue({
    store,
    sendMessage: async (threadId, text) => { if (sendFails) throw new Error('turn/start failed'); sent.push({ threadId, text }) },
    startChat: async (input) => { if (startFails) throw new Error('thread/start failed'); started.push(input); return { threadId: `new-${started.length}` } },
    log: (line) => logs.push(line),
  })
  const saved = store.save({ heard: 'tell the stripe webhook chat to deploy it', action: 'send_to_chat', outcome: 'send_ready', threadId: CHATS.webhook.threadId, message: 'deploy it', sections: buildContext().sections, candidates: [CHATS.webhook], basis: 'jev' })
  const target = { kind: 'send', code: saved.code, threadId: CHATS.webhook.threadId, message: 'deploy it', label: 'Stripe webhook bug' }
  return { store, queue, sent, started, logs, saved, target }
}
/** Lets the timer's async send finish. */
const settle = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve() }

test('a scheduled send waits for the window, then goes out once with its outcome recorded', async (t) => {
  const { store, queue, sent, logs, saved, target } = setup(t)
  const settled = []
  assert.equal(await queue.deliver(saved.code, [target], { delaySeconds: 5, trigger: 'auto', onSettled: (outcomes) => settled.push(outcomes) }), null)
  assert.equal(store.get(saved.code).delivery.state, 'pending')
  assert.equal(store.get(saved.code).delivery.remainingMs, 5000)
  mock.timers.tick(4999)
  await settle()
  assert.equal(sent.length, 0, 'not before the window ends')
  assert.equal(store.get(saved.code).delivery.remainingMs, 1)
  mock.timers.tick(1)
  await settle()
  assert.deepEqual(sent, [{ threadId: CHATS.webhook.threadId, text: 'deploy it' }])
  assert.equal(store.get(saved.code).delivery.state, 'sent')
  assert.equal(settled.length, 1)
  assert.equal(settled[0][0].state, 'sent')
  mock.timers.tick(60_000)
  await settle()
  assert.equal(sent.length, 1, 'a timer fires at most once')
  assert.equal(queue.cancel(saved.code), false, 'too late to cancel')
  assert.equal(store.get(saved.code).delivery.state, 'sent')
  assert.ok(logs.some((line) => /auto_send=scheduled trigger=auto kinds=send delay=5000ms/u.test(line)))
  assert.ok(logs.some((line) => /auto_send=sent trigger=auto kind=send waited=5000ms send=\d+ms/u.test(line)))
  assert.ok(logs.every((line) => !line.includes('deploy') && !line.includes('Stripe')), 'logs never carry the message or the chat')
})

test('cancel before the window ends: nothing is sent, and a second cancel changes nothing', async (t) => {
  const { store, queue, sent, logs, saved, target } = setup(t)
  const settled = []
  await queue.deliver(saved.code, [target], { delaySeconds: 3, trigger: 'auto', onSettled: (outcomes) => settled.push(outcomes) })
  mock.timers.tick(1200)
  assert.equal(queue.cancel(saved.code), true)
  assert.equal(store.get(saved.code).delivery.state, 'cancelled')
  assert.equal(queue.cancel(saved.code), false, 'idempotent')
  mock.timers.tick(10_000)
  await settle()
  assert.equal(sent.length, 0)
  assert.equal(settled.length, 0, 'no "Sent" notification when everything was cancelled')
  assert.equal(queue.pendingCount, 0)
  assert.ok(logs.some((line) => /auto_send=cancelled trigger=auto kind=send after=1200ms/u.test(line)))
})

test('cancel only works for its own code', async (t) => {
  const { store, queue, sent, saved, target } = setup(t)
  const other = store.save({ heard: 'x', action: 'send_to_chat', outcome: 'send_ready', threadId: CHATS.bounces.threadId, message: 'retry', sections: buildContext().sections, candidates: [CHATS.bounces] })
  await queue.deliver(saved.code, [target], { delaySeconds: 3, trigger: 'auto' })
  await queue.deliver(other.code, [{ ...target, code: other.code, threadId: CHATS.bounces.threadId, message: 'retry' }], { delaySeconds: 3, trigger: 'auto' })
  assert.equal(queue.cancel(other.code), true)
  assert.equal(queue.cancel('A'.repeat(24)), false, 'an unknown code cancels nothing')
  mock.timers.tick(3000)
  await settle()
  assert.deepEqual(sent, [{ threadId: CHATS.webhook.threadId, text: 'deploy it' }])
})

test('a failed send is recorded and logged, and the outcome says so', async (t) => {
  const { store, queue, logs, saved, target } = setup(t, { sendFails: true })
  const settled = []
  await queue.deliver(saved.code, [target], { delaySeconds: 3, trigger: 'auto', onSettled: (outcomes) => settled.push(outcomes) })
  mock.timers.tick(3000)
  await settle()
  assert.equal(store.get(saved.code).delivery.state, 'failed')
  assert.equal(settled[0][0].state, 'failed')
  assert.ok(logs.some((line) => /auto_send=failed trigger=auto kind=send waited=3000ms send=\d+ms error=Error/u.test(line)))
})

test('with no window it sends at once and returns the outcome', async (t) => {
  const { store, queue, sent, saved, target } = setup(t)
  const outcomes = await queue.deliver(saved.code, [target], { delaySeconds: 0, trigger: 'auto' })
  assert.deepEqual(outcomes.map((outcome) => outcome.state), ['sent'])
  assert.equal(sent.length, 1)
  assert.equal(store.get(saved.code).delivery.state, 'sent')
  assert.equal(store.get(saved.code).delivery.remainingMs, 0)
  assert.equal(queue.cancel(saved.code), false)
})

test('a restart drops waiting sends unsent and logs how many', async (t) => {
  const { queue, sent, logs, saved, target } = setup(t)
  await queue.deliver(saved.code, [target], { delaySeconds: 10, trigger: 'auto' })
  assert.equal(queue.dispose(), 1)
  mock.timers.tick(20_000)
  await settle()
  assert.equal(sent.length, 0)
  assert.ok(logs.includes('[voice] auto_send=dropped count=1 reason=shutdown'))
  assert.equal(queue.dispose(), 0, 'nothing left the second time')
})

test('steps go out in order; one step can be cancelled on its own', async (t) => {
  const { store, queue, sent, started, saved, target } = setup(t)
  const second = store.save({ heard: 'x', action: 'new_chat', outcome: 'new_chat', project: PROJECTS[0], message: 'fix the quiz', sections: buildContext().sections, candidates: [] })
  const third = store.save({ heard: 'x', action: 'send_to_chat', outcome: 'send_ready', threadId: CHATS.bounces.threadId, message: 'retry', sections: buildContext().sections, candidates: [CHATS.bounces] })
  const targets = [
    target,
    { kind: 'new_chat', code: second.code, cwd: PROJECTS[0].id, agent: 'claude', message: 'fix the quiz', label: 'hr-ai' },
    { kind: 'send', code: third.code, threadId: CHATS.bounces.threadId, message: 'retry', label: 'Customer email bounces' },
  ]
  const settled = []
  await queue.deliver('P'.repeat(24), targets, { delaySeconds: 5, trigger: 'auto', onSettled: (outcomes) => settled.push(outcomes) })
  assert.equal(queue.cancel(third.code), true)
  mock.timers.tick(5000)
  await settle()
  assert.deepEqual(sent, [{ threadId: CHATS.webhook.threadId, text: 'deploy it' }])
  assert.deepEqual(started, [{ cwd: PROJECTS[0].id, agent: 'claude', message: 'fix the quiz' }])
  assert.deepEqual(settled[0].map((outcome) => [outcome.state, outcome.threadId ?? null]), [['sent', CHATS.webhook.threadId], ['sent', 'new-1'], ['cancelled', null]])
  assert.equal(store.get(second.code).delivery.threadId, 'new-1', 'the new chat is recorded so its link opens it')
  assert.equal(store.get(third.code).delivery.state, 'cancelled')
})

test('cancelling the whole command cancels every step', async (t) => {
  const { queue, sent, saved, target } = setup(t)
  await queue.deliver('Q'.repeat(24), [target], { delaySeconds: 5, trigger: 'auto' })
  assert.equal(queue.cancel('Q'.repeat(24)), true)
  mock.timers.tick(5000)
  await settle()
  assert.equal(sent.length, 0)
  assert.equal(queue.cancel(saved.code), false)
})
