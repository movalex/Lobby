// OWNER: 3f. "Gather everyone" on the Excalidraw board page, ported from tests/workshops.spec.ts ("gather
// everyone"), tests/facilitation-review.fix.spec.ts (RETRO-11) and tests/phone-overlays.spec.ts (R2-04).
//
// Following someone's view is 3c's (`canvas.follow`, canvas/api/parts/follow.ts), built beside this
// feature in wave 3; until it lands the feature tells a summoned person "…isn't available here yet". So
// the summon itself (the api, the event, the cooldown, the facilitator's toast) is a test that must
// pass, and every test that follows a view was marked as expected to fail until 3c's follow was in (the
// marks came off at the wave-3 integration). R2-04's readable zoom on a phone is the workshops feature's
// camera rule on 3c's follow camera hook (CR-3F-3, wave 3b): the summon carries the summoner's canvas
// size, so a follower can tell their zoom from their presence view.
import type { Page } from '@playwright/test'
import { canvasCall, setViewport, viewport } from '../tests/support/canvas.ts'
import { capture } from '../tests/support/screenshots.ts'
import { openWorkshopPopover } from '../tests/support/workshops.ts'
import {
  clickEmptyCanvas,
  expect,
  expectItemsEverywhere,
  post,
  seed,
  test,
  type WorkshopCanvasSession,
} from './workshops-kit.ts'

/** The session this page follows (3c's follow.current), or null (also while follow is not in). */
const following = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as { __lobbyBoard: { canvas: { follow: { current(): string | null } } } })
      .__lobbyBoard.canvas
    try {
      return c.follow.current()
    } catch {
      return null
    }
  })

const center = (v: { x: number; y: number; width: number; height: number }) => ({
  x: Math.round(v.x + v.width / 2),
  y: Math.round(v.y + v.height / 2),
})

/** The follower's viewport shows what the leader's shows (same window size: same view). */
async function expectSameView(follower: Page, leader: Page) {
  await expect
    .poll(
      async () => {
        const [f, l] = await Promise.all([viewport(follower), viewport(leader)])
        const fc = center(f)
        const lc = center(l)
        return (
          Math.abs(fc.x - lc.x) <= 2 && Math.abs(fc.y - lc.y) <= 2 && Math.abs(f.zoom / l.zoom - 1) < 0.01
        )
      },
      { message: 'follower shows the leader’s view' },
    )
    .toBe(true)
}

async function summon(a: WorkshopCanvasSession) {
  const pop = await openWorkshopPopover(a.page)
  await pop.getByTestId('summon-button').click()
  await expect(a.page.getByTestId('summon-toast')).toContainText('Everyone here now follows your view')
  await expect(pop).toHaveCount(0)
}

test('gather everyone: the summon reaches everyone on the board; a second one within 3 s is refused; viewers cannot summon', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await summon(a)
  const again = await post(a, `/api/boards/${board}/summon`)
  expect(again.status()).toBe(429)
  for (const s of [b, c])
    await expect
      .poll(() => s.net.eventsOf('workshop.summon').map((e) => (e.data as { userId?: string }).userId))
      .toEqual([a.id])
  // alice's own tabs never follow themselves
  expect(await following(a.page)).toBeNull()
  expect((await post(c, `/api/boards/${board}/summon`)).status()).toBe(403)
})

test('gather everyone: bob and carol follow alice’s view until they stop, click or scroll (3c follow)', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await seed(a.page, {
    notes: [
      { id: 'wk-far-1', x: -3000, y: -2000, text: 'Over here' },
      { id: 'wk-far-2', x: 2000, y: 1500, text: 'And here' },
    ],
  })
  await expectItemsEverywhere([b, c], ['wk-far-1', 'wk-far-2'])
  const aliceSid = (await canvasCall(a.page, 'me'))?.sid

  await setViewport(a.page, { x: 3200, y: 2200, zoom: 0.8 })
  await summon(a)
  const summonedAt = Date.now()
  for (const s of [b, c]) {
    await expect(s.page.getByTestId('follow-toast')).toContainText(`Following ${a.name}`, { timeout: 5_000 })
    await expectSameView(s.page, a.page)
    expect(await following(s.page)).toBe(aliceSid)
  }
  expect(await following(a.page)).toBeNull()

  // they keep following while alice moves
  await setViewport(a.page, { x: -1500, y: -800, zoom: 1.25 })
  await expectSameView(b.page, a.page)
  await expectSameView(c.page, a.page)

  // bob stops following with the one "Stop following" button; carol keeps following
  await expect(b.page.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(1)
  await b.page.getByRole('button', { name: 'Stop following', exact: true }).click()
  await expect(b.page.getByTestId('follow-toast')).toHaveCount(0)
  expect(await following(b.page)).toBeNull()
  const bobView = await viewport(b.page)
  await setViewport(a.page, { x: 500, y: 300, zoom: 1 })
  await expectSameView(c.page, a.page)
  expect(await viewport(b.page)).toEqual(bobView)

  // a plain click on the canvas ends carol's following
  await clickEmptyCanvas(c.page)
  await expect(c.page.getByTestId('follow-toast')).toHaveCount(0)
  await expect.poll(() => following(c.page)).toBeNull()

  // after the cooldown alice gathers again; a click ends bob's, a scroll ends carol's
  await a.page.waitForTimeout(Math.max(0, 3_200 - (Date.now() - summonedAt)))
  await summon(a)
  for (const s of [b, c]) {
    await expect(s.page.getByTestId('follow-toast')).toBeVisible()
    await expectSameView(s.page, a.page)
  }
  await clickEmptyCanvas(b.page)
  await expect(b.page.getByTestId('follow-toast')).toHaveCount(0)
  await expect.poll(() => following(b.page)).toBeNull()
  const vp = c.page.viewportSize() ?? { width: 1280, height: 720 }
  await c.page.mouse.move(vp.width / 2, vp.height / 2)
  await c.page.mouse.wheel(0, 300)
  await expect(c.page.getByTestId('follow-toast')).toHaveCount(0)
  await expect.poll(() => following(c.page)).toBeNull()
})

test('RETRO-11: the "Following" notice sits above the vote prompt, and followers get one Stop following button (3c follow)', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: [{ id: 'fr-v1', x: 0, y: 0, text: 'Alpha' }] })
  await expectItemsEverywhere([b], ['fr-v1'])
  const started = await post(a, `/api/boards/${board}/votes`, {
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(started.status()).toBe(201)
  await expect(b.page.getByTestId('vote-join-prompt')).toBeVisible()
  expect((await post(a, `/api/boards/${board}/summon`)).status()).toBe(202)
  const notice = b.page.getByTestId('follow-toast')
  await expect(notice).toBeVisible({ timeout: 5_000 })
  const n = await notice.boundingBox()
  const p = await b.page.getByTestId('vote-join-prompt').boundingBox()
  expect((n?.y ?? 0) + (n?.height ?? 0)).toBeLessThanOrEqual(p?.y ?? 0)
  await expect(b.page.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(1)
  await b.page.getByRole('button', { name: 'Stop following', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await expect(b.page.getByTestId('vote-join-prompt')).toBeVisible()
})

test('R2-04: "Gather everyone" shows a phone the leader view at a readable zoom (3c follow, CR-3F-3)', async ({
  join,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await a.page.setViewportSize({ width: 1440, height: 900 })
  await b.page.setViewportSize({ width: 390, height: 844 })
  await setViewport(a.page, { x: 400, y: 200, zoom: 0.44 })
  await summon(a)
  await expect(b.page.getByTestId('follow-toast')).toBeVisible({ timeout: 5_000 })
  await expect.poll(async () => (await viewport(b.page)).zoom, { timeout: 10_000 }).toBeGreaterThan(0.43)
  const [bv, av] = await Promise.all([viewport(b.page), viewport(a.page)])
  expect(bv.zoom).toBeLessThan(0.45)
  expect(Math.abs(center(bv).x - center(av).x)).toBeLessThanOrEqual(3)
  expect(Math.abs(center(bv).y - center(av).y)).toBeLessThanOrEqual(3)
  await capture('lc-phone-overlays-gathered-phone.png', b.page, testInfo)
})
