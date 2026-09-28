// Media, second wave: the PDF page viewer and "Place on board" (FIL-04, review F7b) and animated GIF
// playback (FIL-08, review F9), on real uploads through the api file routes and the preview worker.
//
// Unit coverage below the browser: apps/web/src/assets/asset-store.test.ts (resolve for placed pages
// and animated originals), apps/web/src/file-card/pdf-pages.test.ts (pages, navigation, selection,
// zoom, the row of placed pages, the asset record).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { fileCard, insertFiles, read, shapeBounds, waitForValue } from './support/board.ts'
import { inView, selectedIds } from './support/canvas-ux.ts'
import type { ShapeLike } from './support/editor.ts'
import {
  allShapeIds,
  editF,
  imageSrc,
  insertPayloads,
  makeImages,
  newShapeIds,
  recordRequests,
} from './support/files.ts'
import { expect, test } from './support/fixtures.ts'
import {
  gifPayload,
  imageShapes,
  lookAt,
  makePdf,
  naturalSize,
  readM,
  selectBox,
  viewer,
  viewerCounter,
  viewerPage,
} from './support/media-2.ts'
import { capture } from './support/screenshots.ts'
import { FIXTURES_DIR } from './support/stack.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)
const DERIVATIVE_SRC = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/d\/drv_[0-9A-Za-z]{20}\?board=/
const ORIGINAL_SRC = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/original\?board=/
/** The only durable file reference a record may hold: host-less, no query, no data. */
const STABLE_REF = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/original$/

/** The file card named `name` once the worker has made its previews. */
async function readyCard(page: Page, name: string) {
  await expect(fileCard(page, name)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  return waitForValue(() =>
    read(
      page,
      (ed, n) =>
        ed.getCurrentPageShapes().find((s: ShapeLike) => s.type === 'dr-file-card' && s.props.name === n) ??
        null,
      name,
    ),
  )
}

/** The <img> tldraw renders for an image shape, once it shows a URL matching `src` and has decoded. */
async function expectImage(page: Page, id: string, src: RegExp, timeout = 30_000) {
  await expect
    .poll(() => imageSrc(page, id), { timeout })
    .toEqual({ src: expect.stringMatching(src), loaded: true })
}

test('FIL-04 PDF page viewer: "View pages" shows page N of M, ←/→ turn pages (the board keeps its keys), zoom, Download original; 2 selected pages land next to the card as one undo step, sharp at 100 % and 200 %, and a second person sees them', async ({
  session,
  board,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await insertFiles(a.page, [fixture('document.pdf')])
  const card = await readyCard(a.page, 'document.pdf')
  await readyCard(b.page, 'document.pdf')
  const cardBox = await shapeBounds(a.page, card.id)
  if (!cardBox) throw new Error('no card bounds')
  const requestsA = recordRequests(a.page)

  await test.step('the card offers "View pages"; it opens an accessible viewer at page 1 of 4', async () => {
    await editF(a.page, (ed, id) => ed.select(id), card.id)
    const open = fileCard(a.page, 'document.pdf').getByTestId('file-card-view-pages')
    await expect(open).toHaveAccessibleName('View pages of document.pdf')
    await capture('pdf-card-view-pages.png', fileCard(a.page, 'document.pdf'), test.info())
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
    // tldraw would nudge a selected shape with the arrow keys and delete it with Delete.
    await a.page.keyboard.press('Delete')
    expect(await shapeBounds(a.page, card.id)).toEqual(cardBox)
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
    await expect(link).toHaveAttribute('href', new RegExp(`${ORIGINAL_SRC.source}${board}$`))
    await expect(link).toHaveAttribute('download', 'document.pdf')
    const res = await a.page.request.get((await link.getAttribute('href')) ?? '')
    expect(res.status()).toBe(200)
    expect(Buffer.compare(await res.body(), readFileSync(fixture('document.pdf')))).toBe(0)
  })

  let placed: Awaited<ReturnType<typeof imageShapes>> = []
  await test.step('select pages 2 and 3, Place on board: a row right of the card, selected, one toast', async () => {
    await expect(a.page.getByTestId('pdf-viewer-place')).toBeDisabled()
    await selectBox(a.page, 2).click()
    await selectBox(a.page, 3).click()
    await expect(a.page.getByTestId('pdf-viewer-selection')).toHaveText('2 pages selected')
    await capture('pdf-viewer.png', a.page, test.info())
    await a.page.getByTestId('pdf-viewer-place').click()
    await expect(viewer(a.page)).toHaveCount(0)
    await expect(a.page.getByTestId('pdf-pages-placed')).toHaveText(
      'Placed 2 pages of document.pdf next to it.',
    )
    placed = await waitForValue(async () => {
      const s = await imageShapes(a.page)
      return s.length === 2 ? s : null
    })
    expect(placed.map((p) => p.asset?.meta)).toEqual([{ drPdfPage: 2 }, { drPdfPage: 3 }])
    expect(placed.map((p) => p.altText)).toEqual(['Page 2 of document.pdf', 'Page 3 of document.pdf'])
    for (const p of placed) {
      // The PDF version's own stable ref: no host, no signed URL, no base64.
      expect(p.asset?.src).toMatch(STABLE_REF)
      expect(p.asset?.src).toBe(`/files/${card.props.assetId}/${card.props.versionId}/original`)
      expect(p.asset).toMatchObject({ mimeType: 'image/webp', w: 1024 })
      expect(p.parentId).toMatch(/^page:/)
      expect(p.bounds.y).toBeCloseTo(cardBox.y, 1) // tops aligned with the card
      expect(p.bounds.w).toBeCloseTo(512, 1) // half the 1024 px rendering
    }
    const [first, second] = placed
    if (!first || !second) throw new Error('two pages expected')
    expect(first.bounds.x).toBeGreaterThanOrEqual(cardBox.x + cardBox.w + 24)
    expect(first.bounds.x).toBeLessThan(cardBox.x + cardBox.w + 40)
    expect(second.bounds.x).toBeCloseTo(first.bounds.x + first.bounds.w + 24, 1)
    expect(await selectedIds(a.page)).toEqual(placed.map((p) => p.id).sort())
    // The board has the keys again (Delete, undo) for the new selection.
    await expect.poll(() => readM(a.page, (ed) => ed.getInstanceState().isFocused)).toBe(true)
    // The camera zooms out just enough to show the new row (like a drop), then settles.
    await expect
      .poll(() =>
        inView(
          a.page,
          placed.map((p) => p.id),
        ),
      )
      .toBe(true)
    await expect.poll(() => readM(a.page, (ed) => ed.getCameraState())).toBe('idle')
    for (const p of placed) await expectImage(a.page, p.id, DERIVATIVE_SRC)
    await capture('pdf-pages-placed.png', a.page, test.info())
  })

  await test.step('sharp: at 100 % and at 200 % every page shows a rendering with at least one pixel per screen pixel', async () => {
    const dpr = await a.page.evaluate(() => window.devicePixelRatio)
    for (const z of [1, 2]) {
      for (const p of placed) {
        await lookAt(a.page, p.id, z)
        await expectImage(a.page, p.id, DERIVATIVE_SRC)
        const img = a.page.locator(`[data-shape-id="${p.id}"] img.tl-image`).last()
        await expect
          .poll(() => naturalSize(img).then((s) => s.w))
          .toBeGreaterThanOrEqual(Math.ceil(p.bounds.w * z * dpr))
      }
    }
    // Only derivatives were fetched for the pages: never the PDF original.
    expect(requestsA.originals()).toEqual([])
    // Export / copy / "Download original" of a placed page get its largest rendering, not the PDF.
    const forExport = await readM(
      a.page,
      (ed, id) =>
        ed.resolveAssetUrl(String(ed.getShape(id)?.props.assetId), { shouldResolveToOriginal: true }),
      placed[0]?.id ?? '',
    )
    expect(forExport).toMatch(DERIVATIVE_SRC)
  })

  await test.step('bob sees both pages, from the same derivatives', async () => {
    await expect
      .poll(() => imageShapes(b.page).then((s) => s.map((p) => p.id)))
      .toEqual(placed.map((p) => p.id))
    await editF(b.page, (ed) => ed.zoomToFit())
    for (const p of placed) await expectImage(b.page, p.id, DERIVATIVE_SRC)
  })

  await test.step('one undo removes both pages (for bob too); redo brings them back', async () => {
    await a.page.keyboard.press('ControlOrMeta+z')
    for (const s of [a, b]) await expect.poll(() => imageShapes(s.page).then((x) => x.length)).toBe(0)
    expect(await read(a.page, (ed, id) => ed.getShape(id) !== undefined, card.id)).toBe(true)
    // tldraw keeps asset records out of undo (Editor.createAssets runs with history 'ignore'), as for
    // any image: the two page assets stay (a ref and a page number, no bytes) so redo can use them.
    expect(
      await readM(a.page, (ed) => ed.getAssets().filter((x) => x.meta.drPdfPage !== undefined).length),
    ).toBe(2)
    await a.page.keyboard.press('ControlOrMeta+Shift+z')
    for (const s of [a, b]) await expect.poll(() => imageShapes(s.page).then((x) => x.length)).toBe(2)
    for (const p of placed) await expectImage(b.page, p.id, DERIVATIVE_SRC)
  })
})

test('FIL-04 a 12-page PDF: the viewer says plainly that only the first 8 pages have previews; a viewer can read them but not place pages; Esc closes and returns the focus', async ({
  session,
}) => {
  const a = await session('alice')
  const pdf = await makePdf('long-brief.pdf', 12)
  await insertPayloads(a.page, [pdf])
  await readyCard(a.page, 'long-brief.pdf')
  const v = await session('bob', { role: 'viewer' })
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

  // Read-only: selecting works, placing does not (and the sync server would refuse the write).
  await selectBox(v.page, 1).click({ modifiers: [] })
  await selectBox(v.page, 4).click({ modifiers: ['Shift'] })
  await expect(v.page.getByTestId('pdf-viewer-selection')).toHaveText('4 pages selected')
  await expect(v.page.getByTestId('pdf-viewer-place')).toBeDisabled()
  await expect(v.page.getByTestId('pdf-viewer-readonly')).toHaveText(
    'You can view this board but not add to it.',
  )
  await capture('pdf-viewer-partial.png', v.page, test.info())

  await v.page.keyboard.press('Escape')
  await expect(viewer(v.page)).toHaveCount(0)
  await expect(open).toBeFocused()
  expect(await imageShapes(a.page)).toEqual([])

  // A plain click reopens it (a Shift released inside the viewer must not leave the board thinking
  // Shift is still held, which let the canvas take the click and select the card instead).
  await open.click()
  await expect(viewer(v.page)).toBeVisible()
  expect(await readM(v.page, (ed) => ed.getSelectedShapeIds())).toEqual([])

  // The card goes away (alice deletes it) while bob reads it: his viewer closes with it.
  const cardId = await read(
    a.page,
    (ed) => ed.getCurrentPageShapes().find((s: ShapeLike) => s.type === 'dr-file-card')?.id ?? '',
  )
  await editF(a.page, (ed, id) => ed.deleteShapes([id]), cardId)
  await expect(viewer(v.page)).toHaveCount(0)
})

test('FIL-04 a card inside a frame: placed pages join the frame when the row fits there, else land on the page beside the frame', async ({
  session,
}) => {
  const a = await session('alice')
  await insertFiles(a.page, [fixture('document.pdf')])
  const card = await readyCard(a.page, 'document.pdf')
  const place = async (pages: number[]) => {
    await fileCard(a.page, 'document.pdf').getByTestId('file-card-view-pages').click()
    for (const n of pages) await selectBox(a.page, n).click()
    await a.page.getByTestId('pdf-viewer-place').click()
    await expect(viewer(a.page)).toHaveCount(0)
  }
  const frameAround = (w: number, h: number) =>
    readM(
      a.page,
      (ed, arg) => {
        const b = ed.getShapePageBounds(arg.card)
        if (!b) return ''
        const id = `shape:frame-${arg.w}`
        ed.createShape({
          id,
          type: 'frame',
          x: b.x - 40,
          y: b.y - 60,
          props: { w: arg.w, h: arg.h, name: 'Brief' },
        })
        ed.reparentShapes([arg.card], id)
        ed.selectNone()
        ed.zoomToFit()
        return id
      },
      { card: card.id, w, h },
    )

  await test.step('a roomy frame: both pages go into it, inside its bounds', async () => {
    const frame = await frameAround(1600, 900)
    await place([1, 2])
    const placed = await waitForValue(async () => {
      const s = await imageShapes(a.page)
      return s.length === 2 ? s : null
    })
    const fb = await shapeBounds(a.page, frame)
    if (!fb) throw new Error('no frame')
    for (const p of placed) {
      expect(p.parentId).toBe(frame)
      expect(p.bounds.x).toBeGreaterThanOrEqual(fb.x)
      expect(p.bounds.x + p.bounds.w).toBeLessThanOrEqual(fb.x + fb.w)
      expect(p.bounds.y + p.bounds.h).toBeLessThanOrEqual(fb.y + fb.h)
    }
    await editF(a.page, (ed) => ed.undo())
    await expect.poll(() => imageShapes(a.page).then((s) => s.length)).toBe(0)
    // Take the card out again and drop that frame for the next case.
    await readM(
      a.page,
      (ed, arg) => {
        ed.reparentShapes([arg.card], ed.getCurrentPageId())
        ed.deleteShapes([arg.frame])
        return null
      },
      { card: card.id, frame },
    )
  })

  await test.step('a tight frame: the row cannot fit, so it lands on the page, clear of the frame', async () => {
    const frame = await frameAround(360, 480)
    await place([3])
    const [p] = await waitForValue(async () => {
      const s = await imageShapes(a.page)
      return s.length === 1 ? s : null
    })
    const fb = await shapeBounds(a.page, frame)
    if (!p || !fb) throw new Error('no page or frame')
    expect(p.parentId).toMatch(/^page:/)
    const clear =
      p.bounds.x >= fb.x + fb.w ||
      p.bounds.x + p.bounds.w <= fb.x ||
      p.bounds.y >= fb.y + fb.h ||
      p.bounds.y + p.bounds.h <= fb.y
    expect(clear).toBe(true)
  })
})

test('FIL-08 animated GIF: plays from the original once it is on screen at a readable size, a still when zoomed far out; a PNG never loads its original; with reduced motion the GIF stays a still', async ({
  session,
}) => {
  const a = await session('alice')
  const requestsA = recordRequests(a.page)
  const gif = gifPayload('loop.gif', 480, 320)
  const [png] = await makeImages(a.page, [{ name: 'still.png', w: 480, h: 320, type: 'image/png' }])
  if (!png) throw new Error('no png')
  const before = await allShapeIds(a.page)
  await insertPayloads(a.page, [gif, png])
  const ids = await waitForValue(async () => {
    const found = await newShapeIds(a.page, 'image', before)
    return found.length === 2 ? found : null
  })
  const byName = await readM(
    a.page,
    (ed, list) =>
      Object.fromEntries(
        list.map((id) => {
          const s = ed.getShape(id)
          const asset = s?.props.assetId ? ed.getAsset(String(s.props.assetId)) : undefined
          return [String(asset?.props.name), { id, assetSrc: String(asset?.props.src ?? '') }]
        }),
      ),
    ids,
  )
  const gifShape = byName['loop.gif']
  const pngShape = byName['still.png']
  if (!gifShape || !pngShape) throw new Error(`unexpected names: ${JSON.stringify(byName)}`)
  // Both uploads are stable refs by now (tldraw writes src once the bytes are in).
  await expect
    .poll(() =>
      readM(
        a.page,
        (ed, list) =>
          list.map((id) => String(ed.getAsset(String(ed.getShape(id)?.props.assetId))?.props.src)),
        ids,
      ),
    )
    .toEqual([expect.stringMatching(STABLE_REF), expect.stringMatching(STABLE_REF)])
  const originalOf = async (id: string) => {
    const src = await readM(
      a.page,
      (ed, sid) => String(ed.getAsset(String(ed.getShape(sid)?.props.assetId))?.props.src),
      id,
    )
    return src.replace(/\/original$/, '/original?board=')
  }
  const gifOriginal = await originalOf(gifShape.id)
  const pngOriginal = await originalOf(pngShape.id)

  await test.step('zoomed far out (10 %): the GIF is its static preview', async () => {
    await lookAt(a.page, gifShape.id, 0.1)
    await expectImage(a.page, gifShape.id, DERIVATIVE_SRC, 60_000)
  })

  await test.step('zoomed in (100 %): the GIF switches to its original and animates; the PNG stays a derivative', async () => {
    await lookAt(a.page, gifShape.id, 1)
    await expectImage(a.page, gifShape.id, ORIGINAL_SRC)
    expect((await imageSrc(a.page, gifShape.id))?.src).toContain(gifOriginal)
    // Two captures of the GIF a few frames apart differ: it is playing (frames change every 120 ms).
    const shot = () => a.page.locator(`[data-shape-id="${gifShape.id}"] img.tl-image`).last().screenshot()
    const first = await shot()
    await expect.poll(async () => Buffer.compare(first, await shot()) !== 0, { timeout: 5_000 }).toBe(true)
    await lookAt(a.page, pngShape.id, 1)
    await expectImage(a.page, pngShape.id, DERIVATIVE_SRC)
    await lookAt(a.page, pngShape.id, 4)
    await a.page.waitForTimeout(1200) // past tldraw's 500 ms re-resolve debounce
    await expectImage(a.page, pngShape.id, DERIVATIVE_SRC)
  })

  await test.step('zoomed out again: back to the static preview', async () => {
    await lookAt(a.page, gifShape.id, 0.1)
    await expectImage(a.page, gifShape.id, DERIVATIVE_SRC)
  })

  // FIL-02 still holds: the PNG's original was never requested, the GIF's only while it played.
  expect(requestsA.urls.filter((u) => u.includes(pngOriginal))).toEqual([])
  expect(requestsA.urls.filter((u) => u.includes(gifOriginal)).length).toBeGreaterThan(0)

  await test.step('reduced motion: a second person zoomed in on the GIF never loads its original', async () => {
    const b = await session('bob')
    await b.page.emulateMedia({ reducedMotion: 'reduce' })
    const requestsB = recordRequests(b.page)
    await b.page.reload()
    await expect(b.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', {
      timeout: 30_000,
    })
    await b.page.waitForFunction(() => window.editor !== undefined)
    await lookAt(b.page, gifShape.id, 1)
    await b.page.waitForTimeout(1500)
    const resolved = await readM(
      b.page,
      (ed, id) => ed.resolveAssetUrl(String(ed.getShape(id)?.props.assetId), { screenScale: 1 }),
      gifShape.id,
    )
    expect(resolved).toMatch(DERIVATIVE_SRC)
    // tldraw shows the first frame (a still) of whatever it resolved.
    await expect.poll(() => imageSrc(b.page, gifShape.id).then((s) => s?.loaded ?? false)).toBe(true)
    expect(requestsB.urls.filter((u) => u.includes(gifOriginal))).toEqual([])
  })
})
