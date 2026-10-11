import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { chromium } from 'playwright'

// The whole app (real router, App.vue, composer, notification panel) on a
// frontend-only Vite server. Every /codex-api request is answered from the
// fixtures below; no bridge, Codex or Claude process runs. Fictional data only.
const root = fileURLToPath(new URL('..', import.meta.url))
const output = `${root}/output/voice-pages`
await mkdir(output, { recursive: true })
await writeFile(`${output}/index.html`, '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>')

const NOW = Date.now()
const iso = (minutes) => new Date(NOW - minutes * 60_000).toISOString()
const secs = (minutes) => Math.floor((NOW - minutes * 60_000) / 1000)
const code = (letter) => letter.repeat(24)

const ROWS = {
  webhook: { threadId: 'thread-webhook', title: 'Stripe webhook bug', projectName: 'hr-ai', agent: 'codex', status: 'unread', updatedAtIso: iso(4), summary: 'Fixed: the webhook read the parsed body. Tests pass.' },
  bounces: { threadId: 'thread-bounces', title: 'Customer email bounces', projectName: 'hr-ai', agent: 'codex', status: 'unread', updatedAtIso: iso(18), summary: 'SPF record is missing the mail provider include.' },
  exportJob: { threadId: 'claude-export', title: 'Nightly export job', projectName: 'automation', agent: 'claude', status: 'running', updatedAtIso: iso(3), summary: 'Re-running the sheet export.' },
  checkout: { threadId: 'thread-checkout', title: 'Stripe checkout copy', projectName: 'booking-platform', agent: 'codex', status: 'running', updatedAtIso: iso(12), summary: 'Updating the pricing page buttons.' },
  migration: { threadId: 'thread-migration', title: 'Approve database migration', projectName: 'hr-ai', agent: 'codex', status: 'needs_you', updatedAtIso: iso(6), summary: '' },
  payouts: { threadId: 'claude-payouts', title: 'Stripe payouts report', projectName: 'automation', agent: 'claude', status: 'recent', updatedAtIso: iso(1440), summary: 'Weekly payouts summary sent.' },
}
const SECTIONS = { needs_you: [ROWS.migration], running: [ROWS.exportJob, ROWS.checkout], unread: [ROWS.webhook, ROWS.bounces], recent: [ROWS.payouts] }
const PROJECTS = [{ id: '/work/hr-ai', label: 'hr-ai' }, { id: '/work/slack-ai', label: 'slack-ai' }, { id: '/work/automation', label: 'automation' }]
const stored = (letter, fields) => ({ code: code(letter), createdAtIso: iso(0), expiresAtIso: iso(-10), sections: SECTIONS, candidates: [], ...fields })

const RESULTS = {
  [code('L')]: stored('L', { heard: 'show me all unread chats', action: 'list_chats', outcome: 'picker', listType: 'unread', candidates: SECTIONS.unread }),
  [code('W')]: stored('W', { heard: 'what needs me', action: 'list_chats', outcome: 'picker', listType: 'needs_you', candidates: SECTIONS.needs_you }),
  [code('G')]: stored('G', { heard: "what's running", action: 'list_chats', outcome: 'picker', listType: 'running', candidates: SECTIONS.running }),
  [code('T')]: stored('T', { heard: 'show recent chats', action: 'list_chats', outcome: 'picker', listType: 'recent', candidates: SECTIONS.recent }),
  [code('C')]: stored('C', { heard: 'open the stripe one', action: 'open_chat', outcome: 'picker', reason: 'close_call', candidates: [ROWS.webhook, ROWS.checkout, ROWS.payouts] }),
  [code('S')]: stored('S', { heard: 'tell the stripe one to deploy it to staging', action: 'send_to_chat', outcome: 'picker', reason: 'close_call', message: 'deploy it to staging', candidates: [ROWS.webhook, ROWS.checkout, ROWS.payouts] }),
  [code('R')]: stored('R', { heard: 'tell the stripe webhook chat to deploy it', action: 'send_to_chat', outcome: 'send_ready', threadId: 'thread-gone', message: 'deploy it', candidates: [ROWS.webhook] }),
  [code('N')]: stored('N', { heard: 'new chat in HRA I with codex, find out why customer emails bounce', action: 'new_chat', outcome: 'new_chat', message: 'find out why customer emails bounce', project: PROJECTS[0], agent: 'codex' }),
  [code('A')]: stored('A', { heard: 'new chat in slack AI with claude, tidy the bot copy', action: 'new_chat', outcome: 'new_chat', message: 'tidy the bot copy', project: PROJECTS[1], agent: 'claude' }),
  [code('U')]: stored('U', { heard: 'new chat, check the logs', action: 'new_chat', outcome: 'new_chat', reason: 'project_unclear', message: 'check the logs', project: null, projectOptions: [PROJECTS[1], PROJECTS[2], PROJECTS[0]], agent: null }),
  [code('E')]: stored('E', { heard: 'anything unread', action: 'list_chats', outcome: 'empty', reason: 'empty_list', listType: 'unread', candidates: [] }),
  [code('X')]: stored('X', { heard: 'uh can you, the thing from before', action: 'other', outcome: 'not_understood', reason: 'other', candidates: [ROWS.migration, ROWS.exportJob, ROWS.checkout, ROWS.webhook] }),
  [code('O')]: stored('O', { heard: 'open the stripe webhook chat', action: 'open_chat', outcome: 'open_chat', threadId: 'thread-webhook', candidates: [ROWS.webhook] }),
  [code('P')]: stored('P', { heard: 'okay so tell the stripe webhook chat, you know, to deploy it to staging', action: 'send_to_chat', outcome: 'send_ready', threadId: 'thread-webhook', message: 'deploy it to staging', candidates: [ROWS.webhook] }),
  [code('Q')]: stored('Q', { heard: '', action: 'other', outcome: 'not_understood', reason: 'empty', candidates: [ROWS.migration] }),
}
// A command that asked for three things: each step is a saved result of its own.
RESULTS[code('M')] = stored('M', {
  heard: 'tell the stripe webhook chat to deploy it to staging, show me what is running and start a new chat in hr-ai to find out why customer emails bounce',
  action: 'send_to_chat',
  outcome: 'steps',
  steps: [
    { ...RESULTS[code('P')], url: `/#/thread/thread-webhook?voice=${code('P')}` },
    { ...RESULTS[code('G')], url: `/#/voice/${code('G')}` },
    { ...RESULTS[code('N')], url: `/#/?voice=${code('N')}` },
  ],
})
// Auto-send: a send counting down, a new chat counting down, a send that already went, and steps
// where the sure ones ran by themselves. Each `auto` entry is the delivery the mock server starts with.
RESULTS[code('D')] = stored('D', { heard: 'tell the stripe webhook chat to deploy it to staging', action: 'send_to_chat', outcome: 'send_ready', threadId: 'thread-webhook', message: 'deploy it to staging', candidates: [ROWS.webhook], basis: 'jev' })
RESULTS[code('Y')] = stored('Y', { heard: 'find me the best hotels in Johor Bahru', action: 'new_chat', outcome: 'new_chat', message: 'find me the best hotels in Johor Bahru', project: PROJECTS[0], agent: null, basis: 'default' })
RESULTS[code('K')] = stored('K', { heard: 'tell the stripe webhook chat to deploy it to staging', action: 'send_to_chat', outcome: 'send_ready', threadId: 'thread-webhook', message: 'deploy it to staging', candidates: [ROWS.webhook], basis: 'jev' })
RESULTS[code('V')] = stored('V', {
  heard: 'tell the stripe webhook chat to deploy it to staging, new chat in hr-ai to find out why customer emails bounce, and tell the stripe one to merge it',
  action: 'send_to_chat',
  outcome: 'steps',
  steps: [
    { ...RESULTS[code('P')], url: `/#/thread/thread-webhook?voice=${code('P')}` },
    { ...RESULTS[code('N')], url: `/#/?voice=${code('N')}` },
    { ...RESULTS[code('S')], url: `/#/voice/${code('S')}` },
  ],
})
const AUTO = {
  D: { kind: 'send', label: 'Stripe webhook bug', message: 'deploy it to staging', threadId: 'thread-webhook', delaySeconds: 5 },
  Y: { kind: 'new_chat', label: 'hr-ai', message: 'find me the best hotels in Johor Bahru', startsThread: 'thread-bounces', delaySeconds: 5 },
  K: { kind: 'send', label: 'Stripe webhook bug', message: 'deploy it to staging', threadId: 'thread-webhook', delaySeconds: 0 },
  P: { kind: 'send', label: 'Stripe webhook bug', message: 'deploy it to staging', threadId: 'thread-webhook', delaySeconds: 0 },
  N: { kind: 'new_chat', label: 'hr-ai', message: 'find out why customer emails bounce', startsThread: 'thread-bounces', delaySeconds: 5 },
}

/** What the in-app route answers for a result: its code, the link it opens, the result. */
const PATHS = { O: '/#/thread/thread-webhook', P: `/#/thread/thread-webhook?voice=${code('P')}`, N: `/#/?voice=${code('N')}`, C: `/#/voice/${code('C')}`, M: `/#/voice/${code('M')}`, D: `/#/thread/thread-webhook?voice=${code('D')}`, K: `/#/thread/thread-webhook?voice=${code('K')}` }

// The live panel: two chats running, one waiting for approval, two unread, one pinned, recent history.
const thread = (id, name, cwd, minutes, status = 'idle') => ({ id, name, preview: name.toLowerCase(), cwd, createdAt: secs(minutes + 60), updatedAt: secs(minutes), source: 'cli', status: { type: status } })
const THREADS = [
  thread('claude-export', 'Nightly export job', '/work/automation', 3, 'active'),
  thread('thread-webhook', 'Stripe webhook bug', '/work/hr-ai', 4),
  thread('thread-migration', 'Approve database migration', '/work/hr-ai', 6),
  thread('thread-checkout', 'Stripe checkout copy', '/work/booking-platform', 12, 'active'),
  thread('thread-bounces', 'Customer email bounces', '/work/hr-ai', 18),
  thread('thread-invoices', 'Invoice PDF layout', '/work/booking-platform', 300),
  thread('claude-payouts', 'Stripe payouts report', '/work/automation', 1440),
  thread('thread-onboarding', 'Onboarding email copy', '/work/slack-ai', 2000),
  thread('thread-tax', 'Quarterly tax export', '/work/automation', 2900),
  thread('thread-logo', 'Logo contrast check', '/work/booking-platform', 3100),
  thread('thread-sitemap', 'Sitemap generator', '/work/booking-platform', 3300),
  thread('thread-cron', 'Cron drift alert', '/work/automation', 3500),
]
const PANEL = {
  unreadThreadIds: ['thread-webhook', 'thread-bounces'],
  pinnedThreadIds: ['thread-onboarding'],
  pending: [{ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-migration', turnId: 'turn-m', itemId: 'item-m' }, receivedAtIso: iso(6) }],
  history: [
    { id: 'history-invoices', threadId: 'thread-invoices', turnId: 'turn-i', status: 'completed', title: 'Invoice PDF layout', body: 'Moved totals to the right column.', completedAt: iso(300), readAt: iso(200) },
    { id: 'history-payouts', threadId: 'claude-payouts', turnId: 'turn-p', status: 'completed', title: 'Stripe payouts report', body: 'Weekly payouts summary sent.', completedAt: iso(1440), readAt: iso(1400) },
  ],
}
const MODELS = [
  { id: 'gpt-codex-test', displayName: 'Codex Test', isDefault: true, modelProvider: 'openai' },
  { id: 'claude-test-model', displayName: 'Claude Test', modelProvider: 'anthropic' },
]

function rpc(method, params) {
  if (method === 'thread/list') return { data: params?.sourceKinds ? [] : THREADS, nextCursor: null }
  if (method === 'thread/read' || method === 'thread/resume') {
    const thread = THREADS.find((row) => row.id === params?.threadId)
    if (!thread) throw new Error('thread not found')
    return { thread: { ...thread, turns: [] } }
  }
  if (method === 'model/list') return { data: MODELS }
  if (method === 'config/read') return { config: { model: 'gpt-codex-test' } }
  if (method === 'thread/search') return { data: [] }
  return {}
}

const server = await createServer({ root, configFile: false, plugins: [vue(), tailwind()], resolve: { alias: { '@': `${root}/src` } }, optimizeDeps: { include: ['vue', 'pinia', 'vue-router'] }, server: { host: '127.0.0.1', port: 4196, strictPort: true, watch: null } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const shotsDir = `${output}/screens`
await mkdir(shotsDir, { recursive: true })
const failures = []
let passed = 0

async function scenario(name, run, panelOverrides = {}) {
  const panel = { ...PANEL, ...panelOverrides }
  const context = await browser.newContext(panel.desktop
    ? { viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 }
    : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(`${String(error)} ${String(error.stack ?? '').split('\n').slice(1, 4).join(' | ')}`))
  await page.addInitScript(() => {
    // A fake microphone: a tone through Web Audio, so the level meter moves, and a recorder that yields one chunk.
    window.__mic = { deny: false, empty: false, requests: 0 }
    const devices = navigator.mediaDevices ?? {}
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices })
    devices.getUserMedia = async () => {
      window.__mic.requests += 1
      if (window.__mic.deny) throw new DOMException('Permission denied', 'NotAllowedError')
      try {
        const context = new AudioContext()
        const tone = context.createOscillator()
        const destination = context.createMediaStreamDestination()
        tone.connect(destination)
        tone.start()
        return destination.stream
      } catch {
        return new MediaStream()
      }
    }
    window.MediaRecorder = class {
      constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm' }
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        setTimeout(() => {
          if (!window.__mic.empty) this.ondataavailable?.({ data: new Blob(['spoken audio'], { type: 'audio/webm' }) })
          this.onstop?.()
        }, 0)
      }
    }
    window.EventSource = class { constructor() { this.readyState = 1 } close() {} }
    window.WebSocket = class { constructor() { this.readyState = 0 } send() {} close() {} }
    localStorage.setItem('codex-web-local.theme.v1', 'dark')
  })
  const voiceRequests = []
  const commandRequests = []
  const sendRequests = []
  const cancelRequests = []
  const settingsWrites = []
  // The mock server's voice state. Auto-send is off unless a scenario turns it on, so the
  // older scenarios keep testing the pre-typed flow.
  const voiceSettings = { autoSend: false, delaySeconds: 0, defaultProject: '', ...panel.voiceSettings }
  /** code -> { kind, label, message, threadId?, startsThread?, delaySeconds, sendAt, state, trigger } */
  const deliveries = new Map()
  const startDelivery = (letterOrCode, spec, trigger) => {
    const key = letterOrCode.length === 24 ? letterOrCode : code(letterOrCode)
    const delaySeconds = spec.delaySeconds
    const sendAt = Date.now() + (panel.windowMs ?? delaySeconds * 1000)
    deliveries.set(key, { ...spec, delaySeconds, sendAt, state: delaySeconds === 0 ? 'sent' : 'pending', trigger, threadId: delaySeconds === 0 ? spec.threadId ?? spec.startsThread : spec.threadId })
  }
  // Each `auto` window starts when the app first reads it, so a cold page load does not eat into it.
  const autoByCode = new Map((panel.auto ?? []).map((letter) => [code(letter), letter]))
  const deliveryOf = (key) => {
    if (!deliveries.has(key) && autoByCode.has(key)) startDelivery(key, AUTO[autoByCode.get(key)], 'auto')
    const entry = deliveries.get(key)
    if (!entry) return undefined
    if (entry.state === 'pending' && Date.now() >= entry.sendAt) Object.assign(entry, { state: 'sent', threadId: entry.threadId ?? entry.startsThread })
    const { kind, state, trigger, delaySeconds, label, message, threadId } = entry
    return { kind, state, trigger, delaySeconds, label, message, remainingMs: state === 'pending' ? Math.max(0, entry.sendAt - Date.now()) : 0, ...(threadId ? { threadId } : {}) }
  }
  const withDelivery = (key) => {
    const result = RESULTS[key]
    if (!result) return null
    const delivery = deliveryOf(key)
    const steps = result.steps?.map((step) => ({ ...step, ...(deliveryOf(step.code) ? { delivery: deliveryOf(step.code) } : {}) }))
    return { ...result, ...(delivery ? { delivery } : {}), ...(steps ? { steps } : {}) }
  }
  const commandAnswer = (letter) => ({ data: { code: code(letter), url: PATHS[letter] ?? `/#/voice/${code(letter)}`, result: withDelivery(code(letter)) } })
  await page.route('**/codex-api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/codex-api/voice/command' && request.method() === 'POST') {
      // panel.command: the result letters to answer with, in turn; a number is an HTTP error status.
      const answer = panel.command?.[commandRequests.length] ?? panel.command?.at(-1)
      commandRequests.push({ contentType: request.headers()['content-type'] ?? '', bytes: request.postDataBuffer()?.length ?? 0 })
      await new Promise((resolve) => setTimeout(resolve, panel.commandDelayMs ?? 0))
      if (typeof answer === 'number') return route.fulfill({ status: answer, json: { error: 'Transcription failed.' } })
      // The server starts the countdown as it answers.
      if (AUTO[answer] && (panel.commandAuto ?? []).includes(answer)) startDelivery(answer, AUTO[answer], 'auto')
      return route.fulfill({ json: commandAnswer(answer) })
    }
    if (path === '/codex-api/voice/settings') {
      if (request.method() === 'POST') {
        const patch = request.postDataJSON()
        settingsWrites.push(patch)
        Object.assign(voiceSettings, patch)
      }
      return route.fulfill({ json: { data: voiceSettings, projects: PROJECTS, fallbackProject: panel.fallbackProject ?? null } })
    }
    const voicePath = /^\/codex-api\/voice\/([A-Za-z0-9_-]{24})(?:\/(cancel|send))?$/u.exec(path)
    if (voicePath) {
      const [, voiceCode, verb] = voicePath
      voiceRequests.push({ path, auth: request.headers().authorization ?? null })
      if (!RESULTS[voiceCode]) return route.fulfill({ status: 404, json: { error: 'This voice result has expired.' } })
      if (verb === 'cancel') {
        cancelRequests.push(voiceCode)
        const targets = [voiceCode, ...(RESULTS[voiceCode].steps ?? []).map((step) => step.code)]
        for (const key of targets) { const entry = deliveries.get(key); if (entry?.state === 'pending') entry.state = 'cancelled' }
      }
      if (verb === 'send') {
        const body = request.postDataJSON()
        sendRequests.push({ code: voiceCode, ...body })
        const result = RESULTS[voiceCode]
        const row = [...result.candidates, ...Object.values(result.sections).flat()].find((entry) => entry.threadId === body.threadId)
        const project = PROJECTS.find((entry) => entry.id === body.projectId)
        const current = deliveryOf(voiceCode)
        if (!current || current.state === 'cancelled') {
          startDelivery(voiceCode, row
            ? { kind: 'send', label: row.title, message: result.message, threadId: row.threadId, delaySeconds: voiceSettings.delaySeconds }
            : { kind: 'new_chat', label: project.label, message: result.message, startsThread: 'thread-onboarding', delaySeconds: voiceSettings.delaySeconds }, 'tap')
        }
      }
      return route.fulfill({ json: { data: withDelivery(voiceCode) } })
    }
    if (path === '/codex-api/rpc') {
      const body = request.postDataJSON()
      try { return route.fulfill({ json: { result: rpc(body.method, body.params) } }) } catch (error) { return route.fulfill({ status: 502, json: { error: String(error.message) } }) }
    }
    // The desktop header's provider status is not under test; "unavailable" keeps it quiet.
    if (path.startsWith('/codex-api/providers')) return route.fulfill({ status: 503, json: { error: 'Not available in this test.' } })
    if (path === '/codex-api/workspace-roots-state') return route.fulfill({ json: { data: { order: PROJECTS.map((project) => project.id), labels: {}, active: [] } } })
    if (path === '/codex-api/thread-read-state') return route.fulfill({ json: { data: { version: 1, readAtByThreadId: {}, unreadThreadIds: panel.unreadThreadIds } } })
    if (path === '/codex-api/pinned-threads') return route.fulfill({ json: { data: { threadIds: panel.pinnedThreadIds } } })
    if (path === '/codex-api/server-requests/pending') return route.fulfill({ json: { data: panel.pending } })
    if (path.startsWith('/codex-api/push/history')) return route.fulfill({ json: { data: { items: panel.history, unreadCount: 0, dismissals: [] } } })
    return route.fulfill({ json: { data: [] } })
  })
  try {
    await run(page, { voiceRequests, commandRequests, sendRequests, cancelRequests, settingsWrites })
    const relevant = errors.filter((error) => !/ResizeObserver|Failed to fetch/u.test(error))
    assert.deepEqual(relevant, [], 'no page errors')
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split('\n').slice(0, 6).join('\n  ')}`)
    await page.screenshot({ path: `${shotsDir}/failure-${name.replace(/[^a-z0-9]+/giu, '-')}.png` }).catch(() => {})
  } finally {
    await context.close()
  }
}

const base = 'http://127.0.0.1:4196/output/voice-pages/index.html'
const composer = (page) => page.locator('textarea.thread-composer-input')
const waitForHashWithout = (page, text) => page.waitForFunction((value) => !window.location.hash.includes(value), text)
const sheet = (page) => page.locator('.notification-popover')
const section = (page, name) => page.locator(`[data-activity-section="${name}"]`)
const filterPressed = (page, label) => page.getByRole('group', { name: 'Activity filter' }).getByRole('button', { name: new RegExp(`^${label}`, 'u') }).getAttribute('aria-pressed')
const voiceNote = (page) => page.getByRole('status', { name: 'Voice command' })
const panelMic = (page) => sheet(page).locator('.notification-header').getByRole('button', { name: /voice command/u })
const micStatus = (page) => page.getByRole('status', { name: 'Voice mic' })
async function openPanel(page) {
  await page.goto(`${base}#/`)
  await page.locator('.notification-trigger').click()
  await sheet(page).waitFor()
}
/** Tap the panel mic, then tap it again to stop, as a user would. */
async function sayIntoPanel(page) {
  await panelMic(page).click()
  await micStatus(page).getByText(/^Listening… 0:0\d · tap to stop$/u).waitFor()
  await page.getByRole('button', { name: 'Stop and run the voice command' }).click()
}
async function openedOn(page, focus) {
  await sheet(page).waitFor()
  await page.waitForFunction((name) => document.querySelector(`[data-activity-section="${name}"]`)?.classList.contains('is-landing-focus'), focus)
  await page.waitForFunction(() => window.location.hash === '#/')
}
/** How far the section's top sits below the top of the scrolling list. */
const sectionOffset = (page, name) => page.evaluate((value) => {
  const list = document.querySelector('.notification-activity')
  const target = document.querySelector(`[data-activity-section="${value}"]`)
  return Math.round(target.getBoundingClientRect().top - list.getBoundingClientRect().top)
}, name)

try {
  for (const [letter, focus, filter, shot] of [['W', 'needs_you', 'All', '01-voice-needs-you'], ['G', 'running', 'All', '01-voice-running'], ['L', 'unread', 'Unread', '01-voice-unread'], ['T', 'recent', 'All', '01-voice-recent']]) {
    await scenario(`a spoken ${focus} list opens the notification panel on that section`, async (page, { voiceRequests }) => {
      await page.goto(`${base}#/voice/${code(letter)}`)
      await openedOn(page, focus)
      assert.equal(await filterPressed(page, filter), 'true')
      await voiceNote(page).getByText('Heard:').waitFor()
      assert.equal(await page.locator('.voice-picker').count(), 0, 'the old list page is gone')
      await page.screenshot({ path: `${shotsDir}/${shot}.png` })
      assert.ok(voiceRequests.every((request) => request.auth === null), 'the PWA never sends a bearer token')
      assert.ok(voiceRequests.every((request) => !request.path.includes('/shortcut/')), 'the PWA never calls a shortcut route')
    })
  }

  await scenario('Back from the panel does not return to the voice link', async (page) => {
    await page.goto(`${base}#/thread/thread-webhook`)
    await composer(page).waitFor()
    await page.evaluate((value) => { window.location.hash = `#/voice/${value}` }, code('G'))
    await openedOn(page, 'running')
    await page.getByRole('button', { name: 'Close notifications' }).click()
    await page.goBack()
    await page.waitForFunction(() => window.location.hash === '#/thread/thread-webhook')
  })

  await scenario('close-call picker uses the panel rows, marks the best match and offers recent chats', async (page) => {
    await page.goto(`${base}#/voice/${code('C')}`)
    await page.getByRole('heading', { name: 'Which chat?' }).waitFor()
    await voiceNote(page).getByText('Heard: “open the stripe one”').waitFor()
    const choices = page.getByRole('region', { name: 'Possible chats' })
    assert.deepEqual(await choices.locator('.notification-row-title').allInnerTexts(), ['Stripe webhook bug', 'Stripe checkout copy', 'Stripe payouts report'])
    assert.equal(await choices.locator('.notification-unread-pill.is-accent').innerText(), 'Best match')
    assert.equal(await choices.getByText('Best match').count(), 1)
    assert.equal((await choices.locator('.notification-row-meta').nth(1).textContent()).trim(), 'booking-platform·Codex·In progress·12m')
    assert.equal(await choices.locator('.notification-row-icon.is-running').count(), 1, 'the panel icon for a running chat')
    for (const row of await choices.locator('.notification-row').all()) assert.ok((await row.boundingBox()).height >= 48)
    await page.screenshot({ path: `${shotsDir}/02-close-call-picker.png` })
    await page.getByRole('group', { name: 'None of these' }).getByRole('button', { name: 'Recent chats' }).click()
    const recent = page.getByRole('region', { name: 'Recent chats' })
    await recent.waitFor()
    assert.equal(await recent.locator('.notification-row').count(), 6, 'panel order: needs you, running, unread, recent')
    assert.equal(await recent.getByText('Best match').count(), 0)
    await page.getByRole('button', { name: 'Open Stripe checkout copy' }).click()
    await page.waitForFunction(() => window.location.hash === '#/thread/thread-checkout')
  })

  await scenario('send picker shows the message; tapping a chat opens it with the message typed in', async (page) => {
    await page.goto(`${base}#/voice/${code('S')}`)
    await page.getByRole('heading', { name: 'Send to which chat?' }).waitFor()
    await page.getByText('“deploy it to staging”').waitFor()
    await page.screenshot({ path: `${shotsDir}/03-send-picker.png` })
    await page.getByRole('button', { name: 'Open Stripe webhook bug' }).click()
    await page.waitForFunction(() => window.location.hash.startsWith('#/thread/thread-webhook'))
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'deploy it to staging')
    await waitForHashWithout(page, 'voice=')
    assert.equal(await page.evaluate(() => window.location.hash), '#/thread/thread-webhook', 'the code is dropped from the URL once applied')
    await page.getByText('From voice:').waitFor()
    await page.getByText('“tell the stripe one to deploy it to staging”').waitFor()
    await page.screenshot({ path: `${shotsDir}/04-chat-prefilled.png` })
    await page.getByRole('button', { name: 'Dismiss voice note' }).click()
    assert.equal(await page.getByText('From voice:').count(), 0)
    assert.equal(await composer(page).inputValue(), 'deploy it to staging', 'dismissing keeps the words')
  })

  await scenario('new-chat link fills in project, agent and message', async (page) => {
    await page.goto(`${base}#/?voice=${code('N')}`)
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'find out why customer emails bounce')
    await page.getByRole('button', { name: 'Choose workspace folder' }).filter({ hasText: 'hr-ai' }).waitFor()
    await page.getByText('From voice:').waitFor()
    await waitForHashWithout(page, 'voice=')
    await page.waitForFunction(() => document.body.innerText.includes('Codex Test'))
    await page.screenshot({ path: `${shotsDir}/05-new-chat-prefilled.png` })
  })

  await scenario('a spoken agent switches the new-chat model to that agent', async (page) => {
    await page.goto(`${base}#/?voice=${code('A')}`)
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'tidy the bot copy')
    await page.getByRole('button', { name: 'Choose workspace folder' }).filter({ hasText: 'slack-ai' }).waitFor()
    await page.waitForFunction(() => document.body.innerText.includes('Claude Test'))
    assert.ok(!(await page.evaluate(() => document.body.innerText.includes('Codex Test'))), 'the Codex model is no longer selected')
  })

  await scenario('new-chat link with an unclear project opens the project picker', async (page) => {
    await page.goto(`${base}#/?voice=${code('U')}`)
    await page.getByRole('listbox', { name: 'Workspace folders' }).waitFor()
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'check the logs')
    await page.screenshot({ path: `${shotsDir}/06-new-chat-project-picker.png` })
    await page.keyboard.press('Escape')
    await page.getByRole('group', { name: 'Which project?' }).getByRole('button', { name: 'slack-ai' }).click()
    await page.getByRole('button', { name: 'Choose workspace folder' }).filter({ hasText: 'slack-ai' }).waitFor()
    assert.equal(await page.getByRole('group', { name: 'Which project?' }).count(), 0, 'choices go away once chosen')
  })

  await scenario('/new-thread keeps the voice code through its redirect', async (page) => {
    await page.goto(`${base}#/new-thread?voice=${code('N')}`)
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'find out why customer emails bounce')
    assert.equal(await page.evaluate(() => window.location.hash), '#/')
  })

  await scenario('an unknown route keeps the voice code through the catch-all redirect', async (page) => {
    await page.goto(`${base}#/some/old/link?voice=${code('N')}`)
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'find out why customer emails bounce')
  })

  await scenario('an unknown chat falls back home and keeps the message', async (page) => {
    await page.goto(`${base}#/thread/thread-gone?voice=${code('R')}`)
    await page.waitForFunction(() => window.location.hash === '#/')
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'deploy it')
    await page.getByText('That chat could not be opened.', { exact: false }).waitFor()
  })

  await scenario("didn't catch that opens the panel at the top with what was heard and a mic to say it again", async (page) => {
    await page.goto(`${base}#/voice/${code('X')}`)
    await sheet(page).waitFor()
    await voiceNote(page).getByText("Didn't catch that").waitFor()
    await voiceNote(page).getByText('Heard: “uh can you, the thing from before”').waitFor()
    await page.waitForFunction(() => window.location.hash === '#/')
    assert.equal(await filterPressed(page, 'All'), 'true')
    assert.equal(await page.locator('.notification-activity').evaluate((el) => el.scrollTop), 0)
    assert.equal(await page.locator('.is-landing-focus').count(), 0)
    assert.equal(await voiceNote(page).getByRole('button').count(), 0, 'the panel header has the mic')
    assert.equal(await panelMic(page).getAttribute('aria-label'), 'Say a voice command')
    await page.screenshot({ path: `${shotsDir}/07-not-understood.png` })
  })

  await scenario('an empty spoken list opens the panel and says it was empty', async (page) => {
    await page.goto(`${base}#/voice/${code('E')}`)
    await sheet(page).waitFor()
    await voiceNote(page).getByText('Nothing unread ✓').waitFor()
  }, { unreadThreadIds: [] })

  await scenario('the bell opens the panel exactly as before: All, from the top, no voice note, not a sheet', async (page) => {
    await page.goto(`${base}#/`)
    await page.locator('.notification-trigger').click()
    await sheet(page).waitFor()
    await section(page, 'recent').waitFor()
    assert.equal(await filterPressed(page, 'All'), 'true')
    assert.equal(await voiceNote(page).count(), 0)
    assert.equal(await page.locator('.is-landing-focus').count(), 0)
    assert.equal(await sheet(page).evaluate((el) => el.classList.contains('is-landing')), false)
    assert.equal(await page.locator('.notification-activity').evaluate((el) => el.scrollTop), 0)
    assert.deepEqual(await page.locator('[data-activity-section]').evaluateAll((els) => els.map((el) => el.dataset.activitySection)), ['needs_you', 'running', 'unread', 'recent'])
    await page.screenshot({ path: `${shotsDir}/10-bell-panel.png` })
  })

  await scenario('?activity=running opens the panel on Chats running and drops the link from the URL', async (page) => {
    await page.goto(`${base}#/?activity=running`)
    await openedOn(page, 'running')
    assert.equal(await filterPressed(page, 'All'), 'true')
    assert.ok(Math.abs(await sectionOffset(page, 'running')) <= 2, 'Chats running is scrolled to the top of the list')
    assert.equal(await voiceNote(page).count(), 0, 'no voice note without a voice code')
    await page.waitForFunction(() => !document.querySelector('.is-landing-focus'), null, { timeout: 5000 })
  })

  await scenario('?activity=needs_you highlights Needs you', async (page) => {
    await page.goto(`${base}#/?activity=needs_you`)
    await openedOn(page, 'needs_you')
    assert.equal(await sectionOffset(page, 'needs_you'), 0)
  })

  await scenario('?activity=unread switches the panel to its Unread filter', async (page) => {
    await page.goto(`${base}#/?activity=unread`)
    await openedOn(page, 'unread')
    assert.equal(await filterPressed(page, 'Unread'), 'true')
    assert.deepEqual(await section(page, 'unread').locator('.notification-row-title').allInnerTexts(), ['Stripe webhook bug', 'Customer email bounces'])
  })

  await scenario('?activity=recent scrolls down to Recent activity', async (page) => {
    await page.goto(`${base}#/?activity=recent`)
    await openedOn(page, 'recent')
    assert.ok(await page.locator('.notification-activity').evaluate((el) => el.scrollTop) > 0, 'the list scrolled')
    assert.ok(await section(page, 'recent').isVisible())
  })

  await scenario('a voice code on the link shows what was heard above the panel', async (page) => {
    await page.goto(`${base}#/?activity=unread&voice=${code('L')}`)
    await openedOn(page, 'unread')
    assert.match(await voiceNote(page).innerText(), /Heard: “show me all unread chats”/u)
    assert.equal(await composer(page).inputValue(), '', 'a list result types nothing into the composer')
  })

  await scenario('an empty list says so while the section is still empty', async (page) => {
    await page.goto(`${base}#/?activity=unread&voice=${code('E')}`)
    await sheet(page).waitFor()
    await voiceNote(page).getByText('Nothing unread ✓').waitFor()
    assert.equal(await filterPressed(page, 'Unread'), 'true')
    await section(page, 'needs_you').waitFor()
    assert.equal(await section(page, 'unread').count(), 0)
    await page.screenshot({ path: `${shotsDir}/15-panel-empty-unread.png` })
  }, { unreadThreadIds: [] })

  await scenario('the empty note goes once live activity shows that section has chats', async (page) => {
    await page.goto(`${base}#/?activity=unread&voice=${code('E')}`)
    await openedOn(page, 'unread')
    await voiceNote(page).getByText('Heard: “anything unread”').waitFor()
    assert.equal(await voiceNote(page).getByText('Nothing unread ✓').count(), 0)
  })

  await scenario('an expired voice code still opens the panel and says the link expired', async (page) => {
    await page.goto(`${base}#/?activity=running&voice=${code('Z')}`)
    await openedOn(page, 'running')
    await voiceNote(page).getByText('That voice link has expired. Say it again.').waitFor()
  })

  await scenario('an unknown section opens the panel at the top', async (page) => {
    await page.goto(`${base}#/?activity=everything`)
    await sheet(page).waitFor()
    await page.waitForFunction(() => window.location.hash === '#/')
    assert.equal(await page.locator('.is-landing-focus').count(), 0)
  })

  await scenario('on a phone the landing is a full-height sheet with 44 px controls that closes back to the app', async (page) => {
    await page.goto(`${base}#/?activity=running`)
    await openedOn(page, 'running')
    await page.waitForTimeout(300) // the open animation scales the sheet
    const box = await sheet(page).boundingBox()
    assert.ok(box.y + box.height >= 844 - 12, `sheet reaches the bottom (${box.y + box.height})`)
    for (const name of ['Close notifications', 'Mark all as read', 'Activity', 'Settings']) {
      const control = await page.getByRole(name === 'Activity' || name === 'Settings' ? 'tab' : 'button', { name, exact: true }).boundingBox()
      assert.ok(control.height >= 44, `${name} is ${control.height}px tall`)
    }
    for (const row of await sheet(page).locator('.notification-row').all()) assert.ok((await row.boundingBox()).height >= 48)
    await page.getByRole('button', { name: 'Close notifications' }).click()
    await sheet(page).waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.location.hash), '#/')
    await composer(page).waitFor()
    await page.locator('.notification-trigger').click()
    await sheet(page).waitFor()
    assert.equal(await sheet(page).evaluate((el) => el.classList.contains('is-landing')), false, 'reopening from the bell is a normal open')
  })

  await scenario('the catch-all and /new-thread redirects keep the ?activity= link', async (page) => {
    await page.goto(`${base}#/some/old/link?activity=unread`)
    await openedOn(page, 'unread')
    await page.goto(`${base}#/new-thread?activity=running`)
    await openedOn(page, 'running')
  })

  // --- The panel's mic ------------------------------------------------------------

  await scenario('the panel header has a 44 px mic; recording shows a live state, then "Working…", then opens the chat', async (page, { commandRequests }) => {
    await openPanel(page)
    const box = await panelMic(page).boundingBox()
    assert.ok(box.width >= 44 && box.height >= 44, `mic is ${box.width}x${box.height}`)
    assert.equal(await micStatus(page).count(), 0, 'nothing extra while idle')
    await page.screenshot({ path: `${shotsDir}/20-panel-mic-idle.png` })
    await panelMic(page).click()
    await micStatus(page).getByText(/^Listening… 0:0\d · tap to stop$/u).waitFor()
    assert.match(await panelMic(page).getAttribute('class'), /is-recording/u)
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${shotsDir}/21-panel-mic-recording.png` })
    await page.getByRole('button', { name: 'Stop and run the voice command' }).click()
    await micStatus(page).getByText('Working…').waitFor()
    await page.screenshot({ path: `${shotsDir}/22-panel-mic-working.png` })
    await page.waitForFunction(() => window.location.hash === '#/thread/thread-webhook')
    await sheet(page).waitFor({ state: 'detached' })
    assert.equal(commandRequests.length, 1)
    assert.match(commandRequests[0].contentType, /^multipart\/form-data; boundary=/u, 'the recording goes straight to the voice route')
    assert.ok(commandRequests[0].bytes > 0)
  }, { command: ['O'], commandDelayMs: 600 })

  await scenario('on desktop the mic sits in the panel header and records the same way', async (page) => {
    await openPanel(page)
    const box = await panelMic(page).boundingBox()
    assert.ok(box.width >= 32 && box.width < 44, `a compact ${box.width}px mic on desktop`)
    await page.screenshot({ path: `${shotsDir}/30-desktop-panel-mic-idle.png` })
    await panelMic(page).click()
    await micStatus(page).getByText(/^Listening… 0:0\d · tap to stop$/u).waitFor()
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${shotsDir}/31-desktop-panel-mic-recording.png` })
    await page.getByRole('button', { name: 'Stop and run the voice command' }).click()
    await voiceNote(page).getByText('Heard: “what\'s running”').waitFor()
    await page.screenshot({ path: `${shotsDir}/32-desktop-panel-mic-list.png` })
  }, { command: ['G'], desktop: true })

  await scenario('a spoken list stays in the panel on that section, without becoming a sheet', async (page) => {
    await openPanel(page)
    await sayIntoPanel(page)
    await page.waitForFunction(() => document.querySelector('[data-activity-section="running"]')?.classList.contains('is-landing-focus'))
    await voiceNote(page).getByText('Heard: “what\'s running”').waitFor()
    assert.equal(await sheet(page).evaluate((el) => el.classList.contains('is-landing')), false)
    assert.equal(await page.evaluate(() => window.location.hash), '#/')
    await page.screenshot({ path: `${shotsDir}/23-panel-mic-list.png` })
  }, { command: ['G'] })

  await scenario('a spoken send opens the chat with the message typed in and nothing sent', async (page) => {
    await openPanel(page)
    await sayIntoPanel(page)
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'deploy it to staging')
    await page.getByText('From voice:').waitFor()
    assert.equal(await page.evaluate(() => window.location.hash), '#/thread/thread-webhook')
    await page.screenshot({ path: `${shotsDir}/24-panel-mic-send.png` })
  }, { command: ['P'] })

  await scenario('a spoken new chat opens the new-chat page filled in', async (page) => {
    await openPanel(page)
    await sayIntoPanel(page)
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'find out why customer emails bounce')
    await page.getByRole('button', { name: 'Choose workspace folder' }).filter({ hasText: 'hr-ai' }).waitFor()
  }, { command: ['N'] })

  await scenario('an unclear chat opens the chooser', async (page) => {
    await openPanel(page)
    await sayIntoPanel(page)
    await page.getByRole('heading', { name: 'Which chat?' }).waitFor()
  }, { command: ['C'] })

  await scenario('several requests open the Steps chooser; a tapped step is marked done on the way back', async (page) => {
    await openPanel(page)
    await sayIntoPanel(page)
    await page.getByRole('heading', { name: 'You asked for 3 things' }).waitFor()
    const steps = page.getByRole('region', { name: 'Steps' })
    assert.deepEqual(await steps.locator('.notification-row-title').allInnerTexts(), ['Send to Stripe webhook bug', 'Running chats', 'New chat in hr-ai'])
    assert.equal(await steps.getByText('Next').count(), 1)
    for (const row of await steps.locator('.notification-row').all()) assert.ok((await row.boundingBox()).height >= 48)
    await page.screenshot({ path: `${shotsDir}/25-steps-chooser.png` })
    await page.getByRole('button', { name: 'Step 1: Send to Stripe webhook bug' }).click()
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'deploy it to staging')
    await page.goBack()
    await page.getByRole('heading', { name: 'You asked for 3 things' }).waitFor()
    await steps.getByText('Done').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Step 2: Running chats' }).getByText('Next').count(), 1)
    await page.screenshot({ path: `${shotsDir}/26-steps-chooser-after-one.png` })
    await page.getByRole('button', { name: 'Step 2: Running chats' }).click()
    await openedOn(page, 'running')
  }, { command: ['M'] })

  await scenario("didn't catch that stays in the panel with what was heard and the mic ready", async (page) => {
    await openPanel(page)
    await sayIntoPanel(page)
    await voiceNote(page).getByText("Didn't catch that").waitFor()
    await voiceNote(page).getByText('Heard: “uh can you, the thing from before”').waitFor()
    assert.equal(await panelMic(page).getAttribute('aria-label'), 'Say a voice command')
    assert.equal(await page.evaluate(() => window.location.hash), '#/')
    await page.screenshot({ path: `${shotsDir}/27-panel-mic-not-understood.png` })
  }, { command: ['X'] })

  await scenario('a blocked microphone explains how to allow it and keeps the mic ready', async (page, { commandRequests }) => {
    await openPanel(page)
    await page.evaluate(() => { window.__mic.deny = true })
    await panelMic(page).click()
    await micStatus(page).getByText(/Microphone access is blocked/u).waitFor()
    assert.equal(await panelMic(page).getAttribute('aria-label'), 'Say a voice command')
    assert.equal(commandRequests.length, 0)
    await page.screenshot({ path: `${shotsDir}/28-panel-mic-blocked.png` })
    await page.evaluate(() => { window.__mic.deny = false })
    await sayIntoPanel(page)
    await page.waitForFunction(() => window.location.hash === '#/thread/thread-webhook')
  }, { command: ['O'] })

  await scenario('an empty recording or silence says so and sends nothing anywhere', async (page, { commandRequests }) => {
    await openPanel(page)
    await page.evaluate(() => { window.__mic.empty = true })
    await sayIntoPanel(page)
    await micStatus(page).getByText('No audio was recorded. Try recording again.').waitFor()
    assert.equal(commandRequests.length, 0)
    await page.evaluate(() => { window.__mic.empty = false })
    await sayIntoPanel(page)
    await micStatus(page).getByText("Didn't hear anything. Tap the mic and try again.").waitFor()
    assert.equal(await page.evaluate(() => window.location.hash), '#/')
  }, { command: ['Q'] })

  await scenario('a failed command offers Retry, which sends the same recording again', async (page, { commandRequests }) => {
    await openPanel(page)
    await sayIntoPanel(page)
    await micStatus(page).getByText(/Voice command failed: Transcription failed\./u).waitFor()
    await page.screenshot({ path: `${shotsDir}/29-panel-mic-failed.png` })
    await micStatus(page).getByRole('button', { name: 'Retry' }).click()
    await page.waitForFunction(() => window.location.hash === '#/thread/thread-webhook')
    assert.equal(commandRequests.length, 2)
    assert.equal(await page.evaluate(() => window.__mic.requests), 1, 'the microphone was opened once')
  }, { command: [502, 'O'] })

  await scenario('closing the panel while recording stops the microphone and runs nothing', async (page, { commandRequests }) => {
    await openPanel(page)
    await panelMic(page).click()
    await micStatus(page).getByText(/^Listening… 0:0\d · tap to stop$/u).waitFor()
    await page.getByRole('button', { name: 'Close notifications' }).click()
    await sheet(page).waitFor({ state: 'detached' })
    await page.waitForTimeout(200)
    assert.equal(commandRequests.length, 0)
  }, { command: ['O'] })

  // --- Auto-send ----------------------------------------------------------------------

  const deliveryBanner = (page) => page.getByRole('region', { name: 'Voice send' })
  const tallEnough = async (locator, label) => { const box = await locator.boundingBox(); assert.ok(box.height >= 44, `${label} is ${box.height}px tall`); return box }

  for (const desktop of [false, true]) {
    await scenario(`auto-send countdown on a chat: Cancel is the main control and leaves the message typed in${desktop ? ' (desktop)' : ''}`, async (page, { cancelRequests }) => {
      await page.goto(`${base}#/thread/thread-webhook?voice=${code('D')}`)
      await deliveryBanner(page).getByText(/^Sending to Stripe webhook bug in \d+\s+s$/u).waitFor()
      await deliveryBanner(page).getByText('“deploy it to staging”').waitFor()
      assert.equal(await composer(page).inputValue(), '', 'nothing typed in while the server is sending it')
      const cancel = deliveryBanner(page).getByRole('button', { name: 'Cancel', exact: true })
      const edit = deliveryBanner(page).getByRole('button', { name: 'Edit', exact: true })
      const cancelBox = await tallEnough(cancel, 'Cancel')
      const editBox = await tallEnough(edit, 'Edit')
      assert.ok(cancelBox.width > editBox.width, 'Cancel is the most prominent control')
      await waitForHashWithout(page, 'voice=')
      await page.screenshot({ path: `${shotsDir}/40-auto-send-countdown${desktop ? '-desktop' : ''}.png` })
      await cancel.click()
      await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'deploy it to staging')
      await page.getByText('Cancelled · nothing was sent.').waitFor()
      assert.equal(await deliveryBanner(page).count(), 0)
      assert.deepEqual(cancelRequests, [code('D')])
      await page.screenshot({ path: `${shotsDir}/41-auto-send-cancelled${desktop ? '-desktop' : ''}.png` })
    }, { auto: ['D'], windowMs: 5000, desktop })
  }

  await scenario('Edit stops the send, types the message in and focuses it', async (page, { cancelRequests }) => {
    await page.goto(`${base}#/thread/thread-webhook?voice=${code('D')}`)
    await deliveryBanner(page).getByRole('button', { name: 'Edit', exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.matches('textarea.thread-composer-input') && document.activeElement.value === 'deploy it to staging')
    assert.equal(cancelRequests.length, 1)
  }, { auto: ['D'], windowMs: 30_000 })

  await scenario('when the window ends the banner says "Sent ✓" and types nothing in', async (page) => {
    await page.goto(`${base}#/thread/thread-webhook?voice=${code('D')}`)
    await deliveryBanner(page).getByText(/^Sending to Stripe webhook bug in \d\s+s$/u).waitFor()
    await deliveryBanner(page).getByText('Sent ✓ · Stripe webhook bug').waitFor({ timeout: 8000 })
    assert.equal(await composer(page).inputValue(), '')
    await page.screenshot({ path: `${shotsDir}/42-auto-send-sent.png` })
    await deliveryBanner(page).getByRole('button', { name: 'Dismiss' }).click()
    assert.equal(await deliveryBanner(page).count(), 0)
  }, { auto: ['D'], windowMs: 1500 })

  await scenario('a send that already went (no undo window) shows "Sent ✓" on the chat', async (page) => {
    await page.goto(`${base}#/thread/thread-webhook?voice=${code('K')}`)
    await deliveryBanner(page).getByText('Sent ✓ · Stripe webhook bug').waitFor()
    assert.equal(await deliveryBanner(page).getByRole('button', { name: 'Cancel', exact: true }).count(), 0)
  }, { auto: ['K'] })

  await scenario('an auto-started new chat counts down on the home page, then opens the new chat', async (page) => {
    await page.goto(`${base}#/?voice=${code('Y')}`)
    await deliveryBanner(page).getByText(/^Starting new hr-ai chat in \d\s+s$/u).waitFor()
    await page.screenshot({ path: `${shotsDir}/43-auto-new-chat-countdown.png` })
    await page.waitForFunction(() => window.location.hash === '#/thread/thread-bounces', null, { timeout: 8000 })
    await deliveryBanner(page).getByText('Started ✓ · new hr-ai chat').waitFor()
    await page.screenshot({ path: `${shotsDir}/44-auto-new-chat-started.png` })
  }, { auto: ['Y'], windowMs: 1500 })

  await scenario('the panel mic: a sure send lands on the chat with the countdown and Cancel', async (page) => {
    await openPanel(page)
    await sayIntoPanel(page)
    await page.waitForFunction(() => window.location.hash.startsWith('#/thread/thread-webhook'))
    await deliveryBanner(page).getByRole('button', { name: 'Cancel', exact: true }).waitFor()
    await page.screenshot({ path: `${shotsDir}/45-panel-mic-auto-send.png` })
  }, { command: ['D'], commandAuto: ['D'], windowMs: 30_000 })

  await scenario('send chooser: one tap sends there, and the toast offers Undo', async (page, { sendRequests, cancelRequests }) => {
    await page.goto(`${base}#/voice/${code('S')}`)
    await page.getByText('Tap a chat to send it there').waitFor()
    const editFirst = page.getByRole('button', { name: 'Edit first, then send to Stripe checkout copy' })
    await tallEnough(editFirst, 'Edit first')
    await page.screenshot({ path: `${shotsDir}/46-one-tap-send-chooser.png` })
    await page.getByRole('button', { name: 'Send to Stripe checkout copy', exact: true }).click()
    const toast = page.getByRole('status', { name: 'Voice send' })
    await toast.getByText(/^Sending to Stripe checkout copy in \d+\s+s$/u).waitFor()
    await tallEnough(toast.getByRole('button', { name: 'Undo' }), 'Undo')
    await page.getByRole('button', { name: 'Send to Stripe checkout copy', exact: true }).getByText(/^In \d+\s+s$/u).waitFor()
    await page.screenshot({ path: `${shotsDir}/47-one-tap-send-toast.png` })
    await toast.getByRole('button', { name: 'Undo' }).click()
    await toast.getByText('Cancelled · nothing was sent').waitFor()
    assert.deepEqual(sendRequests, [{ code: code('S'), threadId: 'thread-checkout' }])
    assert.deepEqual(cancelRequests, [code('S')])
  }, { voiceSettings: { autoSend: true, delaySeconds: 3 }, windowMs: 5000 })

  await scenario('send chooser with no undo window: "Sent ✓" and View opens the chat', async (page, { sendRequests }) => {
    await page.goto(`${base}#/voice/${code('S')}`)
    await page.getByRole('button', { name: 'Send to Stripe webhook bug', exact: true }).click()
    const toast = page.getByRole('status', { name: 'Voice send' })
    await toast.getByText('Sent ✓ · Stripe webhook bug').waitFor()
    await page.screenshot({ path: `${shotsDir}/48-one-tap-sent-toast.png` })
    await toast.getByRole('button', { name: 'View' }).click()
    await page.waitForFunction(() => window.location.hash === '#/thread/thread-webhook')
    assert.equal(sendRequests.length, 1)
  }, { voiceSettings: { autoSend: true, delaySeconds: 0 } })

  await scenario('send chooser: Edit first opens the chat with the message typed in, nothing sent', async (page, { sendRequests }) => {
    await page.goto(`${base}#/voice/${code('S')}`)
    await page.getByRole('button', { name: 'Edit first, then send to Stripe webhook bug' }).click()
    await page.waitForFunction(() => document.querySelector('textarea.thread-composer-input')?.value === 'deploy it to staging')
    assert.equal(sendRequests.length, 0)
  }, { voiceSettings: { autoSend: true, delaySeconds: 0 } })

  await scenario('every chooser offers a way out: say it again, or recent chats', async (page) => {
    await page.goto(`${base}#/voice/${code('C')}`)
    const none = page.getByRole('group', { name: 'None of these' })
    await none.getByRole('button', { name: 'Say a voice command' }).waitFor()
    await none.getByRole('button', { name: 'Recent chats' }).click()
    await page.getByRole('region', { name: 'Recent chats' }).waitFor()
  })

  await scenario('project chooser: one tap starts the chat and opens it', async (page, { sendRequests }) => {
    await page.goto(`${base}#/?voice=${code('U')}`)
    const chips = page.getByRole('group', { name: 'Start in which project?' })
    await chips.waitFor()
    assert.equal(await page.getByRole('listbox', { name: 'Workspace folders' }).count(), 0, 'the folder list stays closed; the chips are one tap')
    await tallEnough(chips.getByRole('button', { name: 'Start in slack-ai' }), 'project chip')
    await page.getByRole('button', { name: 'Edit first' }).waitFor()
    await page.screenshot({ path: `${shotsDir}/49-one-tap-project-chooser.png` })
    await chips.getByRole('button', { name: 'Start in slack-ai' }).click()
    await page.waitForFunction(() => window.location.hash === '#/thread/thread-onboarding')
    await deliveryBanner(page).getByText('Started ✓ · new slack-ai chat').waitFor()
    assert.deepEqual(sendRequests, [{ code: code('U'), projectId: '/work/slack-ai' }])
  }, { voiceSettings: { autoSend: true, delaySeconds: 0 } })

  await scenario('project chooser: Edit first keeps the message and lets the chips pick the folder', async (page, { sendRequests }) => {
    await page.goto(`${base}#/?voice=${code('U')}`)
    await page.getByRole('button', { name: 'Edit first' }).click()
    await page.getByRole('group', { name: 'Which project?' }).getByRole('button', { name: 'slack-ai' }).click()
    await page.getByRole('button', { name: 'Choose workspace folder' }).filter({ hasText: 'slack-ai' }).waitFor()
    assert.equal(await composer(page).inputValue(), 'check the logs')
    assert.equal(sendRequests.length, 0)
  }, { voiceSettings: { autoSend: true, delaySeconds: 0 } })

  await scenario('steps: the sure ones ran by themselves and show it; the rest are one tap', async (page, { sendRequests, cancelRequests }) => {
    await page.goto(`${base}#/voice/${code('V')}`)
    const steps = page.getByRole('region', { name: 'Steps' })
    await steps.getByText('Sent ✓').waitFor()
    await steps.getByText(/^In \d+\s+s$/u).waitFor()
    for (const row of await steps.locator('.notification-row').all()) assert.ok((await row.boundingBox()).height >= 48)
    await tallEnough(steps.getByRole('button', { name: /^Cancel \(\d+\s+s\)$/u }), 'Cancel')
    await page.screenshot({ path: `${shotsDir}/50-steps-auto-run.png` })
    await steps.getByRole('button', { name: /^Cancel \(\d+\s+s\)$/u }).click()
    await page.waitForFunction(() => !/In \d+\s+s/u.test(document.querySelector('[aria-label="Steps"]')?.textContent ?? ''))
    assert.deepEqual(cancelRequests, [code('V')])
    assert.equal(await page.getByRole('button', { name: 'Step 2: New chat in hr-ai' }).getByText('Next').count(), 1, 'a cancelled step is a normal step again')
    await page.getByRole('button', { name: 'Edit step 2 first' }).waitFor()
    // Step 3 is a send chooser of its own: one tap opens it.
    await page.getByRole('button', { name: 'Step 3: Send to which chat?' }).click()
    await page.getByRole('heading', { name: 'Send to which chat?' }).waitFor()
    assert.equal(sendRequests.length, 0)
  }, { auto: ['P', 'N'], windowMs: 30_000, voiceSettings: { autoSend: true, delaySeconds: 5 } })

  for (const desktop of [false, true]) {
    await scenario(`settings: auto-send, the undo window and the default project save to the server${desktop ? ' (desktop)' : ''}`, async (page, { settingsWrites }) => {
      await openPanel(page)
      await page.getByRole('tab', { name: 'Settings' }).click()
      const group = page.getByRole('region', { name: 'Voice commands' })
      const toggle = group.getByRole('switch', { name: 'Auto-send voice commands' })
      await toggle.waitFor()
      assert.equal(await toggle.getAttribute('aria-checked'), 'true')
      await tallEnough(toggle, 'auto-send switch')
      const delay = group.getByRole('combobox', { name: 'Undo window' })
      assert.equal(await delay.inputValue(), '0')
      assert.deepEqual(await delay.locator('option').allInnerTexts(), ['Send immediately', '3 s to cancel', '5 s to cancel', '10 s to cancel'])
      const project = group.getByRole('combobox', { name: 'Default project for voice new chats' })
      assert.equal(await project.locator('option').first().innerText(), 'notes (server)')
      await group.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${shotsDir}/51-voice-settings${desktop ? '-desktop' : ''}.png` })
      await delay.selectOption('5')
      await project.selectOption('/work/hr-ai')
      await toggle.click()
      await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Auto-send voice commands"]')?.getAttribute('aria-checked') === 'false')
      assert.deepEqual(settingsWrites, [{ delaySeconds: 5 }, { defaultProject: '/work/hr-ai' }, { autoSend: false }])
      assert.equal(await delay.isDisabled(), true, 'no undo window without auto-send')
    }, { voiceSettings: { autoSend: true, delaySeconds: 0 }, fallbackProject: { id: '/work/notes', label: 'notes' }, desktop })
  }

  await scenario('an expired result says so instead of guessing', async (page) => {
    await page.goto(`${base}#/voice/${code('Z')}`)
    await page.getByText('This voice result has expired. Say it again.').waitFor()
    await page.goto(`${base}#/?voice=${code('Z')}`)
    await page.getByText('That voice link has expired. Say it again.').waitFor()
  })
} finally {
  await browser.close()
  await server.close()
}

console.log(`\n${passed} passed, ${failures.length} failed. Screenshots: ${shotsDir}`)
if (failures.length > 0) process.exit(1)
