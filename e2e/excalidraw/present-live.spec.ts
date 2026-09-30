// present-live on the Excalidraw board page (ported from tests/present-live.spec.ts "present to everyone";
// PRS-07, PRS-12's hand-off): presenting to everyone, following in step, stepping out and rejoining,
// hand-off, recovery from reloads, the presenter leaving and an api restart, and what guests and viewers
// may do. The api's state is the second witness (GET /api/boards/:bid/presentation as the user).
//
// Present-live (3c) runs on present mode's presenter, which present mode (3e) provides on this page
// (features/present-export/live/ported/presenter.ts `provideLivePresenter`) with its Present button and
// chrome. Until 3e lands that, every test here is an expected failure (CR-3C-2), and fails fast on the
// missing Present button. The people-list part of the tldraw spec is people-list.spec.ts.
import type { Browser, BrowserContext, Page } from '@playwright/test'
import {
  type CanvasSession,
  createItem,
  createNote,
  expect,
  expectSaved,
  item,
  test,
  updateItem,
  viewport,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import type { Users } from '../tests/support/users.ts'

const PRESENTER_NEEDED = 'CR-3C-2: present mode (3e) provides its presenter to present-live on this page'

interface Deck {
  one: string
  two: string
  three: string
}

interface LiveState {
  presentation: {
    id: string
    presenter: { userId: string; name: string }
    tab: string | null
    slideId: string | null
    presenterOnline: boolean
    followers: { userId: string; name: string; guest: boolean }[]
    followerCount: number
  } | null
}

async function liveState(users: Users, board: string, handle = 'alice'): Promise<LiveState> {
  const res = await (await users.api(handle)).fetch('GET', `/api/boards/${board}/presentation`)
  expect(res.status()).toBe(200)
  return (await res.json()) as LiveState
}

const presentUi = (page: Page) => ({
  button: page.getByTestId('present-button'),
  overlay: page.getByTestId('present-overlay'),
  counter: page.getByTestId('present-counter'),
  exit: page.getByTestId('present-exit'),
})

const live = (page: Page) => ({
  invite: page.getByTestId('live-invite'),
  join: page.getByTestId('live-join'),
  chip: page.getByTestId('live-chip'),
  presenting: page.getByTestId('live-presenting'),
  count: page.getByTestId('live-follower-count'),
  following: page.getByTestId('live-following'),
  stop: page.getByTestId('live-stop-following'),
  takeOver: page.getByTestId('live-take-over'),
  flash: page.getByTestId('live-flash'),
  inviteEveryone: page.getByTestId('present-invite'),
  handoff: page.getByTestId('present-handoff'),
  handoffList: page.getByTestId('handoff-list'),
})

/** Present mode is on this page (3e): fails fast while it is not. */
async function expectPresentMode(page: Page) {
  await expect(presentUi(page).button).toBeVisible({ timeout: 5_000 })
}

/** Wakes the presentation controls (they hide after 2 s without pointer movement). */
async function wake(page: Page) {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  await page.mouse.move(vp.width / 2 + Math.random() * 40, vp.height / 2 + Math.random() * 40, { steps: 2 })
}

/** alice's board with three frames (and a note in the second); everyone given has them. */
async function withDeck(a: CanvasSession, others: CanvasSession[]): Promise<Deck> {
  const frame = async (name: string, x: number, y: number, width: number, height: number) => {
    const id = await createItem(a.page, 'frame', { x, y, width, height, name })
    await expectSaved(a.page)
    return id
  }
  const deck = {
    one: await frame('Welcome', 0, 0, 800, 450),
    two: await frame('Roadmap', 1200, 0, 800, 450),
    three: await frame('Next steps', 2400, 600, 640, 480),
  }
  const note = await createNote(a.page, { x: 1500, y: 120, text: 'Q4 launch' })
  await expectSaved(a.page)
  await updateItem(a.page, note, { frameId: deck.two })
  await expectSaved(a.page)
  for (const s of others) for (const id of Object.values(deck)) await waitForItem(s.page, id)
  return deck
}

/** The frame is the slide on screen: inside the viewport, centred and fitted (camera animation done). */
async function expectSlideOnScreen(page: Page, frameId: string) {
  await expect
    .poll(
      async () => {
        const f = await item(page, frameId)
        const vp = await viewport(page)
        if (!f) return false
        const eps = 1
        const inside =
          f.x >= vp.x - eps &&
          f.y >= vp.y - eps &&
          f.x + f.width <= vp.x + vp.width + eps &&
          f.y + f.height <= vp.y + vp.height + eps
        const centre = Math.hypot(
          f.x + f.width / 2 - (vp.x + vp.width / 2),
          f.y + f.height / 2 - (vp.y + vp.height / 2),
        )
        const fill = Math.max(f.width / vp.width, f.height / vp.height)
        return inside && centre < 1 && fill > 0.98
      },
      { message: `${frameId} fitted on screen`, timeout: 10_000 },
    )
    .toBe(true)
}

/** The presenter starts presenting and invites everyone. */
async function presentToEveryone(page: Page) {
  const ui = presentUi(page)
  await ui.button.click()
  await expect(ui.overlay).toBeVisible()
  await wake(page)
  await live(page).inviteEveryone.click()
  await expect(live(page).presenting).toBeVisible()
  await expect(live(page).flash).toContainText('Everyone on the board can now join your presentation')
}

async function joinPresentation(page: Page, presenterName: string) {
  const l = live(page)
  await expect(l.invite).toContainText(`${presenterName} is presenting`)
  await l.join.click()
  await expect(presentUi(page).overlay).toBeVisible()
  await expect(l.following).toContainText(`Following ${presenterName}`)
}

/** A name-only guest who joined through an editor (workshop) link, in a fresh browser context. */
async function guestSession(browser: Browser, users: Users, board: string, name: string) {
  const res = await (await users.api('alice')).fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'editor',
    allowGuests: true,
  })
  expect(res.status(), await res.text()).toBe(201)
  const { url } = (await res.json()) as { url: string }
  const token = url.slice(url.lastIndexOf('/') + 1)
  const context = await browser.newContext()
  const joined = await context.request.post(`${WEB_URL}/api/invitations/${token}/guest`, {
    headers: { origin: WEB_URL },
    data: { name },
  })
  expect(joined.status(), await joined.text()).toBe(201)
  const { user } = (await joined.json()) as { user: { id: string } }
  const page = await context.newPage()
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  return { context, page, id: user.id, name: `${name} (guest)` }
}

const post = (context: BrowserContext, path: string, data: unknown) =>
  context.request.post(`${WEB_URL}${path}`, { headers: { origin: WEB_URL }, data })

const ref = (id: string) => `shape:${id}`

test.describe('present to everyone', () => {
  test('alice invites everyone; bob (editor) and carol (viewer) join and follow each slide in step; carol steps out and rejoins; ending releases everyone', async ({
    board,
    canvasSession,
    users,
  }) => {
    test.fail(true, PRESENTER_NEEDED)
    const a = await canvasSession('alice')
    await expectPresentMode(a.page)
    const b = await canvasSession('bob', { role: 'editor' })
    const c = await canvasSession('carol', { role: 'viewer' })
    const F = await withDeck(a, [b, c])

    await presentToEveryone(a.page)
    await expect(live(a.page).count).toHaveText('No one following yet')
    for (const s of [b, c]) {
      await expect(live(s.page).invite).toContainText('Alice Park is presenting')
      await expect(presentUi(s.page).overlay).toHaveCount(0)
    }
    expect((await liveState(users, board, 'carol')).presentation).toMatchObject({
      presenter: { userId: a.id, name: 'Alice Park' },
      slideId: ref(F.one),
    })

    await joinPresentation(b.page, 'Alice Park')
    await joinPresentation(c.page, 'Alice Park')
    for (const s of [b, c]) await expectSlideOnScreen(s.page, F.one)
    await expect(live(a.page).count).toHaveText('2 following')
    await expect(b.page.getByTestId('topbar')).toBeHidden()
    await expect(presentUi(b.page).counter).toHaveText('1 / 3')

    await a.page.keyboard.press('ArrowRight')
    await Promise.all([expectSlideOnScreen(b.page, F.two), expectSlideOnScreen(c.page, F.two)])
    await a.page.keyboard.press('ArrowRight')
    await Promise.all([expectSlideOnScreen(b.page, F.three), expectSlideOnScreen(c.page, F.three)])
    await b.page.keyboard.press('ArrowLeft')
    await expectSlideOnScreen(b.page, F.three)
    expect((await liveState(users, board)).presentation?.slideId).toBe(ref(F.three))

    await live(c.page).stop.click()
    await expect(presentUi(c.page).overlay).toHaveCount(0)
    await expect(live(a.page).count).toHaveText('1 following')
    await expect(live(c.page).chip).toHaveAttribute('data-state', 'rejoin')
    await a.page.keyboard.press('ArrowLeft')
    await expectSlideOnScreen(b.page, F.two)
    await live(c.page).chip.click()
    await expect(presentUi(c.page).overlay).toBeVisible()
    await expectSlideOnScreen(c.page, F.two)

    await wake(a.page)
    await presentUi(a.page).exit.click()
    for (const s of [b, c]) {
      await expect(presentUi(s.page).overlay).toHaveCount(0)
      await expect(s.page.getByTestId('live-ended-toast')).toContainText('Alice Park ended the presentation.')
    }
    expect((await liveState(users, board, 'bob')).presentation).toBeNull()
  })

  test('late joiner and reloads: dave joins mid-presentation from the people list at the current slide; the presenter reloads and resumes; a follower reloads and keeps following', async ({
    board,
    canvasSession,
    users,
  }) => {
    test.fail(true, PRESENTER_NEEDED)
    const a = await canvasSession('alice')
    await expectPresentMode(a.page)
    const b = await canvasSession('bob', { role: 'commenter' })
    const F = await withDeck(a, [b])
    await presentToEveryone(a.page)
    await joinPresentation(b.page, 'Alice Park')
    await a.page.keyboard.press('ArrowRight')
    await expectSlideOnScreen(b.page, F.two)
    const id = (await liveState(users, board)).presentation?.id

    const d = await canvasSession('dave', { role: 'viewer' })
    await expect(live(d.page).invite).toContainText('Alice Park is presenting')
    await d.page.getByTestId('people-open').click()
    const row = d.page.locator(`[data-testid="people-row"][data-user-id="${a.id}"]`)
    await expect(row).toHaveAttribute('data-status', 'presenting')
    await expect(row.getByTestId('people-status')).toHaveText('Presenting to everyone')
    await expect(
      d.page.locator(`[data-testid="people-row"][data-user-id="${b.id}"] [data-testid="people-status"]`),
    ).toHaveText('Following the presentation')
    await row.getByTestId('people-join').click()
    await expect(live(d.page).following).toContainText('Following Alice Park')
    await expectSlideOnScreen(d.page, F.two)

    await a.page.reload()
    await waitForCanvas(a.page)
    await expect(presentUi(a.page).overlay).toBeVisible()
    await expect(presentUi(a.page).counter).toHaveText('2 / 3')
    expect((await liveState(users, board)).presentation?.id).toBe(id)
    await a.page.keyboard.press('ArrowRight')
    await expectSlideOnScreen(b.page, F.three)

    await b.page.reload()
    await waitForCanvas(b.page)
    await expect(live(b.page).following).toContainText('Following Alice Park')
    await expectSlideOnScreen(b.page, F.three)
  })

  test('hand-off: Esc closes the list without ending; alice hands over to bob, who drives the slides while alice follows; bob ends it', async ({
    board,
    canvasSession,
    users,
  }) => {
    test.fail(true, PRESENTER_NEEDED)
    const a = await canvasSession('alice')
    await expectPresentMode(a.page)
    const b = await canvasSession('bob', { role: 'editor' })
    const c = await canvasSession('carol', { role: 'viewer' })
    const F = await withDeck(a, [b, c])
    await presentToEveryone(a.page)
    await joinPresentation(b.page, 'Alice Park')
    await joinPresentation(c.page, 'Alice Park')

    await wake(a.page)
    await live(a.page).handoff.click()
    const list = live(a.page).handoffList
    await expect(list.getByTestId('handoff-option')).toHaveCount(1)
    await expect(list.getByTestId('handoff-option')).toHaveAttribute('data-user-id', b.id)
    await expect(list).toContainText('following')
    await a.page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
    await expect(presentUi(a.page).overlay).toBeVisible()

    await wake(a.page)
    await live(a.page).handoff.click()
    await live(a.page).handoffList.getByTestId('handoff-option').click()
    await expect(live(b.page).presenting).toBeVisible()
    await expect(live(b.page).flash).toContainText('Alice Park handed the presentation to you')
    await expect(live(a.page).following).toContainText('Following Bob Chen')
    await expect(live(c.page).following).toContainText('Following Bob Chen')
    expect((await liveState(users, board)).presentation?.presenter.userId).toBe(b.id)

    await b.page.keyboard.press('End')
    await Promise.all([expectSlideOnScreen(a.page, F.three), expectSlideOnScreen(c.page, F.three)])
    await b.page.keyboard.press('Escape')
    for (const s of [a, c]) {
      await expect(presentUi(s.page).overlay).toHaveCount(0)
      await expect(s.page.getByTestId('live-ended-toast')).toContainText('Bob Chen ended the presentation.')
    }
  })

  test('the presenter closes the tab: followers see "reconnecting", an editor takes over; when the new presenter leaves too it ends for everyone after the grace', async ({
    board,
    canvasSession,
    users,
  }) => {
    test.fail(true, PRESENTER_NEEDED)
    test.setTimeout(150_000)
    const a = await canvasSession('alice')
    await expectPresentMode(a.page)
    const b = await canvasSession('bob', { role: 'editor' })
    const c = await canvasSession('carol', { role: 'viewer' })
    const F = await withDeck(a, [b, c])
    await presentToEveryone(a.page)
    await a.page.keyboard.press('ArrowRight')
    await joinPresentation(b.page, 'Alice Park')
    await joinPresentation(c.page, 'Alice Park')
    await expectSlideOnScreen(c.page, F.two)

    await a.context.close()
    for (const s of [b, c]) {
      await expect(live(s.page).following).toHaveAttribute('data-state', 'waiting', { timeout: 15_000 })
      await expect(live(s.page).following).toContainText('Waiting for Alice Park to reconnect')
    }
    await expect(live(b.page).takeOver).toBeVisible()
    await expect(live(c.page).takeOver).toHaveCount(0)

    await live(b.page).takeOver.click()
    await expect(live(b.page).presenting).toBeVisible()
    await expect(live(c.page).following).toContainText('Following Bob Chen')
    await b.page.keyboard.press('ArrowRight')
    await expectSlideOnScreen(c.page, F.three)

    await b.context.close()
    await expect(presentUi(c.page).overlay).toHaveCount(0, { timeout: 30_000 })
    await expect(c.page.getByTestId('live-ended-toast')).toContainText(
      'Bob Chen left the board, so the presentation ended.',
    )
    expect((await liveState(users, board, 'carol')).presentation).toBeNull()
  })

  test('an api restart: the presenter’s tab puts the same presentation back and followers keep following', async ({
    board,
    canvasSession,
    users,
    stack,
  }) => {
    test.fail(true, PRESENTER_NEEDED)
    const a = await canvasSession('alice')
    await expectPresentMode(a.page)
    const b = await canvasSession('bob', { role: 'viewer' })
    const F = await withDeck(a, [b])
    await presentToEveryone(a.page)
    await joinPresentation(b.page, 'Alice Park')
    await a.page.keyboard.press('ArrowRight')
    await expectSlideOnScreen(b.page, F.two)
    const before = (await liveState(users, board)).presentation?.id

    await stack.api.restart()
    await expect
      .poll(async () => (await liveState(users, board)).presentation?.id ?? null, { timeout: 60_000 })
      .toBe(before)
    await expect(presentUi(b.page).overlay).toBeVisible()
    await a.page.keyboard.press('ArrowRight')
    await expectSlideOnScreen(b.page, F.three)
  })

  test('who may present: a viewer and a name-only guest (editor link) get no "Invite everyone" and the api refuses them; the guest follows alice', async ({
    board,
    browser,
    canvasSession,
    users,
  }) => {
    test.fail(true, PRESENTER_NEEDED)
    const a = await canvasSession('alice')
    await expectPresentMode(a.page)
    const c = await canvasSession('carol', { role: 'viewer' })
    const g = await guestSession(browser, users, board, 'Sam Rivera')
    try {
      const F = await withDeck(a, [c])
      for (const id of Object.values(F)) await waitForItem(g.page, id)
      const body = { tab: 'tab_testtesttesttesttest', slideId: ref(F.one), index: 0, count: 3 }
      for (const [page, context] of [
        [c.page, c.context],
        [g.page, g.context],
      ] as const) {
        await presentUi(page).button.click()
        await expect(presentUi(page).overlay).toBeVisible()
        await wake(page)
        await expect(live(page).inviteEveryone).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(presentUi(page).overlay).toHaveCount(0)
        expect((await post(context, `/api/boards/${board}/presentation`, body)).status()).toBe(403)
      }
      await presentToEveryone(a.page)
      await joinPresentation(g.page, 'Alice Park')
      await expect(live(a.page).count).toHaveText('1 following')
      await expect(live(a.page).presenting).toHaveAttribute('title', 'Following: Sam Rivera (guest)')
      await wake(a.page)
      await live(a.page).handoff.click()
      await expect(a.page.getByTestId('handoff-empty')).toBeVisible()
    } finally {
      await g.context.close()
    }
  })
})
