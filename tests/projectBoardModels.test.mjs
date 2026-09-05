import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const compile = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`
const runtime = compile(await readFile(new URL('../src/server/runtimeConfig.ts', import.meta.url), 'utf8'))
const moduleSource = (await readFile(new URL('../src/server/projectBoardModels.ts', import.meta.url), 'utf8')).replace("from './runtimeConfig'", `from '${runtime}'`)
const { readProjectBoardModels, resolveProjectBoardExecutionSettings } = await import(compile(moduleSource))

test('feature model selection uses advertised capabilities and configured defaults', async () => {
  const catalog = await readProjectBoardModels(async (method) => method === 'config/read'
    ? { config: { model: 'review-model', model_reasoning_effort: 'medium' } }
    : { data: [
      { id: 'provider-row', model: 'review-model', displayName: 'Review model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
      { id: 'build-model', model: 'build-model', defaultReasoningEffort: 'high', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ] })
  assert.equal(catalog.defaultModel, 'review-model')
  assert.deepEqual(resolveProjectBoardExecutionSettings(catalog, { model: '', reasoningEffort: 'medium' }), { model: 'review-model', reasoningEffort: 'medium' })
  assert.deepEqual(resolveProjectBoardExecutionSettings(catalog, { model: 'build-model', reasoningEffort: 'high' }), { model: 'build-model', reasoningEffort: 'high' })
  assert.throws(() => resolveProjectBoardExecutionSettings(catalog, { model: 'missing', reasoningEffort: 'high' }), /unavailable/)
  assert.throws(() => resolveProjectBoardExecutionSettings(catalog, { model: 'review-model', reasoningEffort: 'high' }), /does not support/)
})

test('missing model metadata fails explicitly instead of claiming a setting was applied', async () => {
  await assert.rejects(readProjectBoardModels(async () => ({})), /Could not load/)
  assert.throws(() => resolveProjectBoardExecutionSettings({ models: [], defaultModel: '', defaultReasoningEffort: 'medium' }, { model: '', reasoningEffort: 'medium' }), /unavailable/)
})
