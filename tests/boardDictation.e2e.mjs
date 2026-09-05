import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = `${root}/output/board-dictation`
await mkdir(output, { recursive: true })
await writeFile(`${output}/fixture.js`, `import {createApp,h,reactive} from 'vue';
import Field from '/src/components/content/DictationField.vue';
import '/src/style.css';
const state=reactive({title:'Build old thing',plan:'One\\nTwo',limit:'prefix ',busy:{},submits:0,mounted:true});
window.fixture=state;
const fields=[['title','Feature title',false,80],['plan','Goal or plan',true,2000],['limit','Short label',false,12]];
createApp({setup(){return()=>h('main',{style:'max-width:580px;margin:40px auto;padding:24px'},[
 h('h1',{style:'font-size:24px;font-weight:600;margin-bottom:8px'},'Plan your next feature'),
 h('p',{style:'margin-bottom:24px;color:var(--muted-foreground)'},'Type or use the microphone, then review and save.'),
 h('form',{onSubmit:e=>{e.preventDefault();if(!Object.values(state.busy).some(Boolean))state.submits++},style:'display:grid;gap:20px'},[
 ...fields.map(([key,label,multiline,maxlength])=>h('label',{style:'display:grid;gap:8px'},[
 h('span',{style:'font-size:14px;font-weight:500'},label),state.mounted?h(Field,{key,modelValue:state[key],'onUpdate:modelValue':v=>state[key]=v,label,multiline,maxlength,required:true,rows:multiline?4:undefined,class:'fixture-field',dictationDisabled:Object.entries(state.busy).some(([id,busy])=>id!==key&&busy),onBusyChange:value=>state.busy[key]=value}):null])),
 h('button',{type:'submit',disabled:Object.values(state.busy).some(Boolean),style:'padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:var(--foreground);color:var(--background)'},'Save board')])])}}).mount('#app');`)
await writeFile(`${output}/index.html`, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="app"></div><script type="module" src="/output/board-dictation/fixture.js"></script></body></html>')
const server = await createServer({ root, configFile: false, plugins: [vue(), tailwind()], resolve: { alias: { '@': `${root}/src` } }, optimizeDeps: { include: ['vue'] }, server: { host: '127.0.0.1', port: 4192, strictPort: true, watch: null } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => {
      if (window.deferPermission) await new Promise(resolve => window.resolvePermission = resolve)
      return { getTracks: () => [{ stop() { window.trackStops = (window.trackStops || 0) + 1 } }] }
    } } })
    window.MediaRecorder = class {
      state = 'inactive'; mimeType = 'audio/webm'
      start() { this.state = 'recording'; window.recordStarts = (window.recordStarts || 0) + 1 }
      stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) }); this.onstop?.() }, 0) }
    }
  })
  let respond
  await page.route('**/codex-api/transcribe', async route => {
    await new Promise(resolve => { respond = async (text, status = 200) => { await route.fulfill({ status, json: { text } }).catch(() => {}); resolve() } })
  })
  await page.goto('http://127.0.0.1:4192/output/board-dictation/index.html')
  const title = page.getByRole('textbox', { name: 'Feature title', exact: true })
  const plan = page.getByRole('textbox', { name: 'Goal or plan', exact: true })
  const save = page.getByRole('button', { name: 'Save board', exact: true })
  const waitForRequest = async () => {
    const deadline = Date.now() + 5000
    while (!respond && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(respond, 'transcription request reached the fixture')
  }
  const record = async label => {
    respond = undefined
    await page.getByRole('button', { name: `Dictate ${label}`, exact: true }).click()
    await page.getByRole('button', { name: `Stop dictating ${label}`, exact: true }).click()
    await page.getByText('Transcribing…', { exact: true }).waitFor()
    await waitForRequest()
  }
  const finish = async (text, status) => {
    await respond(text, status)
    await page.getByText('Transcribing…', { exact: true }).waitFor({ state: 'hidden' })
  }

  // Replace the selected text in a single-line field, without saving or changing siblings.
  await title.focus()
  await title.evaluate(input => input.setSelectionRange(6, 9))
  assert.equal(await title.getAttribute('maxlength'), '80')
  assert.equal(await title.getAttribute('required'), '')
  assert.match(await title.getAttribute('class'), /fixture-field/)
  assert.equal(await plan.getAttribute('rows'), '4')
  await record('Feature title')
  assert.equal(await save.isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Dictate Goal or plan', exact: true }).isDisabled(), true)
  await finish('new\nsmall')
  assert.equal(await title.inputValue(), 'Build new small thing')
  assert.equal(await plan.inputValue(), 'One\nTwo')
  assert.equal(await page.evaluate(() => fixture.submits), 0)

  // A failed request preserves audio for Retry; typing while it transcribes is retained.
  await record('Goal or plan')
  await finish('', 500)
  assert.equal(await save.isDisabled(), true)
  respond = undefined
  await page.getByRole('button', { name: 'Retry transcription', exact: true }).click()
  await page.getByText('Transcribing…', { exact: true }).waitFor()
  await waitForRequest()
  await plan.fill('Keep my typed plan.')
  await finish('Then add a mobile layout.')
  assert.equal(await plan.inputValue(), 'Keep my typed plan.\nThen add a mobile layout.')
  assert.equal(await save.isDisabled(), false)
  await page.screenshot({ path: `${output}/voice-fields-desktop.png` })

  await record('Feature title')
  await plan.fill('A different field stays focused.')
  await finish('new words')
  assert.equal(await plan.inputValue(), 'A different field stays focused.')
  assert.equal(await plan.evaluate(input => input === document.activeElement), true)

  // An overlong transcript stays reviewable and cannot be silently omitted by Save.
  await record('Short label')
  await finish('too many spoken words')
  assert.equal(await page.getByRole('textbox', { name: 'Short label', exact: true }).inputValue(), 'prefix ')
  const review = page.getByRole('textbox', { name: 'Review dictation for Short label', exact: true })
  assert.equal(await review.inputValue(), 'too many spoken words')
  assert.equal(await save.isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Add text', exact: true }).isDisabled(), true)
  await review.fill('fit')
  await page.getByRole('button', { name: 'Add text', exact: true }).click()
  assert.equal(await page.getByRole('textbox', { name: 'Short label', exact: true }).inputValue(), 'prefix fit')
  assert.equal(await page.evaluate(() => fixture.submits), 0)
  await save.click()
  assert.equal(await page.evaluate(() => fixture.submits), 1)

  // Cancelling transcription and late permission cannot write to a different field or record invisibly.
  await record('Goal or plan')
  await page.getByRole('button', { name: 'Cancel dictation for Goal or plan', exact: true }).click()
  await respond('Discard this recording')
  assert.equal(await plan.inputValue(), 'A different field stays focused.')
  const startsBefore = await page.evaluate(() => window.recordStarts)
  const stopsBefore = await page.evaluate(() => window.trackStops)
  await page.evaluate(() => window.deferPermission = true)
  await page.getByRole('button', { name: 'Dictate Feature title', exact: true }).click()
  await page.getByText('Opening microphone…', { exact: true }).waitFor()
  await page.evaluate(() => fixture.mounted = false)
  await page.evaluate(() => window.resolvePermission())
  await page.waitForFunction(stops => window.trackStops > stops, stopsBefore)
  assert.equal(await page.evaluate(() => window.recordStarts), startsBefore)
  assert.equal(await page.evaluate(() => Object.values(fixture.busy).some(Boolean)), false)
  await page.evaluate(() => { fixture.mounted = true; window.deferPermission = false })

  // Cancel releases the form immediately, and an old permission request cannot clear a newer one.
  await page.evaluate(() => window.deferPermission = true)
  await page.getByRole('button', { name: 'Dictate Feature title', exact: true }).click()
  await page.getByText('Opening microphone…', { exact: true }).waitFor()
  await page.evaluate(() => window.oldPermission = window.resolvePermission)
  await page.getByRole('button', { name: 'Cancel dictation for Feature title', exact: true }).click()
  assert.equal(await save.isDisabled(), false)
  await page.getByRole('button', { name: 'Dictate Feature title', exact: true }).click()
  const stopsBeforeCancel = await page.evaluate(() => window.trackStops)
  await page.evaluate(() => window.oldPermission())
  await page.waitForFunction(stops => window.trackStops > stops, stopsBeforeCancel)
  assert.equal(await page.getByText('Opening microphone…', { exact: true }).isVisible(), true)
  assert.equal(await save.isDisabled(), true)
  await page.evaluate(() => window.resolvePermission())
  await page.getByRole('button', { name: 'Stop dictating Feature title', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Cancel dictation for Feature title', exact: true }).click()
  assert.equal(await save.isDisabled(), false)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await page.screenshot({ path: `${output}/voice-fields-mobile.png` })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await touch.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => document.documentElement.dataset.theme = 'dark')
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
    window.MediaRecorder = class { state = 'inactive'; start() { this.state = 'recording' } stop() { this.state = 'inactive' } }
  })
  await touch.goto('http://127.0.0.1:4192/output/board-dictation/index.html')
  await touch.getByRole('button', { name: 'Dictate Goal or plan', exact: true }).click()
  const stop = touch.getByRole('button', { name: 'Stop dictating Goal or plan', exact: true })
  assert.ok((await stop.boundingBox()).height >= 44)
  await touch.waitForTimeout(250)
  await touch.screenshot({ path: `${output}/voice-fields-mobile.png` })
  assert.equal(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await touch.close()
  assert.deepEqual(errors, [])
  const results = { caretInsertion: true, manualSave: true, retry: true, concurrentEditsPreserved: true, overflowReview: true, cancelAndUnmount: true, mobileFits: true }
  console.log(JSON.stringify(results, null, 2))
  await writeFile(`${output}/smoke-results.json`, JSON.stringify(results, null, 2))
} finally {
  await browser.close()
  await server.close()
}
