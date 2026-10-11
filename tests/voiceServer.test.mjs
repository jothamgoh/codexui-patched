import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { CHATS } from './fixtures/voicePhrases.mjs'

// Bundled to a file under output/ so external packages (web-push, markdown-it) resolve from node_modules.
const bundleDir = fileURLToPath(new URL('../output/test-bundles/', import.meta.url))
async function loadModule(path) {
  const outfile = join(bundleDir, `${path.split('/').at(-1).replace(/\.ts$/u, '')}-${process.pid}.mjs`)
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

const routes = await loadModule('../src/server/voice/voiceRoutes.ts')
const { VoiceResultStore, createVoiceCode, VOICE_RESULT_TTL_MS, VOICE_CONFIRM_TTL_MS } = await loadModule('../src/server/voice/voiceStore.ts')
const { buildVoiceContext } = await loadModule('../src/server/voice/voiceContext.ts')
const { getCodexUiChildEnv, SENSITIVE_ENV_KEYS } = await loadModule('../src/server/envFile.ts')
const push = await loadModule('../src/server/webPushTurnNotifier.ts')
const { voiceResultPath, isVoiceCode } = await loadModule('../src/types/voice.ts')
const { JEV_MODEL } = await loadModule('../src/server/voice/jevClient.ts')

const TOKEN = 'test-shortcut-token-0123456789abcdef'
const NOW = Date.UTC(2026, 9, 11, 9, 41, 0)
const seconds = (minutesAgo) => Math.floor((NOW - minutesAgo * 60_000) / 1000)

// --- Fixtures -------------------------------------------------------------------

function summary(id, name, cwd, minutesAgo, extra = {}) {
  return { id, name, preview: `${name} preview`, cwd, createdAt: seconds(minutesAgo + 60), updatedAt: seconds(minutesAgo), source: 'cli', status: { type: 'idle' }, ...extra }
}

function snapshot(overrides = {}) {
  return {
    threadSummaries: [
      summary(CHATS.webhook.threadId, 'Stripe webhook bug', '/work/hr-ai', 4),
      summary(CHATS.bounces.threadId, 'Customer email bounces', '/work/hr-ai', 18),
      summary(CHATS.exportJob.threadId, 'Nightly export job', '/work/automation', 3),
      summary(CHATS.checkout.threadId, 'Stripe checkout copy', '/work/booking-platform', 12, { status: { type: 'active' } }),
      summary(CHATS.notes.threadId, 'Notes vault sync', '/work/notes-vault', 60),
      summary(CHATS.migration.threadId, 'Approve database migration', '/work/hr-ai', 6),
      summary('board-lead-thread', 'Board lead', '/work/hr-ai', 2),
      summary('helper-thread', 'Helper', '/work/automation', 1, { source: { subAgent: { thread_spawn: { parent_thread_id: CHATS.notes.threadId } } } }),
      summary('worktree-thread', 'Worktree chat', '/home/u/.codex/worktrees/abc/hr-ai', 300),
      summary(CHATS.payouts.threadId, 'Stripe payouts report', '/work/automation', 24 * 60),
    ],
    extraSummaries: [],
    titles: { [CHATS.payouts.threadId]: 'Stripe payouts report (renamed)' },
    readState: {
      readAtByThreadId: {
        [CHATS.webhook.threadId]: new Date(NOW - 30 * 60_000).toISOString(),
        [CHATS.notes.threadId]: new Date(NOW).toISOString(),
        [CHATS.payouts.threadId]: new Date(NOW).toISOString(),
      },
      unreadThreadIds: [CHATS.bounces.threadId],
    },
    activeTurnThreadIds: [CHATS.exportJob.threadId, 'helper-thread'],
    backgroundThreadIds: [],
    pendingRequests: [{ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: CHATS.migration.threadId }, receivedAtIso: new Date(NOW - 5 * 60_000).toISOString() }],
    history: [],
    dismissals: [],
    boardSnapshot: { boards: [{ id: 'b1', name: 'Board', planningThreadId: '' }], cards: [{ id: 'c1', boardId: 'b1', type: 'feature', title: 'Feature', threadId: 'board-lead-thread', status: 'running' }], agents: [], questions: [], comments: [], artifacts: [], runs: [] },
    workspaceRoots: { order: ['/work/hr-ai', '/work/slack-ai'], labels: { '/work/slack-ai': 'slack-ai' } },
    nowMs: NOW,
    ...overrides,
  }
}

test('the server context mirrors the panel: sections, exclusions and flags', () => {
  const context = buildVoiceContext(snapshot())
  const ids = (rows) => rows.map((row) => row.threadId)
  assert.deepEqual(ids(context.sections.needs_you), [CHATS.migration.threadId])
  assert.deepEqual(ids(context.sections.running), [CHATS.exportJob.threadId, CHATS.checkout.threadId, CHATS.notes.threadId], 'newest first: an active turn, an active runtime status, a running helper\'s parent')
  assert.deepEqual(ids(context.sections.unread), [CHATS.webhook.threadId, CHATS.bounces.threadId], 'activity after the last read, and unread-by-event')
  assert.deepEqual(ids(context.sections.recent), ['worktree-thread', CHATS.payouts.threadId])
  const all = [...Object.values(context.sections).flat(), ...context.otherChats]
  assert.ok(!all.some((row) => row.threadId === 'helper-thread'), 'helper sub-chats are left out')
  assert.ok(!all.some((row) => row.threadId === 'board-lead-thread'), 'project-board chats are left out')
  assert.equal(context.sections.recent[1].title, 'Stripe payouts report (renamed)', 'saved titles win')
  assert.equal(context.sections.unread[0].agent, 'claude')
  assert.equal(context.sections.unread[1].agent, 'codex')
  assert.deepEqual(context.projects.map((project) => project.label), ['automation', 'hr-ai', 'booking-platform', 'notes-vault', 'slack-ai'])
  assert.ok(!context.projects.some((project) => project.id.includes('/worktrees/')), 'worktree folders are not projects')
})

test('pinned chats lead Recent once, and keep their place in Running or Unread', () => {
  const context = buildVoiceContext(snapshot({ pinnedThreadIds: [CHATS.payouts.threadId, CHATS.exportJob.threadId, 'not-listed'] }))
  assert.equal(context.sections.recent[0].threadId, CHATS.payouts.threadId)
  assert.equal(context.sections.recent.filter((row) => row.threadId === CHATS.payouts.threadId).length, 1)
  assert.ok(context.sections.running.some((row) => row.threadId === CHATS.exportJob.threadId), 'a pinned running chat is still running')
  assert.ok(!context.sections.recent.some((row) => row.threadId === CHATS.exportJob.threadId))
})

test('dismissed history hides a chat from recent, like the panel', () => {
  const history = [{ id: 'h1', threadId: CHATS.payouts.threadId, turnId: 't', status: 'completed', title: 'x', body: 'Weekly **payouts** sent', completedAt: new Date(NOW - 60_000).toISOString(), readAt: new Date(NOW).toISOString() }]
  const shown = buildVoiceContext(snapshot({ history }))
  assert.equal(shown.sections.recent.find((row) => row.threadId === CHATS.payouts.threadId).summary, 'Weekly payouts sent')
  const hidden = buildVoiceContext(snapshot({ history, dismissals: [{ threadId: CHATS.payouts.threadId, activityAt: history[0].completedAt }] }))
  assert.ok(!hidden.sections.recent.some((row) => row.threadId === CHATS.payouts.threadId && row.summary === 'Weekly payouts sent'))
})

// --- HTTP handler ------------------------------------------------------------------

function jevResponder() {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    const answers = {}
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === 'noul') { answers[id] = { type: 'noul', noul: 0.02 }; continue }
      const keys = Object.keys(question.criteria)
      const spoken = body.state.spoken_request
      let wanted = keys[0]
      if (id === 'action') wanted = /^tell /u.test(spoken) ? 'send_to_chat' : /^new chat/u.test(spoken) ? 'new_chat' : /unread/u.test(spoken) ? 'list_chats' : /^open/u.test(spoken) ? 'open_chat' : 'other'
      if (id === 'list_type') wanted = 'unread'
      if (id === 'chat') wanted = CHATS.webhook.threadId
      if (id === 'project') wanted = 'hr-ai'
      if (id === 'agent') wanted = 'not_said'
      const probabilities = Object.fromEntries(keys.map((key) => [key, key === wanted ? 0.96 : 0.04 / (keys.length - 1)]))
      answers[id] = { type: 'choice', choice: wanted, confidence: 0.95, probabilities }
    }
    return new Response(JSON.stringify({ model: JEV_MODEL, answers }), { status: 200 })
  }
}

async function startHandler(t, { env = { CODEXUI_VOICE_SHORTCUT_TOKEN: TOKEN, CODEXUI_VOICE_TYPESAFE_API_KEY: 'jev-test' }, now = () => NOW, sendMessage, transcribe } = {}) {
  const pushes = []
  const sent = []
  const transcribed = []
  const logs = []
  const clock = { now }
  const store = new VoiceResultStore(() => clock.now())
  const handler = routes.createVoiceCommandHandler({
    collectSnapshot: async () => snapshot(),
    transcribe: transcribe ?? (async (audio, contentType) => { transcribed.push({ audio, contentType }); return 'show me all unread chats' }),
    sendMessage: sendMessage ?? (async (threadId, text) => { sent.push({ threadId, text }) }),
    notify: async (notification) => { pushes.push(notification); return { sent: 1, failed: 0 } },
    env: () => env,
    store,
    fetchImpl: jevResponder(),
    log: (line) => logs.push(line),
  })
  const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end('next') }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, { method = 'POST', token, body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(typeof body === 'object' && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, json, text, headers: response.headers }
  }
  return { call, pushes, sent, transcribed, logs, clock, store }
}

test('shortcut routes are disabled when the token is unset or too short', async (t) => {
  for (const env of [{}, { CODEXUI_VOICE_SHORTCUT_TOKEN: '' }, { CODEXUI_VOICE_SHORTCUT_TOKEN: 'short-token' }]) {
    const { call, pushes } = await startHandler(t, { env })
    const response = await call('/codex-api/voice/shortcut/command', { token: 'short-token', body: { text: 'show me all unread chats' } })
    assert.equal(response.status, 404)
    assert.equal(response.json.kind, 'error')
    assert.equal(pushes.length, 0)
  }
})

test('a missing, wrong or malformed bearer token is rejected before anything runs', async (t) => {
  const { call, pushes, sent } = await startHandler(t)
  for (const headers of [{}, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: `Basic ${TOKEN}` }, { Authorization: TOKEN }, { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }]) {
    const response = await call('/codex-api/voice/shortcut/command', { headers, body: { text: 'show me all unread chats' } })
    assert.equal(response.status, 401, JSON.stringify(headers))
    assert.equal(response.headers.get('www-authenticate'), 'Bearer')
  }
  assert.equal((await call(`/codex-api/voice/shortcut/command?token=${TOKEN}`, { body: { text: 'show me all unread chats' } })).status, 401, 'a token in the URL is not accepted')
  assert.equal((await call('/codex-api/voice/shortcut/confirm', { body: { token: createVoiceCode() } })).status, 401)
  assert.equal((await call('/codex-api/voice/shortcut/anything', { method: 'GET' })).status, 401, 'the whole prefix needs the token')
  assert.equal(pushes.length, 0)
  assert.equal(sent.length, 0)
})

test('a spoken list notifies the phone and the PWA reads the result without the token', async (t) => {
  const { call, pushes, logs } = await startHandler(t)
  const response = await call('/codex-api/voice/shortcut/command', { token: TOKEN, body: { text: 'show me all unread chats' } })
  assert.equal(response.status, 200)
  assert.equal(response.json.kind, 'notified')
  assert.equal(response.json.confirm, undefined)
  assert.equal(pushes.length, 1)
  const match = /^\/#\/voice\/([A-Za-z0-9_-]{24})$/u.exec(pushes[0].url)
  assert.ok(match, `picker link: ${pushes[0].url}`)
  const result = await call(`/codex-api/voice/${match[1]}`, { method: 'GET' })
  assert.equal(result.status, 200)
  assert.equal(result.json.data.outcome, 'picker')
  assert.equal(result.json.data.listType, 'unread')
  assert.equal(result.json.data.heard, 'show me all unread chats')
  assert.ok(result.json.data.candidates.length >= 2)
  assert.ok(logs.every((line) => !line.includes('unread chats')), 'logs never contain the transcript')
})

test('a clear send asks the Shortcut to confirm; the token works once and sends once', async (t) => {
  const { call, pushes, sent } = await startHandler(t)
  const response = await call('/codex-api/voice/shortcut/command', { token: TOKEN, body: { text: 'tell the stripe webhook chat to deploy it to staging' } })
  assert.equal(response.json.kind, 'confirm')
  assert.equal(response.json.confirm.message, 'deploy it to staging')
  assert.equal(response.json.confirm.chatTitle, 'Stripe webhook bug')
  assert.ok(isVoiceCode(response.json.confirm.token))
  assert.equal(pushes.length, 0, 'nothing is pushed until the user confirms')
  assert.equal(sent.length, 0, 'nothing is sent until the user confirms')

  const confirmed = await call('/codex-api/voice/shortcut/confirm', { token: TOKEN, body: { token: response.json.confirm.token } })
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.json.say, 'Sent ✓')
  assert.deepEqual(sent, [{ threadId: CHATS.webhook.threadId, text: 'deploy it to staging' }])
  assert.equal(pushes.at(-1).url, `/#/thread/${encodeURIComponent(CHATS.webhook.threadId)}`)
  assert.match(pushes.at(-1).title, /^Sent ✓/u)

  const replay = await call('/codex-api/voice/shortcut/confirm', { token: TOKEN, body: { token: response.json.confirm.token } })
  assert.equal(replay.status, 410)
  assert.equal(sent.length, 1, 'a replayed token sends nothing')
})

test('confirm tokens expire, and guessed tokens do nothing', async (t) => {
  const { call, sent, clock } = await startHandler(t)
  const response = await call('/codex-api/voice/shortcut/command', { token: TOKEN, body: { text: 'tell the stripe webhook chat to deploy it' } })
  clock.now = () => NOW + VOICE_CONFIRM_TTL_MS + 1
  assert.equal((await call('/codex-api/voice/shortcut/confirm', { token: TOKEN, body: { token: response.json.confirm.token } })).status, 410)
  for (const guess of [createVoiceCode(), 'not-a-token', '', null, 123]) {
    assert.equal((await call('/codex-api/voice/shortcut/confirm', { token: TOKEN, body: { token: guess } })).status, 410)
  }
  assert.equal(sent.length, 0)
})

test('a failed send consumes the token and reports the error', async (t) => {
  const { call } = await startHandler(t, { sendMessage: async () => { throw new Error('turn/start failed') } })
  const response = await call('/codex-api/voice/shortcut/command', { token: TOKEN, body: { text: 'tell the stripe webhook chat to deploy it' } })
  const failed = await call('/codex-api/voice/shortcut/confirm', { token: TOKEN, body: { token: response.json.confirm.token } })
  assert.equal(failed.status, 502)
  assert.equal(failed.json.kind, 'error')
  assert.equal((await call('/codex-api/voice/shortcut/confirm', { token: TOKEN, body: { token: response.json.confirm.token } })).status, 410)
})

test('results expire after ten minutes and unknown or malformed codes are 404', async (t) => {
  const { call, pushes, clock } = await startHandler(t)
  await call('/codex-api/voice/shortcut/command', { token: TOKEN, body: { text: 'show me all unread chats' } })
  const code = pushes[0].url.split('/').at(-1)
  assert.equal((await call(`/codex-api/voice/${code}`, { method: 'GET' })).status, 200)
  clock.now = () => NOW + VOICE_RESULT_TTL_MS + 1
  assert.equal((await call(`/codex-api/voice/${code}`, { method: 'GET' })).status, 404)
  for (const guess of [createVoiceCode(), 'abc', '../../etc/passwd', `${code}x`, 'shortcut']) {
    assert.equal((await call(`/codex-api/voice/${encodeURIComponent(guess)}`, { method: 'GET' })).status, 404, guess)
  }
})

test('the in-app command route runs the router without the token and without a push', async (t) => {
  const { call, pushes } = await startHandler(t)
  const response = await call('/codex-api/voice/command', { body: { text: 'new chat in hr-ai, fix the build' } })
  assert.equal(response.status, 200)
  assert.equal(response.json.data.result.outcome, 'new_chat')
  assert.equal(response.json.data.result.project.label, 'hr-ai')
  assert.equal(response.json.data.url, `/#/?voice=${response.json.data.code}`)
  assert.equal(pushes.length, 0)
  const send = await call('/codex-api/voice/command', { body: { text: 'tell the stripe webhook chat to deploy it' } })
  assert.equal(send.json.data.url, `/#/thread/${encodeURIComponent(CHATS.webhook.threadId)}?voice=${send.json.data.code}`, 'in the app, a send is confirmed in the composer')
})

test('the in-app route works even when the shortcut is disabled, and needs no bearer', async (t) => {
  const { call } = await startHandler(t, { env: { CODEXUI_VOICE_TYPESAFE_API_KEY: 'jev-test' } })
  assert.equal((await call('/codex-api/voice/command', { body: { text: 'show me all unread chats' } })).status, 200)
})

test('audio is wrapped for the transcriber; multipart passes through; failures are 502', async (t) => {
  const { call, transcribed, pushes } = await startHandler(t)
  const audio = new Uint8Array([1, 2, 3, 4])
  const raw = await call('/codex-api/voice/shortcut/command', { token: TOKEN, body: audio, headers: { 'Content-Type': 'audio/x-m4a' } })
  assert.equal(raw.status, 200)
  assert.equal(pushes.length, 1)
  assert.match(transcribed[0].contentType, /^multipart\/form-data; boundary=/u)
  const text = Buffer.from(transcribed[0].audio).toString('latin1')
  assert.match(text, /name="file"; filename="voice\.m4a"\r\nContent-Type: audio\/x-m4a/u)
  const multipart = 'multipart/form-data; boundary=abc'
  await call('/codex-api/voice/shortcut/command', { token: TOKEN, body: audio, headers: { 'Content-Type': multipart } })
  assert.equal(transcribed[1].contentType, multipart)
  assert.deepEqual([...transcribed[1].audio], [1, 2, 3, 4])

  const failing = await startHandler(t, { transcribe: async () => { throw new Error('no auth') } })
  const failed = await failing.call('/codex-api/voice/shortcut/command', { token: TOKEN, body: audio, headers: { 'Content-Type': 'audio/mp4' } })
  assert.equal(failed.status, 502)
  assert.equal(failed.json.kind, 'error')
})

test('oversized or empty bodies are refused', async (t) => {
  const { call } = await startHandler(t)
  assert.equal((await call('/codex-api/voice/shortcut/command', { token: TOKEN, body: { text: 'x'.repeat(20_000) } })).status, 413)
  assert.equal((await call('/codex-api/voice/shortcut/command', { token: TOKEN, body: { text: '   ' } })).status, 400)
  assert.equal((await call('/codex-api/voice/command', { body: 'not json', headers: { 'Content-Type': 'application/json' } })).status, 400)
})

test('only voice routes are handled; everything else passes through', async (t) => {
  const { call } = await startHandler(t)
  assert.equal((await call('/codex-api/thread-titles', { method: 'GET' })).text, 'next')
  assert.equal((await call('/codex-api/voicemail', { method: 'GET' })).text, 'next')
  assert.equal((await call('//codex-api/voice/x', { method: 'GET' })).text, 'next', 'a protocol-relative path is not parsed as a host')
})

// --- Store, codes, secrets, push payloads --------------------------------------------

test('result codes are unguessable: 24 base64url characters from 18 random bytes', () => {
  const codes = new Set(Array.from({ length: 2000 }, () => createVoiceCode()))
  assert.equal(codes.size, 2000)
  for (const code of codes) assert.ok(isVoiceCode(code), code)
})

test('the store returns a result until it expires and confirmations exactly once', () => {
  let now = NOW
  const store = new VoiceResultStore(() => now)
  const saved = store.save({ heard: 'x', action: 'other', outcome: 'not_understood', sections: { needs_you: [], running: [], unread: [], recent: [] }, candidates: [] })
  assert.equal(store.get(saved.code)?.heard, 'x')
  assert.equal(saved.expiresAtIso, new Date(NOW + VOICE_RESULT_TTL_MS).toISOString())
  now = NOW + VOICE_RESULT_TTL_MS - 1
  assert.ok(store.get(saved.code))
  now = NOW + VOICE_RESULT_TTL_MS
  assert.equal(store.get(saved.code), null)
  const token = store.createConfirmation({ threadId: 't', message: 'm', chatTitle: 'c', code: saved.code })
  assert.deepEqual(store.takeConfirmation(token), { threadId: 't', message: 'm', chatTitle: 'c', code: saved.code })
  assert.equal(store.takeConfirmation(token), null)
})

test('every voice secret is kept from agent processes', () => {
  for (const key of ['CODEXUI_VOICE_SHORTCUT_TOKEN', 'CODEXUI_VOICE_TYPESAFE_API_KEY', 'CODEXUI_VOICE_ANTHROPIC_API_KEY', 'CODEXUI_VOICE_ANTHROPIC_WORKSPACE_ID', 'CODEXUI_VOICE_DEEPSEEK_API_KEY', 'CODEXUI_VOICE_KIMI_API_KEY', 'CODEXUI_VOICE_CF_ACCESS_CLIENT_ID', 'CODEXUI_VOICE_CF_ACCESS_CLIENT_SECRET']) {
    assert.ok(SENSITIVE_ENV_KEYS.includes(key), key)
  }
  const saved = { ...process.env }
  try {
    process.env.CODEXUI_VOICE_TYPESAFE_API_KEY = 'secret'
    process.env.CODEXUI_VOICE_SHORTCUT_TOKEN = 'secret'
    process.env.CODEXUI_VOICE_SOMETHING_NEW = 'secret'
    process.env.CODEXUI_VOICE_PLAIN = 'secret'
    const child = getCodexUiChildEnv()
    assert.equal(Object.keys(child).filter((key) => key.startsWith('CODEXUI_VOICE_')).length, 0)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  }
})

test('custom push payloads always show and only link inside the app', () => {
  const payload = push.buildCustomPayload({ title: 'Sent ✓ · Stripe webhook bug', body: 'Tap to watch', url: '/#/thread/abc', tag: 'voice:1' })
  assert.deepEqual({ ...payload }, { title: 'Sent ✓ · Stripe webhook bug', body: 'Tap to watch', url: '/#/thread/abc', tag: 'voice:1', mode: 'always', icon: '/icons/agents-192.png', badge: '/icons/agents-192.png' })
  for (const url of ['https://evil.example/', 'javascript:alert(1)', '/thread/abc', '#/thread/abc', '//evil.example/#/', '']) {
    assert.equal(push.buildCustomPayload({ title: 't', body: 'b', url, tag: 'x' }).url, '/#/', url)
  }
  assert.equal(push.buildCustomPayload({ title: 't', body: 'b', url: `/#/voice/${'a'.repeat(5000)}`, tag: '' }).url.length, 2048)
  assert.equal(push.buildCustomPayload({ title: '', body: 'b', url: '/#/', tag: '' }).tag, 'codexui-custom')
})

test('voice notifications link to the page each outcome needs', () => {
  const code = createVoiceCode()
  const base = { heard: 'h', action: 'open_chat', sections: { needs_you: [], running: [], unread: [], recent: [] }, candidates: [CHATS.webhook], code, createdAtIso: '', expiresAtIso: '' }
  const cases = [
    [{ outcome: 'open_chat', threadId: CHATS.webhook.threadId }, `/#/thread/${encodeURIComponent(CHATS.webhook.threadId)}`],
    [{ outcome: 'picker' }, `/#/voice/${code}`],
    [{ outcome: 'empty', action: 'list_chats', listType: 'unread', candidates: [] }, `/#/voice/${code}`],
    [{ outcome: 'not_understood' }, `/#/voice/${code}`],
    [{ outcome: 'new_chat', action: 'new_chat', project: { id: '/w/hr-ai', label: 'hr-ai' }, message: 'fix it' }, `/#/?voice=${code}`],
    [{ outcome: 'send_ready', threadId: CHATS.webhook.threadId, message: 'm' }, `/#/thread/${encodeURIComponent(CHATS.webhook.threadId)}?voice=${code}`],
  ]
  for (const [overrides, url] of cases) {
    const notification = routes.buildVoiceNotification({ ...base, ...overrides })
    assert.equal(notification.url, url, overrides.outcome)
    assert.equal(push.buildCustomPayload(notification).url, url, 'the push layer keeps the link')
    assert.equal(notification.tag, `voice:${code}`)
  }
  assert.equal(routes.buildVoiceNotification({ ...base, outcome: 'empty', action: 'list_chats', listType: 'unread', candidates: [] }).title, 'Nothing unread ✓')
  assert.equal(voiceResultPath({ outcome: 'picker' }, code), `/#/voice/${code}`)
})

test('the web push notifier sends a custom notification to every subscription', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-voice-push-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.CODEXUI_WEB_PUSH_STATE_FILE
  process.env.CODEXUI_WEB_PUSH_STATE_FILE = join(directory, 'push.json')
  t.after(() => { if (previous === undefined) delete process.env.CODEXUI_WEB_PUSH_STATE_FILE; else process.env.CODEXUI_WEB_PUSH_STATE_FILE = previous })
  const notifier = push.createWebPushTurnNotifier()
  assert.deepEqual(await notifier.sendCustomNotification({ title: 't', body: 'b', url: '/#/', tag: 'x' }), { sent: 0, failed: 0 })
  assert.deepEqual(await notifier.readHistory(), { items: [], dismissals: [] })
})
