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

const sourceUrl = new URL('../src/server/reviewMutationGate.ts', import.meta.url)
const {
  ReviewMutationConflictError,
  ReviewMutationGate,
} = await loadTypeScriptModule(sourceUrl)

test('a Review reservation blocks interactive and automation turn starts', () => {
  const gate = new ReviewMutationGate()
  const releaseReview = gate.reserveReview()

  assert.throws(() => gate.reserveTurnStart(), ReviewMutationConflictError)
  releaseReview()
  releaseReview()

  const releaseTurnStart = gate.reserveTurnStart()
  releaseTurnStart()
})

test('Review and branch mutations are globally exclusive', () => {
  const gate = new ReviewMutationGate()
  const releaseFirst = gate.reserveReview()
  assert.throws(() => gate.reserveReview(), ReviewMutationConflictError)
  releaseFirst()

  const releaseSecond = gate.reserveReview()
  releaseSecond()
})

test('an in-flight or active turn blocks Review until completion', () => {
  const gate = new ReviewMutationGate()
  const releaseTurnStart = gate.reserveTurnStart()

  assert.throws(() => gate.reserveReview(), ReviewMutationConflictError)
  gate.markTurnStarted('turn-1')
  releaseTurnStart()
  assert.throws(() => gate.reserveReview(), ReviewMutationConflictError)

  gate.markTurnCompleted('turn-1')
  const releaseReview = gate.reserveReview()
  releaseReview()
})

test('a completion observed before a delayed start response cannot leave a stale active turn', () => {
  const gate = new ReviewMutationGate()
  const releaseTurnStart = gate.reserveTurnStart()
  gate.markTurnStarted('turn-2')
  gate.markTurnCompleted('turn-2')
  gate.markTurnStarted('turn-2')
  releaseTurnStart()

  const releaseReview = gate.reserveReview()
  releaseReview()
})

test('reset clears turns after an app-server exit', () => {
  const gate = new ReviewMutationGate()
  const releaseTurnStart = gate.reserveTurnStart()
  gate.markTurnStarted('turn-3')
  releaseTurnStart()
  gate.resetTurns()

  const releaseReview = gate.reserveReview()
  releaseReview()
})
