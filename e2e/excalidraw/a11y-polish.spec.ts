// PORTED from e2e/tests/a11y-polish.spec.ts (the tldraw spec keeps running on the default build) to the
// Excalidraw board page (owner 3i, docs/EXCALIDRAW-MIGRATION.md §4.8 (4)): keyboard and focus fixes from the
// accessibility review, driven with the keyboard. IDs: A11Y-*.
//
// Deviations from the tldraw spec: the dock-panel test opens the a11y feature's Contents panel (the Frames
// and History panels are 3b's and 3h's); typing waits for the lease (the editor opens once it is granted,
// keys typed before are buffered and replayed); Ctrl+F (3b), the selection toolbar and the context menu
// (3a) and the tag picker (3d) are expected failures (`needs`) until those ports land.
import {
  clickItem,
  editingId,
  expect,
  itemText,
  test,
  tool,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import {
  boardHasFocus,
  focusCanvas,
  focusOf,
  MISSING_FEATURE_MS,
  note,
  selected,
  waitForA11y,
} from './a11y-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

test('A11Y-12: Enter on a selected note puts the caret at the end, so typing appends; type-to-edit appends too', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const enter = await note(a.page, 200, 200, 'Press N and type')
  const typed = await note(a.page, 600, 200, 'Abc')
  await clickItem(a.page, enter)
  await a.page.keyboard.press('Enter')
  // typed straight away, before the lease is granted: buffered and appended in order
  await a.page.keyboard.type(' (kbd)')
  await expect.poll(() => itemText(a.page, enter)).toBe('Press N and type (kbd)')
  await waitForTextEditor(a.page, enter)
  await a.page.keyboard.type('!')
  await expect.poll(() => itemText(a.page, enter)).toBe('Press N and type (kbd)!')
  await a.page.screenshot({ path: testInfo.outputPath('a11y-12-after-enter-typing.png') })
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()

  await clickItem(a.page, typed)
  await a.page.keyboard.type('de')
  await expect.poll(() => itemText(a.page, typed)).toBe('Abcde')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  // undo removes the typing, one step, and the original text comes back
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => itemText(a.page, typed)).toBe('Abc')
})

test('A11Y-02 / A11Y-01: a dock panel opened from the keyboard takes the focus; Escape and × close it and return the focus to its rail button', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const rail = a.page.getByTestId('dock-tab-contents')
  await expect(rail).toHaveAttribute('aria-expanded', 'false')

  await rail.focus()
  await a.page.keyboard.press('Enter')
  const panel = a.page.getByTestId('dock-panel-contents')
  await expect(panel).toBeVisible()
  await expect(rail).toHaveAttribute('aria-expanded', 'true')
  await expect(rail).toHaveAttribute('aria-controls', (await panel.getAttribute('id')) ?? 'missing')
  await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await a.page.screenshot({ path: testInfo.outputPath('a11y-02-contents-open-focus.png') })
  // one Tab reaches the panel's close button (not the rest of the rail first)
  await a.page.keyboard.press('Tab')
  await expect(panel.getByTestId('dock-panel-close')).toBeFocused()
  await a.page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(rail).toBeFocused()

  // × pressed from the keyboard closes it and the focus goes back to the rail, not <body>
  await a.page.keyboard.press('Enter')
  await expect(panel).toBeVisible()
  await panel.getByTestId('dock-panel-close').focus()
  await a.page.keyboard.press('Enter')
  await expect(panel).toHaveCount(0)
  await expect(rail).toBeFocused()
  expect(await focusOf(a.page)).not.toBe('BODY')

  // a mouse click on × does not leave the focus on <body> either
  await rail.click()
  await expect(panel).toBeVisible()
  await panel.getByTestId('dock-panel-close').click()
  await expect(panel).toHaveCount(0)
  await a.page.waitForTimeout(100)
  expect(await focusOf(a.page)).not.toBe('BODY')
})

test('A11Y-13 / A11Y-01: Ctrl+F focuses the search field every time (typed letters never change tools); Escape gives the keyboard back to the board', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await focusCanvas(a.page)
  for (const word of ['boss', 'nose']) {
    await a.page.keyboard.press('ControlOrMeta+f')
    const input = a.page.getByTestId('search-input')
    await expect(input).toBeFocused({ timeout: MISSING_FEATURE_MS })
    await a.page.keyboard.type(word)
    await expect(input).toHaveValue(word)
    expect(await tool(a.page)).toBe('select')
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('board-search')).toHaveCount(0)
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  }
  await a.page.keyboard.press('n')
  await expect.poll(() => tool(a.page)).toBe('note')
})

test('A11Y-04 / A11Y-03: Alt+F10 reaches the selection toolbar (arrows move, Escape returns to the board); Shift+F10 opens the context menu; overlay fields show a focus ring', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const n = await note(a.page, 300, 250, 'Tag me')
  await clickItem(a.page, n)
  const bar = a.page.getByTestId('selection-bar')
  await expect(bar).toBeVisible({ timeout: MISSING_FEATURE_MS })
  await a.page.keyboard.press('Alt+F10')
  await expect(a.page.getByTestId('copy-link-selection')).toBeFocused()
  const ring = await a.page.evaluate(() => {
    const s = getComputedStyle(document.activeElement as Element)
    return `${s.outlineStyle} ${s.outlineWidth}`
  })
  expect(ring).toBe('solid 2px')
  await a.page.keyboard.press('ArrowRight')
  await expect(a.page.getByTestId('selection-lock')).toBeFocused()
  await a.page.keyboard.press('End')
  expect(await bar.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await a.page.keyboard.press('Home')
  await expect(a.page.getByTestId('copy-link-selection')).toBeFocused()
  await a.page.keyboard.press('Escape')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  expect(await selected(a.page)).toEqual([n])

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
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('tag-picker')).toHaveCount(0)
  await expect(tags).toBeFocused()
  await a.page.keyboard.press('Escape')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  expect(await selected(a.page)).toEqual([n])

  await a.page.keyboard.press('Shift+F10')
  await expect(a.page.getByTestId('context-menu')).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('context-menu')).toHaveCount(0)
})

test('A11Y-08 / A11Y-05: a dialog opens on its first field (not ×), its × keeps a 28 px target, and closing returns the focus to the opener', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
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
  await a.page.screenshot({ path: testInfo.outputPath('a11y-08-share-first-field.png') })
  await a.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(share).toBeFocused()

  // A11Y-05: a menu item reached with the keyboard has a 2px focus ring, not only a faint tint
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
  // the selection is untouched by all of it
  expect(await selected(a.page)).toEqual([])
})
