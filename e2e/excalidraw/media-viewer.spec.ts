// Wave 3g, ported from e2e/tests/media-2.spec.ts: the PDF page viewer and "Place on board" (FIL-04,
// review F7b) and animated GIFs (FIL-08) on the Excalidraw canvas, on real uploads through the api file
// routes and the preview worker.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- media-viewer
//
// What differs from the tldraw spec (docs/research/excalidraw/wave3/3G.md): a placed page is an `image`
// element whose fileId is the PDF version's `ver_….p<n>` (no asset record); FIL-08's inline GIF playback
// is deferred by the plan (§4.1: the canvas shows the first frame), so the GIF spec checks that the canvas
// never loads the GIF's original, at any zoom.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  createItem,
  deleteItem,
  expect,
  itemBounds,
  selection,
  selectNone,
  setViewport,
  test,
  updateItem,
  viewport,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { pressRedo, pressUndo } from '../tests/support/excalidraw.ts'
import { makeImages } from '../tests/support/files.ts'
import {
  gifPayload,
  makePdf,
  naturalSize,
  selectBox,
  viewer,
  viewerCounter,
  viewerPage,
} from '../tests/support/media-2.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import {
  cardItems,
  contains,
  DERIVATIVE_SRC,
  expectLoadedImage,
  type FileItem,
  fileCard,
  imageItems,
  imageState,
  insertFiles,
  newItems,
  ORIGINAL_HREF,
  pageItems,
  recordRequests,
  settleCamera,
  urlOf,
} from './media-kit.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)

/** The card named `name` once the worker has made its previews. */
async function readyCard(page: Page, name: string): Promise<FileItem> {
  await expect(fileCard(page, name)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  const card = (await cardItems(page)).find((c) => c.facts.name === name)
  if (!card) throw new Error(`no card ${name}`)
  return card
}

/** Centres the camera on an element at an exact zoom. */
async function lookAt(page: Page, id: string, z: number) {
  const b = await itemBounds(page, id)
  const vp = await viewport(page)
  if (!b) throw new Error(`no bounds for ${id}`)
  const sw = vp.width * vp.zoom
  const sh = vp.height * vp.zoom
  await setViewport(page, { x: b.x + b.width / 2 - sw / z / 2, y: b.y + b.height / 2 - sh / z / 2, zoom: z })
}

const inView = async (page: Page, ids: string[]) => {
  const vp = await viewport(page)
  for (const id of ids) {
    const b = await itemBounds(page, id)
    if (
      !b ||
      !contains(
        { x: vp.x, y: vp.y, w: vp.width, h: vp.height },
        { x: b.x, y: b.y, w: b.width, h: b.height },
        1,
      )
    )
      return false
  }
  return true
}

test('FIL-04 PDF page viewer: "View pages" shows page N of M, ←/→ turn pages (the board keeps its keys), zoom, Download original; 2 selected pages land next to the card as one undo step, sharp at 100 % and 200 %, and a second person sees them', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await insertFiles(a.page, [fixture('document.pdf')])
  const card = await readyCard(a.page, 'document.pdf')
  await readyCard(b.page, 'document.pdf')
  const cardBox = await itemBounds(a.page, card.id)
  if (!cardBox) throw new Error('no card bounds')
  const requestsA = recordRequests(a.page)

  await test.step('the card offers "View pages"; it opens an accessible viewer at page 1 of 4', async () => {
    await a.page.evaluate(
      (id) => (window as never as { lobbyCanvas: { select(i: string[]): void } }).lobbyCanvas.select([id]),
      card.id,
    )
    const open = fileCard(a.page, 'document.pdf').getByTestId('file-card-view-pages')
    await expect(open).toHaveAccessibleName('View pages of document.pdf')
    await open.click()
    await expect(viewer(a.page)).toBeVisible()
    await expect(a.page.getByRole('dialog', { name: 'document.pdf' })).toBeVisible()
    await expect(viewerCounter(a.page)).toHaveText('Page 1 of 4')
    await expect(viewerPage(a.page)).toHaveAttribute('data-page', '1')
    await expect(viewerPage(a.page)).toHaveAttribute('src', new RegExp(`${DERIVATIVE_SRC.source}${board}$`))
    await expect(viewerPage(a.page)).toHaveAccessibleName('Page 1 of document.pdf')
    // The largest rendering the worker made (1024 px wide), not the thumb.
    await expect.poll(() => naturalSize(viewerPage(a.page))).toMatchObject({ w: 1024 })
    await expect(a.page.getByTestId('pdf-viewer-thumb')).toHaveCount(4)
    await expect(a.page.getByTestId('pdf-viewer-partial-note')).toHaveCount(0)
    // Focus starts on the page, so the arrow keys work at once.
    await expect(a.page.getByTestId('pdf-viewer-stage')).toBeFocused()
  })

  await test.step('←/→, Home/End turn pages; the selected card on the board does not move', async () => {
    await a.page.keyboard.press('ArrowRight')
    await expect(viewerCounter(a.page)).toHaveText('Page 2 of 4')
    await expect(viewerPage(a.page)).toHaveAttribute('data-page', '2')
    await a.page.keyboard.press('End')
    await expect(viewerCounter(a.page)).toHaveText('Page 4 of 4')
    await expect(a.page.getByTestId('pdf-viewer-next')).toBeDisabled()
    await a.page.keyboard.press('ArrowRight')
    await expect(viewerCounter(a.page)).toHaveText('Page 4 of 4')
    await a.page.keyboard.press('Home')
    await expect(viewerCounter(a.page)).toHaveText('Page 1 of 4')
    await a.page.keyboard.press('ArrowLeft')
    await expect(viewerCounter(a.page)).toHaveText('Page 1 of 4')
    await a.page.getByTestId('pdf-viewer-thumb').nth(2).click()
    await expect(viewerCounter(a.page)).toHaveText('Page 3 of 4')
    // The board would nudge a selected element with the arrow keys and delete it with Delete.
    await a.page.keyboard.press('Delete')
    expect(await itemBounds(a.page, card.id)).toEqual(cardBox)
  })

  await test.step('zoom: buttons and keys, the page grows and scrolls; Fit goes back', async () => {
    const fit = await viewerPage(a.page).boundingBox()
    if (!fit) throw new Error('no page box')
    await a.page.getByTestId('pdf-viewer-zoom-in').click()
    await expect(a.page.getByTestId('pdf-viewer-zoom-level')).toHaveText('150%')
    await expect
      .poll(async () => (await viewerPage(a.page).boundingBox())?.width ?? 0)
      .toBeCloseTo(fit.width * 1.5, -1)
    await a.page.keyboard.press('+')
    await expect(a.page.getByTestId('pdf-viewer-zoom-level')).toHaveText('200%')
    const scrollable = await a.page
      .getByTestId('pdf-viewer-stage')
      .evaluate((el) => el.scrollHeight > el.clientHeight + 10)
    expect(scrollable).toBe(true)
    await a.page.keyboard.press('0')
    await expect(a.page.getByTestId('pdf-viewer-zoom-level')).toHaveText('100%')
    await expect
      .poll(async () => (await viewerPage(a.page).boundingBox())?.width ?? 0)
      .toBeCloseTo(fit.width, -1)
  })

  await test.step('"Download original" is the board-scoped original of the PDF', async () => {
    const link = a.page.getByTestId('pdf-viewer-download')
    await expect(link).toHaveAttribute('href', new RegExp(`${ORIGINAL_HREF.source}${board}$`))
    await expect(link).toHaveAttribute('download', 'document.pdf')
    const res = await a.page.request.get((await link.getAttribute('href')) ?? '')
    expect(res.status()).toBe(200)
    expect(Buffer.compare(await res.body(), readFileSync(fixture('document.pdf')))).toBe(0)
  })

  let placed: FileItem[] = []
  await test.step('select pages 2 and 3, Place on board: a row right of the card, selected, one notice', async () => {
    await expect(a.page.getByTestId('pdf-viewer-place')).toBeDisabled()
    await selectBox(a.page, 2).click()
    await selectBox(a.page, 3).click()
    await expect(a.page.getByTestId('pdf-viewer-selection')).toHaveText('2 pages selected')
    await a.page.getByTestId('pdf-viewer-place').click()
    await expect(viewer(a.page)).toHaveCount(0)
    await expect(a.page.getByTestId('pdf-pages-placed')).toHaveText(
      'Placed 2 pages of document.pdf next to it.',
    )
    placed = (await newItems(a.page, pageItems, new Set(), 2)).sort((p, q) => p.x - q.x)
    expect(placed.map((p) => p.pdfPage)).toEqual([2, 3])
    expect(placed.map((p) => p.alt)).toEqual(['Page 2 of document.pdf', 'Page 3 of document.pdf'])
    for (const p of placed) {
      // The PDF version and a page number: no URL, no bytes.
      expect(p.fileId.replace(/@\w+$/, '')).toBe(`${card.facts.versionId}.p${p.pdfPage}`)
      expect(p.facts).toEqual(card.facts)
      expect(p.frameId).toBeNull()
      expect(p.y).toBeCloseTo(cardBox.y, 1) // tops aligned with the card
      expect(p.width).toBeCloseTo(512, 1) // half the 1024 px rendering
    }
    const [first, second] = placed
    if (!first || !second) throw new Error('two pages expected')
    expect(first.x).toBeGreaterThanOrEqual(cardBox.x + cardBox.width + 24)
    expect(first.x).toBeLessThan(cardBox.x + cardBox.width + 40)
    expect(second.x).toBeCloseTo(first.x + first.width + 24, 1)
    expect((await selection(a.page)).sort()).toEqual(placed.map((p) => p.id).sort())
    // The board has the keys again (Delete, undo) for the new selection.
    await expect
      .poll(() => a.page.evaluate(() => !!document.activeElement?.closest('.excalidraw')))
      .toBe(true)
    // The camera zooms out just enough to show the new row (like a drop), then settles.
    await settleCamera(a.page)
    await expect
      .poll(() =>
        inView(
          a.page,
          placed.map((p) => p.id),
        ),
      )
      .toBe(true)
    for (const p of placed) await expectLoadedImage(a.page, p.id, board)
  })

  await test.step('sharp: at 100 % and at 200 % every page shows a rendering with at least one pixel per screen pixel', async () => {
    const dpr = await a.page.evaluate(() => window.devicePixelRatio)
    for (const z of [1, 2]) {
      for (const p of placed) {
        await lookAt(a.page, p.id, z)
        await expect
          .poll(async () => (await imageState(a.page, p.id)).natural?.w ?? 0, { timeout: 30_000 })
          .toBeGreaterThanOrEqual(Math.ceil(p.width * z * dpr))
      }
    }
    // Only derivatives were fetched for the pages: never the PDF original.
    expect(requestsA.originals()).toEqual([])
    // Export / copy / "Download original" of a placed page get its largest rendering, not the PDF.
    expect(await urlOf(a.page, placed[0]?.id ?? '', true)).toMatch(DERIVATIVE_SRC)
  })

  await test.step('bob sees both pages, from the same derivatives', async () => {
    await expect
      .poll(async () => (await pageItems(b.page)).map((p) => p.id).sort())
      .toEqual(placed.map((p) => p.id).sort())
    await zoomToFit(b.page)
    for (const p of placed) await expectLoadedImage(b.page, p.id, board)
  })

  await test.step('one undo removes both pages (for bob too); redo brings them back', async () => {
    await pressUndo(a.page)
    for (const s of [a, b]) await expect.poll(async () => (await pageItems(s.page)).length).toBe(0)
    expect((await cardItems(a.page)).map((c) => c.id)).toEqual([card.id])
    await pressRedo(a.page)
    for (const s of [a, b]) await expect.poll(async () => (await pageItems(s.page)).length).toBe(2)
    for (const p of placed) await expectLoadedImage(b.page, p.id, board)
  })
})

test('FIL-04 a 12-page PDF: the viewer says plainly that only the first 8 pages have previews; a viewer can read them but not place pages; Esc closes and returns the focus', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const pdf = await makePdf('long-brief.pdf', 12)
  await insertFiles(a.page, [pdf])
  await readyCard(a.page, 'long-brief.pdf')
  const v = await canvasSession('bob', { role: 'viewer' })
  await readyCard(v.page, 'long-brief.pdf')
  await expect(fileCard(v.page, 'long-brief.pdf').getByTestId('file-card-pages')).toHaveText('12 pages')

  const open = fileCard(v.page, 'long-brief.pdf').getByTestId('file-card-view-pages')
  await open.focus()
  await v.page.keyboard.press('Enter')
  await expect(viewer(v.page)).toBeVisible()
  await expect(viewerCounter(v.page)).toHaveText('Page 1 of 12')
  await expect(v.page.getByTestId('pdf-viewer-thumb')).toHaveCount(8)
  await expect(v.page.getByTestId('pdf-viewer-rest')).toHaveText('+4 more pages')
  await expect(v.page.getByTestId('pdf-viewer-partial-note')).toHaveText(
    'Previews exist for the first 8 pages of 12. Download the original to read the rest.',
  )
  await v.page.keyboard.press('End')
  await expect(viewerCounter(v.page)).toHaveText('Page 8 of 12')
  await expect(v.page.getByTestId('pdf-viewer-next')).toBeDisabled()
  await expect(viewerPage(v.page)).toHaveAttribute('data-page', '8')
  await expect.poll(() => naturalSize(viewerPage(v.page)).then((s) => s.w)).toBe(1024)

  // Read-only (F5, wave C3): no page checkboxes, selection summary or footer, so nothing here can place a page
  // (and the sync server would refuse the write anyway); the page list and the pager still work.
  for (const id of [
    'pdf-viewer-select',
    'pdf-viewer-selection',
    'pdf-viewer-select-all',
    'pdf-viewer-place',
    'pdf-viewer-readonly',
  ])
    await expect(v.page.getByTestId(id), id).toHaveCount(0)

  await v.page.keyboard.press('Escape')
  await expect(viewer(v.page)).toHaveCount(0)
  await expect(open).toBeFocused()
  expect(await pageItems(a.page)).toEqual([])

  // A plain click reopens it, and selects nothing on the board.
  await selectNone(v.page)
  await open.click()
  await expect(viewer(v.page)).toBeVisible()
  expect(await selection(v.page)).toEqual([])

  // The card goes away (alice deletes it) while bob reads it: his viewer closes with it.
  const [card] = await cardItems(a.page)
  if (!card) throw new Error('no card')
  await deleteItem(a.page, card.id)
  await expect(viewer(v.page)).toHaveCount(0)
})

test('FIL-04 a card inside a frame: placed pages join the frame when the row fits there, else land on the page beside the frame', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  await insertFiles(a.page, [fixture('document.pdf')])
  const card = await readyCard(a.page, 'document.pdf')
  const place = async (pages: number[]) => {
    await fileCard(a.page, 'document.pdf').getByTestId('file-card-view-pages').click()
    for (const n of pages) await selectBox(a.page, n).click()
    await a.page.getByTestId('pdf-viewer-place').click()
    await expect(viewer(a.page)).toHaveCount(0)
  }
  const frameAround = async (w: number, h: number) => {
    const b = await itemBounds(a.page, card.id)
    if (!b) throw new Error('no card bounds')
    const id = await createItem(a.page, 'frame', {
      x: b.x - 40,
      y: b.y - 60,
      width: w,
      height: h,
      name: 'Brief',
    })
    await updateItem(a.page, card.id, { frameId: id })
    await selectNone(a.page)
    await zoomToFit(a.page)
    return id
  }

  await test.step('a roomy frame: both pages go into it, inside its bounds', async () => {
    const frame = await frameAround(1600, 900)
    await place([1, 2])
    const placed = await newItems(a.page, pageItems, new Set(), 2)
    const fb = await itemBounds(a.page, frame)
    if (!fb) throw new Error('no frame')
    for (const p of placed) {
      expect(p.frameId).toBe(frame)
      expect(p.x).toBeGreaterThanOrEqual(fb.x)
      expect(p.x + p.width).toBeLessThanOrEqual(fb.x + fb.width)
      expect(p.y + p.height).toBeLessThanOrEqual(fb.y + fb.height)
    }
    await pressUndo(a.page)
    await expect.poll(async () => (await pageItems(a.page)).length).toBe(0)
    // Take the card out again and drop that frame for the next case.
    await updateItem(a.page, card.id, { frameId: null })
    await deleteItem(a.page, frame)
  })

  await test.step('a tight frame: the row cannot fit, so it lands on the page, clear of the frame', async () => {
    const frame = await frameAround(360, 480)
    await place([3])
    const [p] = await newItems(a.page, pageItems, new Set(), 1)
    const fb = await itemBounds(a.page, frame)
    if (!p || !fb) throw new Error('no page or frame')
    expect(p.frameId).toBeNull()
    const clear =
      p.x >= fb.x + fb.width || p.x + p.width <= fb.x || p.y >= fb.y + fb.height || p.y + p.height <= fb.y
    expect(clear).toBe(true)
  })
})

test('FIL-08 (deferred inline playback, plan §4.1): an animated GIF shows its still at every zoom and the canvas never loads its original; a PNG never loads its original either', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const requestsA = recordRequests(a.page)
  const gif = gifPayload('loop.gif', 480, 320)
  const [png] = await makeImages(a.page, [{ name: 'still.png', w: 480, h: 320, type: 'image/png' }])
  if (!png) throw new Error('no png')
  await insertFiles(a.page, [gif, png])
  const placed = await newItems(a.page, imageItems, new Set(), 2)
  const gifEl = placed.find((p) => p.facts.name === 'loop.gif')
  const pngEl = placed.find((p) => p.facts.name === 'still.png')
  if (!gifEl || !pngEl) throw new Error('unexpected names')
  const original = (f: FileItem) => `/files/${f.facts.assetId}/${f.facts.versionId}/original`

  for (const z of [0.1, 1, 4]) {
    await lookAt(a.page, gifEl.id, z)
    await expectLoadedImage(a.page, gifEl.id, board)
    await lookAt(a.page, pngEl.id, z)
    await expectLoadedImage(a.page, pngEl.id, board)
  }
  await a.page.waitForTimeout(1200)
  expect(requestsA.urls.filter((u) => u.includes(original(gifEl)))).toEqual([])
  expect(requestsA.urls.filter((u) => u.includes(original(pngEl)))).toEqual([])
})
