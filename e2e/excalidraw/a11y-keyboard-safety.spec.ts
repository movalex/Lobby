// PORTED from e2e/tests/keyboard-safety.spec.ts (the tldraw spec keeps running on the default build) to the
// Excalidraw board page (owner 3i, docs/EXCALIDRAW-MIGRATION.md §4.8 (4)): board shortcuts only act while
// the board has the keyboard (A11Y2-02), one undo press undoes the last real change after selection clicks
// (F11), and a keyboard-only user can comment on a note inside a frame (A11Y2-04).
//
// Deviations from the tldraw spec: the places the keyboard sits outside the board are the rail, the a11y
// feature's Contents panel and its rows, Share and the board title (History, Present and Frames are 3h's,
// 3e's and 3b's); the keys that still act from the chrome on tldraw (Ctrl+Z, Shift+= zoom) are their own
// tests (Ctrl+Z from the chrome and Ctrl+X on the canvas since 3a's wave 3b; Shift+= an expected failure until 3b
// brings it to the new page); the comment test is 3c's
// (the context menu is 3a's). The select tool's own "into the frame" keys are a11y-traversal.spec.ts's.
import type { Page } from '@playwright/test'
import {
  clickItem,
  expect,
  item,
  items,
  select,
  setTool,
  test,
  tool,
  updateItem,
  viewport,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { grantClipboard, writeClipboard } from '../tests/support/canvas-ux.ts'
import {
  boardHasFocus,
  focusCanvas,
  frame,
  intoFrame,
  MISSING_FEATURE_MS,
  needs,
  note,
  selected,
  waitForA11y,
} from './a11y-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** A frame "Retro" holding one note, plus a loose note to its right, all in view. */
async function setUp(page: Page) {
  await waitForA11y(page)
  const retro = await frame(page, 0, 0, 800, 500, 'Retro')
  const inner = await note(page, 100, 100, 'Keep me')
  await intoFrame(page, [inner], retro)
  const loose = await note(page, 1000, 100, 'Loose note')
  await zoomToFit(page)
  return { retro, inner, loose }
}

/** Live (the facade's `get` also returns deleted elements). */
const exists = async (page: Page, id: string) => {
  const el = await item(page, id)
  return !!el && !(el as { isDeleted?: boolean }).isDeleted
}

/** Select tool, `id` selected, then the keyboard on `focus`. */
async function selectThenFocus(page: Page, id: string, focus: () => Promise<void>) {
  await setTool(page, 'select')
  await select(page, [id])
  await focus()
}

test('A11Y2-02: tool letters, Delete and Backspace do nothing to the board while the keyboard is in the top bar, the rail or a dock panel', async ({
  canvasSession,
}, testInfo) => {
  const { page } = await canvasSession('alice')
  const { inner } = await setUp(page)

  // a dock panel opened from the keyboard: its heading has the focus
  await selectThenFocus(page, inner, async () => {
    await page.getByTestId('dock-tab-contents').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('dock-panel-contents').locator('h2')).toBeFocused()
  })
  await page.keyboard.press('r')
  await page.keyboard.press('t')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Control+a')
  await page.waitForTimeout(200)
  expect(await tool(page)).toBe('select')
  expect(await exists(page, inner)).toBe(true)
  expect(await selected(page)).toEqual([inner])
  await page.screenshot({ path: testInfo.outputPath('a11y2-02-panel-delete.png') })

  // a row of the panel, top-bar buttons, the rail and the board title
  const places = [
    () => page.getByTestId('contents-item').first().focus(),
    () => page.getByTestId('share-button').focus(),
    () => page.getByTestId('dock-tab-contents').focus(),
    () => page.getByTestId('board-title').focus(),
  ]
  for (const [i, place] of places.entries()) {
    await selectThenFocus(page, inner, place)
    for (const key of ['t', 'n', 'Delete', 'Backspace']) await page.keyboard.press(key)
    await page.waitForTimeout(150)
    expect({ i, tool: await tool(page), note: await exists(page, inner) }).toEqual({
      i,
      tool: 'select',
      note: true,
    })
  }

  // back on the canvas, the same keys act again
  await selectThenFocus(page, inner, () => focusCanvas(page))
  await page.keyboard.press('Delete')
  await expect.poll(() => exists(page, inner)).toBe(false)
  await page.keyboard.press('t')
  await expect.poll(() => tool(page)).toBe('text')
})

test('A11Y2-02: undo still works from the chrome (history keys are not board content)', async ({
  canvasSession,
}) => {
  const { page } = await canvasSession('alice')
  const { loose } = await setUp(page)
  await updateItem(page, loose, { x: 1100 })
  await page.getByTestId('share-button').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await item(page, loose))?.x, { timeout: MISSING_FEATURE_MS }).toBe(1000)
})

test('A11Y2-02: Ctrl+X, Ctrl+V and "," from the top bar and the rail leave the board alone', async ({
  canvasSession,
}) => {
  const { page, context } = await canvasSession('alice')
  await grantClipboard(context)
  const { inner } = await setUp(page)
  const count = async () => (await items(page)).length
  const all = await count()

  for (const testId of ['share-button', 'dock-tab-contents', 'board-title']) {
    await selectThenFocus(page, inner, () => page.getByTestId(testId).focus())
    await page.keyboard.press('ControlOrMeta+x')
    await page.waitForTimeout(200)
    expect({ testId, note: await exists(page, inner) }).toEqual({ testId, note: true })
  }

  // Ctrl+V does not drop the clipboard onto the board
  await writeClipboard(page, { 'text/plain': 'Pasted from the top bar' })
  await page.getByTestId('share-button').focus()
  await page.keyboard.press('ControlOrMeta+v')
  await page.waitForTimeout(400)
  expect(await count()).toBe(all)

  // "," does not place a note from the top bar
  await page.mouse.move(600, 700)
  await setTool(page, 'note')
  await page.getByTestId('share-button').focus()
  await page.keyboard.press(',')
  await page.waitForTimeout(300)
  expect(await count()).toBe(all)
  await setTool(page, 'select')
})

test('A11Y2-02: on the canvas, Ctrl+X still cuts', async ({ canvasSession }) => {
  const { page, context } = await canvasSession('alice')
  await grantClipboard(context)
  const { inner } = await setUp(page)
  await selectThenFocus(page, inner, () => focusCanvas(page))
  await page.keyboard.press('ControlOrMeta+x')
  await expect.poll(() => exists(page, inner), { timeout: MISSING_FEATURE_MS }).toBe(false)
})

test('A11Y2-02: zooming at the cursor (Shift+=) still works from the chrome', async ({ canvasSession }) => {
  // 3i asked 3b: the camera keys act from the chrome too (3b's navigation feature, wave 3b)
  const { page } = await canvasSession('alice')
  await setUp(page)
  const z0 = (await viewport(page)).zoom
  await page.getByTestId('share-button').focus()
  await page.keyboard.press('Shift+Equal')
  await expect
    .poll(async () => (await viewport(page)).zoom, { timeout: MISSING_FEATURE_MS })
    .toBeGreaterThan(z0)
})

/** F11's set-up: a real change with the loose note selected, then four selection-only steps. */
async function changeThenClicks(page: Page) {
  const { loose } = await setUp(page)
  // a real change with the loose note selected (as Arrange as grid leaves its shapes selected)
  await setTool(page, 'select')
  await select(page, [loose])
  await updateItem(page, loose, { x: 1100, y: 300 })
  await expect.poll(async () => (await item(page, loose))?.x).toBe(1100)
  await zoomToFit(page)
  // click empty canvas, click the note, Escape, Ctrl+A
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height - 40)
  await clickItem(page, loose)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+a')
  await expect.poll(async () => (await selected(page)).length).toBeGreaterThan(1)
  return { loose, x: async () => (await item(page, loose))?.x }
}

test('F11: after selection clicks, one Ctrl+Z undoes the last real change; one Ctrl+Shift+Z redoes it', async ({
  canvasSession,
}) => {
  const { page } = await canvasSession('alice')
  const { x } = await changeThenClicks(page)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(x).toBe(1000)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(x).toBe(1100)
  expect(await boardHasFocus(page)).toBe(true)
})

test('F11: the undo restores the selection the change was made with', async ({ canvasSession }) => {
  needs('spike B history (canvas/history)', 'undo restoring the selection of the undone step')
  const { page } = await canvasSession('alice')
  const { loose, x } = await changeThenClicks(page)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(x).toBe(1000)
  await expect.poll(() => selected(page), { timeout: MISSING_FEATURE_MS }).toEqual([loose])
})

test('A11Y2-04: with the keyboard only, a note inside a frame gets a comment (context menu, or the comment tool going inside the frame)', async ({
  canvasSession,
}) => {
  const { page } = await canvasSession('alice')
  const { retro, inner } = await setUp(page)
  const composer = page.getByTestId('new-comment-popover')

  // 1. select the note, Shift+F10, Comment
  await selectThenFocus(page, inner, () => focusCanvas(page))
  await page.keyboard.press('Shift+F10')
  const entry = page.getByRole('menuitem', { name: 'Comment', exact: true })
  await expect(entry).toBeVisible({ timeout: MISSING_FEATURE_MS })
  await entry.focus()
  await page.keyboard.press('Enter')
  await expect(composer).toBeVisible()
  await expect(page.getByTestId('new-comment-where')).toHaveText('Retro · note')
  await expect(composer.locator('textarea')).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(composer).toHaveCount(0)

  // 2. the comment tool: C, Tab to the frame, Ctrl+Shift+Down into it, Enter
  await setTool(page, 'select')
  await select(page, [])
  await focusCanvas(page)
  await page.keyboard.press('c')
  await expect.poll(() => tool(page)).toBe('comment')
  for (let i = 0; i < 3; i++) {
    const sel = await selected(page)
    if (sel.length === 1 && sel[0] === retro) break
    await page.keyboard.press('Tab')
  }
  expect(await selected(page)).toEqual([retro])
  await page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
  await expect.poll(() => selected(page)).toEqual([inner])
  expect(await tool(page)).toBe('comment')
  await page.keyboard.press('Enter')
  await expect(composer).toBeVisible()
  await expect(page.getByTestId('new-comment-where')).toHaveText('Retro · note')
  await page.keyboard.type('Keyboard comment')
  await page.keyboard.press('Enter')
  await expect(composer).toHaveCount(0)
  await expect(page.getByTestId('comment-pin')).toHaveCount(1)

  // Ctrl+Shift+Up goes back out to the frame
  await focusCanvas(page)
  await select(page, [inner])
  await page.keyboard.press('ControlOrMeta+Shift+ArrowUp')
  await expect.poll(() => selected(page)).toEqual([retro])
})
