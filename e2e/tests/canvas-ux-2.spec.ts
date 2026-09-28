// canvas-ux, second wave: arrange as grid (MAK-18), select by type and "Keep only" (MAK-17), the board
// menu's "Hide note authors" (FAC-07 partial, RETRO-03a) and the owner-set start view (PRE-08). Every
// test drives the real UI (selection bar, context menu, board menu, keys) and checks the result in a
// second browser, and, for the board settings, that a read-only person's forged write never lands.
import type { Page } from '@playwright/test'
import { arrowBindings, getShape } from './support/board.ts'
import {
  openPath,
  shortcutRows,
  startView,
  storedCamera,
  waitForCanvasUx,
  waitForSaved,
  zoom,
} from './support/canvas-ux.ts'
import {
  anyOverlap,
  boxes,
  cameraOf,
  closeMenus,
  contextMenuAt,
  distinct,
  docMeta,
  editBd,
  hideAuthorsItem,
  near,
  openBoardMenu,
  openContextSubmenu,
  placements,
  readBd,
  selected,
} from './support/canvas-ux-2.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { downloadFrom } from './support/present-export.ts'
import { closeWorkshopPopover, openWorkshopPopover } from './support/workshops.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const note = (id: string, x: number, y: number, text = '', extra: Record<string, unknown> = {}) => ({
  id,
  type: 'note',
  x,
  y,
  props: { richText: richText(text) },
  ...extra,
})
const frame = (id: string, x: number, y: number, w: number, h: number, name: string) => ({
  id,
  type: 'frame',
  x,
  y,
  props: { w, h, name },
})

async function create(page: Page, shapes: Record<string, unknown>[]) {
  await editBd(
    page,
    (ed, list) => (ed as unknown as { createShapes(l: unknown[]): void }).createShapes(list),
    shapes,
  )
}
const focusBoard = (page: Page) => editBd(page, (ed) => (ed as unknown as { focus(): void }).focus())
const selectIds = (page: Page, ids: readonly string[]) =>
  editBd(page, (ed, list) => ed.select(...list), [...ids])
const undo = (page: Page) => page.keyboard.press('Control+z')

// ---- MAK-18 ------------------------------------------------------------------------------------------

// Three visual rows of three, deliberately untidy. Reading order = A B C / D E F / G H I.
const SCATTER: [string, number, number][] = [
  ['shape:g-a', 0, 0],
  ['shape:g-b', 700, 40],
  ['shape:g-c', 1500, -20],
  ['shape:g-d', 100, 900],
  ['shape:g-e', 800, 860],
  ['shape:g-f', 1600, 940],
  ['shape:g-g', -50, 1800],
  ['shape:g-h', 900, 1760],
  ['shape:g-i', 1700, 1820],
]
const GRID_NOTES = SCATTER.map(([id]) => id)
const ARROW = 'shape:g-arrow'

test('MAK-18 arrange as grid: nine scattered notes become a 3×3 grid in reading order at their top-left (bob sees it, the connector follows, one undo restores); Alt+Shift+G, the columns stepper, the context menu and the shortcuts dialog', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await waitForCanvasUx(a.page)
  await create(
    a.page,
    SCATTER.map(([id, x, y]) => note(id, x, y, id.slice(-1).toUpperCase())),
  )
  await editBd(
    a.page,
    (ed, arg) => {
      const e = ed as unknown as {
        createShape(p: unknown): void
        createBindings(p: unknown[]): void
      }
      e.createShape({
        id: arg.arrow,
        type: 'arrow',
        x: 0,
        y: 0,
        props: { start: { x: 100, y: 100 }, end: { x: 900, y: 960 } },
      })
      const bind = (terminal: string, toId: string) => ({
        id: `binding:g-arrow-${terminal}`,
        type: 'arrow',
        fromId: arg.arrow,
        toId,
        props: {
          terminal,
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
          snap: 'none',
        },
      })
      e.createBindings([bind('start', 'shape:g-a'), bind('end', 'shape:g-e')])
    },
    { arrow: ARROW },
  )
  await expect.poll(() => getShape(b.page, ARROW)).not.toBeNull()
  await editBd(a.page, (ed) => ed.zoomToFit())
  const before = await placements(a.page, GRID_NOTES)
  const arrowBefore = (await boxes(a.page, [ARROW]))[ARROW]

  /** The 3×3 grid expected from the scatter: top-left (-50, -20), 200 px notes, 20 px gaps. */
  const expectGrid = (p: Record<string, { x: number; y: number }>, columns = 3) => {
    GRID_NOTES.forEach((id, i) => {
      expect(p[id], id).toMatchObject({
        x: -50 + (i % columns) * 220,
        y: -20 + Math.floor(i / columns) * 220,
      })
    })
  }

  await test.step('the selection bar’s grid button (the connector is selected too: it follows, it is not a cell)', async () => {
    await selectIds(a.page, [...GRID_NOTES, ARROW])
    await expect(a.page.getByTestId('arrange-grid')).toBeVisible()
    await expect(a.page.getByTestId('arrange-grid')).toHaveAttribute('title', 'Arrange as grid (Alt+Shift+G)')
    await a.page.getByTestId('arrange-grid').click()
    const after = await placements(a.page, GRID_NOTES)
    expectGrid(after)
    expect(anyOverlap(Object.values(await boxes(a.page, GRID_NOTES)))).toBe(false)
    for (const id of GRID_NOTES) expect(after[id]?.parentId).toBe(before[id]?.parentId)
    // Still attached at both ends, so it follows the notes it connects.
    const ends = (await arrowBindings(a.page, ARROW)).map((x) => x.toId).sort()
    expect(ends).toEqual(['shape:g-a', 'shape:g-e'])
    const arrowNow = (await boxes(a.page, [ARROW]))[ARROW]
    expect(arrowNow).not.toEqual(arrowBefore)
    // The stepper shows the automatic count.
    await expect(a.page.getByTestId('grid-columns')).toHaveAttribute('data-columns', '3')
    expect(await selected(a.page)).toEqual([...GRID_NOTES, ARROW].sort())
  })

  await test.step('bob sees the same grid within 2 s', async () => {
    const want = await placements(a.page, GRID_NOTES)
    await expect.poll(() => placements(b.page, GRID_NOTES), { timeout: 2_000 }).toEqual(want)
  })

  await test.step('one Ctrl+Z puts every note back, for alice and bob', async () => {
    await focusBoard(a.page)
    await undo(a.page)
    await expect.poll(() => placements(a.page, GRID_NOTES)).toEqual(before)
    await expect.poll(() => placements(b.page, GRID_NOTES), { timeout: 2_000 }).toEqual(before)
  })

  await test.step('Alt+Shift+G arranges; the stepper makes 4 columns (its own undo step), then back to 3, then the scatter', async () => {
    await selectIds(a.page, GRID_NOTES)
    await focusBoard(a.page)
    await a.page.keyboard.press('Alt+Shift+G')
    await expect
      .poll(() => placements(a.page, GRID_NOTES).then((p) => p['shape:g-i']))
      .toMatchObject({
        x: 390,
        y: 420,
      })
    expectGrid(await placements(a.page, GRID_NOTES))
    const stepper = a.page.getByTestId('grid-columns')
    await expect(stepper).toHaveAttribute('data-columns', '3')
    await a.page.getByTestId('grid-columns-more').click()
    await expect(stepper).toHaveAttribute('data-columns', '4')
    await expect(stepper).toContainText('4 columns')
    const four = await placements(a.page, GRID_NOTES)
    // Same fill order, same top-left: A B C D / E F G H / I.
    expectGrid(four, 4)
    expect(distinct(Object.values(four).map((p) => p.x))).toHaveLength(4)
    await focusBoard(a.page)
    await undo(a.page)
    await expect.poll(() => placements(a.page, GRID_NOTES)).toEqual(await placementsOf3(a.page))
    await undo(a.page)
    await expect.poll(() => placements(a.page, GRID_NOTES)).toEqual(before)
  })

  await test.step('right-click the selection → Arrange as grid', async () => {
    await selectIds(a.page, GRID_NOTES)
    const e = await boxes(a.page, ['shape:g-e'])
    const box = e['shape:g-e']
    if (!box) throw new Error('no bounds')
    await contextMenuAt(a.page, { x: box.x + box.w / 2, y: box.y + box.h / 2 })
    await expect(a.page.getByTestId('context-menu.dr-arrange-grid')).toBeVisible()
    await a.page.getByTestId('context-menu.dr-arrange-grid').click()
    await expect
      .poll(() => placements(a.page, GRID_NOTES).then((p) => p['shape:g-i']))
      .toMatchObject({
        x: 390,
        y: 420,
      })
    expectGrid(await placements(a.page, GRID_NOTES))
  })

  await test.step('the shortcuts dialog lists it; with one note selected there is no grid entry', async () => {
    await selectIds(a.page, ['shape:g-a'])
    await expect(a.page.getByTestId('selection-bar')).toBeVisible()
    await expect(a.page.getByTestId('arrange-grid')).toHaveCount(0)
    await focusBoard(a.page)
    await a.page.keyboard.press('Control+Alt+/')
    await expect(a.page.locator('.tlui-shortcuts-dialog__body')).toBeVisible()
    const rows = await shortcutRows(a.page)
    expect(rows.find((r) => r.label === 'Arrange as grid')?.kbd).toBe('Alt+⇧+G')
    await a.page.keyboard.press('Escape')
  })

  /** The 3-column layout of the scatter, as placements (parent unchanged). */
  async function placementsOf3(page: Page) {
    const p = await placements(page, GRID_NOTES)
    const out: typeof p = {}
    GRID_NOTES.forEach((id, i) => {
      out[id] = {
        x: -50 + (i % 3) * 220,
        y: -20 + Math.floor(i / 3) * 220,
        parentId: p[id]?.parentId ?? '',
      }
    })
    return out
  }
})

test('MAK-18 arrange as grid in frames: children stay inside their frame; a locked note stays put (and says so); a too-small frame grows (one undo); mixed parents land on the page; a viewer gets no grid', async ({
  session,
}) => {
  const a = await session('alice')
  const F = 'shape:gf-frame'
  const INSIDE = ['shape:gf-1', 'shape:gf-2', 'shape:gf-3', 'shape:gf-4', 'shape:gf-5', 'shape:gf-6']
  const LOCKED = 'shape:gf-locked'
  const S = 'shape:gf-small'
  const SMALL = ['shape:gs-1', 'shape:gs-2', 'shape:gs-3', 'shape:gs-4']
  const LOOSE = 'shape:gm-loose'
  await waitForCanvasUx(a.page)
  await create(a.page, [frame(F, 0, 0, 1100, 800, 'Moodboard'), frame(S, 1400, 0, 300, 300, 'Tiny')])
  await create(a.page, [
    ...INSIDE.map((id, i) =>
      note(id, 40 + (i % 3) * 330 + (i % 2) * 17, 60 + Math.floor(i / 3) * 380, `${i}`, { parentId: F }),
    ),
    note(LOCKED, 800, 560, 'Pinned', { parentId: F, isLocked: true }),
    ...SMALL.map((id, i) => note(id, 20 + i * 15, 30 + i * 10, `s${i}`, { parentId: S })),
    note(LOOSE, 2000, 900, 'Loose'),
  ])
  await editBd(a.page, (ed) => ed.zoomToFit())

  await test.step('six notes and a locked one in a frame: the six form a 3×2 grid inside it, the locked one stays', async () => {
    const lockedBefore = await placements(a.page, [LOCKED])
    const frameBefore = await getShape(a.page, F)
    await selectIds(a.page, [...INSIDE, LOCKED])
    await a.page.getByTestId('arrange-grid').click()
    await expect(a.page.getByTestId('arrange-grid-notice')).toContainText(
      'One locked object stayed where it was.',
    )
    const after = await placements(a.page, INSIDE)
    for (const id of INSIDE) expect(after[id]?.parentId).toBe(F)
    expect(distinct(Object.values(after).map((p) => p.x))).toHaveLength(3)
    expect(distinct(Object.values(after).map((p) => p.y))).toHaveLength(2)
    const fb = (await boxes(a.page, [F]))[F]
    for (const bx of Object.values(await boxes(a.page, INSIDE))) {
      expect(bx.x).toBeGreaterThanOrEqual((fb?.x ?? 0) - 0.5)
      expect(bx.y).toBeGreaterThanOrEqual((fb?.y ?? 0) - 0.5)
      expect(bx.x + bx.w).toBeLessThanOrEqual((fb?.x ?? 0) + (fb?.w ?? 0) + 0.5)
      expect(bx.y + bx.h).toBeLessThanOrEqual((fb?.y ?? 0) + (fb?.h ?? 0) + 0.5)
    }
    expect(await placements(a.page, [LOCKED])).toEqual(lockedBefore)
    expect((await getShape(a.page, F))?.props).toEqual(frameBefore?.props)
  })

  await test.step('four notes in a 300×300 frame: nothing fits, so the frame grows around the grid; one undo restores both', async () => {
    const before = await placements(a.page, SMALL)
    await selectIds(a.page, SMALL)
    await a.page.getByTestId('arrange-grid').click()
    await expect(a.page.getByTestId('arrange-grid-notice')).toContainText('The frame grew to fit the grid.')
    const grown = (await getShape(a.page, S))?.props as { w: number; h: number }
    expect(grown.w).toBeGreaterThan(300)
    expect(grown.h).toBeGreaterThan(300)
    const after = await placements(a.page, SMALL)
    for (const id of SMALL) expect(after[id]?.parentId).toBe(S)
    const sb = (await boxes(a.page, [S]))[S]
    for (const bx of Object.values(await boxes(a.page, SMALL))) {
      expect(bx.x + bx.w).toBeLessThanOrEqual((sb?.x ?? 0) + (sb?.w ?? 0) + 0.5)
      expect(bx.y + bx.h).toBeLessThanOrEqual((sb?.y ?? 0) + (sb?.h ?? 0) + 0.5)
    }
    await focusBoard(a.page)
    await undo(a.page)
    await expect.poll(() => getShape(a.page, S).then((s) => s?.props.w)).toBe(300)
    expect(await placements(a.page, SMALL)).toEqual(before)
  })

  await test.step('a note in the frame and one on the page: both end up on the page, side by side', async () => {
    await selectIds(a.page, [INSIDE[0] as string, LOOSE])
    await a.page.getByTestId('arrange-grid').click()
    const p = await placements(a.page, [INSIDE[0] as string, LOOSE])
    const pageId = await readBd(a.page, (ed) => ed.getCurrentPageId())
    expect(p[INSIDE[0] as string]?.parentId).toBe(pageId)
    expect(p[LOOSE]?.parentId).toBe(pageId)
    const bx = await boxes(a.page, [INSIDE[0] as string, LOOSE])
    expect(Math.round(bx[INSIDE[0] as string]?.y ?? 0)).toBe(Math.round(bx[LOOSE]?.y ?? 1))
    expect(anyOverlap(Object.values(bx))).toBe(false)
  })

  await test.step('a note inside a group and a loose note: the whole group moves as one cell and stays a group', async () => {
    const G = 'shape:gg-group'
    const IN_GROUP = ['shape:gg-1', 'shape:gg-2']
    await create(a.page, [
      note(IN_GROUP[0] as string, 2600, 0, 'g1'),
      note(IN_GROUP[1] as string, 2830, 40, 'g2'),
    ])
    await editBd(
      a.page,
      (ed, arg) =>
        (ed as unknown as { groupShapes(ids: string[], o: unknown): void }).groupShapes(arg.ids, {
          groupId: arg.g,
          select: false,
        }),
      { ids: IN_GROUP, g: G },
    )
    const inside = await placements(a.page, IN_GROUP)
    await selectIds(a.page, [IN_GROUP[0] as string, LOOSE])
    await a.page.getByTestId('arrange-grid').click()
    const after = await placements(a.page, [...IN_GROUP, G])
    expect(after[IN_GROUP[0] as string]?.parentId).toBe(G)
    expect(after[IN_GROUP[1] as string]?.parentId).toBe(G)
    // Children keep their places inside the group (the group itself moved).
    for (const id of IN_GROUP) {
      expect({ x: after[id]?.x, y: after[id]?.y }).toEqual({ x: inside[id]?.x, y: inside[id]?.y })
    }
    const bx = await boxes(a.page, [G, LOOSE])
    expect(anyOverlap(Object.values(bx))).toBe(false)
    expect(Math.round(bx[G]?.y ?? 0)).toBe(Math.round(bx[LOOSE]?.y ?? 1))
  })

  await test.step('a viewer can select but gets no grid button, menu entry or key', async () => {
    await waitForSaved(a.page)
    const c = await session('carol', { role: 'viewer' })
    await waitForCanvasUx(c.page)
    const before = await placements(c.page, SMALL)
    await selectIds(c.page, SMALL)
    await expect(c.page.getByTestId('selection-bar')).toBeVisible()
    await expect(c.page.getByTestId('arrange-grid')).toHaveCount(0)
    await focusBoard(c.page)
    await c.page.keyboard.press('Alt+Shift+G')
    const sb = (await boxes(c.page, [SMALL[0] as string]))[SMALL[0] as string]
    await contextMenuAt(c.page, { x: (sb?.x ?? 0) + 20, y: (sb?.y ?? 0) + 20 })
    await expect(c.page.getByTestId('context-menu.dr-arrange-grid')).toHaveCount(0)
    await closeMenus(c.page)
    expect(await placements(c.page, SMALL)).toEqual(before)
  })
})

// ---- MAK-17 ------------------------------------------------------------------------------------------

test('MAK-17 select by type: right-click → Select all on this page › Notes / Images / Text / Connectors (inside frames too, never locked); Keep only narrows a mixed selection, looking inside a selected frame; a viewer can use it', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const F = 'shape:st-frame'
  const NOTES = ['shape:st-n1', 'shape:st-n2', 'shape:st-n3']
  const IMAGES = ['shape:st-i1', 'shape:st-i2']
  const TEXT = 'shape:st-t1'
  const ARROWS = ['shape:st-a1', 'shape:st-a2']
  await create(a.page, [frame(F, 900, 0, 700, 500, 'Refs')])
  await create(
    a.page,
    [
      note(NOTES[0] as string, 0, 0, 'one'),
      note(NOTES[1] as string, 260, 0, 'two'),
      note(NOTES[2] as string, 40, 40, 'three', { parentId: F }),
      note('shape:st-locked', 0, 300, 'locked', { isLocked: true }),
      ...IMAGES.map((id, i) => ({
        id,
        type: 'image',
        x: i === 0 ? 300 : 0,
        y: i === 0 ? 60 : 600,
        parentId: i === 0 ? F : undefined,
        props: { w: 240, h: 160, assetId: null },
      })),
      { id: TEXT, type: 'text', x: 520, y: 20, props: { richText: richText('Title') } },
      ...ARROWS.map((id, i) => ({
        id,
        type: 'arrow',
        x: 0,
        y: 900 + i * 80,
        props: { start: { x: 0, y: 0 }, end: { x: 300, y: 0 } },
      })),
    ].map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))),
  )
  await editBd(a.page, (ed) => ed.zoomToFit())
  const empty = { x: 700, y: 700 } // no shape there, inside the fitted view

  const selectAll = async (page: Page, label: RegExp) => {
    await contextMenuAt(page, empty)
    const sub = await openContextSubmenu(page, 'dr-select-all-type')
    await sub.getByRole('menuitem', { name: label }).click()
    await expect(page.getByTestId('context-menu')).toHaveCount(0)
  }

  await test.step('the submenu lists each type with its count (the locked note is not counted)', async () => {
    await contextMenuAt(a.page, empty)
    const sub = await openContextSubmenu(a.page, 'dr-select-all-type')
    const labels = await sub.getByRole('menuitem').allInnerTexts()
    expect(labels.map((l) => l.trim())).toEqual([
      'Notes (3)',
      'Images (2)',
      'Text (1)',
      'Connectors (2)',
      'Frames (1)',
    ])
    await closeMenus(a.page)
  })

  await test.step('Notes selects the three unlocked notes, the one in the frame included', async () => {
    await selectAll(a.page, /^Notes/)
    expect(await selected(a.page)).toEqual([...NOTES].sort())
    await expect(a.page.getByTestId('select-by-type-notice')).toContainText('3 notes selected.')
  })

  await test.step('Images, Text and Connectors', async () => {
    await selectAll(a.page, /^Images/)
    expect(await selected(a.page)).toEqual([...IMAGES].sort())
    await selectAll(a.page, /^Text/)
    expect(await selected(a.page)).toEqual([TEXT])
    await selectAll(a.page, /^Connectors/)
    expect(await selected(a.page)).toEqual([...ARROWS].sort())
  })

  await test.step('Keep only: a note, an image, a connector and the frame → Keep only › Notes keeps the notes, with the one inside the frame', async () => {
    await selectIds(a.page, [NOTES[0] as string, IMAGES[1] as string, ARROWS[0] as string, F])
    const n1 = (await boxes(a.page, [NOTES[0] as string]))[NOTES[0] as string]
    await contextMenuAt(a.page, { x: (n1?.x ?? 0) + 100, y: (n1?.y ?? 0) + 100 })
    const sub = await openContextSubmenu(a.page, 'dr-keep-only')
    const labels = (await sub.getByRole('menuitem').allInnerTexts()).map((l) => l.trim())
    // Frames (1) too: keeping only the frame drops the note, the image and the connector.
    expect(labels).toEqual(['Notes (2)', 'Images (2)', 'Connectors (1)', 'Frames (1)'])
    await sub.getByRole('menuitem', { name: /^Notes/ }).click()
    expect(await selected(a.page)).toEqual([NOTES[0] as string, NOTES[2] as string].sort())
  })

  await test.step('a selection of one type offers no Keep only; the frame alone offers what is inside it', async () => {
    await selectIds(a.page, [NOTES[0] as string, NOTES[1] as string])
    const n1 = (await boxes(a.page, [NOTES[0] as string]))[NOTES[0] as string]
    await contextMenuAt(a.page, { x: (n1?.x ?? 0) + 100, y: (n1?.y ?? 0) + 100 })
    await expect(a.page.getByTestId('context-menu-sub.dr-keep-only-button')).toHaveCount(0)
    await closeMenus(a.page)
    await selectIds(a.page, [F])
    const fb = (await boxes(a.page, [F]))[F]
    await contextMenuAt(a.page, { x: (fb?.x ?? 0) + 650, y: (fb?.y ?? 0) + 450 })
    const sub = await openContextSubmenu(a.page, 'dr-keep-only')
    await sub.getByRole('menuitem', { name: /^Images/ }).click()
    expect(await selected(a.page)).toEqual([IMAGES[0] as string])
  })

  await test.step('a viewer can select by type (selection is per person; nothing is written)', async () => {
    await waitForSaved(a.page)
    const c = await session('carol', { role: 'viewer' })
    await waitForCanvasUx(c.page)
    await editBd(c.page, (ed) => ed.zoomToFit())
    await selectAll(c.page, /^Notes/)
    expect(await selected(c.page)).toEqual([...NOTES].sort())
  })
})

// ---- FAC-07 partial: "Hide note authors" in the board menu ------------------------------------------

test('FAC-07 (partial) Hide note authors from the board menu: bob’s labels vanish within 2 s, in Present and in his SVG export; it is the workshop popover’s setting; the copy says it is not anonymity; a viewer sees it disabled and cannot forge it', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  const N = 'shape:ha-note'
  const F = 'shape:ha-frame'
  await waitForCanvasUx(a.page)
  await create(a.page, [frame(F, -40, -40, 600, 320, 'Retro')])
  await editBd(
    a.page,
    (ed, arg) =>
      (ed as unknown as { createShape(p: unknown): void }).createShape({
        id: arg.id,
        type: 'note',
        x: 0,
        y: 0,
        parentId: arg.frame,
        props: { richText: arg.rich, textLastEditedBy: arg.uid },
      }),
    { id: N, frame: F, rich: richText('Our deploys are scary'), uid: a.id },
  )
  await expect.poll(() => getShape(b.page, N)).not.toBeNull()
  for (const s of [a, b]) await editBd(s.page, (ed) => ed.zoomToFit())
  const label = (page: Page) => page.locator('.tl-note__attribution')
  await expect(label(b.page)).toBeVisible()

  await test.step('alice: Board menu → Hide note authors; the notice is honest about what it does', async () => {
    await openBoardMenu(a.page)
    const item = hideAuthorsItem(a.page)
    await expect(item).toHaveAttribute('aria-checked', 'false')
    await item.click()
    await expect(item).toHaveAttribute('aria-checked', 'true')
    await closeMenus(a.page)
    const notice = a.page.getByTestId('board-setting-notice')
    await expect(notice).toContainText('on the board, in Present and in exports')
    await expect(notice).toContainText(
      'This is not anonymity: the board still records who last edited each note.',
    )
  })

  await test.step('bob: no label within 2 s; his workshop popover and board menu show the same setting on', async () => {
    await expect(label(b.page)).toBeHidden({ timeout: 2_000 })
    const pop = await openWorkshopPopover(b.page)
    await expect(pop.getByTestId('session-hide-authors')).toBeChecked()
    await closeWorkshopPopover(b.page)
    await openBoardMenu(b.page)
    await expect(hideAuthorsItem(b.page)).toHaveAttribute('aria-checked', 'true')
    await closeMenus(b.page)
    // The author id is still in the board data (the copy says so).
    expect((await getShape(b.page, N))?.props.textLastEditedBy).toBe(a.id)
  })

  await test.step('bob presents: no label on the slide; his SVG export carries none', async () => {
    await b.page.getByTestId('present-button').click()
    await expect(b.page.getByTestId('present-overlay')).toBeVisible()
    await expect(label(b.page)).toBeHidden()
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByTestId('present-overlay')).toHaveCount(0)
    await b.page.getByTestId('export-button').click()
    const dialog = b.page.getByTestId('export-dialog')
    await dialog.getByTestId('export-area-board').check()
    const svg = (await downloadFrom(b.page, () => dialog.getByTestId('export-svg').click())).bytes.toString(
      'utf8',
    )
    expect(svg).toContain('Our deploys are scary')
    expect(svg).not.toContain('tl-note__attribution')
    await b.page.keyboard.press('Escape')
  })

  await test.step('carol (viewer): no label; the board menu shows the setting, disabled; a forged write never lands', async () => {
    await waitForSaved(a.page)
    const c = await session('carol', { role: 'viewer' })
    await waitForCanvasUx(c.page)
    await expect.poll(() => getShape(c.page, N)).not.toBeNull()
    await expect(label(c.page)).toBeHidden()
    await openBoardMenu(c.page)
    const item = hideAuthorsItem(c.page)
    await expect(item).toHaveAttribute('aria-checked', 'true')
    await expect(item).toHaveAttribute('aria-disabled', 'true')
    await expect(c.page.getByTestId('main-menu.dr-set-start-view')).toHaveCount(0)
    await closeMenus(c.page)
    // Forge: switch the UI-only read-only flag off and write the document meta directly.
    await editBd(c.page, (ed) => {
      ;(ed as unknown as { updateInstanceState(p: unknown): void }).updateInstanceState({ isReadonly: false })
      const meta = ed.getDocumentSettings().meta
      ed.updateDocumentSettings({
        meta: { ...meta, drWorkshop: { hideNoteAuthors: false, hideCursors: false } },
      })
    })
    // The server refuses the read-only session's push: carol's copy is rolled back, alice never sees it.
    await expect
      .poll(() =>
        docMeta(c.page).then((m) => (m.drWorkshop as { hideNoteAuthors?: boolean })?.hideNoteAuthors),
      )
      .toBe(true)
    await a.page.waitForTimeout(1_000)
    expect(((await docMeta(a.page)).drWorkshop as { hideNoteAuthors?: boolean }).hideNoteAuthors).toBe(true)
    await expect(label(b.page)).toBeHidden()
  })

  await test.step('bob switches it off in the workshop popover: alice’s board menu follows; labels return', async () => {
    const pop = await openWorkshopPopover(b.page)
    await pop.getByTestId('session-hide-authors').uncheck()
    await closeWorkshopPopover(b.page)
    await expect(label(a.page)).toBeVisible({ timeout: 2_000 })
    await openBoardMenu(a.page)
    await expect(hideAuthorsItem(a.page)).toHaveAttribute('aria-checked', 'false')
    await closeMenus(a.page)
  })
})

// ---- PRE-08: owner-set start view --------------------------------------------------------------------

test('PRE-08 start view: alice saves her view; first visits land exactly there, a returning person keeps their own view, Go to start view returns to it; a frame can be the start view; clear falls back to fit; a viewer can go but not set or forge it', async ({
  session,
  browser,
  board,
  users,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const CORNERS = ['shape:sv2-nw', 'shape:sv2-ne', 'shape:sv2-sw', 'shape:sv2-se']
  const INTRO = 'shape:sv2-intro'
  await create(a.page, [
    note(CORNERS[0] as string, 0, 0, 'North west'),
    note(CORNERS[1] as string, 2600, 0, 'North east'),
    note(CORNERS[2] as string, 0, 1900, 'South west'),
    note(CORNERS[3] as string, 2600, 1900, 'South east'),
    frame(INTRO, 1100, 700, 500, 400, 'Start here'),
  ])
  const cam = { x: -2300, y: 80, z: 0.9 }
  await editBd(a.page, (ed, c) => ed.setCamera(c, { immediate: true }), cam)

  await test.step('alice: Board menu → Set current view as start view (stored in the document, not her browser)', async () => {
    await openBoardMenu(a.page)
    await a.page.getByTestId('main-menu.dr-set-start-view').click()
    await expect(a.page.getByTestId('board-setting-notice')).toContainText('Start view set.')
    const view = (await docMeta(a.page)).drStartView as Record<string, number | string>
    const vp = await readBd(a.page, (ed) => {
      const b = ed.getViewportPageBounds()
      return { x: b.x, y: b.y, w: b.w, h: b.h }
    })
    expect(view).toMatchObject({ pageId: await readBd(a.page, (ed) => ed.getCurrentPageId()) })
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(view[k] as number).toBeCloseTo(vp[k], 3)
    await waitForSaved(a.page)
  })

  const firstVisit = async (handle: string, role: 'editor' | 'viewer') => {
    await users.grant(board, handle, role)
    return openPath(browser, await users.get(handle), `/b/${board}`)
  }

  await test.step('bob’s first visit lands on alice’s view (same screen: same camera)', async () => {
    const b = await firstVisit('bob', 'editor')
    try {
      expect(await startView(b.page)).toBe('start-view')
      // The dock rail narrows the canvas right after it opens; the start area is kept through that.
      await expect.poll(async () => near(await cameraOf(b.page), cam)).toBe(true)

      // He wanders off; a reload brings back HIS view (PRE-06), not the start view.
      const away = { x: -900, y: -1500, z: 0.6 }
      await editBd(b.page, (ed, c) => ed.setCamera(c, { immediate: true }), away)
      const bob = await users.get('bob')
      await expect.poll(() => storedCamera(b.page, board, bob.id)).toMatchObject(away)
      await b.page.reload()
      await waitForCanvasUx(b.page)
      expect(await startView(b.page)).toBe('restore')
      expect(near(await cameraOf(b.page), away)).toBe(true)

      // Board menu → Go to start view.
      await openBoardMenu(b.page)
      await b.page.getByTestId('main-menu.dr-go-to-start-view').click()
      await expect.poll(async () => near(await cameraOf(b.page), cam)).toBe(true)
    } finally {
      await b.context.close()
    }
  })

  await test.step('a viewer’s first visit lands there too; she can go to it, not set it, and a forged write never lands', async () => {
    const c = await firstVisit('carol', 'viewer')
    try {
      expect(await startView(c.page)).toBe('start-view')
      await expect.poll(async () => near(await cameraOf(c.page), cam)).toBe(true)
      await openBoardMenu(c.page)
      await expect(c.page.getByTestId('main-menu.dr-go-to-start-view')).toBeVisible()
      await expect(c.page.getByTestId('main-menu.dr-set-start-view')).toHaveCount(0)
      await expect(c.page.getByTestId('main-menu.dr-clear-start-view')).toHaveCount(0)
      await closeMenus(c.page)
      const original = (await docMeta(a.page)).drStartView
      await editBd(c.page, (ed) => {
        ;(ed as unknown as { updateInstanceState(p: unknown): void }).updateInstanceState({
          isReadonly: false,
        })
        const meta = ed.getDocumentSettings().meta
        ed.updateDocumentSettings({
          meta: { ...meta, drStartView: { pageId: 'page:page', x: 99_999, y: 99_999, w: 10, h: 10 } },
        })
      })
      await expect.poll(async () => (await docMeta(c.page)).drStartView).toEqual(original)
      await a.page.waitForTimeout(1_000)
      expect((await docMeta(a.page)).drStartView).toEqual(original)
    } finally {
      await c.context.close()
    }
  })

  await test.step('right-click a frame → Set this frame as start view: a first visit shows the whole frame, at ≤ 100%', async () => {
    await editBd(a.page, (ed, id) => ed.select(id), INTRO)
    const fb = (await boxes(a.page, [INTRO]))[INTRO]
    await editBd(a.page, (ed) => ed.zoomToFit())
    const vp = await readBd(a.page, (ed, id) => ed.getShapePageBounds(id), INTRO)
    await contextMenuAt(a.page, { x: (vp?.x ?? 0) + 250, y: (vp?.y ?? 0) + 200 })
    await a.page.getByTestId('context-menu.dr-set-frame-start-view').click()
    await expect(a.page.getByTestId('board-setting-notice')).toContainText(
      'This frame is now the start view.',
    )
    expect((await docMeta(a.page)).drStartView).toMatchObject({ frameId: INTRO })
    await waitForSaved(a.page)
    const d = await firstVisit('dave', 'editor')
    try {
      expect(await startView(d.page)).toBe('start-view')
      const view = await readBd(d.page, (ed) => {
        const b = ed.getViewportPageBounds()
        return { x: b.x, y: b.y, w: b.w, h: b.h }
      })
      expect(fb).toBeDefined()
      const f = fb as { x: number; y: number; w: number; h: number }
      expect(view.x).toBeLessThanOrEqual(f.x)
      expect(view.y).toBeLessThanOrEqual(f.y)
      expect(view.x + view.w).toBeGreaterThanOrEqual(f.x + f.w)
      expect(view.y + view.h).toBeGreaterThanOrEqual(f.y + f.h)
      expect(await zoom(d.page)).toBeLessThanOrEqual(1)
    } finally {
      await d.context.close()
    }
  })

  await test.step('Board menu → Clear start view: the next first visit fits all content again', async () => {
    await openBoardMenu(a.page)
    await a.page.getByTestId('main-menu.dr-clear-start-view').click()
    await expect(a.page.getByTestId('board-setting-notice')).toContainText('Start view cleared.')
    expect((await docMeta(a.page)).drStartView).toBeNull()
    await openBoardMenu(a.page)
    await expect(a.page.getByTestId('main-menu.dr-clear-start-view')).toHaveCount(0)
    await closeMenus(a.page)
    await waitForSaved(a.page)
    const e = await firstVisit('erin', 'editor')
    try {
      expect(await startView(e.page)).toBe('fit')
    } finally {
      await e.context.close()
    }
  })
})
