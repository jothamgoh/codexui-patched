import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type {
  GitWorkspaceBaseBranch,
  GitWorkspaceBranch,
  GitWorkspaceReview,
  GitWorkspaceReviewSource,
  GitWorkspaceStatus,
  GitWorkspaceSwitchErrorCode,
  GitWorkspaceSwitchResult,
} from '../types/codex'
import { buildReviewChangesFromUnifiedPatch, buildReviewPatch } from '../utils/reviewDiff'
import { withRepositoryMutationLock } from './reviewPatch'

const NULL_DEVICE_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'
const GIT_TIMEOUT_MS = 20_000
const GIT_MUTATION_TIMEOUT_MS = 5 * 60_000
const GIT_OUTPUT_LIMIT = 12 * 1024 * 1024
const GIT_LIST_OUTPUT_LIMIT = 8 * 1024 * 1024
const MAX_BRANCHES = 512
const MAX_UNTRACKED_FILES = 64
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024
const MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024

type GitCommandResult = {
  code: number
  stdout: string
  stderr: string
  truncated: boolean
}

type GitWorkspace = {
  cwd: string
  root: string
  commonGitDirectory: string
  safetyArgs: string[]
}

type GitRefSnapshot = {
  branches: GitWorkspaceBranch[]
  baseBranches: GitWorkspaceBaseBranch[]
  defaultBaseBranch: string | null
  currentBranch: string | null
  detachedHead: string | null
  branchesTruncated: boolean
}

export class GitWorkspaceRequestError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'GitWorkspaceRequestError'
    this.statusCode = statusCode
  }
}

function gitEnvironment(readOnly: boolean, useEffectiveConfig: boolean): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key]
  }
  Object.assign(environment, {
    GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    ...(readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
  })
  if (!useEffectiveConfig) {
    Object.assign(environment, {
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: NULL_DEVICE_PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: NULL_DEVICE_PATH,
    })
  }
  return environment
}

async function runGit(
  cwd: string,
  args: string[],
  options: {
    readOnly?: boolean
    outputLimit?: number
    input?: string
    timeoutMs?: number
    useEffectiveConfig?: boolean
  } = {},
): Promise<GitCommandResult> {
  const outputLimit = options.outputLimit ?? GIT_OUTPUT_LIMIT
  return await new Promise<GitCommandResult>((resolveCommand, rejectCommand) => {
    const child = spawn('git', args, {
      cwd,
      detached: process.platform !== 'win32',
      env: gitEnvironment(options.readOnly !== false, options.useEffectiveConfig === true),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let retainedBytes = 0
    let settled = false
    let truncated = false
    let forcedCode: number | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    const killTree = (signal: NodeJS.Signals): void => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // The process group may already have exited.
        }
      }
      try {
        child.kill(signal)
      } catch {
        // The close/error handler will settle an already-exited child.
      }
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      callback()
    }
    const terminate = (code: number): void => {
      if (forcedCode !== null) return
      forcedCode = code
      killTree('SIGTERM')
      forceKillTimer = setTimeout(() => {
        killTree('SIGKILL')
        finish(() => resolveCommand({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          truncated,
        }))
      }, 1000)
      forceKillTimer.unref?.()
    }
    const append = (target: Buffer[], chunk: Buffer): void => {
      const available = Math.max(0, outputLimit - retainedBytes)
      if (available > 0) {
        const retained = chunk.length <= available ? chunk : chunk.subarray(0, available)
        target.push(retained)
        retainedBytes += retained.length
      }
      if (chunk.length > available) {
        truncated = true
        terminate(125)
      }
    }
    const timeout = setTimeout(() => terminate(124), options.timeoutMs ?? GIT_TIMEOUT_MS)
    timeout.unref?.()
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') finish(() => rejectCommand(error))
    })
    child.on('error', (error) => finish(() => rejectCommand(error)))
    child.on('close', (code) => finish(() => resolveCommand({
      code: forcedCode ?? code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      truncated,
    })))
    child.stdin.end(options.input ?? '')
  })
}

function compactGitError(result: GitCommandResult): string {
  if (result.code === 124) return 'The Git operation timed out.'
  if (result.truncated) return 'The Git operation produced too much output.'
  const message = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n')
  if (!message) return 'Git could not complete the requested operation.'
  return message.length > 1600 ? `${message.slice(0, 1600).trimEnd()}…` : message
}

async function resolveGitWorkspace(cwd: unknown): Promise<GitWorkspace> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new GitWorkspaceRequestError('The workspace path must be absolute.')
  }
  let details: Awaited<ReturnType<typeof lstat>>
  try {
    details = await lstat(cwd)
  } catch {
    throw new GitWorkspaceRequestError('The workspace no longer exists.')
  }
  if (details.isSymbolicLink()) {
    throw new GitWorkspaceRequestError('Git workspace controls are unavailable for symlinked paths.', 409)
  }
  if (!details.isDirectory()) {
    throw new GitWorkspaceRequestError('The workspace path is not a directory.')
  }
  const canonicalCwd = await realpath(cwd)
  if (canonicalCwd !== resolve(cwd)) {
    throw new GitWorkspaceRequestError('Git workspace controls are unavailable for symlinked paths.', 409)
  }

  const discoveryArgs = [
    '-c', `core.hooksPath=${NULL_DEVICE_PATH}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'checkout.workers=1',
  ]
  const rootResult = await runGit(canonicalCwd, [...discoveryArgs, 'rev-parse', '--show-toplevel'])
  if (rootResult.code !== 0 || !rootResult.stdout.trim()) {
    throw new GitWorkspaceRequestError('This workspace is not a Git repository.', 409)
  }
  const lexicalRoot = resolve(rootResult.stdout.trim())
  const root = await realpath(lexicalRoot).catch(() => '')
  if (!root || root !== lexicalRoot) {
    throw new GitWorkspaceRequestError('Git workspace controls are unavailable for symlinked repositories.', 409)
  }
  const fromRoot = relative(root, canonicalCwd)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new GitWorkspaceRequestError('The workspace is outside its Git repository.', 409)
  }

  const [commonDirectoryResult, bareResult, worktreeConfigResult, filterResult] = await Promise.all([
    runGit(root, [...discoveryArgs, 'rev-parse', '--git-common-dir']),
    runGit(root, [...discoveryArgs, 'rev-parse', '--is-bare-repository']),
    runGit(root, [...discoveryArgs, 'config', '--get', 'core.worktree']),
    runGit(root, [
      ...discoveryArgs,
      'config', '--includes', '--name-only', '--get-regexp',
      '^filter\\..*\\.(process|smudge|clean|required)$',
    ], { outputLimit: 1024 * 1024 }),
  ])
  if (bareResult.code !== 0 || bareResult.stdout.trim() === 'true') {
    throw new GitWorkspaceRequestError('Bare repositories do not have a reviewable workspace.', 409)
  }
  if (worktreeConfigResult.code === 0 && worktreeConfigResult.stdout.trim()) {
    throw new GitWorkspaceRequestError('Repositories with an explicit core.worktree are not supported.', 409)
  }
  if (commonDirectoryResult.code !== 0 || !commonDirectoryResult.stdout.trim()) {
    throw new GitWorkspaceRequestError('The Git repository metadata is unavailable.', 409)
  }
  if (filterResult.code !== 0 && filterResult.code !== 1) {
    throw new GitWorkspaceRequestError('The repository filter configuration could not be inspected safely.', 409)
  }
  const commonPath = resolve(root, commonDirectoryResult.stdout.trim())
  const commonGitDirectory = await realpath(commonPath).catch(() => '')
  if (!commonGitDirectory) {
    throw new GitWorkspaceRequestError('The Git repository metadata is unavailable.', 409)
  }

  const driverNames = new Set<string>()
  for (const line of filterResult.stdout.split(/\r?\n/u)) {
    const match = line.trim().match(/^filter\.(.+)\.(?:process|smudge|clean|required)$/u)
    if (match?.[1]) driverNames.add(match[1])
  }
  if (driverNames.size > 64) {
    throw new GitWorkspaceRequestError('The repository defines too many content filters.', 409)
  }
  const safetyArgs = [
    '-c', `core.hooksPath=${NULL_DEVICE_PATH}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'checkout.workers=1',
    '-c', `core.attributesFile=${NULL_DEVICE_PATH}`,
    '-c', `core.worktree=${root}`,
    '-c', 'diff.external=',
    '-c', 'diff.trustExitCode=false',
    '-c', 'submodule.recurse=false',
  ]
  for (const driverName of driverNames) {
    safetyArgs.push(
      '-c', `filter.${driverName}.process=`,
      '-c', `filter.${driverName}.smudge=`,
      '-c', `filter.${driverName}.clean=`,
      '-c', `filter.${driverName}.required=false`,
    )
  }
  return { cwd: canonicalCwd, root, commonGitDirectory, safetyArgs }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function readRefSnapshot(workspace: GitWorkspace): Promise<GitRefSnapshot> {
  const [symbolicResult, detachedResult, refsResult] = await Promise.all([
    runGit(workspace.root, [...workspace.safetyArgs, 'symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGit(workspace.root, [...workspace.safetyArgs, 'rev-parse', '--short=12', '--verify', 'HEAD']),
    runGit(workspace.root, [
      ...workspace.safetyArgs,
      'for-each-ref',
      '--format=%(refname)%09%(upstream)%09%(symref)',
      'refs/heads',
      'refs/remotes',
    ], { outputLimit: GIT_LIST_OUTPUT_LIMIT }),
  ])
  if (refsResult.code !== 0 || refsResult.truncated) {
    throw new GitWorkspaceRequestError('The branch list is too large to load safely.', 413)
  }
  const currentBranch = symbolicResult.code === 0 ? symbolicResult.stdout.trim() || null : null
  const detachedHead = currentBranch === null && detachedResult.code === 0
    ? detachedResult.stdout.trim() || null
    : null
  const local: GitWorkspaceBranch[] = []
  const baseByRef = new Map<string, GitWorkspaceBaseBranch>()
  for (const line of refsResult.stdout.split(/\r?\n/u)) {
    if (!line) continue
    const [ref = '', upstream = '', symref = ''] = line.split('\t')
    if (symref || (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/'))) continue
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length)
      local.push({
        name,
        ref,
        current: name === currentBranch,
        ...(upstream ? { upstream } : {}),
      })
      baseByRef.set(ref, { name, ref, remote: false })
    } else {
      baseByRef.set(ref, {
        name: ref.slice('refs/remotes/'.length),
        ref,
        remote: true,
      })
    }
  }
  local.sort((left, right) => Number(right.current) - Number(left.current) || compareNames(left.name, right.name))
  const currentRef = currentBranch ? `refs/heads/${currentBranch}` : ''
  const currentEntry = local.find((branch) => branch.current)
  const priorities = [
    'refs/heads/main',
    'refs/heads/master',
    'refs/heads/trunk',
    'refs/heads/develop',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'refs/remotes/origin/trunk',
    'refs/remotes/upstream/main',
    currentEntry?.upstream,
  ].filter((ref): ref is string => Boolean(ref && ref !== currentRef && baseByRef.has(ref)))
  const priorityByRef = new Map(priorities.map((ref, index) => [ref, index]))
  const baseBranches = [...baseByRef.values()]
    .filter((branch) => branch.ref !== currentRef)
    .sort((left, right) => {
      const leftPriority = priorityByRef.get(left.ref) ?? Number.MAX_SAFE_INTEGER
      const rightPriority = priorityByRef.get(right.ref) ?? Number.MAX_SAFE_INTEGER
      return leftPriority - rightPriority || Number(left.remote) - Number(right.remote) || compareNames(left.name, right.name)
    })
  const branchesTruncated = local.length > MAX_BRANCHES || baseBranches.length > MAX_BRANCHES
  return {
    branches: local.slice(0, MAX_BRANCHES),
    baseBranches: baseBranches.slice(0, MAX_BRANCHES),
    defaultBaseBranch: baseBranches[0]?.ref ?? null,
    currentBranch,
    detachedHead,
    branchesTruncated,
  }
}

function parseStatus(result: GitCommandResult): Pick<GitWorkspaceStatus, 'counts' | 'countsTruncated' | 'isDirty'> {
  const counts = { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }
  const records = result.stdout.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    if (record.startsWith('? ')) {
      counts.total += 1
      counts.untracked += 1
      continue
    }
    if (record.startsWith('u ')) {
      counts.total += 1
      counts.conflicted += 1
      continue
    }
    if (!record.startsWith('1 ') && !record.startsWith('2 ')) continue
    counts.total += 1
    const xy = record.split(' ')[1] ?? '..'
    if (xy[0] && xy[0] !== '.') counts.staged += 1
    if (xy[1] && xy[1] !== '.') counts.unstaged += 1
    if (record.startsWith('2 ')) index += 1
  }
  const isDirty = result.truncated || Object.values(counts).some((count) => count > 0)
  return { counts, countsTruncated: result.truncated, isDirty }
}

export async function readGitWorkspaceStatus(cwd: unknown): Promise<GitWorkspaceStatus> {
  const workspace = await resolveGitWorkspace(cwd)
  const [refs, statusResult] = await Promise.all([
    readRefSnapshot(workspace),
    runGit(workspace.root, [
      ...workspace.safetyArgs,
      'status', '--porcelain=v2', '-z', '--untracked-files=all',
    ], { outputLimit: GIT_LIST_OUTPUT_LIMIT }),
  ])
  if (statusResult.code !== 0 && !statusResult.truncated) {
    throw new GitWorkspaceRequestError(compactGitError(statusResult), 409)
  }
  return {
    cwd: workspace.cwd,
    root: workspace.root,
    ...refs,
    ...parseStatus(statusResult),
  }
}

function diffArgs(workspace: GitWorkspace): string[] {
  return [
    ...workspace.safetyArgs,
    'diff', '--no-color', '--no-renames', '--full-index', '--unified=3',
    '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
  ]
}

async function readUntrackedPatches(workspace: GitWorkspace): Promise<{
  patch: string
  omitted: number
  truncated: boolean
}> {
  const listed = await runGit(workspace.root, [
    ...workspace.safetyArgs,
    'ls-files', '--others', '--exclude-standard', '-z', '--',
  ], { outputLimit: GIT_LIST_OUTPUT_LIMIT })
  if (listed.code !== 0 && !listed.truncated) {
    throw new GitWorkspaceRequestError(compactGitError(listed), 409)
  }
  const pathRecords = listed.stdout.split('\0')
  if (listed.truncated && !listed.stdout.endsWith('\0')) pathRecords.pop()
  const paths = pathRecords.filter(Boolean)
  const patches: string[] = []
  const candidates = paths.slice(0, MAX_UNTRACKED_FILES)
  let omitted = (listed.truncated ? 1 : 0) + Math.max(0, paths.length - candidates.length)
  let totalFileBytes = 0
  let totalPatchBytes = 0
  for (const path of candidates) {
    const lexicalPath = resolve(workspace.root, path)
    const fromRoot = relative(workspace.root, lexicalPath)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      omitted += 1
      continue
    }
    const details = await lstat(lexicalPath).catch(() => null)
    const canonicalPath = details?.isFile() ? await realpath(lexicalPath).catch(() => '') : ''
    if (
      !details?.isFile()
      || canonicalPath !== lexicalPath
      || details.size > MAX_UNTRACKED_FILE_BYTES
      || totalFileBytes + details.size > MAX_UNTRACKED_TOTAL_BYTES
    ) {
      omitted += 1
      continue
    }
    const result = await runGit(workspace.root, [
      ...diffArgs(workspace), '--no-index', '--', NULL_DEVICE_PATH, path,
    ], { outputLimit: MAX_UNTRACKED_FILE_BYTES * 3 })
    if ((result.code !== 0 && result.code !== 1) || result.truncated) {
      omitted += 1
      continue
    }
    let patch = result.stdout
    if (!patch.trim()) {
      patch = buildReviewPatch({ path, kind: 'add', diff: '' })
    }
    const patchBytes = Buffer.byteLength(patch)
    if (totalPatchBytes + patchBytes > MAX_UNTRACKED_TOTAL_BYTES) {
      omitted += 1
      continue
    }
    patches.push(patch.endsWith('\n') ? patch : `${patch}\n`)
    totalFileBytes += details.size
    totalPatchBytes += patchBytes
  }
  return { patch: patches.join('\n'), omitted, truncated: listed.truncated }
}

export async function readGitWorkspaceReview(
  cwd: unknown,
  source: GitWorkspaceReviewSource,
  baseBranch?: string,
): Promise<GitWorkspaceReview> {
  if (!['uncommitted', 'unstaged', 'staged', 'branch'].includes(source)) {
    throw new GitWorkspaceRequestError('The requested Git review source is invalid.')
  }
  const workspace = await resolveGitWorkspace(cwd)
  let selectedBase: GitWorkspaceBaseBranch | undefined
  let args = diffArgs(workspace)
  if (source === 'unstaged') args.push('--')
  else if (source === 'staged') args.push('--cached', '--')
  else if (source === 'branch') {
    const refs = await readRefSnapshot(workspace)
    const selectedRef = baseBranch || refs.defaultBaseBranch
    selectedBase = refs.baseBranches.find((branch) => branch.ref === selectedRef)
    if (!selectedBase) throw new GitWorkspaceRequestError('Select an available base branch.', 409)
    if (!refs.currentBranch) throw new GitWorkspaceRequestError('Branch comparison is unavailable in detached HEAD state.', 409)
    args.push(`${selectedBase.ref}...HEAD`, '--')
  } else {
    const head = await runGit(workspace.root, [
      ...workspace.safetyArgs, 'rev-parse', '--verify', 'HEAD',
    ])
    if (head.code === 0) args.push('HEAD', '--')
    else {
      const emptyTree = await runGit(workspace.root, [
        ...workspace.safetyArgs, 'hash-object', '-t', 'tree', NULL_DEVICE_PATH,
      ])
      if (emptyTree.code !== 0 || !emptyTree.stdout.trim()) {
        throw new GitWorkspaceRequestError('The initial Git tree could not be compared safely.', 409)
      }
      args.push(emptyTree.stdout.trim(), '--')
    }
  }

  const comparison = await runGit(workspace.root, args)
  if (comparison.code !== 0 || comparison.truncated) {
    throw new GitWorkspaceRequestError(compactGitError(comparison), comparison.truncated ? 413 : 409)
  }
  let patch = comparison.stdout
  let omittedUntrackedFiles = 0
  let untrackedFilesTruncated = false
  if (source === 'uncommitted') {
    const untracked = await readUntrackedPatches(workspace)
    patch = [patch, untracked.patch].filter(Boolean).join('\n')
    omittedUntrackedFiles = untracked.omitted
    untrackedFilesTruncated = untracked.truncated
  }
  const changes = buildReviewChangesFromUnifiedPatch(patch, {
    id: `git-workspace-${source}`,
    cwd: workspace.root,
    actionUnavailableReason: 'Workspace comparisons are read-only.',
  })
  return {
    source,
    ...(selectedBase ? { baseBranch: selectedBase } : {}),
    changes,
    omittedUntrackedFiles,
    untrackedFilesTruncated,
  }
}

function classifySwitchFailure(result: GitCommandResult): {
  status: 'blocked' | 'failed'
  code: GitWorkspaceSwitchErrorCode
  paths?: string[]
} {
  const output = `${result.stderr}\n${result.stdout}`
  let code: GitWorkspaceSwitchErrorCode = 'git_error'
  if (/local changes|untracked working tree files would be overwritten/iu.test(output)) code = 'local_changes'
  else if (/resolve your current index|unmerged files/iu.test(output)) code = 'conflicts'
  else if (/already checked out at/iu.test(output)) code = 'branch_in_use'
  else if (/cannot switch branch while|in the middle of|rebase|cherry-pick|bisect/iu.test(output)) {
    code = 'repository_operation_in_progress'
  }
  const paths = output
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s+([^\s].*)$/u)?.[1]?.trim() ?? '')
    .filter((line) => line && !/^(Please |Aborting|Commit |Move |error:|hint:)/iu.test(line))
    .slice(0, 64)
  return { status: code === 'git_error' ? 'failed' : 'blocked', code, ...(paths.length ? { paths } : {}) }
}

function parseNulRecords(result: GitCommandResult, errorMessage: string): string[] {
  const records = result.stdout.split('\0')
  if (records.at(-1) === '') records.pop()
  if (result.code !== 0 || result.truncated) {
    throw new GitWorkspaceRequestError(errorMessage, 409)
  }
  return records
}

function filteredPathsFromCheckAttr(result: GitCommandResult): string[] {
  const records = parseNulRecords(
    result,
    'Repository checkout filters could not be inspected safely.',
  )
  if (records.length % 3 !== 0) {
    throw new GitWorkspaceRequestError('Repository checkout filters returned invalid data.', 409)
  }
  const paths: string[] = []
  for (let index = 0; index < records.length; index += 3) {
    const path = records[index] ?? ''
    const value = records[index + 2] ?? ''
    if (path && value && value !== 'unspecified' && value !== 'unset') paths.push(path)
  }
  return paths
}

async function checkoutFilterPaths(workspace: GitWorkspace, targetRef: string): Promise<string[]> {
  const pathArgs = [
    ...workspace.safetyArgs,
    'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
  ]
  const [branchResult, workspaceResult] = await Promise.all([
    runGit(workspace.root, [...pathArgs, 'HEAD', targetRef, '--'], {
      outputLimit: GIT_LIST_OUTPUT_LIMIT,
    }),
    runGit(workspace.root, [...pathArgs, 'HEAD', '--'], {
      outputLimit: GIT_LIST_OUTPUT_LIMIT,
    }),
  ])
  const changedPaths = new Set([
    ...parseNulRecords(branchResult, 'The target branch is too large to inspect safely before checkout.'),
    ...parseNulRecords(workspaceResult, 'The current changes are too large to inspect safely before checkout.'),
  ].filter(Boolean))
  if (changedPaths.size === 0) return []
  const input = `${[...changedPaths].join('\0')}\0`
  const inspectionArgs = [
    '-c', `core.hooksPath=${NULL_DEVICE_PATH}`,
    '-c', 'core.fsmonitor=false',
    '-c', `core.worktree=${workspace.root}`,
  ]

  const currentCheck = await runGit(workspace.root, [
    ...inspectionArgs,
    'check-attr', '-z', 'filter', '--stdin',
  ], {
    outputLimit: GIT_LIST_OUTPUT_LIMIT,
    input,
    useEffectiveConfig: true,
  })
  const targetCheck = await runGit(workspace.root, [
    ...inspectionArgs,
    'check-attr', '-z', '--source', targetRef, 'filter', '--stdin',
  ], {
    outputLimit: GIT_LIST_OUTPUT_LIMIT,
    input,
    useEffectiveConfig: true,
  })
  return [...new Set([
    ...filteredPathsFromCheckAttr(currentCheck),
    ...filteredPathsFromCheckAttr(targetCheck),
  ])].slice(0, 64)
}

export async function switchGitWorkspaceBranch(
  cwd: unknown,
  branch: string,
): Promise<GitWorkspaceSwitchResult> {
  if (typeof branch !== 'string' || !branch || branch !== branch.trim() || branch.includes('\0')) {
    throw new GitWorkspaceRequestError('Select a valid local branch.')
  }
  const workspace = await resolveGitWorkspace(cwd)
  return await withRepositoryMutationLock(workspace.commonGitDirectory, async () => {
    const before = await readRefSnapshot(workspace)
    const target = before.branches.find((candidate) => candidate.name === branch)
    if (!target) {
      return {
        status: 'failed',
        branch,
        previousBranch: before.currentBranch,
        currentBranch: before.currentBranch,
        error: 'That local branch no longer exists.',
        details: { code: 'branch_not_found' },
      }
    }
    if (before.currentBranch === branch) {
      return {
        status: 'success',
        branch,
        previousBranch: branch,
        currentBranch: branch,
      }
    }
    const filteredPaths = await checkoutFilterPaths(workspace, target.ref)
    if (filteredPaths.length > 0) {
      return {
        status: 'failed',
        branch,
        previousBranch: before.currentBranch,
        currentBranch: before.currentBranch,
        error: 'Branch switching is unavailable because this repository uses checkout content filters.',
        details: { code: 'checkout_filters', paths: filteredPaths },
      }
    }
    const switched = await runGit(workspace.root, [
      ...workspace.safetyArgs,
      'switch', '--no-guess', '--no-overwrite-ignore', '--', branch,
    ], {
      readOnly: false,
      outputLimit: 2 * 1024 * 1024,
      timeoutMs: GIT_MUTATION_TIMEOUT_MS,
    })
    const after = await readRefSnapshot(workspace).catch(() => before)
    if (switched.code === 0 && after.currentBranch === branch) {
      return {
        status: 'success',
        branch,
        previousBranch: before.currentBranch,
        currentBranch: after.currentBranch,
      }
    }
    const interrupted = switched.code === 124 || switched.code === 125 || switched.truncated
    const failure = interrupted
      ? { status: 'failed' as const, code: 'checkout_interrupted' as const }
      : classifySwitchFailure(switched)
    return {
      status: failure.status,
      branch,
      previousBranch: before.currentBranch,
      currentBranch: after.currentBranch,
      error: interrupted
        ? `${compactGitError(switched)} The checkout was interrupted; inspect the repository before trying again.`
        : compactGitError(switched),
      details: { code: failure.code, ...(failure.paths ? { paths: failure.paths } : {}) },
    }
  })
}
