// OWNER: 3c. Following someone on the Excalidraw board page: what the follower sees and where their camera
// goes (the early wave-5 review, docs/research/excalidraw/REVIEW-W5-EARLY.md):
//  - W5-23: a follower who stayed on after "Gather everyone" keeps their "Stop following" when the leader
//    starts presenting to everyone: it sits under the "is presenting" invitation instead of disappearing
//    (they are still following until they Join, say Not now or stop);
//  - W5-51: "Stop following" is one flat button: no button outlined inside the coloured pill;
//  - W5-25: a gathered desktop follower is centred on the leader's view centre also when the leader's dock
//    panel opened after their last camera move (the panel narrows the leader's canvas). The follower fits
//    the leader's presence `view` (canvas/api/parts/follow.ts, right); the leader's tab sends it on a
//    pointer move, a camera move and (CR-3C-W5-1, canvas/board/session.ts) whenever its canvas changes
//    size, so followers never keep the wider view until the leader moves (320 scene units off at zoom 0.5
//    with a 320 px panel).
import type { Locator, Page } from '@playwright/test'
import {
  type CanvasSession,
  createItem,
  expect,
  expectSaved,
  setViewport,
  test,
  viewport,
  waitForItem,
} from '../tests/support/canvas.ts'
import { openWorkshopPopover } from '../tests/support/workshops.ts'
import { canvasRect, followingSid, openCommentsPanel, sessionId } from './comments-kit.ts'

const stopButton = (page: Page) => page.getByTestId('following-stop')
const followingLabel = (page: Page) => page.getByTestId('following-label')

/** alice gathers everyone from the workshop popover (the summon carries her canvas size). */
async function gather(a: CanvasSession) {
  const pop = await openWorkshopPopover(a.page)
  await pop.getByTestId('summon-button').click()
  await expect(a.page.getByTestId('summon-toast')).toContainText('Everyone here now follows your view')
  await expect(pop).toHaveCount(0)
}

/** Whether the control is on top at its centre (nothing covers it). */
const onTop = (target: Locator) =>
  target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && (hit === el || el.contains(hit))
  })

/** The borders of an element (the four widths, px). */
const borders = (target: Locator) =>
  target.evaluate((el) => {
    const s = getComputedStyle(el)
    return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(parseFloat)
  })

const centre = (v: { x: number; y: number; width: number; height: number }) => ({
  x: v.x + v.width / 2,
  y: v.y + v.height / 2,
})

test('W5-23 and W5-51: after Gather, the follower keeps one flat "Stop following" under the "is presenting" invitation', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const frame = await createItem(a.page, 'frame', { x: 0, y: 0, width: 800, height: 450, name: 'Welcome' })
  await expectSaved(a.page)
  await waitForItem(b.page, frame)
  const aliceSid = await sessionId(a.page)

  await gather(a)
  await expect(b.page.getByTestId('follow-toast')).toBeVisible({ timeout: 5_000 })
  await expect.poll(() => followingSid(b.page)).toBe(aliceSid)
  const stop = stopButton(b.page)
  await expect(stop).toBeVisible()
  await expect(stop).toHaveText('Stop following')
  // W5-51: one flat button, the pill itself (no outlined button inside a pill)
  expect(await borders(stop)).toEqual([0, 0, 0, 0])
  expect(await borders(followingLabel(b.page))).toEqual([0, 0, 0, 0])
  const pill = await followingLabel(b.page).boundingBox()
  const btn = await stop.boundingBox()
  if (!pill || !btn) throw new Error('no following label')
  expect(Math.abs(pill.width - btn.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(pill.height - btn.height)).toBeLessThanOrEqual(1)

  // alice presents (to everyone: K3-5 offers a Present to everyone on the board at once): bob gets the
  // invitation and is still following her
  await a.page.getByTestId('present-button').click()
  await expect(a.page.getByTestId('present-overlay')).toBeVisible()
  await expect(a.page.getByTestId('live-presenting')).toBeVisible()
  const invite = b.page.getByTestId('live-invite')
  await expect(invite).toContainText('Alice Park is presenting')
  expect(await followingSid(b.page)).toBe(aliceSid)

  // W5-23: the one way out is still on screen, under the invitation, and nothing covers it
  await expect(stop).toBeVisible()
  await expect.poll(() => onTop(stop)).toBe(true)
  const inv = await invite.boundingBox()
  const after = await stop.boundingBox()
  if (!inv || !after) throw new Error('no invitation or stop button')
  expect(after.y).toBeGreaterThanOrEqual(inv.y + inv.height)
  await stop.click()
  await expect.poll(() => followingSid(b.page)).toBeNull()
  await expect(stop).toHaveCount(0)
  // the invitation stays: bob may still join
  await expect(invite).toBeVisible()
  await expect(b.page.getByTestId('live-join')).toBeVisible()
})

test('W5-51: following from the people list shows "Following Alice Park" and one flat "Stop following"', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const aliceSid = await sessionId(a.page)
  await b.page.evaluate((sid) => {
    const c = (window as unknown as { __lobbyBoard: { canvas: { follow: { start(s: string): void } } } })
      .__lobbyBoard.canvas
    c.follow.start(sid)
  }, aliceSid)
  await expect(followingLabel(b.page)).toContainText('Following Alice Park')
  const stop = stopButton(b.page)
  await expect(stop).toHaveText('Stop following')
  expect(await borders(stop)).toEqual([0, 0, 0, 0])
  await expect.poll(() => onTop(stop)).toBe(true)
  await stop.click()
  await expect.poll(() => followingSid(b.page)).toBeNull()
  await expect(followingLabel(b.page)).toHaveCount(0)
})

test('W5-25: a gathered desktop follower sits on the leader’s view centre when the leader’s dock panel is open', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  await a.page.setViewportSize({ width: 1440, height: 900 })
  await b.page.setViewportSize({ width: 1440, height: 900 })
  await setViewport(a.page, { x: 600, y: 300, zoom: 0.5 })
  // the panel opens after alice's last camera move: her canvas gets narrower, the camera itself does not move
  const before = await viewport(a.page)
  await openCommentsPanel(a.page)
  await expect.poll(async () => (await viewport(a.page)).width).toBeLessThan(before.width - 100)

  await gather(a)
  await expect(b.page.getByTestId('follow-toast')).toBeVisible({ timeout: 5_000 })
  const close = async () => {
    const [av, bv] = await Promise.all([viewport(a.page), viewport(b.page)])
    const ac = centre(av)
    const bc = centre(bv)
    return Math.round(Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y)))
  }
  await expect.poll(close, { message: 'scene units between the two view centres' }).toBeLessThanOrEqual(3)

  // alice closes the panel while bob follows: he follows her wider view
  await a.page.getByTestId('dock-tab-comments').click()
  await expect(a.page.getByTestId('comments-panel')).toHaveCount(0)
  await expect.poll(async () => (await viewport(a.page)).width).toBeGreaterThan(before.width - 10)
  await expect.poll(close, { message: 'after the panel closed' }).toBeLessThanOrEqual(3)
})

test('W5-25: a follower who opens or closes their own dock panel stays on the leader’s view centre', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  await a.page.setViewportSize({ width: 1440, height: 900 })
  await b.page.setViewportSize({ width: 1440, height: 900 })
  await setViewport(a.page, { x: 600, y: 300, zoom: 0.5 })
  await gather(a)
  await expect(b.page.getByTestId('follow-toast')).toBeVisible({ timeout: 5_000 })
  const off = async () => {
    const [av, bv] = await Promise.all([viewport(a.page), viewport(b.page)])
    const ac = centre(av)
    const bc = centre(bv)
    return Math.round(Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y)))
  }
  await expect.poll(off, { message: 'following' }).toBeLessThanOrEqual(3)
  const wide = await canvasRect(b.page)

  // bob's canvas gets narrower: he still follows alice, on her centre
  await openCommentsPanel(b.page)
  await expect.poll(async () => (await canvasRect(b.page)).width).toBeLessThan(wide.width - 100)
  expect(await followingSid(b.page)).not.toBeNull()
  await expect.poll(off, { message: 'with bob’s panel open' }).toBeLessThanOrEqual(3)

  // and wider again
  await b.page.getByTestId('dock-tab-comments').click()
  await expect(b.page.getByTestId('comments-panel')).toHaveCount(0)
  await expect.poll(off, { message: 'with bob’s panel closed' }).toBeLessThanOrEqual(3)
})
