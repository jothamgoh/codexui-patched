import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { chromium } from 'playwright'

// Frontend only: all API routes are intercepted; no bridge, notifications, or real Codex data.
const root = fileURLToPath(new URL('..', import.meta.url))
const output = `${root}/output/question-preference`
await mkdir(output, { recursive: true })
await writeFile(`${output}/fixture.js`, `import {createApp,h,reactive} from 'vue';
import Control from '/src/components/content/QuestionSettingControl.vue';
import Question from '/src/components/content/RequestUserInputCard.vue';
import {startThread} from '/src/api/codexGateway.ts';
import '/src/style.css';
window.createProbeChat=()=>startThread('/fixture/workspace','gpt-6-astra');window.questionReplies=[];
const draft=reactive({index:0,answers:new Map()});
const request={id:91,method:'item/tool/requestUserInput',params:{threadId:'existing',questions:[{id:'scope',question:'Which approach should I use?',options:[{label:'Small change (Recommended)',description:'Keep the current workflow.'},{label:'Broader redesign',description:'Revisit the whole flow.'}]}]}};
createApp({render:()=>h('main',{style:'max-width:600px;padding:20px;margin:auto'},[h('h1',{style:'font-size:20px;margin-bottom:16px'},'Settings'),h(Control),h('div',{style:'margin-top:32px'},[h(Question,{request,draft,onRespond:r=>window.questionReplies.push(r)})])])}).mount('#app');`)
await writeFile(`${output}/index.html`, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="app"></div><script type="module" src="/output/question-preference/fixture.js"></script></body></html>')
const server = await createServer({ root, configFile: false, plugins: [vue(), tailwind()], resolve: { alias: { '@': `${root}/src` } }, optimizeDeps: { include: ['vue', 'pinia', 'vue-router'] }, server: { host: '127.0.0.1', port: 4195, strictPort: true, watch: null } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors = [], requests = []
  let supported = true, managed = false, unavailable = false
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => { window.EventSource = class { close() {} } })
  await page.route('**/codex-api/**', async route => {
    const path = new URL(route.request().url()).pathname
    assert.equal(path, '/codex-api/rpc', `Unexpected API request: ${path}`)
    const body = route.request().postDataJSON(); requests.push(body)
    let result
    if (body.method === 'configRequirements/read') result = { requirements: managed ? { featureRequirements: { default_mode_request_user_input: false } } : null }
    else if (body.method === 'experimentalFeature/list') {
      if (unavailable) return route.fulfill({ status: 500, json: { error: 'Unsupported method' } })
      result = { data: supported ? [{ name: 'default_mode_request_user_input', stage: 'underDevelopment', enabled: false, defaultEnabled: false }] : [], nextCursor: null }
    } else if (body.method === 'thread/start') result = { thread: { id: 'created' }, model: 'gpt-6-astra', reasoningEffort: 'low' }
    else assert.fail(`Unexpected RPC method: ${body.method}`)
    await route.fulfill({ json: { result } })
  })
  const url = 'http://127.0.0.1:4195/output/question-preference/index.html'
  await page.goto(url)
  const toggle = page.getByRole('switch', { name: 'Questions in new chats' })
  await toggle.waitFor()
  assert.equal(await toggle.isChecked(), true)
  await page.getByText('Existing chats keep their current setting.', { exact: true }).waitFor()
  await page.evaluate(() => createProbeChat())
  assert.deepEqual(requests.findLast(r => r.method === 'thread/start').params.config, { 'features.default_mode_request_user_input': true })
  await page.screenshot({ path: `${output}/settings-desktop.png` })
  await toggle.uncheck()
  assert.equal(await page.evaluate(() => localStorage.getItem('codex-web-local.new-chat-questions.v1')), 'false')
  assert.equal(await page.getByText('Waiting for your answer', { exact: true }).count(), 1)
  assert.deepEqual(await page.evaluate(() => questionReplies), [])
  await page.evaluate(() => createProbeChat())
  assert.deepEqual(requests.findLast(r => r.method === 'thread/start').params.config, { 'features.default_mode_request_user_input': false })
  await page.reload(); await toggle.waitFor()
  assert.equal(await toggle.isChecked(), false)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${output}/settings-mobile.png` })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  for (const scenario of ['unsupported', 'managed', 'unavailable']) {
    supported = scenario !== 'unsupported'; managed = scenario === 'managed'; unavailable = scenario === 'unavailable'
    await page.reload()
    await page.evaluate(() => createProbeChat())
    assert.equal(await toggle.count(), 0, scenario)
    assert.equal('config' in requests.findLast(r => r.method === 'thread/start').params, false, scenario)
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ defaultOn: true, persistedOff: true, newChatConfig: true, pendingQuestionUnaffected: true, unsupportedHidden: true, managedHidden: true, failedCapabilityHidden: true, mobileOverflow: false }))
} finally { await browser.close(); await server.close() }
