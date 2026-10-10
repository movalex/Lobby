// M2-6 (wave M, W2): the shared laser stays on the other tab while its owner holds it still. A presenter pointing
// at one thing without moving used to vanish for everyone after 3 s (nothing was sent while the pointer rested).
// The hub now re-sends the last point every second (canvas/presence/hub.ts), with the fields rev 12 already has.
//
// This spec talks to whatever sync the run starts (this tree's). The deploy gate runs it against the sync that is
// deployed (4e4a549, rev 12) and against wave M's sync alike: the re-send is plain presence, no new field.
import { expect, test } from '../tests/support/canvas.ts'
import { emptyCanvasPoint, pickLaser, sidOf, writes } from './l6-kit.ts'

test('M2-6: a laser pressed and held still for 8 s is still on the other tab; it goes about a second after the release; nothing is written', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  await expect.poll(() => sidOf(b.page)).not.toBeNull()
  await pickLaser(a.page)
  const before = await writes([a.page, b.page])
  const laser = b.page.locator(`[data-testid="laser"][data-uid="${a.id}"]`)

  const p = await emptyCanvasPoint(a.page)
  await a.page.mouse.move(p.x - 60, p.y)
  await a.page.mouse.down()
  // a short sweep so the other tab has a path, then not one pointer event for 8 s
  await a.page.mouse.move(p.x, p.y + 12, { steps: 8 })
  await expect(laser).toHaveAttribute('data-active', 'true')
  const heldFrom = Date.now()
  let polls = 0
  while (Date.now() - heldFrom < 8_000) {
    await b.page.waitForTimeout(250)
    // the group is there, pressed, with its dot, the whole time (it used to be gone after 3 s)
    await expect(laser, `after ${Date.now() - heldFrom} ms of holding still`).toHaveAttribute(
      'data-active',
      'true',
      { timeout: 1_000 },
    )
    await expect(laser.locator('[data-testid="laser-dot"]')).toHaveCount(1, { timeout: 1_000 })
    polls++
  }
  expect(polls).toBeGreaterThan(20)

  await a.page.mouse.up()
  // released: the laser goes within about a second (its trail fades; no dot is held for a released laser)
  await expect(laser).toHaveCount(0, { timeout: 3_000 })
  // presence only: no push from either tab, the board clock as it was
  expect(await writes([a.page, b.page])).toEqual(before)
})
