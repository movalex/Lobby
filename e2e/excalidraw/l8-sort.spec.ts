// Wave L, W8 (L8-1): sort notes by colour, author, tag or votes into labelled columns, on the real board page
// against the real api and sync server. What must hold: 12 notes in 3 colours and 2 bound arrows become three
// labelled columns from the selection bar; the connectors' bound ends are where the server's own re-snap puts
// them while this tab pushed no arrow at all; one Ctrl+Z puts the notes back and takes the headings away;
// sorting twice leaves one set of headings; a note under another tab's lease is skipped and named in the notice,
// and the tab that only receives pushes nothing.
//
// The sort feature is registered by W3 (features/canvas-registry.ts); the preview over 10 moves is W2's
// showAiPreview, which the dev hook (window.__lobbySort) stands in for until W2's body is on the page.
//
//   E2E_PORT_BASE=7580 pnpm exec playwright test excalidraw/l8-sort --project=chromium --workers=1   (from e2e/)
import {
  type CanvasElement,
  expect,
  expectConverged,
  expectSaved,
  items,
  leaseHolder,
  pushedOps,
  select,
  setViewport,
  startTextEditing,
  stopTextEditing,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import {
  arrowOps,
  expectArrowsDerived,
  FILL,
  fakeAi,
  headings,
  makeArrow,
  makeFrame,
  makeNotes,
  opsSince,
  sortMenuState,
  sortRun,
  twelve,
  waitForSort,
  wordsOf,
} from './l8-kit.ts'
import { focusCanvas, undoKey } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const FRAME = { x: 0, y: 0, w: 2400, h: 1200 }

/** The twelve notes in a frame, two connectors between them; both tabs have them. */
async function retroBoard(
  a: { page: import('@playwright/test').Page },
  b?: { page: import('@playwright/test').Page },
) {
  const frame = await makeFrame(a.page, FRAME.x, FRAME.y, FRAME.w, FRAME.h, 'Retro')
  const ids = await makeNotes(a.page, twelve(60, 120), frame)
  const arrows = [
    await makeArrow(a.page, ids[0] as string, ids[5] as string),
    await makeArrow(a.page, ids[3] as string, ids[8] as string),
  ]
  await expectSaved(a.page)
  await expectArrowsDerived(a.page, arrows)
  if (b) {
    await waitForItem(b.page, arrows[1] as string, (e) => !!(e as { endBinding?: unknown }).endBinding)
    await expectConverged(a.page, [b.page])
  }
  return { frame, ids, arrows }
}

const positions = async (page: import('@playwright/test').Page, ids: readonly string[]) => {
  const all = new Map((await items(page)).map((e) => [e.id, e]))
  return Object.fromEntries(ids.map((id) => [id, [all.get(id)?.x, all.get(id)?.y, all.get(id)?.frameId]]))
}

test('L8-1: 12 notes in 3 colours become three labelled columns from the selection bar, in one undo step, with no arrow written by this tab', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  for (const s of [a, b]) await waitForSort(s.page)
  const { frame, ids, arrows } = await retroBoard(a, b)
  await fakeAi(a.page, { preview: 'apply' })
  const before = await positions(a.page, ids)
  const arrowBefore = await Promise.all(
    arrows.map(async (id) => (await items(a.page)).find((e) => e.id === id)),
  )
  const pushes = (await pushedOps(a.page)).length
  const bobPushes = (await pushedOps(b.page)).length

  await test.step('select the frame’s notes and pick Sort > By colour in the selection bar', async () => {
    await setViewport(a.page, { x: -200, y: -250, zoom: 0.5 })
    await select(a.page, ids)
    await focusCanvas(a.page)
    const button = a.page.getByTestId('selection-sort')
    await expect(button).toBeVisible()
    await button.click()
    await expect(a.page.getByTestId('sort-menu')).toBeVisible()
    expect(await sortMenuState(a.page)).toMatchObject({ view: 'menu' })
    // no vote has been revealed on this board: that way is there, and says why it cannot be used
    await expect(a.page.getByTestId('sort-by-votes')).toHaveAttribute('aria-disabled', 'true')
    await expect(a.page.getByTestId('sort-by-votes')).toContainText('Reveal a vote first')
    await a.page.getByTestId('sort-by-colour').click()
  })

  await test.step('three labelled columns, in the palette’s order, inside the frame', async () => {
    await expect.poll(async () => (await headings(a.page)).length).toBe(3)
    const heads = (await headings(a.page)).sort((p, q) => p.x - q.x)
    expect(heads.map(wordsOf)).toEqual(['Butter', 'Coral', 'Sky'])
    const all = new Map((await items(a.page)).map((e) => [e.id, e]))
    const colour: Record<string, number[]> = {
      Butter: [0, 3, 6, 9],
      Sky: [1, 4, 7, 10],
      Coral: [2, 5, 8, 11],
    }
    for (const h of heads) {
      const xs = new Set(colour[wordsOf(h)]?.map((i) => all.get(ids[i] as string)?.x))
      // one column: every note of the colour has the heading's x
      expect([...xs], wordsOf(h)).toEqual([h.x])
      expect(h.frameId).toBe(frame)
    }
    const f = all.get(frame) as CanvasElement
    for (const id of ids) {
      const n = all.get(id) as CanvasElement
      expect(n.frameId).toBe(frame)
      expect(n.x).toBeGreaterThanOrEqual(f.x)
      expect(n.x + n.width).toBeLessThanOrEqual(f.x + f.width)
      expect(n.y + n.height).toBeLessThanOrEqual(f.y + f.height)
    }
    await expect(a.page.getByTestId('sort-notice')).toContainText('12 notes in 3 columns')
    // the preview over 10 moves was shown (12 notes), then applied
    expect(
      await a.page.evaluate(
        () => (window as never as { __lobbySort: { previews(): unknown[] } }).__lobbySort.previews().length,
      ),
    ).toBe(1)
  })

  await test.step('the connectors are where the server’s re-snap puts them, and this tab pushed no arrow op', async () => {
    await expectSaved(a.page)
    await expectArrowsDerived(a.page, arrows)
    const moved = await Promise.all(arrows.map(async (id) => (await items(a.page)).find((e) => e.id === id)))
    expect(moved.map((m) => [m?.x, m?.y])).not.toEqual(arrowBefore.map((m) => [m?.x, m?.y]))
    const ops = await opsSince(a.page, pushes)
    expect(ops.length).toBeGreaterThan(0)
    expect(arrowOps(ops, arrows)).toEqual([])
    // it wrote notes (their position, and their labels') and the three headings
    expect(ops.filter((o) => o.k === 'c')).toHaveLength(3)
    // and bob, who only received, pushed nothing
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
    await expectConverged(a.page, [b.page])
  })

  await test.step('one Ctrl+Z puts every note back and takes the headings away', async () => {
    await undoKey(a.page)
    await expect.poll(async () => (await headings(a.page)).length).toBe(0)
    await expect.poll(async () => JSON.stringify(await positions(a.page, ids))).toBe(JSON.stringify(before))
    await expectSaved(a.page)
    await expectArrowsDerived(a.page, arrows)
    await expectConverged(a.page, [b.page])
    expect((await headings(b.page)).length).toBe(0)
  })
})

test('L8-1: sorting twice leaves no duplicate headings, and a second look at an already sorted board changes nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForSort(a.page)
  const { ids } = await retroBoard(a)
  await fakeAi(a.page, { preview: 'apply' })
  await select(a.page, ids)
  expect(await sortRun(a.page, 'sort.colour')).toBe(true)
  await expect
    .poll(async () => (await headings(a.page)).map(wordsOf).sort())
    .toEqual(['Butter', 'Coral', 'Sky'])
  await expectSaved(a.page)

  // by author: everything here was made by alice
  expect(await sortRun(a.page, 'sort.author')).toBe(true)
  await expect.poll(async () => (await headings(a.page)).map(wordsOf)).toEqual([a.name])
  await expectSaved(a.page)

  // by colour again: the author's heading is replaced, not kept under the new ones
  expect(await sortRun(a.page, 'sort.colour')).toBe(true)
  await expect
    .poll(async () => (await headings(a.page)).map(wordsOf).sort())
    .toEqual(['Butter', 'Coral', 'Sky'])
  await expectSaved(a.page)

  // and once more the same way: nothing to change, nothing written
  const pushes = (await pushedOps(a.page)).length
  expect(await sortRun(a.page, 'sort.colour')).toBe(true)
  await expect(a.page.getByTestId('sort-notice')).toContainText('already arranged')
  expect((await pushedOps(a.page)).length).toBe(pushes)
  expect(await headings(a.page)).toHaveLength(3)
})

test('L8-1: a note another tab is typing in is not moved, and the notice says 1 note was skipped; the tab that only receives pushes nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  for (const s of [a, b]) await waitForSort(s.page)
  const { ids } = await retroBoard(a, b)
  await fakeAi(a.page, { preview: 'apply' })
  const typed = ids[4] as string
  const all0 = await positions(a.page, ids)
  const before = all0[typed]

  await test.step('bob opens an editor on a note: alice sees the lease', async () => {
    await startTextEditing(b.page, typed)
    await expect.poll(async () => (await leaseHolder(a.page, typed))?.name).toBeTruthy()
  })
  const bobPushes = (await pushedOps(b.page)).length

  await test.step('alice sorts all twelve: eleven move, the one under the lease stays, and the notice counts it', async () => {
    await select(a.page, ids)
    expect(await sortRun(a.page, 'sort.colour')).toBe(true)
    await expect.poll(async () => (await headings(a.page)).length).toBe(3)
    await expect(a.page.getByTestId('sort-notice')).toContainText('1 note was skipped')
    await expect(a.page.getByTestId('sort-notice')).toContainText('someone is editing or moving it')
    expect((await positions(a.page, [typed]))[typed]).toEqual(before)
    const now = await positions(a.page, ids)
    // the other eleven are in new places
    expect(ids.filter((id) => JSON.stringify(now[id]) !== JSON.stringify(all0[id]))).toHaveLength(11)
  })

  await test.step('bob’s tab pushed nothing because of it, and the editor is still his', async () => {
    await expectSaved(a.page)
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
    expect((await leaseHolder(a.page, typed))?.name).toBeTruthy()
    await stopTextEditing(b.page)
    await expectConverged(a.page, [b.page])
  })
})

test('L8-1: a viewer has no Sort entry and the commands refuse', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('bob', { role: 'viewer' })
  for (const s of [a, v]) await waitForSort(s.page)
  const { ids } = await retroBoard(a, v)
  await select(v.page, ids)
  await expect(v.page.getByTestId('selection-sort')).toHaveCount(0)
  expect(await sortRun(v.page, 'sort.colour')).toBe(false)
  expect(await sortRun(v.page, 'sort.lens')).toBe(false)
  expect(await sortRun(v.page, 'sort.place')).toBe(false)
  expect((await pushedOps(v.page)).length).toBe(0)
  // the editor sees the entry
  await select(a.page, ids)
  await expect(a.page.getByTestId('selection-sort')).toBeVisible()
})

test('L8-1: the palette-style commands take the notes they are given, sort by a fixed key, and say when they cannot', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForSort(a.page)
  const frame = await makeFrame(a.page, 0, 0, 2000, 900, 'Few')
  const ids = await makeNotes(
    a.page,
    [
      { x: 60, y: 120, text: 'one', fill: FILL.sky },
      { x: 300, y: 120, text: 'two', fill: FILL.butter },
      { x: 540, y: 120, text: 'three', fill: FILL.sky },
    ],
    frame,
  )
  // nothing selected: the command is disabled, with its reason
  await select(a.page, [])
  expect(await sortRun(a.page, 'sort.colour')).toBe(false)
  // by votes with no revealed vote: disabled
  await select(a.page, ids)
  expect(await sortRun(a.page, 'sort.votes')).toBe(false)
  // three notes selected (no preview: three moves is not more than ten)
  await select(a.page, ids)
  expect(await sortRun(a.page, 'sort.colour')).toBe(true)
  await expect.poll(async () => (await headings(a.page)).map(wordsOf).sort()).toEqual(['Butter', 'Sky'])
  await expectSaved(a.page)
  expect(
    await a.page.evaluate(
      () => (window as never as { __lobbySort: { previews(): unknown[] } }).__lobbySort.previews().length,
    ),
  ).toBe(0)
})
