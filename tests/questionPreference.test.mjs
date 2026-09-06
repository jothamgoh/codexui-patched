import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/utils/questionPreference.ts', import.meta.url), 'utf8')
const compile = (value) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`
const questionModule = compile(source)
const { canConfigureQuestionFeature, readQuestionPreference } = await import(questionModule)
const boardSource = (await readFile(new URL('../src/server/projectBoardQuestions.ts', import.meta.url), 'utf8')).replace("from '../utils/questionPreference'", `from '${questionModule}'`)
const { readProjectBoardQuestionConfig } = await import(compile(boardSource))
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

test('board Leads enable advertised native questions across capability pages', async () => {
  const calls = []
  const config = await readProjectBoardQuestionConfig(async (method, params) => {
    calls.push({ method, params })
    if (method === 'configRequirements/read') return { requirements: null }
    return params.cursor ? { data: [feature], nextCursor: null } : { data: [{ name: 'another_feature' }], nextCursor: 'next' }
  })
  assert.deepEqual(config, { 'features.default_mode_request_user_input': true })
  assert.deepEqual(calls.at(-1), { method: 'experimentalFeature/list', params: { limit: 200, cursor: 'next' } })
})

test('board question configuration preserves managed settings and unsupported runtime fallback', async () => {
  for (const value of [true, false]) {
    assert.equal(await readProjectBoardQuestionConfig(async (method) => method === 'configRequirements/read'
      ? { requirements: { featureRequirements: { default_mode_request_user_input: value } } }
      : { data: [feature] }), undefined)
  }
  assert.equal(await readProjectBoardQuestionConfig(async () => { throw new Error('Unsupported method') }), undefined)
  assert.equal(await readProjectBoardQuestionConfig(async (method) => method === 'configRequirements/read' ? {} : { data: [feature] }), undefined)
  let pages = 0
  assert.equal(await readProjectBoardQuestionConfig(async (method) => {
    if (method === 'configRequirements/read') return { requirements: null }
    pages += 1
    return { data: [], nextCursor: 'same' }
  }), undefined)
  assert.equal(pages, 2, 'A malformed cursor must not prevent a board run from starting')
})
