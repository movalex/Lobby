// OWNER: 3h. "Recently deleted" on the Excalidraw board page (ported from e2e/tests/history.spec.ts and
// e2e/tests/checkpoints.spec.ts, which keep running on the default tldraw build): what the list shows for
// a frame, a note and a connector deleted with the real keyboard, live in every open panel (a delete by
// anyone, an undo), never a delete the text lease refused or an empty text Excalidraw removed by itself,
// and restoring through the api.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw history-deleted
//
// A restore is the api's server write on an OPEN board, which answers 503 until the room implements
// serverWrite (CR 2F-2, O1): the restore tests are marked test.fail with that CR and turn green (then
// fail as "expected to fail") the day it lands, when the mark must go.
import type { Page } from '@playwright/test'
import {
  canvasCall,
  editingId,
  expect,
  expectSaved,
  setTool,
  startTextEditing,
  test,
  typeText,
} from '../tests/support/canvas.ts'
import { deletedRow, historyPanel, listDeleted, openHistory } from '../tests/support/history.ts'
import { emptyCanvasPoint, focusBoard } from './board-kit.ts'
import {
  boundEnds,
  deleteTogether,
  deleteWithKeyboard,
  drawFrameBoard,
  labelOf,
  onBoard,
  placement,
  putNote,
  ref,
  serverElements,
  undoWithKeyboard,
} from './history-kit.ts'

const CR_2F_2 = 'CR 2F-2: a restore on an open board answers 503 until the room has serverWrite'

const selectedIds = async (page: Page) => ((await canvasCall(page, 'selection')) as string[]).sort()

test('recently deleted frame: one row for the frame and its 2 notes, deleted by alice, live in bob’s panel; the connector lost its note end', async ({
  canvasSession,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const bobApi = await users.api('bob')
  const ids = await drawFrameBoard(a.page, 'rd')
  await expect.poll(() => boundEnds(b.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
  await openHistory(a.page)
  await openHistory(b.page)
  await expect(historyPanel(b.page)).toContainText('Nothing deleted recently.')

  // the frame with what is in it, in one step (Excalidraw's own Delete on a frame keeps its children)
  await deleteTogether(a.page, [ids.frame, ids.note1, ids.note2])
  await test.step('the frame and its notes are gone for both; the connector lost its note end', async () => {
    for (const s of [a, b]) {
      for (const id of [ids.frame, ids.note1, ids.note2])
        await expect.poll(() => onBoard(s.page, id)).toBe(false)
      await expect.poll(() => boundEnds(s.page, ids.arrow)).toEqual([`end->${ids.box}`])
    }
  })

  await test.step('bob’s panel lists one row: the frame, “2 objects inside”, deleted by alice', async () => {
    const row = deletedRow(b.page, ref(ids.frame))
    await expect(row).toContainText('Sprint ideas')
    await expect(row).toContainText('Frame · 2 objects inside')
    await expect(row).toContainText(`deleted by ${a.name}`)
    await expect(deletedRow(b.page)).toHaveCount(1)
    expect((await listDeleted(bobApi, board)).entries).toEqual([
      expect.objectContaining({
        shapeId: ref(ids.frame),
        type: 'frame',
        label: 'Sprint ideas',
        childCount: 2,
        deletedBy: { id: a.id, name: a.name },
      }),
    ])
  })
})

test('recently deleted note and connector: deleted together by alice, listed by kind and text for bob, who selects both', async ({
  canvasSession,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const bobApi = await users.api('bob')
  const ids = await drawFrameBoard(a.page, 'nc')
  await openHistory(a.page)
  await openHistory(b.page)
  await deleteWithKeyboard(a.page, [ids.note1, ids.arrow])
  await expect.poll(() => onBoard(b.page, ids.arrow)).toBe(false)

  await test.step('bob sees both rows: the note by its text, the connector by its kind', async () => {
    await expect(deletedRow(b.page, ref(ids.note1))).toContainText('Ship the moodboard')
    await expect(deletedRow(b.page, ref(ids.note1))).toContainText('Sticky note')
    await expect(deletedRow(b.page, ref(ids.arrow))).toContainText('Connector')
    await expect(deletedRow(b.page)).toHaveCount(2)
    expect(
      (await listDeleted(bobApi, board)).entries.map((e) => [e.shapeId, e.type, e.deletedBy.id]).sort(),
    ).toEqual(
      [
        [ref(ids.arrow), 'arrow', a.id],
        [ref(ids.note1), 'note', a.id],
      ].sort(),
    )
  })

  await test.step('bob ticks both rows: the bulk restore button counts them', async () => {
    await expect(b.page.getByTestId('deleted-restore-selected')).toHaveCount(0)
    await deletedRow(b.page, ref(ids.note1)).getByTestId('deleted-select').check()
    await expect(b.page.getByTestId('deleted-restore-selected')).toHaveText('Restore 1 selected object')
    await deletedRow(b.page, ref(ids.arrow)).getByTestId('deleted-select').check()
    await expect(b.page.getByTestId('deleted-restore-selected')).toHaveText('Restore 2 selected objects')
  })
})

test('live list: bob’s delete appears in alice’s open panel within about 2 s and his undo removes it; a delete refused by the text lease is never listed', async ({
  canvasSession,
  board,
  users,
}) => {
  const GONE = 'live-gone'
  const LEASED = 'live-leased'
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const aliceApi = await users.api('alice')
  await putNote(a.page, GONE, 'Bob removes this', 100, 120)
  await putNote(a.page, LEASED, 'Alice types here', 380, 120)
  await expect.poll(() => labelOf(b.page, LEASED)).toBe('Alice types here')
  await openHistory(a.page)
  await expect(historyPanel(a.page)).toContainText('Nothing deleted recently.')

  await test.step('bob deletes a note: alice’s panel gains the row within about 2 s', async () => {
    await deleteWithKeyboard(b.page, [GONE])
    const t0 = Date.now()
    await expect(deletedRow(a.page, ref(GONE))).toBeVisible({ timeout: 2_500 })
    test.info().annotations.push({ type: 'row appeared after (ms)', description: String(Date.now() - t0) })
    await expect(deletedRow(a.page, ref(GONE))).toContainText(`deleted by ${b.name}`)
  })

  await test.step('bob’s Ctrl+Z brings it back, and the row leaves alice’s panel', async () => {
    await expectSaved(b.page)
    await undoWithKeyboard(b.page)
    await expect.poll(() => onBoard(a.page, GONE)).toBe(true)
    const t0 = Date.now()
    await expect(deletedRow(a.page, ref(GONE))).toHaveCount(0, { timeout: 2_500 })
    test.info().annotations.push({ type: 'row left after (ms)', description: String(Date.now() - t0) })
    expect((await listDeleted(aliceApi, board)).entries).toEqual([])
  })

  await test.step('a delete the text lease refuses is not listed', async () => {
    await startTextEditing(a.page, LEASED)
    await typeText(a.page, ' now')
    await expect.poll(() => canvasCall(b.page, 'leaseHolder', LEASED)).not.toBeNull()
    await focusBoard(b.page)
    await canvasCall(b.page, 'select', [LEASED])
    await b.page.keyboard.press('Delete')
    // The note stays (the board refuses a delete while someone types in it): nothing to list.
    await b.page.waitForTimeout(1_000)
    await expect.poll(() => onBoard(b.page, LEASED)).toBe(true)
    expect(await onBoard(a.page, LEASED)).toBe(true)
    expect((await listDeleted(aliceApi, board)).entries).toEqual([])
    await openHistory(b.page)
    await expect(historyPanel(b.page)).toContainText('Nothing deleted recently.')
    await expect(deletedRow(a.page)).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
  })
})

test('Recently deleted: an empty text box that Excalidraw removes by itself is not listed as someone’s deletion (R17)', async ({
  canvasSession,
  board,
  users,
}) => {
  const NOTE = 'r17-parking'
  const aliceApi = await users.api('alice')
  const alice = await canvasSession('alice')
  const bob = await canvasSession('bob', { role: 'editor' })
  await openHistory(alice.page)
  await expect(historyPanel(alice.page)).toContainText('Nothing deleted recently.')
  // Bob clicks the canvas with the Text tool, types nothing, and presses Escape.
  expect(await setTool(bob.page, 'text')).toBe(true)
  const spot = await emptyCanvasPoint(bob.page)
  await bob.page.mouse.click(spot.x, spot.y)
  await expect.poll(() => editingId(bob.page)).not.toBeNull()
  await bob.page.keyboard.press('Escape')
  await expect.poll(() => editingId(bob.page)).toBeNull()
  // (the text tool stays on after an empty text: back to selecting)
  expect(await setTool(bob.page, 'select')).toBe(true)
  // ...and a real deletion right after is listed, while the empty text box never is.
  await putNote(bob.page, NOTE, 'Parking lot')
  await expect.poll(() => onBoard(alice.page, NOTE)).toBe(true)
  await deleteWithKeyboard(bob.page, [NOTE])
  await expect(alice.page.getByTestId('deleted-row')).toHaveCount(1)
  await expect(alice.page.getByTestId('deleted-row')).toHaveAttribute('data-shape-id', ref(NOTE))
  await expect(alice.page.getByTestId('deleted-row')).toContainText(`deleted by ${bob.name}`)
  expect((await listDeleted(aliceApi, board)).entries.map((e) => e.shapeId)).toEqual([ref(NOTE)])
})

test('restoring a deleted frame puts its 2 notes back in place inside it, re-binds the connector and selects the frame, for bob too (CR 2F-2)', async ({
  canvasSession,
  board,
  users,
  stack,
}) => {
  test.fail(true, CR_2F_2)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const bobApi = await users.api('bob')
  const ids = await drawFrameBoard(a.page, 'rf')
  const before = {
    frame: await placement(a.page, ids.frame),
    note1: await placement(a.page, ids.note1),
    note2: await placement(a.page, ids.note2),
  }
  const bound = [`end->${ids.box}`, `start->${ids.note1}`]
  await openHistory(a.page)
  await openHistory(b.page)
  await deleteTogether(a.page, [ids.frame, ids.note1, ids.note2])
  await expect(deletedRow(a.page, ref(ids.frame))).toBeVisible()
  await deletedRow(a.page, ref(ids.frame)).getByTestId('deleted-restore').click()
  await expect(a.page.getByTestId('history-status')).toHaveText(
    'Restored 3 objects, reconnected 1 connection.',
  )
  for (const s of [a, b]) {
    await expect.poll(() => placement(s.page, ids.frame)).toEqual(before.frame)
    await expect.poll(() => placement(s.page, ids.note1)).toEqual(before.note1)
    await expect.poll(() => placement(s.page, ids.note2)).toEqual(before.note2)
    await expect.poll(() => boundEnds(s.page, ids.arrow)).toEqual(bound)
    await expect(deletedRow(s.page)).toHaveCount(0)
  }
  expect((await serverElements(stack, board)).map((e) => e.id)).toContain(ids.note1)
  expect((await listDeleted(bobApi, board)).entries).toEqual([])
  await expect.poll(() => selectedIds(a.page)).toEqual([ids.frame])
})

test('restoring a note and a connector together (bob, multi-select) puts them back in the frame, bound for both (CR 2F-2)', async ({
  canvasSession,
  board,
  users,
}) => {
  test.fail(true, CR_2F_2)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const bobApi = await users.api('bob')
  const ids = await drawFrameBoard(a.page, 'rn')
  const before = { note1: await placement(a.page, ids.note1), arrow: await placement(a.page, ids.arrow) }
  await openHistory(b.page)
  await deleteWithKeyboard(a.page, [ids.note1, ids.arrow])
  await deletedRow(b.page, ref(ids.note1)).getByTestId('deleted-select').check()
  await deletedRow(b.page, ref(ids.arrow)).getByTestId('deleted-select').check()
  await b.page.getByTestId('deleted-restore-selected').click()
  await expect(b.page.getByTestId('history-status')).toHaveText(
    'Restored 2 objects, reconnected 2 connections.',
  )
  for (const s of [a, b]) {
    await expect.poll(() => placement(s.page, ids.note1)).toEqual(before.note1)
    await expect.poll(() => placement(s.page, ids.arrow)).toEqual(before.arrow)
    await expect.poll(() => boundEnds(s.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
  }
  await expect.poll(() => selectedIds(b.page)).toEqual([ids.arrow, ids.note1].sort())
  expect((await listDeleted(bobApi, board)).entries).toEqual([])
})

test('restoring a note whose frame is gone puts it on the board where it was and reconnects its connector; the frame comes back without it (CR 2F-2)', async ({
  canvasSession,
}) => {
  test.fail(true, CR_2F_2)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const ids = await drawFrameBoard(a.page, 'rg')
  const at = await placement(a.page, ids.note1)
  const note2 = await placement(a.page, ids.note2)
  await openHistory(a.page)
  await openHistory(b.page)
  await deleteWithKeyboard(a.page, [ids.note1])
  await expect(deletedRow(b.page, ref(ids.note1))).toBeVisible()
  await deleteTogether(a.page, [ids.frame, ids.note2])
  await expect(deletedRow(b.page, ref(ids.frame))).toContainText('Frame · 1 object inside')
  await deletedRow(b.page, ref(ids.note1)).getByTestId('deleted-restore').click()
  await expect(b.page.getByTestId('history-status')).toHaveText(
    'Restored 1 object, reconnected 1 connection, 1 object placed on the board (the frame is gone).',
  )
  for (const s of [a, b])
    await expect.poll(() => placement(s.page, ids.note1)).toEqual({ frameId: null, x: at?.x, y: at?.y })
  await deletedRow(a.page, ref(ids.frame)).getByTestId('deleted-restore').click()
  await expect(a.page.getByTestId('history-status')).toHaveText('Restored 2 objects.')
  for (const s of [a, b]) await expect.poll(() => placement(s.page, ids.note2)).toEqual(note2)
})
