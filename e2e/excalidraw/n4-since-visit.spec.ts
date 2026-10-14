// Wave N (WS4, N4-1 to N4-4): "Since your last visit", in real browsers against the real api and sync server.
//  - alice visits and leaves; bob adds 2 notes, edits 1 and deletes 1; alice returns: the chip says 2 added, 1 changed,
//    1 removed, the outlines mark them and fade after 15 s, Next change walks the camera through each, Catch me up's
//    window header is the chip's time, Mark all seen hides it, and the next open (another browser) shows none;
//  - the visit time is alice's own: bob's page never receives it (no request, no response, no event, no socket frame);
//  - alice's tab only receives: it pushes no element while the highlights are up;
//  - a Mark all seen the api drops (inside its 10 s write interval) is still honoured by a reload of the same tab;
//  - the server's re-snap of an arrow bound to a moved note is not a change (in the real room the arrow carries the
//    commit's own time), with no checkpoint; and with one from before the visit (the real history routes) the arrow
//    is left out too, while every removal stays counted: the checkpoint only names them, it never filters them (a
//    checkpoint older than what she saw must not hide a deletion: the stale-checkpoint test);
//  - a name-only guest makes no visit request at all and keeps the device-local Catch me up.
import type { Browser, Page } from '@playwright/test'
import {
  createItem,
  deleteItem,
  expectSaved,
  item,
  itemBounds,
  pushedOps,
  setViewport,
  startTextEditingWithKeyboard,
  stopTextEditing,
  typeText,
  updateItem,
  viewport,
} from '../tests/support/canvas.ts'
import { boundEnds } from './history-kit.ts'
import {
  expect,
  seed,
  showAll,
  test,
  type WorkshopCanvasSession,
  waitForWorkshopBoard,
} from './workshops-kit.ts'

test.describe.configure({ timeout: 240_000 })

/** The api writes a person's visit at most once per this long per board (VISIT_WRITE_MIN_INTERVAL_MS). */
const WRITE_INTERVAL_MS = 10_000
/** The outlines fade after this long (VISIT_HIGHLIGHT_FADE_MS). */
const FADE_MS = 15_000

const chip = (page: Page) => page.getByTestId('visits-chip')
const outlines = (page: Page) => page.getByTestId('visit-outline')

/** Waits until `ms` have passed since `since` (a Date.now()). */
const pastSince = (page: Page, since: number, ms: number) =>
  page.waitForTimeout(Math.max(0, since + ms - Date.now()))

interface VisitReply {
  previousSeenAt: number | null
  seenAt: number
}

const repliesOf = (s: WorkshopCanvasSession): VisitReply[] =>
  s.net.responses
    .filter((r) => r.path.endsWith('/visit') && r.status === 200)
    .map((r) => JSON.parse(r.body) as VisitReply)

/** The visit answers this session's page received (its own, only), once `count` of them have been read. */
async function visitReplies(s: WorkshopCanvasSession, count: number): Promise<VisitReply[]> {
  await expect
    .poll(() => repliesOf(s).length, { timeout: 15_000, message: 'the visit answers this page received' })
    .toBe(count)
  return repliesOf(s)
}

/** Board menu › Board › Catch me up; continues the notice when it shows; the finished panel. */
async function catchMeUp(page: Page) {
  await page.getByTestId('main-menu.button').click()
  await page.getByTestId('main-menu-sub.dr-board-button').click()
  await page.getByRole('menuitem', { name: 'Catch me up' }).click()
  const cont = page.getByTestId('ai-notice-continue')
  const done = page.locator('[data-testid="recap-panel"][data-status="done"]')
  await expect(cont.or(done).first()).toBeVisible({ timeout: 20_000 })
  if (await cont.isVisible()) await cont.click()
  await expect(done).toBeVisible({ timeout: 20_000 })
  return done
}

/** The recap's own date format (features/ai/recap/plan.ts recapWhen), in the page's locale and time zone. */
const recapWhenIn = (page: Page, ms: number) =>
  page.evaluate(
    (t) =>
      new Date(t).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    ms,
  )

/** The board of the first test: three notes (one stays, one is reworded, one is deleted). */
const threeNotes = (page: Page) =>
  seed(page, {
    notes: [
      { id: 'n4-keep', x: 0, y: 0, text: 'Kept as it was' },
      { id: 'n4-edit', x: 260, y: 0, text: 'Will be reworded' },
      { id: 'n4-del', x: 520, y: 0, text: 'Will be deleted' },
    ],
  })

/** Two notes with an arrow between them, its ends bound (the server derives where they sit), and a third note. */
async function arrowBoard(page: Page) {
  await seed(page, {
    notes: [
      { id: 'n4-a', x: 0, y: 0, text: 'Left note' },
      { id: 'n4-b', x: 520, y: 0, text: 'Right note' },
      { id: 'n4-del', x: 260, y: 400, text: 'Will be deleted' },
    ],
  })
  await createItem(page, 'arrow', {
    id: 'n4-arrow',
    x: 230,
    y: 60,
    points: [
      [0, 0],
      [280, 0],
    ],
  })
  await expectSaved(page)
  await updateItem(page, 'n4-arrow', {
    startBinding: { elementId: 'n4-a', fixedPoint: [1, 0.5], mode: 'orbit' },
    endBinding: { elementId: 'n4-b', fixedPoint: [0, 0.5], mode: 'orbit' },
  })
  await expectSaved(page)
  await expect.poll(() => boundEnds(page, 'n4-arrow')).toEqual(['end->n4-b', 'start->n4-a'])
}

/** alice sets a board up, stays long enough that leaving is written, and leaves. Returns the session she left. */
async function aliceVisitsAndLeaves(
  join: (h: string) => Promise<WorkshopCanvasSession>,
  setUp: (a: WorkshopCanvasSession) => Promise<void> = (a) => threeNotes(a.page),
) {
  const t0 = Date.now()
  const a = await join('alice')
  await setUp(a)
  // the visit was written when she opened it; leaving writes a newer time only after the interval
  await pastSince(a.page, t0, WRITE_INTERVAL_MS + 1_200)
  await a.page.goto('about:blank')
  await a.page.waitForTimeout(800)
  return a
}

test('alice visits and leaves; bob adds 2 notes, edits 1 and deletes 1; alice returns to the chip, the outlines, the tour and Mark all seen', async ({
  join,
}) => {
  const a1 = await aliceVisitsAndLeaves(join)

  const b = await join('bob', 'editor')
  await expect.poll(async () => (await item(b.page, 'n4-del')) !== null).toBe(true)
  await test.step('bob adds 2 notes, rewords 1 and deletes 1', async () => {
    await seed(b.page, {
      notes: [
        { id: 'n4-new1', x: 0, y: 300, text: 'Bob’s first' },
        { id: 'n4-new2', x: 260, y: 300, text: 'Bob’s second' },
      ],
    })
    await startTextEditingWithKeyboard(b.page, 'n4-edit')
    await typeText(b.page, ' by bob')
    await stopTextEditing(b.page)
    await b.page.evaluate(() => {
      const board = (
        window as unknown as {
          __lobbyBoard: {
            canvas: { transact(l: string, fn: (tx: { delete(id: string): void }) => void): void }
          }
        }
      ).__lobbyBoard
      board.canvas.transact('e2e delete', (tx) => tx.delete('n4-del'))
    })
    await expectSaved(b.page)
  })

  const a2 = await join('alice')
  const opened = Date.now()
  await expect(chip(a2.page)).toBeVisible({ timeout: 30_000 })

  await test.step('the chip says 2 added, 1 changed, 1 removed, with the time of her last visit', async () => {
    await expect(chip(a2.page)).toHaveAttribute('data-added', '2')
    await expect(chip(a2.page)).toHaveAttribute('data-changed', '1')
    await expect(chip(a2.page)).toHaveAttribute('data-removed', '1')
    await expect(a2.page.getByTestId('visits-chip-text')).toHaveText(
      /^Since you were here \((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2} [ap]m\): 2 added · 1 changed · 1 removed$/,
    )
    const replies = await visitReplies(a2, 1)
    expect(replies[0]?.previousSeenAt).not.toBeNull()
    // it is the time she left, not the time she first opened it
    const first = (await visitReplies(a1, 1))[0]
    expect(replies[0]?.previousSeenAt).toBeGreaterThan((first as VisitReply).seenAt)
    await expect(chip(a2.page)).toHaveAttribute('data-since', String(replies[0]?.previousSeenAt))
  })

  await test.step('an editor can see what was removed, by name (a viewer would see the count)', async () => {
    await a2.page.getByTestId('visits-removed-toggle').click()
    await expect(a2.page.getByTestId('visits-removed-list')).toContainText('Will be deleted')
    await a2.page.getByTestId('visits-removed-toggle').click()
    await expect(a2.page.getByTestId('visits-removed-list')).toHaveCount(0)
  })

  await test.step('the outlines mark the two added notes and the reworded one (an overlay: no element is written)', async () => {
    await showAll(a2.page)
    await expect(a2.page.locator('[data-testid="visit-outline"][data-kind="added"]')).toHaveCount(2)
    await expect(a2.page.locator('[data-testid="visit-outline"][data-kind="changed"]')).toHaveCount(1)
    await expect(a2.page.locator('[data-testid="visit-outline"][data-id="n4-new1"]')).toHaveCount(1)
    await expect(a2.page.locator('[data-testid="visit-outline"][data-id="n4-edit"]')).toHaveCount(1)
    // the note that was not touched has none, and neither has the deleted one
    await expect(a2.page.locator('[data-testid="visit-outline"][data-id="n4-keep"]')).toHaveCount(0)
  })

  await test.step('Catch me up’s window is the chip’s time (one window for both)', async () => {
    const since = Number(await chip(a2.page).getAttribute('data-since'))
    const panel = await catchMeUp(a2.page)
    const when = await recapWhenIn(a2.page, since)
    await expect(panel.getByRole('heading')).toContainText(`Since your last visit, ${when}`)
    await a2.page.getByRole('button', { name: 'Close recap' }).click()
    await expect(panel).toHaveCount(0)
  })

  await test.step('the outlines fade after 15 seconds; the chip stays', async () => {
    await pastSince(a2.page, opened, FADE_MS + 500)
    await expect(outlines(a2.page)).toHaveCount(0, { timeout: 10_000 })
    await expect(chip(a2.page)).toBeVisible()
  })

  await test.step('Next change moves the camera to each change in turn, and round again', async () => {
    await setViewport(a2.page, { x: 20_000, y: 20_000, zoom: 1 })
    const stops: string[] = []
    for (let i = 0; i < 4; i++) {
      await setViewport(a2.page, { x: 20_000, y: 20_000, zoom: 1 }) // far away again before each stop
      await a2.page.getByTestId('visits-next').click()
      const ringed = a2.page.locator('.dr-visits-outline--ring[data-testid="visit-outline"]')
      await expect(ringed).toHaveCount(1, { timeout: 10_000 })
      const id = (await ringed.getAttribute('data-id')) as string
      stops.push(id)
      await expect
        .poll(
          async () => {
            const [vp, bounds] = await Promise.all([viewport(a2.page), itemBounds(a2.page, id)])
            if (!bounds) return false
            const cx = bounds.x + bounds.width / 2
            const cy = bounds.y + bounds.height / 2
            return cx >= vp.x && cx <= vp.x + vp.width && cy >= vp.y && cy <= vp.y + vp.height
          },
          { timeout: 10_000, message: `the camera came to ${id}` },
        )
        .toBe(true)
    }
    // two added, then the changed one, then round to the first
    expect(new Set(stops.slice(0, 3))).toEqual(new Set(['n4-new1', 'n4-new2', 'n4-edit']))
    expect(stops.slice(0, 2).every((id) => id.startsWith('n4-new'))).toBe(true)
    expect(stops[2]).toBe('n4-edit')
    expect(stops[3]).toBe(stops[0])
  })

  await test.step('Mark all seen hides the chip', async () => {
    const seenBeacons: string[] = []
    a2.context.on('request', (r) => {
      if (r.url().endsWith('/visit/seen')) seenBeacons.push(r.method())
    })
    await a2.page.getByTestId('visits-mark-seen').click()
    await expect(chip(a2.page)).toHaveCount(0)
    await expect(a2.page.locator('.dr-visits-outline--ring')).toHaveCount(0)
    await expect.poll(() => seenBeacons).toEqual(['POST'])
  })

  await test.step('the next open (another browser) shows none', async () => {
    const a3 = await join('alice')
    // wait for the highlights' decision: the visit answered, the room ready, and then a moment more
    await visitReplies(a3, 1)
    await a3.page.waitForTimeout(2_500)
    await expect(chip(a3.page)).toHaveCount(0)
    expect(await pushedOps(a3.page)).toHaveLength(0)
  })

  await test.step('alice’s tab only received: it pushed no element during the highlights', async () => {
    expect(await pushedOps(a2.page)).toHaveLength(0)
  })

  await test.step('bob’s page never received anything about alice’s visits', async () => {
    const times = new Set<number>()
    for (const r of [...(await visitReplies(a1, 1)), ...(await visitReplies(a2, 1))]) {
      times.add(r.seenAt)
      if (r.previousSeenAt !== null) times.add(r.previousSeenAt)
    }
    // her first opening, and the time she left (a quick return inside the api's write interval is answered with the stored time)
    expect(times.size).toBeGreaterThanOrEqual(2)
    const needles = [...times].map(String)
    // no request of bob’s to the visit routes but his own opening, and its answer is his own
    const own = await visitReplies(b, 1)
    expect(own[0]?.previousSeenAt).toBeNull() // his first visit: alice’s are not his
    for (const t of times) expect(own[0]?.seenAt).not.toBe(t)
    // nothing bob’s page was sent (HTTP bodies, the event stream) or received on the canvas socket carries them
    // (a page that received nothing would pass this: it received the board, and the scan finds a visit time where there is
    // one, bob’s own, so the check has something to read)
    expect(b.net.responses.length).toBeGreaterThan(3)
    expect(b.net.wsFrames.length).toBeGreaterThan(0)
    expect(b.net.responses.some((r) => r.body.includes(String(own[0]?.seenAt)))).toBe(true)
    const has = (text: string) => needles.some((n) => text.includes(n))
    expect(b.net.responses.filter((r) => has(r.body)).map((r) => r.path)).toEqual([])
    expect(b.net.events.filter((e) => has(e.raw)).map((e) => e.type)).toEqual([])
    expect(b.net.wsFrames.filter(has).length).toBe(0)
  })
})

test('Mark all seen inside the api’s write interval is still honoured by a reload of the same tab', async ({
  join,
}) => {
  await aliceVisitsAndLeaves(join)
  const b = await join('bob', 'editor')
  await seed(b.page, { notes: [{ id: 'n4-quick', x: 0, y: 300, text: 'While you were away' }] })

  const a2 = await join('alice')
  await expect(chip(a2.page)).toBeVisible({ timeout: 30_000 })
  await expect(chip(a2.page)).toHaveAttribute('data-added', '1')
  const first = (await visitReplies(a2, 1))[0] as VisitReply

  // inside the interval of the visit just written: the api drops the beacon
  await a2.page.getByTestId('visits-mark-seen').click()
  await expect(chip(a2.page)).toHaveCount(0)

  await a2.page.reload()
  await waitForWorkshopBoard(a2.page)
  const second = (await visitReplies(a2, 2))[1] as VisitReply
  // the api answered the visit it already answered (the proof this is the case under test)
  expect(second).toEqual(first)
  await a2.page.waitForTimeout(2_500)
  await expect(chip(a2.page)).toHaveCount(0)
})

/**
 * alice has been here before (so her next opening is a new visit), then comes back for a short visit: the api writes
 * the leaving time only after its 10 s interval, so the visit time left behind is the opening, and what she makes in
 * this visit comes after it. Her own notes used to count as new.
 */
async function aliceShortVisit(
  join: (h: string) => Promise<WorkshopCanvasSession>,
  work: (a: WorkshopCanvasSession) => Promise<void>,
) {
  await aliceVisitsAndLeaves(join, async () => {})
  const a = await join('alice')
  await visitReplies(a, 1)
  await work(a)
  await a.page.goto('about:blank')
  await a.page.waitForTimeout(800)
}

// P-006: "Since you were here" is about what OTHERS did.
test('P-006: what alice made herself in her last visit is not "since you were here"; what bob made is', async ({
  join,
}) => {
  await aliceShortVisit(join, (a) =>
    seed(a.page, { notes: [{ id: 'p6-mine', x: 0, y: 0, text: 'Day 1: studio' }] }),
  )

  const b = await join('bob', 'editor')
  await expect.poll(async () => (await item(b.page, 'p6-mine')) !== null).toBe(true)
  await seed(b.page, { notes: [{ id: 'p6-theirs', x: 260, y: 0, text: 'Bob’s idea' }] })

  const a2 = await join('alice')
  await expect(chip(a2.page)).toBeVisible({ timeout: 30_000 })
  await expect(chip(a2.page)).toHaveAttribute('data-added', '1')
  await expect(chip(a2.page)).toHaveAttribute('data-changed', '0')
  await expect(chip(a2.page)).toHaveAttribute('data-removed', '0')
  await showAll(a2.page)
  await expect(a2.page.locator('[data-testid="visit-outline"][data-id="p6-theirs"]')).toHaveCount(1)
  await expect(a2.page.locator('[data-testid="visit-outline"][data-id="p6-mine"]')).toHaveCount(0)
})

test('P-006: when only alice changed the board while she was away there is no chip', async ({ join }) => {
  await aliceShortVisit(join, async (a) => {
    await seed(a.page, {
      notes: [
        { id: 'p6-a', x: 0, y: 0, text: 'One' },
        { id: 'p6-b', x: 260, y: 0, text: 'Two' },
      ],
    })
    await startTextEditingWithKeyboard(a.page, 'p6-b')
    await typeText(a.page, ' and more')
    await stopTextEditing(a.page)
    await expectSaved(a.page)
  })

  const a2 = await join('alice')
  await visitReplies(a2, 1)
  await a2.page.waitForTimeout(2_500) // the highlights' decision is made by now
  await expect(chip(a2.page)).toHaveCount(0)
})

test('wave N.1: leaving the page sends one "seen" beacon (the page turning hidden and pagehide said it once each)', async ({
  join,
}) => {
  const a = await join('alice')
  await visitReplies(a, 1) // the api took this open's visit: there is something to say "seen" about
  // Playwright does not report a request made while a page unloads, so the page's own lifecycle events are fired and the
  // beacons counted where they are made: a tab closing turns the page hidden, then fires pagehide
  const beacons = await a.page.evaluate(() => {
    const seen: string[] = []
    const send = navigator.sendBeacon.bind(navigator)
    navigator.sendBeacon = (url, data) => {
      // (the usage counters use a beacon too)
      if (String(url).endsWith('/visit/seen')) seen.push(String(url))
      return send(url, data)
    }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    return seen
  })
  expect(beacons).toHaveLength(1)
  expect(beacons[0]).toMatch(/\/visit\/seen$/)
})

/** The parts of the dev handle this spec drives (focus mode, following). */
type QuietWindow = {
  __lobbyBoard?: {
    canvas: {
      follow: { current(): string | null; start(sid: string): void; stop(): void }
      presence: { peers(): { sid: string; uid: string }[] }
      settings: { set(p: { focusMode: boolean }): void }
    }
  }
}

/** An element as a page holds it: the server's commit time and where it sits. */
const stampOf = async (page: Page, id: string) =>
  (await item(page, id)) as unknown as { updated: number; x: number; y: number }

test('a bound arrow that only followed a moved note is not a change: the server re-snaps it in the note’s own commit', async ({
  join,
}) => {
  const a1 = await aliceVisitsAndLeaves(join, (a) => arrowBoard(a.page))
  void a1
  const b = await join('bob', 'editor')
  await expect.poll(async () => (await item(b.page, 'n4-arrow')) !== null).toBe(true)
  const before = await stampOf(b.page, 'n4-arrow')
  await updateItem(b.page, 'n4-a', { y: 220 }) // the arrow’s left end follows it
  await expectSaved(b.page)

  const a2 = await join('alice')
  await expect(chip(a2.page)).toBeVisible({ timeout: 30_000 })
  await test.step('the real room re-snapped the arrow in the commit that moved the note', async () => {
    const [note, arrow] = await Promise.all([stampOf(a2.page, 'n4-a'), stampOf(a2.page, 'n4-arrow')])
    expect(note.y).toBe(220)
    // there was a server change to leave out: the arrow is not where it was, and carries the note’s commit time
    expect(arrow.x !== before.x || arrow.y !== before.y).toBe(true)
    expect(arrow.updated).toBe(note.updated)
  })
  await test.step('the chip counts the note once and not the arrow', async () => {
    await expect(chip(a2.page)).toHaveAttribute('data-added', '0')
    await expect(chip(a2.page)).toHaveAttribute('data-changed', '1')
    await expect(chip(a2.page)).toHaveAttribute('data-removed', '0')
    await expect(a2.page.locator('[data-testid="visit-outline"][data-id="n4-a"]')).toHaveCount(1)
    await expect(a2.page.locator('[data-testid="visit-outline"][data-id="n4-arrow"]')).toHaveCount(0)
  })
  await test.step('the chip and the outlines step aside in focus mode and while she follows bob, and are back after', async () => {
    const focus = (on: boolean) =>
      a2.page.evaluate(
        (focusMode) => (window as unknown as QuietWindow).__lobbyBoard?.canvas.settings.set({ focusMode }),
        on,
      )
    await focus(true)
    await expect(chip(a2.page)).toHaveCount(0)
    await expect(outlines(a2.page)).toHaveCount(0)
    await focus(false)
    await expect(chip(a2.page)).toBeVisible()
    await expect(a2.page.locator('[data-testid="visit-outline"][data-id="n4-a"]')).toHaveCount(1)

    // following bob (a Shift-click on his cursor chip does the same): the chip steps aside until she stops
    const sid = await (
      await a2.page.waitForFunction(
        (uid) =>
          (window as unknown as QuietWindow).__lobbyBoard?.canvas.presence.peers().find((p) => p.uid === uid)
            ?.sid ?? null,
        b.id,
      )
    ).jsonValue()
    await a2.page.evaluate(
      (target) => (window as unknown as QuietWindow).__lobbyBoard?.canvas.follow.start(target),
      sid as string,
    )
    await expect
      .poll(() =>
        a2.page.evaluate(
          () => (window as unknown as QuietWindow).__lobbyBoard?.canvas.follow.current() ?? null,
        ),
      )
      .toBe(sid)
    await expect(chip(a2.page)).toHaveCount(0)
    await expect(outlines(a2.page)).toHaveCount(0)
    await a2.page.evaluate(() => (window as unknown as QuietWindow).__lobbyBoard?.canvas.follow.stop())
    await expect(chip(a2.page)).toBeVisible()
  })
})

test('with a checkpoint from before the visit: the arrow that only followed is left out, removed items get their names, and a note made and deleted while she was away is still counted', async ({
  join,
  board,
}) => {
  const a1 = await aliceVisitsAndLeaves(join, async (a) => {
    await arrowBoard(a.page)
    // the board as she saw it, saved before she leaves
    const res = await a.api.fetch('POST', `/api/boards/${board}/snapshots`, { name: 'Before' })
    expect(res.status(), await res.text()).toBe(201)
  })
  void a1

  const b = await join('bob', 'editor')
  await expect.poll(async () => (await item(b.page, 'n4-del')) !== null).toBe(true)
  await updateItem(b.page, 'n4-a', { y: 220 })
  await expectSaved(b.page)
  await deleteItem(b.page, 'n4-del') // she had seen this one
  await seed(b.page, { notes: [{ id: 'n4-ghost', x: 800, y: 400, text: 'Here and gone' }] })
  await deleteItem(b.page, 'n4-ghost') // she never saw this one (the timestamps cannot tell: it is counted, see below)
  await expectSaved(b.page)

  const a2 = await join('alice')
  await expect(chip(a2.page)).toBeVisible({ timeout: 30_000 })
  await test.step('the checkpoint narrows the changed (the note moved, the arrow only followed) and keeps every removal', async () => {
    await expect(chip(a2.page)).toHaveAttribute('data-added', '0')
    await expect(chip(a2.page)).toHaveAttribute('data-changed', '1')
    // the checkpoint is not a filter on removals: it cannot know what she saw after it, so the ghost counts too
    await expect(chip(a2.page)).toHaveAttribute('data-removed', '2')
    await a2.page.getByTestId('visits-removed-toggle').click()
    const list = a2.page.getByTestId('visits-removed-list')
    await expect(list).toContainText('Will be deleted')
    await expect(list).toContainText('Here and gone')
  })
  await test.step('it read the checkpoint through the history routes: the list, then one content', async () => {
    const paths = a2.net.responses.map((r) => r.path)
    expect(paths.filter((p) => /\/snapshots$/.test(p)).length).toBeGreaterThanOrEqual(1)
    expect(paths.filter((p) => /\/snapshots\/[^/]+\/content$/.test(p))).toHaveLength(1)
  })
})

test('a checkpoint older than what she saw does not hide a deletion: made after it, seen, deleted while away is still removed', async ({
  join,
  board,
}) => {
  const a1 = await aliceVisitsAndLeaves(join, async (a) => {
    await seed(a.page, { notes: [{ id: 'n4-keep', x: 0, y: 0, text: 'Kept as it was' }] })
    await expectSaved(a.page)
    // the checkpoint is from an hour before she leaves in real life: it has the first note only
    const res = await a.api.fetch('POST', `/api/boards/${board}/snapshots`, { name: 'Early' })
    expect(res.status(), await res.text()).toBe(201)
    // made after the checkpoint, and seen by her before she left
    await seed(a.page, { notes: [{ id: 'n4-del', x: 260, y: 0, text: 'Made after the checkpoint' }] })
    await expectSaved(a.page)
  })
  void a1

  const b = await join('bob', 'editor')
  await expect.poll(async () => (await item(b.page, 'n4-del')) !== null).toBe(true)
  await deleteItem(b.page, 'n4-del') // the only change while she was away
  await expectSaved(b.page)

  const a2 = await join('alice')
  await test.step('the chip still shows the deletion, though the checkpoint never had that note', async () => {
    await expect(chip(a2.page)).toBeVisible({ timeout: 30_000 })
    await expect(chip(a2.page)).toHaveAttribute('data-added', '0')
    await expect(chip(a2.page)).toHaveAttribute('data-changed', '0')
    await expect(chip(a2.page)).toHaveAttribute('data-removed', '1')
  })
  await test.step('it did read the stale checkpoint (the list, then one content): the refinement ran and kept the removal', async () => {
    const paths = a2.net.responses.map((r) => r.path)
    expect(paths.filter((p) => /\/snapshots$/.test(p)).length).toBeGreaterThanOrEqual(1)
    expect(paths.filter((p) => /\/snapshots\/[^/]+\/content$/.test(p))).toHaveLength(1)
  })
})

test('a name-only guest asks for no visit time and keeps the device-local Catch me up', async ({
  browser,
  join,
  board,
}) => {
  const a = await join('alice')
  const res = await a.api.fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'editor',
    allowGuests: true,
  })
  expect(res.status(), await res.text()).toBe(201)
  const link = ((await res.json()) as { url: string }).url

  const visitRequests: string[] = []
  const guest = await openGuest(browser, link, 'QA Bot', visitRequests)
  await expect(guest.getByTestId('user-menu')).toHaveAttribute('data-kind', 'guest')
  await guest.waitForTimeout(2_500)
  await expect(chip(guest)).toHaveCount(0)

  await test.step('Catch me up: the last 24 hours the first time, "your last visit" (this device’s) after a reload', async () => {
    const first = await catchMeUp(guest)
    await expect(first.getByRole('heading')).toContainText('the last 24 hours')
    await guest.getByRole('button', { name: 'Close recap' }).click()
    await guest.reload()
    await waitForWorkshopBoard(guest)
    const second = await catchMeUp(guest)
    await expect(second.getByRole('heading')).toContainText('Since your last visit')
  })

  // never a request to the visit routes, not even the pagehide beacon
  await guest.goto('about:blank')
  await guest.waitForTimeout(500)
  expect(visitRequests).toEqual([])
})

/** A fresh browser (no account) joins the link with just a name and lands on the board; `visitRequests` collects visit calls. */
async function openGuest(
  browser: Browser,
  link: string,
  name: string,
  visitRequests: string[],
): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  context.on('request', (r) => {
    if (/\/visit(\/seen)?$/.test(new URL(r.url()).pathname)) visitRequests.push(`${r.method()} ${r.url()}`)
  })
  const page = await context.newPage()
  await page.goto(link)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForWorkshopBoard(page)
  return page
}
