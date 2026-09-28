// Milestone-0 demonstrations 6 and 7: the shared dr-file-card shape, and real uploads going through
// the api file routes (signed-in session, board permission) and the preview worker (child process) to
// cards on both clients.
//
// The migration of dr-file-card and server-side rejection of invalid records are covered below the
// browser: packages/canvas-schema/src/file-card.test.ts, apps/web/src/schema.test.ts (client schema
// === server schema), apps/sync/test/protocol/schema.test.ts (old/new clients, migrate on load) and
// apps/sync/test/protocol/validation.test.ts (INVALID_RECORD).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import {
  edit,
  fileCard,
  getShape,
  insertFiles,
  pageShapes,
  read,
  type Session,
  shapeBounds,
  toScreen,
  waitForValue,
} from './support/board.ts'
import {
  contains,
  inView,
  overlaps,
  startView,
  viewport,
  waitForCanvasUx,
  zoom,
} from './support/canvas-ux.ts'
import type { BoxLike } from './support/editor.ts'
import {
  allShapeIds,
  dropFiles,
  editF,
  type FilePayload,
  imageSrc,
  insertPayloads,
  makeImages,
  newShapeIds,
  outsideTheirFrame,
  type PlacedShape,
  placedShapes,
  readF,
  recordRequests,
  settleCamera,
} from './support/files.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'
import { FIXTURES_DIR } from './support/stack.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)
const ORIGINAL_HREF = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/original\?board=/
const DERIVATIVE_SRC = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/d\/drv_[0-9A-Za-z]{20}\?board=/

/** The image decoded (so the derivative route really served an image) and is board-scoped. */
async function expectLoadedImage(img: Locator, board: string) {
  await expect(img).toHaveAttribute('src', DERIVATIVE_SRC)
  await expect(img).toHaveAttribute('src', new RegExp(`\\?board=${board}$`))
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

/** The download link serves the original bytes of `name` as an attachment. */
async function expectDownload(s: Session, card: Locator, name: string, board: string) {
  const link = card.getByTestId('file-card-download')
  await expect(link).toHaveAttribute('href', ORIGINAL_HREF)
  await expect(link).toHaveAttribute('href', new RegExp(`\\?board=${board}$`))
  const href = (await link.getAttribute('href')) ?? ''
  const res = await s.page.request.get(href)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-disposition']).toMatch(/^attachment;/)
  expect(Buffer.compare(await res.body(), readFileSync(fixture(name)))).toBe(0)
}

/** Records every data-status each file card shows, in order (deduplicated), keyed by file name. */
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

test('6) custom dr-file-card (shared schema): a card created on A renders on B with the same props', async ({
  session,
}) => {
  const CARD = 'shape:schema-card'
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    a.page,
    (ed, id) =>
      ed.createShape({
        id,
        type: 'dr-file-card',
        x: 200,
        y: 160,
        props: {
          w: 260,
          h: 356,
          // Ids the schema accepts but that name no stored upload, so every tab renders the hint props.
          assetId: 'ast_schemaDemo01',
          versionId: 'ver_schemaDemo01',
          kind: 'pdf',
          name: 'q3-plan.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 48213,
          status: 'processing',
          pageCount: 12,
          durationMs: null,
          posterDerivativeId: null,
        },
      }),
    CARD,
  )
  const card = fileCard(b.page, 'q3-plan.pdf')
  await expect(card).toHaveAttribute('data-kind', 'pdf')
  await expect(card).toHaveAttribute('data-status', 'processing')
  await expect(card.getByTestId('file-card-pages')).toHaveText('12 pages')
  const onA = await getShape(a.page, CARD)
  const onB = await getShape(b.page, CARD)
  expect(onB?.props).toEqual(onA?.props)
  expect(onB?.props).toMatchObject({ name: 'q3-plan.pdf', pageCount: 12, posterDerivativeId: null })

  // And back: B's edit to the custom shape reaches A.
  await edit(
    b.page,
    (ed, id) => ed.updateShape({ id, type: 'dr-file-card', props: { name: 'q3-plan-v2.pdf' } }),
    CARD,
  )
  await expect(fileCard(a.page, 'q3-plan-v2.pdf')).toBeVisible()
})

test('7) uploads: PDF, MP4, encrypted PDF and an attachment become cards on both clients', async ({
  session,
  stack,
  board,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await Promise.all([recordCardStatuses(a.page), recordCardStatuses(b.page)])
  const files = ['document.pdf', 'video.mp4', 'encrypted.pdf', 'notes.zip']

  // With the worker stopped, every card must sit in 'queued' where both users can see it.
  await stack.worker.kill()
  await insertFiles(a.page, files.map(fixture))
  for (const s of [a, b]) {
    for (const name of files) await expect(fileCard(s.page, name)).toHaveAttribute('data-status', 'queued')
  }
  await stack.worker.start()

  for (const s of [a, b]) {
    await test.step(`${s.user}: document.pdf -> ready, cover + 4 pages`, async () => {
      const card = fileCard(s.page, 'document.pdf')
      await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
      await expect(card).toHaveAttribute('data-kind', 'pdf')
      await expectLoadedImage(card.getByTestId('file-card-preview'), board)
      await expect(card.getByTestId('file-card-pages')).toHaveText('4 pages')
      // Pages 2..4 were rendered eagerly too (the page strip).
      await expect(card.locator('[data-testid="file-card-strip"] img')).toHaveCount(3)
    })
    await test.step(`${s.user}: video.mp4 -> ready, poster + duration + play`, async () => {
      const card = fileCard(s.page, 'video.mp4')
      await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
      await expect(card).toHaveAttribute('data-kind', 'video')
      await expectLoadedImage(card.getByTestId('file-card-preview'), board)
      await expect(card.getByTestId('file-card-duration')).toHaveText('0:05')
      await expect(card.getByTestId('file-card-play')).toBeVisible()
    })
    await test.step(`${s.user}: encrypted.pdf -> failed, readable error, download`, async () => {
      const card = fileCard(s.page, 'encrypted.pdf')
      await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 30_000 })
      await expect(card.getByTestId('file-card-error')).toHaveText(
        'This PDF is password-protected. Download it to view it.',
      )
      await expectDownload(s, card, 'encrypted.pdf', board)
    })
    await test.step(`${s.user}: notes.zip -> attachment card with download`, async () => {
      const card = fileCard(s.page, 'notes.zip')
      await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
      await expect(card).toHaveAttribute('data-kind', 'other')
      await expect(card).toContainText('Attachment')
      await expect(card.getByTestId('file-card-preview')).toHaveCount(0)
      await expectDownload(s, card, 'notes.zip', board)
    })
  }

  await test.step('authorship comes from the session: every upload is recorded as alice’s', async () => {
    const cards = (await pageShapes(b.page)).filter((s) => s.type === 'dr-file-card')
    expect(cards).toHaveLength(files.length)
    for (const card of cards) {
      // bob reads the meta route with his own session (view on this board is enough).
      const res = await b.page.request.get(
        `/api/boards/${board}/assets/${card.props.assetId}/${card.props.versionId}`,
      )
      expect(res.status()).toBe(200)
      expect(((await res.json()) as { uploadedBy?: unknown }).uploadedBy).toBe(a.id)
    }
  })

  // Every card moved forward only: queued first, then (possibly a brief processing), then terminal.
  const terminal: Record<string, string> = {
    'document.pdf': 'ready',
    'video.mp4': 'ready',
    'encrypted.pdf': 'failed',
    'notes.zip': 'ready',
  }
  for (const s of [a, b]) {
    const seen = await cardStatuses(s.page)
    for (const name of files) {
      const seq = seen[name] ?? []
      expect([
        ['queued', terminal[name]],
        ['queued', 'processing', terminal[name]],
      ]).toContainEqual(seq)
    }
    test.info().annotations.push({ type: `${s.user} card statuses`, description: JSON.stringify(seen) })
  }

  // A wider window so the whole row of cards clears tldraw's style panel in the screenshot.
  await b.page.setViewportSize({ width: 1600, height: 820 })
  await edit(b.page, (ed) => ed.zoomToFit())
  for (const name of files) await expect(fileCard(b.page, name)).toBeInViewport()
  await capture('file-cards-ready.png', b.page, test.info())
})

test('7) video card plays the original MP4 on the other client', { tag: '@chrome' }, async ({
  session,
  board,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await insertFiles(a.page, [fixture('video.mp4')])
  const card = fileCard(b.page, 'video.mp4')
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
  await card.getByTestId('file-card-play').click()
  const video = card.getByTestId('file-card-video')
  await expect(video).toHaveAttribute(
    'src',
    new RegExp(`^/files/ast_\\w{20}/ver_\\w{20}/original\\?board=${board}$`),
  )
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime), { timeout: 20_000 })
    .toBeGreaterThan(0.5)
  expect(await video.evaluate((v) => (v as HTMLVideoElement).error)).toBeNull()
  // Clicking play must not have selected (or started dragging) the card.
  expect(await b.page.evaluate(() => window.editor?.getSelectedShapeIds() ?? [])).toEqual([])
  await capture('video-playing.png', b.page, test.info())
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

async function insertTemplate(page: Page, id: string) {
  await page.getByTestId('tools.dr-templates').click()
  await page.locator(`[data-testid="template-option"][data-template-id="${id}"]`).click()
  await expect(page.getByTestId('template-picker')).toHaveCount(0)
}

/** Waits for exactly `n` image shapes that were not in `before`, and for their uploads to finish. */
async function newImages(page: Page, before: ReadonlySet<string>, n: number) {
  const ids = await waitForValue(
    async () => {
      const found = await newShapeIds(page, 'image', before)
      return found.length === n ? found : null
    },
    { timeout: 30_000 },
  )
  await expect
    .poll(
      () =>
        readF(
          page,
          (ed, list) =>
            list.every((id) => {
              const assetId = ed.getShape(id)?.props.assetId as string | undefined
              const src = assetId ? (ed.getAsset(assetId)?.props as { src?: string } | undefined)?.src : ''
              return typeof src === 'string' && src.startsWith('/files/')
            }),
          ids,
        ),
      { timeout: 30_000, message: 'uploads finished' },
    )
    .toBe(true)
  return ids
}

const frameByName = (page: Page, name: string) =>
  readF(
    page,
    (ed, n) => {
      const f = ed.getCurrentPageShapes().find((s) => s.type === 'frame' && s.props.name === n)
      const b = f ? ed.getShapePageBounds(f.id) : undefined
      return f && b ? { id: f.id, bounds: { x: b.x, y: b.y, w: b.w, h: b.h } } : null
    },
    name,
  )

test('F1/F2 uploads with the view on "3 · Imagery": 3 then 12 images land in grids inside their frame or on the page, one undo each; Alt+1 and a second person’s first open show the content', async ({
  session,
}) => {
  test.setTimeout(180_000)
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await insertTemplate(a.page, 'mood-board')
  const templateFrames = await placedShapes(a.page, 'frame')
  expect(templateFrames).toHaveLength(4)

  await a.page.getByTestId('dock-tab-frames').click()
  await a.page
    .locator('[data-testid="frame-row"]', { hasText: 'Imagery' })
    .locator('.dr-cux-frame__name')
    .click()
  const imagery = await frameByName(a.page, '3 · Imagery')
  if (!imagery) throw new Error('no "3 · Imagery" frame')
  await expect
    .poll(async () => {
      const vp = await viewport(a.page)
      return contains(imagery.bounds, { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2, w: 0, h: 0 })
    })
    .toBe(true)
  await settleCamera(a.page)

  const three = await mixedImages(a.page, 'three', 3)
  const twelve = await mixedImages(a.page, 'twelve', 12)

  const upload = async (files: FilePayload[]) => {
    const before = await allShapeIds(a.page)
    const zoomAtDrop = await zoom(a.page)
    await insertPayloads(a.page, files)
    const ids = await newImages(a.page, before, files.length)
    await settleCamera(a.page)
    return { ids, zoomAtDrop }
  }

  const first = await upload(three)
  await test.step('3 images: every image lies inside its parent frame, or sits on the page', async () => {
    expect(outsideTheirFrame(await placedShapes(a.page, 'image'))).toEqual([])
  })

  const second = await upload(twelve)
  await test.step('12 images: a 4-column grid, equal on-screen sizes, no overlaps, clear of the template', async () => {
    const all = await placedShapes(a.page, 'image')
    expect(outsideTheirFrame(all)).toEqual([])
    const grid = all.filter((s) => second.ids.includes(s.id))
    const longest = grid.map((s) => Math.max(s.bounds.w, s.bounds.h))
    expect(Math.max(...longest) / Math.min(...longest)).toBeLessThan(1.01)
    // F2-01: one page-space size across uploads (not the pixel size, not the zoom): the second drop
    // matches the first.
    const firstLongest = all
      .filter((s) => first.ids.includes(s.id))
      .map((s) => Math.max(s.bounds.w, s.bounds.h))
    for (const l of [...firstLongest, ...longest]) expect(l).toBeCloseTo(longest[0] ?? 0, 0)
    const centre = (s: PlacedShape) => ({ x: s.bounds.x + s.bounds.w / 2, y: s.bounds.y + s.bounds.h / 2 })
    expect(new Set(grid.map((s) => Math.round(centre(s).x))).size).toBe(4)
    expect(new Set(grid.map((s) => Math.round(centre(s).y))).size).toBe(3)
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(overlaps((all[i] as PlacedShape).bounds, (all[j] as PlacedShape).bounds)).toBe(false)
    for (const img of all.filter((s) => s.parentType === null))
      for (const f of templateFrames)
        expect(overlaps(img.bounds, f.bounds), `${img.id} over a frame`).toBe(false)
    // The whole grid is in view after the drop.
    expect(await inView(a.page, second.ids)).toBe(true)
  })

  await test.step('one Ctrl+Z removes the 12 (not the first 3); redo brings them back', async () => {
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(async () => (await placedShapes(a.page, 'image')).map((s) => s.id).sort())
      .toEqual([...first.ids].sort())
    await a.page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await placedShapes(a.page, 'image')).length).toBe(15)
  })

  await test.step('Alt+1 frames the real content', async () => {
    await a.page.keyboard.press('Alt+1')
    await settleCamera(a.page)
    const content = await readF(a.page, (ed) => ed.getCurrentPageBounds())
    const vp = await viewport(a.page)
    if (!content) throw new Error('no content bounds')
    expect(contains(vp, content, 1)).toBe(true)
    expect(Math.max(content.w / vp.w, content.h / vp.h)).toBeGreaterThan(0.6)
  })

  await test.step('bob’s first open shows content (not an empty 5 % view): the first frame, readable', async () => {
    const b = await session('bob')
    await waitForCanvasUx(b.page)
    // DANA-06: the template plus 15 images only fit at an unreadable zoom, so a first visit opens
    // on the first frame in presentation order instead of the whole page.
    expect(await startView(b.page)).toBe('first-frame')
    expect(await zoom(b.page)).toBeGreaterThan(0.5)
    const direction = await frameByName(b.page, '1 · Direction')
    if (!direction) throw new Error('no "1 · Direction" frame')
    expect(await inView(b.page, [direction.id])).toBe(true)
  })
})

test('F4 previews in progress: a second tab never downloads the original (the uploading tab keeps its local preview), then both show the derivative; export still gets the original', async ({
  session,
  stack,
  board,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  const onA = recordRequests(a.page)
  const onB = recordRequests(b.page)
  // A 20 MP photo (5472 x 3648), with enough detail to be a real multi-megabyte JPEG.
  const [photo] = await makeImages(a.page, [{ name: 'photo-20mp.jpg', w: 5472, h: 3648, detail: 1 }])
  if (!photo) throw new Error('no photo')
  test.info().annotations.push({ type: 'photo bytes', description: String(photo.buffer.length) })
  expect(photo.buffer.length).toBeGreaterThan(1.5 * 1024 * 1024)

  await stack.worker.kill() // previews cannot be made until the worker is back
  const before = await allShapeIds(a.page)
  await insertPayloads(a.page, [photo])
  const [id] = await newImages(a.page, before, 1)
  if (!id) throw new Error('no image')
  await expect.poll(() => getShape(b.page, id).then((s) => s !== null)).toBe(true)

  await test.step('while queued: A shows its local blob preview, B a loading tile; nobody fetches the original', async () => {
    await expect.poll(() => imageSrc(a.page, id).then((s) => s?.src ?? '')).toMatch(/^blob:/)
    await a.page.waitForTimeout(3000)
    expect(await imageSrc(a.page, id)).toMatchObject({ src: expect.stringMatching(/^blob:/) })
    expect(await imageSrc(b.page, id)).toBeNull()
    await expect(b.page.locator(`[data-shape-id="${id}"] .tl-image-container`)).toBeVisible()
    expect(onA.originals()).toEqual([])
    expect(onB.originals()).toEqual([])
  })

  await stack.worker.start()
  await test.step('once the display derivative exists, both tabs show it (still no original)', async () => {
    for (const s of [a, b]) {
      await expect
        .poll(() => imageSrc(s.page, id), { timeout: 60_000 })
        .toEqual({ src: expect.stringMatching(DERIVATIVE_SRC), loaded: true })
    }
    expect(onA.originals()).toEqual([])
    expect(onB.originals()).toEqual([])
  })

  await test.step('export / copy / download resolve to the original', async () => {
    const url = await readF(
      b.page,
      (ed, shapeId) =>
        ed.resolveAssetUrl(String(ed.getShape(shapeId)?.props.assetId), { shouldResolveToOriginal: true }),
      id,
    )
    expect(url).toMatch(ORIGINAL_HREF)
    expect(url).toMatch(new RegExp(`\\?board=${board}$`))
  })
})

test('F5 bad files together: the rejected image is a readable, selectable tile; error cards land in view; the oversize file is named', async ({
  session,
}) => {
  const a = await session('alice')
  const oversize: FilePayload = {
    name: 'oversize-31mb-dunes.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(31 * 1024 * 1024, 0xff),
  }
  const before = await allShapeIds(a.page)
  await insertPayloads(a.page, [
    fixture('bomb-12000x12000.png'),
    fixture('garbage.pdf'),
    fixture('encrypted.pdf'),
    fixture('truncated.mp4'),
    oversize,
  ])
  await expect(
    a.page.getByText('oversize-31mb-dunes.jpg is larger than 25 MB, the limit for images.'),
  ).toBeVisible()
  // tldraw's own anonymous "too large" toast never fires: the file never reached it.
  await expect(a.page.locator('.tlui-toast__title')).toHaveCount(0)

  const [bomb] = await newImages(a.page, before, 1)
  if (!bomb) throw new Error('no image shape')
  await test.step('the image the worker rejected shows "Couldn’t process this image"', async () => {
    await expect
      .poll(() => imageSrc(a.page, bomb), { timeout: 30_000 })
      .toEqual({ src: '/img/image-unavailable.svg', loaded: true })
    await expect(a.page.locator(`[data-shape-id="${bomb}"] img.tl-image`)).toBeInViewport()
    // Screen-relative size, not tldraw's 5,000 x 5,000.
    const bounds = await shapeBounds(a.page, bomb)
    expect(bounds && Math.max(bounds.w, bounds.h)).toBeLessThan(1000)
    await editF(a.page, (ed, shapeId) => ed.select(shapeId), bomb)
    await expect(a.page.getByTestId('tool.image-download')).toBeVisible()
  })
  await test.step('each broken file ends as an error card inside the viewport', async () => {
    for (const name of ['garbage.pdf', 'encrypted.pdf', 'truncated.mp4']) {
      const card = fileCard(a.page, name)
      await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 30_000 })
      await expect(card).toBeInViewport({ ratio: 0.99 })
      await expect(card.getByTestId('file-card-error')).toBeVisible()
    }
    const cards = (await pageShapes(a.page)).filter((s) => s.type === 'dr-file-card').map((s) => s.id)
    const boxes = await Promise.all([bomb, ...cards].map((id) => shapeBounds(a.page, id)))
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        expect(overlaps(boxes[i] as BoxLike, boxes[j] as BoxLike)).toBe(false)
  })
})

test('F6 a frame grab dropped on a Storyboard slot fills that slot (locked, still a drop target); the heading and timing stay visible', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await insertTemplate(a.page, 'storyboard')
  const panel = await readF(a.page, (ed) => {
    const p = ed.getCurrentPageShapes().find((s) => s.type === 'frame' && s.props.name === 'Panel 1')
    if (!p) return null
    const kids = ed.getSortedChildIdsForParent(p.id).map((id) => ed.getShape(id))
    const slot = kids.find((k) => k?.meta.draftroomSlot === 'image')
    const heading = kids[0]
    const timing = kids.find((k) => k?.type === 'text' && JSON.stringify(k.props.richText).includes('Time:'))
    const sb = slot ? ed.getShapePageBounds(slot.id) : undefined
    ed.selectNone()
    const pb = ed.getShapePageBounds(p.id)
    if (pb) ed.zoomToBounds(pb, { immediate: true, targetZoom: 1 })
    return slot && heading && timing && sb
      ? {
          id: p.id,
          slot: slot.id,
          slotLocked: slot.isLocked === true,
          slotBounds: { x: sb.x, y: sb.y, w: sb.w, h: sb.h },
          heading: heading.id,
          timing: timing.id,
        }
      : null
  })
  if (!panel) throw new Error('no Panel 1 with a marked slot')
  expect(panel.slotLocked).toBe(true)

  const [grab] = await makeImages(a.page, [{ name: 'frame-grab.jpg', w: 1920, h: 1080 }])
  if (!grab) throw new Error('no image')
  const before = await allShapeIds(a.page)
  const at = await toScreen(a.page, {
    x: panel.slotBounds.x + panel.slotBounds.w / 2,
    y: panel.slotBounds.y + panel.slotBounds.h / 2,
  })
  await dropFiles(a.page, [grab], at)
  const [id] = await newImages(a.page, before, 1)
  if (!id) throw new Error('no image')

  const placed = (await placedShapes(a.page, 'image')).find((s) => s.id === id)
  expect(placed?.parentId).toBe(panel.id)
  expect(contains(panel.slotBounds, placed?.bounds ?? { x: 0, y: 0, w: 0, h: 0 })).toBe(true)
  expect(placed?.bounds.w).toBeCloseTo(panel.slotBounds.w, 0) // 16:9 into a 16:9 slot fills it
  // Stacked just above the slot, under the panel's notes and text.
  const order = await read(a.page, (ed, p) => ed.getSortedChildIdsForParent(p), panel.id)
  expect(order.indexOf(id)).toBe(order.indexOf(panel.slot) + 1)
  for (const textId of [panel.heading, panel.timing]) {
    await expect(a.page.locator(`[data-shape-id="${textId}"]`)).toBeVisible()
    const tb = await shapeBounds(a.page, textId)
    expect(tb && placed && overlaps(tb, placed.bounds)).toBe(false)
  }
  await expect
    .poll(() => imageSrc(a.page, id), { timeout: 30_000 })
    .toEqual({ src: expect.stringMatching(DERIVATIVE_SRC), loaded: true })
})

test('F7a double-clicking a PDF or video card opens the original in a new tab (no empty text edit); the Download link shows a focus ring', async ({
  session,
  board,
}) => {
  const a = await session('alice')
  await insertFiles(a.page, [fixture('document.pdf'), fixture('video.mp4')])
  for (const name of ['document.pdf', 'video.mp4']) {
    const card = fileCard(a.page, name)
    await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
    await editF(a.page, (ed) => ed.selectNone())
    const shapesBefore = (await pageShapes(a.page)).length
    const box = await card.boundingBox()
    if (!box) throw new Error(`${name} has no box`)
    const popup = a.context.waitForEvent('page')
    // The new tab's navigation (the headless shell may turn a PDF into a download, so look at the
    // request rather than at what the tab ends up showing).
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
    expect(await read(a.page, (ed) => ed.getEditingShapeId())).toBeNull()
    expect((await pageShapes(a.page)).length).toBe(shapesBefore)
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
