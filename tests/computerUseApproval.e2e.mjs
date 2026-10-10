import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = `${root}/output/computer-use-approval`
await mkdir(output, { recursive: true })
await writeFile(`${output}/fixture.js`, `import {createApp,h,reactive} from 'vue';
import {createPinia} from 'pinia';
import {createRouter,createMemoryHistory} from 'vue-router';
import Conversation from '/src/components/content/ThreadConversation.vue';
import '/src/style.css';
const state=reactive({pending:[{id:901,method:'item/permissions/requestApproval',threadId:'claude-fixture',turnId:'turn-1',itemId:'tool-1',receivedAtIso:new Date().toISOString(),params:{threadId:'claude-fixture',turnId:'turn-1',itemId:'tool-1',title:'Allow Claude to control this Mac?',reason:'Claude requested a Computer Use action. Review the current task before allowing it.',permissionKind:'computerUse',availableDecisions:['accept','acceptForSession','decline']}}],replies:[]});
window.fixture=state;
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}}]});
createApp({setup(){const respond=(payload)=>{state.replies.push(payload);state.pending=[]};return()=>h('main',{style:'height:100dvh;display:flex;flex-direction:column'},[h(Conversation,{messages:[{id:'user',role:'user',text:'Open System Settings and check the display options.'}],pendingRequests:state.pending,activeThreadId:'claude-fixture',isLoading:false,scrollState:null,liveOverlay:null,automationProposals:[],automationTasks:[],onRespondServerRequest:respond})])}}).use(createPinia()).use(router).mount('#app');`)
await writeFile(`${output}/index.html`, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="app"></div><script type="module" src="/output/computer-use-approval/fixture.js"></script></body></html>')

const server = await createServer({
  root,
  configFile: false,
  plugins: [vue(), tailwind()],
  resolve: { alias: { '@': `${root}/src` } },
  optimizeDeps: { include: ['vue', 'pinia', 'vue-router'] },
  server: { host: '127.0.0.1', port: 4195, strictPort: true, watch: null },
})
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto('http://127.0.0.1:4195/output/computer-use-approval/index.html')
  await page.getByText('Permission to control this Mac', { exact: true }).waitFor()
  await page.getByText('Claude requested a Computer Use action. Review the current task before allowing it.', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Accept', exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Allow for this chat', exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Decline', exact: true }).count(), 1)
  await page.screenshot({ path: `${output}/desktop.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${output}/mobile.png` })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('button', { name: 'Allow for this chat', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => fixture.replies), [{ id: 901, result: { decision: 'acceptForSession' } }])
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ approvalCard: true, allowForChat: true, mobileOverflow: false }))
} finally {
  await browser.close()
  await server.close()
}
