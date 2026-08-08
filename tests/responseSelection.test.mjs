import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const sourceUrl = new URL('../src/utils/responseSelection.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
const {
  TOUCH_SELECTION_SETTLE_MS,
  normalizeResponseSelectionPointerType,
  responseAnnotationPositionUpdateStrategy,
  responseSelectionPointerDownAction,
  responseSelectionSettleDelay,
  shouldCaptureResponseSelectionAfterPointerUp,
  shouldUseDockedResponseSelectionActions,
} = await import(moduleUrl)

test('uses docked selection actions for touch, pen, and coarse-pointer devices', () => {
  assert.equal(shouldUseDockedResponseSelectionActions(false, 'mouse'), false)
  assert.equal(shouldUseDockedResponseSelectionActions(false, ''), false)
  assert.equal(shouldUseDockedResponseSelectionActions(false, 'touch'), true)
  assert.equal(shouldUseDockedResponseSelectionActions(false, 'pen'), true)
  assert.equal(shouldUseDockedResponseSelectionActions(true, 'mouse'), true)
})

test('does not reopen selection actions after a plain tap on an unchanged range', () => {
  assert.equal(shouldCaptureResponseSelectionAfterPointerUp(false), false)
  assert.equal(shouldCaptureResponseSelectionAfterPointerUp(true), true)
})

test('preserves the native range when a selection handle targets response text', () => {
  assert.equal(responseSelectionPointerDownAction({
    isInteractiveTarget: false,
    hasAnnotationEditor: false,
    isResponseSurface: true,
    hasCapturedSelection: true,
  }), 'track-selection')
  assert.equal(responseSelectionPointerDownAction({
    isInteractiveTarget: false,
    hasAnnotationEditor: false,
    isResponseSurface: false,
    hasCapturedSelection: true,
  }), 'dismiss-selection')
  assert.equal(responseSelectionPointerDownAction({
    isInteractiveTarget: false,
    hasAnnotationEditor: true,
    isResponseSurface: true,
    hasCapturedSelection: true,
  }), 'close-editor')
  assert.equal(responseSelectionPointerDownAction({
    isInteractiveTarget: true,
    hasAnnotationEditor: true,
    isResponseSurface: true,
    hasCapturedSelection: true,
  }), 'ignore')
})

test('allows touch selection to settle without delaying desktop selection', () => {
  assert.equal(responseSelectionSettleDelay(false), 0)
  assert.equal(responseSelectionSettleDelay(true), TOUCH_SELECTION_SETTLE_MS)
  assert.ok(TOUCH_SELECTION_SETTLE_MS >= 100)
})

test('normalizes browser pointer types conservatively', () => {
  assert.equal(normalizeResponseSelectionPointerType('mouse'), 'mouse')
  assert.equal(normalizeResponseSelectionPointerType('touch'), 'touch')
  assert.equal(normalizeResponseSelectionPointerType('pen'), 'pen')
  assert.equal(normalizeResponseSelectionPointerType(''), '')
  assert.equal(normalizeResponseSelectionPointerType('unknown'), '')
})

test('continuously tracks the mobile annotation editor anchor during viewport changes', () => {
  assert.equal(responseAnnotationPositionUpdateStrategy(true), 'always')
  assert.equal(responseAnnotationPositionUpdateStrategy(false), 'optimized')
})
