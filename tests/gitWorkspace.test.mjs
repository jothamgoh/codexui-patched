import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

async function compileTypeScriptModule(sourcePath, replacements = []) {
  let source = await readFile(sourcePath, 'utf8')
  for (const [search, replacement] of replacements) source = source.replace(search, replacement)
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
}

const reviewDiffUrl = await compileTypeScriptModule(
  new URL('../src/utils/reviewDiff.ts', import.meta.url),
)
const reviewPatchUrl = await compileTypeScriptModule(
  new URL('../src/server/reviewPatch.ts', import.meta.url),
)
const gitWorkspaceUrl = await compileTypeScriptModule(
  new URL('../src/server/gitWorkspace.ts', import.meta.url),
  [
    [
      "from '../utils/reviewDiff'",
      `from '${reviewDiffUrl}'`,
    ],
    [
      "from './reviewPatch'",
      `from '${reviewPatchUrl}'`,
    ],
  ],
)
const {
  GitWorkspaceRequestError,
  readGitWorkspaceReview,
  readGitWorkspaceStatus,
  switchGitWorkspaceBranch,
} = await import(gitWorkspaceUrl)
const { buildReviewChangesFromUnifiedPatch } = await import(reviewDiffUrl)

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`))
    })
  })
}

async function makeGitFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codexui-git-workspace-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await run('git', ['init', '--quiet', '--initial-branch=main'], { cwd: directory })
  await run('git', ['config', 'user.name', 'CodexUI Test'], { cwd: directory })
  await run('git', ['config', 'user.email', 'codexui-test@example.invalid'], { cwd: directory })
  return directory
}

async function commitFiles(directory, files, message = 'fixture') {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  await run('git', ['add', '--all'], { cwd: directory })
  await run('git', ['commit', '--quiet', '-m', message], { cwd: directory })
}

test('parses a raw multi-file Git patch into bounded Review Changes data', () => {
  const patch = [
    'diff --git a/file with spaces.txt b/file with spaces.txt',
    'index 7898192..6178079 100644',
    '--- a/file with spaces.txt\t',
    '+++ b/file with spaces.txt\t',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/empty.txt b/empty.txt',
    'new file mode 100644',
    'index 0000000..e69de29',
    '',
  ].join('\n')
  const review = buildReviewChangesFromUnifiedPatch(patch, {
    actionUnavailableReason: 'Read-only',
  })
  assert.equal(review.fileCount, 2)
  assert.equal(review.additions, 1)
  assert.equal(review.deletions, 1)
  assert.deepEqual(review.files.map((file) => file.path), ['file with spaces.txt', 'empty.txt'])
  assert.equal(review.actionUnavailableReason, 'Read-only')
})

test('reports status and reviews uncommitted, staged, unstaged, and branch changes', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, { 'story.txt': 'base\n' }, 'base')
  await run('git', ['switch', '--quiet', '-c', 'feature'], { cwd: directory })
  await run('git', ['config', 'diff.noprefix', 'true'], { cwd: directory })
  await run('git', ['config', 'diff.mnemonicPrefix', 'true'], { cwd: directory })
  await commitFiles(directory, { 'branch.txt': 'feature\n' }, 'feature change')
  await writeFile(join(directory, 'story.txt'), 'staged\n')
  await run('git', ['add', 'story.txt'], { cwd: directory })
  await writeFile(join(directory, 'story.txt'), 'unstaged\n')
  await writeFile(join(directory, 'note.txt'), 'untracked\n')
  await writeFile(join(directory, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
  await mkdir(join(directory, 'a'), { recursive: true })
  await writeFile(join(directory, 'a', 'nested.txt'), 'untracked under a\n')
  await writeFile(join(directory, 'oversized.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 7))

  const previousGitDir = process.env.GIT_DIR
  process.env.GIT_DIR = '/definitely/not/the/repository'
  t.after(() => {
    if (previousGitDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previousGitDir
  })
  const status = await readGitWorkspaceStatus(directory)
  assert.equal(status.currentBranch, 'feature')
  assert.equal(status.counts.staged, 1)
  assert.equal(status.counts.unstaged, 1)
  assert.equal(status.counts.untracked, 4)
  assert.equal(status.counts.total, 5)
  assert.equal(status.isDirty, true)
  assert.equal(status.defaultBaseBranch, 'refs/heads/main')
  assert(status.baseBranches.some((branch) => branch.ref === 'refs/heads/main'))

  const staged = await readGitWorkspaceReview(directory, 'staged')
  const unstaged = await readGitWorkspaceReview(directory, 'unstaged')
  const uncommitted = await readGitWorkspaceReview(directory, 'uncommitted')
  const branch = await readGitWorkspaceReview(directory, 'branch', 'refs/heads/main')
  assert.deepEqual(staged.changes.files.map((file) => file.path), ['story.txt'])
  assert.deepEqual(unstaged.changes.files.map((file) => file.path), ['story.txt'])
  assert(uncommitted.changes.files.some((file) => file.path === 'note.txt'))
  assert(uncommitted.changes.files.some((file) => file.path === 'a/nested.txt'))
  const binary = uncommitted.changes.files.find((file) => file.path === 'binary.dat')
  assert(binary.lines.some((line) => line.text.includes('Binary files')))
  assert(!uncommitted.changes.files.some((file) => file.path === 'oversized.bin'))
  assert.equal(uncommitted.omittedUntrackedFiles, 1)
  assert.deepEqual(branch.changes.files.map((file) => file.path), ['branch.txt'])
  assert.equal(branch.baseBranch.ref, 'refs/heads/main')
  if (previousGitDir === undefined) delete process.env.GIT_DIR
  else process.env.GIT_DIR = previousGitDir
  assert.equal((await run('git', ['branch', '--show-current'], { cwd: directory })).stdout.trim(), 'feature')
})

test('switches only existing local branches, preserves safe changes, and disables checkout hooks', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, { 'tracked.txt': 'same\n' })
  await run('git', ['branch', 'other'], { cwd: directory })
  await writeFile(join(directory, 'scratch.txt'), 'keep me\n')
  const hookPath = join(directory, '.git', 'hooks', 'post-checkout')
  const markerPath = join(directory, 'hook-ran')
  await writeFile(hookPath, `#!/bin/sh\nprintf ran > ${JSON.stringify(markerPath)}\n`)
  await chmod(hookPath, 0o755)

  const switched = await switchGitWorkspaceBranch(directory, 'other')
  assert.deepEqual(switched, {
    status: 'success',
    branch: 'other',
    previousBranch: 'main',
    currentBranch: 'other',
  })
  assert.equal(await readFile(join(directory, 'scratch.txt'), 'utf8'), 'keep me\n')
  await assert.rejects(readFile(markerPath), { code: 'ENOENT' })

  const missing = await switchGitWorkspaceBranch(directory, 'does-not-exist')
  assert.equal(missing.status, 'failed')
  assert.equal(missing.details.code, 'branch_not_found')
  assert.equal(missing.currentBranch, 'other')
})

test('returns a structured block when local changes conflict with checkout', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, { 'tracked.txt': 'base\n' }, 'base')
  await run('git', ['switch', '--quiet', '-c', 'other'], { cwd: directory })
  await commitFiles(directory, { 'tracked.txt': 'other\n' }, 'other')
  await run('git', ['switch', '--quiet', 'main'], { cwd: directory })
  await writeFile(join(directory, 'tracked.txt'), 'local\n')

  const result = await switchGitWorkspaceBranch(directory, 'other')
  assert.equal(result.status, 'blocked')
  assert.equal(result.details.code, 'local_changes')
  assert.equal(result.currentBranch, 'main')
  assert.equal(await readFile(join(directory, 'tracked.txt'), 'utf8'), 'local\n')
})

test('preserves an ignored local file when the target branch tracks that path', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, {
    '.gitignore': 'generated.txt\n',
    'tracked.txt': 'base\n',
  }, 'base')
  await run('git', ['switch', '--quiet', '-c', 'other'], { cwd: directory })
  await writeFile(join(directory, 'generated.txt'), 'branch version\n')
  await run('git', ['add', '--force', 'generated.txt'], { cwd: directory })
  await run('git', ['commit', '--quiet', '-m', 'track generated file'], { cwd: directory })
  await run('git', ['switch', '--quiet', 'main'], { cwd: directory })
  await writeFile(join(directory, 'generated.txt'), 'local ignored version\n')

  const result = await switchGitWorkspaceBranch(directory, 'other')
  assert.equal(result.status, 'blocked')
  assert.equal(result.details.code, 'local_changes')
  assert.equal(result.currentBranch, 'main')
  assert.equal(await readFile(join(directory, 'generated.txt'), 'utf8'), 'local ignored version\n')
})

test('refuses branch checkout that would require repository content filters', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, { 'tracked.txt': 'base\n' }, 'base')
  await run('git', ['switch', '--quiet', '-c', 'filtered'], { cwd: directory })
  await commitFiles(directory, {
    '.gitattributes': '*.bin filter=fixture-filter\n',
    'asset.bin': 'stored representation\n',
  }, 'filtered content')
  await run('git', ['switch', '--quiet', 'main'], { cwd: directory })
  const markerPath = join(directory, 'filter-ran')
  await run('git', ['config', 'filter.fixture-filter.smudge', `touch ${markerPath}`], { cwd: directory })
  await run('git', ['config', 'filter.fixture-filter.clean', 'cat'], { cwd: directory })

  const result = await switchGitWorkspaceBranch(directory, 'filtered')
  assert.equal(result.status, 'failed')
  assert.equal(result.details.code, 'checkout_filters')
  assert.equal(result.currentBranch, 'main')
  await assert.rejects(readFile(markerPath), { code: 'ENOENT' })
  await assert.rejects(readFile(join(directory, 'asset.bin')), { code: 'ENOENT' })
})

test('detects checkout filters introduced through an attributes macro', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, { 'tracked.txt': 'base\n' }, 'base')
  await run('git', ['switch', '--quiet', '-c', 'filtered-macro'], { cwd: directory })
  await commitFiles(directory, {
    '.gitattributes': 'asset.bin materialized\n',
    'asset.bin': 'stored representation\n',
  }, 'filtered macro content')
  await run('git', ['switch', '--quiet', 'main'], { cwd: directory })
  const attributesPath = join(directory, '.git', 'fixture-attributes')
  await writeFile(attributesPath, '[attr]materialized filter=fixture-filter\n')
  await run('git', ['config', 'core.attributesFile', attributesPath], { cwd: directory })

  const result = await switchGitWorkspaceBranch(directory, 'filtered-macro')
  assert.equal(result.status, 'failed')
  assert.equal(result.details.code, 'checkout_filters')
  assert.deepEqual(result.details.paths, ['asset.bin'])
  assert.equal(result.currentBranch, 'main')
  await assert.rejects(readFile(join(directory, 'asset.bin')), { code: 'ENOENT' })
})

test('rejects a symlinked workspace path', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, { 'tracked.txt': 'base\n' })
  const parent = await mkdtemp(join(tmpdir(), 'codexui-git-workspace-link-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const linked = join(parent, 'linked')
  await symlink(directory, linked)
  await assert.rejects(
    readGitWorkspaceStatus(linked),
    (error) => error instanceof GitWorkspaceRequestError && error.statusCode === 409,
  )
})

test('bounds untracked filesystem inspection before generating patches', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, { 'tracked.txt': 'base\n' })
  for (let index = 0; index < 70; index += 1) {
    await symlink('tracked.txt', join(directory, `candidate-${index.toString().padStart(3, '0')}.txt`))
  }
  await writeFile(join(directory, 'zz-after-cap.txt'), 'must stay outside the inspection budget\n')

  const review = await readGitWorkspaceReview(directory, 'uncommitted')
  assert.equal(review.changes, null)
  assert.equal(review.omittedUntrackedFiles, 71)
})

test('reasserts the lazy-fetch guard for every Git subprocess', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, { 'tracked.txt': 'base\n' })
  const shimDirectory = await mkdtemp(join(tmpdir(), 'codexui-git-shim-'))
  t.after(() => rm(shimDirectory, { recursive: true, force: true }))
  const realGit = (await run('sh', ['-c', 'command -v git'])).stdout.trim()
  const shimPath = join(shimDirectory, 'git')
  await writeFile(shimPath, [
    '#!/bin/sh',
    'if [ "$GIT_NO_LAZY_FETCH" != "1" ]; then exit 97; fi',
    `exec ${JSON.stringify(realGit)} "$@"`,
    '',
  ].join('\n'))
  await chmod(shimPath, 0o755)

  const previousPath = process.env.PATH
  const previousGuard = process.env.GIT_NO_LAZY_FETCH
  process.env.PATH = `${shimDirectory}:${previousPath ?? ''}`
  process.env.GIT_NO_LAZY_FETCH = '0'
  try {
    const status = await readGitWorkspaceStatus(directory)
    const review = await readGitWorkspaceReview(directory, 'uncommitted')
    assert.equal(status.currentBranch, 'main')
    assert.equal(review.changes, null)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousGuard === undefined) delete process.env.GIT_NO_LAZY_FETCH
    else process.env.GIT_NO_LAZY_FETCH = previousGuard
  }
})

test('disables content filters configured in worktree-scoped Git config', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, {
    '.gitattributes': 'tracked.txt filter=worktree-fixture\n',
    'tracked.txt': 'base\n',
  })
  const markerPath = join(directory, 'worktree-filter-ran')
  await run('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: directory })
  await run('git', [
    'config', '--worktree', 'filter.worktree-fixture.clean',
    `touch ${markerPath}; cat`,
  ], { cwd: directory })
  await writeFile(join(directory, 'tracked.txt'), 'changed\n')

  const status = await readGitWorkspaceStatus(directory)
  const review = await readGitWorkspaceReview(directory, 'unstaged')
  assert.equal(status.counts.unstaged, 1)
  assert.deepEqual(review.changes.files.map((file) => file.path), ['tracked.txt'])
  await assert.rejects(readFile(markerPath), { code: 'ENOENT' })
})

test('rejects an explicit worktree-scoped core.worktree override', async (t) => {
  const directory = await makeGitFixture(t)
  await commitFiles(directory, { 'tracked.txt': 'base\n' })
  await run('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: directory })
  await run('git', ['config', '--worktree', 'core.worktree', directory], { cwd: directory })

  await assert.rejects(
    readGitWorkspaceStatus(directory),
    (error) => error instanceof GitWorkspaceRequestError && error.statusCode === 409,
  )
})
