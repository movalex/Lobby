// Canvas and media polish before the leadership demo (review findings F1, F2/R8, DANA-06/R13, F6, F5):
// exports and thumbnails draw PDF/video cards with their previews, images and mind-map topics take
// tags, a first visit opens on the first frame, several images fill a Mood board's slots, and a tap on
// "View pages" opens the PDF viewer on a touch phone.
//
// Unit coverage below the browser: apps/web/src/assets/drop-layout.test.ts (slot order, the overflow
// grid), apps/web/src/features/canvas-ux/start-view.test.ts (first-frame and phone rules),
// apps/web/src/features/tags/{model,search,csv}.test.ts (taggable types).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Locator, Page } from '@playwright/test'
import { signInContext } from './support/api.ts'
import { edit, fileCard, insertFiles, read, waitForBoard, waitForValue } from './support/board.ts'
import { waitForCanvasUx, waitForSaved } from './support/canvas-ux.ts'
import type { BoxLike, ShapeLike } from './support/editor.ts'
import { allShapeIds, dropFiles, makeImages, newShapeIds } from './support/files.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'
import { FIXTURES_DIR, REPO_ROOT } from './support/stack.ts'
import {
  chipKeys,
  createShapes,
  openPicker,
  openTagsPanel,
  row,
  selectIds,
  shapeOpacity,
} from './support/tags.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)
/** Local look-at copies of the screenshots (never committed). */
const SHOTS = join(REPO_ROOT, '.scratch/shots/canvas-media-polish')

async function shot(name: string, target: Page | Locator) {
  mkdirSync(SHOTS, { recursive: true })
  await target.screenshot({ path: join(SHOTS, name), animations: 'disabled' })
  await capture(name, target, test.info())
}

async function readyCard(page: Page, name: string) {
  await expect(fileCard(page, name)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  return waitForValue(() =>
    read(
      page,
      (ed, n) =>
        ed.getCurrentPageShapes().find((s: ShapeLike) => s.type === 'dr-file-card' && s.props.name === n)
          ?.id ?? null,
      name,
    ),
  )
}

async function insertTemplate(page: Page, id: string) {
  await page.getByTestId('tools.dr-templates').click()
  await page.locator(`[data-testid="template-option"][data-template-id="${id}"]`).click()
  await expect(page.getByTestId('template-picker')).toHaveCount(0)
}

async function openAs(
  browser: Browser,
  board: string,
  handle: string,
  opts: { viewport?: { width: number; height: number }; phone?: boolean } = {},
) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    ...(opts.phone ? { isMobile: true, hasTouch: true } : {}),
  })
  await signInContext(context, handle, handle)
  const page = await context.newPage()
  await page.goto(`/b/${board}`)
  await waitForBoard(page)
  await waitForCanvasUx(page)
  return { context, page }
}

interface FrameInfo {
  id: string
  name: string
  b: BoxLike
}

const frames = (page: Page) =>
  read(page, (ed) =>
    ed
      .getCurrentPageShapes()
      .filter((s: ShapeLike) => s.type === 'frame' && s.parentId.startsWith('page:'))
      .map((s: ShapeLike) => {
        const b = ed.getShapePageBounds(s.id) as BoxLike
        return { id: s.id, name: String(s.props.name), b: { x: b.x, y: b.y, w: b.w, h: b.h } }
      }),
  ) as Promise<FrameInfo[]>

const view = (page: Page) =>
  read(page, (ed) => {
    const e = ed as unknown as {
      getZoomLevel(): number
      getViewportPageBounds(): BoxLike
    }
    const vp = e.getViewportPageBounds()
    return { z: e.getZoomLevel(), vp: { x: vp.x, y: vp.y, w: vp.w, h: vp.h } }
  })

test('F1 exports and the dashboard thumbnail draw PDF and video cards with their first page and poster, not "Preview unavailable"', async ({
  session,
  board,
}) => {
  test.setTimeout(150_000)
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await insertFiles(a.page, [fixture('document.pdf'), fixture('video.mp4')])
  const pdf = await readyCard(a.page, 'document.pdf')
  const video = await readyCard(a.page, 'video.mp4')

  const exported = async (opts: Record<string, unknown>) =>
    a.page.evaluate(
      async ({ ids, opts }) => {
        const ed = window.editor as unknown as {
          getSvgString(ids: string[], o: Record<string, unknown>): Promise<{ svg: string } | undefined>
        }
        return (await ed.getSvgString(ids, opts))?.svg ?? ''
      },
      { ids: [pdf, video], opts },
    )

  await test.step('the export SVG (what PNG, PDF and SVG downloads are made from) inlines both previews', async () => {
    for (const opts of [
      { pixelRatio: undefined, background: true },
      { pixelRatio: 1, background: true },
    ]) {
      const svg = await exported(opts)
      expect(svg).not.toContain('Preview unavailable')
      expect(svg).not.toContain('Unavailable')
      expect(svg).not.toContain('Loading preview')
      // Both covers are embedded as data URLs (self-contained), none as a board URL.
      expect(svg.match(/<img[^>]+src="data:image\//g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      expect(svg).toContain('4 pages')
      // Controls mean nothing in a picture.
      expect(svg).not.toContain('View pages')
      expect(svg).not.toContain('file-card-download')
    }
  })

  await test.step('the PNG export looks like the board', async () => {
    const b64 = await a.page.evaluate(
      async (ids) => {
        const ed = window.editor as unknown as {
          toImage(ids: string[], o: Record<string, unknown>): Promise<{ blob: Blob }>
        }
        const { blob } = await ed.toImage(ids, { format: 'png', pixelRatio: 1, background: true })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let s = ''
        for (const byte of bytes) s += String.fromCharCode(byte)
        return btoa(s)
      },
      [pdf, video],
    )
    mkdirSync(SHOTS, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(SHOTS, 'f1-export-cards.png'), Buffer.from(b64, 'base64'))
    await test
      .info()
      .attach('f1-export-cards.png', { body: Buffer.from(b64, 'base64'), contentType: 'image/png' })
  })

  await test.step('the dashboard card: the thumbnail is drawn with both previews', async () => {
    await expect(a.page.getByTestId('thumbnail-capture')).toHaveAttribute('data-state', /rendered|sent/, {
      timeout: 30_000,
    })
    await waitForSaved(a.page)
    await a.page.getByRole('link', { name: 'Back to Dev Studio' }).click()
    const card = a.page.locator(`[data-testid="board-card"][data-board-id="${board}"]`)
    const img = card.locator('img').first()
    await expect(img).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0))
      .toBe(true)
    await shot('f1-dashboard-thumbnail.png', card)
  })
})

test('F1 a larger board’s simplified thumbnail draws the cards’ first page and poster, not grey tiles', async ({
  session,
  board,
}) => {
  test.setTimeout(150_000)
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await insertFiles(a.page, [fixture('document.pdf'), fixture('video.mp4')])
  await readyCard(a.page, 'document.pdf')
  await readyCard(a.page, 'video.mp4')
  // Past the detailed renderer's 30 shapes: a row of notes under the cards.
  await edit(a.page, (ed) => {
    const e = ed as unknown as { getCurrentPageBounds(): BoxLike }
    const b = e.getCurrentPageBounds()
    const shapes: Record<string, unknown>[] = []
    for (let i = 0; i < 36; i++)
      shapes.push({
        type: 'note',
        x: b.x + (i % 12) * 60,
        y: b.y + b.h + 60 + Math.floor(i / 12) * 60,
        props: { size: 's', scale: 0.25 },
      })
    ed.createShapes(shapes)
  })
  const state = a.page.getByTestId('thumbnail-capture')
  await expect(state).toHaveAttribute('data-state', 'rendered', { timeout: 30_000 })
  await expect(state).toHaveAttribute('data-renderer', 'schematic')
  await waitForSaved(a.page)
  await a.page.getByRole('link', { name: 'Back to Dev Studio' }).click()
  const card = a.page.locator(`[data-testid="board-card"][data-board-id="${board}"]`)
  const img = card.locator('img').first()
  await expect(img).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
  // The PDF cover's blue header and the video's colour bars: many distinct colours, not two greys.
  const colours = await img.evaluate((i: HTMLImageElement) => {
    const c = document.createElement('canvas')
    c.width = i.naturalWidth
    c.height = i.naturalHeight
    const g = c.getContext('2d')
    if (!g) return 0
    g.drawImage(i, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    const set = new Set<number>()
    for (let p = 0; p < d.length; p += 16)
      set.add(((d[p] ?? 0) >> 4) * 256 + ((d[p + 1] ?? 0) >> 4) * 16 + ((d[p + 2] ?? 0) >> 4))
    return set.size
  })
  expect(colours).toBeGreaterThan(40)
  await shot('f1-dashboard-thumbnail-schematic.png', card)
})

test('F2 R8 images and mind-map topics take tags: picker, chips, "Show only" and #search', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const [photo] = await makeImages(a.page, [{ name: 'warm-1.jpg', w: 1200, h: 800 }])
  if (!photo) throw new Error('no image')
  const before = await allShapeIds(a.page)
  await dropFiles(a.page, [photo], { x: 500, y: 400 })
  const [imageId] = await waitForValue(async () => {
    const found = await newShapeIds(a.page, 'image', before)
    return found.length === 1 ? found : null
  })
  if (!imageId) throw new Error('no image shape')
  const topic = 'shape:polish-topic'
  const other = 'shape:polish-note'
  const imageBox = (await read(a.page, (ed, id) => ed.getShapePageBounds(id), imageId)) as BoxLike
  await createShapes(a.page, [
    {
      id: topic,
      type: 'geo',
      x: imageBox.x,
      y: imageBox.y + imageBox.h + 120,
      props: { w: 260, h: 70, geo: 'rectangle' },
      meta: { drMindmap: { rootId: topic } },
    },
    { id: other, type: 'note', x: imageBox.x + imageBox.w + 120, y: imageBox.y },
  ])

  await test.step('an image offers Tags in its selection bar; a new tag goes on it', async () => {
    await selectIds(a.page, [imageId])
    const picker = await openPicker(a.page)
    await expect(picker.getByTestId('tag-picker-input')).toBeFocused()
    await a.page.keyboard.type('Warm')
    await a.page.keyboard.press('Enter')
    await expect(picker.getByTestId('tag-picker-status')).toHaveText('Created “#Warm”.')
    await expect.poll(() => chipKeys(a.page, imageId)).toEqual(['warm'])
    await a.page.keyboard.press('Escape')
  })

  await test.step('a mind-map topic (geo) takes the same tag; the chips sit above it', async () => {
    await selectIds(a.page, [topic])
    const picker = await openPicker(a.page)
    await picker.locator('[data-testid="tag-option"][data-tag-key="warm"]').click()
    await expect.poll(() => chipKeys(a.page, topic)).toEqual(['warm'])
    await a.page.keyboard.press('Escape')
    await edit(a.page, (ed) => ed.selectNone())
    const chipsBox = await a.page.locator(`.tl-shape[data-shape-id="${topic}"] .dr-tag-chips`).boundingBox()
    const topicBox = await a.page.locator(`.tl-shape[data-shape-id="${topic}"]`).boundingBox()
    if (!chipsBox || !topicBox) throw new Error('no boxes')
    expect(chipsBox.y + chipsBox.height).toBeLessThanOrEqual(topicBox.y + 1)
    await shot('f2-image-and-topic-tagged.png', a.page)
  })

  await test.step('Show only #warm keeps the image and the topic, dims the note', async () => {
    const panel = await openTagsPanel(a.page)
    await expect(row(a.page, 'warm').getByTestId('tag-row-count')).toHaveAttribute('data-count', '2')
    await row(a.page, 'warm').getByTestId('tag-filter').click()
    await expect(a.page.getByTestId('tag-filter-bar')).toContainText('2 items')
    await expect.poll(() => shapeOpacity(a.page, other)).toBeLessThan(0.5)
    expect(await shapeOpacity(a.page, imageId)).toBe(1)
    expect(await shapeOpacity(a.page, topic)).toBe(1)
    await shot('f2-filter-warm.png', a.page)
    await expect(panel).toBeVisible()
  })
})

test('DANA-06 R13 a first visit with no saved camera opens on the first frame, readable, on a desktop and on a phone', async ({
  browser,
  session,
  board,
  users,
}) => {
  test.setTimeout(180_000)
  await test.step('desktop: the Lobby tour opens on "1 · Welcome", readable (not the 9-12 % row of six frames)', async () => {
    const tour = await users.createBoard('Lobby tour first view')
    const owner = await openAs(browser, tour, 'alice')
    await owner.page.goto(`/b/${tour}?template=lobby-tour`)
    await waitForBoard(owner.page)
    await waitForCanvasUx(owner.page)
    await expect.poll(async () => (await frames(owner.page)).length, { timeout: 20_000 }).toBe(6)
    await waitForSaved(owner.page)
    await owner.context.close()
    await users.grant(tour, 'bob', 'commenter')
    const b = await openAs(browser, tour, 'bob')
    try {
      await expect(b.page.getByTestId('canvas-ux-overlay')).toHaveAttribute('data-start-view', 'first-frame')
      await b.page.waitForTimeout(400)
      const welcome = (await frames(b.page)).find((f) => f.name === '1 · Welcome')
      if (!welcome) throw new Error('no Welcome frame')
      const v = await view(b.page)
      expect(v.z).toBeGreaterThanOrEqual(0.5)
      const f = welcome.b
      expect(f.x).toBeGreaterThanOrEqual(v.vp.x - 1)
      expect(f.y).toBeGreaterThanOrEqual(v.vp.y - 1)
      expect(f.x + f.w).toBeLessThanOrEqual(v.vp.x + v.vp.w + 1)
      expect(f.y + f.h).toBeLessThanOrEqual(v.vp.y + v.vp.h + 1)
      await shot('dana06-desktop-first-view.png', b.page)
    } finally {
      await b.context.close()
    }
  })

  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await insertTemplate(a.page, 'retrospective')
  await waitForSaved(a.page)
  const all = await frames(a.page)
  const checkIn = all.find((f) => f.name.includes('Check-in'))
  if (!checkIn) throw new Error('no Check-in frame')

  await test.step('phone: the very wide Check-in opens at its left end at a readable zoom', async () => {
    await users.grant(board, 'carol', 'editor')
    const c = await openAs(browser, board, 'carol', { viewport: { width: 390, height: 844 }, phone: true })
    try {
      await expect(c.page.getByTestId('canvas-ux-overlay')).toHaveAttribute('data-start-view', 'first-frame')
      await c.page.waitForTimeout(600)
      const v = await view(c.page)
      expect(v.z).toBeGreaterThanOrEqual(0.4)
      const f = checkIn.b
      // The frame's left edge and its vertical middle are on screen.
      expect(f.x).toBeGreaterThanOrEqual(v.vp.x)
      expect(f.x).toBeLessThan(v.vp.x + v.vp.w / 4)
      expect(f.y + f.h / 2).toBeGreaterThan(v.vp.y)
      expect(f.y + f.h / 2).toBeLessThan(v.vp.y + v.vp.h)
      await shot('r13-phone-first-view.png', c.page)
    } finally {
      await c.context.close()
    }
  })
})

test('F6 dropping 8 images on the Mood board’s Imagery frame fills its 6 empty slots in order; the other 2 go under the frame at the slots’ size', async ({
  session,
}) => {
  test.setTimeout(150_000)
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await insertTemplate(a.page, 'mood-board')
  const imagery = (await frames(a.page)).find((f) => f.name.includes('Imagery'))
  if (!imagery) throw new Error('no Imagery frame')
  const slots = (await read(
    a.page,
    (ed, id) =>
      ed
        .getSortedChildIdsForParent(id)
        .map((c: string) => ed.getShape(c))
        .filter((s): s is ShapeLike => s?.meta.draftroomSlot === 'image')
        .map((s) => {
          const b = ed.getShapePageBounds(s.id) as BoxLike
          return { id: s.id, b: { x: b.x, y: b.y, w: b.w, h: b.h } }
        }),
    imagery.id,
  )) as { id: string; b: BoxLike }[]
  expect(slots.length).toBe(6)
  await read(
    a.page,
    (ed, b) => {
      ed.selectNone()
      ;(ed as unknown as { zoomToBounds(b: BoxLike, o: Record<string, unknown>): void }).zoomToBounds(b, {
        inset: 48,
        immediate: true,
        targetZoom: 1,
      })
    },
    imagery.b,
  )
  const images = await makeImages(
    a.page,
    Array.from({ length: 8 }, (_, i) => ({
      name: `mood-${i + 1}.jpg`,
      w: i % 2 ? 1200 : 900,
      h: i % 2 ? 800 : 1200,
    })),
  )
  const before = await allShapeIds(a.page)
  // On the frame's first slot.
  const first = [...slots].sort((p, q) => p.b.y - q.b.y || p.b.x - q.b.x)[0] as { b: BoxLike }
  const at = await read(
    a.page,
    (ed, p) =>
      (ed as unknown as { pageToScreen(p: { x: number; y: number }): { x: number; y: number } }).pageToScreen(
        p,
      ),
    { x: first.b.x + first.b.w / 2, y: first.b.y + first.b.h / 2 },
  )
  await dropFiles(a.page, images, at)
  const ids = await waitForValue(async () => {
    const found = await newShapeIds(a.page, 'image', before)
    return found.length === 8 ? found : null
  })
  await a.page.waitForTimeout(800)
  const placed = (await read(
    a.page,
    (ed, list) =>
      list.map((id: string) => {
        const s = ed.getShape(id) as ShapeLike
        const b = ed.getShapePageBounds(id) as BoxLike
        return { id, parentId: s.parentId, b: { x: b.x, y: b.y, w: b.w, h: b.h } }
      }),
    ids,
  )) as { id: string; parentId: string; b: BoxLike }[]

  const inSlots = placed.filter((p) => p.parentId === imagery.id)
  expect(inSlots).toHaveLength(6)
  // Every slot holds exactly one image, fitted inside it.
  for (const s of slots) {
    const inside = inSlots.filter(
      (p) =>
        p.b.x >= s.b.x - 0.5 &&
        p.b.y >= s.b.y - 0.5 &&
        p.b.x + p.b.w <= s.b.x + s.b.w + 0.5 &&
        p.b.y + p.b.h <= s.b.y + s.b.h + 0.5,
    )
    expect(inside, `slot ${s.id}`).toHaveLength(1)
  }
  const rest = placed.filter((p) => p.parentId !== imagery.id)
  expect(rest).toHaveLength(2)
  const slot = slots[0] as { b: BoxLike }
  for (const p of rest) {
    expect(p.parentId.startsWith('page:')).toBe(true)
    // The slots' scale: each fits a slot-sized cell and touches two of its sides.
    expect(p.b.w).toBeLessThanOrEqual(slot.b.w + 0.5)
    expect(p.b.h).toBeLessThanOrEqual(slot.b.h + 0.5)
    expect(Math.max(p.b.w / slot.b.w, p.b.h / slot.b.h)).toBeCloseTo(1, 2)
    // Right under the frame, not over it.
    expect(p.b.y).toBeGreaterThanOrEqual(imagery.b.y + imagery.b.h)
  }
  await read(
    a.page,
    (ed, b) => {
      ed.selectNone()
      ;(ed as unknown as { zoomToBounds(b: BoxLike, o: Record<string, unknown>): void }).zoomToBounds(b, {
        inset: 48,
        immediate: true,
      })
    },
    { x: imagery.b.x, y: imagery.b.y, w: imagery.b.w, h: imagery.b.h + 400 },
  )
  await shot('f6-mood-board-slots.png', a.page)
})

test('F5 on a touch phone, a tap on "View pages" opens the PDF viewer', async ({
  browser,
  session,
  board,
  users,
}) => {
  test.setTimeout(120_000)
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await insertFiles(a.page, [fixture('document.pdf')])
  const card = await readyCard(a.page, 'document.pdf')
  await waitForSaved(a.page)
  await users.grant(board, 'dave', 'viewer')
  const g = await openAs(browser, board, 'dave', { viewport: { width: 390, height: 844 }, phone: true })
  try {
    await expect(fileCard(g.page, 'document.pdf')).toHaveAttribute('data-status', 'ready', {
      timeout: 30_000,
    })
    // Close enough that the chip is a real target (as a client would zoom in).
    await read(
      g.page,
      (ed, id) => {
        const b = ed.getShapePageBounds(id) as BoxLike
        ;(ed as unknown as { zoomToBounds(b: BoxLike, o: Record<string, unknown>): void }).zoomToBounds(b, {
          inset: 24,
          immediate: true,
        })
      },
      card,
    )
    // tldraw covers the shapes with a hit-test blocker while the camera moves.
    await expect
      .poll(() => read(g.page, (ed) => (ed as unknown as { getCameraState(): string }).getCameraState()))
      .toBe('idle')
    const button = fileCard(g.page, 'document.pdf').getByTestId('file-card-view-pages')
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    if (!box) throw new Error('no View pages box')
    // The browser sends the button pointerdown/pointerup but no click (the canvas cancels the touch).
    await g.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
    await expect(g.page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 10_000 })
    await expect(g.page.getByTestId('pdf-viewer-counter')).toContainText('1')
    await shot('f5-phone-view-pages-tapped.png', g.page)
  } finally {
    await g.context.close()
  }
})
