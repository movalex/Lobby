// present-export's exports on the Excalidraw board page (wave 3e; the port of
// ../tests/present-export.spec.ts "image exports", "PDF export" and "CSV export": PRS-05 PNG/SVG + copy
// as PNG, PRS-06 PDF, CSV). Exports are checked as FILES: the PNG signature, IHDR size, pHYs and a real
// pixel; the SVG root element and the image embedded in it; the PDF's pages, page sizes, bookmarks and
// page images (pdf-lib) and its text layer (pdf.js); the CSV's bytes. Where a request matters (originals,
// never the canvas previews) the network log is asserted.
//
// Differences from the tldraw spec (docs/research/excalidraw/wave3/3E.md):
//  - a whole-board PNG is the content plus the 32 px margin in width; in height it also holds the frame
//    names the engine draws above frames (the tldraw export drew them inside the margin);
//  - the context menu is 3a's Lobby menu (the same test ids as tldraw's), on the ported entries;
//  - ids are element ids (no `shape:` prefix), and the CSV's note colours come from the stored fill.
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { waitForValue } from '../tests/support/board.ts'
import {
  canvasCall,
  clickItem,
  createItem,
  deleteItem,
  expect,
  expectSaved,
  itemBounds,
  select,
  selection,
  selectNone,
  test,
  waitForCanvas,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { storedElement } from '../tests/support/excalidraw.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import {
  collectDownloads,
  DERIVATIVE_PATH,
  downloadFrom,
  isFileRequest,
  nextFrames,
  ORIGINAL_PATH,
  parseCsv,
  pdfPageTexts,
  readClipboard,
  readPdf,
  readPng,
  svgEmbeddedImages,
  svgRootName,
  trackRequests,
  watchTestId,
  writeClipboardText,
} from '../tests/support/present-export.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import type { Users } from '../tests/support/users.ts'
import { workshopState } from '../tests/support/workshops.ts'
import { emptyCanvasPoint } from './board-kit.ts'
import { cardItems, fileCard, insertFiles } from './media-kit.ts'
import {
  type DeckSpec,
  expectItems,
  NOTE_FILL,
  openBoardExport,
  placeUploadedImage,
  pngRegionStats,
  type Rgb,
  seedDeck,
} from './present-kit.ts'

const F = { intro: 'pe-intro', backstage: 'pe-backstage', plan: 'pe-plan' }
const N = { intro: 'pe-note-intro', plan: 'pe-note-plan' }
const INTRO = { id: F.intro, name: 'Intro', x: 0, y: 0, w: 800, h: 600 }

const DECK: DeckSpec = {
  frames: [
    INTRO,
    { id: F.backstage, name: 'Backstage', x: 1000, y: 0, w: 720, h: 540, skip: true },
    { id: F.plan, name: 'Plan', x: 2000, y: 0, w: 640, h: 480 },
  ],
  notes: [
    { id: N.intro, frame: F.intro, x: 300, y: 200, text: 'Kickoff agenda' },
    { id: N.plan, frame: F.plan, x: 220, y: 140, text: 'Launch checklist', color: NOTE_FILL.blue },
  ],
}

const boardTitle = async (users: Users, board: string) =>
  (await (await users.api('alice')).getBoard(board)).board.title

/** pHYs value for an N× PNG: N × 72 dpi in pixels per metre. */
const ppm = (scale: number) => Math.round((scale * 72) / 0.0254)

/** The union of elements' bounds (scene), as the dialog's selection area. */
async function unionBounds(page: Page, ids: string[]) {
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const id of ids) {
    const b = await itemBounds(page, id)
    if (!b) continue
    x1 = Math.min(x1, b.x)
    y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.width)
    y2 = Math.max(y2, b.y + b.height)
  }
  return { w: x2 - x1, h: y2 - y1 }
}

test.describe('image exports', () => {
  test('PNG and SVG export: a frame at 2× drawn from the original upload, a transparent selection, the whole board, and an SVG embedding the original', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const title = await boardTitle(users, board)
    await seedDeck(a.page, DECK)
    await placeUploadedImage(a.page, users, board, INTRO, { x: 40, y: 330, w: 400, h: 225 })
    await zoomToFit(a.page)
    const files = trackRequests(a.page, isFileRequest)
    const dialog = a.page.getByTestId('export-dialog')

    await openBoardExport(a.page, { expand: true })
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('export-frame').selectOption(F.intro)
    await expect(dialog.getByTestId('export-area-frame')).toBeChecked()
    await dialog.getByTestId('export-scale').selectOption('2')
    await expect(dialog.getByTestId('export-size-hint')).toHaveText('PNG size: about 1,600 × 1,200 px')

    await test.step('frame PNG at 2×: exact size, opaque, marked 2×, from the original upload', async () => {
      const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(png.name).toBe(`${title} - Intro.png`)
      const info = readPng(png.bytes)
      expect({ w: info.width, h: info.height }).toEqual({ w: 1600, h: 1200 })
      expect(info.topLeft?.[3]).toBe(255)
      // One pHYs chunk (the PNG spec allows at most one) saying 2× of 72 dpi.
      expect(info.pixelsPerMetre).toEqual([ppm(2)])
      await expect(dialog.getByTestId('export-status')).toHaveText(`Downloaded “${title} - Intro.png”.`)
      // The export fetched the uploaded original, never a canvas preview.
      expect(files.paths()).toContainEqual(expect.stringMatching(ORIGINAL_PATH))
      expect(files.paths().filter((p) => !ORIGINAL_PATH.test(p))).toEqual([])
    })

    await test.step('F15: frame SVG embeds the board preview by default (after a PNG from the original)', async () => {
      await expect(dialog.getByTestId('export-svg-originals')).not.toBeChecked()
      const svg = await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())
      expect(svg.name).toBe(`${title} - Intro.svg`)
      const text = svg.bytes.toString('utf8')
      expect(svgRootName(text)).toBe('svg')
      const embedded = svgEmbeddedImages(text)
      expect(embedded.map((e) => e.mime)).toEqual(['image/webp']) // the preview derivative, not the PNG
      // W5-37: the frame's note has tldraw's soft export shadow, not the engine's hard offset copy
      // (fill-opacity 0.16) and 1 px edge (stroke-opacity 0.08)
      expect(text).toMatch(/<path filter="url\(#lobby-note-shadow\)"[^>]* fill="#f6c453"/)
      expect(text).toContain('<filter id="lobby-note-shadow"')
      expect(text).not.toMatch(/fill-opacity="0\.16"|stroke-opacity="0\.08"/)
      expect(files.paths()).toContainEqual(expect.stringMatching(DERIVATIVE_PATH))
      files.clear()
    })

    await test.step('frame SVG with "embed the original uploads": the original 1920×1080 PNG', async () => {
      await dialog.getByTestId('export-svg-originals').check()
      const svg = await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())
      const embedded = svgEmbeddedImages(svg.bytes.toString('utf8'))
      const png = embedded.find((e) => e.mime === 'image/png')
      expect(png, `embedded images: ${embedded.map((e) => e.mime).join(', ')}`).toBeDefined()
      const info = readPng(png?.bytes ?? Buffer.alloc(0))
      expect({ w: info.width, h: info.height }).toEqual({ w: 1920, h: 1080 })
      expect(embedded.some((e) => e.mime === 'image/webp')).toBe(false)
      expect(files.paths().filter((p) => DERIVATIVE_PATH.test(p))).toEqual([])
    })

    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await test.step('selection PNG: transparent where nothing is drawn, opaque without the option', async () => {
      // Two notes on a diagonal: the selection's top-left corner is empty board.
      await select(a.page, [N.intro, N.plan])
      const sel = await unionBounds(a.page, [N.intro, N.plan])
      await openBoardExport(a.page, { expand: true })
      await expect(dialog.getByTestId('export-area-selection')).toBeChecked()
      await expect(dialog.getByTestId('export-scale')).toHaveValue('2') // remembered
      await dialog.getByTestId('export-transparent').check()
      const clear = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(clear.name).toBe(`${title} - selection.png`)
      const info = readPng(clear.bytes)
      expect(info.colorType).toBe(6) // RGBA
      expect(info.topLeft?.[3]).toBe(0)
      // F15: 2× the selection plus a 32 px margin on every side.
      expect(info.width).toBeGreaterThanOrEqual(Math.floor((sel.w + 64) * 2) - 1)
      expect(info.width).toBeLessThanOrEqual(Math.ceil((sel.w + 64) * 2) + 1)
      expect(info.height).toBeGreaterThanOrEqual(Math.floor((sel.h + 64) * 2) - 1)
      expect(info.height).toBeLessThanOrEqual(Math.ceil((sel.h + 64) * 2) + 1)

      await dialog.getByTestId('export-transparent').uncheck()
      const opaque = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(readPng(opaque.bytes).topLeft?.[3]).toBe(255)
    })

    await test.step('whole board PNG at 1× and 4× sizes', async () => {
      const all = await unionBounds(
        a.page,
        (await canvasCall(a.page, 'items')).map((e) => e.id),
      )
      await dialog.getByTestId('export-area-board').check()
      await dialog.getByTestId('export-scale').selectOption('1')
      const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(png.name).toBe(`${title}.png`)
      const info = readPng(png.bytes)
      // F15: the content plus a 32 px margin on each side; frame names drawn above frames add height.
      expect(info.width).toBeGreaterThanOrEqual(Math.floor(all.w + 64) - 1)
      expect(info.width).toBeLessThanOrEqual(Math.ceil(all.w + 64) + 1)
      expect(info.height).toBeGreaterThanOrEqual(Math.floor(all.h + 64) - 1)
      expect(info.height).toBeLessThanOrEqual(Math.ceil(all.h + 64) + 40)
      expect(info.pixelsPerMetre).toEqual([ppm(1)])

      // 4× of one frame: exact, marked 4×.
      await dialog.getByTestId('export-frame').selectOption(F.plan)
      await dialog.getByTestId('export-scale').selectOption('4')
      const big = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(big.name).toBe(`${title} - Plan.png`)
      const bigInfo = readPng(big.bytes)
      expect({ w: bigInfo.width, h: bigInfo.height }).toEqual({ w: 2560, h: 1920 })
      expect(bigInfo.pixelsPerMetre).toEqual([ppm(4)])
    })
    expect(files.paths().filter((p) => DERIVATIVE_PATH.test(p))).toEqual([])
  })

  // P-026 (wave P): the dialog opens on the whole board (the selection when there is one), in plain words, with the
  // size and page options folded; a frame's file is named after the frame, not its number in the deck.
  test('P-026: opens on the whole board with the options folded, in plain words; the selection when there is one; a frame file is named after the frame', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const title = await boardTitle(users, board)
    await seedDeck(a.page, DECK)
    // the camera on one frame: it used to be the frame in view that the image export opened on
    await zoomToFit(a.page)
    const dialog = a.page.getByTestId('export-dialog')

    await openBoardExport(a.page)
    await expect(dialog.getByTestId('export-area-board')).toBeChecked()
    await expect(dialog.getByTestId('export-area-frame')).not.toBeChecked()
    await expect(dialog.getByTestId('export-area-selection')).toBeDisabled()
    // folded: the size and the page options are one click away, their summaries say the setting
    await expect(dialog.getByTestId('export-image-options')).not.toHaveAttribute('open', /.*/)
    await expect(dialog.getByTestId('export-pdf-options')).not.toHaveAttribute('open', /.*/)
    await expect(dialog.getByTestId('export-size-hint')).toContainText('PNG size: about')
    await expect(dialog.getByTestId('export-pdf-options-summary')).toContainText('Fit each frame')
    await expect(dialog.getByTestId('export-scale')).toBeHidden()
    await expect(dialog.getByTestId('export-pdf-hint')).toBeHidden()
    // plain words
    const text = (await dialog.textContent()) ?? ''
    for (const jargon of ['Vector', 'vector pages', 'PNG ≈']) expect(text, jargon).not.toContain(jargon)
    await expect(dialog.getByTestId('export-png')).toHaveText('Download PNG')
    await expect(dialog.getByTestId('export-pdf')).toHaveText('Download PDF')
    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await test.step('with something selected it opens on the selection', async () => {
      await select(a.page, [N.intro])
      await openBoardExport(a.page)
      await expect(dialog.getByTestId('export-area-selection')).toBeChecked()
      await a.page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    })

    await test.step('a frame’s file is named after the frame', async () => {
      await openBoardExport(a.page)
      await dialog.getByTestId('export-frame').selectOption(F.intro)
      const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(png.name).toBe(`${title} - Intro.png`)
    })
  })

  // 3a renders the context menu (host slot `contextMenu`) from the registry entries this feature adds
  // ('export-as' → 'export-as-png' / 'export-as-svg'), with tldraw's test ids.
  test('context menu: Export as PNG and SVG go through the same pipeline (board-titled files, 2×, from the original upload)', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const title = await boardTitle(users, board)
    await seedDeck(a.page, DECK)
    const imageId = await placeUploadedImage(a.page, users, board, INTRO, { x: 40, y: 330, w: 400, h: 225 })
    await zoomToFit(a.page)
    await selectNone(a.page)
    const files = trackRequests(a.page, isFileRequest)
    const menu = a.page.getByTestId('context-menu')

    // Right-click the image (selects it and opens the context menu), then Export as → PNG.
    const openExportAs = async () => {
      await clickItem(a.page, imageId, { button: 'right' })
      await expect(menu).toBeVisible()
      await a.page.getByTestId('context-menu-sub.export-as-button').click()
      await expect(a.page.getByTestId('context-menu-sub.export-as-content')).toBeVisible()
    }
    await openExportAs()
    expect(await selection(a.page)).toEqual([imageId])
    const png = await downloadFrom(a.page, () => a.page.getByTestId('context-menu.export-as-png').click())
    await expect(menu).toHaveCount(0)
    expect(png.name).toBe(`${title} - selection.png`)
    const info = readPng(png.bytes)
    // An image is its own export bounds (no padding): exactly 2× its 400×225 board size.
    expect({ w: info.width, h: info.height }).toEqual({ w: 800, h: 450 })
    expect(info.pixelsPerMetre).toEqual([ppm(2)])
    expect(files.paths()).toContainEqual(expect.stringMatching(ORIGINAL_PATH))
    expect(files.paths().filter((p) => !ORIGINAL_PATH.test(p))).toEqual([])
    files.clear()

    await openExportAs()
    const svg = await downloadFrom(a.page, () => a.page.getByTestId('context-menu.export-as-svg').click())
    expect(svg.name).toBe(`${title} - selection.svg`)
    const text = svg.bytes.toString('utf8')
    expect(svgRootName(text)).toBe('svg')
    // F15: the menu's Export as SVG embeds the board preview (the dialog offers the originals).
    expect(svgEmbeddedImages(text).map((e) => e.mime)).toEqual(['image/webp'])
    expect(files.paths().filter((p) => ORIGINAL_PATH.test(p))).toEqual([])

    // Nothing selected: the context menu on empty board has no Export as (the board menu's Export all
    // as covers the board), as on the tldraw page.
    await a.page.keyboard.press('Escape')
    await selectNone(a.page)
    const empty = await emptyCanvasPoint(a.page)
    await a.page.mouse.click(empty.x, empty.y, { button: 'right' })
    await expect(menu).toBeVisible()
    await expect(a.page.getByTestId('context-menu-sub.export-as-button')).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  test('copy as PNG: Ctrl+Shift+C and the dialog button put an image/png of the selection on the clipboard', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
    await seedDeck(a.page, DECK)
    await zoomToFit(a.page)
    const clipboardPng = async () => {
      const clip = await waitForValue(async () => {
        const c = await readClipboard(a.page)
        return c.pngBase64 ? c : null
      })
      expect(clip.types).toContain('image/png')
      return readPng(Buffer.from(clip.pngBase64 ?? '', 'base64'))
    }

    // The user clicks a note and presses Ctrl+Shift+C.
    await clickItem(a.page, N.plan)
    await expect.poll(() => selection(a.page)).toEqual([N.plan])
    await writeClipboardText(a.page, 'not an image yet')
    await a.page.keyboard.press('Control+Shift+C')
    await expect(a.page.getByTestId('copy-png-toast')).toBeVisible()
    const note = await clipboardPng()
    // The note at 2× (200×200 board px), not the whole board.
    expect(note.width).toBeGreaterThanOrEqual(396)
    expect(note.width).toBeLessThanOrEqual(2 * (200 + 64))
    expect(note.height).toBeGreaterThanOrEqual(396)
    expect(note.height).toBeLessThanOrEqual(2 * (200 + 64))

    // The dialog's button, with a frame chosen.
    await writeClipboardText(a.page, 'not an image yet')
    await openBoardExport(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    await dialog.getByTestId('export-frame').selectOption(F.intro)
    await dialog.getByTestId('export-copy-png').click()
    await expect(dialog.getByTestId('export-status')).toHaveText('Copied as PNG. Paste it into any app.')
    const frame = await clipboardPng()
    expect({ w: frame.width, h: frame.height }).toEqual({ w: 1600, h: 1200 })
  })
})

// D3 (REVIEW-W5-EARLY.md §9): template headings get Excalidraw's Lilita One (fontFamily 7), no new fonts
// and no bold. The SVG export embeds the self-hosted face of every family its text uses (Lilita's woff2
// is self-hosted with the others), so nothing in 3e's export changes for it; this check turns green once
// the server's font allowlist takes 7 (2A and the contracts owner: canvas-schema elements.ts; merged at the
// wave-5 engine integration, so the mark is off).
test('D3: an SVG export embeds Lilita One for a heading in fontFamily 7', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const id = await createItem(a.page, 'text', { x: 0, y: 0, text: 'Plan', fontFamily: 7, fontSize: 48 })
  await expect
    .poll(
      async () => ((await storedElement(stack, board, id)) as { fontFamily?: number } | null)?.fontFamily,
      {
        timeout: 10_000,
      },
    )
    .toBe(7)
  await zoomToFit(a.page)
  await openBoardExport(a.page)
  const dialog = a.page.getByTestId('export-dialog')
  const svg = await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())
  expect(svg.bytes.toString('utf8')).toMatch(
    /@font-face \{ font-family: "Lilita One"; src: url\("data:font\/woff2;base64,/,
  )
})

test.describe('file cards in exports', () => {
  const FILES = ['document.pdf', 'video.mp4', 'notes.zip', 'encrypted.pdf'] as const
  /** The footer's kind badge colours (file-card's CSS `.dr-fc__icon--*`). */
  const BADGE: Record<string, Rgb> = { pdf: [179, 38, 30], video: [91, 60, 196], other: [31, 58, 95] }
  const DANGER: Rgb = [163, 33, 26]

  test('W5-14: a board PNG and SVG draw every file card in full: kind badge, name, size and status, the play button and the error, as on the board', async ({
    canvasSession,
  }) => {
    test.setTimeout(240_000)
    const a = await canvasSession('alice')
    await insertFiles(
      a.page,
      FILES.map((f) => join(FIXTURES_DIR, f)),
    )
    for (const name of FILES)
      await expect(fileCard(a.page, name)).toHaveAttribute(
        'data-status',
        name === 'encrypted.pdf' ? 'failed' : 'ready',
        { timeout: 90_000 },
      )
    await zoomToFit(a.page)
    await selectNone(a.page)
    const cards = await cardItems(a.page)
    expect(cards.map((c) => c.facts.name).sort()).toEqual([...FILES].sort())

    const dialog = a.page.getByTestId('export-dialog')
    await openBoardExport(a.page, { expand: true })
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('export-area-board').check()
    await dialog.getByTestId('export-scale').selectOption('2')
    const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
    const info = readPng(png.bytes)

    // The board's export starts 32 px (the margin) above and left of the cards, at 2×.
    const S = 2
    const M = 32
    const minX = Math.min(...cards.map((c) => c.x))
    const minY = Math.min(...cards.map((c) => c.y))
    const maxX = Math.max(...cards.map((c) => c.x + c.width))
    expect(Math.abs(info.width - (maxX - minX + 2 * M) * S)).toBeLessThanOrEqual(2)
    const at = (c: (typeof cards)[number], dx: number, dy: number, w: number, h: number) => ({
      x: (c.x - minX + M + dx) * S,
      y: (c.y - minY + M + dy) * S,
      w: w * S,
      h: h * S,
    })

    for (const c of cards) {
      const kind = c.facts.kind
      // the footer: the whole card for an attachment, else its bottom 56 px
      const footerTop = kind === 'other' ? 0 : c.height - 56
      const footerH = kind === 'other' ? c.height : 56
      const badgeTop = footerTop + (footerH - 38) / 2
      const [badge, text, status] = await pngRegionStats(a.page, png.bytes, [
        { ...at(c, 13, badgeTop + 3, 28, 32), color: BADGE[kind] ?? BADGE.other },
        at(c, 54, footerTop + 4, c.width - 64, footerH - 8),
        { ...at(c, 54, footerTop + 4, c.width - 64, footerH - 8), color: DANGER },
      ])
      const name = c.facts.name
      // the kind badge in its colour (the bare cover or the engine's grey placeholder before)
      expect(badge?.near ?? 0, `${name}: kind badge`).toBeGreaterThan((badge?.total ?? 0) * 0.6)
      // the name and the size · status line: ink on the card's white
      expect(text?.ink ?? 0, `${name}: name and status`).toBeGreaterThan(40)
      expect(text?.white ?? 0, `${name}: the footer's white`).toBeGreaterThan((text?.total ?? 0) * 0.4)
      // "Preview failed" in the danger colour on the encrypted PDF only
      if (name === 'encrypted.pdf') expect(status?.near ?? 0, `${name}: failed status`).toBeGreaterThan(20)
      if (kind === 'video') {
        // the play button: a dark disc (radius 26) in the middle of the poster, left of its white triangle
        const [play] = await pngRegionStats(a.page, png.bytes, [
          at(c, c.width / 2 - 20, (c.height - 56) / 2 - 6, 12, 12),
        ])
        expect(play?.ink ?? 0, 'video: play button').toBeGreaterThan((play?.total ?? 0) * 0.6)
      }
    }

    // The SVG embeds one face per card (the zip and the encrypted PDF had none before: the engine drew
    // its placeholder), and stays self-contained.
    const svg = await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())
    const text = svg.bytes.toString('utf8')
    expect(svgRootName(text)).toBe('svg')
    expect(svgEmbeddedImages(text)).toHaveLength(FILES.length)
  })
})

test.describe('PDF export', () => {
  /** Presentation order set explicitly (Plan first), unlike the frames' left-to-right layout. */
  // W5-30: one-word labels (the label is exactly the word's width in the canvas's font, so the PDF's
  // wider Helvetica split it when it wrapped again) and a sentence the engine wraps over several lines.
  const SENTENCE = 'Storyboard review with the client before delivery of the final cut'
  const PDF_DECK: DeckSpec = {
    frames: [
      { ...INTRO, index: 1 },
      { id: F.backstage, name: 'Backstage', x: 1000, y: 0, w: 720, h: 540, skip: true },
      { id: F.plan, name: 'Plan', x: 2000, y: 0, w: 640, h: 480, index: 0 },
    ],
    notes: [
      ...(DECK.notes ?? []),
      { id: 'pe-note-story', frame: F.intro, x: 540, y: 40, text: 'Story' },
      { id: 'pe-note-delivery', frame: F.intro, x: 540, y: 260, text: 'Delivery' },
      { id: 'pe-note-sentence', frame: F.intro, x: 40, y: 40, text: SENTENCE },
    ],
  }
  const ORIGINAL_ROUTE = /\/files\/ast_[0-9A-Za-z]+\/ver_[0-9A-Za-z]+\/original/

  test('PDF export: one frame-sized page per slide in presentation order, bookmarks and searchable text; skipped frames on request, selected frames alone, and cancel', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const title = await boardTitle(users, board)
    await seedDeck(a.page, PDF_DECK)
    await placeUploadedImage(a.page, users, board, INTRO, { x: 40, y: 330, w: 400, h: 225 })
    await selectNone(a.page)
    const files = trackRequests(a.page, isFileRequest)
    const downloads = collectDownloads(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    const summary = dialog.getByTestId('export-pdf-summary')

    await openBoardExport(a.page, { expand: true })
    await expect(summary).toHaveText('One page per frame, in presentation order (2 pages).')
    // N6-5: these steps check today's image pages; once the vector choice is offered (VECTOR_PDF), they choose
    // "Image pages" (remembered for the rest of the test), which must give exactly today's output
    const imagePages = dialog.getByTestId('export-pdf-pages-image')
    if (await imagePages.count()) await imagePages.check()

    await test.step('cancel while a page is rendering: no file, "Export cancelled."', async () => {
      // Hold the original upload's download: the export then waits inside page 2 (Intro has the image).
      let release: () => void = () => {}
      const released = new Promise<void>((r) => {
        release = r
      })
      let requested: () => void = () => {}
      const wasRequested = new Promise<void>((r) => {
        requested = r
      })
      await a.page.route(ORIGINAL_ROUTE, async (route) => {
        requested()
        await released
        await route.continue()
      })
      await dialog.getByTestId('export-pdf').click()
      await wasRequested
      const progress = dialog.getByTestId('export-progress')
      await expect(progress).toHaveAttribute('max', '2')
      await expect(progress).toHaveAttribute('value', '1')
      await expect(dialog).toContainText('Rendering page 2 of 2…')
      await expect(dialog.getByTestId('export-pdf')).toBeDisabled()
      await dialog.getByTestId('export-cancel').click()
      release()
      await expect(dialog.getByTestId('export-status')).toHaveText('Export cancelled.')
      await expect(dialog.getByTestId('export-cancel')).toHaveCount(0)
      await expect(progress).toHaveCount(0)
      await expect(dialog.getByTestId('export-pdf')).toBeEnabled()
      expect(downloads).toEqual([])
      await a.page.unroute(ORIGINAL_ROUTE)
    })

    // Each page: the frame at 0.75 pt/px under a header band with its title (RETRO-05a): 28 pt tall on
    // pages this narrow (pdf-layout headerBandHeight).
    const BAND = 28
    await test.step('the deck: 2 pages in presentation order, frame × 0.75 pt + title band, bookmarks, text layer', async () => {
      const progress = await watchTestId(a.page, 'export-progress')
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      expect(pdf.name).toBe(`${title}.pdf`)
      expect((await progress()).length).toBeGreaterThan(0) // the progress bar showed during the export
      await expect(dialog.getByTestId('export-status')).toHaveText(`Downloaded “${title}.pdf” (2 pages).`)
      const info = await readPdf(pdf.bytes)
      expect(info.title).toBe(title)
      expect(info.pages.map((p) => [p.width, p.height])).toEqual([
        [480, 360 + BAND], // Plan 640×480
        [600, 450 + BAND], // Intro 800×600
      ])
      expect(info.outline).toEqual([
        { title: 'Plan', page: 0 },
        { title: 'Intro', page: 1 },
      ])
      // Each page is one image of its frame drawn at 3× (PRS-06 raster pages, see the dialog's note).
      expect(info.pages.map((p) => p.images)).toEqual([
        [{ width: 1920, height: 1440 }],
        [{ width: 2400, height: 1800 }],
      ])
      const texts = await pdfPageTexts(pdf.bytes)
      expect(texts).toHaveLength(2)
      expect(texts[0]).toContain('Launch checklist')
      expect(texts[0]).not.toContain('Kickoff agenda')
      expect(texts[1]).toContain('Kickoff agenda')
      // W5-30: every word of the page is whole in its text layer (a search for it finds it): the layer
      // keeps the canvas's own lines instead of wrapping them again in the PDF's font.
      const words = new Set(texts[1]?.split(/\s+/))
      for (const word of ['Story', 'Delivery', ...SENTENCE.split(' ')])
        expect(words, `"${word}" whole in the text layer: ${texts[1]}`).toContain(word)
      // Each page starts with its frame's title (the header band).
      expect(texts[0]?.startsWith('Plan')).toBe(true)
      expect(texts[1]?.startsWith('Intro')).toBe(true)
      // The image on page 2 came from the original upload, never from a canvas preview.
      expect(files.paths()).toContainEqual(expect.stringMatching(ORIGINAL_PATH))
      expect(files.paths().filter((p) => DERIVATIVE_PATH.test(p))).toEqual([])
    })

    await test.step('with the skipped frame included: 3 pages, the skipped one last', async () => {
      await dialog.getByTestId('export-pdf-include-skipped').check()
      await expect(summary).toHaveText('One page per frame, in presentation order (3 pages).')
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      expect(pdf.name).toBe(`${title}.pdf`)
      const info = await readPdf(pdf.bytes)
      expect(info.pages.map((p) => [p.width, p.height])).toEqual([
        [480, 360 + BAND],
        [600, 450 + BAND],
        [540, 405 + BAND], // Backstage 720×540
      ])
      expect(info.outline.map((o) => o.title)).toEqual(['Plan', 'Intro', 'Backstage'])
    })

    await test.step('only the skipped frame selected: a 1-page "selected frames" PDF', async () => {
      await a.page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await select(a.page, [F.backstage])
      await openBoardExport(a.page)
      await expect(summary).toHaveText('The selected frames, one page each (1 page).')
      await expect(dialog.getByTestId('export-pdf-include-skipped')).toHaveCount(0)
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      expect(pdf.name).toBe(`${title} - selected frames.pdf`)
      const info = await readPdf(pdf.bytes)
      expect(info.pages.map((p) => [p.width, p.height])).toEqual([[540, 405 + BAND]])
      expect(info.outline).toEqual([{ title: 'Backstage', page: 0 }])
    })
    expect(downloads).toEqual([`${title}.pdf`, `${title}.pdf`, `${title} - selected frames.pdf`])
  })

  test('W5-30: the Lobby tour as a PDF (DEMO 3:30): every label word is whole in the searchable text layer', async ({
    canvasSession,
    board,
  }) => {
    const a = await canvasSession('alice')
    await a.page.goto(`/b/${board}?template=lobby-tour`)
    await waitForCanvas(a.page)
    await expect
      .poll(async () => (await canvasCall(a.page, 'items')).filter((e) => e.type === 'frame').length, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(6)
    await expectSaved(a.page)
    await selectNone(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    await openBoardExport(a.page)
    await expect(dialog).toBeVisible()
    const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
    const words = new Set((await pdfPageTexts(pdf.bytes)).flatMap((t) => t.split(/\s+/)))
    // the reviewers' searches ("Stor/y", "Brie/f", "Deliver/y" before), and the other one-word labels
    for (const word of [
      'Story',
      'Brief',
      'Delivery',
      'Concepts',
      'Production',
      'Gameplay',
      'Community',
      'Changes',
    ])
      expect(words, `"${word}" whole in the PDF's text layer`).toContain(word)
  })

  test('Ctrl+P opens the PDF export focused on Download PDF, Delete inside the dialog keeps the selected note, and a viewer can download CSV and PDF', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const title = await boardTitle(users, board)
    await seedDeck(a.page, DECK)
    await zoomToFit(a.page)
    await clickItem(a.page, N.plan)
    await expect.poll(() => selection(a.page)).toEqual([N.plan])

    const dialog = a.page.getByTestId('export-dialog')
    await a.page.keyboard.press('Control+p')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('export-pdf')).toBeFocused()
    await a.page.keyboard.press('Delete')
    await a.page.keyboard.press('Backspace')
    await dialog.getByTestId('export-csv').focus()
    await a.page.keyboard.press('Delete')
    await nextFrames(a.page)
    await expect(dialog).toBeVisible()
    expect(await canvasCall(a.page, 'get', N.plan)).not.toBeNull()
    expect(await selection(a.page)).toEqual([N.plan])
    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // A viewer (read-only canvas) loads the board from the server: the note was never deleted.
    const v = await canvasSession('carol', { role: 'viewer' })
    await expectItems(v.page, [F.intro, F.backstage, F.plan, N.intro, N.plan])
    expect(await canvasCall(v.page, 'readOnly')).toBe(true)

    // ...and can download the CSV and the PDF (presenting as a viewer: present-export-present.spec.ts).
    const vDialog = v.page.getByTestId('export-dialog')
    await openBoardExport(v.page)
    await expect(vDialog).toBeVisible()
    const csv = await downloadFrom(v.page, () => vDialog.getByTestId('export-csv').click())
    expect(csv.name).toBe(`${title}.csv`)
    expect([...csv.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const rows = parseCsv(csv.bytes.subarray(3).toString('utf8'))
    expect(rows[0]).toEqual(['id', 'type', 'text', 'frame', 'color', 'x', 'y', 'tags'])
    expect(rows.find((r) => r[0] === N.plan)?.slice(1, 4)).toEqual(['note', 'Launch checklist', 'Plan'])
    const pdf = await downloadFrom(v.page, () => vDialog.getByTestId('export-pdf').click())
    expect(pdf.name).toBe(`${title}.pdf`)
    const info = await readPdf(pdf.bytes)
    expect(info.outline.map((o) => o.title)).toEqual(['Intro', 'Plan'])
  })

  // RETRO-05b: the results and the comments in the same file as the frames (docs/REVIEW-2026-09-27.md).
  test('RETRO-05b: the PDF can end with a vote results page and a comments appendix; team-only threads only when asked; no authors on a board that hides them', async ({
    canvasSession,
    users,
    board,
  }) => {
    test.setTimeout(180_000)
    const a = await canvasSession('alice')
    const b = await canvasSession('bob', { role: 'editor' })
    const title = await boardTitle(users, board)
    await seedDeck(a.page, PDF_DECK)
    await expectItems(b.page, [F.intro, F.plan, N.intro, N.plan, 'pe-note-story'])
    const alice = await users.api('alice')
    const bob = await users.api('bob')
    const dialog = a.page.getByTestId('export-dialog')
    const withResults = dialog.getByTestId('export-pdf-results')
    const withComments = dialog.getByTestId('export-pdf-comments')
    const withTeam = dialog.getByTestId('export-pdf-team-comments')
    const summary = dialog.getByTestId('export-pdf-summary')
    const call = async (api: typeof alice, path: string, data?: unknown) => {
      const res = await api.fetch('POST', path, data)
      expect(res.status(), `${path}: ${await res.text()}`).toBeLessThan(300)
      return (await res.json()) as Record<string, unknown>
    }

    await test.step('with no vote and no comments both are off, and the dialog says why', async () => {
      await openBoardExport(a.page)
      await expect(withResults).toBeDisabled()
      await expect(withResults).not.toBeChecked()
      await expect(dialog.getByTestId('export-pdf-results-hint')).toContainText('reveal a vote')
      await expect(withComments).toBeDisabled()
      await expect(dialog.getByTestId('export-pdf-comments-hint')).toHaveText('There are no comments to add.')
      await expect(withTeam).toHaveCount(0)
      await expect(summary).toHaveText('One page per frame, in presentation order (2 pages).')
      await a.page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    })

    await test.step('a vote (not revealed yet: no results page) and three threads', async () => {
      await call(alice, `/api/boards/${board}/votes`, {
        votesPerPerson: 3,
        onePerObject: false,
        scope: 'board',
      })
      const sid = (await workshopState(alice, board)).vote?.session.id ?? ''
      expect(sid).not.toBe('')
      const cast = (api: typeof alice, id: string) =>
        call(api, `/api/votes/${sid}/cast`, { shapeId: `shape:${id}`, delta: 1 })
      for (const id of [N.intro, N.intro, N.plan]) await cast(alice, id)
      for (const id of [N.intro, 'pe-note-story', 'pe-note-story']) await cast(bob, id)
      // not revealed: nothing is on offer yet
      await openBoardExport(a.page)
      await expect(withResults).toBeDisabled()
      await a.page.keyboard.press('Escape')
      await call(alice, `/api/votes/${sid}/reveal`)

      const onIntro = { kind: 'shape', shapeId: `shape:${N.intro}`, u: 0.5, v: 0.5 }
      const first = (await call(alice, `/api/boards/${board}/threads`, {
        anchor: onIntro,
        body: 'Please tighten the agenda',
      })) as { thread: { id: string } }
      await call(bob, `/api/threads/${first.thread.id}/comments`, { body: 'Agreed, cut item three' })
      // a pin on the board inside the Plan frame (2000..2640 x 0..480), later resolved
      const second = (await call(bob, `/api/boards/${board}/threads`, {
        anchor: { kind: 'point', x: 2300, y: 400 },
        body: 'Add the launch date here',
      })) as { thread: { id: string } }
      await call(alice, `/api/threads/${second.thread.id}/resolve`)
      await call(alice, `/api/boards/${board}/threads`, {
        anchor: { kind: 'shape', shapeId: `shape:${N.plan}`, u: 0.2, v: 0.2 },
        body: 'Internal: the budget is tight',
        visibility: 'team',
      })
    })

    await test.step('the dialog offers both, with what each holds; team-only threads stay out until asked', async () => {
      await openBoardExport(a.page)
      await expect(withResults).toBeEnabled()
      await expect(withResults).not.toBeChecked()
      await expect(withComments).toBeEnabled()
      // 1 open thread everyone sees and 1 resolved; the team-only one is not counted yet
      await expect(dialog.getByText('Comments page (1 open, 1 resolved)')).toBeVisible()
      await expect(withTeam).not.toBeChecked()
      await expect(dialog.getByTestId('export-pdf-extras')).toContainText('Include 1 team-only thread')
      // nothing is added unless chosen
      await expect(summary).toHaveText('One page per frame, in presentation order (2 pages).')
    })

    const BAND = 28
    await test.step('both pages: after the frames, bookmarked, a text layer; the team-only thread is not in the file', async () => {
      await withResults.check()
      await withComments.check()
      await expect(summary).toHaveText(
        'One page per frame, in presentation order (2 pages). Then a vote results page and a comments page at the end.',
      )
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      expect(pdf.name).toBe(`${title}.pdf`)
      await expect(dialog.getByTestId('export-status')).toHaveText(`Downloaded “${title}.pdf” (4 pages).`)
      const info = await readPdf(pdf.bytes)
      expect(info.outline).toEqual([
        { title: 'Plan', page: 0 },
        { title: 'Intro', page: 1 },
        { title: 'Vote results', page: 2 },
        { title: 'Comments', page: 3 },
      ])
      // the report pages are A4 portrait (794 × 1123 px at 0.75 pt/px) under the title band
      for (const p of info.pages.slice(2)) {
        expect(p.width).toBeCloseTo(595.5, 1)
        expect(p.height).toBeCloseTo(842.25 + BAND, 1)
        expect(p.images).toHaveLength(1)
      }
      const texts = await pdfPageTexts(pdf.bytes)
      expect(texts).toHaveLength(4)
      // the frames' pages are as before
      expect(texts[0]).toContain('Launch checklist')
      expect(texts[1]).toContain('Kickoff agenda')
      // results: ranked, with the votes and the frame (3 on the intro note, 2 on the story, 1 on the plan note)
      const results = texts[2] ?? ''
      expect(results.startsWith('Vote results')).toBe(true)
      expect(results).toContain('3 items received votes (6 votes in total)')
      expect(results).toMatch(/#1 Kickoff agenda 3 votes · in “Intro”/)
      expect(results).toMatch(/#2 Story 2 votes · in “Intro”/)
      expect(results).toMatch(/#3 Launch checklist 1 vote · in “Plan”/)
      // comments: open first, then resolved; who and what, where; no team-only thread
      const comments = texts[3] ?? ''
      expect(comments.startsWith('Comments')).toBe(true)
      expect(comments).toContain('1 open thread and 1 resolved thread')
      expect(comments).toMatch(/Open \(1\).*1 On “Kickoff agenda”, in “Intro”/)
      expect(comments).toContain('Alice Park,')
      expect(comments).toContain('Please tighten the agenda')
      expect(comments).toContain('Bob Chen,')
      expect(comments).toContain('Agreed, cut item three')
      expect(comments).toMatch(/Resolved \(1\).*2 In “Plan”/)
      expect(comments).toContain('Add the launch date here')
      expect(comments).not.toContain('budget')
      expect(comments).not.toContain('Team only')
    })

    await test.step('"Include the team-only thread": it is in the file and marked', async () => {
      await withTeam.check()
      await expect(dialog.getByText('Comments page (2 open, 1 resolved)')).toBeVisible()
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      const texts = await pdfPageTexts(pdf.bytes)
      const comments = texts[3] ?? ''
      expect(comments).toContain('Team-only comments are included and marked')
      expect(comments).toContain('Internal: the budget is tight')
      expect(comments).toContain('Team only')
      await withTeam.uncheck()
    })

    await test.step('a board that hides note authors: the comments page names nobody', async () => {
      await a.page.evaluate(() =>
        (
          window as unknown as {
            __lobbyBoard: { canvas: { doc: { set(p: Record<string, unknown>): void } } }
          }
        ).__lobbyBoard.canvas.doc.set({ workshop: { hideNoteAuthors: true, hideCursors: false } }),
      )
      await expect(dialog.getByTestId('export-pdf-authors-hint')).toHaveText(
        'This board hides note authors, so the comments page lists them without who wrote them.',
      )
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      const comments = (await pdfPageTexts(pdf.bytes))[3] ?? ''
      expect(comments).toContain('This board hides note authors')
      expect(comments).toContain('Please tighten the agenda')
      expect(comments).toContain('Agreed, cut item three')
      expect(comments).not.toContain('Alice Park')
      expect(comments).not.toContain('Bob Chen')
    })

    await test.step('only the results page: one extra page; the choice is not remembered next time', async () => {
      await withComments.uncheck()
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      const info = await readPdf(pdf.bytes)
      expect(info.outline.map((o) => o.title)).toEqual(['Plan', 'Intro', 'Vote results'])
      await a.page.keyboard.press('Escape')
      await openBoardExport(a.page, { expand: true })
      await expect(withResults).not.toBeChecked()
      await expect(withComments).not.toBeChecked()
    })

    await test.step('16:9 and A4 landscape: the results and the comments pages take the same page as the frames, bookmarked', async () => {
      await withResults.check()
      await withComments.check()
      const size = dialog.getByTestId('export-pdf-page-size')
      for (const [format, want] of [
        ['16:9', { width: 960, height: 540 }],
        ['a4', { width: 841.89, height: 595.28 }],
      ] as const) {
        await size.selectOption(format)
        const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
        const info = await readPdf(pdf.bytes)
        expect(
          info.outline.map((o) => o.title),
          format,
        ).toEqual(['Plan', 'Intro', 'Vote results', 'Comments'])
        for (const p of info.pages) {
          expect(p.width, format).toBeCloseTo(want.width, 1)
          expect(p.height, format).toBeCloseTo(want.height, 1)
        }
        // the results page is a picture of the report with its text laid over it, as on the fit pages
        expect(info.pages[2]?.images, format).toHaveLength(1)
        const texts = await pdfPageTexts(pdf.bytes)
        expect(texts[2] ?? '', format).toMatch(/#1 Kickoff agenda 3 votes/)
        expect(texts[3] ?? '', format).toContain('Please tighten the agenda')
      }
      await size.selectOption('fit')
    })

    await test.step('every item that got votes is deleted since the reveal: no results page is on offer and the summary does not promise one', async () => {
      await withResults.check()
      await withComments.uncheck()
      await expect(summary).toContainText('Then a vote results page')
      for (const id of [N.intro, N.plan, 'pe-note-story']) await deleteItem(a.page, id)
      await expect(withResults).toBeDisabled()
      await expect(withResults).not.toBeChecked()
      await expect(dialog.getByTestId('export-pdf-results-hint')).toContainText('no longer on the board')
      await expect(summary).toHaveText('One page per frame, in presentation order (2 pages).')
      // and the file has the frames only
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      const info = await readPdf(pdf.bytes)
      expect(info.outline.map((o) => o.title)).toEqual(['Plan', 'Intro'])
    })
  })
})

test.describe('CSV export', () => {
  test('CSV export: UTF-8 with a BOM, the documented header, formula-like text neutralized, and a selection exports only its rows', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const title = await boardTitle(users, board)
    const ID = {
      frame: 'csv-frame',
      formula: 'csv-formula',
      plus: 'csv-plus',
      at: 'csv-at',
      plain: 'csv-plain',
      loose: 'csv-loose',
    }
    const FORMULA = '=HYPERLINK("http://evil.example","click me")'
    await seedDeck(a.page, {
      frames: [{ id: ID.frame, name: 'Research', x: 0, y: 0, w: 1000, h: 400 }],
      notes: [
        { id: ID.formula, frame: ID.frame, x: 20, y: 60, text: FORMULA },
        { id: ID.plus, frame: ID.frame, x: 260, y: 60, text: '+1 555 0100' },
        { id: ID.at, frame: ID.frame, x: 500, y: 60, text: '@SUM(A1:A9)' },
        { id: ID.plain, frame: ID.frame, x: 740, y: 60, text: 'Plain, with a comma' },
        { id: ID.loose, x: 0, y: 600, text: 'Outside every frame' },
      ],
    })
    const dialog = a.page.getByTestId('export-dialog')
    const exportCsv = async () => {
      await openBoardExport(a.page)
      await expect(dialog).toBeVisible()
      const file = await downloadFrom(a.page, () => dialog.getByTestId('export-csv').click())
      const status = (await dialog.getByTestId('export-status').textContent()) ?? ''
      await a.page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      expect([...file.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      const text = file.bytes.subarray(3).toString('utf8')
      expect(text.startsWith('id,type,text,frame,color,x,y,tags\r\n')).toBe(true)
      return { name: file.name, status, rows: parseCsv(text) }
    }

    const all = await exportCsv()
    expect(all.name).toBe(`${title}.csv`)
    const byId = new Map(all.rows.slice(1).map((r) => [r[0], r]))
    expect([...byId.keys()].sort()).toEqual(Object.values(ID).sort())
    expect(all.status).toBe(`Downloaded “${title}.csv” (6 rows).`)
    // A spreadsheet would evaluate these; the export prefixes an apostrophe so they stay text.
    expect(byId.get(ID.formula)?.[2]).toBe(`'${FORMULA}`)
    expect(byId.get(ID.plus)?.[2]).toBe("'+1 555 0100")
    expect(byId.get(ID.at)?.[2]).toBe("'@SUM(A1:A9)")
    expect(byId.get(ID.plain)?.[2]).toBe('Plain, with a comma')
    // Notes carry the palette's name for their colour (Lobby's yellow fill is "Marigold"; R14).
    expect(byId.get(ID.formula)?.slice(1, 5)).toEqual(['note', `'${FORMULA}`, 'Research', 'Marigold'])
    expect(byId.get(ID.loose)?.slice(3, 7)).toEqual(['', 'Marigold', '0', '600'])
    expect(byId.get(ID.frame)?.slice(1, 4)).toEqual(['frame', 'Research', ''])

    // One note selected: only its row.
    await select(a.page, [ID.plain])
    const one = await exportCsv()
    expect(one.name).toBe(`${title} - selection.csv`)
    expect(one.rows.slice(1).map((r) => r[0])).toEqual([ID.plain])
    expect(one.status).toBe(`Downloaded “${title} - selection.csv” (1 row).`)

    // The frame selected: the frame and what it contains, not the loose note.
    await select(a.page, [ID.frame])
    const framed = await exportCsv()
    expect(
      framed.rows
        .slice(1)
        .map((r) => r[0])
        .sort(),
    ).toEqual([ID.frame, ID.formula, ID.plus, ID.at, ID.plain].sort())

    // Renamed in the top bar to a title no file system accepts as is: the next export is named after the
    // new title, made safe ("/" becomes "-", ":" and "*" go).
    await selectNone(a.page)
    await a.page.getByTestId('board-title').click()
    await a.page.getByTestId('board-title-input').fill('Q3/Q4: launch* plan')
    await a.page.getByTestId('board-title-input').press('Enter')
    await expect(a.page.getByTestId('board-title')).toHaveText('Q3/Q4: launch* plan')
    await expect.poll(() => boardTitle(users, board)).toBe('Q3/Q4: launch* plan')
    const renamed = await exportCsv()
    expect(renamed.name).toBe('Q3-Q4 launch plan.csv')
  })
})
