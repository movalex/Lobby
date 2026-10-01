// GAP PASS (browser-test gaps on the Excalidraw canvas): the select tool's own gestures with the REAL
// pointer and keyboard, which no ported spec drives on the new engine:
//
//  - a marquee (a drag on empty canvas) and Shift+click to add and remove one element;
//  - the arrow keys nudging the selection (Excalidraw: 1 px, 5 px with Shift; the Lobby keymap delegates
//    plain arrows, canvas/input/keymap.ts);
//  - a resize by a corner handle (collab-conflicts resizes through the facade's `update`, not a handle);
//  - a rotation by the rotation handle (no spec rotates anything);
//  - Space+drag panning over a selected shape and the plain wheel (the tldraw suite's canvas-ux.fix F3
//    "Space+drag over a selected image pans and never moves the image" was never ported).
//
// Handle geometry is Excalidraw's (@excalidraw/element getTransformHandlesFromCoords, mouse size 8, margin 4,
// spacing 2): a corner handle's centre is 6 screen px outside the corner on both axes; the rotation handle's
// centre is 22 screen px above the top edge, at the horizontal centre; both at any zoom.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw gaps-input-select
import type { Page } from '@playwright/test'
import {
  type CanvasElement,
  clickItem,
  createItem,
  createNote,
  expect,
  expectConverged,
  expectSaved,
  item,
  itemBounds,
  sceneToScreen,
  selection,
  setViewport,
  test,
  tool,
  viewport,
} from '../tests/support/canvas.ts'
import { focusCanvas, pressUndo, pushCount } from '../tests/support/excalidraw.ts'
import { emptyCanvasPoint, focusBoard, settled } from './board-kit.ts'

/** A solid fill: a transparent shape is hit by Excalidraw on its outline only, and these specs click centres. */
const FILLED = { backgroundColor: '#a5d8ff', fillStyle: 'solid' } as const

const sorted = async (page: Page) => [...(await selection(page))].sort()
const place = async (page: Page, id: string) => {
  const e = await item(page, id)
  return e ? { x: Math.round(e.x), y: Math.round(e.y) } : null
}
const size = async (page: Page, id: string) => {
  const e = await item(page, id)
  return e ? { w: Math.round(e.width), h: Math.round(e.height) } : null
}
const angleOf = async (page: Page, id: string) => (await item(page, id))?.angle ?? null

/** A drag with the real pointer between two screen points. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
}

/** The bound label of a sticky note (its text element). */
async function labelOf(page: Page, noteId: string): Promise<CanvasElement | null> {
  const note = (await item(page, noteId)) as { boundElements?: { id: string; type: string }[] } | null
  const id = (note?.boundElements ?? []).find((b) => b.type === 'text')?.id
  return id ? item(page, id) : null
}

test('marquee: a drag on empty canvas selects exactly what it encloses; Shift+click adds one and removes it again; a click on empty canvas clears; selecting pushes nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const n1 = await settled(a.page, createNote(a.page, { x: 200, y: 160, text: 'one' }))
  const n2 = await settled(a.page, createNote(a.page, { x: 420, y: 160, text: 'two' }))
  const n3 = await settled(a.page, createNote(a.page, { x: 760, y: 160, text: 'three' }))
  await expectConverged(a.page, [b.page])
  const pushes = await pushCount(a.page)
  const b1 = (await itemBounds(a.page, n1)) as NonNullable<Awaited<ReturnType<typeof itemBounds>>>
  const b2 = (await itemBounds(a.page, n2)) as NonNullable<Awaited<ReturnType<typeof itemBounds>>>

  await test.step('a marquee around notes one and two (not three)', async () => {
    await focusBoard(a.page)
    await a.page.keyboard.press('v')
    await expect.poll(() => tool(a.page)).toBe('select')
    const from = await sceneToScreen(a.page, { x: b1.x - 40, y: b1.y - 40 })
    const to = await sceneToScreen(a.page, {
      x: Math.max(b1.x + b1.width, b2.x + b2.width) + 30,
      y: Math.max(b1.y + b1.height, b2.y + b2.height) + 30,
    })
    await drag(a.page, from, to)
    await expect.poll(() => sorted(a.page)).toEqual([n1, n2].sort())
  })

  await test.step('Shift+click adds the third, Shift+click again removes it', async () => {
    await clickItem(a.page, n3, { modifiers: ['Shift'] })
    await expect.poll(() => sorted(a.page)).toEqual([n1, n2, n3].sort())
    await clickItem(a.page, n3, { modifiers: ['Shift'] })
    await expect.poll(() => sorted(a.page)).toEqual([n1, n2].sort())
  })

  await test.step('a click on empty canvas clears; nothing was pushed; bob’s selection is his own', async () => {
    const p = await emptyCanvasPoint(a.page)
    await a.page.mouse.click(p.x, p.y)
    await expect.poll(() => sorted(a.page)).toEqual([])
    expect(await pushCount(a.page)).toBe(pushes)
    expect(await sorted(b.page)).toEqual([])
    await expectConverged(a.page, [b.page])
  })
})

test('arrow keys nudge the selected note (and its label): 1 px a press, 5 px with Shift; bob converges; Ctrl+Z walks it back to where it was', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const n1 = await settled(a.page, createNote(a.page, { x: 300, y: 200, text: 'nudge me' }))
  await expectConverged(a.page, [b.page])
  const start = (await place(a.page, n1)) as { x: number; y: number }
  const label0 = (await labelOf(a.page, n1)) as CanvasElement

  await clickItem(a.page, n1)
  await expect.poll(() => sorted(a.page)).toEqual([n1])
  await focusCanvas(a.page)
  for (let i = 0; i < 3; i++) await a.page.keyboard.press('ArrowRight')
  await expect.poll(() => place(a.page, n1)).toEqual({ x: start.x + 3, y: start.y })
  await a.page.keyboard.press('Shift+ArrowDown')
  await expect.poll(() => place(a.page, n1)).toEqual({ x: start.x + 3, y: start.y + 5 })
  await a.page.keyboard.press('ArrowLeft')
  await expect.poll(() => place(a.page, n1)).toEqual({ x: start.x + 2, y: start.y + 5 })

  await test.step('the label moved with it; Saved; bob has the same place', async () => {
    const label1 = (await labelOf(a.page, n1)) as CanvasElement
    expect({ dx: Math.round(label1.x - label0.x), dy: Math.round(label1.y - label0.y) }).toEqual({
      dx: 2,
      dy: 5,
    })
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    expect(await place(b.page, n1)).toEqual({ x: start.x + 2, y: start.y + 5 })
  })

  await test.step('undo walks back: at most one step per press, back at the start within five', async () => {
    let presses = 0
    while (presses < 5) {
      await pressUndo(a.page)
      presses++
      await a.page.waitForTimeout(80)
      const now = await place(a.page, n1)
      if (now && now.x === start.x && now.y === start.y) break
    }
    expect(await place(a.page, n1)).toEqual(start)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })
})

test('resize by the bottom-right handle with the real pointer: the box grows by the drag, bob sees the same size, one Ctrl+Z puts the size back', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  // filled: Excalidraw hits a transparent shape on its outline only, and the click below is on its centre
  const box = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 300, y: 200, width: 240, height: 160, ...FILLED }),
  )
  await expectConverged(a.page, [b.page])
  const zoom = (await viewport(a.page)).zoom
  const bounds = (await itemBounds(a.page, box)) as NonNullable<Awaited<ReturnType<typeof itemBounds>>>

  await clickItem(a.page, box)
  await expect.poll(() => sorted(a.page)).toEqual([box])
  const corner = await sceneToScreen(a.page, { x: bounds.x + bounds.width, y: bounds.y + bounds.height })
  const handle = { x: corner.x + 6, y: corner.y + 6 }
  const delta = { x: 80, y: 50 }
  await drag(a.page, handle, { x: handle.x + delta.x, y: handle.y + delta.y })
  const want = { w: Math.round(240 + delta.x / zoom), h: Math.round(160 + delta.y / zoom) }
  await expect
    .poll(async () => {
      const s = await size(a.page, box)
      return s && Math.abs(s.w - want.w) <= 3 && Math.abs(s.h - want.h) <= 3 ? 'grown' : JSON.stringify(s)
    })
    .toBe('grown')
  expect(await place(a.page, box)).toEqual({ x: 300, y: 200 })

  await expectSaved(a.page)
  await expectConverged(a.page, [b.page])
  const onBob = (await size(b.page, box)) as { w: number; h: number }
  expect(Math.abs(onBob.w - want.w)).toBeLessThanOrEqual(3)
  expect(Math.abs(onBob.h - want.h)).toBeLessThanOrEqual(3)

  await pressUndo(a.page)
  await expect.poll(() => size(a.page, box)).toEqual({ w: 240, h: 160 })
  await expectSaved(a.page)
  await expectConverged(a.page, [b.page])
})

test('rotate by the rotation handle with the real pointer: a quarter turn sets angle π/2 on both tabs; one Ctrl+Z puts it back to 0', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const box = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 400, y: 260, width: 200, height: 120, ...FILLED }),
  )
  await expectConverged(a.page, [b.page])
  expect(await angleOf(a.page, box)).toBe(0)

  await clickItem(a.page, box)
  await expect.poll(() => sorted(a.page)).toEqual([box])
  const top = await sceneToScreen(a.page, { x: 500, y: 260 })
  const centre = await sceneToScreen(a.page, { x: 500, y: 320 })
  const handle = { x: top.x, y: top.y - 22 }
  // from above the centre, round the right-hand side, to the right of the centre: a clockwise quarter turn
  await a.page.mouse.move(handle.x, handle.y)
  await a.page.mouse.down()
  await a.page.mouse.move(centre.x + 110, centre.y - 110, { steps: 8 })
  await a.page.mouse.move(centre.x + 160, centre.y, { steps: 8 })
  await a.page.mouse.up()

  const quarter = Math.PI / 2
  await expect
    .poll(async () => {
      const ang = await angleOf(a.page, box)
      return ang !== null && Math.abs(ang - quarter) < 0.06 ? 'quarter' : String(ang)
    })
    .toBe('quarter')
  await expectSaved(a.page)
  await expectConverged(a.page, [b.page])
  expect(Math.abs(((await angleOf(b.page, box)) as number) - quarter)).toBeLessThan(0.06)

  await pressUndo(a.page)
  await expect.poll(() => angleOf(a.page, box)).toBe(0)
  await expectSaved(a.page)
  await expectConverged(a.page, [b.page])
})

test('Space+drag over the selected shape pans the view and never moves the shape; the plain wheel pans too; the zoom and the document are untouched (no push)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const box = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 300, y: 220, width: 300, height: 200, ...FILLED }),
  )
  await clickItem(a.page, box)
  await expect.poll(() => sorted(a.page)).toEqual([box])
  const pushes = await pushCount(a.page)
  const before = await viewport(a.page)

  await test.step('Space+drag starting on the selected shape', async () => {
    const c = await sceneToScreen(a.page, { x: 450, y: 320 })
    await focusCanvas(a.page)
    await a.page.keyboard.down('Space')
    await drag(a.page, c, { x: c.x + 150, y: c.y + 100 }, 8)
    await a.page.keyboard.up('Space')
    await a.page.waitForTimeout(150)
    expect(await place(a.page, box)).toEqual({ x: 300, y: 220 })
    const after = await viewport(a.page)
    expect(after.zoom).toBe(before.zoom)
    // the content followed the pointer: the view's top-left moved by the drag (in scene units)
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(100 / before.zoom)
    expect(await sorted(a.page)).toEqual([box])
  })

  await test.step('the wheel pans (no modifier): the view moves down, the zoom stays, nothing moves', async () => {
    const mid = await viewport(a.page)
    const p = await emptyCanvasPoint(a.page)
    await a.page.mouse.move(p.x, p.y)
    await a.page.mouse.wheel(0, 240)
    await expect.poll(async () => (await viewport(a.page)).y - mid.y).toBeGreaterThan(50 / mid.zoom)
    expect((await viewport(a.page)).zoom).toBe(mid.zoom)
    expect(await place(a.page, box)).toEqual({ x: 300, y: 220 })
  })

  expect(await pushCount(a.page)).toBe(pushes)
  await expectSaved(a.page)
})
