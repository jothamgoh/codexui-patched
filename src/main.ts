import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { initializeTheme } from './composables/useTheme'
import './style.css'

initializeTheme()

createApp(App).use(router).mount('#app')

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Notification settings surface registration failures with actionable copy.
    })
  })
}
