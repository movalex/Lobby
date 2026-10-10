// Wave M (M1-3; the first-time scout's FTU-2 and FTU-11, wave L follow-up "the bar covers the below handle"): the
// selection bar is placed clear of the board's chrome (lib/overlay-obstacles.ts placePopover: the style panel, the
// bottom toolbar, the top-centre stack, the navigation panel) and past the selection's flow '+' handles. Checked the
// way a click lands, with document.elementFromPoint:
//  - at 1440 x 900 and at 390 x 844 (touch): one shape near the bottom, selected: the point at each '+' handle's
//    centre is that handle, and the point at each of the bar's own buttons is that button;
//  - at 1440 x 900: notes on the right half with the style panel open: no bar button is under the panel.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m1-placement.spec.ts --project=chromium --workers=1
import type { Browser, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  type CanvasSession,
  createItem,
  createNote,
  expect,
  expectSaved,
  select,
  setTool,
  setViewport,
  test,
} from '../tests/support/canvas.ts'
import type { Users } from '../tests/support/users.ts'
import { PHONE, waitForA11y } from './a11y-kit.ts'

async function openSession(
  browser: Browser,
  board: string,
  users: Users,
  viewport: { width: number; height: number },
  touch: boolean,
): Promise<CanvasSession & { errors: string[] }> {
  const who = await users.get('alice')
  const context = await browser.newContext({
    viewport,
    ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`.slice(0, 300)))
  await signInContext(context, who.handle, who.name)
  await page.goto(`/b/${board}`)
  await waitForA11y(page)
  return { user: who.handle, name: who.name, id: who.id, context, page, errors }
}

/** The bar has stopped moving (its box is the same a moment later). */
async function barSettled(page: Page) {
  await expect(page.getByTestId('selection-bar')).toBeVisible()
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

/**
 * What a click at the centre of each of `selector`'s elements lands on: the ones whose centre is covered by
 * something else (described), or [] when every one is hit.
 */
const missed = (page: Page, selector: string, owner: string) =>
  page.evaluate(
    ({ selector, owner }) => {
      const out: string[] = []
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        const hit = at?.closest(owner)
        if (hit !== el) {
          const what = at
            ? `${at.tagName.toLowerCase()}${at.getAttribute('data-testid') ? `[${at.getAttribute('data-testid')}]` : ''}${at.closest('[data-lobby-slot]')?.getAttribute('data-lobby-slot') ?? ''}`
            : 'nothing'
          out.push(`${el.getAttribute('data-testid') ?? el.getAttribute('aria-label')} under ${what}`)
        }
      }
      return out
    },
    { selector, owner },
  )

/** The bar's own buttons (not a popover's). */
const BAR_BUTTONS = '[data-testid="selection-bar"] button'

for (const vp of [
  { name: '1440 x 900', size: { width: 1440, height: 900 }, touch: false },
  { name: '390 x 844 (touch)', size: PHONE, touch: true },
]) {
  test(`M1-3 at ${vp.name}: a shape near the bottom, selected: every '+' handle and every bar button takes its click`, async ({
    browser,
    board,
    users,
  }, testInfo) => {
    const a = await openSession(browser, board, users, vp.size, vp.touch)
    try {
      const page = a.page
      const id = await createItem(page, 'rectangle', {
        x: 0,
        y: 0,
        width: 160,
        height: 100,
        backgroundColor: '#dce1f8',
        fillStyle: 'solid',
      })
      await expectSaved(page)
      const canvas = await page.locator('[data-lobby-board-canvas]').boundingBox()
      if (!canvas) throw new Error('no canvas')
      // the shape centred sideways, its bottom 150 px above the canvas's bottom (over the bottom toolbar's row)
      await setViewport(page, { x: -(canvas.width / 2 - 80), y: -(canvas.height - 250), zoom: 1 })
      // the '+' handles are the Select tool's (a phone starts on the Hand tool, K5-3)
      await setTool(page, 'select')
      await page.mouse.move(canvas.x + 5, canvas.y + canvas.height / 3)
      await select(page, [id])
      await barSettled(page)
      await expect(page.locator('[data-testid^="flow-handle-"]')).toHaveCount(4)
      await page.screenshot({ path: testInfo.outputPath('m1-3-near-bottom.png') })
      expect(await missed(page, '[data-testid^="flow-handle-"]', '[data-testid^="flow-handle-"]')).toEqual([])
      expect(await missed(page, BAR_BUTTONS, 'button')).toEqual([])
      // and the bar is clear of the bottom toolbar
      const [bar, toolbar] = await Promise.all([
        page.getByTestId('selection-bar').boundingBox(),
        page.locator('[data-lobby-slot="toolbar"] .cux-toolbar-wrap').boundingBox(),
      ])
      if (!bar || !toolbar) throw new Error('no bar or toolbar')
      expect(bar.y + bar.height <= toolbar.y || bar.y >= toolbar.y + toolbar.height).toBe(true)
      expect(a.errors).toEqual([])
    } finally {
      await a.context.close()
    }
  })
}

test('M1-3 at 1440 x 900: notes on the right half with the style panel open: no bar button is under the panel', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const a = await openSession(browser, board, users, { width: 1440, height: 900 }, false)
  try {
    const page = a.page
    const notes = [
      await createNote(page, { x: 0, y: 0, text: 'Right' }),
      await createNote(page, { x: 240, y: 0, text: 'Half' }),
    ]
    await expectSaved(page)
    const canvas = await page.locator('[data-lobby-board-canvas]').boundingBox()
    if (!canvas) throw new Error('no canvas')
    // the notes at the canvas's top right, under where the style panel opens
    await setViewport(page, { x: -(canvas.width - 520), y: -90, zoom: 1 })
    await select(page, notes)
    const panel = page.getByTestId('style.panel')
    await expect(panel).toBeVisible()
    await barSettled(page)
    await page.screenshot({ path: testInfo.outputPath('m1-3-style-panel.png') })
    expect(await missed(page, BAR_BUTTONS, 'button')).toEqual([])
    const [bar, box] = await Promise.all([
      page.getByTestId('selection-bar').boundingBox(),
      panel.boundingBox(),
    ])
    if (!bar || !box) throw new Error('no bar or panel')
    const overlap =
      bar.x < box.x + box.width &&
      box.x < bar.x + bar.width &&
      bar.y < box.y + box.height &&
      box.y < bar.y + bar.height
    expect(overlap).toBe(false)
    expect(a.errors).toEqual([])
  } finally {
    await a.context.close()
  }
})
