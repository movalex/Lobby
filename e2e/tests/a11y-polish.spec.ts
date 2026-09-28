// Keyboard and focus fixes from the accessibility review (batch "a11y-polish"): each test drives the
// board the way the reviewer did, with the keyboard, and checks where the keyboard ends up. IDs: A11Y-*.
import type { Page, TestInfo } from '@playwright/test'
import { getShape } from './support/board.ts'
import { clickCanvasAt, clickShape, currentTool, readEd, waitForCanvasUx } from './support/canvas-ux.ts'
import { plainText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { createShapes, noteAt } from './support/tags.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** What has the keyboard: 'BODY', a test id, or a short tag/class description. */
const focusOf = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    if (!a || a === document.body) return 'BODY'
    return (
      a.getAttribute('data-testid') ??
      `${a.tagName.toLowerCase()}${a.classList.length ? `.${[...a.classList].join('.')}` : ''}`
    )
  })

/** The board itself has the keyboard (the editor container or something inside the canvas). */
const boardHasFocus = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement
    return !!a && (a.classList.contains('tl-container') || a.closest('.tl-canvas') !== null)
  })

const noteText = async (page: Page, id: string) => plainText((await getShape(page, id))?.props.richText)

async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`) })
}

test('A11Y-12: Enter on a selected note puts the caret at the end, so typing appends; type-to-edit appends too', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await createShapes(a.page, [
    noteAt('shape:a11y-enter', 200, 200, 'Press N and type'),
    noteAt('shape:a11y-type', 600, 200, 'Abc'),
  ])
  await clickShape(a.page, 'shape:a11y-enter')
  await a.page.keyboard.press('Enter')
  await expect.poll(() => readEd(a.page, (ed) => ed.getEditingShapeId())).toBe('shape:a11y-enter')
  // Typed straight away, before the text editor has mounted: buffered and appended in order.
  await a.page.keyboard.type(' (kbd)')
  await expect.poll(() => noteText(a.page, 'shape:a11y-enter')).toBe('Press N and type (kbd)')
  await a.page.waitForTimeout(250) // past tldraw's own caret placement (100 ms after mount)
  await a.page.keyboard.type('!')
  await expect.poll(() => noteText(a.page, 'shape:a11y-enter')).toBe('Press N and type (kbd)!')
  await shot(a.page, testInfo, 'a11y-12-after-enter-typing')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => readEd(a.page, (ed) => ed.getEditingShapeId())).toBeNull()

  await clickShape(a.page, 'shape:a11y-type')
  await a.page.keyboard.type('de')
  await expect.poll(() => noteText(a.page, 'shape:a11y-type')).toBe('Abcde')
  await a.page.keyboard.press('Escape')
  // Undo removes the typing, one step, and the original text comes back.
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => noteText(a.page, 'shape:a11y-type')).toBe('Abc')
})

test('A11Y-02 / A11Y-01: a dock panel opened from the keyboard takes the focus; Escape and × close it and return the focus to its rail button', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const railFrames = a.page.getByTestId('dock-tab-frames')
  const railHistory = a.page.getByTestId('dock-tab-history')
  await expect(railFrames).toHaveAttribute('aria-expanded', 'false')

  await railFrames.focus()
  await a.page.keyboard.press('Enter')
  const panel = a.page.getByTestId('dock-panel-frames')
  await expect(panel).toBeVisible()
  await expect(railFrames).toHaveAttribute('aria-expanded', 'true')
  await expect(railFrames).toHaveAttribute('aria-controls', (await panel.getAttribute('id')) ?? 'missing')
  await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await shot(a.page, testInfo, 'a11y-02-frames-open-focus')
  // One Tab reaches the panel's close button (not the rest of the rail first).
  await a.page.keyboard.press('Tab')
  await expect(panel.getByTestId('dock-panel-close')).toBeFocused()

  await a.page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(railFrames).toBeFocused()

  // × (pressed from the keyboard) closes it and the focus goes back to the rail, not <body>.
  await railHistory.focus()
  await a.page.keyboard.press('Enter')
  const history = a.page.getByTestId('dock-panel-history')
  await expect(history).toBeVisible()
  await history.getByTestId('dock-panel-close').focus()
  await a.page.keyboard.press('Enter')
  await expect(history).toHaveCount(0)
  await expect(railHistory).toBeFocused()
  expect(await focusOf(a.page)).not.toBe('BODY')

  // A mouse click on × does not leave the focus on <body> either.
  await railHistory.click()
  await expect(history).toBeVisible()
  await history.getByTestId('dock-panel-close').click()
  await expect(history).toHaveCount(0)
  await a.page.waitForTimeout(100)
  expect(await focusOf(a.page)).not.toBe('BODY')
})

test('A11Y-13 / A11Y-01: Ctrl+F focuses the search field every time (typed letters never change tools); Escape gives the keyboard back to the board', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await clickCanvasAt(a.page, { x: 900, y: 600 })
  for (const word of ['boss', 'nose']) {
    await a.page.keyboard.press('ControlOrMeta+f')
    const input = a.page.getByTestId('search-input')
    await expect(input).toBeFocused()
    await a.page.keyboard.type(word)
    await expect(input).toHaveValue(word)
    expect(await currentTool(a.page)).toBe('select')
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('board-search')).toHaveCount(0)
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  }
  // The board has the keyboard for real: N picks the note tool.
  await a.page.keyboard.press('n')
  await expect.poll(() => currentTool(a.page)).toBe('note')
})

test('A11Y-04 / A11Y-03: Alt+F10 reaches the selection toolbar (arrows move, Escape returns to the board); Shift+F10 opens the context menu; overlay fields show a focus ring', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await createShapes(a.page, [noteAt('shape:a11y-bar', 300, 250, 'Tag me')])
  await clickShape(a.page, 'shape:a11y-bar')
  const bar = a.page.getByTestId('selection-bar')
  await expect(bar).toBeVisible()

  await a.page.keyboard.press('Alt+F10')
  await expect(a.page.getByTestId('copy-link-selection')).toBeFocused()
  const ring = await a.page.evaluate(() => {
    const s = getComputedStyle(document.activeElement as Element)
    return `${s.outlineStyle} ${s.outlineWidth}`
  })
  expect(ring).toBe('solid 2px')
  await shot(a.page, testInfo, 'a11y-04-selection-bar-focus')
  await a.page.keyboard.press('ArrowRight')
  await expect(a.page.getByTestId('selection-lock')).toBeFocused()
  await a.page.keyboard.press('End')
  expect(await bar.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await a.page.keyboard.press('Home')
  await expect(a.page.getByTestId('copy-link-selection')).toBeFocused()
  await a.page.keyboard.press('Escape')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  expect(await readEd(a.page, (ed) => [...ed.getSelectedShapeIds()])).toEqual(['shape:a11y-bar'])

  // The Tags button opens the picker; its field (a Lobby control inside the canvas) shows a ring.
  await a.page.keyboard.press('Alt+F10')
  const tags = a.page.getByTestId('selection-tags')
  for (let i = 0; i < 6 && !(await tags.evaluate((el) => el === document.activeElement)); i++)
    await a.page.keyboard.press('ArrowRight')
  await expect(tags).toBeFocused()
  await a.page.keyboard.press('Enter')
  const input = a.page.getByTestId('tag-picker-input')
  await expect(input).toBeFocused()
  const inputRing = await input.evaluate((el) => {
    const s = getComputedStyle(el)
    return { style: s.outlineStyle, width: s.outlineWidth }
  })
  expect(inputRing).toEqual({ style: 'solid', width: '2px' })
  await shot(a.page, testInfo, 'a11y-03-tag-picker-ring')
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('tag-picker')).toHaveCount(0)
  // Closing the picker gives the keyboard back to its opener, the Tags button (A11Y-15, a11y-2); Escape
  // there returns to the board (A11Y-01/04), with the note still selected.
  await expect(tags).toBeFocused()
  await a.page.keyboard.press('Escape')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  expect(await readEd(a.page, (ed) => [...ed.getSelectedShapeIds()])).toEqual(['shape:a11y-bar'])

  // Shift+F10 opens the selection's context menu.
  await a.page.keyboard.press('Shift+F10')
  await expect(a.page.getByTestId('context-menu')).toBeVisible()
  await shot(a.page, testInfo, 'a11y-04-shift-f10-menu')
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('context-menu')).toHaveCount(0)
})

test('A11Y-08 / A11Y-05: a dialog opens on its first field (not ×), its × keeps a 28 px target, and closing returns the focus to the opener', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const share = a.page.getByTestId('share-button')
  await share.focus()
  await a.page.keyboard.press('Enter')
  const dialog = a.page.getByTestId('share-dialog')
  await expect(dialog).toBeVisible()
  const first = await a.page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return { tag: el?.tagName, inHead: !!el?.closest('.dr-dialog__head') }
  })
  expect(first.inHead).toBe(false)
  expect(['INPUT', 'SELECT', 'TEXTAREA']).toContain(first.tag)
  const close = dialog.locator('.dr-dialog__head .dr-iconbtn')
  const box = await close.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(28)
  expect(box?.height).toBeGreaterThanOrEqual(28)
  await shot(a.page, testInfo, 'a11y-08-share-first-field')
  await a.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(share).toBeFocused()

  // A11Y-05: a menu item reached with the keyboard has a 2px focus ring, not only a faint tint.
  await a.page.evaluate(() => {
    const menu = document.createElement('div')
    menu.className = 'dr-menu'
    menu.style.position = 'fixed'
    menu.style.top = '120px'
    menu.style.left = '600px'
    menu.innerHTML =
      '<button type="button" role="menuitem" class="dr-menu__item" data-testid="probe-a">Open</button>' +
      '<button type="button" role="menuitem" class="dr-menu__item" data-testid="probe-b">Copy link</button>'
    document.body.append(menu)
  })
  await a.page.getByTestId('probe-a').focus()
  await a.page.keyboard.press('Tab')
  await expect(a.page.getByTestId('probe-b')).toBeFocused()
  const shadow = await a.page.getByTestId('probe-b').evaluate((el) => getComputedStyle(el).boxShadow)
  expect(shadow).toContain('inset')
  expect(shadow).toMatch(/2px/)
})
