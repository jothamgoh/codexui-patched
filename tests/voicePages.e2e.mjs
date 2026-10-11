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
  [code('C')]: stored('C', { heard: 'open the stripe one', action: 'open_chat', outcome: 'picker', reason: 'close_call', candidates: [ROWS.webhook, ROWS.checkout, ROWS.payouts] }),
  [code('S')]: stored('S', { heard: 'tell the stripe one to deploy it to staging', action: 'send_to_chat', outcome: 'picker', reason: 'close_call', message: 'deploy it to staging', candidates: [ROWS.webhook, ROWS.checkout, ROWS.payouts] }),
  [code('R')]: stored('R', { heard: 'tell the stripe webhook chat to deploy it', action: 'send_to_chat', outcome: 'send_ready', threadId: 'thread-gone', message: 'deploy it', candidates: [ROWS.webhook] }),
  [code('N')]: stored('N', { heard: 'new chat in HRA I with codex, find out why customer emails bounce', action: 'new_chat', outcome: 'new_chat', message: 'find out why customer emails bounce', project: PROJECTS[0], agent: 'codex' }),
  [code('A')]: stored('A', { heard: 'new chat in slack AI with claude, tidy the bot copy', action: 'new_chat', outcome: 'new_chat', message: 'tidy the bot copy', project: PROJECTS[1], agent: 'claude' }),
  [code('U')]: stored('U', { heard: 'new chat, check the logs', action: 'new_chat', outcome: 'new_chat', reason: 'project_unclear', message: 'check the logs', project: null, projectOptions: [PROJECTS[1], PROJECTS[2], PROJECTS[0]], agent: null }),
  [code('X')]: stored('X', { heard: 'uh can you, the thing from before', action: 'other', outcome: 'not_understood', reason: 'other', candidates: [ROWS.migration, ROWS.exportJob, ROWS.checkout, ROWS.webhook] }),
}

const THREADS = [
  { id: 'thread-webhook', name: 'Stripe webhook bug', preview: 'fix the stripe webhook', cwd: '/work/hr-ai', createdAt: secs(90), updatedAt: secs(4), source: 'cli', status: { type: 'idle' } },
  { id: 'thread-checkout', name: 'Stripe checkout copy', preview: 'update checkout copy', cwd: '/work/booking-platform', createdAt: secs(80), updatedAt: secs(12), source: 'cli', status: { type: 'idle' } },
  { id: 'claude-export', name: 'Nightly export job', preview: 'rerun the export', cwd: '/work/automation', createdAt: secs(70), updatedAt: secs(3), source: 'cli', status: { type: 'idle' } },
]
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

async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(`${String(error)} ${String(error.stack ?? '').split('\n').slice(1, 4).join(' | ')}`))
  await page.addInitScript(() => {
    window.EventSource = class { constructor() { this.readyState = 1 } close() {} }
    window.WebSocket = class { constructor() { this.readyState = 0 } send() {} close() {} }
    localStorage.setItem('codex-web-local.theme.v1', 'dark')
  })
  const voiceRequests = []
  await page.route('**/codex-api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.startsWith('/codex-api/voice/')) {
      const voiceCode = path.split('/').at(-1)
      voiceRequests.push({ path, auth: request.headers().authorization ?? null })
      const result = RESULTS[voiceCode]
      return route.fulfill(result ? { json: { data: result } } : { status: 404, json: { error: 'This voice result has expired.' } })
    }
    if (path === '/codex-api/rpc') {
      const body = request.postDataJSON()
      try { return route.fulfill({ json: { result: rpc(body.method, body.params) } }) } catch (error) { return route.fulfill({ status: 502, json: { error: String(error.message) } }) }
    }
    if (path === '/codex-api/workspace-roots-state') return route.fulfill({ json: { data: { order: PROJECTS.map((project) => project.id), labels: {}, active: [] } } })
    if (path === '/codex-api/thread-read-state') return route.fulfill({ json: { data: { version: 1, readAtByThreadId: {}, unreadThreadIds: [] } } })
    if (path.startsWith('/codex-api/push/history')) return route.fulfill({ json: { data: { items: [], unreadCount: 0, dismissals: [] } } })
    return route.fulfill({ json: { data: [] } })
  })
  try {
    await run(page, { voiceRequests })
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

try {
  await scenario('list picker shows panel sections as tabs and switches between them', async (page, { voiceRequests }) => {
    await page.goto(`${base}#/voice/${code('L')}`)
    await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
    await page.getByText('“show me all unread chats”').waitFor()
    for (const [label, count] of [['Needs you', 1], ['Running', 2], ['Unread', 2], ['Recent', 1]]) {
      assert.equal(await page.getByRole('button', { name: `${label}, ${count}`, exact: true }).count(), 1, label)
    }
    assert.equal(await page.getByRole('button', { name: 'Unread, 2', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.deepEqual(await page.locator('.voice-picker-row-title').allInnerTexts(), ['Stripe webhook bug', 'Customer email bounces'])
    await page.screenshot({ path: `${shotsDir}/01-list-picker-unread.png` })
    await page.getByRole('button', { name: 'Running, 2', exact: true }).click()
    assert.deepEqual(await page.locator('.voice-picker-row-title').allInnerTexts(), ['Nightly export job', 'Stripe checkout copy'])
    assert.match(await page.locator('.voice-picker-row-meta').first().innerText(), /automation · Claude · running/u)
    assert.ok(voiceRequests.every((request) => request.auth === null), 'the PWA never sends a bearer token')
    assert.ok(voiceRequests.every((request) => !request.path.includes('/shortcut/')), 'the PWA never calls a shortcut route')
  })

  await scenario('close-call picker marks the best match and offers recent chats', async (page) => {
    await page.goto(`${base}#/voice/${code('C')}`)
    await page.getByRole('heading', { name: 'Which chat?' }).waitFor()
    assert.equal(await page.locator('.voice-picker-best').count(), 1)
    assert.match(await page.locator('.voice-picker-row-title').first().innerText(), /Stripe webhook bug/u)
    await page.screenshot({ path: `${shotsDir}/02-close-call-picker.png` })
    await page.getByRole('button', { name: 'Not these? Recent chats' }).click()
    await page.getByRole('heading', { name: 'Recent chats' }).waitFor()
    assert.equal(await page.locator('.voice-picker-row').count(), 6, 'panel order: needs you, running, unread, recent')
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

  await scenario('not understood shows what was heard and recent chats', async (page) => {
    await page.goto(`${base}#/voice/${code('X')}`)
    await page.getByRole('heading', { name: "Didn't catch that" }).waitFor()
    await page.getByRole('heading', { name: 'Recent chats' }).waitFor()
    assert.equal(await page.locator('.voice-picker-row').count(), 4)
    await page.screenshot({ path: `${shotsDir}/07-not-understood.png` })
  })

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
