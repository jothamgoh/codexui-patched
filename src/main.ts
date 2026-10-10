import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { initializeTheme } from './composables/useTheme'
import { initializeUiFontSize } from './composables/useUiFontSize'
import './style.css'

initializeTheme()
initializeUiFontSize()

createApp(App).use(createPinia()).use(router).mount('#app')

if ('serviceWorker' in navigator) {
  // Forward push receipts from the service worker (see public/sw.js).
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; receipt?: unknown } | null
    if (data?.type !== 'codexui-push-receipt' || !data.receipt || typeof data.receipt !== 'object') return
    void fetch('/codex-api/push/receipt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...data.receipt, via: 'page' }),
    }).catch(() => {})
  })
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Notification settings surface registration failures with actionable copy.
    })
  })
}
