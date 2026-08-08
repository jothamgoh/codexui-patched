import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

const sourceUrl = new URL('../src/server/reviewPatch.ts', import.meta.url)
const {
  ReviewPatchRequestError,
  applyReviewPatchSequence,
  canonicalizeReviewCommandWorkingDirectories,
  resolveReviewGitWorkspace,
} = await loadTypeScriptModule(sourceUrl)
const reviewDiffSourceUrl = new URL('../src/utils/reviewDiff.ts', import.meta.url)
const { buildReviewPatch } = await loadTypeScriptModule(reviewDiffSourceUrl)

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`))
      }
    })
    child.stdin.end(options.input ?? '')
  })
}

async function makeGitFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codexui-review-patch-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await run('git', ['init', '--quiet'], { cwd: directory })
  await run('git', ['config', 'user.name', 'CodexUI Test'], { cwd: directory })
  await run('git', ['config', 'user.email', 'codexui-test@example.invalid'], { cwd: directory })
  return directory
}

async function commitFixture(directory, files) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  await run('git', ['add', '--all'], { cwd: directory })
  await run('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: directory })
}

async function applyPatch(directory, patch) {
  await run('git', ['apply', '--whitespace=nowarn', '-'], {
    cwd: directory,
    input: patch,
  })
}

async function setTestXattr(path, valueHex) {
  if (process.platform !== 'darwin') return
  await run('/usr/bin/xattr', ['-wx', 'com.codexui.audit', valueHex, path])
}

async function readTestXattr(path) {
  if (process.platform !== 'darwin') return ''
  const result = await run('/usr/bin/xattr', ['-px', 'com.codexui.audit', path])
  return result.stdout.replace(/\s/gu, '').toLowerCase()
}

const firstStoryPatch = [
  'diff --git a/story.txt b/story.txt',
  '--- a/story.txt',
  '+++ b/story.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '',
].join('\n')

const secondStoryPatch = [
  'diff --git a/story.txt b/story.txt',
  '--- a/story.txt',
  '+++ b/story.txt',
  '@@ -1,3 +1,4 @@',
  ' one',
  ' TWO',
  '+between',
  ' three',
  '',
].join('\n')

test('preflights and applies authoritative undo and reapply batches in sequence', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'story.txt': 'one\ntwo\nthree\n' })
  const patches = [firstStoryPatch, secondStoryPatch]
  for (const patch of patches) await applyPatch(directory, patch)

  assert.equal(await readFile(join(directory, 'story.txt'), 'utf8'), 'one\nTWO\nbetween\nthree\n')

  const undone = await applyReviewPatchSequence({ cwd: directory, patches, reverse: true })
  assert.deepEqual(undone, { status: 'success', action: 'undo' })
  assert.equal(await readFile(join(directory, 'story.txt'), 'utf8'), 'one\ntwo\nthree\n')

  const alreadyUndone = await applyReviewPatchSequence({ cwd: directory, patches, reverse: true })
  assert.equal(alreadyUndone.status, 'failed')
  assert.equal(alreadyUndone.action, 'undo')
  assert.equal(alreadyUndone.state, 'undone')

  const reapplied = await applyReviewPatchSequence({ cwd: directory, patches, reverse: false })
  assert.deepEqual(reapplied, { status: 'success', action: 'reapply' })
  assert.equal(await readFile(join(directory, 'story.txt'), 'utf8'), 'one\nTWO\nbetween\nthree\n')

  const alreadyApplied = await applyReviewPatchSequence({ cwd: directory, patches, reverse: false })
  assert.equal(alreadyApplied.status, 'failed')
  assert.equal(alreadyApplied.action, 'reapply')
  assert.equal(alreadyApplied.state, 'applied')
})

test('preserves exact worktree modes across successful updates and renames', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, {
    'secure.txt': 'old secure\n',
    'a/old.txt': 'same contents\n',
  })
  const securePath = join(directory, 'secure.txt')
  const oldPath = join(directory, 'a/old.txt')
  const newPath = join(directory, 'a/new.txt')
  await chmod(securePath, 0o600)
  await chmod(oldPath, 0o4750)
  await setTestXattr(securePath, '00ff1041')
  await setTestXattr(oldPath, 'c0ffee')
  const renameAtime = new Date('2000-01-02T03:04:05.000Z')
  const renameMtime = new Date('2001-02-03T04:05:06.000Z')
  await utimes(oldPath, renameAtime, renameMtime)
  const initialSecureDetails = await lstat(securePath)
  const alternateGroup = process.getgroups?.().find((gid) => gid !== initialSecureDetails.gid)
  if (alternateGroup !== undefined) {
    await chown(securePath, initialSecureDetails.uid, alternateGroup)
  }
  const expectedSecureGid = (await lstat(securePath)).gid
  const updatePatch = [
    'diff --git a/secure.txt b/secure.txt',
    '--- a/secure.txt',
    '+++ b/secure.txt',
    '@@ -1 +1 @@',
    '-old secure',
    '+new secure',
    '',
  ].join('\n')
  const renamePatch = [
    'diff --git a/a/old.txt b/a/new.txt',
    'similarity index 100%',
    'rename from a/old.txt',
    'rename to a/new.txt',
    '',
  ].join('\n')

  const applied = await applyReviewPatchSequence({
    cwd: directory,
    patches: [updatePatch, renamePatch],
    reverse: false,
  })
  assert.deepEqual(applied, { status: 'success', action: 'reapply' })
  assert.equal((await lstat(securePath)).mode & 0o7777, 0o600)
  assert.equal((await lstat(securePath)).gid, expectedSecureGid)
  assert.equal((await lstat(newPath)).mode & 0o7777, 0o4750)
  assert.equal((await lstat(newPath)).atimeMs, renameAtime.getTime())
  assert.equal((await lstat(newPath)).mtimeMs, renameMtime.getTime())
  assert.equal(await readTestXattr(securePath), process.platform === 'darwin' ? '00ff1041' : '')
  assert.equal(await readTestXattr(newPath), process.platform === 'darwin' ? 'c0ffee' : '')

  const undone = await applyReviewPatchSequence({
    cwd: directory,
    patches: [updatePatch, renamePatch],
    reverse: true,
  })
  assert.deepEqual(undone, { status: 'success', action: 'undo' })
  assert.equal(await readFile(securePath, 'utf8'), 'old secure\n')
  assert.equal((await lstat(securePath)).mode & 0o7777, 0o600)
  assert.equal((await lstat(securePath)).gid, expectedSecureGid)
  assert.equal((await lstat(oldPath)).mode & 0o7777, 0o4750)
  assert.equal((await lstat(oldPath)).atimeMs, renameAtime.getTime())
  assert.equal((await lstat(oldPath)).mtimeMs, renameMtime.getTime())
  assert.equal(await readTestXattr(securePath), process.platform === 'darwin' ? '00ff1041' : '')
  assert.equal(await readTestXattr(oldPath), process.platform === 'darwin' ? 'c0ffee' : '')
})

test('rejects a stale patch that Git could relocate onto a repeated block', async (t) => {
  const directory = await makeGitFixture(t)
  const block = 'a\nb\nc\nold\nd\ne\nf\n'
  await commitFixture(directory, { 'repeated.txt': `${block}${block}` })
  const patch = [
    'diff --git a/repeated.txt b/repeated.txt',
    '--- a/repeated.txt',
    '+++ b/repeated.txt',
    '@@ -8,7 +8,7 @@',
    ' a',
    ' b',
    ' c',
    '-old',
    '+new',
    ' d',
    ' e',
    ' f',
    '',
  ].join('\n')
  await applyPatch(directory, patch)

  const staleReapply = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false })
  assert.equal(staleReapply.status, 'failed')
  assert.equal(staleReapply.state, 'applied')
  assert.equal(
    await readFile(join(directory, 'repeated.txt'), 'utf8'),
    `${block}a\nb\nc\nnew\nd\ne\nf\n`,
  )
})

test('applies repository-relative patches when the thread cwd is a subdirectory', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, {
    'root.txt': 'old\n',
    'nested/anchor.txt': 'anchor\n',
  })
  const patch = [
    'diff --git a/root.txt b/root.txt',
    '--- a/root.txt',
    '+++ b/root.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n')
  await applyPatch(directory, patch)

  const undone = await applyReviewPatchSequence({
    cwd: join(directory, 'nested'),
    patches: [patch],
    reverse: true,
  })
  assert.deepEqual(undone, { status: 'success', action: 'undo' })
  assert.equal(await readFile(join(directory, 'root.txt'), 'utf8'), 'old\n')

  const reapplied = await applyReviewPatchSequence({
    cwd: join(directory, 'nested'),
    patches: [patch],
    reverse: false,
  })
  assert.deepEqual(reapplied, { status: 'success', action: 'reapply' })
  assert.equal(await readFile(join(directory, 'root.txt'), 'utf8'), 'new\n')
})

test('does not partially mutate the worktree when any patch conflicts', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, {
    'first.txt': 'old first\n',
    'second.txt': 'actual second\n',
  })
  const validPatch = [
    'diff --git a/first.txt b/first.txt',
    '--- a/first.txt',
    '+++ b/first.txt',
    '@@ -1 +1 @@',
    '-old first',
    '+new first',
    '',
  ].join('\n')
  const conflictingPatch = [
    'diff --git a/second.txt b/second.txt',
    '--- a/second.txt',
    '+++ b/second.txt',
    '@@ -1 +1 @@',
    '-expected second',
    '+new second',
    '',
  ].join('\n')

  const result = await applyReviewPatchSequence({
    cwd: directory,
    patches: [validPatch, conflictingPatch],
    reverse: false,
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.action, 'reapply')
  assert.match(result.error, /patch|apply|second\.txt/iu)
  assert.equal(await readFile(join(directory, 'first.txt'), 'utf8'), 'old first\n')
  assert.equal(await readFile(join(directory, 'second.txt'), 'utf8'), 'actual second\n')
})

test('rolls back earlier batches when the worktree changes after preflight', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, {
    'first.txt': 'old first\n',
    'second.txt': 'old second\n',
  })
  const firstPatch = [
    'diff --git a/first.txt b/first.txt',
    '--- a/first.txt',
    '+++ b/first.txt',
    '@@ -1 +1 @@',
    '-old first',
    '+new first',
    '',
  ].join('\n')
  const secondPatch = [
    'diff --git a/second.txt b/second.txt',
    '--- a/second.txt',
    '+++ b/second.txt',
    '@@ -1 +1 @@',
    '-old second',
    '+new second',
    '',
  ].join('\n')

  const result = await applyReviewPatchSequence({
    cwd: directory,
    patches: [firstPatch, secondPatch],
    reverse: false,
  }, {
    beforeApplyBatch: async (index) => {
      if (index === 1) await writeFile(join(directory, 'second.txt'), 'external edit\n')
    },
  })

  assert.equal(result.status, 'failed')
  assert.equal(await readFile(join(directory, 'first.txt'), 'utf8'), 'old first\n')
  assert.equal(await readFile(join(directory, 'second.txt'), 'utf8'), 'external edit\n')
})

test('restores earlier files when one real multi-file apply exits nonzero', async (t) => {
  const directory = await makeGitFixture(t)
  const lockedDirectory = join(directory, 'locked')
  await commitFixture(directory, {
    'fast.txt': 'old fast\n',
    'locked/bad.txt': 'old bad\n',
  })
  await chmod(join(directory, 'fast.txt'), 0o4755)
  await setTestXattr(join(directory, 'fast.txt'), 'deadbeef')
  const originalAtime = new Date('2001-02-03T04:05:06.000Z')
  const originalMtime = new Date('2002-03-04T05:06:07.000Z')
  await utimes(join(directory, 'fast.txt'), originalAtime, originalMtime)
  await chmod(lockedDirectory, 0o555)
  const patch = [
    'diff --git a/fast.txt b/fast.txt',
    '--- a/fast.txt',
    '+++ b/fast.txt',
    '@@ -1 +1 @@',
    '-old fast',
    '+new fast',
    'diff --git a/locked/bad.txt b/locked/bad.txt',
    '--- a/locked/bad.txt',
    '+++ b/locked/bad.txt',
    '@@ -1 +1 @@',
    '-old bad',
    '+new bad',
    '',
  ].join('\n')

  let result
  try {
    result = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false })
  } finally {
    await chmod(lockedDirectory, 0o755)
  }
  assert.equal(result.status, 'failed')
  assert.match(result.error, /unable to write|permission|bad\.txt/iu)
  const restoredFastDetails = await lstat(join(directory, 'fast.txt'))
  assert.equal(restoredFastDetails.mode & 0o7777, 0o4755)
  assert.equal(restoredFastDetails.atimeMs, originalAtime.getTime())
  assert.equal(restoredFastDetails.mtimeMs, originalMtime.getTime())
  assert.equal(await readFile(join(directory, 'fast.txt'), 'utf8'), 'old fast\n')
  assert.equal(await readTestXattr(join(directory, 'fast.txt')), process.platform === 'darwin' ? 'deadbeef' : '')
  assert.equal(await readFile(join(directory, 'locked/bad.txt'), 'utf8'), 'old bad\n')
  assert.doesNotMatch(result.error, /Some files may have changed/iu)
})

test('rejects review actions outside a Git repository without changing files', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codexui-review-no-git-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const target = join(directory, 'story.txt')
  await writeFile(target, 'one\ntwo\nthree\n')

  await assert.rejects(
    applyReviewPatchSequence({
      cwd: directory,
      patches: [firstStoryPatch],
      reverse: false,
    }),
    (error) => (
      error instanceof ReviewPatchRequestError
      && error.statusCode === 400
      && error.message === 'Undo requires a Git repository.'
    ),
  )
  assert.equal(await readFile(target, 'utf8'), 'one\ntwo\nthree\n')
})

test('rejects symlinked thread and command working directories', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'actual/inside.txt': 'safe\n' })
  const alias = join(directory, 'alias')
  await symlink('actual', alias)

  await assert.rejects(
    resolveReviewGitWorkspace(alias),
    (error) => error instanceof ReviewPatchRequestError && /symlinked thread workspaces/iu.test(error.message),
  )

  const workspace = await resolveReviewGitWorkspace(directory)
  await assert.rejects(
    canonicalizeReviewCommandWorkingDirectories(workspace, [{
      type: 'commandExecution',
      cwd: alias,
    }, {
      type: 'fileChange',
      status: 'completed',
    }]),
    (error) => error instanceof ReviewPatchRequestError && /cannot be resolved safely/iu.test(error.message),
  )
})

test('rejects symlinked files without modifying their targets', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'target.txt': 'safe\n' })
  await symlink('target.txt', join(directory, 'linked.txt'))
  const patch = [
    'diff --git a/linked.txt b/linked.txt',
    '--- a/linked.txt',
    '+++ b/linked.txt',
    '@@ -1 +1 @@',
    '-safe',
    '+unsafe',
    '',
  ].join('\n')

  await assert.rejects(
    applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false }),
    (error) => error instanceof ReviewPatchRequestError && /symlinked files/iu.test(error.message),
  )
  assert.equal(await readFile(join(directory, 'target.txt'), 'utf8'), 'safe\n')
  assert.equal((await lstat(join(directory, 'linked.txt'))).isSymbolicLink(), true)
})

test('rejects hard-linked files without splitting their shared inode', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'first.txt': 'safe\n' })
  const firstPath = join(directory, 'first.txt')
  const secondPath = join(directory, 'second.txt')
  await link(firstPath, secondPath)
  const originalInode = (await lstat(firstPath)).ino
  const patch = [
    'diff --git a/first.txt b/first.txt',
    '--- a/first.txt',
    '+++ b/first.txt',
    '@@ -1 +1 @@',
    '-safe',
    '+unsafe',
    '',
  ].join('\n')

  await assert.rejects(
    applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false }),
    (error) => error instanceof ReviewPatchRequestError && /hard-linked files/iu.test(error.message),
  )
  assert.equal(await readFile(firstPath, 'utf8'), 'safe\n')
  assert.equal(await readFile(secondPath, 'utf8'), 'safe\n')
  assert.equal((await lstat(firstPath)).ino, originalInode)
  assert.equal((await lstat(secondPath)).ino, originalInode)
})

test('rejects macOS ACL-bearing files before mutation', { skip: process.platform !== 'darwin' }, async (t) => {
  const username = process.env.USER
  if (!username) {
    t.skip('No local username is available for an ACL fixture')
    return
  }
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'private.txt': 'safe\n' })
  const target = join(directory, 'private.txt')
  await run('/bin/chmod', ['+a', `user:${username} allow read`, target])
  const patch = [
    'diff --git a/private.txt b/private.txt',
    '--- a/private.txt',
    '+++ b/private.txt',
    '@@ -1 +1 @@',
    '-safe',
    '+unsafe',
    '',
  ].join('\n')

  const result = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false })
  assert.equal(result.status, 'failed')
  assert.match(result.error, /access-control lists/iu)
  assert.equal(await readFile(target, 'utf8'), 'safe\n')
})

test('rejects files with macOS BSD flags before mutation', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'flagged.txt': 'safe\n' })
  const target = join(directory, 'flagged.txt')
  await run('/usr/bin/chflags', ['hidden', target])
  const patch = [
    'diff --git a/flagged.txt b/flagged.txt',
    '--- a/flagged.txt',
    '+++ b/flagged.txt',
    '@@ -1 +1 @@',
    '-safe',
    '+unsafe',
    '',
  ].join('\n')

  await assert.rejects(
    applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false }),
    (error) => error instanceof ReviewPatchRequestError && /BSD flags/iu.test(error.message),
  )
  assert.equal(await readFile(target, 'utf8'), 'safe\n')
})

test('rejects patch paths that could escape the repository', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'inside.txt': 'safe\n' })
  const outsideFilename = `codexui-review-outside-${Date.now().toString()}.txt`
  const outsidePath = join(directory, '..', outsideFilename)
  t.after(() => rm(outsidePath, { force: true }))
  const unsafePatch = [
    `diff --git a/../${outsideFilename} b/../${outsideFilename}`,
    `--- a/../${outsideFilename}`,
    `+++ b/../${outsideFilename}`,
    '@@ -1 +1 @@',
    '-safe',
    '+unsafe',
    '',
  ].join('\n')

  await assert.rejects(
    applyReviewPatchSequence({ cwd: directory, patches: [unsafePatch], reverse: false }),
    (error) => error instanceof ReviewPatchRequestError && /unsafe file path/iu.test(error.message),
  )
  await assert.rejects(readFile(outsidePath, 'utf8'), { code: 'ENOENT' })
  assert.equal(await readFile(join(directory, 'inside.txt'), 'utf8'), 'safe\n')
})

test('ignores header-looking removed content inside a hunk', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'markers.txt': '-- old marker\nstable\n' })
  const patch = [
    'diff --git a/markers.txt b/markers.txt',
    '--- a/markers.txt',
    '+++ b/markers.txt',
    '@@ -1,2 +1,2 @@',
    '--- old marker',
    '+-- new marker',
    ' stable',
    '',
  ].join('\n')
  await applyPatch(directory, patch)

  const undone = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: true })
  assert.deepEqual(undone, { status: 'success', action: 'undo' })
  assert.equal(await readFile(join(directory, 'markers.txt'), 'utf8'), '-- old marker\nstable\n')

  const reapplied = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false })
  assert.deepEqual(reapplied, { status: 'success', action: 'reapply' })
  assert.equal(await readFile(join(directory, 'markers.txt'), 'utf8'), '-- new marker\nstable\n')
})

test('undoes and reapplies a pure rename whose repository path begins with a', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'a/old.txt': 'same contents\n' })
  const patch = [
    'diff --git a/a/old.txt b/a/new.txt',
    'similarity index 100%',
    'rename from a/old.txt',
    'rename to a/new.txt',
    '',
  ].join('\n')
  await applyPatch(directory, patch)
  await assert.rejects(readFile(join(directory, 'a/old.txt'), 'utf8'), { code: 'ENOENT' })
  assert.equal(await readFile(join(directory, 'a/new.txt'), 'utf8'), 'same contents\n')

  const undone = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: true })
  assert.deepEqual(undone, { status: 'success', action: 'undo' })
  assert.equal(await readFile(join(directory, 'a/old.txt'), 'utf8'), 'same contents\n')
  await assert.rejects(readFile(join(directory, 'a/new.txt'), 'utf8'), { code: 'ENOENT' })

  const reapplied = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false })
  assert.deepEqual(reapplied, { status: 'success', action: 'reapply' })
  await assert.rejects(readFile(join(directory, 'a/old.txt'), 'utf8'), { code: 'ENOENT' })
  assert.equal(await readFile(join(directory, 'a/new.txt'), 'utf8'), 'same contents\n')
})

test('preserves metadata for a same-directory rename with content changes', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'a/old.txt': 'old contents\n' })
  const oldPath = join(directory, 'a/old.txt')
  const newPath = join(directory, 'a/new.txt')
  await chmod(oldPath, 0o4710)
  await setTestXattr(oldPath, 'abc123')
  const patch = [
    'diff --git a/a/old.txt b/a/new.txt',
    '--- a/a/old.txt',
    '+++ b/a/new.txt',
    '@@ -1 +1 @@',
    '-old contents',
    '+new contents',
    '',
  ].join('\n')

  const applied = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false })
  assert.deepEqual(applied, { status: 'success', action: 'reapply' })
  assert.equal(await readFile(newPath, 'utf8'), 'new contents\n')
  assert.equal((await lstat(newPath)).mode & 0o7777, 0o4710)
  assert.equal(await readTestXattr(newPath), process.platform === 'darwin' ? 'abc123' : '')

  const undone = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: true })
  assert.deepEqual(undone, { status: 'success', action: 'undo' })
  assert.equal(await readFile(oldPath, 'utf8'), 'old contents\n')
  assert.equal((await lstat(oldPath)).mode & 0o7777, 0o4710)
  assert.equal(await readTestXattr(oldPath), process.platform === 'darwin' ? 'abc123' : '')
})

test('rejects cross-directory renames whose directory modes cannot be reconstructed', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'private/old.txt': 'same contents\n' })
  const privateDirectory = join(directory, 'private')
  await chmod(privateDirectory, 0o700)
  const patch = [
    'diff --git a/private/old.txt b/other/new.txt',
    'similarity index 100%',
    'rename from private/old.txt',
    'rename to other/new.txt',
    '',
  ].join('\n')

  await assert.rejects(
    applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false }),
    (error) => error instanceof ReviewPatchRequestError && /directory permissions/iu.test(error.message),
  )
  assert.equal(await readFile(join(privateDirectory, 'old.txt'), 'utf8'), 'same contents\n')
  assert.equal((await lstat(privateDirectory)).mode & 0o7777, 0o700)
  await assert.rejects(lstat(join(directory, 'other')), { code: 'ENOENT' })
})

test('rejects cross-directory content moves before changing either directory', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'private/old.txt': 'old contents\n' })
  const privateDirectory = join(directory, 'private')
  await chmod(privateDirectory, 0o700)
  const patch = [
    'diff --git a/private/old.txt b/other/new.txt',
    '--- a/private/old.txt',
    '+++ b/other/new.txt',
    '@@ -1 +1 @@',
    '-old contents',
    '+new contents',
    '',
  ].join('\n')

  await assert.rejects(
    applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false }),
    (error) => error instanceof ReviewPatchRequestError && /directory permissions/iu.test(error.message),
  )
  assert.equal(await readFile(join(privateDirectory, 'old.txt'), 'utf8'), 'old contents\n')
  assert.equal((await lstat(privateDirectory)).mode & 0o7777, 0o700)
  await assert.rejects(lstat(join(directory, 'other')), { code: 'ENOENT' })
})

test('rejects addition Undo when the saved turn cannot prove the created worktree mode', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'anchor.txt': 'anchor\n' })
  const patch = [
    'diff --git a/empty.txt b/empty.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/empty.txt',
    '',
  ].join('\n')
  await applyPatch(directory, patch)
  assert.equal(await readFile(join(directory, 'empty.txt'), 'utf8'), '')
  await chmod(join(directory, 'empty.txt'), 0o755)

  await assert.rejects(
    applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: true }),
    (error) => error instanceof ReviewPatchRequestError && /worktree permissions/iu.test(error.message),
  )
  assert.equal((await lstat(join(directory, 'empty.txt'))).mode & 0o111, 0o111)
})

test('rejects explicit mode-change patches instead of overriding their requested mode', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'script.sh': 'old\n' })
  const target = join(directory, 'script.sh')
  const patch = [
    'diff --git a/script.sh b/script.sh',
    'old mode 100644',
    'new mode 100755',
    '--- a/script.sh',
    '+++ b/script.sh',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n')

  await assert.rejects(
    applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false }),
    (error) => error instanceof ReviewPatchRequestError && /mode-change patches/iu.test(error.message),
  )
  assert.equal(await readFile(target, 'utf8'), 'old\n')
  assert.equal((await lstat(target)).mode & 0o7777, 0o644)
})

test('builds byte-exact whole-file patches for CRLF and lone carriage returns', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'anchor.txt': 'anchor\n' })
  const contents = 'first\r\nsecond'
  const rawPatch = buildReviewPatch({
    path: 'windows.txt',
    kind: 'add',
    diff: contents,
  })
  const patch = rawPatch.endsWith('\n') ? rawPatch : `${rawPatch}\n`
  await applyPatch(directory, patch)
  assert.deepEqual(await readFile(join(directory, 'windows.txt')), Buffer.from(contents))

  const carriageReturnContents = 'first\rsecond\r'
  const carriageReturnPatch = `${buildReviewPatch({
    path: 'classic-mac.txt',
    kind: 'add',
    diff: carriageReturnContents,
  })}\n`
  await applyPatch(directory, carriageReturnPatch)
  assert.deepEqual(
    await readFile(join(directory, 'classic-mac.txt')),
    Buffer.from(carriageReturnContents),
  )
})

test('does not execute repository content filters while applying Review changes', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, {
    '.gitattributes': 'filtered.txt filter=slow\n',
    'filtered.txt': 'old\n',
  })
  await run('git', ['config', 'filter.slow.clean', "sh -c 'touch filter-clean-ran; cat'"], { cwd: directory })
  await run('git', ['config', 'filter.slow.smudge', "sh -c 'touch filter-smudge-ran; cat'"], { cwd: directory })
  await run('git', ['config', 'filter.slow.process', "sh -c 'touch filter-process-ran; exit 1'"], { cwd: directory })
  await run('git', ['config', 'filter.slow.required', 'true'], { cwd: directory })
  const patch = [
    'diff --git a/filtered.txt b/filtered.txt',
    '--- a/filtered.txt',
    '+++ b/filtered.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n')

  const reapplied = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false })
  assert.deepEqual(reapplied, { status: 'success', action: 'reapply' })
  assert.equal(await readFile(join(directory, 'filtered.txt'), 'utf8'), 'new\n')
  await assert.rejects(lstat(join(directory, 'filter-clean-ran')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(directory, 'filter-smudge-ran')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(directory, 'filter-process-ran')), { code: 'ENOENT' })
})

test('strips inherited Git config that could inject a content filter', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, {
    '.gitattributes': 'filtered.txt filter=envinject\n',
    'filtered.txt': 'old\n',
  })
  const inheritedKeys = [
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_VALUE_1',
  ]
  const previousValues = new Map(inheritedKeys.map((key) => [key, process.env[key]]))
  process.env.GIT_CONFIG_COUNT = '2'
  process.env.GIT_CONFIG_KEY_0 = 'filter.envinject.process'
  process.env.GIT_CONFIG_VALUE_0 = "sh -c 'touch env-filter-ran; exit 1'"
  process.env.GIT_CONFIG_KEY_1 = 'filter.envinject.required'
  process.env.GIT_CONFIG_VALUE_1 = 'true'
  const patch = [
    'diff --git a/filtered.txt b/filtered.txt',
    '--- a/filtered.txt',
    '+++ b/filtered.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n')

  try {
    const reapplied = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false })
    assert.deepEqual(reapplied, { status: 'success', action: 'reapply' })
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  assert.equal(await readFile(join(directory, 'filtered.txt'), 'utf8'), 'new\n')
  await assert.rejects(lstat(join(directory, 'env-filter-ran')), { code: 'ENOENT' })
})

test('rejects deletion undo when the saved turn cannot prove the original worktree mode', async (t) => {
  const directory = await makeGitFixture(t)
  const scriptPath = join(directory, 'run.sh')
  const contents = '#!/bin/sh\necho safe\n'
  await commitFixture(directory, { 'run.sh': contents })
  // HEAD and the index still say 100644, but this pre-deletion worktree mode was 100755.
  await chmod(scriptPath, 0o755)
  await unlink(scriptPath)
  const patch = `${buildReviewPatch({
    path: 'run.sh',
    kind: 'delete',
    diff: contents,
  })}\n`

  await assert.rejects(
    applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: true }),
    (error) => error instanceof ReviewPatchRequestError && /worktree permissions/iu.test(error.message),
  )
  await assert.rejects(lstat(scriptPath), { code: 'ENOENT' })
})

test('supports ordinary spaces in safe repository paths', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'my file.txt': 'old\n' })
  const patch = [
    'diff --git a/my file.txt b/my file.txt',
    '--- a/my file.txt',
    '+++ b/my file.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n')
  await applyPatch(directory, patch)

  const undone = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: true })
  assert.deepEqual(undone, { status: 'success', action: 'undo' })
  assert.equal(await readFile(join(directory, 'my file.txt'), 'utf8'), 'old\n')

  const reapplied = await applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false })
  assert.deepEqual(reapplied, { status: 'success', action: 'reapply' })
  assert.equal(await readFile(join(directory, 'my file.txt'), 'utf8'), 'new\n')
})

test('rejects backslashes, controls, outer whitespace, and Git metadata in patch paths', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFixture(directory, { 'inside.txt': 'safe\n' })
  const unsafePaths = [
    'folder\\escape.txt',
    `control${String.fromCharCode(1)}.txt`,
    ' leading.txt',
    'trailing.txt ',
    '.git/config',
    '.GIT/config',
  ]

  for (const path of unsafePaths) {
    const patch = [
      `diff --git a/inside.txt b/${path}`,
      '--- a/inside.txt',
      `+++ b/${path}`,
      '@@ -1 +1 @@',
      '-safe',
      '+unsafe',
      '',
    ].join('\n')
    await assert.rejects(
      applyReviewPatchSequence({ cwd: directory, patches: [patch], reverse: false }),
      (error) => error instanceof ReviewPatchRequestError && /unsafe file path/iu.test(error.message),
    )
  }
  assert.equal(await readFile(join(directory, 'inside.txt'), 'utf8'), 'safe\n')
})

test('serializes concurrent undo and reapply operations in one repository', async (t) => {
  const directory = await makeGitFixture(t)
  const files = {}
  const patches = []
  for (let index = 0; index < 16; index += 1) {
    const path = `concurrent-${index.toString()}.txt`
    files[path] = 'old\n'
    patches.push([
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n'))
  }
  await commitFixture(directory, files)
  for (const patch of patches) await applyPatch(directory, patch)

  const undoPromise = applyReviewPatchSequence({ cwd: directory, patches, reverse: true })
  const lastPath = join(directory, 'concurrent-15.txt')
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      if (await readFile(lastPath, 'utf8') === 'old\n') break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(await readFile(lastPath, 'utf8'), 'old\n')

  const reapplyPromise = applyReviewPatchSequence({ cwd: directory, patches, reverse: false })
  const [undone, reapplied] = await Promise.all([undoPromise, reapplyPromise])
  assert.deepEqual(undone, { status: 'success', action: 'undo' })
  assert.deepEqual(reapplied, { status: 'success', action: 'reapply' })
  for (const path of Object.keys(files)) {
    assert.equal(await readFile(join(directory, path), 'utf8'), 'new\n')
  }
})
