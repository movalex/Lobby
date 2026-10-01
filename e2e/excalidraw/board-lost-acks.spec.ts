// The verifier V1's re-check of spike B's lost-ack fix (beff59d), on Lobby's board page (wave 5, 2C):
//
//  - P1: keys typed into a note whose lease is not granted yet are unsent text, so the page never shows
//    Saved meanwhile (the spike page had this; the board page did not call holdSaved);
//  - P12 / R4: a move whose push reached the server but whose ack had not, when the page reloads, is not
//    replayed over another person's later move: the reloaded page decides the queued push as a lost push;
//  - P13 / R5: the same for a create another person deleted meanwhile: it is not revived.
//
// The server's test snapshot is the truth (the sync server runs with test hooks on these stacks).

import { setLatency } from '../spike-b/support/relay.ts'
import {
  createItem,
  createNote,
  dblclickItem,
  expect,
  expectSaved,
  item,
  itemText,
  saveState,
  test,
  updateItem,
  waitForCanvas,
  waitForItem,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { leaseHook, openRelayedCanvasSession, storedElement } from '../tests/support/excalidraw.ts'
import { focusBoard, settled } from './board-kit.ts'
import { waitForCanvasUx } from './canvas-ux-kit.ts'

test('P1: keys typed while the note’s lease is still pending keep Saved away; they land once it is granted', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  // a note on the server (a new note's own editor opens at once: the New element rule)
  const note = await settled(a.page, createNote(a.page, { x: 200, y: 200, text: '' }))
  await leaseHook(stack, board, { mode: 'hold' })
  try {
    await focusBoard(a.page)
    await dblclickItem(a.page, note)
    // the editor waits for the held grant
    await expect
      .poll(() =>
        a.page.evaluate(
          () =>
            (window as unknown as { __lobbyBoard: { input: { editorLease: { phase: string } | null } } })
              .__lobbyBoard.input.editorLease?.phase ?? null,
        ),
      )
      .toBe('pending')
    await a.page.keyboard.type('abc')
    const states: string[] = []
    for (let i = 0; i < 12; i++) {
      states.push((await saveState(a.page)).state)
      await a.page.waitForTimeout(100)
    }
    expect(states.filter((s) => s === 'saved')).toEqual([])
  } finally {
    await leaseHook(stack, board, { mode: 'release' })
    await leaseHook(stack, board, { mode: 'off' })
  }
  await waitForTextEditor(a.page, note)
  await expect.poll(() => itemText(a.page, note)).toBe('abc')
  await a.page.keyboard.press('Escape')
  await expectSaved(a.page)
})

test('P12 / R4: a move that reached the server but not its ack, then the page reloads: another person’s later move is kept', async ({
  browser,
  canvasSession,
  stack,
  board,
  users,
}) => {
  test.setTimeout(120_000)
  const a = await openRelayedCanvasSession(browser, board, await users.get('alice'))
  try {
    const b = await canvasSession('bob')
    const x = await settled(a.page, createItem(a.page, 'rectangle', { x: 0, y: 0, width: 100, height: 100 }))
    await waitForItem(b.page, x)
    // 3 s round trips: the push reaches the server after 1.5 s, its ack would come 1.5 s later
    setLatency(a.page, 3_000)
    await updateItem(a.page, x, { x: 111 })
    await expect.poll(async () => (await storedElement(stack, board, x))?.x, { timeout: 10_000 }).toBe(111)
    // bob moves it after (Saved), before alice's ack
    await waitForItem(b.page, x, (e) => e.x === 111)
    await updateItem(b.page, x, { x: 222 })
    await expectSaved(b.page)
    expect((await storedElement(stack, board, x))?.x).toBe(222)
    // alice's page reloads with her ack still on its way (the queue keeps the push)
    await a.page.reload()
    setLatency(a.page, 0)
    await waitForCanvas(a.page)
    await expectSaved(a.page, 30_000)
    await a.page.waitForTimeout(500)
    expect((await storedElement(stack, board, x))?.x).toBe(222)
    expect((await item(a.page, x))?.x).toBe(222)
    await expect.poll(async () => (await item(b.page, x))?.x).toBe(222)
  } finally {
    await a.context.close()
  }
})

test('P13 / R5: a create that reached the server but not its ack, then the page reloads: another person’s delete is kept', async ({
  browser,
  canvasSession,
  stack,
  board,
  users,
}) => {
  test.setTimeout(120_000)
  const a = await openRelayedCanvasSession(browser, board, await users.get('alice'))
  try {
    const b = await canvasSession('bob')
    await expectSaved(a.page)
    setLatency(a.page, 3_000)
    const m = await createItem(a.page, 'rectangle', { x: 40, y: 40, width: 100, height: 100 })
    await expect.poll(async () => !!(await storedElement(stack, board, m)), { timeout: 10_000 }).toBe(true)
    await waitForItem(b.page, m)
    await b.page.evaluate(
      (id) =>
        (
          window as unknown as {
            __lobbyBoard: {
              canvas: { transact(l: string, f: (tx: { delete(id: string): void }) => void): void }
            }
          }
        ).__lobbyBoard.canvas.transact('delete', (tx) => tx.delete(id)),
      m,
    )
    await expectSaved(b.page)
    expect((await storedElement(stack, board, m))?.isDeleted).toBe(true)
    await a.page.reload()
    setLatency(a.page, 0)
    await waitForCanvas(a.page)
    await expectSaved(a.page, 30_000)
    await a.page.waitForTimeout(500)
    expect((await storedElement(stack, board, m))?.isDeleted).toBe(true)
  } finally {
    await a.context.close()
  }
})
