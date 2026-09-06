import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { chromium, devices } from 'playwright'

// Actual picker components; filesystem responses are fixtures. No Codex process,
// live project registrations, or host folder writes are performed by the UI.
const root = fileURLToPath(new URL('..', import.meta.url))
const output = `${root}/output/host-folders`
await mkdir(output, { recursive: true })
await writeFile(`${output}/fixture.js`, `import {createApp,h,ref} from 'vue';
import FolderPicker from '/src/components/content/NewThreadFolderPicker.vue';
import BoardPlanDialog from '/src/components/content/BoardPlanDialog.vue';
import '/src/style.css';
window.selections=[];window.plans=[];
const agents=[{id:'builtin-lead',name:'Lead',role:'lead',description:'Coordinate delivery.',instructions:'Coordinate delivery.',model:'',reasoningEffort:'',sandbox:'read-only',builtIn:true,createdAtIso:'',updatedAtIso:''}];
createApp({setup(){const path=ref('');const planOpen=ref(false);return()=>h('main',{style:'padding:48px 12px;'},[
 h(FolderPicker,{modelValue:path.value,options:[{value:'/home/demo/Projects/Existing',label:'Existing project'}],defaultAddValue:'New project',
  'onUpdate:modelValue':value=>{path.value=value},onAdd:value=>{path.value=value;window.selections.push(value)}}),
 h('button',{onClick:()=>planOpen.value=true},'Plan a project'),
 h(BoardPlanDialog,{open:planOpen.value,projects:[],agents,'onUpdate:open':value=>planOpen.value=value,onPlan:async value=>window.plans.push(value)})
])}}).mount('#app');`)
await writeFile(`${output}/index.html`, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="app"></div><script type="module" src="/output/host-folders/fixture.js"></script></body></html>')
const server = await createServer({ root, configFile: false, plugins: [vue(), tailwind()], resolve: { alias: { '@': `${root}/src` } }, optimizeDeps: { include: ['vue'] }, server: { host: '127.0.0.1', port: 4198, strictPort: true, watch: null } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop'
    const context = await browser.newContext(mobile ? { ...devices['iPhone 13'], deviceScaleFactor: 1 } : { viewport: { width: 1200, height: 900 } })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`))
    await page.route('**/codex-api/project-board-models*', route => route.fulfill({ json: { data: { defaultModel: 'build-model', defaultReasoningEffort: 'high', models: [{ id: 'build-model', label: 'Build model', reasoningEfforts: ['high'], defaultReasoningEffort: 'high' }] } } }))
    await page.route('**/codex-api/host-folders?**', async route => {
      const url = new URL(route.request().url())
      const path = url.searchParams.get('path') || '/home/demo'
      if (path === '/home/demo/Protected') return route.fulfill({ status: 403, json: { error: 'CodexUI cannot read this folder. Choose another folder or check its permissions on the computer.' } })
      const names = path === '/home/demo' ? ['Projects', 'Protected', ...(url.searchParams.get('showHidden') === 'true' ? ['.hidden-projects'] : [])]
        : path === '/home/demo/Projects' ? ['Existing', 'Empty folder', 'Large folder', 'A project with a very long name that should wrap without covering the folder action']
          : path === '/home/demo/Projects/Large folder' ? Array.from({ length: 500 }, (_, index) => `Project ${index + 1}`) : []
      return route.fulfill({ json: { data: { path, homePath: '/home/demo', parentPath: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/', folders: names.map(name => ({ name, path: `${path}/${name}` })), truncated: path.endsWith('/Large folder') } } })
    })
    await page.goto('http://127.0.0.1:4198/output/host-folders/index.html')
    const openBrowser = async () => {
      await page.getByRole('button', { name: 'Choose workspace folder' }).click()
      await page.getByRole('button', { name: 'Browse computer folders' }).click()
      await page.getByRole('dialog', { name: 'Choose a folder' }).waitFor()
      await page.getByRole('button', { name: 'Use folder', exact: true }).waitFor()
    }
    await openBrowser()
    await page.getByRole('button', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: 'Empty folder', exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.selections), [], 'Browsing must not register or select a project')
    await page.screenshot({ path: `${output}/folders-${label}.png` })
    const geometry = await page.locator('.host-folder-dialog').evaluate(element => ({ width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right, bottom: element.getBoundingClientRect().bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, overflowing: element.scrollWidth > element.clientWidth + 1 }))
    assert.equal(geometry.overflowing, false)
    assert.ok(geometry.right <= geometry.viewportWidth + 1 && geometry.bottom <= geometry.viewportHeight + 1)
    if (mobile) assert.equal(await page.evaluate(() => document.activeElement?.tagName === 'INPUT'), false, 'Opening the browser must not summon the phone keyboard')
    await page.getByRole('button', { name: 'Empty folder', exact: true }).click()
    await page.getByText('No subfolders here. You can use this folder.').waitFor()
    await page.getByRole('button', { name: 'Use folder', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.selections), ['/home/demo/Projects/Empty folder'])
    await openBrowser()
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.getByRole('button', { name: 'Protected', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Use folder', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.getByRole('button', { name: 'Projects', exact: true }).waitFor()
    await page.getByText('Path and hidden folders', { exact: true }).click()
    await page.getByRole('checkbox', { name: 'Show hidden folders' }).check()
    await page.getByRole('button', { name: '.hidden-projects', exact: true }).waitFor()
    await page.getByRole('textbox', { name: 'Folder path', exact: true }).fill('/home/demo/Projects')
    await page.getByRole('button', { name: 'Go', exact: true }).click()
    await page.getByRole('button', { name: 'Large folder', exact: true }).click()
    await page.getByText(/Showing 500 folders/).waitFor()
    await page.getByText('Path and hidden folders', { exact: true }).click()
    await page.getByRole('button', { name: 'Project 500', exact: true }).scrollIntoViewIfNeeded()
    assert.ok(await page.locator('.host-folder-list').evaluate(element => element.scrollTop > 0))
    await page.getByRole('button', { name: 'Up', exact: true }).click()
    await page.getByRole('button', { name: 'Existing', exact: true }).waitFor()
    await page.getByRole('combobox', { name: 'Jump to a recent project' }).selectOption('/home/demo/Projects/Existing')
    await page.getByText('No subfolders here. You can use this folder.').waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await page.evaluate(() => window.selections.length), 1, 'Cancel must preserve the chosen project')
    await page.getByRole('button', { name: 'Choose workspace folder' }).click()
    await page.getByRole('button', { name: 'Create folder or enter a path' }).click()
    await page.getByRole('textbox', { name: 'Project name or absolute path' }).fill('A new project')
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.selections), ['/home/demo/Projects/Empty folder', 'A new project'], 'Keep the existing typed creation path')
    await page.getByRole('button', { name: 'Plan a project', exact: true }).click()
    const planning = page.getByRole('dialog', { name: 'Plan project features' })
    await planning.getByRole('textbox', { name: 'Goal or plan', exact: true }).fill('Keep this plan while choosing its project folder.')
    await planning.getByRole('textbox', { name: 'Board name', exact: true }).fill('Preserved board title')
    await planning.getByRole('checkbox', { name: 'Create this folder if it does not exist' }).check()
    await planning.getByRole('button', { name: 'Browse computer folders' }).click()
    const folders = page.getByRole('dialog', { name: 'Choose a folder' })
    await folders.getByRole('button', { name: 'Projects', exact: true }).click()
    await folders.getByRole('button', { name: 'Existing', exact: true }).click()
    await folders.getByText('No subfolders here. You can use this folder.').waitFor()
    await folders.getByRole('button', { name: 'Use folder', exact: true }).click()
    assert.equal(await planning.getByRole('textbox', { name: 'Project folder', exact: true }).inputValue(), '/home/demo/Projects/Existing')
    assert.equal(await planning.getByRole('textbox', { name: 'Goal or plan', exact: true }).inputValue(), 'Keep this plan while choosing its project folder.')
    assert.equal(await planning.getByRole('textbox', { name: 'Board name', exact: true }).inputValue(), 'Preserved board title')
    assert.equal(await planning.getByRole('checkbox', { name: 'Create this folder if it does not exist' }).isChecked(), false)
    assert.deepEqual(await page.evaluate(() => window.plans), [], 'Selecting a folder must not start a planning run')
    await page.screenshot({ path: `${output}/plan-folder-${label}.png` })
    await planning.getByRole('button', { name: 'Create feature plan' }).click()
    await planning.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.plans[0].projectPath), '/home/demo/Projects/Existing')
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log('Host folder picker desktop and touch checks passed; no live project state was changed.')
} finally { await browser.close(); await server.close() }
