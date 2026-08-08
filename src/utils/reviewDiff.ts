import type {
  ReviewChangeKind,
  ReviewChangesData,
  ReviewDiffFile,
  ReviewDiffLine,
  ReviewPatchBatch,
  ReviewPatchChange,
} from '../types/codex'

type FileChangeLike = {
  type?: unknown
  id?: unknown
  status?: unknown
  changes?: unknown
  cwd?: unknown
}

type ParsedHunkHeader = {
  oldLine: number
  newLine: number
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u
const MAX_REVIEW_FILES = 200
const MAX_REVIEW_LINES_PER_FILE = 1200
const MAX_REVIEW_LINES_PER_TURN = 4000
const MAX_REVIEW_CHARACTERS_PER_LINE = 8000
const MAX_REVIEW_CHARACTERS_PER_TURN = 500_000
const MAX_REVIEW_PATCH_BATCHES = 128
const MAX_REVIEW_CHANGE_COUNT = 2048
const MAX_REVIEW_PATCH_BYTES = 2 * 1024 * 1024
const MAX_REVIEW_TOTAL_PATCH_BYTES = 12 * 1024 * 1024

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, '\n')
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

export class ReviewDiffDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewDiffDataError'
  }
}

function absoluteSegments(value: string): string[] | null {
  if (
    !value.startsWith('/')
    || value !== value.trim()
    || /[\0\r\n\t\\]/u.test(value)
  ) return null
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments
}

function canonicalAbsolutePath(value: string): string {
  const segments = absoluteSegments(value)
  return segments ? `/${segments.join('/')}` : ''
}

function isCwdWithinRoot(cwd: string, root: string): boolean {
  const cwdSegments = absoluteSegments(cwd)
  const rootSegments = absoluteSegments(root)
  if (!cwdSegments || !rootSegments || cwdSegments.length < rootSegments.length) return false
  return rootSegments.every((segment, index) => cwdSegments[index] === segment)
}

function logicalRelativePath(value: string): string {
  if (value.startsWith('/')) return ''
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return ''
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.join('/')
}

function relativePathFromRoot(targetSegments: string[], rootSegments: string[]): string {
  let commonLength = 0
  while (
    commonLength < targetSegments.length
    && commonLength < rootSegments.length
    && targetSegments[commonLength] === rootSegments[commonLength]
  ) commonLength += 1
  return [
    ...Array.from({ length: rootSegments.length - commonLength }, () => '..'),
    ...targetSegments.slice(commonLength),
  ].join('/')
}

function parentPath(value: string): string {
  const separatorIndex = value.lastIndexOf('/')
  return separatorIndex < 0 ? '' : value.slice(0, separatorIndex)
}

function normalizePath(
  value: unknown,
  cwd = '',
  root = cwd,
  includeOutsideRoot = false,
): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    /[\0\r\n\t\\]/u.test(value)
  ) return ''
  if (!cwd && !root) return logicalRelativePath(value)
  const cwdSegments = absoluteSegments(cwd)
  const rootSegments = absoluteSegments(root)
  if (!cwdSegments || !rootSegments) return ''
  const targetSegments = value.startsWith('/') ? [] : [...cwdSegments]
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (targetSegments.length === 0) return ''
      targetSegments.pop()
    } else {
      targetSegments.push(segment)
    }
  }
  const isInsideRoot = targetSegments.length > rootSegments.length
    && rootSegments.every((segment, index) => targetSegments[index] === segment)
  if (isInsideRoot) return targetSegments.slice(rootSegments.length).join('/')
  return includeOutsideRoot ? relativePathFromRoot(targetSegments, rootSegments) : ''
}

function readChangeKind(
  value: unknown,
  cwd: string,
  root: string,
  includeOutsideRoot: boolean,
): { kind: ReviewChangeKind; movePath?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type === 'add' || record.type === 'delete') return { kind: record.type }
  if (record.type !== 'update') return null
  if (record.move_path === null || record.move_path === undefined) return { kind: 'update' }
  const movePath = normalizePath(record.move_path, cwd, root, includeOutsideRoot)
  return movePath ? { kind: 'update', movePath } : null
}

function readPatchChange(
  value: unknown,
  cwd: string,
  root: string,
  includeOutsideRoot: boolean,
): ReviewPatchChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const path = normalizePath(record.path, cwd, root, includeOutsideRoot)
  const parsedKind = readChangeKind(record.kind, cwd, root, includeOutsideRoot)
  if (!path || !parsedKind || typeof record.diff !== 'string') return null
  if (parsedKind.kind === 'update' && !parsedKind.movePath && record.diff.length === 0) return null
  return {
    path,
    kind: parsedKind.kind,
    ...(parsedKind.movePath ? { movePath: parsedKind.movePath } : {}),
    diff: record.diff,
  }
}

function isStrictUpdateDiffSafe(change: ReviewPatchChange): boolean {
  if (change.kind !== 'update') return true
  if (change.diff.length === 0) return Boolean(change.movePath)

  const nextPath = change.movePath || change.path
  const expectedGitHeader = `diff --git a/${change.path} b/${nextPath}`
  const expectedOldHeader = `--- a/${change.path}`
  const expectedNewHeader = `+++ b/${nextPath}`
  const lines = normalizeLineEndings(change.diff.replace(/^(?:\r?\n)+/u, '')).split('\n')
  if (lines.at(-1) === '') lines.pop()
  let inHunk = false
  let sawHunk = false
  let sawGitHeader = false
  let sawOldHeader = false
  let sawNewHeader = false

  for (const line of lines) {
    if (parseHunkHeader(line)) {
      inHunk = true
      sawHunk = true
      continue
    }
    if (line.startsWith('@@')) return false
    if (inHunk) {
      if (
        !line.startsWith(' ')
        && !line.startsWith('+')
        && !line.startsWith('-')
        && !line.startsWith('\\ No newline at end of file')
      ) return false
      continue
    }
    if (!line) continue
    if (line === expectedGitHeader && !sawGitHeader) {
      sawGitHeader = true
      continue
    }
    if (line === expectedOldHeader && !sawOldHeader) {
      sawOldHeader = true
      continue
    }
    if (line === expectedNewHeader && !sawNewHeader) {
      sawNewHeader = true
      continue
    }
    if (line.startsWith('index ')) continue
    return false
  }

  if (!sawHunk || sawOldHeader !== sawNewHeader) return false
  if (sawGitHeader && (!sawOldHeader || !sawNewHeader)) return false
  return true
}

function addOrDeletePatch(change: ReviewPatchChange): string {
  const content = change.diff
  const hasTrailingNewline = content.endsWith('\n')
  const sourceLines = content.length === 0 ? [] : content.split('\n')
  if (hasTrailingNewline) sourceLines.pop()
  const lineCount = sourceLines.length
  let body = sourceLines
    .map((line) => `${change.kind === 'add' ? '+' : '-'}${line}`)
    .join('\n')
  if (lineCount > 0 && !hasTrailingNewline) {
    body = `${body}\n\\ No newline at end of file`
  }
  const hunk = lineCount === 0
    ? ''
    : change.kind === 'add'
      ? `@@ -0,0 +1,${lineCount.toString()} @@\n${body}`
      : `@@ -1,${lineCount.toString()} +0,0 @@\n${body}`
  const header = change.kind === 'add'
    ? [
        `diff --git a/${change.path} b/${change.path}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${change.path}`,
      ]
    : [
        `diff --git a/${change.path} b/${change.path}`,
        'deleted file mode 100644',
        `--- a/${change.path}`,
        '+++ /dev/null',
      ]
  return [...header, ...(hunk ? [hunk] : [])].join('\n')
}

export function buildReviewPatch(change: ReviewPatchChange): string {
  if (change.kind !== 'update') return addOrDeletePatch(change)

  const nextPath = change.movePath || change.path
  const rawDiff = change.diff.replace(/^(?:\r?\n)+/u, '')
  if (!rawDiff && change.movePath) {
    return [
      `diff --git a/${change.path} b/${nextPath}`,
      'similarity index 100%',
      `rename from ${change.path}`,
      `rename to ${nextPath}`,
    ].join('\n')
  }

  const firstHunkIndex = rawDiff.search(/^@@\s/mu)
  const headerRegion = firstHunkIndex >= 0 ? rawDiff.slice(0, firstHunkIndex) : rawDiff
  const hasFileHeaders = /^---\s/mu.test(headerRegion) && /^\+\+\+\s/mu.test(headerRegion)
  const hasGitHeader = /^diff --git\s/mu.test(headerRegion)
  const body = hasFileHeaders || (hasGitHeader && firstHunkIndex < 0)
    ? rawDiff
    : `--- a/${change.path}\n+++ b/${nextPath}\n${rawDiff}`
  return `${hasGitHeader ? '' : `diff --git a/${change.path} b/${nextPath}\n`}${body}`
}

function parseHunkHeader(value: string): ParsedHunkHeader | null {
  const match = value.match(HUNK_HEADER)
  if (!match) return null
  return {
    oldLine: Number.parseInt(match[1] ?? '0', 10),
    newLine: Number.parseInt(match[2] ?? '0', 10),
  }
}

function* iteratePatchLines(value: string): Generator<[number, string]> {
  let lineStart = 0
  let lineIndex = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code !== 10 && code !== 13) continue
    yield [lineIndex, value.slice(lineStart, index)]
    lineIndex += 1
    if (code === 13 && value.charCodeAt(index + 1) === 10) index += 1
    lineStart = index + 1
  }
  if (lineStart < value.length) yield [lineIndex, value.slice(lineStart)]
}

function isRedundantPatchHeader(value: string): boolean {
  return (
    value.startsWith('diff --git ') ||
    value.startsWith('index ') ||
    value.startsWith('--- ') ||
    value.startsWith('+++ ') ||
    value.startsWith('new file mode ') ||
    value.startsWith('deleted file mode ') ||
    value.startsWith('old mode ') ||
    value.startsWith('new mode ') ||
    value.startsWith('similarity index ') ||
    value.startsWith('dissimilarity index ') ||
    value.startsWith('rename from ') ||
    value.startsWith('rename to ') ||
    value.startsWith('copy from ') ||
    value.startsWith('copy to ')
  )
}

function parseFilePatch(
  change: ReviewPatchChange,
  patch: string,
  idPrefix: string,
  maxLines: number,
  maxCharacters: number,
): ReviewDiffFile {
  const lines: ReviewDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  let additions = 0
  let deletions = 0
  let totalLines = 0
  let retainedCharacters = 0
  let contentTruncated = false

  const appendLine = (line: ReviewDiffLine): void => {
    totalLines += 1
    if (lines.length >= maxLines || retainedCharacters >= maxCharacters) {
      contentTruncated = true
      return
    }
    const allowedCharacters = Math.min(
      MAX_REVIEW_CHARACTERS_PER_LINE,
      maxCharacters - retainedCharacters,
    )
    if (line.text.length > allowedCharacters) {
      line.text = allowedCharacters > 1
        ? `${line.text.slice(0, allowedCharacters - 1)}…`
        : '…'
      contentTruncated = true
    }
    retainedCharacters += line.text.length
    lines.push(line)
  }

  for (const [index, rawLine] of iteratePatchLines(patch)) {
    const hunk = parseHunkHeader(rawLine)
    if (hunk) {
      oldLine = hunk.oldLine
      newLine = hunk.newLine
      inHunk = true
      appendLine({
        id: `${idPrefix}:${index.toString()}`,
        kind: 'meta',
        marker: '',
        text: rawLine,
        oldLine: null,
        newLine: null,
      })
      continue
    }

    if (!inHunk && isRedundantPatchHeader(rawLine)) continue
    if (!inHunk && rawLine === '') continue

    if (!inHunk || rawLine.startsWith('\\ No newline at end of file')) {
      appendLine({
        id: `${idPrefix}:${index.toString()}`,
        kind: 'meta',
        marker: '',
        text: rawLine,
        oldLine: null,
        newLine: null,
      })
      continue
    }

    if (rawLine.startsWith('+')) {
      additions += 1
      appendLine({
        id: `${idPrefix}:${index.toString()}`,
        kind: 'added',
        marker: '+',
        text: rawLine.slice(1),
        oldLine: null,
        newLine,
      })
      newLine += 1
      continue
    }

    if (rawLine.startsWith('-')) {
      deletions += 1
      appendLine({
        id: `${idPrefix}:${index.toString()}`,
        kind: 'removed',
        marker: '-',
        text: rawLine.slice(1),
        oldLine,
        newLine: null,
      })
      oldLine += 1
      continue
    }

    const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
    appendLine({
      id: `${idPrefix}:${index.toString()}`,
      kind: 'context',
      marker: ' ',
      text,
      oldLine,
      newLine,
    })
    oldLine += 1
    newLine += 1
  }

  if (totalLines === 0) {
    const text = change.movePath
      ? 'File renamed'
      : change.kind === 'add'
        ? 'Empty file added'
        : change.kind === 'delete'
          ? 'Empty file deleted'
          : 'File metadata changed'
    appendLine({
      id: `${idPrefix}:empty`,
      kind: 'meta',
      marker: '',
      text,
      oldLine: null,
      newLine: null,
    })
  }

  return {
    path: change.movePath || change.path,
    ...(change.movePath ? { previousPath: change.path } : {}),
    kind: change.kind,
    additions,
    deletions,
    lines,
    totalLines,
    isTruncated: contentTruncated || totalLines > lines.length,
  }
}

function parseWholeFileContent(
  change: ReviewPatchChange,
  idPrefix: string,
  maxLines: number,
  maxCharacters: number,
): ReviewDiffFile {
  const lines: ReviewDiffLine[] = []
  let additions = 0
  let deletions = 0
  let totalLines = 0
  let retainedCharacters = 0
  let contentTruncated = false
  let oldLine = 1
  let newLine = 1
  let contentLineCount = 0

  const appendLine = (line: ReviewDiffLine): void => {
    totalLines += 1
    if (lines.length >= maxLines || retainedCharacters >= maxCharacters) {
      contentTruncated = true
      return
    }
    const allowedCharacters = Math.min(
      MAX_REVIEW_CHARACTERS_PER_LINE,
      maxCharacters - retainedCharacters,
    )
    if (line.text.length > allowedCharacters) {
      line.text = allowedCharacters > 1
        ? `${line.text.slice(0, allowedCharacters - 1)}…`
        : '…'
      contentTruncated = true
    }
    retainedCharacters += line.text.length
    lines.push(line)
  }

  const hunkLine: ReviewDiffLine = {
    id: `${idPrefix}:hunk`,
    kind: 'meta',
    marker: '',
    text: change.kind === 'add'
      ? `@@ -0,0 +1,${Math.max(1, change.diff.length).toString()} @@`
      : `@@ -1,${Math.max(1, change.diff.length).toString()} +0,0 @@`,
    oldLine: null,
    newLine: null,
  }
  if (change.diff.length > 0) {
    appendLine(hunkLine)
  }

  const appendContentLine = (
    index: number,
    start: number,
    end: number,
    terminatedByLineFeed: boolean,
  ): void => {
    contentLineCount += 1
    if (change.kind === 'add') additions += 1
    else deletions += 1

    totalLines += 1
    if (lines.length >= maxLines || retainedCharacters >= maxCharacters) {
      contentTruncated = true
      return
    }
    const displayEnd = terminatedByLineFeed && change.diff.charCodeAt(end - 1) === 13
      ? end - 1
      : end
    const allowedCharacters = Math.min(
      MAX_REVIEW_CHARACTERS_PER_LINE,
      maxCharacters - retainedCharacters,
    )
    const sourceLength = Math.max(0, displayEnd - start)
    const retainedLength = Math.min(sourceLength, allowedCharacters)
    let text = change.diff.slice(start, start + retainedLength)
    if (sourceLength > retainedLength) {
      text = retainedLength > 1 ? `${text.slice(0, -1)}…` : '…'
      contentTruncated = true
    }
    retainedCharacters += text.length
    if (change.kind === 'add') {
      lines.push({
        id: `${idPrefix}:${index.toString()}`,
        kind: 'added',
        marker: '+',
        text,
        oldLine: null,
        newLine,
      })
      newLine += 1
    } else {
      lines.push({
        id: `${idPrefix}:${index.toString()}`,
        kind: 'removed',
        marker: '-',
        text,
        oldLine,
        newLine: null,
      })
      oldLine += 1
    }
  }

  let lineStart = 0
  let lineIndex = 0
  for (let index = 0; index < change.diff.length; index += 1) {
    if (change.diff.charCodeAt(index) !== 10) continue
    appendContentLine(lineIndex, lineStart, index, true)
    lineIndex += 1
    lineStart = index + 1
  }
  if (lineStart < change.diff.length) {
    appendContentLine(lineIndex, lineStart, change.diff.length, false)
  }

  if (change.diff.length > 0) {
    hunkLine.text = change.kind === 'add'
      ? `@@ -0,0 +1,${contentLineCount.toString()} @@`
      : `@@ -1,${contentLineCount.toString()} +0,0 @@`
  }

  if (change.diff && !change.diff.endsWith('\n')) {
    appendLine({
      id: `${idPrefix}:no-newline`,
      kind: 'meta',
      marker: '',
      text: '\\ No newline at end of file',
      oldLine: null,
      newLine: null,
    })
  }
  if (totalLines === 0) {
    appendLine({
      id: `${idPrefix}:empty`,
      kind: 'meta',
      marker: '',
      text: change.kind === 'add' ? 'Empty file added' : 'Empty file deleted',
      oldLine: null,
      newLine: null,
    })
  }

  return {
    path: change.path,
    kind: change.kind,
    additions,
    deletions,
    lines,
    totalLines,
    isTruncated: contentTruncated || totalLines > lines.length,
  }
}

function mergeDiffFile(target: ReviewDiffFile, source: ReviewDiffFile): void {
  target.lines.push(...source.lines)
  target.additions += source.additions
  target.deletions += source.deletions
  target.totalLines += source.totalLines
  target.isTruncated = target.isTruncated || source.isTruncated || target.totalLines > target.lines.length
  if (target.kind !== 'add') target.kind = source.kind
  if (source.previousPath) target.previousPath = source.previousPath
}

function reviewBatchFingerprint(values: unknown[]): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  let totalLength = 0
  const update = (value: unknown): void => {
    const text = typeof value === 'string'
      ? value
      : value === null
        ? '<null>'
        : `<${typeof value}>`
    const prefix = `${text.length.toString(36)}:`
    totalLength += prefix.length + text.length + 1
    const hashText = (part: string): void => {
      for (let index = 0; index < part.length; index += 1) {
        const code = part.charCodeAt(index)
        first = Math.imul(first ^ code, 0x01000193) >>> 0
        second = Math.imul(second ^ code, 0x85ebca6b) >>> 0
      }
    }
    hashText(prefix)
    hashText(text)
    hashText(';')
  }
  for (const value of values) {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
    const kind = record?.kind && typeof record.kind === 'object' && !Array.isArray(record.kind)
      ? record.kind as Record<string, unknown>
      : null
    update(record?.path)
    update(kind?.type)
    update(kind?.move_path)
    update(record?.diff)
  }
  return `${totalLength.toString(36)}:${first.toString(36)}:${second.toString(36)}`
}

export function buildReviewChanges(
  items: FileChangeLike[],
  cwd = '',
  root = cwd,
  options: {
    includeOutsideRoot?: boolean
    includePatchText?: boolean
    strict?: boolean
  } = {},
): ReviewChangesData | null {
  const strict = options.strict === true
  const includeOutsideRoot = options.includeOutsideRoot === true && !strict
  const patchBatches: ReviewPatchBatch[] = []
  const files: ReviewDiffFile[] = []
  const fileByPath = new Map<string, ReviewDiffFile>()
  const allPaths = new Set<string>()
  let currentCwd = cwd
  let additions = 0
  let deletions = 0
  let changeCount = 0
  let totalPatchBytes = 0
  let hasOversizedBatch = false
  let hasUnrecordedFileMode = false
  let hasUnrecordedDirectoryMode = false
  let hasTooManyChanges = false
  let remainingRenderedLines = MAX_REVIEW_LINES_PER_TURN
  let remainingRenderedCharacters = MAX_REVIEW_CHARACTERS_PER_TURN

  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'commandExecution') {
      if (typeof item.cwd === 'string' && item.cwd) {
        currentCwd = item.cwd
      } else if (strict) {
        currentCwd = ''
      }
      continue
    }
    const isFileChange = item.type === 'fileChange' || (!strict && item.type === undefined)
    if (!isFileChange || item.status !== 'completed') continue
    if (strict && !isCwdWithinRoot(currentCwd, root)) {
      throw new ReviewDiffDataError('A completed file-change batch has an unsafe working directory.')
    }
    if (!Array.isArray(item.changes)) {
      if (strict) throw new ReviewDiffDataError('A completed file-change batch is malformed.')
      continue
    }
    if (strict && patchBatches.length >= MAX_REVIEW_PATCH_BATCHES) {
      throw new ReviewDiffDataError('This turn contains too many change batches to apply safely.')
    }

    const changes: ReviewPatchChange[] = []
    let strictRawBatchBytes = 0
    for (const value of item.changes) {
      if (changeCount + changes.length >= MAX_REVIEW_CHANGE_COUNT) {
        hasTooManyChanges = true
        if (strict) {
          throw new ReviewDiffDataError('This turn contains too many file changes to apply safely.')
        }
        break
      }
      const rawRecord = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
      if (strict && typeof rawRecord?.diff === 'string') {
        if (changes.length > 0) strictRawBatchBytes += 1
        strictRawBatchBytes += utf8ByteLength(rawRecord.diff)
        if (strictRawBatchBytes > MAX_REVIEW_PATCH_BYTES) {
          throw new ReviewDiffDataError('One saved change batch is too large to apply safely.')
        }
      }
      const change = readPatchChange(value, currentCwd, root, includeOutsideRoot)
      if (!change) {
        if (strict) throw new ReviewDiffDataError('A completed file change cannot be reconstructed safely.')
        continue
      }
      if (strict && !isStrictUpdateDiffSafe(change)) {
        throw new ReviewDiffDataError('A completed update contains unsupported or mismatched patch data.')
      }
      if (change.kind === 'add' || change.kind === 'delete') {
        hasUnrecordedFileMode = true
        if (strict) {
          throw new ReviewDiffDataError(
            'Undo is unavailable because saved file additions and deletions do not include reliable worktree permissions.',
          )
        }
      }
      if (change.movePath && parentPath(change.path) !== parentPath(change.movePath)) {
        hasUnrecordedDirectoryMode = true
        if (strict) {
          throw new ReviewDiffDataError(
            'Undo is unavailable because saved cross-directory renames do not include reliable directory permissions.',
          )
        }
      }
      changes.push(change)
    }
    if (changes.length === 0) continue

    const includePatchText = options.includePatchText !== false
    const patches: string[] = []
    let byteLength = 0
    for (const [changeIndex, change] of changes.entries()) {
      if (changeIndex > 0) byteLength += 1
      const rawByteLength = utf8ByteLength(change.diff)
      if (strict && rawByteLength > MAX_REVIEW_PATCH_BYTES) {
        throw new ReviewDiffDataError('One saved change is too large to apply safely.')
      }
      if (includePatchText || rawByteLength <= MAX_REVIEW_PATCH_BYTES) {
        const patchText = ensureTrailingNewline(buildReviewPatch(change))
        byteLength += utf8ByteLength(patchText)
        if (includePatchText) patches.push(patchText)
      } else {
        // Raw content alone already exceeds the server limit, so headers cannot make it eligible.
        byteLength += rawByteLength
      }
      if (strict && byteLength > MAX_REVIEW_PATCH_BYTES) {
        throw new ReviewDiffDataError('One saved change batch is too large to apply safely.')
      }
      if (strict && totalPatchBytes + byteLength > MAX_REVIEW_TOTAL_PATCH_BYTES) {
        throw new ReviewDiffDataError('The saved changes are too large to apply safely.')
      }
    }
    const patch = includePatchText ? patches.join('\n') : ''
    totalPatchBytes += byteLength
    hasOversizedBatch = hasOversizedBatch || byteLength > MAX_REVIEW_PATCH_BYTES
    const batchId = typeof item.id === 'string' && item.id ? item.id : `patch-${itemIndex.toString()}`
    if (strict && (typeof item.id !== 'string' || !item.id)) {
      throw new ReviewDiffDataError('A completed file-change batch has no identifier.')
    }
    patchBatches.push({
      id: batchId,
      cwd: canonicalAbsolutePath(currentCwd) || currentCwd,
      fingerprint: reviewBatchFingerprint(item.changes),
      byteLength,
      ...(includePatchText ? { patch } : {}),
    })
    changeCount += changes.length

    for (const [changeIndex, change] of changes.entries()) {
      const displayPath = change.movePath || change.path
      const existing = fileByPath.get(displayPath)
      const canStoreFile = Boolean(existing) || files.length < MAX_REVIEW_FILES
      const fileLineBudget = existing
        ? Math.max(0, MAX_REVIEW_LINES_PER_FILE - existing.lines.length)
        : MAX_REVIEW_LINES_PER_FILE
      const maxLines = canStoreFile
        ? Math.max(0, Math.min(fileLineBudget, remainingRenderedLines))
        : 0
      const idPrefix = `${batchId}:${changeIndex.toString()}`
      const maxCharacters = canStoreFile ? remainingRenderedCharacters : 0
      const file = change.kind === 'add' || change.kind === 'delete'
        ? parseWholeFileContent(change, idPrefix, maxLines, maxCharacters)
        : parseFilePatch(
            change,
            includePatchText ? patches[changeIndex] ?? '' : change.diff,
            idPrefix,
            maxLines,
            maxCharacters,
          )
      additions += file.additions
      deletions += file.deletions
      allPaths.add(file.path)
      if (!canStoreFile) continue
      remainingRenderedLines -= file.lines.length
      remainingRenderedCharacters -= file.lines.reduce((sum, line) => sum + line.text.length, 0)
      if (existing) {
        mergeDiffFile(existing, file)
      } else {
        fileByPath.set(file.path, file)
        files.push(file)
      }
    }
  }

  if (patchBatches.length === 0 || allPaths.size === 0) return null
  const actionUnavailableReason = patchBatches.length > MAX_REVIEW_PATCH_BATCHES
    ? `Undo is unavailable because this turn contains more than ${MAX_REVIEW_PATCH_BATCHES.toString()} change batches.`
    : hasTooManyChanges
      ? `Undo is unavailable because this turn contains more than ${MAX_REVIEW_CHANGE_COUNT.toString()} file changes.`
    : hasUnrecordedFileMode
      ? 'Undo is unavailable because saved file additions and deletions do not include reliable worktree permissions.'
    : hasUnrecordedDirectoryMode
      ? 'Undo is unavailable because saved cross-directory renames do not include reliable directory permissions.'
    : hasOversizedBatch
      ? 'Undo is unavailable because one change batch exceeds the 2 MB safety limit.'
      : totalPatchBytes > MAX_REVIEW_TOTAL_PATCH_BYTES
        ? 'Undo is unavailable because this turn exceeds the 12 MB safety limit.'
        : ''
  return {
    files,
    fileCount: allPaths.size,
    changeCount,
    filesTruncated: hasTooManyChanges || allPaths.size > files.length,
    additions,
    deletions,
    patchBatches,
    ...(actionUnavailableReason ? { actionUnavailableReason } : {}),
  }
}
