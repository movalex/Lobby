// Wave W (WS5): the workspace admin page, /w/:wid/admin (docs/WAVE-W-CONTRACTS.md §7).
//  - alice (the Dev Studio owner) opens it from the workspace menu; the five tabs work from the keyboard;
//  - a role change on the members tab goes through the existing route and shows in the audit log, with the person's
//    name and never an address;
//  - an open guest link and the guest who joined through it are listed; revoking the link there is the Share dialog's
//    revoke: the guest loses the board;
//  - storage and retention read; nothing on the page deletes anything for good;
//  - a member, a name-only guest and someone of another workspace each get the unknown-address screen, and the api
//    answers each of them 404 on every admin route;
//  - at phone width no tab scrolls sideways; no request leaves Lobby's origins.
//  - (the integration) opened directly while the config is slow, the owner sees the loading screen, never "Page not
//    found" first.
// The web switch (FORMATS_FLAGS.admin, on since the integration) is also set per context through the dev-auth
// localStorage key; the e2e stack turns DRAFTROOM_WORKSPACE_ADMIN on.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e test -- w5-admin
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { Api, signInContext } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/canvas.ts'
import { freshHandle } from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { guestOn, noHorizontalScroll, tokenOf } from './guests-kit.ts'
import { foreignRequests } from './v2-kit.ts'

/** features/formats/flags.ts FORMATS_FLAG_KEYS.admin (e2e declares no dependency on the web package) */
const ADMIN_FLAG_KEY = 'lobby.formatsAdmin'
const ADMIN_ROUTES = [
  'members',
  'invitations',
  'storage/by-board',
  'storage/by-uploader',
  'audit',
  'links',
  'retention',
]
const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }

async function withAdminFlag(context: BrowserContext) {
  await context.addInitScript((key) => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      /* a blocked store keeps the shipped value */
    }
  }, ADMIN_FLAG_KEY)
}

async function signedIn(
  browser: Browser,
  handle: string,
  viewport = { width: 1360, height: 860 },
): Promise<{ context: BrowserContext; page: Page; me: Awaited<ReturnType<typeof signInContext>> }> {
  const context = await browser.newContext({ viewport })
  await withAdminFlag(context)
  const me = await signInContext(context, handle)
  return { context, page: await context.newPage(), me }
}

const adminUrl = (wid: string) => `/w/${wid}/admin`

/** The page says only that there is nothing here, and the api answers every admin route as an unknown one. */
async function expectNoAdminPage(page: Page, wid: string) {
  await page.goto(adminUrl(wid))
  await expect(page.getByText('Page not found')).toBeVisible()
  await expect(page.getByTestId('workspace-admin')).toHaveCount(0)
  for (const tail of ADMIN_ROUTES) {
    const res = await page.request.get(`${WEB_URL}/api/workspaces/${wid}/admin/${tail}`)
    expect(res.status(), tail).toBe(404)
    expect(await res.json(), tail).toEqual(UNKNOWN)
  }
}

test('the owner opens the admin page from the workspace menu; the tabs work from the keyboard; a role change shows in the audit log', async ({
  browser,
  users,
  playwright,
}, testInfo) => {
  const alice = await signedIn(browser, 'alice')
  // someone new in Dev Studio (a plain member) whose role alice changes, so no other spec's people move
  const handle = freshHandle('wsm')
  const member = await Api.signIn(playwright, handle)
  try {
    const foreign = foreignRequests(alice.page)
    await alice.page.goto(`/w/${users.devStudioId}`)
    await expect(alice.page.getByTestId('dashboard')).toHaveAttribute('data-workspace-id', users.devStudioId)
    await alice.page.getByTestId('workspace-switcher').click()
    await alice.page.getByTestId('workspace-admin-link').click()
    await expect(alice.page).toHaveURL(new RegExp(`/w/${users.devStudioId}/admin`))
    const page = alice.page.getByTestId('workspace-admin')
    await expect(page).toBeVisible()
    await expect(page.getByTestId('workspace-admin-name')).toHaveText('Dev Studio')

    await test.step('the tabs: arrows, Home and End move and select; the address keeps the tab', async () => {
      const members = page.getByTestId('admin-tab-members')
      await expect(members).toHaveAttribute('aria-selected', 'true')
      await members.focus()
      await alice.page.keyboard.press('ArrowRight')
      await expect(page.getByTestId('admin-tab-storage')).toBeFocused()
      await expect(page.getByTestId('admin-tab-storage')).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByTestId('admin-panel-storage')).toBeVisible()
      await expect(alice.page).toHaveURL(/\?tab=storage$/)
      await alice.page.keyboard.press('End')
      await expect(page.getByTestId('admin-tab-retention')).toBeFocused()
      await expect(page.getByTestId('admin-retention')).toBeVisible()
      await alice.page.keyboard.press('ArrowRight')
      await expect(page.getByTestId('admin-tab-members')).toBeFocused()
      await alice.page.keyboard.press('ArrowLeft')
      await expect(page.getByTestId('admin-tab-retention')).toBeFocused()
      await alice.page.keyboard.press('Home')
      await expect(page.getByTestId('admin-tab-members')).toHaveAttribute('aria-selected', 'true')
      // Tab leaves the tablist for the panel (only the selected tab is in the tab order)
      await alice.page.keyboard.press('Tab')
      expect(await alice.page.evaluate(() => document.activeElement?.getAttribute('role') ?? null)).not.toBe(
        'tab',
      )
    })

    await test.step('members: the new member is there; the role changes through the existing route', async () => {
      const row = page.locator(`[data-testid="admin-member"][data-user-id="${member.me.user.id}"]`)
      await expect(row).toHaveAttribute('data-role', 'member')
      await expect(row).toContainText('Creator')
      await expect(row.getByTestId('admin-member-grants')).toHaveText('No direct board access')
      // alice's own row has no controls
      const own = page.locator(`[data-testid="admin-member"][data-user-id="${alice.me.user.id}"]`)
      await expect(own).toContainText('(you)')
      await expect(own.getByTestId('admin-member-role')).toBeDisabled()
      await expect(own.getByTestId('admin-member-remove')).toHaveCount(0)
      const changed = alice.page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/members/${member.me.user.id}`),
      )
      await row.getByTestId('admin-member-role').selectOption('admin')
      expect((await changed).status()).toBe(200)
      await expect(row).toHaveAttribute('data-role', 'admin')
      await row.getByTestId('admin-member-role').selectOption('member')
      await expect(row).toHaveAttribute('data-role', 'member')
      // Remove asks first; Escape cancels and nothing changes
      await row.getByTestId('admin-member-remove').click()
      const confirm = row.getByTestId('admin-member-remove-confirm')
      await expect(confirm).toContainText(`Remove ${handle} from Dev Studio?`)
      await alice.page.keyboard.press('Escape')
      await expect(confirm).toHaveCount(0)
      await expect(row).toHaveAttribute('data-role', 'member')
    })

    await test.step('the audit log names who changed what, by name, never an address', async () => {
      await page.getByTestId('admin-tab-audit').click()
      await page.getByTestId('admin-audit-action').selectOption('workspace.')
      const rows = page.locator('[data-testid="admin-audit-row"][data-action="workspace.member.role"]')
      await expect(rows.first()).toBeVisible()
      await expect(rows.first()).toContainText(alice.me.user.name)
      await expect(rows.first()).toContainText('changed a workspace role')
      await expect(rows.first().getByTestId('admin-audit-detail')).toContainText(handle)
      await expect(rows.first().getByTestId('admin-audit-detail')).toContainText('member')
      const text = (await page.getByTestId('admin-audit-list').textContent()) ?? ''
      expect(text).not.toContain('@')
      expect(text).not.toContain('http')
      await alice.page.screenshot({ path: testInfo.outputPath('desktop-audit.png'), fullPage: true })
      await page.getByTestId('admin-tab-members').click()
      await expect(page.getByTestId('admin-members')).toBeVisible()
      await alice.page.screenshot({ path: testInfo.outputPath('desktop-members.png'), fullPage: true })
    })
    expect(foreign).toEqual([])
  } finally {
    await member.api.dispose()
    await alice.context.close()
  }
})

test('links and guests: the open link and its guest are listed; revoking from the admin page removes the guest from the board', async ({
  browser,
  board,
  users,
}) => {
  const aliceApi = await users.api('alice')
  const made = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'commenter',
    allowGuests: true,
  })
  expect(made.status(), await made.text()).toBe(201)
  const link = (await made.json()) as { id: string; url: string }
  const guestContext = await browser.newContext()
  const guest = await guestOn(guestContext, tokenOf(link.url), 'Sam Guest')
  const alice = await signedIn(browser, 'alice')
  try {
    await alice.page.goto(`${adminUrl(users.devStudioId)}?tab=links`)
    const page = alice.page.getByTestId('workspace-admin')
    await expect(page.getByTestId('admin-tab-links')).toHaveAttribute('aria-selected', 'true')
    const row = page.locator(`[data-testid="admin-link"][data-link-id="${link.id}"]`)
    await expect(row).toContainText('Review link')
    await expect(row).toContainText('Guests by name')
    await expect(row.getByTestId('admin-link-uses')).toHaveText('1 use')
    // never the link's address
    expect((await page.getByTestId('admin-links').textContent()) ?? '').not.toContain('/invite/')
    const guestRow = page.locator(`[data-testid="admin-guest"][data-user-id="${guest.id}"]`)
    await expect(guestRow).toContainText('Sam Guest')
    await expect(
      guestRow.locator(`[data-testid="admin-guest-remove"][data-board-id="${board}"]`),
    ).toBeVisible()

    await row.getByTestId('admin-link-revoke').click()
    const confirm = row.getByTestId('admin-link-revoke-confirm')
    await expect(confirm.getByTestId('admin-link-remove-access')).toBeChecked()
    const revoked = alice.page.waitForResponse((r) => r.url().endsWith(`/review-links/${link.id}/revoke`))
    await confirm.getByTestId('admin-link-revoke-confirm-yes').click()
    const res = await revoked
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ removed: 1 })
    await expect(row).toHaveCount(0)
    await expect(guestRow).toHaveCount(0)
    // the Share dialog's list agrees, and the guest lost the board
    const share = await aliceApi.fetch('GET', `/api/boards/${board}/invitations`)
    expect(((await share.json()).invitations as { id: string }[]).map((i) => i.id)).not.toContain(link.id)
    const theirs = await guestContext.request.get(`${WEB_URL}/api/boards/${board}`)
    expect(theirs.status()).not.toBe(200)
  } finally {
    await guest.page.close()
    await guestContext.close()
    await alice.context.close()
  }
})

test('a member, a name-only guest and someone of another workspace get the unknown-address screen and 404 from every admin route', async ({
  browser,
  board,
  users,
}) => {
  const bob = await signedIn(browser, 'bob')
  const aliceApi = await users.api('alice')
  const made = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'viewer',
    allowGuests: true,
  })
  expect(made.status()).toBe(201)
  const guestContext = await browser.newContext()
  await withAdminFlag(guestContext)
  const guest = await guestOn(
    guestContext,
    tokenOf(((await made.json()) as { url: string }).url),
    'Pat Guest',
  )
  const alice = await users.get('alice')
  try {
    // a member of Dev Studio (bob owns boards there; he is no owner or admin)
    await expectNoAdminPage(bob.page, users.devStudioId)
    // a name-only guest on one of its boards
    await expectNoAdminPage(guest.page, users.devStudioId)
    // someone of another workspace: bob is no member of alice's personal workspace
    await expectNoAdminPage(bob.page, alice.personalWorkspaceId)
    // and the menu offers bob no entry in Dev Studio
    await bob.page.goto(`/w/${users.devStudioId}`)
    await expect(bob.page.getByTestId('dashboard')).toBeVisible()
    const switcher = bob.page.getByTestId('workspace-switcher')
    if ((await switcher.getAttribute('aria-expanded')) !== null) await switcher.click()
    await expect(bob.page.getByTestId('workspace-admin-link')).toHaveCount(0)
    // the owner, for contrast, reads them all (a 429 is her 20 requests per 10 s from the specs before: wait it out)
    const owner = await signedIn(browser, 'alice')
    try {
      for (const tail of ADMIN_ROUTES)
        await expect
          .poll(
            async () =>
              (
                await owner.page.request.get(`${WEB_URL}/api/workspaces/${users.devStudioId}/admin/${tail}`)
              ).status(),
            { message: tail, timeout: 20_000, intervals: [1_000] },
          )
          .toBe(200)
    } finally {
      await owner.context.close()
    }
  } finally {
    await bob.context.close()
    await guestContext.close()
  }
})

test('opened directly while the config is slow, the owner sees the loading screen, never Page not found first', async ({
  browser,
  users,
}) => {
  const alice = await signedIn(browser, 'alice')
  try {
    // the offer arrives with GET /api/auth/config: hold it back, and record every screen the page shows meanwhile
    await alice.page.route('**/api/auth/config', async (route) => {
      await new Promise((r) => setTimeout(r, 1_500))
      await route.continue()
    })
    await alice.page.addInitScript(() => {
      const w = window as unknown as { __notFound?: boolean; __loading?: boolean }
      const look = () => {
        if (document.body?.textContent?.includes('Page not found')) w.__notFound = true
        if (document.querySelector('[data-testid="workspace-admin-loading"]')) w.__loading = true
      }
      new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true })
    })
    await alice.page.goto(adminUrl(users.devStudioId))
    await expect(alice.page.getByTestId('workspace-admin')).toBeVisible({ timeout: 20_000 })
    const seen = await alice.page.evaluate(() => {
      const w = window as unknown as { __notFound?: boolean; __loading?: boolean }
      return { notFound: w.__notFound === true, loading: w.__loading === true }
    })
    expect(seen).toEqual({ notFound: false, loading: true })
  } finally {
    await alice.context.close()
  }
})

test('at phone width no tab of the admin page scrolls sideways', async ({ browser, users }, testInfo) => {
  const alice = await signedIn(browser, 'alice', { width: 390, height: 844 })
  try {
    await alice.page.goto(adminUrl(users.devStudioId))
    const page = alice.page.getByTestId('workspace-admin')
    await expect(page).toBeVisible()
    for (const tab of ['members', 'storage', 'audit', 'links', 'retention']) {
      await page.getByTestId(`admin-tab-${tab}`).click()
      await expect(page.getByTestId(`admin-panel-${tab}`)).toBeVisible()
      // the tab's content has loaded (no spinner left)
      await expect(page.getByRole('status')).toHaveCount(0)
      expect(await noHorizontalScroll(alice.page), tab).toBe(true)
      await alice.page.screenshot({ path: testInfo.outputPath(`phone-${tab}.png`), fullPage: true })
    }
    // the five tabs fit (they wrap rather than scroll)
    for (const tab of ['members', 'storage', 'audit', 'links', 'retention'])
      await expect(page.getByTestId(`admin-tab-${tab}`)).toBeInViewport()
  } finally {
    await alice.context.close()
  }
})
