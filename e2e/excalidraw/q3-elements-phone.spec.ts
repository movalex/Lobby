// Wave Q, WS3: the Elements panel on a phone (390 px, touch) and for a name-only guest, on the real board page, with
// the panel turned on by the dev-auth override. What must hold: on a phone the panel is the host's full-width sheet
// with touch-size tiles and the options folded behind one button, a tap inserts at the middle of the view and the
// sheet closes so the new element shows, and nothing scrolls sideways; a name-only guest (a workshop link) gets Icons
// and Shapes and no Library tab, inserts an icon, and the page asks the library api nothing.
//
//   E2E_PORT_BASE=7760 pnpm exec playwright test excalidraw/q3-elements-phone --project=chromium --workers=1   (from e2e/)
import type { BrowserContext, Request } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  type CanvasElement,
  expect,
  expectSaved,
  items,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { PHONE, scrollsSideways } from './a11y-kit.ts'
import { createGuestLink, guestOn, tokenOf } from './guests-kit.ts'
import { elementsPanelOn, openElements, tab, tile } from './q3-kit.ts'

const kindOf = (e: CanvasElement) => (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind

/** The library requests a context's pages make (a guest's make none). */
function libraryRequests(context: BrowserContext): string[] {
  const seen: string[] = []
  context.on('request', (r: Request) => {
    if (/\/library(\/|\?|$)/.test(new URL(r.url()).pathname)) seen.push(`${r.method()} ${r.url()}`)
  })
  return seen
}

test('Q3 phone: the panel is a full-width sheet with the options folded; a tap inserts and the sheet closes', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const alice = await users.get('alice')
  const context = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  })
  try {
    await signInContext(context, alice.handle, alice.name)
    await elementsPanelOn(context)
    const page = await context.newPage()
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)

    await test.step('the rail folds behind one button; Elements opens as a full-width sheet', async () => {
      await page.getByTestId('dock-rail-toggle').tap()
      await page.getByTestId('dock-tab-elements').tap()
      const sheet = page.getByTestId('dock-panel-elements')
      await expect(sheet).toBeVisible()
      const b = await sheet.boundingBox()
      expect(Math.round(b?.x ?? -1)).toBe(0)
      expect(Math.round(b?.width ?? 0)).toBe(PHONE.width)
      expect(await scrollsSideways(page)).toBe(false)
    })

    await test.step('the options fold behind one button; the tiles are touch-size', async () => {
      await expect(page.getByTestId('element-options')).toBeHidden()
      await page.getByTestId('element-options-toggle').tap()
      await expect(page.getByTestId('element-options')).toBeVisible()
      await page.getByTestId('element-options-toggle').tap()
      await tab(page, 'shapes').tap()
      const t = await tile(page, 'piece', 'decision').boundingBox()
      expect(t?.width ?? 0).toBeGreaterThanOrEqual(44)
      expect(t?.height ?? 0).toBeGreaterThanOrEqual(44)
      await page.screenshot({ path: testInfo.outputPath('q3-phone-sheet.png') })
    })

    await test.step('a tap inserts the shape and closes the sheet so it shows', async () => {
      await tile(page, 'piece', 'decision').tap()
      const decisions = async () => (await items(page)).filter((e) => kindOf(e) === 'piece-decision')
      await expect.poll(async () => (await decisions()).length).toBe(2)
      await expect(page.getByTestId('dock-panel-elements')).toHaveCount(0)
      await expectSaved(page)
      expect(await scrollsSideways(page)).toBe(false)
      await page.screenshot({ path: testInfo.outputPath('q3-phone-inserted.png') })
    })
  } finally {
    await context.close()
  }
})

test('Q3 guest: a name-only guest has Icons and Shapes, no Library tab, inserts an icon, and asks the library nothing', async ({
  browser,
  board,
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  const link = await createGuestLink(a.page, board, 'workshop')
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  try {
    await elementsPanelOn(context)
    const library = libraryRequests(context)
    const g = (await guestOn(context, tokenOf(link), 'Gail')).page
    await expect(g.getByTestId('dock-tab-elements')).toBeVisible({ timeout: 30_000 })
    await openElements(g)
    await expect(tab(g, 'icons')).toBeVisible()
    await expect(tab(g, 'shapes')).toBeVisible()
    await expect(tab(g, 'library')).toHaveCount(0)
    await expect(g.getByTestId('element-search')).toHaveAttribute('placeholder', 'Search icons and shapes')
    // no star: favourites are the library's
    await g.getByTestId('element-search').fill('heart')
    await expect(tile(g, 'icon', 'lucide:heart')).toBeVisible({ timeout: 15_000 })
    await expect(tile(g, 'icon', 'lucide:heart').getByTestId('element-star')).toHaveCount(0)
    await g.screenshot({ path: testInfo.outputPath('q3-guest-panel.png') })
    await tile(g, 'icon', 'lucide:heart').click()
    const iconCount = async (p: typeof g) => (await items(p)).filter((e) => kindOf(e) === 'icon').length
    await expect.poll(() => iconCount(g)).toBeGreaterThan(0)
    await expectSaved(g)
    const n = await iconCount(g)
    await expect.poll(() => iconCount(a.page)).toBe(n)
    expect(library).toEqual([])
  } finally {
    await context.close()
  }
})
