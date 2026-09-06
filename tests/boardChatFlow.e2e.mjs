import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
    let snapshot = await store.createBoard({ projectPath: project, projectName: 'Chat workflow', name: 'Product fixes', isDefault: true, executionAccess: 'project' })
    const board = snapshot.boards[0]
    const sourceId = `source-${label}`
    const leadId = `unlisted-lead-${label}`
    const brief = 'Fix the message list so the last reply stays visible.'
    const finalText = 'The message list fix is complete and its checks passed.'
    const timestamp = Date.now() / 1000
    const thread = (id, name, text, active = false) => ({ id, name, cwd: project, preview: name, source: 'appServer', createdAt: timestamp, updatedAt: timestamp, status: { type: active ? 'active' : 'idle' }, turns: [{ id: `${id}-turn`, status: active ? 'inProgress' : 'completed', items: [{ id: `${id}-message`, type: 'agentMessage', text, phase: 'final_answer' }] }] })
    const sourceThread = thread(sourceId, 'Discuss message list bug', 'We can fix this as one small feature.')
    sourceThread.turns[0].items.unshift({ id: 'casual-reply', type: 'userMessage', content: [{ type: 'text', text: 'ok done?' }] })
    let leadThread = thread(leadId, 'Feature Lead', 'I am preparing the feature plan.', true)
    const otherThreads = Array.from({ length: 7 }, (_, index) => thread(`older-${index}`, `Existing chat ${index}`, 'Earlier work.'))
    const threads = new Map([[sourceId, sourceThread], [leadId, leadThread], ...otherThreads.map((item) => [item.id, item])])
    const context = await browser.newContext(mobile ? { ...devices['iPhone 13'], deviceScaleFactor: 1 } : { viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
    const linkedBoardIds = new Set()
    const readSnapshot = async () => {
      const current = await store.read()
      return { ...current, boards: current.boards.map((entry) => linkedBoardIds.has(entry.id)
        ? { ...entry, sourceThreadId: sourceId, plan: 'Review the feature briefs, dependencies, and checks before starting work.' } : entry) }
    }
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
    let releaseStartup
    const startupReady = new Promise((resolve) => { releaseStartup = resolve })
    let holdStartup = true
    const historyReads = []
    const notify = (method, params) => page.evaluate(({ method, params }) => {
      for (const stream of window.fixtureStreams) stream.onmessage?.({ data: JSON.stringify({ method, params }) })
    }, { method, params })
    const publish = async () => { snapshot = await readSnapshot(); await notify('codexui/projectBoards/updated', snapshot) }
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
      localStorage.setItem('codex-web-local.selected-thread-id.v1', 'older-0')
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
        if (path === '/codex-api/project-boards') return json({ data: await readSnapshot() })
        if (path === '/codex-api/project-board-cards' && request.method() === 'POST') {
          mutations.push({ kind: 'create', input })
          snapshot = await store.createCard(input)
          featureId = snapshot.cards.find((item) => item.type === 'feature').id
          return json({ data: snapshot })
        }
        if (path === `/codex-api/project-board-cards/${featureId}/start`) {
          mutations.push({ kind: 'start', input })
          if (failFirstStart) { failFirstStart = false; return json({ error: 'The feature was saved, but its Lead could not start. Retry safely.' }, 503) }
          const started = await store.startRun(featureId, 'builtin-lead', input.mode, undefined, { model: 'gpt-6-astra', reasoningEffort: 'xhigh' })
          runId = started.run.id
          const startedThreadId = mutations.filter((item) => item.kind === 'create').length === 1 ? leadId : `second-lead-${label}`
          if (!threads.has(startedThreadId)) threads.set(startedThreadId, thread(startedThreadId, 'Second feature Lead', 'I am planning the second feature.', true))
          snapshot = await store.setRunThread(runId, startedThreadId, 2)
          snapshot = await store.confirmRunSettings(runId, startedThreadId, { model: 'gpt-6-astra', reasoningEffort: 'xhigh' })
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
          if ((await store.read()).cards.find((card) => card.id === featureId)?.status === 'done' && !input.expectedTurnId) {
            const conversation = await store.startRun(featureId, 'builtin-lead', 'follow_up')
            await store.setRunThread(conversation.run.id, leadId, 2)
            await publish()
            await notify('turn/started', { threadId: leadId, turn: { id: `${leadId}-follow-up-turn`, status: 'inProgress', items: [] } })
          }
          return json({ data: await store.read() })
        }
        if (path === '/codex-api/transcribe') return json({ text: brief })
        if (path === '/codex-api/project-board-models') {
          const fromSource = new URL(request.url()).searchParams.get('sourceThreadId') === sourceId
          return json({ data: { defaultModel: fromSource ? 'build-model' : 'default-model', defaultReasoningEffort: fromSource ? 'xhigh' : 'high', models: [
            { id: 'default-model', label: 'App default model', reasoningEfforts: ['medium', 'high'], defaultReasoningEffort: 'high' },
            { id: 'build-model', label: 'Build model', reasoningEfforts: ['medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
          ] } })
        }
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
        if (path === '/codex-api/thread-page') historyReads.push(input)
        if (path === '/codex-api/thread-resume-lite' || path === '/codex-api/thread-page') return json({ result: { thread: threads.get(input.threadId) || sourceThread, model: 'build-model', reasoningEffort: input.threadId === sourceId ? 'xhigh' : 'high', page: { startTurnIndex: 0, endTurnIndex: 1, totalTurns: 1, hasEarlier: false } } })
        if (path === '/codex-api/rpc') {
          const { method, params = {} } = input
          if (holdStartup && ['thread/list', 'model/list', 'account/rateLimits/read'].includes(method)) await startupReady
          if (method === 'thread/list') return json({ result: { data: [...otherThreads, sourceThread, ...(listedLead ? [leadThread] : [])], nextCursor: null } })
          if (method === 'thread/read' || method === 'thread/resume') return json({ result: { thread: threads.get(params.threadId) || sourceThread, model: 'build-model', reasoningEffort: params.threadId === sourceId ? 'xhigh' : 'high', cwd: project } })
          if (method === 'model/list') return json({ result: { data: [{ id: 'default-model', model: 'default-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }, { id: 'build-model', model: 'build-model', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }, { reasoningEffort: 'xhigh', description: 'Extra high' }] }] } })
          if (method === 'config/read') return json({ result: { config: { model: 'default-model', model_reasoning_effort: 'high' } } })
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
      assert.ok(historyReads.length > 0)
      assert.ok(historyReads.every((read) => read.threadId === sourceId), 'Reload reads only the routed chat, even while sidebar/account requests are pending')
      assert.equal(historyReads[0].limit, 5, 'Open with a small latest-turn page')
      await page.screenshot({ path: join(output, `startup-chat-${label}.png`), fullPage: true })
      holdStartup = false
      releaseStartup()
      assert.equal(await page.getByRole('region', { name: 'Linked board', exact: true }).count(), 0, 'Ordinary chats do not opt into a board automatically')
      await page.getByRole('button', { name: 'Project board actions', exact: true }).click()
      await page.getByRole('button', { name: 'Open project board', exact: true }).waitFor()
      await page.screenshot({ path: join(output, `board-menu-${label}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Open project board', exact: true }).click()
      await page.waitForURL(`**/#/board/${board.id}`)
      assert.equal(mutations.length, 0, 'Opening the board must not create a feature')
      await page.goBack()
      await page.getByRole('button', { name: 'Project board actions', exact: true }).click()
      await page.getByRole('button', { name: 'Track on board', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Track on board', exact: true })
      assert.equal(await dialog.getByLabel('Feature brief', { exact: true }).inputValue(), '', 'A casual last reply is not a feature brief')
      assert.equal(await dialog.getByRole('button', { name: 'Create feature & plan', exact: true }).isDisabled(), true)
      await page.screenshot({ path: join(output, `empty-track-feature-${label}.png`), fullPage: true })
      await dialog.getByRole('button', { name: 'Have a larger plan? Create several feature cards', exact: true }).click()
      const existingPlan = page.getByRole('dialog', { name: 'Add features to Product fixes', exact: true })
      await existingPlan.waitFor()
      assert.equal(await existingPlan.getByLabel('Goal or plan', { exact: true }).inputValue(), '', 'An empty deliberate brief stays empty instead of copying the last reply')
      assert.equal(await existingPlan.getByLabel('Board name', { exact: true }).count(), 0, 'Track preserves its selected board when expanding into a plan')
      await existingPlan.getByRole('button', { name: 'Close planning', exact: true }).click()
      await page.evaluate(async (id) => {
        const { useComposerDraftStore } = await import('/src/stores/composerDrafts.ts')
        const draft = useComposerDraftStore().draftFor(id)
        draft.text = 'Please implement this.'
        draft.responseTextAnnotations.push({ id: 'selected-plan', text: 'Keep the last reply visible.', annotation: 'Include the phone keyboard.' })
      }, sourceId)
      await page.getByRole('button', { name: 'Project board actions', exact: true }).click()
      await page.getByRole('button', { name: 'Track on board', exact: true }).click()
      assert.equal(await dialog.getByLabel('Feature brief', { exact: true }).inputValue(), 'Please implement this.\n\nKeep the last reply visible.\nInclude the phone keyboard.')
      await page.evaluate(async (id) => {
        const { useComposerDraftStore } = await import('/src/stores/composerDrafts.ts')
        useComposerDraftStore().clearDraft(id)
      }, sourceId)
      await dialog.getByLabel('Feature brief', { exact: true }).fill('')
      await dialog.getByRole('button', { name: 'Dictate Feature brief', exact: true }).click()
      await dialog.getByRole('button', { name: 'Stop dictating Feature brief', exact: true }).click()
      await dialog.getByText('Ready — review your words before saving.', { exact: true }).waitFor()
      assert.equal(await dialog.getByLabel('Feature brief', { exact: true }).inputValue(), brief)
      assert.equal(await dialog.getByLabel('Feature title', { exact: true }).inputValue(), '')
      assert.equal(mutations.length, 0, 'Stopping dictation must not create or send work')
      await dialog.locator('summary').filter({ hasText: 'Lead and model settings' }).click()
      await dialog.getByText('Using build-model · Extra high reasoning.', { exact: true }).waitFor()
      assert.equal(await dialog.getByLabel('Lead model', { exact: true }).inputValue(), '')
      assert.equal(await dialog.getByLabel('Lead reasoning', { exact: true }).inputValue(), '')
      assert.equal(await dialog.getByLabel('Lead reasoning', { exact: true }).locator('option:checked').textContent(), 'Use source chat settings')
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
      assert.equal(feature.model, '', 'Inherited model stays unset on the saved card')
      assert.equal(feature.reasoningEffort, '', 'Inherited source effort stays unset on the saved card')
      assert.equal(mutations[1].input.mode, 'plan')
      assert.equal(mutations[1].input.allowWorkspaceWrite, false)
      await tracked.getByTestId('board-run-settings').getByText(/gpt-6-astra/).waitFor()
      assert.match(await tracked.getByTestId('board-run-settings').textContent(), /This run:.*gpt-6-astra.*Extra high.*Confirmed by Codex/s)
      const settingBounds = await tracked.getByTestId('board-run-settings').boundingBox()
      assert.ok(settingBounds.x >= 0 && settingBounds.x + settingBounds.width <= page.viewportSize().width, 'Confirmed run settings fit the chat width')
      await tracked.getByText('Planning is read-only. Finish or stop this run to switch to work.', { exact: true }).waitFor()
      assert.equal(await tracked.getByLabel('Lead reply mode', { exact: true }).count(), 0, 'A running plan does not pretend its active turn can change mode')
      await page.screenshot({ path: join(output, `active-chat-${label}.png`), fullPage: true })

      // A managed Lead may plan another board without losing its current run
      // controls. The new review destination appears alongside tracked work.
      const leadPlannedBoardId = randomUUID()
      await store.saveDraftPlan({ boardId: leadPlannedBoardId, projectPath: project, sourceThreadId: leadId, expectedVersion: (await store.read()).version,
        name: 'Lead follow-up plan', summary: 'Review this separate initiative before starting it.',
        features: [{ id: randomUUID(), title: 'Follow-up feature', description: 'A separate increment.', acceptanceCriteria: 'Its result is reviewable.', agentId: 'builtin-lead', verificationPolicy: 'self', dependsOn: [] }] })
      const leadPlanSnapshot = await readSnapshot()
      await notify('codexui/projectBoards/updated', { ...leadPlanSnapshot,
        boards: leadPlanSnapshot.boards.map((entry) => entry.id === board.id ? { ...entry, sourceThreadId: leadId } : entry) })
      const leadLinked = page.getByRole('region', { name: 'Linked board', exact: true })
      await leadLinked.getByText('Lead follow-up plan', { exact: true }).waitFor()
      assert.equal(await leadLinked.getByRole('combobox', { name: 'Linked board', exact: true }).count(), 0, 'The managed board is excluded even when it refers to this chat as its source')
      assert.equal(await tracked.count(), 1, 'A linked plan must retain the existing managed Lead context')
      assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isEnabled(), true)
      assert.equal(await leadLinked.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: join(output, `lead-linked-board-${label}.png`), fullPage: true })
      const mutationsBeforeLeadReview = mutations.length
      await leadLinked.getByRole('button', { name: 'Review board', exact: true }).click()
      await page.waitForURL(`**/#/board/${leadPlannedBoardId}`)
      await page.getByTestId('project-board').getByText('Follow-up feature', { exact: true }).waitFor()
      await page.goBack()
      await tracked.getByRole('button', { name: 'View board', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isEnabled(), true)
      await page.getByRole('button', { name: 'Project board actions', exact: true }).click()
      await page.getByRole('button', { name: 'Review Lead follow-up plan', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Open feature', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      assert.equal(mutations.length, mutationsBeforeLeadReview, 'Reviewing a Lead-created board does not start or stop either board')
      await store.deleteBoard(leadPlannedBoardId)
      await publish()
      await leadLinked.waitFor({ state: 'detached' })
      await openOriginal()
      await page.waitForURL(`**/#/thread/${sourceId}`)
      const ordinaryRunning = otherThreads[0]
      ordinaryRunning.status = { type: 'active' }
      ordinaryRunning.turns[0].status = 'inProgress'
      await notify('thread/started', { thread: ordinaryRunning })
      await page.locator('button[aria-label^="Notifications:"]').click()
      const activity = page.locator('.notification-popover')
      const boardWork = activity.getByRole('region', { name: 'Board work', exact: true })
      const ordinaryWork = activity.getByRole('region', { name: 'Chats running', exact: true })
      const openBoardLead = boardWork.getByRole('button', { name: `Open Lead chat for ${feature.title}`, exact: true })
      await openBoardLead.waitFor()
      await ordinaryWork.getByText(ordinaryRunning.name, { exact: true }).waitFor()
      assert.equal(await openBoardLead.count(), 1, 'Unlisted board Leads have one dedicated current-work entry')
      assert.equal(await ordinaryWork.getByText(feature.title, { exact: true }).count(), 0)
      listedLead = true
      await notify('thread/started', { thread: leadThread })
      assert.equal(await openBoardLead.count(), 1, 'Listing the native Lead must not duplicate its board row')
      assert.equal(await ordinaryWork.getByText(leadThread.name, { exact: true }).count(), 0)
      const boardButton = boardWork.getByRole('button', { name: `View board for ${feature.title}`, exact: true })
      const boardButtonBounds = await boardButton.boundingBox()
      assert.ok(boardButtonBounds.width >= 44 && boardButtonBounds.height >= 44, 'Board navigation remains touch-sized')
      await page.screenshot({ path: join(output, `board-running-${label}.png`), fullPage: true })
      // A finished turn with unfinished work remains discoverable as paused.
      const pausedView = await readSnapshot()
      pausedView.runs.find((run) => run.id === runId).status = 'succeeded'
      await notify('codexui/projectBoards/updated', pausedView)
      await boardWork.getByText('Paused', { exact: true }).waitFor()
      await page.screenshot({ path: join(output, `board-paused-${label}.png`), fullPage: true })
      await publish()
      await boardWork.getByText('Working', { exact: true }).waitFor()
      await boardButton.click()
      await page.waitForURL(`**/#/board/${board.id}?feature=${featureId}`)
      await page.goBack()
      await page.waitForURL(`**/#/thread/${sourceId}`)
      await page.locator('button[aria-label^="Notifications:"]').click()
      await openBoardLead.click()
      await page.waitForURL(`**/#/thread/${leadId}`)
      await openOriginal()
      pending = [{ id: 811, method: 'item/commandExecution/requestApproval', params: { threadId: leadId, turnId: `${leadId}-turn`, itemId: 'approval', command: 'npm test', cwd: project, reason: 'Run the combined checks.' } }]
      await notify('server/request', pending[0])
      await publishNativeAlert(pending[0])
      await page.locator('button[aria-label^="Notifications:"]').click()
      await activity.getByText('Approval needed', { exact: true }).waitFor()
      assert.equal(await activity.getByText('Approval needed', { exact: true }).count(), 1, 'Durable native alert and live request share one Activity row')
      assert.equal(await boardWork.count(), 0, 'Waiting Lead appears only in Needs you, not duplicated as working')
      assert.equal(await ordinaryWork.getByText(ordinaryRunning.name, { exact: true }).count(), 1, 'Ordinary chat work stays separate while the board waits')
      assert.equal(await activity.locator('.notification-board-label').filter({ hasText: board.name }).count(), 1)
      await page.screenshot({ path: join(output, `board-approval-${label}.png`), fullPage: true })
      ordinaryRunning.status = { type: 'idle' }
      ordinaryRunning.turns[0].status = 'completed'
      await notify('thread/status/changed', { threadId: ordinaryRunning.id, status: { type: 'idle' } })
      await activity.getByRole('button').filter({ hasText: 'Approval needed' }).click()
      await page.waitForURL(`**/#/thread/${leadId}`)
      await tracked.getByText('Approval needed', { exact: true }).waitFor()
      await page.getByRole('article', { name: 'Permission to run a command', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Accept', exact: true }).click()

      await store.replacePlan(featureId, { summary: 'Repair the final message viewport and check it.', tasks: [{ key: 'fix', title: 'Fix the final message viewport', description: 'Keep the last response visible.', acceptanceCriteria: 'The final text is visible after resizing.', agentId: 'builtin-engineer', taskPurpose: 'work', dependsOn: [] }] }, runId)
      await store.completeRun(runId, 'The plan is ready.')
      await store.completeFeaturePlan(featureId)
      leadThread = thread(leadId, feature.title, 'The plan is ready. Tell me what to refine.')
      threads.set(leadId, leadThread)
      await notify('turn/completed', { threadId: leadId, turn: leadThread.turns[0] })
      await publish()
      const replyMode = tracked.getByLabel('Lead reply mode', { exact: true })
      await replyMode.waitFor()
      assert.equal(await tracked.locator('details').getAttribute('open'), null, 'Reply mode remains visible outside collapsed settings')
      await replyMode.selectOption('plan')
      const composer = page.locator('textarea.thread-composer-input')
      await composer.fill('Include a check for the phone keyboard too.')
      if (mobile) assert.equal(await tracked.locator('details').getAttribute('open'), null, 'Focusing the phone composer makes room without changing reply settings')
      const mutationsBeforeModeChange = mutations.length
      await replyMode.selectOption('execute')
      assert.equal(await composer.inputValue(), 'Include a check for the phone keyboard too.')
      assert.equal(mutations.length, mutationsBeforeModeChange, 'Changing reply mode must not send or start anything')
      await replyMode.selectOption('plan')
      await tracked.getByText('Read-only. Switch back here at any time.', { exact: true }).waitFor()
      const replyModeBounds = await replyMode.boundingBox()
      assert.ok(replyModeBounds.x >= 0 && replyModeBounds.x + replyModeBounds.width <= page.viewportSize().width)
      if (mobile) assert.ok(replyModeBounds.height >= 44, 'The visible mode switch is touch-sized')
      await page.screenshot({ path: join(output, `reply-mode-${label}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page.locator('.thread-composer-dictation-status[role="alert"]').filter({ hasText: 'Connection interrupted. Your draft is safe.' }).waitFor()
      assert.equal(await composer.inputValue(), 'Include a check for the phone keyboard too.')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input').value === '')
      const replies = mutations.filter((item) => item.kind === 'reply')
      assert.equal(replies.length, 2)
      assert.equal(replies[1].input.mode, 'plan')
      assert.equal(replies[1].input.input[0].text, 'Include a check for the phone keyboard too.')

      await store.updateBoard(board.id, { executionAccess: 'full-access' })
      await publish()
      if (await tracked.locator('details').getAttribute('open') === null) await tracked.locator('summary').click()
      await page.getByLabel('Lead reply mode', { exact: true }).selectOption('execute')
      assert.equal(await tracked.getByRole('checkbox', { name: 'Allow workspace changes', exact: true }).count(), 0)
      await composer.fill('Continue the approved work with the board access setting.')
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true)
      await page.screenshot({ path: join(output, `full-access-chat-${label}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input').value === '')
      const fullReply = mutations.filter((item) => item.kind === 'reply').at(-1)
      assert.equal(fullReply.input.mode, 'execute')
      assert.equal(fullReply.input.executionAccess, 'full-access')
      await store.updateBoard(board.id, { executionAccess: 'project' })
      await publish()
      if (await tracked.locator('details').getAttribute('open') === null) await tracked.locator('summary').click()
      await page.getByLabel('Lead reply mode', { exact: true }).selectOption('plan')

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
      await page.getByTestId('feature-detail').getByRole('button', { name: 'Review result in Lead chat', exact: true }).click()
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
      await composer.fill('Where can I open the result, and how do I test it?')
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true, 'A question about completed work needs neither reopening nor project write consent')
      assert.equal(await page.getByRole('checkbox', { name: 'Reopen feature', exact: true }).count(), 0)
      await tracked.getByText('Ask questions or request changes here. Questions keep the card done; the Lead reopens it when starting changes.', { exact: true }).waitFor()
      await page.screenshot({ path: join(output, `completed-chat-${label}.png`), fullPage: true })
      failReply = false
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await tracked.getByText('Conversation', { exact: true }).waitFor()
      assert.equal(mutations.at(-1).kind, 'reply')
      assert.equal(mutations.at(-1).input.reopenAndSend, undefined)
      assert.equal(mutations.at(-1).input.allowWorkspaceWrite, false)
      await page.waitForFunction(() => document.querySelector('button[aria-label="Stop"]')?.disabled === false)
      assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isEnabled(), true)
      const conversationState = await store.read()
      const conversationRun = conversationState.runs.find((run) => run.kind === 'follow_up')
      const completedCard = conversationState.cards.find((card) => card.id === featureId)
      assert.equal(completedCard.status, 'done')
      assert.equal(completedCard.summary, finalText)
      assert.equal(completedCard.lastRunId, execution.run.id, 'Conversation does not replace the implementation result')
      await page.screenshot({ path: join(output, `follow-up-chat-${label}.png`), fullPage: true })
      await store.completeRun(conversationRun.id, 'The result is ready to inspect.')
      await publish()
      await notify('turn/completed', { threadId: leadId, turn: { id: `${leadId}-follow-up-turn`, status: 'completed', items: [] } })
      await openOriginal()
      await page.getByRole('button', { name: 'Project board actions', exact: true }).click()
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
      await detail.locator('.feature-options > summary').click()
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
      await page.locator('button[aria-label^="Notifications:"]').click()

      // A chat-created plan links the ordinary source chat without making it a
      // managed Lead. Keep two linked boards visible and review the exact result.
      snapshot = await store.createBoard({ projectPath: project, projectName: 'Chat workflow', name: 'Next release' })
      const nextBoard = snapshot.boards.find((entry) => entry.id !== board.id)
      assert.equal(nextBoard.executionAccess, 'full-access', 'New boards default to full access')
      linkedBoardIds.add(board.id)
      linkedBoardIds.add(nextBoard.id)
      await publish()
      await page.goto(`${origin}/#/thread/${sourceId}`, { waitUntil: 'domcontentloaded' })
      const linked = page.getByRole('region', { name: 'Linked board', exact: true })
      await linked.getByRole('button', { name: 'Review board', exact: true }).waitFor()
      await linked.getByRole('combobox', { name: 'Linked board', exact: true }).selectOption(board.id)
      await linked.getByText('1/1 done · Plan, results, and checks', { exact: true }).waitFor()
      assert.equal(await tracked.count(), 0, 'A board plan must not change the ordinary chat composer into a managed Lead')
      assert.equal(await linked.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: join(output, `linked-boards-${label}.png`), fullPage: true })
      const mutationsBeforeReview = mutations.length
      await linked.getByRole('combobox', { name: 'Linked board', exact: true }).selectOption(nextBoard.id)
      await linked.getByText('0/0 done · Plan, results, and checks', { exact: true }).waitFor()
      await linked.getByRole('button', { name: 'Review board', exact: true }).click()
      await page.waitForURL(`**/#/board/${nextBoard.id}`)
      await page.getByRole('button', { name: 'Board options', exact: true }).click()
      await page.getByRole('button', { name: 'Original chat', exact: true }).click()
      await page.waitForURL(`**/#/thread/${sourceId}`)
      await page.getByRole('button', { name: 'Project board actions', exact: true }).click()
      await page.getByRole('button', { name: 'Review Next release', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Review Product fixes', exact: true }).click()
      await page.waitForURL(`**/#/board/${board.id}`)
      await page.getByRole('button', { name: 'Board options', exact: true }).click()
      await page.getByRole('button', { name: 'Add from a plan', exact: true }).click()
      await existingPlan.waitFor()
      assert.equal(await existingPlan.getByLabel('Goal or plan', { exact: true }).inputValue(), '', 'Adding work to a populated board starts a fresh brief')
      await existingPlan.getByRole('button', { name: 'Close planning', exact: true }).click()
      // A stale or interrupted screen download must not leave All work blank.
      // Hold the real component request to check loading, then fail it once.
      let failOverviewDownload
      const overviewDownload = new Promise((resolve) => { failOverviewDownload = resolve })
      await page.route('**/src/components/content/BoardWorkOverview.vue', async (request) => {
        await overviewDownload
        await request.abort('failed')
      })
      await page.getByRole('button', { name: 'All work', exact: true }).click()
      await page.getByRole('status').getByText('Opening this screen…', { exact: true }).waitFor()
      failOverviewDownload()
      const failedScreen = page.getByRole('alert').filter({ hasText: 'This screen couldn’t load' })
      await failedScreen.waitFor()
      assert.equal(await failedScreen.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: join(output, `screen-load-error-${label}.png`), fullPage: true })
      assert.ok(await failedScreen.getByRole('button', { name: 'Refresh app' }).isEnabled())
      await page.unroute('**/src/components/content/BoardWorkOverview.vue')
      await Promise.all([
        page.waitForEvent('domcontentloaded'),
        failedScreen.getByRole('button', { name: 'Refresh app', exact: true }).click(),
      ])
      await page.waitForURL('**/#/boards')
      const overview = page.getByTestId('board-work-overview')
      await overview.waitFor()
      const overviewBoards = overview.getByRole('region', { name: 'Your boards', exact: true })
      const overviewFilter = overview.getByRole('combobox', { name: 'Filter boards by project', exact: true })
      assert.equal(await overviewFilter.inputValue(), '')
      await overviewFilter.selectOption(project)
      assert.equal(await overviewBoards.locator('article').count(), 2, 'Filtering retains both independently linked boards in the same project')
      const recentResults = overview.getByRole('region', { name: 'Recent results', exact: true })
      await recentResults.getByText(finalText, { exact: true }).waitFor()
      assert.equal(await overviewBoards.evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector('[data-overview-section="results"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'Board navigation comes before detailed results')
      assert.equal(mutations.length, mutationsBeforeReview, 'Selecting an overview project does not alter its cards or runs')
      assert.equal(await overview.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: join(output, `work-overview-${label}.png`), fullPage: true })
      await recentResults.getByRole('button', { name: 'Review result', exact: true }).click()
      await page.waitForURL(`**/#/thread/${leadId}`)
      await page.goBack()
      await overview.waitFor()
      await overview.getByRole('region', { name: 'Your boards', exact: true }).locator('article').filter({ has: page.getByRole('heading', { name: 'Product fixes', exact: true }) }).getByRole('button', { name: 'Open board', exact: true }).click()
      await page.waitForURL(`**/#/board/${board.id}`)
      await page.locator(`[data-feature-id="${feature.id}"] .board-card-main`).click()
      const result = detail.getByRole('region', { name: 'Feature result', exact: true })
      await result.getByText(finalText, { exact: true }).waitFor()
      assert.equal(await detail.getByRole('heading', { name: 'Plan ready', exact: true }).count(), 0, 'Completed work must not be described as waiting to start')
      await result.getByText('For code changes, open Summary → Changes in the chat.', { exact: true }).waitFor()
      assert.equal(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
      const resultBounds = await result.boundingBox()
      assert.ok(resultBounds.y < 200, 'Review starts with the result, ahead of settings and administration')
      assert.equal(await detail.getByRole('button', { name: 'Delete feature', exact: true }).isVisible(), false, 'Delete is tucked into feature settings')
      await page.screenshot({ path: join(output, `review-result-${label}.png`), fullPage: true })
      await detail.getByRole('button', { name: 'Review result in Lead chat', exact: true }).click()
      await page.waitForURL(`**/#/thread/${leadId}`)
      await page.getByText(finalText, { exact: true }).waitFor()
      assert.equal(mutations.length, mutationsBeforeReview, 'Reviewing a plan or result must not start or change work')

      // A dedicated board planner stays planning; returning to the source is
      // explicit navigation and must not start implementation or lose drafts.
      const plannerId = `planner-${label}`
      const plannerRun = await store.startBoardPlan(nextBoard.id, 'builtin-lead', 'Plan the next release.', sourceId)
      await store.setRunThread(plannerRun.run.id, plannerId, 2)
      await store.completeRun(plannerRun.run.id, 'The draft cards are ready to review.')
      threads.set(plannerId, thread(plannerId, 'Next release planner', 'Review the cards before starting work.'))
      await publish()
      await page.goto(`${origin}/#/thread/${plannerId}`, { waitUntil: 'domcontentloaded' })
      await tracked.getByText('This chat plans board cards. Review the cards to start work, or return to a normal chat.', { exact: true }).waitFor()
      assert.equal(await replyMode.count(), 0, 'Board planning cannot turn into an untracked execution chat')
      await composer.fill('Preserve my planning notes.')
      await page.screenshot({ path: join(output, `planner-exit-${label}.png`), fullPage: true })
      await tracked.getByRole('button', { name: 'Review cards', exact: true }).click()
      await page.waitForURL(`**/#/board/${nextBoard.id}`)
      await page.goBack()
      await tracked.getByRole('button', { name: 'Back to original chat', exact: true }).click()
      await page.waitForURL(`**/#/thread/${sourceId}`)
      assert.equal(await tracked.count(), 0, 'Original chat keeps its ordinary composer')
      await page.goBack()
      await tracked.getByRole('button', { name: 'Back to original chat', exact: true }).waitFor()
      assert.equal(await composer.inputValue(), 'Preserve my planning notes.')
      assert.equal(mutations.length, mutationsBeforeReview, 'Leaving planning must not execute or rewrite the board')

      // Board navigation uses Cmd/Ctrl+B without touching the sidebar or draft.
      await tracked.getByRole('button', { name: 'Back to original chat', exact: true }).click()
      const shortcutDraft = 'Keep this draft while I review all project boards.'
      await composer.fill(shortcutDraft)
      if (!mobile && await page.getByRole('button', { name: 'Expand sidebar', exact: true }).count()) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
      const sidebarBeforeShortcut = await page.locator('.desktop-sidebar').count()
      const ignoredBoardKeys = await composer.evaluate((element) => [
        { isComposing: true }, { shiftKey: true }, { altKey: true },
      ].map((extra) => {
        const event = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true, bubbles: true, cancelable: true, ...extra })
        element.dispatchEvent(event)
        return event.defaultPrevented
      }))
      assert.deepEqual(ignoredBoardKeys, [false, false, false])
      assert.ok(page.url().endsWith(`#/thread/${sourceId}`))
      await page.keyboard.press('Meta+k')
      const searchDialog = page.getByRole('dialog', { name: 'Search chats', exact: true })
      await searchDialog.waitFor()
      await page.keyboard.press('Meta+b')
      assert.ok(page.url().endsWith(`#/thread/${sourceId}`), 'The board shortcut cannot navigate behind a modal dialog')
      await searchDialog.getByRole('button', { name: 'Close search', exact: true }).click()
      for (const shortcut of ['Meta+b', 'Control+b']) {
        await composer.focus()
        await page.keyboard.press(shortcut)
        await page.waitForURL('**/#/boards')
        await overview.waitFor()
        if (!mobile) assert.equal(await page.locator('.desktop-sidebar').count(), sidebarBeforeShortcut, 'Opening boards must not toggle the desktop sidebar')
        await page.goBack()
        await page.waitForURL(`**/#/thread/${sourceId}`)
        assert.equal(await composer.inputValue(), shortcutDraft)
      }
      assert.equal(mutations.length, mutationsBeforeReview, 'Keyboard navigation never starts or changes board work')

      // The main workspace picker keeps an unsuccessful target and retries it
      // without losing the draft for a new chat or creating any runtime work.
      await page.getByRole('button', { name: mobile ? 'Start new thread' : 'New chat', exact: true }).first().click()
      const homeDraft = 'Keep my new-chat draft while I choose its folder.'
      const folderPath = join(project, 'workspace picked for retry')
      await composer.fill(homeDraft)
      const folderRequests = []
      let releaseFolderFailure
      const heldFolderFailure = new Promise((resolve) => { releaseFolderFailure = resolve })
      await page.route('**/codex-api/project-root', async (route) => {
        folderRequests.push(route.request().postDataJSON())
        if (folderRequests.length === 1) {
          await heldFolderFailure
          return route.fulfill({ status: 503, json: { error: 'Folder registration is temporarily unavailable.' } })
        }
        return route.fulfill({ json: { data: { path: folderPath } } })
      })
      const workspacePicker = page.getByRole('button', { name: 'Choose workspace folder', exact: true })
      await workspacePicker.click()
      await page.getByRole('button', { name: 'Create folder or enter a path', exact: true }).click()
      await page.getByRole('textbox', { name: 'Project name or absolute path', exact: true }).fill(folderPath)
      await page.getByRole('button', { name: 'Open', exact: true }).click()
      await page.getByRole('status').getByText('Opening project…', { exact: true }).waitFor()
      assert.equal(await workspacePicker.isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true, 'A draft cannot launch in the old folder while its replacement is opening')
      releaseFolderFailure()
      const folderError = page.locator('.new-thread-project-error[role="alert"]')
      await folderError.getByText('Folder registration is temporarily unavailable.', { exact: true }).waitFor()
      await folderError.getByText(folderPath, { exact: true }).waitFor()
      assert.equal(await composer.inputValue(), homeDraft)
      await page.screenshot({ path: join(output, `workspace-retry-${label}.png`), fullPage: true })
      await folderError.getByRole('button', { name: 'Retry opening project', exact: true }).click()
      await folderError.waitFor({ state: 'detached' })
      await workspacePicker.getByText('workspace picked for retry', { exact: true }).waitFor()
      assert.deepEqual(folderRequests, [{ path: folderPath, createIfMissing: false, label: '' }, { path: folderPath, createIfMissing: false, label: '' }])
      assert.equal(await workspacePicker.textContent(), 'workspace picked for retry')
      assert.equal(await composer.inputValue(), homeDraft)
      assert.equal(mutations.length, mutationsBeforeReview)
    } catch (error) {
      await page.screenshot({ path: join(output, `failure-${label}.png`), fullPage: true })
      console.error(JSON.stringify({ label, url: page.url(), mutations, errors }, null, 2))
      throw error
    } finally { await context.close() }
  }
  assert.deepEqual(errors, [])
  console.log('Board/chat flow passed on desktop and touch mobile: voice/brief-only tracking, read-only Lead start, linked navigation, Activity, native approvals, reply retry, linked source-board selection, result review and stop-before-delete preserving workspace files. Model and audio output are synthetic.')
} finally { await browser.close(); await server.close(); await rm(temporary, { recursive: true, force: true }) }
