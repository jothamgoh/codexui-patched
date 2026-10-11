import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { cancelVoiceDelivery, getVoiceResult } from '../api/voice'
import type { VoiceStoredResult } from '../types/voice'
import { isDeliveryUnsettled, resultDeliveries, secondsLeft } from '../utils/voiceDelivery'

const TICK_MS = 200
const POLL_MS = 1000
/** Stop asking after this long; the server's own notification still says how it went. */
const POLL_LIMIT_MS = 60_000

/**
 * Follows a voice result whose send the server is doing: a local countdown
 * from the server's `remainingMs` (no clock skew), then a few reads until it
 * has gone out or failed.
 */
export function useVoiceDelivery(result: Ref<VoiceStoredResult | null> | Ref<VoiceStoredResult>) {
  const now = ref(Date.now())
  const deadline = ref(0)
  const total = ref(0)
  let ticker: ReturnType<typeof setInterval> | null = null
  let lastPoll = 0
  let startedAt = 0
  let polling = false

  const unsettled = computed(() => resultDeliveries(result.value).some(isDeliveryUnsettled))

  function stop(): void {
    if (ticker) clearInterval(ticker)
    ticker = null
  }

  async function poll(): Promise<void> {
    const current = result.value
    if (!current || polling) return
    polling = true
    lastPoll = Date.now()
    try {
      const fresh = await getVoiceResult(current.code)
      if (result.value?.code === fresh.code) (result as Ref<VoiceStoredResult | null>).value = fresh
    } catch {
      stop()
    } finally {
      polling = false
    }
  }

  watch(result, (value) => {
    const pending = resultDeliveries(value).filter((delivery) => delivery.state === 'pending')
    if (pending.length > 0) {
      const remaining = Math.max(...pending.map((delivery) => delivery.remainingMs))
      deadline.value = Date.now() + remaining
      total.value = Math.max(total.value, Math.max(...pending.map((delivery) => delivery.delaySeconds * 1000)), remaining)
    }
    if (!unsettled.value) {
      stop()
      return
    }
    if (ticker) return
    startedAt = Date.now()
    ticker = setInterval(() => {
      now.value = Date.now()
      if (now.value - startedAt > POLL_LIMIT_MS) { stop(); return }
      const due = now.value >= deadline.value
      if (due && now.value - lastPoll >= POLL_MS) void poll()
    }, TICK_MS)
  }, { immediate: true })

  onBeforeUnmount(stop)

  const seconds = computed(() => secondsLeft(deadline.value, now.value))
  /** 1 when the window starts, 0 when it ends: for a draining bar. */
  const fractionLeft = computed(() => (total.value > 0 ? Math.min(1, Math.max(0, (deadline.value - now.value) / total.value)) : 0))

  async function cancel(code = result.value?.code ?? ''): Promise<VoiceStoredResult | null> {
    if (!code) return null
    const answer = await cancelVoiceDelivery(code)
    // Cancelling a step answers with that step; the screen re-reads the whole command.
    if (answer.code === result.value?.code) (result as Ref<VoiceStoredResult | null>).value = answer
    else await poll()
    return answer
  }

  return { seconds, fractionLeft, unsettled, cancel, refresh: poll }
}
