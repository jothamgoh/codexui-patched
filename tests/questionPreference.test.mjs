import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/utils/questionPreference.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
const { canConfigureQuestionFeature, readQuestionPreference } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const feature = { name: 'default_mode_request_user_input', stage: 'underDevelopment', enabled: false, defaultEnabled: false }

test('new-chat questions default on and preserve a saved off preference', () => {
  assert.equal(readQuestionPreference(null), true)
  assert.equal(readQuestionPreference('true'), true)
  assert.equal(readQuestionPreference('false'), false)
})

test('only offers questions when the runtime advertises the feature and requirements are readable', () => {
  assert.equal(canConfigureQuestionFeature(feature, { requirements: null }), true)
  assert.equal(canConfigureQuestionFeature(feature, { requirements: {} }), true)
  for (const row of [null, {}, { ...feature, name: 'another_feature' }, { ...feature, stage: 'removed' }, { ...feature, stage: 'deprecated' }]) {
    assert.equal(canConfigureQuestionFeature(row, { requirements: null }), false)
  }
  for (const response of [null, {}, { requirements: false }]) assert.equal(canConfigureQuestionFeature(feature, response), false)
})

test('does not override a managed question feature in either direction', () => {
  for (const value of [true, false]) {
    assert.equal(canConfigureQuestionFeature(feature, { requirements: { featureRequirements: { default_mode_request_user_input: value } } }), false)
  }
  assert.equal(canConfigureQuestionFeature(feature, { requirements: { featureRequirements: { another_feature: false } } }), true)
})
