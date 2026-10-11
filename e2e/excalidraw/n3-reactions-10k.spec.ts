// OWNER: 3f (workshops; wave N, WS3; N3-1). The reaction overlay on the 10k board (e2e/excalidraw/support/big-board.ts):
// with reactions on a few dozen notes of it, its rows draw, and dragging a reacted note adds no whole-scene walk.
// The page counts every walk of the scene by its site (the dev-only counter, `window.__lobbyWalks`: apps/web/src/
// canvas/sync/walks.ts, WS1's N1-6). The overlay reads the notes that carry a reaction through
// `canvas.index.withLobbyKeyPrefix('react:')` (WS1's incremental index) and never `canvas.items()`. The same drag is
// measured before and after the reactions are written, and the walk table must not grow:
//  - no site but `items` may count a walk at all (an index rebuild per change, the LOD pass, a hit test: a new row);
//  - the `items` reads (the features' own, one row in a production bundle) must not grow with the reactions. An
//    overlay that walked on every change whether or not a note had a reaction is note-reactions.test.ts's check
//    ("never walks the scene"): the bundle does not name which feature read, so this table cannot tell.
//
// Needs WS1's walk counter and index (a branch without the counter skips) and WS2's sync (the reaction key;
// DRAFTROOM_REACTIONS=on).
//
//   cd e2e && E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n3-reactions-10k.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  expect,
  expectSaved,
  itemCenterOnScreen,
  setViewport,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { BIG_BOARD_ELEMENTS, seedBigBoard } from './support/big-board.ts'

test.use({ syncEnv: { DRAFTROOM_REACTIONS: 'on' } })

/** Reacted notes (the first notes of frame 0: the board's densest part, in view at zoom 1 around the first). */
const REACTED = 30

interface Walks {
  perMove: Record<string, number>
  moves: number
}

/** One drag of `id` for about `ms`, with the walk counter reset after the press (the press's own hit test is not a move). */
async function drag(page: Page, id: string, ms: number): Promise<Walks> {
  const c = await itemCenterOnScreen(page, id)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + 5, c.y + 5)
  await page.evaluate(() => {
    const w = window as unknown as { __lobbyWalks?: { reset(): void }; __n3drag?: { moves: number } }
    w.__lobbyWalks?.reset()
    const st = { moves: 0 }
    w.__n3drag = st
    window.addEventListener('pointermove', () => st.moves++, { capture: true })
  })
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < ms) {
    i++
    const a = (i / 30) * Math.PI
    await page.mouse.move(c.x + 5 + 160 * Math.sin(a), c.y + 5 + 90 * Math.sin(a * 1.5))
  }
  await page.mouse.move(c.x + 5, c.y + 5)
  const r = await page.evaluate(() => {
    const w = window as unknown as {
      __lobbyWalks?: { counts(): Record<string, number> }
      __n3drag: { moves: number }
    }
    return { moves: w.__n3drag.moves, walks: w.__lobbyWalks?.counts() ?? {} }
  })
  await page.mouse.up()
  return {
    moves: r.moves,
    perMove: Object.fromEntries(
      Object.entries(r.walks).map(([k, v]) => [k, Math.round((v / Math.max(1, r.moves)) * 1000) / 1000]),
    ),
  }
}

test('N3-1: rows draw on the 10k board and dragging a reacted note adds no whole-scene walk of the overlay’s', async ({
  canvasSession,
  board,
}, testInfo) => {
  test.setTimeout(900_000)
  const a = await canvasSession('alice')
  const seeded = await seedBigBoard(a.page, board)
  expect(seeded.elements).toBe(BIG_BOARD_ELEMENTS)
  await a.page.goto(`/b/${board}?nocache=1`)
  await waitForCanvas(a.page, 300_000)
  await a.page.waitForFunction(
    (n) => {
      const f = (
        window as unknown as { lobbyCanvas?: { items(): unknown[]; saveState(): { state: string } } }
      ).lobbyCanvas
      return !!f && f.items().length >= n && f.saveState().state === 'saved'
    },
    BIG_BOARD_ELEMENTS - 1,
    { timeout: 300_000, polling: 250 },
  )
  const counted = await a.page.evaluate(
    () => typeof (window as unknown as { __lobbyWalks?: unknown }).__lobbyWalks === 'object',
  )
  test.skip(!counted, 'needs the walk counter (WS1, dev-auth builds)')

  const notes = seeded.board.noteIds.slice(0, REACTED)
  const first = notes[0] as string
  const at = await a.page.evaluate(
    (id) =>
      (
        window as unknown as { lobbyCanvas: { bounds(id: string): { x: number; y: number } | null } }
      ).lobbyCanvas.bounds(id),
    first,
  )
  if (!at) throw new Error(`no note ${first}`)
  await setViewport(a.page, { zoom: 1, x: at.x - 300, y: at.y - 200 })
  await expect
    .poll(() =>
      a.page.evaluate(
        () =>
          (
            window as unknown as { __lobbyBoard?: { canvas: { room: { contractsRev(): number | null } } } }
          ).__lobbyBoard?.canvas.room.contractsRev() ?? null,
      ),
    )
    .toBe(13)
  await a.page.waitForTimeout(1_000)

  // before: the same drag with no reaction on the board
  const before = await drag(a.page, first, 2_500)

  // reactions on the first notes, one transact (the person's own keys, never an undo step)
  await a.page.evaluate(
    ([ids, uid]) => {
      const canvas = (
        window as unknown as {
          __lobbyBoard: {
            canvas: {
              transact(
                label: string,
                fn: (tx: { update(id: string, patch: unknown): void }) => void,
                opts: { skipUndo: boolean },
              ): void
            }
          }
        }
      ).__lobbyBoard.canvas
      canvas.transact(
        'e2e: react',
        (tx) => {
          for (const [n, id] of ids.entries())
            tx.update(id, {
              customData: {
                lobby: { [`react:${n % 2 ? 'heart' : 'up'}:${uid}`]: true, [`react:clap:${uid}`]: true },
              },
            })
        },
        { skipUndo: true },
      )
    },
    [notes, a.id] as const,
  )
  await expectSaved(a.page, 120_000)
  const rows = a.page.locator('[data-testid="note-reactions"]')
  await expect.poll(() => rows.count()).toBeGreaterThan(0)
  const drawn = await rows.count()

  const after = await drag(a.page, first, 2_500)
  // the rows were there for the whole drag, and are still
  expect(await rows.count()).toBeGreaterThan(0)

  const sites = [...new Set([...Object.keys(before.perMove), ...Object.keys(after.perMove)])].sort()
  const table = sites.map((site) => ({
    site,
    before: before.perMove[site] ?? 0,
    after: after.perMove[site] ?? 0,
  }))
  const evidence = {
    board: { elements: seeded.elements, reactedNotes: REACTED, rowsDrawn: drawn },
    before,
    after,
    table,
  }
  console.log(`[n3] n3-reactions-10k: ${JSON.stringify(evidence)}`)
  await testInfo.attach('n3-reactions-10k.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
  expect(before.moves, 'the drag moved').toBeGreaterThan(5)
  expect(after.moves, 'the drag moved').toBeGreaterThan(5)
  for (const row of table) {
    // every site of the table: with reactions the walks per move are what they were without (the features' own
    // `items` reads are the board's, and an index build or any canvas-code site would show as a new row)
    expect(row.after, `walks per move at ${row.site}: ${JSON.stringify(table)}`).toBeLessThanOrEqual(
      row.before + 0.5,
    )
  }
  expect(
    table.filter((r) => r.site !== 'items' && r.after > 0),
    'no whole-scene walk by Lobby canvas code or the index while dragging a reacted note',
  ).toEqual([])
})
