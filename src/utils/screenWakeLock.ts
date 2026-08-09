type WakeLockNavigator = Partial<Pick<Navigator, 'wakeLock'>>
type VisibilityDocument = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>

export type ScreenWakeLockController = {
  acquire: () => Promise<void>
  release: () => Promise<void>
}

export function createScreenWakeLockController(options: {
  navigator?: WakeLockNavigator
  document?: VisibilityDocument
} = {}): ScreenWakeLockController {
  const navigatorLike = options.navigator
    ?? (typeof navigator !== 'undefined' ? navigator : undefined)
  const documentLike = options.document
    ?? (typeof document !== 'undefined' ? document : undefined)

  let sentinel: WakeLockSentinel | null = null
  let requestInFlight: Promise<void> | null = null
  let shouldHoldLock = false
  let generation = 0
  let isListeningForVisibility = false

  async function safelyReleaseSentinel(nextSentinel: WakeLockSentinel): Promise<void> {
    try {
      await nextSentinel.release()
    } catch {
      // Wake locks are best-effort and may already have been released by the browser.
    }
  }

  function onSentinelRelease(): void {
    sentinel = null
  }

  function onVisibilityChange(): void {
    if (documentLike?.visibilityState === 'visible' && shouldHoldLock) {
      void acquire()
    }
  }

  function addVisibilityListener(): void {
    if (!documentLike || isListeningForVisibility) return
    documentLike.addEventListener('visibilitychange', onVisibilityChange)
    isListeningForVisibility = true
  }

  function removeVisibilityListener(): void {
    if (!documentLike || !isListeningForVisibility) return
    documentLike.removeEventListener('visibilitychange', onVisibilityChange)
    isListeningForVisibility = false
  }

  async function acquire(): Promise<void> {
    shouldHoldLock = true
    addVisibilityListener()

    if (
      sentinel
      || requestInFlight
      || !navigatorLike?.wakeLock
      || documentLike?.visibilityState === 'hidden'
    ) {
      return requestInFlight ?? Promise.resolve()
    }

    const requestGeneration = generation
    let sentinelRequest: Promise<WakeLockSentinel>
    try {
      sentinelRequest = navigatorLike.wakeLock.request('screen')
    } catch {
      return
    }

    const pendingRequest = sentinelRequest
      .then(async (nextSentinel) => {
        if (!shouldHoldLock || requestGeneration !== generation) {
          await safelyReleaseSentinel(nextSentinel)
          return
        }
        sentinel = nextSentinel
        sentinel.addEventListener('release', onSentinelRelease, { once: true })
      })
      .catch(() => undefined)
      .finally(() => {
        if (requestInFlight === pendingRequest) requestInFlight = null
      })

    requestInFlight = pendingRequest
    await pendingRequest
  }

  async function release(): Promise<void> {
    shouldHoldLock = false
    generation += 1
    removeVisibilityListener()

    const activeSentinel = sentinel
    sentinel = null
    if (activeSentinel) {
      activeSentinel.removeEventListener('release', onSentinelRelease)
      await safelyReleaseSentinel(activeSentinel)
    }
  }

  return { acquire, release }
}
