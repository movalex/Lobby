// Wave M (M1-5; the first-time scout's FTU-9): in dark mode, a note whose fill is not one of Lobby's 13 swatches
// (Excalidraw's standard pastels, as a paste from excalidraw.com or an import carries them) was drawn with
// near-white ink on the pastel fill. Its label now takes whichever of Lobby's two inks reads better on the fill as
// dark mode draws it (canvas/engine/theme.ts noteInkFor). Read from the rendered pixels, as a11y-contrast.spec.ts
// reads them: a screenshot of a box inside the note at device scale 2, its most common colour the fill, the pixel
// with the most contrast against it the ink.
//  - three pastels (#b2f2bb, #a5d8ff, #ffc9c9) read at 4.5:1 or more in dark mode, and a swatch note still does;
//  - a swatch note recoloured to a pastel while dark (its label unchanged, so its cached drawing must be redrawn)
//    reads too;
//  - rendering only: the stored inks are unchanged and switching the theme pushes nothing.
// Wave N.1: the text editor over such a note (the textarea someone types in) took the same chalk, unreadable on the pastel;
// it now takes the note's ink too, and a swatch note's editor keeps chalk on its designed dark fill.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m1-dark-notes.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  createNote,
  expect,
  expectSaved,
  item,
  pushedOps,
  sceneToScreen,
  setViewport,
  startTextEditing,
  stopTextEditing,
  TEXT_EDITOR,
  test,
  updateItem,
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

/** The box's fill (its most common colour) and ink (the pixel with the most contrast against it). */
async function inkOn(page: Page, box: Box): Promise<{ bg: Rgb; ink: Rgb; ratio: number }> {
  const png = await page.screenshot({ clip: box, scale: 'device', animations: 'disabled' })
  const data = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    g.drawImage(bmp, 0, 0)
    return Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data)
  }, png.toString('base64'))
  const px: Rgb[] = []
  for (let i = 0; i < data.length; i += 4)
    px.push({ r: data[i] as number, g: data[i + 1] as number, b: data[i + 2] as number })
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

async function setTheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme })
  await expect.poll(() => withCanvas(page, (c) => c.theme(), null)).toBe(scheme)
  await page.waitForTimeout(300)
}

/** The label's contrast on its note, read from a box inside the note's middle (where the label sits). */
async function labelContrast(page: Page, id: string) {
  const b = await withCanvas(page, (c, x) => c.bounds(x), id)
  if (!b) throw new Error(`no note ${id}`)
  const tl = await sceneToScreen(page, { x: b.x, y: b.y })
  return inkOn(page, { x: tl.x + 20, y: tl.y + 55, width: 110, height: 40 })
}

/** The stored ink of a note's label. */
const labelInk = (page: Page, id: string) =>
  withCanvas(
    page,
    (c, x) => {
      const n = c.get(x) as { boundElements?: { id: string; type: string }[] | null } | undefined
      const t = n?.boundElements?.find((e) => e.type === 'text')
      return t ? ((c.get(t.id) as { strokeColor?: string } | undefined)?.strokeColor ?? null) : null
    },
    id,
  )

test('M1-5 (FTU-9): in dark mode, notes of off-palette pastels read at 4.5:1 or more; a swatch note still does; recolouring one while dark redraws its label; nothing is written', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const fills = { mint: '#b2f2bb', sky: '#a5d8ff', rose: '#ffc9c9', swatch: '#a6d8f3' } as const
  const ids: Record<string, string> = {}
  for (const [i, [name, color]] of Object.entries(fills).entries()) {
    ids[name] = await createNote(a.page, { x: i * 190, y: 0, size: 150, text: 'Ag Ag', color })
    await expectSaved(a.page)
  }
  // the control that recolours: a swatch note (Butter) that becomes a pastel while dark
  ids.recoloured = await createNote(a.page, { x: 0, y: 220, size: 150, text: 'Ag Ag', color: '#f8e48f' })
  await expectSaved(a.page)
  await setViewport(a.page, { x: -40, y: -40, zoom: 1 })
  const inksBefore = await Promise.all(Object.values(ids).map((id) => labelInk(a.page, id)))

  await setTheme(a.page, 'light')
  const pushedLight = (await pushedOps(a.page)).length
  await setTheme(a.page, 'dark')
  // a first frame drawn in dark mode for the recoloured note's label (its cached drawing then exists)
  const seen: string[] = []
  const low: string[] = []
  const check = async (name: string) => {
    const m = await labelContrast(a.page, ids[name] as string)
    seen.push(`${name} ${hex(m.ink)} on ${hex(m.bg)} ${m.ratio}:1`)
    if (m.ratio < 4.5) low.push(`${name} ${m.ratio}:1`)
    return m
  }
  for (const name of Object.keys(fills)) await check(name)
  await check('recoloured')

  // recoloured while dark: a fill write on the note only (its label is the same element)
  await updateItem(a.page, ids.recoloured as string, { backgroundColor: '#ffc9c9' })
  await expectSaved(a.page)
  await a.page.waitForTimeout(300)
  const after = await check('recoloured')
  // the fill really is the pastel now, drawn as it is (not the swatch's designed dark fill)
  expect(
    Math.abs(after.bg.r - 0xff) + Math.abs(after.bg.g - 0xc9) + Math.abs(after.bg.b - 0xc9),
  ).toBeLessThan(24)
  testInfo.annotations.push({ type: 'contrast', description: seen.join('; ') })
  console.log(`M1-5 contrast (dark): ${seen.join('; ')}`)
  await a.page.screenshot({ path: testInfo.outputPath('m1-5-dark-notes.png') })
  expect(low).toEqual([])

  // rendering only: the stored inks are what they were, and switching the theme pushed nothing (the one fill
  // write above is the only push)
  expect(await Promise.all(Object.values(ids).map((id) => labelInk(a.page, id)))).toEqual(inksBefore)
  const touched = (await pushedOps(a.page))
    .slice(pushedLight)
    .flatMap((p) => p.ops.map((o) => (o.k === 'p' ? o.id : o.el.id)))
  expect([...new Set(touched)]).toEqual([ids.recoloured])
  expect((await item(a.page, ids.recoloured as string))?.backgroundColor).toBe('#ffc9c9')
})

const parseRgb = (css: string): Rgb => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css)
  if (!m) throw new Error(`not a colour: ${css}`)
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
}

test('wave N.1: in dark mode the text editor over a pastel note reads at 4.5:1 or more on the note; a swatch note’s editor keeps chalk on its dark fill', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const mint = await createNote(a.page, { x: 0, y: 0, size: 150, text: 'Ag Ag', color: '#b2f2bb' })
  await expectSaved(a.page)
  const swatch = await createNote(a.page, { x: 220, y: 0, size: 150, text: 'Ag Ag', color: '#a6d8f3' })
  await expectSaved(a.page)
  await setViewport(a.page, { x: -40, y: -40, zoom: 1 })
  await setTheme(a.page, 'dark')

  const seen: string[] = []
  const editorRatio = async (id: string) => {
    await startTextEditing(a.page, id)
    // the editor's colour, and the note's fill as dark mode draws it (read where no text is: the note's corner)
    const color = parseRgb(await a.page.locator(TEXT_EDITOR).evaluate((el) => getComputedStyle(el).color))
    const b = await withCanvas(a.page, (c, x) => c.bounds(x), id)
    if (!b) throw new Error(`no note ${id}`)
    const tl = await sceneToScreen(a.page, { x: b.x, y: b.y })
    const fill = (await inkOn(a.page, { x: tl.x + 6, y: tl.y + 6, width: 8, height: 8 })).bg
    const r = Number(ratio(color, fill).toFixed(2))
    seen.push(`${hex(color)} on ${hex(fill)} ${r}:1`)
    await a.page.screenshot({ path: testInfo.outputPath(`m1-editor-${id}.png`) })
    await stopTextEditing(a.page)
    return { r, color, fill }
  }

  const pastel = await editorRatio(mint)
  // the fill is the pastel as it is, and the editor reads on it
  expect(
    Math.abs(pastel.fill.r - 0xb2) + Math.abs(pastel.fill.g - 0xf2) + Math.abs(pastel.fill.b - 0xbb),
  ).toBeLessThan(24)
  expect(pastel.r, seen.join('; ')).toBeGreaterThanOrEqual(4.5)
  // a swatch note: chalk on its designed dark fill (it read before, and still does)
  const swatchEditor = await editorRatio(swatch)
  expect(swatchEditor.r, seen.join('; ')).toBeGreaterThanOrEqual(4.5)
  expect(hex(swatchEditor.color)).toBe('#f4f1ea')
  console.log(`N.1 editor contrast (dark): ${seen.join('; ')}`)
})
