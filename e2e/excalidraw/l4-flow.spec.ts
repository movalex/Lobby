// L4-1 (wave L, W4): keyboard flow-building on the Excalidraw board page against the real api and sync server.
// Ctrl/Cmd+Arrow makes the next connected shape (a bound elbow connector the ROOM derives: the client pushes the
// connector's whole path unit once, at creation, and never an endpoint), its editor opens through the lease with
// no key lost, the other tab sees the same thing and pushes nothing; dragging the source re-snaps the connector
// in both tabs; Alt+Arrow walks the connection and the live region names it; a locked shape and a viewer get
// nothing; a + handle click works; the axe audit passes with the handles shown; the time to build a 10-step flow,
// keyboard against pointer, is recorded; Ctrl+Shift+Arrow repeats the last kind only while the flow is being
// built, and is a11y's (out of and into a frame) again once the selection moved.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l4-flow --project=chromium --workers=1
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { type ElementsById, resnapArrow } from '../../packages/canvas-schema/src/engine/index.ts'
import type { Op } from '../../packages/canvas-schema/src/protocol.ts'
import {
  type CanvasElement,
  createItem,
  editingId,
  expect,
  expectConverged,
  expectSaved,
  item,
  itemCenterOnScreen,
  items,
  itemText,
  pushedOps,
  saveState,
  select,
  setViewport,
  test,
  updateItem,
  waitForItem,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { announcer, focusCanvas, selected, waitForA11y } from './a11y-kit.ts'
import { settled } from './board-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const FILLED = { backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeColor: '#1971c2' }

type Arrow = CanvasElement & {
  points: [number, number][]
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
}

async function rect(page: Page, x: number, y: number): Promise<string> {
  return settled(page, createItem(page, 'rectangle', { x, y, width: 160, height: 80, ...FILLED }))
}

/** The live connectors from `from` (bound at the start) as `page` holds them. */
async function connectorsFrom(page: Page, from: string): Promise<Arrow[]> {
  return (await items(page)).filter(
    (e) => e.type === 'arrow' && (e as Arrow).startBinding?.elementId === from,
  ) as Arrow[]
}

/** The shape at the end of the one connector from `from`, once there is one with both ends bound. */
async function nextOf(page: Page, from: string): Promise<{ arrow: Arrow; shape: string }> {
  let out: { arrow: Arrow; shape: string } | null = null
  await expect
    .poll(async () => {
      const [a] = await connectorsFrom(page, from)
      const end = a?.endBinding?.elementId
      out = a && end ? { arrow: a, shape: end } : null
      return out !== null
    })
    .toBe(true)
  return out as unknown as { arrow: Arrow; shape: string }
}

/** Whether the stored connector is exactly what the room's re-snap derives from its bound shapes. */
function serverDerived(arrow: Arrow, all: readonly CanvasElement[]): boolean {
  const map = new Map(all.map((e) => [e.id, e])) as unknown as ElementsById
  return !resnapArrow(arrow as never, map).changed
}

/** Ops this tab pushed for `id`: creations, and patches with the groups they wrote. */
async function opsFor(page: Page, id: string): Promise<{ k: string; groups: string[] }[]> {
  const out: { k: string; groups: string[] }[] = []
  for (const rec of await pushedOps(page))
    for (const op of rec.ops as readonly Op[]) {
      if (op.k === 'c' ? op.el.id !== id : op.id !== id) continue
      out.push({
        k: op.k,
        groups:
          op.k === 'p'
            ? [...Object.keys(op.g ?? {}), ...(op.b ? ['bound'] : []), ...(op.c ? ['custom'] : [])]
            : [],
      })
    }
  return out
}

/** No patch of `arrow` this tab pushed wrote its `path` (geometry): only its creation carried it. */
async function expectNoEndpointPush(page: Page, arrow: string) {
  const ops = await opsFor(page, arrow)
  expect(ops.filter((o) => o.k === 'c')).toHaveLength(1)
  expect(ops.filter((o) => o.k === 'p' && o.groups.includes('path'))).toEqual([])
}

test('Ctrl+Right then typing at once: the shape, its words and a room-derived connector on both tabs; the receiving tab pushes nothing; dragging the source re-snaps it everywhere', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  for (const p of [a.page, b.page]) await setViewport(p, { x: -100, y: -200, zoom: 1 })
  const src = await rect(a.page, 100, 100)
  await expectConverged(a.page, [b.page])
  const bobPushes = (await pushedOps(b.page)).length

  let made = ''
  let arrowId = ''
  await test.step('alice presses Ctrl+Right and types "Review" straight away', async () => {
    await select(a.page, [src])
    await focusCanvas(a.page)
    await a.page.keyboard.press('ControlOrMeta+ArrowRight')
    await a.page.keyboard.type('Review')
    const next = await nextOf(a.page, src)
    made = next.shape
    arrowId = next.arrow.id
    await waitForTextEditor(a.page, made)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
    await expect.poll(() => itemText(a.page, made)).toBe('Review')
    // the next shape: the source's kind, style and size, to its right
    const shape = await item(a.page, made)
    expect(shape).toMatchObject({ type: 'rectangle', width: 160, height: 80, ...FILLED })
    expect((shape?.x ?? 0) > 260).toBe(true)
    await expectSaved(a.page)
  })

  await test.step('bob sees the shape, the words and a connector whose ends are the room’s re-snap', async () => {
    await waitForItem(b.page, made)
    await expect.poll(() => itemText(b.page, made)).toBe('Review')
    const arrow = (await waitForItem(
      b.page,
      arrowId,
      (e) => (e as Arrow).startBinding?.elementId === src && (e as Arrow).endBinding?.elementId === made,
    )) as Arrow
    expect(arrow.elbowed).toBe(true)
    await expectConverged(a.page, [b.page])
    expect(serverDerived((await item(b.page, arrowId)) as Arrow, await items(b.page))).toBe(true)
    expect(serverDerived((await item(a.page, arrowId)) as Arrow, await items(a.page))).toBe(true)
    // alice's push log: the connector's geometry only in its creation; bob pushed nothing at all
    await expectNoEndpointPush(a.page, arrowId)
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })

  await test.step('alice drags the source: both tabs hold the room’s re-snap of the connector', async () => {
    const before = (await item(b.page, arrowId)) as Arrow
    const c = await itemCenterOnScreen(a.page, src)
    await a.page.mouse.move(c.x, c.y)
    await a.page.mouse.down()
    await a.page.mouse.move(c.x - 40, c.y + 160, { steps: 8 })
    await a.page.mouse.up()
    await expectSaved(a.page)
    await expect
      .poll(async () => {
        const now = (await item(b.page, arrowId)) as Arrow
        return now.version !== before.version && serverDerived(now, await items(b.page))
      })
      .toBe(true)
    await expectConverged(a.page, [b.page])
    expect(serverDerived((await item(a.page, arrowId)) as Arrow, await items(a.page))).toBe(true)
    await expectNoEndpointPush(a.page, arrowId)
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })

  await test.step('one undo takes the shape and its connector back (the words were a step of their own)', async () => {
    await focusCanvas(a.page)
    await a.page.keyboard.press('ControlOrMeta+z') // the drag
    await a.page.keyboard.press('ControlOrMeta+z') // the words
    await a.page.keyboard.press('ControlOrMeta+z') // the shape and the connector
    await expect.poll(async () => (await items(a.page)).map((e) => e.id)).toEqual([src])
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })
})

test('Alt+Right walks the connection and the live region names it; Alt+Left comes back', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await setViewport(a.page, { x: -100, y: -200, zoom: 1 })
  const src = await rect(a.page, 100, 100)
  // an unconnected shape that comes next in reading order: the walk must skip it for the connected one
  await rect(a.page, 100, 400)
  await select(a.page, [src])
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+ArrowRight')
  const { shape } = await nextOf(a.page, src)
  await waitForTextEditor(a.page, shape)
  await a.page.keyboard.type('Review')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  await expectSaved(a.page)

  await select(a.page, [src])
  await focusCanvas(a.page)
  await expect(announcer(a.page)).toContainText('Rectangle, connected to Review')
  await a.page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => selected(a.page)).toEqual([shape])
  await expect(announcer(a.page)).toContainText('Rectangle: Review, connected to Rectangle')
  await a.page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(() => selected(a.page)).toEqual([src])
})

test('A locked shape and a viewer get nothing from Ctrl+Arrow, and no engine flowchart appears', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('victor', { role: 'viewer' })
  await setViewport(a.page, { x: -100, y: -200, zoom: 1 })
  const locked = await rect(a.page, 100, 100)
  await settled(a.page, updateItem(a.page, locked, { locked: true }))
  await select(a.page, [locked])
  await focusCanvas(a.page)
  for (const k of ['ArrowRight', 'ArrowDown', 'Shift+ArrowRight'])
    await a.page.keyboard.press(`ControlOrMeta+${k}`)
  await a.page.waitForTimeout(500)
  expect((await items(a.page)).map((e) => e.id)).toEqual([locked])

  const free = await rect(a.page, 600, 100)
  await waitForItem(v.page, free)
  await select(v.page, [free])
  await focusCanvas(v.page)
  const viewerPushes = (await pushedOps(v.page)).length
  for (const k of ['ArrowRight', 'ArrowDown']) await v.page.keyboard.press(`ControlOrMeta+${k}`)
  await v.page.waitForTimeout(500)
  expect((await items(v.page)).map((e) => e.id).sort()).toEqual([locked, free].sort())
  expect((await pushedOps(v.page)).length).toBe(viewerPushes)
  // and no + handles for the viewer
  const vc = await itemCenterOnScreen(v.page, free)
  await v.page.mouse.move(vc.x, vc.y)
  await v.page.waitForTimeout(300)
  await expect(v.page.getByTestId('flow-handles')).toHaveCount(0)
})

test('A + handle click makes the connected shape that way; dropping a dragged handle on a shape connects the two; the axe audit passes with the handles shown', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await setViewport(a.page, { x: -100, y: -200, zoom: 1 })
  const src = await rect(a.page, 100, 100)
  const other = await rect(a.page, 700, 500)
  const c = await itemCenterOnScreen(a.page, src)
  await a.page.mouse.move(c.x, c.y)
  await expect(a.page.getByTestId('flow-handles')).toBeVisible()
  await expect(a.page.getByTestId('flow-handles')).toHaveAttribute('data-flow-source', src)

  await test.step('axe: no violation with the handles on screen', async () => {
    const results = await new AxeBuilder({ page: a.page })
      .withTags(AXE_TAGS)
      .include('[data-testid="flow-handles"]')
      .analyze()
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([])
  })

  await test.step('click the bottom +: a shape below, connected, its editor open', async () => {
    await a.page.getByTestId('flow-handle-down').click()
    const { shape } = await nextOf(a.page, src)
    await waitForTextEditor(a.page, shape)
    await a.page.keyboard.type('Below')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => itemText(a.page, shape)).toBe('Below')
    const s = await item(a.page, shape)
    expect((s?.y ?? 0) > 180).toBe(true)
    await expectSaved(a.page)
  })

  await test.step('drag the right + onto the other shape: a connector between the two, nothing new', async () => {
    const count = (await items(a.page)).length
    await a.page.mouse.move(c.x, c.y)
    const h = await a.page.getByTestId('flow-handle-right').boundingBox()
    if (!h) throw new Error('no handle')
    const to = await itemCenterOnScreen(a.page, other)
    await a.page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await a.page.mouse.down()
    await a.page.mouse.move(to.x, to.y, { steps: 10 })
    await expect(a.page.getByTestId('flow-ghost')).toBeVisible()
    await a.page.mouse.up()
    await expect
      .poll(async () => (await connectorsFrom(a.page, src)).some((x) => x.endBinding?.elementId === other))
      .toBe(true)
    expect((await items(a.page)).length).toBe(count + 1)
    await expectSaved(a.page)
  })
})

test('Measured: building a 10-step flow, keyboard against pointer (+ handles)', async ({
  canvasSession,
}, testInfo) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  await setViewport(a.page, { x: -100, y: -300, zoom: 0.5 })
  const timings: Record<string, number> = {}

  const build = async (start: string, step: (cur: string) => Promise<void>) => {
    let cur = start
    const t0 = Date.now()
    for (let i = 0; i < 10; i++) {
      await step(cur)
      const { shape } = await nextOf(a.page, cur)
      await waitForTextEditor(a.page, shape)
      await a.page.keyboard.type(`Step ${i + 1}`)
      await a.page.keyboard.press('Escape')
      await expect.poll(() => editingId(a.page)).toBeNull()
      cur = shape
    }
    await expectSaved(a.page)
    return Date.now() - t0
  }

  const k0 = await rect(a.page, 0, 0)
  await select(a.page, [k0])
  await focusCanvas(a.page)
  timings.keyboardMs = await build(k0, async () => {
    await a.page.keyboard.press('ControlOrMeta+ArrowRight')
  })

  const p0 = await rect(a.page, 0, 600)
  timings.pointerMs = await build(p0, async (cur) => {
    const c = await itemCenterOnScreen(a.page, cur)
    await a.page.mouse.move(c.x, c.y)
    await expect(a.page.getByTestId('flow-handles')).toHaveAttribute('data-flow-source', cur)
    await a.page.getByTestId('flow-handle-right').click()
  })

  // 2 sources, 20 shapes, 20 connectors
  expect((await items(a.page)).filter((e) => e.type === 'arrow')).toHaveLength(20)
  testInfo.annotations.push({ type: 'l4-flow-10-steps', description: JSON.stringify(timings) })
  await testInfo.attach('l4-flow-10-steps.json', {
    body: JSON.stringify(timings, null, 2),
    contentType: 'application/json',
  })
  console.log(`[l4-flow] 10-step flow: keyboard ${timings.keyboardMs} ms, pointer ${timings.pointerMs} ms`)
})

test('Ctrl+Shift+Arrow repeats the last kind only while the flow is being built; in a frame, back on a shape the flow made, Ctrl+Shift+Up goes out to the frame', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await setViewport(a.page, { x: -100, y: -200, zoom: 1 })
  const frame = await settled(a.page, createItem(a.page, 'frame', { x: 0, y: 0, width: 420, height: 260 }))
  const src = await settled(
    a.page,
    createItem(a.page, 'diamond', { x: 40, y: 60, width: 160, height: 100, frameId: frame, ...FILLED }),
  )
  const other = await rect(a.page, 900, 600)
  await waitForItem(a.page, src, (e) => e.frameId === frame)

  let made = ''
  await test.step('Ctrl+Right, the words, Escape: then Ctrl+Shift+Down makes one more diamond below it', async () => {
    await select(a.page, [src])
    await focusCanvas(a.page)
    await a.page.keyboard.press('ControlOrMeta+ArrowRight')
    made = (await nextOf(a.page, src)).shape
    await waitForTextEditor(a.page, made)
    await a.page.keyboard.type('Plan')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
    await expect.poll(() => selected(a.page)).toEqual([made])
    expect((await item(a.page, made))?.frameId).toBe(frame)
    await a.page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
    const branch = (await nextOf(a.page, made)).shape
    await waitForTextEditor(a.page, branch)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
    const b = await item(a.page, branch)
    const m = await item(a.page, made)
    expect(b?.type).toBe('diamond')
    expect((b?.y ?? 0) > (m?.y ?? 0) + (m?.height ?? 0)).toBe(true)
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
  })

  await test.step('something else selected, then the shape the flow made again: Ctrl+Shift+Up is out to the frame, nothing made', async () => {
    await select(a.page, [other])
    await select(a.page, [made])
    await focusCanvas(a.page)
    const before = (await items(a.page)).length
    await a.page.keyboard.press('ControlOrMeta+Shift+ArrowUp')
    await expect.poll(() => selected(a.page)).toEqual([frame])
    await a.page.waitForTimeout(400)
    expect((await items(a.page)).length).toBe(before)
    expect(await editingId(a.page)).toBeNull()
    // and Ctrl+Shift+Down goes back in (a11y's), making nothing either
    await a.page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
    await expect.poll(async () => (await selected(a.page)).length).toBe(1)
    expect(await selected(a.page)).not.toEqual([frame])
    await a.page.waitForTimeout(400)
    expect((await items(a.page)).length).toBe(before)
  })
})
