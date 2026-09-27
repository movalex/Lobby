// Milestone-0 demonstration 5: what happens when two people change the same thing.
// Semantics: docs/research/SYNTHESIS.md §8; wire-level proofs: apps/sync/test/protocol/
// {text-lease,conflicts}.test.ts. These tests show the same behaviors through the real UI.
// Undo (WRK-05) reverses only your own changes: docs/research/undo-per-prop.md, adopted in
// apps/web/src/sync-quality/perPropUndo.ts.
import type { Page } from '@playwright/test'
import {
  arrowBindings,
  type BoardDocument,
  boardDocument,
  edit,
  expectConn,
  expectConverged,
  getShape,
  pageShapes,
  read,
  type Session,
  shapeBounds,
  shapeCenterOnScreen,
  shapeText,
  startTextEditing,
  startTextEditingWithKeyboard,
  stopTextEditing,
  toScreen,
  typeText,
  waitForValue,
} from './support/board.ts'
import {
  expectSaveState,
  focusCanvas,
  geoFacts,
  openSessionWatched,
  redo,
  relayBoardSocket,
  type ServerHold,
  undo,
} from './support/collab-quality.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'

// Short enough to watch the lease expire in the test, long enough for bob's denied attempt to land
// well inside it. The server default is 5000 ms.
const LEASE_MS = 3000
test.use({ syncEnv: { TEXT_LEASE_MS: String(LEASE_MS) } })

const noteText = (page: Page, id: string) => page.locator(`[data-shape-id="${id}"] .tl-rich-text`)
const editingBadge = (page: Page, userId: string) =>
  page.locator(`[data-testid="editing-badge"][data-user-id="${userId}"]`)

test('text lease: bob cannot type into the note alice is typing in, until her lease expires', async ({
  session,
}) => {
  const N = 'shape:leased-note'
  const a = await session('alice')
  const b = await session('bob')
  await edit(a.page, (ed, id) => ed.createShape({ id, type: 'note', x: 240, y: 140 }), N)
  await expect(b.page.locator(`[data-shape-id="${N}"]`)).toBeVisible()

  await startTextEditing(a.page, N)
  await typeText(a.page, 'alice typing')
  await expect.poll(() => shapeText(b.page, N)).toBe('alice typing')
  // B is told (by alice's presence hint) that she is editing this note.
  await expect(editingBadge(b.page, a.id)).toHaveText(`${a.name} is editing`)
  await expect(editingBadge(b.page, a.id)).toHaveAttribute('data-shape-id', N)

  // Bob tries to type into the same note while alice holds the lease.
  await startTextEditing(b.page, N)
  await typeText(b.page, ' and bob')
  await expect(b.page.getByTestId('lease-toast')).toHaveText(`${a.name} is editing this text`)
  // The server vetoed bob's change, so his copy is reverted to alice's text.
  await expect.poll(() => shapeText(b.page, N)).toBe('alice typing')
  await capture('lease-toast.png', b.page, test.info())
  await stopTextEditing(b.page)
  await expect(noteText(b.page, N)).toHaveText('alice typing')
  // Alice's text is intact on her side and on the server.
  expect(await shapeText(a.page, N)).toBe('alice typing')
  const probe = await session('carol')
  expect(await shapeText(probe.page, N)).toBe('alice typing')
  await probe.context.close()

  // Alice was never blocked.
  await typeText(a.page, '!')
  await expect.poll(() => shapeText(b.page, N)).toBe('alice typing!')
  await stopTextEditing(a.page)
  await expect(editingBadge(b.page, a.id)).toHaveCount(0)
  // Every renewal of alice's lease happened before bob saw her last character.
  const lastRenewalSeen = Date.now()

  // The expiry itself is under test here, so this is a real wait (plus a margin for clock skew).
  await b.page.waitForTimeout(Math.max(0, lastRenewalSeen + LEASE_MS + 750 - Date.now()))
  // Enter opens the note with all of its text selected, so bob's typing replaces it.
  await startTextEditingWithKeyboard(b.page, N)
  await typeText(b.page, 'bob took over')
  await stopTextEditing(b.page)
  await expect.poll(() => shapeText(a.page, N)).toBe('bob took over')
  await expect(noteText(a.page, N)).toHaveText('bob took over')
  await expectConverged(a.page, [b.page])
})

test('edit vs delete: the delete wins in either order', async ({ session }) => {
  const EDIT_FIRST = 'shape:edit-then-delete'
  const DELETE_FIRST = 'shape:delete-then-edit'
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    a.page,
    (ed, ids) =>
      ed.createShapes([
        { id: ids.one, type: 'geo', x: 100, y: 120, props: { w: 160, h: 110 } },
        { id: ids.two, type: 'geo', x: 420, y: 120, props: { w: 160, h: 110 } },
      ]),
    { one: EDIT_FIRST, two: DELETE_FIRST },
  )
  await expectConverged(a.page, [b.page])
  const exists = (page: Page, id: string) => getShape(page, id).then((s) => s !== null)

  // 1. Alice's edit lands first, then bob deletes: gone everywhere.
  await edit(
    a.page,
    (ed, id) => ed.updateShape({ id, type: 'geo', x: 180, props: { color: 'green' } }),
    EDIT_FIRST,
  )
  await expect.poll(() => getShape(b.page, EDIT_FIRST).then((s) => s?.x)).toBe(180)
  await edit(b.page, (ed, id) => ed.deleteShapes([id]), EDIT_FIRST)
  await expect.poll(() => exists(a.page, EDIT_FIRST)).toBe(false)

  // 2. Bob deletes while alice's edit is still in flight (she is offline): the late edit does not
  //    bring the shape back.
  await a.context.setOffline(true)
  await expectConn(a.page, 'offline')
  await edit(
    a.page,
    (ed, id) => ed.updateShape({ id, type: 'geo', x: 500, props: { color: 'violet' } }),
    DELETE_FIRST,
  )
  await edit(b.page, (ed, id) => ed.deleteShapes([id]), DELETE_FIRST)
  expect(await exists(a.page, DELETE_FIRST)).toBe(true)
  await a.context.setOffline(false)
  await expectConn(a.page, 'online')
  await expect.poll(() => exists(a.page, DELETE_FIRST)).toBe(false)
  expect(await exists(b.page, DELETE_FIRST)).toBe(false)

  const fresh = await session('carol')
  expect(await exists(fresh.page, EDIT_FIRST)).toBe(false)
  expect(await exists(fresh.page, DELETE_FIRST)).toBe(false)
  await expectConverged(a.page, [b.page, fresh.page])
})

// ---- WRK-05: undo reverses only your own changes (docs/research/undo-per-prop.md) -----------------
// These replace the M0 "DOCUMENTED LIMITATION" test, which pinned tldraw's native behavior: undo
// wrote back the whole earlier record, reverting other people's props and resurrecting deletions.

/** Proves peers have processed everything `from` pushed so far: a new shape round-trips. */
async function roundTrip(from: Session, to: Session[], id: string) {
  await edit(
    from.page,
    (ed, sid) => ed.createShape({ id: sid, type: 'geo', x: 1200, y: 900, props: { w: 40, h: 40 } }),
    id,
  )
  for (const s of to) await expect.poll(() => getShape(s.page, id).then((sh) => sh !== null)).toBe(true)
}

test('WRK-05: alice’s undo moves X back and keeps the colour bob gave it, for everyone', async ({
  session,
}) => {
  const X = 'shape:undo-after-remote'
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    a.page,
    (ed, id) => ed.createShape({ id, type: 'geo', x: 100, y: 160, props: { w: 160, h: 110 } }),
    X,
  )
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 100, color: 'black' })

  // Alice moves the shape (her undo stack: this move). Bob then recolors it, a prop alice never touched.
  await edit(
    a.page,
    (ed, id) => {
      ed.markHistoryStoppingPoint('alice moves')
      ed.updateShape({ id, type: 'geo', x: 400 })
    },
    X,
  )
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 400, color: 'black' })
  await edit(b.page, (ed, id) => ed.updateShape({ id, type: 'geo', props: { color: 'red' } }), X)
  await expect.poll(() => geoFacts(a.page, X)).toEqual({ x: 400, color: 'red' })

  await focusCanvas(a.page)
  await undo(a.page)
  await expect.poll(() => geoFacts(a.page, X)).toEqual({ x: 100, color: 'red' })
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 100, color: 'red' })
  const fresh = await session('carol')
  expect(await geoFacts(fresh.page, X)).toEqual({ x: 100, color: 'red' })
  // Nothing of alice's was skipped, so there is nothing to say.
  await expect(a.page.getByTestId('undo-notice')).toHaveCount(0)

  // Redo replays her move, still without touching bob's colour.
  await redo(a.page)
  await expect.poll(() => geoFacts(a.page, X)).toEqual({ x: 400, color: 'red' })
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 400, color: 'red' })
  await expectConverged(a.page, [b.page, fresh.page])
})

test('WRK-05: undo never brings back a shape someone else deleted, and says so', async ({ session }) => {
  const X = 'shape:undo-after-delete'
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    a.page,
    (ed, id) => ed.createShape({ id, type: 'geo', x: 100, y: 160, props: { w: 160, h: 110 } }),
    X,
  )
  await edit(
    a.page,
    (ed, id) => {
      ed.markHistoryStoppingPoint('alice moves')
      ed.updateShape({ id, type: 'geo', x: 400 })
    },
    X,
  )
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 400, color: 'black' })
  await edit(b.page, (ed, id) => ed.deleteShapes([id]), X)
  await expect.poll(() => geoFacts(a.page, X)).toBeNull()

  await focusCanvas(a.page)
  await undo(a.page) // her move: the shape is gone, so there is nothing to move back
  await expect(a.page.getByTestId('undo-notice')).toHaveText(
    'Someone deleted that object, so it was not restored.',
  )
  expect(await geoFacts(a.page, X)).toBeNull()
  await redo(a.page) // redo of the move: still nothing
  await undo(a.page)
  await undo(a.page) // her create: removing what is already gone
  await redo(a.page) // redo of her create: not re-created, bob deleted it
  expect(await geoFacts(a.page, X)).toBeNull()

  // Everything alice's tab pushed has reached bob and the server; X never came back.
  await roundTrip(a, [b], 'shape:after-undo-sentinel')
  expect(await geoFacts(b.page, X)).toBeNull()
  const fresh = await session('carol')
  await expect
    .poll(() => getShape(fresh.page, 'shape:after-undo-sentinel').then((s) => s !== null))
    .toBe(true)
  expect(await geoFacts(fresh.page, X)).toBeNull()
  await expectConverged(a.page, [b.page, fresh.page])
})

test('WRK-05: bob recolours while alice is still dragging; her undo moves it back and keeps his colour', async ({
  session,
}) => {
  // The case a naive 3-way undo gets wrong: bob's colour lands INSIDE alice's history entry (the
  // entry squashes to her pointer-up state, which includes it). This fails if the remote-write
  // tracker or the replay gate silently stops working (an upgrade canary).
  const X = 'shape:recoloured-mid-drag'
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    a.page,
    (ed, id) => ed.createShape({ id, type: 'geo', x: 100, y: 160, props: { w: 160, h: 110 } }),
    X,
  )
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 100, color: 'black' })

  // Selected first: a drag that starts inside an unselected hollow shape draws a selection box.
  await edit(a.page, (ed, id) => ed.select(id), X)
  const from = await shapeCenterOnScreen(a.page, X)
  await a.page.mouse.move(from.x, from.y)
  await a.page.mouse.down()
  await a.page.mouse.move(from.x + 120, from.y, { steps: 10 })
  await edit(b.page, (ed, id) => ed.updateShape({ id, type: 'geo', props: { color: 'red' } }), X)
  await expect.poll(() => getShape(a.page, X).then((s) => s?.props.color)).toBe('red') // pointer still down
  await a.page.mouse.move(from.x + 300, from.y, { steps: 10 })
  await a.page.mouse.up()
  const dropped = await waitForValue(() => getShape(a.page, X).then((s) => (s && s.x > 300 ? s.x : null)))
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: dropped, color: 'red' })

  await undo(a.page) // the canvas has keyboard focus from the drag
  await expect.poll(() => geoFacts(a.page, X)).toEqual({ x: 100, color: 'red' })
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 100, color: 'red' })
  const fresh = await session('carol')
  expect(await geoFacts(fresh.page, X)).toEqual({ x: 100, color: 'red' })
  expect(await getShape(fresh.page, X).then((s) => s?.y)).toBe(160)
})

test('WRK-05: undo leaves text alone while someone else is editing it, and undoes the rest', async ({
  session,
}) => {
  const N = 'shape:text-being-edited'
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    a.page,
    (ed, arg) => ed.createShape({ id: arg.id, type: 'note', x: 100, y: 160, props: { richText: arg.text } }),
    { id: N, text: richText('first') },
  )
  // One history entry that changes both the text and the position.
  await edit(
    a.page,
    (ed, arg) => {
      ed.markHistoryStoppingPoint('alice rewrites and moves')
      ed.updateShape({ id: arg.id, type: 'note', x: 400, props: { richText: arg.text } })
    },
    { id: N, text: richText('second') },
  )
  await expect.poll(() => shapeText(b.page, N)).toBe('second')
  await expect.poll(() => getShape(b.page, N).then((s) => s?.x)).toBe(400)

  // Bob opens the note's text (no typing yet); alice knows from his presence.
  await startTextEditing(b.page, N)
  await expect(editingBadge(a.page, b.id)).toHaveAttribute('data-shape-id', N)

  await focusCanvas(a.page)
  await undo(a.page)
  await expect(a.page.getByTestId('undo-notice')).toHaveText(
    'Someone is editing that text, so it was left as is.',
  )
  await expect.poll(() => getShape(a.page, N).then((s) => s?.x)).toBe(100)
  expect(await shapeText(a.page, N)).toBe('second')
  await expect.poll(() => getShape(b.page, N).then((s) => s?.x)).toBe(100)
  expect(await shapeText(b.page, N)).toBe('second')
  await stopTextEditing(b.page)
  const fresh = await session('carol')
  expect(await getShape(fresh.page, N).then((s) => s?.x)).toBe(100)
  expect(await shapeText(fresh.page, N)).toBe('second')
})

test('WRK-05: alice’s own create, move, resize, text, arrow, group and delete undo and redo step by step', async ({
  session,
}) => {
  const ID = { g1: 'shape:own-g1', g2: 'shape:own-g2', g3: 'shape:own-g3', note: 'shape:own-note' }
  const a = await session('alice')
  const b = await session('bob')
  type Doc = Pick<BoardDocument, 'shapes' | 'bindings'>
  /** The document this tab holds (shapes + bindings). */
  const doc = async (): Promise<Doc> => {
    const d = await boardDocument(a.page)
    return { shapes: d.shapes, bindings: d.bindings }
  }
  const states: Doc[] = []
  /** One step of alice's history: done, synced to bob, and recorded. */
  const step = async (name: string, run: () => Promise<void>) => {
    await test.step(name, run)
    await expectConverged(a.page, [b.page])
    states.push(await doc())
  }
  await focusCanvas(a.page)
  states.push(await doc())

  await step('create three boxes', async () => {
    await edit(
      a.page,
      (ed, ids) => {
        ed.markHistoryStoppingPoint('create boxes')
        ed.createShapes([
          { id: ids.g1, type: 'geo', x: 100, y: 120, props: { w: 140, h: 100 } },
          { id: ids.g2, type: 'geo', x: 420, y: 120, props: { w: 140, h: 100, color: 'blue' } },
          { id: ids.g3, type: 'geo', x: 100, y: 460, props: { w: 140, h: 100, color: 'green' } },
        ])
      },
      ID,
    )
  })
  await step('drag box 1 with the mouse', async () => {
    // Selected first: a drag that starts inside an unselected hollow shape draws a selection box.
    await edit(a.page, (ed, id) => ed.select(id), ID.g1)
    const c = await shapeCenterOnScreen(a.page, ID.g1)
    await a.page.mouse.move(c.x, c.y)
    await a.page.mouse.down()
    await a.page.mouse.move(c.x + 60, c.y + 40, { steps: 12 })
    await a.page.mouse.up()
    await expect.poll(() => getShape(a.page, ID.g1).then((s) => s?.x)).toBeGreaterThan(140)
  })
  await step('resize box 2 by its corner handle', async () => {
    await edit(a.page, (ed, id) => ed.select(id), ID.g2)
    const box = await shapeBounds(a.page, ID.g2)
    if (!box) throw new Error('box 2 has no bounds')
    const corner = await toScreen(a.page, { x: box.x + box.w, y: box.y + box.h })
    await a.page.mouse.move(corner.x, corner.y)
    await a.page.mouse.down()
    await a.page.mouse.move(corner.x + 80, corner.y + 60, { steps: 12 })
    await a.page.mouse.up()
    await expect.poll(() => getShape(a.page, ID.g2).then((s) => s?.props.w)).toBeGreaterThan(180)
  })
  await step('add a note', async () => {
    await edit(
      a.page,
      (ed, id) => {
        ed.markHistoryStoppingPoint('add note')
        ed.createShape({ id, type: 'note', x: 760, y: 120 })
      },
      ID.note,
    )
  })
  await step('type into the note', async () => {
    await startTextEditing(a.page, ID.note)
    await typeText(a.page, 'own words')
    await stopTextEditing(a.page)
    await expect.poll(() => shapeText(b.page, ID.note)).toBe('own words')
  })
  await step('draw an arrow from box 1 to box 3', async () => {
    await edit(a.page, (ed) => ed.setCurrentTool('arrow'))
    const p1 = await shapeCenterOnScreen(a.page, ID.g1)
    const p3 = await shapeCenterOnScreen(a.page, ID.g3)
    await a.page.mouse.move(p1.x, p1.y)
    await a.page.mouse.down()
    await a.page.mouse.move(p3.x, p3.y, { steps: 15 })
    await a.page.mouse.up()
    const arrowId = await waitForValue(
      async () => (await pageShapes(a.page)).find((s) => s.type === 'arrow')?.id,
    )
    await expect
      .poll(async () =>
        (await arrowBindings(a.page, arrowId)).map((x) => `${x.props.terminal}->${x.toId}`).sort(),
      )
      .toEqual([`end->${ID.g3}`, `start->${ID.g1}`])
  })
  await step('group box 2 and the note', async () => {
    await edit(a.page, (ed, ids) => ed.select(ids.g2, ids.note), ID)
    await a.page.keyboard.press('ControlOrMeta+g')
    await expect.poll(async () => (await getShape(a.page, ID.note))?.parentId).toMatch(/^shape:/)
  })
  await step('delete box 3 (the arrow end is bound to it)', async () => {
    await edit(a.page, (ed, id) => ed.select(id), ID.g3)
    await a.page.keyboard.press('Delete')
    await expect.poll(() => getShape(a.page, ID.g3)).toBeNull()
  })

  /**
   * Presses undo/redo until the document changes, and returns how many presses that took. tldraw also
   * keeps history entries that change only this tab's selection or editing state (entering a note's
   * text makes one); those replay with no document change, exactly as they do natively.
   */
  const pressUntilChanged = async (press: () => Promise<void>, from: Doc, label: string) => {
    for (let presses = 1; presses <= 3; presses++) {
      await a.page.evaluate((l) => {
        ;(window as { __drLabel?: string }).__drLabel = l
      }, `${label} #${presses}`)
      await press()
      // The replay runs inside the key handler; one frame later everything it wrote is in the store.
      await a.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))
      if (JSON.stringify(await doc()) !== JSON.stringify(from)) return presses
    }
    const recorded = await a.page.evaluate(() => (window as { __drRecorded?: string[] }).__drRecorded ?? [])
    throw new Error(
      `${label}: three presses changed nothing in the document. Changes recorded into history since the replays began (they end the redo stack): ${JSON.stringify(recorded)}`,
    )
  }
  // Diagnostics only (a failure message): note every change that lands in alice's history outside a
  // replay, because recording one ends the redo stack. Uses @internal editor/store members, so it
  // quietly does nothing if an upgrade removes them.
  await edit(a.page, (ed) => {
    const w = window as { __drRecorded?: string[] }
    w.__drRecorded = []
    const e = ed as unknown as {
      isReplayingHistory?(): boolean
      store: {
        addHistoryInterceptor?(
          fn: (
            entry: {
              changes: { added: object; updated: Record<string, [unknown, unknown]>; removed: object }
            },
            source: string,
          ) => void,
        ): () => void
      }
    }
    e.store.addHistoryInterceptor?.((entry, source) => {
      if (source !== 'user' || e.isReplayingHistory?.()) return
      const c = entry.changes
      const history = (ed as unknown as { history?: { state?: string } }).history
      w.__drRecorded?.push(
        JSON.stringify({
          at: (window as { __drLabel?: string }).__drLabel,
          history: history?.state,
          selection: Object.entries(c.updated)
            .filter(([id]) => id.startsWith('instance_page_state:'))
            .map(([, [from, to]]) => [
              (from as { selectedShapeIds?: unknown }).selectedShapeIds,
              (to as { selectedShapeIds?: unknown }).selectedShapeIds,
            ]),
          added: Object.keys(c.added),
          updated: Object.fromEntries(
            Object.entries(c.updated).map(([id, [from, to]]) => [
              id,
              Object.keys(to as object).filter(
                (k) =>
                  JSON.stringify((from as Record<string, unknown>)[k]) !==
                  JSON.stringify((to as Record<string, unknown>)[k]),
              ),
            ]),
          ),
          removed: Object.keys(c.removed),
        }),
      )
    })
  })
  // Every undo lands exactly on the state before that step, every redo on the state after it.
  const undoPresses: number[] = []
  for (let i = states.length - 1; i > 0; i--) {
    undoPresses[i] = await pressUntilChanged(() => undo(a.page), states[i] as Doc, `undo of step ${i}`)
    await expect.poll(doc, { message: `undo of step ${i}` }).toEqual(states[i - 1])
  }
  await expectConverged(a.page, [b.page])
  const redoPresses: number[] = []
  for (let i = 1; i < states.length; i++) {
    redoPresses[i] = await pressUntilChanged(() => redo(a.page), states[i - 1] as Doc, `redo of step ${i}`)
    await expect.poll(doc, { message: `redo of step ${i}` }).toEqual(states[i])
  }
  // Redo walks the same entries back: session-only entries sit on the other side of each step.
  test.info().annotations.push({
    type: 'history presses (undo per step / redo per step)',
    description: `${JSON.stringify(undoPresses.slice(1))} / ${JSON.stringify(redoPresses.slice(1))}`,
  })
  expect(undoPresses.reduce((n, x) => n + x, 0)).toBe(redoPresses.reduce((n, x) => n + x, 0))
  await expectConverged(a.page, [b.page])
  // Nothing was anyone else's, so nothing was skipped.
  await expect(a.page.getByTestId('undo-notice')).toHaveCount(0)
  const fresh = await session('carol')
  await expectConverged(a.page, [fresh.page])
})

test('WRK-05: undo goes back at least 100 steps', async ({ session }) => {
  const X = 'shape:hundred-steps'
  const a = await session('alice')
  const b = await session('bob')
  await focusCanvas(a.page)
  await edit(
    a.page,
    (ed, id) => {
      ed.markHistoryStoppingPoint('create')
      ed.createShape({ id, type: 'geo', x: 0, y: 200, props: { w: 80, h: 80 } })
      for (let i = 1; i <= 100; i++) {
        ed.markHistoryStoppingPoint(`step ${i}`)
        ed.updateShape({ id, type: 'geo', x: i * 5 })
      }
    },
    X,
  )
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 500, color: 'black' })
  for (let i = 0; i < 100; i++) await undo(a.page)
  await expect.poll(() => geoFacts(a.page, X)).toEqual({ x: 0, color: 'black' })
  await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 0, color: 'black' })
  await undo(a.page) // the 101st: her create
  await expect.poll(() => geoFacts(a.page, X)).toBeNull()
  await expect.poll(() => geoFacts(b.page, X)).toBeNull()
})

test('WRK-05: redo keeps working when the server confirms an undone creation only after the redo', async ({
  browser,
  board,
  users,
  session,
}) => {
  // The sync client then removes and re-adds the shape inside one rebase, and tldraw's selection
  // cleanup (attributed to the user) used to wipe the redo stack: the next redo did nothing.
  // apps/web/src/sync-quality/rebaseGuard.ts. Deterministic: alice's incoming frames are held.
  const X = 'shape:late-confirmation'
  let relay: ServerHold | undefined
  const a = await openSessionWatched(browser, board, await users.get('alice'), async (page) => {
    relay = await relayBoardSocket(page)
  })
  try {
    const b = await session('bob')
    // Keyboard focus first: a click after X is selected would deselect it as a history step of its own.
    await focusCanvas(a.page)
    await edit(
      a.page,
      (ed, id) => {
        ed.markHistoryStoppingPoint('create')
        ed.createShape({ id, type: 'geo', x: 100, y: 160, props: { w: 160, h: 110 } })
        ed.select(id)
      },
      X,
    )
    await edit(
      a.page,
      (ed, id) => {
        ed.markHistoryStoppingPoint('move')
        ed.updateShape({ id, type: 'geo', x: 400 })
      },
      X,
    )
    await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 400, color: 'black' })
    await expectSaveState(a.page, 'saved')

    await undo(a.page) // the move
    await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 100, color: 'black' })
    await expectSaveState(a.page, 'saved')
    relay?.hold()
    await undo(a.page) // the create: the server applies it, alice does not hear back yet
    await expect.poll(() => geoFacts(b.page, X)).toBeNull()
    await redo(a.page) // re-create, still unconfirmed on alice's side
    await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 100, color: 'black' })
    expect(relay?.held()).toBeGreaterThan(0)
    relay?.release()
    // Every answer is in and checked (the save indicator only says Saved then).
    await expectSaveState(a.page, 'saved')
    expect.soft(await read(a.page, (ed) => ed.getSelectedShapeIds()), "alice's selection").toEqual([X])

    await redo(a.page) // the move is still there to redo
    await expect.poll(() => geoFacts(a.page, X)).toEqual({ x: 400, color: 'black' })
    await expect.poll(() => geoFacts(b.page, X)).toEqual({ x: 400, color: 'black' })
  } finally {
    await a.context.close()
  }
})
