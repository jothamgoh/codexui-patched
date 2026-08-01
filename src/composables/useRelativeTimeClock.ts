import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'

const relativeTimeNow = ref(Date.now())
let subscriberCount = 0
let clockTimer: ReturnType<typeof setInterval> | null = null

function updateClock(): void {
  relativeTimeNow.value = Date.now()
}

function startClock(): void {
  subscriberCount += 1
  updateClock()
  if (clockTimer) return
  clockTimer = setInterval(updateClock, 30000)
  document.addEventListener('visibilitychange', updateClock)
  window.addEventListener('focus', updateClock)
}

function stopClock(): void {
  subscriberCount = Math.max(0, subscriberCount - 1)
  if (subscriberCount > 0 || !clockTimer) return
  clearInterval(clockTimer)
  clockTimer = null
  document.removeEventListener('visibilitychange', updateClock)
  window.removeEventListener('focus', updateClock)
}

export function useRelativeTimeClock() {
  onMounted(startClock)
  onBeforeUnmount(stopClock)
  return readonly(relativeTimeNow)
}
