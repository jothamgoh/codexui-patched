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

const uiFontSizeModule = await loadTypeScriptModule(
  new URL('../src/utils/uiFontSize.ts', import.meta.url),
)

const {
  DEFAULT_UI_FONT_SIZE,
  UI_FONT_SIZES,
  normalizeUiFontSize,
  uiFontScale,
} = uiFontSizeModule

test('keeps the existing UI font size as the minimum and default', () => {
  assert.equal(DEFAULT_UI_FONT_SIZE, 14)
  assert.deepEqual(UI_FONT_SIZES, [14, 15, 16])
  assert.equal(normalizeUiFontSize(null), 14)
  assert.equal(normalizeUiFontSize('13'), 14)
  assert.equal(normalizeUiFontSize('14'), 14)
})

test('allows only modest increases and maps them to root rem scaling', () => {
  assert.equal(normalizeUiFontSize('15'), 15)
  assert.equal(normalizeUiFontSize('16'), 16)
  assert.equal(normalizeUiFontSize('17'), 16)
  assert.equal(normalizeUiFontSize('not-a-size'), 14)
  assert.equal(uiFontScale(14), 1)
  assert.equal(uiFontScale(15), 15 / 14)
  assert.equal(uiFontScale(16), 16 / 14)
})
