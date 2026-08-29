import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const threadComposerSource = await readFile(
  new URL('../src/components/content/ThreadComposer.vue', import.meta.url),
  'utf8',
)

async function loadTypeScriptModule(sourcePath) {
  const source = await readFile(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const mobileFocusModule = await loadTypeScriptModule(
  new URL('../src/utils/mobileComposerFocus.ts', import.meta.url),
)
const composerKeyboardModule = await loadTypeScriptModule(
  new URL('../src/utils/composerKeyboard.ts', import.meta.url),
)
const wakeLockModule = await loadTypeScriptModule(
  new URL('../src/utils/screenWakeLock.ts', import.meta.url),
)
const visibilityIntervalModule = await loadTypeScriptModule(
  new URL('../src/utils/visibilityAwareInterval.ts', import.meta.url),
)

const {
  settleComposerFocusAfterSubmit,
  shouldDismissComposerKeyboardAfterSubmit,
} = mobileFocusModule
const { shouldSubmitComposerWithCommandEnter } = composerKeyboardModule
const { createScreenWakeLockController } = wakeLockModule
const { createVisibilityAwareInterval } = visibilityIntervalModule

test('the composer sends with Command+Enter while plain Enter remains a newline', () => {
  assert.match(threadComposerSource, /<form class="thread-composer" @submit\.prevent>/)
  assert.match(threadComposerSource, /class="thread-composer-submit"[\s\S]*?@click="onSubmit\('steer'\)"/)
  assert.match(threadComposerSource, /shouldSubmitComposerWithCommandEnter\(event\)[\s\S]*?onSubmit\('steer'\)/)
  assert.doesNotMatch(threadComposerSource, /event\.key === 'Enter' && !event\.shiftKey/)

  const keyEvent = (overrides = {}) => ({
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: 'Enter',
    metaKey: false,
    shiftKey: false,
    ...overrides,
  })

  assert.equal(shouldSubmitComposerWithCommandEnter(keyEvent({ metaKey: true })), true)
  assert.equal(shouldSubmitComposerWithCommandEnter(keyEvent()), false)
  assert.equal(shouldSubmitComposerWithCommandEnter(keyEvent({ ctrlKey: true })), false)
  assert.equal(shouldSubmitComposerWithCommandEnter(keyEvent({ metaKey: true, shiftKey: true })), false)
  assert.equal(shouldSubmitComposerWithCommandEnter(keyEvent({ metaKey: true, isComposing: true })), false)
})

class FakeVisibilityDocument extends EventTarget {
  visibilityState = 'visible'
}

class FakeWakeLockSentinel extends EventTarget {
  releaseCalls = 0

  async release() {
    this.releaseCalls += 1
    this.dispatchEvent(new Event('release'))
  }
}

test('dismisses the composer keyboard after submit on phones and touch iPads', () => {
  assert.equal(shouldDismissComposerKeyboardAfterSubmit({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)',
    platform: 'iPhone',
    maxTouchPoints: 5,
  }), true)
  assert.equal(shouldDismissComposerKeyboardAfterSubmit({
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 10)',
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
  }), true)
  assert.equal(shouldDismissComposerKeyboardAfterSubmit({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  }), true)
  assert.equal(shouldDismissComposerKeyboardAfterSubmit({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  }), false)
})

test('blurs the composer after mobile submit and restores focus on desktop', () => {
  const calls = []
  const input = {
    blur() { calls.push('blur') },
    focus() { calls.push('focus') },
  }

  settleComposerFocusAfterSubmit(input, {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)',
    platform: 'iPhone',
    maxTouchPoints: 5,
  })
  settleComposerFocusAfterSubmit(input, {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  })

  assert.deepEqual(calls, ['blur', 'focus'])
})

test('holds a screen wake lock only until recording releases it', async () => {
  const document = new FakeVisibilityDocument()
  const sentinel = new FakeWakeLockSentinel()
  let requestCalls = 0
  const controller = createScreenWakeLockController({
    document,
    navigator: {
      wakeLock: {
        async request(type) {
          assert.equal(type, 'screen')
          requestCalls += 1
          return sentinel
        },
      },
    },
  })

  await controller.acquire()
  await controller.acquire()
  assert.equal(requestCalls, 1)

  await controller.release()
  assert.equal(sentinel.releaseCalls, 1)
})

test('reacquires the recording wake lock after returning to a visible page', async () => {
  const document = new FakeVisibilityDocument()
  const sentinels = [new FakeWakeLockSentinel(), new FakeWakeLockSentinel()]
  let requestCalls = 0
  const controller = createScreenWakeLockController({
    document,
    navigator: {
      wakeLock: {
        async request() {
          const sentinel = sentinels[requestCalls]
          requestCalls += 1
          return sentinel
        },
      },
    },
  })

  await controller.acquire()
  document.visibilityState = 'hidden'
  await sentinels[0].release()
  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(requestCalls, 2)
  await controller.release()
  assert.equal(sentinels[1].releaseCalls, 1)
})

test('releases a wake lock that resolves after recording already stopped', async () => {
  const document = new FakeVisibilityDocument()
  const sentinel = new FakeWakeLockSentinel()
  let resolveRequest
  const controller = createScreenWakeLockController({
    document,
    navigator: {
      wakeLock: {
        request() {
          return new Promise((resolve) => { resolveRequest = resolve })
        },
      },
    },
  })

  const pendingAcquire = controller.acquire()
  await controller.release()
  resolveRequest(sentinel)
  await pendingAcquire

  assert.equal(sentinel.releaseCalls, 1)
})

test('treats unsupported or denied wake locks as nonfatal', async () => {
  const document = new FakeVisibilityDocument()
  const synchronousFailure = createScreenWakeLockController({
    document,
    navigator: {
      wakeLock: {
        request() { throw new DOMException('Denied', 'NotAllowedError') },
      },
    },
  })
  const asynchronousFailure = createScreenWakeLockController({
    document,
    navigator: {
      wakeLock: {
        async request() { throw new DOMException('Denied', 'NotAllowedError') },
      },
    },
  })

  await synchronousFailure.acquire()
  await asynchronousFailure.acquire()
  await synchronousFailure.release()
  await asynchronousFailure.release()
})

test('pauses nonessential UI clocks while the page is hidden', () => {
  const document = new FakeVisibilityDocument()
  const scheduledCallbacks = new Map()
  const clearedTimers = []
  let nextTimer = 1
  let callbackCalls = 0
  const interval = createVisibilityAwareInterval(
    () => { callbackCalls += 1 },
    1000,
    {
      document,
      setInterval(callback, intervalMs) {
        assert.equal(intervalMs, 1000)
        const timer = nextTimer
        nextTimer += 1
        scheduledCallbacks.set(timer, callback)
        return timer
      },
      clearInterval(timer) {
        clearedTimers.push(timer)
        scheduledCallbacks.delete(timer)
      },
    },
  )

  interval.start()
  assert.equal(callbackCalls, 1)
  assert.deepEqual([...scheduledCallbacks.keys()], [1])

  document.visibilityState = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(callbackCalls, 2)
  assert.deepEqual(clearedTimers, [1])
  assert.equal(scheduledCallbacks.size, 0)

  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(callbackCalls, 3)
  assert.deepEqual([...scheduledCallbacks.keys()], [2])

  interval.stop()
  assert.deepEqual(clearedTimers, [1, 2])
})
