// Wave P release audit (the canvas chrome): the floating selection toolbar's buttons are pictures with tooltips, never
// bare glyphs (P-020); the style panel opens only on request, remembers the choice and never covers the selection
// (P-021).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/p-canvas-chrome.spec.ts   (from e2e/)
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  expect,
  expectSaved,
  select,
  selectNone,
  setViewport,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { focusBoard, settled } from './board-kit.ts'
import { waitForCanvasUx } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const bar = (page: Page) => page.getByTestId('selection-bar')
const panel = (page: Page) => page.getByTestId('style.panel')

/** Each button in the selection bar: its tooltip, its name, whether it shows a picture, its visible words. */
const barButtons = (page: Page) =>
  bar(page)
    .locator('button')
    .evaluateAll((els) =>
      els
        .filter((b) => (b as HTMLElement).offsetParent !== null)
        .map((b) => ({
          id: b.getAttribute('data-testid') ?? '',
          title: b.getAttribute('title') ?? '',
          label: b.getAttribute('aria-label') ?? '',
          picture: !!b.querySelector('svg, .cux-selstyle__dot, .cux-selstyle__note, img'),
          text: ((b as HTMLElement).innerText ?? '').trim(),
        })),
    )

/** An element's box on screen (client px), through the board's debug handle. */
const screenBox = (page: Page, id: string) =>
  page.evaluate((elId) => {
    const b = (window as unknown as { __lobbyBoard?: { canvas: unknown } }).__lobbyBoard
    const c = b?.canvas as {
      boundsOf(ids: string[]): { x: number; y: number; width: number; height: number } | null
      sceneToScreen(p: { x: number; y: number }): { x: number; y: number }
    }
    const bb = c.boundsOf([elId])
    if (!bb) return null
    const t = c.sceneToScreen({ x: bb.x, y: bb.y })
    const z = c.sceneToScreen({ x: bb.x + bb.width, y: bb.y + bb.height })
    return { x: t.x, y: t.y, width: z.x - t.x, height: z.y - t.y }
  }, id)

/** Whether two boxes overlap. */
const covers = (
  p: { x: number; y: number; width: number; height: number } | null,
  n: { x: number; y: number; width: number; height: number } | null,
) => {
  if (!p || !n) return 'unmeasured'
  const w = Math.min(p.x + p.width, n.x + n.width) - Math.max(p.x, n.x)
  const h = Math.min(p.y + p.height, n.y + n.height) - Math.max(p.y, n.y)
  return w > 0 && h > 0 ? 'covers' : 'clear'
}

test('P-020: every button of the selection toolbar is a picture with a tooltip (a note, a shape, a text): no bare "L", "–" or "100"', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await setViewport(a.page, { x: -100, y: -100, zoom: 1 })
  const note = await createNote(a.page, { x: 0, y: 0, text: 'Size me' })
  const shape = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 300, y: 0, width: 160, height: 100, backgroundColor: '#dce1f8' }),
  )
  const text = await settled(a.page, createItem(a.page, 'text', { x: 0, y: 300, text: 'Words' }))
  await expectSaved(a.page)
  for (const [what, id] of [
    ['note', note],
    ['shape', shape],
    ['text', text],
  ] as const) {
    await select(a.page, [id])
    await expect(bar(a.page)).toBeVisible()
    await expect(bar(a.page).getByTestId('selection-style-more')).toBeVisible()
    const buttons = await barButtons(a.page)
    expect(buttons.length, what).toBeGreaterThan(4)
    for (const b of buttons) {
      expect(b.title, `${what} ${b.id}: a tooltip`).not.toBe('')
      expect(b.label || b.title, `${what} ${b.id}: a name`).not.toBe('')
      expect(b.picture, `${what} ${b.id}: a picture`).toBe(true)
      expect(b.text, `${what} ${b.id}: no bare glyph`).not.toMatch(/^(–|-|S|M|L|XL|\d+%?)$/)
    }
  }
})

test('P-021: the style panel opens only from the Styles button, remembers it, never covers the selection, and its × hides it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const left = await createNote(a.page, { x: 200, y: 200, text: 'Left' })
  await expectSaved(a.page)

  await test.step('a selection shows the quick styles, not the panel', async () => {
    await select(a.page, [left])
    await expect(bar(a.page)).toBeVisible()
    await a.page.waitForTimeout(400)
    await expect(panel(a.page)).toHaveCount(0)
  })

  await test.step('Styles opens it (pressed), and it is still open after a reload', async () => {
    const more = bar(a.page).getByTestId('selection-style-more')
    await expect(more).toHaveAttribute('aria-pressed', 'false')
    await more.click()
    await expect(panel(a.page)).toBeVisible()
    await expect(more).toHaveAttribute('aria-pressed', 'true')
    await expect(more).toHaveAttribute('title', 'Hide styles')
    await a.page.reload()
    await waitForCanvas(a.page)
    await waitForCanvasUx(a.page)
    await select(a.page, [left])
    await expect(panel(a.page)).toBeVisible()
  })

  await test.step('a note at the right edge, under the panel: the panel moves to the left, clear of it', async () => {
    const vp = await a.page.evaluate(() => {
      type Handle = { __lobbyBoard?: { canvas: { viewport: { get(): unknown } } } }
      const c = (window as unknown as Handle).__lobbyBoard
      return c?.canvas.viewport.get() as { x: number; y: number; width: number; zoom: number }
    })
    // the note's right edge 30 px inside the canvas's right edge, near the top: where the panel sits
    const right = await createNote(a.page, { x: vp.x + vp.width - 230, y: vp.y + 40, text: 'Right' })
    await expectSaved(a.page)
    await select(a.page, [right])
    await expect(a.page.getByTestId('style.panel-place')).toHaveAttribute('data-side', 'left')
    await expect
      .poll(async () => covers(await panel(a.page).boundingBox(), await screenBox(a.page, right)))
      .toBe('clear')
    // back on the note at the left, the panel is at the right again
    await select(a.page, [left])
    await expect(a.page.getByTestId('style.panel-place')).toHaveAttribute('data-side', 'right')
  })

  await test.step('× hides it; the next selection does not bring it back', async () => {
    await a.page.getByTestId('style.panel-close').click()
    await expect(panel(a.page)).toHaveCount(0)
    await selectNone(a.page)
    await select(a.page, [left])
    await expect(bar(a.page)).toBeVisible()
    await a.page.waitForTimeout(400)
    await expect(panel(a.page)).toHaveCount(0)
    await expect(bar(a.page).getByTestId('selection-style-more')).toHaveAttribute('aria-pressed', 'false')
  })
})

test('P-028: the account badge stays on top of the bar while a top-bar popover is open (the bell)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const badge = a.page.getByTestId('dev-identity-badge')
  await expect(badge).toBeVisible()
  /** Whether what is drawn at the badge's centre is the badge (nothing covers it). */
  const onTop = () =>
    badge.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!top && (el === top || el.contains(top))
    })
  expect(await onTop()).toBe(true)
  const bell = a.page.getByTestId('notifications-bell')
  await bell.click()
  await expect(bell).toHaveAttribute('aria-expanded', 'true')
  expect(await onTop()).toBe(true)
  await a.page.keyboard.press('Escape')
})

test('P-034: the keyboard on the board shows corner marks, not a blue ring around the whole canvas', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await focusBoard(a.page)
  // a tool's letter on the board makes the keyboard the last input (the indicator shows)
  await a.page.keyboard.press('r')
  await a.page.keyboard.press('v')
  const ring = a.page.getByTestId('canvas-focus-ring')
  await expect(ring).toBeVisible()
  const look = await ring.evaluate((el) => {
    const cs = getComputedStyle(el)
    return {
      shadow: cs.boxShadow,
      outline: cs.outlineStyle,
      border: cs.borderTopStyle,
      marks: (cs.backgroundImage.match(/linear-gradient/g) ?? []).length,
    }
  })
  expect(look).toEqual({ shadow: 'none', outline: 'none', border: 'none', marks: 8 })
})
