// The people list and follow on the Excalidraw board page (ported from tests/present-live.spec.ts "the
// people list"; WRK-02, FAC-01, FAC-10): the top-bar item `people` replaces the page's own avatars; the
// list shows everyone with their role and "(guest)", searches, follows (the canvas's `follow`, on the
// followed person's presence view), and "Bring here" for people who can edit.
//
// Split from the tldraw test by what each part needs: "who follows me" needs a follow target in Lobby's
// presence (CR-3C-1: canvas-schema PresenceIn has none), and "Bring here" needs the workshops feature's
// summon handler on this page (3f's port). Both are expected failures until those land.
import type { Browser } from '@playwright/test'
import {
  type CanvasSession,
  expect,
  setViewport,
  test,
  viewport,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import type { Users } from '../tests/support/users.ts'
import { canvasRect, followingSid, sessionId } from './comments-kit.ts'

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

const panelOf = (s: CanvasSession) => s.page.getByTestId('people-panel')
const rowOf = (s: CanvasSession, id: string) =>
  panelOf(s).locator(`[data-testid="people-row"][data-user-id="${id}"]`)

test('the people list: search, roles and "(guest)"; follow from the list ("Following Bob Chen") and stop; viewers cannot bring anyone', async ({
  board,
  browser,
  canvasSession,
  users,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const c = await canvasSession('carol', { role: 'viewer' })
  const g = await guestSession(browser, users, board, 'Sam Rivera')
  try {
    await test.step('the top bar lists the others (the page’s own avatars step aside for it)', async () => {
      await expect(a.page.getByTestId('people')).toBeVisible()
      await expect(a.page.getByTestId('presence-list')).toHaveCount(1)
      for (const who of [b, c]) {
        const avatar = a.page.locator(`[data-testid="presence-user"][data-user-id="${who.id}"]`)
        await expect(avatar).toHaveAttribute('title', who.name)
      }
      await expect(a.page.locator(`[data-testid="presence-user"][data-user-id="${a.id}"]`)).toHaveCount(0)
    })

    await test.step('alice opens the list: everyone on the board with their role, a guest marked "(guest)"', async () => {
      await expect(a.page.getByTestId('people-open')).toContainText('4')
      await a.page.getByTestId('people-open').click()
      await expect(panelOf(a).getByTestId('people-row')).toHaveCount(4)
      await expect(rowOf(a, a.id)).toContainText('Alice Park (you)')
      await expect(rowOf(a, a.id).getByTestId('people-role')).toHaveText('Owner')
      await expect(rowOf(a, b.id).getByTestId('people-role')).toHaveText('Editor')
      await expect(rowOf(a, c.id).getByTestId('people-role')).toHaveText('Viewer')
      await expect(rowOf(a, g.id).getByTestId('guest-marker')).toHaveText(' (guest)')
      await expect(rowOf(a, g.id).getByTestId('people-role')).toHaveText('Editor')
      // The search box has the focus: type to filter.
      await expect(panelOf(a).getByTestId('people-search')).toBeFocused()
      await a.page.keyboard.type('car')
      await expect(panelOf(a).getByTestId('people-row')).toHaveCount(1)
      await expect(rowOf(a, c.id)).toBeVisible()
      await panelOf(a).getByTestId('people-search').fill('nobody here')
      await expect(panelOf(a).getByTestId('people-empty')).toBeVisible()
      await panelOf(a).getByTestId('people-search').fill('')
      await expect(panelOf(a).getByTestId('people-row')).toHaveCount(4)
    })

    await test.step('alice follows bob from the list: "Following Bob Chen"; her view follows his', async () => {
      await rowOf(a, b.id).getByTestId('people-follow').click()
      await expect(panelOf(a)).toHaveCount(0)
      await expect(a.page.getByTestId('following-label')).toContainText('Following Bob Chen')
      await expect.poll(() => followingSid(a.page)).toBe(await sessionId(b.page))
      // bob moves his camera (no pointer move): alice's view fits his, centred
      await setViewport(b.page, { x: 3000, y: 2000, zoom: 1 })
      const want = await viewport(b.page)
      await expect
        .poll(async () => {
          const v = await viewport(a.page)
          return Math.round(
            Math.hypot(
              v.x + v.width / 2 - (want.x + want.width / 2),
              v.y + v.height / 2 - (want.y + want.height / 2),
            ),
          )
        })
        .toBeLessThanOrEqual(2)
    })

    await test.step('alice stops following from the list; following again and a wheel over the canvas stops it too', async () => {
      await a.page.getByTestId('people-open').click()
      await expect(rowOf(a, b.id).getByTestId('people-follow')).toHaveAttribute('aria-pressed', 'true')
      await rowOf(a, b.id).getByTestId('people-follow').click()
      await expect(rowOf(a, b.id).getByTestId('people-follow')).toHaveAttribute('aria-pressed', 'false')
      await expect(a.page.getByTestId('following-label')).toHaveCount(0)
      expect(await followingSid(a.page)).toBeNull()
      await a.page.keyboard.press('Escape')
      await expect(panelOf(a)).toHaveCount(0)
      // the avatar follows too, and moving the camera yourself ends it (FAC-02)
      await a.page.locator(`[data-testid="presence-user"][data-user-id="${b.id}"] button`).click()
      await expect(a.page.getByTestId('following-label')).toContainText('Following Bob Chen')
      const r = await canvasRect(a.page)
      await a.page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
      await a.page.mouse.wheel(0, 200)
      await expect(a.page.getByTestId('following-label')).toHaveCount(0)
      expect(await followingSid(a.page)).toBeNull()
      // and "Stop following" on the label
      await a.page.locator(`[data-testid="presence-user"][data-user-id="${b.id}"] button`).click()
      await a.page.getByTestId('following-stop').click()
      await expect(a.page.getByTestId('following-label')).toHaveCount(0)
    })

    await test.step('carol (viewer) sees the list but no "Bring here"', async () => {
      await c.page.getByTestId('people-open').click()
      await expect(panelOf(c).getByTestId('people-row')).toHaveCount(4)
      await expect(panelOf(c).getByTestId('people-bring')).toHaveCount(0)
      await expect(panelOf(c).getByTestId('people-bring-all')).toHaveCount(0)
      await expect(panelOf(c).getByTestId('people-follow')).toHaveCount(3)
    })
  } finally {
    await g.context.close()
  }
})

test('who follows me: bob sees that alice follows him, and "Following you" in his list (CR-3C-1)', async ({
  canvasSession,
}) => {
  // CR-3C-1: Lobby's presence carries no follow target (canvas-schema PresenceIn/PeerPresence), so
  // nobody can tell who follows them by camera. Remove the mark when the protocol and the room relay it.
  test.fail(true, 'CR-3C-1: presence has no follow target')
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  await a.page.getByTestId('people-open').click()
  await rowOf(a, b.id).getByTestId('people-follow').click()
  await expect(a.page.getByTestId('following-label')).toContainText('Following Bob Chen')
  const followers = b.page.getByTestId('people-followers')
  await expect(followers).toHaveAttribute('data-count', '1', { timeout: 5_000 })
  await expect(followers).toHaveAttribute('title', 'Alice Park is following you')
  await followers.click()
  await expect(rowOf(b, a.id).getByTestId('people-status')).toHaveText('Following you')
})

test('"Bring here" on carol: only carol follows alice now (3f: the summon handler)', async ({
  canvasSession,
}) => {
  // The receiving side of "Bring here" / "Gather everyone" (follow the summoner) is the workshops feature's
  // (features/workshops, 3f's port, on canvas.follow.start). Remove the mark when it lands.
  test.fail(true, '3f: the workshops summon handler is not on the Excalidraw page yet')
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const c = await canvasSession('carol', { role: 'viewer' })
  await a.page.getByTestId('people-open').click()
  await rowOf(a, c.id).getByTestId('people-bring').click()
  await expect(a.page.getByTestId('summon-toast')).toContainText('Carol Diaz now follows your view')
  await expect.poll(() => followingSid(c.page), { timeout: 5_000 }).toBe(await sessionId(a.page))
  expect(await followingSid(b.page)).toBeNull()
})
