// PORTED from e2e/tests/guests-2.spec.ts (the tldraw spec keeps running on the default build) to the
// Excalidraw board page (owner 2C). Name-only guests and the export policy, round-2 follow-ups
// (docs/WAVE3-CONTRACTS.md §2 guests and "export-control"), in real browsers:
// - the Share dialog opened from the board (F7, F13): someone who joined with the workshop link says so, with
//   the time it ends; the workshop section is in view without scrolling at 1440 x 900; "+1 h" and
//   "Revoke…" keep their own size on the link's line; the workspace picker never offers a name-only guest,
//   and hides while someone is typed in the invite field;
// - a workshop guest (an editor) on a board whose owner turned exporting off: limited like a viewer
//   (SEAM-04), no History or "Recently deleted" (SEAM-06, DANA-05), and when the link is revoked, a guest
//   screen that never offers to request access, then "Your guest access has ended" (F16);
// - the invite page's "Not you?" link in the app's link colour, light and dark (F17).
//
// Differences from the tldraw spec: the board waits on the facade (guests-kit.ts `waitForLobbyBoard`); the
// revoked guest must also lose the canvas itself (no board page left under the guest screen).
import type { Page } from '@playwright/test'
import { expect, test } from '../tests/support/canvas.ts'
import {
  memberRow,
  openMoreWaysToShare,
  openShareFromButton,
  shareDialog,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { guestOn, ORIGIN, tokenOf, waitForLobbyBoard } from './guests-kit.ts'

test('Share dialog: workshop joiners say "workshop link" with its time, the workshop section is in view, link actions keep their size, and no guest in the picker', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const alice = await users.api('alice')
  const bob = await users.api('bob')
  const carol = await users.get('carol') // a Dev Studio member with no grant: the picker offers her
  // A workshop link on this board that guests may join, and a review link.
  const workshop = (await (
    await alice.fetch('POST', `/api/boards/${board}/review-links`, {
      role: 'editor',
      expiresInHours: 3,
      allowGuests: true,
    })
  ).json()) as { id: string; url: string; expiresAt: string }
  expect(
    (
      await alice.fetch('POST', `/api/boards/${board}/review-links`, { role: 'commenter', expiresInDays: 14 })
    ).status(),
  ).toBe(201)
  // bob (an account) joins with the workshop link; a name-only guest joins ANOTHER board of the workspace.
  expect((await bob.fetch('POST', `/api/invitations/${tokenOf(workshop.url)}/accept`)).status()).toBe(200)
  const other = await alice.createBoard(users.devStudioId, 'Other workshop')
  const otherLink = (await (
    await alice.fetch('POST', `/api/boards/${other.id}/review-links`, { role: 'editor', allowGuests: true })
  ).json()) as { url: string }
  const guestCtx = await browser.newContext()
  const outsider = await guestCtx.request.post(`/api/invitations/${tokenOf(otherLink.url)}/guest`, {
    headers: ORIGIN,
    data: { name: 'Wes Park' },
  })
  expect(outsider.status()).toBe(201)
  const wesId = ((await outsider.json()) as { user: { id: string } }).user.id
  await guestCtx.close()

  const a = await signedInContext(browser, 'alice', { viewport: { width: 1440, height: 900 } })
  try {
    const page = a.page
    await page.goto(`/b/${board}`)
    await waitForLobbyBoard(page)
    await openShareFromButton(page)
    const dialog = shareDialog(page)

    // F13: the workshop link is in view as the dialog opens, without scrolling it.
    const section = dialog.getByTestId('workshop-links')
    await expect(section).toBeInViewport()
    const row = dialog.getByTestId('workshop-link-row')
    await expect(row).toBeInViewport()
    // "+1 h" and "Revoke…" keep their own size, on the same line as what the link is.
    const extend = row.getByTestId('workshop-link-extend')
    const revoke = row.getByTestId('review-link-revoke')
    const text = row.locator('.dr-sharing__link-text')
    const [eb, rb, tb, rowBox] = await Promise.all([
      extend.boundingBox(),
      revoke.boundingBox(),
      text.boundingBox(),
      row.boundingBox(),
    ])
    if (!eb || !rb || !tb || !rowBox) throw new Error('link row not laid out')
    expect(eb.width).toBeLessThan(90)
    expect(eb.width).toBeLessThan(rowBox.width / 4)
    expect(eb.y).toBeLessThan(tb.y + tb.height) // beside the text, not on a row of its own
    expect(Math.abs(rb.y + rb.height / 2 - (eb.y + eb.height / 2))).toBeLessThan(6)
    expect(eb.x).toBeGreaterThan(tb.x + tb.width / 2)

    // F7: bob joined with the workshop link, which ends at a time of day.
    const until = await page.evaluate((iso) => {
      const d = new Date(iso)
      const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      const now = new Date()
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      if (sameDay) return time
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const md = `${months[d.getMonth()]} ${d.getDate()}`
      return `${d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`}, ${time}`
    }, workshop.expiresAt)
    const bobId = (await users.get('bob')).id
    await expect(memberRow(page, bobId).getByTestId('member-source')).toHaveText(
      `@bob · Joined with the workshop link · until ${until}`,
    )
    await expect(row.getByTestId('review-link-url')).toHaveAccessibleName('Workshop link')
    await testInfo.attach('share-dialog-1440.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })

    // The picker offers carol (an account), never the name-only guest from the other board.
    const picker = dialog.getByTestId('share-add-member')
    await expect(picker.locator(`option[value="${carol.id}"]`)).toHaveCount(1)
    await expect(picker.locator(`option[value="${wesId}"]`)).toHaveCount(0)
    await expect(picker).not.toContainText('(guest)')
    // While someone is typed above, the suggestions are the picker: no second invite row.
    await dialog.getByTestId('share-invite-input').fill('@carol')
    await expect(picker).toHaveCount(0)
    await dialog.getByTestId('share-invite-input').fill('')
    await expect(picker).toHaveCount(1)

    // Revoking: the confirmation replaces "Revoke…", and the review link row says "Review link".
    await revoke.click()
    await expect(row.getByTestId('review-link-revoke-confirm')).toBeVisible()
    await expect(row.getByTestId('review-link-revoke')).toHaveCount(0)
    await expect(dialog.getByTestId('review-link-row').getByTestId('review-link-url')).toHaveAccessibleName(
      'Review link',
    )
  } finally {
    await a.context.close()
  }
})

test('Share dialog at phone width: the link actions wrap under the text, and nothing scrolls sideways', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const alice = await users.api('alice')
  expect(
    (
      await alice.fetch('POST', `/api/boards/${board}/review-links`, {
        role: 'editor',
        expiresInHours: 3,
        allowGuests: true,
      })
    ).status(),
  ).toBe(201)
  const a = await signedInContext(browser, 'alice', { viewport: { width: 390, height: 844 } })
  try {
    const page = a.page
    await page.goto(`/b/${board}`)
    await waitForLobbyBoard(page)
    await openShareFromButton(page)
    const row = shareDialog(page).getByTestId('workshop-link-row')
    await row.scrollIntoViewIfNeeded()
    const [eb, rowBox] = await Promise.all([
      row.getByTestId('workshop-link-extend').boundingBox(),
      row.boundingBox(),
    ])
    if (!eb || !rowBox) throw new Error('link row not laid out')
    expect(eb.width).toBeLessThan(90)
    expect(eb.x + eb.width).toBeLessThanOrEqual(rowBox.x + rowBox.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await testInfo.attach('share-dialog-390.png', { body: await page.screenshot(), contentType: 'image/png' })
  } finally {
    await a.context.close()
  }
})

test('a workshop guest under "editors": limited like a viewer, no Recently deleted, and a guest screen when the link is revoked', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const alice = await users.api('alice')
  expect(
    (await alice.fetch('PUT', `/api/boards/${board}/export-policy`, { exportPolicy: 'editors' })).status(),
  ).toBe(200)
  const link = (await (
    await alice.fetch('POST', `/api/boards/${board}/review-links`, {
      role: 'editor',
      expiresInHours: 3,
      allowGuests: true,
    })
  ).json()) as { id: string; url: string }
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark' })
  try {
    const guest = await guestOn(context, tokenOf(link.url), 'Eddie')
    const g = guest.page
    await expect(g.getByTestId('readonly-pill')).toHaveCount(0) // an editor on the canvas

    // SEAM-04: the server says this guest may not export, and the export entry says why.
    const policy = await g.request.get(`/api/boards/${board}/export-policy`)
    expect(await policy.json()).toEqual({ exportPolicy: 'editors', canExport: false, policySet: true })
    expect((await g.request.get(`/api/boards/${board}/export`)).status()).toBe(403)
    // K3-3: the top bar has no Export icon now: the board menu offers no Export… (its Export ▸ says why
    // once the board has content) and the PDF shortcut only says why
    await g.getByTestId('main-menu.button').click()
    await expect(g.getByTestId('main-menu-root')).toBeVisible()
    const exportSub = g.getByTestId('main-menu-sub.export-button')
    if ((await exportSub.count()) > 0) {
      await exportSub.click()
      await expect(g.getByTestId('main-menu.dr-export-off')).toBeVisible()
    }
    await expect(g.getByTestId('main-menu.export-dialog')).toHaveCount(0)
    await g.getByTestId('main-menu.button').click()
    await expect(g.getByTestId('main-menu-root')).toHaveCount(0)

    // SEAM-06: no "Recently deleted" in History, and the api refuses it.
    const deleted = await g.request.get(`/api/boards/${board}/deleted`)
    expect(deleted.status()).toBe(403)
    expect(((await deleted.json()) as { error: { code: string } }).error.code).toBe('GUEST_ACCOUNT_REQUIRED')
    // DANA-05: nor History at all (the rail has no entry; the checkpoint list is refused too).
    await expect(g.getByTestId('dock-tab-comments')).toBeVisible()
    await expect(g.getByTestId('dock-tab-history')).toHaveCount(0)
    await expect(g.getByTestId('deleted-row')).toHaveCount(0)
    expect((await g.request.get(`/api/boards/${board}/snapshots`)).status()).toBe(403)

    // F16: the link is revoked with removal. The guest sees a guest screen at once (never "ask its
    // owner again" or a request form), then "Your guest access has ended".
    const started = Date.now()
    expect(
      (
        await alice.fetch('POST', `/api/boards/${board}/review-links/${link.id}/revoke`, {
          removeAccess: true,
        })
      ).status(),
    ).toBe(200)
    const first = g.getByTestId('guest-no-access').or(g.getByTestId('guest-ended'))
    await expect(first).toBeVisible({ timeout: 15_000 })
    // the board page is gone with its canvas (no socket left to write through)
    await expect(g.getByTestId('lobby-board')).toHaveCount(0)
    const main = g.locator('main')
    await expect(main).not.toContainText('Ask its owner')
    await expect(main).not.toContainText('request access')
    await expect(g.getByTestId('access-request-form')).toHaveCount(0)
    // DANA2-07: the same message as the guest-ended screen that follows.
    if (await g.getByTestId('guest-no-access').isVisible())
      await expect(main).toContainText('Your guest access has ended')
    await testInfo.attach('guest-revoked-dark.png', { body: await g.screenshot(), contentType: 'image/png' })
    await expect(g.getByTestId('guest-ended')).toBeVisible({ timeout: 15_000 })
    await expect(g.getByTestId('guest-ended')).toContainText('Your guest access has ended')
    testInfo.annotations.push({ type: 'guest-ended after revoke', description: `${Date.now() - started} ms` })
    expect(await g.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    await context.close()
  }
})

test('a guest who opens a board they never joined sees the guest wording, with no request form (phone width)', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.api('alice')
  const other = await alice.createBoard(users.devStudioId, 'Private plans')
  const link = (await (
    await alice.fetch('POST', `/api/boards/${board}/review-links`, { role: 'viewer', allowGuests: true })
  ).json()) as { url: string }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  try {
    const guest = await guestOn(context, tokenOf(link.url), 'Vic')
    const g = guest.page
    await g.goto(`/b/${other.id}`)
    await expect(g.getByTestId('guest-no-access')).toBeVisible({ timeout: 15_000 })
    await expect(g.locator('main')).toContainText(
      'As a guest, you can open only the boards you joined with a link.',
    )
    await expect(g.getByTestId('access-request-form')).toHaveCount(0)
    await expect(g.getByTestId('access-request-guest')).toHaveCount(0)
    expect(await g.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    await context.close()
  }
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the invite page's "Not you?" uses the app's link colour (${colorScheme})`, async ({
    browser,
    board,
    users,
  }) => {
    const alice = await users.api('alice')
    const link = (await (
      await alice.fetch('POST', `/api/boards/${board}/review-links`, { role: 'editor', expiresInHours: 3 })
    ).json()) as { url: string }
    const bob = await signedInContext(browser, 'bob')
    try {
      await bob.page.emulateMedia({ colorScheme })
      await bob.page.goto(link.url)
      const notYou = bob.page.getByRole('link', { name: 'Not you?' })
      await expect(notYou).toBeVisible()
      const colors = await notYou.evaluate((el) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--dr-accent-ink)'
        document.body.append(probe)
        const want = getComputedStyle(probe).color
        probe.remove()
        return { got: getComputedStyle(el).color, want }
      })
      expect(colors.got).toBe(colors.want)
      expect(colors.got).not.toBe('rgb(0, 0, 238)') // the browser's default link blue
    } finally {
      await bob.context.close()
    }
  })
}

// G2: "Anyone with the link can join with just a name" for a link that already exists. Ticking the box above
// Create after a workshop link was shared used to change the section's text ("with just a name or an account")
// but not that link: its invite page still said "Sign in to accept". The box above Create is now plainly for
// the NEXT link, and each link has its own box (PATCH review-links/:id) that applies to that link and that link only.
test('G2: a link that already exists gets its own "join with just a name" box; the box above Create is for the next link', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.api('alice')
  const a = await signedInContext(browser, 'alice', { viewport: { width: 1440, height: 900 } })
  const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } })
  try {
    const page = a.page
    await page.goto(`/b/${board}`)
    await waitForLobbyBoard(page)
    await openShareFromButton(page)
    await openMoreWaysToShare(page)
    const dialog = shareDialog(page)
    const workshop = dialog.getByTestId('workshop-links')
    const row = workshop.getByTestId('workshop-link-row')
    const topBox = workshop.getByTestId('workshop-link-guests')
    const rowBox = row.getByTestId('review-link-guests-toggle')
    const rowNote = row.getByTestId('review-link-guests-note')

    await test.step('no link yet: the box says what it always said and creates an account-only link', async () => {
      await expect(topBox).toHaveAccessibleName('Anyone with the link can join with just a name (no account)')
      await expect(topBox).not.toBeChecked()
      await expect(workshop.locator('.dr-sharing__guests').first()).not.toHaveAttribute(
        'data-next-link',
        /.*/,
      )
      await workshop.getByTestId('workshop-link-create').click()
      await expect(row).toHaveCount(1)
      await expect(row).toHaveAttribute('data-allow-guests', 'false')
      await expect(row.getByTestId('link-guests-allowed')).toHaveCount(0)
      await expect(rowBox).not.toBeChecked()
      await expect(rowBox).toBeEnabled()
      await expect(rowBox).toHaveAccessibleName(
        'Anyone with this link can join with just a name (no account)',
      )
    })
    const url = await row.getByTestId('review-link-url').inputValue()

    await test.step('with a link open, the box above Create says it is for the NEXT link, and ticking it changes nothing on the open one', async () => {
      await expect(topBox).toHaveAccessibleName(
        'For the next link: anyone with it can join with just a name (no account)',
      )
      await expect(topBox.locator('xpath=ancestor::div[1]')).toHaveAttribute('data-next-link', 'true')
      await topBox.check()
      await expect(workshop.getByTestId('workshop-link-hint')).toContainText(
        'The next workshop link: anyone with it can edit for a few hours, with just a name or an account',
      )
      await expect(row).toHaveAttribute('data-allow-guests', 'false')
      await expect(row.getByTestId('link-guests-allowed')).toHaveCount(0)
      await expect(rowBox).not.toBeChecked()
      // the link's invite page still wants a sign-in
      const p = await visitor.newPage()
      await p.goto(url)
      await expect(p.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'false')
      await expect(p.getByTestId('invite-signin')).toHaveText('Sign in to accept')
      await expect(p.getByTestId('invite-guest-name')).toHaveCount(0)
      await p.close()
      await topBox.uncheck()
    })

    await test.step('the link’s own box turns guests ON for that link: the row, the server and its invite page follow', async () => {
      await rowBox.check()
      await expect(row).toHaveAttribute('data-allow-guests', 'true')
      await expect(row.getByTestId('link-guests-allowed')).toBeVisible()
      await expect(rowNote).toHaveText('Anyone with this link can now join with just a name.')
      await expect(rowBox).toBeChecked()
      await expect(rowBox).toBeEnabled()
      const listed = (await (await alice.fetch('GET', `/api/boards/${board}/invitations`)).json()) as {
        invitations: { kind: string; role: string; allowGuests: boolean }[]
      }
      expect(listed.invitations).toEqual([
        expect.objectContaining({ kind: 'review', role: 'editor', allowGuests: true }),
      ])
      const p = await visitor.newPage()
      await p.goto(url)
      await expect(p.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'true')
      await expect(p.getByTestId('invite-guest-name')).toBeVisible()
      await expect(p.getByTestId('invite-signin')).toHaveText('Sign in instead')
      await p.close()
    })

    let wes: { page: Page; id: string } | undefined
    await test.step('a guest joins with just a name and is an editor (the link’s role, nothing more)', async () => {
      wes = await guestOn(visitor, tokenOf(url), 'Wes')
      await expect(wes.page.getByTestId('readonly-pill')).toHaveCount(0)
      expect(
        ((await (await wes.page.request.get(`/api/boards/${board}`)).json()) as { role: string }).role,
      ).toBe('editor')
    })

    await test.step('turning it OFF again: new visitors need an account; the guest who is in stays', async () => {
      await rowBox.uncheck()
      await expect(row).toHaveAttribute('data-allow-guests', 'false')
      await expect(row.getByTestId('link-guests-allowed')).toHaveCount(0)
      await expect(rowNote).toContainText('No new guests can join this link with just a name')
      await expect(rowNote).toContainText('People who already joined keep their access')
      const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } })
      try {
        const p = await fresh.newPage()
        await p.goto(url)
        await expect(p.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'false')
        await expect(p.getByTestId('invite-signin')).toHaveText('Sign in to accept')
      } finally {
        await fresh.close()
      }
      // Wes, who joined while it was on, still has the board
      if (!wes) throw new Error('no guest')
      await wes.page.reload()
      await waitForLobbyBoard(wes.page)
    })

    await test.step('a change the api refuses leaves the box where it was and says why', async () => {
      // The link ended meanwhile: the api answers 409 LINK_CLOSED (the real answer, played for this one request).
      await page.route('**/api/boards/*/review-links/*', async (route) => {
        if (route.request().method() !== 'PATCH') return route.fallback()
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'LINK_CLOSED',
              message: 'This link has expired or was revoked. Create a new one.',
            },
          }),
        })
      })
      await rowBox.check()
      await expect(row.getByRole('alert')).toContainText('expired or was revoked')
      await expect(rowBox).not.toBeChecked()
      await expect(rowBox).toBeEnabled()
      await expect(row).toHaveAttribute('data-allow-guests', 'false')
    })
  } finally {
    await visitor.close()
    await a.context.close()
  }
})
