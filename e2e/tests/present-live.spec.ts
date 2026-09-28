// present-live (docs/WAVE4-CONTRACTS.md "present-live"; checklist PRS-07, PRS-12's hand-off, FAC-01,
// WRK-02): presenting to everyone on the board, following in step, stepping out and rejoining, hand-off,
// recovery from reloads, the presenter leaving and an api restart, what guests and viewers may do, and
// the people list (search, roles, "(guest)", follow, "Bring here", who follows me).
//
// Every browser is a separate context (its own session). The api's state is the second witness: it is
// read with GET /api/boards/:bid/presentation as the users themselves.

import type { Browser, BrowserContext, Page } from '@playwright/test'
import { read, type Session, waitForBoard } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'
import { expectShapes, expectSlideOnScreen, presentUi, seedBoard } from './support/present-export.ts'
import type { Users } from './support/users.ts'

const F = { one: 'shape:pl-one', two: 'shape:pl-two', three: 'shape:pl-three' }
const DECK = {
  frames: [
    { id: F.one, name: 'Welcome', x: 0, y: 0, w: 800, h: 450 },
    { id: F.two, name: 'Roadmap', x: 1200, y: 0, w: 800, h: 450 },
    { id: F.three, name: 'Next steps', x: 2400, y: 600, w: 640, h: 480 },
  ],
  notes: [{ id: 'shape:pl-note', parentId: F.two, x: 300, y: 120, text: 'Q4 launch' }],
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

const live = (page: Page) => ({
  invite: page.getByTestId('live-invite'),
  join: page.getByTestId('live-join'),
  notNow: page.getByTestId('live-not-now'),
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

/** Wakes the presentation controls (they hide after 2 s without pointer movement). */
async function wake(page: Page) {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  await page.mouse.move(vp.width / 2 + Math.random() * 40, vp.height / 2 + Math.random() * 40, { steps: 2 })
}

/** alice's board with the deck; everyone given has the deck loaded. */
async function withDeck(a: Session, others: Session[]) {
  await seedBoard(a.page, DECK)
  for (const s of [a, ...others]) await expectShapes(s.page, Object.values(F))
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

/**
 * The presenter presses `key`; resolves once `frameId` is the slide fitted on every follower page, with
 * how long each follower took to START moving there (its slide counter changed), measured inside the
 * pages on the one system clock: key press → api → event stream → follower's camera animation starts.
 */
async function slideDelivery(presenter: Page, followers: Page[], key: string, frameId: string) {
  for (const p of followers)
    await p.evaluate(() => {
      const w = window as unknown as { __plSlideAt?: number }
      w.__plSlideAt = undefined
      const el = document.querySelector('[data-testid="present-counter"]')
      const before = el?.textContent
      const mo = new MutationObserver(() => {
        if (document.querySelector('[data-testid="present-counter"]')?.textContent === before) return
        w.__plSlideAt = Date.now()
        mo.disconnect()
      })
      mo.observe(document.body, { subtree: true, childList: true, characterData: true })
    })
  await presenter.evaluate(() => {
    window.addEventListener(
      'keydown',
      () => {
        ;(window as unknown as { __plKeyAt?: number }).__plKeyAt = Date.now()
      },
      { capture: true, once: true },
    )
  })
  await presenter.keyboard.press(key)
  await Promise.all(followers.map((p) => expectSlideOnScreen(p, frameId)))
  const keyAt = await presenter.evaluate(() => (window as unknown as { __plKeyAt?: number }).__plKeyAt ?? 0)
  return Promise.all(
    followers.map(
      async (p) =>
        (await p.evaluate(() => (window as unknown as { __plSlideAt?: number }).__plSlideAt ?? 0)) - keyAt,
    ),
  )
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
  await waitForBoard(page)
  return { context, page, id: user.id, name: `${name} (guest)` }
}

const post = (context: BrowserContext, path: string, data: unknown) =>
  context.request.post(`${WEB_URL}${path}`, { headers: { origin: WEB_URL }, data })

test.describe('present to everyone', () => {
  test('alice invites everyone; bob (editor) and carol (viewer) join and follow each slide in step; carol steps out and rejoins; ending releases everyone', async ({
    board,
    session,
    users,
  }, testInfo) => {
    const a = await session('alice')
    const b = await session('bob', { role: 'editor' })
    const c = await session('carol', { role: 'viewer' })
    await withDeck(a, [b, c])

    await test.step('alice presents and invites everyone: bob and carol are asked, not pulled in', async () => {
      await presentToEveryone(a.page)
      await expect(live(a.page).count).toHaveText('No one following yet')
      for (const s of [b, c]) {
        await expect(live(s.page).invite).toContainText('Alice Park is presenting')
        await expect(presentUi(s.page).overlay).toHaveCount(0)
      }
      const st = await liveState(users, board, 'carol')
      expect(st.presentation).toMatchObject({
        presenter: { userId: a.id, name: 'Alice Park' },
        slideId: F.one,
      })
    })

    await test.step('they join: each sees the presenter’s slide; alice sees "2 following"', async () => {
      await joinPresentation(b.page, 'Alice Park')
      await joinPresentation(c.page, 'Alice Park')
      for (const s of [b, c]) await expectSlideOnScreen(s.page, F.one)
      await expect(live(a.page).count).toHaveText('2 following')
      await expect(live(a.page).presenting).toHaveAttribute('data-count', '2')
      // A follower's board is clean and read-only for the moment: no top bar, no slide controls.
      await expect(b.page.getByTestId('topbar')).toBeHidden()
      await expect(b.page.getByTestId('present-next')).toHaveCount(0)
      await expect(presentUi(b.page).counter).toHaveText('1 / 3')
    })

    await test.step('alice moves on: both followers’ cameras arrive at each slide in step', async () => {
      const ms1 = await slideDelivery(a.page, [b.page, c.page], 'ArrowRight', F.two)
      await expect(presentUi(c.page).counter).toHaveText('2 / 3')
      const ms2 = await slideDelivery(a.page, [b.page, c.page], 'ArrowRight', F.three)
      for (const ms of [...ms1, ...ms2]) expect(ms).toBeGreaterThan(0)
      testInfo.annotations.push({
        type: 'slide-follow-ms',
        description: `presenter key → followers start moving to the slide (then a 480 ms animation): ${[...ms1, ...ms2].join(', ')} ms (loopback, headless)`,
      })
      // A follower's arrow keys do not move anything.
      await b.page.keyboard.press('ArrowLeft')
      await expectSlideOnScreen(b.page, F.three)
      expect((await liveState(users, board)).presentation?.slideId).toBe(F.three)
    })

    await test.step('carol steps out (one click): she stays on the slide, alice sees 1, a chip offers Rejoin', async () => {
      await live(c.page).stop.click()
      await expect(presentUi(c.page).overlay).toHaveCount(0)
      await expect(c.page.getByTestId('topbar')).toBeVisible()
      // The slide she was looking at stays in view (not the view from before she joined).
      await expect
        .poll(() =>
          read(
            c.page,
            (ed, id) => {
              const vp = (
                ed as unknown as { getViewportPageBounds(): { x: number; y: number; w: number; h: number } }
              ).getViewportPageBounds()
              const f = ed.getShapePageBounds(id)
              if (!f) return false
              const cx = f.x + f.w / 2
              const cy = f.y + f.h / 2
              return cx > vp.x && cx < vp.x + vp.w && cy > vp.y && cy < vp.y + vp.h
            },
            F.three,
          ),
        )
        .toBe(true)
      await expect(live(a.page).count).toHaveText('1 following')
      await expect(live(c.page).chip).toHaveAttribute('data-state', 'rejoin')
      await expect(live(c.page).invite).toHaveCount(0)
      // alice moves back; carol is not pulled along.
      await a.page.keyboard.press('ArrowLeft')
      await expectSlideOnScreen(b.page, F.two)
      await expect(presentUi(c.page).overlay).toHaveCount(0)
    })

    await test.step('carol rejoins from the chip: straight to the current slide', async () => {
      await live(c.page).chip.click()
      await expect(presentUi(c.page).overlay).toBeVisible()
      await expectSlideOnScreen(c.page, F.two)
      await expect(live(a.page).count).toHaveText('2 following')
    })

    await test.step('alice ends it: everyone is released and told so', async () => {
      await wake(a.page)
      await expect(presentUi(a.page).exit).toHaveText('End')
      await presentUi(a.page).exit.click()
      await expect(presentUi(a.page).overlay).toHaveCount(0)
      for (const s of [b, c]) {
        await expect(presentUi(s.page).overlay).toHaveCount(0)
        await expect(s.page.getByTestId('live-ended-toast')).toContainText(
          'Alice Park ended the presentation.',
        )
        await expect(live(s.page).chip).toHaveCount(0)
      }
      expect((await liveState(users, board, 'bob')).presentation).toBeNull()
    })
  })

  test('late joiner and reloads: dave joins mid-presentation at the current slide; the presenter reloads and resumes; a follower reloads and keeps following', async ({
    board,
    session,
    users,
  }) => {
    const a = await session('alice')
    const b = await session('bob', { role: 'commenter' })
    await withDeck(a, [b])
    await presentToEveryone(a.page)
    await joinPresentation(b.page, 'Alice Park')
    await a.page.keyboard.press('ArrowRight')
    await expectSlideOnScreen(b.page, F.two)
    const id = (await liveState(users, board)).presentation?.id

    await test.step('dave opens the board late: invited; he joins from the people list, at slide 2', async () => {
      const d = await session('dave', { role: 'viewer' })
      await expect(live(d.page).invite).toContainText('Alice Park is presenting')
      await d.page.getByTestId('people-open').click()
      const row = d.page.locator(`[data-testid="people-row"][data-user-id="${a.id}"]`)
      await expect(row).toHaveAttribute('data-status', 'presenting')
      await expect(row.getByTestId('people-status')).toHaveText('Presenting to everyone')
      await expect(
        d.page.locator(`[data-testid="people-row"][data-user-id="${b.id}"] [data-testid="people-status"]`),
      ).toHaveText('Following the presentation')
      await row.getByTestId('people-join').click()
      await expect(presentUi(d.page).overlay).toBeVisible()
      await expect(live(d.page).following).toContainText('Following Alice Park')
      await expectSlideOnScreen(d.page, F.two)
      await expect(presentUi(d.page).counter).toHaveText('2 / 3')
      await expect(live(a.page).count).toHaveText('2 following')
    })

    await test.step('alice reloads her tab: she is presenting again at slide 2, the same presentation', async () => {
      await a.page.reload()
      await waitForBoard(a.page)
      await expect(presentUi(a.page).overlay).toBeVisible()
      await expect(presentUi(a.page).counter).toHaveText('2 / 3')
      await expect(live(a.page).presenting).toBeVisible()
      expect((await liveState(users, board)).presentation?.id).toBe(id)
      // bob kept following all along, and follows her next slide.
      await expect(presentUi(b.page).overlay).toBeVisible()
      await a.page.keyboard.press('ArrowRight')
      await expectSlideOnScreen(b.page, F.three)
    })

    await test.step('bob reloads: he comes back following, at the current slide', async () => {
      await b.page.reload()
      await waitForBoard(b.page)
      await expect(presentUi(b.page).overlay).toBeVisible()
      await expect(live(b.page).following).toContainText('Following Alice Park')
      await expectSlideOnScreen(b.page, F.three)
      await expect
        .poll(async () => (await liveState(users, board)).presentation?.followers.map((f) => f.userId))
        .toContain(b.id)
    })
  })

  test('hand-off: Esc closes the list without ending; alice hands over to bob, who drives the slides while alice follows; bob ends it', async ({
    board,
    session,
    users,
  }) => {
    const a = await session('alice')
    const b = await session('bob', { role: 'editor' })
    const c = await session('carol', { role: 'viewer' })
    await withDeck(a, [b, c])
    await presentToEveryone(a.page)
    await joinPresentation(b.page, 'Alice Park')
    await joinPresentation(c.page, 'Alice Park')

    await test.step('the list offers editors only (bob), not carol the viewer; Esc closes it and keeps presenting', async () => {
      await wake(a.page)
      await live(a.page).handoff.click()
      const list = live(a.page).handoffList
      await expect(list.getByTestId('handoff-option')).toHaveCount(1)
      await expect(list.getByTestId('handoff-option')).toHaveAttribute('data-user-id', b.id)
      await expect(list).toContainText('following')
      await a.page.keyboard.press('Escape')
      await expect(list).toHaveCount(0)
      await expect(presentUi(a.page).overlay).toBeVisible()
      expect((await liveState(users, board)).presentation?.presenter.userId).toBe(a.id)
    })

    await test.step('alice hands over: bob presents from his tab, alice follows him', async () => {
      await wake(a.page)
      await live(a.page).handoff.click()
      await live(a.page).handoffList.getByTestId('handoff-option').click()
      await expect(live(b.page).presenting).toBeVisible()
      await expect(live(b.page).flash).toContainText('Alice Park handed the presentation to you')
      await expect(live(a.page).following).toContainText('Following Bob Chen')
      await expect(live(c.page).following).toContainText('Following Bob Chen')
      const st = (await liveState(users, board)).presentation
      expect(st?.presenter.userId).toBe(b.id)
      expect(st?.tab).not.toBeNull()
      expect(st?.followers.map((f) => f.userId).sort()).toEqual([a.id, c.id].sort())
      await expect(live(b.page).count).toHaveText('2 following')
    })

    await test.step('bob drives: alice and carol follow his slides', async () => {
      await b.page.keyboard.press('End')
      await Promise.all([expectSlideOnScreen(a.page, F.three), expectSlideOnScreen(c.page, F.three)])
      await a.page.keyboard.press('ArrowRight') // alice follows now: her keys change nothing
      expect((await liveState(users, board)).presentation?.slideId).toBe(F.three)
    })

    await test.step('bob ends it (Esc): alice and carol are released', async () => {
      await b.page.keyboard.press('Escape')
      for (const s of [a, c]) {
        await expect(presentUi(s.page).overlay).toHaveCount(0)
        await expect(s.page.getByTestId('live-ended-toast')).toContainText('Bob Chen ended the presentation.')
      }
    })
  })

  test('the presenter closes the tab: followers see "reconnecting", an editor takes over; when the new presenter leaves too it ends for everyone after the grace', async ({
    board,
    session,
    users,
  }) => {
    test.setTimeout(150_000)
    const a = await session('alice')
    const b = await session('bob', { role: 'editor' })
    const c = await session('carol', { role: 'viewer' })
    await withDeck(a, [b, c])
    await presentToEveryone(a.page)
    await a.page.keyboard.press('ArrowRight')
    await joinPresentation(b.page, 'Alice Park')
    await joinPresentation(c.page, 'Alice Park')
    await expectSlideOnScreen(c.page, F.two)

    await test.step('alice closes her tab: bob and carol are told she is reconnecting; bob may take over, carol may not', async () => {
      await a.context.close()
      for (const s of [b, c]) {
        await expect(live(s.page).following).toHaveAttribute('data-state', 'waiting', { timeout: 15_000 })
        await expect(live(s.page).following).toContainText('Waiting for Alice Park to reconnect')
      }
      await expect(live(b.page).takeOver).toBeVisible()
      await expect(live(c.page).takeOver).toHaveCount(0)
    })

    await test.step('bob takes over: carol follows bob from the same slide', async () => {
      await live(b.page).takeOver.click()
      await expect(live(b.page).presenting).toBeVisible()
      await expect(live(c.page).following).toContainText('Following Bob Chen')
      await expect(live(c.page).following).toHaveAttribute('data-state', 'following')
      await expect(live(b.page).count).toHaveText('1 following')
      await b.page.keyboard.press('ArrowRight')
      await expectSlideOnScreen(c.page, F.three)
    })

    await test.step('bob closes his tab too: after the grace it ends, and carol is told why', async () => {
      await b.context.close()
      await expect(live(c.page).following).toHaveAttribute('data-state', 'waiting', { timeout: 15_000 })
      await expect(presentUi(c.page).overlay).toHaveCount(0, { timeout: 30_000 })
      await expect(c.page.getByTestId('live-ended-toast')).toContainText(
        'Bob Chen left the board, so the presentation ended.',
      )
      expect((await liveState(users, board, 'carol')).presentation).toBeNull()
    })
  })

  test('an api restart: the presenter’s tab puts the same presentation back and followers keep following', async ({
    board,
    session,
    users,
    stack,
  }) => {
    const a = await session('alice')
    const b = await session('bob', { role: 'viewer' })
    await withDeck(a, [b])
    await presentToEveryone(a.page)
    await joinPresentation(b.page, 'Alice Park')
    await a.page.keyboard.press('ArrowRight')
    await expectSlideOnScreen(b.page, F.two)
    const before = (await liveState(users, board)).presentation?.id

    await stack.api.restart()
    await expect
      .poll(async () => (await liveState(users, board)).presentation?.id ?? null, { timeout: 60_000 })
      .toBe(before)
    await expect
      .poll(async () => (await liveState(users, board)).presentation?.followers.map((f) => f.userId), {
        timeout: 60_000,
      })
      .toEqual([b.id])
    await expect(presentUi(b.page).overlay).toBeVisible()
    await a.page.keyboard.press('ArrowRight')
    await expectSlideOnScreen(b.page, F.three)
  })

  test('who may present: a viewer and a name-only guest (editor link) get no "Invite everyone" and the api refuses them; the guest follows alice', async ({
    board,
    browser,
    session,
    users,
  }) => {
    const a = await session('alice')
    const c = await session('carol', { role: 'viewer' })
    const g = await guestSession(browser, users, board, 'Sam Rivera')
    try {
      await withDeck(a, [c])
      await expectShapes(g.page, Object.values(F))
      const body = { tab: 'tab_testtesttesttesttest', slideId: F.one, index: 0, count: 3 }

      for (const [page, context] of [
        [c.page, c.context],
        [g.page, g.context],
      ] as const) {
        await presentUi(page).button.click()
        await expect(presentUi(page).overlay).toBeVisible()
        await wake(page)
        await expect(presentUi(page).exit).toBeVisible()
        await expect(live(page).inviteEveryone).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(presentUi(page).overlay).toHaveCount(0)
        const res = await post(context, `/api/boards/${board}/presentation`, body)
        expect(res.status()).toBe(403)
      }
      const guestRefusal = await post(g.context, `/api/boards/${board}/presentation`, body)
      expect(((await guestRefusal.json()) as { error: { code: string } }).error.code).toBe(
        'GUEST_ACCOUNT_REQUIRED',
      )

      await presentToEveryone(a.page)
      await joinPresentation(g.page, 'Alice Park')
      await expect(live(a.page).count).toHaveText('1 following')
      await expect(live(a.page).presenting).toHaveAttribute('title', 'Following: Sam Rivera (guest)')
      // The guest is not someone alice can hand over to (the api refuses it too).
      await wake(a.page)
      await live(a.page).handoff.click()
      await expect(a.page.getByTestId('handoff-empty')).toBeVisible()
      const id = (await liveState(users, board)).presentation?.id
      const res = await (await users.api('alice')).fetch(
        'POST',
        `/api/boards/${board}/presentation/handoff`,
        {
          id,
          userId: g.id,
        },
      )
      expect(res.status()).toBe(409)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('GUEST_CANNOT_PRESENT')
    } finally {
      await g.context.close()
    }
  })
})

test.describe('the people list', () => {
  test('search, roles and "(guest)"; follow and "who follows me"; Bring here; viewers cannot bring anyone', async ({
    board,
    browser,
    session,
    users,
  }) => {
    const a = await session('alice')
    const b = await session('bob', { role: 'editor' })
    const c = await session('carol', { role: 'viewer' })
    const g = await guestSession(browser, users, board, 'Sam Rivera')
    try {
      await seedBoard(a.page, DECK)
      await expectShapes(b.page, Object.values(F))
      const panel = a.page.getByTestId('people-panel')
      const row = (id: string) => panel.locator(`[data-testid="people-row"][data-user-id="${id}"]`)

      await test.step('alice opens the list: everyone on the board with their role, a guest marked "(guest)"', async () => {
        await expect(a.page.getByTestId('people-open')).toContainText('4')
        await a.page.getByTestId('people-open').click()
        await expect(panel.getByTestId('people-row')).toHaveCount(4)
        await expect(row(a.id)).toContainText('Alice Park (you)')
        await expect(row(a.id).getByTestId('people-role')).toHaveText('Owner')
        await expect(row(b.id).getByTestId('people-role')).toHaveText('Editor')
        await expect(row(c.id).getByTestId('people-role')).toHaveText('Viewer')
        await expect(row(g.id).getByTestId('guest-marker')).toHaveText(' (guest)')
        await expect(row(g.id).getByTestId('people-role')).toHaveText('Editor')
        // The search box has the focus: type to filter.
        await expect(panel.getByTestId('people-search')).toBeFocused()
        await a.page.keyboard.type('car')
        await expect(panel.getByTestId('people-row')).toHaveCount(1)
        await expect(row(c.id)).toBeVisible()
        await panel.getByTestId('people-search').fill('nobody here')
        await expect(panel.getByTestId('people-empty')).toBeVisible()
        await panel.getByTestId('people-search').fill('')
        await expect(panel.getByTestId('people-row')).toHaveCount(4)
      })

      await test.step('alice follows bob from the list: "Following Bob Chen"; bob sees that alice follows him', async () => {
        await row(b.id).getByTestId('people-follow').click()
        await expect(panel).toHaveCount(0)
        await expect(a.page.getByTestId('following-label')).toContainText('Following Bob Chen')
        await expect
          .poll(() =>
            read(
              a.page,
              (ed) =>
                (
                  ed as unknown as { getInstanceState(): { followingUserId: string | null } }
                ).getInstanceState().followingUserId,
            ),
          )
          .toBe(`user:${b.id}`)
        const followers = b.page.getByTestId('people-followers')
        await expect(followers).toHaveAttribute('data-count', '1')
        await expect(followers).toHaveAttribute('title', 'Alice Park is following you')
        await followers.click()
        const bPanel = b.page.getByTestId('people-panel')
        await expect(
          bPanel.locator(`[data-testid="people-row"][data-user-id="${a.id}"] [data-testid="people-status"]`),
        ).toHaveText('Following you')
        await b.page.keyboard.press('Escape')
        await expect(bPanel).toHaveCount(0)
      })

      await test.step('alice stops following: bob’s indicator goes', async () => {
        await a.page.getByTestId('people-open').click()
        await expect(row(b.id).getByTestId('people-follow')).toHaveAttribute('aria-pressed', 'true')
        await row(b.id).getByTestId('people-follow').click()
        await expect(row(b.id).getByTestId('people-follow')).toHaveAttribute('aria-pressed', 'false')
        await expect(b.page.getByTestId('people-followers')).toHaveCount(0)
        await expect(a.page.getByTestId('following-label')).toHaveCount(0)
      })

      await test.step('"Bring here" on carol: only carol follows alice now', async () => {
        await row(c.id).getByTestId('people-bring').click()
        await expect(a.page.getByTestId('summon-toast')).toContainText('Carol Diaz now follows your view')
        await expect
          .poll(() =>
            read(
              c.page,
              (ed) =>
                (
                  ed as unknown as { getInstanceState(): { followingUserId: string | null } }
                ).getInstanceState().followingUserId,
            ),
          )
          .toBe(`user:${a.id}`)
        const following = (p: Page) =>
          read(
            p,
            (ed) =>
              (ed as unknown as { getInstanceState(): { followingUserId: string | null } }).getInstanceState()
                .followingUserId,
          )
        expect(await following(b.page)).toBeNull()
        expect(await following(g.page)).toBeNull()
        await expect(a.page.getByTestId('people-followers')).toHaveAttribute('data-count', '1')
      })

      await test.step('carol (viewer) sees the list but no "Bring here"', async () => {
        await c.page.getByTestId('people-open').click()
        const cPanel = c.page.getByTestId('people-panel')
        await expect(cPanel.getByTestId('people-row')).toHaveCount(4)
        await expect(cPanel.getByTestId('people-bring')).toHaveCount(0)
        await expect(cPanel.getByTestId('people-bring-all')).toHaveCount(0)
        await expect(cPanel.getByTestId('people-follow')).toHaveCount(3)
      })
    } finally {
      await g.context.close()
    }
  })
})
