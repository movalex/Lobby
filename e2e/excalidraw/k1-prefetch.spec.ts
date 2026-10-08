// K1-3 (wave K): the dashboard downloads the board page's chunk ahead of a click. Once the dashboard is idle
// it is fetched before any click (not on Save-Data, not even on hover there), a pointer over a board link
// fetches it at once, and opening a board from the dashboard then does not fetch it again. Every request
// of the dashboard and the board stays on Lobby's own origin (the e2e network assertion).
import type { Page, Request } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/fixtures.ts'
import { WEB_URL } from '../tests/support/ports.ts'

const BOARD_CHUNK = /\/assets\/LobbyBoardPage-[\w-]+\.js$/

/** Every request of the page that left Lobby's origin (none may: plan §2.12, the e2e network assertion). */
function foreignRequests(page: Page) {
  const origin = new URL(WEB_URL).origin
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (url.origin !== origin) foreign.push(r.url())
  })
  return foreign
}

test('the dashboard downloads the board code while idle, before any click; the board then opens without it again', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    const foreign = foreignRequests(page)
    const chunkRequests: number[] = []
    let clicked = false
    page.on('request', (r) => {
      if (BOARD_CHUNK.test(new URL(r.url()).pathname)) chunkRequests.push(clicked ? 1 : 0)
    })
    await page.goto(`/w/${users.devStudioId}`)
    await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 30_000 })
    // no click, no hover: the idle prefetch alone
    await expect.poll(() => chunkRequests.length, { timeout: 15_000 }).toBe(1)
    expect(chunkRequests).toEqual([0])
    const card = page.locator(`[data-testid="board-card"][data-board-id="${board}"]`)
    await expect(card).toBeVisible()
    clicked = true
    await card.locator('a.dr-bcard__link').click()
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    // the module was there: not asked for again
    expect(chunkRequests).toEqual([0])
    expect(foreign).toEqual([])
  } finally {
    await context.close()
  }
})

test('on Save-Data the dashboard downloads nothing ahead, not even on hover; a click still opens the board', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const context = await browser.newContext()
  try {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'connection', {
        configurable: true,
        get: () => ({ saveData: true, effectiveType: '4g', addEventListener() {}, removeEventListener() {} }),
      })
    })
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    const chunkRequests: string[] = []
    page.on('request', (r) => {
      if (BOARD_CHUNK.test(new URL(r.url()).pathname)) chunkRequests.push(r.url())
    })
    await page.goto(`/w/${users.devStudioId}`)
    await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 30_000 })
    const card = page.locator(`[data-testid="board-card"][data-board-id="${board}"]`)
    await expect(card).toBeVisible()
    await card.hover()
    await page.waitForTimeout(6_000)
    expect(chunkRequests).toEqual([])
    await card.locator('a.dr-bcard__link').click()
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    expect(chunkRequests.length).toBe(1)
  } finally {
    await context.close()
  }
})

test('a pointer over a board link downloads the board code at once (before the idle time)', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const context = await browser.newContext()
  try {
    // no idle time on this page: requestIdleCallback never calls back
    await context.addInitScript(() => {
      ;(window as unknown as { requestIdleCallback: () => number }).requestIdleCallback = () => 0
    })
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    const chunkRequests: string[] = []
    page.on('request', (r) => {
      if (BOARD_CHUNK.test(new URL(r.url()).pathname)) chunkRequests.push(r.url())
    })
    await page.goto(`/w/${users.devStudioId}`)
    const card = page.locator(`[data-testid="board-card"][data-board-id="${board}"]`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1_500)
    expect(chunkRequests).toEqual([])
    await card.hover()
    await expect.poll(() => chunkRequests.length, { timeout: 5_000 }).toBe(1)
  } finally {
    await context.close()
  }
})
