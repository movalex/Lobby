// Wave 3g, ported from e2e/tests/files.spec.ts: files on the Excalidraw canvas (docs/EXCALIDRAW-MIGRATION.md
// §2.10, §4.1). Real uploads go through the api file routes (signed-in session, board permission) and the
// preview worker to `image` elements holding only the version id and the stable facts; the canvas shows
// the worker's derivatives through Lobby's image loader, cards draw today's face over their element.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- media-files
//
// What differs from the tldraw spec (docs/research/excalidraw/wave3/3G.md): a card is an `image` element
// with `customData.lobby.file` (no dr-file-card record, no hint props: live facts come from the api's
// meta, so a card says "Loading" until the meta answers); the uploading tab has no local preview (the
// image appears once uploaded, with Lobby's "Processing…" tile until its derivative is there); the
// template is pushed as a scene (the template insert is 3b's, CR-2D-2); Alt+1 and the first-open start
// view are 3b's and are not checked here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import {
  type CanvasSession,
  expect,
  itemBounds,
  items,
  sceneToScreen,
  select,
  selection,
  selectNone,
  setViewport,
  test,
  updateItem,
  viewport,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { pressRedo, pressUndo } from '../tests/support/excalidraw.ts'
import { dropFiles, type FilePayload, makeImages } from '../tests/support/files.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import {
  allIds,
  boxOf,
  cardItems,
  contains,
  DERIVATIVE_SRC,
  expectLoadedImage,
  fileCard,
  fileItems,
  frameByName,
  imageItems,
  imageState,
  insertFiles,
  newItems,
  ORIGINAL_HREF,
  overlaps,
  placeholder,
  pushTemplate,
  recordRequests,
  settleCamera,
  slotsOf,
  urlOf,
} from './media-kit.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)

/** The card's <img> decoded from a board-scoped derivative. */
async function expectLoadedFaceImage(img: Locator, board: string) {
  await expect(img).toHaveAttribute('src', DERIVATIVE_SRC)
  await expect(img).toHaveAttribute('src', new RegExp(`\\?board=${board}$`))
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

/** The Download link serves the original bytes of `name` as an attachment. */
async function expectDownload(s: CanvasSession, card: Locator, name: string, board: string) {
  const link = card.getByTestId('file-card-download')
  await expect(link).toHaveAttribute('href', ORIGINAL_HREF)
  await expect(link).toHaveAttribute('href', new RegExp(`\\?board=${board}$`))
  const href = (await link.getAttribute('href')) ?? ''
  const res = await s.page.request.get(href)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-disposition']).toMatch(/^attachment;/)
  expect(Buffer.compare(await res.body(), readFileSync(fixture(name)))).toBe(0)
}

/** Records every data-status each card face shows, in order (deduplicated), keyed by file name. */
async function recordCardStatuses(page: Page) {
  await page.evaluate(() => {
    const log: Record<string, string[]> = {}
    ;(window as unknown as { __cardStatuses: Record<string, string[]> }).__cardStatuses = log
    const note = () => {
      for (const el of document.querySelectorAll('[data-testid="file-card"]')) {
        const name = el.querySelector('.dr-fc__name')?.textContent ?? '?'
        const status = el.getAttribute('data-status') ?? '?'
        log[name] ??= []
        const seq = log[name]
        if (seq[seq.length - 1] !== status) seq.push(status)
      }
    }
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-status'],
    })
    note()
  })
}
const cardStatuses = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cardStatuses: Record<string, string[]> }).__cardStatuses)

test('6) a file card (an image element with its stable facts) created on A is the same element on B; B’s rename reaches A', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await insertFiles(a.page, [fixture('document.pdf')])
  const [card] = await newItems(a.page, cardItems, new Set(), 1)
  if (!card) throw new Error('no card')
  await expect(fileCard(b.page, 'document.pdf')).toHaveAttribute('data-kind', 'pdf')
  const onB = (await fileItems(b.page)).find((f) => f.id === card.id)
  expect(onB?.facts).toEqual(card.facts)
  expect(card.fileId).toBe(card.facts.versionId)
  expect(card.facts).toMatchObject({ kind: 'pdf', name: 'document.pdf', mimeType: 'application/pdf' })
  // nothing but ids and facts: no URL, no bytes
  const el = (await items(a.page)).find((e) => e.id === card.id) as unknown as Record<string, unknown>
  expect(JSON.stringify(el)).not.toMatch(/data:|blob:|\/files\/|https?:/)

  // And back: the name is the one client-writable fact.
  await updateItem(b.page, card.id, {
    customData: { lobby: { file: { ...card.facts, name: 'document-v2.pdf' } } },
  })
  await expect
    .poll(async () => (await fileItems(a.page)).find((f) => f.id === card.id)?.facts.name)
    .toBe('document-v2.pdf')
})

test('7) uploads: PDF, MP4, encrypted PDF and an attachment become cards on both clients', async ({
  canvasSession,
  stack,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await Promise.all([recordCardStatuses(a.page), recordCardStatuses(b.page)])
  const files = ['document.pdf', 'video.mp4', 'encrypted.pdf', 'notes.zip']

  // With the worker stopped, every card must sit in 'queued' where both users can see it.
  await stack.worker.kill()
  await insertFiles(a.page, files.map(fixture))
  for (const s of [a, b]) {
    for (const name of files)
      await expect(fileCard(s.page, name)).toHaveAttribute('data-status', 'queued', { timeout: 30_000 })
  }
  await stack.worker.start()

  for (const s of [a, b]) {
    await test.step(`${s.user}: document.pdf -> ready, cover + 4 pages`, async () => {
      const card = fileCard(s.page, 'document.pdf')
      await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
      await expect(card).toHaveAttribute('data-kind', 'pdf')
      await expectLoadedFaceImage(card.getByTestId('file-card-preview'), board)
      await expect(card.getByTestId('file-card-pages')).toHaveText('4 pages')
      // Pages 2..4 were rendered eagerly too (the page strip).
      await expect(card.locator('[data-testid="file-card-strip"] img')).toHaveCount(3)
    })
    await test.step(`${s.user}: video.mp4 -> ready, poster + duration + play`, async () => {
      const card = fileCard(s.page, 'video.mp4')
      await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
      await expect(card).toHaveAttribute('data-kind', 'video')
      await expectLoadedFaceImage(card.getByTestId('file-card-preview'), board)
      await expect(card.getByTestId('file-card-duration')).toHaveText('0:05')
      await expect(card.getByTestId('file-card-play')).toBeVisible()
    })
    await test.step(`${s.user}: encrypted.pdf -> failed, readable error, download`, async () => {
      const card = fileCard(s.page, 'encrypted.pdf')
      await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 60_000 })
      await expect(card.getByTestId('file-card-error')).toHaveText(
        'This PDF is password-protected. Download it to view it.',
      )
      await expectDownload(s, card, 'encrypted.pdf', board)
    })
    await test.step(`${s.user}: notes.zip -> attachment card with download`, async () => {
      const card = fileCard(s.page, 'notes.zip')
      await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
      await expect(card).toHaveAttribute('data-kind', 'other')
      await expect(card).toContainText('Attachment')
      await expect(card.getByTestId('file-card-preview')).toHaveCount(0)
      await expectDownload(s, card, 'notes.zip', board)
    })
  }

  await test.step('the canvas face of the PDF and the video is the worker’s cover and poster', async () => {
    for (const c of (await cardItems(b.page)).filter((x) => x.facts.kind !== 'other')) {
      if (c.facts.name === 'encrypted.pdf') continue
      await expectLoadedImage(b.page, c.id, board)
    }
  })

  await test.step('authorship comes from the session: every upload is recorded as alice’s', async () => {
    const cards = await cardItems(b.page)
    expect(cards).toHaveLength(files.length)
    for (const card of cards) {
      // bob reads the meta route with his own session (view on this board is enough).
      const res = await b.page.request.get(
        `/api/boards/${board}/assets/${card.facts.assetId}/${card.facts.versionId}`,
      )
      expect(res.status()).toBe(200)
      expect(((await res.json()) as { uploadedBy?: unknown }).uploadedBy).toBe(a.id)
    }
  })

  // Every card moved forward only: queued first (after "Loading" while the meta route has not answered),
  // then (possibly a brief processing), then terminal.
  const terminal: Record<string, string> = {
    'document.pdf': 'ready',
    'video.mp4': 'ready',
    'encrypted.pdf': 'failed',
    'notes.zip': 'ready',
  }
  for (const s of [a, b]) {
    const seen = await cardStatuses(s.page)
    for (const name of files) {
      const seq = (seen[name] ?? []).filter((x) => x !== 'loading')
      expect([
        ['queued', terminal[name]],
        ['queued', 'processing', terminal[name]],
      ]).toContainEqual(seq)
    }
    test.info().annotations.push({ type: `${s.user} card statuses`, description: JSON.stringify(seen) })
  }

  await b.page.setViewportSize({ width: 1600, height: 820 })
  await zoomToFit(b.page)
  for (const name of files) await expect(fileCard(b.page, name)).toBeInViewport()
  await b.page.screenshot({ path: test.info().outputPath('file-cards-ready.png') })
})

// ---- where uploads land (FIL-06, F1/F2/F5/F6), previews and the original (F4, PERF-01), cards (F7a) --

const IMAGE_SIZES: [number, number][] = [
  [1600, 1067],
  [1080, 1350],
  [1200, 1200],
  [2400, 1000],
  [1080, 1920],
  [3000, 2000],
  [800, 600],
  [1920, 1080],
  [1000, 1500],
  [2560, 1440],
  [640, 960],
  [4000, 2667],
]
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
const IMAGE_EXTS = ['jpg', 'png', 'webp'] as const
const mixedImages = (page: Page, prefix: string, n: number) =>
  makeImages(
    page,
    IMAGE_SIZES.slice(0, n).map(([w, h], i) => ({
      name: `${prefix}-${i + 1}.${IMAGE_EXTS[i % 3]}`,
      w,
      h,
      type: IMAGE_TYPES[i % 3],
    })),
  )

/** Every placed image lies inside its frame (when it has one). */
async function outsideTheirFrame(page: Page) {
  const all = await imageItems(page)
  const frames = new Map((await items(page)).filter((e) => e.type === 'frame').map((f) => [f.id, boxOf(f)]))
  return all
    .filter((i) => i.frameId && !contains(frames.get(i.frameId) ?? boxOf(i), boxOf(i)))
    .map((i) => i.id)
}

test('F1/F2 uploads with the view on "3 · Imagery": 3 then 12 images land in grids inside their frame or on the page, one undo each', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  await pushTemplate(a.page, board, 'mood-board')
  const templateFrames = (await items(a.page)).filter((e) => e.type === 'frame').map(boxOf)
  expect(templateFrames).toHaveLength(4)
  const imagery = await frameByName(a.page, '3 · Imagery')
  if (!imagery) throw new Error('no "3 · Imagery" frame')
  // the view centred on the frame (the frames panel's jump is 3b's)
  await setViewport(a.page, {
    x: imagery.x + imagery.w / 2 - 700,
    y: imagery.y + imagery.h / 2 - 400,
    zoom: 0.5,
  })
  await settleCamera(a.page)

  const three = await mixedImages(a.page, 'three', 3)
  const twelve = await mixedImages(a.page, 'twelve', 12)
  const upload = async (files: FilePayload[]) => {
    const before = await allIds(a.page)
    await insertFiles(a.page, files)
    const placed = await newItems(a.page, imageItems, before, files.length)
    await settleCamera(a.page)
    return placed.map((p) => p.id)
  }

  const first = await upload(three)
  await test.step('3 images: every image lies inside its frame, or sits on the page', async () => {
    expect(await outsideTheirFrame(a.page)).toEqual([])
  })

  const second = await upload(twelve)
  await test.step('12 images: a 4-column grid, equal sizes, no overlaps, clear of the template', async () => {
    const all = await imageItems(a.page)
    expect(await outsideTheirFrame(a.page)).toEqual([])
    const grid = all.filter((s) => second.includes(s.id))
    const longest = grid.map((s) => Math.max(s.width, s.height))
    expect(Math.max(...longest) / Math.min(...longest)).toBeLessThan(1.01)
    // F2-01: one page-space size across uploads
    const firstLongest = all.filter((s) => first.includes(s.id)).map((s) => Math.max(s.width, s.height))
    for (const l of [...firstLongest, ...longest]) expect(l).toBeCloseTo(longest[0] ?? 0, 0)
    const centre = (s: { x: number; y: number; width: number; height: number }) => ({
      x: s.x + s.width / 2,
      y: s.y + s.height / 2,
    })
    expect(new Set(grid.map((s) => Math.round(centre(s).x))).size).toBe(4)
    expect(new Set(grid.map((s) => Math.round(centre(s).y))).size).toBe(3)
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(overlaps(boxOf(all[i] as never), boxOf(all[j] as never))).toBe(false)
    for (const img of all.filter((s) => s.frameId === null))
      for (const f of templateFrames) expect(overlaps(boxOf(img), f), `${img.id} over a frame`).toBe(false)
    // The whole grid is in view after the drop.
    const vp = await viewport(a.page)
    for (const s of grid)
      expect(contains({ x: vp.x, y: vp.y, w: vp.width, h: vp.height }, boxOf(s), 1)).toBe(true)
  })

  await test.step('one undo removes the 12 (not the first 3); redo brings them back', async () => {
    await pressUndo(a.page)
    await expect
      .poll(async () => (await imageItems(a.page)).map((s) => s.id).sort())
      .toEqual([...first].sort())
    await pressRedo(a.page)
    await expect.poll(async () => (await imageItems(a.page)).length).toBe(15)
  })
})

test('F4 previews in progress: nobody downloads the original; both tabs show the derivative once it exists; export still gets the original', async ({
  canvasSession,
  stack,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const onA = recordRequests(a.page)
  const onB = recordRequests(b.page)
  // A 20 MP photo (5472 x 3648), with enough detail to be a real multi-megabyte JPEG.
  const [photo] = await makeImages(a.page, [{ name: 'photo-20mp.jpg', w: 5472, h: 3648, detail: 1 }])
  if (!photo) throw new Error('no photo')
  expect(photo.buffer.length).toBeGreaterThan(1.5 * 1024 * 1024)

  await stack.worker.kill() // previews cannot be made until the worker is back
  await insertFiles(a.page, [photo])
  const [img] = await newItems(a.page, imageItems, new Set(), 1)
  if (!img) throw new Error('no image')
  await expect.poll(async () => (await imageItems(b.page)).length).toBe(1)

  await test.step('while queued: both tabs show the "Processing…" tile with the name; nobody fetches the original', async () => {
    for (const s of [a, b]) {
      await expect(placeholder(s.page, img.id)).toHaveAttribute('data-state', 'processing')
      await expect(placeholder(s.page, img.id)).toContainText('Processing…')
      await expect(placeholder(s.page, img.id)).toContainText('photo-20mp.jpg')
    }
    await a.page.waitForTimeout(3000)
    expect(onA.originals()).toEqual([])
    expect(onB.originals()).toEqual([])
  })

  await stack.worker.start()
  await test.step('once the derivative exists, both tabs show it (still no original)', async () => {
    for (const s of [a, b]) {
      await expectLoadedImage(s.page, img.id, board, 90_000)
      await expect(placeholder(s.page, img.id)).toHaveCount(0)
    }
    expect(onA.originals()).toEqual([])
    expect(onB.originals()).toEqual([])
  })

  await test.step('export / copy / download resolve to the original', async () => {
    const url = await urlOf(b.page, img.id, true)
    expect(url).toMatch(ORIGINAL_HREF)
    expect(url).toMatch(new RegExp(`\\?board=${board}$`))
  })
})

test('F5 bad files together: the rejected image is a readable, selectable tile; error cards land in view; the oversize file is named', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const oversize: FilePayload = {
    name: 'oversize-31mb-dunes.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(31 * 1024 * 1024, 0xff),
  }
  await insertFiles(a.page, [
    fixture('bomb-12000x12000.png'),
    fixture('garbage.pdf'),
    fixture('encrypted.pdf'),
    fixture('truncated.mp4'),
    oversize,
  ])
  await expect(
    a.page.getByText('oversize-31mb-dunes.jpg is larger than 25 MB, the limit for images.'),
  ).toBeVisible()

  const [bomb] = await newItems(a.page, imageItems, new Set(), 1)
  if (!bomb) throw new Error('no image element')
  await test.step('the image the worker rejected shows "Couldn’t process this image"', async () => {
    const tile = placeholder(a.page, bomb.id)
    await expect(tile).toHaveAttribute('data-state', 'unavailable', { timeout: 60_000 })
    await expect(tile).toContainText("Couldn't process this image")
    await expect(tile).toBeInViewport()
    // Page-space size from its header, never decoded in the tab (not 12,000 x 12,000).
    expect(Math.max(bomb.width, bomb.height)).toBeLessThan(1000)
    await select(a.page, [bomb.id])
    expect(await selection(a.page)).toEqual([bomb.id])
  })
  await test.step('each broken file ends as an error card inside the viewport', async () => {
    for (const name of ['garbage.pdf', 'encrypted.pdf', 'truncated.mp4']) {
      const card = fileCard(a.page, name)
      await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 60_000 })
      await expect(card).toBeInViewport({ ratio: 0.99 })
      await expect(card.getByTestId('file-card-error')).toBeVisible()
    }
    const all = await fileItems(a.page)
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(overlaps(boxOf(all[i] as never), boxOf(all[j] as never))).toBe(false)
  })
})

test('F6 a frame grab dropped on a Storyboard slot fills that slot (locked, still a drop target); the heading and timing stay visible', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  await pushTemplate(a.page, board, 'storyboard')
  const panel = await frameByName(a.page, 'Panel 1')
  if (!panel) throw new Error('no Panel 1')
  const [slot] = await slotsOf(a.page, panel.id)
  if (!slot) throw new Error('no marked slot in Panel 1')
  expect(slot.locked).toBe(true)
  // the panel's heading and timing (free texts; the slot's own label is under the image, as on tldraw)
  const texts = (await items(a.page)).filter(
    (e) => e.frameId === panel.id && e.type === 'text' && !(e as { containerId?: string | null }).containerId,
  )
  expect(texts.length).toBeGreaterThanOrEqual(2)
  await setViewport(a.page, { x: panel.x - 100, y: panel.y - 100, zoom: 1 })
  await settleCamera(a.page)

  const [grab] = await makeImages(a.page, [{ name: 'frame-grab.jpg', w: 1920, h: 1080 }])
  if (!grab) throw new Error('no image')
  const at = await sceneToScreen(a.page, { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 })
  await dropFiles(a.page, [grab], at)
  const [placed] = await newItems(a.page, imageItems, new Set(), 1)
  if (!placed) throw new Error('no image')

  expect(placed.frameId).toBe(panel.id)
  expect(contains(slot, boxOf(placed))).toBe(true)
  expect(placed.width).toBeCloseTo(slot.w, 0) // 16:9 into a 16:9 slot fills it
  // Painted above the slot (new elements go on top: the exact "just above the slot" z of tldraw is not kept).
  expect(placed.index > slot.index).toBe(true)
  for (const t of texts) {
    const tb = await itemBounds(a.page, t.id)
    expect(tb && overlaps({ x: tb.x, y: tb.y, w: tb.width, h: tb.height }, boxOf(placed))).toBe(false)
  }
  await expectLoadedImage(a.page, placed.id, board)
})

test('F7a double-clicking a PDF or video card opens the original in a new tab (no text edit, nothing new); the Download link shows a focus ring', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  await insertFiles(a.page, [fixture('document.pdf'), fixture('video.mp4')])
  for (const name of ['document.pdf', 'video.mp4']) {
    const card = fileCard(a.page, name)
    await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
    await selectNone(a.page)
    const before = (await items(a.page)).length
    const box = await card.boundingBox()
    if (!box) throw new Error(`${name} has no box`)
    const popup = a.context.waitForEvent('page')
    const opened = a.context.waitForEvent(
      'request',
      (r) => r.isNavigationRequest() && r.url().includes('/original?board='),
    )
    // On the footer: clear of the video's play button.
    await a.page.mouse.dblclick(box.x + box.width / 3, box.y + box.height - 24)
    const tab = await popup
    const url = (await opened).url()
    expect(url).toMatch(new RegExp(`/files/ast_\\w{20}/ver_\\w{20}/original\\?board=${board}$`))
    const href = (await card.getByTestId('file-card-download').getAttribute('href')) ?? ''
    expect(url).toBe(new URL(href, url).href) // the same link as Download
    await tab.close()
    expect(await a.page.locator('textarea.excalidraw-wysiwyg').count()).toBe(0)
    expect((await items(a.page)).length).toBe(before)
  }

  const link = fileCard(a.page, 'document.pdf').getByTestId('file-card-download')
  await a.page.keyboard.press('Escape') // keyboard modality, as when tabbing to the link
  await link.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions))
  const ring = await link.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { focusVisible: el.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth }
  })
  expect(ring).toEqual({ focusVisible: true, style: 'solid', width: '2px' })
})

test('W5-12 a phone photo stored landscape with EXIF Orientation 6 lands portrait, like its derivatives (not squashed)', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  // image-exif6.jpg: 1920 × 1080 pixels stored, EXIF Orientation 6: shown 1080 × 1920
  await insertFiles(a.page, [fixture('image-exif6.jpg')])
  const [photo] = await newItems(a.page, imageItems, new Set(), 1)
  if (!photo) throw new Error('no image')
  expect(photo.height).toBeGreaterThan(photo.width)
  expect(photo.height / photo.width).toBeCloseTo(1920 / 1080, 2)
  await expectLoadedImage(a.page, photo.id, board)
  // the worker's thumb is auto-oriented: the box has its proportions, so nothing is stretched
  const shown = await imageState(a.page, photo.id)
  const natural = shown.natural as { w: number; h: number }
  expect(natural.h).toBeGreaterThan(natural.w)
  expect(photo.height / photo.width).toBeCloseTo(natural.h / natural.w, 1)
})

test('W5-56 the uploading tab sees its own images at once (at their places while uploading, then under "Processing…"); others see the placeholder; nothing local is stored', async ({
  canvasSession,
  stack,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await stack.worker.kill() // no derivative until the worker is back
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  // hold the uploads, so the time they take can be seen
  await a.page.route('**/api/boards/*/assets', async (route) => {
    if (route.request().method() === 'POST') await gate
    await route.continue()
  })
  const files = await makeImages(a.page, [
    { name: 'shot-1.jpg', w: 1200, h: 800 },
    { name: 'shot-2.jpg', w: 800, h: 1200 },
    { name: 'shot-3.png', w: 900, h: 900, type: 'image/png' },
  ])
  await insertFiles(a.page, files)

  await test.step('while uploading: a local copy of each image at its planned place, nothing on the board yet', async () => {
    const ghosts = a.page.getByTestId('upload-ghost')
    await expect(ghosts).toHaveCount(3)
    for (const img of await ghosts.locator('img').all()) {
      await expect(img).toHaveAttribute('src', /^blob:/)
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    }
    await expect(ghosts.first()).toContainText('Uploading…')
    expect(await imageItems(a.page)).toHaveLength(0)
  })

  release()
  const placed = await newItems(a.page, imageItems, new Set(), 3)
  await expect(a.page.getByTestId('upload-ghost')).toHaveCount(0)
  await a.page.unroute('**/api/boards/*/assets')

  await test.step('uploaded, not processed: this tab shows its copy under "Processing…", bob the placeholder', async () => {
    for (const p of placed) {
      const mine = placeholder(a.page, p.id)
      await expect(mine).toHaveAttribute('data-local-preview', '')
      await expect(mine.locator('img')).toHaveAttribute('src', /^blob:/)
      await expect(mine).toContainText('Processing…')
      await expect(mine).toContainText(p.facts.name)
      const theirs = placeholder(b.page, p.id)
      await expect(theirs).toContainText('Processing…', { timeout: 30_000 })
      await expect(theirs).not.toHaveAttribute('data-local-preview')
      await expect(theirs.locator('img')).toHaveCount(0)
    }
    // the preview is this tab's only: no element holds a blob: or data: URL
    expect(JSON.stringify(await items(a.page))).not.toMatch(/blob:|data:image/)
  })

  await stack.worker.start()
  await test.step('once the derivatives exist, both tabs show them; the local copies are gone', async () => {
    for (const p of placed) {
      await expectLoadedImage(a.page, p.id, board, 90_000)
      await expectLoadedImage(b.page, p.id, board, 90_000)
      await expect(placeholder(a.page, p.id)).toHaveCount(0)
    }
  })
})

/** WCAG contrast of two `rgb(…)` colours. */
function contrast(fg: string, bg: string): number {
  const lum = (c: string) => {
    const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number]
  return (l1 + 0.05) / (l2 + 0.05)
}

test('W5-36 a card’s corners and colours: new cards are rounded on the canvas as on screen; in dark mode the card body is dark and its error text readable', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  await a.page.emulateMedia({ colorScheme: 'dark' })
  await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await insertFiles(a.page, [fixture('document.pdf'), fixture('encrypted.pdf')])
  const cards = await newItems(a.page, cardItems, new Set(), 2)
  for (const c of cards) {
    const el = (await items(a.page)).find((e) => e.id === c.id) as unknown as { roundness: unknown }
    // the canvas face (the cover the engine draws, and exports) is clipped to the face's 10-unit corners
    expect(el.roundness).toEqual({ type: 3, value: 10 })
  }
  const ready = fileCard(a.page, 'document.pdf')
  await expect(ready).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await expect.poll(() => ready.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('10px')

  const failed = fileCard(a.page, 'encrypted.pdf')
  await expect(failed).toHaveAttribute('data-status', 'failed', { timeout: 60_000 })
  const colours = await failed.evaluate((el) => {
    const preview = el.querySelector('.dr-fc__preview') as HTMLElement
    const error = el.querySelector('[data-testid="file-card-error"]') as HTMLElement
    return { body: getComputedStyle(preview).backgroundColor, text: getComputedStyle(error).color }
  })
  // not the light theme's beige (#f3f1ea) under the dark theme's red
  expect(colours.body).not.toBe('rgb(243, 241, 234)')
  expect(contrast(colours.text, colours.body)).toBeGreaterThanOrEqual(4.5)
})
