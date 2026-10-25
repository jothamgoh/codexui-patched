import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/utils/keyboardViewport.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const { keepFieldAboveKeyboard, measureKeyboardLayout } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
)

/**
 * A phone window as iOS Safari measures it, 812 px tall. The keyboard shrinks the visual viewport
 * and pans it down by `offsetTop`; scrolling the window to the top undoes the pan, unless the
 * browser `keepsPan`.
 */
function phoneWindow({ height = 812, offsetTop = 0, scale = 1, keepsPan = false } = {}) {
  const visualViewport = { height, offsetTop, scale }
  const view = {
    innerHeight: 812,
    visualViewport,
    scrolls: 0,
    get scrollY() { return visualViewport.offsetTop },
    scrollTo(_x, y) {
      view.scrolls += 1
      if (!keepsPan) visualViewport.offsetTop = y
    },
  }
  return view
}

const composer = { tagName: 'TEXTAREA', isContentEditable: false }
const body = { tagName: 'BODY', isContentEditable: false }

test('the keyboard pan to the composer is undone, so the layout stays at the top and ends at the keyboard', () => {
  const view = phoneWindow({ height: 425, offsetTop: 317 })
  assert.deepEqual(measureKeyboardLayout(view, composer, true), { height: 425, top: 0 })
  assert.equal(view.visualViewport.offsetTop, 0, 'the page is no longer panned')
})

test('where the browser keeps its pan, the layout follows it to the visible area', () => {
  const view = phoneWindow({ height: 425, offsetTop: 317, keepsPan: true })
  assert.deepEqual(measureKeyboardLayout(view, composer, true), { height: 425, top: 317 })
})

test('a field in an overlay keeps the pan that shows it', () => {
  const view = phoneWindow({ height: 425, offsetTop: 317 })
  assert.deepEqual(measureKeyboardLayout(view, composer, false), { height: 425, top: 317 })
  assert.equal(view.scrolls, 0)
})

test('once focus leaves the field the layout fills the window, before the keyboard is measured gone', () => {
  const view = phoneWindow({ height: 425, offsetTop: 317 })
  assert.deepEqual(measureKeyboardLayout(view, body, true), { height: null, top: 0 })
  assert.equal(view.visualViewport.offsetTop, 0, 'a pan left over from the keyboard is undone too')
})

test('a pinch-zoom is left as the person zoomed it', () => {
  const view = phoneWindow({ height: 406, offsetTop: 200, scale: 2 })
  assert.deepEqual(measureKeyboardLayout(view, composer, true), { height: null, top: 0 })
  assert.equal(view.scrolls, 0)
})

test('browser chrome covering a little of the window is not a keyboard', () => {
  assert.deepEqual(measureKeyboardLayout(phoneWindow({ height: 760 }), composer, true), { height: null, top: 0 })
})

/** An element at `top`..`bottom` in the window, inside `parent`. */
function box(top, bottom, { parent = null, overflowY = 'visible', scrollHeight = 0, clientHeight = 0 } = {}) {
  return {
    parentElement: parent,
    overflowY,
    scrollHeight,
    clientHeight,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top, bottom }),
  }
}
const styles = { getComputedStyle: (element) => ({ overflowY: element.overflowY }) }

test('a field the keyboard covers is scrolled up its column to clear the keyboard', () => {
  const column = box(100, 600, { overflowY: 'auto', scrollHeight: 2000, clientHeight: 500 })
  const field = box(460, 500, { parent: box(0, 0, { parent: column }) })
  keepFieldAboveKeyboard(field, 425, styles)
  assert.equal(column.scrollTop, 99, 'the field ends 24 px above the keyboard')
})

test('a tall field is scrolled no further than its own top', () => {
  const column = box(100, 600, { overflowY: 'auto', scrollHeight: 2000, clientHeight: 500 })
  const field = box(120, 560, { parent: column })
  keepFieldAboveKeyboard(field, 425, styles)
  assert.equal(column.scrollTop, 20)
})

test('a field above the keyboard, or in no scrolling column, is left where it is', () => {
  const column = box(100, 600, { overflowY: 'auto', scrollHeight: 2000, clientHeight: 500 })
  const visible = box(200, 240, { parent: column })
  keepFieldAboveKeyboard(visible, 425, styles)
  assert.equal(column.scrollTop, 0)
  const layout = box(0, 812, { overflowY: 'hidden', scrollHeight: 812, clientHeight: 812 })
  keepFieldAboveKeyboard(box(700, 760, { parent: layout }), 425, styles)
  assert.equal(layout.scrollTop, 0)
})
