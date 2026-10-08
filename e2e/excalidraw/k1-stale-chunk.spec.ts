// K1-7 (wave K): a tab that loaded before a deploy asks for a lazy chunk that is gone (Render serves only
// the new build's files). The chunk is answered 404 here, as Render would:
//
//  - on a board (the export code, loaded on the first export): the board stays, a notice offers a Reload,
//    nothing reloads by itself, and no error is left uncaught; the Reload button reloads the board;
//  - opening a board from the dashboard when the board page's chunk is gone: the page reloads once (the new
//    build), and the board opens;
//  - the chunk still missing after that reload: no second reload (the loop guard), the page says Lobby was
//    updated and offers a Reload.
import type { Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { clickItem, createNote, expect, expectSaved, test } from '../tests/support/canvas.ts'

const BOARD_CHUNK = '**/assets/LobbyBoardPage-*.js'

function pageErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

/** Document loads after the first one (reloads; an in-app navigation is not one). */
function reloads(page: Page) {
  const seen = { count: -1 }
  page.on('load', () => {
    seen.count++
  })
  return seen
}

test('on a board: a missing export chunk shows the Reload notice; the board stays, nothing reloads by itself, no uncaught error', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  const errors = pageErrors(page)
  const nav = { count: 0 }
  page.on('load', () => {
    nav.count++
  })
  // the deploy removed the export code this tab would load on its first export (before anything here loads
  // it: a thumbnail after the note would)
  const missing: string[] = []
  await page.route('**/assets/scene-*.js', (route) => {
    missing.push(route.request().url())
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })
  })
  const note = await createNote(page, { x: 200, y: 160, text: 'Export me' })
  await expectSaved(page)
  await clickItem(page, note, { button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.getByTestId('context-menu-sub.export-as-button').click()
  await page.getByTestId('context-menu.export-as-png').click()
  const notice = page.getByTestId('stale-chunk-notice')
  await expect(notice).toBeVisible({ timeout: 15_000 })
  await expect(notice).toContainText('Lobby has been updated')
  await expect(page.getByTestId('stale-chunk-reload')).toBeVisible()
  expect(missing.length).toBeGreaterThan(0)
  // the board is still here, live, and was not reloaded
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready')
  expect(nav.count).toBe(0)
  expect(errors).toEqual([])

  // the person's Reload: the new build (here: the chunk is back) and the same board
  await page.unroute('**/assets/scene-*.js')
  await page.getByTestId('stale-chunk-reload').click()
  await expect.poll(() => nav.count, { timeout: 15_000 }).toBe(1)
  await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
  expect(errors).toEqual([])
})

test('opening a board whose page chunk is gone reloads once and opens it', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    const errors = pageErrors(page)
    const nav = reloads(page)
    let gone = true
    await page.route(BOARD_CHUNK, (route) =>
      gone ? route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' }) : route.continue(),
    )
    await page.goto(`/w/${users.devStudioId}`)
    const card = page.locator(`[data-testid="board-card"][data-board-id="${board}"]`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    // the deploy happened: from the reload on, the new build has the chunk
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) gone = false
    })
    await card.locator('a.dr-bcard__link').click()
    await expect.poll(() => nav.count, { timeout: 15_000 }).toBe(1)
    await expect(page).toHaveURL(new RegExp(`/b/${board}$`))
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    await page.waitForTimeout(1_000)
    expect(nav.count).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})

test('the chunk still missing after that reload: no second reload, a page that says Lobby was updated, with Reload', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    const errors = pageErrors(page)
    const nav = reloads(page)
    await page.route(BOARD_CHUNK, (route) =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' }),
    )
    await page.goto(`/b/${board}`)
    // the first load reloads once; the reloaded page finds the chunk still missing and stops there
    await expect(page.getByTestId('board-code-updated')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('stale-chunk-notice')).toBeVisible()
    await page.waitForTimeout(3_000)
    expect(nav.count).toBe(1)
    expect(errors).toEqual([])
    // the person's Reload works once the chunk is back
    await page.unroute(BOARD_CHUNK)
    await page.getByTestId('stale-chunk-reload').click()
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
  } finally {
    await context.close()
  }
})
