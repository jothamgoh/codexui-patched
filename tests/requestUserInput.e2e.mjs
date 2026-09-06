import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { chromium } from 'playwright'

// Frontend-only Vite: every API request and event is stubbed. No bridge or Codex process.
const root = fileURLToPath(new URL('..', import.meta.url))
const output = `${root}/output/request-user-input`
await mkdir(output, { recursive: true })
await writeFile(`${output}/fixture.js`, `import {createApp,h,reactive} from 'vue';
import {createPinia} from 'pinia';
import {createRouter,createMemoryHistory} from 'vue-router';
import Conversation from '/src/components/content/ThreadConversation.vue';
import {useDesktopState} from '/src/composables/useDesktopState.ts';
import {normalizeThreadMessagesV2} from '/src/api/normalizers/v2.ts';
import '/src/style.css';
const state=reactive({threadId:'parent',revision:0,useDesktopMessages:true,messages:[{id:'user',role:'user',text:'Improve the project planning flow.'},{id:'assistant',role:'assistant',text:'I have checked the existing flow. One choice will help me finish the change.'}]});window.fixture=state;
const desktop=useDesktopState();window.desktop=desktop;desktop.selectedThreadId.value='parent';desktop.startPolling();
window.normalizeHistory=normalizeThreadMessagesV2;window.asyncReplies=[];
async function submitQuestionAnswer(threadId,text){
  window.asyncReplies.push({threadId,text});
  if(window.asyncReplies.length===1)await new Promise((resolve,reject)=>{window.failAsyncReply=()=>reject(new Error('Temporarily disconnected.'))});
  state.messages.push({id:'async-reply-'+window.asyncReplies.length,role:'user',text});
}
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}},{path:'/thread/:threadId',name:'thread',component:{render:()=>null}}]});
createApp({setup(){return()=>h('main',{style:'height:100dvh;display:flex;flex-direction:column'},[h(Conversation,{key:state.revision,messages:[...state.messages,...(state.useDesktopMessages?desktop.messages.value:[])],pendingRequests:desktop.selectedThreadServerRequests.value,activeThreadId:state.threadId,isLoading:false,scrollState:null,liveOverlay:{activityLabel:'Working',reasoningText:'',errorText:''},automationProposals:[],automationTasks:[],submitQuestionAnswer,onRespondServerRequest:desktop.respondToPendingServerRequest})])}}).use(createPinia()).use(router).mount('#app');`)
await writeFile(`${output}/index.html`, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="app"></div><script type="module" src="/output/request-user-input/fixture.js"></script></body></html>')
const server = await createServer({ root, configFile: false, plugins: [vue(), tailwind()], resolve: { alias: { '@': `${root}/src` } }, optimizeDeps: { include: ['vue', 'pinia', 'vue-router'] }, server: { host: '127.0.0.1', port: 4194, strictPort: true, watch: null } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, hasTouch: true })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => {
    window.EventSource = class { constructor() { window.fixtureEvents = this } close() {} }
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
    window.MediaRecorder = class {
      state = 'inactive'; mimeType = 'audio/webm'
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) }); this.onstop?.() }, 0) }
    }
  })
  const replies = []
  let releaseReply
  await page.route('**/codex-api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/codex-api/server-requests/respond') {
      replies.push(route.request().postDataJSON())
      if (replies.length === 1) {
        await new Promise(resolve => { releaseReply = resolve })
        await route.fulfill({ status: 503, json: { error: 'Temporarily disconnected.' } })
      } else await route.fulfill({ json: { ok: true } })
    } else if (path === '/codex-api/transcribe') await route.fulfill({ json: { text: 'Keep the existing approval checks and test the mobile layout.' } })
    else await route.fulfill({ json: { requests: [], data: [] } })
  })
  await page.goto('http://127.0.0.1:4194/output/request-user-input/index.html')
  await page.getByText('Working', { exact: true }).waitFor()
  const notify = (method, params) => page.evaluate(({ method, params }) => fixtureEvents.onmessage({ data: JSON.stringify({ method, params }) }), { method, params })
  const request = { id: 701, method: 'item/tool/requestUserInput', params: { threadId: 'parent', turnId: 'turn-1', itemId: 'question-call', questions: [
    { id: 'scope', header: 'Scope', question: 'How broad should this change be?', isOther: true, isSecret: false, options: [{ label: 'Small fix (Recommended)', description: 'Keep the current workflow and improve the rough parts.' }, { label: 'Broader redesign', description: 'Rework the planning flow and revisit its layout.' }] },
    { id: 'notes', header: 'Details', question: 'Anything else I should keep in mind?', isOther: false, isSecret: false, options: null },
  ] } }
  await notify('server/request', request)
  await page.getByText('Waiting for your answer', { exact: true }).waitFor()
  assert.equal(await page.getByText('Working', { exact: true }).count(), 0)
  assert.equal(await page.getByText('item/tool/requestUserInput', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled(), true)
  await page.getByText('Keep the current workflow and improve the rough parts.', { exact: true }).waitFor()
  await page.getByRole('radio', { name: /Small fix/ }).check()
  await page.screenshot({ path: `${output}/question-desktop.png` })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Dictate Anything else I should keep in mind?', exact: true }).click()
  await page.getByRole('button', { name: 'Stop dictating Anything else I should keep in mind?', exact: true }).click()
  await page.getByText('Ready — review your words before saving.', { exact: true }).waitFor()
  assert.equal(replies.length, 0)
  assert.equal(await page.getByRole('textbox', { name: 'Anything else I should keep in mind?', exact: true }).inputValue(), 'Keep the existing approval checks and test the mobile layout.')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  assert.equal(await page.getByRole('radio', { name: /Small fix/ }).isChecked(), true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${output}/question-mobile.png` })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('radio', { name: 'Other', exact: true }).check()
  await page.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Keep the cards and improve their wording.')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.evaluate(() => { fixture.threadId = 'other'; desktop.selectedThreadId.value = 'other' })
  await page.locator('.question-card').waitFor({ state: 'hidden' })
  await page.evaluate(() => { fixture.threadId = 'parent'; desktop.selectedThreadId.value = 'parent' })
  await page.getByRole('textbox', { name: 'Anything else I should keep in mind?', exact: true }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Anything else I should keep in mind?', exact: true }).inputValue(), 'Keep the existing approval checks and test the mobile layout.')
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await page.getByText('Sending your answer…', { exact: true }).waitFor()
  // Replaying the request during submission must retain disabled state and block duplicates.
  await notify('server/request', request)
  assert.equal(await page.getByRole('button', { name: 'Sending…', exact: true }).isDisabled(), true)
  await page.evaluate(() => desktop.respondToPendingServerRequest({ id: 701, result: { answers: {} } }))
  assert.equal(replies.length, 1)
  releaseReply()
  await page.getByRole('alert').filter({ hasText: 'Your answer is still here' }).waitFor()
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await page.locator('.question-card').waitFor({ state: 'hidden' })
  assert.equal(replies.length, 2)
  assert.deepEqual(replies[1], { id: 701, result: { answers: { scope: { answers: ['Keep the cards and improve their wording.'] }, notes: { answers: ['Keep the existing approval checks and test the mobile layout.'] } } } })
  await notify('item/completed', { threadId: 'parent', turnId: 'turn-1', item: { id: 'continued', type: 'agentMessage', phase: 'final_answer', text: 'I continued with the focused change and kept the approval checks.' } })
  await page.getByText('I continued with the focused change and kept the approval checks.', { exact: true }).waitFor()
  await notify('server/request', { id: 702, method: 'item/tool/requestUserInput', params: { threadId: 'parent', turnId: 'turn-2', itemId: 'secret-call', questions: [{ id: 'secret', question: 'Enter the requested value', isSecret: true, options: null }] } })
  await page.locator('.question-card input[type="password"]').fill('fixture-secret')
  assert.equal(await page.locator('.question-card').getByRole('button', { name: /^Dictate / }).count(), 0)
  assert.equal(await page.locator('.question-card').getByText('fixture-secret', { exact: true }).count(), 0)
  await notify('server/request/resolved', { id: 702 })

  // New native async questions are message items, not pending server requests.
  // A later final answer must leave them answerable, including after history reload.
  const asyncItem = { id: 'async-question-call', type: 'agentMessage', phase: 'final_answer', delivery: 'async', text: 'Choose a scope and tell me any constraints.', questions: [
    { title: 'How much should we change?', options: ['Focused improvement', 'Broader redesign'] },
    { title: 'Which constraint matters most?', options: ['Keep desktop familiar', 'Prioritize mobile'] },
  ] }
  const finalItem = { id: 'async-final', type: 'agentMessage', phase: 'final_answer', text: 'I can continue checking the layout while you answer.' }
  await notify('item/completed', { threadId: 'parent', turnId: 'turn-async', item: asyncItem })
  await notify('item/completed', { threadId: 'parent', turnId: 'turn-async', item: finalItem })
  const asyncCards = page.locator('.async-question-card')
  await asyncCards.nth(1).waitFor()
  assert.equal(await asyncCards.count(), 2)
  assert.deepEqual(await page.evaluate(() => desktop.messages.value.find(message => message.asyncQuestions?.length)?.asyncQuestions), [
    { id: JSON.stringify(['request_user_input_async', asyncItem.id, 0]), title: asyncItem.questions[0].title, options: asyncItem.questions[0].options },
    { id: JSON.stringify(['request_user_input_async', asyncItem.id, 1]), title: asyncItem.questions[1].title, options: asyncItem.questions[1].options },
  ])
  const firstAsync = asyncCards.nth(0)
  await firstAsync.getByRole('radio', { name: 'Focused improvement', exact: true }).check()
  await page.setViewportSize({ width: 1100, height: 850 })
  await firstAsync.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${output}/async-question-desktop.png` })
  await firstAsync.getByRole('button', { name: 'Send answer', exact: true }).click()
  await firstAsync.getByRole('button', { name: /Sending/ }).waitFor()
  assert.equal(await firstAsync.getByRole('button', { name: /Sending/ }).isDisabled(), true)
  await page.evaluate(() => failAsyncReply())
  await firstAsync.getByRole('alert').waitFor()
  assert.equal(await firstAsync.getByRole('radio', { name: 'Focused improvement', exact: true }).isChecked(), true)
  await firstAsync.getByRole('button', { name: 'Send answer', exact: true }).click()
  await firstAsync.getByText('Answer sent', { exact: true }).waitFor()
  const expectedFirst = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', asyncItem.id, 0]), question: asyncItem.questions[0].title, answer: 'Focused improvement' }])}\n</send_user_message_question_reply>`
  assert.deepEqual(await page.evaluate(() => asyncReplies), [{ threadId: 'parent', text: expectedFirst }, { threadId: 'parent', text: expectedFirst }])

  const secondAsync = asyncCards.nth(1)
  await page.setViewportSize({ width: 390, height: 844 })
  await secondAsync.getByRole('radio', { name: 'Write an answer', exact: true }).check()
  await secondAsync.getByRole('button', { name: /^Dictate / }).click()
  await secondAsync.getByRole('button', { name: /^Stop dictating / }).click()
  await secondAsync.getByText('Ready — review your words before saving.', { exact: true }).waitFor()
  assert.equal(await secondAsync.getByRole('textbox').inputValue(), 'Keep the existing approval checks and test the mobile layout.')
  assert.equal(await page.evaluate(() => asyncReplies.length), 2, 'Stopping dictation must not send an answer')
  await secondAsync.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${output}/async-question-mobile.png` })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.ok((await secondAsync.getByRole('button', { name: 'Send answer', exact: true }).boundingBox()).height >= 44)
  await secondAsync.getByRole('button', { name: 'Send answer', exact: true }).click()
  await secondAsync.getByText('Answer sent', { exact: true }).waitFor()
  const expectedSecond = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', asyncItem.id, 1]), question: asyncItem.questions[1].title, answer: 'Keep the existing approval checks and test the mobile layout.' }])}\n</send_user_message_question_reply>`
  assert.deepEqual(await page.evaluate(() => asyncReplies[2]), { threadId: 'parent', text: expectedSecond })
  await page.evaluate(({ asyncItem, finalItem, responses }) => {
    fixture.messages = normalizeHistory({ thread: { id: 'parent', cwd: '/fixture', turns: [{ id: 'turn-async', status: 'completed', items: [asyncItem, finalItem, ...responses.map((text, index) => ({ id: 'persisted-reply-' + index, type: 'userMessage', content: [{ type: 'text', text }] }))] }] } })
    fixture.useDesktopMessages = false
    fixture.revision += 1
  }, { asyncItem, finalItem, responses: [expectedFirst, expectedSecond] })
  await asyncCards.nth(1).getByText('Answer sent', { exact: true }).waitFor()
  assert.equal(await asyncCards.getByText('Answer sent', { exact: true }).count(), 2, 'Answers survive transcript normalization and component remount')
  assert.equal(await page.getByText('<send_user_message_question_reply>', { exact: false }).count(), 0)
  assert.deepEqual(errors, [])
  await page.evaluate(() => desktop.stopPolling())
  console.log(JSON.stringify({ questions: true, optionDescriptions: true, freeTextVoice: true, explicitSubmit: true, retryPreserved: true, replayDuplicateGuard: true, resumedMessages: true, secretMasked: true, asyncLiveQuestions: true, asyncRetry: true, asyncVoice: true, asyncHistoryReload: true, mobileOverflow: false }))
} finally { await browser.close(); await server.close() }
