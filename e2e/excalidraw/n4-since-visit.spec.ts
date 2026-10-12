// Wave N (WS4, N4-1 to N4-4): "Since your last visit", in real browsers against the real api and sync server.
//  - alice visits and leaves; bob adds 2 notes, edits 1 and deletes 1; alice returns: the chip says 2 added, 1 changed,
//    1 removed, the outlines mark them and fade after 15 s, Next change walks the camera through each, Catch me up's
//    window header is the chip's time, Mark all seen hides it, and the next open (another browser) shows none;
//  - the visit time is alice's own: bob's page never receives it (no request, no response, no event, no socket frame);
//  - alice's tab only receives: it pushes no element while the highlights are up;
//  - a Mark all seen the api drops (inside its 10 s write interval) is still honoured by a reload of the same tab;
//  - a name-only guest makes no visit request at all and keeps the device-local Catch me up.
import type { Browser, Page } from '@playwright/test'
import {
  expectSaved,
  item,
  itemBounds,
  pushedOps,
  setViewport,
  startTextEditingWithKeyboard,
  stopTextEditing,
  typeText,
  viewport,
} from '../tests/support/canvas.ts'
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

/**
 * The visit answers this session's page received (its own, only), once `count` of them have been read. Not
 * `net.settle()`: that waits for every /api body of the page, and the body of a thumbnail upload the api refused (a 429
 * while another tab's picture is fresh) can stay pending for good.
 */
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

/** alice makes three notes, stays long enough that leaving is written, and leaves. Returns when she left. */
async function aliceVisitsAndLeaves(join: (h: string) => Promise<WorkshopCanvasSession>) {
  const t0 = Date.now()
  const a = await join('alice')
  await seed(a.page, {
    notes: [
      { id: 'n4-keep', x: 0, y: 0, text: 'Kept as it was' },
      { id: 'n4-edit', x: 260, y: 0, text: 'Will be reworded' },
      { id: 'n4-del', x: 520, y: 0, text: 'Will be deleted' },
    ],
  })
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
    // (a page that received nothing would pass this: it received the board, so the check has something to read)
    expect(b.net.responses.length).toBeGreaterThan(3)
    expect(b.net.wsFrames.length).toBeGreaterThan(0)
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
