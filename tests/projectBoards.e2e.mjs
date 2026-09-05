import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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

await writeFile(join(fixtureHome, 'codexui-project-boards.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
const fixtureEnvFile = join(fixtureHome, 'empty.env')
await writeFile(fixtureEnvFile, '', { mode: 0o600 })
await mkdir(outputDirectory, { recursive: true })

const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
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
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  await page.route('**/codex-api/project-board-models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { defaultModel: 'build-model', defaultReasoningEffort: 'high', models: [
    { id: 'build-model', label: 'Build model', reasoningEfforts: ['medium', 'high'], defaultReasoningEffort: 'high' },
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
    await page.getByTestId('board-select').waitFor()
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
  await page.screenshot({ path: join(outputDirectory, 'project-board-desktop.png'), fullPage: true })

  // Route changes cannot retain detail from a different board, project, or missing query.
  await page.getByTestId('board-project-select').selectOption(secondProject)
  await page.locator('[data-feature-id="feature-other"]').waitFor()
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
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  const library = page.getByRole('dialog', { name: 'Agent library' })
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
  assert.match(await agentPrompt.inputValue(), /implementation engineer/u)
  await library.getByRole('button', { name: 'Create copy', exact: true }).click()
  await library.getByRole('button', { name: 'Edit Engineer copy', exact: true }).waitFor()
  await page.keyboard.press('Escape')

  const newFeatureButton = page.getByRole('button', { name: 'New feature', exact: true }).first()
  await newFeatureButton.click()
  const form = page.getByTestId('new-feature-form')
  await form.getByPlaceholder('Add project progress board').fill('Dogfood the board')
  await form.getByPlaceholder('What should be built, and why?').fill('Use the dashboard to track its own improvements.')
  await page.evaluate(async () => {
    const response = await fetch('/codex-api/project-board-cards/feature-review', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Mobile snapshot refreshed' }) })
    if (!response.ok) throw new Error(`Fixture update failed: ${await response.text()}`)
  })
  await page.locator('[data-feature-id="feature-review"]').getByText('Mobile snapshot refreshed', { exact: true }).waitFor()
  assert.equal(await form.getByPlaceholder('Add project progress board').inputValue(), 'Dogfood the board', 'Live snapshots must preserve the current form')
  await rejectOnce('project-board-cards', 'Feature could not be saved.')
  await form.getByRole('button', { name: 'Create feature' }).click()
  await form.getByRole('alert').getByText('Feature could not be saved.').waitFor()
  assert.equal(await form.getByPlaceholder('Add project progress board').inputValue(), 'Dogfood the board')
  await page.keyboard.press('Escape')
  await form.waitFor({ state: 'detached' })
  assert.equal(await newFeatureButton.evaluate((element) => element === document.activeElement), true, 'Closing a modal restores focus')
  await newFeatureButton.click()
  await form.getByPlaceholder('Add project progress board').fill('Dogfood the board')
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

  // Server owns completion truth; failed moves keep the current value and explain why.
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
  assert.deepEqual(startConsent, { allowWorkspaceWrite: true, mode: 'execute' })
  await page.keyboard.press('Escape')
  await detail.getByRole('button', { name: 'Plan first', exact: true }).click()
  await detail.getByRole('alert').getByText('Smoke test does not run a Lead.').waitFor()
  assert.deepEqual(startConsent, { allowWorkspaceWrite: false, mode: 'plan' })

  await page.getByRole('button', { name: 'Close feature', exact: true }).click()
  await visitBoard()
  let queueRequest
  await page.route('**/codex-api/project-boards/board-1/queue', (route) => {
    queueRequest = route.request().postDataJSON()
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Queue is paused for this smoke.' }) })
  })
  await page.getByRole('button', { name: 'Run selected features', exact: true }).click()
  const queueDialog = page.getByRole('dialog', { name: 'Run selected features', exact: true })
  assert.equal(await queueDialog.getByRole('button', { name: 'Start selected features' }).isDisabled(), true)
  await queueDialog.getByRole('checkbox', { name: 'Allow project edits', exact: false }).check()
  await page.screenshot({ path: join(outputDirectory, 'project-board-queue.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await queueDialog.evaluate((element) => element.scrollWidth <= element.clientWidth), 'Queue consent must fit mobile width')
  await page.screenshot({ path: join(outputDirectory, 'project-board-queue-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await queueDialog.getByRole('button', { name: 'Start selected features' }).click()
  await queueDialog.getByRole('alert').getByText('Queue is paused for this smoke.').waitFor()
  assert.equal(queueRequest.allowWorkspaceWrite, true)
  assert.ok(queueRequest.featureIds.includes(savedFeature.id))
  assert.ok(!queueRequest.featureIds.includes('feature-done'))
  await page.keyboard.press('Escape')

  await visitBoard()
  let planRequest
  await page.route('**/codex-api/project-boards/*/plan', (route) => {
    planRequest = route.request().postDataJSON()
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Planning request kept for review.' }) })
  })
  await page.getByRole('button', { name: 'Plan features', exact: true }).click()
  const planning = page.getByRole('dialog', { name: 'Plan project features', exact: true })
  await planning.getByLabel('Goal or plan', { exact: true }).fill('Build shared groundwork once, then two related features. Keep completed work.')
  await planning.getByLabel('Coordinator model', { exact: true }).selectOption('build-model')
  await planning.getByLabel('Coordinator reasoning', { exact: true }).selectOption('high')
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
  assert.equal(planRequest.model, 'build-model')
  assert.equal(planRequest.reasoningEffort, 'high')
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
  await page.getByTestId('project-board').waitFor()

  // Dark surfaces use the same theme token for cards, detail, forms, and selects.
  await visitBoard('?feature=feature-working')
  await detail.getByText('Requested: build-model · high reasoning', { exact: true }).waitFor()
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark' })
  await page.waitForFunction(() => [...document.querySelectorAll('.board-card, .board-detail-panel, .detail-status-select select')].every((element) => getComputedStyle(element).backgroundColor === 'rgb(37, 38, 51)'))
  const darkSurfaces = await page.locator('.board-card, .board-detail-panel, .detail-status-select select').evaluateAll((elements) => elements.map((element) => getComputedStyle(element).backgroundColor))
  assert.ok(darkSurfaces.length > 2 && darkSurfaces.every((color) => color !== 'rgb(255, 255, 255)'), 'Dark mode surfaces must not stay white')
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
  assert.equal(overflow.scrollable, true)
  assert.ok(overflow.documentWidth <= overflow.viewport, 'Only the board lanes may overflow horizontally')
  await page.screenshot({ path: join(outputDirectory, 'project-board-mobile-overview.png'), fullPage: true })
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
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
    else if ((method === 'thread/read' || method === 'thread/resume') && params.threadId === sourceThread.id) result = { thread: sourceThread, model: 'build-model', reasoningEffort: 'high', cwd: emptyProject }
    else if (method === 'thread/read' && params.threadId === childThread.id) result = { thread: childThread }
    else if (method === 'thread/goal/get') result = { goal: null }
    else return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result }) })
  })
  await page.route('**/codex-api/thread-resume-lite', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { thread: sourceThread, model: 'build-model', reasoningEffort: 'high' } }) }))
  await page.route('**/codex-api/thread-page', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { thread: route.request().postDataJSON().threadId === childThread.id ? childThread : sourceThread, page: { startTurnIndex: 0, endTurnIndex: 1, totalTurns: 1, hasEarlier: false } } }) }))
  await page.goto(`${origin}/?chat-import-smoke=1#/thread/${sourceThread.id}`, { waitUntil: 'domcontentloaded' })
  await page.getByText(sourcePlan, { exact: true }).waitFor()
  await page.getByRole('link', { name: 'Open Design review subagent', exact: true }).click()
  await page.waitForURL('**#/thread/unlisted-child')
  await page.getByText('The mobile design review is ready.', { exact: true }).waitFor()
  await page.goBack()
  await page.getByText(sourcePlan, { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Turn this chat into a board', exact: true }).click()
  const chatPlan = page.getByRole('dialog', { name: 'Turn this chat into a board', exact: true })
  assert.equal(await chatPlan.getByLabel('Goal or plan', { exact: true }).inputValue(), sourcePlan)
  await chatPlan.getByLabel('Board name', { exact: true }).fill('Plan from chat')
  assert.ok(await chatPlan.evaluate((element) => element.scrollWidth <= element.clientWidth), 'Chat planning must fit mobile width')
  await page.screenshot({ path: join(outputDirectory, 'project-board-chat-plan-mobile.png'), fullPage: true })
  await chatPlan.getByRole('button', { name: 'Create feature plan' }).click()
  await chatPlan.getByRole('alert').getByText('Planning request kept for review.').waitFor()
  assert.equal(planRequest.sourceThreadId, sourceThread.id)
  assert.equal(planRequest.plan, sourcePlan)
  const afterFirstPlan = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data
  const importedBoard = afterFirstPlan.boards.find((board) => board.name === 'Plan from chat')
  assert.ok(importedBoard)
  await chatPlan.getByRole('button', { name: 'Create feature plan' }).click()
  await chatPlan.getByRole('alert').getByText('Planning request kept for review.').waitFor()
  const afterRetry = (await (await fetch(`${origin}/codex-api/project-boards`)).json()).data
  assert.equal(afterRetry.boards.filter((board) => board.name === 'Plan from chat').length, 1, 'Retry must reuse the created board')
  await page.keyboard.press('Escape')

  // Existing Activity displays a board outcome and navigates directly to its card.
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
  await page.waitForURL('**/#/board/board-1?feature=feature-done')
  await detail.waitFor()

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
  await mobilePage.route('**/codex-api/project-board-models', (route) => route.fulfill({ json: { data: { defaultModel: 'build-model', defaultReasoningEffort: 'high', models: [{ id: 'build-model', label: 'Build model', reasoningEfforts: ['high'], defaultReasoningEffort: 'high' }] } } }))
  await mobilePage.route('**/codex-api/transcribe', (route) => route.fulfill({ json: { text: 'A feature created by voice on mobile.' } }))
  await mobilePage.goto(`${origin}/#/board/board-1`, { waitUntil: 'domcontentloaded' })
  await mobilePage.getByTestId('project-board').waitFor()
  assert.equal(await mobilePage.evaluate(() => matchMedia('(pointer: coarse)').matches), true)
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(await mobilePage.locator('.boards-header-actions').first().getByRole('button').evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth)), true, 'Phone toolbar labels must fit inside their buttons')
  await mobilePage.screenshot({ path: join(outputDirectory, `project-board-${mobileEngineName}-touch.png`), fullPage: true })
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
  await mobilePage.getByRole('button', { name: 'Plan features', exact: true }).tap()
  const touchPlan = mobilePage.getByRole('dialog', { name: 'Plan project features', exact: true })
  await touchPlan.getByLabel('Goal or plan', { exact: true }).fill('Build one small feature, then a dependent improvement.')
  await touchPlan.getByRole('button', { name: 'Create feature plan', exact: true }).scrollIntoViewIfNeeded()
  await mobilePage.screenshot({ path: join(outputDirectory, `project-board-${mobileEngineName}-touch-plan.png`), fullPage: true })
  assert.equal(await touchPlan.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  await touchPlan.getByRole('button', { name: 'Close planning', exact: true }).tap()

  assert.deepEqual(pageErrors, [])
  console.log(`Project board smoke passed: questions, draft/retry preservation, model settings, Plan first, queue consent, chat-to-board entry, Activity and unlisted-child links, voice/manual save, dark dialogs, ${mobileEngineName} touch/mobile layout, and ordinary chat navigation. Model execution is verified separately by the native runtime probe.`)
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
