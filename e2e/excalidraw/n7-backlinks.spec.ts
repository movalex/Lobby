// Wave N (WS7, N7-4 and N7-5): "Linked from" on the Excalidraw board page, against the real api, sync and search
// indexer: board A links board B; after the indexer's tick (the test hook below: a workspace search, which refreshes
// the stale boards of the searcher's scope, A among them, through the sync's text route with ?links=1) B's
// navigation panel lists A, and "Go to the link" opens A at the card. A viewer of B who cannot view A sees nothing;
// the palette command 'board-links.backlinks' lists the same; an older api (backlinks answering 404) hides the
// section. Nothing leaves Lobby's origins (the e2e network assertion).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n7-backlinks.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type Api, signInContext } from '../tests/support/api.ts'
import {
  type CanvasElement,
  expect,
  expectSaved,
  items,
  openCanvasSession,
  selection,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { capture } from '../tests/support/screenshots.ts'
import { foreignRequests } from './ai-kit.ts'
import { focusBoard } from './media-kit.ts'
import { grantClipboard, navRun, writeClipboard } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

type Card = CanvasElement & { link?: string; customData?: { lobby?: { kind?: string } } }
const boardCards = async (page: Page) =>
  (await items(page)).filter(
    (e) => e.type === 'rectangle' && (e as Card).customData?.lobby?.kind === 'board-card',
  ) as Card[]

async function pasteUrl(page: Page, url: string) {
  await focusBoard(page)
  await writeClipboard(page, { 'text/plain': url })
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45)
  await page.keyboard.press('ControlOrMeta+v')
}

const unique = (prefix: string) => `${prefix} ${Math.random().toString(36).slice(2, 8)}`

/**
 * The indexer's tick (the test hook): a search of the workspace by `api` refreshes the stale boards of its scope
 * (search/indexer.ts refreshForSearch), each through the text route with ?links=1, then "Linked from" of `board`
 * is read until it names `from` (the background pass, every 15 s, would get there too).
 */
async function indexerTick(api: Api, workspaceId: string, board: string, from: string) {
  await expect
    .poll(
      async () => {
        await api.fetch(
          'GET',
          `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent('linkedfromtick')}`,
        )
        const res = await api.fetch('GET', `/api/boards/${board}/backlinks`)
        if (res.status() !== 200) return `status ${res.status()}`
        const body = (await res.json()) as { backlinks: { boardId: string }[] }
        return body.backlinks.map((b) => b.boardId).join(',')
      },
      { timeout: 60_000, intervals: [500, 1000, 2000] },
    )
    .toContain(from)
}

const linkedFrom = (page: Page) => page.getByTestId('navigation.linked-from')

test('N7-5 board A links board B; after the indexer tick B’s panel lists A, and Go to the link opens A at the card', async ({
  board,
  canvasSession,
  users,
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const aTitle = (await (await users.api('alice')).getBoard(board)).board.title
  const target = await users.createBoard(unique('N7 Linked'))
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await pasteUrl(a.page, `${WEB_URL}/b/${target}`)
  await expect.poll(async () => (await boardCards(a.page)).length, { timeout: 15_000 }).toBe(1)
  const [card] = await boardCards(a.page)
  if (!card) throw new Error('no card')
  await expectSaved(a.page)
  await a.context.close()

  await indexerTick(await users.api('alice'), users.devStudioId, target, board)

  const alice = await users.get('alice')
  const b = await openCanvasSession(browser, target, alice)
  const foreign = foreignRequests(b.page)
  await test.step('P-018: the top bar says "Linked from 1 board" early; the board menu lists it too', async () => {
    const top = b.page.getByTestId('linked-from-top')
    // asked as soon as the board is ready, not after the navigation panel's own delay (2 s)
    await expect(top).toBeVisible({ timeout: 1_800 })
    await expect(top).toHaveText('Linked from 1')
    await expect(top).toHaveAttribute('aria-label', 'Linked from 1 board')
    await capture('p018-linked-from-top.png', b.page, testInfo)
    await b.page.getByTestId('main-menu.button').click()
    await b.page.getByTestId('main-menu-sub.dr-board-button').click()
    await expect(b.page.getByRole('menuitem', { name: 'Linked from 1 board' })).toBeVisible()
    await b.page.keyboard.press('Escape')
    await top.click()
    const list = b.page.getByRole('listbox', { name: 'Linked from results' })
    await expect(list.getByTestId('command-palette-option').filter({ hasText: aTitle })).toBeVisible({
      timeout: 15_000,
    })
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByRole('combobox', { name: 'Linked from' })).toHaveCount(0)
  })
  await expect(linkedFrom(b.page)).toBeVisible({ timeout: 20_000 })
  await expect(linkedFrom(b.page)).toHaveAttribute('aria-label', 'Linked from 1 board')
  await linkedFrom(b.page).click()
  const row = b.page.getByTestId('linked-from-item')
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute('data-board-id', board)
  await expect(row).toContainText(aTitle)
  const go = row.getByTestId('linked-from-go')
  await expect(go).toHaveAttribute('href', `/b/${board}?el=${card.id}`)
  // the button closes the list again
  await linkedFrom(b.page).click()
  await expect(linkedFrom(b.page)).toHaveAttribute('aria-expanded', 'false')
  await expect(row).toHaveCount(0)

  await test.step('the palette command lists the same board', async () => {
    expect(await navRun(b.page, 'board-links.backlinks')).toBe(true)
    const list = b.page.getByRole('listbox', { name: 'Linked from results' })
    await expect(list.getByTestId('command-palette-option').filter({ hasText: aTitle })).toBeVisible({
      timeout: 15_000,
    })
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByRole('combobox', { name: 'Linked from' })).toHaveCount(0)
  })

  await test.step('Go to the link opens A in this tab at the card', async () => {
    await linkedFrom(b.page).click()
    await expect(linkedFrom(b.page)).toHaveAttribute('aria-expanded', 'true')
    await b.page.getByTestId('linked-from-go').click()
    await expect.poll(() => new URL(b.page.url()).pathname, { timeout: 20_000 }).toBe(`/b/${board}`)
    await waitForCanvas(b.page)
    await expect.poll(() => selection(b.page), { timeout: 20_000 }).toEqual([card.id])
  })
  expect(foreign).toEqual([])
  await b.context.close()
})

test('N7-5 a viewer of B who cannot view A sees nothing; an older api (404) hides the section', async ({
  board,
  canvasSession,
  users,
  browser,
}) => {
  test.setTimeout(180_000)
  const target = await users.createBoard(unique('N7 Viewed'))
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await pasteUrl(a.page, `${WEB_URL}/b/${target}`)
  await expect.poll(async () => (await boardCards(a.page)).length, { timeout: 15_000 }).toBe(1)
  await expectSaved(a.page)
  await a.context.close()
  await indexerTick(await users.api('alice'), users.devStudioId, target, board)

  // carol views B only (A is alice's private board: she has no grant on it)
  const carol = await users.grant(target, 'carol', 'viewer')
  const carolApi = await users.api('carol')
  const res = await carolApi.fetch('GET', `/api/boards/${target}/backlinks`)
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ backlinks: [] })
  const c = await openCanvasSession(browser, target, carol)
  // the panel is there, with nothing linked from a board she can open
  await expect(c.page.getByTestId('navigation-panel')).toBeVisible()
  await c.page
    .waitForResponse((r) => r.url().includes(`/api/boards/${target}/backlinks`), { timeout: 20_000 })
    .catch(() => {})
  await expect(linkedFrom(c.page)).toHaveCount(0)
  await expect(c.page.getByTestId('linked-from-top')).toHaveCount(0)
  expect(await c.page.content()).not.toContain(board)
  await c.context.close()

  // alice, with an api that has no backlinks route (an older api answers 404 like any unknown route)
  const alice = await users.get('alice')
  const context = await browser.newContext()
  const page = await context.newPage()
  let refused = 0
  await page.route('**/api/boards/*/backlinks', (route) => {
    refused++
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found.' } }),
    })
  })
  await signInContext(context, alice.handle, alice.name)
  await page.goto(`/b/${target}`)
  await waitForCanvas(page)
  await expect.poll(() => refused, { timeout: 20_000 }).toBeGreaterThan(0)
  await expect(page.getByTestId('navigation-panel')).toBeVisible()
  await expect(linkedFrom(page)).toHaveCount(0)
  await expect(page.getByTestId('linked-from-top')).toHaveCount(0)
  await context.close()
})
