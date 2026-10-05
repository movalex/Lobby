// OWNER: G1 (wave G). The vote a participant's page acts on is the vote that is open NOW, whatever came
// before it and whatever the board event stream missed. Found by a live two-user test on staging
// (2026-10-05): the owner ended a selection vote and started a board vote; a name-only guest (whose event
// stream kept dropping) joined, clicked a note outside the old selection and was told "Not part of this
// vote: only objects in the selection take votes."; and a vote started while the guest's stream was down
// never reached the guest until a reload.
//
//  1. scope after a new vote, every stream up: selection vote -> end -> board vote, where the guest, an
//     editor who voted in the first vote and the owner all vote outside the old selection; and board vote ->
//     end -> selection vote, where a click outside the selection is refused and one inside it lands.
//  2. the same, the participants' event streams cut (and kept from reconnecting) across the change: the
//     guest joins the leftover join card, the editor clicks outside the old selection; both end up voting in
//     the board vote, without a reload (failed before G1: the old selection vote's rule refused the clicks).
//  3. catch-up: the participant's stream is cut while a vote starts and while it ends, or the page goes
//     offline (the stream's events still arrive, every refetch fails); once restored the page shows the
//     open vote, then the ended one, without a reload (offline failed before G1: a refetch that failed was
//     never tried again).
//
// alice = board owner and facilitator, bob = editor with an account, the guest ("QA Bot") = a name-only
// workshop guest who joins through a workshop link (editor role, never a facilitator).
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { select } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { type ApiVoteState, openWorkshopPopover } from '../tests/support/workshops.ts'
import {
  clickElement,
  dot,
  expect,
  expectItemsEverywhere,
  reloadBoard,
  seed,
  showAll,
  test,
  type WorkshopCanvasSession,
  waitForWorkshopBoard,
} from './workshops-kit.ts'

const ID = {
  went: 'g1-went',
  improve: 'g1-improve',
  later: 'g1-later',
  w1: 'g1-went-1',
  i1: 'g1-improve-1',
  p1: 'g1-later-1',
  loose: 'g1-loose',
}
const ref = (id: string) => `shape:${id}`
const NOT_IN_SELECTION = 'Not part of this vote: only objects in the selection take votes.'
/** apps/web WorkshopOverlay.tsx REFUSE_CONFIRMED_MS: a refused click this long after the last check asks again. */
const REFUSE_CONFIRMED_MS = 2_000
/** How long a page may take to catch up once its connection is back (the backoffs start at 1 s). */
const CATCH_UP_MS = 20_000

async function seedRetro(a: WorkshopCanvasSession) {
  await seed(a.page, {
    frames: [
      { id: ID.went, x: 0, y: 0, w: 500, h: 400, name: 'Went well' },
      { id: ID.improve, x: 600, y: 0, w: 500, h: 400, name: 'To improve' },
      { id: ID.later, x: 1200, y: 0, w: 500, h: 400, name: 'Parking lot' },
    ],
    notes: [
      { id: ID.w1, x: 40, y: 80, text: 'Trailer music', frameId: ID.went },
      { id: ID.i1, x: 640, y: 80, text: 'Build times', frameId: ID.improve },
      { id: ID.p1, x: 1240, y: 80, text: 'Merch', frameId: ID.later },
      { id: ID.loose, x: 0, y: 600, text: 'Standup' },
    ],
  })
}

// ---- cutting a page's board event stream ------------------------------------------------------------------

/**
 * Installed before the app runs: records the page's board event streams so the test can cut them like a
 * dropped connection (the stream errors and is closed, as the browser reports an HTTP error or a proxy
 * that gave up). Reconnects are refused by the test's route while the cut lasts.
 */
function trackEventStreams() {
  const Original = window.EventSource
  const streams: EventSource[] = []
  window.EventSource = class extends Original {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      if (String(url).includes('/events')) streams.push(this)
    }
  }
  ;(window as unknown as { __cutEventStreams: () => number }).__cutEventStreams = () => {
    let cut = 0
    for (const es of streams.splice(0)) {
      if (es.readyState === Original.CLOSED) continue
      es.close()
      es.dispatchEvent(new Event('error'))
      cut++
    }
    return cut
  }
}

const EVENTS = '**/api/boards/*/events'

/** Cuts the page's open event stream and refuses new ones until `restoreStream`. */
async function cutStream(page: Page) {
  await page.route(EVENTS, (route) => route.abort('connectionreset'))
  const cut = await page.evaluate(() =>
    (window as unknown as { __cutEventStreams: () => number }).__cutEventStreams(),
  )
  expect(cut, 'an open board event stream was cut').toBe(1)
}
const restoreStream = (page: Page) => page.unroute(EVENTS)

/** Marks the page, so a later check can tell it was not reloaded. */
const markPage = (page: Page) =>
  page.evaluate(() => {
    ;(window as unknown as { __g1Mark: boolean }).__g1Mark = true
  })
const notReloaded = (page: Page) =>
  page.evaluate(() => (window as unknown as { __g1Mark?: boolean }).__g1Mark === true)

// ---- people -----------------------------------------------------------------------------------------------

interface Guest {
  context: BrowserContext
  page: Page
}

/** A workshop link (editor, name-only guests allowed), made through the api as alice. */
async function workshopLink(a: WorkshopCanvasSession, board: string): Promise<string> {
  const res = await a.api.fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'editor',
    allowGuests: true,
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { url: string }).url
}

/** A fresh browser (no account) joins the link with just a name and lands on the board. */
async function joinAsGuest(browser: Browser, link: string, name: string): Promise<Guest> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addInitScript(trackEventStreams)
  const page = await context.newPage()
  await page.goto(link)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForWorkshopBoard(page)
  await expect(page.getByTestId('user-menu')).toHaveAttribute('data-kind', 'guest')
  return { context, page }
}

/** bob's page, reopened with its event streams tracked (so the test can cut them). */
async function trackStreams(s: WorkshopCanvasSession) {
  await s.context.addInitScript(trackEventStreams)
  await reloadBoard(s)
}

type ServerVote = ApiVoteState & { session: { scope: string; selection?: string[] | null } }

/**
 * The vote as the server answers this person's page (its cookie, and this web build's revision header: a
 * request without it is answered as a build from before 0024, which reads a selection vote as a board vote).
 */
async function serverVote(page: Page, boardId: string): Promise<ServerVote> {
  const res = await page.request.get(`${WEB_URL}/api/boards/${boardId}/workshop`, {
    headers: { 'x-lobby-client': '1' },
  })
  expect(res.status()).toBe(200)
  return ((await res.json()) as { vote: ServerVote }).vote
}

/** What the server stored for this person in the vote open now. */
async function storedBallot(s: { page: Page }, boardId: string) {
  const v = await serverVote(s.page, boardId)
  return { sid: v.session.id, myVotes: v.myVotes }
}

// ---- voting steps -----------------------------------------------------------------------------------------

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

/**
 * alice starts a 3-vote vote from the setup dialog (`from`: the top bar's "Start a vote…" or the panel's
 * "Start a new vote…"), picking the scope like a person: 'board' ("Everything on the board") or 'selection'
 * ("Only the selection", which needs the frames selected first). Returns the new vote's id.
 */
async function startVote(
  a: WorkshopCanvasSession,
  boardId: string,
  scope: 'board' | 'selection',
  from: 'bar' | 'panel',
) {
  if (from === 'bar') {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('vote-start').click()
  } else {
    const panel = await openVotingPanel(a.page)
    await panel.getByTestId('vote-start-panel').click()
  }
  const dialog = a.page.getByTestId('vote-setup-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('vote-per-person').fill('3')
  await dialog.getByTestId('vote-scope').selectOption(scope)
  await expect(dialog.getByTestId('vote-scope')).toHaveValue(scope)
  await dialog.getByTestId('vote-setup-submit').click()
  await expect(dialog).toHaveCount(0)
  await expect(a.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'open')
  const v = await serverVote(a.page, boardId)
  expect(v.session).toMatchObject({ status: 'open', scope })
  return v.session.id
}

/** alice ends the open vote with "End without results" (the Voting panel). */
async function endWithoutResults(a: WorkshopCanvasSession) {
  const panel = await openVotingPanel(a.page)
  await panel.getByTestId('vote-close').click()
  await expect(panel.getByTestId('vote-current')).toHaveAttribute('data-status', 'closed')
}

const joinPrompt = (page: Page) => page.getByTestId('vote-join-prompt')
const describes = (where: 'board' | 'selection') =>
  where === 'board' ? 'objects on the board' : 'the selected frames and objects'

/** The participant accepts the join prompt for the vote that is open now. */
async function joinVote(page: Page, where: 'board' | 'selection') {
  const prompt = joinPrompt(page)
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText(describes(where))
  await prompt.getByTestId('vote-join').click()
  await expect(prompt).toHaveCount(0)
  await expect(page.getByTestId('vote-bar')).toBeVisible()
}

const remaining = (page: Page) => page.getByTestId('vote-remaining')
const toast = (page: Page) => page.getByTestId('vote-toast')

/** A click on a note lands one vote: the dot shows it and the allowance drops to `left`. */
async function votesOn(page: Page, id: string, left: number) {
  await clickElement(page, id)
  await expect(dot(page, id)).toHaveAttribute('data-count', '1')
  await expect(remaining(page)).toHaveAttribute('data-remaining', String(left))
}

// ---- 1. scope after a new vote, every stream up --------------------------------------------------------------

test('a selection vote, ended, then a board vote: the guest, an editor who voted in the first and the owner all vote outside the old selection', async ({
  join,
  board: boardId,
  browser,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seedRetro(a)
  await expectItemsEverywhere([a, b], Object.values(ID))

  let first = ''
  await test.step('alice starts a vote over the two selected columns', async () => {
    await select(a.page, [ID.went, ID.improve])
    first = await startVote(a, boardId, 'selection', 'bar')
  })

  // The guest's page loads while the selection vote is open, and shows its join card.
  const guest = await joinAsGuest(browser, await workshopLink(a, boardId), 'QA Bot')
  try {
    await expectItemsEverywhere([{ page: guest.page, user: 'guest' }], Object.values(ID))
    await test.step('the guest sees the selection vote; bob joins it and votes in a column', async () => {
      await expect(joinPrompt(guest.page)).toContainText(describes('selection'))
      await joinVote(b.page, 'selection')
      await showAll(b.page)
      await votesOn(b.page, ID.w1, 2)
      await clickElement(b.page, ID.loose)
      await expect(toast(b.page)).toContainText(NOT_IN_SELECTION)
    })

    let second = ''
    await test.step('alice ends it without results and starts a board vote from the panel', async () => {
      await endWithoutResults(a)
      await expect(joinPrompt(guest.page)).toHaveCount(0)
      await expect(b.page.getByTestId('vote-bar')).toHaveCount(0)
      second = await startVote(a, boardId, 'board', 'panel')
      expect(second).not.toBe(first)
      await expect(a.page.getByTestId('vote-current')).not.toContainText('in frames')
    })

    await test.step('the guest joins the board vote and votes on notes outside the old selection', async () => {
      await joinVote(guest.page, 'board')
      await showAll(guest.page)
      await votesOn(guest.page, ID.loose, 2)
      await votesOn(guest.page, ID.p1, 1)
    })

    await test.step('bob (who voted in the selection vote) votes on the loose note too', async () => {
      await joinVote(b.page, 'board')
      await votesOn(b.page, ID.loose, 2)
    })

    await test.step('alice (in by starting it) votes outside the old selection, and inside a column she has selected', async () => {
      await expect(joinPrompt(a.page)).toHaveCount(0)
      await expect(a.page.getByTestId('vote-bar')).toBeVisible()
      await showAll(a.page)
      await votesOn(a.page, ID.p1, 2)
      await votesOn(a.page, ID.loose, 1)
      await select(a.page, [ID.went, ID.improve])
      await votesOn(a.page, ID.w1, 0)
    })

    await test.step('the server holds each ballot in the board vote', async () => {
      expect(await storedBallot(a, boardId)).toEqual({
        sid: second,
        myVotes: { [ref(ID.p1)]: 1, [ref(ID.loose)]: 1, [ref(ID.w1)]: 1 },
      })
      expect(await storedBallot(b, boardId)).toEqual({ sid: second, myVotes: { [ref(ID.loose)]: 1 } })
      expect(await storedBallot(guest, boardId)).toEqual({
        sid: second,
        myVotes: { [ref(ID.loose)]: 1, [ref(ID.p1)]: 1 },
      })
    })
  } finally {
    await guest.context.close()
  }
})

test('a board vote, ended, then a selection vote: a click outside the selection is refused, one inside lands (guest and owner)', async ({
  join,
  board: boardId,
  browser,
}) => {
  const a = await join('alice')
  await seedRetro(a)
  const guest = await joinAsGuest(browser, await workshopLink(a, boardId), 'QA Bot')
  try {
    await expectItemsEverywhere([a, { page: guest.page, user: 'guest' }], Object.values(ID))

    await test.step('a board vote: the guest votes on the loose note, then alice ends it', async () => {
      await startVote(a, boardId, 'board', 'bar')
      await joinVote(guest.page, 'board')
      await showAll(guest.page)
      await votesOn(guest.page, ID.loose, 2)
      await endWithoutResults(a)
      await expect(guest.page.getByTestId('vote-bar')).toHaveCount(0)
    })

    let sid = ''
    await test.step('alice selects two columns and starts a selection vote from the panel', async () => {
      await select(a.page, [ID.went, ID.improve])
      sid = await startVote(a, boardId, 'selection', 'panel')
      await expect(a.page.getByTestId('vote-current')).toContainText('in frames “Went well” and “To improve”')
    })

    for (const [who, page] of [
      ['guest', guest.page],
      ['alice', a.page],
    ] as const) {
      await test.step(`${who}: outside the selection is refused, inside it lands`, async () => {
        if (who === 'guest') await joinVote(page, 'selection')
        await showAll(page)
        await clickElement(page, ID.loose)
        await expect(toast(page)).toContainText(NOT_IN_SELECTION)
        await clickElement(page, ID.p1)
        await expect(toast(page)).toContainText(NOT_IN_SELECTION)
        await expect(remaining(page)).toHaveAttribute('data-remaining', '3')
        await expect(dot(page, ID.loose)).toHaveCount(0)
        await expect(dot(page, ID.p1)).toHaveCount(0)
        await votesOn(page, ID.i1, 2)
      })
    }
    expect(await storedBallot(guest, boardId)).toEqual({ sid, myVotes: { [ref(ID.i1)]: 1 } })
    expect(await storedBallot(a, boardId)).toEqual({ sid, myVotes: { [ref(ID.i1)]: 1 } })
  } finally {
    await guest.context.close()
  }
})

// ---- 2. the same, with the participants' event streams cut across the change ---------------------------------

test('streams cut while a selection vote is replaced by a board vote: the guest’s leftover join card and the editor’s click both lead to the board vote, without a reload', async ({
  join,
  board: boardId,
  browser,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await trackStreams(b)
  await seedRetro(a)
  await expectItemsEverywhere([a, b], Object.values(ID))
  await select(a.page, [ID.went, ID.improve])
  const first = await startVote(a, boardId, 'selection', 'bar')

  const guest = await joinAsGuest(browser, await workshopLink(a, boardId), 'QA Bot')
  try {
    await expectItemsEverywhere([{ page: guest.page, user: 'guest' }], Object.values(ID))
    await expect(joinPrompt(guest.page)).toContainText(describes('selection'))
    await joinVote(b.page, 'selection')
    await showAll(b.page)
    await votesOn(b.page, ID.w1, 2)
    for (const page of [guest.page, b.page]) await markPage(page)

    let second = ''
    await test.step('both participants’ streams are cut; alice ends the selection vote and starts a board vote', async () => {
      await cutStream(guest.page)
      await cutStream(b.page)
      await endWithoutResults(a)
      second = await startVote(a, boardId, 'board', 'panel')
      expect(second).not.toBe(first)
      // Neither page heard of it: the guest still shows the selection vote's join card, bob its voting bar.
      await expect(joinPrompt(guest.page)).toContainText(describes('selection'))
      await expect(b.page.getByTestId('vote-bar')).toBeVisible()
    })

    await test.step('the guest joins the leftover card: the board vote’s card comes up, and its votes land', async () => {
      await joinPrompt(guest.page).getByTestId('vote-join').click()
      await joinVote(guest.page, 'board')
      await showAll(guest.page)
      await votesOn(guest.page, ID.loose, 2)
      await votesOn(guest.page, ID.p1, 1)
      await expect(toast(guest.page)).toHaveCount(0)
    })

    await test.step('bob clicks outside the old selection a while later: no refusal, the board vote’s card comes up', async () => {
      await b.page.waitForTimeout(REFUSE_CONFIRMED_MS + 100)
      await clickElement(b.page, ID.loose)
      await joinVote(b.page, 'board')
      await expect(toast(b.page)).toHaveCount(0)
      await votesOn(b.page, ID.loose, 2)
    })

    await test.step('the streams come back; nothing was reloaded and the server holds the board-vote ballots', async () => {
      await restoreStream(guest.page)
      await restoreStream(b.page)
      for (const page of [guest.page, b.page]) expect(await notReloaded(page)).toBe(true)
      expect(await storedBallot(guest, boardId)).toEqual({
        sid: second,
        myVotes: { [ref(ID.loose)]: 1, [ref(ID.p1)]: 1 },
      })
      expect(await storedBallot(b, boardId)).toEqual({ sid: second, myVotes: { [ref(ID.loose)]: 1 } })
    })
  } finally {
    await guest.context.close()
  }
})

// ---- 3. catch-up after a stream drop ------------------------------------------------------------------------

for (const how of ['stream cut', 'offline'] as const) {
  test(`catch-up (${how}): a vote that starts, and one that ends, while the guest is cut off reaches the guest once restored, without a reload`, async ({
    join,
    board: boardId,
    browser,
  }) => {
    const a = await join('alice')
    await seedRetro(a)
    const guest = await joinAsGuest(browser, await workshopLink(a, boardId), 'QA Bot')
    const g = guest.page
    const cut = () => (how === 'offline' ? guest.context.setOffline(true) : cutStream(g))
    const restore = () => (how === 'offline' ? guest.context.setOffline(false) : restoreStream(g))
    try {
      await expectItemsEverywhere([{ page: g, user: 'guest' }], Object.values(ID))
      await markPage(g)

      let sid = ''
      await test.step('cut off while alice starts a board vote: nothing shows yet', async () => {
        await cut()
        sid = await startVote(a, boardId, 'board', 'bar')
        // what the guest's page asked for meanwhile could not come in
        await g.waitForTimeout(1_500)
        await expect(joinPrompt(g)).toHaveCount(0)
        await expect(g.getByTestId('vote-chip')).toHaveCount(0)
      })

      await test.step('restored: the open vote comes up on its own', async () => {
        await restore()
        await expect(joinPrompt(g)).toContainText(describes('board'), { timeout: CATCH_UP_MS })
        await expect(g.getByTestId('vote-chip')).toContainText('Voting · 3 left')
        await joinVote(g, 'board')
        await showAll(g)
        await votesOn(g, ID.loose, 2)
      })

      await test.step('cut off while alice ends the vote with its results; restored: the page shows it ended', async () => {
        await cut()
        const panel = await openVotingPanel(a.page)
        await panel.getByTestId('vote-reveal').click()
        await expect(panel.getByTestId('vote-current')).toHaveAttribute('data-status', 'revealed')
        await restore()
        await expect(g.getByTestId('vote-bar')).toHaveCount(0, { timeout: CATCH_UP_MS })
        await expect(g.getByTestId('vote-chip')).toHaveCount(0)
        const gp = await openVotingPanel(g)
        await expect(gp.getByTestId('vote-current')).toHaveAttribute('data-status', 'revealed', {
          timeout: CATCH_UP_MS,
        })
        await expect(gp.getByTestId('vote-result-row')).toHaveCount(1)
        await expect(gp.getByTestId('vote-result-row').first()).toHaveAttribute(
          'data-shape-id',
          ref(ID.loose),
        )
      })

      await test.step('cut off while alice starts the next vote over the selection; restored: it comes up, its rule with it', async () => {
        await cut()
        await select(a.page, [ID.went, ID.improve])
        const next = await startVote(a, boardId, 'selection', 'panel')
        expect(next).not.toBe(sid)
        await restore()
        await expect(joinPrompt(g)).toContainText(describes('selection'), { timeout: CATCH_UP_MS })
        await joinVote(g, 'selection')
        await clickElement(g, ID.loose)
        await expect(toast(g)).toContainText(NOT_IN_SELECTION)
        await votesOn(g, ID.w1, 2)
        expect(await storedBallot(guest, boardId)).toEqual({ sid: next, myVotes: { [ref(ID.w1)]: 1 } })
      })

      expect(await notReloaded(g)).toBe(true)
    } finally {
      await guest.context.close()
    }
  })
}
