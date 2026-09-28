import { inflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'
import { watchPage } from '../support/watch.ts'
import { addNote, elements, lab, openLab, resetLab, toClient, waitEditor } from './host-kit.ts'

// A5 (docs/EXCALIDRAW-MIGRATION.md §8.2, §2.3.2): `ui={false}` hides Excalidraw's UI; Lobby's minimal
// toolbar (host-lab ?toolbar=1) drives the tools. Pass: a visual pin test.
//
// Which pin, and why: a DOM assertion (primary) plus a baseline-free pixel check, not a screenshot
// compared with a committed baseline. A baseline PNG is brittle across GPU, font hinting and OS (the
// suite also runs in CI and on a laptop), needs binary files in the repo and re-approval on every
// Excalidraw bump, and when it fails it does not say what appeared. The DOM assertion names the element
// that became visible; the pixel check needs no baseline: with an empty scene every pixel outside
// Lobby's toolbar must be the canvas background, so ANY painted Excalidraw control fails it.

const EXCALIDRAW_UI = [
  '.App-toolbar',
  '.App-toolbar-content',
  '.App-menu',
  '.App-menu_top',
  '.App-bottom-bar',
  '.main-menu-trigger',
  '.dropdown-menu',
  '.layer-ui__library',
  '.library-menu',
  '.sidebar-trigger',
  '.default-sidebar-trigger',
  '.sidebar',
  '.zoom-actions',
  '.undo-redo-buttons',
  '.help-icon',
  '.welcome-screen-center',
  '.welcome-screen-decor',
  '.HintViewer',
  '.Island',
  '.ToolIcon',
  '.footer-center',
  '.layer-ui__wrapper__footer-left',
  '.layer-ui__wrapper__footer-right',
  '.excalidraw-button',
  '.UserList',
  '.Stats',
  '.context-menu',
  '.popover',
  '.selected-shape-actions',
  '.compact-shape-actions-island',
  '.mobile-toolbar',
  '.hyperlink',
  '[data-testid="main-menu-trigger"]',
]

/** Visible elements inside Excalidraw's container that draw or accept anything, canvases excepted. */
async function visibleUi(page: Page) {
  return page.evaluate((selectors) => {
    const root = document.querySelector('.excalidraw')
    if (!root) throw new Error('no .excalidraw')
    const isVisible = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      const s = getComputedStyle(el)
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0
    }
    const painted = (el: Element) => {
      const s = getComputedStyle(el)
      const bg = s.backgroundColor
      const hasBg = bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
      const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(
        (side) => Number.parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
      )
      const text = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())
      const interactive = el.matches('button, input, select, textarea, a[href], [role=button], [role=menu]')
      // An <svg> counts only if it draws something (Excalidraw's full-size, empty SVG layer for laser
      // and eraser trails, div.SVGLayer > svg, draws nothing until a trail exists).
      const graphic =
        el.matches('img') ||
        (el.matches('svg') &&
          !!el.querySelector('path, rect, circle, ellipse, line, polyline, polygon, use, text, image'))
      return hasBg || hasBorder || text || interactive || graphic || s.boxShadow !== 'none'
    }
    const found: string[] = []
    const emptySvgs: string[] = []
    for (const el of root.querySelectorAll('*')) {
      if (el.matches('canvas.excalidraw__canvas')) continue
      if (el.matches('textarea.excalidraw-wysiwyg')) continue // Lobby's text editing surface, allowed
      if (el.closest('svg') && !el.matches('svg')) continue
      const name = `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(' ').filter(Boolean).join('.')}`
      if (isVisible(el) && painted(el)) found.push(name)
      else if (isVisible(el) && el.matches('svg'))
        emptySvgs.push(`${el.parentElement?.className ?? ''} > ${name}`)
    }
    const bySelector = Object.fromEntries(
      selectors.map((sel) => [sel, [...document.querySelectorAll(sel)].filter(isVisible).length]),
    )
    return { found, bySelector, emptySvgs }
  }, EXCALIDRAW_UI)
}

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced: what Chromium's screenshots are). */
function decodePng(buf: Buffer): { width: number; height: number; px: (x: number, y: number) => number[] } {
  let off = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG')
      colorType = data[9] ?? 0
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!bpp) throw new Error(`unsupported PNG color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] ?? 0
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (out[y * stride + x - bpp] ?? 0) : 0
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0
      const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] ?? 0) : 0
      const v = raw[src + x] ?? 0
      let r: number
      if (f === 0) r = v
      else if (f === 1) r = v + a
      else if (f === 2) r = v + b
      else if (f === 3) r = v + ((a + b) >> 1)
      else {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      out[y * stride + x] = r & 0xff
    }
  }
  return {
    width,
    height,
    px: (x, y) => [...out.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)],
  }
}

const settle = (page: Page, ms = 150) =>
  page.evaluate(
    (t) =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(), t))),
      ),
    ms,
  )

test.describe('A5: ui={false} hides Excalidraw UI; Lobby toolbar drives tools', () => {
  test('DOM pin: no Excalidraw toolbar, menu, library, footer or popup is visible in any state', async ({
    page,
  }) => {
    const watch = watchPage(page)
    await openLab(page, { toolbar: true, grant: 30 })
    const states: Record<string, unknown> = {}
    await resetLab(page)
    states.empty = await visibleUi(page)
    const ids = await addNote(page, { x: 200, y: 160, size: 200, text: 'Selected' })
    await lab(page, (x) =>
      x.fixture.add([
        {
          type: 'line',
          id: 'ln',
          x: 520,
          y: 200,
          points: [
            [0, 0],
            [160, 40],
          ],
        },
      ]),
    )
    const body = await toClient(page, 220, 180)
    await page.mouse.click(body.x, body.y) // a selected note: the default UI would show shape actions
    await settle(page)
    states.noteSelected = await visibleUi(page)
    await page.keyboard.press('Enter') // the text editor open (default UI: text properties)
    await waitEditor(page, (e) => e.phase === 'open')
    states.editorOpen = await visibleUi(page)
    await page.keyboard.press('Escape')
    await waitEditor(page, (e) => e.phase === 'idle')
    const lp = await toClient(page, 600, 220)
    await page.mouse.dblclick(lp.x, lp.y) // the line in its linear editor
    await settle(page)
    states.linearEditor = await visibleUi(page)
    await page.keyboard.press('Escape')
    await page.mouse.click(body.x, body.y, { button: 'right' }) // Excalidraw's context menu would open
    await settle(page)
    states.rightClick = await visibleUi(page)
    await page.setViewportSize({ width: 390, height: 844 }) // phone form factor: Excalidraw's mobile UI
    await settle(page, 300)
    await page.mouse.click(20, 400)
    await settle(page)
    states.phone = await visibleUi(page)
    console.log('A5-DOM', JSON.stringify({ states, ids }))
    for (const [name, s] of Object.entries(states) as [string, Awaited<ReturnType<typeof visibleUi>>][]) {
      expect(s.found, `${name}: visible Excalidraw UI`).toEqual([])
      for (const [sel, n] of Object.entries(s.bySelector)) expect(n, `${name}: ${sel}`).toBe(0)
    }
    expect(watch.pageErrors).toEqual([])
  })

  test("pixel pin (no baseline): with an empty scene every pixel outside Lobby's toolbar is the canvas background", async ({
    page,
  }) => {
    await openLab(page, { toolbar: true })
    await resetLab(page)
    await page.mouse.move(5, 5)
    await settle(page, 300)
    const bar = await page.getByTestId('lobby-toolbar').boundingBox()
    const bg = await page.evaluate(() => window.__lobbySpike?.api?.getAppState().viewBackgroundColor)
    if (!bar || typeof bg !== 'string') throw new Error('no toolbar or background')
    const shot = decodePng(await page.screenshot({ scale: 'css' }))
    const want = [1, 3, 5].map((i) => Number.parseInt(bg.slice(i, i + 2), 16))
    let off = 0
    let first: unknown = null
    for (let y = 0; y < shot.height; y++) {
      for (let x = 0; x < shot.width; x++) {
        const inBar =
          x >= bar.x - 1 && x <= bar.x + bar.width + 1 && y >= bar.y - 1 && y <= bar.y + bar.height + 1
        if (inBar) continue
        const p = shot.px(x, y)
        if (p.some((c, i) => Math.abs(c - (want[i] ?? 0)) > 2)) {
          off++
          first ??= { x, y, p }
        }
      }
    }
    console.log(
      'A5-PIXELS',
      JSON.stringify({ size: [shot.width, shot.height], bar, bg, offPixels: off, first }),
    )
    expect(off).toBe(0)
  })

  test("Lobby's toolbar drives the tools: each button sets its tool; shape, note, text and comment work", async ({
    page,
  }) => {
    await openLab(page, { toolbar: true, grant: 30 })
    await resetLab(page)
    const expectTool: Record<string, string> = {
      select: 'selection:',
      hand: 'hand:',
      note: 'custom:lobby-note',
      text: 'custom:lobby-text',
      rectangle: 'rectangle:',
      arrow: 'arrow:',
      freedraw: 'freedraw:',
      frame: 'frame:',
      comment: 'custom:lobby-comment',
    }
    const seen: Record<string, unknown> = {}
    for (const [tool, want] of Object.entries(expectTool)) {
      await page.locator(`[data-tool="${tool}"]`).click()
      await expect.poll(() => lab(page, (x) => x.appSnap().activeTool)).toBe(want)
      await expect(page.locator(`[data-tool="${tool}"]`)).toHaveAttribute('aria-pressed', 'true')
      seen[tool] = want
    }
    // Shape: drag on the canvas makes a rectangle (Excalidraw's own tool, chosen by Lobby).
    await page.locator('[data-tool="rectangle"]').click()
    const a = await toClient(page, 120, 400)
    const b = await toClient(page, 260, 500)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await elements(page)).filter((e) => e.type === 'rectangle').length).toBe(1)
    // Note: a click places a created-null note and opens it at once (the New element rule).
    await page.locator('[data-tool="note"]').click()
    const n = await toClient(page, 500, 300)
    await page.mouse.click(n.x, n.y)
    await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused)
    await page.keyboard.type('from toolbar')
    await page.keyboard.press('Escape')
    await waitEditor(page, (e) => e.phase === 'idle')
    // Text: a click on empty canvas places a text and opens it.
    await page.locator('[data-tool="text"]').click()
    const t = await toClient(page, 300, 650)
    await page.mouse.click(t.x, t.y)
    await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused)
    await page.keyboard.type('free text')
    await page.keyboard.press('Escape')
    await waitEditor(page, (e) => e.phase === 'idle')
    // Comment: Lobby's custom tool gets the click, Excalidraw creates nothing.
    await page.locator('[data-tool="comment"]').click()
    const before = (await elements(page)).length
    const c = await toClient(page, 800, 600)
    await page.mouse.click(c.x, c.y)
    await settle(page)
    const els = await elements(page)
    const notes = els.filter((e) => e.type === 'stickynote')
    const texts = els.filter((e) => e.type === 'text' && !e.isDeleted)
    const clicks = await lab(page, (x) => x.customClicks.map((k: { tool: string }) => k.tool))
    console.log(
      'A5-TOOLBAR',
      JSON.stringify({
        seen,
        rectangles: els.filter((e) => e.type === 'rectangle').length,
        notes: notes.map((e) => ({ created: e.created })),
        texts: texts.map((e) => e.originalText),
        clicks,
      }),
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]?.created).toBeNull()
    expect(texts.map((e) => e.originalText).sort()).toEqual(['free text', 'from toolbar'])
    expect(clicks.at(-1)).toBe('comment')
    expect((await elements(page)).length).toBe(before)
  })
})
