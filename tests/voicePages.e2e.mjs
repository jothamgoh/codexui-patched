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
}

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
    if (path === '/codex-api/thread-read-state') return route.fulfill({ json: { data: { version: 1, readAtByThreadId: {}, unreadThreadIds: panel.unreadThreadIds } } })
    if (path === '/codex-api/pinned-threads') return route.fulfill({ json: { data: { threadIds: panel.pinnedThreadIds } } })
    if (path === '/codex-api/server-requests/pending') return route.fulfill({ json: { data: panel.pending } })
    if (path.startsWith('/codex-api/push/history')) return route.fulfill({ json: { data: { items: panel.history, unreadCount: 0, dismissals: [] } } })
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
const sheet = (page) => page.locator('.notification-popover')
const section = (page, name) => page.locator(`[data-activity-section="${name}"]`)
const filterPressed = (page, label) => page.getByRole('group', { name: 'Activity filter' }).getByRole('button', { name: new RegExp(`^${label}`, 'u') }).getAttribute('aria-pressed')
const voiceNote = (page) => page.getByRole('status', { name: 'Voice command' })
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

  await scenario("didn't catch that opens the panel at the top with what was heard and a mic to say it again", async (page) => {
    await page.goto(`${base}#/voice/${code('X')}`)
    await sheet(page).waitFor()
    await voiceNote(page).getByText("Didn't catch that").waitFor()
    await voiceNote(page).getByText('Heard: “uh can you, the thing from before”').waitFor()
    await page.waitForFunction(() => window.location.hash === '#/')
    assert.equal(await filterPressed(page, 'All'), 'true')
    assert.equal(await page.locator('.notification-activity').evaluate((el) => el.scrollTop), 0)
    assert.equal(await page.locator('.is-landing-focus').count(), 0)
    assert.equal(await voiceNote(page).getByRole('button', { name: 'Say a voice command' }).count(), 1)
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
