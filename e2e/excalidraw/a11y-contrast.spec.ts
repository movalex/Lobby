// OWNER: 3i. Contrast as the board actually draws it (the early wave-5 review,
// docs/research/excalidraw/REVIEW-W5-EARLY.md W5-10 and W5-15; 2C fixes the engine theme in the host, 3i owns
// these checks). The unit test canvas/a11y/palette-contrast.test.ts computes the palette's ratios through
// Excalidraw's dark filter; these read the rendered pixels instead, so they hold whatever way the theme is
// drawn (a filter, mapped colours, a canvas colour):
//  - W5-10: a frame's name meets 4.5:1 and its outline 3:1 against the canvas, in light and dark mode; the
//    light canvas is #f9fafb (tldraw's), so a frame (white) stands out from it;
//  - W5-15: in dark mode the ink of every one of the 13 note colours meets 4.5:1 on its fill, and an explicit
//    colour that is not Lobby's palette is drawn as it is (not inverted).
// Each test waited for 2C's theme as an expected failure; the theme (canvas/engine/theme.ts) was merged at the
// wave-5 engine integration, and the marks are off.
//
// How a ratio is read: a screenshot of a small box at device scale 2 (text strokes cover whole pixels),
// decoded in the page; the background is the box's most common colour, the ink the pixel with the most
// contrast against it.
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  expect,
  expectSaved,
  sceneToScreen,
  setViewport,
  test,
} from '../tests/support/canvas.ts'
import { waitForA11y, withCanvas } from './a11y-kit.ts'

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })

interface Rgb {
  r: number
  g: number
  b: number
}
interface Box {
  x: number
  y: number
  width: number
  height: number
}

const lum = ({ r, g, b }: Rgb) => {
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const hex = ({ r, g, b }: Rgb) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

/** The pixels of a screen box (CSS px), decoded in the page: device pixels, row by row. */
async function pixels(page: Page, box: Box): Promise<Rgb[]> {
  const png = await page.screenshot({ clip: box, scale: 'device', animations: 'disabled' })
  const data = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    g.drawImage(bmp, 0, 0)
    return Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data)
  }, png.toString('base64'))
  const out: Rgb[] = []
  for (let i = 0; i < data.length; i += 4)
    out.push({ r: data[i] as number, g: data[i + 1] as number, b: data[i + 2] as number })
  return out
}

/** The box's background (its most common colour) and ink (the pixel with the most contrast against it). */
async function inkOn(page: Page, box: Box): Promise<{ bg: Rgb; ink: Rgb; ratio: number }> {
  const px = await pixels(page, box)
  const counts = new Map<string, { c: Rgb; n: number }>()
  for (const p of px) {
    const k = hex(p)
    const e = counts.get(k)
    if (e) e.n++
    else counts.set(k, { c: p, n: 1 })
  }
  const bg = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.c as Rgb
  let ink = bg
  for (const p of px) if (ratio(p, bg) > ratio(ink, bg)) ink = p
  return { bg, ink, ratio: Number(ratio(ink, bg).toFixed(2)) }
}

/** The most common colour of a box. */
async function colourOf(page: Page, box: Box): Promise<Rgb> {
  return (await inkOn(page, box)).bg
}

/** A frame at the scene origin, at zoom 1 with the origin 150 px in from the canvas's corner. */
async function frameOnScreen(page: Page, name: string) {
  const id = await createItem(page, 'frame', { x: 0, y: 0, width: 640, height: 360, name })
  await expectSaved(page)
  await setViewport(page, { x: -150, y: -150, zoom: 1 })
  await page.waitForTimeout(300)
  const tl = await sceneToScreen(page, { x: 0, y: 0 })
  return { id, tl }
}

async function setTheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme })
  await expect.poll(() => withCanvas(page, (c) => c.theme(), null)).toBe(scheme)
  await page.waitForTimeout(300)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`W5-10 (${scheme}): a frame's name reads at 4.5:1 and its outline at 3:1 against the canvas`, async ({
    canvasSession,
  }, testInfo) => {
    const a = await canvasSession('alice')
    await waitForA11y(a.page)
    await setTheme(a.page, scheme)
    const { tl } = await frameOnScreen(a.page, 'Contrast check')
    // the name is drawn just above the frame's top-left corner
    const name = await inkOn(a.page, { x: tl.x, y: tl.y - 26, width: 200, height: 22 })
    // the outline: a strip across the frame's left edge, half-way down
    const edge = await inkOn(a.page, { x: tl.x - 8, y: tl.y + 160, width: 16, height: 8 })
    testInfo.annotations.push({
      type: 'contrast',
      description: `${scheme}: name ${hex(name.ink)} on ${hex(name.bg)} ${name.ratio}:1; outline ${hex(edge.ink)} on ${hex(edge.bg)} ${edge.ratio}:1`,
    })
    expect(name.ratio, `frame name ${hex(name.ink)} on ${hex(name.bg)}`).toBeGreaterThanOrEqual(4.5)
    expect(edge.ratio, `frame outline ${hex(edge.ink)} on ${hex(edge.bg)}`).toBeGreaterThanOrEqual(3)
  })
}

test('W5-10: the light canvas is #f9fafb, so a white frame or card stands out from it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await setTheme(a.page, 'light')
  await frameOnScreen(a.page, 'Canvas colour')
  const c = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!c) throw new Error('no canvas')
  // empty canvas, right of the frame (the frame is at x 150..790 of the canvas)
  const bg = await colourOf(a.page, {
    x: c.x + c.width - 120,
    y: c.y + c.height - 140,
    width: 40,
    height: 40,
  })
  expect(hex(bg)).toBe('#f9fafb')
})

test('W5-15: in dark mode the ink of every note colour reads at 4.5:1 on its fill', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  // the 13 note colours (board-ops elements/palette.ts NOTE_FILL), one note each, two rows
  const fills: Record<string, string> = {
    black: '#f8e48f',
    yellow: '#f6c453',
    orange: '#f4a874',
    'light-red': '#f6bfc4',
    red: '#ef8c82',
    'light-violet': '#e3c9f4',
    violet: '#c5a4ea',
    blue: '#a7b7f6',
    'light-blue': '#a6d8f3',
    green: '#93cfa6',
    'light-green': '#cde7a2',
    grey: '#d6d9de',
    white: '#ffffff',
  }
  const names = Object.keys(fills)
  const ids: Record<string, string> = {}
  for (const [i, n] of names.entries()) {
    ids[n] = await createNote(a.page, {
      x: (i % 7) * 170,
      y: Math.floor(i / 7) * 190,
      size: 150,
      text: 'Ag Ag',
      color: fills[n] as string,
    })
    await expectSaved(a.page)
  }
  await expectSaved(a.page)
  await setViewport(a.page, { x: -40, y: -40, zoom: 1 })
  await setTheme(a.page, 'dark')
  const low: string[] = []
  const seen: string[] = []
  for (const n of names) {
    const b = await withCanvas(a.page, (c, id) => c.bounds(id), ids[n] as string)
    if (!b) throw new Error(`no note ${n}`)
    const tl = await sceneToScreen(a.page, { x: b.x, y: b.y })
    // the label sits in the note's middle; the box is wholly inside the note
    const m = await inkOn(a.page, { x: tl.x + 20, y: tl.y + 55, width: 110, height: 40 })
    seen.push(`${n} ${hex(m.ink)} on ${hex(m.bg)} ${m.ratio}:1`)
    if (m.ratio < 4.5) low.push(`${n} ${m.ratio}:1`)
  }
  testInfo.annotations.push({ type: 'contrast', description: seen.join('; ') })
  expect(low).toEqual([])
})

test('W5-15: in dark mode a colour that is not Lobby’s palette is drawn as it is', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const teal = '#127a8a'
  const id = await createItem(a.page, 'rectangle', {
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    backgroundColor: teal,
    fillStyle: 'solid',
  })
  await expectSaved(a.page)
  await setViewport(a.page, { x: -100, y: -100, zoom: 1 })
  await setTheme(a.page, 'dark')
  const b = await withCanvas(a.page, (c, x) => c.bounds(x), id)
  if (!b) throw new Error('no rectangle')
  const tl = await sceneToScreen(a.page, { x: b.x, y: b.y })
  const fill = await colourOf(a.page, { x: tl.x + 100, y: tl.y + 70, width: 60, height: 40 })
  const d = Math.max(Math.abs(fill.r - 0x12), Math.abs(fill.g - 0x7a), Math.abs(fill.b - 0x8a))
  expect(d, `${teal} drawn as ${hex(fill)}`).toBeLessThanOrEqual(6)
})
