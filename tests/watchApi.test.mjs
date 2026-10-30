import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

// Bundled to a file under output/ so external packages (markdown-it, the Claude SDK) resolve from node_modules.
const bundleDir = fileURLToPath(new URL('../output/test-bundles/', import.meta.url))
async function loadModule(path) {
  const outfile = join(bundleDir, `watch-${path.split('/').at(-1).replace(/\.ts$/u, '')}-${process.pid}.mjs`)
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

const mapping = await loadModule('../src/server/watch/watchMapping.ts')
const routes = await loadModule('../src/server/watch/watchRoutes.ts')
const { readRequestQuestions, requestQuestionAnswerValues } = await loadModule('../src/api/requestUserInput.ts')
const { RESTART_CONTINUE_TEXT } = await loadModule('../src/server/restartResume.ts')
const { GOAL_CONTINUATION_TAG } = await loadModule('../src/server/claudeTranscript.ts')
const { ClaudeBackend } = await loadModule('../src/server/claudeBackend.ts')
const { SENSITIVE_ENV_KEYS, getCodexUiChildEnv } = await loadModule('../src/server/envFile.ts')

const TOKEN = 'watch-token-0123456789abcdef-0123456789'
const VOICE_TOKEN = 'voice-token-0123456789abcdef-0123456789'
const NOW = Date.UTC(2026, 9, 31, 9, 0, 0)
const S = (minutesAgo) => Math.floor((NOW - minutesAgo * 60_000) / 1000)
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString()

// --- Claude fixture: a real transcript read through ClaudeBackend's thread/read -------

const CLAUDE_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CLAUDE_ID = `claude-${CLAUDE_SESSION}`
const claudeCwd = '/work/claude-app'
const BASE_MS = NOW - 60 * 60_000
const at = (seconds) => new Date(BASE_MS + seconds * 1000).toISOString()
const entry = (uuid, parentUuid, fields) => ({ uuid, parentUuid, isSidechain: false, cwd: claudeCwd, sessionId: CLAUDE_SESSION, timestamp: at(0), ...fields })
const said = (uuid, parentUuid, seconds, text, extra = {}) => entry(uuid, parentUuid, {
  type: 'user', timestamp: at(seconds), message: { role: 'user', content: [{ type: 'text', text }] }, ...extra,
})
const assistant = (uuid, parentUuid, seconds, messageId, block) => entry(uuid, parentUuid, {
  type: 'assistant',
  timestamp: at(seconds),
  message: { id: messageId, model: 'claude-opus-5-5', role: 'assistant', content: [block], usage: { input_tokens: 10, output_tokens: 20 } },
})
const toolResult = (uuid, parentUuid, seconds, toolUseId, content, toolUseResult) => entry(uuid, parentUuid, {
  type: 'user', timestamp: at(seconds), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] }, toolUseResult,
})
/** What the composer sends for a reply with selected text (codexGateway.ts buildTextWithAttachments). */
const annotatedRequest = (annotations, request, agent = 'Claude') => [
  '# Response annotations:',
  'Each item contains text selected from an earlier Codex response and may include a user comment. Use every selection as context and address every comment in your response.',
  '<response-annotations>',
  JSON.stringify(annotations),
  '</response-annotations>',
  '',
  `## My request for ${agent}:`,
  '',
  request,
].join('\n')
const ANNOTATED_REQUEST = annotatedRequest([{ text: 'use a queue', annotation: 'Use the existing job queue' }], 'Ship the export job')
const CLAUDE_TRANSCRIPT = [
  said('u1', null, 0, ANNOTATED_REQUEST),
  assistant('a1', 'u1', 2, 'm1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }),
  toolResult('r1', 'a1', 3, 't1', 'ok', { stdout: 'ok', stderr: '', interrupted: false }),
  assistant('a2', 'r1', 4, 'm2', { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${claudeCwd}/src/export.ts`, old_string: 'a', new_string: 'b' } }),
  toolResult('r2', 'a2', 5, 't2', 'updated', { filePath: `${claudeCwd}/src/export.ts`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }),
  assistant('a3', 'r2', 6, 'm3', { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm run build' } }),
  toolResult('r3', 'a3', 7, 't3', 'built', { stdout: 'built', stderr: '', interrupted: false }),
  assistant('a4', 'r3', 8, 'm4', { type: 'text', text: '## Shipped\n\nThe export job now uses the **job queue**.\n\n- Retries: 5\n- Timeout: `30s`\n\n```ts\nqueue.add(job)\nqueue.run()\n```' }),
  said('u2', 'a4', 60, '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>', { origin: { kind: 'task-notification' }, promptSource: 'system' }),
  assistant('a5', 'u2', 62, 'm5', { type: 'text', text: 'The background build passed.' }),
  said('u3', 'a5', 120, RESTART_CONTINUE_TEXT, { promptSource: 'sdk' }),
  assistant('a6', 'u3', 122, 'm6', { type: 'text', text: 'Picked up again.' }),
  said('u4', 'a6', 180, 'Continue where you left off. Do not redo work that is already done.'),
  assistant('a7', 'u4', 182, 'm7', { type: 'text', text: 'Carrying on.' }),
  said('u5', 'a7', 240, `${GOAL_CONTINUATION_TAG}\nKeep working toward this goal: ship v2\n\nPick up where you left off.`),
  assistant('a8', 'u5', 242, 'm8', { type: 'text', text: 'Goal progress.' }),
  said('u6', 'a8', 300, 'Check CI until it is green'),
  assistant('a9', 'u6', 302, 'm9', { type: 'tool_use', id: 't9', name: 'ScheduleWakeup', input: { delaySeconds: 300, prompt: 'Check CI again', reason: 'waiting on CI' } }),
  toolResult('r9', 'a9', 303, 't9', 'Scheduled', null),
  assistant('a10', 'r9', 304, 'm10', { type: 'text', text: 'I will check again in 5 minutes.' }),
  said('u7', 'a10', 600, 'Check CI again'),
  assistant('a11', 'u7', 602, 'm11', { type: 'text', text: 'CI is green.' }),
  said('u8', 'a11', 660, 'Another Claude session sent a message:\n<message>Merged the fix.</message>'),
  assistant('a12', 'u8', 662, 'm12', { type: 'text', text: 'Thanks, noted.' }),
  said('u9', 'a12', 720, 'Run the slow suite'),
  assistant('a13', 'u9', 722, 'm13', { type: 'tool_use', id: 't13', name: 'Bash', input: { command: 'npm run slow' } }),
  said('int', 'a13', 730, '[Request interrupted by user for tool use]'),
  said('u10', 'int', 800, 'Deploy it to staging'),
  assistant('a14', 'u10', 802, 'm14', { type: 'tool_use', id: 't14', name: 'Bash', input: { command: 'cd /work/claude-app && npm run deploy:staging' } }),
]

/** thread/read as the Claude backend serves it; Claude Code's session registry says the last reply is still running. */
async function readClaudeFixture() {
  const configDir = await mkdtemp(join(tmpdir(), 'codexui-watch-claude-'))
  const projectDir = join(configDir, 'projects', '-work-claude-app')
  const sessionsDir = join(configDir, 'sessions')
  await mkdir(projectDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(join(projectDir, `${CLAUDE_SESSION}.jsonl`), CLAUDE_TRANSCRIPT.map((row) => JSON.stringify(row)).join('\n') + '\n')
  await writeFile(join(sessionsDir, `${String(process.pid)}.json`), JSON.stringify({
    pid: process.pid, sessionId: CLAUDE_SESSION, cwd: claudeCwd, kind: 'interactive', entrypoint: 'sdk-cli', status: 'busy', startedAt: Date.now(),
  }))
  const backend = new ClaudeBackend(join(configDir, 'threads.json'), { accountSwitcherPath: null, claudeConfigDir: configDir })
  try {
    const { thread } = await backend.rpc('thread/read', { threadId: CLAUDE_ID, includeTurns: true })
    // The listing time is the transcript's mtime; pin it for stable ordering.
    return { ...thread, name: 'Export job', updatedAt: S(2) }
  } finally {
    backend.dispose()
    await rm(configDir, { recursive: true, force: true })
  }
}

const claudeThread = await readClaudeFixture()

// --- Codex fixture: thread/read from the Codex app-server (v2 protocol) ----------------

const CODEX_ID = '019a3c51-7d2e-7a10-9c1b-5f0e8a6b2c41'
const command = (id, line, actions = [{ type: 'unknown', command: line }], status = 'completed') => ({
  type: 'commandExecution', id, command: `/bin/zsh -lc '${line}'`, cwd: '/work/hr-ai', processId: null, status,
  commandActions: actions, aggregatedOutput: 'output the watch never sees', exitCode: status === 'completed' ? 0 : null, durationMs: 900,
})
const fileChange = (id, path) => ({ type: 'fileChange', id, status: 'completed', changes: [{ path, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] })
const userMessage = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text, text_elements: [] }] })
const CODEX_FINAL = '## Fixed\n\nThe upload test waited on a timer; it now awaits the upload.\n\n1. Replaced the sleep\n2. Added a retry\n\n| Test | Before | After |\n|---|---|---|\n| upload | flaky | passes |\n| resume | passes | passes |'
const codexTurns = [
  {
    id: 'turn-1', status: 'completed', itemsView: 'full', error: null, startedAt: S(60), completedAt: S(60) + 1563, durationMs: 1_563_000,
    items: [
      userMessage('u1', 'Fix the flaky upload test'),
      { type: 'reasoning', id: 'r1', summary: ['**Reading the test**'], content: ['private chain of thought'] },
      { type: 'agentMessage', id: 'c1', text: 'I will run the upload tests first.', phase: 'commentary', memoryCitation: null, delivery: null, questions: null },
      command('cmd1', 'npm test -- upload'),
      command('cmd2', 'cat src/upload.test.ts', [{ type: 'read', command: 'cat src/upload.test.ts', name: 'upload.test.ts', path: '/work/hr-ai/src/upload.test.ts' }]),
      command('cmd3', 'rg -n sleep src', [{ type: 'search', command: 'rg -n sleep src', query: 'sleep', path: 'src' }]),
      fileChange('fc1', '/work/hr-ai/src/upload.test.ts'),
      fileChange('fc2', '/work/hr-ai/src/upload.ts'),
      command('cmd4', 'npm test -- upload'),
      command('cmd5', 'git status --short'),
      { type: 'agentMessage', id: 'f1', text: CODEX_FINAL, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null },
    ],
  },
  {
    id: 'turn-2', status: 'interrupted', itemsView: 'full', error: null, startedAt: S(20), completedAt: S(19), durationMs: 60_000,
    items: [userMessage('u2', 'Also update the docs'), command('cmd6', 'ls docs', [{ type: 'listFiles', command: 'ls docs', path: 'docs' }])],
  },
  {
    id: 'turn-3', status: 'failed', itemsView: 'full', startedAt: S(10), completedAt: S(9), durationMs: 45_000,
    error: { message: 'stream disconnected before completion: rate limit reached', codexErrorInfo: null, additionalDetails: null },
    items: [userMessage('u3', 'Try the docs again')],
  },
  {
    id: 'turn-4', status: 'inProgress', itemsView: 'full', error: null, startedAt: S(2), completedAt: null, durationMs: null,
    items: [userMessage('u4', 'Run the e2e suite'), command('cmd7', 'npm run test:e2e', undefined, 'inProgress')],
  },
]

function codexChat(id, name, cwd, minutesAgo, turns = [], extra = {}) {
  return { id, name, preview: `${name} preview`, modelProvider: 'openai', cwd, createdAt: S(minutesAgo + 60), updatedAt: S(minutesAgo), source: 'cli', status: { type: 'idle' }, turns, ...extra }
}

const QUESTION_PARAMS = {
  threadId: 'chat-question',
  turnId: 'turn-q',
  itemId: 'ask-1',
  questions: [
    { id: 'db', header: 'Database', question: 'Which database should I use?', isOther: true, isSecret: false, multiSelect: false,
      options: [{ label: 'Postgres (Recommended)', description: 'Managed and backed up' }, { label: 'SQLite', description: '' }] },
    { id: 'checks', header: 'Checks', question: 'Which checks should run?', isOther: true, isSecret: false, multiSelect: true,
      options: [{ label: 'Lint', description: '' }, { label: 'Types', description: '' }, { label: 'Unit', description: '' }] },
    { id: 'note', header: '', question: 'Anything else?', isOther: false, isSecret: false, multiSelect: false, options: [] },
  ],
}

// --- A fake bridge over an in-memory world ---------------------------------------------

function summaryOf(thread) {
  const { turns: _turns, ...summary } = thread
  return summary
}

function fakeWorld() {
  const world = {
    threads: new Map(),
    pending: [],
    running: [],
    background: [],
    pinned: [],
    history: [],
    dismissals: [],
    readState: { readAtByThreadId: {}, unreadThreadIds: [] },
    titles: {},
    roots: { order: [], labels: {} },
    boards: { boards: [], cards: [], agents: [], questions: [], comments: [], artifacts: [], runs: [] },
    boardChats: new Set(),
    /** Chats thread/list leaves out, such as ones older than its page. */
    unlisted: new Set(),
    sent: [], interrupted: [], responded: [], markedRead: [], historyRead: [], started: [],
    respond: null,
    add(thread) { world.threads.set(thread.id, thread); return world },
  }
  const find = (id) => {
    const thread = world.threads.get(id)
    if (!thread) throw new Error(`thread not found: ${id}`)
    return thread
  }
  const bridge = {
    listThreads: async () => [...world.threads.values()].filter((thread) => !world.unlisted.has(thread.id)).map(summaryOf),
    readThreadSummary: async (id) => summaryOf(find(id)),
    readThread: async (id) => structuredClone(find(id)),
    readTitles: async () => world.titles,
    readReadState: async () => world.readState,
    replyThreadIds: () => world.running,
    backgroundThreadIds: () => world.background,
    listPendingServerRequests: () => world.pending,
    readProjectBoards: async () => world.boards,
    readWorkspaceRoots: async () => world.roots,
    readPinnedThreadIds: async () => world.pinned,
    transcribe: async () => { throw new Error('no audio here') },
    sendMessage: async () => { throw new Error('the watch must send through the composer path') },
    startChat: async (input) => { world.started.push(input); return { threadId: 'new-chat-1' } },
    readVoiceSettings: async () => null,
    writeVoiceSettings: async () => {},
    isBoardManagedChat: async (id) => world.boardChats.has(id),
    sendComposerMessage: async (threadId, text, localPort) => { world.sent.push({ threadId, text, localPort }) },
    interruptTurn: async (threadId, turnId) => { world.interrupted.push({ threadId, turnId }) },
    respondToServerRequest: async (payload) => {
      if (world.respond) return world.respond(payload)
      world.responded.push(payload)
      world.pending = world.pending.filter((request) => request.id !== payload.id)
    },
    markThreadRead: async (threadId, readAtIso) => { world.markedRead.push({ threadId, readAtIso }) },
  }
  const push = {
    readHistory: async () => ({ items: world.history, dismissals: world.dismissals }),
    markHistoryRead: async (selection) => { world.historyRead.push(selection) },
  }
  return { world, bridge, push }
}

const historyItem = (threadId, status, body, minutesAgo, readAt = null) => ({
  id: `${threadId}:turn`, threadId, turnId: 'turn', status, title: threadId, body, completedAt: iso(minutesAgo), readAt,
})

/** The panel's chats: one per state, plus chats the watch must leave out. */
function panelWorld() {
  const { world, bridge, push } = fakeWorld()
  world
    .add(codexChat('chat-question', 'Pick a database', '/work/hr-ai', 5))
    .add(claudeThread)
    .add(codexChat('chat-unread', 'Upload retries', '/work/hr-ai', 10))
    .add(codexChat('chat-done', 'Release notes', '/work/booking', 15))
    .add(codexChat('chat-failed', 'Nightly export', '/work/booking', 20))
    .add(codexChat('chat-board', 'Board lead', '/work/hr-ai', 1))
    .add(codexChat('chat-helper', 'Helper', '/work/booking', 1, [], { source: { subAgent: { thread_spawn: { parent_thread_id: 'chat-done' } } } }))
    .add(codexChat('chat-pinned', 'Pinned plan', '/work/notes', 2 * 24 * 60))
    .add(codexChat('chat-worktree', 'Worktree chat', '/home/u/.codex/worktrees/abc/hr-ai', 3 * 24 * 60))
  for (let index = 1; index <= 12; index += 1) world.add(codexChat(`old-${String(index)}`, `Old chat ${String(index)}`, '/work/notes', 4 * 24 * 60 + index))
  world.pending = [{ id: 11, method: 'item/tool/requestUserInput', params: QUESTION_PARAMS, receivedAtIso: iso(4) }]
  world.running = [CLAUDE_ID]
  world.pinned = ['chat-pinned']
  world.readState = { readAtByThreadId: { 'chat-unread': iso(30) }, unreadThreadIds: [] }
  world.history = [
    historyItem('chat-unread', 'completed', 'Added the retry. All tests pass.', 10),
    historyItem('chat-done', 'completed', 'Wrote the release notes.', 15, iso(14)),
    historyItem('chat-failed', 'failed', 'Rate limit reached', 20, iso(19)),
  ]
  world.boards = { ...world.boards, boards: [{ id: 'b1', name: 'Board', planningThreadId: '' }], cards: [{ id: 'c1', boardId: 'b1', type: 'feature', title: 'Feature', threadId: 'chat-board', status: 'running' }] }
  world.boardChats.add('chat-board')
  world.roots = { order: ['/work/hr-ai'], labels: { '/work/booking': 'booking-platform' } }
  return { world, bridge, push }
}

async function startWatch(t, { world, bridge, push }, { env = { CODEXUI_WATCH_TOKEN: TOKEN }, now = () => NOW } = {}) {
  const logs = []
  const handler = routes.createWatchHandler({
    bridge,
    push,
    env: () => env,
    now,
    isDirectory: async (path) => path === '/work/fresh-folder',
    log: (line) => logs.push(line),
  })
  const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 418; res.end('next') }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${String(server.address().port)}/codex-api/voice/shortcut/watch/`
  const call = async (path, { method = path.startsWith('feed') || path.startsWith('chat') ? 'GET' : 'POST', token = TOKEN, body, headers = {} } = {}) => {
    const response = await fetch(path.startsWith('/') ? `http://127.0.0.1:${String(server.address().port)}${path}` : `${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, json, text, headers: response.headers }
  }
  return { call, logs, world }
}

// --- Auth --------------------------------------------------------------------------

test('the watch API is off (404) until CODEXUI_WATCH_TOKEN is set, and too short counts as unset', async (t) => {
  for (const env of [{}, { CODEXUI_WATCH_TOKEN: '   ' }, { CODEXUI_WATCH_TOKEN: 'short-token' }]) {
    const { call } = await startWatch(t, panelWorld(), { env })
    const response = await call('feed')
    assert.equal(response.status, 404)
    assert.deepEqual(response.json, { error: 'The watch API is not configured.' })
  }
})

test('every request needs the watch bearer token, loopback included', async (t) => {
  const { call } = await startWatch(t, panelWorld(), { env: { CODEXUI_WATCH_TOKEN: TOKEN, CODEXUI_VOICE_SHORTCUT_TOKEN: VOICE_TOKEN } })
  const missing = await call('feed', { token: '' })
  assert.equal(missing.status, 401, 'this test server listens on 127.0.0.1, so loopback gets no pass')
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer')
  assert.deepEqual(missing.json, { error: 'Not authorized.' })
  assert.equal((await call('feed', { token: `${TOKEN}x` })).status, 401, 'wrong token')
  assert.equal((await call('feed', { token: VOICE_TOKEN })).status, 401, "the voice Shortcut's token does not open the watch API")
  assert.equal((await call(`feed?token=${TOKEN}`, { token: '' })).status, 401, 'a token in the URL is not accepted')
  assert.equal((await call('feed', { token: '', headers: { Authorization: `Basic ${TOKEN}` } })).status, 401)
  assert.equal((await call('send', { token: '', body: { chatId: 'chat-done', text: 'hi' } })).status, 401, 'writes too')
  assert.equal((await call('anything', { method: 'GET' })).status, 404, 'unknown routes, once authorized')
  assert.equal((await call('feed')).status, 200)
  assert.equal((await call('/codex-api/voice/shortcut/command', { token: '' })).status, 418, 'other paths pass through to the next handler')
})

test('the watch token is kept from agent processes', () => {
  assert.ok(SENSITIVE_ENV_KEYS.includes('CODEXUI_WATCH_TOKEN'))
  const saved = process.env.CODEXUI_WATCH_TOKEN
  try {
    process.env.CODEXUI_WATCH_TOKEN = 'secret'
    assert.equal(getCodexUiChildEnv().CODEXUI_WATCH_TOKEN, undefined)
  } finally {
    if (saved === undefined) delete process.env.CODEXUI_WATCH_TOKEN
    else process.env.CODEXUI_WATCH_TOKEN = saved
  }
})

// --- Markdown to blocks ------------------------------------------------------------

test('Markdown becomes blocks: inline Markdown stays, code and tables collapse, images go', () => {
  const source = [
    '# Release notes',
    '',
    'Intro with **bold**, *italic*, `code` and [a link](https://example.com).',
    'Second line ![diagram](data:image/png;base64,AAAA) end.',
    '',
    '3. third',
    '4. fourth',
    '   - nested',
    '',
    '- one',
    '',
    '  more about one',
    '- two',
    '',
    '> quoted *text*',
    '> more',
    '',
    '```python',
    '',
    'def main():',
    '    pass',
    '```',
    '',
    '    indented code',
    '',
    '| Name | **Status** |',
    '|---|---|',
    '| api | ok |',
    '| web | down |',
    '',
    ':::writing',
    'Draft text',
    ':::',
  ].join('\n')
  assert.deepEqual(mapping.markdownToBlocks(source), [
    { type: 'h', text: 'Release notes' },
    { type: 'p', text: 'Intro with **bold**, *italic*, `code` and [a link](https://example.com).\nSecond line diagram end.' },
    { type: 'bullet', text: 'third', ordered: 3 },
    { type: 'bullet', text: 'fourth', ordered: 4 },
    { type: 'bullet', text: 'nested' },
    { type: 'bullet', text: 'one' },
    { type: 'p', text: 'more about one' },
    { type: 'bullet', text: 'two' },
    { type: 'quote', text: 'quoted *text*\nmore' },
    { type: 'code', lines: 3, language: 'python', preview: 'def main():' },
    { type: 'code', lines: 1, preview: 'indented code' },
    { type: 'table', rows: 2, preview: 'Name · Status' },
    { type: 'p', text: 'Draft text' },
  ])
  assert.deepEqual(mapping.markdownToBlocks(''), [])
  const long = mapping.markdownToBlocks(Array.from({ length: 70 }, (_, index) => `Paragraph ${String(index)}`).join('\n\n'))
  assert.equal(long.length, 61, 'a very long reply is cut for the watch')
  assert.deepEqual(long.at(-1), { type: 'p', text: '… The rest is in CodexUI.' })
})

// --- Turns the chat started itself ---------------------------------------------------

test('turns the chat started itself get a note instead of a user message', () => {
  const note = (text, prompts) => mapping.selfStartedNote(text, prompts && new Set(prompts))
  assert.equal(note('<task-notification>\n<task-id>x</task-id>\n</task-notification>'), 'Background task finished')
  assert.equal(note(RESTART_CONTINUE_TEXT), 'Continued after restart')
  assert.equal(note('Continue where you left off. Do not redo work that is already done.'), 'Continued after usage limit')
  assert.equal(note('<<autonomous-loop-dynamic>>'), 'Scheduled check')
  assert.equal(note('Check CI again', ['Check CI again']), 'Scheduled check', 'a ScheduleWakeup prompt coming back')
  assert.equal(note(`${GOAL_CONTINUATION_TAG}\nKeep working toward this goal: ship`), 'Goal step')
  assert.equal(note('Keep working toward this goal: ship v2'), 'Goal step')
  assert.equal(note('Continue working toward the goal'), 'Goal step')
  assert.equal(note('Another Claude session sent a message:\n<message>hi</message>'), 'Message from a helper')
  assert.equal(note('Check CI again'), null, 'the same words typed by the user are the user')
  assert.equal(note('Continue where you left off, please'), null)
  assert.equal(note(''), null)

  // A /loop: the user types the prompt, the turn schedules the same prompt, and the wakeup sends it back.
  const loopTurn = (id, withWakeup) => ({
    id,
    status: 'completed',
    items: [
      userMessage(`${id}-u`, '/loop check CI'),
      ...(withWakeup ? [{ type: 'mcpToolCall', id: `${id}-w`, server: 'check CI', tool: 'Schedule wakeup', arguments: { delaySeconds: 600, prompt: '/loop check CI' }, status: 'completed' }] : []),
    ],
  })
  assert.deepEqual(mapping.toWatchTurns([loopTurn('t1', true), loopTurn('t2', true), loopTurn('t3', false)]).map((turn) => [turn.user, turn.userNote]), [
    ['/loop check CI', null],
    [null, 'Scheduled check'],
    [null, 'Scheduled check'],
  ])
})

test("CodexUI's response-annotation wrapper shrinks to the user's own comment and request", () => {
  const comment = { text: 'use a queue', annotation: 'Use the existing job queue' }
  const read = (text) => mapping.readUserMessage(userMessage('u', text))
  assert.deepEqual(read(annotatedRequest([comment], 'Ship the export job', 'Codex')), {
    raw: annotatedRequest([comment], 'Ship the export job', 'Codex'),
    words: 'Use the existing job queue\n\nShip the export job',
  })
  assert.equal(read(annotatedRequest([comment], '', 'Codex')).words, 'Use the existing job queue', 'a comment without a request')
  assert.equal(read(annotatedRequest([{ text: 'use a queue' }], '', 'Codex')).words, '“use a queue”', 'only a selection')
  assert.equal(read('Plain request').words, 'Plain request')
})

// --- Steps --------------------------------------------------------------------------

test('steps count what the turn did, never what it output', () => {
  assert.equal(mapping.stepsSummary(codexTurns[0].items), 'Worked · 5 commands, 2 edits')
  assert.equal(mapping.stepsSummary(codexTurns[3].items, 'inProgress'), 'Working · 1 command')
  assert.equal(mapping.stepsSummary([userMessage('u', 'hi'), { type: 'agentMessage', id: 'a', text: 'Hello' }]), null)
  assert.equal(mapping.stepsSummary([
    { type: 'webSearch', id: 'w1', query: 'x' },
    { type: 'webSearch', id: 'w2', query: 'y' },
    { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'search' },
    { type: 'dynamicToolCall', id: 'd1', tool: 'automation_update' },
    { type: 'subAgentActivity', id: 's1', kind: 'started', agentThreadId: 'h1' },
    { type: 'subAgentActivity', id: 's2', kind: 'completed', agentThreadId: 'h1' },
  ]), 'Worked · 2 searches, 1 helper, 1 tool call')
})

test('the working line says the current step in plain words', () => {
  const line = (...items) => mapping.workingLine({ id: 't', status: 'inProgress', items })
  assert.equal(line(), 'Thinking')
  assert.equal(line(userMessage('u', 'go')), 'Thinking')
  assert.equal(line(command('c', 'npm run test:e2e', undefined, 'inProgress')), 'Running npm run test:e2e')
  assert.equal(line({ type: 'commandExecution', id: 'c', command: 'cd /x && FOO=1 node --test tests/watchApi.test.mjs | tail -5', commandActions: [] }), 'Running node --test watchApi.test.mjs')
  const running = (command) => line({ type: 'commandExecution', id: 'c', command, commandActions: [] })
  assert.equal(running('TOKEN=$(security find-generic-password -s "Application cloudflare-api-token" -w) && curl -s x'), 'Running security find-generic-password -s', 'a command inside $( ) shows, without its quotes or parentheses')
  assert.equal(running(`git commit -m "Fix the feed; keep 'quoted' words" --no-verify`), 'Running git commit -m', 'quoted text stays one word and never leaks its quotes')
  assert.equal(running(`/bin/zsh -lc 'echo "hello world"'`), 'Running echo hello world')
  assert.equal(line(codexTurns[0].items[4]), 'Reading upload.test.ts')
  assert.equal(line(codexTurns[0].items[5]), 'Searching for “sleep”')
  assert.equal(line(fileChange('f', '/work/hr-ai/src/upload.ts')), 'Editing upload.ts')
  assert.equal(line({ type: 'fileChange', id: 'f', status: 'inProgress', changes: [] }), 'Editing files')
  assert.equal(line({ type: 'mcpToolCall', id: 'm', server: 'src/server/watch/watchRoutes.ts', tool: 'Read file', status: 'inProgress' }), 'Reading watchRoutes.ts')
  assert.equal(line({ type: 'mcpToolCall', id: 'm', server: 'TODO in src', tool: 'Search files', status: 'inProgress' }), 'Searching files')
  assert.equal(line({ type: 'mcpToolCall', id: 'm', server: '2 of 5 done', tool: 'Update plan', status: 'inProgress' }), 'Updating plan')
  assert.equal(line({ type: 'mcpToolCall', id: 'm', server: 'cua repl', tool: 'js', status: 'inProgress' }), 'Using cua repl')
  assert.equal(line({ type: 'webSearch', id: 'w', query: 'swift charts', action: { type: 'search', query: 'swift charts' } }), 'Searching the web for “swift charts”')
  assert.equal(line({ type: 'webSearch', id: 'w', query: '', action: { type: 'openPage', url: 'https://www.example.com/a' } }), 'Reading example.com')
  assert.equal(line({ type: 'agentMessage', id: 'a', text: 'I found the bug. Now fixing it.', phase: 'commentary' }), 'I found the bug.')
  assert.equal(line({ type: 'reasoning', id: 'r', summary: ['secret plan'], content: [] }), 'Thinking', 'never the reasoning text')
  assert.equal(line({ type: 'subAgentActivity', id: 's', kind: 'started' }), 'Working with a helper')
})

// --- Feed and chat list ---------------------------------------------------------------

test('GET feed: the panel sections, each chat once, with state and one line', async (t) => {
  const { call } = await startWatch(t, panelWorld())
  const { status, json } = await call('feed')
  assert.equal(status, 200)
  assert.equal(json.generatedAt, new Date(NOW).toISOString())
  assert.deepEqual(json.sections.map((section) => [section.id, section.title]), [['needs_you', 'Needs you'], ['running', 'Running'], ['unread', 'Unread'], ['recent', 'Recent']])
  const [needsYou, running, unread, recent] = json.sections
  assert.deepEqual(needsYou.chats, [{
    id: 'chat-question', title: 'Pick a database', project: 'hr-ai', agent: 'codex', state: 'needsYou', unread: false, pinned: false,
    line: 'Which database should I use? (+2 more questions)', updatedAt: iso(5),
  }])
  assert.deepEqual(running.chats, [{
    id: CLAUDE_ID, title: 'Export job', project: 'claude-app', agent: 'claude', state: 'running', unread: false, pinned: false,
    line: 'Running npm run deploy:staging', updatedAt: iso(2),
  }])
  assert.deepEqual(unread.chats.map((row) => [row.id, row.state, row.unread, row.line]), [['chat-unread', 'done', true, 'Added the retry. All tests pass.']])
  assert.equal(recent.chats.length, 10, 'Recent holds at most 10 chats')
  assert.deepEqual(recent.chats.slice(0, 3).map((row) => [row.id, row.state, row.pinned, row.line]), [
    ['chat-pinned', 'idle', true, 'Pinned plan preview'],
    ['chat-done', 'done', false, 'Wrote the release notes.'],
    ['chat-failed', 'failed', false, 'Rate limit reached'],
  ])
  assert.equal(recent.chats[2].project, 'booking-platform', 'saved workspace labels name projects, as in the panel')
  const ids = json.sections.flatMap((section) => section.chats.map((row) => row.id))
  assert.equal(new Set(ids).size, ids.length, 'a chat appears in one section only')
  for (const hidden of ['chat-board', 'chat-helper']) assert.ok(!ids.includes(hidden), `${hidden} is left out, as in the panel`)
  assert.deepEqual(json.summary, { needsYou: 1, running: 1, unread: 1 })
})

test('GET feed lists empty sections too', async (t) => {
  const { world, bridge, push } = fakeWorld()
  world.add(codexChat('only', 'Only chat', '/work/a', 5))
  const { json } = await (await startWatch(t, { world, bridge, push })).call('feed')
  assert.deepEqual(json.sections.map((section) => [section.id, section.chats.length]), [['needs_you', 0], ['running', 0], ['unread', 0], ['recent', 1]])
  assert.deepEqual(json.summary, { needsYou: 0, running: 0, unread: 0 })
})

test('GET feed never waits long for a slow running chat, and shows its working line from memory', async (t) => {
  const setup = panelWorld()
  const read = setup.bridge.readThread
  let reads = 0
  let release
  const slowRead = new Promise((resolve) => { release = resolve })
  setup.bridge.readThread = async (id) => {
    reads += 1
    if (id === CLAUDE_ID) await slowRead
    return read(id)
  }
  let clock = NOW
  const { call } = await startWatch(t, setup, { now: () => clock })
  const workingLine = (json) => json.sections.find((section) => section.id === 'running').chats[0].line

  const first = await call('feed')
  assert.notEqual(workingLine(first.json), 'Running npm run deploy:staging', 'a slow first read does not hold the list')
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = await call('feed')
  assert.equal(workingLine(second.json), 'Running npm run deploy:staging', 'the line read in the background shows on the next request')

  const readsBefore = reads
  clock += 5_000
  const third = await call('feed')
  assert.equal(workingLine(third.json), 'Running npm run deploy:staging', 'a stale line still shows at once')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(reads, readsBefore + 1, 'and is refreshed in the background')
})

test('GET chats never waits long for a slow pinned chat, and shows it from memory next time', async (t) => {
  const setup = panelWorld()
  setup.world.unlisted.add('chat-pinned')
  const summary = setup.bridge.readThreadSummary
  let release
  const slowRead = new Promise((resolve) => { release = resolve })
  setup.bridge.readThreadSummary = async (id) => {
    if (id === 'chat-pinned') await slowRead
    return summary(id)
  }
  const { call } = await startWatch(t, setup)
  const first = await call('chats')
  assert.deepEqual(first.json.pinned.map((row) => row.id), [], 'a slow pinned read does not hold the list')
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = await call('chats')
  assert.deepEqual(second.json.pinned.map((row) => row.id), ['chat-pinned'], 'it shows from memory on the next request')
})

test('GET ping answers ok with the token and checks it like every route', async (t) => {
  const { call } = await startWatch(t, panelWorld())
  const ok = await call('ping', { method: 'GET' })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { ok: true })
  assert.equal((await call('ping', { method: 'GET', token: 'x'.repeat(40) })).status, 401)
})

test('GET chat: a chat outside the listed page still has its own updated time', async (t) => {
  const setup = panelWorld()
  setup.world.unlisted.add('chat-pinned')
  const { json } = await (await startWatch(t, setup)).call('chat?id=chat-pinned')
  assert.equal(json.chat.updatedAt, iso(2 * 24 * 60), 'not an empty string the watch cannot read')
})

test('GET chats: pinned first, then projects newest first, at most 25 chats each', async (t) => {
  const setup = panelWorld()
  setup.world.unlisted.add('chat-pinned')
  for (let index = 1; index <= 30; index += 1) setup.world.add(codexChat(`bulk-${String(index)}`, `Bulk ${String(index)}`, '/work/bulk', 6 * 24 * 60 + index))
  const { json } = await (await startWatch(t, setup)).call('chats')
  assert.deepEqual(json.pinned.map((row) => row.id), ['chat-pinned'], 'a pinned chat outside the listed page is read, as the panel does')
  assert.deepEqual(json.projects.map((project) => [project.name, project.cwd]), [
    ['claude-app', claudeCwd],
    ['hr-ai', '/work/hr-ai'],
    ['booking-platform', '/work/booking'],
    ['notes', '/work/notes'],
    ['bulk', '/work/bulk'],
  ])
  const hrAi = json.projects[1]
  assert.deepEqual(hrAi.chats.map((row) => row.id), ['chat-question', 'chat-unread', 'chat-worktree'], 'newest first; a worktree chat sits with its project')
  assert.equal(json.projects[3].chats.some((row) => row.id === 'chat-pinned'), false, 'pinned chats show only under Pinned')
  assert.equal(json.projects.at(-1).chats.length, 25)
  assert.equal(json.projects[0].chats[0].line, 'Running npm run deploy:staging')
})

// --- One chat ---------------------------------------------------------------------

test('GET chat: a Claude chat read through the Claude backend, with notes, steps and the working line', async (t) => {
  const { world, bridge, push } = fakeWorld()
  world.add(claudeThread)
  world.running = [CLAUDE_ID]
  const { call } = await startWatch(t, { world, bridge, push })

  const latest = (await call(`chat?id=${CLAUDE_ID}`)).json
  assert.deepEqual(latest.turns.map((turn) => turn.id), ['u7', 'u8', 'u9', 'u10'], 'the last 4 turns, oldest first')
  assert.equal(latest.hasEarlier, true)
  assert.deepEqual(latest.chat, {
    id: CLAUDE_ID, title: 'Export job', project: 'claude-app', agent: 'claude', state: 'running', unread: false, pinned: false,
    line: 'Running npm run deploy:staging', updatedAt: iso(2),
  })
  assert.deepEqual(latest.working, { line: 'Running npm run deploy:staging', since: at(800) })
  assert.equal(latest.backgroundTasks, 0)
  assert.equal(latest.question, null)
  assert.deepEqual(latest.turns[0], {
    id: 'u7', status: 'completed', user: null, userNote: 'Scheduled check', reply: [{ type: 'p', text: 'CI is green.' }], steps: null, workedFor: '2s', error: null,
  })
  assert.deepEqual(latest.turns.slice(1).map((turn) => [turn.status, turn.user, turn.userNote]), [
    ['completed', null, 'Message from a helper'],
    ['interrupted', 'Run the slow suite', null],
    ['inProgress', 'Deploy it to staging', null],
  ])
  assert.equal(latest.turns[2].workedFor, '10s')
  assert.equal(latest.turns[3].workedFor, null)

  const everything = (await call(`chat?id=${CLAUDE_ID}&limit=20`)).json
  assert.equal(everything.hasEarlier, false)
  assert.deepEqual(everything.turns.map((turn) => turn.userNote), [
    null, 'Background task finished', 'Continued after restart', 'Continued after usage limit', 'Goal step',
    null, 'Scheduled check', 'Message from a helper', null, null,
  ])
  assert.deepEqual(everything.turns[0], {
    id: 'u1',
    status: 'completed',
    user: 'Use the existing job queue\n\nShip the export job',
    userNote: null,
    reply: [
      { type: 'h', text: 'Shipped' },
      { type: 'p', text: 'The export job now uses the **job queue**.' },
      { type: 'bullet', text: 'Retries: 5' },
      { type: 'bullet', text: 'Timeout: `30s`' },
      { type: 'code', lines: 2, language: 'ts', preview: 'queue.add(job)' },
    ],
    steps: 'Worked · 2 commands, 1 edit',
    workedFor: '8s',
    error: null,
  })
  assert.equal(everything.turns[5].steps, 'Worked · 1 tool call', 'the ScheduleWakeup call')

  const page = (await call(`chat?id=${CLAUDE_ID}&before=u7&limit=3`)).json
  assert.deepEqual(page.turns.map((turn) => turn.id), ['u4', 'u5', 'u6'])
  assert.equal(page.hasEarlier, true)
  const wakeup = (await call(`chat?id=${CLAUDE_ID}&before=u8&limit=1`)).json
  assert.deepEqual(wakeup.turns.map((turn) => [turn.id, turn.userNote]), [['u7', 'Scheduled check']], 'earlier pages still count the ScheduleWakeup prompt')
  const first = (await call(`chat?id=${CLAUDE_ID}&before=u2`)).json
  assert.deepEqual(first.turns.map((turn) => turn.id), ['u1'])
  assert.equal(first.hasEarlier, false)

  assert.equal((await call(`chat?id=${CLAUDE_ID}&before=nope`)).status, 404)
  assert.equal((await call('chat?id=claude-unknown')).status, 404)
  assert.deepEqual((await call('chat?id=claude-unknown')).json, { error: 'Unknown chat.' })
  assert.equal((await call('chat')).status, 400)
  assert.equal((await call(`chat?id=${CLAUDE_ID}&limit=two`)).status, 400)
})

test('GET chat: a Codex chat keeps the final answer, counts steps and drops reasoning and output', async (t) => {
  const { world, bridge, push } = fakeWorld()
  world.add(codexChat(CODEX_ID, 'Flaky upload test', '/work/hr-ai', 1, codexTurns, { status: { type: 'active', activeFlags: [] } }))
  world.running = [CODEX_ID]
  const { json } = await (await startWatch(t, { world, bridge, push })).call(`chat?id=${CODEX_ID}`)
  assert.equal(json.hasEarlier, false)
  assert.deepEqual(json.turns[0], {
    id: 'turn-1',
    status: 'completed',
    user: 'Fix the flaky upload test',
    userNote: null,
    reply: [
      { type: 'h', text: 'Fixed' },
      { type: 'p', text: 'The upload test waited on a timer; it now awaits the upload.' },
      { type: 'bullet', text: 'Replaced the sleep', ordered: 1 },
      { type: 'bullet', text: 'Added a retry', ordered: 2 },
      { type: 'table', rows: 2, preview: 'Test · Before · After' },
    ],
    steps: 'Worked · 5 commands, 2 edits',
    workedFor: '26m 3s',
    error: null,
  })
  assert.deepEqual(json.turns.slice(1).map((turn) => [turn.id, turn.status, turn.user, turn.reply.length, turn.steps, turn.workedFor, turn.error]), [
    ['turn-2', 'interrupted', 'Also update the docs', 0, 'Worked · 1 command', '1m 0s', null],
    ['turn-3', 'failed', 'Try the docs again', 0, null, '45s', 'stream disconnected before completion: rate limit reached'],
    ['turn-4', 'inProgress', 'Run the e2e suite', 0, 'Working · 1 command', null, null],
  ])
  assert.deepEqual(json.working, { line: 'Running npm run test:e2e', since: iso(2) })
  assert.equal(json.chat.state, 'running')
  const text = JSON.stringify(json)
  for (const secret of ['private chain of thought', 'Reading the test', 'output the watch never sees', '@@ -1 +1 @@']) {
    assert.ok(!text.includes(secret), `the payload leaves out ${secret}`)
  }
})

test('GET chat: the chat state comes from its own last turn', async (t) => {
  const { world, bridge, push } = fakeWorld()
  world
    .add(codexChat('done', 'Done chat', '/work/a', 5, codexTurns.slice(0, 1)))
    .add(codexChat('stopped', 'Stopped chat', '/work/a', 5, codexTurns.slice(0, 2)))
    .add(codexChat('failed', 'Failed chat', '/work/a', 5, codexTurns.slice(0, 3)))
    .add(codexChat('idle', 'New chat', '/work/a', 5, []))
    .add(codexChat('chat-question', 'Question chat', '/work/a', 5, codexTurns.slice(0, 1)))
    .add(codexChat('background', 'Background chat', '/work/a', 5, codexTurns.slice(0, 1), { backgroundTasks: [{ id: 'b1' }, { id: 'b2' }] }))
  world.pending = [
    { id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'chat-question', title: 'Run migrations' } },
    { id: 11, method: 'item/tool/requestUserInput', params: QUESTION_PARAMS, receivedAtIso: iso(1) },
  ]
  const { call } = await startWatch(t, { world, bridge, push })
  const read = async (id) => (await call(`chat?id=${id}`)).json
  const states = {}
  for (const id of ['done', 'stopped', 'failed', 'idle', 'chat-question', 'background']) {
    const { chat } = await read(id)
    states[id] = [chat.state, chat.line]
  }
  assert.deepEqual(states, {
    done: ['done', 'Fixed The upload test waited on a timer; it now awaits the upload. Replaced the sleep Added a retry Test Before After upload flaky passes resume passes passes'],
    stopped: ['stopped', 'Stopped'],
    failed: ['failed', 'stream disconnected before completion: rate limit reached'],
    idle: ['idle', 'New chat preview'],
    'chat-question': ['needsYou', 'Run migrations'],
    background: ['running', '2 background tasks are running'],
  })
  const asked = await read('chat-question')
  assert.deepEqual(asked.question, {
    requestId: 11,
    questions: [
      { id: 'db', header: 'Database', text: 'Which database should I use?', multiSelect: false, allowOther: true,
        options: [{ label: 'Postgres (Recommended)', description: 'Managed and backed up' }, { label: 'SQLite', description: null }] },
      { id: 'checks', header: 'Checks', text: 'Which checks should run?', multiSelect: true, allowOther: true,
        options: [{ label: 'Lint', description: null }, { label: 'Types', description: null }, { label: 'Unit', description: null }] },
      { id: 'note', header: null, text: 'Anything else?', multiSelect: false, allowOther: true, options: [] },
    ],
  })
  assert.equal((await read('background')).backgroundTasks, 2)
})

// --- Actions ----------------------------------------------------------------------

test('POST send steers a running reply through the composer path and plainly sends otherwise', async (t) => {
  const setup = panelWorld()
  const { call, world } = await startWatch(t, setup)
  const steered = await call('send', { body: { chatId: CLAUDE_ID, text: '  Use the blue-green deploy  ' } })
  assert.deepEqual(steered.json, { ok: true, mode: 'steered' })
  const sent = await call('send', { body: { chatId: 'chat-done', text: 'Thanks' } })
  assert.deepEqual(sent.json, { ok: true, mode: 'sent' })
  assert.deepEqual(world.sent.map(({ threadId, text }) => [threadId, text]), [[CLAUDE_ID, 'Use the blue-green deploy'], ['chat-done', 'Thanks']])
  assert.ok(world.sent.every((entry) => Number.isInteger(entry.localPort)), 'the local port goes along for the board-planning context, as from the composer')

  const board = await call('send', { body: { chatId: 'chat-board', text: 'hi' } })
  assert.equal(board.status, 409, 'project boards drive their Lead chats, as the composer route refuses')
  assert.equal((await call('send', { body: { chatId: 'missing', text: 'hi' } })).status, 404)
  assert.equal((await call('send', { body: { chatId: 'chat-done', text: '   ' } })).status, 400)
  assert.equal((await call('send', { body: { chatId: 'chat-done' } })).status, 400)
  assert.equal((await call('send', { body: { chatId: 'chat-done', text: 'x'.repeat(20_001) } })).status, 413)
  assert.equal(world.sent.length, 2)

  setup.bridge.sendComposerMessage = async () => { throw new Error('Claude is signed out. Sign in to Claude before starting a Claude turn.') }
  const failed = await call('send', { body: { chatId: 'chat-done', text: 'hi' } })
  assert.deepEqual([failed.status, failed.json], [502, { error: 'Claude is signed out. Sign in to Claude before starting a Claude turn.' }], "the agent's own words")
})

test('POST stop interrupts the running turn, and says idle when nothing runs', async (t) => {
  const { world, bridge, push } = fakeWorld()
  world.add(codexChat(CODEX_ID, 'Flaky upload test', '/work/hr-ai', 1, codexTurns)).add(codexChat('idle', 'Idle', '/work/a', 5, codexTurns.slice(0, 1)))
  const { call } = await startWatch(t, { world, bridge, push })
  assert.deepEqual((await call('stop', { body: { chatId: CODEX_ID } })).json, { ok: true })
  assert.deepEqual(world.interrupted, [{ threadId: CODEX_ID, turnId: 'turn-4' }])
  assert.deepEqual((await call('stop', { body: { chatId: 'idle' } })).json, { ok: true, idle: true })
  assert.equal(world.interrupted.length, 1)
  assert.equal((await call('stop', { body: { chatId: 'missing' } })).status, 404)
})

test("POST answer replies exactly as the web app's question card does", async (t) => {
  const setup = panelWorld()
  const { call, world } = await startWatch(t, setup)
  const answers = { db: ['Postgres'], checks: ['Unit', 'Lint', 'Run the e2e suite too'], note: ['Ship after lunch'] }
  const response = await call('answer', { body: { chatId: 'chat-question', requestId: 11, answers } })
  assert.deepEqual(response.json, { ok: true })

  // What RequestUserInputCard emits for the same picks, with the card's own functions.
  const questions = readRequestQuestions(QUESTION_PARAMS)
  const drafts = {
    db: { choice: 0, text: '' },
    checks: { choice: null, choices: [2, 0, -1], text: 'Run the e2e suite too' },
    note: { choice: null, text: 'Ship after lunch' },
  }
  const card = {
    id: 11,
    result: { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: requestQuestionAnswerValues(question, drafts[question.id]) }])) },
  }
  assert.deepEqual(world.responded, [card])
  assert.deepEqual(card.result.answers, {
    db: { answers: ['Postgres (Recommended)'] },
    checks: { answers: ['Lint', 'Unit', 'Run the e2e suite too'] },
    note: { answers: ['Ship after lunch'] },
  })
})

test('POST answer: 409 once the question is no longer open, 400 for answers that do not fit', async (t) => {
  const setup = panelWorld()
  const { call, world } = await startWatch(t, setup)
  const good = { db: ['SQLite'], checks: ['Types'], note: ['No'] }
  assert.equal((await call('answer', { body: { chatId: 'chat-done', requestId: 11, answers: good } })).status, 409, "another chat's request")
  assert.equal((await call('answer', { body: { chatId: 'chat-question', requestId: 99, answers: good } })).status, 409, 'an unknown request')

  const unfit = await call('answer', { body: { chatId: 'chat-question', requestId: 11, answers: { ...good, db: ['SQLite', 'Postgres'] } } })
  assert.deepEqual([unfit.status, unfit.json], [400, { error: 'Choose from the options for “Which database should I use?”.' }])
  const missing = await call('answer', { body: { chatId: 'chat-question', requestId: 11, answers: { db: ['SQLite'], checks: ['Types'] } } })
  assert.deepEqual([missing.status, missing.json], [400, { error: 'Answer “Anything else?”.' }])
  assert.equal((await call('answer', { body: { chatId: 'chat-question', requestId: '11', answers: good } })).status, 400)
  assert.equal(world.responded.length, 0)

  // Answered on the phone while the watch's reply was on its way.
  world.respond = async () => {
    world.pending = []
    throw new Error('This Claude question is no longer waiting for an answer.')
  }
  const raced = await call('answer', { body: { chatId: 'chat-question', requestId: 11, answers: good } })
  assert.deepEqual([raced.status, raced.json], [409, { error: 'That question is no longer waiting for an answer.' }])
  assert.equal((await call('answer', { body: { chatId: 'chat-question', requestId: 11, answers: good } })).status, 409)
})

test('POST read marks the chat read as opening it from the panel does', async (t) => {
  const { call, world } = await startWatch(t, panelWorld())
  assert.deepEqual((await call('read', { body: { chatId: 'chat-unread' } })).json, { ok: true })
  assert.deepEqual(world.markedRead, [{ threadId: 'chat-unread', readAtIso: iso(10) }], 'read up to the chat\'s last activity')
  assert.deepEqual(world.historyRead, [{ threadId: 'chat-unread' }], 'and its push alerts')
  assert.equal((await call('read', { body: { chatId: 'missing' } })).status, 404)
})

test('POST new starts a chat in a project by name or folder with the agent asked for', async (t) => {
  const { call, world } = await startWatch(t, panelWorld())
  assert.deepEqual((await call('new', { body: { project: 'booking-platform', agent: 'claude', text: 'Plan the sale' } })).json, { ok: true, chatId: 'new-chat-1' })
  await call('new', { body: { project: '/work/hr-ai/', agent: 'codex', text: 'Fix the build' } })
  await call('new', { body: { project: 'HR-AI', agent: 'codex', text: 'Any case' } })
  await call('new', { body: { project: '/work/fresh-folder', agent: 'claude', text: 'Start here' } })
  assert.deepEqual(world.started, [
    { cwd: '/work/booking', agent: 'claude', message: 'Plan the sale' },
    { cwd: '/work/hr-ai', agent: 'codex', message: 'Fix the build' },
    { cwd: '/work/hr-ai', agent: 'codex', message: 'Any case' },
    { cwd: '/work/fresh-folder', agent: 'claude', message: 'Start here' },
  ])
  assert.equal((await call('new', { body: { project: 'nowhere', agent: 'codex', text: 'x' } })).status, 400)
  assert.equal((await call('new', { body: { project: '/work/missing-folder', agent: 'codex', text: 'x' } })).status, 400)
  assert.equal((await call('new', { body: { project: 'hr-ai', agent: 'gemini', text: 'x' } })).status, 400)
  assert.equal((await call('new', { body: { project: 'hr-ai', agent: 'codex', text: '' } })).status, 400)
  assert.equal(world.started.length, 4)
})

test('bodies must be JSON objects within the size limit', async (t) => {
  const { call } = await startWatch(t, panelWorld())
  assert.equal((await call('send', { headers: { 'Content-Type': 'application/json' } })).status, 400, 'no body')
  assert.equal((await call('send', { body: ['chat-done', 'hi'] })).status, 400)
  assert.equal((await call('send', { body: { chatId: 'chat-done', text: 'x'.repeat(70_000) } })).status, 413)
})
