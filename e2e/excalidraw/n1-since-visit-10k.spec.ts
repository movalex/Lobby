// N1 (wave N.1, before CHUNKED_APPLY goes on): N4's "Since your last visit" on the 10k board (./support/big-board.ts)
// opened cold with the chunked install. The visit highlights are computed once, at room ready, and a chunked install
// delivers the room's frames (its `contracts` frame, which marks the room ready) only after its last chunk; on a board
// this large the features also install a frame after the welcome. alice visits the board and leaves; bob adds 2 notes,
// moves 1 and deletes 1; alice comes back on a cold open (`?nocache=1`, CHUNKED_APPLY on for her page): the snapshot
// went in in chunks, the chip says 2 added, 1 changed, 1 removed, and her tab pushes nothing.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n1-since-visit-10k.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { expect, expectSaved, pushedOps, test, updateItem, waitForCanvas } from '../tests/support/canvas.ts'
import { BIG_BOARD_ELEMENTS, seedBigBoard, speedFlags } from './support/big-board.ts'

/** The api writes a person's visit at most once per this long per board (VISIT_WRITE_MIN_INTERVAL_MS). */
const WRITE_INTERVAL_MS = 10_000

/** The page's board is all in: welcomed, no chunk still to go in, Saved, every element of the board in the scene. */
const boardIn = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate((n) => {
          const b = (
            window as unknown as {
              __lobbyBoard?: {
                session: { snapshot: { welcomed: boolean; applying: boolean; save: { state: string } } }
                api: { getSceneElements(): readonly unknown[] }
              }
            }
          ).__lobbyBoard
          const s = b?.session.snapshot
          return !!s && s.welcomed && !s.applying && s.save.state === 'saved' && b.api.getSceneElements().length >= n
        }, BIG_BOARD_ELEMENTS - 1),
      { timeout: 300_000 },
    )
    .toBe(true)

test('N1: since your last visit on the 10k board, opened cold in chunks: 2 added, 1 changed, 1 removed', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(900_000)
  const a = await canvasSession('alice')
  const opened = Date.now()
  const seeded = await seedBigBoard(a.page, board)
  expect(seeded.elements).toBe(BIG_BOARD_ELEMENTS)
  // her next open of this context installs a large snapshot in chunks
  await speedFlags(a.context, { CHUNKED_APPLY: true })
  // she stays past the api's write interval, then leaves (the seen beacon writes the time she left)
  await a.page.waitForTimeout(Math.max(0, opened + WRITE_INTERVAL_MS + 1_500 - Date.now()))
  await a.page.goto('about:blank')
  await a.page.waitForTimeout(1_000)

  const b = await canvasSession('bob')
  await waitForCanvas(b.page, 300_000)
  // a cold open of a board this large goes in in chunks: the whole board first
  await boardIn(b.page)
  // two notes with no arrow on them (a bound arrow's re-snap would be derived anyway): one moves, one goes
  const [moved, gone] = await b.page.evaluate((ids) => {
    const c = (
      window as unknown as {
        __lobbyBoard: {
          canvas: { get(id: string): { boundElements?: { type: string }[] | null } | undefined }
        }
      }
    ).__lobbyBoard.canvas
    return ids.filter((id) => (c.get(id)?.boundElements ?? []).every((x) => x.type === 'text')).slice(-2)
  }, seeded.board.noteIds)
  expect(moved && gone).toBeTruthy()
  await b.page.evaluate(
    ({ gone }) => {
      type Tx = { create(kind: string, props: Record<string, unknown>): string; delete(id: string): void }
      const board = (
        window as unknown as { __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } } }
      ).__lobbyBoard
      board.canvas.transact('n1 bob adds', (tx) => {
        tx.create('note', { id: 'n1sv-new1', x: -2_000, y: -2_000, text: 'Bob’s first' })
        tx.create('note', { id: 'n1sv-new2', x: -1_700, y: -2_000, text: 'Bob’s second' })
      })
      board.canvas.transact('n1 bob deletes', (tx) => tx.delete(gone))
    },
    { gone: gone as string },
  )
  const at = await b.page.evaluate(
    (id) =>
      (
        window as unknown as { __lobbyBoard: { canvas: { get(id: string): { x: number } | undefined } } }
      ).__lobbyBoard.canvas.get(id)?.x ?? 0,
    moved as string,
  )
  await updateItem(b.page, moved as string, { x: at + 40 })
  await expectSaved(b.page)

  // alice comes back: a cold open, installed in chunks
  await a.page.goto(`/b/${board}?nocache=1`)
  await waitForCanvas(a.page, 300_000)
  await boardIn(a.page)
  expect(
    await a.page.evaluate(
      () =>
        (window as unknown as { __lobbyBoard: { core: { resetApply: string | null } } }).__lobbyBoard.core
          .resetApply,
    ),
    'the snapshot went in in chunks',
  ).toBe('chunked')
  const chip = a.page.getByTestId('visits-chip')
  await expect(chip).toBeVisible({ timeout: 60_000 })
  await expect(chip).toHaveAttribute('data-added', '2')
  await expect(chip).toHaveAttribute('data-changed', '1')
  await expect(chip).toHaveAttribute('data-removed', '1')
  // the highlights are up and her tab only received
  await a.page.waitForTimeout(1_500)
  expect(await pushedOps(a.page)).toEqual([])
})
