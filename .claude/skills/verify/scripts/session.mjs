// Playwright session against the verify instance. Import from a scenario file
// saved under output/verify/<run>/ so `playwright` resolves from the repo.
//   import { openSession } from '../../../.claude/skills/verify/scripts/session.mjs'
//   const s = await openSession({ run: 'my-run', mobile: true })
//   await s.go('/scheduled'); await s.shot('01-list'); ...; await s.close()
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, webkit, devices } from 'playwright'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const base = `http://127.0.0.1:${process.env.VERIFY_PORT || 5181}`

export async function openSession({ run, mobile = false, engine = 'chromium' } = {}) {
  if (!run) throw new Error('openSession needs { run } to name the evidence folder')
  const evidence = `${repo}output/verify/${run}`
  await mkdir(evidence, { recursive: true })
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true })
  const context = await browser.newContext(mobile ? { ...devices['iPhone 13'] } : { viewport: { width: 1280, height: 860 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  const log = []
  return {
    page, base, evidence, errors,
    go: (route) => page.goto(`${base}/#${route}`),
    note: (line) => { log.push(line); console.log(line) },
    shot: async (name) => { const path = `${evidence}/${name}.png`; await page.screenshot({ path }); log.push(`screenshot ${path}`) },
    snapshot: async (name) => { await writeFile(`${evidence}/${name}.aria.yml`, await page.locator('body').ariaSnapshot()) },
    close: async () => {
      await writeFile(`${evidence}/log.txt`, [...log, '', 'browser errors:', ...(errors.length ? errors : ['none'])].join('\n') + '\n')
      await browser.close()
    },
  }
}
