import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { chromium, devices } from 'playwright'

// Actual App, API client, shared chat state and disposable board persistence.
// The server is frontend-only: no Codex process, notification subscribers or
// credentials are loaded. All API calls and model events stay in this fixture.
const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'codexui-board-chat-flow-'))
const output = join(root, 'output', 'board-chat-flow')
await mkdir(output, { recursive: true })
await build({ entryPoints: [join(root, 'src/server/projectBoardStore.ts')], outfile: join(temporary, 'store.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { ProjectBoardStore } = await import(pathToFileURL(join(temporary, 'store.mjs')).href)
const server = await createServer({ root, configFile: false, plugins: [vue(), tailwind()], resolve: { alias: { '@': `${root}/src` } }, optimizeDeps: { include: ['vue', 'pinia', 'vue-router'] }, server: { host: '127.0.0.1', port: 4195, strictPort: true, watch: null, fs: { allow: [root, await realpath(join(root, 'node_modules'))] } } })
await server.listen()
const origin = 'http://127.0.0.1:4195'
const browser = await chromium.launch({ headless: true })
const errors = []

try {
  for (const mobile of [false, true].filter((value) => !process.env.CODEXUI_BOARD_CHAT_DEVICE || process.env.CODEXUI_BOARD_CHAT_DEVICE === (value ? 'mobile' : 'desktop'))) {
    const label = mobile ? 'mobile' : 'desktop'
    const project = join(temporary, label)
    await mkdir(project)
    const workspaceFile = join(project, 'existing-work.txt')
    const workspaceText = 'Keep the user’s existing project work.\n'
    await writeFile(workspaceFile, workspaceText)
    const store = new ProjectBoardStore({ stateFilePath: join(temporary, `${label}.json`) })
    let snapshot = await store.createBoard({ projectPath: project, projectName: 'Chat workflow', name: 'Product fixes', isDefault: true })
    const board = snapshot.boards[0]
    const sourceId = `source-${label}`
    const leadId = `unlisted-lead-${label}`
    const brief = 'Fix the message list so the last reply stays visible.'
    const finalText = 'The message list fix is complete and its checks passed.'
    const timestamp = Date.now() / 1000
    const thread = (id, name, text, active = false) => ({ id, name, cwd: project, preview: name, source: 'appServer', createdAt: timestamp, updatedAt: timestamp, status: { type: active ? 'active' : 'idle' }, turns: [{ id: `${id}-turn`, status: active ? 'inProgress' : 'completed', items: [{ id: `${id}-message`, type: 'agentMessage', text, phase: 'final_answer' }] }] })
    const sourceThread = thread(sourceId, 'Discuss message list bug', 'We can fix this as one small feature.')
    let leadThread = thread(leadId, 'Feature Lead', 'I am preparing the feature plan.', true)
    const otherThreads = Array.from({ length: 7 }, (_, index) => thread(`older-${index}`, `Existing chat ${index}`, 'Earlier work.'))
    const threads = new Map([[sourceId, sourceThread], [leadId, leadThread], ...otherThreads.map((item) => [item.id, item])])
    const context = await browser.newContext(mobile ? { ...devices['iPhone 13'], deviceScaleFactor: 1 } : { viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
    const mutations = []
    let featureId = ''
    let runId = ''
    let pending = []
    let history = []
    let failReply = true
    let failFirstStart = true
    let holdReply = false
    let releaseReply
    let failStop = true
    let listedLead = false
    const notify = (method, params) => page.evaluate(({ method, params }) => {
      for (const stream of window.fixtureStreams) stream.onmessage?.({ data: JSON.stringify({ method, params }) })
    }, { method, params })
    const publish = async () => { snapshot = await store.read(); await notify('codexui/projectBoards/updated', snapshot) }
    const publishNativeAlert = async (request) => {
      const occurredAt = new Date().toISOString()
      const event = { id: `project-board-native:${request.params.threadId}:${request.params.turnId}:${request.id}`, kind: 'native_request', boardId: board.id, featureId, cardId: featureId, threadId: request.params.threadId, requestId: request.id, requestKind: 'approval', occurredAt }
      history.unshift({ id: event.id, threadId: `project-board:${board.id}:${featureId}`, turnId: event.id, status: 'native_request', title: 'Lead needs your approval', body: 'Open the Lead chat to review the request and continue.', completedAt: occurredAt, readAt: null, projectBoard: event })
      await notify('codexui/projectBoards/notification', event)
    }
    const resolveNativeRequest = async (request, mode) => {
      const resolvedAtIso = new Date().toISOString()
      history = history.map((item) => item.projectBoard?.requestId === request.id ? { ...item, status: 'resolved', readAt: resolvedAtIso, body: 'This Lead request has been resolved.' } : item)
      await notify('server/request/resolved', { id: request.id, method: request.method, threadId: request.params.threadId, mode, resolvedAtIso })
      await notify('codexui/projectBoards/historyUpdated', {})
    }
    await page.addInitScript(({ project, sourceId }) => {
      localStorage.setItem('codex-web-local.new-thread-cwd.v1', project)
      localStorage.setItem('codex-web-local.theme.v1', 'dark')
      window.fixtureStreams = []
      window.EventSource = class { constructor() { window.fixtureStreams.push(this) } close() {} }
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
      window.MediaRecorder = class {
        state = 'inactive'; mimeType = 'audio/webm'
        start() { this.state = 'recording' }
        stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.({ data: new Blob(['fixture audio'], { type: 'audio/webm' }) }); this.onstop?.() }, 0) }
      }
    }, { project, sourceId })
    await page.route('**/codex-api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const input = request.method() === 'GET' || !request.headers()['content-type']?.includes('application/json') ? {} : request.postDataJSON() || {}
      const json = (value, status = 200) => route.fulfill({ status, json: value })
      try {
        if (path === '/codex-api/project-boards') return json({ data: await store.read() })
        if (path === '/codex-api/project-board-cards' && request.method() === 'POST') {
          mutations.push({ kind: 'create', input })
          snapshot = await store.createCard(input)
          featureId = snapshot.cards.find((item) => item.type === 'feature').id
          return json({ data: snapshot })
        }
        if (path === `/codex-api/project-board-cards/${featureId}/start`) {
          mutations.push({ kind: 'start', input })
          if (failFirstStart) { failFirstStart = false; return json({ error: 'The feature was saved, but its Lead could not start. Retry safely.' }, 503) }
          const started = await store.startRun(featureId, 'builtin-lead', input.mode)
          runId = started.run.id
          const startedThreadId = mutations.filter((item) => item.kind === 'create').length === 1 ? leadId : `second-lead-${label}`
          if (!threads.has(startedThreadId)) threads.set(startedThreadId, thread(startedThreadId, 'Second feature Lead', 'I am planning the second feature.', true))
          snapshot = await store.setRunThread(runId, startedThreadId, 2)
          return json({ data: snapshot })
        }
        if (path === `/codex-api/project-board-cards/${featureId}` && request.method() === 'PATCH') {
          mutations.push({ kind: 'rename', input })
          snapshot = await store.updateCard(featureId, input)
          return json({ data: snapshot })
        }
        if (path === `/codex-api/project-board-cards/${featureId}/stop`) {
          mutations.push({ kind: 'stop', input })
          const run = (await store.read()).runs.find((item) => item.cardId === featureId && item.status === 'running')
          assert.equal(input.expectedRunId, run.id, 'Stop targets the displayed run rather than a later replacement')
          if (failStop) { failStop = false; return json({ error: 'The stop request could not reach the server. Try again.' }, 503) }
          snapshot = await store.failRun(run.id, 'Stopped by you. Review partial work before continuing.', 'interrupted')
          const cancelled = pending.filter((item) => item.params.threadId === run.threadId)
          pending = pending.filter((item) => item.params.threadId !== run.threadId)
          for (const request of cancelled) await resolveNativeRequest(request, 'cancelled')
          await notify('turn/completed', { threadId: run.threadId, turn: { id: `${run.threadId}-turn`, status: 'interrupted', items: [] } })
          return json({ data: snapshot })
        }
        if (path === `/codex-api/project-board-cards/${featureId}` && request.method() === 'DELETE') {
          mutations.push({ kind: 'delete' })
          snapshot = await store.deleteCard(featureId)
          return json({ data: snapshot })
        }
        if (path === `/codex-api/project-board-threads/${leadId}/messages`) {
          mutations.push({ kind: 'reply', input })
          if (holdReply) await new Promise((resolveReply) => { releaseReply = resolveReply })
          if (failReply) { failReply = false; return json({ error: 'Connection interrupted. Your draft is safe.' }, 503) }
          return json({ data: await store.read() })
        }
        if (path === '/codex-api/transcribe') return json({ text: brief })
        if (path === '/codex-api/project-board-models') return json({ data: { defaultModel: 'build-model', defaultReasoningEffort: 'high', models: [{ id: 'build-model', label: 'Build model', reasoningEfforts: ['medium', 'high'], defaultReasoningEffort: 'high' }] } })
        if (path === '/codex-api/server-requests') return json({ requests: pending })
        if (path === '/codex-api/server-requests/respond') { const resolved = pending.find((item) => item.id === input.id); pending = pending.filter((item) => item.id !== input.id); if (resolved) await resolveNativeRequest(resolved, 'manual'); return json({ ok: true }) }
        if (path === '/codex-api/push/history') return json({ data: { items: history, unreadCount: history.filter((item) => !item.readAt).length, dismissals: [] } })
        if (path === '/codex-api/push/history/read') { history = history.map((item) => input.all || input.threadId === item.threadId || input.ids?.includes(item.id) ? { ...item, readAt: new Date().toISOString() } : item); return json({ data: { items: history, unreadCount: history.filter((item) => !item.readAt).length, dismissals: [] } }) }
        if (path === '/codex-api/push/config') return json({ data: { supported: false, publicKey: '' } })
        if (path === '/codex-api/telegram/config') return json({ data: { available: false, enabled: false } })
        if (path === '/codex-api/workspace-roots-state') return json({ data: { order: [project], active: [project], labels: { [project]: 'Chat workflow' } } })
        if (path === '/codex-api/home-directory') return json({ homeDirectory: temporary })
        if (path === '/codex-api/pinned-threads') return json({ data: { threadIds: [] } })
        if (path === '/codex-api/thread-read-state') return json({ data: { readAtByThreadId: {}, unreadThreadIds: [], version: 1 } })
        if (path === '/codex-api/automations') return json({ data: { tasks: [], runs: [], proposals: [], version: 1 } })
        if (path === '/codex-api/thread-resume-lite' || path === '/codex-api/thread-page') return json({ result: { thread: threads.get(input.threadId) || sourceThread, model: 'build-model', reasoningEffort: 'high', page: { startTurnIndex: 0, endTurnIndex: 1, totalTurns: 1, hasEarlier: false } } })
        if (path === '/codex-api/rpc') {
          const { method, params = {} } = input
          if (method === 'thread/list') return json({ result: { data: [...otherThreads, sourceThread, ...(listedLead ? [leadThread] : [])], nextCursor: null } })
          if (method === 'thread/read' || method === 'thread/resume') return json({ result: { thread: threads.get(params.threadId) || sourceThread, model: 'build-model', reasoningEffort: 'high', cwd: project } })
          if (method === 'model/list') return json({ result: { data: [{ id: 'build-model', model: 'build-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }] } })
          if (method === 'config/read') return json({ result: { config: { model: 'build-model', model_reasoning_effort: 'high' } } })
          if (method === 'thread/goal/get') return json({ result: { goal: null } })
          if (method === 'thread/name/set') { threads.get(params.threadId).name = params.name; return json({ result: {} }) }
          if (method === 'turn/start' || method === 'thread/start') throw new Error(`Unexpected untracked ${method}`)
          return json({ result: { data: [], skills: [], rateLimits: null, entries: [] } })
        }
        return json({ data: [], requests: [], result: {} })
      } catch (error) { errors.push(`${label}: ${path}: ${error.message}`); return json({ error: error.message }, 500) }
    })

    try {
      await page.goto(`${origin}/#/thread/${sourceId}`, { waitUntil: 'domcontentloaded' })
      await page.getByText('We can fix this as one small feature.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Track on board', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Track on board', exact: true })
      await dialog.getByRole('button', { name: 'Dictate Feature brief', exact: true }).click()
      await dialog.getByRole('button', { name: 'Stop dictating Feature brief', exact: true }).click()
      await dialog.getByText('Ready — review your words before saving.', { exact: true }).waitFor()
      assert.equal(await dialog.getByLabel('Feature brief', { exact: true }).inputValue(), brief)
      assert.equal(await dialog.getByLabel('Feature title', { exact: true }).inputValue(), '')
      assert.equal(mutations.length, 0, 'Stopping dictation must not create or send work')
      assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: join(output, `track-feature-${label}.png`), fullPage: true })
      await dialog.getByRole('button', { name: 'Create feature & plan', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: 'The feature was saved, but its Lead could not start. Retry safely.' }).waitFor()
      assert.equal((await store.read()).cards.filter((item) => item.type === 'feature').length, 1)
      await dialog.getByRole('button', { name: 'Retry opening chat', exact: true }).click()
      await page.waitForURL(`**/#/thread/${leadId}`)
      assert.equal(mutations.filter((item) => item.kind === 'create').length, 1, 'A failed start must reuse the already saved feature')
      const tracked = page.getByRole('region', { name: 'Tracked work', exact: true })
      const openOriginal = async () => {
        const button = tracked.getByRole('button', { name: 'Original chat', exact: true })
        if (!await button.isVisible()) await tracked.locator('summary').click()
        await button.click()
      }
      await tracked.getByRole('button', { name: 'View board', exact: true }).waitFor()
      snapshot = await store.read()
      const feature = snapshot.cards.find((item) => item.id === featureId)
      assert.ok(feature.title && feature.title !== 'Untitled', 'Brief-only input creates a usable title')
      assert.equal(feature.sourceThreadId, sourceId)
      assert.equal(mutations[1].input.mode, 'plan')
      assert.equal(mutations[1].input.allowWorkspaceWrite, false)
      await page.screenshot({ path: join(output, `active-chat-${label}.png`), fullPage: true })
      await openOriginal()
      await page.waitForURL(`**/#/thread/${sourceId}`)
      await page.locator('button[aria-label^="Notifications:"]').click()
      const activity = page.locator('.notification-popover')
      const running = activity.locator('.notification-section').filter({ has: page.getByText('Running', { exact: true }) })
      await running.getByRole('button').filter({ hasText: feature.title }).waitFor()
      assert.equal(await running.getByRole('button').filter({ hasText: feature.title }).count(), 1)
      await page.screenshot({ path: join(output, `board-running-${label}.png`), fullPage: true })
      await running.getByRole('button').filter({ hasText: feature.title }).click()
      await page.waitForURL(`**/#/thread/${leadId}`)
      await openOriginal()
      pending = [{ id: 811, method: 'item/commandExecution/requestApproval', params: { threadId: leadId, turnId: `${leadId}-turn`, itemId: 'approval', command: 'npm test', cwd: project, reason: 'Run the combined checks.' } }]
      await notify('server/request', pending[0])
      await publishNativeAlert(pending[0])
      await page.locator('button[aria-label^="Notifications:"]').click()
      await activity.getByText('Approval needed', { exact: true }).waitFor()
      assert.equal(await activity.getByText('Approval needed', { exact: true }).count(), 1, 'Durable native alert and live request share one Activity row')
      assert.equal(await activity.getByText('Running', { exact: true }).count(), 0, 'Waiting Lead must not also appear as working')
      await page.screenshot({ path: join(output, `board-approval-${label}.png`), fullPage: true })
      await activity.getByRole('button').filter({ hasText: 'Approval needed' }).click()
      await page.waitForURL(`**/#/thread/${leadId}`)
      await page.getByRole('button', { name: 'Accept', exact: true }).click()

      await store.replacePlan(featureId, { summary: 'Repair the final message viewport and check it.', tasks: [{ key: 'fix', title: 'Fix the final message viewport', description: 'Keep the last response visible.', acceptanceCriteria: 'The final text is visible after resizing.', agentId: 'builtin-engineer', taskPurpose: 'work', dependsOn: [] }] }, runId)
      await store.completeRun(runId, 'The plan is ready.')
      await store.completeFeaturePlan(featureId)
      leadThread = thread(leadId, feature.title, 'The plan is ready. Tell me what to refine.')
      threads.set(leadId, leadThread)
      await notify('turn/completed', { threadId: leadId, turn: leadThread.turns[0] })
      await publish()
      await tracked.locator('summary').click()
      await page.getByLabel('Lead reply mode', { exact: true }).selectOption('plan')
      const composer = page.locator('textarea.thread-composer-input')
      await composer.fill('Include a check for the phone keyboard too.')
      if (mobile) assert.equal(await tracked.locator('details').getAttribute('open'), null, 'Focusing the phone composer makes room without changing reply settings')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page.locator('.thread-composer-dictation-status[role="alert"]').filter({ hasText: 'Connection interrupted. Your draft is safe.' }).waitFor()
      assert.equal(await composer.inputValue(), 'Include a check for the phone keyboard too.')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input').value === '')
      const replies = mutations.filter((item) => item.kind === 'reply')
      assert.equal(replies.length, 2)
      assert.equal(replies[1].input.mode, 'plan')
      assert.equal(replies[1].input.input[0].text, 'Include a check for the phone keyboard too.')

      listedLead = true
      await notify('thread/started', { thread: leadThread })
      if (mobile) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
      const leadRow = page.locator(`[data-thread-id="${leadId}"]`).first()
      await leadRow.waitFor({ state: 'visible' })
      assert.equal(await leadRow.locator('.thread-row-board-icon').count(), 1)
      await leadRow.hover()
      await leadRow.getByRole('button', { name: 'Edit chat name', exact: true }).click()
      const nameInput = page.locator(`[data-thread-rename-input="${leadId}"]`)
      await nameInput.fill('Keep the last response visible')
      await nameInput.press('Enter')
      await leadRow.getByText('Keep the last response visible', { exact: true }).waitFor()
      assert.equal((await store.read()).cards.find((item) => item.id === featureId).title, 'Keep the last response visible')
      if (mobile) {
        await leadRow.locator('.thread-main-button').click()
        await page.locator('.mobile-drawer-backdrop').waitFor({ state: 'hidden' })
      }
      await tracked.getByRole('button', { name: 'Keep the last response visible', exact: true }).waitFor()
      await page.locator('.content-header').getByText('Keep the last response visible', { exact: true }).waitFor()
      await page.screenshot({ path: join(output, `linked-chat-${label}.png`), fullPage: true })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (mobile) {
        const controls = await tracked.getByRole('button', { name: 'View board', exact: true }).boundingBox()
        assert.ok(controls.height >= 44, 'Phone board navigation needs a touch-sized target')
        const composerBounds = await composer.boundingBox()
        assert.ok(composerBounds.y >= 0 && composerBounds.y + composerBounds.height <= page.viewportSize().height)
      }

      // A late rejection belongs to the originating Lead draft, even if the
      // user has already opened and typed in another conversation.
      failReply = true; holdReply = true
      assert.equal(await page.getByLabel('Lead reply mode', { exact: true }).inputValue(), 'plan', 'Renaming must preserve the selected reply mode')
      await composer.fill('Also check scrolling after a reconnect.')
      await Promise.all([
        page.waitForRequest((request) => request.url().includes(`/project-board-threads/${leadId}/messages`)),
        page.getByRole('button', { name: 'Send message', exact: true }).click(),
      ])
      await openOriginal()
      await composer.fill('Keep this original chat draft.')
      releaseReply(); holdReply = false
      await page.waitForTimeout(150)
      assert.equal(await composer.inputValue(), 'Keep this original chat draft.')
      if (mobile) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
      await leadRow.locator('.thread-main-button').click()
      assert.equal(await composer.inputValue(), 'Also check scrolling after a reconnect.')

      await tracked.getByRole('button', { name: 'View board', exact: true }).click()
      await page.getByTestId('project-board').waitFor()
      await page.locator('.board-card-main').filter({ hasText: 'Keep the last response visible' }).click()
      await page.getByTestId('feature-detail').getByRole('button', { name: 'Open Lead chat', exact: true }).click()
      await page.waitForURL(`**/#/thread/${leadId}`)

      const execution = await store.startRun(featureId, 'builtin-lead', 'execute')
      await store.setRunThread(execution.run.id, leadId, 2)
      snapshot = await store.read()
      for (const task of snapshot.cards.filter((item) => item.parentCardId === featureId)) {
        await store.updateTaskFromAgent(featureId, task.id, 'start', {}, execution.run.id)
        await store.updateTaskFromAgent(featureId, task.id, 'complete', { summary: 'The fixture completed this task and checked its acceptance criteria.' }, execution.run.id)
      }
      await store.finishFeature(featureId, finalText, execution.run.id)
      await store.completeRun(execution.run.id, finalText)
      await publish()
      const outcome = { id: `outcome-${label}`, kind: 'completed', boardId: board.id, featureId, cardId: featureId, threadId: leadId, occurredAt: new Date().toISOString() }
      history = [{ id: outcome.id, threadId: `project-board:${board.id}:${featureId}`, turnId: outcome.id, status: 'completed', title: 'Feature complete', body: 'Open the Lead chat to review the result.', completedAt: outcome.occurredAt, readAt: null, projectBoard: outcome }]
      leadThread = thread(leadId, feature.title, finalText)
      threads.set(leadId, leadThread)
      await openOriginal()
      await notify('codexui/projectBoards/notification', outcome)
      await page.locator('button[aria-label^="Notifications:"]').click()
      await activity.getByText('Feature complete', { exact: true }).waitFor()
      await activity.getByRole('button').filter({ hasText: 'Feature complete' }).first().click()
      await page.waitForURL(`**/#/thread/${leadId}`)
      await page.getByText(finalText, { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true, 'Completed work needs explicit reopen/access before sending')
      await page.screenshot({ path: join(output, `completed-chat-${label}.png`), fullPage: true })
      await openOriginal()
      await page.getByRole('button', { name: 'Track on board', exact: true }).click()
      await dialog.getByLabel('Feature brief', { exact: true }).fill('Add a compact status summary to the chat header.')
      await dialog.getByRole('button', { name: 'Create feature & plan', exact: true }).click()
      await page.waitForURL(`**/#/thread/second-lead-${label}`)
      assert.equal(mutations.filter((item) => item.kind === 'create').length, 2, 'Starting again from the same source must create a separate feature')
      assert.equal((await store.read()).cards.filter((item) => item.type === 'feature').length, 2)

      pending = [{ id: 812, method: 'item/commandExecution/requestApproval', params: { threadId: `second-lead-${label}`, turnId: `second-lead-${label}-turn`, itemId: 'second-approval', command: 'npm test', cwd: project, reason: 'Verify the feature before continuing.' } }]
      await notify('server/request', pending[0])
      await publishNativeAlert(pending[0])
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'The stop request could not reach the server. Try again.' }).waitFor()
      await tracked.getByRole('button', { name: 'View board', exact: true }).click()
      await page.getByTestId('project-board').getByRole('button', { name: '1 need you', exact: true }).click()
      await page.getByTestId('board-inbox').getByText('Approval needed', { exact: true }).waitFor()
      await page.getByTestId('board-inbox').getByRole('button', { name: 'Review in Lead chat', exact: true }).click()
      await page.waitForURL(`**/#/thread/second-lead-${label}`)
      await tracked.getByRole('button', { name: 'View board', exact: true }).click()
      await page.getByRole('tab', { name: 'Board', exact: true }).click()
      await page.locator('.board-card-main').filter({ hasText: 'Add a compact status summary' }).click()
      const detail = page.getByTestId('feature-detail')
      await detail.getByRole('region', { name: 'Lead request', exact: true }).getByText('Approval needed', { exact: true }).waitFor()
      await detail.getByText('The Lead is waiting for you. Open its chat to review the request, or stop this run.', { exact: true }).waitFor()
      await detail.getByText('Stop the run before deleting. Your code files are kept.', { exact: true }).waitFor()
      assert.equal(await detail.getByRole('button', { name: 'Delete feature', exact: true }).isDisabled(), true, 'Active work must stop before its record can be deleted')
      assert.equal(await detail.getByRole('button', { name: 'Delete feature', exact: true }).isDisabled(), true, 'A rejected stop must keep the active feature protected')
      await detail.getByRole('button', { name: 'Stop run', exact: true }).click()
      await detail.getByRole('button', { name: 'Stop run', exact: true }).waitFor({ state: 'hidden' })
      await detail.getByRole('region', { name: 'Lead request', exact: true }).waitFor({ state: 'hidden' })
      await detail.getByRole('button', { name: 'Delete feature', exact: true }).and(page.locator('button:enabled')).waitFor()
      assert.equal(await detail.getByRole('button', { name: 'Delete feature', exact: true }).isEnabled(), true)
      assert.equal((await store.read()).runs.find((item) => item.cardId === featureId).status, 'interrupted')
      await page.screenshot({ path: join(output, `stopped-feature-${label}.png`), fullPage: true })
      page.once('dialog', (confirmation) => confirmation.accept())
      await detail.getByRole('button', { name: 'Delete feature', exact: true }).click()
      await detail.waitFor({ state: 'hidden' })
      assert.equal((await store.read()).cards.some((item) => item.id === featureId), false)
      assert.equal(await readFile(workspaceFile, 'utf8'), workspaceText, 'Deleting a board card must preserve project files')
      assert.equal(mutations.filter((item) => item.kind === 'stop').length, 2)
      assert.equal(mutations.filter((item) => item.kind === 'delete').length, 1)
      await page.locator('button[aria-label^="Notifications:"]').click()
      assert.equal(await activity.getByText('Approval needed', { exact: true }).count(), 0, 'The stopped turn must not leave a phantom approval notification')
    } catch (error) {
      await page.screenshot({ path: join(output, `failure-${label}.png`), fullPage: true })
      console.error(JSON.stringify({ label, url: page.url(), mutations, errors }, null, 2))
      throw error
    } finally { await context.close() }
  }
  assert.deepEqual(errors, [])
  console.log('Board/chat flow passed on desktop and touch mobile: voice/brief-only tracking, read-only Lead start, linked navigation, Activity, native approvals, reply retry, result navigation and stop-before-delete preserving workspace files. Model and audio output are synthetic.')
} finally { await browser.close(); await server.close(); await rm(temporary, { recursive: true, force: true }) }
