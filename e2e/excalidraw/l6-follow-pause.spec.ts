// L6-3 (wave L, W6): nudging the canvas pauses a follow instead of dropping it, between two browsers.
//  - alice follows bob and wheels: the chip says "Paused following Bob …", her camera stays put while bob
//    moves; Resume follows him again (her view comes back onto his);
//  - bob leaving while she is paused ends it (no chip);
//  - Esc ends a follow;
//  - nothing is written by either tab.
import { expect, setViewport, test, viewport } from '../tests/support/canvas.ts'
import { emptyCanvasPoint, focusBoard, follow, followState, sidOf, writes } from './l6-kit.ts'
import { seedDeck, startPresenting } from './present-kit.ts'

const centre = (v: { x: number; y: number; width: number; height: number }) => ({
  x: v.x + v.width / 2,
  y: v.y + v.height / 2,
})

test('L6-3: a wheel pauses the follow ("Paused following …"), the camera stays; Resume follows again; bob leaving stops it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const bsid = (await sidOf(b.page)) as string
  const before = await writes([a.page, b.page])
  await setViewport(b.page, { x: 2000, y: 1000, zoom: 1 })
  await follow(a.page, bsid)
  await expect(a.page.getByTestId('following-label')).toBeVisible()
  const off = async () => {
    const [av, bv] = await Promise.all([viewport(a.page), viewport(b.page)])
    const ac = centre(av)
    const bc = centre(bv)
    return Math.round(Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y)))
  }
  await expect.poll(off, { message: 'following' }).toBeLessThanOrEqual(3)

  await test.step('alice wheels: paused, the target kept, the camera no longer follows', async () => {
    const p = await emptyCanvasPoint(a.page)
    await a.page.mouse.move(p.x, p.y)
    await a.page.mouse.wheel(0, 240)
    const chip = a.page.getByTestId('follow-paused')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('Paused following')
    await expect(chip).toContainText(b.name)
    await expect(a.page.getByTestId('following-label')).toHaveCount(0)
    expect(await followState(a.page)).toEqual({ sid: bsid, status: 'paused' })
    const held = await viewport(a.page)
    await setViewport(b.page, { x: 6000, y: 3000, zoom: 1 })
    await a.page.waitForTimeout(600)
    const still = await viewport(a.page)
    expect(Math.abs(still.x - held.x) + Math.abs(still.y - held.y)).toBeLessThan(1)
  })

  await test.step('Resume follows bob again, onto his view', async () => {
    await a.page.getByTestId('follow-resume').click()
    await expect(a.page.getByTestId('following-label')).toBeVisible()
    await expect(a.page.getByTestId('follow-paused')).toHaveCount(0)
    expect(await followState(a.page)).toEqual({ sid: bsid, status: 'following' })
    await expect.poll(off, { message: 'following again' }).toBeLessThanOrEqual(3)
  })

  await test.step('paused again, then bob leaves: stopped, no chip', async () => {
    const p = await emptyCanvasPoint(a.page)
    await a.page.mouse.move(p.x, p.y)
    await a.page.mouse.wheel(0, -240)
    await expect(a.page.getByTestId('follow-paused')).toBeVisible()
    expect(await writes([a.page, b.page])).toEqual(before)
    await b.context.close()
    await expect(a.page.getByTestId('follow-paused')).toHaveCount(0)
    await expect.poll(() => followState(a.page)).toBeNull()
  })
})

test('L6-3: Esc stops a follow; × on the paused chip stops it too', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const bsid = (await sidOf(b.page)) as string
  // the board takes the keyboard before the follow starts (a click on the canvas would end a follow)
  await focusBoard(a.page)
  await follow(a.page, bsid)
  await expect(a.page.getByTestId('following-label')).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect.poll(() => followState(a.page)).toBeNull()
  await expect(a.page.getByTestId('following-label')).toHaveCount(0)
  // paused, then the chip's ×
  await follow(a.page, bsid)
  const p = await emptyCanvasPoint(a.page)
  await a.page.mouse.move(p.x, p.y)
  await a.page.mouse.wheel(0, 120)
  await expect(a.page.getByTestId('follow-paused')).toBeVisible()
  await a.page.getByTestId('follow-paused-stop').click()
  await expect(a.page.getByTestId('follow-paused')).toHaveCount(0)
  expect(await followState(a.page)).toBeNull()
})

// Wave L integration (L6-3 with the presenter, W5's file): a paused follow has current() === null, so the
// presenter's "stop following" used to leave it, and "Paused following …, Resume" came back after the
// presentation ended (the W6 review's stale paused follow).
test('L6-3: a paused follow ends when this tab starts presenting; it does not come back after', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  await seedDeck(a.page, { frames: [{ id: 'l6p-f', x: 0, y: 0, w: 800, h: 500, name: 'Slide' }] })
  const bsid = (await sidOf(b.page)) as string
  await setViewport(b.page, { x: 2000, y: 1000, zoom: 1 })
  await follow(a.page, bsid)
  await expect(a.page.getByTestId('following-label')).toBeVisible()
  const p = await emptyCanvasPoint(a.page)
  await a.page.mouse.move(p.x, p.y)
  await a.page.mouse.wheel(0, 240)
  await expect(a.page.getByTestId('follow-paused')).toBeVisible()
  await startPresenting(a.page, 'me')
  await expect(a.page.getByTestId('present-overlay')).toBeVisible()
  await expect.poll(() => followState(a.page)).toBeNull()
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('present-overlay')).toHaveCount(0)
  await a.page.waitForTimeout(300)
  await expect(a.page.getByTestId('follow-paused')).toHaveCount(0)
  await expect(a.page.getByTestId('following-label')).toHaveCount(0)
  expect(await followState(a.page)).toBeNull()
})
