import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'

export type ThreadTitleCache = {
  titles: Record<string, string>
  order: string[]
}

export type SharedThreadReadState = {
  readAtByThreadId: Record<string, string>
  unreadThreadIds: string[]
  readOrder: string[]
  version: number
}

type ThreadMetadataState = {
  titles: ThreadTitleCache
  readState: SharedThreadReadState
  version: number
  updatedAtIso: string
}

type ThreadMetadataStoreOptions = {
  stateFilePath: string
  readLegacyTitles: () => Promise<unknown>
  readLegacyReadState: () => Promise<unknown>
  now?: () => Date
}

const MAX_THREAD_TITLES = 500
const MAX_THREAD_READ_STATES = 500
const MAX_UNREAD_THREADS = 100

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const values: string[] = []
  for (const entry of value) {
    const normalized = typeof entry === 'string' ? entry.trim() : ''
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    values.push(normalized)
  }
  return values
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (!record) return {}
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key, entry]) => Boolean(key) && typeof entry === 'string' && entry.trim().length > 0)
      .map(([key, entry]) => [key, (entry as string).trim()]),
  )
}

export function normalizeThreadTitleCache(value: unknown): ThreadTitleCache {
  const record = asRecord(value) ?? {}
  const titles = normalizeStringRecord(record.titles)
  const order = normalizeStringArray(record.order).filter((threadId) => threadId in titles)
  for (const threadId of Object.keys(titles)) {
    if (!order.includes(threadId)) order.push(threadId)
  }
  return {
    titles: Object.fromEntries(order.slice(0, MAX_THREAD_TITLES).map((threadId) => [threadId, titles[threadId]])),
    order: order.slice(0, MAX_THREAD_TITLES),
  }
}

export function normalizeSharedThreadReadState(value: unknown): SharedThreadReadState {
  const record = asRecord(value) ?? {}
  const readAtByThreadId = normalizeStringRecord(record.readAtByThreadId)
  const readOrder = normalizeStringArray(record.readOrder).filter((threadId) => threadId in readAtByThreadId)
  for (const threadId of Object.keys(readAtByThreadId)) {
    if (!readOrder.includes(threadId)) readOrder.push(threadId)
  }
  return {
    readAtByThreadId: Object.fromEntries(
      readOrder.slice(0, MAX_THREAD_READ_STATES).map((threadId) => [threadId, readAtByThreadId[threadId]]),
    ),
    unreadThreadIds: normalizeStringArray(record.unreadThreadIds).slice(0, MAX_UNREAD_THREADS),
    readOrder: readOrder.slice(0, MAX_THREAD_READ_STATES),
    version:
      typeof record.version === 'number' && Number.isFinite(record.version)
        ? Math.max(0, Math.floor(record.version))
        : 0,
  }
}

function normalizeState(value: unknown): ThreadMetadataState | null {
  const record = asRecord(value)
  if (!record) return null
  return {
    titles: normalizeThreadTitleCache(record.titles),
    readState: normalizeSharedThreadReadState(record.readState),
    version:
      typeof record.version === 'number' && Number.isFinite(record.version)
        ? Math.max(1, Math.floor(record.version))
        : 1,
    updatedAtIso:
      typeof record.updatedAtIso === 'string' && record.updatedAtIso.trim()
        ? record.updatedAtIso.trim()
        : new Date(0).toISOString(),
  }
}

function isMissingFileError(error: unknown): boolean {
  return asRecord(error)?.code === 'ENOENT'
}

export class ThreadMetadataStore {
  private readonly stateFilePath: string
  private readonly readLegacyTitles: () => Promise<unknown>
  private readonly readLegacyReadState: () => Promise<unknown>
  private readonly now: () => Date
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(options: ThreadMetadataStoreOptions) {
    this.stateFilePath = options.stateFilePath
    this.readLegacyTitles = options.readLegacyTitles
    this.readLegacyReadState = options.readLegacyReadState
    this.now = options.now ?? (() => new Date())
  }

  readTitles(): Promise<ThreadTitleCache> {
    return this.enqueue(async () => (await this.loadOrMigrate()).titles)
  }

  updateTitle(threadId: string, title: string): Promise<ThreadTitleCache> {
    return this.enqueue(async () => {
      const current = await this.loadOrMigrate()
      const normalizedTitle = title.trim()
      const titles = { ...current.titles.titles }
      let order = current.titles.order.filter((id) => id !== threadId)
      if (normalizedTitle) {
        titles[threadId] = normalizedTitle
        order = [threadId, ...order]
      } else {
        delete titles[threadId]
      }
      while (order.length > MAX_THREAD_TITLES) {
        const removed = order.pop()
        if (removed) delete titles[removed]
      }
      const nextTitles = { titles, order }
      await this.write(this.nextState(current, { titles: nextTitles }))
      return nextTitles
    })
  }

  readReadState(): Promise<SharedThreadReadState> {
    return this.enqueue(async () => (await this.loadOrMigrate()).readState)
  }

  updateReadState(threadId: string, unread: boolean, readAtIso: string): Promise<SharedThreadReadState> {
    return this.enqueue(async () => {
      const current = await this.loadOrMigrate()
      const readAtByThreadId = { ...current.readState.readAtByThreadId }
      let readOrder = [...current.readState.readOrder]
      if (readAtIso) {
        readAtByThreadId[threadId] = readAtIso
        readOrder = [threadId, ...readOrder.filter((id) => id !== threadId)]
      }
      while (readOrder.length > MAX_THREAD_READ_STATES) {
        const removed = readOrder.pop()
        if (removed) delete readAtByThreadId[removed]
      }
      const unreadThreadIds = unread
        ? [threadId, ...current.readState.unreadThreadIds.filter((id) => id !== threadId)].slice(0, MAX_UNREAD_THREADS)
        : current.readState.unreadThreadIds.filter((id) => id !== threadId)
      const readState = {
        readAtByThreadId,
        unreadThreadIds,
        readOrder,
        version: current.readState.version + 1,
      }
      await this.write(this.nextState(current, { readState }))
      return readState
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.operationQueue.then(operation)
    this.operationQueue = queued.then(() => undefined, () => undefined)
    return queued
  }

  private async loadOrMigrate(): Promise<ThreadMetadataState> {
    try {
      const raw = await readFile(this.stateFilePath, 'utf8')
      const state = normalizeState(JSON.parse(raw))
      if (!state) throw new Error('CodexUI thread metadata state is invalid.')
      return state
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }

    const migrated: ThreadMetadataState = {
      titles: normalizeThreadTitleCache(await this.readLegacyTitles()),
      readState: normalizeSharedThreadReadState(await this.readLegacyReadState()),
      version: 1,
      updatedAtIso: this.now().toISOString(),
    }
    await this.write(migrated)
    return migrated
  }

  private nextState(
    current: ThreadMetadataState,
    changes: Partial<Pick<ThreadMetadataState, 'titles' | 'readState'>>,
  ): ThreadMetadataState {
    return {
      ...current,
      ...changes,
      version: current.version + 1,
      updatedAtIso: this.now().toISOString(),
    }
  }

  private async write(state: ThreadMetadataState): Promise<void> {
    const temporaryPath = `${this.stateFilePath}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.stateFilePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
