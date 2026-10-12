// Wave N1 (web follow-ups of wave M, W1): the selection bar's three untested corners, on two notes selected (so the bar
// has its arrange row).
//  - the open style tray follows the arrange row in the DOM, as it does on screen (WCAG 2.4.3, Focus Order): the bar's
//    buttons, in DOM order, read left to right and top to bottom, on a wide canvas (a control's tray) and on a compact
//    one (the Style button's tray, under More's row);
//  - at 900 x 700 with the style panel open the full bar fits nowhere clear of the panel and folds to compact (Style and
//    More buttons; no per-control buttons), clear of the panel and the bottom toolbar; at 1440 x 900 the same selection
//    gets the full bar;
//  - at 720 x 700 the compact bar's More row is wider than the room left of the style panel: the panel steps aside while
//    More is open, and is back when it closes.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n1w-selection-bar.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { createNote, expect, expectSaved, select, setViewport, test } from '../tests/support/canvas.ts'
import { waitForA11y } from './a11y-kit.ts'

const bar = (page: Page) => page.getByTestId('selection-bar')
const panel = (page: Page) => page.getByTestId('style.panel')

/** Two notes side by side, selected, with the view put so the pair sits in the middle of the canvas. */
async function twoNotesSelected(page: Page) {
  await waitForA11y(page)
  const n1 = await createNote(page, { x: 0, y: 0, text: 'One' })
  const n2 = await createNote(page, { x: 240, y: 0, text: 'Two' })
  await expectSaved(page)
  const canvas = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!canvas) throw new Error('no canvas')
  await setViewport(page, { x: 220 - canvas.width / 2, y: 100 - canvas.height / 2, zoom: 1 })
  await select(page, [n1, n2])
  await expect(bar(page)).toBeVisible()
  await barSettled(page)
  return [n1, n2] as const
}

/** The bar has stopped moving (its box is the same a moment later). */
async function barSettled(page: Page) {
  const where = () =>
    page.evaluate(() => {
      const r = document.querySelector('[data-testid="selection-bar"]')?.getBoundingClientRect()
      return r ? `${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)}` : null
    })
  await expect
    .poll(async () => {
      const a = await where()
      await page.waitForTimeout(250)
      return a !== null && a === (await where())
    })
    .toBe(true)
}

interface Btn {
  id: string
  top: number
  left: number
  right: number
  height: number
}

/** The bar's own buttons in DOM order, with where each is drawn. */
const buttonsInDomOrder = (page: Page): Promise<Btn[]> =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="selection-bar"]')
    if (!el) throw new Error('no selection bar')
    return [...el.querySelectorAll<HTMLButtonElement>('button')]
      .filter((b) => b.closest('[role="toolbar"]') === el)
      .map((b) => {
        const r = b.getBoundingClientRect()
        return {
          id: b.getAttribute('data-testid') ?? b.getAttribute('aria-label') ?? '?',
          top: r.top,
          left: r.left,
          right: r.right,
          height: r.height,
        }
      })
  })

/**
 * Whether `b` reads after `a`: on a lower row, or on the same row and to the right. Rows are told apart by half a
 * button's height (the tray and More rows are separate rows; buttons on one row share a top).
 */
const readsAfter = (a: Btn, b: Btn) =>
  b.top > a.top + a.height / 2 || (Math.abs(b.top - a.top) <= a.height / 2 && b.left >= a.right - 1)

/** The first pair of neighbours in DOM order that do not read in order (a description), or null. */
function outOfOrder(buttons: readonly Btn[]): string | null {
  for (let i = 1; i < buttons.length; i++) {
    const a = buttons[i - 1] as Btn
    const b = buttons[i] as Btn
    if (!readsAfter(a, b)) {
      const at = (x: Btn) => `${x.id} (${Math.round(x.left)},${Math.round(x.top)})`
      return `${at(b)} after ${at(a)}`
    }
  }
  return null
}

test.describe('at 1440 x 900', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('N1 (W1): a control’s open tray comes after the arrange row in the DOM, where it is drawn (WCAG 2.4.3)', async ({
    canvasSession,
  }, testInfo) => {
    const a = await canvasSession('alice')
    await twoNotesSelected(a.page)
    // the full bar: a button per control, then the arrange row
    await expect(bar(a.page)).not.toHaveAttribute('data-compact', 'true')
    await expect(bar(a.page).getByTestId('align-left')).toBeVisible()
    await bar(a.page).getByTestId('selection-style-note-colour').click()
    const tray = bar(a.page).getByTestId('selection-style-tray')
    await expect(tray).toBeVisible()
    await barSettled(a.page)
    await a.page.screenshot({ path: testInfo.outputPath('n1w-tray-open.png') })

    const buttons = await buttonsInDomOrder(a.page)
    const ids = buttons.map((b) => b.id)
    const arrangeEnd = Math.max(ids.indexOf('align-left'), ids.indexOf('align-bottom'))
    const firstTray = ids.findIndex((id) => id.startsWith('selection-style.'))
    expect(arrangeEnd, ids.join(' ')).toBeGreaterThan(0)
    expect(firstTray, ids.join(' ')).toBeGreaterThan(arrangeEnd)
    // and every button reads after the one before it
    expect(outOfOrder(buttons)).toBeNull()
    // the tray is drawn under the arrange row
    const align = buttons[arrangeEnd] as Btn
    const swatch = buttons[firstTray] as Btn
    expect(swatch.top).toBeGreaterThan(align.top + align.height / 2)

    // the arrow keys walk the bar in that order: from the last button before the tray the next stop is the tray's first
    const lastBeforeTray = ids[firstTray - 1] as string
    await bar(a.page).getByTestId(lastBeforeTray).focus()
    await a.page.keyboard.press('ArrowRight')
    await expect(a.page.locator(':focus')).toHaveAttribute('data-testid', ids[firstTray] as string)
  })
})

test.describe('at 900 x 700', () => {
  test.use({ viewport: { width: 900, height: 700 } })

  test('N1 (W1): with the style panel open the full bar fits nowhere and folds to compact, clear of the panel and the toolbar', async ({
    canvasSession,
  }, testInfo) => {
    const a = await canvasSession('alice')
    await twoNotesSelected(a.page)
    await expect(panel(a.page)).toBeVisible()
    await expect(bar(a.page)).toHaveAttribute('data-compact', 'true')
    await a.page.screenshot({ path: testInfo.outputPath('n1w-folded.png') })
    // compact: Style and More, not a button per control
    await expect(bar(a.page).getByTestId('selection-style')).toBeVisible()
    await expect(bar(a.page).getByTestId('selection-more')).toBeVisible()
    await expect(bar(a.page).getByTestId('selection-style-note-colour')).toHaveCount(0)
    await expect(bar(a.page).getByTestId('align-left')).toHaveCount(0)
    // and it is drawn clear of the style panel and the bottom toolbar
    const [b, p, t] = await Promise.all([
      bar(a.page).boundingBox(),
      panel(a.page).boundingBox(),
      a.page.locator('[data-lobby-slot="toolbar"] .cux-toolbar-wrap').boundingBox(),
    ])
    if (!b || !p || !t) throw new Error('no bar, panel or toolbar')
    const overlaps = (x: { x: number; y: number; width: number; height: number }) =>
      b.x < x.x + x.width && x.x < b.x + b.width && b.y < x.y + x.height && x.y < b.y + b.height
    expect(overlaps(p)).toBe(false)
    expect(overlaps(t)).toBe(false)
    // More and the Style tray both open: the tray is after More's row in the DOM, as drawn
    await bar(a.page).getByTestId('selection-more').click()
    await bar(a.page).getByTestId('selection-style').click()
    await expect(bar(a.page).getByTestId('selection-style-tray')).toBeVisible()
    await expect(bar(a.page).getByTestId('selection-more-row')).toBeVisible()
    await barSettled(a.page)
    expect(outOfOrder(await buttonsInDomOrder(a.page))).toBeNull()
  })
})

test.describe('at 1440 x 900, the same selection', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('N1 (W1): the full bar, not folded, where it fits', async ({ canvasSession }) => {
    const a = await canvasSession('alice')
    await twoNotesSelected(a.page)
    await expect(panel(a.page)).toBeVisible()
    await expect(bar(a.page)).not.toHaveAttribute('data-compact', 'true')
    await expect(bar(a.page).getByTestId('selection-more')).toHaveCount(0)
  })
})

test.describe('at 720 x 700', () => {
  test.use({ viewport: { width: 720, height: 700 } })

  test('N1 (W1): the style panel steps aside while the bar’s More row would cover it, and comes back', async ({
    canvasSession,
  }, testInfo) => {
    const a = await canvasSession('alice')
    await twoNotesSelected(a.page)
    await expect(panel(a.page)).toBeVisible()
    await expect(bar(a.page)).toHaveAttribute('data-compact', 'true')
    await bar(a.page).getByTestId('selection-more').click()
    await expect(bar(a.page).getByTestId('selection-more-row')).toBeVisible()
    // More's row is wider than the room left of the panel: the panel is gone for as long as it is open
    await expect(panel(a.page)).toHaveCount(0)
    await barSettled(a.page)
    await a.page.screenshot({ path: testInfo.outputPath('n1w-step-aside.png') })
    // the open row is whole on the canvas (nothing of it is off the right edge or under the toolbar)
    const [b, c, t] = await Promise.all([
      bar(a.page).boundingBox(),
      a.page.locator('[data-lobby-board-canvas]').boundingBox(),
      a.page.locator('[data-lobby-slot="toolbar"] .cux-toolbar-wrap').boundingBox(),
    ])
    if (!b || !c || !t) throw new Error('no bar, canvas or toolbar')
    expect(b.x).toBeGreaterThanOrEqual(c.x - 1)
    expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width + 1)
    expect(b.y + b.height <= t.y || b.y >= t.y + t.height).toBe(true)
    // closing More brings the panel back
    await bar(a.page).getByTestId('selection-more').click()
    await expect(bar(a.page).getByTestId('selection-more-row')).toHaveCount(0)
    await expect(panel(a.page)).toBeVisible()
  })
})
