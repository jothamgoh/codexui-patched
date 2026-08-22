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

const {
  FAST_SERVICE_TIER_CONFIG_VALUE,
  isFastServiceTier,
  readFastServiceTierByModel,
  serviceTierForModel,
} = await loadTypeScriptModule(new URL('../src/utils/serviceTier.ts', import.meta.url))

test('recognizes both public and protocol Fast tier names', () => {
  assert.equal(FAST_SERVICE_TIER_CONFIG_VALUE, 'fast')
  assert.equal(isFastServiceTier('fast'), true)
  assert.equal(isFastServiceTier(' Priority '), true)
  assert.equal(isFastServiceTier('default'), false)
  assert.equal(isFastServiceTier(null), false)
})

test('maps supported models to their advertised Fast service tier', () => {
  assert.deepEqual(readFastServiceTierByModel([
    {
      id: 'gpt-5.6-sol',
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster' }],
    },
    {
      model: 'gpt-5.5',
      additionalSpeedTiers: ['fast'],
    },
    {
      id: 'gpt-5.4-mini',
      serviceTiers: [],
    },
  ]), {
    'gpt-5.6-sol': 'priority',
    'gpt-5.5': 'fast',
  })
})

test('uses Fast only when enabled and supported by the selected model', () => {
  const tiers = {
    'gpt-5.6-sol': 'priority',
  }
  assert.equal(serviceTierForModel(false, 'gpt-5.6-sol', tiers), null)
  assert.equal(serviceTierForModel(true, 'gpt-5.6-sol', tiers), 'priority')
  assert.equal(serviceTierForModel(true, 'gpt-5.4-mini', tiers), null)
})
