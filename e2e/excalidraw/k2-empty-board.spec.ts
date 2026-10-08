// K2-4 (wave K, UXD-03): a blank board shows a "start here" card over a subtle dot grid. Neither takes the
// pointer (a double-click through the card's words still makes a note there); only the card's buttons do.
// Both go with the first element. Viewers get one read-only line. The axe audit of the empty board in light
// and dark is a11y-audit.spec.ts's ("axe: the board page …").
import type { Page } from '@playwright/test'
import {
  deleteItem,
  editingId,
  expect,
  items,
  test,
  typeText,
  waitForCanvas,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { note } from './a11y-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const hint = (page: Page) => page.getByTestId('empty-board-hint')
const grid = (page: Page) => page.getByTestId('empty-board-grid')

test('K2-4: a blank board shows the start card and the dot grid; a double-click through the card makes a note; both go with it', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  await expect(hint(a.page)).toBeVisible()
  await expect(grid(a.page)).toBeVisible()
  await expect(hint(a.page)).toContainText('Start your board')
  await expect(a.page.getByTestId('empty-hint-templates')).toBeVisible()
  await expect(a.page.getByTestId('empty-hint-mindmap')).toBeVisible()
  // the card and the grid take no pointer events; the buttons do
  const pointer = await a.page.evaluate(() => {
    const pe = (sel: string) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).pointerEvents : null
    }
    return {
      card: pe('[data-testid="empty-board-hint"]'),
      line: pe('.cux-empty-hint__line'),
      grid: pe('[data-testid="empty-board-grid"]'),
      button: pe('[data-testid="empty-hint-templates"]'),
    }
  })
  expect(pointer).toEqual({ card: 'none', line: 'none', grid: 'none', button: 'auto' })
  await a.page.screenshot({ path: testInfo.outputPath('k2-4-empty-board.png') })

  // a double-click on the card's words (not a button) reaches the board: a note there, its editor open
  const line = await a.page.locator('.cux-empty-hint__title').boundingBox()
  if (!line) throw new Error('no hint line')
  await a.page.mouse.dblclick(line.x + line.width / 2, line.y + line.height / 2)
  const id = await waitForTextEditor(a.page)
  await typeText(a.page, 'First idea')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  const made = (await items(a.page)).find((e) => e.id === id)
  expect(made?.type).toBe('stickynote')
  await expect(hint(a.page)).toHaveCount(0)
  await expect(grid(a.page)).toHaveCount(0)
})

test('K2-4: "Browse templates" opens the templates panel; "Start a mind map" starts one', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  await a.page.getByTestId('empty-hint-templates').click()
  await expect(a.page.getByTestId('dock-panel-templates')).toBeVisible()
  await a.page.getByTestId('dock-panel-close').click()
  await a.page.getByTestId('empty-hint-mindmap').click()
  await expect.poll(async () => (await items(a.page)).length).toBeGreaterThan(0)
  await expect(hint(a.page)).toHaveCount(0)
})

test('K2-4: a viewer gets one read-only line, no buttons; the card is back once the board is empty again', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('carol', { role: 'viewer' })
  await waitForCanvas(v.page)
  await expect(hint(v.page)).toHaveText('Nothing on this board yet.')
  await expect(hint(v.page).locator('button')).toHaveCount(0)
  const id = await note(a.page, 0, 0, 'Hello')
  await expect(hint(v.page)).toHaveCount(0)
  await deleteItem(a.page, id)
  await expect(hint(v.page)).toBeVisible()
  await expect(hint(a.page)).toBeVisible()
})
