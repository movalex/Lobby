// L6-2 (wave L, W6): the presence compass, frame face piles and the followed view on the minimap, between two
// browsers. Presence-derived only: neither tab pushes anything.
//  - bob goes 5,000 px to the right: alice gets his chip on her right edge; a click on it brings his pointer
//    into her view;
//  - with "hide everyone's cursors" on there are no chips;
//  - on a 375 px touch screen the chip is at least 40 px and a press held on it follows bob;
//  - bob looking at a frame puts his face on that frame for alice;
//  - while alice follows bob, the minimap draws his view in his colour.
import { createItem, expect, expectSaved, setViewport, test, viewport } from '../tests/support/canvas.ts'
import {
  colorOf,
  emptyCanvasPoint,
  focusBoard,
  follow as followSid,
  followState,
  openTab,
  setHideCursors,
  sidOf,
  writes,
} from './l6-kit.ts'

const markerOf = (page: import('@playwright/test').Page, uid: string) =>
  page.locator(`[data-testid="edge-marker"][data-uid="${uid}"]`)

/** Moves the real pointer over empty canvas (presence sends it), a little each time. */
async function wiggle(page: import('@playwright/test').Page) {
  const p = await emptyCanvasPoint(page)
  await page.mouse.move(p.x - 30, p.y - 10)
  await page.mouse.move(p.x, p.y, { steps: 5 })
}

const peerPoint = (page: import('@playwright/test').Page, uid: string) =>
  page.evaluate((u) => {
    const b = (
      window as unknown as {
        __lobbyBoard?: {
          canvas: { presence: { peers(): { uid: string; point: { x: number; y: number } | null }[] } }
        }
      }
    ).__lobbyBoard
    return b?.canvas.presence.peers().find((p) => p.uid === u)?.point ?? null
  }, uid)

test('L6-2: an off-screen colleague’s chip sits on the right edge; a click brings their pointer into view; no push', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const before = await writes([a.page, b.page])
  const v = await viewport(b.page)
  await setViewport(b.page, { x: v.x + 5000, y: v.y })
  await wiggle(b.page)
  const chip = markerOf(a.page, b.id)
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-side', 'right')
  // the click: alice's camera goes to bob's pointer
  const at = await peerPoint(a.page, b.id)
  expect(at).not.toBeNull()
  await chip.click()
  await expect
    .poll(async () => {
      const av = await viewport(a.page)
      const p = (await peerPoint(a.page, b.id)) as { x: number; y: number }
      return p.x >= av.x && p.x <= av.x + av.width && p.y >= av.y && p.y <= av.y + av.height
    })
    .toBe(true)
  await expect(chip).toHaveCount(0)
  expect(await writes([a.page, b.page])).toEqual(before)
})

test('L6-2: with "hide everyone’s cursors" on there are no chips', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const v = await viewport(b.page)
  await setViewport(b.page, { x: v.x + 5000, y: v.y })
  await wiggle(b.page)
  await expect(markerOf(a.page, b.id)).toBeVisible()
  await setHideCursors(a.page, true)
  await expect(markerOf(a.page, b.id)).toHaveCount(0)
  await setHideCursors(a.page, false)
  await expect(markerOf(a.page, b.id)).toBeVisible()
})

test('L6-2: on a 375 px touch screen the chip is at least 40 px and a press held on it follows', async ({
  browser,
  board,
  users,
}) => {
  const b = await openTab(browser, board, users, 'bob', { role: 'editor' })
  const a = await openTab(browser, board, users, 'alice', {
    options: { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  })
  try {
    const v = await viewport(b.page)
    await setViewport(b.page, { x: v.x + 5000, y: v.y })
    await wiggle(b.page)
    const chip = markerOf(a.page, b.id)
    await expect(chip).toBeVisible()
    const box = await chip.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(40)
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40)
    // press and hold (a finger): follows bob, and the click after it does not "go there" as well
    const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2
    const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2
    const init = { bubbles: true, button: 0, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: cy }
    const el = await chip.elementHandle()
    await el?.dispatchEvent('pointerdown', init)
    await a.page.waitForTimeout(700)
    // the follow brings bob into view, so the chip may be gone already: the finger lifts from where it was
    await el?.dispatchEvent('pointerup', init).catch(() => {})
    const bsid = await sidOf(b.page)
    await expect.poll(() => followState(a.page)).toEqual({ sid: bsid, status: 'following' })
  } finally {
    await a.context.close()
    await b.context.close()
  }
})

test('L6-2: bob looking at a frame puts his face on it for alice; following him draws his view on her minimap', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const frame = await createItem(a.page, 'frame', { x: 4000, y: 0, width: 1600, height: 1000, name: 'Ideas' })
  await expectSaved(a.page)
  // bob looks at the middle of the frame
  const bv = await viewport(b.page)
  await setViewport(b.page, { x: 4800 - bv.width / 2, y: 500 - bv.height / 2 })
  await wiggle(b.page)
  // alice sees the frame (zoomed out to take it in)
  await setViewport(a.page, { x: 3800, y: -200, zoom: 0.5 })
  const pile = a.page.locator(`[data-testid="frame-heads"][data-frame-id="${frame}"]`)
  await expect(pile).toBeVisible()
  await expect(pile).toHaveAttribute('data-count', '1')
  await expect(pile.locator(`[data-uid="${b.id}"]`)).toHaveCount(1)
  // alice opens the minimap (M) and follows bob: his view in his colour
  await focusBoard(a.page)
  await a.page.keyboard.press('m')
  const minimap = a.page.getByTestId('minimap.canvas')
  await expect(minimap).toBeVisible()
  await expect(minimap).not.toHaveAttribute('data-followed-sid', /./)
  const bsid = (await sidOf(b.page)) as string
  await followSid(a.page, bsid)
  await expect.poll(() => followState(a.page)).toEqual({ sid: bsid, status: 'following' })
  await expect(minimap).toHaveAttribute('data-followed-sid', bsid)
  const color = await colorOf(a.page, b.id)
  await expect(minimap).toHaveAttribute('data-followed-color', new RegExp(`^${color}$`, 'i'))
  await expect(minimap).toHaveAttribute('data-followed-rect', /^-?\d+,-?\d+,\d+,\d+$/)
})
