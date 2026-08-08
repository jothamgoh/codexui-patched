import { spawn } from 'node:child_process'
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const MAX_PATCH_COUNT = 128
const MAX_PATCH_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_PATCH_BYTES = 12 * 1024 * 1024
const GIT_COMMAND_TIMEOUT_MS = 30_000
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
const MAX_SNAPSHOT_PATHS = 4096
const MAX_SNAPSHOT_XATTRS = 4096
const MAX_SNAPSHOT_XATTR_BYTES = 8 * 1024 * 1024
const MAX_XATTR_BYTES = 64 * 1024
const METADATA_COMMAND_TIMEOUT_MS = 10_000
const METADATA_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024
const NULL_DEVICE_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'
const REVIEW_GIT_ENVIRONMENT: NodeJS.ProcessEnv = {
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: NULL_DEVICE_PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: NULL_DEVICE_PATH,
  LANG: 'C',
  LC_ALL: 'C',
}
const repositoryMutationTailByGitDirectory = new Map<string, Promise<void>>()

export type ReviewPatchResult = {
  status: 'success' | 'failed'
  action: 'undo' | 'reapply'
  error?: string
  state?: 'applied' | 'undone' | 'unknown'
}

export class ReviewPatchRequestError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'ReviewPatchRequestError'
    this.statusCode = statusCode
  }
}

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

async function runMetadataCommand(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      outputBytes += chunk.length
      if (outputBytes > METADATA_COMMAND_MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        finish(() => reject(new ReviewPatchRequestError(
          'A changed file contains too much extended metadata to preserve safely.',
          409,
        )))
        return
      }
      if (target === 'stdout') stdout += chunk.toString()
      else stderr += chunk.toString()
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new ReviewPatchRequestError(
        'A changed file\'s metadata could not be inspected safely.',
        409,
      )))
    }, METADATA_COMMAND_TIMEOUT_MS)
    timeout.unref?.()
    child.stdout.on('data', (chunk: Buffer) => appendOutput('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => appendOutput('stderr', chunk))
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })))
  })
}

async function runGit(
  cwd: string,
  args: string[],
  input = '',
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(childEnvironment)) {
      if (
        key === 'GIT_CONFIG_COUNT'
        || key === 'GIT_CONFIG_PARAMETERS'
        || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
        || [
          'GIT_ALTERNATE_OBJECT_DIRECTORIES',
          'GIT_COMMON_DIR',
          'GIT_DIR',
          'GIT_INDEX_FILE',
          'GIT_OBJECT_DIRECTORY',
          'GIT_WORK_TREE',
        ].includes(key)
      ) delete childEnvironment[key]
    }
    Object.assign(childEnvironment, envOverrides)
    const child = spawn('git', args, {
      cwd,
      env: childEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null
    const killChildTree = (signal: NodeJS.Signals): void => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Fall back to the direct child when the process group has already exited.
        }
      }
      try {
        child.kill(signal)
      } catch {
        // The close/error handlers settle an already-exited child.
      }
    }
    const timeout = setTimeout(() => {
      timedOut = true
      killChildTree('SIGTERM')
      forceKillTimer = setTimeout(() => {
        killChildTree('SIGKILL')
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        finish(() => resolve({
          code: 124,
          stdout,
          stderr: `${stderr}\nGit operation timed out.`.trim(),
        }))
      }, 1500)
      forceKillTimer.unref?.()
    }, GIT_COMMAND_TIMEOUT_MS)
    timeout.unref?.()
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      callback()
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => resolve({
      code: timedOut ? 124 : code ?? 1,
      stdout,
      stderr: timedOut ? `${stderr}\nGit operation timed out.`.trim() : stderr,
    })))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function compactGitError(result: CommandResult): string {
  const message = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n')
  if (!message) return 'The files no longer match this change.'
  return message.length > 1600 ? `${message.slice(0, 1600).trimEnd()}…` : message
}

function adjustedHunkError(result: CommandResult): CommandResult | null {
  if (!/\bHunk #\d+ succeeded at .*\b(?:offset|fuzz)\b/iu.test(`${result.stderr}\n${result.stdout}`)) return null
  return {
    code: 1,
    stdout: result.stdout,
    stderr: 'The files no longer match the exact locations recorded by this change.',
  }
}

function reviewParentPath(value: string): string {
  const separatorIndex = value.lastIndexOf('/')
  return separatorIndex < 0 ? '' : value.slice(0, separatorIndex)
}

type ReviewPatchMove = { from: string; to: string; preserveTimestamps: boolean }

function readPatchMoves(patch: string): ReviewPatchMove[] {
  const moves: ReviewPatchMove[] = []
  let inHunk = false
  let renameFrom: string | null = null
  let renameTo: string | null = null
  let oldPath: string | null | undefined
  let newPath: string | null | undefined
  let fileHasHunk = false
  const finishFile = (): void => {
    if ((renameFrom === null) !== (renameTo === null)) {
      throw new ReviewPatchRequestError('The saved rename data is incomplete.')
    }
    if (renameFrom !== null && renameTo !== null) {
      moves.push({ from: renameFrom, to: renameTo, preserveTimestamps: !fileHasHunk })
    } else if (oldPath && newPath && oldPath !== newPath) {
      moves.push({ from: oldPath, to: newPath, preserveTimestamps: false })
    }
    renameFrom = null
    renameTo = null
    oldPath = undefined
    newPath = undefined
    fileHasHunk = false
  }
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith('diff --git ')) {
      finishFile()
      inHunk = false
      continue
    }
    if (line.startsWith('@@ ')) {
      inHunk = true
      fileHasHunk = true
      continue
    }
    if (inHunk) continue
    if (line.startsWith('--- ')) {
      oldPath = readSafeAffectedPath(line.slice(4), {
        expectedPrefix: line.slice(4) === '/dev/null' ? undefined : 'a/',
        allowDevNull: true,
      })
      continue
    }
    if (line.startsWith('+++ ')) {
      newPath = readSafeAffectedPath(line.slice(4), {
        expectedPrefix: line.slice(4) === '/dev/null' ? undefined : 'b/',
        allowDevNull: true,
      })
      continue
    }
    if (line.startsWith('rename from ')) {
      if (renameFrom !== null) throw new ReviewPatchRequestError('The saved rename data is incomplete.')
      renameFrom = readSafeAffectedPath(line.slice('rename from '.length))
      continue
    }
    if (line.startsWith('rename to ')) {
      if (renameTo !== null) throw new ReviewPatchRequestError('The saved rename data is incomplete.')
      renameTo = readSafeAffectedPath(line.slice('rename to '.length))
    }
  }
  finishFile()
  return moves
}

function rejectUnsafeRenameDirectories(patch: string): void {
  for (const move of readPatchMoves(patch)) {
    if (reviewParentPath(move.from) !== reviewParentPath(move.to)) {
      throw new ReviewPatchRequestError(
        'Undo is unavailable because saved cross-directory renames do not include reliable directory permissions.',
        409,
      )
    }
  }
}

function validatePatches(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATCH_COUNT) {
    throw new ReviewPatchRequestError('No valid change batches were found for this turn.')
  }

  let totalBytes = 0
  const patches: string[] = []
  for (const patch of value) {
    if (typeof patch !== 'string' || !patch.includes('diff --git ') || patch.includes('\0')) {
      throw new ReviewPatchRequestError('The saved change data is invalid.')
    }
    rejectUnsafeRenameDirectories(patch)
    let inHunk = false
    for (const line of patch.split(/\r?\n/u)) {
      if (line.startsWith('diff --git ')) {
        inHunk = false
        continue
      }
      if (line.startsWith('@@ ')) {
        inHunk = true
        continue
      }
      if (
        !inHunk
        && (line.startsWith('new file mode ') || line.startsWith('deleted file mode '))
      ) {
        throw new ReviewPatchRequestError(
          'Undo is unavailable because saved file additions and deletions do not include reliable worktree permissions.',
          409,
        )
      }
      if (!inHunk && (line.startsWith('old mode ') || line.startsWith('new mode '))) {
        throw new ReviewPatchRequestError(
          'Undo is unavailable because explicit mode-change patches cannot preserve complete worktree permissions.',
          409,
        )
      }
    }
    const byteLength = Buffer.byteLength(patch)
    if (byteLength > MAX_PATCH_BYTES) {
      throw new ReviewPatchRequestError('One saved change is too large to apply safely.')
    }
    totalBytes += byteLength
    if (totalBytes > MAX_TOTAL_PATCH_BYTES) {
      throw new ReviewPatchRequestError('The saved changes are too large to apply safely.')
    }
    patches.push(patch.endsWith('\n') ? patch : `${patch}\n`)
  }
  return patches
}

export type ReviewGitWorkspace = {
  cwd: string
  root: string
  commonGitDirectory: string
  gitSafetyArgs: string[]
}

async function readGitSafetyArgs(root: string): Promise<string[]> {
  const result = await runGit(
    root,
    ['config', '--includes', '--name-only', '--get-regexp', '^filter\\..*\\.(process|smudge|clean|required)$'],
    '',
    REVIEW_GIT_ENVIRONMENT,
  )
  if (result.code !== 0 && result.code !== 1) {
    throw new ReviewPatchRequestError('The repository filter configuration could not be inspected safely.')
  }
  const driverNames = new Set<string>()
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.trim().match(/^filter\.(.+)\.(?:process|smudge|clean|required)$/iu)
    if (match?.[1]) driverNames.add(match[1])
  }
  if (driverNames.size > 64) {
    throw new ReviewPatchRequestError('The repository defines too many content filters to apply changes safely.')
  }
  const args = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NULL_DEVICE_PATH}`]
  for (const driverName of driverNames) {
    args.push(
      '-c', `filter.${driverName}.process=`,
      '-c', `filter.${driverName}.smudge=`,
      '-c', `filter.${driverName}.clean=`,
      '-c', `filter.${driverName}.required=false`,
    )
  }
  return args
}

export async function resolveReviewGitWorkspace(cwd: unknown): Promise<ReviewGitWorkspace> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new ReviewPatchRequestError('The thread workspace is unavailable.')
  }

  let workspace: string
  try {
    const details = await stat(cwd)
    if (!details.isDirectory()) throw new Error('Not a directory')
    workspace = await realpath(cwd)
  } catch {
    throw new ReviewPatchRequestError('The thread workspace no longer exists.')
  }
  if (workspace !== resolve(cwd)) {
    throw new ReviewPatchRequestError('Review Changes does not modify symlinked thread workspaces.')
  }

  const rootResult = await runGit(workspace, ['rev-parse', '--show-toplevel'])
  if (rootResult.code !== 0) {
    throw new ReviewPatchRequestError('Undo requires a Git repository.')
  }

  const root = await realpath(rootResult.stdout.trim())
  const workspaceFromRoot = relative(root, workspace)
  if (workspaceFromRoot.startsWith('..') || isAbsolute(workspaceFromRoot)) {
    throw new ReviewPatchRequestError('The thread workspace is outside its Git repository.')
  }
  const commonDirectoryResult = await runGit(workspace, ['rev-parse', '--git-common-dir'])
  if (commonDirectoryResult.code !== 0 || !commonDirectoryResult.stdout.trim()) {
    throw new ReviewPatchRequestError('The Git repository metadata is unavailable.')
  }
  const commonGitDirectory = await realpath(resolve(workspace, commonDirectoryResult.stdout.trim()))
  const gitSafetyArgs = await readGitSafetyArgs(root)
  return { cwd: workspace, root, commonGitDirectory, gitSafetyArgs }
}

export async function canonicalizeReviewCommandWorkingDirectories<T>(
  workspace: ReviewGitWorkspace,
  items: T[],
): Promise<T[]> {
  const canonicalItems = [...items]
  const canonicalizedCommandIndexes = new Set<number>()
  let activeCommandIndex = -1

  for (const [index, value] of items.entries()) {
    const item = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
    if (item?.type === 'commandExecution') {
      activeCommandIndex = index
      continue
    }
    if (
      item?.type !== 'fileChange'
      || item.status !== 'completed'
      || activeCommandIndex < 0
      || canonicalizedCommandIndexes.has(activeCommandIndex)
    ) continue

    const commandValue = items[activeCommandIndex]
    const command = commandValue && typeof commandValue === 'object' && !Array.isArray(commandValue)
      ? commandValue as Record<string, unknown>
      : null
    if (!command || typeof command.cwd !== 'string' || !isAbsolute(command.cwd)) {
      throw new ReviewPatchRequestError('A command preceding the saved changes has no safe working directory.', 409)
    }
    const lexicalCwd = resolve(command.cwd)
    let canonicalCwd: string
    try {
      canonicalCwd = await realpath(command.cwd)
    } catch {
      throw new ReviewPatchRequestError('A command working directory no longer exists.', 409)
    }
    const fromRoot = relative(workspace.root, canonicalCwd)
    if (
      canonicalCwd !== lexicalCwd
      || fromRoot.startsWith('..')
      || isAbsolute(fromRoot)
    ) {
      throw new ReviewPatchRequestError(
        'A command working directory cannot be resolved safely inside this repository.',
        409,
      )
    }
    canonicalItems[activeCommandIndex] = { ...command, cwd: canonicalCwd } as T
    canonicalizedCommandIndexes.add(activeCommandIndex)
  }
  return canonicalItems
}

function readSafeAffectedPath(
  rawPath: string,
  options: { expectedPrefix?: 'a/' | 'b/'; allowDevNull?: boolean } = {},
): string | null {
  if (options.allowDevNull && rawPath === '/dev/null') return null
  if (
    !rawPath ||
    rawPath !== rawPath.trim() ||
    /[\\\u0000-\u001f\u007f]/u.test(rawPath)
  ) {
    throw new ReviewPatchRequestError('The saved changes contain an unsafe file path.')
  }

  let path = rawPath
  if (options.expectedPrefix) {
    if (!path.startsWith(options.expectedPrefix)) {
      throw new ReviewPatchRequestError('The saved changes contain an unsafe file path.')
    }
    path = path.slice(options.expectedPrefix.length)
  }

  const segments = path.split('/')
  if (
    !path ||
    path !== path.trim() ||
    isAbsolute(path) ||
    segments.some((segment) => (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.toLowerCase() === '.git'
    ))
  ) {
    throw new ReviewPatchRequestError('The saved changes contain an unsafe file path.')
  }
  return path
}

function readAffectedPaths(patches: string[]): string[] {
  const paths = new Set<string>()
  for (const patch of patches) {
    let inHunk = false
    for (const line of patch.split(/\r?\n/u)) {
      if (line.startsWith('diff --git ')) {
        inHunk = false
        continue
      }
      if (line.startsWith('@@ ')) {
        inHunk = true
        continue
      }
      if (inHunk) continue

      let path: string | null = null
      if (line.startsWith('--- ')) {
        path = readSafeAffectedPath(line.slice(4), {
          expectedPrefix: line.slice(4) === '/dev/null' ? undefined : 'a/',
          allowDevNull: true,
        })
      } else if (line.startsWith('+++ ')) {
        path = readSafeAffectedPath(line.slice(4), {
          expectedPrefix: line.slice(4) === '/dev/null' ? undefined : 'b/',
          allowDevNull: true,
        })
      } else if (line.startsWith('rename from ')) {
        path = readSafeAffectedPath(line.slice('rename from '.length))
      } else if (line.startsWith('rename to ')) {
        path = readSafeAffectedPath(line.slice('rename to '.length))
      }
      if (path) paths.add(path)
    }
  }
  if (paths.size === 0) {
    throw new ReviewPatchRequestError('The saved changes do not name any files.')
  }
  return [...paths]
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT',
  )
}

async function ensureSafeParentDirectories(
  root: string,
  path: string,
  createMissing: boolean,
  missingDirectories?: Set<string>,
): Promise<void> {
  const segments = path.split('/').slice(0, -1)
  let currentRelativePath = ''
  for (const segment of segments) {
    currentRelativePath = currentRelativePath ? `${currentRelativePath}/${segment}` : segment
    const currentPath = resolve(root, currentRelativePath)
    try {
      const details = await lstat(currentPath)
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new ReviewPatchRequestError('A changed file has an unsafe parent directory.', 409)
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      missingDirectories?.add(currentRelativePath)
      if (!createMissing) continue
      try {
        await mkdir(currentPath)
      } catch (mkdirError) {
        if (!isMissingPathError(mkdirError) && (mkdirError as { code?: unknown })?.code !== 'EEXIST') {
          throw mkdirError
        }
      }
      const createdDetails = await lstat(currentPath)
      if (!createdDetails.isDirectory() || createdDetails.isSymbolicLink()) {
        throw new ReviewPatchRequestError('A changed file has an unsafe parent directory.', 409)
      }
    }
  }
}

type WorktreeExtendedAttribute = { name: string; valueHex: string }

async function ensureSafeDarwinFileFlags(path: string): Promise<void> {
  if (process.platform !== 'darwin') return
  const result = await runMetadataCommand('/usr/bin/stat', ['-f', '%Sf', path])
  if (result.code !== 0) {
    throw new ReviewPatchRequestError('A changed file\'s flags could not be inspected safely.', 409)
  }
  const flags = result.stdout.trim()
  if (flags !== '-') {
    throw new ReviewPatchRequestError('Review Changes does not modify files with BSD flags.', 409)
  }
}

async function readDarwinExtendedAttributes(
  path: string,
  budget: WorktreeSnapshotBudget,
): Promise<WorktreeExtendedAttribute[]> {
  if (process.platform !== 'darwin') return []

  const aclResult = await runMetadataCommand('/bin/ls', ['-led', path])
  if (aclResult.code !== 0) {
    throw new ReviewPatchRequestError('A changed file\'s access controls could not be inspected safely.', 409)
  }
  const firstLine = aclResult.stdout.split('\n')[0] ?? ''
  const hasAclEntries = aclResult.stdout
    .split(/\r?\n/u)
    .slice(1)
    .some((line) => /^\s*\d+:/u.test(line))
  if (firstLine.charAt(10) === '+' || hasAclEntries) {
    throw new ReviewPatchRequestError('Review Changes does not modify files with access-control lists.', 409)
  }

  const namesResult = await runMetadataCommand('/usr/bin/xattr', [path])
  if (namesResult.code !== 0) {
    throw new ReviewPatchRequestError('A changed file\'s extended attributes could not be inspected safely.', 409)
  }
  const names = namesResult.stdout.split(/\r?\n/u).filter(Boolean)
  if (budget.xattrs + names.length > MAX_SNAPSHOT_XATTRS) {
    throw new ReviewPatchRequestError('These files contain too many extended attributes to preserve safely.', 409)
  }
  const attributes: WorktreeExtendedAttribute[] = []
  for (const name of names) {
    if (name.startsWith('-') || name !== name.trim() || /[\0\r\n]/u.test(name)) {
      throw new ReviewPatchRequestError('A changed file has an unsupported extended attribute.', 409)
    }
    const valueResult = await runMetadataCommand('/usr/bin/xattr', ['-px', name, path])
    if (valueResult.code !== 0) {
      throw new ReviewPatchRequestError('A changed file\'s extended attributes changed during inspection.', 409)
    }
    const valueHex = valueResult.stdout.replace(/\s/gu, '').toLowerCase()
    if (!/^(?:[0-9a-f]{2})*$/u.test(valueHex)) {
      throw new ReviewPatchRequestError('A changed file has an unsupported extended attribute.', 409)
    }
    const byteLength = valueHex.length / 2
    if (byteLength > MAX_XATTR_BYTES) {
      throw new ReviewPatchRequestError('A changed file has an extended attribute that is too large to preserve safely.', 409)
    }
    budget.xattrs += 1
    budget.xattrBytes += byteLength
    if (budget.xattrs > MAX_SNAPSHOT_XATTRS || budget.xattrBytes > MAX_SNAPSHOT_XATTR_BYTES) {
      throw new ReviewPatchRequestError('These files contain too much extended metadata to preserve safely.', 409)
    }
    attributes.push({ name, valueHex })
  }
  return attributes
}

async function restoreDarwinExtendedAttributes(
  path: string,
  attributes: WorktreeExtendedAttribute[],
): Promise<void> {
  if (process.platform !== 'darwin') return
  const aclResult = await runMetadataCommand('/bin/chmod', ['-N', path])
  if (aclResult.code !== 0) throw new Error('File access controls could not be restored.')
  const cleared = await runMetadataCommand('/usr/bin/xattr', ['-c', path])
  if (cleared.code !== 0) throw new Error('File extended attributes could not be restored.')
  for (const attribute of attributes) {
    const restored = await runMetadataCommand(
      '/usr/bin/xattr',
      ['-wx', attribute.name, attribute.valueHex, path],
    )
    if (restored.code !== 0) throw new Error('File extended attributes could not be restored.')
  }
}

function validateRestorableOwnership(details: { uid: number; gid: number }): void {
  const currentUid = process.getuid?.()
  if (currentUid === undefined || currentUid === 0) return
  if (details.uid !== currentUid) {
    throw new ReviewPatchRequestError('Review Changes does not modify files owned by another user.', 409)
  }
  const availableGroups = new Set([process.getgid?.(), ...(process.getgroups?.() ?? [])])
  if (!availableGroups.has(details.gid)) {
    throw new ReviewPatchRequestError('Review Changes cannot safely preserve a changed file\'s group ownership.', 409)
  }
}

type WorktreeSnapshotEntry =
  | { path: string; kind: 'missing' }
  | {
      path: string
      kind: 'file'
      backupPath: string
      mode: number
      uid: number
      gid: number
      atimeMs: number
      mtimeMs: number
      xattrs: WorktreeExtendedAttribute[]
    }

type WorktreeSnapshot = {
  directory: string
  entries: WorktreeSnapshotEntry[]
  missingDirectories: string[]
}

type WorktreeSnapshotBudget = {
  bytes: number
  paths: number
  xattrs: number
  xattrBytes: number
}

type WorktreeAccessTimeSnapshot = Map<string, number>

async function inspectSnapshotPath(root: string, path: string) {
  await ensureSafeParentDirectories(root, path, false)
  try {
    const details = await lstat(resolve(root, path))
    if (details.isSymbolicLink()) {
      throw new ReviewPatchRequestError('Review Changes does not modify symlinked files.', 409)
    }
    if (!details.isFile()) {
      throw new ReviewPatchRequestError('Review Changes only modifies regular files.', 409)
    }
    if (details.nlink > 1) {
      throw new ReviewPatchRequestError('Review Changes does not modify hard-linked files.', 409)
    }
    validateRestorableOwnership(details)
    await ensureSafeDarwinFileFlags(resolve(root, path))
    return details
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

async function validateWorktreeSnapshotBudget(
  workspace: ReviewGitWorkspace,
  patches: string[],
): Promise<WorktreeAccessTimeSnapshot> {
  const paths = readAffectedPaths(patches)
  if (paths.length > MAX_SNAPSHOT_PATHS) {
    throw new ReviewPatchRequestError('This change touches too many files to update transactionally.', 409)
  }
  let bytes = 0
  const accessTimes: WorktreeAccessTimeSnapshot = new Map()
  for (const path of paths) {
    const details = await inspectSnapshotPath(workspace.root, path)
    if (details?.isFile()) {
      bytes += details.size
      accessTimes.set(path, details.atimeMs)
    }
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new ReviewPatchRequestError('The current files are too large to snapshot safely.', 409)
    }
  }
  return accessTimes
}

async function restoreWorktreeAccessTimes(
  workspace: ReviewGitWorkspace,
  accessTimes: WorktreeAccessTimeSnapshot,
): Promise<void> {
  for (const [path, atimeMs] of accessTimes) {
    const target = resolve(workspace.root, path)
    const details = await lstat(target)
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new ReviewPatchRequestError('A changed file moved during safety checks.', 409)
    }
    await utimes(target, atimeMs / 1000, details.mtimeMs / 1000)
  }
}

async function captureWorktreeSnapshot(
  workspace: ReviewGitWorkspace,
  patch: string,
  budget: WorktreeSnapshotBudget,
): Promise<WorktreeSnapshot> {
  const paths = readAffectedPaths([patch])
  const directory = await mkdtemp(join(tmpdir(), 'codexui-review-snapshot-'))
  const entries: WorktreeSnapshotEntry[] = []
  const missingDirectories = new Set<string>()
  try {
    for (const [index, path] of paths.entries()) {
      budget.paths += 1
      if (budget.paths > MAX_SNAPSHOT_PATHS) {
        throw new ReviewPatchRequestError('This change touches too many files to update transactionally.', 409)
      }
      await ensureSafeParentDirectories(workspace.root, path, false, missingDirectories)
      const target = resolve(workspace.root, path)
      let details: Awaited<ReturnType<typeof lstat>>
      try {
        details = await lstat(target)
      } catch (error) {
        if (!isMissingPathError(error)) throw error
        entries.push({ path, kind: 'missing' })
        continue
      }
      if (details.isSymbolicLink()) {
        throw new ReviewPatchRequestError('Review Changes does not modify symlinked files.', 409)
      }
      if (!details.isFile()) {
        throw new ReviewPatchRequestError('Review Changes only modifies regular files.', 409)
      }
      if (details.nlink > 1) {
        throw new ReviewPatchRequestError('Review Changes does not modify hard-linked files.', 409)
      }
      validateRestorableOwnership(details)
      await ensureSafeDarwinFileFlags(target)
      budget.bytes += details.size
      if (budget.bytes > MAX_SNAPSHOT_BYTES) {
        throw new ReviewPatchRequestError('The current files are too large to snapshot safely.', 409)
      }
      const backupPath = join(directory, index.toString())
      const xattrs = await readDarwinExtendedAttributes(target, budget)
      await copyFile(target, backupPath)
      entries.push({
        path,
        kind: 'file',
        backupPath,
        mode: details.mode & 0o7777,
        uid: details.uid,
        gid: details.gid,
        atimeMs: details.atimeMs,
        mtimeMs: details.mtimeMs,
        xattrs,
      })
    }
    return {
      directory,
      entries,
      missingDirectories: [...missingDirectories].sort((left, right) => right.length - left.length),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function removeSnapshotTarget(target: string): Promise<void> {
  try {
    const details = await lstat(target)
    if (details.isDirectory() && !details.isSymbolicLink()) await rmdir(target)
    else await unlink(target)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
}

async function restoreWorktreeSnapshot(
  workspace: ReviewGitWorkspace,
  snapshot: WorktreeSnapshot,
): Promise<boolean> {
  let restoredAll = true
  for (const entry of snapshot.entries) {
    const target = resolve(workspace.root, entry.path)
    try {
      if (entry.kind === 'missing') {
        await removeSnapshotTarget(target)
        continue
      }
      await ensureSafeParentDirectories(workspace.root, entry.path, true)
      let existing: Awaited<ReturnType<typeof lstat>> | null = null
      try {
        existing = await lstat(target)
      } catch (error) {
        if (!isMissingPathError(error)) throw error
      }
      if (existing?.isFile() && !existing.isSymbolicLink()) {
        await chmod(target, 0o600)
      } else if (existing) {
        await removeSnapshotTarget(target)
      }
      await copyFile(entry.backupPath, target)
      await chown(target, entry.uid, entry.gid)
      await restoreDarwinExtendedAttributes(target, entry.xattrs)
      await chmod(target, entry.mode)
      await utimes(target, entry.atimeMs / 1000, entry.mtimeMs / 1000)
    } catch {
      restoredAll = false
    }
  }
  for (const path of snapshot.missingDirectories) {
    try {
      await rmdir(resolve(workspace.root, path))
    } catch (error) {
      if (!isMissingPathError(error)) restoredAll = false
    }
  }
  return restoredAll
}

async function cleanupWorktreeSnapshots(snapshots: WorktreeSnapshot[]): Promise<void> {
  await Promise.all(snapshots.map(async (snapshot) => {
    await rm(snapshot.directory, { recursive: true, force: true })
  }))
}

async function restoreWorktreeSnapshots(
  workspace: ReviewGitWorkspace,
  snapshots: WorktreeSnapshot[],
): Promise<boolean> {
  let restoredAll = true
  for (const snapshot of [...snapshots].reverse()) {
    if (!await restoreWorktreeSnapshot(workspace, snapshot)) restoredAll = false
  }
  return restoredAll
}

async function preserveAppliedFileMetadata(
  workspace: ReviewGitWorkspace,
  snapshot: WorktreeSnapshot,
  patch: string,
  reverse: boolean,
): Promise<void> {
  const destinationBySource = new Map<string, { path: string; preserveTimestamps: boolean }>()
  for (const move of readPatchMoves(patch)) {
    destinationBySource.set(reverse ? move.to : move.from, {
      path: reverse ? move.from : move.to,
      preserveTimestamps: move.preserveTimestamps,
    })
  }

  for (const entry of snapshot.entries) {
    if (entry.kind !== 'file') continue
    const move = destinationBySource.get(entry.path)
    const destination = move?.path ?? entry.path
    const target = resolve(workspace.root, destination)
    const details = await lstat(target)
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new ReviewPatchRequestError('A changed file could not retain its original metadata.', 409)
    }
    await chown(target, entry.uid, entry.gid)
    await restoreDarwinExtendedAttributes(target, entry.xattrs)
    await chmod(target, entry.mode)
    if (move?.preserveTimestamps) {
      await utimes(target, entry.atimeMs / 1000, entry.mtimeMs / 1000)
    }
  }
}

async function preflightPatchSequence(
  workspace: ReviewGitWorkspace,
  patches: string[],
  reversePatch: boolean,
): Promise<CommandResult | null> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codexui-review-'))
  const objectsDirectory = join(temporaryDirectory, 'objects')
  const indexPath = join(temporaryDirectory, 'index')
  await mkdir(objectsDirectory, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...REVIEW_GIT_ENVIRONMENT,
    GIT_INDEX_FILE: indexPath,
    GIT_OBJECT_DIRECTORY: objectsDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(workspace.commonGitDirectory, 'objects'),
  }

  try {
    let initialized = await runGit(workspace.cwd, [...workspace.gitSafetyArgs, 'read-tree', 'HEAD'], '', env)
    if (initialized.code !== 0) {
      initialized = await runGit(workspace.cwd, [...workspace.gitSafetyArgs, 'read-tree', '--empty'], '', env)
    }
    if (initialized.code !== 0) return initialized

    const affectedPaths = readAffectedPaths(patches)
    const existingPaths: string[] = []
    const missingPaths: string[] = []
    for (const path of affectedPaths) {
      try {
        await lstat(resolve(workspace.cwd, path))
        existingPaths.push(path)
      } catch {
        missingPaths.push(path)
      }
    }

    if (existingPaths.length > 0) {
      const staged = await runGit(
        workspace.cwd,
        [...workspace.gitSafetyArgs, 'add', '-f', '--', ...existingPaths],
        '',
        env,
      )
      if (staged.code !== 0) return staged
    }
    for (const path of missingPaths) {
      const removed = await runGit(
        workspace.cwd,
        [...workspace.gitSafetyArgs, 'update-index', '--force-remove', '--', path],
        '',
        env,
      )
      if (removed.code !== 0) return removed
    }

    const directionArgs = reversePatch ? ['--reverse'] : []
    for (const patch of patches) {
      const applied = await runGit(
        workspace.cwd,
        [...workspace.gitSafetyArgs, 'apply', '--cached', '--verbose', ...directionArgs, '--whitespace=nowarn', '-'],
        patch,
        env,
      )
      if (applied.code !== 0) return applied
      const adjusted = adjustedHunkError(applied)
      if (adjusted) return adjusted
    }
    return null
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export async function withRepositoryMutationLock<T>(
  repositoryKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = repositoryMutationTailByGitDirectory.get(repositoryKey) ?? Promise.resolve()
  let release = (): void => {}
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate
  })
  const tail = previous.catch(() => {}).then(() => gate)
  repositoryMutationTailByGitDirectory.set(repositoryKey, tail)

  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    if (repositoryMutationTailByGitDirectory.get(repositoryKey) === tail) {
      repositoryMutationTailByGitDirectory.delete(repositoryKey)
    }
  }
}

export async function applyReviewPatchSequence(input: {
  cwd: unknown
  patches: unknown
  reverse: unknown
}, testHooks: {
  beforeApplyBatch?: (index: number) => Promise<void> | void
} = {}): Promise<ReviewPatchResult> {
  const workspace = await resolveReviewGitWorkspace(input.cwd)
  const patches = validatePatches(input.patches)
  if (typeof input.reverse !== 'boolean') {
    throw new ReviewPatchRequestError('The requested change action is invalid.')
  }

  const reverse = input.reverse
  const action = reverse ? 'undo' : 'reapply'
  const orderedPatches = reverse ? [...patches].reverse() : patches
  const directionArgs = reverse ? ['--reverse'] : []
  return await withRepositoryMutationLock(workspace.commonGitDirectory, async () => {
    const executionCwd = workspace.root
    const accessTimes = await validateWorktreeSnapshotBudget(workspace, orderedPatches)
    let preflightError: CommandResult | null
    let oppositePreflightError: CommandResult | null
    try {
      preflightError = await preflightPatchSequence(
        { ...workspace, cwd: executionCwd },
        orderedPatches,
        reverse,
      )
      const oppositeOrderedPatches = reverse ? patches : [...patches].reverse()
      oppositePreflightError = await preflightPatchSequence(
        { ...workspace, cwd: executionCwd },
        oppositeOrderedPatches,
        !reverse,
      )
    } finally {
      await restoreWorktreeAccessTimes(workspace, accessTimes)
    }
    if (!preflightError && !oppositePreflightError) {
      return {
        status: 'failed',
        action,
        error: 'The current files match both change directions, so their state is ambiguous.',
        state: 'unknown',
      }
    }
    if (preflightError) {
      const state = oppositePreflightError
        ? 'unknown'
        : reverse
          ? 'undone'
          : 'applied'
      return { status: 'failed', action, error: compactGitError(preflightError), state }
    }

    const snapshots: WorktreeSnapshot[] = []
    const snapshotBudget: WorktreeSnapshotBudget = {
      bytes: 0,
      paths: 0,
      xattrs: 0,
      xattrBytes: 0,
    }
    try {
      for (const [index, patch] of orderedPatches.entries()) {
        let applied: CommandResult
        try {
          await testHooks.beforeApplyBatch?.(index)
          snapshots.push(await captureWorktreeSnapshot(workspace, patch, snapshotBudget))
          applied = await runGit(
            executionCwd,
            [...workspace.gitSafetyArgs, 'apply', '--verbose', ...directionArgs, '--whitespace=nowarn', '-'],
            patch,
            REVIEW_GIT_ENVIRONMENT,
          )
        } catch (error) {
          const restored = await restoreWorktreeSnapshots(workspace, snapshots)
          const detail = error instanceof Error ? error.message : 'Git could not apply the saved changes.'
          return {
            status: 'failed',
            action,
            error: restored ? detail : `${detail}\nSome files may have changed; review the worktree before retrying.`,
          }
        }
        const adjusted = adjustedHunkError(applied)
        if (applied.code !== 0 || adjusted) {
          const restored = await restoreWorktreeSnapshots(workspace, snapshots)
          const detail = compactGitError(adjusted ?? applied)
          return {
            status: 'failed',
            action,
            error: restored ? detail : `${detail}\nSome files may have changed; review the worktree before retrying.`,
          }
        }
        try {
          const currentSnapshot = snapshots.at(-1)
          if (!currentSnapshot) throw new Error('The file metadata snapshot is unavailable.')
          await preserveAppliedFileMetadata(workspace, currentSnapshot, patch, reverse)
        } catch (error) {
          const restored = await restoreWorktreeSnapshots(workspace, snapshots)
          const detail = error instanceof Error ? error.message : 'File metadata could not be preserved.'
          return {
            status: 'failed',
            action,
            error: restored ? detail : `${detail}\nSome files may have changed; review the worktree before retrying.`,
          }
        }
      }
      return { status: 'success', action }
    } finally {
      await cleanupWorktreeSnapshots(snapshots)
    }
  })
}
