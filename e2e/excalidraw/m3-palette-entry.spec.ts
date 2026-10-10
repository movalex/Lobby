// Wave M (W3, M3-1, FTU-4.2): "Search or do… Ctrl+K", the command palette's on-screen entry, in a real browser.
//  - on a desktop board the top bar has the button, with an accessible name and aria-keyshortcuts; a click opens the
//    palette on its Try section with no line chosen, and a reflex Enter runs nothing (nothing pushed, the palette stays);
//  - a bar that is only a little crowded keeps the magnifier alone (the `palette` compact step);
//  - on a tablet and a phone the button is in the "⋯" menu, and a phone's "All tools" sheet has the same entry at 390 x 844;
//  - the button passes axe, in light and dark; no request leaves Lobby's own origins (the e2e network assertion).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m3-palette-entry.spec.ts --project=chromium --workers=1
import AxeBuilder from '@axe-core/playwright'
import type { Browser, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  type CanvasSession,
  createNote,
  expect,
  expectSaved,
  items,
  pushedOps,
  test,
} from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import type { Users } from '../tests/support/users.ts'
import { PHONE, waitForA11y } from './a11y-kit.ts'

const palette = (page: Page) => page.getByTestId('command-palette')
const input = (page: Page) => page.getByTestId('command-palette-input')
const activeOption = (page: Page) =>
  page.locator('[data-testid="command-palette-option"][data-active="true"]')
const button = (page: Page) => page.getByTestId('topbar-palette')

/** Every request of the page that left Lobby's own origins (none may). */
function foreignRequests(page: Page) {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

/** After a reflex Enter: the palette is still open, nothing is chosen, nothing ran, nothing was pushed. */
async function expectReflexEnterRunsNothing(page: Page, before: { pushes: number; items: number }) {
  await expect(activeOption(page)).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(palette(page)).toBeVisible()
  await expect(page.getByTestId('command-palette-status')).toHaveText('')
  await page.waitForTimeout(400)
  expect((await pushedOps(page)).length).toBe(before.pushes)
  expect((await items(page)).length).toBe(before.items)
}

test.describe('on a desktop board', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the top bar has "Search or do… Ctrl+K"; a click opens the palette on Try, nothing chosen; a reflex Enter runs nothing; Escape closes it', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    const foreign = foreignRequests(a.page)
    await createNote(a.page, { x: 0, y: 0, text: 'First' })
    await expectSaved(a.page)

    const b = button(a.page)
    await expect(b).toBeVisible()
    // a name that is its words, and the key it answers to (aria-keyshortcuts) and the same hint on screen
    await expect(b).toHaveAttribute('aria-label', 'Search or do…')
    await expect(b).toHaveAttribute('aria-keyshortcuts', /^(Control|Meta)\+K$/)
    await expect(b).toContainText('Search or do…')
    await expect(b).toContainText(/Ctrl\+K|⌘K/)
    await expect(a.page.getByRole('button', { name: 'Search or do…' })).toBeVisible()
    // it sits in the bar with the other feature controls, before Share
    const order = await a.page.getByTestId('topbar').evaluate((bar) => {
      const at = (id: string) => {
        const el = bar.querySelector(`[data-testid="${id}"]`)
        return el ? [...bar.querySelectorAll('*')].indexOf(el) : -1
      }
      return { palette: at('topbar-palette'), share: at('share-button'), feedback: at('topbar-feedback') }
    })
    expect(order.palette).toBeGreaterThan(order.feedback)
    expect(order.palette).toBeLessThan(order.share)

    const before = { pushes: (await pushedOps(a.page)).length, items: (await items(a.page)).length }
    await b.click()
    await expect(palette(a.page)).toBeVisible()
    await expect(input(a.page)).toBeFocused()
    // an empty palette starts with Try (M3-2), the first group, and no line is chosen
    await expect(a.page.getByTestId('command-palette-group').first()).toHaveAttribute('data-group-id', 'try')
    await expect(
      a.page.locator('[data-testid="command-palette-option"][data-entry-id="cmd:ai.recap"]'),
    ).toContainText('Wrap up this board')
    await expectReflexEnterRunsNothing(a.page, before)

    await a.page.keyboard.press('Escape')
    await expect(palette(a.page)).toHaveCount(0)
    expect(foreign).toEqual([])
  })

  test('the button is a tab stop with a name: axe finds nothing on it, in light and dark', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await expect(button(a.page)).toBeVisible()
    for (const scheme of ['light', 'dark'] as const) {
      await a.page.emulateMedia({ colorScheme: scheme })
      await a.page.waitForTimeout(150)
      const results = await new AxeBuilder({ page: a.page })
        .include('[data-testid="topbar"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze()
      const mine = results.violations.flatMap((v) =>
        v.nodes
          .filter((n) => n.html.includes('topbar-palette'))
          .map((n) => `${v.id}: ${n.html.slice(0, 160)}`),
      )
      expect(mine, scheme).toEqual([])
    }
    // keyboard: Tab reaches it, Enter opens the palette
    await button(a.page).focus()
    await expect(button(a.page)).toBeFocused()
    await a.page.keyboard.press('Enter')
    await expect(palette(a.page)).toBeVisible()
    await expect(input(a.page)).toBeFocused()
  })

  test('a long title at a middle width keeps the magnifier alone before anything else gives; the name stays', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await a.page.setViewportSize({ width: 1100, height: 800 })
    await expect(button(a.page)).toBeVisible()
    const compact = async () =>
      (await a.page.getByTestId('topbar').getAttribute('data-compact'))?.split(' ').filter(Boolean) ?? []
    // rename the board to something long: the bar must make room for the title, and takes the palette's words first
    await a.page.getByTestId('board-title').click()
    await a.page
      .getByTestId('board-title-input')
      .fill('Q4 launch planning: the long board title that wants all the room it can get')
    await a.page.keyboard.press('Enter')
    await expect.poll(compact).toContain('palette')
    const b = button(a.page)
    await expect(b).toBeVisible()
    await expect(b).toHaveAttribute('aria-label', 'Search or do…')
    await expect(b.locator('.dr-topbar__palette-label')).toBeHidden()
    await expect(b.locator('.dr-topbar__palette-kbd')).toBeHidden()
    const box = await b.boundingBox()
    expect(box?.width).toBeLessThan(44)
    // it still opens the palette
    await b.click()
    await expect(palette(a.page)).toBeVisible()
  })
})

for (const [label, size] of [
  ['a tablet (768 px)', { width: 768, height: 1024 }],
  ['a phone (390 px)', PHONE],
] as const) {
  test(`on ${label} the button is in the "⋯" menu, not the bar, and opens the palette from there`, async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await a.page.setViewportSize(size)
    await waitForA11y(a.page)
    await expect(a.page.getByTestId('topbar').getByTestId('share-button')).toBeVisible()
    await expect(button(a.page)).toBeHidden()
    await a.page.getByTestId('topbar-overflow').click()
    const panel = a.page.getByTestId('topbar-overflow-panel')
    await expect(panel).toHaveAttribute('data-open', 'true')
    await expect(panel.getByTestId('topbar-palette')).toBeVisible()
    await expect(panel).toContainText('Search')
    await panel.getByTestId('topbar-palette').click()
    await expect(palette(a.page)).toBeVisible()
    await expect(activeOption(a.page)).toHaveCount(0)
  })
}

test.describe('on a phone at 390 x 844 (touch)', () => {
  async function phone(browser: Browser, board: string, users: Users): Promise<CanvasSession> {
    const who = await users.get('alice')
    const context = await browser.newContext({
      viewport: PHONE,
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    await signInContext(context, who.handle, who.name)
    await page.goto(`/b/${board}`)
    await waitForA11y(page)
    return { user: who.handle, name: who.name, id: who.id, context, page }
  }

  test('the "All tools" sheet has "Search or do…": it opens the palette on Try, nothing chosen, and a reflex Enter runs nothing', async ({
    browser,
    board,
    users,
  }) => {
    const a = await phone(browser, board, users)
    try {
      await createNote(a.page, { x: 0, y: 0, text: 'First' })
      await expectSaved(a.page)
      const before = { pushes: (await pushedOps(a.page)).length, items: (await items(a.page)).length }
      await a.page.getByTestId('phone-sheet-open').tap()
      const sheet = a.page.getByTestId('phone-sheet')
      await expect(sheet).toBeVisible()
      const row = sheet.getByTestId('phone-sheet-palette')
      await expect(row).toBeVisible()
      await expect(row).toHaveText('Search or do…')
      // a touch target, as every sheet row
      const box = await row.boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
      await row.tap()
      // the sheet shuts, the palette opens over the board
      await expect(sheet).toHaveCount(0)
      await expect(palette(a.page)).toBeVisible()
      await expect(input(a.page)).toBeFocused()
      await expect(a.page.getByTestId('command-palette-group').first()).toHaveAttribute(
        'data-group-id',
        'try',
      )
      await expectReflexEnterRunsNothing(a.page, before)
      // it fits the phone: no sideways scroll inside the dialog
      const fits = await palette(a.page).evaluate((d) => d.scrollWidth <= d.clientWidth + 1)
      expect(fits).toBe(true)
    } finally {
      await a.context.close()
    }
  })
})
