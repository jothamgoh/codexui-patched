import assert from 'node:assert/strict'
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

const { ClaudeBackend, isClaudeModelId, normalizeClaudeUsage, runtimeModel } = await loadModule('../src/server/claudeBackend.ts')
const { BackendRouter } = await loadModule('../src/server/backendRouter.ts')
const transcript = await loadModule('../src/server/claudeTranscript.ts')
const { startClaudeProcessHost, spawnThroughHost } = await loadModule('../src/server/claudeProcessHost.ts')
const { scanClaudeSessionRegistry } = await loadModule('../src/server/claudeSessionRegistry.ts')
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
  process.env.CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE = configPath
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
    await rm(directory, { recursive: true, force: true })
  }
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
      return { async *[Symbol.asyncIterator]() {}, close: () => {}, interrupt: async () => {} }
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

test('starts a Claude chat without Mac control when the computer-use plugin is broken', async () => {
  await withComputerUseRunner({ CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE: '/missing/computer-use.mcp.json' }, async ({ runnerOptions }) => {
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
  assert.match(failure.message, /session host is not running/u)
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
