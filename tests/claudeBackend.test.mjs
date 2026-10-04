import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const bundleDir = await mkdtemp(join(tmpdir(), 'codexui-claude-test-'))
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
    external: ['@anthropic-ai/claude-agent-sdk'],
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

const { ClaudeBackend, isClaudeModelId, normalizeClaudeUsage, runtimeModel } = await loadModule('../src/server/claudeBackend.ts')
const { BackendRouter } = await loadModule('../src/server/backendRouter.ts')
const transcript = await loadModule('../src/server/claudeTranscript.ts')
const { startClaudeProcessHost, spawnThroughHost } = await loadModule('../src/server/claudeProcessHost.ts')
const { buildReviewChanges } = await loadModule('../src/utils/reviewDiff.ts')

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
      const backend = new ClaudeBackend(join(directory, 'threads.json'))
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
  assert.match(failure.message, /session host is not running/u)
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
