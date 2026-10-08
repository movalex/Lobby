// Wave K (K4-3): what the dark theme really paints. The canvas draws dark mode by passing every stored colour
// through its own theme (apps/web/src/canvas/engine/theme.ts), so a label that is white on a saturated fill
// in the light theme came out as dark text on a bright fill (the Brainstorm's centre question). The templates
// now put their words on pale tints in the dark ink, and this spec measures the rendered pixels in both
// themes: the words against the fill they sit on, at WCAG AA (4.5:1). The screenshots (Brainstorm and the
// Lobby tour's Welcome frame, light and dark) are attached to the report and, with E2E_SCREENSHOTS=1, saved to
// docs/screenshots.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw k4-dark-safe
import type { Page } from '@playwright/test'
import { expect, items, sceneToScreen, test, zoomToFit } from '../tests/support/canvas.ts'
import { capture } from '../tests/support/screenshots.ts'
import { pickTheme } from '../tests/support/theme.ts'
import { countOf, setView, waitForNavigation } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

interface Clip {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The contrast of the words in a screenshot region against the fill behind them: the most common colour is
 * the fill, the most common colour among the pixels far from it in lightness is the ink (anti-aliasing
 * spreads between the two, so only strongly different pixels count). Decoded in the page (no image library).
 */
async function inkContrast(page: Page, clip: Clip): Promise<number> {
  const png = (await page.screenshot({ clip, animations: 'disabled' })).toString('base64')
  return page.evaluate(async (data) => {
    const img = new Image()
    img.src = `data:image/png;base64,${data}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, c.width, c.height).data
    const lin = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const counts = new Map<number, number>()
    for (let i = 0; i < px.length; i += 4) {
      const key = ((px[i] as number) << 16) | ((px[i + 1] as number) << 8) | (px[i + 2] as number)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const bg = top[0]?.[0] ?? 0
    const bgL = lum((bg >> 16) & 255, (bg >> 8) & 255, bg & 255)
    // the ink: the most common colour whose lightness differs clearly from the fill's
    let ink = bg
    for (const [k] of top) {
      const l = lum((k >> 16) & 255, (k >> 8) & 255, k & 255)
      if (Math.abs(l - bgL) > 0.15) {
        ink = k
        break
      }
    }
    const inkL = lum((ink >> 16) & 255, (ink >> 8) & 255, ink & 255)
    const [hi, lo] = bgL > inkL ? [bgL, inkL] : [inkL, bgL]
    return (hi + 0.05) / (lo + 0.05)
  }, png)
}

test('K4-3: the Brainstorm’s centre question and the tour’s Welcome cards read at 4.5:1 in the light and the dark theme', async ({
  canvasSession,
  users,
}, testInfo) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  const open = async (id: 'brainstorm' | 'lobby-tour', frames: number) => {
    const board = await users.createBoard(`K4 dark ${id}`)
    await a.page.goto(`/b/${board}?template=${id}`)
    await waitForNavigation(a.page)
    await expect.poll(() => countOf(a.page, 'frame'), { timeout: 30_000 }).toBe(frames)
    await zoomToFit(a.page)
    return (await items(a.page)) as (Awaited<ReturnType<typeof items>>[number] & { originalText?: string })[]
  }
  /** The screen rectangle of the middle of an element (its label area). */
  const middle = async (
    e: { x: number; y: number; width: number; height: number },
    inset: number,
    iy = 0.3,
  ) => {
    const p0 = await sceneToScreen(a.page, { x: e.x + e.width * inset, y: e.y + e.height * iy })
    const p1 = await sceneToScreen(a.page, { x: e.x + e.width * (1 - inset), y: e.y + e.height * (1 - iy) })
    return { x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y }
  }

  for (const mode of ['light', 'dark'] as const) {
    await test.step(`${mode}: the Brainstorm's centre question`, async () => {
      const els = await open('brainstorm', 3)
      if (mode === 'dark') await pickTheme(a.page, 'dark')
      else await pickTheme(a.page, 'light')
      await a.page.keyboard.press('Escape')
      await zoomToFit(a.page)
      const question = els.find((e) => e.type === 'ellipse')
      if (!question) throw new Error('no centre question')
      const ratio = await inkContrast(a.page, await middle(question, 0.25))
      expect(ratio, `the question's words against their fill, ${mode}`).toBeGreaterThanOrEqual(4.5)
      await capture(`k4-brainstorm-${mode}.png`, a.page, testInfo)
    })
    await test.step(`${mode}: the tour's Welcome cards`, async () => {
      const els = await open('lobby-tour', 6)
      const welcome = els.find((e) => e.type === 'frame' && e.name === '1 · Welcome')
      if (!welcome) throw new Error('no Welcome frame')
      // the Welcome frame at 70 %, clear of the top bar, so its text is large enough to measure
      const z = 0.7
      await setView(a.page, { x: welcome.x - 60 / z, y: welcome.y - 90 / z, zoom: z })
      const cards = els.filter((e) => e.frameId === welcome.id && e.type === 'rectangle')
      expect(cards).toHaveLength(3)
      for (const card of cards) {
        const ratio = await inkContrast(a.page, await middle(card, 0.2, 0.15))
        expect(ratio, `${card.id} words against the card, ${mode}`).toBeGreaterThanOrEqual(4.5)
      }
      // the Welcome frame filling the view, for the screenshot
      const tl = await sceneToScreen(a.page, { x: welcome.x, y: welcome.y })
      const br = await sceneToScreen(a.page, { x: welcome.x + welcome.width, y: welcome.y + welcome.height })
      await a.page.screenshot({
        path: testInfo.outputPath(`k4-welcome-${mode}.png`),
        clip: { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y },
      })
      await testInfo.attach(`k4-welcome-${mode}.png`, {
        path: testInfo.outputPath(`k4-welcome-${mode}.png`),
        contentType: 'image/png',
      })
    })
  }
})
