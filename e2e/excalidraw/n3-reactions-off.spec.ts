// OWNER: 3f (workshops; wave N, WS3; N3-2). The kill switch, DRAFTROOM_REACTIONS=off (the sync's default: fail-closed).
//
//  1. The room says contracts 12 while it is off (apps/sync config.ts parseReactions), so the page offers reacting
//     nowhere: no row, no bar button, no menu entry, the palette says why, nothing is pushed or stored.
//  2. The refusal path, in a real browser against the real room: a tab that believes the room says 13 (its `contracts`
//     frame is rewritten on the way, as a tab connected before the room restarted with the switch off would) reacts and
//     the room refuses the write UNAVAILABLE. That code is retryable, so the engine would retry for ever; the second
//     answer is read as the switch: the person is told "Reactions are switched off right now", the key goes back to the
//     server's value (the chip is gone), the retries stop (the page returns to Saved) and nothing is stored. Another tab
//     never sees it.
//
//  3. The guard (mountReactionGuard), for what the watch cannot reach: a reaction written to the off room by a way
//     nothing watches (through the port), and a page reloaded with such a write still in its offline queue. The room
//     that says 12 gets every unconfirmed reaction put back, the person is told, the page returns to Saved and nothing
//     is stored. (Before the guard both stayed on "Can't save right now" for ever, with the reaction held locally.)
//
//   cd e2e && E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n3-reactions-off.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { CONNECT_URL } from '../spike-b/support/relay.ts'
import { expectSaved, itemCenterOnScreen, saveState, select } from '../tests/support/canvas.ts'
import { storedElement } from '../tests/support/excalidraw.ts'
import {
  expect,
  expectItemsEverywhere,
  hoverNote,
  reactionChip,
  reactionRow,
  reactionsIn,
  reactionsOfElement,
  reactWithMouse,
  seed,
  showAll,
  test,
  waitForWorkshopBoard,
} from './workshops-kit.ts'

test.use({ syncEnv: { DRAFTROOM_REACTIONS: 'off' } })

const N = 'n3off-note'

test('off: the room says 12, so no reaction UI shows anywhere, the palette says why, and nothing is pushed', async ({
  join,
}) => {
  const a = await join('alice')
  await seed(a.page, { notes: [{ id: N, x: 40, y: 60, text: 'Warm-up game' }] })
  await expectItemsEverywhere([a], [N])
  await showAll(a.page)
  await expect
    .poll(() =>
      a.page.evaluate(() =>
        (
          window as unknown as { __lobbyBoard: { canvas: { room: { contractsRev(): number | null } } } }
        ).__lobbyBoard.canvas.room.contractsRev(),
      ),
    )
    .toBe(12)
  await hoverNote(a.page, N)
  await select(a.page, [N])
  await expect(a.page.getByTestId('selection-bar')).toBeVisible()
  await a.page.waitForTimeout(500)
  await expect(a.page.getByTestId('note-reactions-layer')).toHaveCount(0)
  await expect(a.page.getByTestId('selection-reactions')).toHaveCount(0)
  const at = await itemCenterOnScreen(a.page, N)
  await a.page.mouse.click(at.x, at.y, { button: 'right' })
  await expect(a.page.getByTestId('context-menu')).toBeVisible()
  await expect(a.page.getByTestId('context-menu.reactions-react')).toHaveCount(0)
  await a.page.keyboard.press('Escape')
  await a.page.keyboard.press('ControlOrMeta+k')
  await a.page.getByTestId('command-palette-input').fill('React to a note')
  await expect(a.page.getByText('Reactions are not available on this board yet')).toBeVisible()
  await a.page.keyboard.press('Escape')
  expect(
    a.net
      .sentPushes()
      .flatMap((p) => p.ops)
      .filter((op) => Object.keys(op.c ?? {}).some((k) => k.startsWith('react:'))),
  ).toEqual([])
})

test('a tab that believes the room takes reactions: the refusal is told once, the key goes back, nothing is stored', async ({
  join,
  board,
  stack,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: [{ id: N, x: 40, y: 60, text: 'Warm-up game' }] })
  await expectItemsEverywhere([b], [N])
  // bob's board socket says 13 (the real room, which is off, says 12): what a tab connected before the switch went off sees
  await b.context.routeWebSocket(CONNECT_URL, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      if (typeof m === 'string' && m.startsWith('{"type":"contracts"'))
        ws.send(JSON.stringify({ type: 'contracts', rev: 13 }))
      else ws.send(m)
    })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
  })
  await b.page.reload()
  await waitForWorkshopBoard(b.page)
  await expectItemsEverywhere([b], [N])
  for (const s of [a, b]) await showAll(s.page)
  await expect
    .poll(() =>
      b.page.evaluate(() =>
        (
          window as unknown as { __lobbyBoard: { canvas: { room: { contractsRev(): number | null } } } }
        ).__lobbyBoard.canvas.room.contractsRev(),
      ),
    )
    .toBe(13)

  await reactWithMouse(b.page, N, 'up')
  // the engine retries UNAVAILABLE; the second answer is read as the switch: the person is told
  await expect(b.page.getByTestId('reaction-toast')).toContainText('Reactions are switched off right now', {
    timeout: 20_000,
  })
  // the key is the server's value again (it never had it): no chip, and the page settles (no retry loop left)
  await expect(reactionRow(b.page, N).getByTestId('note-reaction')).toHaveCount(0)
  await expectSaved(b.page)
  expect(reactionsOfElement(await storedElement(stack, board, N))).toEqual({})
  // the other tab saw nothing at any point
  await expect(reactionRow(a.page, N)).toHaveCount(0)

  // asking again is told again, and still nothing is stored
  await b.page.getByTestId('reaction-toast').waitFor({ state: 'detached', timeout: 20_000 })
  await reactWithMouse(b.page, N, 'heart')
  await expect(b.page.getByTestId('reaction-toast')).toContainText('Reactions are switched off right now', {
    timeout: 20_000,
  })
  await expect(reactionChip(b.page, N, 'heart')).toHaveCount(0)
  await expectSaved(b.page)
  expect(reactionsOfElement(await storedElement(stack, board, N))).toEqual({})
})

// ---- the guard ----------------------------------------------------------------------------------------------------

/** A reaction written the way nothing watches: straight through the port (a skipUndo transact of the person's own key). */
const writeThroughPort = (page: Page, id: string, key: string, on: boolean) =>
  page.evaluate(
    ([noteId, k, value]) =>
      (
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
      ).__lobbyBoard.canvas.transact(
        'e2e: react',
        (tx) =>
          tx.update(noteId as string, { customData: { lobby: { [k as string]: value ? true : null } } }),
        { skipUndo: true },
      ),
    [id, key, on] as const,
  )

const roomRev = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __lobbyBoard: { canvas: { room: { contractsRev(): number | null } } } }
    ).__lobbyBoard.canvas.room.contractsRev(),
  )

test('a reaction that reaches the off room by a way nothing watches is put back all the same: told, Saved, nothing stored', async ({
  join,
  board,
  stack,
}) => {
  const a = await join('alice')
  await seed(a.page, { notes: [{ id: N, x: 40, y: 60, text: 'Warm-up game' }] })
  await expectItemsEverywhere([a], [N])
  await expectSaved(a.page)
  await expect.poll(() => roomRev(a.page)).toBe(12)

  await writeThroughPort(a.page, N, `react:up:${a.id}`, true)
  // the room refuses it UNAVAILABLE, which the engine retries for ever; the guard puts the key back
  await expect(a.page.getByTestId('reaction-toast')).toContainText('Reactions are switched off right now', {
    timeout: 20_000,
  })
  await expectSaved(a.page)
  expect(await reactionsIn(a.page, N)).toEqual({})
  expect(reactionsOfElement(await storedElement(stack, board, N))).toEqual({})
  expect(
    a.net.sentPushes().filter((p) => p.ops.some((op) => `react:up:${a.id}` in (op.c ?? {}))).length,
  ).toBeLessThan(4)
})

test('a page reloaded with the write still in its offline queue: the room that is off puts it back at its frame', async ({
  join,
  board,
  stack,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: [{ id: N, x: 40, y: 60, text: 'Warm-up game' }] })
  await expectItemsEverywhere([b], [N])
  // bob's socket says 13 while `rewrite` holds (a tab connected before the room restarted with the switch off), so
  // nothing on his page treats the room as closed and the write below is left to retry
  let rewrite = true
  await b.context.routeWebSocket(CONNECT_URL, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      if (rewrite && typeof m === 'string' && m.startsWith('{"type":"contracts"'))
        ws.send(JSON.stringify({ type: 'contracts', rev: 13 }))
      else ws.send(m)
    })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
  })
  await b.page.reload()
  await waitForWorkshopBoard(b.page)
  await expectItemsEverywhere([b], [N])
  await expect.poll(() => roomRev(b.page)).toBe(13)

  const key = `react:up:${b.id}`
  await writeThroughPort(b.page, N, key, true)
  // the room refuses it; with the room read as 13 nobody puts it back: the page sits on its retry, the write queued
  await expect.poll(async () => (await saveState(b.page)).state).not.toBe('saved')
  await b.page.waitForTimeout(2_000) // the offline queue is written a moment after the change
  expect(Object.keys(await reactionsIn(b.page, N))).toEqual(['up'])

  // the page is reloaded and talks to the room as it is: 12
  rewrite = false
  await b.page.reload()
  await waitForWorkshopBoard(b.page)
  await expect.poll(() => roomRev(b.page)).toBe(12)
  await expectSaved(b.page)
  expect(await reactionsIn(b.page, N)).toEqual({})
  expect(reactionsOfElement(await storedElement(stack, board, N))).toEqual({})
  // and the other tab never had it
  expect(await reactionsIn(a.page, N)).toEqual({})
})
