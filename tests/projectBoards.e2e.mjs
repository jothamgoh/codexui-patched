import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

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
    card({ id: 'task-qa', parentCardId: 'feature-working', type: 'task', title: 'Validate feature', status: 'backlog', assignedAgentId: 'builtin-qa', dependencyIds: ['task-engineer'], progressNote: 'Waiting for dependencies' }),
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
  runs: [{ id: 'run-1', boardId: 'board-1', cardId: 'feature-working', agentId: 'builtin-lead', kind: 'execute', status: 'running', threadId: '', startedAtIso: now, finishedAtIso: '', summary: '', error: '' }],
}

snapshot.boards.push({ ...snapshot.boards[0], id: 'board-2', projectPath: secondProject, projectName: 'Second smoke project', name: 'Another board' })
snapshot.questions.push({ ...snapshot.questions[0], id: 'question-2', prompt: 'Which feature should ship first?' })

await writeFile(join(fixtureHome, 'codexui-project-boards.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
await mkdir(outputDirectory, { recursive: true })

const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    CODEX_HOME: fixtureHome,
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
try {
  await waitForServer()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
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
  await page.screenshot({ path: join(outputDirectory, 'project-board-overview.png'), fullPage: true })

  const newFeatureButton = page.getByRole('button', { name: 'New feature', exact: true }).first()
  await newFeatureButton.click()
  const form = page.getByTestId('new-feature-form')
  await form.getByPlaceholder('Add project progress board').fill('Dogfood the board')
  await form.getByPlaceholder('What should be built, and why?').fill('Use the dashboard to track its own improvements.')
  await page.evaluate(async () => {
    const response = await fetch('/codex-api/project-board-cards/feature-done', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Storage snapshot refreshed' }) })
    if (!response.ok) throw new Error('Fixture update failed')
  })
  await page.locator('[data-feature-id="feature-done"]').getByText('Storage snapshot refreshed', { exact: true }).waitFor()
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
  await form.getByRole('button', { name: 'Create feature' }).click()
  await detail.getByText('Dogfood the board', { exact: true }).waitFor()

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
  assert.deepEqual(startConsent, { allowWorkspaceWrite: true })
  await page.keyboard.press('Escape')

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
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByText("Let's build", { exact: true }).waitFor()
  await page.locator('button[aria-label^="Notifications:"]').waitFor()
  await page.getByRole('button', { name: 'Project boards', exact: true }).click()
  await page.getByTestId('project-board').waitFor()

  // Dark surfaces use the same theme token for cards, detail, forms, and selects.
  await visitBoard('?feature=feature-working')
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

  console.log('Project board smoke passed: seeded questions, preserved drafts, guarded moves, consent transport, scoped routes, dark dialogs, mobile scrolling, and ordinary chat navigation. Lead orchestration is covered separately by the fake service adapter.')
} catch (error) {
  await page?.screenshot({ path: join(outputDirectory, 'project-board-failure.png'), fullPage: true }).catch(() => undefined)
  const renderedCards = await page?.locator('.board-card-main > strong').allTextContents().catch(() => [])
  console.error(JSON.stringify({ pageErrors, navigations, streamConnections, streamMethods: [...streamMethods], renderedCards }, null, 2))
  throw error
} finally {
  await browser?.close().catch(() => undefined)
  try { process.kill(-server.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await new Promise((resolveWait) => {
    if (server.exitCode !== null) return resolveWait()
    server.once('exit', resolveWait)
    setTimeout(resolveWait, 2_000).unref()
  })
  await rm(fixtureHome, { recursive: true, force: true })
}
