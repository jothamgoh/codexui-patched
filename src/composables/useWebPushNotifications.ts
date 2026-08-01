import { computed, readonly, ref } from 'vue'
import {
  getWebPushConfig,
  removeWebPushSubscription,
  saveWebPushSubscription,
  sendWebPushTest,
  type WebPushMode,
} from '../api/webPush'

export type TurnNotificationMode = 'off' | WebPushMode
export type WebPushUiStatus =
  | 'loading'
  | 'ready'
  | 'enabled'
  | 'needs-install'
  | 'blocked'
  | 'unsupported'
  | 'error'

const MODE_STORAGE_KEY = 'codex-web-local.turn-notification-mode.v1'
const ENABLED_STORAGE_KEY = 'codex-web-local.web-push-enabled.v1'

const status = ref<WebPushUiStatus>('loading')
const mode = ref<TurnNotificationMode>(loadMode())
const isBusy = ref(false)
const errorMessage = ref('')
const testMessage = ref('')
const isInitialized = ref(false)
const isStandalone = ref(readStandaloneMode())
const isIOS = ref(readIsIOS())
let vapidPublicKey = ''

function loadMode(): TurnNotificationMode {
  if (typeof window === 'undefined') return 'unfocused'
  const value = window.localStorage.getItem(MODE_STORAGE_KEY)
  if (value === 'off' || value === 'always' || value === 'unfocused') return value
  return 'unfocused'
}

function readStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || standaloneNavigator.standalone === true
}

function readIsIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iP(ad|hone|od)/u.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function browserSupportsWebPush(): boolean {
  if (typeof window === 'undefined') return false
  return window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
}

function saveMode(nextMode: TurnNotificationMode): void {
  mode.value = nextMode
  if (typeof window === 'undefined') return
  window.localStorage.setItem(MODE_STORAGE_KEY, nextMode)
}

export function getLocalTurnNotificationMode(): TurnNotificationMode {
  return loadMode()
}

function saveEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  if (enabled) {
    window.localStorage.setItem(ENABLED_STORAGE_KEY, 'true')
  } else {
    window.localStorage.removeItem(ENABLED_STORAGE_KEY)
  }
}

function deviceName(): string {
  if (typeof navigator === 'undefined') return 'Browser'
  if (/iPhone/u.test(navigator.userAgent)) return 'iPhone'
  if (/iPad/u.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return 'iPad'
  }
  if (/Mac/u.test(navigator.platform) || /Macintosh/u.test(navigator.userAgent)) return 'Mac'
  return 'Browser'
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/gu, '+').replace(/_/gu, '/')
  const raw = window.atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index)
  }
  return output
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (existing) return existing
  return navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

async function loadConfig(): Promise<void> {
  if (vapidPublicKey) return
  const config = await getWebPushConfig()
  if (!config.supported || !config.publicKey) {
    throw new Error('Web Push is not configured on this server')
  }
  vapidPublicKey = config.publicKey
}

async function initializeWebPushNotifications(force = false): Promise<void> {
  if (isInitialized.value && !force) return
  isInitialized.value = true
  isStandalone.value = readStandaloneMode()
  isIOS.value = readIsIOS()
  errorMessage.value = ''

  if (!browserSupportsWebPush()) {
    status.value = 'unsupported'
    saveEnabled(false)
    return
  }
  if (isIOS.value && !isStandalone.value) {
    status.value = 'needs-install'
    saveEnabled(false)
    return
  }
  if (Notification.permission === 'denied') {
    status.value = 'blocked'
    saveEnabled(false)
    return
  }

  status.value = 'loading'
  try {
    const [registration] = await Promise.all([
      serviceWorkerRegistration(),
      loadConfig(),
    ])
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      status.value = 'ready'
      saveEnabled(false)
      return
    }

    const currentMode = mode.value === 'off' ? 'unfocused' : mode.value
    if (mode.value === 'off') saveMode(currentMode)
    await saveWebPushSubscription(subscription.toJSON(), currentMode, deviceName())
    saveEnabled(true)
    status.value = 'enabled'
  } catch (error) {
    status.value = 'error'
    saveEnabled(false)
    errorMessage.value = error instanceof Error ? error.message : 'Failed to initialize notifications'
  }
}

async function enableWebPushNotifications(requestedMode?: WebPushMode): Promise<void> {
  if (isBusy.value) return
  isStandalone.value = readStandaloneMode()
  if (readIsIOS() && !isStandalone.value) {
    status.value = 'needs-install'
    return
  }
  if (!browserSupportsWebPush()) {
    status.value = 'unsupported'
    return
  }

  isBusy.value = true
  errorMessage.value = ''
  testMessage.value = ''
  try {
    const permissionPromise = Notification.permission === 'default'
      ? requestNotificationPermission()
      : Promise.resolve(Notification.permission)
    const permission = await permissionPromise
    if (permission !== 'granted') {
      status.value = permission === 'denied' ? 'blocked' : 'ready'
      saveEnabled(false)
      return
    }

    await loadConfig()
    const registration = await serviceWorkerRegistration()
    const subscription =
      await registration.pushManager.getSubscription() ??
      await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      })
    const nextMode = requestedMode ?? (mode.value === 'off' ? 'unfocused' : mode.value)
    await saveWebPushSubscription(subscription.toJSON(), nextMode, deviceName())
    saveMode(nextMode)
    saveEnabled(true)
    status.value = 'enabled'
  } catch (error) {
    status.value = 'error'
    saveEnabled(false)
    errorMessage.value = error instanceof Error ? error.message : 'Failed to enable notifications'
  } finally {
    isBusy.value = false
  }
}

async function disableWebPushNotifications(): Promise<void> {
  if (isBusy.value || !browserSupportsWebPush()) return
  isBusy.value = true
  errorMessage.value = ''
  testMessage.value = ''
  try {
    const registration = await serviceWorkerRegistration()
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      try {
        await removeWebPushSubscription(subscription.toJSON())
      } finally {
        await subscription.unsubscribe()
      }
    }
    saveMode('off')
    saveEnabled(false)
    status.value = 'ready'
  } catch (error) {
    status.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : 'Failed to disable notifications'
  } finally {
    isBusy.value = false
  }
}

async function setTurnNotificationMode(nextMode: TurnNotificationMode): Promise<void> {
  if (nextMode === 'off') {
    await disableWebPushNotifications()
    return
  }
  if (status.value !== 'enabled') {
    await enableWebPushNotifications(nextMode)
    return
  }
  if (isBusy.value) return

  isBusy.value = true
  errorMessage.value = ''
  testMessage.value = ''
  try {
    const registration = await serviceWorkerRegistration()
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      status.value = 'ready'
      saveEnabled(false)
      saveMode(nextMode)
      errorMessage.value = 'This device is no longer subscribed. Enable notifications again.'
      return
    }
    await saveWebPushSubscription(subscription.toJSON(), nextMode, deviceName())
    saveMode(nextMode)
  } catch (error) {
    status.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : 'Failed to update notifications'
  } finally {
    isBusy.value = false
  }
}

async function testWebPushNotification(): Promise<void> {
  if (isBusy.value || status.value !== 'enabled') return
  isBusy.value = true
  errorMessage.value = ''
  testMessage.value = ''
  try {
    const registration = await serviceWorkerRegistration()
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      status.value = 'ready'
      saveEnabled(false)
      throw new Error('This device is no longer subscribed. Enable notifications again.')
    }
    await sendWebPushTest(subscription.toJSON(), `/${window.location.hash || '#/'}`)
    testMessage.value = 'Test sent to this device.'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to send test notification'
  } finally {
    isBusy.value = false
  }
}

async function requestNotificationPermission(): Promise<NotificationPermission> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Notification.requestPermission(),
      new Promise<NotificationPermission>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(
            'Chrome is still waiting for notification permission. Allow Notifications in the address bar, then try again.',
          ))
        }, 15_000)
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export function isWebPushLocallyEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(ENABLED_STORAGE_KEY) === 'true'
}

export function useWebPushNotifications() {
  return {
    status: readonly(status),
    mode: readonly(mode),
    isBusy: readonly(isBusy),
    errorMessage: readonly(errorMessage),
    testMessage: readonly(testMessage),
    isStandalone: readonly(isStandalone),
    isIOS: readonly(isIOS),
    isEnabled: computed(() => status.value === 'enabled'),
    initializeWebPushNotifications,
    enableWebPushNotifications,
    disableWebPushNotifications,
    setTurnNotificationMode,
    testWebPushNotification,
  }
}
