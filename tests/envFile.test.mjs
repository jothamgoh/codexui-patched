import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(sourcePath) {
  const source = await readFile(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const envFileSourceUrl = new URL('../src/server/envFile.ts', import.meta.url)
const { getCodexUiChildEnv, loadCodexUiEnv, parseEnvFile } = await loadTypeScriptModule(envFileSourceUrl)

test('parses comments, quoted values, and export prefixes', () => {
  assert.deepEqual(
    parseEnvFile(`
# comment
PLAIN=value
QUOTED="value with spaces"
export EXPORTED='another value'
INLINE=value # ignored comment
INVALID-KEY=nope
`),
    {
      PLAIN: 'value',
      QUOTED: 'value with spaces',
      EXPORTED: 'another value',
      INLINE: 'value',
    },
  )
})

test('loads an explicit file without overriding existing environment values', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-env-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const envPath = join(directory, 'secrets.env')
  await writeFile(envPath, 'EXISTING=file\nNEW_VALUE=loaded\n', { mode: 0o600 })
  const env = { EXISTING: 'shell' }

  const result = loadCodexUiEnv({ env, explicitPath: envPath })

  assert.equal(result.path, envPath)
  assert.deepEqual(result.loadedKeys, ['NEW_VALUE'])
  assert.equal(env.EXISTING, 'shell')
  assert.equal(env.NEW_VALUE, 'loaded')
  assert.equal(env.CODEXUI_ENV_FILE, envPath)
})

test('loads .env from the application root by default', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codexui-env-default-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const envPath = join(directory, '.env')
  await writeFile(envPath, 'DEFAULT_VALUE=loaded\n', { mode: 0o600 })
  const env = {}

  const result = loadCodexUiEnv({ appRootDir: directory, cwd: directory, env })

  assert.equal(result.path, envPath)
  assert.equal(env.DEFAULT_VALUE, 'loaded')
})

test('rejects a missing explicitly configured env file', () => {
  assert.throws(
    () => loadCodexUiEnv({ env: {}, explicitPath: '/definitely/missing/codexui.env' }),
    /CodexUI environment file was not found/u,
  )
})

test('strips app secrets from child environments and permits explicit MCP credentials', () => {
  const originalTelegramToken = process.env.CODEXUI_TELEGRAM_BOT_TOKEN
  const originalJinaKey = process.env.JINA_API_KEY
  process.env.CODEXUI_TELEGRAM_BOT_TOKEN = 'telegram-secret'
  process.env.JINA_API_KEY = 'jina-secret'

  try {
    const ordinaryChild = getCodexUiChildEnv()
    assert.equal(ordinaryChild.CODEXUI_TELEGRAM_BOT_TOKEN, undefined)
    assert.equal(ordinaryChild.JINA_API_KEY, undefined)

    const codexChild = getCodexUiChildEnv({}, ['JINA_API_KEY'])
    assert.equal(codexChild.CODEXUI_TELEGRAM_BOT_TOKEN, undefined)
    assert.equal(codexChild.JINA_API_KEY, 'jina-secret')
  } finally {
    if (originalTelegramToken === undefined) delete process.env.CODEXUI_TELEGRAM_BOT_TOKEN
    else process.env.CODEXUI_TELEGRAM_BOT_TOKEN = originalTelegramToken
    if (originalJinaKey === undefined) delete process.env.JINA_API_KEY
    else process.env.JINA_API_KEY = originalJinaKey
  }
})
