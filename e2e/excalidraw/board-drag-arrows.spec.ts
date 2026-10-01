// D1 / W5-08 (docs/research/excalidraw/REVIEW-W5-EARLY.md §9, owner 2C): a connector bound to a box
// follows the box on the OTHER person's screen while it is dragged (DEMO 1:00), drawn only: nothing is
// written or pushed for it until the drag ends, when the server's re-snap arrives as usual.
import type { Page } from '@playwright/test'
import type { LobbyCanvas } from '../../apps/web/src/canvas/api/lobby-canvas.ts'
import {
  createItem,
  expect,
  expectSaved,
  item,
  itemCenterOnScreen,
  pushedOps,
  setViewport,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import { settled } from './board-kit.ts'

async function withCanvas<T, A>(page: Page, fn: (canvas: LobbyCanvas, arg: A) => T, arg: A): Promise<T> {
  return (await page.evaluate(
    ({ src, arg }) => {
      const b = (window as unknown as { __lobbyBoard?: { canvas: unknown } }).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      const f = new Function(`return (${src})`)() as (c: unknown, a: unknown) => unknown
      return f(b.canvas, arg)
    },
    { src: fn.toString(), arg },
  )) as T
}

/** A filled box: a press inside it hits it (a transparent one is hit on its outline only). */
const FILLED = { backgroundColor: '#a6d8f3', fillStyle: 'solid' }

/** The render override the engine has for `id` on `page` (the board's RenderOverrides, dev-auth builds). */
const override = (page: Page, id: string) =>
  page.evaluate(
    (x) =>
      (
        window as unknown as { __lobbyBoard: { overrides: { current(): ReadonlyMap<string, unknown> } } }
      ).__lobbyBoard.overrides
        .current()
        .get(x) ?? null,
    id,
  )
/** The ids of the arrows the drag-preview layer draws re-routed on `page`. */
const copies = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __lobbyBoard: { session: { presenceHub: { arrowPreviews(): { id: string }[] } } }
      }
    ).__lobbyBoard.session.presenceHub
      .arrowPreviews()
      .map((p) => p.id),
  )
/** The preview layer's drawn copy of `arrow` on `page`: its overlay box, or null. */
const preview = (page: Page, arrow: string) =>
  page.locator(`[data-testid="drag-arrow-previews"] [data-arrow-id="${arrow}"]`)

test('D1: while alice drags a box, bob sees the connector bound to it follow (drawn only), and the stored arrow is re-snapped at the end', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  for (const p of [a.page, b.page]) await setViewport(p, { x: 0, y: 0, zoom: 1 })
  const box = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 100, y: 200, width: 160, height: 100, ...FILLED }),
  )
  const story = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 600, y: 200, width: 160, height: 100, ...FILLED }),
  )
  const arrow = await settled(
    a.page,
    createItem(a.page, 'arrow', {
      x: 260,
      y: 250,
      width: 340,
      height: 0,
      points: [
        [0, 0],
        [340, 0],
      ],
    }),
  )
  await withCanvas(
    a.page,
    (c, ids) =>
      c.transact('bind', (tx) => {
        tx.bind(ids.arrow, 'start', ids.box)
        tx.bind(ids.arrow, 'end', ids.story)
      }),
    { arrow, box, story },
  )
  await expectSaved(a.page)
  await waitForItem(
    b.page,
    arrow,
    (e) => (e as { endBinding?: { elementId: string } | null }).endBinding?.elementId === story,
  )
  const stored = await item(b.page, arrow)
  const bobPushes = (await pushedOps(b.page)).length

  // alice drags Story down and holds it
  const c = await itemCenterOnScreen(a.page, story)
  await a.page.mouse.move(c.x, c.y)
  await a.page.mouse.down()
  await a.page.mouse.move(c.x + 20, c.y + 120, { steps: 6 })
  await a.page.mouse.move(c.x + 40, c.y + 240, { steps: 6 })
  // bob: the arrow is drawn re-routed (its end follows Story), the engine's own arrow is invisible
  await expect(preview(b.page, arrow)).toHaveCount(1, { timeout: 5_000 })
  // the drawn arrow reaches down towards Story's new place (it was a flat line at y 250)
  await expect.poll(async () => ((await preview(b.page, arrow).boundingBox())?.height ?? 0) > 150).toBe(true)
  await b.page.screenshot({ path: test.info().outputPath('bob-mid-drag.png') })
  expect(await copies(b.page)).toEqual([arrow])
  expect(await override(b.page, arrow)).toEqual({ opacity: 0 })
  // drawing only: bob's document copy of the arrow is unchanged, and bob pushed nothing
  expect((await item(b.page, arrow))?.version).toBe(stored?.version)
  expect((await pushedOps(b.page)).length).toBe(bobPushes)
  await a.page.mouse.up()
  // the drag ends: the drawn copy goes, and the stored arrow is the server's re-snap to Story's new place
  await expect(preview(b.page, arrow)).toHaveCount(0, { timeout: 10_000 })
  await expectSaved(a.page)
  await expect
    .poll(async () => {
      const el = (await item(b.page, arrow)) as { y: number; points: [number, number][] } | null
      const end = el ? el.y + (el.points.at(-1)?.[1] ?? 0) : 0
      return end > 400
    })
    .toBe(true)
  expect((await pushedOps(b.page)).length).toBe(bobPushes)
})

test('D1: dragging both ends of a connector moves it with them on the other screen (an offset, no drawn copy)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  for (const p of [a.page, b.page]) await setViewport(p, { x: 0, y: 0, zoom: 1 })
  const left = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 100, y: 200, width: 160, height: 100, ...FILLED }),
  )
  const right = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 600, y: 200, width: 160, height: 100, ...FILLED }),
  )
  const arrow = await settled(
    a.page,
    createItem(a.page, 'arrow', {
      x: 260,
      y: 250,
      width: 340,
      height: 0,
      points: [
        [0, 0],
        [340, 0],
      ],
    }),
  )
  await withCanvas(
    a.page,
    (c, ids) =>
      c.transact('bind', (tx) => {
        tx.bind(ids.arrow, 'start', ids.left)
        tx.bind(ids.arrow, 'end', ids.right)
      }),
    { arrow, left, right },
  )
  await expectSaved(a.page)
  await waitForItem(
    b.page,
    arrow,
    (e) => (e as { endBinding?: { elementId: string } | null }).endBinding?.elementId === right,
  )
  // alice selects both boxes (not the arrow) and drags them
  await withCanvas(a.page, (c, ids) => c.select(ids), [left, right])
  const c = await itemCenterOnScreen(a.page, left)
  await a.page.mouse.move(c.x, c.y)
  await a.page.mouse.down()
  await a.page.mouse.move(c.x, c.y + 150, { steps: 8 })
  // bob: the arrow moves by the boxes' offset (a render override of its own), with no drawn copy
  await expect
    .poll(async () => (await override(b.page, left)) as { offset?: { y: number } } | null, { timeout: 5_000 })
    .toMatchObject({ offset: { y: expect.any(Number) } })
  await expect
    .poll(async () => {
      const [ao, lo] = [await override(b.page, arrow), await override(b.page, left)]
      const y = (lo as { offset?: { y: number } } | null)?.offset?.y ?? 0
      return y > 50 && JSON.stringify(ao) === JSON.stringify(lo)
    })
    .toBe(true)
  expect(
    ((await override(b.page, arrow)) as { offset?: { y: number } } | null)?.offset?.y ?? 0,
  ).toBeGreaterThan(50)
  expect(await copies(b.page)).toEqual([])
  await a.page.mouse.up()
  await expectSaved(a.page)
})
