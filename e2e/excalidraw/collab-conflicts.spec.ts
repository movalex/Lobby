// Port of e2e/tests/conflicts.spec.ts to the Excalidraw engine (the tldraw version stays in e2e/tests on
// the default build): what happens when two people change the same thing, through the real UI.
// Semantics: docs/EXCALIDRAW-MIGRATION.md §2.4.3 (field groups, delete wins), §2.8 (undo reverses only
// your own changes, field by field), §2.9 (the explicit text lease). Wire-level proofs: the element room's
// protocol tests and the negative suite (apps/sync/test/negative).
//
// Differences from the tldraw spec, by design of the new engine:
//  - the lease is explicit: B's editor never opens on a note A is typing in (a toast names A), and A's
//    lease ends when her editor closes or her tab goes away, not by a presence timeout alone;
//  - a remote change to an element this tab is dragging is held back until the gesture ends (§2.5.4), so
//    A sees B's colour after her pointer-up, not during the drag;
//  - "redo after a late confirmation" (tldraw's rebase guard) has no counterpart: the engine core never
//    rebases an undone create.
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  deleteItem,
  expect,
  expectConverged,
  expectSaved,
  item,
  itemCenterOnScreen,
  items,
  openCanvasSession,
  select,
  selectNone,
  setTool,
  startTextEditing,
  startTextEditingWithKeyboard,
  stopTextEditing,
  TEXT_EDITOR,
  test,
  typeText,
  updateItem,
  waitForItem,
} from '../tests/support/canvas.ts'
import {
  expectServerConverged,
  focusCanvas,
  goOffline,
  goOnline,
  labelText,
  openRelayedCanvasSession,
  pressRedo,
  pressUndo,
  storedElement,
  toastTexts,
  typingBadge,
} from '../tests/support/excalidraw.ts'

// Short, so a lease left behind by a vanished tab ends inside the test. The server default is 5000 ms.
const LEASE_MS = 3000
test.use({ syncEnv: { TEXT_LEASE_MS: String(LEASE_MS) } })

/** x and strokeColor of an element on a tab (null when it is not live there). */
const boxFacts = async (page: Page, id: string) => {
  const s = await item(page, id)
  return s && !s.isDeleted ? { x: Math.round(s.x), color: (s as { strokeColor?: string }).strokeColor } : null
}
const exists = (page: Page, id: string) => item(page, id).then((s) => s !== null && !s.isDeleted)

test('text lease: bob cannot type into the note alice is typing in; he takes over once her lease ends', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const N = await createNote(a.page, { x: 240, y: 140 })
  await waitForItem(b.page, N)

  await startTextEditing(a.page, N)
  await typeText(a.page, 'alice typing')
  await expect.poll(() => labelText(b.page, N)).toBe('alice typing')
  // B is told alice is typing in this note.
  await expect(typingBadge(b.page, N)).toHaveAttribute('data-holder', a.name)

  // Bob tries to open the same note while alice holds the lease: his editor never opens.
  const c = await itemCenterOnScreen(b.page, N)
  await b.page.mouse.dblclick(c.x, c.y)
  await b.page.keyboard.type(' and bob', { delay: 15 })
  await expect.poll(() => toastTexts(b.page)).toContainEqual(expect.stringContaining(`${a.name} is typing`))
  await expect(b.page.locator(TEXT_EDITOR)).toHaveCount(0)
  expect(await labelText(b.page, N)).toBe('alice typing')
  await b.page.keyboard.press('Escape')
  // Alice's text is intact on her side and on the server.
  expect(await labelText(a.page, N)).toBe('alice typing')
  const label = (
    (await item(a.page, N)) as { boundElements?: { id: string; type: string }[] }
  ).boundElements?.find((e) => e.type === 'text')?.id as string
  expect(((await storedElement(stack, board, label)) as { originalText?: string } | null)?.originalText).toBe(
    'alice typing',
  )

  // Alice was never blocked.
  await typeText(a.page, '!')
  await expect.poll(() => labelText(b.page, N)).toBe('alice typing!')
  await stopTextEditing(a.page)
  await expect(typingBadge(b.page, N)).toHaveCount(0)

  // Her lease ended with her editor: Enter opens the note for bob; Ctrl/Cmd+A selects its text.
  await startTextEditingWithKeyboard(b.page, N)
  await b.page.keyboard.press('ControlOrMeta+a')
  await typeText(b.page, 'bob took over')
  await stopTextEditing(b.page)
  await expect.poll(() => labelText(a.page, N)).toBe('bob took over')
  await expectServerConverged(stack, board, [a.page, b.page])
})

test('text lease: a lease held by a tab that vanished mid-typing ends, and someone else can type', async ({
  canvasSession,
  users,
  browser,
  board,
}) => {
  const b = await canvasSession('bob')
  const a = await openCanvasSession(browser, board, await users.get('alice'))
  const N = await createNote(a.page, { x: 240, y: 140 })
  await waitForItem(b.page, N)
  await startTextEditing(a.page, N)
  await typeText(a.page, 'half a thought')
  await expect(typingBadge(b.page, N)).toHaveAttribute('data-holder', a.name)
  await expect.poll(() => labelText(b.page, N)).toBe('half a thought')
  await a.context.close() // the tab goes away with the lease
  await expect(typingBadge(b.page, N)).toHaveCount(0, { timeout: LEASE_MS + 10_000 })
  await startTextEditingWithKeyboard(b.page, N)
  await b.page.keyboard.press('ControlOrMeta+a')
  await typeText(b.page, 'finished by bob')
  await stopTextEditing(b.page)
  await expectSaved(b.page)
  expect(await labelText(b.page, N)).toBe('finished by bob')
})

test('edit vs delete: the delete wins in either order', async ({
  browser,
  board,
  users,
  canvasSession,
  stack,
}) => {
  const EDIT_FIRST = 'edit-then-delete'
  const DELETE_FIRST = 'delete-then-edit'
  const a = await openRelayedCanvasSession(browser, board, await users.get('alice'))
  try {
    const b = await canvasSession('bob')
    await createItem(a.page, 'rectangle', { id: EDIT_FIRST, x: 100, y: 120, width: 160, height: 110 })
    await createItem(a.page, 'rectangle', { id: DELETE_FIRST, x: 420, y: 120, width: 160, height: 110 })
    await waitForItem(b.page, DELETE_FIRST)
    await expectConverged(a.page, [b.page])

    // 1. Alice's edit lands first, then bob deletes: gone everywhere.
    await updateItem(a.page, EDIT_FIRST, { x: 180, strokeColor: '#2f9e44' })
    await expect.poll(() => item(b.page, EDIT_FIRST).then((s) => Math.round(s?.x ?? 0))).toBe(180)
    await deleteItem(b.page, EDIT_FIRST)
    await expect.poll(() => exists(a.page, EDIT_FIRST)).toBe(false)

    // 2. Bob deletes while alice's edit is still on her device (she is offline): her late edit does not
    //    bring the element back.
    await goOffline(a)
    await updateItem(a.page, DELETE_FIRST, { x: 500, strokeColor: '#9c36b5' })
    await deleteItem(b.page, DELETE_FIRST)
    await expectSaved(b.page)
    expect(await exists(a.page, DELETE_FIRST)).toBe(true)
    await goOnline(a)
    await expect.poll(() => exists(a.page, DELETE_FIRST)).toBe(false)
    await expectSaved(a.page)
    expect(await exists(b.page, DELETE_FIRST)).toBe(false)
    expect(
      ((await storedElement(stack, board, DELETE_FIRST)) as { isDeleted?: boolean } | null)?.isDeleted,
    ).toBe(true)

    const fresh = await canvasSession('carol')
    expect(await exists(fresh.page, EDIT_FIRST)).toBe(false)
    expect(await exists(fresh.page, DELETE_FIRST)).toBe(false)
    await expectServerConverged(stack, board, [a.page, b.page, fresh.page])
  } finally {
    await a.context.close()
  }
})

// ---- undo reverses only your own changes (§2.8) ---------------------------------------------------------

test('undo: alice’s undo moves X back and keeps the colour bob gave it, for everyone', async ({
  canvasSession,
  stack,
  board,
}) => {
  const X = 'undo-after-remote'
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await createItem(a.page, 'rectangle', {
    id: X,
    x: 100,
    y: 160,
    width: 160,
    height: 110,
    strokeColor: '#1e1e1e',
  })
  await expect.poll(() => boxFacts(b.page, X)).toEqual({ x: 100, color: '#1e1e1e' })

  // Alice moves it (her undo stack: this move). Bob then recolours it, a field alice never touched.
  await updateItem(a.page, X, { x: 400 })
  await expect.poll(() => boxFacts(b.page, X)).toEqual({ x: 400, color: '#1e1e1e' })
  await updateItem(b.page, X, { strokeColor: '#e03131' })
  await expect.poll(() => boxFacts(a.page, X)).toEqual({ x: 400, color: '#e03131' })
  await expectSaved(a.page)

  await pressUndo(a.page)
  await expect.poll(() => boxFacts(a.page, X)).toEqual({ x: 100, color: '#e03131' })
  await expect.poll(() => boxFacts(b.page, X)).toEqual({ x: 100, color: '#e03131' })
  // Nothing of alice's was skipped, so there is nothing to say.
  expect((await toastTexts(a.page)).filter((t) => /kept/.test(t))).toEqual([])

  // Redo replays her move, still without touching bob's colour.
  await pressRedo(a.page)
  await expect.poll(() => boxFacts(a.page, X)).toEqual({ x: 400, color: '#e03131' })
  await expect.poll(() => boxFacts(b.page, X)).toEqual({ x: 400, color: '#e03131' })
  await expectSaved(a.page)
  const fresh = await canvasSession('carol')
  expect(await boxFacts(fresh.page, X)).toEqual({ x: 400, color: '#e03131' })
  await expectServerConverged(stack, board, [a.page, b.page, fresh.page])
})

test('undo never brings back an element someone else deleted, and says so', async ({
  canvasSession,
  stack,
  board,
}) => {
  const X = 'undo-after-delete'
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await createItem(a.page, 'rectangle', { id: X, x: 100, y: 160, width: 160, height: 110 })
  await updateItem(a.page, X, { x: 400 })
  await expect.poll(() => boxFacts(b.page, X)).toMatchObject({ x: 400 })
  await deleteItem(b.page, X)
  await expect.poll(() => boxFacts(a.page, X)).toBeNull()
  await expectSaved(a.page)

  await pressUndo(a.page) // her move: the element is gone, so there is nothing to move back
  await expect.poll(() => toastTexts(a.page)).toContainEqual(expect.stringMatching(/kept/))
  expect(await boxFacts(a.page, X)).toBeNull()
  await pressRedo(a.page) // redo of the move: still nothing
  await pressUndo(a.page)
  await pressUndo(a.page) // her create: removing what is already gone
  await pressRedo(a.page) // redo of her create: not re-created, bob deleted it
  await expectSaved(a.page)
  expect(await boxFacts(a.page, X)).toBeNull()

  // Everything alice's tab pushed has reached bob and the server; X never came back.
  await expectServerConverged(stack, board, [a.page, b.page])
  expect(((await storedElement(stack, board, X)) as { isDeleted?: boolean } | null)?.isDeleted).toBe(true)
  const fresh = await canvasSession('carol')
  expect(await boxFacts(fresh.page, X)).toBeNull()
})

test('undo: bob recolours while alice is still dragging; her undo moves it back and keeps his colour', async ({
  canvasSession,
}) => {
  // Wave 2's known defect (2E): alice's pointer-up push carried her stale colour and bob's recolour was lost.
  // Fixed by spike B's O2 in part 3 (the held remote change is kept; merged into engine/excalidraw at the
  // wave-3 integration), so this is the fix's acceptance test.
  // The case a naive whole-element undo gets wrong: bob's colour lands during alice's gesture, so her
  // step's "after" side holds it. Field-level undo moves only what she changed.
  const X = 'recoloured-mid-drag'
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await createItem(a.page, 'rectangle', {
    id: X,
    x: 100,
    y: 160,
    width: 160,
    height: 110,
    backgroundColor: '#ffec99',
    fillStyle: 'solid',
    strokeColor: '#1e1e1e',
  })
  await expect.poll(() => boxFacts(b.page, X)).toEqual({ x: 100, color: '#1e1e1e' })

  await select(a.page, [X])
  const from = await itemCenterOnScreen(a.page, X)
  await a.page.mouse.move(from.x, from.y)
  await a.page.mouse.down()
  await a.page.mouse.move(from.x + 120, from.y, { steps: 10 })
  await updateItem(b.page, X, { strokeColor: '#e03131' })
  await expect
    .poll(() => item(b.page, X).then((s) => (s as { strokeColor?: string } | null)?.strokeColor))
    .toBe('#e03131')
  await a.page.mouse.move(from.x + 300, from.y, { steps: 10 })
  await a.page.mouse.up()
  await expect.poll(async () => ((await boxFacts(a.page, X))?.x ?? 0) > 300).toBe(true)
  const dropped = (await boxFacts(a.page, X))?.x
  await expect.poll(() => boxFacts(a.page, X)).toEqual({ x: dropped, color: '#e03131' })
  await expect.poll(() => boxFacts(b.page, X)).toEqual({ x: dropped, color: '#e03131' })
  await expectSaved(a.page)

  await pressUndo(a.page)
  await expect.poll(() => boxFacts(a.page, X)).toEqual({ x: 100, color: '#e03131' })
  await expect.poll(() => boxFacts(b.page, X)).toEqual({ x: 100, color: '#e03131' })
  const fresh = await canvasSession('carol')
  expect(await boxFacts(fresh.page, X)).toEqual({ x: 100, color: '#e03131' })
  expect(await item(fresh.page, X).then((s) => Math.round(s?.y ?? 0))).toBe(160)
})

test('undo leaves text alone while someone else is editing it, and undoes the rest', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const N = await createNote(a.page, { x: 100, y: 160, text: 'first' })
  await waitForItem(b.page, N)
  // Alice rewrites the note (one step: her editor's close), then moves it (another step).
  await startTextEditingWithKeyboard(a.page, N)
  await a.page.keyboard.press('ControlOrMeta+a')
  await typeText(a.page, 'second')
  await stopTextEditing(a.page)
  await expect.poll(() => labelText(b.page, N)).toBe('second')
  await updateItem(a.page, N, { x: 400 })
  await expect.poll(() => item(b.page, N).then((s) => Math.round(s?.x ?? 0))).toBe(400)
  await expectSaved(a.page)

  // Bob opens the note's text (no typing yet); alice sees that he is typing there.
  await startTextEditingWithKeyboard(b.page, N)
  await expect(typingBadge(a.page, N)).toHaveAttribute('data-holder', b.name)

  await pressUndo(a.page) // her move: applies
  await expect.poll(() => item(a.page, N).then((s) => Math.round(s?.x ?? 0))).toBe(100)
  await pressUndo(a.page) // her text: bob holds the lease, so it is left as is, and she is told
  await expect.poll(() => toastTexts(a.page)).toContainEqual(expect.stringMatching(/kept/))
  expect(await labelText(a.page, N)).toBe('second')
  await expect.poll(() => item(b.page, N).then((s) => Math.round(s?.x ?? 0))).toBe(100)
  expect(await labelText(b.page, N)).toBe('second')
  await stopTextEditing(b.page)
  await expectSaved(b.page)
  const fresh = await canvasSession('carol')
  expect(await item(fresh.page, N).then((s) => Math.round(s?.x ?? 0))).toBe(100)
  expect(await labelText(fresh.page, N)).toBe('second')
})

/** A tab's live elements as comparable facts (geometry rounded; no versions, nonces or timestamps). */
async function docFacts(page: Page) {
  const all = await items(page)
  return all
    .filter((e) => !e.isDeleted)
    .map((e) => {
      const x = e as unknown as Record<string, unknown>
      const bind = (b: unknown) => (b as { elementId?: string } | null)?.elementId ?? null
      return {
        id: e.id,
        type: e.type,
        x: Math.round(e.x),
        y: Math.round(e.y),
        w: Math.round(e.width),
        h: Math.round(e.height),
        groupIds: [...((x.groupIds as string[]) ?? [])],
        text: (x.originalText as string | undefined) ?? null,
        start: bind(x.startBinding),
        end: bind(x.endBinding),
      }
    })
    .sort((p, q) => (p.id < q.id ? -1 : 1))
}

for (const withGroup of [false, true])
  test(`undo: alice’s own drag, resize, note, text, arrow, ${withGroup ? 'group and ' : ''}delete undo and redo step by step`, async ({
    canvasSession,
    stack,
    board,
  }) => {
    // KNOWN DEFECT with the group step (spike-owned canvas/history, reported by 2E at wave 2): after the
    // whole sequence is undone, the redo of the Ctrl+G step changes nothing (a group made and redone on its
    // own works: the next test). Acceptance test of the fix: expected to fail until then.
    test.fail(withGroup, 'known defect: in a long undo/redo sequence the redo of an own Ctrl+G does nothing')
    const ID = { g1: 'own-g1', g2: 'own-g2', g3: 'own-g3' }
    const a = await canvasSession('alice')
    const b = await canvasSession('bob')
    type Doc = Awaited<ReturnType<typeof docFacts>>
    // the three boxes are the baseline (three creates are three steps; they are not undone here)
    await createItem(a.page, 'rectangle', { id: ID.g1, x: 100, y: 120, width: 140, height: 100 })
    await createItem(a.page, 'rectangle', {
      id: ID.g2,
      x: 420,
      y: 120,
      width: 140,
      height: 100,
      strokeColor: '#1971c2',
    })
    await createItem(a.page, 'rectangle', {
      id: ID.g3,
      x: 100,
      y: 460,
      width: 140,
      height: 100,
      strokeColor: '#2f9e44',
    })
    await expectSaved(a.page)
    const states: Doc[] = [await docFacts(a.page)]
    let noteId = ''
    const step = async (name: string, run: () => Promise<void>) => {
      await test.step(name, run)
      await expectSaved(a.page)
      await expectConverged(a.page, [b.page])
      states.push(await docFacts(a.page))
    }

    await step('drag box 1 with the mouse', async () => {
      await select(a.page, [ID.g1])
      const c = await itemCenterOnScreen(a.page, ID.g1)
      await a.page.mouse.move(c.x, c.y)
      await a.page.mouse.down()
      await a.page.mouse.move(c.x + 60, c.y + 40, { steps: 12 })
      await a.page.mouse.up()
      await expect.poll(() => item(a.page, ID.g1).then((s) => s?.x ?? 0)).toBeGreaterThan(140)
    })
    await step('resize box 2', async () => {
      await updateItem(a.page, ID.g2, { width: 220, height: 160 })
    })
    await step('add a note', async () => {
      // with a word already in it: typing into an EMPTY note is a known defect (the test below)
      noteId = await createNote(a.page, { x: 760, y: 120, text: 'note' })
    })
    await step('type into the note', async () => {
      await startTextEditing(a.page, noteId)
      await a.page.keyboard.press('End')
      await typeText(a.page, ' with own words')
      await stopTextEditing(a.page)
      await expect.poll(() => labelText(b.page, noteId)).toBe('note with own words')
    })
    await step('draw an arrow from box 1 to box 3', async () => {
      await selectNone(a.page)
      expect(await setTool(a.page, 'arrow')).toBe(true)
      const p1 = await itemCenterOnScreen(a.page, ID.g1)
      const p3 = await itemCenterOnScreen(a.page, ID.g3)
      await a.page.mouse.move(p1.x, p1.y)
      await a.page.mouse.down()
      await a.page.mouse.move(p3.x, p3.y, { steps: 15 })
      await a.page.mouse.up()
      await expect
        .poll(async () => {
          const ar = (await items(a.page)).find((e) => e.type === 'arrow') as
            | { startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null }
            | undefined
          return [ar?.startBinding?.elementId ?? null, ar?.endBinding?.elementId ?? null]
        })
        .toEqual([ID.g1, ID.g3])
    })
    if (withGroup)
      await step('group box 2 and the note (Ctrl/Cmd+G)', async () => {
        await select(a.page, [ID.g2, noteId])
        await focusCanvas(a.page)
        await a.page.keyboard.press('ControlOrMeta+g')
        await expect.poll(() => item(a.page, noteId).then((s) => (s?.groupIds ?? []).length)).toBe(1)
      })
    await step('delete box 3 (the arrow’s end is bound to it)', async () => {
      await select(a.page, [ID.g3])
      await focusCanvas(a.page)
      await a.page.keyboard.press('Delete')
      await expect.poll(() => exists(a.page, ID.g3)).toBe(false)
    })

    /** Presses undo/redo until the document changes (at most 3 presses), and returns how many it took. */
    const pressUntilChanged = async (press: () => Promise<void>, from: Doc, label: string) => {
      for (let presses = 1; presses <= 3; presses++) {
        await press()
        await a.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))
        if (JSON.stringify(await docFacts(a.page)) !== JSON.stringify(from)) return presses
        await a.page.waitForTimeout(100)
        if (JSON.stringify(await docFacts(a.page)) !== JSON.stringify(from)) return presses
      }
      throw new Error(`${label}: three presses changed nothing`)
    }
    // Every undo lands exactly on the state before that step, every redo on the state after it.
    const undoPresses: number[] = []
    for (let i = states.length - 1; i > 0; i--) {
      undoPresses[i] = await pressUntilChanged(() => pressUndo(a.page), states[i] as Doc, `undo of step ${i}`)
      await expect.poll(() => docFacts(a.page), { message: `undo of step ${i}` }).toEqual(states[i - 1])
    }
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    const redoPresses: number[] = []
    for (let i = 1; i < states.length; i++) {
      redoPresses[i] = await pressUntilChanged(
        () => pressRedo(a.page),
        states[i - 1] as Doc,
        `redo of step ${i}`,
      )
      await expect.poll(() => docFacts(a.page), { message: `redo of step ${i}` }).toEqual(states[i])
    }
    test.info().annotations.push({
      type: 'history presses (undo per step / redo per step)',
      description: `${JSON.stringify(undoPresses.slice(1))} / ${JSON.stringify(redoPresses.slice(1))}`,
    })
    expect(
      undoPresses.slice(1).every((n) => n === 1),
      'one press per step',
    ).toBe(true)
    expect(
      redoPresses.slice(1).every((n) => n === 1),
      'one press per step',
    ).toBe(true)
    await expectSaved(a.page)
    // Nothing was anyone else's, so nothing was skipped.
    expect((await toastTexts(a.page)).filter((t) => /kept/.test(t))).toEqual([])
    await expectServerConverged(stack, board, [a.page, b.page])
  })

test('undo goes back at least 100 steps', async ({ canvasSession }) => {
  const X = 'hundred-steps'
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  // each write acknowledged before the next: two writes the engine sees in one change are one step
  const savedNow = () =>
    a.page.waitForFunction(
      () =>
        (window as unknown as { lobbyCanvas: { saveState(): { state: string } } }).lobbyCanvas.saveState()
          .state === 'saved',
      undefined,
      { polling: 10, timeout: 15_000 },
    )
  await createItem(a.page, 'rectangle', { id: X, x: 0, y: 200, width: 80, height: 80 })
  await savedNow()
  for (let i = 1; i <= 100; i++) {
    await updateItem(a.page, X, { x: i * 5 })
    await savedNow()
  }
  await expect.poll(() => boxFacts(b.page, X)).toMatchObject({ x: 500 })
  await expectSaved(a.page)
  for (let i = 0; i < 100; i++) await pressUndo(a.page)
  await expect.poll(() => boxFacts(a.page, X)).toMatchObject({ x: 0 })
  await expect.poll(() => boxFacts(b.page, X)).toMatchObject({ x: 0 })
  await pressUndo(a.page) // the 101st: her create
  await expect.poll(() => boxFacts(a.page, X)).toBeNull()
  await expect.poll(() => boxFacts(b.page, X)).toBeNull()
})

test('undo: typing into an empty note is one undo step (the note comes back empty, then goes)', async ({
  canvasSession,
}) => {
  // KNOWN DEFECT of the web engine's undo (spike-owned canvas/history and the editor lease, reported by
  // 2E at wave 2): after typing "own words" into a note created empty, one undo leaves "o" (the first
  // character is not in the text step) and further undos change nothing, so the note's create is never
  // undone. A note created with text undoes correctly (the step-by-step test above). Acceptance test of
  // the fix: expected to fail until then; delete the next line when it passes.
  test.fail(
    true,
    'known defect: the first character typed into an empty note is not part of the text undo step',
  )
  const a = await canvasSession('alice')
  const n = await createNote(a.page, { x: 100, y: 100 })
  await expectSaved(a.page)
  await startTextEditing(a.page, n)
  await typeText(a.page, 'own words')
  await stopTextEditing(a.page)
  await expectSaved(a.page)
  await pressUndo(a.page)
  await expect.poll(() => labelText(a.page, n), { timeout: 5_000 }).toBeNull()
  await pressUndo(a.page)
  await expect.poll(() => exists(a.page, n), { timeout: 5_000 }).toBe(false)
})

test('undo: a group made with Ctrl/Cmd+G undoes and redoes', async ({ canvasSession }) => {
  // the rule "re-add the group ids an undo removed if that group still exists" (§2.8) must not skip the
  // redo of one's own group, whose members the undo left with no group at all
  const a = await canvasSession('alice')
  await createItem(a.page, 'rectangle', { id: 'grp-1', x: 100, y: 100, width: 100, height: 100 })
  await createItem(a.page, 'rectangle', { id: 'grp-2', x: 300, y: 100, width: 100, height: 100 })
  await expectSaved(a.page)
  await select(a.page, ['grp-1', 'grp-2'])
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+g')
  const groups = async () =>
    Promise.all(['grp-1', 'grp-2'].map((id) => item(a.page, id).then((s) => (s?.groupIds ?? []).length)))
  await expect.poll(groups).toEqual([1, 1])
  await expectSaved(a.page)
  await pressUndo(a.page)
  await expect.poll(groups, { timeout: 5_000 }).toEqual([0, 0])
  await pressRedo(a.page)
  await expect.poll(groups, { timeout: 5_000 }).toEqual([1, 1])
})
