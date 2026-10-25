// A stand-in for a phone's on-screen keyboard, which a headless browser does not have. It moves
// window.visualViewport the way iOS Safari does:
//   - raiseKeyboard() shrinks the visible area and pans it down to the focused field;
//   - focus leaving a field changes nothing by itself, since the keyboard is still sliding away;
//   - lowerKeyboard() reports the keyboard gone, as WebKit does once it has slid away.
// Scrolling the window back to the top undoes the pan, as on iOS.
//
//   import { installPhoneKeyboard, raiseKeyboard, lowerKeyboard } from '../../../.claude/skills/verify/scripts/phoneKeyboard.mjs'
//   await installPhoneKeyboard(s.page)        // before the first s.go()
//   await input.tap(); const keyboardTop = await raiseKeyboard(s.page)
//   await s.page.getByRole('button', { name: 'Send message' }).tap()
//   await s.page.waitForTimeout(100); await lowerKeyboard(s.page)

/** Call before the first navigation. `shrinksWindow` makes innerHeight shrink with the keyboard too, as on some phones. */
export async function installPhoneKeyboard(page, { shrinksWindow = false } = {}) {
  await page.addInitScript((shrinksWindow) => {
    const viewport = new EventTarget()
    const state = { height: null, offsetTop: 0 }
    const visibleHeight = () => state.height ?? document.documentElement.clientHeight
    Object.defineProperty(viewport, 'height', { get: visibleHeight })
    Object.defineProperty(viewport, 'offsetTop', { get: () => state.offsetTop })
    Object.defineProperty(viewport, 'width', { get: () => window.innerWidth })
    viewport.scale = 1
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    Object.defineProperty(window, 'scrollY', { get: () => state.offsetTop, configurable: true })
    if (shrinksWindow) Object.defineProperty(window, 'innerHeight', { get: visibleHeight, configurable: true })
    window.scrollTo = (x, y) => {
      const top = typeof x === 'object' ? x.top ?? 0 : y
      if (state.offsetTop === top) return
      state.offsetTop = top
      viewport.dispatchEvent(new Event('scroll'))
    }
    window.__phoneKeyboard = (height, offsetTop) => {
      state.height = height
      state.offsetTop = offsetTop
      viewport.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('scroll'))
    }
  }, shrinksWindow)
}

/** Raises a keyboard `height` px tall, with iOS's pan of `pan` px down to the field. Returns the keyboard's top edge. */
export function raiseKeyboard(page, { height = 334, pan = 300 } = {}) {
  return page.evaluate(([height, pan]) => {
    const top = document.documentElement.clientHeight - height
    window.__phoneKeyboard(top, pan)
    return top
  }, [height, pan])
}

/** Reports the keyboard gone. Call it after the tap or blur that dismisses it, not at the same moment. */
export function lowerKeyboard(page) {
  return page.evaluate(() => window.__phoneKeyboard(null, 0))
}

/** Shades the area the keyboard covers from `top` down, for screenshots. Taps pass through it. `null` removes it. */
export function drawKeyboard(page, top) {
  return page.evaluate((top) => {
    document.getElementById('fake-keyboard')?.remove()
    if (top === null) return
    const keyboard = document.createElement('div')
    keyboard.id = 'fake-keyboard'
    keyboard.textContent = 'keyboard'
    Object.assign(keyboard.style, { position: 'fixed', left: '0', right: '0', top: `${top}px`, bottom: '0', background: 'rgba(120,120,130,0.92)', zIndex: '99999', color: '#fff', font: '16px sans-serif', display: 'grid', placeItems: 'center', pointerEvents: 'none' })
    document.body.append(keyboard)
  }, top)
}
