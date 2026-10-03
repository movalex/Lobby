// W5-13 (docs/research/excalidraw/REVIEW-W5-EARLY.md): Replace media, Crop and Alternative text on the
// Excalidraw board, owner 3g (file-card/ported/edit-media.tsx; `files.crop`, CR-W5-3G-1). tldraw's image
// toolbar has all three; the first port had none, so the client-review loop (key art v1 becomes v2 and
// keeps its thread, place and slot) did not work.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test -c excalidraw/playwright.config.ts media-edit
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  dragItem,
  expect,
  item,
  pushedOps,
  sceneToScreen,
  select,
  selectNone,
  setViewport,
  test,
  updateItem,
} from '../tests/support/canvas.ts'
import { pressUndo } from '../tests/support/excalidraw.ts'
import { dropFiles, type FilePayload, makeImages } from '../tests/support/files.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import {
  boxOf,
  cardItems,
  expectLoadedImage,
  fileCard,
  fileItems,
  frameByName,
  imageItems,
  insertFiles,
  newItems,
  pushTemplate,
  settleCamera,
  slotsOf,
} from './media-kit.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)

type Engine = {
  api: {
    getSceneElements(): { id: string; fileId?: string | null; crop?: unknown }[]
    getAppState(): { croppingElementId?: string | null }
  }
}
/** The engine's own copy of an element: its LOCAL fileId (with a derivative suffix) and crop. */
const sceneCopy = (page: Page, id: string) =>
  page.evaluate((elId) => {
    const h = (window as unknown as { __lobbyBoard?: Engine }).__lobbyBoard
    const el = h?.api.getSceneElements().find((e) => e.id === elId)
    return el ? { fileId: el.fileId ?? null, crop: (el.crop ?? null) as Crop | null } : null
  }, id)
/**
 * Records the element's LOCAL fileId on every animation frame from now on (each change once): a
 * revert to the thumb for even one frame shows up in `seenFileIds`.
 */
const watchFileIds = (page: Page, id: string) =>
  page.evaluate((elId) => {
    const w = window as unknown as { __lobbyBoard?: Engine; __e2eFileIds?: string[] }
    const seen: string[] = []
    w.__e2eFileIds = seen
    const tick = () => {
      if (w.__e2eFileIds !== seen) return
      const el = w.__lobbyBoard?.api.getSceneElements().find((e) => e.id === elId)
      const f = el ? (el.fileId ?? 'null') : 'gone'
      if (seen[seen.length - 1] !== f) seen.push(f)
      requestAnimationFrame(tick)
    }
    tick()
  }, id)
const seenFileIds = (page: Page) =>
  page.evaluate(() => (window as unknown as { __e2eFileIds?: string[] }).__e2eFileIds ?? [])
const croppingId = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __lobbyBoard?: Engine }).__lobbyBoard?.api.getAppState().croppingElementId ??
      null,
  )

interface Crop {
  x: number
  y: number
  width: number
  height: number
  naturalWidth: number
  naturalHeight: number
}

/** Picks `file` in the chooser the button opens. */
async function pickWith(page: Page, testId: string, file: string | FilePayload) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId(testId).click()
  await (await chooser).setFiles(file)
}

async function placeImage(page: Page, board: string, name: string, w: number, h: number) {
  const [file] = await makeImages(page, [{ name, w, h }])
  if (!file) throw new Error('no image')
  const before = new Set((await fileItems(page)).map((f) => f.id))
  await insertFiles(page, [file])
  const [img] = await newItems(page, imageItems, before, 1)
  if (!img) throw new Error('no image element')
  await expectLoadedImage(page, img.id, board)
  await settleCamera(page)
  return img
}

/** Drags the crop editor's bottom-right corner by (dx, dy) screen px. */
async function dragCropCorner(page: Page, id: string, dx: number, dy: number) {
  const el = await item(page, id)
  if (!el) throw new Error('no element')
  const corner = await sceneToScreen(page, { x: el.x + el.width, y: el.y + el.height })
  await page.mouse.move(corner.x + 3, corner.y + 3)
  await page.mouse.down()
  await page.mouse.move(corner.x + 3 + dx / 2, corner.y + 3 + dy / 2, { steps: 5 })
  await page.mouse.move(corner.x + 3 + dx, corner.y + 3 + dy, { steps: 5 })
  await page.mouse.up()
}

test.use({ viewport: { width: 1440, height: 900 } })

test('W5-13 Replace media: key art v1 becomes v2 in the same element (place kept, new proportions); bob sees v2; one undo brings v1 back', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const v1 = await placeImage(a.page, board, 'key-art-v1.jpg', 1600, 900)
  await select(a.page, [v1.id])
  await expect(a.page.getByTestId('media-replace')).toBeVisible()
  const [v2] = await makeImages(a.page, [{ name: 'key-art-v2.jpg', w: 900, h: 1600 }])
  if (!v2) throw new Error('no v2')
  await pickWith(a.page, 'media-replace', v2)

  await expect
    .poll(async () => (await fileItems(a.page)).find((f) => f.id === v1.id)?.facts.name, { timeout: 60_000 })
    .toBe('key-art-v2.jpg')
  const after = (await fileItems(a.page)).find((f) => f.id === v1.id)
  if (!after) throw new Error('gone')
  // the same element: a new version, the same place (centre and longer side), the new proportions
  expect(after.fileId).toBe(after.facts.versionId)
  expect(after.facts.versionId).not.toBe(v1.facts.versionId)
  expect(after.facts.assetId).not.toBe(v1.facts.assetId)
  expect(after.x + after.width / 2).toBeCloseTo(v1.x + v1.width / 2, 0)
  expect(after.y + after.height / 2).toBeCloseTo(v1.y + v1.height / 2, 0)
  expect(after.height).toBeCloseTo(Math.max(v1.width, v1.height), 0)
  expect(after.height / after.width).toBeCloseTo(1600 / 900, 2)
  expect((await imageItems(a.page)).length).toBe(1)

  await test.step('bob sees v2 (the new version decoded on his canvas)', async () => {
    await expect
      .poll(async () => (await fileItems(b.page)).find((f) => f.id === v1.id)?.facts.versionId, {
        timeout: 30_000,
      })
      .toBe(after.facts.versionId)
    await expectLoadedImage(b.page, v1.id, board, 90_000)
  })

  await test.step('one undo puts v1 back where it was', async () => {
    await pressUndo(a.page)
    await expect
      .poll(async () => (await fileItems(a.page)).find((f) => f.id === v1.id)?.facts.versionId)
      .toBe(v1.facts.versionId)
    const back = (await fileItems(a.page)).find((f) => f.id === v1.id)
    expect(back && boxOf(back)).toEqual(boxOf(v1))
  })
})

test('W5-13 Replace media in a template slot: the new photo fills the same slot (cropped again), in the same frame', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  await pushTemplate(a.page, board, 'storyboard')
  const panel = await frameByName(a.page, 'Panel 1')
  if (!panel) throw new Error('no Panel 1')
  const [slot] = await slotsOf(a.page, panel.id)
  if (!slot) throw new Error('no slot')
  await setViewport(a.page, { x: panel.x - 100, y: panel.y - 100, zoom: 1 })
  await settleCamera(a.page)
  const [square] = await makeImages(a.page, [{ name: 'grab-v1.jpg', w: 1200, h: 1200 }])
  if (!square) throw new Error('no image')
  await dropFiles(
    a.page,
    [square],
    await sceneToScreen(a.page, { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 }),
  )
  const [placed] = await newItems(a.page, imageItems, new Set(), 1)
  if (!placed) throw new Error('not placed')
  expect(placed.crop).not.toBeNull()
  await expectLoadedImage(a.page, placed.id, board)

  await select(a.page, [placed.id])
  const [tall] = await makeImages(a.page, [{ name: 'grab-v2.jpg', w: 1080, h: 1920 }])
  if (!tall) throw new Error('no v2')
  await pickWith(a.page, 'media-replace', tall)
  await expect
    .poll(async () => (await fileItems(a.page)).find((f) => f.id === placed.id)?.facts.name, {
      timeout: 60_000,
    })
    .toBe('grab-v2.jpg')
  const after = (await fileItems(a.page)).find((f) => f.id === placed.id)
  if (!after) throw new Error('gone')
  expect(after.frameId).toBe(panel.id)
  expect(boxOf(after)).toEqual(boxOf(placed))
  // a portrait into a landscape slot: cut top and bottom, in the new thumb's pixels (288 × 512)
  const crop = after.crop as Crop
  expect(crop).toMatchObject({ x: 0, width: 288, naturalWidth: 288, naturalHeight: 512 })
  expect(crop.height).toBeLessThan(512)
})

test('W5-13 Replace media on a card: a PDF card becomes the new file’s card in place; images can only replace images', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  await insertFiles(a.page, [fixture('document.pdf')])
  const [card] = await newItems(a.page, cardItems, new Set(), 1)
  if (!card) throw new Error('no card')
  await expect(fileCard(a.page, 'document.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await select(a.page, [card.id])
  await pickWith(a.page, 'media-replace', fixture('notes.zip'))
  await expect(fileCard(a.page, 'notes.zip')).toHaveAttribute('data-kind', 'other', { timeout: 60_000 })
  const after = (await fileItems(a.page)).find((f) => f.id === card.id)
  expect(after?.facts).toMatchObject({ kind: 'other', name: 'notes.zip' })
  expect(after?.x).toBeCloseTo(card.x, 1)
  expect(after?.width).toBeCloseTo(card.width, 1)
  await expect(fileCard(a.page, 'document.pdf')).toHaveCount(0)

  // an image picked for a card is refused before any byte is sent
  await select(a.page, [card.id])
  const [png] = await makeImages(a.page, [{ name: 'oops.png', w: 200, h: 200, type: 'image/png' }])
  if (!png) throw new Error('no png')
  await pickWith(a.page, 'media-replace', png)
  await expect(a.page.getByText(/images replace images/)).toBeVisible()
  expect((await fileItems(a.page)).find((f) => f.id === card.id)?.facts.name).toBe('notes.zip')
})

test('W5-13 Crop: the selection bar opens the crop editor; a drag crops in the thumb’s pixels; Escape ends it; bob sees the same crop', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const img = await placeImage(a.page, board, 'crop-me.jpg', 1600, 900)
  await select(a.page, [img.id])
  await a.page.getByTestId('media-crop').click()
  await expect.poll(() => croppingId(a.page)).toBe(img.id)
  await expect(a.page.getByTestId('media-crop-hint')).toBeVisible()
  await dragCropCorner(a.page, img.id, -120, -40)
  await a.page.keyboard.press('Escape')
  await expect.poll(() => croppingId(a.page)).toBeNull()
  await expect
    .poll(async () => (await item(a.page, img.id))?.crop ?? null, { timeout: 15_000 })
    .not.toBeNull()
  const crop = (await item(a.page, img.id))?.crop as unknown as Crop
  // 1600 × 900 → the 512 × 288 thumb every tab loads
  expect(crop.naturalWidth).toBe(512)
  expect(crop.naturalHeight).toBe(288)
  expect(crop.width).toBeLessThan(512)
  await expect
    .poll(async () => JSON.stringify((await item(b.page, img.id))?.crop ?? null), { timeout: 30_000 })
    .toBe(JSON.stringify(crop))
})

test('W5-13 Crop on an image shown at its 2,048 px rendering: it goes back to its thumb first, so the crop is in the pixels every tab loads', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const img = await placeImage(a.page, board, 'big-view.jpg', 1600, 900)
  // shown larger than 512 device px for 300 ms: the swap moves it to its `display` rendering (local)
  await setViewport(a.page, { x: img.x - 40, y: img.y - 40, zoom: 900 / img.width })
  // unconditional since CR-W5-3G-3 (wave A): the sync core keeps the local suffix across its rebuilds
  await expect
    .poll(async () => (await sceneCopy(a.page, img.id))?.fileId ?? '', { timeout: 15_000 })
    .toBe(`${img.facts.versionId}@display`)
  await select(a.page, [img.id])
  await a.page.getByTestId('media-crop').click()
  await expect.poll(() => croppingId(a.page)).toBe(img.id)
  await expect.poll(async () => (await sceneCopy(a.page, img.id))?.fileId ?? '').toBe(img.facts.versionId)
  await dragCropCorner(a.page, img.id, -200, -60)
  await a.page.keyboard.press('Escape')
  await expect
    .poll(async () => (await item(a.page, img.id))?.crop ?? null, { timeout: 15_000 })
    .not.toBeNull()
  const crop = (await item(a.page, img.id))?.crop as unknown as Crop
  expect(crop.naturalWidth).toBe(512)
  // and it stays on its thumb while cropped, however large it is shown
  await a.page.waitForTimeout(1_500)
  expect((await sceneCopy(a.page, img.id))?.fileId).toBe(img.facts.versionId)
})

test('CR-W5-3G-3 an image shown at its 2,048 px rendering stays on it: another tab moves it, then its own drag; no frame goes back to the thumb', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const img = await placeImage(a.page, board, 'zoom-in.jpg', 1600, 900)
  const display = `${img.facts.versionId}@display`
  // shown larger than 512 device px for 300 ms: the swap moves it to its `display` rendering (local)
  await setViewport(a.page, { x: img.x - 40, y: img.y - 40, zoom: 900 / img.width })
  await expect
    .poll(async () => (await sceneCopy(a.page, img.id))?.fileId ?? '', { timeout: 15_000 })
    .toBe(display)
  await watchFileIds(a.page, img.id)

  await test.step('bob moves it: alice sees the move on the same 2,048 px rendering', async () => {
    const near = (v: number | undefined, want: number) => v !== undefined && Math.abs(v - want) < 0.5
    await expect
      .poll(async () => near((await item(b.page, img.id))?.x, img.x), { timeout: 30_000 })
      .toBe(true)
    await updateItem(b.page, img.id, { x: img.x + 60 })
    await expect
      .poll(async () => near((await item(a.page, img.id))?.x, img.x + 60), { timeout: 30_000 })
      .toBe(true)
    await a.page.waitForTimeout(500)
    expect((await sceneCopy(a.page, img.id))?.fileId).toBe(display)
  })

  await test.step('alice drags it herself: bob gets the move, the wire never carries the suffix', async () => {
    // 120 screen px down (the image is shown 900 px wide)
    await dragItem(a.page, img.id, { x: 0, y: 120 })
    const moved = (await item(a.page, img.id))?.y ?? img.y
    expect(moved).toBeGreaterThan(img.y + 20)
    await expect
      .poll(async () => Math.abs(((await item(b.page, img.id))?.y ?? 0) - moved) < 0.5, { timeout: 30_000 })
      .toBe(true)
    await a.page.waitForTimeout(500)
    expect((await sceneCopy(a.page, img.id))?.fileId).toBe(display)
    // alice's pushes carried the move with the wire file id only (E9)
    const pushed = JSON.stringify(await pushedOps(a.page))
    expect(pushed).toContain(img.id)
    expect(pushed).not.toMatch(/@(display|thumb)/)
  })

  // every frame since the upgrade drew the image from its display rendering
  expect(await seenFileIds(a.page)).toEqual([display])
})

test('W5-13 Alternative text: the dialog writes customData.lobby.alt (one undo); bob reads it; viewers get none of the three tools', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const img = await placeImage(a.page, board, 'team.jpg', 1200, 800)
  await select(a.page, [img.id])
  await a.page.getByTestId('media-alt-text-open').click()
  const dialog = a.page.getByTestId('media-alt-text')
  await expect(dialog).toBeVisible()
  const input = a.page.getByTestId('media-alt-text-input')
  await expect(input).toBeFocused()
  await input.fill('The DBC team at the Q3 offsite')
  await input.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(async () => (await fileItems(b.page)).find((f) => f.id === img.id)?.alt, { timeout: 30_000 })
    .toBe('The DBC team at the Q3 offsite')
  // the dialog opens on the current text; Escape changes nothing
  await select(a.page, [img.id])
  await a.page.getByTestId('media-alt-text-open').click()
  await expect(a.page.getByTestId('media-alt-text-input')).toHaveValue('The DBC team at the Q3 offsite')
  await a.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await pressUndo(a.page)
  await expect
    .poll(async () => (await fileItems(a.page)).find((f) => f.id === img.id)?.alt ?? null)
    .toBeNull()

  await test.step('a viewer sees no Replace, Crop or Alternative text', async () => {
    const v = await canvasSession('carol', { role: 'viewer' })
    await selectNone(v.page)
    await select(v.page, [img.id])
    await expect(v.page.getByTestId('media-download-original')).toBeVisible()
    for (const id of ['media-replace', 'media-crop', 'media-alt-text-open'])
      await expect(v.page.getByTestId(id)).toHaveCount(0)
  })
})
