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

const sourceUrl = new URL('../src/utils/reviewDiff.ts', import.meta.url)
const {
  ReviewDiffDataError,
  buildReviewChanges,
  buildReviewPatch,
} = await loadTypeScriptModule(sourceUrl)

test('reconstructs authoritative update, add, and delete patches', () => {
  const update = buildReviewPatch({
    path: 'notes/existing.txt',
    kind: 'update',
    diff: '@@ -1,3 +1,3 @@\n first\n-old value\n+new value\n last',
  })
  const added = buildReviewPatch({
    path: 'notes/new.txt',
    kind: 'add',
    diff: 'first line\nsecond line\n',
  })
  const deleted = buildReviewPatch({
    path: 'notes/old.txt',
    kind: 'delete',
    diff: 'obsolete\ncontent\n',
  })

  assert.equal(update, [
    'diff --git a/notes/existing.txt b/notes/existing.txt',
    '--- a/notes/existing.txt',
    '+++ b/notes/existing.txt',
    '@@ -1,3 +1,3 @@',
    ' first',
    '-old value',
    '+new value',
    ' last',
  ].join('\n'))
  assert.equal(added, [
    'diff --git a/notes/new.txt b/notes/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/notes/new.txt',
    '@@ -0,0 +1,2 @@',
    '+first line',
    '+second line',
  ].join('\n'))
  assert.equal(deleted, [
    'diff --git a/notes/old.txt b/notes/old.txt',
    'deleted file mode 100644',
    '--- a/notes/old.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-obsolete',
    '-content',
  ].join('\n'))
})

test('computes file and turn stats with accurate old and new line numbers', () => {
  const review = buildReviewChanges([{
    type: 'fileChange',
    id: 'change-batch',
    status: 'completed',
    changes: [
      {
        path: 'notes/existing.txt',
        kind: { type: 'update', move_path: null },
        diff: '@@ -10,3 +10,3 @@\n context\n-before\n+<img src=x onerror="alert(1)">\n after',
      },
      {
        path: 'notes/new.html',
        kind: { type: 'add' },
        diff: '<strong>literal text</strong>\nsecond line\n',
      },
      {
        path: 'notes/old.txt',
        kind: { type: 'delete' },
        diff: 'obsolete\n',
      },
    ],
  }])

  assert.ok(review)
  assert.equal(review.files.length, 3)
  assert.equal(review.additions, 3)
  assert.equal(review.deletions, 2)

  const updated = review.files.find((file) => file.path === 'notes/existing.txt')
  assert.ok(updated)
  assert.equal(updated.additions, 1)
  assert.equal(updated.deletions, 1)
  assert.deepEqual(
    updated.lines
      .filter((line) => line.kind === 'context' || line.kind === 'removed' || line.kind === 'added')
      .map(({ kind, text, oldLine, newLine }) => ({ kind, text, oldLine, newLine })),
    [
      { kind: 'context', text: 'context', oldLine: 10, newLine: 10 },
      { kind: 'removed', text: 'before', oldLine: 11, newLine: null },
      {
        kind: 'added',
        text: '<img src=x onerror="alert(1)">',
        oldLine: null,
        newLine: 11,
      },
      { kind: 'context', text: 'after', oldLine: 12, newLine: 12 },
    ],
  )

  const added = review.files.find((file) => file.path === 'notes/new.html')
  assert.ok(added)
  assert.deepEqual(
    added.lines
      .filter((line) => line.kind === 'added')
      .map(({ text, oldLine, newLine }) => ({ text, oldLine, newLine })),
    [
      { text: '<strong>literal text</strong>', oldLine: null, newLine: 1 },
      { text: 'second line', oldLine: null, newLine: 2 },
    ],
  )

  const deleted = review.files.find((file) => file.path === 'notes/old.txt')
  assert.ok(deleted)
  assert.deepEqual(
    deleted.lines
      .filter((line) => line.kind === 'removed')
      .map(({ text, oldLine, newLine }) => ({ text, oldLine, newLine })),
    [{ text: 'obsolete', oldLine: 1, newLine: null }],
  )
})

test('lightweight browser reconstruction matches full patch previews without retaining patches', () => {
  const items = [{
    type: 'fileChange',
    id: 'lightweight',
    status: 'completed',
    changes: [
      {
        path: 'updated.txt',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-old\n+new',
      },
      {
        path: 'added.txt',
        kind: { type: 'add' },
        diff: 'first\r\nsecond',
      },
      {
        path: 'deleted.txt',
        kind: { type: 'delete' },
        diff: 'gone\n',
      },
    ],
  }]
  const full = buildReviewChanges(items, '/repo', '/repo')
  const lightweight = buildReviewChanges(items, '/repo', '/repo', { includePatchText: false })

  assert.ok(full)
  assert.ok(lightweight)
  assert.equal(lightweight.patchBatches[0].patch, undefined)
  assert.deepEqual(
    lightweight.files.map(({ path, additions, deletions, lines }) => ({
      path,
      additions,
      deletions,
      lines: lines.map(({ kind, text, oldLine, newLine }) => ({ kind, text, oldLine, newLine })),
    })),
    full.files.map(({ path, additions, deletions, lines }) => ({
      path,
      additions,
      deletions,
      lines: lines.map(({ kind, text, oldLine, newLine }) => ({ kind, text, oldLine, newLine })),
    })),
  )
})

test('keeps lightweight and authoritative stats aligned for lone carriage returns', () => {
  const items = [{
    type: 'fileChange',
    id: 'carriage-returns',
    status: 'completed',
    changes: [{
      path: 'classic-mac.txt',
      kind: { type: 'add' },
      diff: 'first\rsecond\r',
    }],
  }]
  const full = buildReviewChanges(items, '/repo', '/repo')
  const lightweight = buildReviewChanges(items, '/repo', '/repo', { includePatchText: false })

  assert.ok(full)
  assert.ok(lightweight)
  assert.equal(full.additions, 1)
  assert.equal(lightweight.additions, full.additions)
  assert.deepEqual(
    lightweight.files[0].lines.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine })),
    full.files[0].lines.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine })),
  )
})

test('disables deletion Undo when the original worktree mode was not recorded', () => {
  const items = [{
    type: 'fileChange',
    id: 'deleted-mode',
    status: 'completed',
    changes: [{ path: 'run.sh', kind: { type: 'delete' }, diff: '#!/bin/sh\n' }],
  }]
  const displayed = buildReviewChanges(items, '/repo', '/repo', { includePatchText: false })
  assert.ok(displayed)
  assert.match(displayed.actionUnavailableReason, /worktree permissions/iu)
  assert.throws(
    () => buildReviewChanges(items, '/repo', '/repo', { strict: true }),
    (error) => error instanceof ReviewDiffDataError && /worktree permissions/iu.test(error.message),
  )
})

test('groups repeated updates while preserving authoritative batch order', () => {
  const review = buildReviewChanges([
    {
      type: 'fileChange',
      id: 'first-update',
      status: 'completed',
      changes: [{
        path: 'story.txt',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-alpha\n+bravo',
      }],
    },
    {
      type: 'fileChange',
      id: 'ignored-failure',
      status: 'failed',
      changes: [{
        path: 'should-not-appear.txt',
        kind: { type: 'add' },
        diff: 'not applied',
      }],
    },
    {
      type: 'fileChange',
      id: 'second-update',
      status: 'completed',
      changes: [{
        path: './story.txt',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-bravo\n+charlie',
      }],
    },
  ])

  assert.ok(review)
  assert.equal(review.files.length, 1)
  assert.equal(review.files[0].path, 'story.txt')
  assert.equal(review.files[0].additions, 2)
  assert.equal(review.files[0].deletions, 2)
  assert.equal(review.patchBatches.length, 2)
  assert.deepEqual(review.patchBatches.map((batch) => batch.id), ['first-update', 'second-update'])
  assert.ok(review.patchBatches[0].patch.indexOf('-alpha') >= 0)
  assert.ok(review.patchBatches[1].patch.indexOf('-bravo') >= 0)
  assert.ok(review.files[0].lines.every((line, index, lines) => (
    lines.findIndex((candidate) => candidate.id === line.id) === index
  )))
})

test('returns no review for failed, declined, or malformed file changes', () => {
  assert.equal(buildReviewChanges([
    { type: 'fileChange', status: 'failed', changes: [] },
    { type: 'fileChange', status: 'declined', changes: [{ path: 'a.txt', kind: { type: 'add' }, diff: 'a' }] },
    { type: 'fileChange', status: 'completed', changes: [{ path: '', kind: { type: 'add' }, diff: 'a' }] },
  ]), null)
})

test('normalizes in-workspace absolute paths and rejects paths outside the workspace', () => {
  const review = buildReviewChanges([{
    type: 'fileChange',
    id: 'absolute-paths',
    status: 'completed',
    changes: [
      {
        path: '/workspace/project/src/inside.txt',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-old\n+new',
      },
      {
        path: '/workspace/other/outside.txt',
        kind: { type: 'add' },
        diff: 'outside',
      },
      {
        path: '../escape.txt',
        kind: { type: 'add' },
        diff: 'escape',
      },
    ],
  }], '/workspace/project')

  assert.ok(review)
  assert.deepEqual(review.files.map((file) => file.path), ['src/inside.txt'])
  assert.match(review.patchBatches[0].patch, /diff --git a\/src\/inside\.txt b\/src\/inside\.txt/u)
  assert.doesNotMatch(review.patchBatches[0].patch, /outside|escape/u)
})

test('preserves CRLF bytes and missing final-newline markers for whole-file changes', () => {
  const crlfAdded = buildReviewPatch({
    path: 'windows.txt',
    kind: 'add',
    diff: 'first\r\nsecond\r\n',
  })
  const noNewlineDeleted = buildReviewPatch({
    path: 'legacy.txt',
    kind: 'delete',
    diff: 'first\r\nsecond',
  })

  assert.match(crlfAdded, /\+first\r\n\+second\r$/u)
  assert.doesNotMatch(crlfAdded, /No newline at end of file/u)
  assert.match(noNewlineDeleted, /-first\r\n-second\n\\ No newline at end of file$/u)

  const review = buildReviewChanges([{
    type: 'fileChange',
    id: 'crlf-add',
    status: 'completed',
    changes: [{ path: 'windows.txt', kind: { type: 'add' }, diff: 'first\r\nsecond\r\n' }],
  }])
  assert.ok(review)
  assert.match(review.patchBatches[0].patch, /\+first\r\n\+second\r\n$/u)
})

test('keeps header-looking removed content inside its hunk', () => {
  const patch = buildReviewPatch({
    path: 'markers.txt',
    kind: 'update',
    diff: '@@ -1 +1 @@\n--- old marker\n+-- new marker',
  })

  assert.match(patch, /^diff --git a\/markers\.txt b\/markers\.txt\n--- a\/markers\.txt\n\+\+\+ b\/markers\.txt\n@@/u)
  assert.match(patch, /\n--- old marker\n\+-- new marker$/u)
})

test('emits valid metadata for pure renames', () => {
  const patch = buildReviewPatch({
    path: 'old/name.txt',
    movePath: 'new/name.txt',
    kind: 'update',
    diff: '',
  })

  assert.equal(patch, [
    'diff --git a/old/name.txt b/new/name.txt',
    'similarity index 100%',
    'rename from old/name.txt',
    'rename to new/name.txt',
  ].join('\n'))
})

test('keeps cross-directory renames reviewable without unsafe Undo', () => {
  const items = [{
    type: 'fileChange',
    id: 'cross-directory-rename',
    status: 'completed',
    changes: [{
      path: 'private/old.txt',
      kind: { type: 'update', move_path: 'public/new.txt' },
      diff: '',
    }],
  }]
  const displayed = buildReviewChanges(items, '/repo', '/repo', { includePatchText: false })
  assert.ok(displayed)
  assert.equal(displayed.files[0].previousPath, 'private/old.txt')
  assert.match(displayed.actionUnavailableReason, /directory permissions/iu)
  assert.throws(
    () => buildReviewChanges(items, '/repo', '/repo', { strict: true }),
    (error) => error instanceof ReviewDiffDataError && /directory permissions/iu.test(error.message),
  )
})

test('tracks and canonicalizes each file-change batch from its preceding command cwd', () => {
  const review = buildReviewChanges([
    { type: 'commandExecution', cwd: '/repo/packages/alpha' },
    {
      type: 'fileChange',
      id: 'alpha-change',
      status: 'completed',
      changes: [{ path: 'src/index.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+alpha' }],
    },
    { type: 'commandExecution', cwd: '/repo/packages/beta' },
    {
      type: 'fileChange',
      id: 'beta-change',
      status: 'completed',
      changes: [{ path: './src/index.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+beta' }],
    },
  ], '/repo', '/repo', { strict: true })

  assert.ok(review)
  assert.deepEqual(review.files.map((file) => file.path), [
    'packages/alpha/src/index.ts',
    'packages/beta/src/index.ts',
  ])
  assert.deepEqual(review.patchBatches.map(({ id, cwd }) => ({ id, cwd })), [
    { id: 'alpha-change', cwd: '/repo/packages/alpha' },
    { id: 'beta-change', cwd: '/repo/packages/beta' },
  ])
})

test('strict reconstruction fails the entire action on malformed data or an unsafe cwd', () => {
  assert.throws(() => buildReviewChanges([{
    type: 'fileChange',
    id: 'mixed-change',
    status: 'completed',
    changes: [
      { path: 'valid.txt', kind: { type: 'add' }, diff: 'valid\n' },
      { path: '../outside.txt', kind: { type: 'add' }, diff: 'outside\n' },
    ],
  }], '/repo', '/repo', { strict: true }), ReviewDiffDataError)

  assert.throws(() => buildReviewChanges([
    { type: 'commandExecution', cwd: '/outside' },
    {
      type: 'fileChange',
      id: 'outside-cwd',
      status: 'completed',
      changes: [{ path: '/repo/inside.txt', kind: { type: 'add' }, diff: 'inside\n' }],
    },
  ], '/repo', '/repo', { strict: true }), ReviewDiffDataError)

  assert.equal(buildReviewChanges([{
    id: 'missing-type',
    status: 'completed',
    changes: [{ path: 'ignored.txt', kind: { type: 'add' }, diff: 'ignored\n' }],
  }], '/repo', '/repo', { strict: true }), null)
})

test('strict reconstruction rejects mismatched headers and non-hunk update data', () => {
  const mismatched = {
    type: 'fileChange',
    id: 'mismatched-header',
    status: 'completed',
    changes: [{
      path: 'safe.txt',
      kind: { type: 'update', move_path: null },
      diff: [
        'diff --git a/other.txt b/other.txt',
        '--- a/other.txt',
        '+++ b/other.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    }],
  }
  const metadataOnly = {
    type: 'fileChange',
    id: 'metadata-only',
    status: 'completed',
    changes: [{
      path: 'safe.txt',
      kind: { type: 'update', move_path: null },
      diff: 'old mode 100644\nnew mode 100755',
    }],
  }

  assert.throws(
    () => buildReviewChanges([mismatched], '/repo', '/repo', { strict: true }),
    ReviewDiffDataError,
  )
  assert.throws(
    () => buildReviewChanges([metadataOnly], '/repo', '/repo', { strict: true }),
    ReviewDiffDataError,
  )
})

test('keeps parent-directory changes visible while matching authoritative batch fingerprints', () => {
  const items = [
    {
      type: 'fileChange',
      id: 'inside-change',
      status: 'completed',
      changes: [{ path: 'inside.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+inside' }],
    },
    { type: 'commandExecution', cwd: '/repo' },
    {
      type: 'fileChange',
      id: 'root-change',
      status: 'completed',
      changes: [{ path: 'root.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+root' }],
    },
  ]
  const displayed = buildReviewChanges(items, '/repo/packages/app', '/repo/packages/app', {
    includeOutsideRoot: true,
    includePatchText: false,
  })
  const authoritative = buildReviewChanges(items, '/repo/packages/app', '/repo', { strict: true })

  assert.ok(displayed)
  assert.ok(authoritative)
  assert.deepEqual(displayed.files.map((file) => file.path), ['inside.txt', '../../root.txt'])
  assert.deepEqual(authoritative.files.map((file) => file.path), [
    'packages/app/inside.txt',
    'root.txt',
  ])
  assert.equal(displayed.changeCount, 2)
  assert.equal(displayed.fileCount, authoritative.fileCount)
  assert.deepEqual(
    displayed.patchBatches.map(({ id, cwd, fingerprint, patch }) => ({
      id,
      cwd,
      fingerprint,
      patch,
    })),
    authoritative.patchBatches.map(({ id, cwd, fingerprint }) => ({
      id,
      cwd,
      fingerprint,
      patch: undefined,
    })),
  )
})

test('marks deterministically oversized patch histories unavailable for Undo', () => {
  const oversized = buildReviewChanges([{
    type: 'fileChange',
    id: 'oversized',
    status: 'completed',
    changes: [{
      path: 'large.txt',
      kind: { type: 'update', move_path: null },
      diff: `@@ -1 +1 @@\n-${'x'.repeat(2 * 1024 * 1024)}\n+y`,
    }],
  }], '/repo', '/repo')
  assert.ok(oversized)
  assert.match(oversized.actionUnavailableReason, /2 MB safety limit/iu)
  assert.ok(oversized.patchBatches[0].byteLength > 2 * 1024 * 1024)
  assert.ok(oversized.files[0].lines[0].text.length <= 8000)
  assert.equal(oversized.files[0].isTruncated, true)

  const tooManyBatches = buildReviewChanges(Array.from({ length: 129 }, (_, index) => ({
    type: 'fileChange',
    id: `batch-${index.toString()}`,
    status: 'completed',
    changes: [{
      path: `file-${index.toString()}.txt`,
      kind: { type: 'add' },
      diff: 'safe\n',
    }],
  })), '/repo', '/repo')
  assert.ok(tooManyBatches)
  assert.match(tooManyBatches.actionUnavailableReason, /more than 128 change batches/iu)
  assert.throws(
    () => buildReviewChanges(Array.from({ length: 129 }, (_, index) => ({
      type: 'fileChange',
      id: `strict-batch-${index.toString()}`,
      status: 'completed',
      changes: [{
        path: `strict-file-${index.toString()}.txt`,
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-old\n+safe',
      }],
    })), '/repo', '/repo', { strict: true }),
    (error) => error instanceof ReviewDiffDataError && /too many change batches/iu.test(error.message),
  )

  assert.throws(
    () => buildReviewChanges([{
      type: 'fileChange',
      id: 'strict-oversized',
      status: 'completed',
      changes: [{
        path: 'large.txt',
        kind: { type: 'update', move_path: null },
        diff: `@@ -1 +1 @@\n-${'x'.repeat(2 * 1024 * 1024)}\n+y`,
      }],
    }], '/repo', '/repo', { strict: true }),
    (error) => error instanceof ReviewDiffDataError && /too large/iu.test(error.message),
  )

  assert.throws(
    () => buildReviewChanges([{
      type: 'fileChange',
      id: 'strict-too-many-changes',
      status: 'completed',
      changes: Array.from({ length: 2049 }, (_, index) => ({
        path: `many/file-${index.toString()}.txt`,
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-old\n+new',
      })),
    }], '/repo', '/repo', { strict: true }),
    (error) => error instanceof ReviewDiffDataError && /too many file changes/iu.test(error.message),
  )
})

test('caps rendered files and lines while keeping complete aggregate statistics and patches', () => {
  const changes = Array.from({ length: 205 }, (_, fileIndex) => ({
    path: `generated/file-${fileIndex.toString()}.txt`,
    kind: { type: 'update', move_path: null },
    diff: `@@ -1,0 +1,30 @@\n${Array.from({ length: 30 }, (_, lineIndex) => (
      `+file ${fileIndex.toString()} line ${lineIndex.toString()}`
    )).join('\n')}`,
  }))
  const review = buildReviewChanges([{
    type: 'fileChange',
    id: 'large-change',
    status: 'completed',
    changes,
  }], '/repo', '/repo', { strict: true })

  assert.ok(review)
  assert.equal(review.fileCount, 205)
  assert.equal(review.files.length, 200)
  assert.equal(review.filesTruncated, true)
  assert.equal(review.additions, 205 * 30)
  assert.equal(review.deletions, 0)
  assert.ok(review.files.reduce((sum, file) => sum + file.lines.length, 0) <= 4000)
  assert.ok(review.files.some((file) => file.isTruncated))
  assert.match(review.patchBatches[0].patch, /generated\/file-204\.txt/u)
})
