// Wave 3g: where dropped and inserted files land on the Excalidraw canvas, and what a collaborator sees
// while they upload. Ported from the media tests of e2e/tests/canvas-3.fix.spec.ts (F2-01, F2-02),
// demo-polish-b.spec.ts (F9), canvas-2.fix.spec.ts (F12, F8), canvas-media-polish.spec.ts (F6, F5 on a
// phone) and saving.spec.ts (WRK-03).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- media-drops
//
// What differs from the tldraw specs (docs/research/excalidraw/wave3/3G.md): the templates are pushed as
// scenes (the template insert is 3b's, CR-2D-2), and F9 uses the mood-board template's slots (the tour
// board's are the same template frame); a centre crop is Excalidraw's `crop` in the thumb's pixels; new
// elements are painted on top (not "just above the slot"); the selection bar and the style panel are 3a's
// (F12's bar and R16 steps are not checked here); WRK-03's element appears once the upload has finished,
// so the collaborator gets it with its file (tldraw shared a placeholder first).
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  expect,
  itemBounds,
  openCanvasSession,
  sceneToScreen,
  selection,
  selectNone,
  setViewport,
  test,
  viewport,
} from '../tests/support/canvas.ts'
import { expectSaveState, recordSaveStates, saveLog } from '../tests/support/collab-quality.ts'
import { dropFiles, fileFromPath, makeImages } from '../tests/support/files.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import {
  allIds,
  boxOf,
  cardItems,
  contains,
  expectLoadedImage,
  fileCard,
  frameByName,
  imageItems,
  insertFiles,
  newItems,
  placeholder,
  pushTemplate,
  settleCamera,
  slotsOf,
} from './media-kit.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)

/** The camera on `b` (scene units) at zoom `z`, with `inset` screen px around it (at most 1:1). */
async function fit(page: Page, b: { x: number; y: number; w: number; h: number }, inset = 48, maxZoom = 1) {
  const vp = await viewport(page)
  const sw = vp.width * vp.zoom
  const sh = vp.height * vp.zoom
  const z = Math.min(maxZoom, (sw - 2 * inset) / b.w, (sh - 2 * inset) / b.h)
  await setViewport(page, { x: b.x + b.w / 2 - sw / z / 2, y: b.y + b.h / 2 - sh / z / 2, zoom: z })
  await settleCamera(page)
}

/** Sorted in reading order (rows top to bottom, then left to right). */
const reading = <T extends { x: number; y: number }>(list: T[]) =>
  [...list].sort((p, q) => Math.round(p.y - q.y) || p.x - q.x)

test('F2-01 two uploads at different zooms come out at the same page-space size', async ({
  canvasSession,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  const dropAt = async (zoom: number, names: string[], screen: { x: number; y: number }) => {
    const vp = await viewport(a.page)
    await setViewport(a.page, { zoom })
    await settleCamera(a.page)
    void vp
    const files = await makeImages(
      a.page,
      names.map((name, i) => ({ name, w: i % 2 ? 1200 : 900, h: i % 2 ? 800 : 1200 })),
    )
    const before = await allIds(a.page)
    await dropFiles(a.page, files, screen)
    return newItems(a.page, imageItems, before, names.length)
  }
  const first = await dropAt(0.4, ['z40-a.jpg', 'z40-b.jpg', 'z40-c.jpg'], { x: 500, y: 450 })
  await a.page.waitForTimeout(600)
  const second = await dropAt(1.25, ['z125-a.jpg', 'z125-b.jpg'], { x: 900, y: 400 })
  const sides = [...first, ...second].map((s) => Math.max(s.width, s.height))
  for (const s of sides) expect(s).toBeCloseTo(sides[0] as number, 0)
  expect(sides[0]).toBeCloseTo(400, 0)
})

test('F2-02 a portrait photo dropped on a Mood board slot fills the slot, centre-cropped', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  await pushTemplate(a.page, board, 'mood-board')
  const imagery = await frameByName(a.page, '3 · Imagery')
  if (!imagery) throw new Error('no Imagery frame')
  const [slot] = reading(await slotsOf(a.page, imagery.id))
  if (!slot) throw new Error('no slot')
  await fit(a.page, imagery)
  const [photo] = await makeImages(a.page, [{ name: 'portrait.jpg', w: 900, h: 1200 }])
  if (!photo) throw new Error('no photo')
  const at = await sceneToScreen(a.page, { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 })
  await dropFiles(a.page, [photo], at)
  const [placed] = await newItems(a.page, imageItems, new Set(), 1)
  if (!placed) throw new Error('no image')
  expect(placed.frameId).toBe(imagery.id)
  // The whole slot, no placeholder beside it.
  expect(placed.x).toBeCloseTo(slot.x, 0)
  expect(placed.y).toBeCloseTo(slot.y, 0)
  expect(placed.width).toBeCloseTo(slot.w, 0)
  expect(placed.height).toBeCloseTo(slot.h, 0)
  // Centre-cropped: the full width, equal bands cut off top and bottom (in the thumb's pixels, 384 x 512).
  const crop = placed.crop as {
    x: number
    y: number
    width: number
    height: number
    naturalWidth: number
    naturalHeight: number
  }
  expect(crop).toMatchObject({ x: 0, naturalWidth: 384, naturalHeight: 512, width: 384 })
  expect(crop.y).toBeGreaterThan(0)
  expect(crop.naturalHeight - (crop.y + crop.height)).toBeCloseTo(crop.y, -0.5)
  await expectLoadedImage(a.page, placed.id, board)
})

test('F6 dropping 8 images on the Mood board’s Imagery frame fills its 6 empty slots in order; the other 2 go under the frame at the slots’ size', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(150_000)
  const a = await canvasSession('alice')
  await pushTemplate(a.page, board, 'mood-board')
  const imagery = await frameByName(a.page, '3 · Imagery')
  if (!imagery) throw new Error('no Imagery frame')
  const slots = await slotsOf(a.page, imagery.id)
  expect(slots.length).toBe(6)
  await selectNone(a.page)
  await fit(a.page, imagery)
  const images = await makeImages(
    a.page,
    Array.from({ length: 8 }, (_, i) => ({
      name: `mood-${i + 1}.jpg`,
      w: i % 2 ? 1200 : 900,
      h: i % 2 ? 800 : 1200,
    })),
  )
  // On the frame's first slot.
  const first = reading(slots)[0] as (typeof slots)[number]
  const at = await sceneToScreen(a.page, { x: first.x + first.w / 2, y: first.y + first.h / 2 })
  await dropFiles(a.page, images, at)
  const placed = await newItems(a.page, imageItems, new Set(), 8)
  await a.page.waitForTimeout(800)

  const inSlots = placed.filter((p) => p.frameId === imagery.id)
  expect(inSlots).toHaveLength(6)
  // Every slot holds exactly one image, filling it (centre-cropped).
  for (const s of slots) {
    const inside = inSlots.filter((p) => contains(s, boxOf(p)))
    expect(inside, `slot ${s.id}`).toHaveLength(1)
  }
  // In reading order from the first slot: mood-1 in the first slot, mood-2 in the second…
  const bySlot = reading(slots).map((s) => inSlots.find((p) => contains(s, boxOf(p)))?.facts.name)
  expect(bySlot).toEqual(['mood-1.jpg', 'mood-2.jpg', 'mood-3.jpg', 'mood-4.jpg', 'mood-5.jpg', 'mood-6.jpg'])
  const rest = placed.filter((p) => p.frameId !== imagery.id)
  expect(rest).toHaveLength(2)
  const slot = slots[0] as (typeof slots)[number]
  for (const p of rest) {
    expect(p.frameId).toBeNull()
    // The slots' scale: each fits a slot-sized cell and touches two of its sides.
    expect(p.width).toBeLessThanOrEqual(slot.w + 0.5)
    expect(p.height).toBeLessThanOrEqual(slot.h + 0.5)
    expect(Math.max(p.width / slot.w, p.height / slot.h)).toBeCloseTo(1, 2)
    // Right under the frame, not over it.
    expect(p.y).toBeGreaterThanOrEqual(imagery.y + imagery.h)
  }
})

test('F9 a video dropped on a Mood board slot lands in that slot (fitted, in the frame) and the camera does not move', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  await pushTemplate(a.page, board, 'mood-board')
  const imagery = await frameByName(a.page, '3 · Imagery')
  if (!imagery) throw new Error('no Imagery frame')
  const slot = reading(await slotsOf(a.page, imagery.id))[1]
  if (!slot) throw new Error('no second image slot')
  await selectNone(a.page)
  await fit(a.page, imagery)
  const before = await viewport(a.page)
  const at = await sceneToScreen(a.page, { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 })
  await dropFiles(a.page, [{ ...fileFromPath(fixture('video.mp4')), name: 'teaser.mp4' }], at)
  const [card] = await newItems(a.page, cardItems, new Set(), 1)
  if (!card) throw new Error('no card')
  expect(card.frameId).toBe(imagery.id)
  // Inside the slot, fitted (it touches two opposite sides), the card's own shape kept.
  expect(contains(slot, boxOf(card))).toBe(true)
  expect(Math.max(card.width / slot.w, card.height / slot.h)).toBeCloseTo(1, 2)
  expect(card.width / card.height).toBeCloseTo(360 / 276, 2)
  expect(card.index > slot.index).toBe(true)
  await a.page.waitForTimeout(600) // an animated zoom-out would have started by now
  const after = await viewport(a.page)
  expect({ x: after.x, y: after.y, zoom: after.zoom }).toEqual({
    x: before.x,
    y: before.y,
    zoom: before.zoom,
  })
})

test('F12 a drop of images plus a PDF and a video lands at one scale, and the whole drop is selected', async ({
  canvasSession,
}) => {
  test.setTimeout(150_000)
  const a = await canvasSession('alice')
  const specs = Array.from({ length: 12 }, (_, i) => ({
    name: `mood-${String(i + 1).padStart(2, '0')}.jpg`,
    w: i % 3 === 1 ? 900 : 1400,
    h: i % 3 === 1 ? 1300 : 900,
  }))
  const images = await makeImages(a.page, specs)
  await insertFiles(a.page, [
    ...images,
    fileFromPath(fixture('document.pdf')),
    fileFromPath(fixture('video.mp4')),
  ])
  await expect(fileCard(a.page, 'document.pdf')).toBeVisible({ timeout: 60_000 })
  await expect(fileCard(a.page, 'video.mp4')).toBeVisible({ timeout: 60_000 })
  const placedImages = await newItems(a.page, imageItems, new Set(), 12)
  const cards = await newItems(a.page, cardItems, new Set(), 2)

  await test.step('one scale: every image and card has the same longest side', async () => {
    const sides = [...placedImages, ...cards].map((r) => Math.max(r.width, r.height))
    expect(Math.max(...sides) / Math.min(...sides)).toBeLessThan(1.02)
  })
  await test.step('the whole drop is selected', async () => {
    await expect.poll(async () => (await selection(a.page)).length).toBe(14)
  })
})

test('F8 a collaborator watching an upload sees an animated "Processing…" tile with the file name, then the preview', async ({
  canvasSession,
  stack,
  board,
}) => {
  test.setTimeout(150_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const images = await makeImages(a.page, [
    { name: 'halden-hero.jpg', w: 1600, h: 1000 },
    { name: 'autumn-leaves-portrait.jpg', w: 900, h: 1300 },
  ])
  await stack.worker.kill() // previews cannot be made until the worker is back
  await insertFiles(a.page, images)
  const placed = await newItems(a.page, imageItems, new Set(), 2)
  await expect.poll(async () => (await imageItems(b.page)).length).toBe(2)
  const ids = placed.map((p) => p.id)
  const all = placed.map(boxOf).reduce((u, r) => ({
    x: Math.min(u.x, r.x),
    y: Math.min(u.y, r.y),
    w: Math.max(u.x + u.w, r.x + r.w) - Math.min(u.x, r.x),
    h: Math.max(u.y + u.h, r.y + r.h) - Math.min(u.y, r.y),
  }))
  await fit(b.page, all)

  await test.step('bob: each empty tile says Processing… with its own file name, over a shimmer', async () => {
    for (const p of placed) {
      const tile = placeholder(b.page, p.id)
      await expect(tile).toHaveAttribute('data-state', 'processing')
      await expect(tile.locator('strong')).toHaveText('Processing…')
      await expect(tile.locator('.lobby-pending__name')).toHaveText(p.facts.name)
      expect(await tile.evaluate((el) => getComputedStyle(el).animationName)).toBe('lobby-pending-shimmer')
    }
    expect(placed.map((p) => p.facts.name).sort()).toEqual(['autumn-leaves-portrait.jpg', 'halden-hero.jpg'])
  })

  await stack.worker.start()
  await test.step('once previews exist, the canvas shows them and the tiles are gone', async () => {
    for (const id of ids) {
      await expectLoadedImage(b.page, id, board, 90_000)
      await expect(placeholder(b.page, id)).toHaveCount(0)
    }
  })
})

test('F5 on a touch phone, a tap on "View pages" opens the PDF viewer', async ({
  browser,
  canvasSession,
  board,
  users,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  await insertFiles(a.page, [fixture('document.pdf')])
  await expect(fileCard(a.page, 'document.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  const [card] = await cardItems(a.page)
  if (!card) throw new Error('no card')
  await expectSaveState(a.page, 'saved')
  const dave = await users.grant(board, 'dave', 'viewer')
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  try {
    const g = await openCanvasSession({ newContext: async () => context } as never, board, dave)
    await expect(fileCard(g.page, 'document.pdf')).toHaveAttribute('data-status', 'ready', {
      timeout: 30_000,
    })
    // Close enough that the chip is a real target (as a client would zoom in).
    const b = await itemBounds(g.page, card.id)
    if (!b) throw new Error('no card bounds')
    await fit(g.page, { x: b.x, y: b.y, w: b.width, h: b.height }, 24, 4)
    const button = fileCard(g.page, 'document.pdf').getByTestId('file-card-view-pages')
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    if (!box) throw new Error('no View pages box')
    await g.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
    await expect(g.page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 10_000 })
    await expect(g.page.getByTestId('pdf-viewer-counter')).toContainText('1')
  } finally {
    await context.close()
  }
})

test('WRK-03: "Saving…" while an image uploads (the element comes with its file): never Saved before the bytes landed', async ({
  canvasSession,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await expectSaveState(a.page, 'saved')
  // Hold the upload request until the test lets it go.
  let release: () => void = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  await a.page.route('**/api/boards/*/assets', async (route) => {
    await held
    await route.continue()
  })
  await recordSaveStates(a.page)
  await insertFiles(a.page, [fixture('image.png')])
  // Held well past the display's smoothing (≤ 750 ms): this duration is what is under test.
  await expect(a.page.getByTestId('save-status')).toHaveAttribute(
    'title',
    'Uploading a file to the board server',
  )
  await a.page.waitForTimeout(1500)
  await expectSaveState(a.page, 'saving')
  expect(await saveLog(a.page)).toEqual(['saved', 'saving'])
  expect(await imageItems(b.page)).toEqual([])

  release()
  const [img] = await newItems(a.page, imageItems, new Set(), 1)
  if (!img) throw new Error('no image')
  await expect.poll(async () => (await imageItems(b.page)).map((i) => i.id)).toEqual([img.id])
  await expectSaveState(a.page, 'saved', 30_000)
  expect((await saveLog(a.page)).join(' ')).toMatch(/^saved saving saved$/)
  // Saved means the element with its version id is on the server: a fresh tab has it.
  const c = await canvasSession('carol')
  await expect
    .poll(async () => (await imageItems(c.page)).map((i) => i.fileId.replace(/@\w+$/, '')))
    .toEqual([img.facts.versionId])
})
