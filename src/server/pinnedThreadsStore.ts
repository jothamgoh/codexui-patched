import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import {
  applyPinnedThreadIntent,
  hasSamePinnedThreadMembership,
  normalizePinnedThreadIds,
  type SetThreadPinnedIntent,
} from '../utils/pinnedThreads'

export type PinnedThreadsState = {
  threadIds: string[]
  version: number
  updatedAtIso: string
}

export type PinnedThreadsOrderResult = PinnedThreadsState & {
  accepted: boolean
}

type PinnedThreadsStoreOptions = {
  stateFilePath: string
  readLegacyThreadIds: () => Promise<unknown>
  now?: () => Date
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeState(value: unknown): PinnedThreadsState | null {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.threadIds)) return null
  const version =
    typeof record.version === 'number' && Number.isFinite(record.version)
      ? Math.max(1, Math.floor(record.version))
      : 1
  return {
    threadIds: normalizePinnedThreadIds(record.threadIds),
    version,
    updatedAtIso:
      typeof record.updatedAtIso === 'string' && record.updatedAtIso.trim()
        ? record.updatedAtIso.trim()
        : new Date(0).toISOString(),
  }
}

function isMissingFileError(error: unknown): boolean {
  return asRecord(error)?.code === 'ENOENT'
}

export class PinnedThreadsStore {
  private readonly stateFilePath: string
  private readonly readLegacyThreadIds: () => Promise<unknown>
  private readonly now: () => Date
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(options: PinnedThreadsStoreOptions) {
    this.stateFilePath = options.stateFilePath
    this.readLegacyThreadIds = options.readLegacyThreadIds
    this.now = options.now ?? (() => new Date())
  }

  read(): Promise<PinnedThreadsState> {
    return this.enqueue(() => this.loadOrMigrate())
  }

  reorder(threadIds: string[]): Promise<PinnedThreadsOrderResult> {
    return this.enqueue(async () => {
      const current = await this.loadOrMigrate()
      const requested = normalizePinnedThreadIds(threadIds)
      if (!hasSamePinnedThreadMembership(current.threadIds, requested)) {
        return { ...current, accepted: false }
      }
      if (requested.every((threadId, index) => current.threadIds[index] === threadId)) {
        return { ...current, accepted: true }
      }
      const next = this.nextState(current, requested)
      await this.write(next)
      return { ...next, accepted: true }
    })
  }

  update(intent: SetThreadPinnedIntent): Promise<PinnedThreadsState> {
    return this.enqueue(async () => {
      const current = await this.loadOrMigrate()
      const threadIds = applyPinnedThreadIntent(current.threadIds, intent)
      if (
        threadIds.length === current.threadIds.length &&
        threadIds.every((threadId, index) => current.threadIds[index] === threadId)
      ) {
        return current
      }
      const next = this.nextState(current, threadIds)
      await this.write(next)
      return next
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.operationQueue.then(operation)
    this.operationQueue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  private async loadOrMigrate(): Promise<PinnedThreadsState> {
    try {
      const raw = await readFile(this.stateFilePath, 'utf8')
      const state = normalizeState(JSON.parse(raw))
      if (!state) throw new Error('CodexUI pinned thread state is invalid.')
      return state
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }

    const migrated: PinnedThreadsState = {
      threadIds: normalizePinnedThreadIds(await this.readLegacyThreadIds()),
      version: 1,
      updatedAtIso: this.now().toISOString(),
    }
    await this.write(migrated)
    return migrated
  }

  private nextState(current: PinnedThreadsState, threadIds: string[]): PinnedThreadsState {
    return {
      threadIds,
      version: current.version + 1,
      updatedAtIso: this.now().toISOString(),
    }
  }

  private async write(state: PinnedThreadsState): Promise<void> {
    const temporaryPath = `${this.stateFilePath}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(temporaryPath, JSON.stringify(state), {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(temporaryPath, this.stateFilePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
