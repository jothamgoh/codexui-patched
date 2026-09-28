import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(sourcePath, replacements = []) {
  let source = await readFile(sourcePath, 'utf8')
  for (const [search, replacement] of replacements) source = source.replace(search, replacement)
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const claudeModule = await loadTypeScriptModule(new URL('../src/server/claudeBackend.ts', import.meta.url))
const { isClaudeModelId, normalizeClaudeUsage, runtimeModel } = claudeModule

const routerModule = await loadTypeScriptModule(
  new URL('../src/server/backendRouter.ts', import.meta.url),
  [[
    "import { isClaudeModelId, isClaudeThreadId } from './claudeBackend'",
    `const isClaudeThreadId = (value) => typeof value === 'string' && value.startsWith('claude-')
const isClaudeModelId = (value) => typeof value === 'string' && value.startsWith('claude-')`,
  ]],
)
const { BackendRouter } = routerModule

function createBackends(rpc) {
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
    dispose: () => {},
  }
  return { codex, claude }
}

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
