// E2 (wave E; the D2 review of DEF-GAPS-1): the board page keeps ONE board session (socket, engine core,
// offline queue) while the page shell around it re-renders.
//
//  - LobbyBoardShell handed FirstTicket an inline `onAccessLost` arrow, a dependency of FirstTicket's ticket
//    effect: every re-render of the shell (a rename, a role change, a visibility change from the Share
//    dialog) fetched a new ticket, and the new ticket started a new LobbyBoardSession with a new socket on the
//    same canvas. Now the callback is stable (and FirstTicket no longer depends on it): a rename opens no
//    socket and asks for no ticket; a role change reconnects once (the room closes the session that has the
//    old role) and keeps the session.
//  - A guest's offline queue was the session's (memory only, no copy on the device), so a session restart on
//    the same page dropped a guest's unsent changes. It is the page's now (canvas/sync/adapter/offline-guest.ts):
//    a change a guest makes while the session is closed reaches the board after Retry (a new session).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw board-session-stable
import type { BrowserContext, Page } from '@playwright/test'
import {
  createItem,
  createNote,
  expect,
  expectConverged,
  expectSaved,
  item,
  readOnly,
  saveState,
  test,
  updateItem,
  waitForItem,
} from '../tests/support/canvas.ts'
import { signedInContext } from '../tests/support/dashboard-share.ts'
import { createGuestLink, joinAsGuest, waitForLobbyBoard } from './guests-kit.ts'

type BoardWindow = {
  __lobbyBoard?: { session?: Record<string, unknown> & { transport?: { sendRaw(f: string): void } } }
}

/** Board sockets the page opens and tickets it asks for, from now on. */
function watchConnections(page: Page) {
  let sockets = 0
  let tickets = 0
  page.on('websocket', (ws) => {
    if (/\/connect\//.test(ws.url())) sockets++
  })
  page.on('request', (r) => {
    if (r.method() === 'POST' && /^\/api\/boards\/[^/]+\/ticket$/.test(new URL(r.url()).pathname)) tickets++
  })
  return { sockets: () => sockets, tickets: () => tickets }
}

/** Marks the page's current board session (the object), to tell later whether it is still the same one. */
const markSession = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as BoardWindow).__lobbyBoard?.session
    if (!s) throw new Error('no board session (not a dev-auth build?)')
    s.__e2eMark = true
  })
const sameSession = (page: Page) =>
  page.evaluate(() => (window as unknown as BoardWindow).__lobbyBoard?.session?.__e2eMark === true)

/** Long enough for what the old shell did on a re-render: a ticket, a new session and its socket. */
const SETTLE_MS = 2_500

test('a rename re-renders the board shell, not its session: no new ticket, no new socket', async ({
  canvasSession,
}) => {
  const { page } = await canvasSession('alice')
  const note = await createNote(page, { x: 200, y: 160, text: 'Stays put' })
  await expectSaved(page)
  await markSession(page)
  const seen = watchConnections(page)

  await page.getByTestId('board-title').click()
  const input = page.getByTestId('board-title-input')
  await input.fill('Renamed while open')
  await input.press('Enter')
  await expect(page.getByTestId('board-title')).toHaveText('Renamed while open')
  await page.waitForTimeout(SETTLE_MS)

  expect(seen.sockets(), 'board sockets opened after the rename').toBe(0)
  expect(seen.tickets(), 'tickets asked for after the rename').toBe(0)
  expect(await sameSession(page), 'the same board session').toBe(true)
  await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
  // and the session still saves
  await updateItem(page, note, { x: 260 })
  await expectSaved(page)
})

test('a role change reconnects the socket once (the room closes the old role) and keeps the board session', async ({
  canvasSession,
  users,
  board,
}) => {
  const { page } = await canvasSession('bob', { role: 'editor' })
  expect(await readOnly(page)).toBe(false)
  await markSession(page)
  const seen = watchConnections(page)

  await users.grant(board, 'bob', 'viewer')
  await expect.poll(() => readOnly(page), { timeout: 20_000 }).toBe(true)
  await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-role', 'viewer', { timeout: 20_000 })
  await page.waitForTimeout(SETTLE_MS)

  expect(seen.sockets(), 'board sockets opened after the role change').toBe(1)
  expect(await sameSession(page), 'the same board session').toBe(true)
  await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
})

test('a guest’s changes made while the session is closed reach the board after Retry (a new session on the same page)', async ({
  browser,
  board,
}) => {
  const alice = await signedInContext(browser, 'alice')
  const contexts: BrowserContext[] = [alice.context]
  try {
    const a = alice.page
    const link = await createGuestLink(a, board, 'workshop')
    const guest = await joinAsGuest(browser, link, 'Gail')
    contexts.push(guest.context)
    const g = guest.page
    const moved = await createItem(g, 'rectangle', { x: 100, y: 100, width: 120, height: 80 })
    await expectSaved(g)
    await waitForItem(a, moved)

    // the session ends for good: a frame the room refuses (4099 INVALID_MESSAGE), and the page offers Retry
    await g.evaluate(() =>
      (window as unknown as BoardWindow).__lobbyBoard?.session?.transport?.sendRaw(
        '{"type":"not-a-message"}',
      ),
    )
    await expect(g.getByTestId('sync-retry')).toBeVisible({ timeout: 15_000 })

    // the guest keeps working: a move and a new rectangle, unsent (a guest's queue is in this page's memory)
    await updateItem(g, moved, { x: 420 })
    const made = await createItem(g, 'rectangle', { x: 100, y: 420, width: 100, height: 60 })
    await expect.poll(async () => (await saveState(g)).pending).toBeGreaterThan(0)
    await markSession(g)

    // Retry: a new board session (a new socket, engine core and canvas) on the same page
    await g.getByTestId('sync-retry').click()
    await expect(g.getByTestId('sync-retry')).toHaveCount(0)
    await waitForLobbyBoard(g)
    expect(await sameSession(g), 'Retry started a new board session').toBe(false)

    // what the guest did while closed was not lost with the old session
    await expect.poll(async () => Math.round((await item(a, moved))?.x ?? 0), { timeout: 20_000 }).toBe(420)
    await waitForItem(a, made)
    await expectSaved(g)
    await expectConverged(a, [g])
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})
