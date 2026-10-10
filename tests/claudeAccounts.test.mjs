import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const cache = new URL('../node_modules/.cache/', import.meta.url).pathname
await mkdir(cache, { recursive: true })
const directory = await mkdtemp(join(cache, 'claude-accounts-test-'))
test.after(() => rm(directory, { recursive: true, force: true }))
async function load(path) {
  const outfile = join(directory, path.replace(/\W/gu, '_') + '.mjs')
  await build({ entryPoints: [new URL(path, import.meta.url).pathname], outfile, bundle: true, platform: 'node', format: 'esm', external: ['@anthropic-ai/claude-agent-sdk', 'zod'], logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
const { ClaudeAccountSwitcher, parseCSwapAccounts, CLAUDE_CSWAP_CHECK_MS } = await load('../src/server/claudeAccountSwitcher.ts')
const { ClaudeBackend, isClaudeHardLimitError } = await load('../src/server/claudeBackend.ts')
const { isAllowedClaudeHostRequest, startClaudeProcessHost, spawnThroughHost } = await load('../src/server/claudeProcessHost.ts')

function rows(active = 1, percent = 95) {
  return [1, 2, 3].map((number) => ({ number, email: `account${number}@example.test`, active: active === number, usageStatus: 'ok', usage: { fiveHour: { pct: number === 1 ? percent : 20 }, sevenDay: { pct: 30 } } }))
}
async function fixture(options = {}) {
  const scratch = await mkdtemp(join(directory, 'case-'))
  let active = 1
  let busy = false
  let authenticating = false
  let accounts = rows()
  let now = Date.now()
  const calls = []
  let keepBusy = false
  const run = async (_command, args) => {
    calls.push(args)
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ schemaVersion: 1, accounts: accounts.map((row) => ({ ...row, active: row.number === active })) }) }
    assert.equal(busy && !keepBusy, false, 'only a hard-limit recovery may change credentials during an active reply')
    if (args[0] === 'switch') active = Number(args[1])
    if (args[0] === 'auto') active = 2
    if (args[0] === 'remove') accounts = accounts.filter((account) => account.number !== Number(args[1]))
    if (args[0] === 'disable') accounts = accounts.map((account) => account.number === Number(args[1]) ? { ...account, disabled: true } : account)
    if (args[0] === 'enable') accounts = accounts.map((account) => account.number === Number(args[1]) ? { ...account, disabled: false } : account)
    return { code: 0, stdout: '{}' }
  }
  const manager = new ClaudeAccountSwitcher({ stateFilePath: join(scratch, 'settings.json'), executable: '/fixture/cswap', run, isBusy: () => busy, isAuthenticating: () => authenticating, prepareSwitch: async (prepare) => { keepBusy = Boolean(prepare?.keepBusy); calls.push(keepBusy ? ['prepare', 'keepBusy'] : ['prepare']) }, accountChanged: () => calls.push(['changed']), now: () => now, ...options })
  return { manager, scratch, calls, run, advance: (ms) => { now += ms }, setBusy: (next) => { busy = next }, setAuthenticating: (next) => { authenticating = next }, setRows: (next) => { accounts = next } }
}

test('HTTP account metadata excludes credentials, invalid JSON never leaks the original output', () => {
  const source = { schemaVersion: 1, token: 'TOP_SECRET', accounts: [{ ...rows()[0], credentials: { token: 'TOP_SECRET' }, usage: { fiveHour: { pct: 120, resetsAt: 'later', token: 'TOP_SECRET' } } }] }
  const result = parseCSwapAccounts(JSON.stringify(source))
  assert.equal(result.active, 1)
  assert.equal(result.accounts[0].limits[0].usedPercent, 100)
  assert.equal(JSON.stringify(result).includes('TOP_SECRET'), false)
  assert.throws(() => parseCSwapAccounts('{"token":"TOP_SECRET"'), (error) => !error.message.includes('TOP_SECRET'))
})

test('only provider hard-limit messages trigger account recovery', () => {
  assert.equal(isClaudeHardLimitError("You've hit your session limit · resets 9:20pm"), true)
  assert.equal(isClaudeHardLimitError('Your weekly limit has been reached'), true)
  assert.equal(isClaudeHardLimitError('HTTP 429 while refreshing usage'), false)
  assert.equal(isClaudeHardLimitError('Context window limit reached'), false)
})

test('manual selection queues during a reply, blocks new chats, then takes priority over auto', async () => {
  const f = await fixture()
  f.setBusy(true)
  assert.equal((await f.manager.requestSwitch(3)).pendingAccountNumber, 3)
  assert.equal(f.calls.some((args) => args[0] === 'switch'), false)
  await assert.rejects(f.manager.exclusive(() => f.manager.beforeTurn()), /queued/u)
  f.setBusy(false)
  await f.manager.tick()
  assert.equal((await f.manager.snapshot()).activeAccountNumber, 3)
  assert.deepEqual(f.calls.filter((args) => ['prepare', 'switch', 'changed'].includes(args[0])), [['prepare'], ['switch', '3', '--json'], ['changed']])
  await f.manager.tick()
  assert.equal(f.calls.some((args) => args[0] === 'auto'), false)
  f.manager.dispose()
})

test('account switching waits for asynchronously detected Remote Control work', async () => {
  let remoteBusy = true
  const f = await fixture({ isBusy: async () => remoteBusy })
  assert.equal((await f.manager.requestSwitch(2)).pendingAccountNumber, 2)
  assert.equal(f.calls.some((args) => args[0] === 'switch'), false)
  remoteBusy = false
  await f.manager.tick()
  assert.equal((await f.manager.snapshot()).activeAccountNumber, 2)
  f.manager.dispose()
})

test('a hard limit switches to the enabled account with the most quota', async () => {
  const f = await fixture()
  f.setRows([
    ...rows(1, 100).slice(0, 1),
    { ...rows()[1], usage: { fiveHour: { pct: 8 }, sevenDay: { pct: 10 } } },
    { ...rows()[2], usage: { fiveHour: { pct: 3 }, sevenDay: { pct: 5 } } },
  ])
  const recovery = await f.manager.recoverFromLimit(1, [1])
  assert.deepEqual(recovery, { kind: 'ready', accountNumber: 3 })
  assert.deepEqual(f.calls.filter((args) => ['prepare', 'switch', 'changed'].includes(args[0])), [['prepare', 'keepBusy'], ['switch', '3', '--json'], ['changed']])
  assert.match((await f.manager.snapshot()).notice, /continuing the reply/u)
  f.manager.dispose()
})

test('hard-limit recovery switches even while other Claude work, such as a background task, is running', { timeout: 5000 }, async () => {
  const f = await fixture()
  f.setRows(rows(1, 100))
  f.setBusy(true)
  assert.deepEqual(await f.manager.recoverFromLimit(1, [1]), { kind: 'ready', accountNumber: 2 })
  assert.deepEqual(f.calls.filter((args) => args[0] === 'prepare'), [['prepare', 'keepBusy']], 'busy Claude processes are kept, not refused or killed')
  f.manager.dispose()
})

test('hard-limit recovery still waits for a Claude sign-in to finish', async () => {
  const f = await fixture()
  f.setRows(rows(1, 100))
  f.setAuthenticating(true)
  const recovery = f.manager.recoverFromLimit(1, [1])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.some((args) => args[0] === 'switch'), false)
  assert.match((await f.manager.snapshot()).notice, /waiting for Claude sign-in/u)
  f.setAuthenticating(false)
  await f.manager.tick()
  assert.deepEqual(await recovery, { kind: 'ready', accountNumber: 2 })
  f.manager.dispose()
})

test('a queued manual switch is applied during hard-limit recovery despite busy work', async () => {
  const f = await fixture()
  f.setRows(rows(1, 100))
  f.setBusy(true)
  assert.equal((await f.manager.requestSwitch(3)).pendingAccountNumber, 3)
  assert.deepEqual(await f.manager.recoverFromLimit(1, [1]), { kind: 'ready', accountNumber: 3 })
  f.manager.dispose()
})

test('auto delegates quota and unknown-usage decisions to cswap only when idle and enabled', async () => {
  const f = await fixture()
  f.setBusy(true)
  await f.manager.tick()
  assert.equal(f.calls.length, 0)
  f.setBusy(false)
  f.setRows(rows().map((row) => ({ ...row, usageStatus: 'unavailable' })))
  await f.manager.tick()
  assert.deepEqual(f.calls.find((args) => args[0] === 'auto'), ['auto', '--once', '--json', '--threshold', '90'])
  assert.deepEqual(f.calls.filter((args) => args[0] === 'prepare'), [['prepare']])
  f.setRows(rows())
  f.advance(CLAUDE_CSWAP_CHECK_MS + 1)
  await f.manager.configure(false, 90)
  const autoCalls = f.calls.filter((args) => args[0] === 'auto').length
  await f.manager.tick()
  assert.equal(f.calls.filter((args) => args[0] === 'auto').length, autoCalls)
  await f.manager.configure(true, 90)
  await f.manager.tick()
  assert.equal(f.calls.filter((args) => args[0] === 'auto').length, autoCalls + 1)
  assert.equal((await f.manager.snapshot()).activeAccountNumber, 2)
  f.manager.dispose()
})

test('a cswap no-action result does not close idle Claude processes', async () => {
  let f
  f = await fixture({ run: async (_command, args) => {
    f.calls.push(args)
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ schemaVersion: 1, accounts: rows() }) }
    return { code: 2, stdout: '{}' }
  } })
  await f.manager.tick()
  assert.equal(f.calls.some((args) => args[0] === 'auto'), true)
  assert.equal(f.calls.some((args) => args[0] === 'prepare'), false)
  assert.equal(f.calls.some((args) => args[0] === 'changed'), false)
  f.manager.dispose()
})

test('switch settings persist privately and invalid thresholds cannot change them', async () => {
  const f = await fixture()
  await f.manager.configure(false, 95)
  assert.deepEqual(JSON.parse(await readFile(join(f.scratch, 'settings.json'), 'utf8')), { enabled: false, threshold: 95 })
  assert.equal((await stat(join(f.scratch, 'settings.json'))).mode & 0o777, 0o600)
  await assert.rejects(f.manager.configure(true, 100), /50% and 99%/u)
  const restored = new ClaudeAccountSwitcher({ stateFilePath: join(f.scratch, 'settings.json'), executable: null, run: f.run, isBusy: () => false, prepareSwitch: async () => {}, accountChanged: () => {} })
  assert.equal((await restored.snapshot()).enabled, false)
  assert.equal((await restored.snapshot()).threshold, 95)
  restored.dispose(); f.manager.dispose()
})

test('login prevents background token reads and account switching', async () => {
  const f = await fixture()
  await f.manager.snapshot()
  const count = f.calls.length
  f.setAuthenticating(true)
  assert.equal((await f.manager.snapshot(true)).switching, true)
  assert.equal(f.calls.length, count)
  await assert.rejects(f.manager.requestSwitch(2), /Finish or cancel/u)
  f.manager.dispose()
})

test('turn-start lock drains before a queued credential mutation', async () => {
  const f = await fixture()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const start = f.manager.exclusive(async () => { await gate; f.setBusy(true) })
  const switching = f.manager.requestSwitch(2)
  release()
  await start
  assert.equal((await switching).pendingAccountNumber, 2)
  assert.equal(f.calls.some((args) => args[0] === 'switch'), false)
  f.setBusy(false)
  await f.manager.tick()
  assert.equal((await f.manager.snapshot()).activeAccountNumber, 2)
  f.manager.dispose()
})

test('all accounts unavailable produces an actionable notice without replaying a turn', async () => {
  const f = await fixture({ run: async (_command, args) => args[0] === 'list' ? { code: 0, stdout: JSON.stringify({ schemaVersion: 1, accounts: rows() }) } : { code: 3, stdout: '{}' } })
  await f.manager.tick()
  const state = await f.manager.snapshot()
  assert.match(state.notice, /No saved account is ready/u)
  assert.equal(state.activeAccountNumber, 1)
  f.manager.dispose()
})

test('switch closes idle Claude processes while preserving saved chat and folder history', async () => {
  const f = await fixture()
  const backend = new ClaudeBackend(join(f.scratch, 'threads.json'), {
    accountSwitcherPath: '/fixture/cswap',
    claudeConfigDir: join(f.scratch, 'claude'),
  })
  backend.runAccountCommand = f.run
  backend.readRuntime = async () => ({ connected: true, account: {}, models: [] })
  const session = 'session-that-must-stay'
  await backend.store.update(session, { cwd: '/work/project', model: 'claude-sonnet', effort: 'low', createdAtMs: 1 })
  await backend.store.writeChain
  let closed = 0
  const old = { sessionId: session, threadId: `claude-${session}`, activeTurn: null, pushedCommands: new Map(), backgroundTasks: [], closed: false, query: { close: () => { closed += 1 } }, input: { release: () => {} } }
  backend.runners.set(session, old)
  const before = await readFile(join(f.scratch, 'threads.json'), 'utf8')
  await backend.accounts.requestSwitch(2)
  assert.equal(closed, 1)
  assert.equal(backend.runners.size, 0)
  assert.equal(await readFile(join(f.scratch, 'threads.json'), 'utf8'), before)
  let resumed
  backend.createRunner = async (threadId, sessionId, stored, cwd, settingsKey) => {
    resumed = { threadId, sessionId, cwd, stored }
    const runner = { ...old, query: {}, closed: false, cwd, settingsKey, totalUsage: {}, contextWindow: 200000, input: { push: () => true }, activeTurn: null, pushedCommands: new Map() }
    backend.runners.set(sessionId, runner)
    return runner
  }
  await backend.rpc('turn/start', { threadId: `claude-${session}`, input: [{ type: 'text', text: 'continue' }] })
  assert.equal(resumed.sessionId, session)
  assert.equal(resumed.cwd, '/work/project')
  assert.equal(resumed.stored.model, 'claude-sonnet')
  await backend.store.writeChain
  backend.runners.clear(); backend.dispose(); f.manager.dispose()
})

test('Claude host only permits the supported cswap operations', async () => {
  const executable = join(directory, 'cswap')
  await writeFile(executable, '#!/bin/sh\nprintf \'{"schemaVersion":1,"accounts":[]}\\n\'\n')
  await chmod(executable, 0o700)
  for (const args of [['add'], ['remove', '2'], ['disable', '2'], ['enable', '2'], ['list', '--json'], ['switch', '2', '--json'], ['auto', '--once', '--json', '--threshold', '90']]) assert.equal(isAllowedClaudeHostRequest(executable, args), true)
  for (const args of [['export'], ['import', '/tmp/secrets'], ['add', '--token', 'secret'], ['disable', '2;evil'], ['enable', '0'], ['auto'], ['auto', '--once', '--json', '--threshold', '100'], ['switch', '2;evil', '--json']]) assert.equal(isAllowedClaudeHostRequest(executable, args), false)
  const socketDirectory = await mkdtemp('/tmp/codexui-accounts-')
  const socketPath = join(socketDirectory, 'host.sock')
  const server = await startClaudeProcessHost(socketPath)
  try {
    const child = spawnThroughHost(socketPath, { command: executable, args: ['list', '--json'], env: {} })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stdin.end()
    assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 0)
    assert.deepEqual(JSON.parse(stdout), { schemaVersion: 1, accounts: [] })
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(socketDirectory, { recursive: true, force: true }) }
})

test('refresh clicks and many tabs share a one-minute cswap snapshot', async () => {
  const f = await fixture()
  await Promise.all(Array.from({ length: 12 }, () => f.manager.snapshot(true)))
  assert.equal(f.calls.filter((args) => args[0] === 'list').length, 1)
  await f.manager.tick()
  const afterSwitch = f.calls.filter((args) => args[0] === 'list').length
  await Promise.all(Array.from({ length: 12 }, () => f.manager.snapshot(true)))
  assert.equal(f.calls.filter((args) => args[0] === 'list').length, afterSwitch)
  f.advance(CLAUDE_CSWAP_CHECK_MS + 1)
  await f.manager.snapshot(true)
  assert.equal(f.calls.filter((args) => args[0] === 'list').length, afterSwitch + 1)
  f.manager.dispose()
})

test('429 preserves cached bars while cswap remains responsible for its retry deadline', async () => {
  let f
  f = await fixture({ run: async (_command, args) => {
    f.calls.push(args)
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ schemaVersion: 1, accounts: f.rateLimited ? rows().map((row) => ({ ...row, usage: null, usageStatus: 'unavailable', usageError: 'http-429', usageRetryAt: f.deadline })) : rows() }) }
    return { code: 2, stdout: '{}' }
  } })
  f.rateLimited = false
  f.deadline = new Date(Date.now() + 90 * 60_000).toISOString()
  const first = await f.manager.snapshot()
  f.rateLimited = true
  f.advance(CLAUDE_CSWAP_CHECK_MS + 1)
  const fallback = await f.manager.snapshot(true)
  assert.deepEqual(fallback.accounts[0].limits, first.accounts[0].limits)
  assert.equal(fallback.accounts[0].usageIsStale, true)
  assert.equal(fallback.accounts[0].usageRateLimited, true)
  assert.ok(Date.parse(fallback.nextCheckAt) < Date.parse(f.deadline))
  assert.match(fallback.notice, /rate limited/u)
  const listCalls = f.calls.filter((args) => args[0] === 'list').length
  await f.manager.tick()
  await f.manager.snapshot(true)
  f.advance(CLAUDE_CSWAP_CHECK_MS + 1)
  await f.manager.snapshot(true)
  assert.equal(f.calls.filter((args) => args[0] === 'list').length, listCalls + 1)
  f.manager.dispose()
})

test('account removal waits for replies and removes only the saved login', async () => {
  const f = await fixture()
  f.setBusy(true)
  await assert.rejects(f.manager.removeAccount(2), /Wait for Claude replies/u)
  f.setBusy(false)
  const state = await f.manager.removeAccount(2)
  assert.deepEqual(state.accounts.map((account) => account.number), [1, 3])
  assert.equal(state.activeAccountNumber, 1)
  assert.deepEqual(f.calls.find((args) => args[0] === 'remove'), ['remove', '2'])
  assert.equal(f.calls.some((args) => args[0] === 'prepare'), false)
  f.manager.dispose()
})

test('accounts can be excluded from and restored to automatic switching without changing the active login', async () => {
  const f = await fixture()
  const excluded = await f.manager.setAccountEnabled(2, false)
  assert.equal(excluded.accounts.find((account) => account.number === 2).disabled, true)
  assert.equal(excluded.activeAccountNumber, 1)
  assert.deepEqual(f.calls.find((args) => args[0] === 'disable'), ['disable', '2'])
  assert.equal(f.calls.some((args) => args[0] === 'prepare'), false)
  assert.equal(f.calls.some((args) => args[0] === 'changed'), false)

  const restored = await f.manager.setAccountEnabled(2, true)
  assert.equal(restored.accounts.find((account) => account.number === 2).disabled, false)
  assert.equal(restored.activeAccountNumber, 1)
  assert.deepEqual(f.calls.find((args) => args[0] === 'enable'), ['enable', '2'])
  await assert.rejects(f.manager.setAccountEnabled(99, false), /no longer available/u)
  await assert.rejects(f.manager.setAccountEnabled(2, 'yes'), /whether it can be used/u)
  f.manager.dispose()
})

test('active usage card reuses cswap data without querying the SDK usage endpoint', async () => {
  const f = await fixture()
  const backend = new ClaudeBackend(join(f.scratch, 'threads.json'), {
    accountSwitcherPath: '/fixture/cswap',
    claudeConfigDir: join(f.scratch, 'claude'),
  })
  backend.runAccountCommand = f.run
  backend.readRuntime = async () => ({ connected: true, account: { apiProvider: 'firstParty' }, models: [] })
  backend.sdk = () => { throw new Error('duplicate collector is forbidden') }
  const usage = await backend.readUsage(true)
  assert.equal(usage.limits[0].usedPercent, 95)
  await backend.readUsage(true)
  assert.equal(f.calls.length, 1)
  backend.dispose(); f.manager.dispose()
})

test('SDK-only usage fallback keeps cached limits after 429 and refresh cannot bypass Retry-After', async () => {
  const scratch = await mkdtemp(join(directory, 'sdk-cache-'))
  const backend = new ClaudeBackend(join(scratch, 'threads.json'), { accountSwitcherPath: null, claudeConfigDir: join(scratch, 'claude') })
  backend.readRuntime = async () => ({ connected: true, account: { apiProvider: 'firstParty' }, models: [] })
  let calls = 0
  backend.sdk = async () => ({ query: () => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { calls += 1; throw Object.assign(new Error('HTTP 429'), { status: 429, headers: { 'retry-after': '7200' } }) },
    close: () => {},
  }) })
  backend.usageCache = { at: Date.now(), value: { plan: 'team', limits: [{ key: 'five_hour', label: '5 hours', usedPercent: 15, resetsAt: null }] } }
  const fallback = await backend.readUsage(true)
  assert.equal(fallback.limits[0].usedPercent, 15)
  assert.match(fallback.notice, /429/u)
  assert.ok(backend.usageNextReadAt >= Date.now() + 7199_000)
  await Promise.all([backend.readUsage(true), backend.readUsage(true)])
  assert.equal(calls, 1)
  backend.dispose()
})

test('background tasks keep the Claude process alive and block account changes until they end', async () => {
  const f = await fixture()
  const backend = new ClaudeBackend(join(f.scratch, 'threads.json'), {
    accountSwitcherPath: '/fixture/cswap',
    claudeConfigDir: join(f.scratch, 'claude'),
  })
  backend.runAccountCommand = f.run
  backend.refreshClaudeSessionStates = async () => ({ uncertain: false, states: new Map() })
  const session = 'session-with-background-work'
  const runner = { sessionId: session, threadId: `claude-${session}`, activeTurn: null, pushedCommands: new Map(), backgroundTasks: [], idleTimer: null, closed: false, query: { close: () => {} }, input: { release: () => {} } }
  backend.runners.set(session, runner)
  const updates = []
  backend.onNotification((notification) => {
    if (notification.method === 'thread/backgroundTasks/updated') updates.push(notification.params)
  })
  const changed = (tasks) => backend.handleMessage(runner, { type: 'system', subtype: 'background_tasks_changed', tasks, uuid: 'u', session_id: session })

  changed([
    { task_id: 'b1', task_type: 'local_bash', description: 'npm run build' },
    { task_id: 'w1', task_type: 'monitor', description: 'file watcher', ambient: true },
  ])
  assert.deepEqual(updates.at(-1), { threadId: `claude-${session}`, tasks: [{ id: 'b1', type: 'local_bash', description: 'npm run build' }] })
  backend.scheduleIdleClose(runner)
  assert.equal(runner.idleTimer, null, 'a reply ending must not start the idle close while work runs')
  await assert.rejects(backend.prepareAccountChange(), /Wait for Claude replies/u)

  changed([])
  assert.deepEqual(updates.at(-1).tasks, [])
  assert.notEqual(runner.idleTimer, null, 'the idle close starts once the last task ends')
  clearTimeout(runner.idleTimer)
  backend.runners.clear(); backend.dispose(); f.manager.dispose()
})

test('a hard-limit result retires its background work, switches accounts, and continues the same Claude chat', async () => {
  const f = await fixture()
  const backend = new ClaudeBackend(join(f.scratch, 'threads.json'), {
    accountSwitcherPath: '/fixture/cswap',
    claudeConfigDir: join(f.scratch, 'claude'),
  })
  backend.runAccountCommand = f.run
  backend.refreshClaudeSessionStates = async () => ({ uncertain: false, states: new Map() })
  const session = 'session-that-hit-the-limit'
  let closes = 0
  let releases = 0
  const runner = {
    sessionId: session,
    threadId: `claude-${session}`,
    cwd: '/work/project',
    settingsKey: 'claude-sonnet|low|/work/project',
    activeTurn: null,
    pushedCommands: new Map(),
    backgroundTasks: [{ id: 'watcher', type: 'local_bash', description: 'tail -F pipeline.log' }],
    idleTimer: null,
    interruptTimer: null,
    closed: false,
    totalUsage: {},
    contextWindow: 200000,
    query: { close: () => { closes += 1 } },
    input: { release: () => { releases += 1 } },
  }
  backend.runners.set(session, runner)
  await backend.accounts.snapshot()
  const resumed = new Promise((resolve) => {
    backend.startTurn = async (request, extra) => {
      resolve({ request, extra })
      return {}
    }
  })
  backend.beginTurn(runner, 'turn-at-limit', runner.cwd, null)
  backend.handleMessage(runner, {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ["You've hit your session limit · resets 9:20pm (Asia/Singapore)"],
  })
  const continuation = await resumed
  assert.equal(continuation.request.threadId, `claude-${session}`)
  assert.match(continuation.request.input[0].text, /Continue where you left off/u)
  assert.deepEqual(continuation.extra.limitRecoveryAccountNumbers, [1])
  assert.equal(runner.activeTurn, null)
  assert.equal(runner.closed, true)
  assert.deepEqual(runner.backgroundTasks, [])
  assert.equal(backend.runners.has(session), false)
  assert.equal(closes, 1)
  assert.equal(releases, 1)
  assert.deepEqual(f.calls.find((args) => args[0] === 'switch'), ['switch', '2', '--json'])
  backend.dispose(); f.manager.dispose()
})

test('a limit switch keeps busy Claude chats running and blames their later limit on their own account', async () => {
  const f = await fixture()
  const backend = new ClaudeBackend(join(f.scratch, 'threads.json'), {
    accountSwitcherPath: '/fixture/cswap',
    claudeConfigDir: join(f.scratch, 'claude'),
  })
  const closed = []
  const runnerFor = (session, extra) => ({
    sessionId: session, threadId: `claude-${session}`, cwd: '/work/project', accountNumber: 1,
    activeTurn: null, pushedCommands: new Map(), backgroundTasks: [], idleTimer: null, closed: false,
    totalUsage: {}, contextWindow: 200000, input: { release: () => {} },
    query: { close: () => closed.push(session), interrupt: async () => {} },
    ...extra,
  })
  const withBackgroundTask = runnerFor('with-background-task', { backgroundTasks: [{ id: 'task-1', description: 'long build' }] })
  const idle = runnerFor('idle')
  backend.runners.set(withBackgroundTask.sessionId, withBackgroundTask)
  backend.runners.set(idle.sessionId, idle)
  backend.refreshClaudeSessionStates = async () => ({ uncertain: false, states: new Map() })

  await assert.rejects(backend.prepareAccountChange(), /Wait for Claude replies/u, 'ordinary switches still wait')
  await backend.prepareAccountChange({ keepBusy: true })
  assert.equal(backend.runners.has('with-background-task'), true, 'the background task keeps running')
  assert.equal(backend.runners.has('idle'), false, 'idle processes restart on the new login')
  assert.deepEqual(closed, ['idle'])

  backend.accounts.activeAccountNumber = () => 2
  backend.accounts.tick = async () => {}
  const exhausted = new Promise((resolve) => {
    backend.accounts.recoverFromLimit = async (accountNumber) => {
      resolve(accountNumber)
      return { kind: 'blocked', reason: 'no-account' }
    }
  })
  const turn = backend.beginTurn(withBackgroundTask, 'turn-on-old-login', withBackgroundTask.cwd, null)
  backend.failTurn(withBackgroundTask, turn, "You've hit your session limit · resets 2:30am")
  assert.equal(await exhausted, 1, 'the old login is the exhausted one, not the newly active account 2')
  backend.dispose(); f.manager.dispose()
})

test('a hard-limit exception from the Claude SDK uses the same continuation path', async () => {
  const f = await fixture()
  const backend = new ClaudeBackend(join(f.scratch, 'threads.json'), {
    accountSwitcherPath: '/fixture/cswap',
    claudeConfigDir: join(f.scratch, 'claude'),
  })
  const session = 'session-whose-sdk-threw-the-limit'
  const runner = {
    sessionId: session,
    threadId: `claude-${session}`,
    cwd: '/work/project',
    settingsKey: 'claude-sonnet|low|/work/project',
    activeTurn: null,
    pushedCommands: new Map(),
    backgroundTasks: [],
    idleTimer: null,
    interruptTimer: null,
    closed: false,
    totalUsage: {},
    contextWindow: 200000,
    query: {
      async *[Symbol.asyncIterator]() {
        throw new Error("Claude Code returned an error result: You've hit your session limit · resets 2:30am (Asia/Singapore)")
      },
      close: () => {},
    },
    input: { release: () => {} },
  }
  backend.runners.set(session, runner)
  backend.accounts.activeAccountNumber = () => 2
  backend.accounts.tick = async () => {}
  backend.accounts.recoverFromLimit = async () => ({ kind: 'ready', accountNumber: 3 })
  const resumed = new Promise((resolve) => {
    backend.startTurn = async (request) => {
      resolve(request)
      return {}
    }
  })
  backend.beginTurn(runner, 'turn-with-thrown-limit', runner.cwd, null)
  await backend.consumeRunner(runner)
  assert.match((await resumed).input[0].text, /Continue where you left off/u)
  assert.equal(runner.activeTurn, null)
  backend.dispose(); f.manager.dispose()
})

test('a chat the previous server was running can be continued at once, unlike one active elsewhere', async () => {
  const f = await fixture()
  const configDir = join(f.scratch, 'claude')
  const backend = new ClaudeBackend(join(f.scratch, 'threads.json'), { accountSwitcherPath: '/fixture/cswap', claudeConfigDir: configDir })
  backend.runAccountCommand = f.run
  backend.readRuntime = async () => ({ connected: true, account: {}, models: [] })
  backend.refreshClaudeSessionStates = async () => ({ uncertain: false, states: new Map() })
  const cwd = '/work/project'
  const session = 'interrupted-by-restart'
  await backend.store.update(session, { cwd, model: 'claude-sonnet', effort: 'low', createdAtMs: 1 })
  const projectDir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/gu, '-'))
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, `${session}.jsonl`), '')
  backend.createRunner = async (threadId, sessionId, stored, runnerCwd, settingsKey) => {
    const runner = { sessionId, threadId, cwd: runnerCwd, settingsKey, query: {}, closed: false, totalUsage: {}, contextWindow: 200000, input: { push: () => true }, activeTurn: null, pushedCommands: new Map(), backgroundTasks: [], idleTimer: null }
    backend.runners.set(sessionId, runner)
    return runner
  }
  const send = () => backend.rpc('turn/start', { threadId: `claude-${session}`, input: [{ type: 'text', text: 'continue' }] })
  await assert.rejects(send(), /active in another app/u, 'a chat written moments ago by an unknown process is refused')
  backend.adoptInterruptedSession(`claude-${session}`)
  await send()
  assert.equal(backend.runners.has(session), true)
  await backend.store.writeChain
  backend.runners.clear(); backend.dispose(); f.manager.dispose()
})

test('a refused send to a Claude session running in another app does not list it as a CodexUI chat', async () => {
  const f = await fixture()
  const backend = new ClaudeBackend(join(f.scratch, 'threads.json'), { accountSwitcherPath: '/fixture/cswap', claudeConfigDir: join(f.scratch, 'claude') })
  backend.runAccountCommand = f.run
  backend.readRuntime = async () => ({ connected: true, account: {}, models: [] })
  const session = 'pipeline-job-in-terminal'
  backend.refreshClaudeSessionStates = async () => {
    backend.claudeSessionStates = new Map([[session, 'busy']])
    return { uncertain: false, states: backend.claudeSessionStates }
  }
  await assert.rejects(
    backend.rpc('turn/start', { threadId: `claude-${session}`, input: [{ type: 'text', text: 'continue' }] }),
    /active in another app/u,
  )
  assert.equal(await backend.store.get(session), undefined)
  assert.equal(await backend.isListedChat(`claude-${session}`), false, 'restart recovery skips it')
  await backend.store.update('codexui-chat', { cwd: '/w', createdAtMs: 1 })
  assert.equal(await backend.isListedChat('claude-codexui-chat'), true)
  await backend.store.update('codexui-chat', { archived: true })
  assert.equal(await backend.isListedChat('claude-codexui-chat'), false)
  await backend.store.writeChain
  backend.runners.clear(); backend.dispose(); f.manager.dispose()
})
