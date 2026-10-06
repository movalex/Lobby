// Wave J (J1, owner decisions 2026-10-05): targeted markers for people outside Dark Burn Creative and
// Trailer Park Group, with an outside account and a name-only guest in real browsers:
// - an "External" tag (with the verified domain where the viewer manages access) in the Share dialog's
//   lists, the people bar and list, cursor labels, comment authors; name-only guests keep "(guest)";
// - a one-time confirm before approving an outside account's request and before inviting an outside
//   address (never for a creator address), and before a board owner who is a plain workspace member adds
//   an outside workspace guest from the picker or by @handle (the picker's External tag);
// - "Shared outside" on the board top bar and the dashboard card while an outside account has access or a
//   guest link is open, and off again when that ends;
// - the owner's bell notice the first time the outside account opens the board;
// - "Internal only" on the workspace: the server refuses outside invites, approvals and links (the dialog
//   says why), the outside access that remains is listed for the owner (a pending outside invitation
//   with a Revoke), and nothing is removed.
//
// The dev provider trusts the dev sign-in's `email`; outside addresses go only to fresh handles. Every
// address is a reserved example (or a `lobby-test-` local part at a creator domain).
import type { Page } from '@playwright/test'
import { Api } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/canvas.ts'
import { commentsApi, openCommentsPanel } from '../tests/support/comments.ts'
import {
  accessRequests,
  closeShare,
  freshHandle,
  invitations,
  mainCard,
  memberRow,
  openDashboard,
  openShareFromButton,
  requestRow,
  shareDialog,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { capture } from '../tests/support/screenshots.ts'
import { createGuestLink, cursorOf, joinAsGuest, waitForLobbyBoard } from './guests-kit.ts'

/** The board's Shared outside flag as the server computes it (ShareState.sharedOutside). */
const sharedOutside = async (api: Api, boardId: string) =>
  ((await (await api.fetch('GET', `/api/boards/${boardId}/sharing`)).json()) as { sharedOutside?: boolean })
    .sharedOutside ?? false

const confirmBox = (page: Page) => shareDialog(page).getByTestId('outside-confirm')
const outsideSentence = (who: string) =>
  `${who} is outside Dark Burn and Trailer Park Group. They will only see this board.`

/** Moves the real pointer over empty canvas (its cursor then streams to everyone else). */
async function hover(page: Page) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6)
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.62, { steps: 4 })
}

test('an outside account: External tags, the one-time confirms, Shared outside on and off, the owner’s bell', async ({
  browser,
  users,
  board,
  canvasSession,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const a = await canvasSession('alice')
  const pat = await signedInContext(browser, freshHandle('pat'), {
    name: 'Pat Client',
    email: 'pat@client.example.test',
  })
  const patApi = new Api(pat.context.request)
  const hint = 'p•••@client.example.test'
  try {
    await test.step('a private staff-only board: no marker', async () => {
      expect(await sharedOutside(aliceApi, board)).toBe(false)
      await expect(a.page.getByTestId('topbar-shared-outside')).toHaveCount(0)
    })

    await test.step('pat asks for access; the request says External · client.example.test', async () => {
      const res = await patApi.fetch('POST', `/api/boards/${board}/access-requests`, { role: 'editor' })
      expect(res.status()).toBe(202)
      await openShareFromButton(a.page)
      const row = requestRow(a.page, pat.me.user.id)
      await expect(row.getByTestId('external-tag')).toHaveText('External · client.example.test')
      await capture('outsiders-request-row.png', a.page, testInfo)
    })

    await test.step('Approve asks first; Cancel approves nothing; the second time Approve approves', async () => {
      const row = requestRow(a.page, pat.me.user.id)
      await row.getByTestId('access-request-approve').click()
      await expect(row.getByTestId('outside-confirm-text')).toHaveText(
        outsideSentence(`Pat Client (${hint})`),
      )
      await row.getByTestId('outside-confirm-no').click()
      await expect(row.getByTestId('outside-confirm')).toHaveCount(0)
      expect((await accessRequests(aliceApi, board)).map((r) => r.status)).toEqual(['pending'])
      await row.getByTestId('access-request-approve').click()
      await expect(row.getByTestId('outside-confirm-yes')).toHaveText('Approve')
      await row.getByTestId('outside-confirm-yes').click()
      await expect(requestRow(a.page, pat.me.user.id)).toHaveCount(0)
      await expect(memberRow(a.page, pat.me.user.id).getByTestId('external-tag')).toHaveText(
        'External · client.example.test',
      )
      // a creator's row has no tag
      await expect(memberRow(a.page, a.id).getByTestId('external-tag')).toHaveCount(0)
    })

    await test.step('inviting an outside address asks once; a creator address does not', async () => {
      const dialog = shareDialog(a.page)
      const input = dialog.getByTestId('share-invite-input')
      await input.fill('x@client.example.test')
      await dialog.getByTestId('share-invite-submit').click()
      await expect(confirmBox(a.page).getByTestId('outside-confirm-text')).toHaveText(
        outsideSentence('x@client.example.test'),
      )
      await capture('outsiders-invite-confirm.png', a.page, testInfo)
      await confirmBox(a.page).getByTestId('outside-confirm-yes').click()
      await expect(dialog.getByTestId('share-invite-link')).toHaveValue(new RegExp(`^${WEB_URL}/invite/`))
      await input.fill('lobby-test-xavier@darkburn.com')
      await dialog.getByTestId('share-invite-submit').click()
      await expect(dialog.getByTestId('share-invite-lock-note')).toContainText(
        'lobby-test-xavier@darkburn.com',
      )
      await expect(confirmBox(a.page)).toHaveCount(0)
      await closeShare(a.page)
    })

    await test.step('Shared outside appears on the top bar, for everyone who can see the board', async () => {
      await expect(a.page.getByTestId('topbar-shared-outside')).toBeVisible()
      await expect(a.page.getByTestId('topbar-shared-outside')).toHaveAttribute('title', /outside Dark Burn/)
      expect(await sharedOutside(aliceApi, board)).toBe(true)
    })

    await test.step('pat opens the board: the people bar, the people list and pat’s cursor say External', async () => {
      await pat.page.goto(`/b/${board}`)
      await waitForLobbyBoard(pat.page)
      const avatar = a.page.locator(`[data-testid="presence-user"][data-user-id="${pat.me.user.id}"]`)
      await expect(avatar).toHaveAttribute('data-external', 'true')
      await expect(avatar).toHaveAttribute('title', 'Pat Client (Outside Dark Burn and Trailer Park Group)')
      await a.page.getByTestId('people-open').click()
      const row = a.page.locator(`[data-testid="people-row"][data-user-id="${pat.me.user.id}"]`)
      await expect(row.getByTestId('external-tag')).toHaveText('External · client.example.test')
      await a.page.keyboard.press('Escape')
      await hover(pat.page)
      const cursor = cursorOf(a.page, pat.me.user.id)
      await expect(cursor).toBeVisible()
      await expect(cursor).toHaveAttribute('data-external', 'true')
      await expect(cursor.getByTestId('cursor-external')).toHaveText('· External')
      // pat sees alice without a tag (she is staff)
      await expect(
        pat.page.locator(`[data-testid="presence-user"][data-user-id="${a.id}"]`),
      ).not.toHaveAttribute('data-external', 'true')
      await capture('outsiders-board.png', a.page, testInfo)
    })

    await test.step('pat’s comment is tagged External for alice', async () => {
      const thread = await commentsApi(patApi).createThread(
        board,
        { kind: 'point', x: 40, y: 40 },
        'From the client',
      )
      // the api marks the author (the same thread goes to everyone, without any domain)
      expect((thread.createdBy as { external?: boolean }).external).toBe(true)
      const panel = await openCommentsPanel(a.page)
      const row = panel.locator(`[data-testid="comment-row"][data-thread-id="${thread.id}"]`)
      await expect(row.getByTestId('external-tag')).toHaveText('External')
    })

    await test.step('alice’s bell: pat opened this board for the first time (with the domain)', async () => {
      await a.page.getByTestId('notifications-bell').click()
      // This board's notice (other specs' outsiders may have opened alice's other boards in this stack).
      const item = a.page
        .locator('[data-testid="notification-item"][data-kind="outsider_joined"]')
        .filter({ hasText: 'opened this board for the first time' })
      await expect(item).toHaveCount(1)
      await expect(item.getByTestId('notification-outsider')).toContainText('Pat Client')
      await expect(item.getByTestId('notification-outsider')).toContainText(
        'opened this board for the first time',
      )
      await expect(item.getByTestId('external-tag')).toHaveText('External · client.example.test')
      await a.page.keyboard.press('Escape')
    })

    await test.step('the dashboard card says Shared outside too', async () => {
      await openDashboard(a.page, users.devStudioId)
      await expect(mainCard(a.page, board).getByTestId('board-card-shared-outside')).toBeVisible()
      await capture('outsiders-dashboard-card.png', a.page, testInfo)
    })

    await test.step('pat’s access ends: the marker goes, on the card and the top bar', async () => {
      const res = await aliceApi.fetch('DELETE', `/api/boards/${board}/members/${pat.me.user.id}`)
      expect(res.status()).toBe(200)
      expect(await sharedOutside(aliceApi, board)).toBe(false)
      await a.page.reload()
      await expect(mainCard(a.page, board)).toBeVisible()
      await expect(mainCard(a.page, board).getByTestId('board-card-shared-outside')).toHaveCount(0)
      await a.page.goto(`/b/${board}`)
      await waitForLobbyBoard(a.page)
      await expect(a.page.getByTestId('topbar-shared-outside')).toHaveCount(0)
    })
  } finally {
    await pat.context.close()
  }
})

test('a board owner who is a plain member: the picker and a typed @handle tag an outside workspace guest and ask first', async ({
  browser,
  users,
  board,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const bobApi = await users.api('bob')
  // bob (a plain Dev Studio member) owns a board of his own.
  const bobBoard = (await bobApi.createBoard(users.devStudioId, 'Bob’s pitch')).id
  const pat = await signedInContext(browser, freshHandle('pat'), {
    name: 'Pat Client',
    email: 'pat@client.example.test',
  })
  const bob = await signedInContext(browser, 'bob')
  const patApi = new Api(pat.context.request)
  const hint = 'p•••@client.example.test'
  const patGrant = async () =>
    (
      (await (await bobApi.fetch('GET', `/api/boards/${bobBoard}/members`)).json()) as {
        members: { user: { id: string }; role: string }[]
      }
    ).members.find((m) => m.user.id === pat.me.user.id)?.role ?? null
  try {
    await test.step('pat, an outside client, joins ANOTHER board of the workspace (alice’s)', async () => {
      expect(
        (await patApi.fetch('POST', `/api/boards/${board}/access-requests`, { role: 'viewer' })).status(),
      ).toBe(202)
      const req = (await accessRequests(aliceApi, board)).find((r) => r.status === 'pending')
      expect((await aliceApi.fetch('POST', `/api/access-requests/${req?.id}/approve`, {})).status()).toBe(200)
    })

    await test.step('bob’s picker says External · client.example.test; Add asks first, Cancel adds nothing', async () => {
      await bob.page.goto(`/b/${bobBoard}`)
      await waitForLobbyBoard(bob.page)
      await openShareFromButton(bob.page)
      const dialog = shareDialog(bob.page)
      const option = dialog.locator(`[data-testid="share-add-member"] option[value="${pat.me.user.id}"]`)
      await expect(option).toHaveAttribute('data-external', 'true')
      await expect(option).toContainText('External · client.example.test')
      await dialog.getByTestId('share-add-member').selectOption(pat.me.user.id)
      await dialog.getByTestId('share-add-submit').click()
      await expect(confirmBox(bob.page).getByTestId('outside-confirm-text')).toHaveText(
        outsideSentence(`Pat Client (${hint})`),
      )
      await capture('outsiders-picker-confirm.png', bob.page, testInfo)
      await confirmBox(bob.page).getByTestId('outside-confirm-no').click()
      await expect(confirmBox(bob.page)).toHaveCount(0)
      expect(await patGrant()).toBeNull()
    })

    await test.step('when the address check fails, the dialog says so and invites nothing (no silent skip)', async () => {
      const dialog = shareDialog(bob.page)
      const failCheck = '**/api/boards/*/sharing/address-check'
      await bob.page.route(failCheck, (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'IDENTITY_UNAVAILABLE', message: 'Try again.' } }),
        }),
      )
      try {
        await dialog.getByTestId('share-invite-input').fill('w@client.example.test')
        await dialog.getByTestId('share-invite-submit').click()
        await expect(dialog.getByTestId('share-invite-notice')).toHaveText(
          'Lobby couldn’t check that address just now, so nothing was sent. Try again.',
        )
        await expect(confirmBox(bob.page)).toHaveCount(0)
        await expect(dialog.getByTestId('share-invite-link')).toHaveCount(0)
        expect((await invitations(bobApi, bobBoard)).length).toBe(0)
      } finally {
        await bob.page.unroute(failCheck)
      }
      await dialog.getByTestId('share-invite-input').fill('')
    })

    await test.step('typing @pat asks too; Give access adds them, tagged External', async () => {
      const dialog = shareDialog(bob.page)
      await dialog.getByTestId('share-invite-input').fill(`@${pat.handle}`)
      await expect(dialog.getByTestId('share-invite-hint')).toContainText('Pat Client is in Dev Studio')
      await dialog.getByTestId('share-invite-submit').click()
      await expect(confirmBox(bob.page).getByTestId('outside-confirm-text')).toHaveText(
        outsideSentence(`Pat Client (${hint})`),
      )
      await expect(confirmBox(bob.page).getByTestId('outside-confirm-yes')).toHaveText('Give access')
      await confirmBox(bob.page).getByTestId('outside-confirm-yes').click()
      await expect(dialog.getByTestId('share-invite-notice')).toContainText(
        'Pat Client can now open this board',
      )
      await expect.poll(patGrant).not.toBeNull()
      await expect(memberRow(bob.page, pat.me.user.id).getByTestId('external-tag')).toHaveText(
        'External · client.example.test',
      )
    })
  } finally {
    await pat.context.close()
    await bob.context.close()
  }
})

test('a name-only guest keeps “(guest)” and no External tag; an open guest link turns Shared outside on', async ({
  browser,
  users,
  board,
  canvasSession,
}) => {
  const aliceApi = await users.api('alice')
  const a = await canvasSession('alice')
  const link = await createGuestLink(a.page, board, 'review')
  await waitForLobbyBoard(a.page)
  await expect(a.page.getByTestId('topbar-shared-outside')).toBeVisible()
  const guest = await joinAsGuest(browser, link, 'Dana')
  try {
    const avatar = a.page.locator(`[data-testid="presence-user"][data-user-id="${guest.id}"]`)
    await expect(avatar).toHaveAttribute('data-guest', 'true')
    await expect(avatar).not.toHaveAttribute('data-external', 'true')
    await hover(guest.page)
    const cursor = cursorOf(a.page, guest.id)
    await expect(cursor).toContainText('Dana (guest)')
    await expect(cursor.getByTestId('cursor-external')).toHaveCount(0)
    await openShareFromButton(a.page)
    const row = memberRow(a.page, guest.id)
    await expect(row.getByTestId('member-guest-marker')).toHaveText(' (guest)')
    await expect(row.getByTestId('external-tag')).toHaveCount(0)
    await closeShare(a.page)
    // the link revoked with its people: nothing outside is left
    const linkId = (
      (await (await aliceApi.fetch('GET', `/api/boards/${board}/invitations`)).json()) as {
        invitations: { id: string; kind: string }[]
      }
    ).invitations.find((i) => i.kind === 'review')?.id
    const revoked = await aliceApi.fetch('POST', `/api/boards/${board}/review-links/${linkId}/revoke`, {
      removeAccess: true,
    })
    expect(revoked.status()).toBe(200)
    await expect.poll(async () => await sharedOutside(aliceApi, board)).toBe(false)
  } finally {
    await guest.context.close()
  }
})

test('Internal only on the workspace: outside invites, approvals and links refused; what remains is listed, never removed', async ({
  browser,
  users,
  board,
  canvasSession,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const ws = users.devStudioId
  const quinn = await signedInContext(browser, freshHandle('quinn'), {
    name: 'Quinn Vendor',
    email: 'quinn@vendor.example.test',
  })
  const rex = await signedInContext(browser, freshHandle('rex'), {
    name: 'Rex Client',
    email: 'rex@client.example.test',
  })
  const quinnApi = new Api(quinn.context.request)
  const rexApi = new Api(rex.context.request)
  try {
    let pendingId = ''
    await test.step('before: quinn has the board (an approved request); an invitation for z@ is pending', async () => {
      expect(
        (await quinnApi.fetch('POST', `/api/boards/${board}/access-requests`, { role: 'viewer' })).status(),
      ).toBe(202)
      const [req] = await accessRequests(aliceApi, board)
      expect((await aliceApi.fetch('POST', `/api/access-requests/${req?.id}/approve`, {})).status()).toBe(200)
      const inv = await aliceApi.fetch('POST', `/api/boards/${board}/invitations`, {
        role: 'viewer',
        email: 'z@client.example.test',
      })
      expect(inv.status()).toBe(201)
      pendingId = ((await inv.json()) as { id: string }).id
    })

    const a = await canvasSession('alice')
    await test.step('alice turns Internal only on in the sidebar; quinn is listed, not removed', async () => {
      await openDashboard(a.page, ws)
      const section = a.page.getByTestId('internal-only')
      await expect(section).toHaveAttribute('data-on', 'false')
      await section.getByTestId('internal-only-switch').check()
      await expect(section).toHaveAttribute('data-on', 'true')
      // (other tests' outsiders may still be Dev Studio guests: the count is not ours)
      await expect(section.getByTestId('internal-only-review')).toContainText(/still ha(s|ve) access/)
      await section.getByTestId('internal-only-review').click()
      const dialog = a.page.getByTestId('outside-access-dialog')
      const person = dialog.locator(
        `[data-testid="outside-access-person"][data-user-id="${quinn.me.user.id}"]`,
      )
      await expect(person.getByTestId('external-tag')).toHaveText('External · vendor.example.test')
      await expect(person.getByTestId('outside-access-remove-board')).toBeVisible()
      // the invitation sent before the switch: nobody outside can accept it now; listed with a Revoke
      const pending = dialog.locator(
        `[data-testid="outside-access-invitation"][data-invitation-id="${pendingId}"]`,
      )
      await expect(pending).toContainText('z•••@client.example.test')
      await expect(pending.getByTestId('external-tag')).toHaveText('External · client.example.test')
      await capture('outsiders-internal-only-review.png', a.page, testInfo)
      await pending.getByTestId('outside-access-revoke-invitation').click()
      await expect(pending).toHaveCount(0)
      expect((await invitations(aliceApi, board)).some((i) => i.id === pendingId)).toBe(false)
      await a.page.keyboard.press('Escape')
      // nothing was removed
      expect((await quinnApi.fetch('GET', `/api/boards/${board}`)).status()).toBe(200)
    })

    await test.step('the server refuses outside invites and links (409 INTERNAL_ONLY)', async () => {
      const invite = await aliceApi.fetch('POST', `/api/boards/${board}/invitations`, {
        role: 'viewer',
        email: 'y@client.example.test',
      })
      expect(invite.status()).toBe(409)
      expect(((await invite.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ONLY')
      const link = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, { role: 'commenter' })
      expect(link.status()).toBe(409)
    })

    await test.step('the Share dialog says so, offers no link, and refuses an outside address before asking', async () => {
      await a.page.goto(`/b/${board}`)
      await waitForLobbyBoard(a.page)
      await openShareFromButton(a.page)
      const dialog = shareDialog(a.page)
      await expect(dialog.getByTestId('share-internal-only-note')).toContainText(
        'This workspace is internal only',
      )
      await expect(dialog.getByTestId('review-link-create')).toHaveCount(0)
      await dialog.getByTestId('share-invite-input').fill('y@client.example.test')
      await dialog.getByTestId('share-invite-submit').click()
      await expect(dialog.getByTestId('share-invite-notice')).toContainText('This workspace is internal only')
      await expect(confirmBox(a.page)).toHaveCount(0)
      await expect(dialog.getByTestId('share-invite-link')).toHaveCount(0)
      await capture('outsiders-internal-only-share.png', a.page, testInfo)
    })

    await test.step('approving an outside account: asked first, then refused with the server’s words', async () => {
      expect(
        (await rexApi.fetch('POST', `/api/boards/${board}/access-requests`, { role: 'editor' })).status(),
      ).toBe(202)
      // the dialog refetches on the board stream's sharing event; reopen to be sure
      await closeShare(a.page)
      await openShareFromButton(a.page)
      const row = requestRow(a.page, rex.me.user.id)
      await row.getByTestId('access-request-approve').click()
      await row.getByTestId('outside-confirm-yes').click()
      await expect(row.getByRole('alert')).toContainText('This workspace is internal only')
      expect((await accessRequests(aliceApi, board)).map((r) => r.status)).toEqual(['pending'])
      await closeShare(a.page)
    })

    await test.step('alice turns it off again (a creator may)', async () => {
      await openDashboard(a.page, ws)
      const section = a.page.getByTestId('internal-only')
      await section.getByTestId('internal-only-switch').uncheck()
      await expect(section).toHaveAttribute('data-on', 'false')
    })
  } finally {
    // Dev Studio is shared by the worker's other tests: never leave the switch on.
    await aliceApi.fetch('PUT', `/api/workspaces/${ws}/internal-only`, { internalOnly: false })
    await quinn.context.close()
    await rex.context.close()
  }
})
