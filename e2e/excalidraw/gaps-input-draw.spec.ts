// GAP PASS (browser-test gaps on the Excalidraw canvas): the drawing tools driven with the REAL pointer.
// The ported specs pick tools (canvas-ux-toolbar "L connector, P pen pick their tool"), place shapes with
// Enter (A11Y-07), draw connectors (W5-11) and polygons (D4) and highlight (Shift+D); nothing drags out a
// plain rectangle, ellipse, line or pen stroke, nothing erases, and the frame tool is never dragged around
// existing notes (RETRO-14 creates its frame through the facade; W5-01 makes notes INSIDE a frame).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw gaps-input-draw
//
// Keys are Lobby's (canvas/input/keymap.ts TOOL_KEYS: r, o, p, e, f, v); the line has no key and is picked
// through the facade's setTool (CR-3A-9: it goes through LobbyCanvas). Convergence is the facade hash.
import type { Page } from '@playwright/test'
import {
  type CanvasElement,
  createNote,
  expect,
  expectConverged,
  expectSaved,
  item,
  itemBounds,
  items,
  sceneToScreen,
  selection,
  setTool,
  setViewport,
  test,
  tool,
} from '../tests/support/canvas.ts'
import { pressUndo, serverSnapshot } from '../tests/support/excalidraw.ts'
import { focusBoard, settled } from './board-kit.ts'

type Pt = { x: number; y: number }
const live = async (page: Page, id: string) => {
  const e = (await item(page, id)) as { isDeleted?: boolean } | null
  return !!e && !e.isDeleted
}

/** Drags with the real pointer from scene `from` to scene `to`. */
async function dragScene(page: Page, from: Pt, to: Pt, steps = 10) {
  const a = await sceneToScreen(page, from)
  const b = await sceneToScreen(page, to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
}

/** The one new element of `type` since `before`, polled. */
async function newElement(page: Page, type: string, before: ReadonlySet<string>): Promise<CanvasElement> {
  let found: CanvasElement[] = []
  await expect
    .poll(
      async () => {
        found = (await items(page)).filter((e) => e.type === type && !before.has(e.id))
        return found.length
      },
      { message: `one new ${type}` },
    )
    .toBe(1)
  return found[0] as CanvasElement
}

const ids = async (page: Page) => new Set((await items(page)).map((e) => e.id))
const near = (got: number, want: number, tol = 3) => Math.abs(got - want) <= tol

test('drawing with the real pointer: R, O and P strokes and the line from More each make their element where the pointer went; bob sees them; Ctrl+Z removes the last', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await focusBoard(a.page)

  let rect: CanvasElement
  await test.step('R: a drag from (150,150) to (350,270) is a 200×120 rectangle; Select comes back with it selected', async () => {
    const before = await ids(a.page)
    await a.page.keyboard.press('r')
    await expect.poll(() => tool(a.page)).toBe('rectangle')
    await dragScene(a.page, { x: 150, y: 150 }, { x: 350, y: 270 })
    rect = await newElement(a.page, 'rectangle', before)
    expect([near(rect.x, 150), near(rect.y, 150), near(rect.width, 200), near(rect.height, 120)]).toEqual([
      true,
      true,
      true,
      true,
    ])
    await expect.poll(() => tool(a.page)).toBe('select')
    await expect.poll(() => selection(a.page)).toEqual([rect.id])
  })

  let ellipse: CanvasElement
  await test.step('O: an ellipse by drag', async () => {
    const before = await ids(a.page)
    await a.page.keyboard.press('o')
    await expect.poll(() => tool(a.page)).toBe('ellipse')
    await dragScene(a.page, { x: 420, y: 150 }, { x: 620, y: 270 })
    ellipse = await newElement(a.page, 'ellipse', before)
    expect([
      near(ellipse.x, 420),
      near(ellipse.y, 150),
      near(ellipse.width, 200),
      near(ellipse.height, 120),
    ]).toEqual([true, true, true, true])
  })

  let line: CanvasElement
  await test.step('the line (More, no key): a drag is a two-point line', async () => {
    const before = await ids(a.page)
    expect(await setTool(a.page, 'line')).toBe(true)
    await expect.poll(() => tool(a.page)).toBe('line')
    await dragScene(a.page, { x: 150, y: 380 }, { x: 350, y: 450 })
    line = await newElement(a.page, 'line', before)
    const points = (line as { points?: number[][] }).points ?? []
    expect(points.length).toBe(2)
    expect([near(line.x, 150), near(line.y, 380), near(line.width, 200), near(line.height, 70)]).toEqual([
      true,
      true,
      true,
      true,
    ])
  })

  let stroke: CanvasElement
  await test.step('P: a pen stroke along a path is one freedraw with its points', async () => {
    const before = await ids(a.page)
    await a.page.keyboard.press('p')
    await expect.poll(() => tool(a.page)).toBe('freedraw')
    const s = await sceneToScreen(a.page, { x: 450, y: 380 })
    await a.page.mouse.move(s.x, s.y)
    await a.page.mouse.down()
    await a.page.mouse.move(s.x + 70, s.y + 40, { steps: 6 })
    await a.page.mouse.move(s.x + 140, s.y + 10, { steps: 6 })
    await a.page.mouse.move(s.x + 200, s.y + 60, { steps: 6 })
    await a.page.mouse.up()
    stroke = await newElement(a.page, 'freedraw', before)
    expect(((stroke as { points?: number[][] }).points ?? []).length).toBeGreaterThanOrEqual(6)
  })

  await test.step('Saved; bob holds all four; Ctrl+Z removes the stroke only', async () => {
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    for (const e of [rect, ellipse, line, stroke]) expect(await live(b.page, e.id)).toBe(true)
    await pressUndo(a.page)
    await expect.poll(() => live(a.page, stroke.id)).toBe(false)
    for (const e of [rect, ellipse, line]) expect(await live(a.page, e.id)).toBe(true)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    expect(await live(b.page, stroke.id)).toBe(false)
  })
})

test('the eraser (E): a stroke across a note removes it and its label for everyone, leaves its neighbour, and one Ctrl+Z brings it back', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const n1 = await settled(a.page, createNote(a.page, { x: 200, y: 200, text: 'erase me' }))
  const n2 = await settled(a.page, createNote(a.page, { x: 560, y: 200, text: 'keep me' }))
  await expectConverged(a.page, [b.page])
  const label = (
    (await item(a.page, n1)) as { boundElements?: { id: string; type: string }[] }
  ).boundElements?.find((e) => e.type === 'text')?.id as string
  expect(label).toBeTruthy()
  const bounds = (await itemBounds(a.page, n1)) as NonNullable<Awaited<ReturnType<typeof itemBounds>>>

  await focusBoard(a.page)
  await a.page.keyboard.press('e')
  await expect.poll(() => tool(a.page)).toBe('eraser')
  const midY = bounds.y + bounds.height / 2
  await dragScene(a.page, { x: bounds.x - 30, y: midY }, { x: bounds.x + bounds.width + 30, y: midY }, 12)

  await expect.poll(() => live(a.page, n1)).toBe(false)
  expect(await live(a.page, label)).toBe(false)
  expect(await live(a.page, n2)).toBe(true)
  await expectSaved(a.page)
  await expectConverged(a.page, [b.page])
  expect(await live(b.page, n1)).toBe(false)
  expect(await live(b.page, n2)).toBe(true)

  await a.page.keyboard.press('v')
  await expect.poll(() => tool(a.page)).toBe('select')
  await pressUndo(a.page)
  await expect.poll(() => live(a.page, n1)).toBe(true)
  expect(await live(a.page, label)).toBe(true)
  await expectSaved(a.page)
  await expectConverged(a.page, [b.page])
  expect(await live(b.page, n1)).toBe(true)
})

test('the frame tool (F): a drag around two notes makes a frame that adopts them and not the third; bob and the server agree; Ctrl+Z removes the frame and frees them', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const n1 = await settled(a.page, createNote(a.page, { x: 220, y: 220, text: 'in one' }))
  const n2 = await settled(a.page, createNote(a.page, { x: 470, y: 220, text: 'in two' }))
  const n3 = await settled(a.page, createNote(a.page, { x: 900, y: 220, text: 'outside' }))
  await expectConverged(a.page, [b.page])
  const frameOf = async (page: Page, id: string) =>
    ((await item(page, id)) as { frameId?: string | null })?.frameId ?? null

  await focusBoard(a.page)
  await a.page.keyboard.press('f')
  await expect.poll(() => tool(a.page)).toBe('frame')
  const before = await ids(a.page)
  await dragScene(a.page, { x: 160, y: 160 }, { x: 740, y: 480 })
  const frame = await newElement(a.page, 'frame', before)

  await test.step('the two notes inside are its children (labels too); the third is not', async () => {
    await expect.poll(() => frameOf(a.page, n1)).toBe(frame.id)
    await expect.poll(() => frameOf(a.page, n2)).toBe(frame.id)
    expect(await frameOf(a.page, n3)).toBeNull()
    // (the page's facade has no `children` verb yet: membership is read off every element's frameId)
    const children = (await items(a.page))
      .filter((e) => (e as { frameId?: string | null }).frameId === frame.id)
      .map((e) => e.id)
    expect(children).toEqual(expect.arrayContaining([n1, n2]))
    expect(children).not.toContain(n3)
    expect(children.length).toBe(4) // the two notes and their two labels
  })

  await test.step('Saved; bob and the server hold the same membership', async () => {
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    expect(await frameOf(b.page, n1)).toBe(frame.id)
    expect(await frameOf(b.page, n2)).toBe(frame.id)
    expect(await frameOf(b.page, n3)).toBeNull()
    const stored = (await serverSnapshot(stack, board)).elements as { id: string; frameId?: string | null }[]
    expect(stored.find((e) => e.id === n1)?.frameId).toBe(frame.id)
    expect(stored.find((e) => e.id === n2)?.frameId).toBe(frame.id)
    expect(stored.find((e) => e.id === n3)?.frameId ?? null).toBeNull()
  })

  await test.step('Ctrl+Z: the frame goes and the notes are loose again, for bob too', async () => {
    await a.page.keyboard.press('v')
    await pressUndo(a.page)
    await expect.poll(() => live(a.page, frame.id)).toBe(false)
    await expect.poll(() => frameOf(a.page, n1)).toBeNull()
    expect(await frameOf(a.page, n2)).toBeNull()
    expect(await live(a.page, n1)).toBe(true)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    expect(await frameOf(b.page, n1)).toBeNull()
    expect(await live(b.page, frame.id)).toBe(false)
  })
})
