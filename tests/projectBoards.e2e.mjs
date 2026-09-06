import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, webkit, devices } from 'playwright'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixtureHome = await mkdtemp(join(tmpdir(), 'codexui-project-board-e2e-'))
const outputDirectory = join(repositoryRoot, 'output', 'project-boards')
const fixtureProject = join(fixtureHome, 'project')
const secondProject = join(fixtureHome, 'second-project')
const emptyProject = join(fixtureHome, 'empty-project')
await Promise.all([fixtureProject, secondProject, emptyProject].map((path) => mkdir(path)))
const port = 4187
const origin = `http://127.0.0.1:${port}`

const now = new Date().toISOString()
const agentIds = ['builtin-lead', 'builtin-product', 'builtin-design', 'builtin-engineer', 'builtin-qa']

function card(input) {
  return {
    id: input.id,
    boardId: input.boardId ?? 'board-1',
    parentCardId: input.parentCardId ?? '',
    type: input.type ?? 'feature',
    title: input.title,
    description: input.description ?? '',
    acceptanceCriteria: input.acceptanceCriteria ?? '',
    status: input.status ?? 'backlog',
    priority: input.priority ?? 'normal',
    verificationPolicy: input.verificationPolicy ?? 'self',
    taskPurpose: input.taskPurpose ?? 'work',
    assignedAgentId: input.assignedAgentId ?? 'builtin-lead',
    dependencyIds: input.dependencyIds ?? [],
    autoRun: false,
    threadId: input.threadId ?? '',
    summary: input.summary ?? '',
    progressNote: input.progressNote ?? '',
    createdAtIso: now,
    updatedAtIso: now,
    completedAtIso: input.status === 'done' ? now : '',
  }
}

const snapshot = {
  schemaVersion: 1,
  version: 7,
  updatedAtIso: now,
  agents: [],
  boards: [{
    id: 'board-1',
    projectPath: fixtureProject,
    projectName: 'Board smoke project',
    name: 'Product build',
    isDefault: true,
    executionAccess: 'project',
    agentIds,
    autoDispatch: false,
    maxConcurrentRuns: 1,
    createdAtIso: now,
    updatedAtIso: now,
  }],
  cards: [
    card({ id: 'feature-other', boardId: 'board-2', title: 'Other project feature' }),
    card({ id: 'qa-batch', type: 'qa_batch', title: 'Later integration QA' }),
    card({ id: 'feature-working', title: 'Project board orchestration', status: 'working', description: 'Track a large app build across specialist chats.', acceptanceCriteria: 'Work is visible and handoffs remain durable.', progressNote: '1/3 tasks complete' }),
    card({ id: 'feature-needs-you', title: 'Choose the release workflow', status: 'needs_input', priority: 'high', description: 'The Lead needs a product decision before implementation continues.', progressNote: 'Waiting for your answer' }),
    card({ id: 'feature-review', title: 'Mobile interaction pass', status: 'review', verificationPolicy: 'batch', progressNote: 'Ready for batch QA' }),
    card({ id: 'feature-done', title: 'Persistent board storage', status: 'done', summary: 'Atomic JSON persistence is complete.', progressNote: 'All tasks complete' }),
    card({ id: 'task-product', parentCardId: 'feature-working', type: 'task', title: 'Write product brief', status: 'done', assignedAgentId: 'builtin-product', summary: 'PRD and acceptance criteria written.' }),
    card({ id: 'task-engineer', parentCardId: 'feature-working', type: 'task', title: 'Build native UI', status: 'working', assignedAgentId: 'builtin-engineer', progressNote: 'Engineer is working' }),
    card({ id: 'task-qa', parentCardId: 'feature-working', type: 'task', taskPurpose: 'verification', title: 'Validate feature', status: 'backlog', assignedAgentId: 'builtin-qa', dependencyIds: ['task-product', 'task-engineer'], progressNote: 'Waiting for dependencies' }),
  ],
  questions: [{
    id: 'question-1',
    boardId: 'board-1',
    cardId: 'feature-needs-you',
    runId: 'run-1',
    prompt: 'Should this release use one shared QA batch or independent QA per feature?',
    status: 'open',
    answer: '',
    createdAtIso: now,
    answeredAtIso: '',
  }],
  comments: [],
  artifacts: [{ id: 'artifact-1', cardId: 'feature-working', runId: 'run-1', label: 'Product specification', path: 'documentation/project-boards/PRD.md', createdAtIso: now }],
  runs: [{ id: 'run-1', boardId: 'board-1', cardId: 'feature-working', agentId: 'builtin-lead', kind: 'execute', status: 'running', threadId: '', requestedModel: 'build-model', requestedReasoningEffort: 'high', startedAtIso: now, finishedAtIso: '', summary: '', error: '' }],
}

snapshot.boards.push({ ...snapshot.boards[0], id: 'board-2', projectPath: secondProject, projectName: 'Second smoke project', name: 'Another board' })
snapshot.questions.push({ ...snapshot.questions[0], id: 'question-2', prompt: 'Which feature should ship first?' })
snapshot.runs.push(
  { id: 'run-plan', boardId: 'board-1', cardId: '', agentId: 'builtin-product', kind: 'board_plan', status: 'succeeded', threadId: '', startedAtIso: new Date(Date.parse(now) - 180_000).toISOString(), finishedAtIso: new Date(Date.parse(now) - 150_000).toISOString(), summary: 'Prepared the project feature plan.', error: '' },
  { id: 'run-done', boardId: 'board-1', cardId: 'feature-done', agentId: 'builtin-engineer', kind: 'execute', status: 'succeeded', threadId: 'daily-run-thread', requestedModel: 'review-model', requestedReasoningEffort: 'medium', startedAtIso: new Date(Date.parse(now) - 125_000).toISOString(), finishedAtIso: now, summary: 'Storage and its combined checks passed.', error: '' },
)

await writeFile(join(fixtureHome, 'codexui-project-boards.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
const fixtureEnvFile = join(fixtureHome, 'empty.env')
await writeFile(fixtureEnvFile, '', { mode: 0o600 })
await mkdir(outputDirectory, { recursive: true })

const server = spawn(process.execPath, ['--input-type=module', '--eval', `
  import { createServer } from 'vite'
  const server = await createServer({ server: { host: '127.0.0.1', port: ${port}, strictPort: true } })
  // Repository watch settings can override watch:null; close it explicitly so
  // unrelated source edits cannot reload the page and discard fixture drafts.
  await server.watcher.close()
  await server.listen()
`], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    CODEX_HOME: fixtureHome,
    CODEXUI_ENV_FILE: fixtureEnvFile,
    CODEXUI_WEB_PUSH_STATE_FILE: join(fixtureHome, 'push-state.json'),
    CODEXUI_WEB_PUSH_PUBLIC_KEY: '',
    CODEXUI_WEB_PUSH_PRIVATE_KEY: '',
    CODEXUI_TELEGRAM_NOTIFICATIONS: 'false',
    CODEXUI_TELEGRAM_BOT_TOKEN: '',
    CODEXUI_TELEGRAM_CHAT_ID: '',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    MY_TELEGRAM_CHAT_ID: '',
    CODEXUI_PUBLIC_BASE_URL: origin,
    CODEXUI_BASE_URL: origin,
    PUBLIC_BASE_URL: origin,
    PUBLIC_URL: origin,
    VITE_WORKTREE_NAME: 'board-e2e',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})

let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += String(chunk) })
server.stderr.on('data', (chunk) => { serverOutput += String(chunk) })

async function waitForServer() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite exited early.\n${serverOutput}`)
    try {
      const response = await fetch(`${origin}/codex-api/project-boards`)
      if (response.ok) {
        const payload = await response.json()
        if (payload.data?.boards?.some((board) => board.id === 'board-1' && board.projectPath === fixtureProject)) return
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new Error(`Timed out waiting for Vite.\n${serverOutput}`)
}

let browser
let page
const pageErrors = []
const streamMethods = new Set()
const streamConnections = []
const navigations = []
let mobileBrowser
let mobilePage
try {
  await waitForServer()
  const isolatedPushState = JSON.parse(await readFile(join(fixtureHome, 'push-state.json'), 'utf8'))
  assert.equal(isolatedPushState.subscriptions.length, 0, 'Browser fixture must not load real push subscribers')
  const isolatedTelegram = await (await fetch(`${origin}/codex-api/telegram/config`)).json()
  assert.equal(isolatedTelegram.data.available, false, 'Browser fixture must not load Telegram credentials')
  const directTurn = (threadId) => fetch(`${origin}/codex-api/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'Fixture request must never execute.' }] } }),
  })
  const managedTurn = await directTurn('daily-run-thread')
  assert.equal(managedTurn.status, 409, 'Old clients cannot start untracked turns in a board Lead chat')
  assert.match((await managedTurn.json()).error, /linked chat controls/u)
  // An intentionally invalid ID proves ordinary requests still reach native
  // validation, without creating a chat, starting a model, or writing files.
  const ordinaryTurn = await directTurn('fixture-invalid-unmanaged-thread')
  assert.ok(ordinaryTurn.status >= 400 && ordinaryTurn.status !== 409)
  assert.doesNotMatch((await ordinaryTurn.json()).error, /managed by a project board/u)

  // Real bridge/native chat lookup + bundled planning helper, without a model
  // turn, coordinator run, project implementation, or notification delivery.
  const source = await (await fetch(`${origin}/codex-api/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'thread/start', params: { cwd: emptyProject, approvalPolicy: 'never', sandbox: 'read-only' } }),
  })).json()
  assert.ok(source.result?.thread?.id, JSON.stringify(source))
  const planningThreadId = source.result.thread.id
  const helper = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [
    join(repositoryRoot, 'skills/codexui-board-planning/scripts/board.mjs'), '--url', origin, '--thread', planningThreadId, ...args,
  ])).stdout)
  let planningContext = await helper('context')
  assert.equal(planningContext.projectPath, emptyProject)
  const boardId = randomUUID(), firstId = randomUUID(), secondId = randomUUID()
  const planFile = join(fixtureHome, 'draft-plan.json')
  const proposal = { boardId, expectedVersion: planningContext.version, name: 'Optional chat plan', summary: 'Build a parser, then expose it in the CLI.',
    projectPath: secondProject, sourceThreadId: 'ignored-spoof',
    features: [{ id: firstId, description: 'Add the parser.', acceptanceCriteria: 'Parses valid input and explains invalid input.', dependsOn: [] },
      { id: secondId, description: 'Expose the parser through the CLI.', acceptanceCriteria: 'One combined CLI check passes.', dependsOn: [firstId] }] }
  await writeFile(planFile, JSON.stringify(proposal))
  const receipt = await helper('save', '--file', planFile)
  assert.equal(receipt.boardId, boardId)
  assert.equal(receipt.boardPath, `/#/board/${boardId}`)
  planningContext = await helper('context', '--board', boardId)
  assert.equal(planningContext.projectPath, emptyProject, 'Project is derived from the native source chat')
  assert.equal(planningContext.board.sourceThreadId, planningThreadId)
  assert.deepEqual(planningContext.features.find(feature => feature.id === secondId).dependsOn, [firstId])
  await assert.rejects(helper('save', '--file', planFile), /board changed/u)
  proposal.expectedVersion = planningContext.version
  proposal.features = [{ ...proposal.features[0], description: 'Add the parser and handle empty input.' }]
  await writeFile(planFile, JSON.stringify(proposal))
  await helper('save', '--file', planFile)
  const planningState = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data
  const savedBoard = planningState.boards.find(board => board.id === boardId)
  assert.equal(savedBoard.planningThreadId, '', 'The original chat stays ordinary')
  assert.equal(planningState.cards.filter(card => card.boardId === boardId).length, 2, 'Omitted cards remain; retries do not duplicate them')
  assert.equal(planningState.runs.filter(run => run.boardId === boardId).length, 0)
  assert.ok(planningState.cards.filter(card => card.boardId === boardId).every(card => card.status === 'backlog' && !card.threadId && !card.autoRun))
  assert.equal((await fetch(`${origin}/codex-api/project-boards/${boardId}`, { method: 'DELETE' })).status, 200)
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  await page.route('**/codex-api/project-board-models*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { defaultModel: 'build-model', defaultReasoningEffort: new URL(route.request().url()).searchParams.get('sourceThreadId') === 'planning-source-chat' ? 'xhigh' : 'high', models: [
    { id: 'build-model', label: 'Build model', reasoningEfforts: ['medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
    { id: 'review-model', label: 'Review model', reasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'medium' },
  ] } }) }))
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()) })
  page.on('pageerror', (error) => { pageErrors.push(error.message) })
  page.on('websocket', (socket) => {
    streamConnections.push(new URL(socket.url()).pathname)
    socket.on('framereceived', ({ payload }) => {
      try { const value = JSON.parse(String(payload)); if (value.method || value.type) streamMethods.add(value.method ?? value.type) } catch {}
    })
  })
  await page.addInitScript((path) => {
    const NativeEventSource = window.EventSource
    window.boardFixtureStreams = []
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); window.boardFixtureStreams.push(this) }
    }
    localStorage.setItem('codex-web-local.new-thread-cwd.v1', path)
    localStorage.setItem('codex-web-local.theme.v1', 'light')
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
    window.MediaRecorder = class {
      state = 'inactive'; mimeType = 'audio/webm'
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) }); this.onstop?.() }, 0) }
    }
  }, emptyProject)
  const visitBoard = async (query = '') => {
    await page.goto(`${origin}/#/board/board-1${query}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'Board', exact: true }).waitFor({ state: 'attached' })
    const options = page.getByRole('button', { name: 'Board options', exact: true })
    if (await options.getAttribute('aria-expanded') === 'true') await options.click()
  }
  const rejectOnce = (path, message) => page.route(`**/codex-api/${path}`, (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: message }) }), { times: 1 })
  const detail = page.getByTestId('feature-detail')

  await visitBoard('?feature=feature-needs-you&question=question-2')
  await page.getByTestId('project-board').waitFor()
  assert.equal(await page.locator('[data-board-status]').count(), 5)
  await detail.waitFor()
  assert.notEqual(await detail.getAttribute('aria-modal'), 'true', 'Desktop detail must leave board navigation available')
  assert.equal(await page.getByTestId('needs-you-question').locator('p').textContent(), 'Which feature should ship first?')
  assert.equal(await detail.locator('.detail-status-select select').isDisabled(), true)

  // The inbox retains each decision's exact question and the run list is a saved receipt.
  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  await page.getByRole('button', { name: /need you$/ }).click()
  const inbox = page.getByTestId('board-inbox')
  await inbox.waitFor()
  assert.equal(await inbox.locator('[data-question-id]').count(), 2)
  assert.match(await inbox.locator('[data-question-id="question-2"]').textContent(), /Choose the release workflow.*Lead/s)
  assert.match(await inbox.locator('[data-attention-feature-id="feature-review"]').textContent(), /Ready for batch QA/)
  await page.screenshot({ path: join(outputDirectory, 'project-board-inbox-desktop.png'), fullPage: true })
  await inbox.locator('[data-attention-feature-id="feature-review"]').getByRole('button', { name: 'Open feature' }).click()
  await detail.getByRole('heading', { name: 'Mobile interaction pass', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  assert.equal(await page.getByRole('tab', { name: /Needs you/ }).getAttribute('aria-selected'), 'true')
  await page.getByRole('tab', { name: 'Runs', exact: true }).click()
  const runs = page.getByTestId('board-runs')
  assert.equal(await runs.locator('[data-board-run-id]').count(), 3)
  assert.equal(await runs.evaluate((element) => element.scrollTop), 0, 'Switching daily views opens the new list at its beginning')
  assert.match(await runs.locator('[data-board-run-id="run-1"]').textContent(), /Interrupted.*Feature work/s)
  assert.match(await runs.locator('[data-board-run-id="run-done"]').textContent(), /Engineer.*2m 5s.*Requested: review-model · medium reasoning/s)
  assert.match(await runs.locator('[data-board-run-id="run-plan"]').textContent(), /Project planning.*Model settings were not recorded/s)
  assert.equal(await page.getByRole('tab', { name: 'Runs', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await runs.getByRole('heading', { name: 'Runs', exact: true }).textContent(), 'Runs')
  await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))))
  await page.screenshot({ path: join(outputDirectory, 'project-board-runs-desktop.png'), fullPage: true })
  await runs.locator('[data-board-run-id="run-done"]').getByRole('button', { name: 'Open feature' }).click()
  await detail.getByRole('heading', { name: 'Persistent board storage', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  const dailyThread = { id: 'daily-run-thread', cwd: fixtureProject, preview: 'Storage checks', status: { type: 'idle' }, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, turns: [{ id: 'daily-turn', status: 'completed', items: [{ id: 'daily-result', type: 'agentMessage', phase: 'final_answer', text: 'The saved storage run is ready to inspect.' }] }] }
  await page.route('**/codex-api/rpc', (route) => {
    const { method, params } = route.request().postDataJSON()
    if ((method === 'thread/read' || method === 'thread/resume') && params.threadId === dailyThread.id) return route.fulfill({ json: { result: { thread: dailyThread, model: 'review-model', reasoningEffort: 'medium', cwd: fixtureProject } } })
    return route.fallback()
  })
  await page.route('**/codex-api/thread-resume-lite', (route) => route.request().postDataJSON().threadId === dailyThread.id ? route.fulfill({ json: { result: { thread: dailyThread, model: 'review-model', reasoningEffort: 'medium' } } }) : route.fallback())
  await page.route('**/codex-api/thread-page', (route) => route.request().postDataJSON().threadId === dailyThread.id ? route.fulfill({ json: { result: { thread: dailyThread, page: { startTurnIndex: 0, endTurnIndex: 1, totalTurns: 1, hasEarlier: false } } } }) : route.fallback())
  await runs.locator('[data-board-run-id="run-done"]').getByRole('button', { name: 'Open chat' }).click()
  await page.waitForURL('**#/thread/daily-run-thread')
  await page.getByText('The saved storage run is ready to inspect.', { exact: true }).waitFor()
  await visitBoard()
  const boardTab = page.getByRole('tab', { name: 'Board', exact: true })
  await boardTab.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.getByRole('tab', { name: /Needs you/ }).getAttribute('aria-selected'), 'true')
  await inbox.locator('[data-question-id="question-2"]').getByRole('button', { name: 'Review & answer' }).click()
  await page.waitForURL('**question=question-2')
  assert.equal(await page.getByTestId('needs-you-question').locator('p').textContent(), 'Which feature should ship first?')

  await page.locator('button[aria-label^="Notifications:"]').click()
  await page.getByText('Choose the release workflow', { exact: true }).last().waitFor()
  await page.keyboard.press('Escape')

  await rejectOnce('project-board-questions/question-2/answer', 'Answer could not be saved.')
  const answer = page.getByPlaceholder('Give the Lead the decision it needs')
  await answer.fill('Ship the board first.')
  await page.getByRole('button', { name: 'Answer & continue' }).click()
  await detail.getByRole('alert').getByText('Answer could not be saved.').waitFor()
  assert.equal(await answer.inputValue(), 'Ship the board first.')
  await page.getByRole('button', { name: 'Answer & continue' }).click()
  await page.getByTestId('needs-you-question').locator('p').filter({ hasText: 'Should this release use' }).waitFor()
  await answer.fill('Use one shared QA batch for the small related features.')
  await page.getByRole('button', { name: 'Answer & continue' }).click()
  await page.getByTestId('needs-you-question').waitFor({ state: 'detached' })
  assert.equal(await inbox.locator('[data-question-id]').count(), 0, 'Answered decisions leave the inbox')
  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  await page.getByRole('tab', { name: 'Board', exact: true }).click()
  await page.screenshot({ path: join(outputDirectory, 'project-board-desktop.png'), fullPage: true })

  await page.getByRole('button', { name: 'Board options', exact: true }).click()
  // Route changes cannot retain detail from a different board, project, or missing query.
  await page.getByTestId('board-project-select').selectOption(secondProject)
  await page.locator('[data-feature-id="feature-other"]').waitFor()
  assert.equal(await page.getByRole('tab', { name: 'Board', exact: true }).getAttribute('aria-selected'), 'true')
  await page.getByRole('tab', { name: /Needs you/ }).click()
  await page.getByText('You’re all caught up', { exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Runs', exact: true }).click()
  await page.getByText('No runs yet', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-board-run-id]').count(), 0, 'A different board cannot show these runs')

  assert.equal(await detail.count(), 0)
  await page.getByTestId('board-project-select').selectOption(emptyProject)
  await page.getByText('No board for this project', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-feature-id]').count(), 0)
  await page.getByTestId('board-project-select').selectOption(fixtureProject)
  await page.locator('[data-feature-id="feature-needs-you"]').waitFor()
  await visitBoard('?feature=feature-other')
  assert.equal(await detail.count(), 0)
  await visitBoard('?feature=feature-working')
  await detail.waitFor()
  await visitBoard()
  assert.equal(await detail.count(), 0)
  await page.getByLabel('Find a feature', { exact: true }).fill('Persistent board')
  assert.equal(await page.locator('[data-feature-id]').count(), 1)
  await page.getByLabel('Find a feature', { exact: true }).fill('')
  await page.screenshot({ path: join(outputDirectory, 'project-board-overview.png'), fullPage: true })

  // A custom prompt can be saved, edited, and selected to coordinate a feature.
  assert.equal(await page.getByLabel('Board work permissions', { exact: true }).count(), 0, 'Rare settings are collapsed on desktop too')
  await page.getByRole('button', { name: 'Board options', exact: true }).click()
  await page.getByRole('button', { name: 'Shared agent library', exact: true }).click()
  const library = page.getByRole('dialog', { name: 'Agent library' })
  assert.equal(await library.getByLabel('Agent reasoning', { exact: true }).inputValue(), '', 'Custom agents inherit unless reasoning is explicitly chosen')
  await library.getByLabel('Name', { exact: true }).fill('Release coordinator')
  await library.getByLabel('Specialty', { exact: true }).selectOption('engineering')
  await library.getByLabel('Instructions', { exact: true }).fill('Coordinate releases and check the final feature.')
  await library.getByRole('button', { name: 'Add agent', exact: true }).click()
  await library.getByRole('button', { name: 'Edit Release coordinator', exact: true }).click()
  const agentPrompt = library.getByLabel('Instructions', { exact: true })
  await agentPrompt.fill('Coordinate releases. Use specialists when useful and validate the whole feature.')
  assert.equal(await library.getByRole('button', { name: 'Customize Engineer', exact: true }).isDisabled(), true, 'Choosing another profile must not discard a dirty prompt')
  await rejectOnce('project-board-agents/*', 'Agent could not be saved.')
  await library.getByRole('button', { name: 'Save agent', exact: true }).click()
  await library.getByRole('alert').getByText('Agent could not be saved.').waitFor()
  assert.match(await agentPrompt.inputValue(), /validate the whole feature/u)
  await library.getByRole('button', { name: 'Save agent', exact: true }).click()
  await library.getByRole('button', { name: 'Add agent', exact: true }).waitFor()
  await library.getByRole('button', { name: 'Edit Release coordinator', exact: true }).click()
  assert.match(await agentPrompt.inputValue(), /validate the whole feature/u)
  const customAgent = await page.evaluate(async () => {
    const { data } = await (await fetch('/codex-api/project-boards')).json()
    return data.agents.find((agent) => agent.name === 'Release coordinator')
  })
  assert.match(customAgent.instructions, /validate the whole feature/u)
  await page.screenshot({ path: join(outputDirectory, 'project-board-agent-prompt.png'), fullPage: true })
  await library.getByRole('button', { name: 'Customize Engineer', exact: true }).click()
  assert.equal(await library.getByLabel('Name', { exact: true }).inputValue(), 'Engineer copy')
  const engineerPrompt = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data.agents.find((agent) => agent.id === 'builtin-engineer').instructions
  assert.equal(await agentPrompt.inputValue(), engineerPrompt, 'Customize starts with the current source profile instructions')
  await library.getByRole('button', { name: 'Create copy', exact: true }).click()
  await library.getByRole('button', { name: 'Edit Engineer copy', exact: true }).waitFor()
  await page.keyboard.press('Escape')

  const newFeatureButton = page.getByRole('button', { name: 'New feature', exact: true }).first()
  await newFeatureButton.click()
  const form = page.getByTestId('new-feature-form')
  await form.getByLabel('Title', { exact: true }).fill('Dogfood the board')
  await form.getByPlaceholder('What should be built, and why?').fill('Use the dashboard to track its own improvements.')
  await page.evaluate(async () => {
    const response = await fetch('/codex-api/project-board-cards/feature-review', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Mobile snapshot refreshed' }) })
    if (!response.ok) throw new Error(`Fixture update failed: ${await response.text()}`)
  })
  await page.locator('[data-feature-id="feature-review"]').getByText('Mobile snapshot refreshed', { exact: true }).waitFor()
  assert.equal(await form.getByLabel('Title', { exact: true }).inputValue(), 'Dogfood the board', 'Live snapshots must preserve the current form')
  await rejectOnce('project-board-cards', 'Feature could not be saved.')
  await form.getByRole('button', { name: 'Create feature' }).click()
  await form.getByRole('alert').getByText('Feature could not be saved.').waitFor()
  assert.equal(await form.getByLabel('Title', { exact: true }).inputValue(), 'Dogfood the board')
  await page.keyboard.press('Escape')
  await form.waitFor({ state: 'detached' })
  assert.equal(await newFeatureButton.evaluate((element) => element === document.activeElement), true, 'Closing a modal restores focus')
  await newFeatureButton.click()
  await form.getByLabel('Title', { exact: true }).fill('Dogfood the board')
  await form.getByLabel('Lead for this feature', { exact: true }).selectOption(customAgent.id)
  await form.getByLabel('Lead model', { exact: true }).selectOption('review-model')
  await form.getByLabel('Lead reasoning', { exact: true }).selectOption('medium')
  await form.getByRole('checkbox', { name: 'Persistent board storage · Done' }).check()
  await page.screenshot({ path: join(outputDirectory, 'project-board-feature-settings.png'), fullPage: true })
  await form.getByRole('button', { name: 'Create feature' }).click()
  await detail.getByText('Dogfood the board', { exact: true }).waitFor()
  const selectedAgentId = await page.evaluate(async () => {
    const { data } = await (await fetch('/codex-api/project-boards')).json()
    return data.cards.find((card) => card.title === 'Dogfood the board').assignedAgentId
  })
  assert.equal(selectedAgentId, customAgent.id)
  const savedFeature = await page.evaluate(async () => (await (await fetch('/codex-api/project-boards')).json()).data.cards.find((card) => card.title === 'Dogfood the board'))
  assert.equal(savedFeature.model, 'review-model')
  assert.equal(savedFeature.reasoningEffort, 'medium')
  assert.deepEqual(savedFeature.dependencyIds, ['feature-done'])

  // The direct model action opens the same editor with the run settings visible
  // first. Overrides persist, and blank choices restore independent inheritance.
  await detail.getByRole('button', { name: 'Model & reasoning', exact: true }).click()
  const modelEditor = page.getByRole('dialog', { name: 'Edit feature', exact: true })
  const leadModel = modelEditor.getByLabel('Lead model', { exact: true })
  const leadReasoning = modelEditor.getByLabel('Lead reasoning', { exact: true })
  assert.equal(await leadModel.inputValue(), 'review-model')
  assert.equal(await leadReasoning.inputValue(), 'medium')
  assert.ok((await leadModel.boundingBox()).y < (await modelEditor.getByLabel('Brief', { exact: true }).boundingBox()).y, 'The direct model action puts model settings before the long brief')
  await leadModel.selectOption('build-model')
  await leadReasoning.selectOption('xhigh')
  await page.screenshot({ path: join(outputDirectory, 'project-board-model-direct-desktop.png'), fullPage: true })
  await modelEditor.getByRole('button', { name: 'Save feature', exact: true }).click()
  await modelEditor.waitFor({ state: 'detached' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await detail.getByRole('button', { name: 'Model & reasoning', exact: true }).click()
  assert.equal(await leadModel.inputValue(), 'build-model')
  assert.equal(await leadReasoning.inputValue(), 'xhigh')
  await leadModel.selectOption('')
  await leadReasoning.selectOption('')
  await modelEditor.getByRole('button', { name: 'Save feature', exact: true }).click()
  await modelEditor.waitFor({ state: 'detached' })
  const inheritedFeature = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data.cards.find((feature) => feature.id === savedFeature.id)
  assert.equal(inheritedFeature.model, '')
  assert.equal(inheritedFeature.reasoningEffort, '')
  assert.equal(inheritedFeature.assignedAgentId, customAgent.id)
  assert.deepEqual(inheritedFeature.dependencyIds, ['feature-done'])

  // Server owns completion truth; failed moves keep the current value and explain why.
  await detail.locator('.feature-options > summary').click()
  await detail.locator('.detail-status-select select').selectOption('done')
  await detail.getByRole('alert').waitFor()
  assert.equal(await detail.locator('.detail-status-select select').inputValue(), 'backlog')
  await detail.locator('.detail-status-select select').selectOption('review')
  await page.locator('[data-board-status="review"] [data-feature-id]').filter({ hasText: 'Dogfood the board' }).waitFor()
  await detail.locator('.detail-status-select select').selectOption('backlog')
  await page.getByTestId('start-feature').waitFor()

  // Verify consent transport with a rejected adapter response. Never start a real Lead.
  let startConsent
  await page.route('**/codex-api/project-board-cards/*/start', (route) => {
    startConsent = route.request().postDataJSON()
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Smoke test does not run a Lead.' }) })
  })
  await page.getByTestId('start-feature').click()
  const consent = page.getByRole('dialog', { name: 'Allow project edits?' })
  await consent.waitFor()
  assert.equal(startConsent, undefined)
  await consent.getByRole('button', { name: 'Allow edits & start' }).click()
  await consent.getByRole('alert').waitFor()
  assert.deepEqual(startConsent, { allowWorkspaceWrite: true, mode: 'execute', executionAccess: 'project' })
  await page.keyboard.press('Escape')
  await detail.getByRole('button', { name: 'Plan first', exact: true }).click()
  await detail.getByRole('alert').getByText('Smoke test does not run a Lead.').waitFor()
  assert.equal(startConsent.allowWorkspaceWrite, false)
  assert.equal(startConsent.mode, 'plan')

  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  await visitBoard()
  // Synthetic snapshots exercise the existing realtime consumer without starting
  // a model or modifying the isolated server's run state.
  const queueBaseline = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data
  let queueVersion = queueBaseline.version
  const queueRun = { ...queueBaseline.runs.find((run) => run.id === 'run-1'), status: 'running', threadId: 'daily-run-thread', finishedAtIso: '', error: '' }
  const publishQueueSnapshot = async (next) => {
    await page.evaluate((snapshot) => {
      if (!window.boardFixtureStreams.length) throw new Error('No fixture notification stream')
      for (const stream of window.boardFixtureStreams) stream.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ method: 'codexui/projectBoards/updated', params: snapshot }),
      }))
    }, { ...next, version: ++queueVersion })
  }
  // Short desktop windows retain a real, wheel-scrollable card viewport even
  // when one lane has many features. All extra cards remain synthetic.
  const optionsToggle = page.getByRole('button', { name: 'Board options', exact: true })
  if (await optionsToggle.getAttribute('aria-expanded') === 'true') await optionsToggle.click()
  const scrollCards = Array.from({ length: 12 }, (_, index) => card({ id: `scroll-card-${index}`, title: `Scroll fixture ${index}`, description: 'Enough detail to exercise the actual card height and wheel scrolling.' }))
  await publishQueueSnapshot({ ...queueBaseline, cards: [...queueBaseline.cards, ...scrollCards] })
  await page.getByRole('button', { name: 'New feature', exact: true }).click()
  await page.getByTestId('new-feature-form').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.getByTestId('project-board').evaluate((element) => { element.scrollTop = 0 })
  const backlogList = page.locator('[data-board-status="backlog"] .board-lane-list')
  await page.waitForFunction(() => document.querySelector('.desktop-layout').getBoundingClientRect().height <= innerHeight + 1)
  const laneBounds = await backlogList.boundingBox()
  assert.ok(laneBounds.height >= 250 && laneBounds.y < 300, `Cards have a usable viewport below the compact desktop header: ${JSON.stringify(laneBounds)}`)
  assert.equal(await backlogList.evaluate((element) => element.scrollHeight > element.clientHeight), true)
  await page.screenshot({ path: join(outputDirectory, 'project-board-short-desktop.png'), fullPage: true })
  await page.mouse.move(laneBounds.x + 30, laneBounds.y + laneBounds.height / 2)
  await page.mouse.wheel(0, 10000)
  await page.waitForFunction(() => document.querySelector('[data-board-status="backlog"] .board-lane-list').scrollTop > 0)
  const lastCardBounds = await page.locator('[data-feature-id="scroll-card-11"]').boundingBox()
  assert.ok(lastCardBounds.y >= laneBounds.y && lastCardBounds.y < 600, 'The last card is reachable with normal wheel scrolling')
  await page.screenshot({ path: join(outputDirectory, 'project-board-scroll-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await publishQueueSnapshot(queueBaseline)

  // A conversation about a completed feature stays visible while leaving its
  // Done result and the board's next execution slot available.
  const followup = { ...queueRun, id: 'followup-run', cardId: 'feature-done', kind: 'follow_up' }
  await publishQueueSnapshot({ ...queueBaseline, runs: [followup, ...queueBaseline.runs] })
  const completedCard = page.locator('[data-board-status="done"] [data-feature-id="feature-done"]')
  await completedCard.getByText('Conversation', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Run selected features', exact: true }).isEnabled(), true)
  await page.locator('.board-overview').getByText('1 done', { exact: true }).waitFor()
  await completedCard.locator('.board-card-main').click()
  await detail.getByRole('heading', { name: 'Result', exact: true }).waitFor()
  assert.equal(await detail.getByRole('button', { name: 'Model & reasoning', exact: true }).isDisabled(), true)
  assert.equal(await detail.getByRole('button', { name: 'Stop run', exact: true }).isEnabled(), true)
  await detail.locator('.feature-options > summary').click()
  assert.equal(await detail.getByRole('button', { name: 'Delete feature', exact: true }).isDisabled(), true)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth))
  await page.screenshot({ path: join(outputDirectory, 'project-board-followup-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  await page.getByRole('tab', { name: 'Runs', exact: true }).click()
  await page.locator('[data-board-run-id="followup-run"]').getByText('Conversation', { exact: true }).waitFor()
  await page.locator('button[aria-label^="Notifications:"]').click()
  await page.locator('.notification-board-work').getByText('Conversation', { exact: true }).waitFor()
  await page.locator('button[aria-label^="Notifications:"]').click()
  await page.getByRole('button', { name: 'All work', exact: true }).click()
  const followupOverview = page.getByTestId('board-work-overview')
  await followupOverview.getByRole('region', { name: 'Current Leads', exact: true }).getByText('Conversation', { exact: true }).waitFor()
  const followupBoard = followupOverview.getByRole('region', { name: 'Your boards', exact: true }).locator('article').filter({ has: page.getByRole('heading', { name: 'Product build', exact: true }) })
  await followupBoard.getByText(/1 of .* features done/).waitFor()
  await page.screenshot({ path: join(outputDirectory, 'project-board-followup-overview.png'), fullPage: true })
  await followupBoard.getByRole('button', { name: 'Open board', exact: true }).click()
  await publishQueueSnapshot(queueBaseline)

  await publishQueueSnapshot({ ...queueBaseline, runs: queueBaseline.runs.map((run) => run.id === queueRun.id ? queueRun : run) })
  const workingIndicator = page.locator('[data-feature-id="feature-working"] .card-live-status')
  await workingIndicator.getByText('Working…', { exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Show features', { exact: true }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.board-lane')].find((element) => element.getClientRects().length)?.getAttribute('data-board-status') === 'working')
  assert.equal(await page.locator('.board-lane:visible').first().getAttribute('data-board-status'), 'working', 'Mobile puts in-progress work above backlog')
  assert.equal(await page.locator('[data-board-status="backlog"]:visible').count(), 1, 'The board still includes its backlog below active work')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await workingIndicator.locator('span').evaluate((element) => getComputedStyle(element).animationName), 'none', 'Reduced motion disables the working pulse')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  assert.notEqual(await workingIndicator.locator('span').evaluate((element) => getComputedStyle(element).animationName), 'none')
  await page.getByTestId('project-board').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: join(outputDirectory, 'project-board-active-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  const waitingSnapshot = { ...queueBaseline, runs: queueBaseline.runs.map((run) => run.id === queueRun.id ? queueRun : run), questions: [...queueBaseline.questions, { ...queueBaseline.questions[0], id: 'working-decision', cardId: 'feature-working', status: 'open' }] }
  await publishQueueSnapshot(waitingSnapshot)
  await workingIndicator.waitFor({ state: 'detached' })
  await publishQueueSnapshot({ ...queueBaseline, runs: queueBaseline.runs.map((run) => run.id === queueRun.id ? queueRun : run) })
  await workingIndicator.waitFor()
  const delivery = page.getByRole('region', { name: 'Board delivery' })
  await delivery.getByText(/Project board orchestration.*already running/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Run selected features', exact: true }).isDisabled(), true)
  await page.locator('[data-feature-id="feature-working"] .board-card-main').click()
  assert.equal(await detail.getByRole('button', { name: 'Model & reasoning', exact: true }).isDisabled(), true)
  await detail.getByText('Stop the run before changing model or reasoning', { exact: false }).waitFor()
  assert.equal(await detail.getByRole('button', { name: 'Stop run', exact: true }).isEnabled(), true, 'Stopping remains a separate deliberate action')
  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  await page.getByRole('button', { name: 'Board options', exact: true }).click()
  let activeBoardDeleteRequests = 0
  await page.route('**/codex-api/project-boards/board-1', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    activeBoardDeleteRequests += 1
    return route.fulfill({ status: 409, json: { error: 'An active board must not be deleted.' } })
  })
  await page.getByRole('button', { name: 'Delete board', exact: true }).click()
  const activeDeleteDialog = page.getByRole('dialog', { name: 'Delete board?', exact: true })
  await activeDeleteDialog.getByText('Product build', { exact: false }).waitFor()
  await activeDeleteDialog.getByText(/stop.*running|running.*stop/i).waitFor()
  assert.equal(await activeDeleteDialog.getByRole('button', { name: 'Delete board', exact: true }).isDisabled(), true)
  await activeDeleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(activeBoardDeleteRequests, 0)
  await page.unroute('**/codex-api/project-boards/board-1')
  await page.getByRole('button', { name: 'Board options', exact: true }).click()
  await delivery.getByRole('button', { name: 'Open active Lead chat', exact: true }).click()
  await page.waitForURL('**#/thread/daily-run-thread')
  await page.getByText('The saved storage run is ready to inspect.', { exact: true }).waitFor()
  await visitBoard()
  await publishQueueSnapshot(queueBaseline)
  await workingIndicator.waitFor({ state: 'detached' })
  let queueRequest
  await page.route('**/codex-api/project-boards/board-1/queue', (route) => {
    queueRequest = route.request().postDataJSON()
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Queue is paused for this smoke.' }) })
  })
  await page.getByRole('button', { name: 'Run selected features', exact: true }).click()
  const queueDialog = page.getByRole('dialog', { name: 'Run selected features', exact: true })
  assert.equal(await queueDialog.getByRole('button', { name: 'Start selected features' }).isDisabled(), true)
  await queueDialog.getByRole('checkbox', { name: 'Allow project edits', exact: false }).check()
  const selectedQueueIds = () => queueDialog.locator('.queue-list input:checked').evaluateAll((inputs) => inputs.map((input) => input.value))
  const selectedBeforeRun = await selectedQueueIds()
  const otherProjectRun = { ...queueRun, id: 'run-elsewhere', boardId: 'board-2', cardId: 'feature-other' }
  const elsewhere = { ...queueBaseline, runs: [...queueBaseline.runs, otherProjectRun] }
  await publishQueueSnapshot(elsewhere)
  assert.equal(await queueDialog.getByRole('button', { name: 'Start selected features' }).isEnabled(), true, 'A different project does not block this queue')
  const sameProject = { ...elsewhere, boards: elsewhere.boards.map((board) => board.id === 'board-2' ? { ...board, projectPath: fixtureProject } : board) }
  await publishQueueSnapshot(sameProject)
  assert.equal(await queueDialog.getByRole('button', { name: 'Start selected features' }).isEnabled(), true, 'Another board in the same folder does not block this queue')
  assert.equal(await queueDialog.getByRole('status').count(), 0, 'Another board must not appear as this board’s current work')
  await page.keyboard.press('Escape')
  await optionsToggle.click()
  await delivery.getByText('Ready when you are', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Add from a plan', exact: true }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: 'New feature', exact: true }).isEnabled(), true)
  await page.getByTestId('board-select').selectOption('board-2')
  await delivery.getByText(/Other project feature.*already running/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Run selected features', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Add from a plan', exact: true }).isDisabled(), true, 'Planning still waits for active work on its own board')
  await page.getByTestId('board-select').selectOption('board-1')
  await delivery.getByText('Ready when you are', { exact: true }).waitFor()
  assert.equal(await delivery.getByRole('button', { name: 'Open active Lead chat', exact: true }).count(), 0, 'Returning to the idle board does not link another board’s Lead')
  await optionsToggle.click()
  await page.locator(`[data-feature-id="${savedFeature.id}"] .board-card-main`).click()
  assert.equal(await detail.getByRole('button', { name: 'Model & reasoning', exact: true }).isEnabled(), true, 'Settings remain editable while another board runs in the folder')
  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  await page.getByRole('button', { name: 'Run selected features', exact: true }).click()
  await queueDialog.getByRole('checkbox', { name: 'Allow project edits', exact: false }).check()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await queueDialog.getByRole('button', { name: 'Start selected features' }).isEnabled(), true)
  await page.screenshot({ path: join(outputDirectory, 'project-board-independent-queue-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  // Work arriving on this board still blocks a previously opened selection.
  const localPlan = { ...otherProjectRun, id: 'run-local-plan', boardId: 'board-1', cardId: '', kind: 'board_plan' }
  await publishQueueSnapshot({ ...sameProject, runs: [localPlan, ...sameProject.runs] })
  await queueDialog.getByRole('status').getByText(/Board planning.*already running/).waitFor()
  assert.equal(await queueDialog.getByRole('button', { name: 'Start selected features' }).isDisabled(), true, 'A run arriving on this board after the dialog opens blocks execution')
  assert.deepEqual(await selectedQueueIds(), selectedBeforeRun)
  assert.equal(await queueDialog.getByRole('checkbox', { name: 'Allow project edits', exact: false }).isChecked(), true)
  await queueDialog.locator('form').evaluate((form) => form.requestSubmit())
  assert.equal(queueRequest, undefined, 'Implicit submission must not start work while this board is busy')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await queueDialog.evaluate((element) => element.scrollWidth <= element.clientWidth), 'Active-run context must fit a phone')
  await page.screenshot({ path: join(outputDirectory, 'project-board-queue-busy-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.screenshot({ path: join(outputDirectory, 'project-board-queue-busy.png'), fullPage: true })
  await publishQueueSnapshot(queueBaseline)
  await queueDialog.getByRole('status').waitFor({ state: 'detached' })
  assert.equal(await queueDialog.getByRole('button', { name: 'Start selected features' }).isEnabled(), true)
  assert.deepEqual(await selectedQueueIds(), selectedBeforeRun)
  assert.equal(queueRequest, undefined, 'Finishing existing work must not automatically start the preserved selection')
  await page.screenshot({ path: join(outputDirectory, 'project-board-queue.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await queueDialog.evaluate((element) => element.scrollWidth <= element.clientWidth), 'Queue consent must fit mobile width')
  await page.screenshot({ path: join(outputDirectory, 'project-board-queue-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await queueDialog.getByRole('button', { name: 'Start selected features' }).click()
  await queueDialog.getByRole('alert').getByText('Queue is paused for this smoke.').waitFor()
  assert.equal(queueRequest.allowWorkspaceWrite, true)
  assert.equal(queueRequest.executionAccess, 'project')
  assert.ok(queueRequest.featureIds.includes(savedFeature.id))
  assert.ok(!queueRequest.featureIds.includes('feature-done'))
  await page.keyboard.press('Escape')

  // Full access is an explicit board setting: starting work sends that choice
  // directly, without the project-only edit consent. Calls stay intercepted.
  await publishQueueSnapshot({ ...queueBaseline, boards: queueBaseline.boards.map((board) => board.id === 'board-1' ? { ...board, executionAccess: 'full-access' } : board) })
  await page.locator(`[data-feature-id="${savedFeature.id}"] .board-card-main`).click()
  startConsent = undefined
  await page.getByTestId('start-feature').click()
  await detail.getByRole('alert').getByText('Smoke test does not run a Lead.').waitFor()
  assert.equal(await consent.count(), 0)
  assert.equal(startConsent.executionAccess, 'full-access')
  assert.equal(startConsent.mode, 'execute')
  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  await page.getByRole('button', { name: 'Run selected features', exact: true }).click()
  await queueDialog.getByText(/Full access.*no approval prompts/i).waitFor()
  assert.equal(await queueDialog.getByRole('checkbox', { name: 'Allow project edits', exact: false }).count(), 0)
  assert.equal(await queueDialog.getByRole('button', { name: 'Start selected features' }).isEnabled(), true)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await queueDialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
  await page.screenshot({ path: join(outputDirectory, 'project-board-full-access-mobile.png'), fullPage: true })
  queueRequest = undefined
  await queueDialog.getByRole('button', { name: 'Start selected features' }).click()
  await queueDialog.getByRole('alert').getByText('Queue is paused for this smoke.').waitFor()
  assert.equal(queueRequest.executionAccess, 'full-access')
  assert.ok(queueRequest.featureIds.includes(savedFeature.id))
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1600, height: 1000 })
  // Resume the real fixture's version stream after the synthetic busy snapshots.
  await page.reload({ waitUntil: 'domcontentloaded' })

  await visitBoard()
  let planRequest
  await page.route('**/codex-api/project-boards/*/plan', (route) => {
    planRequest = route.request().postDataJSON()
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Planning request kept for review.' }) })
  })
  if (await page.getByRole('button', { name: 'Board options', exact: true }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: 'Board options', exact: true }).click()
  await page.getByRole('button', { name: 'Add from a plan', exact: true }).click()
  const planning = page.getByRole('dialog', { name: 'Add features to Product build', exact: true })
  await planning.getByText(/adds draft cards and dependencies here; existing work stays/).waitFor()
  assert.equal(await planning.getByLabel('Board name', { exact: true }).count(), 0, 'Adding a plan targets this board instead of creating another')
  await planning.getByLabel('Goal or plan', { exact: true }).fill('Build shared groundwork once, then two related features. Keep completed work.')
  await planning.getByLabel('Board default model', { exact: true }).selectOption('build-model')
  await planning.getByLabel('Board default reasoning', { exact: true }).selectOption('high')
  let finishPlanTranscript
  await page.route('**/codex-api/transcribe', async (route) => {
    await new Promise((resolveTranscript) => { finishPlanTranscript = resolveTranscript })
    await route.fulfill({ json: { text: 'shared groundwork once, then two related features. Keep completed work.' } })
  })
  await planning.getByLabel('Goal or plan', { exact: true }).fill('Build ')
  await planning.getByRole('button', { name: 'Dictate Goal or plan', exact: true }).click()
  assert.equal(await planning.getByRole('button', { name: 'Create feature plan' }).isDisabled(), true)
  await planning.getByRole('button', { name: 'Stop dictating Goal or plan', exact: true }).click()
  await planning.getByText('Transcribing…', { exact: true }).waitFor()
  await page.locator('.plan-overlay').click({ position: { x: 5, y: 5 } })
  assert.equal(await planning.isVisible(), true, 'Outside press must not discard pending dictation')
  await page.waitForFunction(() => document.querySelector('.dictation-field[data-dictation-busy]') !== null)
  // Wait for the intercepted request, not an actual speech service.
  const transcriptDeadline = Date.now() + 5_000
  while (!finishPlanTranscript && Date.now() < transcriptDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  assert.ok(finishPlanTranscript, 'The microphone must submit audio for transcription')
  finishPlanTranscript()
  await planning.getByText('Ready — review your words before saving.', { exact: true }).waitFor()
  assert.match(await planning.getByLabel('Goal or plan', { exact: true }).inputValue(), /Build shared groundwork/)
  assert.equal(planRequest, undefined, 'Stopping dictation must not start planning')
  await page.screenshot({ path: join(outputDirectory, 'project-board-plan.png'), fullPage: true })
  await planning.getByRole('button', { name: 'Create feature plan' }).click()
  await planning.getByRole('alert').getByText('Planning request kept for review.').waitFor()
  assert.match(await planning.getByLabel('Goal or plan', { exact: true }).inputValue(), /shared groundwork/)
  assert.equal(planRequest.model, undefined, 'Planning inherits the saved board model')
  assert.equal(planRequest.team, undefined, 'The run request does not carry the settings form draft')
  const updatedPlanBoard = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data.boards.find((board) => board.id === 'board-1')
  assert.equal(updatedPlanBoard.model, 'build-model', 'Team defaults are saved before the planner starts')
  assert.equal(updatedPlanBoard.reasoningEffort, 'high')
  await page.keyboard.press('Escape')
  await page.locator(`[data-feature-id="${savedFeature.id}"] .board-card-main`).click()

  const comment = page.getByPlaceholder('Add context for the Lead')
  await rejectOnce('project-board-cards/*/comments', 'Comment could not be saved.')
  await comment.fill('Preserve this context on failure.')
  await detail.getByRole('button', { name: 'Add', exact: true }).click()
  await detail.getByRole('alert').getByText('Comment could not be saved.').waitFor()
  assert.equal(await comment.inputValue(), 'Preserve this context on failure.')
  await detail.getByRole('button', { name: 'Add', exact: true }).click()
  await detail.locator('.comment-list').getByText('Preserve this context on failure.').waitFor()

  await visitBoard('?feature=qa-batch')
  await detail.getByText('QA batch cards track later verification.', { exact: false }).waitFor()
  assert.equal(await page.getByTestId('start-feature').count(), 0)
  if (await page.getByRole('button', { name: 'Expand sidebar', exact: true }).count()) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByText("Let's build", { exact: true }).waitFor()
  await page.locator('button[aria-label^="Notifications:"]').waitFor()
  await page.getByRole('button', { name: 'Project boards', exact: true }).click()
  await page.getByTestId('board-work-overview').waitFor()

  // Dark surfaces use the same theme token for cards, detail, forms, and selects.
  await visitBoard('?feature=feature-working')
  await detail.getByText('Requested: build-model · high reasoning', { exact: true }).waitFor()
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark' })
  await page.waitForFunction(() => [...document.querySelectorAll('.board-card, .board-detail-panel')].filter((element) => element.getClientRects().length).every((element) => getComputedStyle(element).backgroundColor !== 'rgb(255, 255, 255)'))
  const darkSurfaces = await page.locator('.board-card, .board-detail-panel').evaluateAll((elements) => elements.filter((element) => element.getClientRects().length).map((element) => getComputedStyle(element).backgroundColor))
  assert.ok(darkSurfaces.length > 2 && darkSurfaces.every((color) => color !== 'rgb(255, 255, 255)'), `Dark mode surfaces must not stay white: ${JSON.stringify(darkSurfaces)}`)
  await page.screenshot({ path: join(outputDirectory, 'project-board-dark.png'), fullPage: true })
  await newFeatureButton.click()
  assert.notEqual(await form.evaluate((element) => getComputedStyle(element.parentElement).backgroundColor), 'rgb(255, 255, 255)')
  await page.screenshot({ path: join(outputDirectory, 'project-board-dark-dialog.png'), fullPage: true })
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-testid="feature-detail"][aria-modal="true"]').waitFor()
  assert.equal(await detail.getAttribute('aria-modal'), 'true')
  const panelBounds = await detail.boundingBox()
  assert.ok(panelBounds.x >= 0 && panelBounds.width <= 390 && panelBounds.height <= 844)
  await page.screenshot({ path: join(outputDirectory, 'project-board-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Close feature' }).click()
  const overflow = await page.locator('.boards-lanes').evaluate((element) => ({
    scrollable: element.scrollWidth > element.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }))
  assert.equal(overflow.scrollable, false, 'Phone features use one vertical list instead of sideways lanes')
  assert.ok(overflow.documentWidth <= overflow.viewport, 'The board fits the phone width')
  await page.getByTestId('project-board').evaluate((element) => { element.scrollTop = 0 })
  const firstMobileCard = await page.locator('.board-card:visible').first().boundingBox()
  assert.ok(firstMobileCard.y + 50 < 844, 'Actual work appears on the first phone screen')
  await page.getByLabel('Show features', { exact: true }).selectOption('review')
  assert.equal(await page.locator('.board-lane:visible').getAttribute('data-board-status'), 'review')
  await page.getByLabel('Show features', { exact: true }).selectOption('all')
  await page.screenshot({ path: join(outputDirectory, 'project-board-mobile-overview.png'), fullPage: true })
  await page.getByRole('button', { name: 'Board options', exact: true }).click()
  const workPermissions = page.getByLabel('Board work permissions', { exact: true })
  assert.equal(await workPermissions.inputValue(), 'project')
  const permissionBounds = await workPermissions.boundingBox()
  assert.ok(permissionBounds.height >= 44 && permissionBounds.x >= 0 && permissionBounds.x + permissionBounds.width <= 390)
  await page.screenshot({ path: join(outputDirectory, 'project-board-permissions-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Shared agent library', exact: true }).click()
  await library.getByLabel('Find an agent', { exact: true }).fill('Release coordinator')
  await library.getByRole('button', { name: 'Edit Release coordinator', exact: true }).click()
  const agentName = library.getByLabel('Name', { exact: true })
  await page.waitForFunction(() => document.activeElement === document.querySelector('.new-agent-form input'))
  const agentNameBounds = await agentName.boundingBox()
  const libraryHeaderBounds = await library.locator('header').boundingBox()
  assert.ok(agentNameBounds.y >= libraryHeaderBounds.y + libraryHeaderBounds.height && agentNameBounds.y < 844, 'Mobile Edit brings its form into view below the visible close control')
  assert.equal(await library.getByLabel('Access', { exact: true }).isDisabled(), true, 'Access is explained and locked once the profile owns work')
  assert.ok(await library.evaluate((element) => element.scrollWidth <= element.clientWidth), 'Agent library must fit mobile width')
  await page.screenshot({ path: join(outputDirectory, 'project-board-agent-mobile.png'), fullPage: true })
  await page.keyboard.press('Escape')

  // Start in an ordinary chat, preserve its plan and source link, and reuse a new
  // board when planning fails. Model execution is covered by the native probe.
  const sourcePlan = 'Create shared foundations, then build two related features with one final review.'
  const sourceThread = { id: 'planning-source-chat', cwd: emptyProject, preview: 'Planning a new project', createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, status: { type: 'idle' }, turns: [{ id: 'source-turn', status: 'completed', items: [
    { id: 'source-user', type: 'userMessage', content: [{ type: 'text', text: 'Please make a project plan.' }] },
    { id: 'source-child-start', type: 'subAgentActivity', kind: 'started', agentThreadId: 'unlisted-child', agentPath: '/root/design_review' },
    { id: 'source-plan', type: 'agentMessage', text: sourcePlan, phase: 'final_answer' },
  ] }] }
  const childThread = { ...sourceThread, id: 'unlisted-child', preview: 'Design review', turns: [{ id: 'child-turn', status: 'completed', items: [{ id: 'child-result', type: 'agentMessage', text: 'The mobile design review is ready.', phase: 'final_answer' }] }] }
  await page.route('**/codex-api/rpc', async (route) => {
    const { method, params } = route.request().postDataJSON()
    let result
    if (method === 'thread/list') result = { data: [sourceThread], nextCursor: null }
    else if ((method === 'thread/read' || method === 'thread/resume') && params.threadId === sourceThread.id) result = { thread: sourceThread, model: 'build-model', reasoningEffort: 'xhigh', cwd: emptyProject }
    else if (method === 'thread/read' && params.threadId === childThread.id) result = { thread: childThread }
    else if (method === 'thread/goal/get') result = { goal: null }
    else return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result }) })
  })
  await page.route('**/codex-api/thread-resume-lite', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { thread: sourceThread, model: 'build-model', reasoningEffort: 'xhigh' } }) }))
  await page.route('**/codex-api/thread-page', (route) => {
    const threadId = route.request().postDataJSON().threadId
    if (threadId !== sourceThread.id && threadId !== childThread.id) return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { thread: threadId === childThread.id ? childThread : sourceThread, page: { startTurnIndex: 0, endTurnIndex: 1, totalTurns: 1, hasEarlier: false } } }) })
  })
  await page.goto(`${origin}/?chat-import-smoke=1#/thread/${sourceThread.id}`, { waitUntil: 'domcontentloaded' })
  await page.getByText(sourcePlan, { exact: true }).waitFor()
  await page.getByRole('link', { name: 'Open Design review subagent', exact: true }).click()
  await page.waitForURL('**#/thread/unlisted-child')
  await page.getByText('The mobile design review is ready.', { exact: true }).waitFor()
  await page.goBack()
  await page.getByText(sourcePlan, { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Project board actions', exact: true }).click()
  await page.getByRole('button', { name: 'Track on board', exact: true }).click()
  const trackDialog = page.getByRole('dialog', { name: 'Track on board', exact: true })
  await trackDialog.getByLabel('Feature brief', { exact: true }).fill(sourcePlan)
  await trackDialog.getByRole('button', { name: 'Have a larger plan? Create several feature cards', exact: true }).click()
  const chatPlan = page.locator('.plan-dialog')
  assert.equal(await chatPlan.getByLabel('Goal or plan', { exact: true }).inputValue(), sourcePlan)
  await chatPlan.getByRole('group', { name: 'Board default', exact: true }).getByText('Using build-model · Extra high reasoning.', { exact: true }).waitFor()
  assert.equal(await chatPlan.getByLabel('Board default model', { exact: true }).inputValue(), '')
  assert.equal(await chatPlan.getByLabel('Board default reasoning', { exact: true }).inputValue(), '')
  assert.equal(await chatPlan.getByLabel('Board default reasoning', { exact: true }).locator('option:checked').textContent(), 'Use source chat settings')
  const planningQa = chatPlan.locator('.team-agent').filter({ has: page.locator('summary', { hasText: 'QA / Validator' }) })
  await planningQa.locator('summary').click()
  await planningQa.getByLabel('QA / Validator prompt', { exact: true }).fill('Review shared foundations and the complete mobile workflow.')
  await planningQa.getByLabel('QA / Validator model', { exact: true }).selectOption('review-model')
  await planningQa.getByLabel('QA / Validator reasoning', { exact: true }).selectOption('medium')
  assert.equal(await chatPlan.getByLabel('Board name', { exact: true }).inputValue(), '')
  const generatedBoardName = await chatPlan.getByLabel('Board name', { exact: true }).getAttribute('placeholder')
  assert.ok(generatedBoardName && generatedBoardName !== 'From your goal or plan')
  assert.ok(await chatPlan.evaluate((element) => element.scrollWidth <= element.clientWidth), 'Chat planning must fit mobile width')
  await page.screenshot({ path: join(outputDirectory, 'project-board-chat-plan-mobile.png'), fullPage: true })
  await chatPlan.getByRole('button', { name: 'Create feature plan' }).click()
  await chatPlan.getByRole('alert').getByText('Planning request kept for review.').waitFor()
  assert.equal(planRequest.sourceThreadId, sourceThread.id)
  assert.equal(planRequest.plan, sourcePlan)
  assert.equal(planRequest.model, undefined)
  assert.equal(planRequest.reasoningEffort, undefined)
  const afterFirstPlan = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data
  const importedBoard = afterFirstPlan.boards.find((board) => board.name === generatedBoardName)
  assert.ok(importedBoard)
  assert.deepEqual(importedBoard.agentOverrides['builtin-qa'], { instructions: 'Review shared foundations and the complete mobile workflow.', model: 'review-model', reasoningEffort: 'medium' })
  await chatPlan.getByRole('button', { name: 'Create feature plan' }).click()
  await chatPlan.getByRole('alert').getByText('Planning request kept for review.').waitFor()
  const afterRetry = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data
  assert.equal(afterRetry.boards.filter((board) => board.name === generatedBoardName).length, 1, 'Retry must reuse the created board')
  await page.keyboard.press('Escape')

  // Activity opens a completed feature's Lead result, including older history
  // without a threadId when the current board snapshot can resolve its chat.
  const outcome = { id: 'project-board-completed:feature-done:smoke', kind: 'completed', boardId: 'board-1', featureId: 'feature-done', cardId: 'feature-done', occurredAt: now }
  const historyItem = { id: outcome.id, threadId: 'project-board:feature-done', turnId: outcome.id, status: 'completed', title: 'Feature completed', body: 'The feature is done. Open the board to review the result.', completedAt: now, readAt: null, projectBoard: outcome }
  await page.route('**/codex-api/push/history', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { items: [historyItem], unreadCount: 1, dismissals: [] } }) }))
  await page.route('**/codex-api/push/history/read', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { items: [{ ...historyItem, readAt: now }], unreadCount: 0, dismissals: [] } }) }))
  await visitBoard()
  await page.locator('button[aria-label^="Notifications:"]').click()
  const notificationCenter = page.locator('.notification-popover')
  await notificationCenter.getByText('Persistent board storage', { exact: true }).waitFor()
  await page.screenshot({ path: join(outputDirectory, 'project-board-activity-mobile.png'), fullPage: true })
  await notificationCenter.getByText('Persistent board storage', { exact: true }).click()
  await page.waitForURL('**/#/thread/daily-run-thread')
  await page.getByText('The saved storage run is ready to inspect.', { exact: true }).waitFor()

  // Phone pass with actual touch media queries, not just a narrow desktop window.
  // Opt into WebKit where the installed engine works. Speech/model output is stubbed.
  const mobileEngine = process.env.CODEXUI_MOBILE_BROWSER === 'webkit' ? webkit : chromium
  const mobileEngineName = mobileEngine.name()
  mobileBrowser = await mobileEngine.launch({ headless: true })
  mobilePage = await mobileBrowser.newPage({ ...devices['iPhone 13'], deviceScaleFactor: 1 })
  mobilePage.on('pageerror', (error) => pageErrors.push(error.message))
  await mobilePage.addInitScript(() => {
    localStorage.setItem('codex-web-local.theme.v1', 'dark')
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
    window.MediaRecorder = class {
      state = 'inactive'; mimeType = 'audio/webm'
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) }); this.onstop?.() }, 0) }
    }
  })
  await mobilePage.route('**/codex-api/project-board-models*', (route) => route.fulfill({ json: { data: { defaultModel: 'build-model', defaultReasoningEffort: 'high', models: [{ id: 'build-model', label: 'Build model', reasoningEfforts: ['high'], defaultReasoningEffort: 'high' }] } } }))
  await mobilePage.route('**/codex-api/transcribe', (route) => route.fulfill({ json: { text: 'A feature created by voice on mobile.' } }))
  await mobilePage.goto(`${origin}/#/board/board-1`, { waitUntil: 'domcontentloaded' })
  await mobilePage.getByTestId('project-board').waitFor()
  assert.equal(await mobilePage.evaluate(() => matchMedia('(pointer: coarse)').matches), true)
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(await mobilePage.locator('.boards-header-actions').first().getByRole('button').evaluateAll((buttons) => buttons.filter((button) => button.getClientRects().length).every((button) => button.scrollWidth <= button.clientWidth)), true, 'Phone toolbar labels must fit inside their buttons')
  await mobilePage.screenshot({ path: join(outputDirectory, `project-board-${mobileEngineName}-touch.png`), fullPage: true })
  await mobilePage.getByRole('button', { name: 'Board options', exact: true }).tap()
  for (const width of [320, 390, 640]) {
    await mobilePage.setViewportSize({ width, height: 844 })
    await mobilePage.getByTestId('project-board').evaluate((element) => { element.scrollTop = 0 })
    const toolbarLayout = await mobilePage.locator('.boards-header-actions').getByRole('button').evaluateAll((buttons) => buttons.filter((button) => button.getClientRects().length).map((button) => {
      const bounds = button.getBoundingClientRect()
      const textRects = []
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(walker.currentNode)
        textRects.push(...range.getClientRects())
      }
      return { label: button.textContent.trim(), height: bounds.height,
        fits: button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1
          && textRects.every((rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1) }
    }))
    assert.ok(toolbarLayout.length >= 6 && toolbarLayout.every((button) => button.fits && button.height >= 44), `Toolbar labels stay inside touch buttons at ${width}px: ${JSON.stringify(toolbarLayout)}`)
    const optionsColumns = await mobilePage.locator('.board-options-panel > .boards-header-actions').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
    assert.equal(optionsColumns, 2, `Board options use two readable columns at ${width}px`)
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await mobilePage.screenshot({ path: join(outputDirectory, `project-board-options-${width}-${mobileEngineName}-touch.png`), fullPage: true })
  }
  await mobilePage.setViewportSize({ width: 390, height: 844 })
  await mobilePage.getByRole('button', { name: 'Board options', exact: true }).tap()
  for (const [view, label] of [['needs-you', /Needs you/], ['runs', 'Runs']]) {
    await mobilePage.getByRole('tab', { name: label }).tap()
    const mobileDaily = mobilePage.getByTestId(view === 'runs' ? 'board-runs' : 'board-inbox')
    await mobileDaily.waitFor()
    await mobileDaily.locator('.daily-row').first().scrollIntoViewIfNeeded()
    assert.equal(await mobileDaily.evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'Daily views fit a phone without horizontal scrolling')
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await mobileDaily.getByRole('button').evaluateAll((buttons) => buttons.every((button) => button.getBoundingClientRect().height >= 44)), true, 'Daily actions have comfortable touch targets')
    await mobilePage.screenshot({ path: join(outputDirectory, `project-board-${view}-${mobileEngineName}-touch.png`), fullPage: true })
  }
  await mobilePage.getByRole('tab', { name: 'Board', exact: true }).tap()
  const touchCard = mobilePage.locator('.board-card-main').first()
  await touchCard.scrollIntoViewIfNeeded()
  await mobilePage.screenshot({ path: join(outputDirectory, `project-board-${mobileEngineName}-touch-cards.png`), fullPage: true })
  await touchCard.tap()
  await mobilePage.getByTestId('feature-detail').waitFor()
  await mobilePage.getByRole('button', { name: 'Close feature', exact: true }).tap()
  await mobilePage.getByRole('button', { name: 'New feature', exact: true }).first().tap()
  const touchForm = mobilePage.getByTestId('new-feature-form')
  const titleMic = touchForm.getByRole('button', { name: 'Dictate Title', exact: true })
  const micBounds = await titleMic.boundingBox()
  assert.ok(micBounds.width >= 44 && micBounds.height >= 44, 'Phone voice controls must be comfortable touch targets')
  await titleMic.tap()
  await touchForm.getByRole('button', { name: 'Stop dictating Title', exact: true }).tap()
  await touchForm.getByText('Ready — review your words before saving.', { exact: true }).waitFor()
  assert.equal(await touchForm.getByLabel('Title', { exact: true }).inputValue(), 'A feature created by voice on mobile.')
  await touchForm.getByLabel('Brief', { exact: true }).fill('Verify the complete phone workflow, including form scrolling and manual save.')
  await touchForm.getByRole('button', { name: 'Create feature', exact: true }).scrollIntoViewIfNeeded()
  await mobilePage.screenshot({ path: join(outputDirectory, `project-board-${mobileEngineName}-touch-form.png`), fullPage: true })
  const closeBounds = await mobilePage.getByRole('button', { name: 'Close', exact: true }).boundingBox()
  assert.ok(closeBounds.y >= 0 && closeBounds.y + closeBounds.height <= mobilePage.viewportSize().height, 'Close stays visible while the form scrolls')
  await touchForm.getByRole('button', { name: 'Create feature', exact: true }).tap()
  await mobilePage.getByTestId('feature-detail').waitFor()
  assert.equal(await mobilePage.getByTestId('feature-detail').getAttribute('aria-modal'), 'true')
  await mobilePage.getByRole('button', { name: 'Close feature', exact: true }).tap()
  if (await mobilePage.getByRole('button', { name: 'Board options', exact: true }).getAttribute('aria-expanded') !== 'true') await mobilePage.getByRole('button', { name: 'Board options', exact: true }).tap()
  await mobilePage.getByRole('button', { name: 'Add from a plan', exact: true }).tap()
  const touchPlan = mobilePage.getByRole('dialog', { name: 'Add features to Product build', exact: true })
  await touchPlan.getByLabel('Goal or plan', { exact: true }).fill('Build one small feature, then a dependent improvement.')
  await touchPlan.getByRole('button', { name: 'Create feature plan', exact: true }).scrollIntoViewIfNeeded()
  await mobilePage.screenshot({ path: join(outputDirectory, `project-board-${mobileEngineName}-touch-plan.png`), fullPage: true })
  assert.equal(await touchPlan.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  await touchPlan.getByRole('button', { name: 'Close planning', exact: true }).tap()

  // Delete only the explicitly chosen idle fixture board. Cancel makes no
  // request, confirmation shows scope, and another project's work survives.
  const beforeDelete = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data
  const deleteRequests = []
  await mobilePage.route('**/codex-api/project-boards/board-2', (route) => {
    if (route.request().method() === 'DELETE') deleteRequests.push(new URL(route.request().url()).pathname)
    return route.fallback()
  })
  await mobilePage.goto(`${origin}/#/board/board-2`, { waitUntil: 'domcontentloaded' })
  await mobilePage.locator('[data-feature-id="feature-other"]').waitFor()
  if (await mobilePage.getByRole('button', { name: 'Board options', exact: true }).getAttribute('aria-expanded') !== 'true') await mobilePage.getByRole('button', { name: 'Board options', exact: true }).tap()
  await mobilePage.getByRole('button', { name: 'Delete board', exact: true }).tap()
  const deleteDialog = mobilePage.getByRole('dialog', { name: 'Delete board?', exact: true })
  await deleteDialog.getByText('Another board', { exact: false }).waitFor()
  await deleteDialog.getByText(/1 feature cards/).waitFor()
  await deleteDialog.getByText('Your project files, chat history, and agent profiles are kept.', { exact: true }).waitFor()
  assert.equal(await deleteDialog.getByRole('button', { name: 'Delete board', exact: true }).isEnabled(), true)
  assert.equal(await deleteDialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  await mobilePage.screenshot({ path: join(outputDirectory, `project-board-delete-${mobileEngineName}-touch.png`), fullPage: true })
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).tap()
  assert.deepEqual(deleteRequests, [])
  assert.ok((await (await fetch(`${origin}/codex-api/project-boards`)).json()).data.boards.some((board) => board.id === 'board-2'))
  await mobilePage.getByRole('button', { name: 'Delete board', exact: true }).tap()
  await deleteDialog.getByRole('button', { name: 'Delete board', exact: true }).tap()
  await mobilePage.getByTestId('board-work-overview').waitFor()
  assert.deepEqual(deleteRequests, ['/codex-api/project-boards/board-2'])
  const afterDelete = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data
  assert.equal(afterDelete.boards.some((board) => board.id === 'board-2'), false)
  assert.equal(afterDelete.cards.some((feature) => feature.boardId === 'board-2'), false)
  assert.deepEqual(afterDelete.cards.filter((feature) => feature.boardId === 'board-1'), beforeDelete.cards.filter((feature) => feature.boardId === 'board-1'))
  assert.deepEqual(afterDelete.boards.find((board) => board.id === 'board-1'), beforeDelete.boards.find((board) => board.id === 'board-1'))

  // Team edits stay in browser-only board state; no model, global template or
  // real board is changed by the desktop/touch form journey.
  async function checkBoardTeam(target, touch) {
    const teamSnapshot = structuredClone({ ...snapshot, agents: beforeDelete.agents, version: 8000,
      boards: snapshot.boards.map((board) => ({ ...board, projectPath: fixtureProject, model: '', reasoningEffort: '', coordinatorAgentId: 'builtin-lead', agentOverrides: {} })),
      cards: [], runs: [], queues: [], questions: [], comments: [], artifacts: [] })
    const templatesBefore = structuredClone(teamSnapshot.agents)
    const writes = []
    const json = (route, value) => route.fulfill({ json: value })
    await target.route('**/codex-api/**', (route) => {
      const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
      if (path === '/codex-api/project-board-models') return json(route, { data: { defaultModel: 'build-model', defaultReasoningEffort: 'high', models: [
        { id: 'build-model', label: 'Build model', reasoningEfforts: ['medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
        { id: 'review-model', label: 'Review model', reasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'medium' },
      ] } })
      if (path === '/codex-api/transcribe') return json(route, { text: 'Check phone layout and keep the review focused.' })
      if (path === '/codex-api/project-boards' && method === 'GET') return json(route, { data: teamSnapshot })
      if (/^\/codex-api\/project-board/.test(path) && method !== 'GET') {
        const input = request.postDataJSON(); writes.push({ path, method, input })
        if (path === '/codex-api/project-boards' && method === 'POST') teamSnapshot.boards.push({ ...teamSnapshot.boards[0], ...input, id: 'team-created', isDefault: false })
        else if (path.startsWith('/codex-api/project-boards/') && method === 'PATCH') Object.assign(teamSnapshot.boards.find((board) => board.id === path.split('/').at(-1)), input)
        else if (path === '/codex-api/project-board-cards' && method === 'POST') teamSnapshot.cards.push({ ...card({ ...input, id: 'team-feature' }), model: input.model ?? '', reasoningEffort: input.reasoningEffort ?? '' })
        else return route.fulfill({ status: 409, json: { error: 'The team fixture cannot start runs or change shared templates.' } })
        teamSnapshot.version++
        return json(route, { data: teamSnapshot })
      }
      if (path === '/codex-api/rpc' && request.postDataJSON().method === 'thread/list') return json(route, { result: { data: [], nextCursor: null } })
      return route.fallback()
    })
    const press = (locator) => touch ? locator.tap() : locator.click()
    await target.setViewportSize({ width: touch ? 390 : 1600, height: touch ? 844 : 1000 })
    await target.goto(`${origin}/?board-team=${touch ? 'touch' : 'desktop'}#/board/board-1`, { waitUntil: 'domcontentloaded' })
    await press(target.getByRole('button', { name: 'Board options', exact: true }))
    await press(target.getByRole('button', { name: 'New board', exact: true }))
    const create = target.getByRole('dialog', { name: 'New board', exact: true })
    await create.getByLabel('Name', { exact: true }).fill('Mobile release team')
    await create.getByLabel('Board default model', { exact: true }).selectOption('build-model')
    await create.getByLabel('Board default reasoning', { exact: true }).selectOption('xhigh')
    await create.getByLabel('Project coordinator', { exact: true }).selectOption('builtin-product')
    const qa = create.locator('.team-agent').filter({ has: target.locator('summary', { hasText: 'QA / Validator' }) })
    await press(qa.locator('summary'))
    await qa.getByLabel('QA / Validator model', { exact: true }).selectOption('review-model')
    await qa.getByLabel('QA / Validator reasoning', { exact: true }).selectOption('medium')
    await qa.getByLabel('QA / Validator prompt', { exact: true }).fill('Review the acceptance criteria. ')
    await press(qa.getByRole('button', { name: 'Dictate QA / Validator prompt', exact: true }))
    assert.equal(await create.getByRole('button', { name: 'Create board', exact: true }).isDisabled(), true)
    await press(qa.getByRole('button', { name: 'Stop dictating QA / Validator prompt', exact: true }))
    await qa.getByText('Ready — review your words before saving.', { exact: true }).waitFor()
    const qaPrompt = await qa.getByLabel('QA / Validator prompt', { exact: true }).inputValue()
    assert.match(qaPrompt, /Check phone layout/)
    assert.deepEqual(writes, [], 'Dictation edits only the draft until Create board is pressed')
    if (touch) for (const width of [320, 390]) {
      await target.setViewportSize({ width, height: 844 })
      assert.equal(await create.evaluate((element) => element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= innerWidth), true)
      assert.equal(await create.locator('select, summary, button').evaluateAll((elements) => elements.filter((element) => element.getClientRects().length).every((element) => element.getBoundingClientRect().height >= 44)), true, `Team controls have 44px touch targets at ${width}px`)
      await create.evaluate((element) => { element.scrollTop = 0 })
      await target.screenshot({ path: join(outputDirectory, `project-board-team-${width}-touch.png`), fullPage: true })
    }
    else {
      await create.evaluate((element) => { element.scrollTop = 0 })
      await target.screenshot({ path: join(outputDirectory, 'project-board-team-desktop.png'), fullPage: true })
    }
    await press(create.getByRole('button', { name: 'Create board', exact: true }))
    await target.waitForURL('**#/board/team-created')
    const saved = teamSnapshot.boards.find((board) => board.id === 'team-created')
    assert.equal(saved.model, 'build-model'); assert.equal(saved.reasoningEffort, 'xhigh')
    assert.equal(saved.coordinatorAgentId, 'builtin-product')
    assert.deepEqual(saved.agentOverrides['builtin-qa'], { model: 'review-model', reasoningEffort: 'medium', instructions: qaPrompt })
    await target.reload({ waitUntil: 'domcontentloaded' })
    await press(target.getByRole('button', { name: 'Board options', exact: true }))
    await press(target.getByRole('button', { name: 'Plan features', exact: true }))
    const addPlan = target.getByRole('dialog', { name: 'Add features to Mobile release team', exact: true })
    await addPlan.getByLabel('Goal or plan', { exact: true }).fill('Preserve this plan while I update the board team.')
    await press(addPlan.getByRole('button', { name: 'Cancel', exact: true }))
    await press(target.getByRole('button', { name: 'Team & settings', exact: true }))
    const team = target.getByRole('dialog', { name: 'Team & settings', exact: true })
    const savedQa = team.locator('.team-agent').filter({ has: target.locator('summary', { hasText: 'QA / Validator' }) })
    assert.equal(await team.getByLabel('Board default reasoning', { exact: true }).inputValue(), 'xhigh')
    await press(savedQa.locator('summary'))
    assert.equal(await savedQa.getByLabel('QA / Validator prompt', { exact: true }).inputValue(), qaPrompt)
    assert.equal(await savedQa.getByLabel('QA / Validator model', { exact: true }).inputValue(), 'review-model')
    await savedQa.getByLabel('QA / Validator prompt', { exact: true }).fill('Review the complete mobile workflow once.')
    await team.getByLabel('Board default reasoning', { exact: true }).selectOption('high')
    await press(team.getByRole('button', { name: 'Save team settings', exact: true }))
    await team.waitFor({ state: 'detached' })
    assert.equal(saved.agentOverrides['builtin-qa'].instructions, 'Review the complete mobile workflow once.')
    await press(target.getByRole('button', { name: 'Plan features', exact: true }))
    assert.equal(await addPlan.getByLabel('Goal or plan', { exact: true }).inputValue(), 'Preserve this plan while I update the board team.')
    assert.equal(await addPlan.getByLabel('Board default reasoning', { exact: true }).inputValue(), 'high', 'Reopening a saved plan refreshes current team settings without losing the plan')
    const teamWritesBeforePlan = writes.filter((write) => write.method === 'PATCH').length
    await press(addPlan.getByRole('button', { name: 'Create feature plan', exact: true }))
    await addPlan.getByRole('alert').getByText('The team fixture cannot start runs or change shared templates.', { exact: true }).waitFor()
    assert.equal(writes.filter((write) => write.method === 'PATCH').length, teamWritesBeforePlan, 'Unchanged planning settings do not overwrite the saved team')
    await press(addPlan.getByRole('button', { name: 'Cancel', exact: true }))
    await press(target.getByRole('button', { name: 'New feature', exact: true }).first())
    const feature = target.getByTestId('new-feature-form')
    assert.equal(await feature.getByLabel('Lead for this feature', { exact: true }).inputValue(), 'builtin-product')
    await feature.getByText('Using build-model · High reasoning.', { exact: true }).waitFor()
    await feature.getByLabel('Brief', { exact: true }).fill('Build the mobile release with this team.')
    await press(feature.getByRole('button', { name: 'Create feature', exact: true }))
    await feature.waitFor({ state: 'detached' })
    assert.equal(teamSnapshot.cards[0].assignedAgentId, 'builtin-product')
    assert.equal(teamSnapshot.cards[0].model, '', 'New features continue inheriting board defaults')
    await target.goto(`${origin}/?board-team=${touch ? 'touch' : 'desktop'}#/board/board-2`)
    await press(target.getByRole('button', { name: 'Team & settings', exact: true }))
    assert.equal(await team.getByLabel('Board default model', { exact: true }).inputValue(), '')
    assert.equal(await team.getByLabel('Project coordinator', { exact: true }).inputValue(), 'builtin-lead')
    await press(savedQa.locator('summary'))
    assert.equal(await savedQa.getByLabel('QA / Validator prompt', { exact: true }).inputValue(), templatesBefore.find((agent) => agent.id === 'builtin-qa').instructions)
    await press(team.getByRole('button', { name: 'Close team settings', exact: true }))
    await target.goto(`${origin}/?board-team=${touch ? 'touch' : 'desktop'}#/board/team-created`)
    await press(target.getByRole('button', { name: 'Team & settings', exact: true }))
    await press(savedQa.locator('summary'))
    await press(savedQa.getByRole('button', { name: 'Reset to template', exact: true }))
    await press(team.getByRole('button', { name: 'Save team settings', exact: true }))
    await team.waitFor({ state: 'detached' })
    assert.equal(saved.agentOverrides['builtin-qa'], undefined)
    assert.equal(saved.model, 'build-model', 'Resetting one agent preserves the board default')
    teamSnapshot.runs.push({ ...snapshot.runs[0], id: 'team-busy', boardId: saved.id, cardId: 'team-feature' })
    teamSnapshot.version++
    await target.reload({ waitUntil: 'domcontentloaded' })
    const writesBeforeBusy = writes.length
    await press(target.getByRole('button', { name: 'Team & settings', exact: true }))
    await team.getByText('You can view the prompts now. Stop active runs and pause delivery before changing the team.', { exact: true }).waitFor()
    await press(savedQa.locator('summary'))
    assert.equal(await team.getByLabel('Board default model', { exact: true }).isDisabled(), true)
    assert.equal(await savedQa.getByLabel('QA / Validator prompt', { exact: true }).isEditable(), false)
    assert.equal(await savedQa.getByRole('button', { name: 'Dictate QA / Validator prompt', exact: true }).isDisabled(), true)
    assert.equal(await team.getByRole('button', { name: 'Save team settings', exact: true }).isDisabled(), true)
    assert.equal(writes.length, writesBeforeBusy)
    assert.deepEqual(teamSnapshot.agents, templatesBefore, 'Board customization never rewrites shared agent templates')
    assert.deepEqual(teamSnapshot.boards[1].agentOverrides, {}, 'The second board remains untouched')
    await press(team.getByRole('button', { name: 'Close team settings', exact: true }))
  }
  await checkBoardTeam(page, false)
  await checkBoardTeam(mobilePage, true)

  async function checkWorkOverview(target, touch) {
    const overviewSnapshot = { ...snapshot, agents: beforeDelete.agents, version: 9000,
      boards: [...snapshot.boards, { ...snapshot.boards[0], id: 'board-sibling', name: 'Design queue', isDefault: false }],
      cards: [card({ id: 'overview-main-active', title: 'Build main release', status: 'working', threadId: 'overview-main-lead' }),
        card({ id: 'overview-main-done', title: 'Main result', status: 'done', summary: 'Main release completed.' }),
        card({ id: 'overview-review', boardId: 'board-sibling', title: 'Review mobile design', status: 'review' }),
        card({ id: 'overview-other-active', boardId: 'board-2', title: 'Build other release', status: 'working', threadId: 'overview-other-lead' }),
        card({ id: 'overview-other-done', boardId: 'board-2', title: 'Other result', status: 'done', summary: 'Other release completed.' })],
      runs: [{ ...snapshot.runs[0], id: 'overview-main-run', cardId: 'overview-main-active', threadId: 'overview-main-lead' },
        { ...snapshot.runs[0], id: 'overview-other-run', boardId: 'board-2', cardId: 'overview-other-active', threadId: 'overview-other-lead' }],
      questions: [], comments: [], artifacts: [], queues: [] }
    const boardWrites = []
    await target.addInitScript((path) => localStorage.setItem('codex-web-local.new-thread-cwd.v1', path), emptyProject)
    await target.route('**/codex-api/**', (route) => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (/^\/codex-api\/project-board/.test(path) && request.method() !== 'GET') {
        boardWrites.push({ path, method: request.method() })
        return route.fulfill({ status: 409, json: { error: 'Overview navigation must not write board state.' } })
      }
      if (path === '/codex-api/project-boards') return route.fulfill({ json: { data: overviewSnapshot } })
      if (path === '/codex-api/rpc' && request.postDataJSON().method === 'thread/list') return route.fulfill({ json: { result: { data: [{ id: 'overview-catalog', name: 'Main project chat', cwd: fixtureProject, preview: '', source: 'vscode', status: { type: 'idle' }, createdAt: 1, updatedAt: 2 }], nextCursor: null } } })
      return route.fallback()
    })
    const press = (locator) => touch ? locator.tap() : locator.click()
    await target.setViewportSize({ width: touch ? 390 : 1600, height: touch ? 844 : 1000 })
    await target.goto(`${origin}/?overview-filter=${touch ? 'touch' : 'desktop'}#/boards`, { waitUntil: 'domcontentloaded' })
    const overview = target.getByTestId('board-work-overview')
    const filter = overview.getByRole('combobox', { name: 'Filter boards by project', exact: true })
    await filter.waitFor()
    assert.equal(await filter.inputValue(), '')
    assert.equal(await filter.locator('option:checked').textContent(), 'All projects')
    const yourBoards = overview.getByRole('region', { name: 'Your boards', exact: true })
    const names = () => yourBoards.locator('article h4').allTextContents()
    const counts = async (needs, active, done) => {
      for (const text of [`${needs} need you`, `${active} active`, `${done} done`]) await overview.locator('.overview-counts').getByText(text, { exact: true }).waitFor()
    }
    await yourBoards.getByRole('heading', { name: 'Design queue', exact: true }).waitFor()
    assert.deepEqual((await names()).sort(), ['Another board', 'Design queue', 'Product build'])
    await counts(1, 2, 2)
    assert.equal(await yourBoards.evaluate((element) => [...element.parentElement.querySelectorAll('[data-overview-section]')].every((section) => Boolean(element.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING))), true, 'Boards precede detailed requests, Leads and results')
    assert.equal(await overview.getByRole('button', { name: 'Open project', exact: true }).count(), 0, 'The project filter has no second submit step')
    for (const path of [fixtureProject, secondProject, emptyProject]) assert.equal(await filter.locator('option').evaluateAll((options, path) => options.filter((option) => option.value === path).length, path), 1)
    await filter.selectOption(fixtureProject)
    assert.deepEqual((await names()).sort(), ['Design queue', 'Product build'])
    await counts(1, 1, 1)
    await overview.getByRole('region', { name: 'Current Leads', exact: true }).getByText('Build main release', { exact: true }).waitFor()
    assert.equal(await overview.getByText('Build other release', { exact: true }).count(), 0)
    assert.equal(await overview.getByText('Other release completed.', { exact: true }).count(), 0)
    assert.match(target.url(), /#\/boards$/)
    if (touch) for (const width of [320, 390]) {
      await target.setViewportSize({ width, height: 844 })
      await overview.evaluate((element) => { element.scrollTop = 0 })
      await target.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))))
      const first = await yourBoards.locator('article').first().boundingBox()
      assert.ok(first.y >= 0 && first.y + first.height < 844, 'A whole board card is available in the first phone viewport')
      assert.ok((await filter.boundingBox()).height >= 44)
      assert.equal(await yourBoards.getByRole('button').evaluateAll((buttons) => buttons.every((button) => button.getBoundingClientRect().height >= 44)), true)
      assert.equal(await overview.evaluate((element) => element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= innerWidth), true)
      await target.screenshot({ path: join(outputDirectory, `work-overview-filter-${width}-touch.png`), fullPage: true })
    }
    else await target.screenshot({ path: join(outputDirectory, 'work-overview-filter-desktop.png'), fullPage: true })
    await filter.selectOption(secondProject)
    assert.deepEqual(await names(), ['Another board'], 'A snapshot-only project is immediately selectable')
    await counts(0, 1, 1)
    await overview.getByRole('region', { name: 'Current Leads', exact: true }).getByText('Build other release', { exact: true }).waitFor()
    assert.equal(await overview.getByText('Build main release', { exact: true }).count(), 0)
    await press(overview.getByRole('button', { name: 'New plan', exact: true }))
    const plan = target.getByRole('dialog', { name: 'Plan project features', exact: true })
    await plan.getByRole('textbox', { name: 'Goal or plan', exact: true }).fill('A canceled second-project plan.')
    await press(plan.getByRole('button', { name: 'Cancel', exact: true }))
    await filter.selectOption(emptyProject)
    assert.deepEqual(await names(), [])
    assert.equal(await overview.locator('[data-overview-section]').count(), 0, 'Empty projects cannot retain another project’s activity')
    const emptyName = await filter.locator('option:checked').textContent()
    assert.match(await overview.locator('.overview-empty').textContent(), /no boards/i)
    assert.ok((await overview.locator('.overview-empty').textContent()).includes(emptyName))
    await press(overview.getByRole('button', { name: 'New plan', exact: true }))
    assert.equal(await plan.getByRole('combobox', { name: 'Plan project', exact: true }).inputValue(), emptyProject)
    assert.equal(await plan.getByRole('textbox', { name: 'Goal or plan', exact: true }).inputValue(), '', 'Changing the chosen project cannot restore another project’s canceled plan')
    await press(plan.getByRole('button', { name: 'Close planning', exact: true }))
    await filter.selectOption('')
    assert.equal((await names()).length, 3)
    await counts(1, 2, 2)
    assert.deepEqual(boardWrites, [], 'Filtering and opening the preselected planning form are read-only')
    // Finished boards do not keep asking for review of their original plan.
    overviewSnapshot.cards.find((feature) => feature.id === 'overview-other-active').status = 'done'
    overviewSnapshot.runs.find((run) => run.id === 'overview-other-run').status = 'succeeded'
    overviewSnapshot.runs.push({ ...snapshot.runs[1], id: 'overview-old-plan', kind: 'board_plan', boardId: 'board-2', cardId: '', status: 'succeeded', threadId: 'overview-old-planner' })
    await target.reload({ waitUntil: 'domcontentloaded' })
    await filter.selectOption(secondProject)
    await counts(0, 0, 2)
    assert.equal(await overview.getByRole('region', { name: 'Needs you', exact: true }).count(), 0)
    await filter.selectOption('')
    await press(yourBoards.locator('article').filter({ has: target.getByRole('heading', { name: 'Design queue', exact: true }) }).getByRole('button', { name: 'Open board', exact: true }))
    await target.waitForURL('**#/board/board-sibling')
    await target.locator('[data-feature-id="overview-review"]').waitFor()
  }
  await checkWorkOverview(page, false)
  await checkWorkOverview(mobilePage, true)

  // Exercise helper grouping in the real app with browser-only thread, board,
  // event and question fixtures. No helper turn or reply reaches the runtime.
  async function checkHelperGrouping(target, touch) {
    const nativeThread = (id, name, parentThreadId) => ({ id, name, cwd: fixtureProject, preview: `Checking ${name}`, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000,
      source: parentThreadId ? { subAgent: { thread_spawn: { parent_thread_id: parentThreadId } } } : 'vscode', status: { type: 'active' },
      turns: [{ id: `${id}-turn`, status: 'inProgress', items: [{ id: `${id}-message`, type: 'agentMessage', text: `Context for ${id}.` }] }] })
    const helperThreads = [nativeThread('helper-lead-1', 'Notification Lead'), nativeThread('helper-lead-2', 'Search Lead'),
      nativeThread('layout-child', 'Layout check', 'helper-lead-1'), nativeThread('nested-child', 'Nested check', 'layout-child'),
      nativeThread('search-child', 'Search check', 'helper-lead-2'), nativeThread('ordinary-same-name', 'Layout check')]
    const helperSnapshot = { ...snapshot, agents: beforeDelete.agents, version: 10000,
      boards: snapshot.boards.map((board) => ({ ...board, projectPath: fixtureProject })),
      cards: [card({ id: 'helper-feature-1', title: 'Build notifications', status: 'working', threadId: 'helper-lead-1' }), card({ id: 'helper-feature-2', boardId: 'board-2', title: 'Build search', status: 'working', threadId: 'helper-lead-2' })],
      runs: ['1', '2'].map((id) => ({ ...snapshot.runs[0], id: `helper-run-${id}`, boardId: `board-${id}`, cardId: `helper-feature-${id}`, threadId: `helper-lead-${id}` })), questions: [], comments: [], artifacts: [], queues: [] }
    let helperHistory = [], helperRequests = []
    const helperReplies = [], helperCatalogReads = []
    await target.addInitScript(() => {
      window.helperFixtureStreams = []
      window.EventSource = class { static CLOSED = 2; readyState = 1; constructor() { window.helperFixtureStreams.push(this); queueMicrotask(() => this.onopen?.({})) } close() { this.readyState = 2 } }
    })
    const notify = (method, params) => target.evaluate(({ method, params }) => {
      for (const stream of window.helperFixtureStreams) if (stream.readyState === 1) stream.onmessage?.({ data: JSON.stringify({ method, params }) })
    }, { method, params })
    await target.route('**/codex-api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      const json = (value) => route.fulfill({ json: value })
      if (path === '/codex-api/project-boards') return json({ data: helperSnapshot })
      if (path === '/codex-api/push/history') return json({ data: { items: helperHistory, unreadCount: helperHistory.length, dismissals: [] } })
      if (path === '/codex-api/server-requests/pending') return json({ requests: helperRequests })
      if (path === '/codex-api/server-requests/respond') { helperReplies.push(route.request().postDataJSON()); helperRequests = []; return json({ ok: true }) }
      if (path === '/codex-api/rpc') {
        const { method, params } = route.request().postDataJSON()
        if (method === 'thread/list') {
          if (!params.sourceKinds?.length && !params.ancestorThreadId) return json({ result: { data: helperThreads.filter((thread) => thread.source === 'vscode'), nextCursor: null } })
          helperCatalogReads.push(params)
          const descendants = helperThreads.filter((thread) => {
            let parent = thread.source?.subAgent?.thread_spawn?.parent_thread_id
            if (!params.ancestorThreadId) return Boolean(parent)
            while (parent) {
              if (parent === params.ancestorThreadId) return true
              parent = helperThreads.find((entry) => entry.id === parent)?.source?.subAgent?.thread_spawn?.parent_thread_id
            }
            return false
          })
          return json({ result: { data: descendants, nextCursor: null } })
        }
        if (method === 'thread/read' || method === 'thread/resume') return json({ result: { thread: helperThreads.find((thread) => thread.id === params.threadId), model: 'build-model', reasoningEffort: 'high' } })
        if (method === 'thread/goal/get') return json({ result: { goal: null } })
      }
      if (path === '/codex-api/thread-page' || path === '/codex-api/thread-resume-lite') {
        const thread = helperThreads.find((entry) => entry.id === route.request().postDataJSON().threadId)
        return json({ result: { thread, model: 'build-model', reasoningEffort: 'high', page: { startTurnIndex: 0, endTurnIndex: 1, totalTurns: 1, hasEarlier: false } } })
      }
      return route.fallback()
    })
    const press = (locator) => touch ? locator.tap() : locator.click()
    await target.setViewportSize({ width: touch ? 390 : 1600, height: touch ? 844 : 1000 })
    await target.goto(`${origin}/?helper-grouping=${touch ? 'touch' : 'desktop'}#/board/board-1`, { waitUntil: 'domcontentloaded' })
    await target.getByTestId('project-board').waitFor()
    const trigger = target.locator('button[aria-label^="Notifications:"]')
    await target.getByRole('button', { name: 'Notifications: 3 running', exact: true }).waitFor()
    await press(trigger)
    const activity = target.locator('.notification-popover')
    const boardWork = activity.getByRole('region', { name: 'Board work', exact: true })
    const owner = (title) => boardWork.locator(':scope > div').filter({ has: target.getByRole('button', { name: `Open Lead chat for ${title}`, exact: true }) })
    const primary = owner('Build notifications'), secondary = owner('Build search')
    assert.equal(await boardWork.locator('.notification-board-main').count(), 2, 'Two independent boards retain two Lead rows')
    assert.equal(await primary.locator('details').getAttribute('open'), null)
    assert.equal(await secondary.locator('details').getAttribute('open'), null)
    assert.equal(await primary.getByRole('button', { name: 'View helper Nested check', exact: true }).isVisible(), false)
    await primary.locator('summary').getByText('2 helpers', { exact: true }).waitFor()
    assert.ok(helperCatalogReads.some((params) => params.ancestorThreadId === 'helper-lead-1'), 'Activity loads helpers omitted from the ordinary chat catalog')
    await primary.locator('summary').getByText('2 working', { exact: true }).waitFor()
    await press(primary.locator('summary'))
    await press(secondary.locator('summary'))
    await primary.getByRole('button', { name: 'View helper Layout check', exact: true }).getByText('Working', { exact: true }).waitFor()
    await primary.getByRole('button', { name: 'View helper Nested check', exact: true }).waitFor()
    assert.equal(await primary.getByRole('button', { name: 'View helper Search check', exact: true }).count(), 0)
    await secondary.getByRole('button', { name: 'View helper Search check', exact: true }).waitFor()
    const ordinary = activity.getByRole('region', { name: 'Chats running', exact: true })
    assert.equal(await ordinary.locator('.notification-row').count(), 1)
    await ordinary.getByText('Layout check', { exact: true }).waitFor()
    if (touch) for (const width of [320, 390]) {
      await target.setViewportSize({ width, height: 844 })
      assert.equal(await target.evaluate(() => matchMedia('(pointer: coarse)').matches && document.documentElement.scrollWidth <= innerWidth), true)
      assert.equal(await activity.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
      assert.equal(await activity.locator('.thread-helpers summary, .thread-helpers button').evaluateAll((elements) => elements.every((element) => element.getBoundingClientRect().height >= 44)), true)
      await target.screenshot({ path: join(outputDirectory, `project-board-helpers-${width}-touch.png`), fullPage: true })
    }
    else await target.screenshot({ path: join(outputDirectory, 'project-board-helpers-desktop.png'), fullPage: true })
    await press(primary.getByRole('button', { name: 'View helper Nested check', exact: true }))
    await target.waitForURL('**#/thread/nested-child')
    const helperHeader = target.getByRole('region', { name: 'Helper chat', exact: true })
    await helperHeader.getByText('Managed by the Lead · Build notifications', { exact: true }).waitFor()
    await target.getByText('Context for nested-child.', { exact: true }).waitFor()
    await target.reload({ waitUntil: 'domcontentloaded' })
    await helperHeader.getByText('Managed by the Lead · Build notifications', { exact: true }).waitFor()
    await press(helperHeader.getByRole('button', { name: 'Open Lead', exact: true }))
    await target.waitForURL('**#/thread/helper-lead-1')
    await target.getByRole('region', { name: 'Tracked work', exact: true }).getByText('Build notifications', { exact: true }).waitFor()

    const nested = helperThreads.find((thread) => thread.id === 'nested-child')
    nested.status = { type: 'idle' }; nested.turns[0].status = 'completed'
    helperHistory = [{ id: 'helper-completion', threadId: nested.id, turnId: nested.turns[0].id, status: 'completed', title: 'Nested helper completed', body: 'Internal helper receipt', completedAt: now, readAt: null }]
    await notify('turn/completed', { threadId: nested.id, turn: { id: nested.turns[0].id, status: 'completed' } })
    await press(trigger)
    await press(primary.locator('summary'))
    await primary.getByRole('button', { name: 'View helper Nested check', exact: true }).getByText('Idle', { exact: true }).waitFor()
    assert.equal(await trigger.getAttribute('aria-label'), 'Notifications: 3 running', 'A helper completion cannot add a separate unread badge')
    assert.equal(await activity.getByText('Nested helper completed', { exact: true }).count(), 0, 'Internal completion history stays out of user-facing activity')
    await press(trigger)
    const helperRequest = { id: 8701, receivedAtIso: now, method: 'item/tool/requestUserInput', params: { threadId: 'layout-child', turnId: 'layout-child-turn', itemId: 'helper-question', questions: [{ id: 'scope', question: 'Can the helper keep the current layout?', options: [{ label: 'Keep the current layout', description: 'Continue the reviewed plan.' }, { label: 'Ask the Lead to revise', description: 'Return to planning.' }] }] } }
    helperRequests = [helperRequest]
    await notify('server/request', helperRequest)
    await press(trigger)
    const questionRow = activity.locator('.notification-row').filter({ hasText: 'Answer needed' })
    await questionRow.getByText('Layout check', { exact: true }).waitFor()
    await questionRow.getByText('Product build', { exact: true }).waitFor()
    await press(questionRow)
    await target.waitForURL('**#/thread/layout-child')
    const questionCard = target.locator('.question-card')
    await questionCard.getByText('Can the helper keep the current layout?', { exact: true }).waitFor()
    await questionCard.getByRole('radio', { name: /Keep the current layout/ }).check()
    if (touch) await target.screenshot({ path: join(outputDirectory, 'project-board-helper-question-touch.png'), fullPage: true })
    await press(questionCard.getByRole('button', { name: 'Submit', exact: true }))
    await questionCard.waitFor({ state: 'detached' })
    assert.deepEqual(helperReplies, [{ id: 8701, result: { answers: { scope: { answers: ['Keep the current layout'] } } } }])
    const leadRequest = { ...helperRequest, id: 8702, params: { ...helperRequest.params, threadId: 'helper-lead-1', turnId: 'helper-lead-1-turn' } }
    helperRequests = [leadRequest]
    await notify('server/request', leadRequest)
    await press(trigger)
    const leadWaiting = activity.locator('section').filter({ has: target.locator('.notification-section-header').getByText('Needs you', { exact: true }) })
    await leadWaiting.getByText('Build notifications', { exact: true }).waitFor()
    await leadWaiting.locator('summary').getByText('2 helpers', { exact: true }).waitFor()
    await press(leadWaiting.locator('summary'))
    await leadWaiting.getByRole('button', { name: 'View helper Layout check', exact: true }).waitFor()
    const waitingTitle = await leadWaiting.locator('.notification-row-title').evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element)
      const bounds = element.getBoundingClientRect()
      return { width: bounds.width, height: bounds.height,
        textFits: [...range.getClientRects()].every((rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1) }
    })
    assert.ok(waitingTitle.width >= 100 && waitingTitle.height >= 16 && waitingTitle.textFits, 'The waiting Lead title remains readable beside its status pill')
    assert.equal(await boardWork.getByRole('button', { name: 'Open Lead chat for Build notifications', exact: true }).count(), 0, 'A waiting Lead keeps its helper disclosure in one Needs you row')
    await boardWork.getByRole('button', { name: 'Open Lead chat for Build search', exact: true }).waitFor()
    if (touch) {
      await target.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))))
      await target.screenshot({ path: join(outputDirectory, 'project-board-waiting-lead-helpers-touch.png'), fullPage: true })
    }
  }
  await checkHelperGrouping(page, false)
  await checkHelperGrouping(mobilePage, true)

  assert.deepEqual(pageErrors, [])
  console.log(`Project board smoke passed: inbox decisions and run receipts, questions, draft/retry preservation, direct model settings and inheritance, Plan first, queue consent, chat-to-board entry, grouped helper Activity and nested reload recovery, voice/manual save, dark dialogs, ${mobileEngineName} touch/mobile layout at 320/390/640px, active-board delete guard and confirmed idle-board removal, and ordinary chat navigation. Model execution is verified separately by the native runtime probe.`)
} catch (error) {
  await mobilePage?.screenshot({ path: join(outputDirectory, 'project-board-mobile-failure.png'), fullPage: true }).catch(() => undefined)
  await page?.screenshot({ path: join(outputDirectory, 'project-board-failure.png'), fullPage: true }).catch(() => undefined)
  const renderedCards = await page?.locator('.board-card-main > strong').allTextContents().catch(() => [])
  console.error(JSON.stringify({ pageErrors, navigations, streamConnections, streamMethods: [...streamMethods], renderedCards }, null, 2))
  throw error
} finally {
  await mobileBrowser?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  try { process.kill(-server.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await new Promise((resolveWait) => {
    if (server.exitCode !== null) return resolveWait()
    server.once('exit', resolveWait)
    setTimeout(resolveWait, 2_000).unref()
  })
  await rm(fixtureHome, { recursive: true, force: true })
}
