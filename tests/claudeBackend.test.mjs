import assert from 'node:assert/strict'
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

// Inside the checkout, so external packages resolve from its node_modules.
const cacheDir = new URL('../node_modules/.cache/', import.meta.url).pathname
await mkdir(cacheDir, { recursive: true })
const bundleDir = await mkdtemp(join(cacheDir, 'codexui-claude-test-'))
test.after(() => rm(bundleDir, { recursive: true, force: true }))

/** Bundle a TypeScript module and its relative imports for Node's test runner. */
async function loadModule(relativePath) {
  const outfile = join(bundleDir, `${relativePath.replace(/[^a-z0-9]/giu, '_')}.mjs`)
  await build({
    entryPoints: [new URL(relativePath, import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: ['@anthropic-ai/claude-agent-sdk', 'zod'],
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

const { ClaudeBackend, findTranscriptSnippet, isClaudeModelId, normalizeClaudeUsage, readTranscriptRange, runtimeModel } = await loadModule('../src/server/claudeBackend.ts')
const { BackendRouter } = await loadModule('../src/server/backendRouter.ts')
const transcript = await loadModule('../src/server/claudeTranscript.ts')
const { startClaudeProcessHost, spawnThroughHost } = await loadModule('../src/server/claudeProcessHost.ts')
const { scanClaudeSessionRegistry } = await loadModule('../src/server/claudeSessionRegistry.ts')
const { withTurnMetadata, parseTurnFile, turnEndedRequest, isRelayResponse } = await loadModule('../src/server/cuaRelay.ts')
const cuaRelayBundle = join(bundleDir, `${'../src/server/cuaRelay.ts'.replace(/[^a-z0-9]/giu, '_')}.mjs`)
const { buildReviewChanges } = await loadModule('../src/utils/reviewDiff.ts')
const { createClaudeAutomationTool } = await loadModule('../src/server/claudeAutomationTool.ts')

function createBackends(rpc, claudeOverrides = {}) {
  const codex = {
    rpc,
    onNotification: () => () => {},
    respondToServerRequest: async () => {},
    listPendingServerRequests: () => [],
    publishLocalNotification: () => {},
    reserveReviewMutation: () => () => {},
    dispose: () => {},
  }
  const claude = {
    rpc: async () => ({}),
    onNotification: () => () => {},
    listThreads: async () => [],
    listModels: async () => [],
    searchThreads: async () => [],
    listSkills: async () => ({ data: [] }),
    listPendingServerRequests: () => [],
    ownsServerRequest: () => false,
    respondToServerRequest: async () => {},
    dispose: () => {},
    ...claudeOverrides,
  }
  return { codex, claude }
}

// ── Transcript fixture (shape recorded from Claude Code 2.1.283) ──────────

const cwd = '/work/project'
const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 0, 0, seconds)).toISOString()
const entry = (uuid, parentUuid, fields) => ({ uuid, parentUuid, isSidechain: false, cwd, sessionId: 's1', timestamp: at(0), ...fields })
const assistant = (uuid, parentUuid, seconds, messageId, block) => entry(uuid, parentUuid, {
  type: 'assistant',
  timestamp: at(seconds),
  message: {
    id: messageId,
    model: 'claude-opus-5-5',
    role: 'assistant',
    content: [block],
    usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 20 },
  },
})
const toolResult = (uuid, parentUuid, seconds, toolUseId, content, toolUseResult, isError = false) => entry(uuid, parentUuid, {
  type: 'user',
  timestamp: at(seconds),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
  toolUseResult,
})

const fixture = [
  { type: 'queue-operation', operation: 'enqueue' },
  entry('u1', null, { type: 'user', timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: 'Create notes.txt then edit it' }] } }),
  entry('att-env', 'u1', { type: 'attachment', attachment: { type: 'environment' } }),
  assistant('a1', 'att-env', 2, 'msg_1', { type: 'thinking', thinking: 'Plan the work' }),
  assistant('a2', 'a1', 2, 'msg_1', { type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: `${cwd}/notes.txt`, content: 'alpha\n' } }),
  toolResult('r1', 'a2', 3, 'toolu_write', 'File created successfully', { type: 'create', filePath: `${cwd}/notes.txt`, content: 'alpha\n', structuredPatch: [], originalFile: null }),
  entry('steer', 'r1', { type: 'attachment', timestamp: at(4), attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'Also say kiwi' }], source_uuid: 'steer-src', commandMode: 'prompt' } }),
  assistant('a3', 'steer', 5, 'msg_2', { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: `${cwd}/notes.txt`, old_string: 'alpha', new_string: 'beta' } }),
  toolResult('r2', 'a3', 6, 'toolu_edit', 'The file has been updated', {
    filePath: `${cwd}/notes.txt`, oldString: 'alpha', newString: 'beta', originalFile: 'alpha\n',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-alpha', '+beta'] }],
  }),
  assistant('a4', 'r2', 7, 'msg_3', { type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: { command: 'cat notes.txt' } }),
  toolResult('r3', 'a4', 8, 'toolu_ok', 'beta', { stdout: 'beta', stderr: '', interrupted: false }),
  assistant('a5', 'r3', 9, 'msg_3', { type: 'tool_use', id: 'toolu_fail', name: 'Bash', input: { command: 'exit 3' } }),
  toolResult('r4', 'a5', 10, 'toolu_fail', 'Exit code 3', 'Error: Exit code 3', true),
  assistant('a6', 'r4', 11, 'msg_4', { type: 'text', text: 'Done. Kiwi.' }),
  entry('sys', 'a6', { type: 'system', subtype: 'stop_hook_summary', timestamp: at(12) }),
  entry('u2', 'sys', { type: 'user', timestamp: at(20), message: { role: 'user', content: 'Run a long command' } }),
  assistant('a7', 'u2', 21, 'msg_5', { type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'sleep 60' } }),
  entry('int', 'a7', { type: 'user', timestamp: at(30), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
  { type: 'custom-title', customTitle: 'Notes work', sessionId: 's1' },
]

test('maps a Claude transcript onto Codex turns and items', () => {
  const chain = transcript.resolveMainChain(fixture)
  const summary = transcript.buildTurnsFromChain(chain, cwd)
  assert.equal(summary.turns.length, 2)

  const [first, second] = summary.turns
  assert.equal(first.id, 'u1')
  assert.equal(first.status, 'completed')
  assert.equal(first.durationMs, 12_000)
  assert.deepEqual(first.items.map((item) => item.type), [
    'userMessage', 'reasoning', 'fileChange', 'userMessage', 'fileChange', 'commandExecution', 'commandExecution', 'agentMessage',
  ])
  assert.deepEqual(first.items[3].content, [{ type: 'text', text: 'Also say kiwi' }])
  assert.deepEqual(first.items[2].changes, [{ path: `${cwd}/notes.txt`, kind: { type: 'add' }, diff: 'alpha\n' }])
  assert.deepEqual(first.items[4].changes, [{
    path: `${cwd}/notes.txt`,
    kind: { type: 'update', move_path: null },
    diff: '@@ -1,1 +1,1 @@\n-alpha\n+beta\n',
  }])
  assert.equal(first.items[5].status, 'completed')
  assert.equal(first.items[5].exitCode, 0)
  assert.equal(first.items[5].aggregatedOutput, 'beta')
  assert.equal(first.items[6].status, 'failed')
  assert.equal(first.items[6].exitCode, 3)
  assert.equal(first.items[7].id, 'msg_4:text:0')
  assert.equal(first.items[7].phase, 'final_answer')

  assert.equal(second.status, 'interrupted')
  assert.equal(second.items[1].type, 'commandExecution')
  assert.equal(second.items[1].status, 'interrupted')
  assert.deepEqual(summary.lastUsage, { inputTokens: 1100, cachedInputTokens: 1000, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 1120 })
})

test('keeps a running reply in progress and leaves its tools pending', () => {
  const chain = transcript.resolveMainChain(fixture.slice(0, -2))
  const summary = transcript.buildTurnsFromChain(chain, cwd, { liveTurnId: 'u2' })
  const live = summary.turns.at(-1)
  assert.equal(live.status, 'inProgress')
  assert.equal(live.items[1].status, 'inProgress')
})

test('builds a review card whose edits can be undone safely', () => {
  const chain = transcript.resolveMainChain(fixture)
  const [first] = transcript.buildTurnsFromChain(chain, cwd).turns
  const updateOnly = first.items.filter((item) => item.id !== 'toolu_write')
  const review = buildReviewChanges(updateOnly, cwd, cwd, { strict: true })
  assert.equal(review.fileCount, 1)
  assert.equal(review.additions, 1)
  assert.equal(review.deletions, 1)
  assert.match(review.patchBatches[0].patch, /--- a\/notes\.txt\n\+\+\+ b\/notes\.txt\n@@ -1,1 \+1,1 @@\n-alpha\n\+beta/u)
})

test('follows the newest branch after a rewind and resumes rollbacks at the kept turn', () => {
  const rewound = [
    ...fixture,
    entry('u3', 'sys', { type: 'user', timestamp: at(40), message: { role: 'user', content: 'Different follow-up' } }),
    assistant('a8', 'u3', 41, 'msg_6', { type: 'text', text: 'Sure.' }),
  ]
  const chain = transcript.resolveMainChain(rewound)
  const turns = transcript.buildTurnsFromChain(chain, cwd).turns
  assert.deepEqual(turns.map((turn) => turn.id), ['u1', 'u3'])
  assert.deepEqual(transcript.rewindPointForRollback(chain, turns, 1), { resumeAt: 'sys' })
  assert.equal(transcript.rewindPointForRollback(chain, turns, 2), null)
  assert.deepEqual(transcript.truncateChain(chain, 'sys').at(-1).uuid, 'sys')
})

test('shows slash commands as typed and keeps the composer marker first', () => {
  assert.equal(transcript.normalizeCommandText('<command-name>/compact</command-name><command-args></command-args>'), '/compact')
  assert.equal(
    transcript.normalizeCommandText('<command-name>/review</command-name><command-args># Files\n\n## My request for Claude:\n\nCheck this</command-args>'),
    '# Files\n\n## My request for Claude:\n\n/review Check this',
  )
  assert.equal(transcript.normalizeCommandText('<local-command-stdout>ok</local-command-stdout>'), null)
})

test('maps Claude tools onto the closest Codex item', () => {
  const item = (name, input, outcome = null) => transcript.toolUseItem({ id: 't', name, input }, cwd, outcome)
  assert.equal(item('Read', { file_path: `${cwd}/src/a.ts` }).server, 'src/a.ts')
  assert.equal(item('Read', { file_path: `${cwd}/src/a.ts` }).tool, 'Read file')
  assert.deepEqual(item('WebFetch', { url: 'https://example.com' }).action, { type: 'openPage', url: 'https://example.com' })
  assert.equal(item('WebSearch', { query: 'vue 3' }).type, 'webSearch')
  assert.equal(item('Task', { subagent_type: 'Explore', description: 'Find tests' }).type, 'subAgentActivity')
  assert.equal(item('Task', { subagent_type: 'Explore' }, { text: 'done', isError: false, structured: null }).kind, 'completed')
  const mcp = item('mcp__playwright__browser_navigate', { url: 'https://example.com' }, { text: 'boom', isError: true, structured: null })
  assert.equal(mcp.server, 'playwright')
  assert.equal(mcp.tool, 'browser_navigate')
  assert.deepEqual(mcp.error, { message: 'boom' })
  assert.equal(item('ExitPlanMode', { plan: '1. Do it' }).type, 'plan')
  const waiting = item('AskUserQuestion', { questions: [{ question: 'Ship it?', header: 'Ship', options: [] }] })
  assert.deepEqual(waiting, { type: 'askedQuestions', id: 't', status: 'inProgress', questions: [{ header: 'Ship', question: 'Ship it?', answer: '' }] })
})

test('drops thinking and unused copies when reading a transcript, keeping what the chat shows and counts', () => {
  const entry = transcript.parseTranscriptLine(JSON.stringify({
    type: 'assistant', uuid: 'a1', parentUuid: null, timestamp: at(1), cwd, requestId: 'req_1',
    wireToolInputs: { toolu_1: { command: 'x'.repeat(1000) } },
    message: {
      id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', diagnostics: { detail: 'x'.repeat(1000) },
      usage: {
        input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 20,
        output_tokens_details: { thinking_tokens: 5 }, iterations: [{ input_tokens: 2 }], server_tool_use: { web_search_requests: 0 },
      },
      content: [{ type: 'thinking', thinking: 'Plan the reply', signature: 'sig'.repeat(500) }, { type: 'text', text: 'Hello' }],
    },
  }))
  assert.equal(entry.wireToolInputs, undefined)
  assert.equal(entry.requestId, undefined)
  assert.equal(entry.message.diagnostics, undefined)
  assert.deepEqual(entry.message.content, [{ type: 'thinking' }, { type: 'text', text: 'Hello' }])
  assert.deepEqual(transcript.readApiUsage(entry.message.usage), { inputTokens: 112, cachedInputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 132 })
  assert.equal(entry.message.usage.iterations, undefined)
  const [turn] = transcript.buildTurnsFromChain([entry], cwd).turns
  assert.deepEqual(turn.items.map((item) => [item.type, item.id]), [['reasoning', 'msg_1:reasoning:0'], ['agentMessage', 'msg_1:text:0']])
})

test('keeps Claude questions and the answers given in the chat after a reload', () => {
  const questions = [
    { question: 'Which budget?', header: 'Budget', multiSelect: false, options: [{ label: 'Low', description: '' }, { label: 'High', description: '' }] },
    { question: 'What matters?', header: 'Priorities', multiSelect: true, options: [{ label: 'Pool', description: '' }, { label: 'Quiet', description: '' }] },
  ]
  const lines = [
    entry('u1', null, { type: 'user', timestamp: at(0), message: { role: 'user', content: 'Find a hotel' } }),
    assistant('a1', 'u1', 1, 'msg_1', { type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions } }),
    toolResult('r1', 'a1', 2, 'toolu_ask', 'The user answered: "Which budget?"="High", "What matters?"="Pool, and a gym"', {
      questions, answers: { 'Which budget?': 'High', 'What matters?': 'Pool, and a gym' },
    }),
    assistant('a2', 'r1', 3, 'msg_2', { type: 'tool_use', id: 'toolu_away', name: 'AskUserQuestion', input: { questions: [questions[0]] } }),
    toolResult('r2', 'a2', 4, 'toolu_away', 'PreToolUse:AskUserQuestion hook error: No answer after 15 minutes', 'Error: No answer after 15 minutes', true),
  ]
  const chain = transcript.resolveMainChain(lines.map((line) => transcript.parseTranscriptLine(JSON.stringify(line))))
  const [turn] = transcript.buildTurnsFromChain(chain, cwd).turns
  assert.deepEqual(turn.items.filter((item) => item.type === 'askedQuestions'), [
    { type: 'askedQuestions', id: 'toolu_ask', status: 'completed', questions: [
      { header: 'Budget', question: 'Which budget?', answer: 'High' },
      { header: 'Priorities', question: 'What matters?', answer: 'Pool, and a gym' },
    ] },
    { type: 'askedQuestions', id: 'toolu_away', status: 'failed', questions: [{ header: 'Budget', question: 'Which budget?', answer: '' }] },
  ])
})

test('reads transcript lines a chunk at a time, across chunk boundaries and multi-byte characters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-transcript-range-'))
  try {
    const file = join(directory, 'chat.jsonl')
    const lines = [
      { type: 'user', uuid: 'a', message: { content: 'Plan a trip to Bali 🌴 with café stops' } },
      { type: 'assistant', uuid: 'b', message: { content: [{ type: 'text', text: 'Sure — 好的. '.repeat(20) }] } },
      { type: 'user', uuid: 'c', message: { content: 'Thanks' } },
    ].map((line) => JSON.stringify(line))
    const complete = `${lines.join('\n')}\n`
    await writeFile(file, `${complete}{"type":"assistant","uuid":"half`)
    const size = (await stat(file)).size
    const expected = lines.map((line) => transcript.parseTranscriptLine(line))
    for (const chunkBytes of [1, 2, 3, 7, 64, 1 << 20]) {
      const whole = await readTranscriptRange(file, 0, size, chunkBytes)
      assert.deepEqual(whole.entries, expected, `${String(chunkBytes)}-byte chunks parse every complete line`)
      assert.equal(whole.bytes, Buffer.byteLength(complete), 'the half-written last line is left for the next read')
    }
    const from = Buffer.byteLength(`${lines[0]}\n`)
    const appended = await readTranscriptRange(file, from, size, 5)
    assert.deepEqual(appended.entries.map((entry) => entry.uuid), ['b', 'c'])
    assert.equal(from + appended.bytes, Buffer.byteLength(complete))
    assert.equal(await readTranscriptRange(join(directory, 'missing.jsonl'), 0, 10), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('finds the first message that mentions a search term, ignoring tool output and meta entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-transcript-search-'))
  try {
    const file = join(directory, 'chat.jsonl')
    const filler = 'x'.repeat(150)
    await writeFile(file, [
      { type: 'user', isMeta: true, message: { content: 'Caveat: the HOTEL list is internal' } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'hotel.txt' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'hotel.txt' } }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: `${filler} Three Hotels near the beach 🌴 ${filler}` }] } },
      { type: 'user', message: { content: 'Book the second hotel' } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n')
    const expected = `…${'x'.repeat(93)} Three Hotels near the beach 🌴 ${'x'.repeat(140)}`
    for (const chunkBytes of [3, 64, 1 << 20]) {
      assert.equal(await findTranscriptSnippet(file, 'hotel', chunkBytes), expected, `${String(chunkBytes)}-byte chunks`)
    }
    assert.equal(await findTranscriptSnippet(file, 'second hotel'), 'Book the second hotel')
    assert.equal(await findTranscriptSnippet(file, 'internal'), '', 'meta entries are not chat')
    assert.equal(await findTranscriptSnippet(file, 'zebra'), '')
    assert.equal(await findTranscriptSnippet(join(directory, 'missing.jsonl'), 'hotel'), '')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('searches the text of saved Claude chats', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'codexui-claude-search-'))
  try {
    const sessionId = '12121212-3434-5656-7878-909090909090'
    const projectDir = join(configDir, 'projects', '-work-project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), fixture.map((line) => JSON.stringify(line)).join('\n') + '\n')
    const backend = new ClaudeBackend(join(configDir, 'threads.json'), { accountSwitcherPath: null, claudeConfigDir: configDir })
    backend.listAllSessions = async () => [{ sessionId, summary: 'Notes work', firstPrompt: 'Create notes.txt then edit it', cwd, lastModified: Date.now() }]
    backend.refreshClaudeSessionStates = async () => ({ states: new Map() })
    const [result] = await backend.searchThreads({ searchTerm: 'KIWI' })
    assert.equal(result.thread.id, `claude-${sessionId}`)
    assert.equal(result.snippet, 'Done. Kiwi.')
    assert.deepEqual(await backend.searchThreads({ searchTerm: 'zebra' }), [])
    backend.dispose()
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('reads a growing transcript incrementally and waits for half-written lines', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'codexui-claude-config-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  try {
    const sessionId = '11111111-2222-3333-4444-555555555555'
    const projectDir = join(configDir, 'projects', '-work-project')
    await mkdir(projectDir, { recursive: true })
    const file = join(projectDir, `${sessionId}.jsonl`)
    const line = (value) => `${JSON.stringify(value)}\n`
    await writeFile(file, fixture.slice(0, 2).map(line).join(''))
    const backend = new ClaudeBackend(join(configDir, 'threads.json'))
    const read = async () => (await backend.rpc('thread/read', { threadId: `claude-${sessionId}`, includeTurns: true })).thread.turns
    assert.equal((await read()).length, 1)

    const rest = fixture.slice(2, 15).map(line).join('')
    const second = line(fixture[15])
    await appendFile(file, `${rest}${second.slice(0, 20)}`)
    const partial = await read()
    assert.equal(partial.length, 1, 'half-written prompt is not parsed yet')
    assert.equal(partial[0].items.at(-1).id, 'msg_4:text:0')

    await appendFile(file, second.slice(20))
    const complete = await read()
    assert.deepEqual(complete.map((turn) => turn.id), ['u1', 'u2'])
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(configDir, { recursive: true, force: true })
  }
})

test('refuses to send to a session another Claude app is writing', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'codexui-claude-config-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  try {
    const sessionId = '66666666-7777-8888-9999-000000000000'
    const projectDir = join(configDir, 'projects', '-work-project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), fixture.slice(0, 2).map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    const backend = new ClaudeBackend(join(configDir, 'threads.json'))
    backend.readRuntime = async () => ({ account: { email: 'a@b.c' }, connected: true, models: [] })
    await assert.rejects(
      backend.rpc('turn/start', { threadId: `claude-${sessionId}`, input: [{ type: 'text', text: 'hi' }] }),
      /active in another app/u,
    )
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(configDir, { recursive: true, force: true })
  }
})

test('shows live Remote Control work as running until Claude reports idle', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'codexui-claude-sessions-'))
  const sessionId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb'
  const projectDir = join(configDir, 'projects', '-work-project')
  const sessionsDir = join(configDir, 'sessions')
  const sessionFile = join(sessionsDir, `${String(process.pid)}.json`)
  await mkdir(projectDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(join(projectDir, `${sessionId}.jsonl`), fixture.slice(0, 15).map((row) => JSON.stringify(row)).join('\n') + '\n')
  const record = { pid: process.pid, sessionId, cwd, kind: 'interactive', entrypoint: 'sdk-cli', status: 'busy', startedAt: Date.now() }
  await writeFile(sessionFile, JSON.stringify(record))
  const backend = new ClaudeBackend(join(configDir, 'threads.json'), { accountSwitcherPath: null, claudeConfigDir: configDir })
  const notifications = []
  const unsubscribe = backend.onNotification((notification) => notifications.push(notification))
  try {
    const running = (await backend.rpc('thread/read', { threadId: `claude-${sessionId}`, includeTurns: true })).thread
    assert.equal(running.status.type, 'active')
    assert.equal(running.turns.at(-1).status, 'inProgress')

    await writeFile(sessionFile, JSON.stringify({ ...record, status: 'idle' }))
    await backend.refreshClaudeSessionStates()
    assert.deepEqual(notifications.at(-1), {
      method: 'thread/status/changed',
      params: { threadId: `claude-${sessionId}`, status: { type: 'idle' } },
    })
    const idle = (await backend.rpc('thread/read', { threadId: `claude-${sessionId}`, includeTurns: true })).thread
    assert.equal(idle.status.type, 'idle')
    assert.equal(idle.turns.at(-1).status, 'completed')

    await writeFile(join(sessionsDir, 'unreadable.json'), '{')
    assert.equal((await scanClaudeSessionRegistry(configDir)).uncertain, true)
  } finally {
    unsubscribe()
    backend.dispose()
    await rm(configDir, { recursive: true, force: true })
  }
})

// ── Backend helpers ──────────────────────────────────────────────────────

test('recognizes both stable and runtime-generated Claude model ids', () => {
  assert.equal(isClaudeModelId('claude-opus'), true)
  assert.equal(isClaudeModelId('claude-model:opus%5B1m%5D'), true)
  assert.equal(isClaudeModelId('gpt-5.6-sol'), false)
})

test('turns Claude runtime metadata into actual model labels and effort limits', () => {
  const model = runtimeModel({
    value: 'default',
    displayName: 'Default',
    description: 'The recommended model (currently Opus 4.8 (1M context))',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  })
  assert.equal(model.displayName, 'Claude · Default (Opus 4.8 (1M context))')
  assert.deepEqual(model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(model.defaultReasoningEffort, 'high')
})

test('normalizes current Claude usage windows', () => {
  const usage = normalizeClaudeUsage({
    limits: [
      { kind: 'session', percent: 27, resets_at: '2026-09-28T12:00:00Z' },
      { kind: 'weekly_scoped', percent: 54, scope: { model: { display_name: 'Claude Opus' } } },
    ],
  }, 'max')
  assert.equal(usage.plan, 'max')
  assert.deepEqual(usage.limits.map(({ label, usedPercent }) => ({ label, usedPercent })), [
    { label: '5h limit', usedPercent: 27 },
    { label: 'Weekly · Claude Opus', usedPercent: 54 },
  ])
})

test('normalizes the Agent SDK usage response and model-scoped windows', () => {
  const usage = normalizeClaudeUsage({
    subscription_type: 'pro',
    rate_limits: {
      five_hour: { utilization: 12, resets_at: '2026-09-28T12:00:00Z' },
      seven_day: { utilization: 34, resets_at: null },
      model_scoped: [
        { display_name: 'Opus', utilization: 56, resets_at: '2026-09-29T12:00:00Z' },
      ],
    },
  }, null)
  assert.equal(usage.plan, 'pro')
  assert.deepEqual(usage.limits.map(({ label, usedPercent }) => ({ label, usedPercent })), [
    { label: '5h limit', usedPercent: 12 },
    { label: 'Weekly · all models', usedPercent: 34 },
    { label: 'Weekly · Opus', usedPercent: 56 },
  ])
})

/** A live runner with no transcript, and the context meters it publishes. */
async function withMeteredRunner(run) {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-claude-context-'))
  const sessionId = '11111111-2222-3333-4444-555555555558'
  const backend = new ClaudeBackend(join(directory, 'threads.json'), { accountSwitcherPath: null, claudeConfigDir: directory })
  backend.readRuntime = async () => ({ connected: true, account: {}, models: [] })
  backend.sdk = async () => ({
    query: () => {
      let release
      const closed = new Promise((resolve) => { release = resolve })
      return { async *[Symbol.asyncIterator]() { await closed }, close: () => release(), interrupt: async () => {} }
    },
  })
  const meters = []
  const unsubscribe = backend.onNotification(({ method, params }) => {
    if (method === 'thread/tokenUsage/updated') meters.push(params.tokenUsage)
  })
  try {
    const runner = await backend.createRunner(
      `claude-${sessionId}`,
      sessionId,
      { cwd: directory, model: 'claude-default', effort: null, createdAtMs: Date.now() },
      directory,
      `claude-default||${directory}`,
    )
    await run({ backend, runner, sessionId, directory, meters })
  } finally {
    unsubscribe()
    backend.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

const opusReply = (id, contextTokens) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    id,
    model: 'claude-opus-5-5',
    role: 'assistant',
    content: [],
    usage: { input_tokens: 2, cache_read_input_tokens: contextTokens - 2, cache_creation_input_tokens: 0, output_tokens: 40 },
  },
})

// Shape recorded from Claude Code 2.1.283: the Haiku model it names chats with comes first.
const recordedModelUsage = {
  'claude-haiku-4-5-20251001': {
    inputTokens: 897, outputTokens: 8, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0,
    costUSD: 0.000937, contextWindow: 200_000, maxOutputTokens: 32_000, thinkingTokens: 0, canonicalModel: 'claude-haiku-4-5', provider: 'firstParty',
  },
  'claude-opus-5-5': {
    inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 25_055, webSearchRequests: 0,
    costUSD: 0.200528, contextWindow: 1_000_000, maxOutputTokens: 128_000, thinkingTokens: 0, canonicalModel: 'claude-opus-5-5', provider: 'firstParty',
  },
}

test('measures the context meter against the chat model, not the helper model Claude Code lists first', async () => {
  await withMeteredRunner(async ({ backend, runner, sessionId, directory, meters }) => {
    backend.beginTurn(runner, 'turn-1', directory, null)
    backend.handleMessage(runner, opusReply('msg_1', 150_000))
    backend.handleMessage(runner, { type: 'result', subtype: 'success', is_error: false, result: '', modelUsage: recordedModelUsage })
    assert.equal(meters.at(-1).last.totalTokens, 150_040)
    assert.equal(meters.at(-1).modelContextWindow, 1_000_000, 'the meter is corrected as soon as Claude Code reports the window')
    const saved = async () => JSON.parse(await readFile(join(directory, 'threads.json'), 'utf8').catch(() => '{}')).threads?.[sessionId]?.contextWindow
    for (let attempt = 0; attempt < 50 && await saved() === undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(await saved(), 1_000_000, 'reopened chats keep the window')

    backend.beginTurn(runner, 'turn-2', directory, null)
    backend.handleMessage(runner, opusReply('msg_2', 160_000))
    assert.equal(meters.at(-1).modelContextWindow, 1_000_000)
  })
})

test('measures a chat past 200K tokens against 1M before Claude Code reports its window', async () => {
  await withMeteredRunner(async ({ backend, runner, directory, meters }) => {
    backend.beginTurn(runner, 'turn-1', directory, null)
    backend.handleMessage(runner, opusReply('msg_1', 150_000))
    assert.equal(meters.at(-1).modelContextWindow, 200_000)
    backend.handleMessage(runner, opusReply('msg_2', 300_000))
    assert.equal(meters.at(-1).modelContextWindow, 1_000_000, 'a 200K window cannot hold this chat')
  })
})

test('a reply Claude has not saved yet shows the message as sent, photos included', async () => {
  await withMeteredRunner(async ({ backend, runner, sessionId, directory }) => {
    await backend.store.update(sessionId, { cwd: directory, model: 'claude-default', effort: null, createdAtMs: Date.now() })
    const photo = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'FULLSIZE' } }
    const sent = { role: 'user', content: [{ type: 'text', text: 'What is this?' }, photo] }
    backend.beginTurn(runner, 'turn-1', directory, { type: 'user', uuid: 'turn-1', session_id: sessionId, parent_tool_use_id: null, message: sent })
    const { thread } = await backend.rpc('thread/read', { threadId: `claude-${sessionId}`, includeTurns: true })
    assert.equal(thread.turns.at(-1).status, 'inProgress')
    assert.deepEqual(thread.turns.at(-1).items, [{
      type: 'userMessage',
      id: 'turn-1',
      content: [{ type: 'text', text: 'What is this?' }, { type: 'image', url: 'data:image/png;base64,FULLSIZE' }],
    }])
  })
})

const finishedReply = { type: 'result', subtype: 'success', is_error: false, result: '', modelUsage: recordedModelUsage }

test('closes an idle Claude process after 5 minutes', async (t) => {
  await withMeteredRunner(async ({ backend, runner, sessionId, directory }) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    backend.beginTurn(runner, 'turn-1', directory, null)
    backend.handleMessage(runner, finishedReply)
    t.mock.timers.tick(5 * 60_000 - 1)
    assert.equal(backend.runners.has(sessionId), true)
    t.mock.timers.tick(1)
    assert.equal(backend.runners.has(sessionId), false)
  })
})

test('keeps an idle Claude process until a wakeup it scheduled has fired', async (t) => {
  await withMeteredRunner(async ({ backend, runner, sessionId, directory }) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    backend.beginTurn(runner, 'turn-1', directory, null)
    const wakeup = { type: 'tool_use', id: 'toolu_wake', name: 'ScheduleWakeup', input: { delaySeconds: 20 * 60, prompt: '/loop check', reason: 'waiting' } }
    backend.handleMessage(runner, { ...opusReply('msg_1', 1000), message: { ...opusReply('msg_1', 1000).message, content: [wakeup] } })
    backend.handleMessage(runner, { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wake', content: 'Scheduled' }] } })
    backend.handleMessage(runner, finishedReply)
    t.mock.timers.tick(20 * 60_000)
    assert.equal(backend.runners.has(sessionId), true, 'the process outlives the idle timeout while its wakeup is pending')
    t.mock.timers.tick(60_000)
    assert.equal(backend.runners.has(sessionId), false, 'it closes once the wakeup should have fired')
  })
})

test('marks a finished reply when the chat will carry on by itself, so alerts wait for the reply that ends its work', async (t) => {
  await withMeteredRunner(async ({ backend, runner, directory }) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const completions = []
    const unsubscribe = backend.onNotification(({ method, params }) => {
      if (method === 'turn/completed') completions.push(params)
    })
    const reply = (id, text) => ({ ...opusReply(id, 1000), message: { ...opusReply(id, 1000).message, content: [{ type: 'text', text }] } })
    const lastContinuation = () => completions.at(-1).codexuiContinuation

    backend.beginTurn(runner, 'turn-1', directory, null)
    backend.handleMessage(runner, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'validator', task_type: 'local_agent', description: 'Re-check the cut' }] })
    backend.handleMessage(runner, reply('msg_1', 'A second validator is re-checking.'))
    backend.handleMessage(runner, finishedReply)
    assert.deepEqual(lastContinuation(), { reason: 'backgroundWork' })

    // The validator ends and Claude Code starts the next reply by itself.
    backend.handleMessage(runner, { type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    backend.handleMessage(runner, reply('msg_2', 'Sent to Telegram.'))
    backend.handleMessage(runner, finishedReply)
    assert.equal(completions.length, 2)
    assert.equal(lastContinuation(), undefined, 'the reply that ends the work alerts')

    backend.beginTurn(runner, 'turn-3', directory, null)
    runner.pushedCommands.set('turn-3', {})
    runner.pushedCommands.set('steer', {})
    runner.pushedCommands.set('queued', {})
    backend.handleMessage(runner, { ...finishedReply, user_message_uuids: ['turn-3', 'steer'] })
    assert.deepEqual(lastContinuation(), { reason: 'queuedMessage' }, 'a message the reply did not take in starts the next one')
    backend.beginTurn(runner, 'queued', directory, null)
    backend.handleMessage(runner, { ...finishedReply, user_message_uuids: ['queued'] })
    assert.equal(lastContinuation(), undefined)

    backend.beginTurn(runner, 'turn-5', directory, null)
    runner.activeTurn.goalContinuation = true
    backend.handleMessage(runner, reply('msg_5', 'Two of five pages done.'))
    backend.handleMessage(runner, finishedReply)
    assert.deepEqual(lastContinuation(), { reason: 'goal' })
    backend.beginTurn(runner, 'turn-6', directory, null)
    runner.activeTurn.goalContinuation = true
    backend.handleMessage(runner, reply('msg_6', 'All pages done.\nGOAL COMPLETE'))
    backend.handleMessage(runner, finishedReply)
    assert.equal(lastContinuation(), undefined)

    backend.beginTurn(runner, 'turn-7', directory, null)
    const wakeup = { type: 'tool_use', id: 'toolu_wake', name: 'ScheduleWakeup', input: { delaySeconds: 20 * 60, prompt: '/loop check', reason: 'waiting' } }
    backend.handleMessage(runner, { ...opusReply('msg_7', 1000), message: { ...opusReply('msg_7', 1000).message, content: [wakeup] } })
    backend.handleMessage(runner, { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wake', content: 'Scheduled' }] } })
    backend.handleMessage(runner, finishedReply)
    assert.deepEqual(lastContinuation(), { reason: 'scheduledWakeup', resumesAt: new Date(Date.now() + 20 * 60_000).toISOString() })
    t.mock.timers.tick(20 * 60_000)
    backend.beginTurn(runner, 'turn-8', directory, null)
    backend.handleMessage(runner, finishedReply)
    assert.equal(lastContinuation(), undefined, 'a wakeup that has fired no longer holds alerts')

    backend.beginTurn(runner, 'turn-9', directory, null)
    backend.handleMessage(runner, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'tests', task_type: 'local_bash', description: 'Run the tests' }] })
    backend.interrupt(runner.threadId)
    backend.handleMessage(runner, finishedReply)
    assert.equal(lastContinuation(), undefined, 'a stopped reply never waits')
    unsubscribe()
  })
})

test('marks a usage-limit failure that CodexUI retries by itself', async () => {
  await withMeteredRunner(async ({ backend, runner, directory }) => {
    const completions = []
    const unsubscribe = backend.onNotification(({ method, params }) => {
      if (method === 'turn/completed') completions.push(params)
    })
    backend.beginTurn(runner, 'turn-1', directory, null)
    backend.handleMessage(runner, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 10pm (Asia/Singapore)", modelUsage: {} })
    assert.equal(completions[0].turn.status, 'failed')
    assert.deepEqual(completions[0].codexuiContinuation, { reason: 'limitRetry' })
    unsubscribe()
  })
})

/** A saved Claude chat with a subagent folder, and a backend that has, by default, started its process. */
async function withSavedClaudeChat(run, { startProcess = true } = {}) {
  const configDir = await mkdtemp(join(tmpdir(), 'codexui-claude-delete-'))
  const sessionId = '88888888-9999-aaaa-bbbb-cccccccccccc'
  const threadId = `claude-${sessionId}`
  const projectDir = join(configDir, 'projects', '-work-project')
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
  const sessionFolder = join(projectDir, sessionId)
  await mkdir(join(sessionFolder, 'subagents'), { recursive: true })
  await writeFile(transcriptPath, fixture.map((row) => JSON.stringify(row)).join('\n') + '\n')
  await writeFile(join(sessionFolder, 'subagents', 'agent-1.jsonl'), '{}\n')
  const storePath = join(configDir, 'threads.json')
  const backend = new ClaudeBackend(storePath, { accountSwitcherPath: null, claudeConfigDir: configDir })
  backend.readRuntime = async () => ({ connected: true, account: {}, models: [] })
  let closed = false
  backend.sdk = async () => ({
    query: () => {
      let release
      const ended = new Promise((resolve) => { release = resolve })
      return { async *[Symbol.asyncIterator]() { await ended }, close: () => { closed = true; release() }, interrupt: async () => {} }
    },
  })
  const deleted = []
  const unsubscribe = backend.onNotification(({ method, params }) => {
    if (method === 'thread/deleted') deleted.push(params.threadId)
  })
  try {
    const stored = await backend.store.update(sessionId, { cwd, model: 'claude-default', effort: null, createdAtMs: Date.now() })
    const runner = startProcess ? await backend.createRunner(threadId, sessionId, stored, cwd, `claude-default||${cwd}`) : null
    await run({
      backend, runner, configDir, sessionId, threadId, transcriptPath, sessionFolder, deleted,
      processClosed: () => closed,
      /** The chat's saved settings on disk, read past a write in progress. */
      saved: async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            return JSON.parse(await readFile(storePath, 'utf8').catch(() => '{}')).threads?.[sessionId]
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
        throw new Error('the saved chats file never became readable')
      },
    })
  } finally {
    unsubscribe()
    backend.dispose()
    await rm(configDir, { recursive: true, force: true })
  }
}

const exists = (path) => stat(path).then(() => true, () => false)

test('deleting a Claude chat erases its transcript, subagent folder and saved settings', async () => {
  await withSavedClaudeChat(async ({ backend, threadId, transcriptPath, sessionFolder, deleted, processClosed, saved }) => {
    assert.ok(await saved(), 'precondition: CodexUI saved the chat')
    await backend.rpc('thread/delete', { threadId })
    assert.equal(processClosed(), true, 'its idle Claude Code process is closed first')
    assert.equal(await exists(transcriptPath), false)
    assert.equal(await exists(sessionFolder), false)
    for (let attempt = 0; attempt < 50 && await saved() !== undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(await saved(), undefined, 'the saved settings are gone')
    assert.deepEqual(deleted, [threadId])
    await backend.rpc('thread/delete', { threadId })
    assert.deepEqual(deleted, [threadId, threadId], 'deleting again is harmless')
  })
})

test('refuses to delete a Claude chat that is still working', async () => {
  await withSavedClaudeChat(async ({ backend, runner, threadId, transcriptPath, deleted }) => {
    backend.beginTurn(runner, 'turn-1', cwd, null)
    await assert.rejects(backend.rpc('thread/delete', { threadId }), /still working/u)
    assert.equal(await exists(transcriptPath), true)
    assert.deepEqual(deleted, [])
  })
})

test('refuses to delete a Claude chat another Claude app has open', async () => {
  await withSavedClaudeChat(async ({ backend, configDir, sessionId, threadId, transcriptPath, deleted }) => {
    await mkdir(join(configDir, 'sessions'), { recursive: true })
    await writeFile(join(configDir, 'sessions', `${String(process.pid)}.json`), JSON.stringify({
      pid: process.pid, sessionId, cwd, kind: 'interactive', entrypoint: 'cli', status: 'idle', startedAt: Date.now(),
    }))
    await assert.rejects(backend.rpc('thread/delete', { threadId }), /open in another Claude app/u)
    assert.equal(await exists(transcriptPath), true)
    assert.deepEqual(deleted, [])
  }, { startProcess: false })
})

test('enables Claude in Chrome only for conversational runners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-claude-chrome-'))
  const backend = new ClaudeBackend(join(directory, 'threads.json'), { accountSwitcherPath: null, claudeConfigDir: directory })
  let runnerOptions
  backend.readRuntime = async () => ({ connected: true, account: {}, models: [] })
  backend.sdk = async () => ({
    query: ({ options }) => {
      runnerOptions = options
      return {
        async *[Symbol.asyncIterator]() {},
        close: () => {},
        interrupt: async () => {},
      }
    },
  })
  try {
    assert.equal(backend.baseOptions(directory).extraArgs, undefined, 'background probes must not attach to Chrome')
    await backend.createRunner(
      'claude-11111111-2222-3333-4444-555555555555',
      '11111111-2222-3333-4444-555555555555',
      { cwd: directory, model: 'claude-default', effort: null, createdAtMs: Date.now() },
      directory,
      `claude-default||${directory}`,
    )
    assert.deepEqual(runnerOptions.extraArgs, { chrome: null })
  } finally {
    backend.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('loads guarded Mac control for Claude runners and waits for approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-claude-computer-use-'))
  const configPath = join(directory, 'computer-use.mcp.json')
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      cua_repl: {
        command: process.execPath,
        args: ['/fixture/cua-repl.mjs'],
        env: { CUA_REPL_ENABLED_SURFACES: 'browser,computer', KEEP_ME: 'yes' },
      },
    },
  }))
  const previous = process.env.CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE
  const previousApproval = process.env.CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL
  process.env.CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE = configPath
  process.env.CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL = 'ask'
  const backend = new ClaudeBackend(join(directory, 'threads.json'), { accountSwitcherPath: null, claudeConfigDir: directory })
  let runnerOptions
  let releaseQuery
  backend.readRuntime = async () => ({ connected: true, account: {}, models: [] })
  backend.sdk = async () => ({
    query: ({ options }) => {
      runnerOptions = options
      return {
        async *[Symbol.asyncIterator]() { await new Promise((resolve) => { releaseQuery = resolve }) },
        close: () => { releaseQuery?.() },
        interrupt: async () => {},
      }
    },
  })
  try {
    const threadId = 'claude-11111111-2222-3333-4444-555555555556'
    const runner = await backend.createRunner(
      threadId,
      '11111111-2222-3333-4444-555555555556',
      { cwd: directory, model: 'claude-default', effort: null, createdAtMs: Date.now() },
      directory,
      `claude-default||${directory}`,
    )
    backend.beginTurn(runner, 'turn-1', directory, null)

    assert.equal(runnerOptions.mcpServers.cua_repl.command, process.execPath)
    assert.equal(runnerOptions.mcpServers.cua_repl.env.KEEP_ME, 'yes')
    assert.equal(runnerOptions.mcpServers.cua_repl.env.CUA_REPL_ENABLED_SURFACES, 'computer')
    assert.equal(runnerOptions.mcpServers.cua_repl.alwaysLoad, true)

    const computerHook = runnerOptions.hooks.PreToolUse.find((matcher) => matcher.matcher === 'mcp__cua_repl__js').hooks[0]
    const hookResult = computerHook(
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__cua_repl__js', tool_input: { code: 'await cua.getState()' } },
      'tool-1',
      { signal: new AbortController().signal },
    )
    await new Promise((resolve) => setImmediate(resolve))
    const [pending] = backend.listPendingServerRequests()
    assert.equal(pending.method, 'item/permissions/requestApproval')
    assert.equal(pending.params.permissionKind, 'computerUse')
    assert.deepEqual(pending.params.availableDecisions, ['accept', 'acceptForSession', 'decline'])
    await backend.respondToServerRequest({ id: pending.id, result: { decision: 'accept' } })
    assert.equal((await hookResult).hookSpecificOutput.permissionDecision, 'allow')

    const callHook = (toolUseId) => computerHook(
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__cua_repl__js', tool_input: { code: 'await cua.getState()' } },
      toolUseId,
      { signal: new AbortController().signal },
    )
    const second = callHook('tool-2')
    await new Promise((resolve) => setImmediate(resolve))
    const [askedAgain] = backend.listPendingServerRequests()
    assert.ok(askedAgain, 'a one-time Accept must not cover the next call')
    await backend.respondToServerRequest({ id: askedAgain.id, result: { decision: 'acceptForSession' } })
    assert.equal((await second).hookSpecificOutput.permissionDecision, 'allow')

    assert.equal((await callHook('tool-3')).hookSpecificOutput.permissionDecision, 'allow')
    assert.deepEqual(backend.listPendingServerRequests(), [])

    runner.activeTurn.threadId = 'claude-other-chat'
    const otherChat = callHook('tool-4')
    await new Promise((resolve) => setImmediate(resolve))
    const [otherPending] = backend.listPendingServerRequests()
    assert.ok(otherPending, 'approval for one chat must not cover another chat')
    await backend.respondToServerRequest({ id: otherPending.id, result: { decision: 'decline' } })
    assert.equal((await otherChat).hookSpecificOutput.permissionDecision, 'deny')
  } finally {
    backend.dispose()
    if (previous === undefined) delete process.env.CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE
    else process.env.CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE = previous
    if (previousApproval === undefined) delete process.env.CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL
    else process.env.CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL = previousApproval
    await rm(directory, { recursive: true, force: true })
  }
})

test('the cua relay adds Codex turn metadata to tool calls only', () => {
  const meta = { session_id: 'session-1', turn_id: 'turn-1' }
  const call = JSON.parse(withTurnMetadata(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'js', arguments: { code: '1' }, _meta: { progressToken: 7 } } }), 'session-1', 'turn-1'))
  assert.deepEqual(call.params, { name: 'js', arguments: { code: '1', timeout_ms: 120000 }, _meta: { progressToken: 7, 'x-codex-turn-metadata': meta } })
  const chosen = JSON.parse(withTurnMetadata(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'js', arguments: { code: '1', timeout_ms: 5000 } } }), 'session-1', 'turn-1'))
  assert.equal(chosen.params.arguments.timeout_ms, 5000, 'a timeout Claude chose is kept')
  const reset = JSON.parse(withTurnMetadata(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'js_reset', arguments: {} } }), 'session-1', 'turn-1'))
  assert.deepEqual(reset.params.arguments, {}, 'only js calls get the longer default')
  const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(withTurnMetadata(list, 'session-1', 'turn-1'), list)
  assert.equal(withTurnMetadata('not json', 'session-1', 'turn-1'), 'not json')
})

test('the cua relay process forwards stdio and reads the current turn on each call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-cua-relay-'))
  try {
    const echo = join(directory, 'echo.mjs')
    await writeFile(echo, "process.stdin.pipe(process.stdout)\n")
    const turnFile = join(directory, 'turn')
    await writeFile(turnFile, 'turn-a')
    const relay = spawn(process.execPath, [cuaRelayBundle, 'session-9', turnFile, '--', process.execPath, echo], { stdio: ['pipe', 'pipe', 'inherit'] })
    const lines = createInterface({ input: relay.stdout })[Symbol.asyncIterator]()
    const send = async (message) => {
      relay.stdin.write(`${JSON.stringify(message)}\n`)
      return JSON.parse((await lines.next()).value)
    }
    assert.deepEqual(await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    assert.deepEqual((await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js' } })).params._meta, { 'x-codex-turn-metadata': { session_id: 'session-9', turn_id: 'turn-a' } })
    await writeFile(turnFile, 'turn-b')
    assert.equal((await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'js' } })).params._meta['x-codex-turn-metadata'].turn_id, 'turn-b')
    const exited = new Promise((resolve) => relay.on('exit', resolve))
    relay.stdin.end()
    assert.equal(await exited, 0, 'closing Claude\'s side ends the relay and its server')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the cua relay tells the plugin when a turn ends, as Codex does, and hides the answer from Claude', async () => {
  assert.deepEqual(parseTurnFile('turn-1'), { turnId: 'turn-1', ended: false })
  assert.deepEqual(parseTurnFile('turn-1\nended'), { turnId: 'turn-1', ended: true })
  const request = JSON.parse(turnEndedRequest(1, 'session-1', 'turn-1'))
  assert.deepEqual(request.params.arguments, { hook_event_name: 'Stop', session_id: 'session-1', turn_id: 'turn-1' })
  assert.equal(isRelayResponse(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })), true)
  assert.equal(isRelayResponse(JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} })), false)

  const directory = await mkdtemp(join(tmpdir(), 'codexui-cua-relay-end-'))
  try {
    const received = join(directory, 'received.jsonl')
    const server = join(directory, 'server.mjs')
    await writeFile(server, `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(${JSON.stringify(received)}, line + '\\n')
  const message = JSON.parse(line)
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } }) + '\\n')
})
`)
    const turnFile = join(directory, 'turn')
    await writeFile(turnFile, 'turn-a')
    const relay = spawn(process.execPath, [cuaRelayBundle, 'session-7', turnFile, '--', process.execPath, server], { stdio: ['pipe', 'pipe', 'inherit'] })
    const output = []
    createInterface({ input: relay.stdout }).on('line', (line) => output.push(JSON.parse(line)))
    relay.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    relay.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    await writeFile(turnFile, 'turn-a\nended')
    const sent = async () => (await readFile(received, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    for (let attempt = 0; attempt < 60 && !(await sent()).some((m) => m.params?.name === 'turn_ended'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100))
    const ended = (await sent()).filter((m) => m.params?.name === 'turn_ended')
    assert.equal(ended.length, 1)
    assert.deepEqual(ended[0].params.arguments, { hook_event_name: 'Stop', session_id: 'session-7', turn_id: 'turn-a' })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal((await sent()).filter((m) => m.params?.name === 'turn_ended').length, 1, 'each turn ends once')
    assert.deepEqual(output.map((m) => m.id), [1], 'Claude sees its own answers only')
    const exited = new Promise((resolve) => relay.on('exit', resolve))
    relay.stdin.end()
    await exited
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Claude chats drive Chrome through the cua relay instead of Claude in Chrome when it is available', async () => {
  const stubRelay = join(bundleDir, 'cuaRelay.js')
  await writeFile(stubRelay, '')
  try {
    await withComputerUseRunner({ CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL: 'never' }, async ({ backend, runnerOptions }) => {
      const server = runnerOptions.mcpServers.cua_repl
      const sessionId = '11111111-2222-3333-4444-555555555557'
      const turnFile = join(backend.cuaTurnDirectory, sessionId)
      assert.equal(server.command, process.execPath)
      assert.deepEqual(server.args, [stubRelay, sessionId, turnFile, '--', process.execPath])
      assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'computer,browser')
      assert.equal(runnerOptions.extraArgs, undefined, 'one Chrome driver, not two')
      for (let attempt = 0; attempt < 50 && !(await stat(turnFile).catch(() => null)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(await readFile(turnFile, 'utf8'), 'turn-1')
      assert.equal((await stat(turnFile)).mode & 0o777, 0o600)
      backend.finishTurn(backend.runners.get(sessionId), 'completed')
      for (let attempt = 0; attempt < 50 && (await readFile(turnFile, 'utf8')) !== 'turn-1\nended'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(await readFile(turnFile, 'utf8'), 'turn-1\nended', 'the relay learns the turn ended')
      backend.closeRunner(sessionId)
      for (let attempt = 0; attempt < 50 && await stat(turnFile).catch(() => null); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(await stat(turnFile).catch(() => null), null, 'a closed chat leaves no turn file')
    })
  } finally {
    await rm(stubRelay, { force: true })
  }
})

test('restart recovery learns which chats are busy from the Claude backend itself', () => {
  const backend = new ClaudeBackend(join(tmpdir(), `codexui-active-${Date.now()}.json`), { accountSwitcherPath: null })
  const runner = (session, extra = {}) => ({ sessionId: session, threadId: `claude-${session}`, closed: false, activeTurn: null, pushedCommands: new Map(), backgroundTasks: [], ...extra })
  for (const entry of [
    runner('replying', { activeTurn: { turnId: 't' } }),
    runner('background', { backgroundTasks: [{ id: 'b' }] }),
    runner('reported-busy'),
    runner('idle'),
    runner('closed', { closed: true, activeTurn: { turnId: 't' } }),
  ]) backend.runners.set(entry.sessionId, entry)
  backend.claudeSessionStates = new Map([['reported-busy', 'busy'], ['idle', 'idle']])
  assert.deepEqual(backend.activeThreadIds().sort(), ['claude-background', 'claude-replying', 'claude-reported-busy'])
  backend.runners.clear(); backend.dispose()
})

async function withComputerUseRunner(env, run) {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-claude-computer-use-'))
  const configPath = join(directory, 'computer-use.mcp.json')
  await writeFile(configPath, JSON.stringify({ mcpServers: { cua_repl: { command: process.execPath } } }))
  const names = ['CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE', 'CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  Object.assign(process.env, { CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE: configPath, ...env })
  const backend = new ClaudeBackend(join(directory, 'threads.json'), { accountSwitcherPath: null, claudeConfigDir: directory })
  let runnerOptions
  backend.readRuntime = async () => ({ connected: true, account: {}, models: [] })
  backend.sdk = async () => ({
    query: ({ options }) => {
      runnerOptions = options
      let release
      const closed = new Promise((resolve) => { release = resolve })
      return { async *[Symbol.asyncIterator]() { await closed }, close: () => release(), interrupt: async () => {} }
    },
  })
  try {
    const runner = await backend.createRunner(
      'claude-11111111-2222-3333-4444-555555555557',
      '11111111-2222-3333-4444-555555555557',
      { cwd: directory, model: 'claude-default', effort: null, createdAtMs: Date.now() },
      directory,
      `claude-default||${directory}`,
    )
    backend.beginTurn(runner, 'turn-1', directory, null)
    await run({ backend, runnerOptions })
  } finally {
    backend.dispose()
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
    await rm(directory, { recursive: true, force: true })
  }
}

test('gives Claude unattended Mac control when approval is set to never', async () => {
  await withComputerUseRunner({ CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL: 'never' }, async ({ backend, runnerOptions }) => {
    assert.equal(runnerOptions.mcpServers.cua_repl.command, process.execPath)
    assert.equal(runnerOptions.hooks.PreToolUse.some((matcher) => matcher.matcher === 'mcp__cua_repl__js'), false)
    const elicited = await runnerOptions.onElicitation(
      { serverName: 'cua_repl', mode: 'form', message: 'Allow access to Safari?' },
      { signal: new AbortController().signal },
    )
    assert.deepEqual(elicited, { action: 'accept' })
    assert.deepEqual(backend.listPendingServerRequests(), [])
  })
})

test('carries on without an answer after 15 minutes, telling Claude the user is away', async (t) => {
  await withComputerUseRunner({ CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL: 'never' }, async ({ backend, runnerOptions }) => {
    const matcher = runnerOptions.hooks.PreToolUse.find((entry) => entry.matcher === 'AskUserQuestion')
    assert.ok(matcher.timeout * 1000 > 15 * 60_000, "the hook outlasts the wait, or Claude Code's 10-minute default fails the question")
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const result = matcher.hooks[0](
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Ship it?', header: 'Ship', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] } },
      'toolu_away',
      { signal: new AbortController().signal },
    )
    await new Promise((resolve) => setImmediate(resolve))
    const [pending] = backend.listPendingServerRequests()
    assert.equal(Date.parse(pending.params.expiresAtIso) - Date.parse(pending.receivedAtIso), 15 * 60_000, 'the card shows when Claude carries on')
    t.mock.timers.tick(15 * 60_000 - 1)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(backend.listPendingServerRequests().length, 1, 'still waiting just before the deadline')
    let settled = null
    void result.then((value) => { settled = value })
    t.mock.timers.tick(1)
    for (let turn = 0; turn < 5 && !settled; turn += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.ok(settled, 'Claude is told to carry on at the deadline')
    const output = settled.hookSpecificOutput
    assert.equal(output.permissionDecision, 'deny')
    assert.match(output.permissionDecisionReason, /^No answer after 15 minutes; the user is probably away\. Carry on/u)
    assert.deepEqual(backend.listPendingServerRequests(), [], 'the card goes away')
  })
})

test('returns every multi-select pick of a Claude question and passes option previews to the card', async () => {
  await withComputerUseRunner({ CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL: 'never' }, async ({ backend, runnerOptions }) => {
    const matcher = runnerOptions.hooks.PreToolUse.find((entry) => entry.matcher === 'AskUserQuestion')
    const toolInput = { questions: [{ question: 'Which should I clear?', header: 'Cleanup', multiSelect: true, options: [
      { label: 'Worktrees', description: 'Old checkouts', preview: '  a/\n  b/' },
      { label: 'Caches', description: 'Build caches' },
    ] }] }
    const result = matcher.hooks[0](
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: toolInput },
      'toolu_question',
      { signal: new AbortController().signal },
    )
    await new Promise((resolve) => setImmediate(resolve))
    const [pending] = backend.listPendingServerRequests()
    assert.equal(pending.method, 'item/tool/requestUserInput')
    const [question] = pending.params.questions
    assert.equal(question.multiSelect, true)
    assert.equal(question.options[0].preview, '  a/\n  b/')
    assert.equal('preview' in question.options[1], false)
    await backend.respondToServerRequest({ id: pending.id, result: { answers: { q0: { answers: ['Worktrees', 'Caches'] } } } })
    const output = (await result).hookSpecificOutput
    assert.equal(output.permissionDecision, 'allow')
    assert.deepEqual(output.updatedInput.answers, { 'Which should I clear?': 'Worktrees, Caches' })
  })
})

test('starts a Claude chat without Mac control when the computer-use plugin is broken', async () => {
  await withComputerUseRunner({ CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE: '/missing/computer-use.mcp.json', CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL: 'ask' }, async ({ runnerOptions }) => {
    assert.ok(runnerOptions, 'the runner must still start')
    assert.equal(runnerOptions.mcpServers?.cua_repl, undefined)
    assert.equal(runnerOptions.onElicitation, undefined)
  })
})

async function withFakeClaude(script, run) {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-fake-claude-'))
  const executable = join(directory, 'claude')
  await writeFile(executable, script)
  await chmod(executable, 0o700)
  try {
    await run(executable, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('completes Claude login through the persistent CLI auth flow', async () => {
  await withFakeClaude(`#!/bin/sh
printf '%s\\n' 'If the browser did not open, visit: https://claude.com/cai/oauth/authorize?state=expected-state'
IFS= read -r code
[ "$code" = 'authorization-code#pasted-state' ]
`, async (executable, directory) => {
    const previousPath = process.env.CODEXUI_CLAUDE_PATH
    process.env.CODEXUI_CLAUDE_PATH = executable
    try {
      const backend = new ClaudeBackend(join(directory, 'threads.json'), { accountSwitcherPath: null, claudeConfigDir: directory })
      backend.readProviderStatus = async () => ({ id: 'claude', connected: true })
      const login = await backend.startLogin()
      assert.equal(login.authUrl, 'https://claude.com/cai/oauth/authorize?state=expected-state')
      const status = await backend.completeLogin(login.loginId, 'authorization-code#pasted-state')
      assert.equal(status.connected, true)
    } finally {
      if (previousPath === undefined) delete process.env.CODEXUI_CLAUDE_PATH
      else process.env.CODEXUI_CLAUDE_PATH = previousPath
    }
  })
})

test('adding another account saves both logins without signing out, and cancellation releases the login lock', async () => {
  await withFakeClaude(`#!/bin/sh
printf '%s\\n' 'https://claude.com/cai/oauth/authorize?state=fixture'
IFS= read -r code
[ "$code" = 'fixture-code' ]
`, async (executable, directory) => {
    const previousPath = process.env.CODEXUI_CLAUDE_PATH
    process.env.CODEXUI_CLAUDE_PATH = executable
    const backend = new ClaudeBackend(join(directory, 'threads.json'), { accountSwitcherPath: '/fixture/cswap', claudeConfigDir: directory })
    let active = 1
    let saved = 0
    const calls = []
    backend.readProviderStatus = async () => ({ id: 'claude', connected: true })
    backend.runAccountCommand = async (_command, args) => {
      calls.push(args)
      if (args[0] === 'add') { saved += 1; active = saved > 1 ? 2 : 1 }
      return { code: 0, stdout: JSON.stringify({ schemaVersion: 1, accounts: [1, 2].map((number) => ({ number, email: `account${number}@example.test`, active: number === active })) }) }
    }
    backend.runClaudeCommand = async () => { throw new Error('must not revoke a saved login') }
    try {
      const login = await backend.startLogin()
      assert.equal(saved, 1, 'old account backed up before opening the new login')
      assert.equal((await backend.accounts.snapshot()).switching, true)
      await assert.rejects(backend.rpc('turn/start', { threadId: 'claude-fixture', input: [{ type: 'text', text: 'hi' }] }), /Finish or cancel/u)
      await backend.completeLogin(login.loginId, 'fixture-code')
      assert.equal(saved, 2, 'new account automatically registered')
      assert.equal((await backend.accounts.snapshot()).activeAccountNumber, 2)
      const pending = await backend.startLogin()
      backend.cancelLogin()
      assert.equal(backend.login, null)
      await assert.rejects(backend.completeLogin(pending.loginId, 'fixture-code'), /expired/u)
      assert.equal(calls.some((args) => args.includes('logout')), false)
    } finally {
      backend.dispose()
      if (previousPath === undefined) delete process.env.CODEXUI_CLAUDE_PATH
      else process.env.CODEXUI_CLAUDE_PATH = previousPath
    }
  })
})

test('runs Claude in the login-session host and relays stdio and exit status', async () => {
  await withFakeClaude(`#!/bin/sh
IFS= read -r line
printf '%s\\n' "$line" | tr a-z A-Z
printf 'warn\\n' >&2
exit 7
`, async (executable, directory) => {
    const socketPath = join(directory, 'host.sock')
    const server = await startClaudeProcessHost(socketPath)
    try {
      const child = spawnThroughHost(socketPath, { command: executable, args: [], env: { PATH: process.env.PATH } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.stdin.write('hello from the bridge\n')
      child.stdin.end()
      const code = await new Promise((resolve) => child.once('exit', resolve))
      assert.equal(code, 7)
      assert.equal(stdout, 'HELLO FROM THE BRIDGE\n')
      assert.equal(stderr, 'warn\n')

      const refused = spawnThroughHost(socketPath, { command: '/bin/sh', args: ['-c', 'echo nope'], env: {} })
      const failure = await new Promise((resolve) => refused.once('error', resolve))
      assert.match(failure.message, /only starts the Claude CLI/u)
    } finally {
      server.close()
    }
  })
})

test('reports a missing host instead of hanging', async () => {
  const child = spawnThroughHost(join(tmpdir(), `missing-${Date.now()}.sock`), { command: '/usr/bin/claude', args: [], env: {} })
  const failure = await new Promise((resolve) => child.once('error', resolve))
  assert.match(failure.message, /nobody is logged in to this Mac/u)
})

test('gives Claude chats the scheduled-task tool with their own model for new chats', async () => {
  const calls = []
  const tool = createClaudeAutomationTool(() => async (params) => {
    calls.push(params)
    return { contentItems: [{ type: 'inputText', text: 'Created scheduled task "Digest".' }], success: true }
  })
  assert.equal(tool.name, 'automation_update')
  const context = { threadId: 'claude-s1', turnId: 'turn-1', model: 'claude-opus' }
  const text = await tool.handler(context, { action: 'create', task: { kind: 'cron', cwd: '/work', prompt: 'Digest' } })
  assert.equal(text, 'Created scheduled task "Digest".')
  assert.deepEqual(calls[0], {
    threadId: 'claude-s1',
    turnId: 'turn-1',
    arguments: { action: 'create', task: { kind: 'cron', cwd: '/work', prompt: 'Digest', model: 'claude-opus' } },
  })
  await tool.handler(context, { action: 'create', task: { kind: 'heartbeat', prompt: 'Check in' } })
  assert.equal(calls[1].arguments.task.model, undefined)
})

// ── Router ───────────────────────────────────────────────────────────────

test('resumes an unloaded Codex thread and retries the read', async () => {
  const calls = []
  const { codex, claude } = createBackends(async (method, params) => {
    calls.push([method, params])
    if (method === 'thread/read' && calls.filter(([name]) => name === 'thread/read').length === 1) {
      throw new Error('thread not loaded: old-id')
    }
    return { thread: { id: 'old-id' } }
  })
  const result = await new BackendRouter(codex, claude).rpc('thread/read', { threadId: 'old-id', includeTurns: false })
  assert.equal(result.thread.id, 'old-id')
  assert.deepEqual(calls.map(([method]) => method), ['thread/read', 'thread/resume', 'thread/read'])
  assert.deepEqual(calls[1][1], { threadId: 'old-id', excludeTurns: true })
})

test('does not resume on unrelated Codex read failures', async () => {
  const calls = []
  const { codex, claude } = createBackends(async (method) => {
    calls.push(method)
    throw new Error('database unavailable')
  })
  await assert.rejects(
    new BackendRouter(codex, claude).rpc('thread/read', { threadId: 'old-id' }),
    /database unavailable/,
  )
  assert.deepEqual(calls, ['thread/read'])
})

test('keeps Claude ids out of Codex-only ancestry lookups', async () => {
  const calls = []
  const { codex, claude } = createBackends(async (method) => {
    calls.push(method)
    return { data: [{ id: 'unexpected' }], nextCursor: null }
  })
  const result = await new BackendRouter(codex, claude).rpc('thread/list', {
    ancestorThreadId: 'claude-session-id',
    sourceKinds: ['subAgentThreadSpawn'],
  })
  assert.deepEqual(result, { data: [], nextCursor: null })
  assert.deepEqual(calls, [])
})

test('merges chat search results from both backends by recency', async () => {
  const { codex, claude } = createBackends(async () => ({
    data: [{ thread: { id: 'codex-old', updatedAt: 10 }, snippet: 'a' }],
  }), {
    searchThreads: async () => [{ thread: { id: 'claude-new', updatedAt: 20 }, snippet: 'b' }],
  })
  const result = await new BackendRouter(codex, claude).rpc('thread/search', { searchTerm: 'x', limit: 10 })
  assert.deepEqual(result.data.map((row) => row.thread.id), ['claude-new', 'codex-old'])
})

test('offers GPT-6.1 Sol until the local runtime advertises it itself', async () => {
  const baseModel = { id: 'gpt-6-astra', model: 'gpt-6-astra', isDefault: true }
  const claudeModel = { id: 'claude-default', modelProvider: 'anthropic' }
  const { codex, claude } = createBackends(async () => ({ data: [baseModel] }), {
    listModels: async () => [claudeModel],
  })
  const fallback = await new BackendRouter(codex, claude).rpc('model/list', {})
  assert.deepEqual(fallback.data.map((model) => model.id), ['gpt-6-astra', 'gpt-6.1-sol', 'claude-default'])
  assert.deepEqual(
    fallback.data[1].supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  )
  assert.equal(fallback.data[1].defaultReasoningEffort, 'medium')

  codex.rpc = async () => ({ data: [baseModel, { ...fallback.data[1], displayName: 'Runtime GPT-6.1 Sol' }] })
  const advertised = await new BackendRouter(codex, claude).rpc('model/list', {})
  assert.deepEqual(advertised.data.map((model) => model.id), ['gpt-6-astra', 'gpt-6.1-sol', 'claude-default'])
  assert.equal(advertised.data[1].displayName, 'Runtime GPT-6.1 Sol', 'runtime metadata replaces the compatibility entry')
})

test('routes question answers to the backend that asked', async () => {
  const answered = []
  const { codex, claude } = createBackends(async () => ({}), {
    ownsServerRequest: (id) => id === 1_700_000_001,
    respondToServerRequest: async (payload) => { answered.push(['claude', payload.id]) },
    listPendingServerRequests: () => [{ id: 1_700_000_001, method: 'item/tool/requestUserInput', params: {}, receivedAtIso: '' }],
  })
  codex.respondToServerRequest = async (payload) => { answered.push(['codex', payload.id]) }
  codex.listPendingServerRequests = () => [{ id: 4 }]
  const router = new BackendRouter(codex, claude)
  await router.respondToServerRequest({ id: 1_700_000_001, result: {} })
  await router.respondToServerRequest({ id: 4, result: {} })
  assert.deepEqual(answered, [['claude', 1_700_000_001], ['codex', 4]])
  assert.deepEqual(router.listPendingServerRequests().map((row) => row.id), [4, 1_700_000_001])
})

test('sends Claude skill lookups to Claude', async () => {
  const { codex, claude } = createBackends(async () => { throw new Error('codex should not be asked') }, {
    listSkills: async (cwd) => ({ data: [{ cwd, skills: [{ name: 'review' }], errors: [] }] }),
  })
  const result = await new BackendRouter(codex, claude).rpc('skills/list', { provider: 'claude', cwds: ['/work'] })
  assert.equal(result.data[0].cwd, '/work')
})
