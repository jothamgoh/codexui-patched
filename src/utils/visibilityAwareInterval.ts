type VisibilityDocument = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>

export type VisibilityAwareInterval = {
  refresh: () => void
  start: () => void
  stop: () => void
}

export function createVisibilityAwareInterval(
  callback: () => void,
  intervalMs: number,
  options: {
    clearInterval?: (timer: ReturnType<typeof setInterval>) => void
    document?: VisibilityDocument
    setInterval?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>
  } = {},
): VisibilityAwareInterval {
  const documentLike = options.document
    ?? (typeof document !== 'undefined' ? document : undefined)
  const scheduleInterval = options.setInterval ?? globalThis.setInterval
  const cancelInterval = options.clearInterval ?? globalThis.clearInterval

  let active = false
  let timer: ReturnType<typeof setInterval> | null = null

  function stopTimer(): void {
    if (timer === null) return
    cancelInterval(timer)
    timer = null
  }

  function startTimerIfVisible(): void {
    if (!active || timer !== null || documentLike?.visibilityState === 'hidden') return
    timer = scheduleInterval(callback, intervalMs)
  }

  function onVisibilityChange(): void {
    callback()
    if (documentLike?.visibilityState === 'hidden') {
      stopTimer()
      return
    }
    startTimerIfVisible()
  }

  function start(): void {
    if (active) {
      callback()
      return
    }
    active = true
    callback()
    documentLike?.addEventListener('visibilitychange', onVisibilityChange)
    startTimerIfVisible()
  }

  function stop(): void {
    if (!active) return
    active = false
    documentLike?.removeEventListener('visibilitychange', onVisibilityChange)
    stopTimer()
  }

  return { refresh: callback, start, stop }
}
