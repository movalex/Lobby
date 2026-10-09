// L5-2 (wave L) Spotlight for everyone: a facilitator dims the board around what they are talking about, for
// everyone, without taking anyone's camera (bringEveryone eases the view to it once). Two browsers: alice
// (owner) spotlights, bob (editor) is panned away; carol (viewer) watches with reduced motion. The api's state
// (GET /workshop) is the second witness. Bob's push counter proves that a person who only receives it writes
// nothing to the board.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- l5-spotlight
import type { Page } from '@playwright/test'
import {
  deleteItem,
  itemBounds,
  itemCenterOnScreen,
  select,
  selection,
  setViewport,
  viewport,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { pushCount } from './board-kit.ts'
import {
  expect,
  expectItemsEverywhere,
  post,
  seed,
  test,
  type WorkshopCanvasSession,
} from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const mask = (page: Page) => page.getByTestId('spotlight-mask')
const bar = (page: Page) => page.getByTestId('spotlight-bar')

/** The element is wholly inside this page's viewport. */
async function inView(page: Page, id: string): Promise<boolean> {
  const [b, v] = await Promise.all([itemBounds(page, id), viewport(page)])
  return !!b && b.x >= v.x && b.y >= v.y && b.x + b.width <= v.x + v.width && b.y + b.height <= v.y + v.height
}

/** The cut-out the mask draws, in overlay pixels, and the overlay's origin on the screen. */
async function cutOut(page: Page): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const raw = await mask(page)
    .getAttribute('data-rect', { timeout: 1_000 })
    .catch(() => null)
  if (!raw) return null
  const [x = 0, y = 0, w = 0, h = 0] = raw.split(',').map(Number)
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  return { x: x + (box?.x ?? 0), y: y + (box?.y ?? 0), w, h }
}

async function spotlightState(s: WorkshopCanvasSession, board: string) {
  const res = await s.api.fetch('GET', `/api/boards/${board}/workshop`)
  expect(res.status()).toBe(200)
  return (await res.json()) as { spotlight: { refs: string[]; by: { userId: string } } | null }
}

/**
 * Gives the board the keyboard with nothing selected: a click on empty canvas, in the top left corner (the
 * spotlit note is eased to the middle of the view, so the usual empty spot lower right can be on it).
 */
async function clearAndFocus(page: Page) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.3)
  await expect.poll(async () => (await selection(page)).length).toBe(0)
}

test('L5-2: alice spotlights a note from its context menu: bob (panned away) gets it eased into view; Esc hides it only for bob; alice sees how many look; she ends it for everyone; bob pushes nothing', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await c.page.emulateMedia({ reducedMotion: 'reduce' })
  await seed(a.page, {
    notes: [
      { id: 'l5s-near', x: 0, y: 0, text: 'Near' },
      { id: 'l5s-far', x: 3000, y: 2000, text: 'Weekly demo' },
    ],
  })
  await expectItemsEverywhere([b, c], ['l5s-near', 'l5s-far'])
  await zoomToFit(a.page)

  // bob is looking elsewhere: far from both notes
  await setViewport(b.page, { x: -30_000, y: -30_000, zoom: 1 })
  expect(await inView(b.page, 'l5s-far')).toBe(false)
  const before = await pushCount(b.page)

  await test.step('alice: select the note, right-click it, "Spotlight for everyone"', async () => {
    await select(a.page, ['l5s-far'])
    const at = await itemCenterOnScreen(a.page, 'l5s-far')
    await a.page.mouse.click(at.x, at.y, { button: 'right' })
    await expect(a.page.getByTestId('context-menu')).toBeVisible()
    await a.page.getByTestId('context-menu.workshops-spotlight').click()
    await expect(mask(a.page)).toBeVisible()
    expect((await spotlightState(a, board)).spotlight?.refs).toEqual(['shape:l5s-far'])
  })

  await test.step('bob: the mask is up within the event latency, and the note is eased into his view; carol sees it too', async () => {
    const startedAt = Date.now()
    await expect(mask(b.page)).toBeVisible({ timeout: 5_000 })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    await expect(bar(b.page).getByTestId('spotlight-text')).toContainText(`${a.name} is spotlighting this`)
    await expect.poll(() => inView(b.page, 'l5s-far'), { timeout: 10_000 }).toBe(true)
    // the cut-out sits on the note (after the camera settles)
    await expect
      .poll(async () => {
        const [r, at] = await Promise.all([cutOut(b.page), itemCenterOnScreen(b.page, 'l5s-far')])
        return !!r && at.x > r.x && at.x < r.x + r.w && at.y > r.y && at.y < r.y + r.h
      })
      .toBe(true)
    await expect(mask(c.page)).toBeVisible({ timeout: 5_000 })
    // a viewer may hide it for herself, but has no "End for everyone"
    await expect(c.page.getByTestId('spotlight-hide')).toBeVisible()
    await expect(c.page.getByTestId('spotlight-end')).toHaveCount(0)
    // reduced motion: the ring stands still
    await expect(c.page.getByTestId('spotlight-layer')).toHaveAttribute('data-motion', 'still')
    await expect(b.page.getByTestId('spotlight-layer')).toHaveAttribute('data-motion', 'pulse')
  })

  await test.step('alice sees "1 of 2 looking": bob (it is in his view now), not carol if she looks away', async () => {
    await setViewport(c.page, { x: -30_000, y: 30_000, zoom: 1 })
    await expect(a.page.getByTestId('spotlight-looking')).toContainText('of 2 looking', { timeout: 8_000 })
    await expect(a.page.getByTestId('spotlight-looking')).toHaveText('1 of 2 looking', { timeout: 8_000 })
  })

  await test.step('bob presses Esc: gone for him, still there for alice; a chip brings it back', async () => {
    await clearAndFocus(b.page)
    await b.page.keyboard.press('Escape')
    await expect(mask(b.page)).toHaveCount(0)
    await expect(b.page.getByTestId('spotlight-show')).toBeVisible()
    await expect(mask(a.page)).toBeVisible()
    await b.page.getByTestId('spotlight-show').click()
    await expect(mask(b.page)).toBeVisible()
    await clearAndFocus(b.page)
    await b.page.keyboard.press('Escape')
    await expect(mask(b.page)).toHaveCount(0)
  })

  await test.step('alice ends it for everyone: it is gone for bob (hidden or not) and carol, and bob is told', async () => {
    await a.page.getByTestId('spotlight-end').click()
    await expect(mask(a.page)).toHaveCount(0)
    await expect(mask(c.page)).toHaveCount(0)
    await expect(b.page.getByTestId('spotlight-show')).toHaveCount(0)
    await expect(b.page.getByTestId('spotlight-ended-toast')).toContainText(`${a.name} ended the spotlight`)
    expect((await spotlightState(a, board)).spotlight).toBeNull()
  })

  await test.step('bob only received it: nothing was written to the board by him', async () => {
    expect(await pushCount(b.page)).toBe(before)
  })
})

test('L5-2: the selection bar and the Facilitate menu start it; a new spotlight shows again for someone who hid the last; deleted items say so; a viewer is refused by the api', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await seed(a.page, {
    notes: [
      { id: 'l5s-one', x: 0, y: 0, text: 'One' },
      { id: 'l5s-two', x: 400, y: 0, text: 'Two' },
    ],
  })
  await expectItemsEverywhere([b, c], ['l5s-one', 'l5s-two'])
  await zoomToFit(a.page)
  await zoomToFit(b.page)

  await test.step('a viewer is refused by the api (403), and has no spotlight entries', async () => {
    const res = await post(c, `/api/boards/${board}/spotlight`, { refs: ['shape:l5s-one'] })
    expect(res.status()).toBe(403)
    await select(c.page, ['l5s-one'])
    await expect(c.page.getByTestId('selection-spotlight')).toHaveCount(0)
    expect((await spotlightState(a, board)).spotlight).toBeNull()
  })

  await test.step('the selection bar: select a note, press the button; bob sees it', async () => {
    await select(a.page, ['l5s-one'])
    await a.page.getByTestId('selection-spotlight').click()
    await expect(mask(a.page)).toBeVisible()
    await expect(mask(b.page)).toBeVisible({ timeout: 5_000 })
  })

  await test.step('bob hides it; alice spotlights the other note from the Facilitate menu (the old one is replaced): bob sees the new one', async () => {
    await clearAndFocus(b.page)
    await b.page.keyboard.press('Escape')
    await expect(mask(b.page)).toHaveCount(0)
    // the cooldown is a few seconds per person
    await a.page.waitForTimeout(3_200)
    await select(a.page, ['l5s-two'])
    await a.page.getByTestId('facilitate-button').click()
    await expect(a.page.getByTestId('spotlight-menu')).toContainText('Spotlight for everyone')
    await expect(a.page.getByTestId('spotlight-menu-end')).toContainText('End the spotlight') // alice's own is on
    await a.page.getByTestId('spotlight-menu').click()
    await expect(mask(b.page)).toBeVisible({ timeout: 5_000 }) // a NEW spotlight: shown again
    await expect.poll(async () => (await spotlightState(a, board)).spotlight?.refs).toEqual(['shape:l5s-two'])
  })

  await test.step('deleting what is spotlit: no dimming, and everyone is told the items were removed', async () => {
    await deleteItem(a.page, 'l5s-two')
    for (const s of [a, b]) {
      await expect(s.page.getByTestId('spotlight-text')).toHaveText('The spotlit items were removed', {
        timeout: 8_000,
      })
      await expect(mask(s.page)).toHaveCount(0)
    }
    await a.page.getByTestId('spotlight-end').click()
    await expect(bar(a.page)).toHaveCount(0)
    await expect(bar(b.page)).toHaveCount(0)
  })
})
