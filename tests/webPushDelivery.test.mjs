import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const notificationSettingsSource = await readFile(
  new URL('../src/composables/useWebPushNotifications.ts', import.meta.url),
  'utf8',
)
const desktopStateSource = await readFile(
  new URL('../src/composables/useDesktopState.ts', import.meta.url),
  'utf8',
)
const serviceWorkerSource = await readFile(
  new URL('../public/sw.js', import.meta.url),
  'utf8',
)
const indexHtmlSource = await readFile(
  new URL('../index.html', import.meta.url),
  'utf8',
)

test('the PWA manifest includes credentials for authenticated deployments', () => {
  assert.match(
    indexHtmlSource,
    /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/u,
  )
})

test('the test action delegates notification display to server Web Push', () => {
  assert.match(notificationSettingsSource, /await sendWebPushTest\(/u)
  assert.doesNotMatch(notificationSettingsSource, /\.showNotification\(/u)
})

test('subscribed turn completion does not create a duplicate local notification', () => {
  assert.match(desktopStateSource, /if \(isWebPushLocallyEnabled\(\)\) \{/u)
  assert.doesNotMatch(desktopStateSource, /registration\.showNotification\(/u)
})

test('the service worker remains the single Web Push display source', () => {
  const showNotificationCalls = serviceWorkerSource.match(/self\.registration\.showNotification\(/gu) ?? []
  assert.equal(showNotificationCalls.length, 1)
})
