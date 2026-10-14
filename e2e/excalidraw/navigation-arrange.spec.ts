// 3b navigation on the Excalidraw board page: arrange as grid (MAK-18) and select by type / keep only
// (MAK-17), ported from canvas-ux-2.spec.ts. The selection bar, the context menu and the shortcuts dialog
// are 3a's shells: their entries run here through the page's registry (window.__lobbyNavigation), with
// the page's feature context; Alt+Shift+G is the real key. Images need an uploaded file on the new canvas
// (3g's upload path), so the select-by-type board holds notes, text, connectors, shapes and frames.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-arrange
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  expect,
  expectSaved,
  item,
  select,
  test,
  updateItem,
} from '../tests/support/canvas.ts'
import {
  bindArrow,
  boundsOf,
  contains,
  focusCanvas,
  group,
  navEntries,
  navMenu,
  navRun,
  navSelectionBar,
  overlaps,
  placements,
  seed,
  setFrame,
  sortedSelection,
  undoKey,
  waitForNavigation,
} from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const NOTE = 200
const GAP = 20

/** Three visual rows of three, deliberately untidy. Reading order = A B C / D E F / G H I. */
const SCATTER: [string, number, number][] = [
  ['A', 0, 0],
  ['B', 700, 40],
  ['C', 1500, -20],
  ['D', 100, 900],
  ['E', 800, 860],
  ['F', 1600, 940],
  ['G', -50, 1800],
  ['H', 900, 1760],
  ['I', 1700, 1820],
]

const anyOverlap = (list: { x: number; y: number; width: number; height: number }[]) =>
  list.some((a, i) => list.some((b, j) => j > i && overlaps(a, b)))

test('MAK-18 arrange as grid: nine scattered notes become a 3×3 grid in reading order at their top-left (bob sees it, the bound connector follows, one undo restores); Alt+Shift+G; the context menu; one note offers no grid', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForNavigation(a.page)
  const ids = (await seed(
    a.page,
    SCATTER.map(
      ([t, x, y]) =>
        () =>
          createNote(a.page, { x, y, text: t }),
    ),
  )) as string[]
  const arrow = await createItem(a.page, 'arrow', {
    x: 100,
    y: 100,
    points: [
      [0, 0],
      [800, 860],
    ],
    width: 800,
    height: 860,
  })
  await expectSaved(a.page)
  await bindArrow(a.page, arrow, ids[0] as string, ids[4] as string)
  const before = await placements(a.page, ids)

  /** The 3×3 grid expected from the scatter: top-left (-50, -20), 200 px notes, 20 px gaps. */
  const expectGrid = (p: Record<string, { x: number; y: number }>, columns = 3) => {
    ids.forEach((id, i) => {
      expect(p[id], id).toMatchObject({
        x: -50 + (i % columns) * (NOTE + GAP),
        y: -20 + Math.floor(i / columns) * (NOTE + GAP),
      })
    })
  }

  await test.step('the selection bar’s grid (the connector is selected too: it follows, it is not a cell)', async () => {
    await select(a.page, [...ids, arrow])
    expect(await navSelectionBar(a.page)).toContain('navigation.arrange-grid')
    expect(await navRun(a.page, 'navigation.arrange-grid')).toBe(true)
    await expect
      .poll(async () => (await placements(a.page, [ids[8] as string]))[ids[8] as string])
      .toMatchObject({
        x: -50 + 2 * (NOTE + GAP),
        y: -20 + 2 * (NOTE + GAP),
      })
    expectGrid(await placements(a.page, ids))
    const boxes = await Promise.all(ids.map((id) => boundsOf(a.page, [id])))
    expect(anyOverlap(boxes as never)).toBe(false)
    // still bound at both ends, so it follows the notes it connects (the server re-snaps it)
    const el = await item(a.page, arrow)
    expect([
      (el as { startBinding?: { elementId: string } }).startBinding?.elementId,
      (el as { endBinding?: { elementId: string } }).endBinding?.elementId,
    ]).toEqual([ids[0], ids[4]])
    expect(await sortedSelection(a.page)).toEqual([...ids, arrow].sort())
  })

  await test.step('bob sees the same grid within 2 s', async () => {
    const want = await placements(a.page, ids)
    await expect.poll(() => placements(b.page, ids), { timeout: 2_000 }).toEqual(want)
  })

  await test.step('one Ctrl+Z puts every note back, for alice and bob', async () => {
    await undoKey(a.page)
    await expect.poll(() => placements(a.page, ids)).toEqual(before)
    await expect.poll(() => placements(b.page, ids), { timeout: 2_000 }).toEqual(before)
  })

  await test.step('Alt+Shift+G arranges; one undo restores the scatter', async () => {
    await select(a.page, ids)
    await focusCanvas(a.page)
    await a.page.keyboard.press('Alt+Shift+G')
    await expect
      .poll(async () => (await placements(a.page, [ids[8] as string]))[ids[8] as string])
      .toMatchObject({ x: 390, y: 420 })
    expectGrid(await placements(a.page, ids))
    await undoKey(a.page)
    await expect.poll(() => placements(a.page, ids)).toEqual(before)
  })

  await test.step('the context menu’s Arrange as grid', async () => {
    await select(a.page, ids)
    expect((await navEntries(a.page, 'contextMenu')).map((e) => e.id)).toContain('navigation.arrange-grid')
    expect(await navMenu(a.page, 'contextMenu', 'navigation.arrange-grid')).toBe(true)
    await expect
      .poll(async () => (await placements(a.page, [ids[8] as string]))[ids[8] as string])
      .toMatchObject({ x: 390, y: 420 })
  })

  await test.step('with one note selected there is no grid entry (bar or menu)', async () => {
    await select(a.page, [ids[0] as string])
    expect(await navSelectionBar(a.page)).not.toContain('navigation.arrange-grid')
    expect((await navEntries(a.page, 'contextMenu')).map((e) => e.id)).not.toContain(
      'navigation.arrange-grid',
    )
  })
})

test('MAK-18 arrange as grid in frames: children stay inside their frame; a locked note stays put (and says so); a too-small frame grows (one undo); mixed frames land on the board; a group moves as one; a viewer gets no grid', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const F = await createItem(a.page, 'frame', { x: 0, y: 0, width: 1100, height: 800, name: 'Moodboard' })
  await expectSaved(a.page)
  const S = await createItem(a.page, 'frame', { x: 1400, y: 0, width: 300, height: 300, name: 'Tiny' })
  await expectSaved(a.page)
  const inside = (await seed(
    a.page,
    Array.from(
      { length: 6 },
      (_, i) => () =>
        createNote(a.page, {
          x: 40 + (i % 3) * 330 + (i % 2) * 17,
          y: 60 + Math.floor(i / 3) * 380,
          text: `${i}`,
        }),
    ),
  )) as string[]
  const locked = await createNote(a.page, { x: 800, y: 560, text: 'Pinned' })
  await expectSaved(a.page)
  await setFrame(a.page, [...inside, locked], F)
  await updateItem(a.page, locked, { locked: true })
  await expectSaved(a.page)
  const small = (await seed(
    a.page,
    Array.from(
      { length: 4 },
      (_, i) => () => createNote(a.page, { x: 1420 + i * 15, y: 30 + i * 10, text: `s${i}` }),
    ),
  )) as string[]
  await setFrame(a.page, small, S)
  const loose = await createNote(a.page, { x: 2000, y: 900, text: 'Loose' })
  await expectSaved(a.page)

  await test.step('six notes and a locked one in a frame: the six form a 3×2 grid inside it, the locked one stays', async () => {
    const lockedBefore = await placements(a.page, [locked])
    const frameBefore = await item(a.page, F)
    await select(a.page, [...inside, locked])
    expect(await navRun(a.page, 'navigation.arrange-grid')).toBe(true)
    await expect(a.page.getByTestId('arrange-grid-notice')).toContainText(
      'One locked object stayed where it was.',
    )
    const after = await placements(a.page, inside)
    for (const id of inside) expect(after[id]?.frameId).toBe(F)
    expect(new Set(Object.values(after).map((p) => p.x)).size).toBe(3)
    expect(new Set(Object.values(after).map((p) => p.y)).size).toBe(2)
    const fb = await boundsOf(a.page, [F])
    for (const id of inside) {
      const bx = await boundsOf(a.page, [id])
      expect(fb && bx && contains(fb, bx)).toBe(true)
    }
    expect(await placements(a.page, [locked])).toEqual(lockedBefore)
    const frameNow = await item(a.page, F)
    expect([frameNow?.width, frameNow?.height]).toEqual([frameBefore?.width, frameBefore?.height])
  })

  await test.step('four notes in a 300×300 frame: nothing fits, so the frame grows around the grid; one undo restores both', async () => {
    const before = await placements(a.page, small)
    await select(a.page, small)
    expect(await navRun(a.page, 'navigation.arrange-grid')).toBe(true)
    await expect(a.page.getByTestId('arrange-grid-notice')).toContainText('The frame grew to fit the grid.')
    const grown = await item(a.page, S)
    expect(grown?.width).toBeGreaterThan(300)
    expect(grown?.height).toBeGreaterThan(300)
    const after = await placements(a.page, small)
    for (const id of small) expect(after[id]?.frameId).toBe(S)
    const sb = await boundsOf(a.page, [S])
    for (const id of small) {
      const bx = await boundsOf(a.page, [id])
      expect(sb && bx && contains(sb, bx)).toBe(true)
    }
    await undoKey(a.page)
    await expect.poll(async () => (await item(a.page, S))?.width).toBe(300)
    expect(await placements(a.page, small)).toEqual(before)
  })

  await test.step('a note in the frame and one on the board: both end up on the board, side by side', async () => {
    const first = inside[0] as string
    await select(a.page, [first, loose])
    expect(await navRun(a.page, 'navigation.arrange-grid')).toBe(true)
    await expect.poll(async () => (await placements(a.page, [first]))[first]?.frameId).toBeNull()
    const p = await placements(a.page, [first, loose])
    expect(p[loose]?.frameId).toBeNull()
    expect(Math.round(p[first]?.y ?? 0)).toBe(Math.round(p[loose]?.y ?? 1))
    const [b1, b2] = [await boundsOf(a.page, [first]), await boundsOf(a.page, [loose])]
    expect(b1 && b2 && overlaps(b1, b2)).toBe(false)
  })

  await test.step('a grouped pair and a loose note: the whole group moves as one cell and stays a group', async () => {
    const pair = (await seed(a.page, [
      () => createNote(a.page, { x: 2600, y: 0, text: 'g1' }),
      () => createNote(a.page, { x: 2830, y: 40, text: 'g2' }),
    ])) as string[]
    const gid = await group(a.page, pair)
    const inGroup = await placements(a.page, pair)
    await select(a.page, [...pair, loose])
    expect(await navRun(a.page, 'navigation.arrange-grid')).toBe(true)
    await expect
      .poll(async () => {
        const p = await placements(a.page, pair)
        return Math.round((p[pair[1] as string]?.x ?? 0) - (p[pair[0] as string]?.x ?? 0))
      })
      .toBe(Math.round((inGroup[pair[1] as string]?.x ?? 0) - (inGroup[pair[0] as string]?.x ?? 0)))
    for (const id of pair) expect((await item(a.page, id))?.groupIds).toContain(gid)
    const [g, l] = [await boundsOf(a.page, pair), await boundsOf(a.page, [loose])]
    expect(g && l && overlaps(g, l)).toBe(false)
    // uniform cells, items centred: the taller group and the note share a centre line
    const mid = (x: { y: number; height: number } | null) => Math.round((x?.y ?? 0) + (x?.height ?? 0) / 2)
    expect(mid(g)).toBe(mid(l))
  })

  await test.step('a viewer can select but gets no grid entry or key', async () => {
    const c = await canvasSession('carol', { role: 'viewer' })
    await waitForNavigation(c.page)
    const before = await placements(c.page, small)
    await select(c.page, small)
    expect(await navSelectionBar(c.page)).not.toContain('navigation.arrange-grid')
    expect((await navEntries(c.page, 'contextMenu')).map((e) => e.id)).not.toContain(
      'navigation.arrange-grid',
    )
    await focusCanvas(c.page)
    await c.page.keyboard.press('Alt+Shift+G')
    expect(await navRun(c.page, 'navigation.arrange-grid')).toBe(false)
    await c.page.waitForTimeout(300)
    expect(await placements(c.page, small)).toEqual(before)
  })
})

const entryLabels = async (page: Page, prefix: string) =>
  (await navEntries(page, 'contextMenu')).filter((e) => e.id.startsWith(`${prefix}/`)).map((e) => e.label)

test('MAK-17 select by type: Select by type › Notes / Text / Connectors / Shapes / Frames (inside frames too, never locked); Keep only narrows a mixed selection, looking inside a selected frame; a viewer can use it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const F = await createItem(a.page, 'frame', { x: 900, y: 0, width: 700, height: 500, name: 'Refs' })
  await expectSaved(a.page)
  const notes = (await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: 'one' }),
    () => createNote(a.page, { x: 260, y: 0, text: 'two' }),
    () => createNote(a.page, { x: 940, y: 40, text: 'three' }),
  ])) as string[]
  await setFrame(a.page, [notes[2] as string], F)
  const lockedNote = await createNote(a.page, { x: 0, y: 300, text: 'locked' })
  await expectSaved(a.page)
  await updateItem(a.page, lockedNote, { locked: true })
  await expectSaved(a.page)
  const [text, a1, a2, box] = (await seed(a.page, [
    () => createItem(a.page, 'text', { x: 520, y: 20, text: 'Title' }),
    () =>
      createItem(a.page, 'arrow', {
        x: 0,
        y: 900,
        points: [
          [0, 0],
          [300, 0],
        ],
        width: 300,
        height: 0,
      }),
    () =>
      createItem(a.page, 'arrow', {
        x: 0,
        y: 980,
        points: [
          [0, 0],
          [300, 0],
        ],
        width: 300,
        height: 0,
      }),
    () => createItem(a.page, 'rectangle', { x: 1200, y: 300, width: 200, height: 120 }),
  ])) as string[]
  await setFrame(a.page, [box as string], F)

  await test.step('the submenu lists each type with its count (the locked note is not counted)', async () => {
    await select(a.page, [])
    expect(await entryLabels(a.page, 'navigation.select-all-type')).toEqual([
      'Notes (3)',
      'Text (1)',
      'Connectors (2)',
      'Shapes (1)',
      'Frames (1)',
    ])
  })

  await test.step('Notes selects the three unlocked notes, the one in the frame included', async () => {
    expect(
      await navMenu(a.page, 'contextMenu', 'navigation.select-all-type/navigation.select-all-notes'),
    ).toBe(true)
    expect(await sortedSelection(a.page)).toEqual([...notes].sort())
    await expect(a.page.getByTestId('select-by-type-notice')).toContainText('3 notes selected.')
  })

  await test.step('Text and Connectors', async () => {
    await navMenu(a.page, 'contextMenu', 'navigation.select-all-type/navigation.select-all-text')
    expect(await sortedSelection(a.page)).toEqual([text])
    await navMenu(a.page, 'contextMenu', 'navigation.select-all-type/navigation.select-all-connectors')
    expect(await sortedSelection(a.page)).toEqual([a1, a2].sort())
  })

  await test.step('Keep only: a note, a connector and the frame → Keep only › Notes keeps the notes, with the one inside the frame', async () => {
    await select(a.page, [notes[0] as string, a1 as string, F])
    expect(await entryLabels(a.page, 'navigation.keep-only')).toEqual([
      'Notes (2)',
      'Connectors (1)',
      'Shapes (1)',
      'Frames (1)',
    ])
    expect(await navMenu(a.page, 'contextMenu', 'navigation.keep-only/navigation.keep-only-notes')).toBe(true)
    expect(await sortedSelection(a.page)).toEqual([notes[0], notes[2]].sort())
  })

  await test.step('a selection of one type offers no Keep only; the frame alone offers what is inside it', async () => {
    await select(a.page, [notes[0] as string, notes[1] as string])
    expect((await navEntries(a.page, 'contextMenu')).map((e) => e.id)).not.toContain('navigation.keep-only')
    await select(a.page, [F])
    expect(await navMenu(a.page, 'contextMenu', 'navigation.keep-only/navigation.keep-only-shapes')).toBe(
      true,
    )
    expect(await sortedSelection(a.page)).toEqual([box])
  })

  await test.step('a viewer can select by type (selection is per person; nothing is written)', async () => {
    const c = await canvasSession('carol', { role: 'viewer' })
    await waitForNavigation(c.page)
    expect(
      await navMenu(c.page, 'contextMenu', 'navigation.select-all-type/navigation.select-all-notes'),
    ).toBe(true)
    expect(await sortedSelection(c.page)).toEqual([...notes].sort())
  })
})
