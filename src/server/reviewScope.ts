import type { ReviewChangesData } from '../types/codex'

export type ReviewClientScope = {
  additions: number
  batchFingerprints: Array<{ id: string; cwd: string; fingerprint: string }>
  changeCount: number
  deletions: number
  fileCount: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readReviewCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function readReviewClientScope(value: unknown): ReviewClientScope | null {
  const record = asRecord(value)
  const additions = readReviewCount(record?.additions)
  const changeCount = readReviewCount(record?.changeCount)
  const deletions = readReviewCount(record?.deletions)
  const fileCount = readReviewCount(record?.fileCount)
  if (
    additions === null
    || changeCount === null
    || deletions === null
    || fileCount === null
    || !Array.isArray(record?.batchFingerprints)
  ) return null

  const batchFingerprints: ReviewClientScope['batchFingerprints'] = []
  for (const value of record.batchFingerprints) {
    const batch = asRecord(value)
    if (
      typeof batch?.id !== 'string'
      || !batch.id
      || typeof batch.cwd !== 'string'
      || !batch.cwd
      || typeof batch.fingerprint !== 'string'
      || !batch.fingerprint
    ) return null
    batchFingerprints.push({ id: batch.id, cwd: batch.cwd, fingerprint: batch.fingerprint })
  }
  return { additions, batchFingerprints, changeCount, deletions, fileCount }
}

export function reviewScopeMatches(scope: ReviewClientScope, review: ReviewChangesData): boolean {
  if (
    scope.additions !== review.additions
    || scope.changeCount !== review.changeCount
    || scope.deletions !== review.deletions
    || scope.fileCount !== review.fileCount
    || scope.batchFingerprints.length !== review.patchBatches.length
  ) return false
  return scope.batchFingerprints.every((batch, index) => (
    batch.id === review.patchBatches[index]?.id
    && batch.cwd === review.patchBatches[index]?.cwd
    && batch.fingerprint === review.patchBatches[index]?.fingerprint
  ))
}
