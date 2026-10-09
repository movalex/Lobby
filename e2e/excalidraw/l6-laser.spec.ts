// L6-1 (wave L, W6): the shared laser between two browsers, through the real sync room at CONTRACTS_REV 12.
//  - alice presses K and sweeps 300 px: bob's laser layer shows a path of 8 or more samples in alice's colour
//    within 300 ms of her press, and it is gone within 1.5 s of her release;
//  - a viewer's laser shows the same way (read-only reviewers point too);
//  - nobody pushes anything and the board clock does not move (the laser is presence);
//  - with "hide everyone's cursors" on, the cursor is hidden and the laser still shows;
//  - under reduced motion only the dot is drawn.
import { expect, test } from '../tests/support/canvas.ts'
import {
  colorOf,
  laserStroke,
  laserStrokeAtMouseRate,
  pickLaser,
  pickLaserReadOnly,
  setHideCursors,
  sidOf,
  watchLaser,
  writes,
} from './l6-kit.ts'

test('L6-1: a laser sweep reaches the other tab as a path in the presenter’s colour within 300 ms, gone 1.5 s after; nothing is written', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  await expect.poll(() => sidOf(b.page)).not.toBeNull()
  await pickLaser(a.page)
  const before = await writes([a.page, b.page])
  const watch = await watchLaser(b.page, a.id)
  // at a real mouse's rate (125 moves a second for 300 ms, 300 px)
  const stroke = await laserStrokeAtMouseRate(a.page)
  await expect
    .poll(async () => (await watch.read()).at, { message: 'a path of 8 samples at bob' })
    .not.toBeNull()
  await expect.poll(async () => (await watch.read()).goneAt, { timeout: 5_000 }).not.toBeNull()
  const seen = await watch.read()
  await watch.stop()
  const lag = (seen.at as number) - stroke.startedAt
  const gone = (seen.goneAt as number) - stroke.endedAt
  console.log(
    `[L6-1] 8 samples at bob ${lag} ms after the press (max ${seen.maxPoints}); gone ${gone} ms after the release`,
  )
  expect(seen.points).toBeGreaterThanOrEqual(8)
  expect(lag).toBeLessThanOrEqual(300)
  expect(gone).toBeLessThanOrEqual(1_500)
  expect(seen.path).toBe(true)
  // in alice's presence colour (the roster's)
  const color = await colorOf(b.page, a.id)
  expect(seen.color?.toLowerCase()).toBe(color?.toLowerCase())
  // presence only: no push from either tab, the board clock as it was
  expect(await writes([a.page, b.page])).toEqual(before)
})

test('L6-1: a viewer’s laser reaches the editor (read-only reviewers point too), and writes nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('bob', { role: 'viewer' })
  await pickLaserReadOnly(v.page)
  const before = await writes([a.page, v.page])
  const watch = await watchLaser(a.page, v.id)
  await laserStroke(v.page)
  await expect.poll(async () => (await watch.read()).at).not.toBeNull()
  const seen = await watch.read()
  await watch.stop()
  expect(seen.path).toBe(true)
  expect(seen.color?.toLowerCase()).toBe((await colorOf(a.page, v.id))?.toLowerCase())
  expect(await writes([a.page, v.page])).toEqual(before)
})

test('L6-1: with "hide everyone’s cursors" on, the cursor is hidden and the laser still shows', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  await setHideCursors(a.page, true)
  const cursor = a.page.locator(`[data-testid="cursor"][data-uid="${b.id}"]`)
  await pickLaser(b.page)
  const watch = await watchLaser(a.page, b.id, 2)
  await laserStroke(b.page)
  await expect.poll(async () => (await watch.read()).at).not.toBeNull()
  await expect(cursor).toHaveCount(0)
  expect((await watch.read()).path).toBe(true)
  await watch.stop()
  await setHideCursors(a.page, false)
})

test('L6-1: under reduced motion the other tab draws only the dot, no trail', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  await b.page.emulateMedia({ reducedMotion: 'reduce' })
  await pickLaser(a.page)
  const watch = await watchLaser(b.page, a.id, 1)
  await laserStroke(a.page, { dx: 10, steps: 20, stepMs: 15 })
  await expect.poll(async () => (await watch.read()).dot).toBe(true)
  const seen = await watch.read()
  await watch.stop()
  expect(seen.path).toBe(false)
  await expect(b.page.locator('[data-testid="laser-layer"][data-reduced-motion]')).toHaveCount(0) // gone again
})
