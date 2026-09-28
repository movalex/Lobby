// Fix batch "security-web" (docs/SECURITY-REVIEW-2026-09-27.md, the web half of SCA-1, SCA-4 and
// authz-001): each test is the browser check for one fixed finding; the finding id is in its title.
// The unit tests next to the code cover the rest: apps/web/src/auth/signOut.test.ts (the sign-out
// sequence, the explicit-sign-out mark and the Clerk "Continue as" gate, which needs a live Clerk
// instance to run in a browser) and apps/web/src/features/history/model.test.ts (who sees the list).
// Everything here runs with the dev sign-in provider.
import type { Page, Route } from '@playwright/test'
import { displayName } from './support/api.ts'
import { edit, openSession, type Session, signInThroughUi, waitForBoard } from './support/board.ts'
import { freshHandle, signedInContext } from './support/dashboard-share.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import {
  checkpointRow,
  deletedRow,
  deleteWithKeyboard,
  expectServerHasTab,
  historyPanel,
  listDeleted,
  openHistory,
} from './support/history.ts'
import { capture } from './support/screenshots.ts'
import { THEME_KEY } from './support/theme.ts'

/** Set in sessionStorage by an explicit sign-out (apps/web/src/auth/signOutMark.ts). */
const SIGNED_OUT_MARK = 'draftroom:signed-out'
const REVOKE_ALL = '**/api/auth/sessions/revoke-all'

/** Every request the page makes for the board's "Recently deleted" list. */
function recordDeletedListRequests(page: Page, boardId: string): string[] {
  const seen: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === `/api/boards/${boardId}/deleted`)
      seen.push(r.url())
  })
  return seen
}

/** Two notes on the board, one of them deleted by `s` (and listed by the server). */
async function deleteOneOfTwoNotes(s: Session, api: Parameters<typeof listDeleted>[0], boardId: string) {
  const GONE = 'shape:sec-gone'
  await edit(
    s.page,
    (ed, x) =>
      ed.createShapes([
        { id: x.gone, type: 'note', x: 120, y: 120, props: { richText: x.t1 } },
        { id: x.keep, type: 'note', x: 380, y: 120, props: { richText: x.t2, color: 'green' } },
      ]),
    {
      gone: GONE,
      keep: 'shape:sec-keep',
      t1: richText('Internal: client budget is 40k'),
      t2: richText('Welcome to the review'),
    },
  )
  // A create and a delete in the same push never reach the server as a delete: let the create land.
  await expectServerHasTab(api, boardId, s.page)
  await deleteWithKeyboard(s.page, [GONE])
  await expect
    .poll(async () => (await listDeleted(api, boardId)).entries.map((e) => e.shapeId))
    .toEqual([GONE])
  return GONE
}

const recentlyDeletedHeading = (page: Page) =>
  historyPanel(page).getByRole('heading', { name: 'Recently deleted' })

// ---- authz-001 ---------------------------------------------------------------------------------------

test('authz-001: "Recently deleted" is shown to the owner and editors only; a commenter, a viewer and a review-link guest never see it and never request it', async ({
  session,
  board,
  users,
  browser,
}) => {
  const aliceApi = await users.api('alice')
  const owner = await session('alice')
  const GONE = await deleteOneOfTwoNotes(owner, aliceApi, board)

  await test.step('owner and editor: the list shows the deleted note with restore', async () => {
    const editor = await session('bob', { role: 'editor' })
    for (const s of [owner, editor]) {
      await openHistory(s.page)
      await expect(recentlyDeletedHeading(s.page)).toBeVisible()
      await expect(deletedRow(s.page, GONE)).toContainText('Internal: client budget is 40k')
      await expect(deletedRow(s.page, GONE).getByTestId('deleted-restore')).toBeVisible()
    }
  })

  for (const [handle, role] of [
    ['carol', 'commenter'],
    ['dave', 'viewer'],
  ] as const) {
    await test.step(`${role}: no "Recently deleted" section, and the page never asks for it`, async () => {
      const s = await session(handle, { role })
      const requested = recordDeletedListRequests(s.page, board)
      await openHistory(s.page)
      await expect(recentlyDeletedHeading(s.page)).toHaveCount(0)
      await expect(deletedRow(s.page)).toHaveCount(0)
      await expect(historyPanel(s.page)).not.toContainText('client budget')
      for (const id of ['deleted-restore', 'deleted-select', 'deleted-restore-selected']) {
        await expect(s.page.getByTestId(id), id).toHaveCount(0)
      }
      // The rest of the panel still works for them: checkpoints and the export.
      await expect(historyPanel(s.page).getByRole('heading', { name: 'Checkpoints' })).toBeVisible()
      await expect(s.page.getByTestId('export-json')).toBeVisible()
      // Reopening the panel (it remounts) does not fetch it either.
      await s.page.getByTestId('dock-tab-history').click()
      await expect(historyPanel(s.page)).toHaveCount(0)
      await openHistory(s.page)
      expect(requested).toEqual([])
    })
  }

  await test.step('review-link guest (an outsider on a view link to a board in alice’s own workspace)', async () => {
    const aliceUser = await users.get('alice')
    const personalBoard = (await aliceApi.createBoard(aliceUser.personalWorkspaceId, 'Client review')).id
    const a = await openSession(browser, personalBoard, aliceUser)
    const contexts = [a.context]
    try {
      const gone = await deleteOneOfTwoNotes(a, aliceApi, personalBoard)
      const created = await aliceApi.fetch('POST', `/api/boards/${personalBoard}/review-links`, {
        role: 'viewer',
      })
      expect(created.status()).toBe(201)
      const link = ((await created.json()) as { url: string }).url

      const guest = { handle: freshHandle('client'), name: 'Casey Client' }
      const context = await browser.newContext()
      contexts.push(context)
      const page = await context.newPage()
      const requested = recordDeletedListRequests(page, personalBoard)
      await page.goto(link)
      await expect(page.getByTestId('invite-role-label')).toHaveText('Can view')
      await page.getByTestId('invite-signin').click()
      await signInThroughUi(page, guest)
      await expect(page).toHaveURL(new RegExp(`/b/${personalBoard}$`))
      await waitForBoard(page)
      await expect(page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'viewer')

      await openHistory(page)
      await expect(recentlyDeletedHeading(page)).toHaveCount(0)
      await expect(deletedRow(page, gone)).toHaveCount(0)
      await expect(historyPanel(page)).not.toContainText('client budget')
      // A guest cannot make boards: no restore-as-new or duplicate, only the export.
      await expect(checkpointRow(page).getByTestId('checkpoint-restore')).toHaveCount(0)
      await expect(page.getByTestId('history-duplicate')).toHaveCount(0)
      await expect(page.getByTestId('export-json')).toBeVisible()
      expect(requested).toEqual([])
    } finally {
      await Promise.all(contexts.map((c) => c.close()))
    }
  })
})

// ---- SCA-1 (web) ---------------------------------------------------------------------------------------

async function openAccountMenu(page: Page) {
  await page.getByTestId('dev-identity-badge').click()
  await expect(page.getByRole('dialog', { name: 'Your account' })).toBeVisible()
}

const signedOutMark = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key), SIGNED_OUT_MARK)
const meStatus = async (page: Page) => (await page.request.get('/api/me')).status()

test('SCA-1: "Sign out" ends the session for good: /signin stays signed out after a reload, the explicit sign-out mark is set, and the next sign-in clears it', async ({
  browser,
  stackReady: _,
}) => {
  const handle = freshHandle('sam')
  const person = await signedInContext(browser, handle, { name: 'Sam Signout' })
  try {
    const { page } = person
    await page.goto('/')
    await expect(page.getByTestId('dashboard')).toBeVisible()
    expect(await signedOutMark(page)).toBeNull()

    await openAccountMenu(page)
    await page.getByTestId('sign-out').click()
    await expect(page).toHaveURL(/\/signin$/)
    await expect(page.getByTestId('signin-form')).toBeVisible()
    expect(await meStatus(page)).toBe(401)
    // The mark that stops the sign-in page from trading a live Clerk session back in without a click.
    expect(JSON.parse((await signedOutMark(page)) ?? 'null')).toMatchObject({ clerk: 'none' })

    await page.reload()
    await expect(page.getByTestId('signin-form')).toBeVisible()
    expect(await meStatus(page)).toBe(401)
    await page.goto('/')
    await expect(page).toHaveURL(/\/signin$/)

    // Signing in again (a click: the dev form) is what clears the mark.
    await signInThroughUi(page, { handle, name: 'Sam Signout' })
    await expect(page.getByTestId('dashboard')).toBeVisible()
    expect(await signedOutMark(page)).toBeNull()
  } finally {
    await person.context.close()
  }
})

test('SCA-1: a failed sign-out is reported and the person stays signed in (no signed-out screen over a live session); "Try again" finishes it', async ({
  browser,
  stackReady: _,
}, testInfo) => {
  const person = await signedInContext(browser, freshHandle('lou'), { name: 'Lou Logout' })
  try {
    const { page } = person
    // In the dark theme: the alert is drawn from the theme tokens.
    await person.context.addInitScript((key) => localStorage.setItem(key, 'dark'), THEME_KEY)
    await page.goto('/')
    await expect(page.getByTestId('dashboard')).toBeVisible()
    const dashboardUrl = page.url()

    const failLogout = (route: Route) =>
      route.fulfill({
        status: 500,
        json: { error: { code: 'INTERNAL', message: 'Draftroom had a problem handling that.' } },
      })
    await page.route('**/api/auth/logout', failLogout)
    await openAccountMenu(page)
    await page.getByTestId('sign-out').click()
    const alert = page.getByTestId('signout-error')
    await expect(alert).toBeVisible()
    await expect(alert).toHaveAttribute('data-reason', 'logout')
    await expect(alert).toContainText('You are still signed in')
    await expect(page).toHaveURL(dashboardUrl)
    await expect(page.getByTestId('dashboard')).toBeVisible()
    expect(await meStatus(page)).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await capture('signout-failed-dark.png', page, testInfo)

    // The retry reaches the real API (a little late): the alert stays up and says so meanwhile.
    await page.unroute('**/api/auth/logout', failLogout)
    await page.route('**/api/auth/logout', async (route) => {
      await new Promise((r) => setTimeout(r, 600))
      await route.continue()
    })
    await alert.getByTestId('signout-retry').click()
    await expect(alert.getByTestId('signout-retry')).toHaveText('Signing out…')
    await expect(alert.getByTestId('signout-retry')).toBeDisabled()
    await expect(page).toHaveURL(/\/signin$/)
    await expect(page.getByTestId('signout-error')).toHaveCount(0)
    expect(await meStatus(page)).toBe(401)
  } finally {
    await person.context.close()
  }
})

// ---- SCA-4 (web) ---------------------------------------------------------------------------------------

test('SCA-4: "Sign out everywhere" calls POST /api/auth/sessions/revoke-all; an API without the route (404) says so and changes nothing; success ends this session too', async ({
  browser,
  stackReady: _,
}, testInfo) => {
  const handle = freshHandle('eve')
  const person = await signedInContext(browser, handle, { name: displayName(handle) })
  try {
    const { page } = person
    await page.goto('/')
    await expect(page.getByTestId('dashboard')).toBeVisible()
    const calls: string[] = []
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/auth/sessions/revoke-all') calls.push(r.method())
    })

    await test.step('an API without the route: a clear message, still signed in, no mark left behind', async () => {
      await page.route(REVOKE_ALL, (route) =>
        route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } }),
      )
      await openAccountMenu(page)
      await capture(
        'account-menu-sign-out-everywhere.png',
        page.getByRole('dialog', { name: 'Your account' }),
        testInfo,
      )
      await page.getByTestId('sign-out-everywhere').click()
      const alert = page.getByTestId('signout-error')
      await expect(alert).toHaveAttribute('data-reason', 'unsupported')
      await expect(alert).toContainText('not available on this server yet')
      await capture('sign-out-everywhere-unsupported.png', page, testInfo)
      await expect(alert.getByTestId('signout-retry')).toHaveCount(0)
      await expect(page.getByTestId('dashboard')).toBeVisible()
      expect(await meStatus(page)).toBe(200)
      expect(await signedOutMark(page)).toBeNull()
      await alert.getByTestId('signout-dismiss').click()
      await expect(alert).toHaveCount(0)
      await page.unrouteAll()
    })

    await test.step('the route answers 204: this browser is signed out as well and lands on /signin', async () => {
      await page.route(REVOKE_ALL, (route) => route.fulfill({ status: 204 }))
      await openAccountMenu(page)
      await page.getByTestId('sign-out-everywhere').click()
      await expect(page).toHaveURL(/\/signin$/)
      expect(await meStatus(page)).toBe(401)
      expect(await signedOutMark(page)).not.toBeNull()
      await page.unrouteAll()
    })
    expect(calls).toEqual(['POST', 'POST'])
  } finally {
    await person.context.close()
  }
})
