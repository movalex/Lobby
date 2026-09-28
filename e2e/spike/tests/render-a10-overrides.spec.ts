import { expect, type Page, test } from '@playwright/test'
import type { LabExtra, RenderApi } from '../fixtures/render-types.ts'
import { openSpike } from '../support/page.ts'
import type { SpikeElement } from '../support/spike-global.ts'
import { watchPage } from '../support/watch.ts'

// A10 (docs/EXCALIDRAW-MIGRATION.md §8.2, §2.7, §4.7): render overrides through Lobby's single owner
// (apps/web/src/canvas/overrides.ts).
//  - drag offsets move a note and its bound label together; the document does not change;
//  - opacity 0 hides a branch (notes, labels, an arrow, a free text, a frame and its child);
//  - overrides leave hit tests at document values (shown with the guard off), and Lobby's hit-test guard
//    stops clicks, double-clicks, drags, the context menu and box selection on hidden elements, and
//    presses on the document position of an element a peer is dragging.
// Pass: pixel probes.

const NOTE = [0xff, 0xdf, 0x6b] // Lobby yellow, the light-theme fill of the notes below
const WHITE = [0xff, 0xff, 0xff]

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** The scene: row 1 D (drag), M (remote move), V (visible); row 2 the branch B1 → B2, T, frame F ∋ C; V2. */
async function setup(page: Page) {
  await page.evaluate(() => {
    const spike = window.__lobbySpike
    const extra = spike?.extra as unknown as LabExtra
    const note = (id: string, x: number, y: number, text: string) => ({
      type: 'stickynote',
      id,
      x,
      y,
      width: 200,
      height: 200,
      backgroundColor: '#ffdf6b',
      label: { text, fontFamily: 6 },
    })
    const els = extra.engine.convertToExcalidrawElements(
      [
        note('D', 40, 40, 'Drag me'),
        note('M', 300, 40, 'Bob moves me'),
        note('V', 560, 40, 'Visible'),
        note('B1', 40, 320, 'Branch one'),
        note('B2', 300, 320, 'Branch two'),
        // unbound: convertToExcalidrawElements cannot bind an arrow to a stickynote (A10.md finding)
        { type: 'arrow', id: 'A', x: 244, y: 420, width: 52, height: 0, strokeWidth: 4 },
        { type: 'text', id: 'T', x: 40, y: 560, text: 'branch text', fontSize: 28, fontFamily: 6 },
        note('C', 610, 340, 'In frame'),
        {
          type: 'frame',
          id: 'F',
          x: 580,
          y: 310,
          width: 260,
          height: 260,
          name: 'Branch frame',
          children: ['C'],
        },
        note('V2', 900, 320, 'Visible two'),
      ],
      { regenerateIds: false },
    )
    // Lobby notes carry created: null (no date footer, plan §2.11)
    extra.probe.applyServer(els.map((e) => (e.type === 'stickynote' ? { ...e, created: null } : e)))
    spike?.api?.updateScene({
      appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} },
    })
  })
  await frames(page, 3)
}

const frames = (page: Page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
    n,
  )

const el = (page: Page, id: string) =>
  page.evaluate((id) => {
    const e = window.__lobbySpike?.api?.getSceneElementsIncludingDeleted().find((x) => x.id === id)
    if (!e) throw new Error(`no ${id}`)
    return e
  }, id)

const labelOf = async (page: Page, id: string): Promise<SpikeElement> => {
  const c = await el(page, id)
  const lid = c.boundElements?.find((b) => b.type === 'text')?.id
  if (!lid) throw new Error(`no label on ${id}`)
  return el(page, lid)
}

const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).pixel(x, y), [
    x,
    y,
  ] as const)

const dark = (page: Page, r: Box) =>
  page.evaluate((r) => ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).dark(r), r)

const near = (a: number[] | null, b: readonly number[], tol = 16) =>
  !!a && b.every((c, i) => Math.abs((a[i] ?? -999) - c) <= tol)

/** Viewport (client) coordinates of a scene point. */
const client = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => {
      const spike = window.__lobbySpike
      if (!spike?.api) throw new Error('no api')
      return spike.lib.sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, spike.api.getAppState())
    },
    [x, y] as const,
  )

const selected = (page: Page) =>
  page.evaluate(() => {
    const s = window.__lobbySpike?.api?.getAppState().selectedElementIds as Record<string, boolean>
    return Object.keys(s)
      .filter((k) => s[k])
      .sort()
  })

const deselect = (page: Page) =>
  page.evaluate(() => window.__lobbySpike?.api?.updateScene({ appState: { selectedElementIds: {} } }))

const docState = (page: Page) =>
  page.evaluate(() => {
    const spike = window.__lobbySpike
    const extra = spike?.extra as unknown as LabExtra
    return {
      ops: extra.probe.ops,
      drift: extra.probe.versionDrift(),
      unknown: [...extra.probe.unknown],
      onChange: extra.probe.onChangeCalls,
      positions: Object.fromEntries(
        (spike?.api?.getSceneElementsIncludingDeleted() ?? []).map((e) => [e.id, [e.x, e.y, e.version]]),
      ),
    }
  })

const labelBox = (l: SpikeElement, dx = 0, dy = 0): Box => ({
  x: l.x + dx,
  y: l.y + dy,
  w: l.width,
  h: l.height,
})

test('drag offsets move a note and its bound label together; the document does not change', async ({
  page,
}) => {
  const watch = watchPage(page)
  await openSpike(page, 'render-lab')
  await setup(page)
  const before = await docState(page)
  const D = await el(page, 'D')
  const L = await labelOf(page, 'D')
  const off = { x: 820, y: 0 }
  expect(near(await pixel(page, D.x + 12, D.y + 12), NOTE)).toBe(true)
  const labelDarkBefore = await dark(page, labelBox(L))
  expect(labelDarkBefore).toBeGreaterThan(20)

  await page.evaluate((off) => {
    const extra = window.__lobbySpike?.extra as unknown as LabExtra
    extra.overrides.setDrag('peer-bob', new Map([['D', off]]))
  }, off)
  await frames(page)
  const moved = {
    oldFill: await pixel(page, D.x + 12, D.y + 12),
    newFill: await pixel(page, D.x + off.x + 12, D.y + off.y + 12),
    oldLabelDark: await dark(page, labelBox(L)),
    newLabelDark: await dark(page, labelBox(L, off.x, off.y)),
  }
  expect(near(moved.oldFill, WHITE, 6)).toBe(true)
  expect(near(moved.newFill, NOTE)).toBe(true)
  expect(moved.oldLabelDark).toBe(0)
  expect(moved.newLabelDark).toBeGreaterThan(20)
  const during = await docState(page)
  expect(during.positions).toEqual(before.positions)
  expect(during.ops).toEqual([])
  expect(during.onChange).toBe(before.onChange) // overrides fire no onChange

  // An offset on the label alone is ignored by the engine (labels inherit their container's offset).
  const labelOnly = await page.evaluate(
    ({ lid }) => {
      const extra = window.__lobbySpike?.extra as unknown as LabExtra
      extra.overrides.setDrag('peer-bob', null)
      extra.overrides.setDrag('peer-carol', new Map([[lid, { x: 400, y: 0 }]]))
      return lid
    },
    { lid: L.id },
  )
  await frames(page)
  const labelOnlyDark = {
    original: await dark(page, labelBox(L)),
    shifted: await dark(page, labelBox(L, 400, 0)),
  }
  expect(labelOnly).toBe(L.id)
  expect(labelOnlyDark.original).toBeGreaterThan(20)

  // Two peers on one element: the most recently updated wins; clearing the commit restores it.
  await page.evaluate(() => {
    const extra = window.__lobbySpike?.extra as unknown as LabExtra
    extra.overrides.setDrag('peer-carol', null)
    extra.overrides.setDrag('peer-bob', new Map([['D', { x: 820, y: 0 }]]))
    extra.overrides.setDrag('peer-dan', new Map([['D', { x: 820, y: 260 }]]))
  })
  await frames(page)
  const lastWins = near(await pixel(page, D.x + 820 + 12, D.y + 260 + 12), NOTE)
  expect(lastWins).toBe(true)
  await page.evaluate(() => {
    const extra = window.__lobbySpike?.extra as unknown as LabExtra
    extra.overrides.clearDragFor(['D'])
  })
  await frames(page)
  expect(near(await pixel(page, D.x + 12, D.y + 12), NOTE)).toBe(true)
  expect(await dark(page, labelBox(L))).toBeGreaterThan(20)
  const after = await docState(page)
  expect(after.positions).toEqual(before.positions)
  expect(after.ops).toEqual([])
  expect(after.drift).toEqual([])
  const stats = await page.evaluate(
    () => ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).overrides.stats,
  )
  console.log(
    'A10-METRICS drag',
    JSON.stringify({ moved, labelOnlyDark, lastWins, stats, onChange: after.onChange }),
  )
  expect(watch.consoleErrors).toEqual([])
})

test('opacity 0 hides a branch; a bound label must be hidden explicitly (engine rule)', async ({ page }) => {
  const watch = watchPage(page)
  await openSpike(page, 'render-lab')
  await setup(page)
  const before = await docState(page)
  const [B1, B2, T, C, V, V2] = await Promise.all(['B1', 'B2', 'T', 'C', 'V', 'V2'].map((id) => el(page, id)))
  const LB1 = await labelOf(page, 'B1')
  const LC = await labelOf(page, 'C')
  if (!B1 || !B2 || !T || !C || !V || !V2) throw new Error('scene')

  // The engine alone: opacity 0 on the container leaves its label drawn ("label opacity remains
  // independent", types.d.ts:1095-1110).
  const raw = await page.evaluate(() => {
    const api = window.__lobbySpike?.api as RenderApi
    api.setElementRenderOverrides(new Map([['B1', { opacity: 0 }]]))
    return true
  })
  await frames(page)
  const rawResult = {
    fill: await pixel(page, B1.x + 12, B1.y + 12),
    labelDark: await dark(page, labelBox(LB1)),
  }
  expect(raw).toBe(true)
  expect(near(rawResult.fill, WHITE, 6)).toBe(true)
  expect(rawResult.labelDark).toBeGreaterThan(20)
  await page.evaluate(() =>
    ((window.__lobbySpike as { api: unknown }).api as RenderApi).setElementRenderOverrides(null),
  )
  await frames(page)

  // Through Lobby's owner: the collapse source lists the branch; labels and frame children are expanded.
  const hiddenIds = await page.evaluate(() => {
    const extra = window.__lobbySpike?.extra as unknown as LabExtra
    extra.overrides.setHidden('collapse:root', ['B1', 'B2', 'A', 'T', 'F'])
    extra.overrides.flush()
    return [...extra.overrides.hiddenIds()].sort()
  })
  await frames(page)
  const probe = {
    B1fill: await pixel(page, B1.x + 12, B1.y + 12),
    B2fill: await pixel(page, B2.x + 12, B2.y + 12),
    B1label: await dark(page, labelBox(LB1)),
    arrow: await dark(page, { x: 242, y: 405, w: 56, h: 30 }),
    text: await dark(page, { x: T.x, y: T.y, w: T.width, h: T.height }),
    childFill: await pixel(page, C.x + 12, C.y + 12),
    childLabel: await dark(page, labelBox(LC)),
    Vfill: await pixel(page, V.x + 12, V.y + 12),
    V2fill: await pixel(page, V2.x + 12, V2.y + 12),
  }
  expect(hiddenIds).toEqual(expect.arrayContaining(['A', 'B1', 'B2', 'C', 'F', 'T', LB1.id, LC.id]))
  expect(near(probe.B1fill, WHITE, 6)).toBe(true)
  expect(near(probe.B2fill, WHITE, 6)).toBe(true)
  expect(probe.B1label).toBe(0)
  expect(probe.arrow).toBe(0)
  expect(probe.text).toBe(0)
  expect(near(probe.childFill, WHITE, 6)).toBe(true)
  expect(probe.childLabel).toBe(0)
  expect(near(probe.Vfill, NOTE)).toBe(true)
  expect(near(probe.V2fill, NOTE)).toBe(true)
  const during = await docState(page)
  expect(during.positions).toEqual(before.positions)
  expect(during.ops).toEqual([])

  // Expanding again: the branch comes back.
  await page.evaluate(() => {
    const extra = window.__lobbySpike?.extra as unknown as LabExtra
    extra.overrides.setHidden('collapse:root', null)
  })
  await frames(page)
  expect(near(await pixel(page, B1.x + 12, B1.y + 12), NOTE)).toBe(true)
  expect(await dark(page, labelBox(LB1))).toBeGreaterThan(20)
  console.log('A10-METRICS hide', JSON.stringify({ rawResult, hiddenIds: hiddenIds.length, probe }))
  expect(watch.consoleErrors).toEqual([])
})

test("hit tests stay at document values; Lobby's guard stops clicks, double-clicks, drags, menus and box selection on hidden elements", async ({
  page,
}) => {
  const watch = watchPage(page)
  await openSpike(page, 'render-lab')
  await setup(page)
  await page.evaluate(() => {
    const extra = window.__lobbySpike?.extra as unknown as LabExtra
    extra.overrides.setHidden('collapse:root', ['B1', 'B2', 'A', 'T', 'F'])
    extra.overrides.flush()
  })
  await frames(page)
  const B1 = await el(page, 'B1')
  const center = await client(page, B1.x + 100, B1.y + 100)

  // Guard off: a click on the hidden note selects it (hit tests use the document).
  await page.evaluate(() =>
    ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).guard.setEnabled(false),
  )
  await page.mouse.click(center.x, center.y)
  const selectedWithoutGuard = await selected(page)
  await deselect(page)
  await page.mouse.dblclick(center.x, center.y)
  const editorWithoutGuard = await page.evaluate(() => ({
    editing:
      (window.__lobbySpike?.api?.getAppState().editingTextElement as { id?: string } | null)?.id ?? null,
    textarea: document.querySelectorAll('textarea.excalidraw-wysiwyg').length,
  }))
  await page.keyboard.press('Escape')
  await deselect(page)
  await frames(page)
  expect(selectedWithoutGuard).toContain('B1')
  expect(editorWithoutGuard.textarea).toBe(1)

  // Guard on.
  await page.evaluate(() =>
    ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).guard.setEnabled(true),
  )
  const base = await docState(page)
  await page.mouse.click(center.x, center.y)
  const afterClick = await selected(page)
  await page.mouse.dblclick(center.x, center.y)
  await frames(page)
  const afterDbl = await page.evaluate(() => ({
    editing:
      (window.__lobbySpike?.api?.getAppState().editingTextElement as { id?: string } | null)?.id ?? null,
    textarea: document.querySelectorAll('textarea.excalidraw-wysiwyg').length,
  }))
  // drag the hidden note
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 120, center.y + 60, { steps: 6 })
  await page.mouse.up()
  const afterDrag = await el(page, 'B1')
  // context menu
  await page.mouse.click(center.x, center.y, { button: 'right' })
  const afterMenu = await selected(page)
  // box selection over the whole row 2 (B1, B2, A, T, F, C hidden; V2 visible)
  const a = await client(page, 20, 290)
  const b = await client(page, 1120, 610)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 10 })
  await page.mouse.up()
  await frames(page)
  const afterBox = await selected(page)
  // a visible note is still clickable
  await deselect(page)
  const V = await el(page, 'V')
  const vc = await client(page, V.x + 100, V.y + 100)
  await page.mouse.click(vc.x, vc.y)
  const afterVisible = await selected(page)
  const log = await page.evaluate(
    () => ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).guard.log,
  )
  const after = await docState(page)
  // for the record: the hover cursor over a hidden element (the guard does not touch pointermove)
  await deselect(page)
  await page.mouse.move(center.x + 5, center.y + 5)
  await page.mouse.move(center.x, center.y)
  const hoverCursor = await page.evaluate(
    () =>
      document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.interactive')?.style.cursor ?? '',
  )
  const emptyPoint = await client(page, 1180, 120)
  await page.mouse.move(emptyPoint.x, emptyPoint.y)
  const emptyCursor = await page.evaluate(
    () =>
      document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.interactive')?.style.cursor ?? '',
  )

  console.log(
    'A10-METRICS guard',
    JSON.stringify({
      selectedWithoutGuard,
      editorWithoutGuard,
      afterClick,
      afterDbl,
      dragMoved: [afterDrag.x - B1.x, afterDrag.y - B1.y],
      afterMenu,
      afterBox,
      afterVisible,
      hoverCursor,
      emptyCursor,
      guardLog: log.map((e) => `${e.type}:${e.id}:${e.reason.kind}`),
      // with the guard off, opening and closing the label editor (no typing) re-laid out the label
      opsFromGuardOffEditor: base.ops,
      opsWithGuardOn: after.ops.length - base.ops.length,
    }),
  )
  expect(afterClick).toEqual([])
  expect(afterDbl).toEqual({ editing: null, textarea: 0 })
  expect([afterDrag.x, afterDrag.y]).toEqual([B1.x, B1.y])
  expect(afterMenu).toEqual([])
  expect(afterBox).toContain('V2')
  for (const id of ['B1', 'B2', 'A', 'T', 'F', 'C']) expect(afterBox).not.toContain(id)
  expect(afterVisible).toEqual(['V'])
  expect(log.filter((e) => e.id === 'B1' && e.reason.kind === 'hidden').map((e) => e.type)).toEqual(
    expect.arrayContaining(['pointerdown', 'dblclick', 'contextmenu']),
  )
  // nothing the guard let through changed the document: only the box selection and clicks (no ops)
  expect(after.ops).toEqual(base.ops)
  expect(after.positions).toEqual(base.positions)
  expect(watch.consoleErrors).toEqual([])
})

test("a press on the document position of an element a peer is dragging is swallowed ('moving'); the drawn position misses", async ({
  page,
}) => {
  await openSpike(page, 'render-lab')
  await setup(page)
  const M = await el(page, 'M')
  const off = { x: 780, y: 0 }
  await page.evaluate((off) => {
    const extra = window.__lobbySpike?.extra as unknown as LabExtra
    extra.overrides.setDrag('peer-bob', new Map([['M', off]]))
  }, off)
  await frames(page)
  const docPos = await client(page, M.x + 100, M.y + 100)
  const drawnPos = await client(page, M.x + off.x + 100, M.y + off.y + 100)
  expect(near(await pixel(page, M.x + off.x + 12, M.y + 12), NOTE)).toBe(true)
  await page.mouse.click(docPos.x, docPos.y)
  const atDoc = await selected(page)
  await page.mouse.click(drawnPos.x, drawnPos.y)
  const atDrawn = await selected(page)
  const log = await page.evaluate(
    () => ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).guard.log,
  )
  // the commit arrives: the preview ends, the note is clickable again
  await page.evaluate(() =>
    ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).overrides.clearDragFor(['M']),
  )
  await frames(page)
  await page.mouse.click(docPos.x, docPos.y)
  const afterCommit = await selected(page)
  console.log(
    'A10-METRICS moving',
    JSON.stringify({ atDoc, atDrawn, afterCommit, log: log.map((e) => [e.type, e.id, e.reason]) }),
  )
  expect(atDoc).toEqual([])
  expect(log).toEqual([{ id: 'M', reason: { kind: 'moving', source: 'peer-bob' }, type: 'pointerdown' }])
  expect(atDrawn).toEqual([]) // stated deviation (§2.7): the drawn position is not hittable until the commit
  expect(afterCommit).toEqual(['M'])
})
