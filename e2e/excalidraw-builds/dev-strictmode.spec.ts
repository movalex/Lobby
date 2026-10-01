// LEAD-1 (docs/EXCALIDRAW-CUTOVER.md, the lead's wave-4 findings): under `vite dev` React StrictMode runs
// every effect's cleanup once right after mount and the effect again. The board session used to be made in
// render and disposed by that cleanup for good (its transport closed, 0 attempts), so the page stayed at
// "Connecting to board…". Now each effect run owns one session, and the remount reconnects.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw:dev
import { signInContext } from '../tests/support/api.ts'
import { createNote, expect, expectSaved, test, waitForCanvas, waitForItem } from '../tests/support/canvas.ts'

interface DevHandle {
  session: { transport: { attempts: number; state: string } }
}

test('vite dev (StrictMode): the board connects and edits are Saved; the live session opened its socket once', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    await page.goto(`/b/${board}`)
    // the first request compiles the board page and pre-bundles the engine: give the dev server time
    const lobbyBoard = page.getByTestId('lobby-board')
    await expect(lobbyBoard).toBeAttached({ timeout: 180_000 })
    await expect(lobbyBoard).toHaveAttribute('data-engine', 'excalidraw')
    // before the fix: data-phase stayed "connecting" and the facade never reported ready
    await waitForCanvas(page, 60_000)
    await expect(lobbyBoard).toHaveAttribute('data-phase', 'ready')
    await expect(page.getByTestId('sync-loading')).toHaveCount(0)
    await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
    // StrictMode's first session was disposed; the live one opened exactly one socket
    const transport = await page.evaluate(() => {
      const h = (window as unknown as { __lobbyBoard?: DevHandle }).__lobbyBoard
      if (!h) throw new Error('no window.__lobbyBoard (the dev build exposes it)')
      return { attempts: h.session.transport.attempts, state: h.session.transport.state }
    })
    expect(transport).toEqual({ attempts: 1, state: 'open' })

    const id = await createNote(page, { x: 120, y: 120, text: 'Made under vite dev' })
    await expectSaved(page)
    await page.reload()
    await expect(lobbyBoard).toBeAttached({ timeout: 60_000 })
    await waitForCanvas(page, 60_000)
    await waitForItem(page, id)
    await expect(lobbyBoard).toHaveAttribute('data-phase', 'ready')
  } finally {
    await context.close()
  }
})
