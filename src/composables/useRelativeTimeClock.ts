import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'
import { createVisibilityAwareInterval } from '../utils/visibilityAwareInterval'

const relativeTimeNow = ref(Date.now())
let subscriberCount = 0

function updateClock(): void {
  relativeTimeNow.value = Date.now()
}

const clock = createVisibilityAwareInterval(updateClock, 30000)

function startClock(): void {
  subscriberCount += 1
  if (subscriberCount > 1) {
    clock.refresh()
    return
  }
  clock.start()
  window.addEventListener('focus', clock.refresh)
}

function stopClock(): void {
  subscriberCount = Math.max(0, subscriberCount - 1)
  if (subscriberCount > 0) return
  clock.stop()
  window.removeEventListener('focus', clock.refresh)
}

export function useRelativeTimeClock() {
  onMounted(startClock)
  onBeforeUnmount(stopClock)
  return readonly(relativeTimeNow)
}
