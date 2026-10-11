import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { CHATS, DEFAULT_PROJECT, PHRASES, PROJECTS, QUERY_PHRASES, buildContext } from './fixtures/voicePhrases.mjs'

async function loadModule(path) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

const router = await loadModule('../src/server/voice/voiceRouter.ts')
const jev = await loadModule('../src/server/voice/jevClient.ts')
const { routeVoiceCommand, selectChatCandidates, projectAliases, VOICE_THRESHOLDS, buildPass1Questions, buildChatQuestion, allowsShortcutConfirm } = router
const { askJev, validateJevAnswers, JEV_MODEL, JevValidationError } = jev

const titleOf = (threadId) => Object.values(CHATS).find((row) => row.threadId === threadId)?.title ?? threadId
const keyOfThread = Object.fromEntries(Object.entries(CHATS).map(([key, row]) => [row.threadId, key]))

/** A Choice answer over the request's own options: named probabilities, the rest spread evenly. */
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
  const confidence = (top - 1 / keys.length) / (1 - 1 / keys.length)
  return { type: 'choice', choice, confidence, probabilities }
}

const FAILURES = {
  timeout: (init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  http500: () => new Response('{"error":"boom"}', { status: 500 }),
  http429: () => new Response('{"error":"slow down"}', { status: 429 }),
  http401: () => new Response('{"error":"bad key"}', { status: 401 }),
  network: () => { throw new TypeError('fetch failed') },
  malformed: () => new Response('<html>not json', { status: 200 }),
}
const CORRUPTIONS = {
  wrong_model: (payload) => ({ ...payload, model: 'jev-1.12.0' }),
  missing_answer: (payload) => { const answers = { ...payload.answers }; delete answers[Object.keys(answers)[0]]; return { ...payload, answers } },
  bad_sum: (payload) => mapChoices(payload, (answer) => ({ ...answer, probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([key, value]) => [key, value * 0.7])) })),
  not_argmax: (payload) => mapChoices(payload, (answer) => ({ ...answer, choice: Object.entries(answer.probabilities).sort((left, right) => left[1] - right[1])[0][0] })),
  unknown_option: (payload) => mapChoices(payload, (answer) => ({ ...answer, probabilities: { ...answer.probabilities, invented: 0 } })),
  out_of_range: (payload) => mapChoices(payload, (answer) => ({ ...answer, confidence: 1.5 })),
  string_probability: (payload) => mapChoices(payload, (answer) => ({ ...answer, probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([key, value]) => [key, String(value)])) })),
  noul_out_of_range: (payload) => ({ ...payload, answers: Object.fromEntries(Object.entries(payload.answers).map(([key, answer]) => [key, answer.type === 'noul' ? { ...answer, noul: -0.2 } : answer])) }),
}
function mapChoices(payload, change) {
  return { ...payload, answers: Object.fromEntries(Object.entries(payload.answers).map(([key, answer]) => [key, answer.type === 'choice' ? change(answer) : answer])) }
}

/**
 * A fake TypeSafe endpoint. `script.pass1` / `script.pass2` are either answer
 * specs ({ questionId: { option: probability } } or a noul number) or a
 * failure name from FAILURES / CORRUPTIONS.
 */
function fakeJev(script, requests = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ url, headers: init.headers, body })
    const pass = 'action' in body.questions ? 'pass1' : 'pass2'
    const spec = script[pass]
    if (typeof spec === 'string' && FAILURES[spec]) return FAILURES[spec](init)
    const answers = {}
    for (const [id, question] of Object.entries(body.questions)) {
      const wanted = (typeof spec === 'object' && spec?.[id]) ?? {}
      answers[id] = question.type === 'noul' ? { type: 'noul', noul: typeof wanted === 'number' ? wanted : 0.03 } : choiceAnswer(question.criteria, wanted)
    }
    let payload = { model: JEV_MODEL, answers, usage: { input_tokens: 100, output_tokens: 20 } }
    if (typeof spec === 'string' && CORRUPTIONS[spec]) payload = CORRUPTIONS[spec](payload)
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

/**
 * `decision` is what the LLM fallback router returns: a list of steps (provider
 * anthropic), null for "no provider answered", or a function of the input.
 */
function deps(script, { llm = null, requests = [], llmCalls = [], decision = null, decisionCalls = [] } = {}) {
  const fetchImpl = fakeJev(script, requests)
  return {
    jev: (questions, state) => askJev(questions, state, { apiKey: 'test-key', fetchImpl, timeoutMs: 40 }),
    extractWithLlm: async (kind, transcript) => { llmCalls.push({ kind, transcript }); return llm },
    decideWithLlm: async (input) => {
      decisionCalls.push(input)
      const steps = typeof decision === 'function' ? decision(input) : decision
      return steps ? { steps, provider: 'anthropic' } : null
    },
  }
}

/** LLM steps, written briefly. */
const llmChat = (action, key, fields = {}) => ({ action, threadId: key ? CHATS[key].threadId : null, certain: true, alternatives: [], chatWords: '', message: '', ...fields })
const llmNew = (label, fields = {}) => ({ action: 'new_chat', projectId: PROJECTS.find((project) => project.label === label)?.id ?? null, agent: null, message: '', ...fields })
const llmList = (listType) => ({ action: 'list_chats', listType })

/** The Jev answers a good model would give for a labelled phrase. */
function scriptFor(phrase) {
  const { expect } = phrase
  const compound = expect.reason === 'compound' || Boolean(expect.steps)
  const action = expect.action ?? (compound ? 'send_to_chat' : 'other')
  const pass1 = { action: { [action]: 0.95 }, list_type: { [expect.listType ?? 'recent']: 0.9 }, compound: compound ? 0.92 : 0.04 }
  let pass2 = {}
  if (expect.chat && (action === 'open_chat' || action === 'send_to_chat')) pass2 = { chat: { [CHATS[expect.chat].threadId]: 0.93 } }
  if (expect.picker) pass2 = { chat: Object.fromEntries(expect.picker.map((key, index) => [CHATS[key].threadId, [0.42, 0.3, 0.2][index] ?? 0.02])) }
  const projectKey = expect.projectNamed === false ? 'not_named' : expect.project ?? 'other'
  if (action === 'new_chat') pass2 = { project: { [projectKey]: 0.94 }, agent: { [expect.agent ?? 'not_said']: 0.93 } }
  // Several requests: the LLM splits them into steps (chats unnamed, so each lands on a chooser).
  const decision = expect.steps?.map((step) => step.action === 'list_chats' ? llmList(step.listType)
    : step.action === 'new_chat' ? llmNew(step.project)
    : llmChat(step.action, step.chat ?? null, { certain: false }))
  return { pass1, pass2, decision }
}

function assertMatchesExpectation(result, trace, phrase, label) {
  const { expect } = phrase
  assert.ok([expect.outcome].flat().includes(result.outcome), `${label}: outcome ${result.outcome}`)
  if (expect.steps) {
    assert.deepEqual(result.steps.map((step) => step.action), expect.steps.map((step) => step.action), `${label}: steps`)
    for (const [index, step] of expect.steps.entries()) {
      if (step.listType) assert.equal(result.steps[index].listType, step.listType, `${label}: step ${index + 1} list`)
      if (step.project) assert.equal(result.steps[index].project?.label, step.project, `${label}: step ${index + 1} project`)
    }
  }
  assert.equal(result.heard, phrase.say.replace(/\s+/gu, ' ').trim(), `${label}: heard text is kept`)
  if (expect.reason) assert.equal(result.reason, expect.reason, `${label}: reason`)
  if (expect.listType) assert.equal(result.listType, expect.listType, `${label}: list type`)
  if (expect.chat) assert.equal(titleOf(result.threadId), CHATS[expect.chat].title, `${label}: chat`)
  if (expect.picker) {
    assert.deepEqual(result.candidates.slice(0, expect.picker.length).map((row) => keyOfThread[row.threadId]), expect.picker, `${label}: picker order`)
    assert.ok(result.candidates.length >= VOICE_THRESHOLDS.pickerMin && result.candidates.length <= VOICE_THRESHOLDS.pickerMax, `${label}: 3-5 picker rows`)
  }
  if ('message' in expect) assert.equal(result.message ?? '', expect.message, `${label}: message`)
  if ('project' in expect && [expect.outcome].flat().includes(result.outcome)) assert.equal(result.project?.label ?? null, expect.project, `${label}: project`)
  if ('agent' in expect) assert.equal(result.agent ?? null, expect.agent, `${label}: agent`)
  if (expect.outcome === 'not_understood') assert.ok(result.candidates.length > 0, `${label}: recent chats offered`)
  if (expect.action === 'list_chats' && expect.outcome === 'picker') {
    assert.deepEqual(result.candidates, buildContext().sections[expect.listType], `${label}: list rows are the panel section`)
  }
  if (expect.llm) assert.equal(trace.extraction, 'llm:anthropic', `${label}: used the LLM`)
  else if (expect.message !== undefined && expect.outcome !== 'not_understood') assert.equal(trace.extraction, 'rule', `${label}: a rule extracted the message`)
}

test('the labelled phrase set covers every journey with at least 40 phrasings', () => {
  assert.ok(PHRASES.length >= 40)
  for (const journey of [1, 2, 3, 4, 5, 6]) assert.ok(PHRASES.some((phrase) => phrase.journey === journey), `journey ${journey}`)
})

for (const phrase of PHRASES) {
  test(`routes "${phrase.say}" (journey ${phrase.journey})`, async () => {
    const llmCalls = []
    const llm = phrase.expect.llm ? { message: phrase.expect.message, provider: 'anthropic' } : null
    const script = scriptFor(phrase)
    const { result, trace } = await routeVoiceCommand(phrase.say, buildContext(), deps(script, { llm, llmCalls, decision: script.decision }))
    assertMatchesExpectation(result, trace, phrase, phrase.say)
    if (!phrase.expect.llm) assert.equal(llmCalls.length, 0, 'no LLM call when a rule works')
    assert.ok(trace.calls.length <= 2, 'at most two Jev calls')
  })
}

// --- Jev failure modes: every one falls back, none guesses -------------------

for (const failure of [...Object.keys(FAILURES), ...Object.keys(CORRUPTIONS)]) {
  test(`pass 1 failure "${failure}" asks the LLM, and without it says "didn't catch that" with recent chats`, async () => {
    const decisionCalls = []
    const { result, trace } = await routeVoiceCommand('open the stripe webhook chat', buildContext(), deps({ pass1: failure }, { decisionCalls }))
    assert.equal(decisionCalls.length, 1)
    assert.equal(result.outcome, 'not_understood')
    assert.equal(result.reason, 'jev_unavailable')
    assert.equal(result.candidates[0].threadId, CHATS.migration.threadId, 'recent chats in panel order')
    assert.equal(trace.calls.length, 1)
    assert.equal(trace.calls[0].ok, false)
    assert.equal(trace.path, 'none')
    const rescued = await routeVoiceCommand('open the stripe webhook chat', buildContext(), deps({ pass1: failure }, { decision: [llmChat('open_chat', 'webhook')] }))
    assert.equal(rescued.result.outcome, 'open_chat')
    assert.equal(rescued.result.threadId, CHATS.webhook.threadId)
    assert.equal(rescued.trace.path, 'llm')
  })
}

for (const failure of ['timeout', 'http500', 'malformed', 'bad_sum', 'wrong_model']) {
  test(`pass 2 failure "${failure}" offers a picker ranked by the spoken words instead of guessing`, async () => {
    const script = { pass1: { action: { open_chat: 0.95 } }, pass2: failure }
    const { result } = await routeVoiceCommand('open the stripe webhook chat', buildContext(), deps(script))
    assert.equal(result.outcome, 'picker')
    assert.equal(result.reason, 'jev_unavailable')
    assert.equal(result.candidates[0].threadId, CHATS.webhook.threadId)
    assert.ok(result.candidates.length <= VOICE_THRESHOLDS.pickerMax)
  })
}

test('a pass 2 failure on a send keeps the message for the picker', async () => {
  const script = { pass1: { action: { send_to_chat: 0.95 } }, pass2: 'http500' }
  const { result } = await routeVoiceCommand('tell the stripe webhook chat to deploy it', buildContext(), deps(script))
  assert.equal(result.outcome, 'picker')
  assert.equal(result.message, 'deploy it')
})

test('a pass 2 failure on a new chat still uses the project the words named', async () => {
  const script = { pass1: { action: { new_chat: 0.95 } }, pass2: 'timeout' }
  const { result } = await routeVoiceCommand('new chat in slack AI, check the logs', buildContext(), deps(script))
  assert.equal(result.outcome, 'new_chat')
  assert.equal(result.project?.label, 'slack-ai')
  assert.equal(result.message, 'check the logs')
})

test('a pass 2 failure on a new chat with no recognisable project opens the project picker', async () => {
  const script = { pass1: { action: { new_chat: 0.95 } }, pass2: 'http429' }
  const { result } = await routeVoiceCommand('new chat, check the logs', buildContext(), deps(script))
  assert.equal(result.project, null)
  assert.equal(result.reason, 'jev_unavailable')
  assert.deepEqual(result.projectOptions.map((project) => project.label), PROJECTS.map((project) => project.label))
})

// --- Gates and thresholds ----------------------------------------------------

test('a low-confidence action goes to the LLM, and without an answer is not acted on', async () => {
  const script = { pass1: { action: { open_chat: 0.55, send_to_chat: 0.4 } } }
  const decisionCalls = []
  const { result, trace } = await routeVoiceCommand('open the stripe webhook chat', buildContext(), deps(script, { decisionCalls }))
  assert.equal(decisionCalls.length, 1)
  assert.equal(result.outcome, 'not_understood')
  assert.equal(result.reason, 'low_confidence')
  assert.deepEqual(trace.fallback && { reason: trace.fallback.reason, ok: trace.fallback.ok }, { reason: 'low_confidence', ok: false })
})

test('sends need no more action confidence than opening: every outcome waits for a tap in the app', async () => {
  // Confidence for 5 options is (p - 0.2) / 0.8, so p = 0.8 gives 0.75, above the 0.7 bar.
  for (const [action, say, outcome] of [['open_chat', 'open the stripe webhook chat', 'open_chat'], ['send_to_chat', 'tell the stripe webhook chat to deploy', 'send_ready']]) {
    const decisionCalls = []
    const script = { pass1: { action: { [action]: 0.8 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.95 } } }
    const { result, trace } = await routeVoiceCommand(say, buildContext(), deps(script, { decisionCalls }))
    assert.equal(result.outcome, outcome)
    assert.equal(decisionCalls.length, 0, 'Jev was sure enough; no LLM')
    assert.equal(trace.path, 'jev')
  }
})

test('naming only a project with several chats shows them even when Jev is sure', async () => {
  const script = { pass1: { action: { open_chat: 0.95 } }, pass2: { chat: { [CHATS.checkout.threadId]: 0.95 } } }
  const { result } = await routeVoiceCommand('view the booking platform chat', buildContext(), deps(script))
  assert.equal(result.outcome, 'picker')
  assert.equal(result.reason, 'same_project')
  assert.deepEqual(new Set(result.candidates.map((row) => row.projectName)), new Set(['booking-platform']))
  assert.equal(result.candidates[0].threadId, CHATS.checkout.threadId, "Jev's pick comes first")
  const running = (await routeVoiceCommand('view the running booking platform chat', buildContext(), deps(script))).result
  assert.equal(running.outcome, 'open_chat', 'a state word distinguishes the chat')
  const single = { pass1: { action: { open_chat: 0.95 } }, pass2: { chat: { [CHATS.notes.threadId]: 0.95 } } }
  assert.equal((await routeVoiceCommand('show me the notes vault chat', buildContext(), deps(single))).result.outcome, 'open_chat', 'a project with one chat names it')
})

test('a modest Jev pick is accepted only when the spoken words single out the same chat', async () => {
  const modest = (threadId) => ({ pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [threadId]: 0.55, [CHATS.bounces.threadId]: 0.3 } } })
  const agree = (await routeVoiceCommand('tell the quiz chat to shorten the answers', buildContext(), deps(modest(CHATS.quizzes.threadId)))).result
  assert.equal(agree.outcome, 'send_ready')
  assert.equal(agree.threadId, CHATS.quizzes.threadId)
  const disagree = (await routeVoiceCommand('tell the quiz chat to shorten the answers', buildContext(), deps(modest(CHATS.login.threadId)))).result
  assert.equal(disagree.outcome, 'picker', 'Jev and the words disagree')
  const tied = { pass1: { action: { open_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.55, [CHATS.checkout.threadId]: 0.3 } } }
  assert.equal((await routeVoiceCommand('open the stripe one', buildContext(), deps(tied))).result.outcome, 'picker', 'words matching several chats do not count')
})

test('an agent name inside a project name does not pick the agent', async () => {
  const script = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { 'codexui-patched': 0.95 }, agent: { codex: 0.9 } } }
  const inName = (await routeVoiceCommand('new chat in codexui patched, fix the flaky test', buildContext(), deps(script))).result
  assert.equal(inName.project?.label, 'codexui-patched')
  assert.equal(inName.agent, null)
  const said = (await routeVoiceCommand('new chat in codexui patched, fix the flaky test using codex', buildContext(), deps(script))).result
  assert.equal(said.agent, 'codex')
})

test('compound requests at the threshold go to the LLM; just below it they route', async () => {
  const at = { pass1: { action: { open_chat: 0.95 }, compound: VOICE_THRESHOLDS.compound }, pass2: { chat: { [CHATS.webhook.threadId]: 0.95 } } }
  assert.equal((await routeVoiceCommand('open the stripe webhook chat', buildContext(), deps(at))).result.reason, 'compound', 'no LLM answer')
  const below = { ...at, pass1: { ...at.pass1, compound: VOICE_THRESHOLDS.compound - 0.01 } }
  assert.equal((await routeVoiceCommand('open the stripe webhook chat', buildContext(), deps(below))).result.outcome, 'open_chat')
})

for (const [label, probabilities, outcome] of [
  ['top 0.85 and exactly 3x the runner-up goes straight there', [0.85, 0.15 / 2 + 0.0001], 'open_chat'],
  ['top 0.84 shows a picker', [0.84, 0.08], 'picker'],
  ['top 0.87 but only 2.9x the runner-up shows a picker', [0.70, 0.2414], 'picker'],
  ['top 0.95 goes straight there', [0.95, 0.02], 'open_chat'],
]) {
  test(`chat gate: ${label}`, async () => {
    const [top, second] = probabilities
    const script = { pass1: { action: { open_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: top, [CHATS.checkout.threadId]: second } } }
    // No title words, so only Jev's numbers decide.
    const { result } = await routeVoiceCommand('open that one', buildContext(), deps(script))
    assert.equal(result.outcome, outcome)
  })
}

test('words that fit several chats equally show those chats even when Jev is sure', async () => {
  const script = { pass1: { action: { open_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.95 } } }
  const { result } = await routeVoiceCommand('open the stripe one', buildContext(), deps(script))
  assert.equal(result.outcome, 'picker')
  assert.equal(result.reason, 'same_words')
  assert.equal(result.candidates[0].threadId, CHATS.webhook.threadId, "Jev's pick first")
  assert.deepEqual(new Set(result.candidates.map((row) => row.threadId)), new Set([CHATS.webhook.threadId, CHATS.checkout.threadId, CHATS.payouts.threadId]))
  const distinct = (await routeVoiceCommand('open the stripe webhook chat', buildContext(), deps(script))).result
  assert.equal(distinct.outcome, 'open_chat', 'an extra word singles it out')
  const latest = (await routeVoiceCommand('open the latest stripe one', buildContext(), deps(script))).result
  assert.equal(latest.outcome, 'open_chat', 'a recency word singles it out')
})

test('Jev choosing none shows the panel chats and keeps a send message', async () => {
  const script = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { none: 0.9 } } }
  const { result } = await routeVoiceCommand('tell the zebra chat to deploy it', buildContext(), deps(script))
  assert.equal(result.outcome, 'picker')
  assert.equal(result.reason, 'no_match')
  assert.equal(result.message, 'deploy it')
  assert.equal(result.candidates[0].threadId, CHATS.migration.threadId)
})

test('when Jev finds no match, chats the words point at are listed first', async () => {
  const script = { pass1: { action: { open_chat: 0.95 } }, pass2: { chat: { none: 0.6 } } }
  const { result } = await routeVoiceCommand('open the booking chat', buildContext(), deps(script))
  assert.equal(result.reason, 'no_match')
  assert.deepEqual(result.candidates.slice(0, 3).map((row) => row.projectName), ['booking-platform', 'booking-platform', 'booking-platform'])
})

test('a clear send whose message cannot be extracted opens the chat instead of sending nothing', async () => {
  const script = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.95 } } }
  const llmCalls = []
  const { result, trace } = await routeVoiceCommand('stripe webhook chat needs to know about staging', buildContext(), deps(script, { llm: null, llmCalls }))
  assert.equal(llmCalls.length, 1, 'the LLM is tried when no rule fits')
  assert.equal(trace.extraction, 'none')
  assert.equal(result.outcome, 'open_chat')
  assert.equal(result.reason, 'no_message')
})

test('an empty list notifies without a chat; a one-item list opens that chat', async () => {
  const emptyContext = buildContext({ sections: { needs_you: [] } })
  const script = { pass1: { action: { list_chats: 0.95 }, list_type: { needs_you: 0.9 } } }
  const empty = (await routeVoiceCommand("what's waiting on me", emptyContext, deps(script))).result
  assert.equal(empty.outcome, 'empty')
  assert.equal(empty.candidates.length, 0)
  const unreadScript = { pass1: { action: { list_chats: 0.95 }, list_type: { unread: 0.9 } } }
  const single = (await routeVoiceCommand('anything unread', buildContext({ sections: { unread: [CHATS.bounces] } }), deps(unreadScript))).result
  assert.equal(single.outcome, 'open_chat')
  assert.equal(single.threadId, CHATS.bounces.threadId)
})

test('with no chats at all, opening a chat says so instead of asking Jev', async () => {
  const context = buildContext({ sections: { needs_you: [], running: [], unread: [], recent: [] }, otherChats: [] })
  const requests = []
  const { result } = await routeVoiceCommand('open the stripe chat', context, deps({ pass1: { action: { open_chat: 0.95 } } }, { requests }))
  assert.equal(result.outcome, 'not_understood')
  assert.equal(result.reason, 'no_chats')
  assert.equal(requests.length, 1, 'only pass 1 was called')
})

test('an empty transcript never reaches Jev', async () => {
  const requests = []
  const { result } = await routeVoiceCommand('   ', buildContext(), deps({}, { requests }))
  assert.equal(result.outcome, 'not_understood')
  assert.equal(result.reason, 'empty')
  assert.equal(requests.length, 0)
})

test('agent words win over Jev, and Jev fills in when words are absent', async () => {
  const script = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { 'hr-ai': 0.95 }, agent: { claude: 0.9 } } }
  const fromWords = (await routeVoiceCommand('new chat in hr-ai with codex, fix the build', buildContext(), deps(script))).result
  assert.equal(fromWords.agent, 'codex')
  const fromJev = (await routeVoiceCommand('new chat in hr-ai, fix the build', buildContext(), deps(script))).result
  assert.equal(fromJev.agent, 'claude')
  const unsure = { ...script, pass2: { ...script.pass2, agent: { claude: 0.5, codex: 0.4 } } }
  assert.equal((await routeVoiceCommand('new chat in hr-ai, fix the build', buildContext(), deps(unsure))).result.agent, null)
})

test('an unsure project choice opens the picker with Jev\'s ranking first', async () => {
  const script = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { 'booking-platform': 0.5, automation: 0.3 } } }
  const { result } = await routeVoiceCommand('new chat for the booking site, add a pricing page', buildContext(), deps(script, { llm: { message: 'add a pricing page', provider: 'anthropic' } }))
  assert.equal(result.project, null)
  assert.deepEqual(result.projectOptions.slice(0, 2).map((project) => project.label), ['booking-platform', 'automation'])
  assert.equal(result.projectOptions.length, PROJECTS.length)
})

// --- What Jev is asked ---------------------------------------------------------

test('Jev requests pin the model, carry only the transcript and chat titles, and key chats by thread id', async () => {
  const requests = []
  const script = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.95 } } }
  await routeVoiceCommand('tell the stripe webhook chat to deploy it', buildContext(), deps(script, { requests }))
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(request.body.model, 'jev-1.13.0')
    assert.equal(request.headers.Authorization, 'Bearer test-key')
  }
  assert.equal(requests[0].body.state.spoken_request, 'tell the stripe webhook chat to deploy it')
  assert.deepEqual(Object.keys(requests[0].body.state), ['spoken_request', 'chat_titles'])
  assert.equal(requests[0].body.state.chat_titles.length, VOICE_THRESHOLDS.panelCandidates, 'pass 1 sees the same chats pass 2 would choose from')
  assert.deepEqual(Object.keys(requests[0].body.questions), ['action', 'list_type', 'compound'])
  assert.deepEqual(Object.keys(requests[0].body.questions.action.criteria), ['open_chat', 'list_chats', 'send_to_chat', 'new_chat', 'other'])
  for (const option of Object.values(requests[0].body.questions.action.criteria)) assert.deepEqual(Object.keys(option), ['what', 'not_for', 'examples'])
  assert.equal(requests[1].body.state.chat_named_as, 'the stripe webhook chat')
  const keys = Object.keys(requests[1].body.questions.chat.criteria)
  assert.equal(keys.at(-1), 'none')
  assert.ok(keys.slice(0, -1).every((key) => Object.values(CHATS).some((row) => row.threadId === key)), 'option keys are thread ids, never titles')
})

test('chat candidates are the top 10 panel chats in panel order plus older chats the user named', () => {
  const context = buildContext()
  const plain = selectChatCandidates('open the chat', context)
  assert.equal(plain.length, VOICE_THRESHOLDS.panelCandidates)
  assert.deepEqual(plain.slice(0, 4).map((row) => keyOfThread[row.threadId]), ['migration', 'exportJob', 'checkout', 'webhook'])
  const named = selectChatCandidates('open the kubernetes ingress notes', context)
  assert.equal(named.length, VOICE_THRESHOLDS.panelCandidates + 1)
  assert.equal(keyOfThread[named.at(-1).threadId], 'ingress')
  const dashboard = selectChatCandidates('go to the finance dashboard chat', context)
  assert.ok(dashboard.some((row) => row.threadId === CHATS.dashboard.threadId), 'a recent chat past the top 10 is added when named')
  assert.ok(!dashboard.some((row) => row.threadId === CHATS.ingress.threadId), 'unnamed older chats stay out')
})

test('project descriptions carry spoken aliases for dictation slips', () => {
  assert.ok(projectAliases('hr-ai').includes('HRA I'))
  assert.ok(projectAliases('hr-ai').includes('H R A I'))
  assert.ok(projectAliases('slack-ai').includes('slack AI'))
  assert.deepEqual(projectAliases('notes-vault'), ['notes-vault', 'notes vault', 'notesvault'])
  assert.deepEqual(projectAliases('automation'), ['automation'])
})

test('pass 1 and pass 2 questions validate against well-formed answers', () => {
  const pass1 = buildPass1Questions()
  const payload = { model: JEV_MODEL, answers: {
    action: choiceAnswer(pass1.action.criteria, { open_chat: 0.9 }),
    list_type: choiceAnswer(pass1.list_type.criteria, { unread: 0.7 }),
    compound: { type: 'noul', noul: 0.1 },
  } }
  assert.equal(validateJevAnswers(payload, pass1).action.choice, 'open_chat')
  const chat = buildChatQuestion([CHATS.webhook], Date.now())
  assert.throws(() => validateJevAnswers({ model: JEV_MODEL, answers: { chat: choiceAnswer({ other: null }, { other: 1 }) } }, chat), JevValidationError)
})

test('whole-percentage probabilities are accepted within rounding, others must sum to 1', () => {
  const questions = { pick: { type: 'choice', instructions: 'x', criteria: { a: null, b: null, c: null } } }
  const ok = { model: JEV_MODEL, answers: { pick: { type: 'choice', choice: 'a', confidence: 0.5, probabilities: { a: 0.67, b: 0.17, c: 0.17 } } } }
  assert.equal(validateJevAnswers(ok, questions).pick.choice, 'a')
  const off = { model: JEV_MODEL, answers: { pick: { type: 'choice', choice: 'a', confidence: 0.5, probabilities: { a: 0.6712, b: 0.17, c: 0.17 } } } }
  assert.throws(() => validateJevAnswers(off, questions), JevValidationError)
})

test('askJev without a key is disabled and makes no request', async () => {
  let called = false
  const outcome = await askJev(buildPass1Questions(), {}, { apiKey: '', fetchImpl: async () => { called = true } })
  assert.deepEqual(outcome, { ok: false, reason: 'disabled', elapsedMs: 0 })
  assert.equal(called, false)
})

test('askJev refuses oversized state without sending it', async () => {
  let called = false
  const outcome = await askJev(buildPass1Questions(), { spoken_request: 'x'.repeat(130_000) }, { apiKey: 'k', fetchImpl: async () => { called = true } })
  assert.equal(outcome.reason, 'too_large')
  assert.equal(called, false)
})

// --- LLM fallback ---------------------------------------------------------------

const unsure = (action = 'send_to_chat') => ({ pass1: { action: { [action]: 0.6, other: 0.3 } } })

test('a confident Jev "other" is trusted: out of scope, and the LLM is not asked', async () => {
  const decisionCalls = []
  const script = { pass1: { action: { other: VOICE_THRESHOLDS.trustedOther } } }
  const { result, trace } = await routeVoiceCommand('stop the export job', buildContext(), deps(script, { decisionCalls, decision: [llmChat('send_to_chat', 'exportJob', { message: 'stop' })] }))
  assert.equal(result.outcome, 'not_understood')
  assert.equal(decisionCalls.length, 0)
  assert.equal(trace.path, 'jev')
})

test('a doubtful Jev "other" asks the LLM, which can find a send in a long ramble', async () => {
  const say = 'Respond to the iPhone shortcut chat and basically, you know, add a small microphone to the notification bar. Do you get what I mean?'
  const script = { pass1: { action: { other: 0.55, send_to_chat: 0.4 } } }
  const decisionCalls = []
  const decision = [llmChat('send_to_chat', 'shortcut', { message: 'add a small microphone to the notification bar. Do you get what I mean?', chatWords: 'iPhone shortcut chat' })]
  const { result, trace } = await routeVoiceCommand(say, buildContext(), deps(script, { decision, decisionCalls }))
  assert.equal(result.outcome, 'send_ready')
  assert.equal(result.threadId, CHATS.shortcut.threadId)
  assert.equal(result.message, decision[0].message)
  assert.equal(trace.path, 'llm')
  assert.equal(trace.fallback.reason, 'other')
  // The LLM sees the same candidates pass 2 would, including older chats the words name.
  assert.ok(decisionCalls[0].chats.some((row) => row.threadId === CHATS.shortcut.threadId))
  assert.deepEqual(decisionCalls[0].projects, PROJECTS)
})

test('the LLM finding nothing to do is "didn\'t catch that"; the LLM failing keeps Jev\'s reason', async () => {
  const none = await routeVoiceCommand('mm hmm', buildContext(), deps(unsure(), { decision: [] }))
  assert.equal(none.result.outcome, 'not_understood')
  assert.equal(none.result.reason, 'other')
  assert.equal(none.trace.path, 'llm')
  const failed = await routeVoiceCommand('mm hmm', buildContext(), deps(unsure(), { decision: null }))
  assert.equal(failed.result.reason, 'low_confidence')
  assert.equal(failed.trace.path, 'none')
  assert.ok(failed.result.candidates.length > 0, 'recent chats offered')
})

test('an unsure LLM pick is a chooser with its ideas first', async () => {
  const decision = [llmChat('send_to_chat', 'login', { certain: false, alternatives: [CHATS.pricing.threadId], message: 'merge it' })]
  const { result } = await routeVoiceCommand('tell the booking one to merge it', buildContext(), deps(unsure(), { decision }))
  assert.equal(result.outcome, 'picker')
  assert.equal(result.message, 'merge it')
  assert.deepEqual(result.candidates.slice(0, 2).map((row) => row.threadId), [CHATS.login.threadId, CHATS.pricing.threadId])
})

test('an unsure LLM pick that the words alone name is taken: two signals agree', async () => {
  const decision = [llmChat('send_to_chat', 'shortcut', { certain: false, chatWords: 'iPhone shortcut chat', message: 'add a microphone' })]
  const { result } = await routeVoiceCommand('tell the iPhone shortcut chat to add a microphone', buildContext(), deps(unsure(), { decision }))
  assert.equal(result.outcome, 'send_ready')
  assert.equal(result.threadId, CHATS.shortcut.threadId)
})

test('a sure LLM pick still becomes a chooser when the words fit several chats', async () => {
  const decision = [llmChat('open_chat', 'checkout', { chatWords: 'booking platform chat' })]
  const { result } = await routeVoiceCommand('view the booking platform chat', buildContext(), deps(unsure('open_chat'), { decision }))
  assert.equal(result.outcome, 'picker')
  assert.equal(result.reason, 'same_project')
})

test('an LLM step with no known chat lists its alternatives, then chats the words name', async () => {
  const decision = [llmChat('open_chat', null, { alternatives: [CHATS.dashboard.threadId] })]
  const { result } = await routeVoiceCommand('open the charts thing', buildContext(), deps(unsure('open_chat'), { decision }))
  assert.equal(result.outcome, 'picker')
  assert.equal(result.reason, 'no_match')
  assert.equal(result.candidates[0].threadId, CHATS.dashboard.threadId)
})

test('an LLM send without usable words falls back to the rule, else opens the chat', async () => {
  const decision = [llmChat('send_to_chat', 'webhook', { message: '' })]
  const ruled = (await routeVoiceCommand('tell the stripe webhook chat to deploy it', buildContext(), deps(unsure(), { decision }))).result
  assert.equal(ruled.outcome, 'send_ready')
  assert.equal(ruled.message, 'deploy it')
  const bare = (await routeVoiceCommand('stripe webhook chat please', buildContext(), deps(unsure(), { decision }))).result
  assert.equal(bare.outcome, 'open_chat')
  assert.equal(bare.reason, 'no_message')
})

test('LLM new chats use the same project and agent rules', async () => {
  const named = (await routeVoiceCommand('um new chat in codexui patched and add a mic', buildContext(), deps(unsure('new_chat'), { decision: [llmNew('codexui-patched', { agent: 'codex', message: 'add a mic' })] }))).result
  assert.equal(named.outcome, 'new_chat')
  assert.equal(named.project?.label, 'codexui-patched')
  assert.equal(named.agent, null, 'codex is only part of the project name')
  assert.equal(named.message, 'add a mic')
  const unclear = (await routeVoiceCommand('a new chat to add a mic with claude', buildContext(), deps(unsure('new_chat'), { decision: [llmNew(null, { agent: 'claude', message: 'add a mic' })] }))).result
  assert.equal(unclear.project, null)
  assert.equal(unclear.reason, 'project_unclear')
  assert.equal(unclear.agent, 'claude')
  assert.equal(unclear.projectOptions.length, PROJECTS.length)
})

test('an LLM list lands on that panel section', async () => {
  const { result } = await routeVoiceCommand('is there anything I have not looked at', buildContext(), deps(unsure('list_chats'), { decision: [llmList('unread')] }))
  assert.equal(result.action, 'list_chats')
  assert.equal(result.listType, 'unread')
  assert.equal(result.outcome, 'picker')
})

test('several LLM steps become a steps result, each routed on its own without the whole-command rules', async () => {
  const script = { pass1: { action: { send_to_chat: 0.9 }, compound: 0.9 } }
  const decision = [
    llmChat('send_to_chat', 'webhook', { message: 'deploy it', chatWords: 'stripe webhook chat' }),
    llmChat('open_chat', 'bounces', { chatWords: 'email bounces chat' }),
    llmNew('hr-ai', { message: 'fix the quiz' }),
  ]
  const { result, trace } = await routeVoiceCommand('tell the stripe webhook chat to deploy it and open the email bounces chat and new chat in hr-ai to fix the quiz', buildContext(), deps(script, { decision }))
  assert.equal(result.outcome, 'steps')
  assert.equal(trace.fallback.reason, 'compound')
  assert.deepEqual(result.steps.map((step) => step.outcome), ['send_ready', 'open_chat', 'new_chat'])
  assert.equal(result.steps[0].message, 'deploy it', 'the step message, not a rule cut of the whole command')
  assert.equal(result.steps[2].project?.label, 'hr-ai')
  assert.equal(result.steps[2].message, 'fix the quiz')
  assert.ok(result.steps.every((step) => step.heard === result.heard))
})

test('a pass 2 close call asks the LLM, which settles it only when Jev also ranked that chat high', async () => {
  const close = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [CHATS.shortcut.threadId]: 0.5, [CHATS.pushNotes.threadId]: 0.45 } } }
  const agree = await routeVoiceCommand('tell the brainstorm chat to add a mic', buildContext(), deps(close, { decision: [llmChat('send_to_chat', 'shortcut', { message: 'add a mic' })] }))
  assert.equal(agree.result.outcome, 'send_ready')
  assert.equal(agree.result.threadId, CHATS.shortcut.threadId)
  assert.equal(agree.trace.path, 'jev+llm')
  assert.equal(agree.trace.fallback.reason, 'chat_unclear')
  const elsewhere = await routeVoiceCommand('tell the brainstorm chat to add a mic', buildContext(), deps(close, { decision: [llmChat('send_to_chat', 'login', { message: 'add a mic' })] }))
  assert.equal(elsewhere.result.outcome, 'picker', 'the LLM and Jev disagree')
  assert.equal(elsewhere.result.candidates[0].threadId, CHATS.login.threadId, "the LLM's idea leads the chooser")
  const failed = await routeVoiceCommand('tell the brainstorm chat to add a mic', buildContext(), deps(close, { decision: null }))
  assert.equal(failed.result.outcome, 'picker')
  assert.equal(failed.result.candidates[0].threadId, CHATS.shortcut.threadId)
})

test('a close call the words leave open goes straight to the chooser without the LLM', async () => {
  const decisionCalls = []
  const close = { pass1: { action: { open_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.5, [CHATS.checkout.threadId]: 0.4 } } }
  const { result } = await routeVoiceCommand('open the stripe one', buildContext(), deps(close, { decisionCalls, decision: [llmChat('open_chat', 'webhook')] }))
  assert.equal(result.outcome, 'picker')
  assert.equal(decisionCalls.length, 0)
})

test('only a send Jev itself was sure of may be confirmed inside the Shortcut', () => {
  const at = (path, confidence) => allowsShortcutConfirm({ calls: [], path, pass1: { action: 'send_to_chat', actionConfidence: confidence, actionProbabilities: {}, listType: 'recent', compound: 0 } })
  assert.equal(at('jev', VOICE_THRESHOLDS.shortcutConfirmActionConfidence), true)
  assert.equal(at('jev', VOICE_THRESHOLDS.shortcutConfirmActionConfidence - 0.01), false)
  assert.equal(at('llm', 0.99), false)
  assert.equal(at('jev+llm', 0.99), false)
})

// --- Auto-send inputs: what made a pick sure, and drafts ----------------------------

test('a sure send records what made it sure, for each path', async () => {
  const sure = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.93 } } }
  assert.equal((await routeVoiceCommand('tell the stripe webhook chat to deploy it', buildContext(), deps(sure))).result.basis, 'jev')
  const modest = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [CHATS.shortcut.threadId]: 0.6, [CHATS.pushNotes.threadId]: 0.2 } } }
  assert.equal((await routeVoiceCommand('tell the iPhone shortcut chat to add a mic', buildContext(), deps(modest))).result.basis, 'jev+words')
  const near = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [CHATS.login.threadId]: 0.5, [CHATS.pushNotes.threadId]: 0.45 } } }
  const settled = (await routeVoiceCommand('tell the mobile layout chat to add a mic', buildContext(), deps(near, { decision: [llmChat('send_to_chat', 'login', { message: 'add a mic' })] }))).result
  assert.equal(settled.basis, 'jev+llm', 'the LLM is sure and Jev ranked it in its top two')
  const llmWords = (await routeVoiceCommand('tell the iPhone shortcut chat to add a microphone', buildContext(), deps(unsure(), { decision: [llmChat('send_to_chat', 'shortcut', { certain: false, chatWords: 'iPhone shortcut chat', message: 'add a microphone' })] }))).result
  assert.equal(llmWords.basis, 'llm+words')
  const llmAlone = (await routeVoiceCommand('tell the mobile layout one to add a microphone', buildContext(), deps(unsure(), { decision: [llmChat('send_to_chat', 'login', { certain: true, message: 'add a microphone' })] }))).result
  assert.equal(llmAlone.outcome, 'send_ready')
  assert.equal(llmAlone.basis, 'llm', 'the LLM alone: routed, but not enough to send without a tap')
})

test('a new chat records how its project was chosen', async () => {
  const jevProject = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { 'hr-ai': 0.94 } } }
  assert.equal((await routeVoiceCommand('new chat in hr-ai, fix the build', buildContext(), deps(jevProject))).result.basis, 'words', 'the rule read the name')
  assert.equal((await routeVoiceCommand('start something for hr-ai and fix the build', buildContext(), deps(jevProject, { llm: { message: 'fix the build', provider: 'anthropic' } }))).result.basis, 'jev')
  const llmNamed = (await routeVoiceCommand('um new chat in codexui patched and add a mic', buildContext(), deps(unsure('new_chat'), { decision: [llmNew('codexui-patched', { message: 'add a mic', projectNamed: true })] }))).result
  assert.equal(llmNamed.basis, 'words', 'the rule also read it')
  const llmOnly = (await routeVoiceCommand('a fresh one for the vault to tidy the inbox', buildContext(), deps(unsure('new_chat'), { decision: [llmNew('notes-vault', { message: 'tidy the inbox', projectNamed: true })] }))).result
  assert.equal(llmOnly.project?.label, 'notes-vault')
  assert.equal(llmOnly.basis, 'llm', 'no project name in the words')
})

test('"draft", "don\'t send" and "just type" mark the result draft-only and stay out of the message', async () => {
  const sure = { pass1: { action: { send_to_chat: 0.95 } }, pass2: { chat: { [CHATS.webhook.threadId]: 0.93 } } }
  for (const say of ['draft a reply to the stripe webhook chat saying deploy it', 'tell the stripe webhook chat to deploy it, but don\'t send it', 'just type deploy it in the stripe webhook chat', 'tell the stripe webhook chat to deploy it. I\'ll send it myself']) {
    const { result } = await routeVoiceCommand(say, buildContext(), deps(sure))
    assert.equal(result.outcome, 'send_ready', say)
    assert.equal(result.message, 'deploy it', say)
    assert.equal(result.draftOnly, true, say)
    assert.equal(result.heard, say, 'what was heard is kept whole')
  }
  const plain = (await routeVoiceCommand('tell the docs chat to draft the release notes', buildContext(), deps(sure))).result
  assert.equal(plain.draftOnly, undefined, 'asking the agent to draft something is a normal send')
  const llmDraft = (await routeVoiceCommand('respond to the iPhone shortcut chat with add a mic but hold it for me', buildContext(), deps(unsure(), { decision: [llmChat('send_to_chat', 'shortcut', { chatWords: 'iPhone shortcut chat', message: 'add a mic', draftOnly: true })] }))).result
  assert.equal(llmDraft.draftOnly, true, 'the LLM can spot a draft the rules miss')
  const steps = { pass1: { action: { send_to_chat: 0.9 }, compound: 0.9 } }
  const multi = (await routeVoiceCommand('draft: tell the stripe webhook chat to deploy it and new chat in hr-ai to fix the quiz', buildContext(), deps(steps, { decision: [llmChat('send_to_chat', 'webhook', { chatWords: 'stripe webhook chat', message: 'deploy it' }), llmNew('hr-ai', { message: 'fix the quiz' })] }))).result
  assert.equal(multi.outcome, 'steps')
  assert.ok(multi.steps.every((step) => step.draftOnly === true), 'a spoken "draft" covers every step')
})

// --- Default project and bare tasks ------------------------------------------------

const withDefault = () => buildContext({ defaultProject: DEFAULT_PROJECT })

for (const phrase of QUERY_PHRASES.filter((entry) => entry.journey === 8)) {
  test(`starts a new chat for "${phrase.say}"`, async () => {
    const script = scriptFor(phrase)
    const llm = phrase.expect.message === undefined ? { message: phrase.say, provider: 'anthropic' } : null
    const { result, trace } = await routeVoiceCommand(phrase.say, withDefault(), deps(script, { llm }))
    assert.equal(result.outcome, 'new_chat')
    assert.equal(result.project?.label ?? null, phrase.expect.project)
    if (phrase.expect.message !== undefined) assert.equal(result.message, phrase.expect.message)
    if ('agent' in phrase.expect) assert.equal(result.agent ?? null, phrase.expect.agent)
    if (phrase.expect.projectNamed === false) assert.equal(result.basis, 'default')
    if (phrase.expect.projectNamed === true) assert.equal(result.reason, 'project_unclear', 'a name said but not matched never falls back to the default')
    assert.ok(trace.calls.length <= 2)
  })
}

test('without a default project, a task with no project opens the project chooser with the message', async () => {
  const phrase = QUERY_PHRASES[0]
  const { result } = await routeVoiceCommand(phrase.say, buildContext(), deps(scriptFor(phrase)))
  assert.equal(result.outcome, 'new_chat')
  assert.equal(result.project, null)
  assert.equal(result.reason, 'project_unclear')
  assert.equal(result.message, phrase.say)
})

test('Jev must be sure no project was named; a project word in the request blocks the default', async () => {
  const unsureNone = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { not_named: 0.6, other: 0.3 } } }
  assert.equal((await routeVoiceCommand('find me the best hotels for the travel project', withDefault(), deps(unsureNone))).result.project, null)
  const otherProject = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { other: 0.94 } } }
  assert.equal((await routeVoiceCommand('new chat in the marketing repo, plan the launch', withDefault(), deps(otherProject))).result.project, null)
  // Jev says not named, but the words do name a listed project: not the default.
  const wrongNone = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { not_named: 0.95 } } }
  const named = (await routeVoiceCommand('a fresh one for slack AI to look at the logs', withDefault(), deps(wrongNone, { llm: { message: 'look at the logs', provider: 'anthropic' } }))).result
  assert.notEqual(named.project?.label, DEFAULT_PROJECT.label)
})

test('the LLM path uses the default only when it says no project was named', async () => {
  const say = 'so um I was wondering, what are the best chicken rice stalls near Tiong Bahru'
  const none = (await routeVoiceCommand(say, withDefault(), deps(unsure('new_chat'), { decision: [llmNew(null, { message: 'what are the best chicken rice stalls near Tiong Bahru', projectNamed: false })] }))).result
  assert.equal(none.project?.label, DEFAULT_PROJECT.label)
  assert.equal(none.basis, 'default')
  const named = (await routeVoiceCommand(say, withDefault(), deps(unsure('new_chat'), { decision: [llmNew(null, { message: 'what are the best chicken rice stalls near Tiong Bahru', projectNamed: true })] }))).result
  assert.equal(named.project, null)
})

test('fragments that lean on earlier work never start a chat, even when Jev calls them new chats', async () => {
  const wrong = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { not_named: 0.95 } } }
  for (const say of ['deploy it', 'try that again', 'fix it', 'do the same for the other one', 'uh the thing from before']) {
    const { result } = await routeVoiceCommand(say, withDefault(), deps(wrong))
    assert.equal(result.outcome, 'not_understood', say)
    assert.equal(result.reason, 'fragment', say)
  }
})

test('pass 1 teaches standalone tasks as new chats and keeps fragments and app requests out', () => {
  const { action } = buildPass1Questions()
  assert.ok(action.criteria.new_chat.examples.includes('find me the best hotels in Johor Bahru'))
  assert.ok(action.criteria.other.examples.includes('deploy it'))
  assert.ok(!action.criteria.other.examples.includes('what time is it'))
  const { questions } = router.buildNewChatQuestions(PROJECTS)
  assert.ok('not_named' in questions.project.criteria)
  assert.ok('other' in questions.project.criteria)
})

test('Jev\'s best guess that no project was named counts when no word sounds like a project', async () => {
  const lean = { pass1: { action: { new_chat: 0.95 } }, pass2: { project: { not_named: 0.6, other: 0.3 } } }
  const plain = (await routeVoiceCommand('summarise the latest news on OpenAI', withDefault(), deps(lean))).result
  assert.equal(plain.project?.label, DEFAULT_PROJECT.label)
  const repo = (await routeVoiceCommand('new chat in the marketing repo, plan the launch', withDefault(), deps(lean))).result
  assert.equal(repo.project, null, '"repo" in the words: Jev must be sure')
})
