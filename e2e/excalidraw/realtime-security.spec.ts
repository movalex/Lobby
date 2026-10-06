// Wave J3 (realtime audit), through the real stack:
//  - RT-01: "Sign out everywhere" closes the person's open board sockets on every device, 4099
//    NOT_AUTHENTICATED, at once (the api tells the sync server; the periodic re-check is turned off here so
//    only that push can do it), including a raw socket on a page that runs no Lobby code (a stale or
//    hostile client that ignores the event stream's "session ended"). Nobody else's socket closes, and the
//    person can sign in again on that device and edit at once.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/realtime-security.spec.ts --project=chromium --workers=1
import type { BrowserContext, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  canvasCall,
  createItem,
  expect,
  expectSaved,
  openCanvasSession,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { freshHandle } from '../tests/support/dashboard-share.ts'
import { type ForgeSocket, forgeSession } from '../tests/support/excalidraw.ts'

// Only the api's push may close a socket in this file: no periodic access round during a test.
test.use({ syncEnv: { ACCESS_RECHECK_MS: '600000' } })

/** A page of `context` that runs no Lobby code (a static file of the web origin): it reacts to nothing. */
async function barePage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto('/favicon-32.png')
  return page
}

/** Still open 1.5 s later (a close meanwhile: false). */
const isOpen = (s: ForgeSocket) =>
  Promise.race([
    s.closed().then(
      () => false,
      () => false, // the page went away at the end of the test
    ),
    new Promise<boolean>((r) => setTimeout(() => r(true), 1_500)),
  ])

/** How `s` closed, or 'still open' after `ms`. */
const closedWithin = (s: ForgeSocket, ms: number) =>
  Promise.race([s.closed(), new Promise<'still open'>((r) => setTimeout(() => r('still open'), ms))])

test('RT-01: Sign out everywhere closes the person’s board sockets on every device at once; signing in again works', async ({
  browser,
  board,
  users,
  canvasSession,
}) => {
  test.setTimeout(150_000)
  // a fresh person: signing out everywhere ends every session of theirs, the suite's cached ones too
  const handle = freshHandle('j3-signout')
  const who = await users.grant(board, handle, 'editor')
  const laptop = await openCanvasSession(browser, board, who)
  const phone = await openCanvasSession(browser, board, who)
  const bob = await canvasSession('bob')
  try {
    await createItem(laptop.page, 'rectangle', { id: 'j3-before', x: 40, y: 40, width: 120, height: 80 })
    await expectSaved(laptop.page)
    // a socket on the phone that no Lobby code looks after, and one of bob's
    const phoneRaw = await forgeSession(await barePage(phone.context), board)
    const bobRaw = await forgeSession(await barePage(bob.context), board)

    const res = await laptop.page.evaluate(async () => {
      const r = await fetch('/api/auth/sessions/revoke-all', { method: 'POST', credentials: 'same-origin' })
      return r.status
    })
    expect(res).toBe(200)
    const started = Date.now()
    expect(await closedWithin(phoneRaw.socket, 10_000)).toEqual({ code: 4099, reason: 'NOT_AUTHENTICATED' })
    // the push, not a periodic round (there is none in this file): well under a second on this stack
    expect(Date.now() - started).toBeLessThan(5_000)
    // the CLOSING notice came first (CONTRACTS_REV 9): through an edge that drops close reasons too
    expect(
      (await phoneRaw.socket.messages()).some(
        (m) => m.type === 'notice' && m.code === 'CLOSING' && m.detail === 'NOT_AUTHENTICATED',
      ),
    ).toBe(true)
    // both Lobby tabs end up signed out
    for (const s of [laptop, phone]) await expect(s.page).toHaveURL(/\/signin/, { timeout: 15_000 })
    // bob was never touched
    expect(await isOpen(bobRaw.socket)).toBe(true)
    await createItem(bob.page, 'rectangle', { id: 'j3-bob', x: 240, y: 40, width: 120, height: 80 })
    await expectSaved(bob.page)

    // signing in again on the phone: the board opens, edits save, and a new socket stays open
    await signInContext(phone.context, who.handle, who.name)
    await phone.page.goto(`/b/${board}`)
    await waitForCanvas(phone.page)
    await expect.poll(async () => (await canvasCall(phone.page, 'me'))?.uid).toBe(who.id)
    await createItem(phone.page, 'rectangle', { id: 'j3-after', x: 40, y: 200, width: 120, height: 80 })
    await expectSaved(phone.page)
    const again = await forgeSession(await barePage(phone.context), board)
    expect(await isOpen(again.socket)).toBe(true)
  } finally {
    await Promise.all([laptop.context.close(), phone.context.close()])
  }
})
