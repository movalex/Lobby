// canvas-ux (3a) on the Excalidraw board page: the context menu, the board menu and export control. Ported
// from the tldraw page's specs (tests/canvas-ux.spec.ts "two-browser lock", tests/a11y-polish.spec.ts
// A11Y-04's Shift+F10, tests/canvas-ux-2.spec.ts FAC-07's board-menu half, tests/export-control.spec.ts's
// copy and menu half). The exports themselves (Export, Copy as PNG, PDF) and the downloads are present-export's
// and media's and are ported with them; so are the note labels hiding in Present and SVG (FAC-07's other half).
import type { Page } from '@playwright/test'
import {
  clickItem,
  createNote,
  dragItem,
  expect,
  item,
  items,
  itemText,
  select,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import { focusBoard, settled } from './board-kit.ts'
import { boardHasFocus, clickScene, waitForCanvasUx, withCanvas } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const locked = async (page: Page, id: string) => (await item(page, id))?.locked ?? null

test('two-browser lock: bob sees alice’s Ctrl+Shift+L within 2 s and cannot drag or delete the note until it is unlocked (her key, Menu → Edit → Unlock all, or a right-click → Unlock all)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const n = await settled(a.page, createNote(a.page, { x: 400, y: 260, text: 'Final cut' }))
  await waitForItem(b.page, n)
  const start = await item(a.page, n)

  await clickItem(a.page, n)
  await expect.poll(() => withCanvas(a.page, (c) => c.selection, null)).toEqual([n])
  await a.page.keyboard.press('ControlOrMeta+Shift+L')
  await expect.poll(() => locked(a.page, n)).toBe(true)
  await expect.poll(() => locked(b.page, n), { timeout: 2_000 }).toBe(true)

  await test.step('bob drags the locked note and presses Delete on it: it stays put, for everyone', async () => {
    await dragItem(b.page, n, { x: 260, y: 140 })
    await select(b.page, [n])
    await focusBoard(b.page)
    await select(b.page, [n])
    await b.page.keyboard.press('Delete')
    await b.page.waitForTimeout(300)
    const after = await item(b.page, n)
    expect({ x: after?.x, y: after?.y, deleted: after?.isDeleted }).toEqual({
      x: start?.x,
      y: start?.y,
      deleted: false,
    })
    const onA = await item(a.page, n)
    expect({ x: onA?.x, y: onA?.y, locked: onA?.locked }).toEqual({ x: start?.x, y: start?.y, locked: true })
  })

  await test.step('alice unlocks with the same key (her selection was kept); bob can drag it now', async () => {
    expect(await withCanvas(a.page, (c) => c.selection, null)).toEqual([n])
    await a.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await a.page.keyboard.press('ControlOrMeta+Shift+L')
    await expect.poll(() => locked(b.page, n), { timeout: 2_000 }).toBe(false)
    await clickScene(b.page, { x: 1100, y: 700 })
    await dragItem(b.page, n, { x: 260, y: 140 })
    await expect.poll(async () => ((await item(a.page, n))?.x ?? 0) - (start?.x ?? 0)).toBeGreaterThan(200)
  })

  await test.step('locked and deselected, it can still be freed: bob’s Menu → Edit → Unlock all', async () => {
    await a.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await a.page.keyboard.press('ControlOrMeta+Shift+L')
    await expect.poll(() => locked(b.page, n), { timeout: 2_000 }).toBe(true)
    await clickScene(a.page, { x: 900, y: 150 })
    expect(await withCanvas(a.page, (c) => c.selection, null)).toEqual([])
    // a click on a locked element does not select it
    await clickItem(b.page, n)
    expect(await withCanvas(b.page, (c) => c.selection, null)).toEqual([])
    await b.page.getByTestId('main-menu.button').click()
    await b.page.getByTestId('main-menu-sub.edit-button').click()
    await b.page.getByTestId('main-menu.unlock-all').click()
    await expect.poll(() => locked(a.page, n), { timeout: 2_000 }).toBe(false)
    await expect(b.page.getByTestId('main-menu')).toHaveCount(0)
  })

  await test.step('…and with a right-click on the canvas → Unlock all, shown only while something is locked', async () => {
    await select(a.page, [n])
    await a.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await a.page.keyboard.press('ControlOrMeta+Shift+L')
    await expect.poll(() => locked(b.page, n), { timeout: 2_000 }).toBe(true)
    // an empty spot of bob's view, clear of the chrome: since the wave-3 integration bob's first view is
    // 3b's (the scene point this used to pick sat under the style panel of his selection)
    const empty = { x: 320, y: 620 }
    await b.page.mouse.click(empty.x, empty.y, { button: 'right' })
    await expect(b.page.getByTestId('context-menu')).toBeVisible()
    await b.page.getByTestId('context-menu.unlock-all').click()
    await expect.poll(() => locked(a.page, n), { timeout: 2_000 }).toBe(false)
    await expect(b.page.getByTestId('context-menu')).toHaveCount(0)
    await b.page.mouse.click(empty.x, empty.y, { button: 'right' })
    await expect(b.page.getByTestId('context-menu')).toBeVisible()
    await expect(b.page.getByTestId('context-menu.unlock-all')).toHaveCount(0)
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByTestId('context-menu')).toHaveCount(0)
  })
})

test('context menu: a right-click on a note selects it and offers its entries; Duplicate copies it in one step; Shift+F10 opens it from the keyboard, arrows move, Escape gives the keyboard back', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const n = await settled(a.page, createNote(a.page, { x: 300, y: 200, text: 'Copy me' }))
  const menu = a.page.getByTestId('context-menu')

  await test.step('right-click on the note: it is selected and the menu offers the note entries', async () => {
    await clickItem(a.page, n, { button: 'right' })
    await expect(menu).toBeVisible()
    expect(await withCanvas(a.page, (c) => c.selection, null)).toEqual([n])
    for (const id of ['cut', 'copy', 'duplicate', 'toggle-lock', 'delete', 'select-all'])
      await expect(a.page.getByTestId(`context-menu.${id}`), id).toBeVisible()
    await expect(a.page.getByTestId('context-menu-sub.reorder-button')).toBeVisible()
    // one element: no arrange (align needs two) and no group
    await expect(a.page.getByTestId('context-menu-sub.arrange-button')).toHaveCount(0)
    await expect(a.page.getByTestId('context-menu.group')).toHaveCount(0)
    await expect(a.page.getByTestId('context-menu.toggle-lock')).toHaveText('Toggle lockedCtrl+Shift+L')
  })

  await test.step('Duplicate: a copy with the same words, selected, one undo step', async () => {
    await a.page.getByTestId('context-menu.duplicate').click()
    await expect(menu).toHaveCount(0)
    await expect.poll(async () => (await items(a.page)).filter((e) => e.type === 'stickynote').length).toBe(2)
    const copy = (await items(a.page)).find((e) => e.type === 'stickynote' && e.id !== n)?.id as string
    await expect.poll(() => itemText(a.page, copy)).toBe('Copy me')
    expect(await withCanvas(a.page, (c) => c.selection, null)).toEqual([copy])
    expect((await item(a.page, copy))?.created ?? null, 'a duplicated note has no date').toBeNull()
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await items(a.page)).filter((e) => e.type === 'stickynote').length).toBe(1)
  })

  await test.step('Shift+F10 opens it for the selection; arrows move; Escape returns to the board', async () => {
    await select(a.page, [n])
    await a.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await a.page.keyboard.press('Shift+F10')
    await expect(menu).toBeVisible()
    const first = menu.locator('[role^="menuitem"]').first()
    await expect(first).toBeFocused()
    await a.page.keyboard.press('ArrowDown')
    await expect(menu.locator('[role^="menuitem"]').nth(1)).toBeFocused()
    await a.page.keyboard.press('End')
    await expect(menu.locator('[role^="menuitem"]').last()).toBeFocused()
    await a.page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    // the context-menu key too
    await a.page.keyboard.press('ContextMenu')
    await expect(menu).toBeVisible()
    await a.page.keyboard.press('Escape')
  })

  await test.step('a submenu opens with ArrowRight and closes with ArrowLeft; Reorder runs from it', async () => {
    await clickItem(a.page, n, { button: 'right' })
    await a.page.getByTestId('context-menu-sub.reorder-button').focus()
    await a.page.keyboard.press('ArrowRight')
    await expect(a.page.getByTestId('context-menu.bring-to-front')).toBeFocused()
    await a.page.keyboard.press('ArrowLeft')
    await expect(a.page.getByTestId('context-menu-sub.reorder-content')).toHaveCount(0)
    await expect(a.page.getByTestId('context-menu-sub.reorder-button')).toBeFocused()
    await a.page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
})

test('FAC-07 (partial): Board → Hide note authors is the synced workshop setting (bob sees it within 2 s, with its notice); a viewer sees it disabled; Preferences and Keyboard shortcuts are there', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const v = await canvasSession('carol', { role: 'viewer' })
  await waitForCanvasUx(a.page)
  const workshop = (page: Page) => withCanvas(page, (c) => c.doc.get('workshop') ?? null, null)
  await a.page.getByTestId('main-menu.button').click()
  await a.page.getByTestId('main-menu-sub.dr-board-button').click()
  const item_ = a.page.getByRole('menuitemcheckbox', { name: 'Hide note authors' })
  await expect(item_).toHaveAttribute('aria-checked', 'false')
  await item_.click()
  await expect(a.page.getByTestId('board-setting-notice')).toContainText('This is not anonymity')
  await expect.poll(() => workshop(b.page), { timeout: 2_000 }).toMatchObject({ hideNoteAuthors: true })
  // the viewer sees the state, and cannot change it
  await v.page.getByTestId('main-menu.button').click()
  await v.page.getByTestId('main-menu-sub.dr-board-button').click()
  const vItem = v.page.getByRole('menuitemcheckbox', { name: 'Hide note authors' })
  await expect(vItem).toHaveAttribute('aria-checked', 'true')
  await expect(vItem).toHaveAttribute('aria-disabled', 'true')
  await vItem.click({ force: true })
  expect(await workshop(a.page)).toMatchObject({ hideNoteAuthors: true })
  await v.page.keyboard.press('Escape')
  // off again, from alice's menu
  await a.page.getByTestId('main-menu.button').click()
  await a.page.getByTestId('main-menu-sub.dr-board-button').click()
  await expect(item_).toHaveAttribute('aria-checked', 'true')
  await item_.click()
  await expect.poll(() => workshop(b.page), { timeout: 2_000 }).toMatchObject({ hideNoteAuthors: false })
  await expect(a.page.getByTestId('board-setting-notice')).toHaveText('Note authors are shown again.')

  await test.step('Preferences → Always snap toggles snapping; Keyboard shortcuts opens the dialog', async () => {
    const snap = () => withCanvas(a.page, (c) => c.settings.get().snap, null)
    const before = await snap()
    await a.page.getByTestId('main-menu.button').click()
    await a.page.getByTestId('main-menu-sub.preferences-button').click()
    await a.page.getByTestId('main-menu.toggle-snap-mode').click()
    await expect.poll(snap).toBe(!before)
    await a.page.getByTestId('main-menu.button').click()
    await a.page.getByTestId('main-menu.keyboard-shortcuts').click()
    await expect(a.page.getByTestId('shortcuts-dialog')).toBeVisible()
    await a.page.getByTestId('shortcuts-dialog-close').click()
    await expect(a.page.getByTestId('shortcuts-dialog')).toHaveCount(0)
  })
})

test('export control: while the owner has exporting off for viewers, a viewer’s Ctrl+C on the board says why, and the context and board menus show the one line instead', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'viewer' })
  await waitForCanvasUx(b.page)
  const n = await settled(a.page, createNote(a.page, { x: 300, y: 200, text: 'Secret' }))
  await waitForItem(b.page, n)
  const OFF = 'The board owner turned off exporting for viewers'

  await test.step('before: the menus have no export-off line', async () => {
    await clickItem(b.page, n, { button: 'right' })
    await expect(b.page.getByTestId('context-menu')).toBeVisible()
    await expect(b.page.getByTestId('context-menu.dr-export-off')).toHaveCount(0)
    await b.page.keyboard.press('Escape')
  })

  await test.step('the owner turns exporting off for viewers', async () => {
    const status = await a.page.evaluate(async (bid) => {
      const r = await fetch(`/api/boards/${encodeURIComponent(bid)}/export-policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ exportPolicy: 'editors' }),
      })
      return r.status
    }, board)
    expect(status).toBe(200)
  })

  await test.step('the viewer, without a reload: Ctrl+C says why; the menus show the line', async () => {
    await select(b.page, [n])
    await b.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await expect
      .poll(async () => {
        await b.page.keyboard.press('ControlOrMeta+c')
        return b.page.getByTestId('export-off-notice').count()
      })
      .toBeGreaterThan(0)
    await expect(b.page.getByTestId('export-off-notice')).toContainText(OFF)
    await clickItem(b.page, n, { button: 'right' })
    await expect(b.page.getByTestId('context-menu.dr-export-off')).toContainText(OFF)
    await expect(b.page.getByTestId('context-menu.copy')).toHaveCount(0)
    await b.page.getByTestId('context-menu.dr-export-off').click()
    await expect(b.page.getByTestId('export-off-notice')).toContainText(OFF)
    await b.page.getByTestId('main-menu.button').click()
    await b.page.getByTestId('main-menu-sub.export-button').click()
    await expect(b.page.getByTestId('main-menu.dr-export-off')).toContainText(OFF)
    await b.page.keyboard.press('Escape')
  })

  await test.step('the owner keeps every entry', async () => {
    await clickItem(a.page, n, { button: 'right' })
    await expect(a.page.getByTestId('context-menu.copy')).toBeVisible()
    await expect(a.page.getByTestId('context-menu.dr-export-off')).toHaveCount(0)
    await a.page.keyboard.press('Escape')
  })
})
