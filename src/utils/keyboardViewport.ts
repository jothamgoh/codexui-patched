/**
 * Where the app layout sits while a phone's on-screen keyboard is up.
 *
 * The keyboard covers the bottom of the window instead of resizing it, and iOS pans the page down
 * to the focused field as the keyboard rises. The app is one fixed layout that fills the window,
 * so the pan slid it up: the composer stood near the top with blank space down to the keyboard.
 * Following the pan with the layout raced Safari and could be left behind. So for a field in the
 * layout the pan is undone instead: the layout stays at the window's top and ends where the
 * keyboard begins, the way a native app sits above its keyboard. A field in an overlay keeps the
 * pan that shows it, and where a browser keeps its pan anyway the layout follows it.
 */

/** Less of the window covered than this is browser chrome, not a keyboard. */
const MIN_KEYBOARD_HEIGHT = 120

/** How far above the keyboard a focused field's column keeps it, in CSS pixels. */
const FIELD_MARGIN = 24

export type KeyboardLayout = {
  /** The layout's height, down to the keyboard's top; null while no keyboard covers the window. */
  height: number | null
  /** How far down the window the layout starts, where the browser keeps its pan. */
  top: number
}

export type KeyboardWindow = {
  readonly innerHeight: number
  readonly scrollY: number
  readonly visualViewport: Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'> | null
  scrollTo(x: number, y: number): void
}

/** Whether focusing `element` can raise an on-screen keyboard or picker. A frame counts, for a field inside it. */
export function raisesKeyboard(element: Element | null): element is HTMLElement {
  if (!element) return false
  if ((element as HTMLElement).isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME'].includes(element.tagName)
}

/**
 * The layout for the keyboard now over `view`, measured after the page's pan is scrolled back
 * when `undoPan` is set. A pinch-zoom shrinks and pans the visual viewport too, but covers
 * nothing, so a zoomed page is left as the person zoomed it.
 */
export function measureKeyboardLayout(view: KeyboardWindow, focused: Element | null, undoPan: boolean): KeyboardLayout {
  const viewport = view.visualViewport
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return { height: null, top: 0 }
  if (undoPan && (viewport.offsetTop >= 1 || view.scrollY >= 1)) view.scrollTo(0, 0)
  const height = Math.round(viewport.height)
  if (!raisesKeyboard(focused) || view.innerHeight - height <= MIN_KEYBOARD_HEIGHT) return { height: null, top: 0 }
  return { height, top: Math.max(0, Math.round(viewport.offsetTop)) }
}

/** The nearest ancestor of `element` that scrolls its content up and down. */
function scrollingColumn(element: Element, view: Pick<Window, 'getComputedStyle'>): Element | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const { overflowY } = view.getComputedStyle(at)
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) return at
  }
  return null
}

/**
 * Scrolls the column holding a focused field until the field clears the keyboard, as the undone
 * pan would have shown it, without pushing the field's top out of the column.
 */
export function keepFieldAboveKeyboard(field: Element, keyboardTop: number, view: Pick<Window, 'getComputedStyle'>): void {
  const column = scrollingColumn(field, view)
  if (!column) return
  const box = field.getBoundingClientRect()
  const area = column.getBoundingClientRect()
  const hidden = box.bottom + FIELD_MARGIN - Math.min(keyboardTop, area.bottom)
  const scroll = Math.min(hidden, box.top - area.top)
  if (scroll > 0) column.scrollTop += scroll
}
