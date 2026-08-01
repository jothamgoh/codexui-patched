import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

const runtimeConfigSourceUrl = new URL('../src/server/runtimeConfig.ts', import.meta.url)
const { readCodexUiRuntimeConfig } = await loadTypeScriptModule(runtimeConfigSourceUrl)

test('accepts a supported default reasoning effort', () => {
  assert.deepEqual(
    readCodexUiRuntimeConfig({ CODEXUI_DEFAULT_REASONING_EFFORT: ' High ' }),
    { defaultReasoningEffort: 'high' },
  )
})

test('ignores an unsupported default reasoning effort', () => {
  assert.deepEqual(
    readCodexUiRuntimeConfig({ CODEXUI_DEFAULT_REASONING_EFFORT: 'extreme' }),
    { defaultReasoningEffort: '' },
  )
})
