// Wave J3 (realtime audit), through the real stack:
//  - RT-01: "Sign out everywhere" closes the person's open board sockets on every device, 4099
//    NOT_AUTHENTICATED, at once (the api tells the sync server; the periodic re-check is turned off here so
//    only that push can do it), including a raw socket on a page that runs no Lobby code (a stale or
//    hostile client that ignores the event stream's "session ended"). Nobody else's socket closes, and the
//    person can sign in again on that device and edit at once.
//  - RT-03: during an (anonymous) dot vote, a peer's button is relayed as 'up' and its selection dropped,
//    and the vote's counts move only at the end of a 5 s counting window: a cast shows to nobody before its
//    window is over (the voter's own answer included), whatever they poll.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/realtime-security.spec.ts --project=chromium --workers=1
import type { BrowserContext, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  type CanvasSession,
  canvasCall,
  createItem,
  createNote,
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

const WINDOW_MS = 5_000 // apps/api/src/features/workshops/vote-tally.ts VOTE_TALLY_WINDOW_MS

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

/** The dock's voting panel (as workshops-voting.spec.ts opens it). */
async function openVotingPanel(page: Page) {
  const panel = page.getByTestId('dock-panel-voting')
  if (!(await panel.isVisible())) {
    const toggle = page.getByTestId('dock-rail-toggle')
    if (await toggle.isVisible()) await toggle.click()
    await page.getByTestId('dock-tab-voting').click()
  }
  await expect(panel).toBeVisible()
  return panel
}

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

test('RT-03: during a dot vote no click or selection is relayed, and counts move only when a 5 s window ends', async ({
  board,
  users,
  canvasSession,
}) => {
  test.setTimeout(150_000)
  const alice: CanvasSession = await canvasSession('alice')
  const bob = await canvasSession('bob')
  const carol = await canvasSession('carol', { role: 'viewer' })
  const note = await createNote(alice.page, { x: 0, y: 0, text: 'Idea' })
  await expectSaved(alice.page)
  const bobRaw = (await forgeSession(await barePage(bob.context), board)).socket
  const carolRaw = (await forgeSession(await barePage(carol.context), board)).socket
  const bobSid = `${bob.id}:${bobRaw.tab}`
  const press = (x: number) =>
    bobRaw.send({
      type: 'presence',
      pointer: { x, y: 50 },
      button: 'down',
      sel: [note],
      view: null,
      idle: false,
      editing: null,
    })
  /** What carol's socket was last told about bob's raw cursor once it reached x. */
  const seen = async (x: number) => {
    await expect
      .poll(async () =>
        (await carolRaw.messages()).some(
          (m) => m.type === 'presence' && m.peers.some((p) => p.sid === bobSid && p.pointer?.x === x),
        ),
      )
      .toBe(true)
    const peer = (await carolRaw.messages())
      .flatMap((m) => (m.type === 'presence' ? m.peers : []))
      .filter((p) => p.sid === bobSid && p.pointer?.x === x)
      .at(-1)
    return { button: peer?.button, sel: peer?.sel }
  }

  await press(101)
  expect(await seen(101)).toEqual({ button: 'down', sel: [note] })

  const aliceApi = await users.api('alice')
  const bobApi = await users.api('bob')
  const carolApi = await users.api('carol')
  const started = await aliceApi.fetch('POST', `/api/boards/${board}/votes`, {
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(started.status()).toBe(201)
  const sid = ((await started.json()) as { session: { id: string } }).session.id
  await expect
    .poll(async () => (await carolRaw.messages()).some((m) => m.type === 'workshop' && m.voteOpen))
    .toBe(true)

  // the click on an object, the way a dot is cast: the cursor moves, the button and the selection do not show
  await press(202)
  expect(await seen(202)).toEqual({ button: 'up', sel: null })

  const total = async (api: typeof carolApi) => {
    const r = await api.fetch('GET', `/api/boards/${board}/workshop`)
    expect(r.status()).toBe(200)
    return ((await r.json()) as { vote: { totalVotesCast: number } }).vote.totalVotesCast
  }
  const progress = (await openVotingPanel(alice.page)).getByTestId('vote-progress')
  await expect(progress).toHaveText('Waiting for votes')
  // cast early in a window, so the steps below all happen inside it
  const toNextWindow = WINDOW_MS - (Date.now() % WINDOW_MS) + 300
  await new Promise((r) => setTimeout(r, toNextWindow))
  const castAt = Date.now()
  const windowEnd = Math.floor(castAt / WINDOW_MS) * WINDOW_MS + WINDOW_MS
  const cast = await bobApi.fetch('POST', `/api/votes/${sid}/cast`, { shapeId: `shape:${note}`, delta: 1 })
  expect(cast.status()).toBe(200)
  const mine = (await cast.json()) as { myVotes: Record<string, number>; totalVotesCast: number }
  expect(mine.myVotes).toEqual({ [`shape:${note}`]: 1 })
  expect(mine.totalVotesCast).toBe(0)
  const polled: { at: number; n: number }[] = []
  for (let i = 0; i < 6 && Date.now() < windowEnd - 500; i++) {
    polled.push({ at: Date.now(), n: await total(carolApi) })
    await new Promise((r) => setTimeout(r, 300))
  }
  expect(polled.length).toBeGreaterThan(2)
  expect(polled.every((p) => p.n === 0)).toBe(true)
  await expect.poll(() => total(carolApi), { timeout: 15_000 }).toBe(1)
  expect(Date.now()).toBeGreaterThanOrEqual(windowEnd)
  // the facilitator's progress line catches up through the event stream
  await expect(progress).toContainText('1 vote cast', { timeout: 15_000 })

  // the vote over: the button and the selection are relayed again
  expect((await aliceApi.fetch('POST', `/api/votes/${sid}/close`)).status()).toBe(200)
  await expect
    .poll(async () => (await carolRaw.messages()).some((m) => m.type === 'workshop' && !m.voteOpen))
    .toBe(true)
  await press(303)
  expect(await seen(303)).toEqual({ button: 'down', sel: [note] })
})
