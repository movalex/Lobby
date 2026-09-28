// Final demo walk, canvas part 3 (findings R7, F2-01, F2-02, DANA-06, DANA2-03): a mind map started with
// a frame in view belongs to that frame, uploads keep one page-space size, an image fills the template
// slot it is dropped on, a new tour opens on its Welcome frame, and the Frames panel goes to a frame
// without selecting it. (DANA-10, the AI themes under the tour's map: ai-assist.spec.ts.)
//
// Unit coverage: apps/web/src/features/mindmap/frame-place.test.ts, apps/web/src/assets/drop-layout.test.ts.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { edit, read, waitForValue } from './support/board.ts'
import { waitForCanvasUx } from './support/canvas-ux.ts'
import type { BoxLike, ShapeLike } from './support/editor.ts'
import { allShapeIds, dropFiles, makeImages, newShapeIds } from './support/files.ts'
import { expect, test } from './support/fixtures.ts'
import { mapView, toolbarButton, waitForTyping } from './support/mindmap.ts'
import { capture } from './support/screenshots.ts'
import { REPO_ROOT } from './support/stack.ts'
import { createShapes } from './support/tags.ts'

/** Local look-at copies of the screenshots (never committed). */
const SHOTS = join(REPO_ROOT, '.scratch/shots/canvas-3')

async function shot(name: string, target: Page | Locator) {
  mkdirSync(SHOTS, { recursive: true })
  await target.screenshot({ path: join(SHOTS, name), animations: 'disabled' })
  await capture(name, target, test.info())
}

type Cam = {
  zoomToBounds(b: BoxLike, o: Record<string, unknown>): void
  getZoomLevel(): number
  getCamera(): { x: number; y: number; z: number }
  setCamera(c: { x: number; y: number; z: number }, o: Record<string, unknown>): void
  getCameraState(): string
  zoomToFit(o: Record<string, unknown>): void
}

const boundsOf = (page: Page, id: string) =>
  read(
    page,
    (ed, i) => {
      const b = ed.getShapePageBounds(i)
      return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null
    },
    id,
  ) as Promise<BoxLike | null>

const fit = (page: Page, b: BoxLike, inset = 48) =>
  edit(
    page,
    (ed, arg) => {
      ed.selectNone()
      ;(ed as unknown as Cam).zoomToBounds(arg.b, { inset: arg.inset, immediate: true, targetZoom: 1 })
    },
    { b, inset },
  )

const zoomOf = (page: Page) => read(page, (ed) => (ed as unknown as Cam).getZoomLevel()) as Promise<number>

const inside = (outer: BoxLike, r: BoxLike, tol = 0.5) =>
  r.x >= outer.x - tol &&
  r.y >= outer.y - tol &&
  r.x + r.w <= outer.x + outer.w + tol &&
  r.y + r.h <= outer.y + outer.h + tol
const overlap = (a: BoxLike, b: BoxLike) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

async function insertTemplate(page: Page, id: string) {
  await page.getByTestId('tools.dr-templates').click()
  await page.locator(`[data-testid="template-option"][data-template-id="${id}"]`).click()
  await expect(page.getByTestId('template-picker')).toHaveCount(0)
}

test('R7 a mind map started while a full frame fills the view is made inside it, the frame growing downward', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const F = 'shape:c3-retro'
  // A retro-like frame whose notes fill it: no free room left for a map.
  const notes = Array.from({ length: 12 }, (_, i) => ({
    id: `shape:c3-note-${i}`,
    type: 'note',
    parentId: F,
    x: 60 + (i % 6) * 250,
    y: 80 + Math.floor(i / 6) * 420,
  }))
  await createShapes(a.page, [
    { id: F, type: 'frame', x: 0, y: 0, props: { w: 1600, h: 960, name: '5 · Retro' } },
    ...notes,
  ])
  const before = (await boundsOf(a.page, F)) as BoxLike
  await fit(a.page, before)

  await toolbarButton(a.page).click()
  await waitForTyping(a.page)
  await a.page.keyboard.type('Next sprint actions')
  await a.page.keyboard.press('Tab')
  await a.page.keyboard.type('Book art sign-off slots')
  await a.page.keyboard.press('Enter')
  await a.page.keyboard.type('One review round per cut')
  await a.page.keyboard.press('Escape')

  const v = await waitForValue(async () => {
    const m = await mapView(a.page)
    return m.topics.length === 3 ? m : null
  })
  const parents = (await read(
    a.page,
    (ed, ids) => ids.map((id: string) => ed.getShape(id)?.parentId ?? null),
    v.topics.map((t) => t.id),
  )) as (string | null)[]
  expect(parents).toEqual([F, F, F])
  const grown = (await boundsOf(a.page, F)) as BoxLike
  expect(grown.w).toBe(before.w)
  expect(grown.h).toBeGreaterThan(before.h)
  const noteBoxes = await Promise.all(notes.map((n) => boundsOf(a.page, n.id)))
  for (const t of v.topics) {
    expect(inside(grown, t.box), `"${t.text}" inside the frame`).toBe(true)
    for (const n of noteBoxes) expect(overlap(t.box, n as BoxLike), `"${t.text}" over a note`).toBe(false)
  }
  await fit(a.page, grown)
  await shot('r7-mindmap-inside-frame.png', a.page)
})

test('F2-01 two uploads at different zooms come out at the same page-space size', async ({ session }) => {
  test.setTimeout(120_000)
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const longest = async (ids: string[]) =>
    Promise.all(ids.map(async (id) => ((await boundsOf(a.page, id)) as BoxLike) ?? { w: 0, h: 0 })).then(
      (bs) => bs.map((b) => Math.max(b.w, b.h)),
    )
  const dropAt = async (zoom: number, names: string[], screen: { x: number; y: number }) => {
    await edit(
      a.page,
      (ed, z) => {
        const e = ed as unknown as Cam
        e.setCamera({ ...e.getCamera(), z }, { immediate: true })
      },
      zoom,
    )
    const files = await makeImages(
      a.page,
      names.map((name, i) => ({ name, w: i % 2 ? 1200 : 900, h: i % 2 ? 800 : 1200 })),
    )
    const before = await allShapeIds(a.page)
    await dropFiles(a.page, files, screen)
    return waitForValue(async () => {
      const found = await newShapeIds(a.page, 'image', before)
      return found.length === names.length ? found : null
    })
  }
  const first = await dropAt(0.4, ['z40-a.jpg', 'z40-b.jpg', 'z40-c.jpg'], { x: 500, y: 450 })
  await a.page.waitForTimeout(600)
  const second = await dropAt(1.25, ['z125-a.jpg', 'z125-b.jpg'], { x: 900, y: 400 })
  await a.page.waitForTimeout(600)
  const sides = [...(await longest(first)), ...(await longest(second))]
  for (const s of sides) expect(s).toBeCloseTo(sides[0] as number, 0)
  expect(sides[0]).toBeCloseTo(400, 0)
  await edit(a.page, (ed) => (ed as unknown as Cam).zoomToFit({ immediate: true }))
  await shot('f2-01-two-uploads-same-size.png', a.page)
})

test('F2-02 a portrait photo dropped on a Mood board slot fills the slot, centre-cropped', async ({
  session,
}) => {
  test.setTimeout(120_000)
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await insertTemplate(a.page, 'mood-board')
  const imagery = (await read(a.page, (ed) => {
    const f = ed
      .getCurrentPageShapes()
      .find((s: ShapeLike) => s.type === 'frame' && /Imagery/.test(String(s.props.name)))
    const b = f ? ed.getShapePageBounds(f.id) : undefined
    const slot = f
      ? ed
          .getSortedChildIdsForParent(f.id)
          .map((c: string) => ed.getShape(c))
          .filter((s): s is ShapeLike => s?.meta.draftroomSlot === 'image')
          .map((s) => ed.getShapePageBounds(s.id))
          .sort((p, q) => (p?.y ?? 0) - (q?.y ?? 0) || (p?.x ?? 0) - (q?.x ?? 0))[0]
      : undefined
    return f && b && slot
      ? {
          id: f.id,
          b: { x: b.x, y: b.y, w: b.w, h: b.h },
          slot: { x: slot.x, y: slot.y, w: slot.w, h: slot.h },
        }
      : null
  })) as { id: string; b: BoxLike; slot: BoxLike } | null
  if (!imagery) throw new Error('no Imagery frame with a slot')
  await fit(a.page, imagery.b)
  const [photo] = await makeImages(a.page, [{ name: 'portrait.jpg', w: 900, h: 1200 }])
  if (!photo) throw new Error('no photo')
  const before = await allShapeIds(a.page)
  const at = await read(
    a.page,
    (ed, p) =>
      (ed as unknown as { pageToScreen(p: { x: number; y: number }): { x: number; y: number } }).pageToScreen(
        p,
      ),
    { x: imagery.slot.x + imagery.slot.w / 2, y: imagery.slot.y + imagery.slot.h / 2 },
  )
  await dropFiles(a.page, [photo], at)
  const [id] = await waitForValue(async () => {
    const found = await newShapeIds(a.page, 'image', before)
    return found.length === 1 ? found : null
  })
  if (!id) throw new Error('no image')
  await a.page.waitForTimeout(600)
  const placed = (await read(
    a.page,
    (ed, i) => {
      const s = ed.getShape(i)
      const b = ed.getShapePageBounds(i)
      return s && b
        ? { parentId: s.parentId, crop: s.props.crop, b: { x: b.x, y: b.y, w: b.w, h: b.h } }
        : null
    },
    id,
  )) as {
    parentId: string
    crop: { topLeft: { x: number; y: number }; bottomRight: { x: number; y: number } } | null
    b: BoxLike
  } | null
  expect(placed?.parentId).toBe(imagery.id)
  // The whole slot, no placeholder beside it.
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(placed?.b[k]).toBeCloseTo(imagery.slot[k], 0)
  expect(placed?.crop?.topLeft.x).toBe(0)
  expect(placed?.crop?.bottomRight.x).toBe(1)
  expect(placed?.crop?.topLeft.y ?? 0).toBeGreaterThan(0)
  expect(1 - (placed?.crop?.bottomRight.y ?? 1)).toBeCloseTo(placed?.crop?.topLeft.y ?? 0, 6)
  await edit(a.page, (ed) => ed.selectNone())
  await shot('f2-02-slot-filled.png', a.page)
})

test('DANA2-03 the Frames panel goes to a frame without selecting it; a drag inside then does not move the frame', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const [F1, F2] = ['shape:c3-welcome', 'shape:c3-brainstorm']
  await createShapes(a.page, [
    { id: F1, type: 'frame', x: 0, y: 0, props: { w: 1600, h: 1000, name: '1 · Welcome' } },
    { id: F2, type: 'frame', x: 1800, y: 0, props: { w: 1600, h: 1000, name: '2 · Brainstorm' } },
    { id: 'shape:c3-idea', type: 'note', parentId: F2, x: 900, y: 500 },
  ])
  await edit(a.page, (ed) => ed.select('shape:c3-idea'))
  await a.page.getByTestId('dock-tab-frames').click()
  const row = a.page.locator(`[data-testid="frame-row"][data-frame-id="${F2}"] .dr-cux-frame__name`)
  await row.click()
  await expect.poll(() => read(a.page, (ed) => (ed as unknown as Cam).getCameraState())).toBe('idle')
  expect(await read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([])
  const frameBefore = (await boundsOf(a.page, F2)) as BoxLike
  expect(await zoomOf(a.page)).toBeGreaterThan(0.3)
  await shot('dana2-03-after-frames-panel.png', a.page)

  // A box-drag over the frame's empty interior (DEMO.md 1:20) selects, it does not move the frame.
  const start = await read(
    a.page,
    (ed, p) =>
      (ed as unknown as { pageToScreen(p: { x: number; y: number }): { x: number; y: number } }).pageToScreen(
        p,
      ),
    { x: frameBefore.x + 700, y: frameBefore.y + 350 },
  )
  await a.page.mouse.move(start.x, start.y)
  await a.page.mouse.down()
  await a.page.mouse.move(start.x + 260, start.y + 260, { steps: 8 })
  await a.page.mouse.up()
  expect(await boundsOf(a.page, F2)).toEqual(frameBefore)
  expect(await read(a.page, (ed) => ed.getSelectedShapeIds())).not.toContain(F2)

  // A second click on the row, with the frame in view, selects it (Shift+click still adds).
  await row.click()
  await row.click()
  expect(await read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([F2])
})
