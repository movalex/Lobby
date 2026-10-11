// Wave N (WS7, N7-1 and N7-2): board cards on the Excalidraw board page, against the real api (board-cards route,
// permission-checked faces) and sync:
//  - a pasted board URL of this Lobby becomes a board card that stores only the Lobby-relative path and the label
//    "Board link" (a scene scan finds no title or thumbnail of the target); its face shows the target's title to
//    someone who can open it; a click on Open navigates in this tab and `?el=` lands on the frame; Ctrl/Cmd and a
//    middle click open a new tab without opener or referrer;
//  - bob, who cannot view the target, sees the neutral face on the shared board while alice sees its title, and his
//    page never asks for the target's thumbnail;
//  - the palette command 'board-links.insert' picks a board from the permission-filtered list;
//  - an older api (the route answering 404) leaves neutral faces, and the card still navigates;
//  - nothing leaves Lobby's origins (the e2e network assertion).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n7-board-cards.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  type CanvasElement,
  createItem,
  expect,
  expectSaved,
  items,
  itemText,
  openCanvasSession,
  selection,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
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

/** A title no other board of this run holds. */
const unique = (prefix: string) => `${prefix} ${Math.random().toString(36).slice(2, 8)}`

const face = (page: Page, id: string) => page.locator(`[data-lobby-board-card="${id}"]`)

test('N7-1 a pasted board link becomes a board card: path only, the target’s face, in-app open with ?el=, new tabs without opener', async ({
  board,
  canvasSession,
  users,
  browser,
}) => {
  test.setTimeout(180_000)
  const title = unique('N7 Target')
  const target = await users.createBoard(title)
  const alice = await users.get('alice')
  // the target's frame (the card opens it)
  const t = await openCanvasSession(browser, target, alice)
  const frameId = await createItem(t.page, 'frame', { x: 2000, y: 1200, width: 600, height: 400 })
  await expectSaved(t.page)
  await t.context.close()

  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await grantClipboard(a.context)
  await pasteUrl(a.page, `${WEB_URL}/b/${target}?el=${frameId}`)
  await expect.poll(async () => (await boardCards(a.page)).length, { timeout: 15_000 }).toBe(1)
  const [card] = await boardCards(a.page)
  if (!card) throw new Error('no card')
  // stored: the Lobby-relative path and the kind, the label "Board link"; nothing of the target
  expect(card.link).toBe(`/b/${target}?el=${frameId}`)
  expect(await itemText(a.page, card.id)).toBe('Board link')
  await expectSaved(a.page)
  const scene = JSON.stringify(await items(a.page))
  expect(scene).not.toContain(title)
  expect(scene).not.toContain('/thumbnail')
  expect(scene).not.toContain(WEB_URL)

  await test.step('the face: the target’s title for alice, who can open it', async () => {
    await expect(face(a.page, card.id)).toBeVisible({ timeout: 30_000 })
    await expect(face(a.page, card.id)).toHaveAttribute('data-state', 'ok', { timeout: 30_000 })
    await expect(face(a.page, card.id).getByTestId('board-card-title')).toHaveText(title)
    await expect(face(a.page, card.id).getByTestId('board-card-open')).toHaveAttribute(
      'href',
      `/b/${target}?el=${frameId}`,
    )
  })

  await test.step('Ctrl/Cmd+click and a middle click open a new tab, without opener or referrer', async () => {
    for (const how of ['modifier', 'middle'] as const) {
      const popup = a.context.waitForEvent('page')
      const open = face(a.page, card.id).getByTestId('board-card-open')
      if (how === 'modifier') await open.click({ modifiers: ['ControlOrMeta'] })
      else await open.click({ button: 'middle' })
      const tab = await popup
      await expect.poll(() => tab.url()).toContain(`/b/${target}`)
      expect(await tab.evaluate(() => window.opener)).toBeNull()
      await waitForCanvas(tab)
      expect(await tab.evaluate(() => document.referrer)).toBe('')
      await tab.close()
    }
    // the board page itself stayed where it was
    expect(new URL(a.page.url()).pathname).toBe(`/b/${board}`)
  })

  await test.step('a click navigates in this tab, and ?el= lands on the frame', async () => {
    await face(a.page, card.id).getByTestId('board-card-open').click()
    await expect.poll(() => new URL(a.page.url()).pathname, { timeout: 20_000 }).toBe(`/b/${target}`)
    await waitForCanvas(a.page)
    await expect.poll(() => selection(a.page), { timeout: 20_000 }).toEqual([frameId])
    // back: the first board again, with its card
    await a.page.goBack()
    await expect.poll(() => new URL(a.page.url()).pathname, { timeout: 20_000 }).toBe(`/b/${board}`)
    await waitForCanvas(a.page)
    await expect.poll(async () => (await boardCards(a.page)).length).toBe(1)
  })
  expect(foreign).toEqual([])
})

test('N7-2 bob, who cannot view the target, sees the neutral face on the shared board; alice sees its title', async ({
  canvasSession,
  users,
}) => {
  test.setTimeout(150_000)
  const title = unique('N7 Private')
  const target = await users.createBoard(title) // alice's, private: bob has no grant
  const a = await canvasSession('alice')
  const b = await canvasSession('bob') // an editor of the shared board
  const bobForeign = foreignRequests(b.page)
  const bobAsked: string[] = []
  b.page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith(`/api/boards/${target}`)) bobAsked.push(r.url())
  })
  await grantClipboard(a.context)
  await pasteUrl(a.page, `${WEB_URL}/b/${target}`)
  await expect.poll(async () => (await boardCards(a.page)).length, { timeout: 15_000 }).toBe(1)
  const [card] = await boardCards(a.page)
  if (!card) throw new Error('no card')
  await expectSaved(a.page)
  await expect(face(a.page, card.id)).toHaveAttribute('data-state', 'ok', { timeout: 30_000 })
  await expect(face(a.page, card.id).getByTestId('board-card-title')).toHaveText(title)
  // bob: the card arrives through the room; its face is the neutral one
  await expect(face(b.page, card.id)).toBeVisible({ timeout: 30_000 })
  await expect(face(b.page, card.id)).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 })
  await expect(face(b.page, card.id).getByTestId('board-card-title')).toHaveText('Board you can’t open')
  await expect(face(b.page, card.id).getByTestId('board-card-thumbnail')).toHaveCount(0)
  expect(await b.page.content()).not.toContain(title)
  // his page asked nothing about the target itself (only the board-cards route of the shared board)
  expect(bobAsked).toEqual([])
  expect(bobForeign).toEqual([])
})

test('N7-1 the palette’s “Link to another board” picks from the boards this person can open', async ({
  canvasSession,
  users,
}) => {
  test.setTimeout(120_000)
  const title = unique('N7 Picked')
  const target = await users.createBoard(title)
  const a = await canvasSession('alice')
  expect(await navRun(a.page, 'board-links.insert')).toBe(true)
  const field = a.page.getByRole('combobox', { name: 'Link a board' })
  await expect(field).toBeVisible()
  await field.fill(title)
  await expect(a.page.getByTestId('command-palette-option').filter({ hasText: title })).toBeVisible({
    timeout: 15_000,
  })
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await boardCards(a.page)).length, { timeout: 15_000 }).toBe(1)
  const [card] = await boardCards(a.page)
  expect(card?.link).toBe(`/b/${target}`)
  await expect(face(a.page, card?.id ?? '')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 })
})

test('N7-2 an older api (board-cards answers 404): neutral faces, and the card still opens its board', async ({
  canvasSession,
  users,
}) => {
  test.setTimeout(120_000)
  const title = unique('N7 Old api')
  const target = await users.createBoard(title)
  const a = await canvasSession('alice')
  await a.page.route('**/api/boards/*/board-cards?**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found.' } }),
    }),
  )
  await grantClipboard(a.context)
  await pasteUrl(a.page, `${WEB_URL}/b/${target}`)
  await expect.poll(async () => (await boardCards(a.page)).length, { timeout: 15_000 }).toBe(1)
  const [card] = await boardCards(a.page)
  if (!card) throw new Error('no card')
  await expect(face(a.page, card.id)).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 })
  await expectSaved(a.page)
  await face(a.page, card.id).getByTestId('board-card-open').click()
  await expect.poll(() => new URL(a.page.url()).pathname, { timeout: 20_000 }).toBe(`/b/${target}`)
  await waitForCanvas(a.page)
})
