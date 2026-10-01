// W5-01 (docs/research/excalidraw/REVIEW-W5-EARLY.md, 2C): notes and text made inside a frame are its
// children, as on the tldraw board: N and a click, T and a click, the rail's "Add a sticky note", and a
// note dragged in (and out). The frame's children move with it, and the other tab and the server agree.
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  dragItem,
  editingId,
  expect,
  expectSaved,
  item,
  items,
  itemText,
  setTool,
  setViewport,
  test,
  tool,
  waitForCanvas,
  waitForItem,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { focusBoard, settled } from './board-kit.ts'
import { clickScene, waitForCanvasUx } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const FRAME = { x: 60, y: 80, width: 700, height: 520 }

const labelOf = async (page: Page, id: string) => {
  const note = await item(page, id)
  const labelId = (
    (note as { boundElements?: { id: string; type: string }[] } | null)?.boundElements ?? []
  ).find((b) => b.type === 'text')?.id
  return labelId ? item(page, labelId) : null
}

const newIds = async (page: Page, type: string, known: Set<string>) =>
  (await items(page)).filter((e) => e.type === type && !e.containerId && !known.has(e.id)).map((e) => e.id)

async function typeInto(page: Page, id: string, text: string) {
  await waitForTextEditor(page, id)
  await expectSaved(page)
  await page.keyboard.type(text)
  await expect.poll(() => itemText(page, id)).toBe(text)
  await page.keyboard.press('Escape')
  await expect.poll(() => editingId(page)).toBeNull()
}

test('W5-01: N, T and "Add a sticky note" inside a frame make its children (label included), the other tab and the server agree, and they move with the frame', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const frame = await settled(a.page, createItem(a.page, 'frame', { ...FRAME, name: 'Retro' }))
  await focusBoard(a.page)
  const known = new Set((await items(a.page)).map((e) => e.id))

  // N + click inside the frame
  await a.page.keyboard.press('n')
  await expect.poll(() => tool(a.page)).toBe('note')
  await clickScene(a.page, { x: 260, y: 260 })
  await expect.poll(async () => (await newIds(a.page, 'stickynote', known)).length).toBe(1)
  const byN = (await newIds(a.page, 'stickynote', known))[0] as string
  known.add(byN)
  await typeInto(a.page, byN, 'Went well')
  expect((await item(a.page, byN))?.frameId).toBe(frame)
  expect((await labelOf(a.page, byN))?.frameId).toBe(frame)

  // T + click inside the frame: a free text
  await focusBoard(a.page)
  await a.page.keyboard.press('t')
  await expect.poll(() => tool(a.page)).toBe('text')
  await clickScene(a.page, { x: 520, y: 480 })
  await expect.poll(async () => (await newIds(a.page, 'text', known)).length).toBe(1)
  const byT = (await newIds(a.page, 'text', known))[0] as string
  known.add(byT)
  await typeInto(a.page, byT, 'Note to self')
  expect((await item(a.page, byT))?.frameId).toBe(frame)

  // the rail's button, with the view centred inside the frame
  const v = await a.page.evaluate(() => {
    const c = (window as unknown as { __lobbyBoard: { canvas: { viewport: { get(): unknown } } } })
      .__lobbyBoard.canvas
    return c.viewport.get() as { width: number; height: number }
  })
  await setViewport(a.page, { x: 560 - v.width / 2, y: 420 - v.height / 2, zoom: 1 })
  const add = a.page.getByTestId('dock-add-note')
  await add.focus()
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await newIds(a.page, 'stickynote', known)).length).toBe(1)
  const byRail = (await newIds(a.page, 'stickynote', known))[0] as string
  known.add(byRail)
  await typeInto(a.page, byRail, 'From the rail')
  expect((await item(a.page, byRail))?.frameId).toBe(frame)
  expect((await labelOf(a.page, byRail))?.frameId).toBe(frame)

  // the server kept it: bob's copies (and a reload's) say the same
  await expectSaved(a.page)
  for (const id of [byN, byT, byRail])
    await waitForItem(b.page, id, (e) => (e as { frameId?: string | null }).frameId === frame)
  await b.page.reload()
  await waitForCanvas(b.page)
  await expect.poll(async () => (await item(b.page, byN))?.frameId, { timeout: 30_000 }).toBe(frame)

  // they move with the frame (dragged by its name, as people do)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await setTool(a.page, 'select')
  const before = await item(a.page, byN)
  const name = a.page.locator('.excalidraw .frame-name', { hasText: 'Retro' })
  await expect(name).toBeVisible()
  const nb = await name.boundingBox()
  if (!nb) throw new Error('no frame name')
  await a.page.mouse.move(nb.x + 10, nb.y + nb.height / 2)
  await a.page.mouse.down()
  await a.page.mouse.move(nb.x + 130, nb.y + nb.height / 2 + 40, { steps: 10 })
  await a.page.mouse.up()
  await expect.poll(async () => Math.round(((await item(a.page, frame))?.x ?? 0) - FRAME.x)).toBe(120)
  const after = await item(a.page, byN)
  expect(Math.round((after?.x ?? 0) - (before?.x ?? 0))).toBe(120)
  expect(Math.round((after?.y ?? 0) - (before?.y ?? 0))).toBe(40)
  await expectSaved(a.page)
  await waitForItem(b.page, byN, (e) => Math.round(e.x - (before?.x ?? 0)) === 120)
})

test('W5-01: a note dragged into a frame joins it (label included) and leaves it when dragged out; outside any frame N makes a loose note', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const frame = await settled(a.page, createItem(a.page, 'frame', { ...FRAME, name: 'Ideas' }))
  const loose = await settled(a.page, createNote(a.page, { x: 960, y: 140, text: 'Outside' }))
  expect((await item(a.page, loose))?.frameId ?? null).toBeNull()
  await focusBoard(a.page)

  await dragItem(a.page, loose, { x: -620, y: 160 }, 12)
  await expect.poll(async () => (await item(a.page, loose))?.frameId ?? null).toBe(frame)
  await expect.poll(async () => (await labelOf(a.page, loose))?.frameId ?? null).toBe(frame)
  await expectSaved(a.page)
  await waitForItem(b.page, loose, (e) => (e as { frameId?: string | null }).frameId === frame)

  await dragItem(a.page, loose, { x: 700, y: 0 }, 12)
  await expect.poll(async () => (await item(a.page, loose))?.frameId ?? null).toBeNull()
  await expect.poll(async () => (await labelOf(a.page, loose))?.frameId ?? null).toBeNull()
  await expectSaved(a.page)
  await waitForItem(b.page, loose, (e) => ((e as { frameId?: string | null }).frameId ?? null) === null)

  // N outside every frame: no frame
  const known = new Set((await items(a.page)).map((e) => e.id))
  await focusBoard(a.page)
  await a.page.keyboard.press('n')
  await expect.poll(() => tool(a.page)).toBe('note')
  await clickScene(a.page, { x: 1000, y: 650 })
  await expect.poll(async () => (await newIds(a.page, 'stickynote', known)).length).toBe(1)
  const out = (await newIds(a.page, 'stickynote', known))[0] as string
  await typeInto(a.page, out, 'Loose')
  expect((await item(a.page, out))?.frameId ?? null).toBeNull()
})

test('W5-01: N inside a locked frame makes a loose note (a locked frame takes no new children)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const frame = await settled(a.page, createItem(a.page, 'frame', { ...FRAME, name: 'Locked', locked: true }))
  expect((await item(a.page, frame))?.locked).toBe(true)
  const known = new Set((await items(a.page)).map((e) => e.id))
  await focusBoard(a.page)
  await a.page.keyboard.press('n')
  await expect.poll(() => tool(a.page)).toBe('note')
  await clickScene(a.page, { x: 300, y: 300 })
  await expect.poll(async () => (await newIds(a.page, 'stickynote', known)).length).toBe(1)
  const id = (await newIds(a.page, 'stickynote', known))[0] as string
  await typeInto(a.page, id, 'Not inside')
  expect((await item(a.page, id))?.frameId ?? null).toBeNull()
})
