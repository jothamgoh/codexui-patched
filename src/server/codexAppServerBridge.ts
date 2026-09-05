import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, mkdir, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { PinnedThreadsStore, type PinnedThreadsOrderResult } from './pinnedThreadsStore'
import {
  ThreadMetadataStore,
  type SharedThreadReadState,
  type ThreadTitleCache,
} from './threadMetadataStore'
import { AutomationStore } from './automationStore'
import { AUTOMATION_DYNAMIC_TOOL_SPEC, AutomationService } from './automationService'
import { ProjectBoardStore } from './projectBoardStore'
import { ProjectBoardService } from './projectBoardService'
import { readProjectBoardModels, resolveProjectBoardExecutionSettings } from './projectBoardModels'
import type { ProjectBoardSnapshot } from '../types/projectBoards'
import { buildThreadReferenceSection, type ThreadReferenceMessage } from '../utils/threadReferences'
import { getCodexUiChildEnv } from './envFile'
import {
  paginateThreadReadResult,
  resumeThreadLite,
} from './threadPagination'
import {
  resolveSkillUninstallTarget,
  SkillUninstallTargetError,
  type InstalledSkillPath,
} from './skillUninstall'
import { readCodexUiRuntimeConfig } from './runtimeConfig'
import { buildReviewChanges, ReviewDiffDataError } from '../utils/reviewDiff'
import {
  applyReviewPatchSequence,
  canonicalizeReviewCommandWorkingDirectories,
  resolveReviewGitWorkspace,
  ReviewPatchRequestError,
} from './reviewPatch'
import { ReviewMutationConflictError, ReviewMutationGate } from './reviewMutationGate'
import { readReviewClientScope, reviewScopeMatches } from './reviewScope'
import {
  GitWorkspaceRequestError,
  readGitWorkspaceReview,
  readGitWorkspaceStatus,
  switchGitWorkspaceBranch,
} from './gitWorkspace'
import type { GitWorkspaceReviewSource } from '../types/codex'

type JsonRpcCall = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: {
    code: number
    message: string
  }
  method?: string
  params?: unknown
}

type RpcProxyRequest = {
  method: string
  params?: unknown
}

type ServerRequestReply = {
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

type WorkspaceRootsState = {
  order: string[]
  labels: Record<string, string>
  active: string[]
}

type PendingServerRequest = {
  id: number
  method: string
  params: unknown
  receivedAtIso: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message.trim().length > 0) {
    return payload.message
  }

  const record = asRecord(payload)
  if (!record) return fallback

  const error = record.error
  if (typeof error === 'string' && error.length > 0) return error

  const nestedError = asRecord(error)
  if (nestedError && typeof nestedError.message === 'string' && nestedError.message.length > 0) {
    return nestedError.message
  }

  return fallback
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function scoreFileCandidate(path: string, query: string): number {
  if (!query) return 0
  const lowerPath = path.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const baseName = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
  if (baseName === lowerQuery) return 0
  if (baseName.startsWith(lowerQuery)) return 1
  if (baseName.includes(lowerQuery)) return 2
  if (lowerPath.includes(`/${lowerQuery}`)) return 3
  if (lowerPath.includes(lowerQuery)) return 4
  return 10
}

async function listFilesWithRipgrep(cwd: string): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const proc = spawn('rg', ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'], {
      cwd,
      env: getCodexUiChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        const rows = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        resolve(rows)
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      reject(new Error(details || 'rg --files failed'))
    })
  })
}

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

function getEnvFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return defaultValue
  return !['0', 'false', 'no', 'off'].includes(raw)
}

function resolveCodexAppServerCommand(): string {
  const explicitCommand = process.env.CODEXUI_CODEX_COMMAND?.trim()
  if (explicitCommand) return explicitCommand

  const pluginAppServerCommand = join(getCodexHomeDir(), 'plugins', '.plugin-appserver', 'codex')
  if (existsSync(pluginAppServerCommand)) return pluginAppServerCommand

  const desktopCommand = '/Applications/ChatGPT.app/Contents/Resources/codex'
  if (existsSync(desktopCommand)) return desktopCommand

  return 'codex'
}

function createAppServerArgs(): string[] {
  const args = [
    'app-server',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="danger-full-access"',
  ]

  if (getEnvFlag('CODEXUI_ENABLE_CODE_MODE_HOST', true)) {
    args.push('-c', 'features.code_mode_host=true')
  }

  if (getEnvFlag('CODEXUI_ANALYTICS_DEFAULT_ENABLED', false)) {
    args.push('--analytics-default-enabled')
  }

  return args
}

function getSkillsInstallDir(): string {
  return join(getCodexHomeDir(), 'skills')
}

async function runCommand(command: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: getCodexUiChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

async function runCommandForOutput(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: getCodexUiChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

async function createManagedWorktree(cwd: string): Promise<string> {
  const gitRoot = await runCommandForOutput('git', ['rev-parse', '--show-toplevel'], { cwd })
  if (!gitRoot || !isAbsolute(gitRoot)) {
    throw new Error('This workspace is not inside a Git repository')
  }

  const repoSlug = basename(gitRoot)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace'
  const worktreeParent = join(getCodexHomeDir(), 'worktrees', repoSlug)
  await mkdir(worktreeParent, { recursive: true })
  const worktreePath = join(worktreeParent, `${Date.now()}-${randomUUID().slice(0, 8)}`)
  await runCommand('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], { cwd: gitRoot })
  return worktreePath
}

async function detectUserSkillsDir(appServer: AppServerProcess): Promise<string> {
  try {
    const result = (await appServer.rpc('skills/list', {})) as {
      data?: Array<{ skills?: Array<{ scope?: string; path?: string }> }>
    }
    for (const entry of result.data ?? []) {
      for (const skill of entry.skills ?? []) {
        if (skill.scope !== 'user' || !skill.path) continue
        const parts = skill.path.split('/').filter(Boolean)
        if (parts.length < 2) continue
        return `/${parts.slice(0, -2).join('/')}`
      }
    }
  } catch {}
  return getSkillsInstallDir()
}

async function ensureInstalledSkillIsValid(appServer: AppServerProcess, skillPath: string): Promise<void> {
  const result = (await appServer.rpc('skills/list', { forceReload: true })) as {
    data?: Array<{ errors?: Array<{ path?: string; message?: string }> }>
  }
  const normalized = skillPath.endsWith('/SKILL.md') ? skillPath : `${skillPath}/SKILL.md`
  for (const entry of result.data ?? []) {
    for (const error of entry.errors ?? []) {
      if (error.path === normalized) {
        throw new Error(error.message || 'Installed skill is invalid')
      }
    }
  }
}

type SkillHubEntry = {
  name: string
  owner: string
  description: string
  displayName: string
  publishedAt: number
  avatarUrl: string
  url: string
  installed: boolean
  path?: string
  enabled?: boolean
}

type SkillsTreeEntry = {
  name: string
  owner: string
  url: string
}

type SkillsTreeCache = {
  entries: SkillsTreeEntry[]
  fetchedAt: number
}

type MetaJson = {
  displayName?: string
  owner?: string
  slug?: string
  latest?: { publishedAt?: number }
}

const TREE_CACHE_TTL_MS = 5 * 60 * 1000
let skillsTreeCache: SkillsTreeCache | null = null
const metaCache = new Map<string, { description: string; displayName: string; publishedAt: number }>()

async function getGhToken(): Promise<string | null> {
  try {
    const proc = spawn('gh', ['auth', 'token'], {
      env: getCodexUiChildEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    return new Promise((resolve) => {
      proc.on('close', (code) => resolve(code === 0 ? out.trim() : null))
      proc.on('error', () => resolve(null))
    })
  } catch { return null }
}

async function ghFetch(url: string): Promise<Response> {
  const token = await getGhToken()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'codex-web-local',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(url, { headers })
}

async function fetchSkillsTree(): Promise<SkillsTreeEntry[]> {
  if (skillsTreeCache && Date.now() - skillsTreeCache.fetchedAt < TREE_CACHE_TTL_MS) {
    return skillsTreeCache.entries
  }

  const resp = await ghFetch('https://api.github.com/repos/openclaw/skills/git/trees/main?recursive=1')
  if (!resp.ok) throw new Error(`GitHub tree API returned ${resp.status}`)
  const data = (await resp.json()) as { tree?: Array<{ path: string; type: string }> }

  const metaPattern = /^skills\/([^/]+)\/([^/]+)\/_meta\.json$/
  const seen = new Set<string>()
  const entries: SkillsTreeEntry[] = []

  for (const node of data.tree ?? []) {
    const match = metaPattern.exec(node.path)
    if (!match) continue
    const [, owner, skillName] = match
    const key = `${owner}/${skillName}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      name: skillName,
      owner,
      url: `https://github.com/openclaw/skills/tree/main/skills/${owner}/${skillName}`,
    })
  }

  skillsTreeCache = { entries, fetchedAt: Date.now() }
  return entries
}

async function fetchMetaBatch(entries: SkillsTreeEntry[]): Promise<void> {
  const toFetch = entries.filter((e) => !metaCache.has(`${e.owner}/${e.name}`))
  if (toFetch.length === 0) return

  const batch = toFetch.slice(0, 50)
  const results = await Promise.allSettled(
    batch.map(async (e) => {
      const rawUrl = `https://raw.githubusercontent.com/openclaw/skills/main/skills/${e.owner}/${e.name}/_meta.json`
      const resp = await fetch(rawUrl)
      if (!resp.ok) return
      const meta = (await resp.json()) as MetaJson
      metaCache.set(`${e.owner}/${e.name}`, {
        displayName: typeof meta.displayName === 'string' ? meta.displayName : '',
        description: typeof meta.displayName === 'string' ? meta.displayName : '',
        publishedAt: meta.latest?.publishedAt ?? 0,
      })
    }),
  )
  void results
}

function buildHubEntry(e: SkillsTreeEntry): SkillHubEntry {
  const cached = metaCache.get(`${e.owner}/${e.name}`)
  return {
    name: e.name,
    owner: e.owner,
    description: cached?.description ?? '',
    displayName: cached?.displayName ?? '',
    publishedAt: cached?.publishedAt ?? 0,
    avatarUrl: `https://github.com/${e.owner}.png?size=40`,
    url: e.url,
    installed: false,
  }
}

type InstalledSkillInfo = { name: string; path: string; enabled: boolean }

async function scanInstalledSkillsFromDisk(): Promise<Map<string, InstalledSkillInfo>> {
  const map = new Map<string, InstalledSkillInfo>()
  const skillsDir = getSkillsInstallDir()
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skillMd = join(skillsDir, entry.name, 'SKILL.md')
      try {
        await stat(skillMd)
        map.set(entry.name, { name: entry.name, path: skillMd, enabled: true })
      } catch {}
    }
  } catch {}
  return map
}

async function searchSkillsHub(
  allEntries: SkillsTreeEntry[],
  query: string,
  limit: number,
  sort: string,
  installedMap: Map<string, InstalledSkillInfo>,
): Promise<SkillHubEntry[]> {
  const q = query.toLowerCase().trim()
  let filtered = q
    ? allEntries.filter((s) => {
        if (s.name.toLowerCase().includes(q) || s.owner.toLowerCase().includes(q)) return true
        const cached = metaCache.get(`${s.owner}/${s.name}`)
        if (cached?.displayName?.toLowerCase().includes(q)) return true
        return false
      })
    : allEntries

  const page = filtered.slice(0, Math.min(limit * 2, 200))
  await fetchMetaBatch(page)

  let results = page.map(buildHubEntry)

  if (sort === 'date') {
    results.sort((a, b) => b.publishedAt - a.publishedAt)
  } else if (q) {
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === q ? 1 : 0
      const bExact = b.name.toLowerCase() === q ? 1 : 0
      if (aExact !== bExact) return bExact - aExact
      return b.publishedAt - a.publishedAt
    })
  }

  return results.slice(0, limit).map((s) => {
    const local = installedMap.get(s.name)
    return local
      ? { ...s, installed: true, path: local.path, enabled: local.enabled }
      : s
  })
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && !normalized.includes(item)) {
      normalized.push(item)
    }
  }
  return normalized
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === 'string' && key.length > 0 && typeof item === 'string') {
      next[key] = item
    }
  }
  return next
}

function getCodexAuthPath(): string {
  return join(getCodexHomeDir(), 'auth.json')
}

type CodexAuth = {
  tokens?: {
    access_token?: string
    account_id?: string
  }
}

type RateLimitResetCredit = {
  status: string
  expiresAt: string | null
  title: string | null
}

async function readCodexAuth(): Promise<{ accessToken: string; accountId?: string } | null> {
  try {
    const raw = await readFile(getCodexAuthPath(), 'utf8')
    const auth = JSON.parse(raw) as CodexAuth
    const token = auth.tokens?.access_token
    if (!token) return null
    return { accessToken: token, accountId: auth.tokens?.account_id ?? undefined }
  } catch {
    return null
  }
}

function getCodexGlobalStatePath(): string {
  return join(getCodexHomeDir(), '.codex-global-state.json')
}

const PINNED_THREADS_STATE_KEY = 'codexui-pinned-thread-ids'
const PINNED_THREADS_STATE_FILENAME = 'codexui-pinned-threads.json'
const THREAD_READ_STATE_KEY = 'codexui-thread-read-state'
const THREAD_METADATA_STATE_FILENAME = 'codexui-thread-metadata.json'
let globalStateMutationQueue: Promise<void> = Promise.resolve()

async function readCodexGlobalStateFile(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(getCodexGlobalStatePath(), 'utf8')
    return asRecord(JSON.parse(raw)) ?? {}
  } catch {
    return {}
  }
}

async function readCodexGlobalState(): Promise<Record<string, unknown>> {
  await globalStateMutationQueue
  return readCodexGlobalStateFile()
}

async function mutateCodexGlobalState<T>(mutator: (payload: Record<string, unknown>) => T): Promise<T> {
  let result!: T
  const operation = globalStateMutationQueue.then(async () => {
    const payload = await readCodexGlobalStateFile()
    result = mutator(payload)
    await writeFile(getCodexGlobalStatePath(), JSON.stringify(payload), 'utf8')
  })
  globalStateMutationQueue = operation.catch(() => undefined)
  await operation
  return result
}

async function readSharedThreadReadState(): Promise<SharedThreadReadState> {
  return threadMetadataStore.readReadState()
}

async function updateSharedThreadReadState(
  threadId: string,
  unread: boolean,
  readAtIso: string,
): Promise<SharedThreadReadState> {
  return threadMetadataStore.updateReadState(threadId, unread, readAtIso)
}

async function readThreadTitleCache(): Promise<ThreadTitleCache> {
  return threadMetadataStore.readTitles()
}

async function updateThreadTitle(id: string, title: string): Promise<ThreadTitleCache> {
  return threadMetadataStore.updateTitle(id, title)
}

const pinnedThreadsStore = new PinnedThreadsStore({
  stateFilePath: join(getCodexHomeDir(), PINNED_THREADS_STATE_FILENAME),
  readLegacyThreadIds: async () => {
    const payload = await readCodexGlobalState()
    return payload[PINNED_THREADS_STATE_KEY]
  },
})

const threadMetadataStore = new ThreadMetadataStore({
  stateFilePath: join(getCodexHomeDir(), THREAD_METADATA_STATE_FILENAME),
  readLegacyTitles: async () => {
    const payload = await readCodexGlobalState()
    return payload['thread-titles']
  },
  readLegacyReadState: async () => {
    const payload = await readCodexGlobalState()
    return payload[THREAD_READ_STATE_KEY]
  },
})

async function readPinnedThreadIds(): Promise<string[]> {
  return (await pinnedThreadsStore.read()).threadIds
}

async function reorderPinnedThreadIds(threadIds: string[]): Promise<PinnedThreadsOrderResult> {
  return pinnedThreadsStore.reorder(threadIds)
}

async function updatePinnedThread(
  threadId: string,
  pinned: boolean,
  beforeThreadId?: string,
): Promise<string[]> {
  return (
    await pinnedThreadsStore.update({
      threadId,
      pinned,
      beforeThreadId,
    })
  ).threadIds
}

async function readWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  const payload = await readCodexGlobalState()

  return {
    order: normalizeStringArray(payload['electron-saved-workspace-roots']),
    labels: normalizeStringRecord(payload['electron-workspace-root-labels']),
    active: normalizeStringArray(payload['active-workspace-roots']),
  }
}

async function writeWorkspaceRootsState(nextState: WorkspaceRootsState): Promise<void> {
  await mutateCodexGlobalState((payload) => {
    payload['electron-saved-workspace-roots'] = normalizeStringArray(nextState.order)
    payload['electron-workspace-root-labels'] = normalizeStringRecord(nextState.labels)
    payload['active-workspace-roots'] = normalizeStringArray(nextState.active)
  })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req)
  if (raw.length === 0) return null
  const text = raw.toString('utf8').trim()
  if (text.length === 0) return null
  return JSON.parse(text) as unknown
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

function bufferIndexOf(buf: Buffer, needle: Buffer, start = 0): number {
  for (let i = start; i <= buf.length - needle.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) { match = false; break }
    }
    if (match) return i
  }
  return -1
}

function handleFileUpload(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks)
      const contentType = req.headers['content-type'] ?? ''
      const boundaryMatch = contentType.match(/boundary=(.+)/i)
      if (!boundaryMatch) { setJson(res, 400, { error: 'Missing multipart boundary' }); return }
      const boundary = boundaryMatch[1]
      const boundaryBuf = Buffer.from(`--${boundary}`)
      const parts: Buffer[] = []
      let searchStart = 0
      while (searchStart < body.length) {
        const idx = body.indexOf(boundaryBuf, searchStart)
        if (idx < 0) break
        if (searchStart > 0) parts.push(body.subarray(searchStart, idx))
        searchStart = idx + boundaryBuf.length
        if (body[searchStart] === 0x0d && body[searchStart + 1] === 0x0a) searchStart += 2
      }
      let fileName = 'uploaded-file'
      let fileData: Buffer | null = null
      const headerSep = Buffer.from('\r\n\r\n')
      for (const part of parts) {
        const headerEnd = bufferIndexOf(part, headerSep)
        if (headerEnd < 0) continue
        const headers = part.subarray(0, headerEnd).toString('utf8')
        const fnMatch = headers.match(/filename="([^"]+)"/i)
        if (!fnMatch) continue
        fileName = fnMatch[1].replace(/[/\\]/g, '_')
        let end = part.length
        if (end >= 2 && part[end - 2] === 0x0d && part[end - 1] === 0x0a) end -= 2
        fileData = part.subarray(headerEnd + 4, end)
        break
      }
      if (!fileData) { setJson(res, 400, { error: 'No file in request' }); return }
      const uploadDir = join(tmpdir(), 'codex-web-uploads')
      await mkdir(uploadDir, { recursive: true })
      const destDir = await mkdtemp(join(uploadDir, 'f-'))
      const destPath = join(destDir, fileName)
      await writeFile(destPath, fileData)
      setJson(res, 200, { path: destPath })
    } catch (err) {
      setJson(res, 500, { error: getErrorMessage(err, 'Upload failed') })
    }
  })
  req.on('error', (err) => {
    setJson(res, 500, { error: getErrorMessage(err, 'Upload stream error') })
  })
}

async function proxyTranscribe(
  body: Buffer,
  contentType: string,
  authToken: string,
  accountId?: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Content-Length': body.length,
    Authorization: `Bearer ${authToken}`,
    originator: 'Codex Desktop',
    'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})`,
  }

  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId
  }

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      'https://chatgpt.com/backend-api/transcribe',
      { method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function normalizeRateLimitResetCredit(value: unknown): RateLimitResetCredit | null {
  const record = asRecord(value)
  if (!record) return null

  const status = typeof record.status === 'string' ? record.status : ''
  const expiresAt = typeof record.expires_at === 'string'
    ? record.expires_at
    : typeof record.expiresAt === 'string'
      ? record.expiresAt
      : null
  const title = typeof record.title === 'string' ? record.title : null

  if (!status && !expiresAt) return null
  return { status, expiresAt, title }
}

function normalizeRateLimitResetCreditsResponse(payload: unknown): unknown {
  const record = asRecord(payload)
  if (!record) return { rateLimitResetCredits: { availableCount: 0, credits: [] } }

  const rawCredits = Array.isArray(record.credits) ? record.credits : []
  const credits = rawCredits
    .map(normalizeRateLimitResetCredit)
    .filter((credit): credit is RateLimitResetCredit => credit !== null)
    .sort((a, b) => {
      const first = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY
      const second = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY
      return first - second
    })
  const availableCount = typeof record.available_count === 'number' && Number.isFinite(record.available_count)
    ? record.available_count
    : credits.filter((credit) => credit.status === 'available').length

  return {
    rateLimitResetCredits: {
      availableCount: Math.max(0, Math.round(availableCount)),
      credits,
    },
  }
}

async function proxyRateLimitResetCredits(authToken: string, accountId?: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${authToken}`,
    originator: 'Codex Desktop',
    'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})`,
  }

  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId
  }

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      { method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8')
          if ((res.statusCode ?? 500) >= 400) {
            resolve({ status: res.statusCode ?? 500, body: rawBody })
            return
          }

          try {
            const normalized = normalizeRateLimitResetCreditsResponse(JSON.parse(rawBody) as unknown)
            resolve({ status: res.statusCode ?? 200, body: JSON.stringify(normalized) })
          } catch {
            resolve({ status: 502, body: JSON.stringify({ error: 'Invalid reset credit response' }) })
          }
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

class AppServerProcess {
  private process: ChildProcessWithoutNullStreams | null = null
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private readBuffer = ''
  private nextId = 1
  private stopping = false
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
  private readonly notificationListeners = new Set<(value: { method: string; params: unknown }) => void>()
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>()
  private readonly dynamicToolHandlers = new Map<string, (params: unknown) => Promise<unknown>>()
  private readonly appServerCommand = resolveCodexAppServerCommand()
  private readonly appServerArgs = createAppServerArgs()
  private readonly reviewMutationGate = new ReviewMutationGate()

  private start(): void {
    if (this.process) return

    this.stopping = false
    console.log(`[codex-bridge] Starting ${this.appServerCommand} ${this.appServerArgs.join(' ')}`)
    const proc = spawn(this.appServerCommand, this.appServerArgs, {
      env: getCodexUiChildEnv(
        { CODEX_HOME: getCodexHomeDir() },
        ['JINA_API_KEY'],
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.readBuffer += chunk

      let lineEnd = this.readBuffer.indexOf('\n')
      while (lineEnd !== -1) {
        const line = this.readBuffer.slice(0, lineEnd).trim()
        this.readBuffer = this.readBuffer.slice(lineEnd + 1)

        if (line.length > 0) {
          this.handleLine(line)
        }

        lineEnd = this.readBuffer.indexOf('\n')
      }
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', () => {
      // Keep stderr silent in dev middleware; JSON-RPC errors are forwarded via responses.
    })

    proc.on('exit', (code, signal) => {
      const failure = new Error(this.stopping ? 'codex app-server stopped' : 'codex app-server exited unexpectedly')
      for (const request of this.pending.values()) {
        request.reject(failure)
      }

      this.pending.clear()
      this.pendingServerRequests.clear()
      this.process = null
      this.initialized = false
      this.initializePromise = null
      this.readBuffer = ''
      this.reviewMutationGate.resetTurns()
      this.emitNotification({
        method: 'codexui/appServer/exited',
        params: { code, signal, message: failure.message },
      })
    })
  }

  private sendLine(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error('codex app-server is not running')
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }

    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pendingRequest = this.pending.get(message.id)
      this.pending.delete(message.id)

      if (!pendingRequest) return

      if (message.error) {
        pendingRequest.reject(new Error(message.error.message))
      } else {
        pendingRequest.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string' && typeof message.id !== 'number') {
      this.emitNotification({
        method: message.method,
        params: message.params ?? null,
      })
      return
    }

    // Handle server-initiated JSON-RPC requests (approvals, dynamic tool calls, etc.).
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method, message.params ?? null)
    }
  }

  private emitNotification(notification: { method: string; params: unknown }): void {
    const turnId = readNestedString(notification.params, 'turn', 'id')
    if (notification.method === 'turn/started') this.reviewMutationGate.markTurnStarted(turnId)
    if (notification.method === 'turn/completed') this.reviewMutationGate.markTurnCompleted(turnId)
    for (const listener of this.notificationListeners) {
      listener(notification)
    }
  }

  private sendServerRequestReply(requestId: number, reply: ServerRequestReply): void {
    if (reply.error) {
      this.sendLine({
        jsonrpc: '2.0',
        id: requestId,
        error: reply.error,
      })
      return
    }

    this.sendLine({
      jsonrpc: '2.0',
      id: requestId,
      result: reply.result ?? {},
    })
  }

  private resolvePendingServerRequest(requestId: number, reply: ServerRequestReply): void {
    const pendingRequest = this.pendingServerRequests.get(requestId)
    if (!pendingRequest) {
      throw new Error(`No pending server request found for id ${String(requestId)}`)
    }
    this.pendingServerRequests.delete(requestId)

    this.sendServerRequestReply(requestId, reply)
    const requestParams = asRecord(pendingRequest.params)
    const threadId =
      typeof requestParams?.threadId === 'string' && requestParams.threadId.length > 0
        ? requestParams.threadId
        : ''
    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: requestId,
        method: pendingRequest.method,
        threadId,
        mode: 'manual',
        resolvedAtIso: new Date().toISOString(),
      },
    })
  }

  private handleServerRequest(requestId: number, method: string, params: unknown): void {
    const requestParams = asRecord(params)
    const dynamicToolName = typeof requestParams?.tool === 'string' ? requestParams.tool : ''
    const dynamicToolHandler = this.dynamicToolHandlers.get(dynamicToolName)
    if (method === 'item/tool/call' && dynamicToolHandler) {
      void dynamicToolHandler(params)
        .then((result) => {
          this.sendServerRequestReply(requestId, { result })
          this.emitNotification({
            method: 'server/request/resolved',
            params: {
              id: requestId,
              method,
              threadId: typeof requestParams?.threadId === 'string' ? requestParams.threadId : '',
              mode: 'automatic',
              resolvedAtIso: new Date().toISOString(),
            },
          })
        })
        .catch((error) => {
          this.sendServerRequestReply(requestId, {
            result: {
              contentItems: [{
                type: 'inputText',
                text: error instanceof Error ? error.message : `${dynamicToolName} failed.`,
              }],
              success: false,
            },
          })
        })
      return
    }

    const pendingRequest: PendingServerRequest = {
      id: requestId,
      method,
      params,
      receivedAtIso: new Date().toISOString(),
    }
    this.pendingServerRequests.set(requestId, pendingRequest)

    this.emitNotification({
      method: 'server/request',
      params: pendingRequest,
    })
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    this.start()
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })

      this.sendLine({
        jsonrpc: '2.0',
        id,
        method,
        params,
      } satisfies JsonRpcCall)
    })
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (this.initializePromise) {
      await this.initializePromise
      return
    }

    this.initializePromise = this.call('initialize', {
      clientInfo: {
        name: 'codex-web-local',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }).then(() => {
      this.initialized = true
    }).finally(() => {
      this.initializePromise = null
    })

    await this.initializePromise
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    const releaseTurnStart = method === 'turn/start'
      ? this.reviewMutationGate.reserveTurnStart()
      : null
    try {
      await this.ensureInitialized()
      const result = await this.call(method, params)
      if (method === 'turn/start') {
        const turnId = readNestedString(result, 'turn', 'id')
        const status = readNestedString(result, 'turn', 'status')
        if (turnId && (!status || status === 'inProgress')) {
          this.reviewMutationGate.markTurnStarted(turnId)
        }
      }
      return result
    } finally {
      releaseTurnStart?.()
    }
  }

  reserveReviewMutation(): () => void {
    return this.reviewMutationGate.reserveReview()
  }

  onNotification(listener: (value: { method: string; params: unknown }) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  publishLocalNotification(method: string, params: unknown): void {
    this.emitNotification({ method, params })
  }

  registerDynamicToolHandler(name: string, handler: (params: unknown) => Promise<unknown>): void {
    this.dynamicToolHandlers.set(name, handler)
  }

  async respondToServerRequest(payload: unknown): Promise<void> {
    await this.ensureInitialized()

    const body = asRecord(payload)
    if (!body) {
      throw new Error('Invalid response payload: expected object')
    }

    const id = body.id
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error('Invalid response payload: "id" must be an integer')
    }

    const rawError = asRecord(body.error)
    if (rawError) {
      const message = typeof rawError.message === 'string' && rawError.message.trim().length > 0
        ? rawError.message.trim()
        : 'Server request rejected by client'
      const code = typeof rawError.code === 'number' && Number.isFinite(rawError.code)
        ? Math.trunc(rawError.code)
        : -32000
      this.resolvePendingServerRequest(id, { error: { code, message } })
      return
    }

    if (!('result' in body)) {
      throw new Error('Invalid response payload: expected "result" or "error"')
    }

    this.resolvePendingServerRequest(id, { result: body.result })
  }

  listPendingServerRequests(): PendingServerRequest[] {
    return Array.from(this.pendingServerRequests.values())
  }

  dispose(): void {
    if (!this.process) return

    const proc = this.process
    this.stopping = true
    this.process = null
    this.initialized = false
    this.initializePromise = null
    this.readBuffer = ''

    const failure = new Error('codex app-server stopped')
    for (const request of this.pending.values()) {
      request.reject(failure)
    }
    this.pending.clear()
    this.pendingServerRequests.clear()

    try {
      proc.stdin.end()
    } catch {
      // ignore close errors on shutdown
    }

    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore kill errors on shutdown
    }

    const forceKillTimer = setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore kill errors on shutdown
        }
      }
    }, 1500)
    forceKillTimer.unref()
  }
}

class MethodCatalog {
  private methodCache: string[] | null = null
  private notificationCache: string[] | null = null

  private async runGenerateSchemaCommand(outDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const process = spawn('codex', ['app-server', 'generate-json-schema', '--out', outDir], {
        env: getCodexUiChildEnv(),
        stdio: ['ignore', 'ignore', 'pipe'],
      })

      let stderr = ''

      process.stderr.setEncoding('utf8')
      process.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      process.on('error', reject)
      process.on('exit', (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(stderr.trim() || `generate-json-schema exited with code ${String(code)}`))
      })
    })
  }

  private extractMethodsFromClientRequest(payload: unknown): string[] {
    const root = asRecord(payload)
    const oneOf = Array.isArray(root?.oneOf) ? root.oneOf : []
    const methods = new Set<string>()

    for (const entry of oneOf) {
      const row = asRecord(entry)
      const properties = asRecord(row?.properties)
      const methodDef = asRecord(properties?.method)
      const methodEnum = Array.isArray(methodDef?.enum) ? methodDef.enum : []

      for (const item of methodEnum) {
        if (typeof item === 'string' && item.length > 0) {
          methods.add(item)
        }
      }
    }

    return Array.from(methods).sort((a, b) => a.localeCompare(b))
  }

  private extractMethodsFromServerNotification(payload: unknown): string[] {
    const root = asRecord(payload)
    const oneOf = Array.isArray(root?.oneOf) ? root.oneOf : []
    const methods = new Set<string>()

    for (const entry of oneOf) {
      const row = asRecord(entry)
      const properties = asRecord(row?.properties)
      const methodDef = asRecord(properties?.method)
      const methodEnum = Array.isArray(methodDef?.enum) ? methodDef.enum : []

      for (const item of methodEnum) {
        if (typeof item === 'string' && item.length > 0) {
          methods.add(item)
        }
      }
    }

    return Array.from(methods).sort((a, b) => a.localeCompare(b))
  }

  async listMethods(): Promise<string[]> {
    if (this.methodCache) {
      return this.methodCache
    }

    const outDir = await mkdtemp(join(tmpdir(), 'codex-web-local-schema-'))
    await this.runGenerateSchemaCommand(outDir)

    const clientRequestPath = join(outDir, 'ClientRequest.json')
    const raw = await readFile(clientRequestPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const methods = this.extractMethodsFromClientRequest(parsed)

    this.methodCache = methods
    return methods
  }

  async listNotificationMethods(): Promise<string[]> {
    if (this.notificationCache) {
      return this.notificationCache
    }

    const outDir = await mkdtemp(join(tmpdir(), 'codex-web-local-schema-'))
    await this.runGenerateSchemaCommand(outDir)

    const serverNotificationPath = join(outDir, 'ServerNotification.json')
    const raw = await readFile(serverNotificationPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const methods = this.extractMethodsFromServerNotification(parsed)

    this.notificationCache = methods
    return methods
  }
}

const THREAD_TITLE_MODEL = 'gpt-5.6-luna'
const THREAD_TITLE_TIMEOUT_MS = 30_000
const THREAD_TITLE_PROMPT_LIMIT = 2_000
const THREAD_TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 36 },
    description: { type: 'string', minLength: 1, maxLength: 100 },
  },
  required: ['title', 'description'],
} as const

type GeneratedThreadTitle = {
  title: string
  description: string
}

function readNestedString(payload: unknown, ...path: string[]): string {
  let value = payload
  for (const key of path) {
    value = asRecord(value)?.[key]
  }
  return typeof value === 'string' ? value : ''
}

function buildThreadTitlePrompt(prompt: string): string {
  return [
    'You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.',
    'The tasks typically have to do with coding-related tasks, for example requests for bug fixes or questions about a codebase. The title you generate will be shown in the UI to represent the prompt.',
    'Generate a concise UI title (up to 36 characters) for this task.',
    'Fill the structured title field with plain text.',
    'Fill the structured description field with a compact, search-oriented summary (up to 100 characters). Include concrete project names, code areas, artifacts, people, or recurring responsibility terms when relevant so the thread is easy to retrieve by keyword.',
    'Do not include quotes, markdown, formatting characters, or trailing punctuation in either value.',
    'If the task includes a ticket reference (e.g. ABC-123), include it verbatim.',
    '',
    'Generate a clear, informative task title based solely on the prompt provided.',
    '- Use an imperative verb first: "Add", "Fix", "Update", "Refactor", "Remove", "Locate", "Find", etc.',
    '- Keep it under 36 characters and under 5 words where possible.',
    '- If the user prompt is already a short clear title, reuse it verbatim.',
    '- Capitalize only the first word unless the locale requires otherwise.',
    '- Write the title in the user locale.',
    '- Do not use punctuation at the end.',
    '- Use precise, non-redundant language.',
    '- Leave code terms in English unless a widely adopted translation exists.',
    '- Make it clear whether the user requests a change or asks a question.',
    '- Do not answer the prompt or attempt the work; only fill the title and description fields.',
    '',
    'Examples:',
    '- "Can we add dark-mode support to the settings page?" -> Add dark-mode support',
    '- "How do I fix our login bug?" -> Troubleshoot login bug',
    '- "Where in the codebase is foo_bar created" -> Locate foo_bar',
    '- "what is 2+2" -> Calculate 2+2',
    '',
    'User prompt:',
    prompt,
  ].join('\n')
}

function normalizeGeneratedThreadTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  let title = value
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim() ?? ''
  title = title
    .replace(/^title[:\s]+/iu, '')
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[.?!]+$/gu, '')
    .trim()
  if (title.length > 36) title = `${title.slice(0, 35).trimEnd()}…`
  return title
}

function parseGeneratedThreadTitle(value: string): GeneratedThreadTitle | null {
  if (!value.trim()) return null
  try {
    const parsed = asRecord(JSON.parse(value))
    const title = normalizeGeneratedThreadTitle(parsed?.title)
    const description = typeof parsed?.description === 'string'
      ? parsed.description.replace(/\s+/gu, ' ').trim().slice(0, 100).trimEnd()
      : ''
    return title && description ? { title, description } : null
  } catch {
    return null
  }
}

class ThreadTitleGenerator {
  private readonly appServer = new AppServerProcess()

  async generate(prompt: string, cwd: string | null): Promise<GeneratedThreadTitle | null> {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) return null

    const startResult = await this.appServer.rpc('thread/start', {
      model: THREAD_TITLE_MODEL,
      modelProvider: null,
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: {
        model_reasoning_effort: 'low',
        'features.enable_fanout': false,
        'features.hooks': false,
        'features.multi_agent': false,
        'features.multi_agent_v2': false,
        'features.plugins': false,
        'features.tool_suggest': false,
        'features.apps': false,
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
        web_search: 'disabled',
      },
      personality: null,
      ephemeral: true,
      threadSource: 'system',
      serviceTier: null,
    })
    const threadId = readNestedString(startResult, 'thread', 'id')
    if (!threadId) throw new Error('Title generation did not create an ephemeral thread')

    try {
      return await this.runTitleTurn(
        threadId,
        buildThreadTitlePrompt(trimmedPrompt.slice(0, THREAD_TITLE_PROMPT_LIMIT)),
      )
    } finally {
      await this.appServer.rpc('thread/unsubscribe', { threadId }).catch(() => undefined)
    }
  }

  dispose(): void {
    this.appServer.dispose()
  }

  private async runTitleTurn(threadId: string, prompt: string): Promise<GeneratedThreadTitle | null> {
    let turnId = ''
    let responseText = ''
    let turnError = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let unsubscribe = () => {}
    let resolveResult: (value: GeneratedThreadTitle | null) => void = () => {}
    let rejectResult: (error: Error) => void = () => {}

    const resultPromise = new Promise<GeneratedThreadTitle | null>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const finish = (value: GeneratedThreadTitle | null, error?: Error): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      unsubscribe()
      if (error) rejectResult(error)
      else resolveResult(value)
    }

    unsubscribe = this.appServer.onNotification((notification) => {
      const params = asRecord(notification.params)
      if (typeof params?.threadId !== 'string' || params.threadId !== threadId) return

      if (notification.method === 'turn/started') {
        const startedTurnId = readNestedString(params, 'turn', 'id')
        if (startedTurnId) turnId = startedTurnId
        return
      }
      if (notification.method === 'error') {
        const notificationTurnId = typeof params.turnId === 'string' ? params.turnId : ''
        if (turnId && notificationTurnId && notificationTurnId !== turnId) return
        turnError = readNestedString(params, 'error', 'message') || 'Title generation failed'
        return
      }
      if (notification.method === 'item/agentMessage/delta') {
        const notificationTurnId = typeof params.turnId === 'string' ? params.turnId : ''
        if (turnId && notificationTurnId && notificationTurnId !== turnId) return
        if (typeof params.delta === 'string') responseText += params.delta
        return
      }
      if (notification.method === 'item/completed') {
        const notificationTurnId = typeof params.turnId === 'string' ? params.turnId : ''
        if (turnId && notificationTurnId && notificationTurnId !== turnId) return
        const item = asRecord(params.item)
        if (item?.type === 'agentMessage' && typeof item.text === 'string') responseText = item.text
        return
      }
      if (notification.method !== 'turn/completed') return

      const completedTurn = asRecord(params.turn)
      const completedTurnId = typeof completedTurn?.id === 'string' ? completedTurn.id : ''
      if (turnId && completedTurnId && completedTurnId !== turnId) return
      turnId = completedTurnId || turnId
      if (completedTurn?.status !== 'completed') {
        finish(null, new Error(turnError || `Title generation ended with status ${String(completedTurn?.status ?? 'unknown')}`))
        return
      }
      finish(parseGeneratedThreadTitle(responseText))
    })

    timeout = setTimeout(() => {
      if (turnId) {
        void this.appServer.rpc('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      }
      finish(null, new Error('Title generation timed out'))
    }, THREAD_TITLE_TIMEOUT_MS)
    timeout.unref?.()

    try {
      const startResult = await this.appServer.rpc('turn/start', {
        threadId,
        clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text: prompt }],
        cwd: null,
        approvalPolicy: null,
        sandboxPolicy: null,
        model: null,
        effort: null,
        serviceTier: null,
        summary: 'auto',
        personality: null,
        outputSchema: THREAD_TITLE_OUTPUT_SCHEMA,
      })
      turnId = readNestedString(startResult, 'turn', 'id') || turnId
      return await resultPromise
    } catch (error) {
      finish(null, error instanceof Error ? error : new Error('Title generation failed'))
      return await resultPromise
    }
  }
}

type CodexBridgeMiddleware = ((req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>) & {
  dispose: () => void
  listThreads: (params: Record<string, unknown>) => Promise<unknown>
  readThread: (threadId: string) => Promise<unknown>
  readProjectBoards: () => Promise<ProjectBoardSnapshot>
  takeProjectBoardRecoveryBaseline: () => Promise<ProjectBoardSnapshot> | null
  publishLocalNotification: (method: string, params: unknown) => void
  subscribeNotifications: (listener: (value: { method: string; params: unknown; atIso: string }) => void) => () => void
}

type SharedBridgeState = {
  appServer: AppServerProcess
  threadTitleGenerator: ThreadTitleGenerator
  methodCatalog: MethodCatalog
  automationService: AutomationService
  projectBoardService: ProjectBoardService
  projectBoardRecoveryBaseline: Promise<ProjectBoardSnapshot> | null
}

const SHARED_BRIDGE_KEY = '__codexRemoteSharedBridge__'

function getSharedBridgeState(): SharedBridgeState {
  const globalScope = globalThis as typeof globalThis & {
    [SHARED_BRIDGE_KEY]?: SharedBridgeState
  }

  const existing = globalScope[SHARED_BRIDGE_KEY]
  if (existing) return existing

  const appServer = new AppServerProcess()
  const automationStore = new AutomationStore({
    stateFilePath: join(getCodexHomeDir(), 'codexui-automations.json'),
    sessionsDirectoryPath: join(getCodexHomeDir(), 'sessions'),
  })
  const automationService = new AutomationService({
    store: automationStore,
    appServer,
    createWorktree: createManagedWorktree,
    dynamicToolSpec: AUTOMATION_DYNAMIC_TOOL_SPEC,
  })
  const projectBoardStore = new ProjectBoardStore({
    stateFilePath: join(getCodexHomeDir(), 'codexui-project-boards.json'),
  })
  const projectBoardService = new ProjectBoardService({
    store: projectBoardStore,
    appServer,
    prepareThreadStartParams: (params) => automationService.augmentThreadStartParams(params),
    resolveExecutionSettings: async (settings) => resolveProjectBoardExecutionSettings(
      await readProjectBoardModels((method, params) => appServer.rpc(method, params)), settings,
    ),
  })
  appServer.registerDynamicToolHandler(
    'automation_update',
    (params) => {
      const request = asRecord(params)
      if (typeof request?.threadId === 'string' && projectBoardService.isPlanningThread(request.threadId)
        && asRecord(request.arguments)?.action !== 'view') {
        throw new Error('Planning is read-only. Start implementation before creating or changing automations.')
      }
      return automationService.handleDynamicToolCall(params)
    },
  )
  appServer.registerDynamicToolHandler(
    'project_board_update',
    (params) => projectBoardService.handleDynamicToolCall(params),
  )
  appServer.onNotification((notification) => {
    void automationService.handleNotification(notification)
    void projectBoardService.handleNotification(notification).catch((error) => {
      console.warn('[project-boards] Failed to handle lifecycle notification:', getErrorMessage(error, 'Unknown project-board error'))
    })
  })
  void automationService.start().catch((error) => {
    console.warn('[automations] Failed to start scheduler:', getErrorMessage(error, 'Unknown scheduler error'))
  })
  const projectBoardRecoveryBaseline = projectBoardStore.read()
  void projectBoardRecoveryBaseline.catch(() => undefined)
  void projectBoardService.start().catch((error) => {
    console.warn('[project-boards] Failed to start service:', getErrorMessage(error, 'Unknown project-board error'))
  })

  const created: SharedBridgeState = {
    appServer,
    threadTitleGenerator: new ThreadTitleGenerator(),
    methodCatalog: new MethodCatalog(),
    automationService,
    projectBoardService,
    projectBoardRecoveryBaseline,
  }
  globalScope[SHARED_BRIDGE_KEY] = created
  return created
}

export function createCodexBridgeMiddleware(): CodexBridgeMiddleware {
  const { appServer, threadTitleGenerator, methodCatalog, automationService, projectBoardService } = getSharedBridgeState()
  const localNotificationListeners = new Set<
    (value: { method: string; params: unknown; atIso: string }) => void
  >()

  const emitLocalNotification = (method: string, params: unknown): void => {
    const notification = { method, params, atIso: new Date().toISOString() }
    for (const listener of localNotificationListeners) {
      listener(notification)
    }
  }

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    try {
      if (!req.url) {
        next()
        return
      }

      const url = new URL(req.url, 'http://localhost')

      if (req.method === 'GET' && url.pathname === '/codex-api/runtime-config') {
        setJson(res, 200, { data: readCodexUiRuntimeConfig() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/upload-file') {
        handleFileUpload(req, res)
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/rpc') {
        const payload = await readJsonBody(req)
        const body = asRecord(payload) as RpcProxyRequest | null

        if (!body || typeof body.method !== 'string' || body.method.length === 0) {
          setJson(res, 400, { error: 'Invalid body: expected { method, params? }' })
          return
        }
        const params =
          body.method === 'thread/start'
            ? automationService.augmentThreadStartParams(body.params)
            : body.params ?? null
        const result = await appServer.rpc(body.method, params)
        setJson(res, 200, { result })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/git-workspace/status') {
        const body = asRecord(await readJsonBody(req))
        const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
        if (!threadId) {
          setJson(res, 400, { error: 'Invalid body: expected { threadId }' })
          return
        }
        const payload = asRecord(await appServer.rpc('thread/read', {
          threadId,
          includeTurns: false,
        }))
        const thread = asRecord(payload?.thread)
        const cwd = typeof thread?.cwd === 'string' ? thread.cwd : ''
        if (!cwd) throw new GitWorkspaceRequestError('The thread workspace is unavailable.', 404)
        const result = await readGitWorkspaceStatus(cwd)
        setJson(res, 200, { result })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/git-workspace/review') {
        const body = asRecord(await readJsonBody(req))
        const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
        const source = typeof body?.source === 'string' ? body.source : ''
        const baseBranch = typeof body?.baseBranch === 'string' ? body.baseBranch : undefined
        const allowedSources: GitWorkspaceReviewSource[] = ['uncommitted', 'unstaged', 'staged', 'branch']
        if (!threadId || !allowedSources.includes(source as GitWorkspaceReviewSource)) {
          setJson(res, 400, { error: 'Invalid body: expected { threadId, source, baseBranch? }' })
          return
        }
        const payload = asRecord(await appServer.rpc('thread/read', {
          threadId,
          includeTurns: false,
        }))
        const thread = asRecord(payload?.thread)
        const cwd = typeof thread?.cwd === 'string' ? thread.cwd : ''
        if (!cwd) throw new GitWorkspaceRequestError('The thread workspace is unavailable.', 404)
        const result = await readGitWorkspaceReview(
          cwd,
          source as GitWorkspaceReviewSource,
          baseBranch,
        )
        setJson(res, 200, { result })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/git-workspace/switch-branch') {
        const body = asRecord(await readJsonBody(req))
        const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
        const branch = typeof body?.branch === 'string' ? body.branch : ''
        if (!threadId || !branch.trim()) {
          setJson(res, 400, { error: 'Invalid body: expected { threadId, branch }' })
          return
        }

        let releaseReviewMutation: (() => void) | null = null
        try {
          releaseReviewMutation = appServer.reserveReviewMutation()
          const payload = asRecord(await appServer.rpc('thread/read', {
            threadId,
            includeTurns: true,
          }))
          const thread = asRecord(payload?.thread)
          const turns = Array.isArray(thread?.turns) ? thread.turns : []
          if (turns.some((value) => asRecord(value)?.status === 'inProgress')) {
            throw new GitWorkspaceRequestError('Wait for the current turn to finish before switching branches.', 409)
          }
          const cwd = typeof thread?.cwd === 'string' ? thread.cwd : ''
          if (!cwd) throw new GitWorkspaceRequestError('The thread workspace is unavailable.', 404)
          const result = await switchGitWorkspaceBranch(cwd, branch)
          if (result.status === 'success') {
            emitLocalNotification('git-workspace/changed', {
              threadId,
              branch: result.currentBranch,
            })
          }
          setJson(res, 200, { result })
        } finally {
          releaseReviewMutation?.()
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/review-changes/apply') {
        const body = asRecord(await readJsonBody(req))
        const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
        const turnId = typeof body?.turnId === 'string' ? body.turnId.trim() : ''
        const reverse = body?.reverse
        const scope = readReviewClientScope(body?.scope)
        if (!threadId || !turnId || typeof reverse !== 'boolean' || !scope) {
          setJson(res, 400, { error: 'Invalid body: expected { threadId, turnId, reverse, scope }' })
          return
        }

        let releaseReviewMutation: (() => void) | null = null
        try {
          releaseReviewMutation = appServer.reserveReviewMutation()
          const payload = asRecord(await appServer.rpc('thread/read', {
            threadId,
            includeTurns: true,
          }))
          const thread = asRecord(payload?.thread)
          const turns = Array.isArray(thread?.turns) ? thread.turns : []
          const turn = turns
            .map((value) => asRecord(value))
            .find((value) => value?.id === turnId)
          if (!turn || !Array.isArray(turn.items)) {
            throw new ReviewPatchRequestError('The saved turn could not be found.', 404)
          }
          if (turns.some((value) => asRecord(value)?.status === 'inProgress')) {
            throw new ReviewPatchRequestError('Wait for the current turn to finish before changing earlier edits.', 409)
          }

          const threadCwd = typeof thread?.cwd === 'string' ? thread.cwd : ''
          const gitWorkspace = await resolveReviewGitWorkspace(threadCwd)
          const authoritativeItems = await canonicalizeReviewCommandWorkingDirectories(
            gitWorkspace,
            turn.items as Parameters<typeof buildReviewChanges>[0],
          )
          const review = buildReviewChanges(
            authoritativeItems,
            gitWorkspace.cwd,
            gitWorkspace.root,
            { strict: true },
          )
          if (!review) {
            throw new ReviewPatchRequestError('This turn has no completed file changes.', 409)
          }
          if (!reviewScopeMatches(scope, review)) {
            throw new ReviewPatchRequestError(
              'The saved changes no longer match this Review card. Reload the thread and try again.',
              409,
            )
          }
          const result = await applyReviewPatchSequence({
            cwd: gitWorkspace.root,
            patches: review.patchBatches.map((batch) => batch.patch ?? ''),
            reverse,
          })
          emitLocalNotification('git-workspace/changed', { threadId })
          setJson(res, 200, { result })
        } catch (error) {
          const statusCode = error instanceof ReviewPatchRequestError
            ? error.statusCode
            : error instanceof ReviewMutationConflictError
              ? 409
              : error instanceof ReviewDiffDataError
                ? 409
                : 502
          setJson(res, statusCode, {
            error: getErrorMessage(error, 'Failed to update the saved changes'),
          })
        } finally {
          releaseReviewMutation?.()
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-title/generate') {
        const body = asRecord(await readJsonBody(req))
        const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
        const cwd = typeof body?.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null
        if (!prompt.trim()) {
          setJson(res, 400, { error: 'Invalid body: expected { prompt, cwd? }' })
          return
        }

        const result = await threadTitleGenerator.generate(prompt, cwd)
        setJson(res, 200, { result: result ?? { title: '', description: '' } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-page') {
        const body = asRecord(await readJsonBody(req))
        const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
        if (!threadId) {
          setJson(res, 400, { error: 'Invalid body: expected { threadId, beforeTurnIndex?, limit? }' })
          return
        }

        const result = await appServer.rpc('thread/read', {
          threadId,
          includeTurns: true,
        })
        setJson(res, 200, {
          result: paginateThreadReadResult(result, {
            beforeTurnIndex: typeof body?.beforeTurnIndex === 'number' ? body.beforeTurnIndex : null,
            limit: typeof body?.limit === 'number' ? body.limit : undefined,
          }),
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-resume-lite') {
        const body = asRecord(await readJsonBody(req))
        const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
        if (!threadId) {
          setJson(res, 400, { error: 'Invalid body: expected { threadId }' })
          return
        }

        setJson(res, 200, { result: await resumeThreadLite(appServer, threadId) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-board-models') {
        setJson(res, 200, { data: await readProjectBoardModels((method, params) => appServer.rpc(method, params)) })
        return
      }

      const boardPlanMatch = url.pathname.match(/^\/codex-api\/project-boards\/([^/]+)\/plan$/u)
      if (req.method === 'POST' && boardPlanMatch) {
        const input = asRecord(await readJsonBody(req)) ?? {}
        const sourceThreadId = typeof input.sourceThreadId === 'string' ? input.sourceThreadId.trim() : ''
        let sourceContext = ''
        if (sourceThreadId) {
          const result = asRecord(await appServer.rpc('thread/read', { threadId: sourceThreadId, includeTurns: true }))
          const thread = asRecord(result?.thread)
          if (!thread) throw new Error('The source chat could not be read. Paste its plan into the brief instead.')
          const turns = Array.isArray(thread.turns) ? thread.turns : []
          const messages: ThreadReferenceMessage[] = []
          for (const turn of turns.slice(-12)) {
            const items = asRecord(turn)?.items
            for (const value of Array.isArray(items) ? items : []) {
              const item = asRecord(value)
              if (item?.type === 'agentMessage' && typeof item.text === 'string') messages.push({ role: 'assistant', text: item.text })
              if (item?.type === 'userMessage' && Array.isArray(item.content)) {
                const text = item.content.map((value) => { const part = asRecord(value); return part?.type === 'text' && typeof part.text === 'string' ? part.text : '' }).filter(Boolean).join('\n')
                if (text) messages.push({ role: 'user', text })
              }
            }
          }
          sourceContext = buildThreadReferenceSection([{ id: sourceThreadId, name: typeof thread.name === 'string' ? thread.name : 'Planning chat', path: `thread://${sourceThreadId}`, messages, hasEarlier: turns.length > 12 }])
        }
        setJson(res, 202, { data: await projectBoardService.startBoardPlan(decodeURIComponent(boardPlanMatch[1]), input, sourceContext) })
        return
      }

      const boardQueueMatch = url.pathname.match(/^\/codex-api\/project-boards\/([^/]+)\/queue$/u)
      if (boardQueueMatch && req.method === 'POST') {
        setJson(res, 202, { data: await projectBoardService.startBoardQueue(decodeURIComponent(boardQueueMatch[1]), await readJsonBody(req)) })
        return
      }
      if (boardQueueMatch && req.method === 'DELETE') {
        setJson(res, 200, { data: await projectBoardService.stopBoardQueue(decodeURIComponent(boardQueueMatch[1])) })
        return
      }

      if (url.pathname === '/codex-api/project-boards') {
        if (req.method === 'GET') {
          setJson(res, 200, { data: await projectBoardService.read() })
          return
        }
        if (req.method === 'POST') {
          setJson(res, 200, { data: await projectBoardService.createBoard(await readJsonBody(req)) })
          return
        }
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-boards/ensure') {
        setJson(res, 200, { data: await projectBoardService.ensureDefaultBoard(await readJsonBody(req)) })
        return
      }

      const projectBoardPathMatch = url.pathname.match(/^\/codex-api\/project-boards\/([^/]+)$/u)
      if (projectBoardPathMatch) {
        const boardId = decodeURIComponent(projectBoardPathMatch[1])
        if (req.method === 'PATCH') {
          setJson(res, 200, { data: await projectBoardService.updateBoard(boardId, await readJsonBody(req)) })
          return
        }
        if (req.method === 'DELETE') {
          setJson(res, 200, { data: await projectBoardService.deleteBoard(boardId) })
          return
        }
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-board-agents') {
        setJson(res, 200, { data: await projectBoardService.createAgent(await readJsonBody(req)) })
        return
      }

      const projectBoardAgentMatch = url.pathname.match(/^\/codex-api\/project-board-agents\/([^/]+)$/u)
      if (projectBoardAgentMatch) {
        const agentId = decodeURIComponent(projectBoardAgentMatch[1])
        if (req.method === 'PATCH') {
          setJson(res, 200, { data: await projectBoardService.updateAgent(agentId, await readJsonBody(req)) })
          return
        }
        if (req.method === 'DELETE') {
          setJson(res, 200, { data: await projectBoardService.deleteAgent(agentId) })
          return
        }
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-board-cards') {
        setJson(res, 200, { data: await projectBoardService.createCard(await readJsonBody(req)) })
        return
      }

      const startProjectBoardCardMatch = url.pathname.match(/^\/codex-api\/project-board-cards\/([^/]+)\/start$/u)
      if (req.method === 'POST' && startProjectBoardCardMatch) {
        setJson(res, 202, {
          data: await projectBoardService.startFeature(
            decodeURIComponent(startProjectBoardCardMatch[1]),
            await readJsonBody(req),
          ),
        })
        return
      }

      const commentProjectBoardCardMatch = url.pathname.match(/^\/codex-api\/project-board-cards\/([^/]+)\/comments$/u)
      if (req.method === 'POST' && commentProjectBoardCardMatch) {
        setJson(res, 200, {
          data: await projectBoardService.addComment(
            decodeURIComponent(commentProjectBoardCardMatch[1]),
            await readJsonBody(req),
          ),
        })
        return
      }

      const projectBoardCardMatch = url.pathname.match(/^\/codex-api\/project-board-cards\/([^/]+)$/u)
      if (projectBoardCardMatch) {
        const cardId = decodeURIComponent(projectBoardCardMatch[1])
        if (req.method === 'PATCH') {
          setJson(res, 200, { data: await projectBoardService.updateCard(cardId, await readJsonBody(req)) })
          return
        }
        if (req.method === 'DELETE') {
          setJson(res, 200, { data: await projectBoardService.deleteCard(cardId) })
          return
        }
      }

      const answerProjectBoardQuestionMatch = url.pathname.match(/^\/codex-api\/project-board-questions\/([^/]+)\/answer$/u)
      if (req.method === 'POST' && answerProjectBoardQuestionMatch) {
        setJson(res, 200, {
          data: await projectBoardService.answerQuestion(
            decodeURIComponent(answerProjectBoardQuestionMatch[1]),
            await readJsonBody(req),
          ),
        })
        return
      }

      if (url.pathname === '/codex-api/automations') {
        if (req.method === 'GET') {
          setJson(res, 200, { data: await automationService.read() })
          return
        }
        if (req.method === 'POST') {
          setJson(res, 200, { data: await automationService.create(await readJsonBody(req)) })
          return
        }
      }

      const automationPathMatch = url.pathname.match(/^\/codex-api\/automations\/([^/]+)$/u)
      if (automationPathMatch) {
        const automationId = decodeURIComponent(automationPathMatch[1])
        if (req.method === 'PATCH') {
          setJson(res, 200, {
            data: await automationService.update(automationId, await readJsonBody(req)),
          })
          return
        }
        if (req.method === 'DELETE') {
          setJson(res, 200, { data: await automationService.delete(automationId) })
          return
        }
      }

      const runAutomationMatch = url.pathname.match(/^\/codex-api\/automations\/([^/]+)\/run$/u)
      if (req.method === 'POST' && runAutomationMatch) {
        setJson(res, 202, {
          data: await automationService.runNow(decodeURIComponent(runAutomationMatch[1])),
        })
        return
      }

      const proposalMatch = url.pathname.match(/^\/codex-api\/automation-proposals\/([^/]+)\/resolve$/u)
      if (req.method === 'POST' && proposalMatch) {
        const body = asRecord(await readJsonBody(req))
        setJson(res, 200, {
          data: await automationService.resolveProposal(
            decodeURIComponent(proposalMatch[1]),
            body?.accept === true,
          ),
        })
        return
      }

      const runMatch = url.pathname.match(/^\/codex-api\/automation-runs\/([^/]+)$/u)
      if (req.method === 'PATCH' && runMatch) {
        const body = asRecord(await readJsonBody(req))
        setJson(res, 200, {
          data: await automationService.updateRun(decodeURIComponent(runMatch[1]), {
            ...(typeof body?.unread === 'boolean' ? { unread: body.unread } : {}),
            ...(typeof body?.archived === 'boolean' ? { archived: body.archived } : {}),
          }),
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/worktree') {
        const payload = asRecord(await readJsonBody(req))
        const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing workspace path' })
          return
        }
        const cwd = resolve(rawCwd)
        try {
          const info = await stat(cwd)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'Workspace path is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'Workspace path does not exist' })
          return
        }

        try {
          const worktreePath = await createManagedWorktree(cwd)
          setJson(res, 200, { data: { path: worktreePath } })
        } catch (error) {
          setJson(res, 400, { error: getErrorMessage(error, 'Failed to create a Git worktree') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/transcribe') {
        const auth = await readCodexAuth()
        if (!auth) {
          setJson(res, 401, { error: 'No auth token available for transcription' })
          return
        }

        const rawBody = await readRawBody(req)
        const incomingCt = req.headers['content-type'] ?? 'application/octet-stream'
        const upstream = await proxyTranscribe(rawBody, incomingCt, auth.accessToken, auth.accountId)

        res.statusCode = upstream.status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(upstream.body)
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/rate-limit-reset-credits') {
        const auth = await readCodexAuth()
        if (!auth) {
          setJson(res, 401, { error: 'No auth token available for reset credits' })
          return
        }

        const upstream = await proxyRateLimitResetCredits(auth.accessToken, auth.accountId)
        res.statusCode = upstream.status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(upstream.body)
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/server-requests/respond') {
        const payload = await readJsonBody(req)
        await appServer.respondToServerRequest(payload)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/server-requests/pending') {
        setJson(res, 200, { data: appServer.listPendingServerRequests() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/methods') {
        const methods = await methodCatalog.listMethods()
        setJson(res, 200, { data: methods })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/notifications') {
        const methods = await methodCatalog.listNotificationMethods()
        setJson(res, 200, { data: methods })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/workspace-roots-state') {
        const state = await readWorkspaceRootsState()
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/home-directory') {
        setJson(res, 200, { data: { path: homedir() } })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/workspace-roots-state') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        const nextState: WorkspaceRootsState = {
          order: normalizeStringArray(record.order),
          labels: normalizeStringRecord(record.labels),
          active: normalizeStringArray(record.active),
        }
        await writeWorkspaceRootsState(nextState)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-root') {
        const payload = asRecord(await readJsonBody(req))
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
        const createIfMissing = payload?.createIfMissing === true
        const label = typeof payload?.label === 'string' ? payload.label : ''
        if (!rawPath) {
          setJson(res, 400, { error: 'Missing path' })
          return
        }

        const normalizedPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath)
        let pathExists = true
        try {
          const info = await stat(normalizedPath)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'Path exists but is not a directory' })
            return
          }
        } catch {
          pathExists = false
        }

        if (!pathExists && createIfMissing) {
          await mkdir(normalizedPath, { recursive: true })
        } else if (!pathExists) {
          setJson(res, 404, { error: 'Directory does not exist' })
          return
        }

        const existingState = await readWorkspaceRootsState()
        const nextOrder = [normalizedPath, ...existingState.order.filter((item) => item !== normalizedPath)]
        const nextActive = [normalizedPath, ...existingState.active.filter((item) => item !== normalizedPath)]
        const nextLabels = { ...existingState.labels }
        if (label.trim().length > 0) {
          nextLabels[normalizedPath] = label.trim()
        }
        await writeWorkspaceRootsState({
          order: nextOrder,
          labels: nextLabels,
          active: nextActive,
        })
        setJson(res, 200, { data: { path: normalizedPath } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-root-suggestion') {
        const basePath = url.searchParams.get('basePath')?.trim() ?? ''
        if (!basePath) {
          setJson(res, 400, { error: 'Missing basePath' })
          return
        }
        const normalizedBasePath = isAbsolute(basePath) ? basePath : resolve(basePath)
        try {
          const baseInfo = await stat(normalizedBasePath)
          if (!baseInfo.isDirectory()) {
            setJson(res, 400, { error: 'basePath is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'basePath does not exist' })
          return
        }

        let index = 1
        while (index < 100000) {
          const candidateName = `New Project (${String(index)})`
          const candidatePath = join(normalizedBasePath, candidateName)
          try {
            await stat(candidatePath)
            index += 1
            continue
          } catch {
            setJson(res, 200, { data: { name: candidateName, path: candidatePath } })
            return
          }
        }

        setJson(res, 500, { error: 'Failed to compute project name suggestion' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/composer-file-search') {
        const payload = asRecord(await readJsonBody(req))
        const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
        const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
        const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 20
        const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)))
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const info = await stat(cwd)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }

        try {
          const files = await listFilesWithRipgrep(cwd)
          const scored = files
            .map((path) => ({ path, score: scoreFileCandidate(path, query) }))
            .filter((row) => query.length === 0 || row.score < 10)
            .sort((a, b) => (a.score - b.score) || a.path.localeCompare(b.path))
            .slice(0, limit)
            .map((row) => ({ path: row.path }))
          setJson(res, 200, { data: scored })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to search files') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-titles') {
        const cache = await readThreadTitleCache()
        setJson(res, 200, { data: cache })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-titles') {
        const payload = asRecord(await readJsonBody(req))
        const id = typeof payload?.id === 'string' ? payload.id : ''
        const title = typeof payload?.title === 'string' ? payload.title : ''
        if (!id) {
          setJson(res, 400, { error: 'Missing id' })
          return
        }
        const cache = await updateThreadTitle(id, title)
        setJson(res, 200, { data: cache })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/pinned-threads') {
        const threadIds = await readPinnedThreadIds()
        setJson(res, 200, { data: { threadIds } })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/pinned-threads') {
        const payload = asRecord(await readJsonBody(req))
        const result = await reorderPinnedThreadIds(normalizeStringArray(payload?.threadIds))
        if (!result.accepted) {
          console.warn('[pins] Rejected stale full-list update; pin membership may only change through PATCH.')
          emitLocalNotification('codexui/pinnedThreads/updated', { threadIds: result.threadIds })
          setJson(res, 200, {
            data: { threadIds: result.threadIds },
            conflict: true,
          })
          return
        }
        const threadIds = result.threadIds
        emitLocalNotification('codexui/pinnedThreads/updated', { threadIds })
        setJson(res, 200, { data: { threadIds } })
        return
      }

      if (req.method === 'PATCH' && url.pathname === '/codex-api/pinned-threads') {
        const payload = asRecord(await readJsonBody(req))
        const threadId = typeof payload?.threadId === 'string' ? payload.threadId.trim() : ''
        const pinned = payload?.pinned
        const beforeThreadId =
          typeof payload?.beforeThreadId === 'string' ? payload.beforeThreadId.trim() : ''
        if (!threadId || typeof pinned !== 'boolean') {
          setJson(res, 400, { error: 'threadId and pinned are required' })
          return
        }
        const threadIds = await updatePinnedThread(threadId, pinned, beforeThreadId || undefined)
        emitLocalNotification('codexui/pinnedThreads/updated', { threadIds })
        setJson(res, 200, { data: { threadIds } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-read-state') {
        const state = await readSharedThreadReadState()
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-read-state') {
        const payload = asRecord(await readJsonBody(req))
        const threadId = typeof payload?.threadId === 'string' ? payload.threadId.trim() : ''
        const unread = payload?.unread
        const readAtIso = typeof payload?.readAtIso === 'string' ? payload.readAtIso.trim() : ''
        if (!threadId || typeof unread !== 'boolean') {
          setJson(res, 400, { error: 'Invalid body: threadId and unread are required' })
          return
        }
        const state = await updateSharedThreadReadState(threadId, unread, readAtIso)
        appServer.publishLocalNotification('codexui/threadReadState/updated', state)
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/skills-hub') {
        try {
          const q = url.searchParams.get('q') || ''
          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200)
          const sort = url.searchParams.get('sort') || 'date'
          const allEntries = await fetchSkillsTree()

          const installedMap = await scanInstalledSkillsFromDisk()
          try {
            const result = (await appServer.rpc('skills/list', {})) as { data?: Array<{ skills?: Array<{ name?: string; path?: string; enabled?: boolean }> }> }
            for (const entry of result.data ?? []) {
              for (const skill of entry.skills ?? []) {
                if (skill.name) {
                  installedMap.set(skill.name, { name: skill.name, path: skill.path ?? '', enabled: skill.enabled !== false })
                }
              }
            }
          } catch {}

          const installedHubEntries = allEntries.filter((e) => installedMap.has(e.name))
          await fetchMetaBatch(installedHubEntries)

          const installed: SkillHubEntry[] = []
          for (const [, info] of installedMap) {
            const hubEntry = allEntries.find((e) => e.name === info.name)
            const base = hubEntry ? buildHubEntry(hubEntry) : {
              name: info.name, owner: 'local', description: '', displayName: '',
              publishedAt: 0, avatarUrl: '', url: '', installed: false,
            }
            installed.push({ ...base, installed: true, path: info.path, enabled: info.enabled })
          }

          const results = await searchSkillsHub(allEntries, q, limit, sort, installedMap)
          setJson(res, 200, { data: results, installed, total: allEntries.length })
        } catch (error) {
          setJson(res, 502, { error: getErrorMessage(error, 'Failed to fetch skills hub') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/skills-hub/readme') {
        try {
          const owner = url.searchParams.get('owner') || ''
          const name = url.searchParams.get('name') || ''
          if (!owner || !name) {
            setJson(res, 400, { error: 'Missing owner or name' })
            return
          }
          const rawUrl = `https://raw.githubusercontent.com/openclaw/skills/main/skills/${owner}/${name}/SKILL.md`
          const resp = await fetch(rawUrl)
          if (!resp.ok) throw new Error(`Failed to fetch SKILL.md: ${resp.status}`)
          const content = await resp.text()
          setJson(res, 200, { content })
        } catch (error) {
          setJson(res, 502, { error: getErrorMessage(error, 'Failed to fetch SKILL.md') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/skills-hub/install') {
        try {
          const payload = asRecord(await readJsonBody(req))
          const owner = typeof payload?.owner === 'string' ? payload.owner : ''
          const name = typeof payload?.name === 'string' ? payload.name : ''
          if (!owner || !name) {
            setJson(res, 400, { error: 'Missing owner or name' })
            return
          }
          const installerScript = join(
            getCodexHomeDir(),
            'skills',
            '.system',
            'skill-installer',
            'scripts',
            'install-skill-from-github.py',
          )
          if (!existsSync(installerScript)) {
            throw new Error(`Codex skill installer was not found under CODEX_HOME: ${installerScript}`)
          }
          const installDest = await detectUserSkillsDir(appServer)
          const skillPathInRepo = `skills/${owner}/${name}`
          await runCommand('python3', [
            installerScript,
            '--repo', 'openclaw/skills',
            '--path', skillPathInRepo,
            '--dest', installDest,
            '--method', 'git',
          ])
          const skillDir = join(installDest, name)
          await ensureInstalledSkillIsValid(appServer, skillDir)
          setJson(res, 200, { ok: true, path: skillDir })
        } catch (error) {
          setJson(res, 502, { error: getErrorMessage(error, 'Failed to install skill') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/skills-hub/uninstall') {
        try {
          const payload = asRecord(await readJsonBody(req))
          const name = typeof payload?.name === 'string' ? payload.name : ''
          const path = typeof payload?.path === 'string' ? payload.path : ''
          if (!name) {
            setJson(res, 400, { error: 'Missing skill name' })
            return
          }
          const skillsResult = (await appServer.rpc('skills/list', { forceReload: true })) as {
            data?: Array<{ skills?: InstalledSkillPath[] }>
          }
          const installedSkills = (skillsResult.data ?? []).flatMap((entry) => entry.skills ?? [])
          const target = await resolveSkillUninstallTarget({
            defaultSkillsRoot: getSkillsInstallDir(),
            installedSkills,
            name,
            requestedPath: path,
          })
          await rm(target, { recursive: true, force: true })
          try { await appServer.rpc('skills/list', { forceReload: true }) } catch {}
          setJson(res, 200, { ok: true, deletedPath: target })
        } catch (error) {
          setJson(res, error instanceof SkillUninstallTargetError ? 400 : 502, {
            error: getErrorMessage(error, 'Failed to uninstall skill'),
          })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/events') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')

        const unsubscribe = middleware.subscribeNotifications((notification: { method: string; params: unknown; atIso: string }) => {
          if (res.writableEnded || res.destroyed) return
          res.write(`data: ${JSON.stringify(notification)}\n\n`)
        })

        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        const keepAlive = setInterval(() => {
          res.write(': ping\n\n')
        }, 5000)

        const close = () => {
          clearInterval(keepAlive)
          unsubscribe()
          if (!res.writableEnded) {
            res.end()
          }
        }

        req.on('close', close)
        req.on('aborted', close)
        return
      }

      if (url.pathname.startsWith('/codex-api/')) {
        setJson(res, 404, { error: 'Unknown CodexUI API route.' })
        return
      }

      next()
    } catch (error) {
      const message = getErrorMessage(error, 'Unknown bridge error')
      const statusCode = error instanceof ReviewMutationConflictError
        ? 409
        : error instanceof GitWorkspaceRequestError
          ? error.statusCode
          : error instanceof ReviewDiffDataError
            ? 413
            : 502
      setJson(res, statusCode, { error: message })
    }
  }

  middleware.dispose = () => {
    appServer.dispose()
    threadTitleGenerator.dispose()
  }
  middleware.listThreads = (params: Record<string, unknown>) => appServer.rpc('thread/list', params)
  middleware.readThread = (threadId: string) => appServer.rpc('thread/read', {
    threadId,
    includeTurns: false,
  })
  middleware.readProjectBoards = () => projectBoardService.read()
  middleware.takeProjectBoardRecoveryBaseline = () => {
    const shared = getSharedBridgeState()
    const baseline = shared.projectBoardRecoveryBaseline
    shared.projectBoardRecoveryBaseline = null
    return baseline
  }
  middleware.publishLocalNotification = (method: string, params: unknown) => appServer.publishLocalNotification(method, params)
  middleware.subscribeNotifications = (
    listener: (value: { method: string; params: unknown; atIso: string }) => void,
  ) => {
    localNotificationListeners.add(listener)
    const unsubscribeAppServer = appServer.onNotification((notification: { method: string; params: unknown }) => {
      listener({
        ...notification,
        atIso: new Date().toISOString(),
      })
    })
    return () => {
      localNotificationListeners.delete(listener)
      unsubscribeAppServer()
    }
  }

  return middleware
}
