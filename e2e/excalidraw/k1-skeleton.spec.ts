// K1-5 (wave K): a board opening shows its skeleton at once (the top bar with the board's title, the dock's
// column, a greyed toolbar and a shimmer) instead of a lone spinner on a blank page, never says "Saved" or
// "Live" before it is, and is replaced by the real top bar once sync is live, with nothing moving: the
// toolbar keeps its place (centre, bottom edge, height) and so does the title.
//
// The first ticket is held back (route interception) so the skeleton stays long enough to be measured; the
// moment the skeleton first appears is read with the page's own clock (a MutationObserver installed before
// the page's scripts run).
import type { Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/fixtures.ts'

/** Records, on the page's clock (ms since its navigation), when each test id first appears. */
async function watchFirstSeen(page: Page, ids: readonly string[]) {
  await page.addInitScript((list: readonly string[]) => {
    const seen: Record<string, number> = {}
    ;(window as unknown as { __k1Seen: Record<string, number> }).__k1Seen = seen
    const check = () => {
      for (const id of list)
        if (seen[id] === undefined && document.querySelector(`[data-testid="${id}"]`))
          seen[id] = performance.now()
    }
    new MutationObserver(check).observe(document, { subtree: true, childList: true })
  }, ids)
}
const firstSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __k1Seen: Record<string, number> }).__k1Seen)

/** Holds the first `POST /api/boards/:id/ticket` until `release()`; later ones go through. */
async function holdFirstTicket(page: Page, boardId: string) {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  let held = 0
  await page.route(`**/api/boards/${boardId}/ticket`, async (route) => {
    if (held++ === 0) await gate
    await route.continue()
  })
  return () => release()
}

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}

test('the skeleton within 300 ms, the title while the ticket waits, never Saved or Live; the real top bar once live, the toolbar where it was', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const alice = await users.get('alice')
  const title = (await (await users.api('alice')).getBoard(board)).board.title
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  try {
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    await watchFirstSeen(page, ['board-skeleton', 'topbar'])
    const release = await holdFirstTicket(page, board)
    await page.goto(`/b/${board}`, { waitUntil: 'commit' })
    const skeleton = page.getByTestId('board-skeleton')
    await expect(skeleton).toBeVisible()
    const seen = await firstSeen(page)
    await testInfo.attach('k1-skeleton-first-seen.json', {
      body: JSON.stringify(seen),
      contentType: 'application/json',
    })
    console.log('[k1 skeleton first seen, ms since navigation]', JSON.stringify(seen))
    expect(seen['board-skeleton'], 'the skeleton within 300 ms of the navigation').toBeLessThan(300)

    // the board answered (the ticket is still held): its title and workspace in the skeleton's top bar
    await expect(page.getByTestId('board-skeleton-title')).toHaveText(title)
    await expect(page.getByTestId('board-skeleton-topbar')).toContainText('Dev Studio')
    await expect(skeleton).not.toContainText(/Saved|Live|Saving|Offline/)
    await expect(page.getByTestId('save-status')).toHaveCount(0)
    await expect(page.getByTestId('conn-status')).toHaveCount(0)
    await expect(page.getByTestId('topbar')).toHaveCount(0)
    const skelBar = await box(page, '[data-testid="board-skeleton-topbar"]')
    const skelTitle = await box(page, '[data-testid="board-skeleton-title"]')
    const skelToolbar = await box(page, '[data-testid="board-skeleton-toolbar"]')
    const skelCanvas = await box(page, '[data-testid="board-skeleton"] .dr-board__canvas')

    release()
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
    await expect(page.getByTestId('topbar')).toBeVisible()
    await expect(skeleton).toHaveCount(0)
    await expect(page.getByTestId('board-title')).toHaveText(title)
    const toolbar = page.getByTestId('main-toolbar')
    await expect(toolbar).toBeVisible()
    const realBar = await box(page, '[data-testid="topbar"]')
    const realTitle = await box(page, '[data-testid="board-title"]')
    const realToolbar = await box(page, '[data-testid="main-toolbar"]')
    const realCanvas = await box(page, '.dr-board__canvas')
    const centre = (b: { x: number; width: number }) => b.x + b.width / 2
    const geometry = {
      skelBar,
      skelTitle,
      skelToolbar,
      skelCanvas,
      realBar,
      realTitle,
      realToolbar,
      realCanvas,
    }
    await testInfo.attach('k1-skeleton-geometry.json', {
      body: JSON.stringify(geometry, null, 2),
      contentType: 'application/json',
    })
    // no layout shift: the bar's height, the title's place, the canvas, the toolbar's centre, bottom and height
    expect(Math.abs(realBar.height - skelBar.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(realTitle.x - skelTitle.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(realTitle.y - skelTitle.y)).toBeLessThanOrEqual(2)
    expect(Math.abs(realCanvas.x - skelCanvas.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(realCanvas.width - skelCanvas.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(centre(realToolbar) - centre(skelToolbar))).toBeLessThanOrEqual(2)
    expect(
      Math.abs(realToolbar.y + realToolbar.height - (skelToolbar.y + skelToolbar.height)),
    ).toBeLessThanOrEqual(2)
    expect(Math.abs(realToolbar.height - skelToolbar.height)).toBeLessThanOrEqual(2)
  } finally {
    await context.close()
  }
})

test('from the dashboard: the skeleton names the board from its card at once, before the board answers', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const title = (await (await users.api('alice')).getBoard(board)).board.title
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  try {
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    await page.goto(`/w/${users.devStudioId}`)
    const card = page.locator(`[data-testid="board-card"][data-board-id="${board}"]`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    // the board's own answer is held: whatever the skeleton names, it took from the card
    let releaseBoard: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releaseBoard = r
    })
    await page.route(`**/api/boards/${board}`, async (route) => {
      if (route.request().method() === 'GET') await gate
      await route.continue()
    })
    const clickedAt = await page.evaluate(() => performance.now())
    await card.locator('a.dr-bcard__link').click()
    await expect(page.getByTestId('board-skeleton')).toBeVisible()
    await expect(page.getByTestId('board-skeleton-title')).toHaveText(title)
    await expect(page.getByTestId('board-skeleton-topbar')).toContainText('Dev Studio')
    const shownAt = await page.evaluate(() => performance.now())
    expect(shownAt - clickedAt).toBeLessThan(1_000)
    releaseBoard()
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    await expect(page.getByTestId('board-skeleton')).toHaveCount(0)
  } finally {
    await context.close()
  }
})
