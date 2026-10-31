import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { CHATS, buildContext } from './fixtures/voicePhrases.mjs'

// Bundled to a file under output/ so external packages (markdown-it, the Claude SDK) resolve from node_modules.
const bundleDir = fileURLToPath(new URL('../output/test-bundles/', import.meta.url))
async function loadModule(path) {
  const outfile = join(bundleDir, `watch-command-${path.split('/').at(-1).replace(/\.ts$/u, '')}-${process.pid}.mjs`)
  await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    outfile,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    packages: 'external',
  })
  try {
    return await import(pathToFileURL(outfile).href)
  } finally {
    await rm(outfile, { force: true })
  }
}

const { routeVoiceCommand } = await loadModule('../src/server/voice/voiceRouter.ts')
const { buildLlmRouterRequest, parseLlmDecision, LLM_ROUTER_INSTRUCTIONS } = await loadModule('../src/server/voice/voiceLlmRouter.ts')
const { JEV_MODEL } = await loadModule('../src/server/voice/jevClient.ts')
const routes = await loadModule('../src/server/watch/watchRoutes.ts')

/** A Choice answer over the question's own options: named probabilities, the rest spread evenly. */
function choiceAnswer(criteria, wanted) {
  const keys = Object.keys(criteria)
  const named = Object.entries(wanted).filter(([key]) => keys.includes(key))
  const used = named.reduce((sum, [, value]) => sum + value, 0)
  const others = keys.filter((key) => !(key in wanted))
  const probabilities = Object.fromEntries(keys.map((key) => [key, 0]))
  for (const [key, value] of named) probabilities[key] = value
  for (const key of others) probabilities[key] = Math.max(0, 1 - used) / others.length
  if (others.length === 0) for (const key of keys) probabilities[key] /= used
  const [choice, top] = Object.entries(probabilities).sort((left, right) => right[1] - left[1])[0]
  return { type: 'choice', choice, confidence: (top - 1 / keys.length) / (1 - 1 / keys.length), probabilities }
}

/**
 * Jev's answers by phrase: `action`, `list`, `chat`, `project` are { option: probability },
 * `compound` a number. A phrase not in the table is out of scope for Jev (`other`).
 */
function jevTable(table) {
  return (id, state) => {
    const entry = table[state.spoken_request] ?? {}
    if (id === 'action') return entry.action ?? { other: 0.95 }
    if (id === 'list_type') return entry.list ?? { recent: 0.9 }
    if (id === 'compound') return entry.compound ?? 0.03
    if (id === 'chat') return entry.chat ?? { none: 0.9 }
    if (id === 'project') return entry.project ?? { not_named: 0.94 }
    return { not_said: 0.93 }
  }
}

function answerQuestions(questions, state, spec) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const wanted = spec(id, state) ?? {}
    return [id, question.type === 'noul' ? { type: 'noul', noul: typeof wanted === 'number' ? wanted : 0.03 } : choiceAnswer(question.criteria, wanted)]
  }))
}

// --- The router with a screen (VoiceRouteOptions), against the fictional voice fixture ----------------

/** Router deps with a scripted Jev; `decision` is what the LLM fallback returns (steps, or null for none). */
function routerDeps(table = {}, { decision = null, calls = [], decisions = [] } = {}) {
  const spec = jevTable(table)
  return {
    jev: async (questions, state) => {
      calls.push({ questions: Object.keys(questions), state })
      return { ok: true, answers: answerQuestions(questions, state, spec), elapsedMs: 1 }
    },
    extractWithLlm: async () => null,
    decideWithLlm: async (input) => {
      decisions.push(input)
      const steps = typeof decision === 'function' ? decision(input) : decision
      return steps ? { steps, provider: 'anthropic' } : null
    },
  }
}
const WATCH = { chatActions: true }
const ids = (rows) => rows.map((row) => row.threadId)

test('a whole section is decided by code: "all unread" sends the rest of the words to each unread chat, no Jev call', async () => {
  for (const [say, message] of [
    ['tell all unread to summarize concisely', 'summarize concisely'],
    ["send 'summarize concisely' to all unread", 'summarize concisely'],
    ['tell all my unread chats to push it', 'push it'],
    ['let every chat that finished know I am merging now', 'I am merging now'],
    ['all unread: push it', 'push it'],
  ]) {
    const calls = []
    const { result } = await routeVoiceCommand(say, buildContext(), routerDeps({}, { calls }), WATCH)
    assert.equal(result.outcome, 'send_ready', say)
    assert.equal(result.group, 'unread', say)
    assert.deepEqual(ids(result.candidates), ids(buildContext().sections.unread), say)
    assert.equal(result.message, message, say)
    assert.equal(result.basis, 'words', say)
    assert.equal(calls.length, 0, `${say}: no Jev call`)
  }
  const running = await routeVoiceCommand('ask all running whether they are done', buildContext(), routerDeps(), WATCH)
  assert.deepEqual([running.result.group, ids(running.result.candidates)], ['running', ids(buildContext().sections.running)])
  const needs = await routeVoiceCommand('reply to all that need me with yes', buildContext(), routerDeps(), WATCH)
  assert.deepEqual([needs.result.group, needs.result.message], ['needs_you', 'yes'])
})

test('a whole section is at most 6 chats, in panel order', async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ ...CHATS.bounces, threadId: `unread-${String(index)}`, title: `Unread ${String(index)}` }))
  const context = buildContext({ sections: { unread: many } })
  for (const say of ['tell all unread to push it', 'summarize all unread', 'catch me up']) {
    const { result } = await routeVoiceCommand(say, context, routerDeps(), WATCH)
    assert.deepEqual(ids(result.candidates), ids(many.slice(0, 6)), say)
  }
  const empty = await routeVoiceCommand('tell all running to push it', buildContext({ sections: { running: [] } }), routerDeps(), WATCH)
  assert.deepEqual([empty.result.outcome, empty.result.reason], ['empty', 'empty_group'])
})

test('a whole section without words to send asks the LLM, which must use the user\'s own words', async () => {
  const decisions = []
  const cut = await routeVoiceCommand('tell all unread', buildContext(), routerDeps({}, {
    decisions,
    decision: [{ action: 'send_to_chat', threadId: null, certain: false, alternatives: [], chatWords: 'all unread', message: '', draftOnly: false }],
  }), WATCH)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].chatActions, true, 'the LLM gets the watch actions')
  assert.deepEqual([cut.result.outcome, cut.result.reason, cut.result.group], ['not_understood', 'no_message', 'unread'], 'no words, nothing sent')
})

test('stop: a whole section, the open chat, or a chat by name through Jev', async () => {
  const all = await routeVoiceCommand('stop all running', buildContext(), routerDeps(), WATCH)
  assert.deepEqual([all.result.outcome, all.result.group, ids(all.result.candidates)], ['stop_ready', 'running', ids(buildContext().sections.running)])
  const everything = await routeVoiceCommand('pause all the running agents', buildContext(), routerDeps(), WATCH)
  assert.equal(everything.result.outcome, 'stop_ready')

  const open = await routeVoiceCommand('stop it', buildContext(), routerDeps(), { ...WATCH, openChat: CHATS.exportJob })
  assert.deepEqual([open.result.outcome, open.result.threadId, open.result.basis], ['stop_ready', CHATS.exportJob.threadId, 'screen'])
  const which = await routeVoiceCommand('stop it', buildContext(), routerDeps(), WATCH)
  assert.deepEqual([which.result.outcome, which.result.reason], ['picker', 'which_chat'], 'no chat open: which of the working chats')
  assert.deepEqual(ids(which.result.candidates), [...ids(buildContext().sections.running), ...ids(buildContext().sections.needs_you)])

  const calls = []
  const named = await routeVoiceCommand('stop the nightly export job', buildContext(), routerDeps({ 'stop the nightly export job': { chat: { [CHATS.exportJob.threadId]: 0.93 } } }, { calls }), WATCH)
  assert.deepEqual([named.result.outcome, named.result.threadId, named.result.basis], ['stop_ready', CHATS.exportJob.threadId, 'jev'])
  assert.deepEqual(calls.map((call) => call.questions), [['chat']], 'only pass 2: the rule already knows it is a stop')
  assert.equal(calls[0].state.chat_named_as, 'the nightly export job')
})

test('summarize: catching up names the unread chats, "what did X say" names X, and a topic is not a chat', async () => {
  const catchUp = await routeVoiceCommand('catch me up', buildContext(), routerDeps(), WATCH)
  assert.deepEqual([catchUp.result.outcome, catchUp.result.group, ids(catchUp.result.candidates)], ['summarize_ready', 'unread', ids(buildContext().sections.unread)])
  const mine = await routeVoiceCommand('summarize my unread chats', buildContext(), routerDeps(), WATCH)
  assert.equal(mine.result.group, 'unread')
  const thisOne = await routeVoiceCommand('summarize this', buildContext(), routerDeps(), { ...WATCH, openChat: CHATS.notes })
  assert.deepEqual([thisOne.result.outcome, ids(thisOne.result.candidates)], ['summarize_ready', [CHATS.notes.threadId]])

  const said = await routeVoiceCommand('what did the stripe webhook chat say', buildContext(), routerDeps({ 'what did the stripe webhook chat say': { chat: { [CHATS.webhook.threadId]: 0.93 } } }), WATCH)
  assert.deepEqual([said.result.outcome, said.result.threadId], ['summarize_ready', CHATS.webhook.threadId])

  const news = 'summarise the latest news on OpenAI'
  const topic = await routeVoiceCommand(news, buildContext({ defaultProject: { id: '/work/notes-vault', label: 'notes-vault' } }), routerDeps({ [news]: { action: { new_chat: 0.95 } } }), WATCH)
  assert.deepEqual([topic.result.outcome, topic.result.message], ['new_chat', news], 'a task, as on the iPhone')
})

test('with a chat open, replies and plain words go to it; a chat named in so many words still wins', async () => {
  const screen = { ...WATCH, openChat: CHATS.notes }
  const calls = []
  const reply = await routeVoiceCommand('reply yes go ahead', buildContext(), routerDeps({}, { calls }), screen)
  assert.deepEqual([reply.result.outcome, reply.result.threadId, reply.result.message, reply.result.basis], ['send_ready', CHATS.notes.threadId, 'yes go ahead', 'screen'])
  const tell = await routeVoiceCommand('tell it to run the tests', buildContext(), routerDeps({}, { calls }), screen)
  assert.deepEqual([tell.result.threadId, tell.result.message], [CHATS.notes.threadId, 'run the tests'])
  assert.equal(calls.length, 0, 'replies are settled by the rules')

  const fragment = await routeVoiceCommand('deploy it', buildContext(), routerDeps(), screen)
  assert.deepEqual([fragment.result.outcome, fragment.result.threadId, fragment.result.message], ['send_ready', CHATS.notes.threadId, 'deploy it'], 'Jev calls it other: the open chat gets it')
  const task = await routeVoiceCommand('run the tests again', buildContext(), routerDeps({ 'run the tests again': { action: { new_chat: 0.9 } } }), screen)
  assert.deepEqual([task.result.outcome, task.result.threadId], ['send_ready', CHATS.notes.threadId], 'a task said on its own is a reply, not a new chat')
  const newChat = await routeVoiceCommand('new chat in hr-ai, fix the build', buildContext(), routerDeps({ 'new chat in hr-ai, fix the build': { action: { new_chat: 0.95 }, project: { 'hr-ai': 0.94 } } }), screen)
  assert.deepEqual([newChat.result.outcome, newChat.result.project?.label], ['new_chat', 'hr-ai'], '"new chat" still starts one')

  const say = 'tell the slack bot chat to raise the timeout'
  const other = await routeVoiceCommand(say, buildContext(), routerDeps({ [say]: { action: { send_to_chat: 0.95 }, chat: { [CHATS.slackBot.threadId]: 0.93 } } }), screen)
  assert.deepEqual([other.result.outcome, other.result.threadId, other.result.message], ['send_ready', CHATS.slackBot.threadId, 'raise the timeout'], 'an explicit target beats the open chat')

  const topic = 'the slack bot should raise the timeout'
  const topicCalls = []
  const onTopic = await routeVoiceCommand(topic, buildContext(), routerDeps({ [topic]: { action: { send_to_chat: 0.9 }, chat: { [CHATS.slackBot.threadId]: 0.95 } } }, { calls: topicCalls }), screen)
  assert.equal(onTopic.result.threadId, CHATS.notes.threadId, 'words that share a title but call no chat a chat stay with the open chat')
  assert.deepEqual(topicCalls.map((call) => call.questions.includes('chat')), [false], 'and need no pass 2')
  const called = 'the slack bot chat should raise the timeout'
  const unsure = await routeVoiceCommand(called, buildContext(), routerDeps({ [called]: { action: { send_to_chat: 0.9 }, chat: { [CHATS.slackBot.threadId]: 0.45, [CHATS.bounces.threadId]: 0.35 } } }), screen)
  assert.equal(unsure.result.threadId, CHATS.notes.threadId, 'a chat called a chat, but a close call: the open chat')
  const sure = await routeVoiceCommand(called, buildContext(), routerDeps({ [called]: { action: { send_to_chat: 0.9 }, chat: { [CHATS.slackBot.threadId]: 0.95 } } }), screen)
  assert.equal(sure.result.threadId, CHATS.slackBot.threadId, 'a chat called a chat, and Jev sure of it')

  const list = await routeVoiceCommand("what's running", buildContext(), routerDeps({ "what's running": { action: { list_chats: 0.95 }, list: { running: 0.95 } } }), screen)
  assert.deepEqual([list.result.action, list.result.listType], ['list_chats', 'running'], 'a list is a list')
})

test('the screen breaks near-ties: the open chat, else the only one on screen', async () => {
  const say = 'open the stripe one'
  const table = { [say]: { action: { open_chat: 0.95 }, chat: { [CHATS.webhook.threadId]: 0.45, [CHATS.checkout.threadId]: 0.3, [CHATS.payouts.threadId]: 0.2 } } }
  const plain = await routeVoiceCommand(say, buildContext(), routerDeps(table), WATCH)
  assert.equal(plain.result.outcome, 'picker')
  const open = await routeVoiceCommand(say, buildContext(), routerDeps(table), { ...WATCH, openChat: CHATS.checkout })
  assert.deepEqual([open.result.outcome, open.result.threadId], ['open_chat', CHATS.checkout.threadId])
  const visible = await routeVoiceCommand(say, buildContext(), routerDeps(table), { ...WATCH, visibleChatIds: [CHATS.migration.threadId, CHATS.payouts.threadId] })
  assert.deepEqual([visible.result.outcome, visible.result.threadId], ['open_chat', CHATS.payouts.threadId])
  const two = await routeVoiceCommand(say, buildContext(), routerDeps(table), { ...WATCH, visibleChatIds: [CHATS.webhook.threadId, CHATS.payouts.threadId] })
  assert.equal(two.result.outcome, 'picker', 'two on screen: still a choice')
  const calls = []
  await routeVoiceCommand(say, buildContext(), routerDeps(table, { calls }), { ...WATCH, visibleChatIds: [CHATS.ingress.threadId] })
  assert.equal(calls[0].state.chat_titles[0], CHATS.ingress.title, 'chats on screen are offered first')
  const sureElsewhere = await routeVoiceCommand(say, buildContext(), routerDeps({ [say]: { action: { open_chat: 0.95 }, chat: { [CHATS.webhook.threadId]: 0.9 } } }), { ...WATCH, visibleChatIds: [CHATS.migration.threadId] })
  assert.equal(sureElsewhere.result.outcome, 'picker', 'twins named by the same word stay a choice when none is on screen')
})

test('the iPhone path is unchanged: no options, no screen rules, and the same LLM request', async () => {
  for (const say of ['stop all running', 'catch me up', 'tell all unread to summarize concisely']) {
    const calls = []
    const { result } = await routeVoiceCommand(say, buildContext(), routerDeps({}, { calls }))
    assert.equal(result.outcome, 'not_understood', say)
    assert.equal(result.group, undefined)
    assert.ok(calls.length > 0, `${say}: Jev decides, as before`)
  }
  const input = { heard: 'stop the export job', chats: [CHATS.exportJob], projects: [], describeAge: () => 'now' }
  const phone = buildLlmRouterRequest(input).request
  assert.equal(phone.system, LLM_ROUTER_INSTRUCTIONS)
  assert.ok(!phone.system.includes('stop_chats') && !JSON.stringify(phone.schema).includes('stop_chats'))
  const watch = buildLlmRouterRequest({ ...input, chatActions: true }).request
  assert.ok(watch.system.includes('stop_chats') && JSON.stringify(watch.schema).includes('summarize_chats'))
  const raw = { steps: [{ action: 'stop_chats', list_type: 'none', chat_id: 'c1', chat_words: 'the export job', chat_certain: true, alternative_chat_ids: [], project_id: '', project_named: false, agent: 'not_said', message: '', draft_only: false }] }
  const chatIds = new Map([['c1', CHATS.exportJob.threadId]])
  assert.equal(parseLlmDecision(raw, 'stop the export job', chatIds, new Map()), null, 'the iPhone never takes a stop step')
  assert.deepEqual(parseLlmDecision(raw, 'stop the export job', chatIds, new Map(), true).map((step) => [step.action, step.threadId]), [['stop_chats', CHATS.exportJob.threadId]])
  raw.steps[0].chat_id = 'c9'
  assert.equal(parseLlmDecision(raw, 'stop the export job', chatIds, new Map(), true)[0].threadId, null, 'an id outside the options is no chat')
})

test('LLM steps: a section comes from the words the model copied, and the open chat takes a step with no chat', async () => {
  const halted = 'the busy agents should all be halted now'
  const decision = [{ action: 'stop_chats', threadId: CHATS.checkout.threadId, certain: true, alternatives: [], chatWords: 'the busy agents', message: '', draftOnly: false }]
  const { result } = await routeVoiceCommand(halted, buildContext(), routerDeps({ [halted]: { action: { other: 0.6 } } }, { decision }), WATCH)
  assert.deepEqual([result.outcome, result.group, ids(result.candidates)], ['stop_ready', 'running', ids(buildContext().sections.running)], 'the section from the words, whatever chat the model named')
  const noChat = [{ action: 'send_to_chat', threadId: null, certain: false, alternatives: [], chatWords: '', message: 'try the other approach', draftOnly: false }]
  const plain = 'hmm maybe try the other approach instead'
  const reply = await routeVoiceCommand(plain, buildContext(), routerDeps({ [plain]: { action: { other: 0.6 } } }, { decision: noChat }), { ...WATCH, openChat: CHATS.notes })
  assert.deepEqual([reply.result.outcome, reply.result.threadId, reply.result.message], ['send_ready', CHATS.notes.threadId, 'try the other approach'])
  // Found live: the model guessed another chat without naming words, and a title shared one spoken word.
  const charts = 'hmm make the charts bigger'
  const guessedSend = [{ action: 'send_to_chat', threadId: CHATS.dashboard.threadId, certain: false, alternatives: [], chatWords: '', message: 'make the charts bigger', draftOnly: false }]
  const kept = await routeVoiceCommand(charts, buildContext(), routerDeps({ [charts]: { action: { other: 0.6 } } }, { decision: guessedSend }), { ...WATCH, openChat: CHATS.notes })
  assert.deepEqual([kept.result.outcome, kept.result.threadId, kept.result.message], ['send_ready', CHATS.notes.threadId, 'make the charts bigger'], 'never another chat on a guess')
  const cited = [{ ...guessedSend[0], certain: true, chatWords: 'the charts' }]
  const topicWords = await routeVoiceCommand(charts, buildContext(), routerDeps({ [charts]: { action: { other: 0.6 } } }, { decision: cited }), { ...WATCH, openChat: CHATS.notes })
  assert.equal(topicWords.result.threadId, CHATS.notes.threadId, 'words the model cited from the message itself do not name a chat')
  const phone = await routeVoiceCommand(charts, buildContext(), routerDeps({ [charts]: { action: { other: 0.6 } } }, { decision: guessedSend }))
  assert.equal(phone.result.threadId, CHATS.dashboard.threadId, 'the iPhone, with no chat open, still decides as before')
  const question = 'did you also update the readme?'
  const openStep = [{ action: 'open_chat', threadId: CHATS.notes.threadId, certain: true, alternatives: [], chatWords: '', message: '', draftOnly: false }]
  const asked = await routeVoiceCommand(question, buildContext(), routerDeps({ [question]: { action: { other: 0.55 } } }, { decision: openStep }), { ...WATCH, openChat: CHATS.notes })
  assert.deepEqual([asked.result.outcome, asked.result.message], ['send_ready', question], 'a question for the open chat is sent, not "opened"')
  const opened = await routeVoiceCommand('open the finance charts', buildContext(), routerDeps({ 'open the finance charts': { action: { open_chat: 0.5 } } }, {
    decision: [{ action: 'open_chat', threadId: CHATS.dashboard.threadId, certain: true, alternatives: [], chatWords: '', message: '', draftOnly: false }],
  }), { ...WATCH, openChat: CHATS.notes })
  assert.deepEqual([opened.result.outcome, opened.result.threadId], ['open_chat', CHATS.dashboard.threadId], '"open …" still opens the chat the model found')
  const vague = 'okay go with that one'
  const placed = await routeVoiceCommand(vague, buildContext(), routerDeps({ [vague]: { action: { open_chat: 0.5 } } }, { decision: [] }), { ...WATCH, openChat: CHATS.notes })
  assert.deepEqual([placed.result.threadId, placed.result.message], [CHATS.notes.threadId, 'go with that one'], 'the LLM found nothing to do: a reply to the open chat')
  const all = await routeVoiceCommand('stop all of them', buildContext(), routerDeps({}, {
    decision: [{ action: 'stop_chats', threadId: null, certain: false, alternatives: [], chatWords: 'all of them', message: '', draftOnly: false }],
  }), WATCH)
  assert.deepEqual([all.result.outcome, all.result.group], ['stop_ready', 'running'], 'the rules read "all of them" as everything running')
  const guessed = [{ action: 'summarize_chats', threadId: CHATS.webhook.threadId, certain: true, alternatives: [], chatWords: '', message: '', draftOnly: false }]
  const said = 'give me the gist of the stripe webhook work please and thanks'
  const named = await routeVoiceCommand(said, buildContext(), routerDeps({ [said]: { action: { other: 0.6 } } }, { decision: guessed }), WATCH)
  assert.deepEqual([named.result.outcome, named.result.threadId], ['summarize_ready', CHATS.webhook.threadId])
})

// --- The HTTP routes, over a fake bridge and fake Jev and Anthropic endpoints ---------------------------

const TOKEN = 'watch-token-0123456789abcdef-0123456789'
const NOW = Date.UTC(2026, 9, 31, 9, 0, 0)
const S = (minutesAgo) => Math.floor((NOW - minutesAgo * 60_000) / 1000)
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString()
const userMessage = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text, text_elements: [] }] })
const answerItem = (id, text) => ({ type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null })
const turn = (id, status, items, minutesAgo = 20) => ({
  id, status, itemsView: 'full', error: null, startedAt: S(minutesAgo), completedAt: status === 'inProgress' ? null : S(minutesAgo - 1), durationMs: null, items,
})
function chat(id, name, cwd, minutesAgo, turns = []) {
  return { id, name, preview: `${name} preview`, modelProvider: 'openai', cwd, createdAt: S(minutesAgo + 60), updatedAt: S(minutesAgo), source: 'cli', status: { type: 'idle' }, turns }
}
const REPLIES = {
  'chat-notes': '## Done\n\nWrote the **release notes** for v2.\n\n- Added the changelog\n- Linked the docs',
  'chat-retries': 'Added retries to the upload. All tests pass.',
  'chat-webhook': 'Fixed the webhook: it read the parsed body.',
  'chat-checkout': 'Updated the checkout copy.',
}
const historyItem = (threadId, minutesAgo, readAt = null) => ({ id: `${threadId}:turn`, threadId, turnId: 'turn', status: 'completed', title: threadId, body: 'Done.', completedAt: iso(minutesAgo), readAt })

function commandWorld() {
  const world = {
    threads: new Map(),
    pending: [],
    running: ['chat-export', 'chat-board'],
    pinned: [],
    history: [historyItem('chat-notes', 10), historyItem('chat-retries', 12), historyItem('chat-webhook', 30, iso(29)), historyItem('chat-checkout', 40, iso(39))],
    readState: { readAtByThreadId: { 'chat-notes': iso(30), 'chat-retries': iso(30) }, unreadThreadIds: [] },
    boards: { boards: [{ id: 'b1', name: 'Board', planningThreadId: '' }], cards: [{ id: 'c1', boardId: 'b1', type: 'feature', title: 'Feature', threadId: 'chat-board', status: 'running' }], agents: [], questions: [], comments: [], artifacts: [], runs: [] },
    boardChats: new Set(['chat-board']),
    sent: [], interrupted: [], started: [],
    add(thread) { world.threads.set(thread.id, thread); return world },
  }
  world
    .add(chat('chat-export', 'Nightly export job', '/work/automation', 2, [
      turn('t-export-1', 'completed', [userMessage('u1', 'Run the export'), answerItem('a1', 'Exported 3 sheets.')], 40),
      turn('t-export-2', 'inProgress', [userMessage('u2', 'Now the finance sheet'), { type: 'commandExecution', id: 'c', command: 'npm run export', commandActions: [], status: 'inProgress' }], 3),
    ]))
    .add(chat('chat-notes', 'Release notes', '/work/booking', 10, [turn('t-notes', 'completed', [userMessage('u', 'Write the notes'), answerItem('a', REPLIES['chat-notes'])], 11)]))
    .add(chat('chat-retries', 'Upload retries', '/work/hr-ai', 12, [turn('t-retries', 'completed', [userMessage('u', 'Add retries'), answerItem('a', REPLIES['chat-retries'])], 13)]))
    .add(chat('chat-webhook', 'Stripe webhook bug', '/work/hr-ai', 30, [turn('t-webhook', 'completed', [userMessage('u', 'Fix it'), answerItem('a', REPLIES['chat-webhook'])], 31)]))
    .add(chat('chat-checkout', 'Stripe checkout copy', '/work/booking', 40, [turn('t-checkout', 'completed', [userMessage('u', 'Copy'), answerItem('a', REPLIES['chat-checkout'])], 41)]))
    .add(chat('chat-board', 'Board lead', '/work/hr-ai', 1, [turn('t-board', 'inProgress', [userMessage('u', 'Plan')], 2)]))
    .add(chat('chat-fresh', 'Fresh chat', '/work/scratch', 50, []))
    .add(chat('chat-old', 'Old plan', '/work/scratch', 90 * 24 * 60, []))
  /** Chats thread/list leaves out, such as ones older than its page. */
  world.unlisted = new Set(['chat-old'])
  const find = (id) => {
    const thread = world.threads.get(id)
    if (!thread) throw new Error(`thread not found: ${id}`)
    return thread
  }
  const summaryOf = ({ turns: _turns, ...summary }) => summary
  const bridge = {
    listThreads: async () => [...world.threads.values()].filter((thread) => !world.unlisted.has(thread.id)).map(summaryOf),
    readThreadSummary: async (id) => summaryOf(find(id)),
    readThread: async (id) => structuredClone(find(id)),
    readTitles: async () => ({}),
    readReadState: async () => world.readState,
    replyThreadIds: () => world.running,
    backgroundThreadIds: () => [],
    listPendingServerRequests: () => world.pending,
    readProjectBoards: async () => world.boards,
    readWorkspaceRoots: async () => ({ order: [], labels: {} }),
    readPinnedThreadIds: async () => world.pinned,
    transcribe: async () => { throw new Error('no audio here') },
    sendMessage: async () => { throw new Error('the watch must send through the composer path') },
    startChat: async (input) => { world.started.push(input); return { threadId: `new-chat-${String(world.started.length)}` } },
    readVoiceSettings: async () => null,
    writeVoiceSettings: async () => {},
    isBoardManagedChat: async (id) => world.boardChats.has(id),
    sendComposerMessage: async (threadId, text) => { world.sent.push({ threadId, text }) },
    interruptTurn: async (threadId, turnId) => { world.interrupted.push({ threadId, turnId }) },
    respondToServerRequest: async () => {},
    markThreadRead: async () => {},
  }
  const push = { readHistory: async () => ({ items: world.history, dismissals: [] }), markHistoryRead: async () => {} }
  return { world, bridge, push }
}

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
const llmStep = (fields) => ({ action: 'none', list_type: 'none', chat_id: '', chat_words: '', chat_certain: false, alternative_chat_ids: [], project_id: '', project_named: false, agent: 'not_said', message: '', draft_only: false, ...fields })

/**
 * Fake TypeSafe and Anthropic endpoints. `jev` answers by phrase (jevTable); `router(input)` gives the
 * LLM fallback's raw steps; `summary(body, init)` gives a summary, a Response, or hangs until aborted.
 */
function fakeApis({ jev = {}, router = () => [], summary = async () => 'A short summary.' } = {}) {
  const calls = { jev: [], router: [], summary: [], other: [], maxInFlight: 0 }
  let inFlight = 0
  const spec = jevTable(jev)
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (url.includes('typesafe')) {
      calls.jev.push(body)
      return json({ model: JEV_MODEL, answers: answerQuestions(body.questions, body.state, spec) })
    }
    if (!url.includes('anthropic')) {
      calls.other.push(url)
      return json({ error: 'not here' }, 500)
    }
    if (body.system.includes('smartwatch')) {
      calls.summary.push(body)
      inFlight += 1
      calls.maxInFlight = Math.max(calls.maxInFlight, inFlight)
      try {
        const value = await summary(JSON.parse(body.messages[0].content), init)
        return value instanceof Response ? value : json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: value }) }] })
      } finally {
        inFlight -= 1
      }
    }
    calls.router.push(body)
    return json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ steps: router(JSON.parse(body.messages[0].content)).map(llmStep) }) }] })
  }
  return { fetchImpl, calls }
}

const ENV = {
  CODEXUI_WATCH_TOKEN: TOKEN,
  CODEXUI_VOICE_TYPESAFE_API_KEY: 'jev-test',
  CODEXUI_VOICE_ANTHROPIC_API_KEY: 'anthropic-test',
  CODEXUI_VOICE_DEEPSEEK_API_KEY: 'deepseek-test',
  CODEXUI_VOICE_DEFAULT_PROJECT: '/work/scratch',
}

async function startWatch(t, { apis = fakeApis(), setup = commandWorld(), env = ENV, summaryTimeoutMs } = {}) {
  const logs = []
  const clock = { now: NOW }
  const handler = routes.createWatchHandler({
    bridge: setup.bridge,
    push: setup.push,
    env: () => env,
    now: () => clock.now,
    log: (line) => logs.push(line),
    fetchImpl: apis.fetchImpl,
    ...(summaryTimeoutMs ? { summaryTimeoutMs } : {}),
  })
  const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 418; res.end('next') }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${String(server.address().port)}/codex-api/voice/shortcut/watch/`
  const call = async (path, body, { token = TOKEN } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: response.status, json: parsed }
  }
  const command = (text, context) => call('command', context ? { text, context } : { text })
  return { call, command, logs, clock, world: setup.world, calls: apis.calls }
}

const chatIdsOf = (reply) => reply.chats.map((row) => row.id)

test('POST command answers every kind, and only send, new and stop get a code', async (t) => {
  const apis = fakeApis({
    jev: {
      'open the release notes chat': { action: { open_chat: 0.95 }, chat: { 'chat-notes': 0.93 } },
      "what's running": { action: { list_chats: 0.95 }, list: { running: 0.95 } },
      'show unread': { action: { list_chats: 0.95 }, list: { unread: 0.95 } },
      'tell the release notes chat to add a summary': { action: { send_to_chat: 0.95 }, chat: { 'chat-notes': 0.93 } },
      'new chat in automation, fix the cron jobs': { action: { new_chat: 0.95 }, project: { automation: 0.94 } },
      'open the stripe one': { action: { open_chat: 0.95 }, chat: { 'chat-webhook': 0.45, 'chat-checkout': 0.4 } },
    },
  })
  const { command, calls } = await startWatch(t, { apis })

  const open = (await command('open the release notes chat')).json
  assert.deepEqual([open.kind, open.code, open.say, chatIdsOf(open)], ['open', null, 'Open Release notes', ['chat-notes']])
  assert.deepEqual(Object.keys(open).sort(), ['chats', 'code', 'kind', 'newChats', 'say', 'section', 'text'], 'the contract\'s fields, all present')
  assert.deepEqual(Object.keys(open.chats[0]).sort(), ['agent', 'id', 'line', 'pinned', 'project', 'state', 'title', 'unread', 'updatedAt'], 'chats are ChatRows')

  const list = (await command('show unread')).json
  assert.deepEqual([list.kind, list.code, list.section, list.say, list.chats], ['list', null, 'unread', 'Unread: 2 chats', []])
  const single = (await command("what's running")).json
  assert.deepEqual([single.kind, chatIdsOf(single)], ['open', ['chat-export']], 'a list of one opens it, as on the iPhone; the board chat is not counted')

  const send = (await command('tell the release notes chat to add a summary')).json
  assert.deepEqual([send.kind, send.text, send.say, chatIdsOf(send)], ['send', 'add a summary', 'Send to Release notes', ['chat-notes']])
  assert.match(send.code, /^[A-Za-z0-9_-]{24}$/u)

  const group = (await command('tell all unread to summarize concisely')).json
  assert.deepEqual([group.kind, group.text, group.say, chatIdsOf(group)], ['send', 'summarize concisely', 'Send to 2 unread chats', ['chat-notes', 'chat-retries']])

  const created = (await command('new chat in automation, fix the cron jobs')).json
  assert.deepEqual([created.kind, created.say, created.newChats], ['new', 'New Claude chat in automation', [{ project: 'automation', text: 'fix the cron jobs' }]])
  assert.ok(created.code)

  const stop = (await command('stop all running')).json
  assert.deepEqual([stop.kind, stop.say, chatIdsOf(stop)], ['stop', 'Stop 1 running chat', ['chat-export']], 'never a board chat')
  assert.ok(stop.code)

  const summarize = (await command('catch me up')).json
  assert.deepEqual([summarize.kind, summarize.code, summarize.say, chatIdsOf(summarize)], ['summarize', null, 'Catch up on 2 unread chats', ['chat-notes', 'chat-retries']])

  const choose = (await command('open the stripe one')).json
  assert.deepEqual([choose.kind, choose.code, choose.say], ['choose', null, 'Open which chat?'])
  assert.deepEqual(chatIdsOf(choose).slice(0, 2), ['chat-webhook', 'chat-checkout'])

  const none = (await command('open spotify')).json
  assert.deepEqual([none.kind, none.code, none.say, none.chats], ['none', null, "I didn't catch that.", []])

  assert.ok(calls.jev.every((request) => !('stop_chats' in (request.questions.action?.criteria ?? {}))), "Jev's pass 1 keeps the iPhone's labels")
})

test('a tap on a choice resends the same words with that chat open and needs no second routing', async (t) => {
  const apis = fakeApis({ jev: { 'tell the stripe one to add a retry': { action: { send_to_chat: 0.95 }, chat: { 'chat-webhook': 0.45, 'chat-checkout': 0.4 } } } })
  const { command, call, calls, world } = await startWatch(t, { apis })
  const choose = (await command('tell the stripe one to add a retry')).json
  assert.deepEqual([choose.kind, choose.text, choose.say], ['choose', 'add a retry', 'Send to which chat?'])
  const jevCalls = calls.jev.length
  const picked = (await command('tell the stripe one to add a retry', { chatId: 'chat-checkout' })).json
  assert.deepEqual([picked.kind, picked.text, chatIdsOf(picked)], ['send', 'add a retry', ['chat-checkout']])
  assert.equal(calls.jev.length, jevCalls, 'the choice is remembered, not routed again')
  assert.deepEqual((await call('command/run', { code: picked.code })).json, { ok: true, chatIds: ['chat-checkout'] })
  assert.deepEqual(world.sent, [{ threadId: 'chat-checkout', text: 'add a retry' }])
  const again = (await command('tell the stripe one to add a retry', { chatId: 'chat-checkout' })).json
  assert.equal(again.kind, 'send', 'a remembered choice is used once; the open chat still settles the same words')
  assert.ok(calls.jev.length > jevCalls)
})

test('a chat only the LLM picked is not sent to on a timer: one tap confirms it', async (t) => {
  const said = 'hmm go with the second option on that one'
  const apis = fakeApis({
    jev: { [said]: { action: { other: 0.6 } } },
    router: (input) => [{ action: 'send_to_chat', chat_id: input.chats.find((row) => row.title === 'Release notes').id, chat_certain: true, message: 'go with the second option' }],
  })
  const { command, call, world } = await startWatch(t, { apis })
  const unsure = (await command(said)).json
  assert.deepEqual([unsure.kind, unsure.code, unsure.say, unsure.text, chatIdsOf(unsure)], ['choose', null, 'Send to Release notes?', 'go with the second option', ['chat-notes']])
  const tapped = (await command(said, { chatId: 'chat-notes' })).json
  assert.deepEqual([tapped.kind, tapped.text, chatIdsOf(tapped)], ['send', 'go with the second option', ['chat-notes']])
  await call('command/run', { code: tapped.code })
  assert.deepEqual(world.sent, [{ threadId: 'chat-notes', text: 'go with the second option' }])
})

test('context: the open chat takes a plain message; a chat named in so many words wins; on-screen chats win near-ties', async (t) => {
  const apis = fakeApis({
    jev: {
      'tell the export job to retry the sheet': { action: { send_to_chat: 0.95 }, chat: { 'chat-export': 0.93 } },
      'open the stripe one': { action: { open_chat: 0.95 }, chat: { 'chat-webhook': 0.45, 'chat-checkout': 0.4 } },
    },
  })
  const { command } = await startWatch(t, { apis })
  const plain = (await command('deploy it', { chatId: 'chat-notes' })).json
  assert.deepEqual([plain.kind, plain.text, chatIdsOf(plain)], ['send', 'deploy it', ['chat-notes']])
  const reply = (await command('reply looks good, merge it', { chatId: 'chat-old' })).json
  assert.deepEqual([reply.kind, reply.text, chatIdsOf(reply)], ['send', 'looks good, merge it', ['chat-old']], 'a chat outside the listed page is read')
  assert.equal(reply.chats[0].title, 'Old plan')
  const explicit = (await command('tell the export job to retry the sheet', { chatId: 'chat-notes' })).json
  assert.deepEqual([explicit.kind, explicit.text, chatIdsOf(explicit)], ['send', 'retry the sheet', ['chat-export']])
  const stopIt = (await command('stop it', { chatId: 'chat-export' })).json
  assert.deepEqual([stopIt.kind, chatIdsOf(stopIt)], ['stop', ['chat-export']])
  const idle = (await command('stop it', { chatId: 'chat-notes' })).json
  assert.deepEqual([idle.kind, idle.code, idle.say], ['none', null, "Release notes isn't running."])
  const visible = (await command('open the stripe one', { visibleChatIds: ['chat-checkout', 'chat-notes'] })).json
  assert.deepEqual([visible.kind, chatIdsOf(visible)], ['open', ['chat-checkout']])
  const board = (await command('deploy it', { chatId: 'chat-board' })).json
  assert.deepEqual([board.kind, board.code], ['none', null], 'never a send to a board chat')
  const noContext = (await command('deploy it')).json
  assert.equal(noContext.kind, 'none', 'with nothing open, a fragment names no chat')
  assert.equal((await command('deploy it', { chatId: 'missing' })).json.kind, 'none', 'an unknown open chat is ignored')
})

test('command/run carries out a plan exactly once; a repeat, a cancelled or an expired code gets 404', async (t) => {
  const { command, call, world, clock, logs } = await startWatch(t)
  const send = (await command('tell all unread to summarize concisely')).json
  const ran = await call('command/run', { code: send.code })
  assert.deepEqual([ran.status, ran.json], [200, { ok: true, chatIds: ['chat-notes', 'chat-retries'] }])
  assert.deepEqual(world.sent, [{ threadId: 'chat-notes', text: 'summarize concisely' }, { threadId: 'chat-retries', text: 'summarize concisely' }])
  assert.equal((await call('command/run', { code: send.code })).status, 404, 'a second run')
  assert.equal((await call('command/cancel', { code: send.code })).status, 409, 'too late to cancel')
  assert.equal(world.sent.length, 2)

  const cancelled = (await command('tell all unread to push it')).json
  assert.deepEqual((await call('command/cancel', { code: cancelled.code })).json, { ok: true })
  assert.deepEqual((await call('command/cancel', { code: cancelled.code })).json, { ok: true }, 'cancelling twice is fine')
  assert.equal((await call('command/run', { code: cancelled.code })).status, 404)

  const late = (await command('tell all unread to push it')).json
  clock.now += 2 * 60_000 + 1
  assert.equal((await call('command/run', { code: late.code })).status, 404, 'two minutes later')
  assert.equal((await call('command/cancel', { code: late.code })).status, 404)
  assert.equal(world.sent.length, 2, 'nothing else went out')

  assert.equal((await call('command/run', { code: 'nope' })).status, 400)
  assert.equal((await call('command/run', { code: 'A'.repeat(24) })).status, 404)
  assert.equal((await call('command/run', { code: send.code }, { token: '' })).status, 401, 'the watch token, as every route')
  assert.ok(!logs.some((line) => line.includes('summarize concisely') || line.includes('push it')), 'never the words')
})

test('command/run: stop interrupts each running turn, new chats start as Claude, and a failure says why', async (t) => {
  const twoChats = 'create two chats: fix the login bug and write release notes'
  const apis = fakeApis({
    jev: {
      'stop the nightly export job': { chat: { 'chat-export': 0.93 } },
      [twoChats]: { action: { new_chat: 0.8 }, compound: 0.9 },
    },
    router: (input) => (input.transcript === twoChats ? [
      { action: 'new_chat', project_named: false, message: 'fix the login bug' },
      { action: 'new_chat', project_named: false, message: 'write release notes' },
    ] : []),
  })
  const setup = commandWorld()
  const { command, call, world } = await startWatch(t, { apis, setup })

  const stop = (await command('stop the nightly export job')).json
  assert.deepEqual([stop.kind, stop.say, chatIdsOf(stop)], ['stop', 'Stop Nightly export job', ['chat-export']])
  assert.deepEqual((await call('command/run', { code: stop.code })).json, { ok: true, chatIds: ['chat-export'] })
  assert.deepEqual(world.interrupted, [{ threadId: 'chat-export', turnId: 't-export-2' }])

  const finished = (await command('stop all running')).json
  world.threads.get('chat-export').turns.at(-1).status = 'completed'
  assert.deepEqual((await call('command/run', { code: finished.code })).json, { ok: true, chatIds: [] }, 'finished meanwhile: nothing to stop')
  assert.equal(world.interrupted.length, 1)

  const created = (await command(twoChats)).json
  assert.deepEqual([created.kind, created.say, created.newChats], ['new', '2 new Claude chats in scratch', [
    { project: 'scratch', text: 'fix the login bug' },
    { project: 'scratch', text: 'write release notes' },
  ]])
  assert.deepEqual((await call('command/run', { code: created.code })).json, { ok: true, chatIds: ['new-chat-1', 'new-chat-2'] })
  assert.deepEqual(world.started, [
    { cwd: '/work/scratch', agent: 'claude', message: 'fix the login bug' },
    { cwd: '/work/scratch', agent: 'claude', message: 'write release notes' },
  ], 'always Claude, in the default project')

  setup.bridge.sendComposerMessage = async () => { throw new Error('Claude is signed out.') }
  const send = (await command('tell all unread to push it')).json
  const failed = await call('command/run', { code: send.code })
  assert.deepEqual([failed.status, failed.json], [502, { error: 'Claude is signed out.' }])
})

test('a whole section\'s message the rules cannot cut comes from the LLM, in the user\'s own words or not at all', async (t) => {
  const said = 'the deploy is done, tell all unread'
  const own = fakeApis({ router: () => [{ action: 'send_to_chat', chat_words: 'all unread', message: 'the deploy is done' }] })
  const { command, calls } = await startWatch(t, { apis: own })
  const sent = (await command(said)).json
  assert.deepEqual([sent.kind, sent.text, chatIdsOf(sent)], ['send', 'the deploy is done', ['chat-notes', 'chat-retries']])
  assert.equal(calls.jev.length, 0, 'the rules found the section; only the message needed the LLM')

  const reworded = fakeApis({ router: () => [{ action: 'send_to_chat', chat_words: 'all unread', message: 'deployment finished successfully' }] })
  const second = await startWatch(t, { apis: reworded })
  const refused = (await second.command(said)).json
  assert.deepEqual([refused.kind, refused.code, refused.say], ['none', null, 'What should I send to the unread chats?'], 'a reworded message is never sent')
})

test('POST summaries: Claude Haiku, 1 to 8 chats in parallel, cached per reply, null on failure or without a reply', async (t) => {
  let failRetries = true
  const apis = fakeApis({
    summary: async ({ chat_title: title }) => {
      if (title === 'Upload retries' && failRetries) return json({ error: 'overloaded' }, 529)
      return `**${title}**: done, and it\nworked.`
    },
  })
  const { call, calls, logs } = await startWatch(t, { apis })
  const first = await call('summaries', { chatIds: ['chat-notes', 'chat-retries', 'chat-fresh', 'missing', 'chat-export'] })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json.summaries, [
    { chatId: 'chat-notes', title: 'Release notes', turnId: 't-notes', summary: 'Release notes: done, and it worked.' },
    { chatId: 'chat-retries', title: 'Upload retries', turnId: 't-retries', summary: null },
    { chatId: 'chat-fresh', title: 'Fresh chat', turnId: null, summary: null },
    { chatId: 'missing', title: '', turnId: null, summary: null },
    { chatId: 'chat-export', title: 'Nightly export job', turnId: 't-export-1', summary: 'Nightly export job: done, and it worked.' },
  ], 'plain text; a running reply with no final answer yet falls back to the last answered turn')
  const request = calls.summary.find((body) => body.messages[0].content.includes('Release notes'))
  assert.equal(request.model, 'claude-haiku-5-5')
  assert.deepEqual(JSON.parse(request.messages[0].content), { chat_title: 'Release notes', reply: REPLIES['chat-notes'] })
  assert.match(request.system, /at most 200 characters/u)
  assert.equal(calls.other.length, 0, 'replies go to Anthropic only, never the other fallback providers')

  const asked = calls.summary.length
  failRetries = false
  const second = await call('summaries', { chatIds: ['chat-notes', 'chat-retries'] })
  assert.equal(second.json.summaries[0].summary, 'Release notes: done, and it worked.')
  assert.equal(second.json.summaries[1].summary, 'Upload retries: done, and it worked.', 'a failure is not cached')
  assert.equal(calls.summary.length, asked + 1, 'the cached reply is not asked again')

  const logged = JSON.stringify(logs)
  for (const secret of [...Object.values(REPLIES), 'done, and it', 'worked']) assert.ok(!logged.includes(secret), `never logged: ${secret}`)

  for (const chatIds of [[], Array.from({ length: 9 }, (_, index) => `chat-${String(index)}`), 'chat-notes', [42]]) {
    assert.equal((await call('summaries', { chatIds })).status, 400, JSON.stringify(chatIds))
  }
})

test('POST summaries runs the chats in parallel, and a slow one gives up in time with null', async (t) => {
  const setup = commandWorld()
  for (let index = 1; index <= 8; index += 1) {
    setup.world.add(chat(`many-${String(index)}`, `Chat ${String(index)}`, '/work/many', 60 + index, [turn(`t-${String(index)}`, 'completed', [userMessage('u', 'Go'), answerItem('a', `Reply ${String(index)}`)], 61 + index)]))
  }
  let release
  const allIn = new Promise((resolve) => { release = resolve })
  const apis = fakeApis({
    summary: async (input) => {
      if (apis.calls.summary.length === 8) release()
      await allIn
      return `Summary of ${input.chat_title}`
    },
  })
  const { call } = await startWatch(t, { apis, setup })
  const ids = Array.from({ length: 8 }, (_, index) => `many-${String(index + 1)}`)
  const { json: body } = await call('summaries', { chatIds: ids })
  assert.equal(apis.calls.maxInFlight, 8, 'all eight at once')
  assert.deepEqual(body.summaries.map((entry) => entry.summary), ids.map((_, index) => `Summary of Chat ${String(index + 1)}`))

  const hanging = fakeApis({
    summary: (_input, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  })
  const slow = await startWatch(t, { apis: hanging, summaryTimeoutMs: 700 })
  const started = performance.now()
  const timedOut = await slow.call('summaries', { chatIds: ['chat-notes'] })
  assert.ok(performance.now() - started < 3_000)
  assert.deepEqual(timedOut.json.summaries, [{ chatId: 'chat-notes', title: 'Release notes', turnId: 't-notes', summary: null }])
})

test('POST summaries without an Anthropic key answers titles with null summaries and asks nobody', async (t) => {
  const apis = fakeApis()
  const { call, calls } = await startWatch(t, { apis, env: { ...ENV, CODEXUI_VOICE_ANTHROPIC_API_KEY: '' } })
  const { json: body } = await call('summaries', { chatIds: ['chat-notes'] })
  assert.deepEqual(body.summaries, [{ chatId: 'chat-notes', title: 'Release notes', turnId: 't-notes', summary: null }])
  assert.equal(calls.summary.length + calls.other.length, 0)
})

test('POST command validates its body', async (t) => {
  const { call } = await startWatch(t)
  assert.equal((await call('command', {})).status, 400)
  assert.equal((await call('command', { text: '   ' })).status, 400)
  assert.equal((await call('command', { text: 'x'.repeat(4_001) })).status, 413)
  assert.equal((await call('command', { text: 'catch me up', context: { chatId: 42, visibleChatIds: 'chat-notes' } })).json.kind, 'summarize', 'a malformed context is left out')
  assert.equal((await call('command', { text: 'catch me up' }, { token: '' })).status, 401)
})
