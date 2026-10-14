// K3-4 (wave K): in present mode nothing covers slide content. The live timer used to float over a slide's
// heading and the control bar over its footer (the most visible flaw in a demo). Present mode now fits each
// slide below the floating timer (and the raised hands under it) and above the bar
// (features/present-export/ported/insets.ts); the unit test insets.test.ts checks the numbers, this checks
// what a browser draws: the timer's, the hands' and the bar's boxes against the frame's box on screen, at
// 1440 × 900 and 1280 × 760.
import type { Locator, Page } from '@playwright/test'
import { itemBounds, sceneToScreen } from '../tests/support/canvas.ts'
import { startPresenting } from './present-kit.ts'
import { expect, expectItemsEverywhere, post, seed, test } from './workshops-kit.ts'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

async function rectOf(l: Locator): Promise<Rect> {
  const b = await l.boundingBox()
  if (!b) throw new Error('no box')
  return { x: b.x, y: b.y, w: b.width, h: b.height }
}

/** The frame as drawn now: its scene box through the camera. */
async function frameOnScreen(page: Page, id: string): Promise<Rect> {
  const b = await itemBounds(page, id)
  if (!b) throw new Error(`${id} has no bounds`)
  const tl = await sceneToScreen(page, { x: b.x, y: b.y })
  const br = await sceneToScreen(page, { x: b.x + b.width, y: b.y + b.height })
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
}

/** Wakes the presentation's controls (they fade after 2 s without pointer movement). */
async function wake(page: Page) {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  await page.mouse.move(vp.width / 2 + Math.random() * 30, vp.height / 2 + Math.random() * 30, { steps: 2 })
}

const near = (a: Rect, b: Rect, eps = 2) =>
  Math.abs(a.x - b.x) <= eps &&
  Math.abs(a.y - b.y) <= eps &&
  Math.abs(a.w - b.w) <= eps &&
  Math.abs(a.h - b.h) <= eps

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 760 },
])
  test(`K3-4 at ${size.width}×${size.height}: the timer, the raised hands and the bar never cover the slide`, async ({
    join,
    board,
  }, testInfo) => {
    const a = await join('alice')
    await a.page.setViewportSize(size)
    // a 16:9 slide (fills the width when nothing is kept free) and a tall one (fills the height)
    await seed(a.page, {
      frames: [
        { id: 'k3-wide', x: 0, y: 0, w: 1600, h: 900, name: 'Kick-off' },
        { id: 'k3-tall', x: 2000, y: 0, w: 900, h: 1200, name: 'Agenda' },
      ],
    })
    await expectItemsEverywhere([a], ['k3-wide', 'k3-tall'])
    expect(
      (await post(a, `/api/boards/${board}/timer`, { action: 'start', durationMs: 300_000 })).status(),
    ).toBe(200)

    await startPresenting(a.page.getByTestId('present-button'))
    const overlay = a.page.getByTestId('present-overlay')
    await expect(overlay).toBeVisible()
    const timer = a.page.getByTestId('timer-floating')
    await expect(timer).toBeVisible()
    await expect.soft(overlay).toHaveAttribute('data-insets', '64|16|80|16')

    const check = async (frameId: string, top: number, extra: Locator[] = []) => {
      await wake(a.page)
      const mask = a.page.getByTestId('present-mask')
      // the camera has settled on the frame: the drawn frame is the surround's window
      await expect
        .poll(async () => near(await frameOnScreen(a.page, frameId), await rectOf(mask)), {
          message: `${frameId} is the slide on screen`,
          timeout: 10_000,
        })
        .toBe(true)
      await expect(a.page.getByTestId('present-controls')).toBeVisible()
      const slide = await frameOnScreen(a.page, frameId)
      const chrome = { timer: await rectOf(timer), bar: await rectOf(a.page.getByTestId('present-controls')) }
      for (const [name, r] of Object.entries(chrome))
        expect(
          overlap(slide, r),
          `${name} ${JSON.stringify(r)} over ${frameId} ${JSON.stringify(slide)}`,
        ).toBe(false)
      for (const l of extra) {
        const r = await rectOf(l)
        expect(overlap(slide, r), `${JSON.stringify(r)} over ${frameId} ${JSON.stringify(slide)}`).toBe(false)
      }
      // and it still uses the room it has: it fills the free band on one side
      const vp = a.page.viewportSize() ?? size
      expect(Math.max(slide.w / (vp.width - 32), slide.h / (vp.height - top - 80))).toBeGreaterThan(0.97)
      return slide
    }

    await test.step('the wide slide sits under the timer and above the bar', async () => {
      await check('k3-wide', 64)
      await a.page.screenshot({ path: testInfo.outputPath(`k3-insets-wide-${size.width}.png`) })
    })

    await test.step('the tall slide too', async () => {
      await a.page.keyboard.press('ArrowRight')
      await expect(a.page.getByTestId('present-counter')).toHaveText('2 / 2')
      await check('k3-tall', 64)
    })

    await test.step('a hand goes up: it floats under the timer, and the slide moves below both', async () => {
      expect((await post(a, `/api/boards/${board}/hand`, { raised: true })).status()).toBe(200)
      const hands = a.page.getByTestId('hands-floating')
      await expect(hands).toBeVisible()
      await expect.soft(overlay).toHaveAttribute('data-insets', '116|16|80|16')
      await check('k3-tall', 116, [hands])
      await a.page.screenshot({ path: testInfo.outputPath(`k3-insets-hands-${size.width}.png`) })
    })

    await test.step('the timer is stopped and the hand lowered: the slide takes the top back', async () => {
      expect((await post(a, `/api/boards/${board}/timer`, { action: 'stop' })).status()).toBe(200)
      expect((await post(a, `/api/boards/${board}/hand`, { raised: false })).status()).toBe(200)
      await expect(timer).toHaveCount(0)
      await expect.soft(overlay).toHaveAttribute('data-insets', '16|16|80|16')
      await wake(a.page)
      await expect
        .poll(
          async () =>
            near(await frameOnScreen(a.page, 'k3-tall'), await rectOf(a.page.getByTestId('present-mask'))),
          { timeout: 10_000 },
        )
        .toBe(true)
      const slide = await frameOnScreen(a.page, 'k3-tall')
      // the tall slide takes the top back, down to the margin every slide keeps (P-039)
      expect(slide.y).toBeGreaterThanOrEqual(15)
      expect(slide.y).toBeLessThan(18)
      expect(overlap(slide, await rectOf(a.page.getByTestId('present-controls')))).toBe(false)
    })

    await a.page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
  })
