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

const sourceUrl = new URL('../src/server/reviewScope.ts', import.meta.url)
const { readReviewClientScope, reviewScopeMatches } = await loadTypeScriptModule(sourceUrl)

const review = {
  additions: 3,
  changeCount: 2,
  deletions: 1,
  fileCount: 2,
  files: [],
  filesTruncated: false,
  patchBatches: [
    { id: 'batch-1', cwd: '/repo/packages/app', fingerprint: 'fingerprint-1', byteLength: 100 },
    { id: 'batch-2', cwd: '/repo', fingerprint: 'fingerprint-2', byteLength: 200 },
  ],
}

function matchingScope() {
  return {
    additions: 3,
    batchFingerprints: [
      { id: 'batch-1', cwd: '/repo/packages/app', fingerprint: 'fingerprint-1' },
      { id: 'batch-2', cwd: '/repo', fingerprint: 'fingerprint-2' },
    ],
    changeCount: 2,
    deletions: 1,
    fileCount: 2,
  }
}

test('accepts and matches the exact reviewed counts, order, cwd, and fingerprints', () => {
  const parsed = readReviewClientScope(matchingScope())
  assert.deepEqual(parsed, matchingScope())
  assert.equal(reviewScopeMatches(parsed, review), true)
})

test('rejects malformed client scopes', () => {
  assert.equal(readReviewClientScope(null), null)
  assert.equal(readReviewClientScope({ ...matchingScope(), additions: -1 }), null)
  assert.equal(readReviewClientScope({
    ...matchingScope(),
    batchFingerprints: [{ id: 'batch-1', fingerprint: 'fingerprint-1' }],
  }), null)
})

test('rejects stale or retargeted review scopes', () => {
  const changedCwd = matchingScope()
  changedCwd.batchFingerprints[0].cwd = '/repo/packages/other'
  assert.equal(reviewScopeMatches(changedCwd, review), false)

  const changedFingerprint = matchingScope()
  changedFingerprint.batchFingerprints[1].fingerprint = 'different'
  assert.equal(reviewScopeMatches(changedFingerprint, review), false)

  const changedCounts = matchingScope()
  changedCounts.fileCount = 3
  assert.equal(reviewScopeMatches(changedCounts, review), false)

  const missingBatch = matchingScope()
  missingBatch.batchFingerprints.pop()
  assert.equal(reviewScopeMatches(missingBatch, review), false)
})
