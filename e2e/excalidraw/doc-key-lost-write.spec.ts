// The board document's lost-write rule in a browser (FACADE-setDoc, wave C; the Node twin is
// apps/web/src/canvas/sync/core/w4c-fixes.test.ts, the verifier V1's round-6 case DB1, W4C-2C-1).
//
// Two writes of one board-document key (a tag definition here; the workshop settings and the start view are
// the same shape) within one round trip go out as two pushes built at the same base clock: the client's
// clock only moves on `changes`, welcome and snapshot. The first lands and is acked; the socket drops before
// the second reaches the room; nobody else writes. The rule once read the first write's own landing as
// another person's write: the second write was dropped, the local value went back, and the page said
// "Someone else changed a board setting you edited while you were reconnecting" with nobody else on the board.
//
// The tab's uplink is slow and the downlink is not (a relay of its own below: the spike-b relay delays both
// ways alike, and the case needs the ack to be home before the second push has left the machine's queue).
// The cut is made by the relay the moment the first push's ack comes down, and the second push, still in the
// uplink's queue, never reaches the room. The facade's `setDoc` makes the writes (the features' own path),
// `getDoc` reads them, a second person's tab and a fresh one say what is stored.
import type { Browser, Page } from '@playwright/test'
import { CONNECT_URL } from '../spike-b/support/relay.ts'
import { signInContext } from '../tests/support/api.ts'
import {
  type CanvasSession,
  canvasCall,
  expect,
  expectSaved,
  getDoc,
  saveState,
  setDoc,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import type { TestUser } from '../tests/support/users.ts'

const KEY = 'tagDef:topic'
const tag = (color: string) => ({ name: 'topic', color })
const green = tag('green')
const red = tag('red')
const blue = tag('blue')
const theirs = tag('light-blue') // bob's write in the third case

// ---- an uplink that is slow in one direction and can be cut ------------------------------------------------

interface Uplink {
  /**
   * From now on this page's frames to the server wait `upMs` (order kept). With `cutAfterAckMs`, the first
   * `ack` that comes down cuts the socket that many ms after it was delivered.
   */
  arm(o: { upMs: number; cutAfterAckMs?: number }): void
  /** Closes the live socket on both sides now (the page sees 1012, as after a server restart). */
  cut(): void
  /** Pushes the page sent that the cut dropped before they left, pushes that left, and the cuts made. */
  readonly stats: { dropped: number; cuts: number; sent: number }
}

/**
 * Routes the page's board socket (install before the page opens the board). A socket opened while the uplink
 * is not armed passes straight through, which is every reconnect after a cut.
 */
async function slowUplink(page: Page): Promise<Uplink> {
  const stats = { dropped: 0, cuts: 0, sent: 0 }
  const live = new Set<{ cut(): void }>()
  let upMs = 0
  let cutAfterAckMs: number | null = null
  await page.routeWebSocket(CONNECT_URL, (ws) => {
    const server = ws.connectToServer()
    let open = true
    let lastAt = 0
    // frames waiting in the uplink, and whether each is a push (presence frames wait too)
    const timers = new Map<ReturnType<typeof setTimeout>, boolean>()
    const conn = {
      cut() {
        if (!open) return
        open = false
        for (const t of timers.keys()) clearTimeout(t)
        stats.dropped += [...timers.values()].filter(Boolean).length
        timers.clear()
        stats.cuts++
        upMs = 0
        cutAfterAckMs = null
        live.delete(conn)
        try {
          ws.close({ code: 1012, reason: 'doc-key-lost-write cut' })
        } catch {
          // already closed
        }
        try {
          server.close()
        } catch {
          // already closed
        }
      },
    }
    live.add(conn)
    ws.onMessage((m) => {
      if (upMs <= 0) return void server.send(m)
      // every frame waits the same, so the timers fire in the order the frames were sent
      const at = Math.max(Date.now() + upMs, lastAt)
      lastAt = at
      const isPush = typeof m === 'string' && frameType(m) === 'push'
      const t = setTimeout(() => {
        timers.delete(t)
        if (!open) return
        if (isPush) stats.sent++
        server.send(m)
      }, at - Date.now())
      timers.set(t, isPush)
    })
    server.onMessage((m) => {
      if (open) ws.send(m)
      if (cutAfterAckMs !== null && typeof m === 'string' && frameType(m) === 'ack') {
        const after = cutAfterAckMs
        cutAfterAckMs = null
        setTimeout(() => conn.cut(), after)
      }
    })
    ws.onClose(() => {
      open = false
      live.delete(conn)
      for (const t of timers.keys()) clearTimeout(t)
      timers.clear()
      try {
        server.close()
      } catch {
        // already closed
      }
    })
    server.onClose(() => {
      open = false
      live.delete(conn)
      try {
        ws.close()
      } catch {
        // already closed
      }
    })
  })
  return {
    arm(o) {
      upMs = o.upMs
      cutAfterAckMs = o.cutAfterAckMs ?? null
    },
    cut() {
      for (const c of [...live]) c.cut()
    },
    stats,
  }
}

/** The `type` of a JSON frame ('push', 'ack', 'changes', …), or '' for anything else. */
function frameType(text: string): string {
  try {
    const t = (JSON.parse(text) as { type?: unknown }).type
    return typeof t === 'string' ? t : ''
  } catch {
    return ''
  }
}

/** `openCanvasSession` with the page's board socket routed through a `slowUplink`. */
async function openSlowSession(
  browser: Browser,
  board: string,
  user: TestUser,
): Promise<{ s: CanvasSession; uplink: Uplink }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signInContext(context, user.handle, user.name)
  const uplink = await slowUplink(page)
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  const me = await canvasCall(page, 'me')
  expect(me?.uid, 'the welcome names this user').toBe(user.id)
  return { s: { user: user.handle, name: user.name, id: user.id, context, page }, uplink }
}

const supersededToast = (page: Page) => page.getByTestId('save-superseded-toast')
/** The doc pushes this tab has sent, their base clocks in order. */
const docPushBases = async (page: Page): Promise<number[]> =>
  (await canvasCall(page, 'pushedOps')).filter((p) => p.doc).map((p) => p.base)

test.describe('a lost write of a board-document key', () => {
  test('DB1: red lands and is acked, blue is lost with the socket, nobody else writes: blue is stored, no notice', async ({
    browser,
    canvasSession,
    board,
    users,
  }) => {
    test.setTimeout(120_000)
    const { s: a, uplink } = await openSlowSession(browser, board, await users.get('alice'))
    try {
      const b = await canvasSession('bob')
      await setDoc(a.page, { [KEY]: green })
      await expectSaved(a.page)
      await expect.poll(() => getDoc(b.page, KEY)).toEqual(green)
      const pushesBefore = (await docPushBases(a.page)).length

      // red goes out at once, blue 0.8 s later: both before red's ack can come back (1.5 s up, nothing down),
      // so both are built on the same base clock. The first ack cuts the socket 60 ms after it is home,
      // 0.8 s before blue would have left the queue
      uplink.arm({ upMs: 1_500, cutAfterAckMs: 60 })
      await setDoc(a.page, { [KEY]: red })
      await a.page.waitForTimeout(800)
      await setDoc(a.page, { [KEY]: blue })
      expect(await getDoc(a.page, KEY), 'this tab holds its own latest write').toEqual(blue)
      const bases = (await docPushBases(a.page)).slice(pushesBefore)
      expect(bases, 'two doc pushes, built on one base clock').toHaveLength(2)
      expect(bases[1]).toBe(bases[0])

      // red lands (bob sees it) while blue is still on its way up, then the cut drops blue
      await expect.poll(() => getDoc(b.page, KEY), { timeout: 15_000 }).toEqual(red)
      expect((await saveState(a.page)).state, 'blue is not stored: this tab is not Saved').not.toBe('saved')
      await expect.poll(() => uplink.stats.cuts, { timeout: 15_000 }).toBe(1)
      expect(uplink.stats.dropped, 'the cut dropped blue before it left').toBe(1)

      // the page reconnects: blue is written again (the key's clock is past blue's base only by red, this
      // tab's own acked write), nobody is told "someone else changed it", and everyone ends on blue
      await expectSaved(a.page, 45_000)
      expect(await getDoc(a.page, KEY)).toEqual(blue)
      await expect.poll(() => getDoc(b.page, KEY), { timeout: 15_000 }).toEqual(blue)
      await expect(supersededToast(a.page)).toHaveCount(0)
      const fresh = await canvasSession('carol')
      expect(await getDoc(fresh.page, KEY), 'what is stored').toEqual(blue)
    } finally {
      await a.context.close()
    }
  })

  test('DB1c control: blue written after red is Saved and lost on its way up goes again, no notice', async ({
    browser,
    canvasSession,
    board,
    users,
  }) => {
    test.setTimeout(120_000)
    const { s: a, uplink } = await openSlowSession(browser, board, await users.get('alice'))
    try {
      const b = await canvasSession('bob')
      await setDoc(a.page, { [KEY]: green })
      await expectSaved(a.page)
      await setDoc(a.page, { [KEY]: red })
      await expectSaved(a.page)
      await expect.poll(() => getDoc(b.page, KEY)).toEqual(red)

      uplink.arm({ upMs: 1_500 })
      await setDoc(a.page, { [KEY]: blue })
      await a.page.waitForTimeout(500)
      uplink.cut()
      expect(uplink.stats.dropped, 'blue never left the machine').toBe(1)
      expect(await getDoc(b.page, KEY), 'the room still has red').toEqual(red)

      await expectSaved(a.page, 45_000)
      expect(await getDoc(a.page, KEY)).toEqual(blue)
      await expect.poll(() => getDoc(b.page, KEY), { timeout: 15_000 }).toEqual(blue)
      await expect(supersededToast(a.page)).toHaveCount(0)
    } finally {
      await a.context.close()
    }
  })

  test('another person writes the key after red is acked and blue is lost: theirs stands and this tab is told', async ({
    browser,
    canvasSession,
    board,
    users,
  }) => {
    test.setTimeout(120_000)
    const { s: a, uplink } = await openSlowSession(browser, board, await users.get('alice'))
    try {
      const b = await canvasSession('bob')
      await setDoc(a.page, { [KEY]: green })
      await expectSaved(a.page)
      await expect.poll(() => getDoc(b.page, KEY)).toEqual(green)

      // the cut comes 0.5 s after red's ack: time for bob to write the key, which lands before it
      uplink.arm({ upMs: 1_500, cutAfterAckMs: 500 })
      await setDoc(a.page, { [KEY]: red })
      await a.page.waitForTimeout(800)
      await setDoc(a.page, { [KEY]: blue })
      await expect.poll(() => getDoc(b.page, KEY), { timeout: 15_000 }).toEqual(red)
      await setDoc(b.page, { [KEY]: theirs })
      await expect.poll(() => uplink.stats.cuts, { timeout: 15_000 }).toBe(1)
      expect(uplink.stats.dropped, 'the cut dropped blue before it left').toBe(1)

      // the key's clock is past alice's own write (red): the write is bob's, so it stands, and alice is told
      await expect(supersededToast(a.page)).toBeVisible({ timeout: 30_000 })
      await expectSaved(a.page, 45_000)
      await expect.poll(() => getDoc(a.page, KEY), { timeout: 15_000 }).toEqual(theirs)
      expect(await getDoc(b.page, KEY)).toEqual(theirs)
      const fresh = await canvasSession('carol')
      expect(await getDoc(fresh.page, KEY), 'what is stored').toEqual(theirs)
    } finally {
      await a.context.close()
    }
  })
})
