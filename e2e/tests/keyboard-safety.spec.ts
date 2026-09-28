// Keyboard safety (demo review, final round): board shortcuts only act while the board has the
// keyboard (A11Y2-02), one undo press undoes the last real change after selection clicks (F11), and a
// keyboard-only user can comment on a note inside a frame (A11Y2-04).
import type { Page } from '@playwright/test'
import { editEd, readEd, waitForCanvasUx } from './support/canvas-ux.ts'
import { expect, test } from './support/fixtures.ts'
import { createShapes, noteAt } from './support/tags.ts'

test.use({ viewport: { width: 1440, height: 900 } })

interface Ed {
  setCurrentTool(id: string): void
  select(...ids: string[]): void
  selectNone(): void
  markHistoryStoppingPoint(name: string): void
  updateShapes(partials: unknown[]): void
  getShape(id: string): { x: number; parentId: string } | undefined
  getSelectedShapeIds(): string[]
  getShapePageBounds(id: string): { x: number; y: number; w: number; h: number }
  pageToScreen(p: { x: number; y: number }): { x: number; y: number }
  getCurrentToolId(): string
}

const FRAME = 'shape:ks-frame'
const INNER = 'shape:ks-inner'
const LOOSE = 'shape:ks-loose'

/** A frame "Retro" holding one note, plus a loose note to its right, all in view. */
async function setUp(page: Page) {
  await waitForCanvasUx(page)
  await createShapes(page, [
    { id: FRAME, type: 'frame', x: 0, y: 0, props: { w: 800, h: 500, name: 'Retro' } },
    { ...noteAt(INNER, 100, 100, 'Keep me'), parentId: FRAME },
    noteAt(LOOSE, 1000, 100, 'Loose note'),
  ])
  await editEd(page, (ed) => ed.zoomToBounds({ x: -100, y: -100, w: 1400, h: 800 }, { immediate: true }))
}

const exists = (page: Page, id: string) => readEd(page, (ed, i) => !!(ed as unknown as Ed).getShape(i), id)
const toolId = (page: Page) => readEd(page, (ed) => (ed as unknown as Ed).getCurrentToolId())

/** Select tool, `id` selected, then the keyboard on `target`. */
async function selectThenFocus(page: Page, id: string, focus: () => Promise<void>) {
  await editEd(
    page,
    (ed, i) => {
      const e = ed as unknown as Ed
      e.setCurrentTool('select')
      e.select(i)
    },
    id,
  )
  await focus()
}

test('A11Y2-02: tool letters, Delete and Backspace do nothing to the board while the keyboard is in the top bar, the rail or a dock panel', async ({
  session,
}, testInfo) => {
  const { page } = await session('alice')
  await setUp(page)

  // A dock panel opened from the keyboard: its heading has the focus.
  await selectThenFocus(page, INNER, async () => {
    await page.getByTestId('dock-tab-history').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('dock-panel-history').locator('h2')).toBeFocused()
  })
  await page.keyboard.press('r')
  await page.keyboard.press('t')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Control+a')
  await page.waitForTimeout(200)
  expect(await toolId(page)).toBe('select')
  expect(await exists(page, INNER)).toBe(true)
  expect(await readEd(page, (ed) => (ed as unknown as Ed).getSelectedShapeIds())).toEqual([INNER])
  await page.screenshot({ path: testInfo.outputPath('a11y2-02-panel-delete.png') })

  // A button in the panel, top-bar buttons, the rail and the board title.
  const places = ['history-duplicate', 'share-button', 'present-button', 'dock-tab-frames', 'board-title']
  for (const testId of places) {
    await selectThenFocus(page, INNER, () => page.getByTestId(testId).focus())
    for (const key of ['t', 'n', 'Delete', 'Backspace']) await page.keyboard.press(key)
    await page.waitForTimeout(150)
    expect({ testId, tool: await toolId(page), note: await exists(page, INNER) }).toEqual({
      testId,
      tool: 'select',
      note: true,
    })
  }

  // Undo still works from the chrome (history keys are not board content).
  await editEd(page, (ed) => {
    const e = ed as unknown as Ed
    e.markHistoryStoppingPoint('move')
    e.updateShapes([{ id: 'shape:ks-loose', type: 'note', x: 1100 }])
  })
  await page.getByTestId('share-button').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() => readEd(page, (ed) => (ed as unknown as Ed).getShape('shape:ks-loose')?.x))
    .toBe(1000)

  // Back on the canvas, the same keys act again.
  await selectThenFocus(page, INNER, () => page.locator('.tl-container').first().focus())
  await page.keyboard.press('Delete')
  await expect.poll(() => exists(page, INNER)).toBe(false)
  await page.keyboard.press('t')
  await expect.poll(() => toolId(page)).toBe('text')
})

test('F11: after selection clicks, one Ctrl+Z undoes the last real change and restores its selection', async ({
  session,
}) => {
  const { page } = await session('alice')
  await setUp(page)
  // A real change with the loose note selected (as Arrange as grid leaves its shapes selected).
  await editEd(page, (ed) => {
    const e = ed as unknown as Ed
    e.setCurrentTool('select')
    e.select('shape:ks-loose')
    e.markHistoryStoppingPoint('move')
    e.updateShapes([{ id: 'shape:ks-loose', type: 'note', x: 1100, y: 300 }])
  })
  const loose = () => readEd(page, (ed) => (ed as unknown as Ed).getShape('shape:ks-loose')?.x)
  const centre = await readEd(page, (ed) => {
    const e = ed as unknown as Ed
    const r = e.getShapePageBounds('shape:ks-loose')
    return e.pageToScreen({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  })
  // Click empty canvas, click the note, Escape, Ctrl+A: four selection-only steps.
  await page.mouse.click(700, 820)
  await page.mouse.click(centre.x, centre.y)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+a')
  await expect.poll(() => readEd(page, (ed) => (ed as unknown as Ed).getSelectedShapeIds().length)).toBe(2)

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(loose).toBe(1000)
  // The selection the move was made with.
  expect(await readEd(page, (ed) => (ed as unknown as Ed).getSelectedShapeIds())).toEqual(['shape:ks-loose'])
  // Redo puts it back in one press as well.
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(loose).toBe(1100)
})

test('A11Y2-04: with the keyboard only, a note inside a frame gets a comment (context menu, or the comment tool going inside the frame)', async ({
  session,
}, testInfo) => {
  const { page } = await session('alice')
  await setUp(page)
  const composer = page.getByTestId('new-comment-popover')

  // 1. Select the note, Shift+F10, Comment.
  await selectThenFocus(page, INNER, () => page.locator('.tl-container').first().focus())
  await page.keyboard.press('Shift+F10')
  const item = page.getByRole('menuitem', { name: 'Comment', exact: true })
  await expect(item).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('a11y2-04-context-menu.png') })
  await item.focus()
  await page.keyboard.press('Enter')
  await expect(composer).toBeVisible()
  await expect(page.getByTestId('new-comment-where')).toHaveText('Retro · note')
  await expect(composer.locator('textarea')).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('a11y2-04-composer.png') })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(composer).toHaveCount(0)

  // 2. The comment tool: C, Tab to the frame, Ctrl+Shift+Down into it, Enter.
  await editEd(page, (ed) => {
    const e = ed as unknown as Ed
    e.setCurrentTool('select')
    e.selectNone()
  })
  await page.locator('.tl-container').first().focus()
  await page.keyboard.press('c')
  await expect.poll(() => toolId(page)).toBe('comment')
  // Tab walks the top level in reading order until the frame is selected.
  for (let i = 0; i < 3; i++) {
    const sel = await readEd(page, (ed) => (ed as unknown as Ed).getSelectedShapeIds())
    if (sel.length === 1 && sel[0] === FRAME) break
    await page.keyboard.press('Tab')
  }
  expect(await readEd(page, (ed) => (ed as unknown as Ed).getSelectedShapeIds())).toEqual([FRAME])
  await page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
  await expect.poll(() => readEd(page, (ed) => (ed as unknown as Ed).getSelectedShapeIds())).toEqual([INNER])
  expect(await toolId(page)).toBe('comment')
  await page.keyboard.press('Enter')
  await expect(composer).toBeVisible()
  await expect(page.getByTestId('new-comment-where')).toHaveText('Retro · note')
  await page.keyboard.type('Keyboard comment')
  await page.keyboard.press('Enter')
  await expect(composer).toHaveCount(0)
  await expect(page.getByTestId('comment-pin')).toHaveCount(1)

  // Ctrl+Shift+Up goes back out to the frame.
  await page.locator('.tl-container').first().focus()
  await editEd(page, (ed) => (ed as unknown as Ed).select('shape:ks-inner'))
  await page.keyboard.press('ControlOrMeta+Shift+ArrowUp')
  await expect.poll(() => readEd(page, (ed) => (ed as unknown as Ed).getSelectedShapeIds())).toEqual([FRAME])
})
