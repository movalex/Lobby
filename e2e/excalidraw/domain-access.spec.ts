// PORTED from e2e/tests/domain-access.spec.ts (32859b1; retired with the tldraw suite) to the Excalidraw
// board page, every assertion kept: the board opens through the facade's welcome (guests-kit
// `waitForLobbyBoard`) instead of `window.editor`, and alice's tab is a `canvasSession`. Everything else
// here (the api, the sign-in form, the invite page, the dashboard, the Share dialog, the History panel) is
// shared by both engines' pages.
//
// Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §11.5): only verified darkburn.com /
// trailerparkgroup.com addresses (plus the DRAFTROOM_CREATOR_EMAILS exceptions) create workspaces,
// projects and boards and hand out access; everyone else ("outside accounts") gets only what they are
// invited to; an invitation to an address works only for an account with that verified address.
//
// The dev provider trusts the dev sign-in's `email` as verified; without one an account is
// `<handle>@dev.invalid`, a creator (alice, bob, carol stay creators). Outside addresses are only ever
// given to fresh handles: every dev login replaces the account's dev emails, and the stack caches the
// shared people's sessions. Every address here is a reserved example (or a `lobby-test-` local part at a
// creator domain); none is real.
import type { Page } from '@playwright/test'
import { Api, type Me } from '../tests/support/api.ts'
import { signInThroughUi } from '../tests/support/board.ts'
import { expect, openCanvasSession, test } from '../tests/support/canvas.ts'
import {
  accessRequests,
  freshHandle,
  invitations,
  inviteToken,
  listedPerson,
  mainCard,
  memberRow,
  menuActions,
  openDashboard,
  openMoreWaysToShare,
  openPeopleList,
  openShareFromButton,
  personalWorkspace,
  requestRow,
  shareDialog,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { openHistory } from '../tests/support/history.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { capture } from '../tests/support/screenshots.ts'
import { waitForLobbyBoard } from './guests-kit.ts'

const EXCEPTION = 'owner@personal.example.test'
test.use({ apiEnv: { DRAFTROOM_CREATOR_EMAILS: EXCEPTION } })

const CREATOR_REQUIRED = 'CREATOR_REQUIRED'
const SHARE_NOTE =
  'Only people at Dark Burn Creative or Trailer Park Group can invite people, create links or give more access in Lobby. You can still lower or remove access.'
const OUTSIDE_EMPTY =
  'Boards shared with you appear here. Only people at Dark Burn Creative or Trailer Park Group can create boards. Work there? Sign in with your work email.'
/** The dashboard notice (access-outside) for an outside account whose workspace role would create. */
const OUTSIDE_NOTICE =
  'Only people at Dark Burn Creative or Trailer Park Group can create boards, projects and links in Lobby.'
const UNCONFIRMED_SHARE_NOTE =
  "Lobby couldn't confirm your account, so inviting people, creating links and giving more access are paused. You can still lower or remove access. Reload in a minute to try again."
const RESTORE_ONLY_CREATORS =
  'A checkpoint keeps this board as it is now. Only people at Dark Burn Creative or Trailer Park Group can restore one as a new board.'

/** The error code of a refused API call. */
async function errorCode(res: { json(): Promise<unknown> }): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
  return body?.error?.code ?? null
}

/** Nothing scrolls sideways (390 px phones). */
async function expectNoSideScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0)
}

/** The dashboard's creation entry points are all absent (New board, Templates, Import, sample). */
async function expectNoCreateControls(page: Page) {
  await expect(page.getByTestId('dashboard')).toBeVisible()
  for (const id of ['create-board', 'open-templates', 'import-board', 'start-sample-board', 'create-project'])
    await expect(page.getByTestId(id), id).toHaveCount(0)
}

test('outside account with nothing shared: an honest landing, and every create route refuses it', async ({
  browser,
  users,
  board,
}, testInfo) => {
  const email = 'client@client.example.test'
  const client = await signedInContext(browser, freshHandle('client'), { name: 'Casey Client', email })
  try {
    await test.step('the api: an outsider with no workspace, no personal workspace, no Dev Studio', async () => {
      expect(client.me.access).toEqual({ creator: false, reason: 'outside', email })
      expect(client.me.workspaces).toEqual([])
    })

    await test.step('"/" says nothing is shared yet, with their address and a way to switch accounts', async () => {
      await client.page.goto('/')
      const screen = client.page.getByTestId('no-workspace')
      await expect(screen).toHaveAttribute('data-reason', 'outside')
      await expect(screen.getByRole('heading')).toHaveText('Nothing has been shared with you yet')
      await expect(screen.getByTestId('no-workspace-account')).toHaveText(`You're signed in as ${email}.`)
      await expect(screen).toContainText('Work there? Sign in with your work email.')
      // D13: "Invite people" and "Link for one person" send no email, so nothing says to wait for one.
      await expect(screen).toContainText('open the invite link they send you')
      await expect(screen).not.toContainText('in their email')
      await expect(screen.getByTestId('no-workspace-switch')).toHaveText('Switch account')
      await capture('domain-access-outside-landing.png', client.page, testInfo)
      await client.page.setViewportSize({ width: 390, height: 844 })
      await expect(screen.getByTestId('no-workspace-switch')).toBeInViewport()
      await expectNoSideScroll(client.page)
      await capture('domain-access-outside-landing-390.png', client.page, testInfo)
    })

    await test.step('every create and share route answers 403 CREATOR_REQUIRED (uniform, whatever the id)', async () => {
      const api = new Api(client.context.request)
      const ws = users.devStudioId
      const fake = { ws: 'wsp_000000000000000000000', board: 'b-0000000000', id: 'inv_00000000000000000000' }
      const routes: [string, string, unknown][] = [
        ['POST', `/api/workspaces/${ws}/boards`, { title: 'Nope' }],
        ['POST', `/api/workspaces/${fake.ws}/boards`, { title: 'Nope' }],
        ['POST', `/api/workspaces/${ws}/projects`, { name: 'Nope' }],
        ['PATCH', '/api/projects/prj_00000000000000000000', { name: 'Nope' }],
        ['POST', `/api/workspaces/${ws}/boards/import`, {}],
        ['POST', `/api/boards/${board}/duplicate`, {}],
        ['POST', '/api/snapshots/snp_00000000000000000000/restore-as-new', {}],
        ['POST', `/api/workspaces/${ws}/invitations`, { role: 'member', email: 'x@client.example.test' }],
        ['POST', `/api/boards/${board}/invitations`, { role: 'viewer', email: 'x@client.example.test' }],
        [
          'POST',
          `/api/boards/${board}/invitations/email`,
          { role: 'viewer', email: 'x@client.example.test' },
        ],
        ['POST', `/api/boards/${board}/review-links`, { role: 'commenter' }],
        ['POST', `/api/boards/${board}/review-links/${fake.id}/extend`, { hours: 1 }],
        ['POST', `/api/access-requests/acr_00000000000000000000/approve`, {}],
        ['POST', `/api/boards/${fake.board}/transfer-ownership`, { userId: 'usr_00000000000000000000' }],
      ]
      for (const [method, path, data] of routes) {
        const res = await api.fetch(method, path, data)
        expect(res.status(), `${method} ${path}`).toBe(403)
        expect(await errorCode(res), `${method} ${path}`).toBe(CREATOR_REQUIRED)
      }
      // Nothing was created: still no workspace, and alice's workspace has only her board.
      expect((await api.me()).workspaces).toEqual([])
    })
  } finally {
    await client.context.close()
  }
})

test('email lock: a link for pat@ turns sam@ away (no auto-accept), then pat signs in and lands on the board as an outsider who creates nothing', async ({
  browser,
  users,
  board,
  canvasSession,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const a = await canvasSession('alice')
  const pat = { handle: freshHandle('pat'), name: 'Pat Client', email: 'pat@client.example.test' }
  const sam = { handle: freshHandle('sam'), name: 'Sam Client', email: 'sam@client.example.test' }
  const hint = 'p•••@client.example.test'

  let link = ''
  await test.step('alice invites pat@ through "Invite people": a link only that address can use', async () => {
    expect((await aliceApi.me()).access).toMatchObject({ creator: true, reason: 'dev' })
    await openShareFromButton(a.page)
    const dialog = shareDialog(a.page)
    await dialog.getByTestId('share-invite-input').fill(pat.email)
    await expect(dialog.getByTestId('share-invite-hint')).toContainText('only this address can use')
    await dialog.getByTestId('share-invite-submit').click()
    await dialog.getByTestId('outside-confirm-yes').click()
    const field = dialog.getByTestId('share-invite-link')
    await expect(field).toHaveValue(new RegExp(`^${WEB_URL}/invite/[A-Za-z0-9_-]{43}$`))
    link = await field.inputValue()
    await expect(dialog.getByTestId('share-invite-lock-note')).toContainText(
      `Only ${pat.email} can use this link, once, until`,
    )
    await expect(dialog.getByTestId('share-invite-lock-note')).toContainText(
      'Anyone else who opens it is turned away.',
    )
    expect(await invitations(aliceApi, board)).toEqual([
      expect.objectContaining({ kind: 'invite', role: 'commenter', uses: 0, email: pat.email }),
    ])
    await a.page.keyboard.press('Escape')
  })

  await test.step('alice opens her own link to check it: it says whom it is for, never "ask Alice"', async () => {
    await a.page.goto(link)
    const mismatch = a.page.getByTestId('invite-email-mismatch')
    await expect(mismatch).toContainText('This is the invitation you sent')
    await expect(a.page.getByTestId('invite-email-mismatch-body')).toHaveText(
      `Only ${hint} can use this link. It won't let you in as alice@dev.invalid. Send it to them: they sign in with that address to join.`,
    )
    await expect(mismatch).not.toContainText('ask Alice Park')
    await expect(a.page.getByTestId('invite-accept')).toHaveCount(0)
    expect(await invitations(aliceApi, board)).toEqual([expect.objectContaining({ kind: 'invite', uses: 0 })])
  })

  await test.step('fixer round 2: her own link is not an error and not "invited you"; its one action leads back to the board, signed in', async () => {
    const invitePage = a.page.getByTestId('invite-page')
    const mismatch = a.page.getByTestId('invite-email-mismatch')
    await expect(mismatch).toHaveAttribute('role', 'status')
    await expect(mismatch).toHaveAttribute('data-sent-by-you', 'true')
    await expect(invitePage).toContainText('Your invitation to a board')
    await expect(invitePage).not.toContainText('invited you')
    await expect(a.page.getByTestId('invite-title')).not.toContainText('Join')
    await expect(invitePage).toContainText('Their role')
    await expect(a.page.getByTestId('invite-inviter')).toHaveText('Alice Park (you)')
    // No way into signing out: the only action goes back to the board.
    await expect(a.page.getByTestId('invite-mismatch-switch')).toHaveCount(0)
    await expect(invitePage.getByRole('button')).toHaveCount(0)
    const back = a.page.getByTestId('invite-own-back')
    await expect(back).toHaveText('Back to the board')
    await capture('domain-access-invite-own-link.png', a.page, testInfo)
    await back.click()
    await expect(a.page).toHaveURL(new RegExp(`/b/${board}$`))
    await waitForLobbyBoard(a.page)
    expect((await a.context.request.get(`${WEB_URL}/api/me`)).status()).toBe(200)
    expect(await invitations(aliceApi, board)).toEqual([expect.objectContaining({ kind: 'invite', uses: 0 })])
  })

  // One browser: sam signs in from the link, is turned away, switches to pat.
  const context = await browser.newContext()
  try {
    const page = context.pages()[0] ?? (await context.newPage())

    await test.step('signed out: the page names the address (masked) the invitation is for', async () => {
      await page.goto(link)
      await expect(page.getByTestId('invite-page')).toBeVisible()
      await expect(page.getByTestId('invite-locked-hint')).toHaveText(hint)
      await expect(page.getByTestId('invite-signin')).toHaveText(`Sign in or create an account with ${hint}`)
      await expect(page.getByTestId('invite-page')).not.toContainText(pat.email)
      await page.getByTestId('invite-signin').click()
      await expect(page.getByTestId('signin-heading')).toContainText(`Sign in with ${hint} to join`)
    })

    await test.step('sam signs in: the mismatch state, with both addresses, and nothing accepted', async () => {
      await signInThroughUi(page, sam)
      await expect(page).toHaveURL(new RegExp(`/invite/${inviteToken(link)}$`))
      const mismatch = page.getByTestId('invite-email-mismatch')
      await expect(mismatch).toBeVisible()
      await expect(mismatch).toContainText(`This invitation was sent to ${hint}.`)
      await expect(mismatch).toContainText(`You're signed in as ${sam.email}.`)
      await expect(mismatch).toContainText(`ask Alice Park to invite ${sam.email}`)
      await expect(page.getByTestId('invite-accept')).toHaveCount(0)
      await capture('domain-access-invite-mismatch.png', page, testInfo)
      // No auto-accept: the link is still unused, and sam cannot open the board.
      expect(await invitations(aliceApi, board)).toEqual([
        expect.objectContaining({ kind: 'invite', uses: 0 }),
      ])
      expect((await context.request.get(`${WEB_URL}/api/boards/${board}`)).status()).toBe(404)
      // A forged accept is refused too, and still redeems nothing.
      const forged = await context.request.post(`${WEB_URL}/api/invitations/${inviteToken(link)}/accept`, {
        headers: { origin: WEB_URL },
      })
      expect(forged.status()).toBe(403)
      expect(await errorCode(forged)).toBe('INVITATION_EMAIL_MISMATCH')
      expect(await invitations(aliceApi, board)).toHaveLength(1)
    })

    await test.step('"Sign in with a different account": pat signs in and is let in at once, as commenter', async () => {
      await page.getByTestId('invite-mismatch-switch').click()
      await signInThroughUi(page, pat)
      await expect(page).toHaveURL(new RegExp(`/b/${board}$`), { timeout: 30_000 })
      await waitForLobbyBoard(page)
      await expect(page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')
      const patMe = (await (await context.request.get(`${WEB_URL}/api/me`)).json()) as Me
      expect(patMe.access).toEqual({ creator: false, reason: 'outside', email: pat.email })
      expect(await invitations(aliceApi, board)).toEqual([])
    })

    await test.step('pat’s dashboard: no New board, Templates, Import or sample; the card has no Duplicate', async () => {
      await openDashboard(page, users.devStudioId)
      await expectNoCreateControls(page)
      const actions = await menuActions(mainCard(page, board))
      expect(actions).toContain('open')
      expect(actions).not.toContain('duplicate')
    })

    await test.step('pat’s History panel offers neither "Duplicate board" nor "Restore as new board"', async () => {
      const saved = await aliceApi.fetch('POST', `/api/boards/${board}/snapshots`, { name: 'Baseline' })
      expect(saved.status()).toBe(201)
      await page.goto(`/b/${board}`)
      await waitForLobbyBoard(page)
      const panel = await openHistory(page)
      await expect(panel.getByTestId('checkpoint-row').first()).toBeVisible()
      await expect(panel.getByTestId('history-duplicate')).toHaveCount(0)
      await expect(panel.getByTestId('checkpoint-restore')).toHaveCount(0)
    })

    await test.step('with nothing left to show, the empty dashboard says who can create boards', async () => {
      expect((await aliceApi.fetch('POST', `/api/boards/${board}/trash`)).status()).toBe(200)
      await openDashboard(page, users.devStudioId)
      await expect(page.getByTestId('dashboard-empty')).toContainText(OUTSIDE_EMPTY)
      await expectNoCreateControls(page)
    })
  } finally {
    await context.close()
  }
})

test('domain creators: darkburn.com and trailerparkgroup.com get a personal workspace and create boards; a subdomain does not count', async ({
  browser,
}) => {
  for (const [label, email] of [
    ['Dark Burn Creative', 'lobby-test-dbc@darkburn.com'],
    ['Trailer Park Group', 'lobby-test-tpg@trailerparkgroup.com'],
  ] as const) {
    await test.step(`${label}: a creator with a personal workspace, and New board works`, async () => {
      const p = await signedInContext(browser, freshHandle('dom'), { name: `${label} Person`, email })
      try {
        expect(p.me.access).toEqual({ creator: true, reason: 'domain', email })
        const wid = personalWorkspace(p.me)
        await openDashboard(p.page, wid)
        await p.page.getByTestId('create-board').click()
        await expect(p.page.getByTestId('create-board-dialog')).toBeVisible()
        await p.page.getByTestId('create-board-title').fill(`${label} plan`)
        await p.page.getByTestId('create-board-submit').click()
        await expect(p.page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
        await waitForLobbyBoard(p.page)
        await expect(p.page.getByTestId('readonly-pill')).toHaveCount(0)
      } finally {
        await p.context.close()
      }
    })
  }

  await test.step('sub.darkburn.com is an outside account (exact domains only)', async () => {
    const email = 'lobby-test@sub.darkburn.com'
    const p = await signedInContext(browser, freshHandle('sub'), { name: 'Sub Domain', email })
    try {
      expect(p.me.access).toEqual({ creator: false, reason: 'outside', email })
      expect(p.me.workspaces).toEqual([])
      await p.page.goto('/')
      await expect(p.page.getByTestId('no-workspace')).toHaveAttribute('data-reason', 'outside')
    } finally {
      await p.context.close()
    }
  })
})

test('the exception address (DRAFTROOM_CREATOR_EMAILS) is a creator', async ({ browser }) => {
  const p = await signedInContext(browser, freshHandle('owner'), { name: 'Personal Owner', email: EXCEPTION })
  try {
    expect(p.me.access).toEqual({ creator: true, reason: 'exception', email: EXCEPTION })
    const wid = personalWorkspace(p.me)
    await openDashboard(p.page, wid)
    await expect(p.page.getByTestId('create-board')).toBeVisible()
    await expect(p.page.getByTestId('create-project')).toBeVisible()
    const created = await new Api(p.context.request).createBoard(wid, 'Exception board')
    expect(created.id).toMatch(/^b-[0-9a-z]{10}$/)
  } finally {
    await p.context.close()
  }
})

test('a board owner who is not a creator: the Share dialog only reduces access (note, no invites or links, no transfer, no copy-link), and lowering and removing work', async ({
  browser,
  playwright,
  users,
}, testInfo) => {
  const handle = freshHandle('own')
  const name = 'Olive Owner'
  const [bob, carol, dave] = await Promise.all([users.get('bob'), users.get('carol'), users.get('dave')])
  const invitee = 'invitee@client.example.test'

  let boardId = ''
  await test.step('set-up while a creator: a Dev Studio board with people, a review link, an invite, a request', async () => {
    const { api: ownApi, me } = await Api.signIn(playwright, handle, name)
    try {
      expect(me.access).toMatchObject({ creator: true, reason: 'dev' })
      boardId = (await ownApi.createBoard(users.devStudioId, 'Outside owner board')).id
      await ownApi.putMember(boardId, bob.id, 'editor')
      await ownApi.putMember(boardId, carol.id, 'commenter')
      const review = await ownApi.fetch('POST', `/api/boards/${boardId}/review-links`, {
        role: 'commenter',
        expiresInDays: 14,
        allowGuests: false,
      })
      expect(review.status()).toBe(201)
      const invite = await ownApi.fetch('POST', `/api/boards/${boardId}/invitations`, {
        role: 'viewer',
        email: invitee,
      })
      expect(invite.status()).toBe(201)
      const daveApi = await users.api('dave')
      const asked = await daveApi.fetch('POST', `/api/boards/${boardId}/access-requests`, { role: 'viewer' })
      expect(asked.status()).toBeLessThan(300)
    } finally {
      await ownApi.dispose()
    }
  })

  // The same account signs in again with an outside address: it keeps every membership and its
  // ownership (decision 4), and becomes an outsider.
  const own = await signedInContext(browser, handle, { name, email: 'olive@client.example.test' })
  try {
    const page = own.page
    await test.step('the outsider keeps Dev Studio and the board, as its owner', async () => {
      expect(own.me.access).toMatchObject({ creator: false, reason: 'outside' })
      expect(own.me.workspaces.map((w) => w.id)).toContain(users.devStudioId)
      const ownApi = new Api(own.context.request)
      expect((await ownApi.getBoard(boardId)).role).toBe('owner')
    })

    await test.step('the Share dialog: the note, and nothing that hands out access', async () => {
      await page.goto(`/b/${boardId}`)
      await waitForLobbyBoard(page)
      await openShareFromButton(page)
      const dialog = shareDialog(page)
      await expect(dialog.getByTestId('share-creator-note')).toHaveText(SHARE_NOTE)
      await expect(dialog.getByTestId('member-list')).toBeVisible()
      for (const id of [
        'share-invite-input',
        'review-link-create',
        'share-workshop-shortcut',
        'share-more',
        'share-email-section',
        'invite-create',
        'one-person-link-email',
        'workshop-link-create',
        'member-transfer',
        'access-request-approve',
        'review-link-copy',
        'review-link-url',
      ])
        await expect(dialog.getByTestId(id), id).toHaveCount(0)
      // What is open stays visible, to revoke; the request can be denied.
      await expect(dialog.getByTestId('review-link-row')).toHaveCount(1)
      await expect(dialog.getByTestId('review-link-revoke')).toBeVisible()
      await expect(dialog.getByTestId('invitation-row')).toContainText(`For ${invitee} · Can view`)
      await expect(dialog.getByTestId('access-request-deny')).toBeVisible()
      // Workspace access can only be narrowed: the options above "Private" are off.
      const visibility = dialog.getByTestId('visibility-select')
      await expect(visibility).toHaveValue('private')
      await expect(visibility.locator('option[value="workspace_view"]')).toBeDisabled()
      await expect(visibility.locator('option[value="workspace_edit"]')).toBeDisabled()
      await capture('domain-access-share-reduce-only.png', dialog, testInfo)
    })

    await test.step('lowering works; raising is not offered', async () => {
      const bobRole = memberRow(page, bob.id).getByTestId('member-role')
      await expect(bobRole.locator('option')).toHaveText(['Can edit', 'Can comment', 'Can view'])
      await bobRole.selectOption('viewer')
      await expect(memberRow(page, bob.id)).toHaveAttribute('data-role', 'viewer')
      await expect(shareDialog(page).getByTestId('share-error')).toHaveCount(0)
      const members = await new Api(own.context.request).members(boardId)
      expect(members.find((m) => m.user.id === bob.id)?.role).toBe('viewer')
      await expect(memberRow(page, bob.id).getByTestId('member-role').locator('option')).toHaveText([
        'Can view',
      ])
    })

    await test.step('removing works, and so do revoking the invitation and denying the request', async () => {
      await memberRow(page, carol.id).getByTestId('member-remove').click()
      await memberRow(page, carol.id).getByTestId('member-remove-confirm').click()
      await expect(memberRow(page, carol.id)).toHaveCount(0)
      const dialog = shareDialog(page)
      await dialog.getByTestId('invitation-revoke').click()
      await expect(dialog.getByTestId('invitation-row')).toHaveCount(0)
      await dialog.getByTestId('access-request-deny').click()
      await expect(dialog.getByTestId('access-request-row')).toHaveCount(0)
      const ownApi = new Api(own.context.request)
      expect((await ownApi.members(boardId)).map((m) => m.user.id)).not.toContain(carol.id)
      expect(await accessRequests(ownApi, boardId)).toEqual([])
      expect(await invitations(ownApi, boardId)).toEqual([expect.objectContaining({ kind: 'review' })])
      expect((await ownApi.members(boardId)).map((m) => m.user.id)).not.toContain(dave.id)
      // The server refuses what the dialog does not offer.
      const raise = await ownApi.fetch('PUT', `/api/boards/${boardId}/members/${bob.id}`, { role: 'editor' })
      expect(raise.status()).toBe(403)
      expect(await errorCode(raise)).toBe(CREATOR_REQUIRED)
      const links = (await (await ownApi.fetch('GET', `/api/boards/${boardId}/invitations`)).json()) as {
        invitations: { kind: string; url: string | null }[]
      }
      expect(links.invitations.filter((i) => i.kind === 'review').map((i) => i.url)).toEqual([null])
      await page.keyboard.press('Escape')
    })

    await test.step('History: no copy actions for an outside workspace member', async () => {
      const panel = await openHistory(page)
      await expect(panel.getByTestId('export-json')).toBeVisible()
      await expect(panel.getByTestId('history-duplicate')).toHaveCount(0)
    })

    await test.step('the dashboard: the board can be moved, never duplicated; nothing to create, and it says why', async () => {
      await openDashboard(page, users.devStudioId)
      await expectNoCreateControls(page)
      await expect(page.getByTestId('access-outside')).toContainText(OUTSIDE_NOTICE)
      const actions = await menuActions(mainCard(page, boardId))
      expect(actions).toContain('move')
      expect(actions).not.toContain('duplicate')
    })
  } finally {
    await own.context.close()
  }
})

// ---- fixer round 1: the flows the review found untested or unclear ----------------------------------

test('a name-only guest joins a creator’s client link, unchanged under the domain-access policy (§11.5 flow 6)', async ({
  browser,
  users,
  board,
}) => {
  const aliceApi = await users.api('alice')
  const created = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'commenter',
    expiresInDays: 14,
    allowGuests: true,
  })
  expect(created.status()).toBe(201)
  const link = ((await created.json()) as { url: string }).url
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(link)
    await expect(page.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'true')
    // A guest link is not locked to an address.
    await expect(page.getByTestId('invite-locked-hint')).toHaveCount(0)
    await page.getByTestId('invite-guest-name').fill('Gia Guest')
    await page.getByTestId('invite-guest-join').click()
    await expect(page).toHaveURL(new RegExp(`/b/${board}$`), { timeout: 30_000 })
    await waitForLobbyBoard(page)
    await expect(page.getByTestId('user-menu')).toHaveAttribute('data-kind', 'guest')
    await expect(page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')
    const guestApi = new Api(context.request)
    expect((await guestApi.me()).access).toEqual({ creator: false, reason: 'guest', email: null })
    // Guests keep their own refusal, never CREATOR_REQUIRED.
    const refused = await guestApi.fetch('POST', `/api/workspaces/${users.devStudioId}/boards`, {
      title: 'No',
    })
    expect(refused.status()).toBe(403)
    expect(await errorCode(refused)).toBe('GUEST_ACCOUNT_REQUIRED')
  } finally {
    await context.close()
  }
})

test('an existing account that lost creator status: its own workspace says why nothing can be created, and Share and History promise nothing it cannot do', async ({
  browser,
  playwright,
  users,
}, testInfo) => {
  const handle = freshHandle('exo')
  const name = 'Exa Former'
  let personal = ''
  let boardId = ''
  await test.step('set-up while a creator: a board in its personal workspace, opened once, with a checkpoint', async () => {
    const { api, me } = await Api.signIn(playwright, handle, name)
    try {
      personal = personalWorkspace(me)
      boardId = (await api.createBoard(personal, 'Own board')).id
      // On the Excalidraw engine a board has no file until someone opens it, and the api's snapshot read of
      // one answers 503 (sync: 404 board-not-found); the tldraw registry made an empty room on demand. A
      // checkpoint is saved from the History panel of an OPEN board, so the set-up opens it once, as a
      // person would.
      const opened = await openCanvasSession(browser, boardId, {
        handle,
        name,
        id: me.user.id,
        personalWorkspaceId: personal,
      })
      await opened.context.close()
      expect((await api.fetch('POST', `/api/boards/${boardId}/snapshots`, { name: 'Draft' })).status()).toBe(
        201,
      )
    } finally {
      await api.dispose()
    }
  })

  const exo = await signedInContext(browser, handle, { name, email: 'exo@client.example.test' })
  try {
    const page = exo.page
    expect(exo.me.access).toMatchObject({ creator: false, reason: 'outside' })
    expect(exo.me.workspaces).toContainEqual(expect.objectContaining({ id: personal, role: 'owner' }))

    await test.step('its own workspace (Owner): the board is there, the create controls are not, and a notice says why', async () => {
      await openDashboard(page, personal)
      await expect(mainCard(page, boardId)).toBeVisible()
      await expectNoCreateControls(page)
      const notice = page.getByTestId('access-outside')
      await expect(notice).toContainText(OUTSIDE_NOTICE)
      await expect(notice).toContainText('Work there? Sign in with your work email.')
      await capture('domain-access-outside-own-workspace.png', page, testInfo)
      // Dev Studio, where it is a member: the same notice.
      await openDashboard(page, users.devStudioId)
      await expect(page.getByTestId('access-outside')).toContainText(OUTSIDE_NOTICE)
      // Trash offers no creating to anyone: no notice there.
      await openDashboard(page, personal, 'trash')
      await expect(page.getByTestId('access-outside')).toHaveCount(0)
    })

    await test.step('Share: the note, and no line about creating client links it cannot make', async () => {
      await page.goto(`/b/${boardId}`)
      await waitForLobbyBoard(page)
      await openShareFromButton(page)
      const dialog = shareDialog(page)
      await expect(dialog.getByTestId('share-creator-note')).toHaveAttribute('data-reason', 'outside')
      await expect(dialog.getByTestId('share-creator-note')).toHaveText(SHARE_NOTE)
      await expect(dialog.getByTestId('share-export-policy')).toBeVisible()
      await expect(dialog.getByTestId('share-export-policy')).toHaveAttribute('data-policy', 'everyone')
      await expect(dialog.getByTestId('share-export-policy-default')).toHaveCount(0)
      await page.keyboard.press('Escape')
    })

    await test.step('History: the checkpoint is listed, nothing promises restoring it', async () => {
      const panel = await openHistory(page)
      await expect(panel.getByTestId('checkpoint-row').first()).toBeVisible()
      await expect(panel.getByTestId('checkpoint-restore')).toHaveCount(0)
      await expect(panel.getByTestId('checkpoints-hint')).toHaveText(RESTORE_ONLY_CREATORS)
    })
  } finally {
    await exo.context.close()
  }
})

/** The Share dialog's "People with access" section (the list and its owner note). */
const peopleSection = (page: Page) => shareDialog(page).locator('section[aria-labelledby="dr-share-people"]')

test('a creator managing an outside member: Owner is off with the reason in words, transfer is off, and "pick someone" never offers Owner', async ({
  playwright,
  users,
  board,
  canvasSession,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  // Three Dev Studio members (joined while creators) who are outside accounts now.
  const olga = { handle: freshHandle('olga'), name: 'Olga Outside' }
  const pia = { handle: freshHandle('pia'), name: 'Pia Outside' }
  const nils = { handle: freshHandle('nils'), name: 'Nils Outside' }
  for (const p of [olga, pia, nils]) {
    const { api } = await Api.signIn(playwright, p.handle, p.name)
    await api.dispose()
  }
  const olgaNow = await Api.signIn(playwright, olga.handle, olga.name, { email: 'olga@client.example.test' })
  const piaNow = await Api.signIn(playwright, pia.handle, pia.name, { email: 'pia@client.example.test' })
  const nilsNow = await Api.signIn(playwright, nils.handle, nils.name, { email: 'nils@client.example.test' })
  const olgaId = olgaNow.me.user.id
  const piaId = piaNow.me.user.id
  try {
    expect(olgaNow.me.access).toMatchObject({ creator: false, reason: 'outside' })
    const bob = await users.get('bob')
    await aliceApi.putMember(board, olgaId, 'editor')
    await aliceApi.putMember(board, piaId, 'viewer')
    await aliceApi.putMember(board, bob.id, 'viewer')
    const a = await canvasSession('alice')
    const OWNER_NOTE =
      'Only people at Dark Burn Creative or Trailer Park Group can own boards, so Owner is turned off for everyone else here.'

    await test.step('olga’s and pia’s rows: Owner is turned off, and the list says why in words, once', async () => {
      await openShareFromButton(a.page)
      const dialog = shareDialog(a.page)
      for (const [id, role] of [
        [olgaId, 'editor'],
        [piaId, 'viewer'],
      ] as const) {
        await expect(memberRow(a.page, id)).toHaveAttribute('data-role', role)
      }
      // Fixer round 2: one note under "People with access", not one per row (a list of client
      // reviewers repeated it on every row).
      const note = dialog.getByTestId('member-owner-note')
      await expect(note).toHaveCount(1)
      await expect(note).toHaveText(OWNER_NOTE)
      await expect(dialog.getByTestId('member-list').getByTestId('member-owner-note')).toHaveCount(0)
      const noteId = (await note.getAttribute('id')) ?? ''
      expect(noteId).not.toBe('')
      for (const id of [olgaId, piaId]) {
        const row = memberRow(a.page, id)
        await expect(row.getByTestId('member-role').locator('option[value="owner"]')).toBeDisabled()
        await expect(row.getByTestId('member-role')).toHaveAttribute('aria-describedby', noteId)
        await expect(row.getByTestId('member-transfer')).toBeDisabled()
        await expect(row.getByTestId('member-transfer')).toHaveAttribute('aria-describedby', noteId)
      }
      // A creator's row: Owner is offered, and nothing points to the note.
      const bobRow = memberRow(a.page, bob.id)
      await expect(bobRow.getByTestId('member-role').locator('option[value="owner"]')).toBeEnabled()
      await expect(bobRow.getByTestId('member-role')).not.toHaveAttribute('aria-describedby', /.+/)
      await expect(bobRow.getByTestId('member-transfer')).not.toHaveAttribute('aria-describedby', /.+/)
      await capture('domain-access-owner-off-note.png', peopleSection(a.page), testInfo)
    })

    await test.step('an outsider’s row is as tall as a creator’s, on a desktop and at 390 px', async () => {
      const heights = async () => {
        const of = async (id: string) => (await memberRow(a.page, id).boundingBox())?.height ?? 0
        return { bob: await of(bob.id), olga: await of(olgaId), pia: await of(piaId) }
      }
      const wide = await heights()
      expect(wide.bob).toBeGreaterThan(0)
      expect(Math.abs(wide.olga - wide.bob), JSON.stringify(wide)).toBeLessThanOrEqual(2)
      expect(Math.abs(wide.pia - wide.bob), JSON.stringify(wide)).toBeLessThanOrEqual(2)
      await a.page.setViewportSize({ width: 390, height: 844 })
      await expect(shareDialog(a.page).getByTestId('member-owner-note')).toBeVisible()
      const narrow = await heights()
      expect(Math.abs(narrow.olga - narrow.bob), JSON.stringify(narrow)).toBeLessThanOrEqual(2)
      expect(Math.abs(narrow.pia - narrow.bob), JSON.stringify(narrow)).toBeLessThanOrEqual(2)
      await expectNoSideScroll(a.page)
      await capture('domain-access-owner-off-note-390.png', peopleSection(a.page), testInfo)
      await a.page.setViewportSize({ width: 1280, height: 720 })
    })

    await test.step('the invite field’s list (a click on it empty) lists nils, and offers edit, comment or view only', async () => {
      const dialog = shareDialog(a.page)
      await expect(listedPerson(await openPeopleList(a.page), nilsNow.me.user.id)).toHaveCount(1)
      await expect(dialog.getByTestId('share-invite-role').locator('option')).toHaveText([
        'Can edit',
        'Can comment',
        'Can view',
      ])
    })

    await test.step('the server agrees: owner for olga is 409, transfer to olga is 409', async () => {
      const put = await aliceApi.fetch('PUT', `/api/boards/${board}/members/${olgaId}`, { role: 'owner' })
      expect(put.status()).toBe(409)
      expect(await errorCode(put)).toBe('ROLE_REQUIRES_CREATOR')
      const transfer = await aliceApi.fetch('POST', `/api/boards/${board}/transfer-ownership`, {
        userId: olgaId,
      })
      expect(transfer.status()).toBe(409)
      expect(await errorCode(transfer)).toBe('ROLE_REQUIRES_CREATOR')
    })
  } finally {
    await olgaNow.api.dispose()
    await piaNow.api.dispose()
    await nilsNow.api.dispose()
  }
})

test('an outsider opens a board link: the no-access screen, a request, a creator approves, and the board opens at the granted role', async ({
  browser,
  users,
  board,
  canvasSession,
}) => {
  const rae = await signedInContext(browser, freshHandle('rae'), {
    name: 'Rae Request',
    email: 'rae@client.example.test',
  })
  try {
    const page = rae.page
    expect(rae.me.workspaces).toEqual([])
    await test.step('rae (no workspace) opens the board URL and asks to comment', async () => {
      await page.goto(`/b/${board}`)
      await expect(page.getByTestId('no-access')).toContainText("You don't have access to this board")
      await expect(page.getByTestId('access-request-form')).toBeVisible()
      await page.getByTestId('access-request-role').selectOption('commenter')
      await page.getByTestId('access-request-button').click()
      await expect(page.getByTestId('access-request-status')).toContainText('requested')
    })

    await test.step('alice (a creator) approves it in the Share dialog; rae’s page opens the board by itself', async () => {
      const a = await canvasSession('alice')
      const badge = a.page.getByTestId('share-badge')
      await expect(badge).toHaveAttribute('data-requests', '1', { timeout: 15_000 })
      await badge.click()
      const row = requestRow(a.page, rae.me.user.id)
      await expect(row).toBeVisible()
      await row.getByTestId('access-request-approve').click()
      await row.getByTestId('outside-confirm-yes').click()
      await expect(requestRow(a.page, rae.me.user.id)).toHaveCount(0)
      await expect(memberRow(a.page, rae.me.user.id)).toHaveAttribute('data-role', 'commenter')
      await waitForLobbyBoard(page)
      await expect(page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')
    })

    await test.step('rae is a workspace guest of Dev Studio, still an outside account that creates nothing', async () => {
      const me = await new Api(rae.context.request).me()
      expect(me.access).toEqual({ creator: false, reason: 'outside', email: 'rae@client.example.test' })
      expect(me.workspaces).toContainEqual(expect.objectContaining({ id: users.devStudioId, role: 'guest' }))
      await openDashboard(page, users.devStudioId)
      await expectNoCreateControls(page)
      await expect(mainCard(page, board)).toBeVisible()
    })
  } finally {
    await rae.context.close()
  }
})

test('an email-locked workspace invitation: admin for an outside address is refused; as member, the outsider signs in with that address and joins', async ({
  browser,
  users,
}) => {
  const aliceApi = await users.api('alice')
  const email = 'wes@client.example.test'
  const wes = { handle: freshHandle('wes'), name: 'Wes Workspace', email }

  const admin = await aliceApi.fetch('POST', `/api/workspaces/${users.devStudioId}/invitations`, {
    role: 'admin',
    email,
  })
  expect(admin.status()).toBe(409)
  expect(await errorCode(admin)).toBe('ROLE_REQUIRES_CREATOR')
  const created = await aliceApi.fetch('POST', `/api/workspaces/${users.devStudioId}/invitations`, {
    role: 'member',
    email,
  })
  expect(created.status()).toBe(201)
  const link = ((await created.json()) as { url: string }).url

  await test.step('fixer round 2: alice opens her own workspace link: it leads back to the workspace, signed in', async () => {
    const alice = await signedInContext(browser, 'alice')
    try {
      await alice.page.goto(link)
      await expect(alice.page.getByTestId('invite-email-mismatch')).toHaveAttribute(
        'data-sent-by-you',
        'true',
      )
      await expect(alice.page.getByTestId('invite-page')).toContainText('Your invitation to a workspace')
      await expect(alice.page.getByTestId('invite-mismatch-switch')).toHaveCount(0)
      const back = alice.page.getByTestId('invite-own-back')
      await expect(back).toHaveText('Go to the workspace')
      await back.click()
      await expect(alice.page).toHaveURL(new RegExp(`/w/${users.devStudioId}$`))
      await expect(alice.page.getByTestId('dashboard')).toBeVisible()
      expect((await alice.context.request.get(`${WEB_URL}/api/me`)).status()).toBe(200)
    } finally {
      await alice.context.close()
    }
  })

  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(link)
    await expect(page.getByTestId('invite-locked-hint')).toHaveText('w•••@client.example.test')
    await page.getByTestId('invite-signin').click()
    await signInThroughUi(page, wes)
    await expect(page).toHaveURL(new RegExp(`/w/${users.devStudioId}`), { timeout: 30_000 })
    await expect(page.getByTestId('dashboard')).toBeVisible()
    const me = await new Api(context.request).me()
    expect(me.access).toEqual({ creator: false, reason: 'outside', email })
    expect(me.workspaces).toContainEqual(expect.objectContaining({ id: users.devStudioId, role: 'member' }))
    // A member who is an outside account: nothing to create, and the dashboard says why.
    await expectNoCreateControls(page)
    await expect(page.getByTestId('access-outside')).toContainText(OUTSIDE_NOTICE)
  } finally {
    await context.close()
  }
})

/**
 * Rewrites what the web reads about the signed-in account (GET /api/auth/me, GET /api/me): the states
 * the dev provider can never produce (an unconfirmed account).
 */
async function rewriteMe(
  page: Page,
  change: (me: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  for (const path of ['**/api/auth/me', '**/api/me']) {
    await page.route(path, async (route) => {
      const res = await route.fetch()
      if (res.status() !== 200) return route.fulfill({ response: res })
      await route.fulfill({ response: res, json: change((await res.json()) as Record<string, unknown>) })
    })
  }
}

test('failure states the dev provider cannot produce: an unconfirmed account (dashboard, landing, Share) and refused accepts (503 retry, 409, 403 mismatch)', async ({
  browser,
  users,
  board,
}, testInfo) => {
  const unconfirmed = { creator: false, reason: 'unconfirmed', email: 'alice@dev.invalid' }

  await test.step('alice, unconfirmed: the dashboard pauses creating, and Share says paused, not "not at Dark Burn"', async () => {
    const alice = await signedInContext(browser, 'alice')
    try {
      await rewriteMe(alice.page, (me) => ({ ...me, access: unconfirmed }))
      await openDashboard(alice.page, users.devStudioId)
      await expect(alice.page.getByTestId('access-unconfirmed')).toContainText(
        "Lobby couldn't confirm your account, so creating and sharing are paused.",
      )
      await expectNoCreateControls(alice.page)
      await expect(alice.page.getByTestId('access-outside')).toHaveCount(0)
      await alice.page.goto(`/b/${board}`)
      await waitForLobbyBoard(alice.page)
      await openShareFromButton(alice.page)
      const note = shareDialog(alice.page).getByTestId('share-creator-note')
      await expect(note).toHaveAttribute('data-reason', 'unconfirmed')
      await expect(note).toHaveText(UNCONFIRMED_SHARE_NOTE)
      await expect(note).not.toContainText('Only people at Dark Burn Creative')
      await capture('domain-access-unconfirmed-share.png', shareDialog(alice.page), testInfo)
    } finally {
      await alice.context.close()
    }
  })

  await test.step('an unconfirmed account with no workspace: "We couldn’t confirm your account" and Reload', async () => {
    const nobody = await signedInContext(browser, freshHandle('unc'), {
      name: 'Una Confirmed',
      email: 'una@client.example.test',
    })
    try {
      await rewriteMe(nobody.page, (me) => ({ ...me, access: { ...unconfirmed, email: null } }))
      await nobody.page.goto('/')
      const screen = nobody.page.getByTestId('no-workspace')
      await expect(screen).toHaveAttribute('data-reason', 'unconfirmed')
      await expect(screen.getByRole('heading')).toHaveText("We couldn't confirm your account")
      await expect(screen.getByTestId('no-workspace-reload')).toBeVisible()
      await expect(screen.getByTestId('no-workspace-switch')).toHaveCount(0)
    } finally {
      await nobody.context.close()
    }
  })

  await test.step('refused accepts: 503 offers "Try again", 409 shows the server’s words, 403 shows the mismatch state', async () => {
    const aliceApi = await users.api('alice')
    const email = 'ivy@client.example.test'
    const res = await aliceApi.fetch('POST', `/api/boards/${board}/invitations`, { role: 'viewer', email })
    expect(res.status()).toBe(201)
    const link = ((await res.json()) as { url: string }).url
    const token = inviteToken(link)
    const ivy = await signedInContext(browser, freshHandle('ivy'), { name: 'Ivy Invitee', email })
    try {
      const page = ivy.page
      const accept = `**/api/invitations/${token}/accept`
      const refuse = (status: number, body: unknown) =>
        page.route(accept, (route) => route.fulfill({ status, json: body }))

      // 503 IDENTITY_UNAVAILABLE: the page offers a retry.
      await refuse(503, {
        error: {
          code: 'IDENTITY_UNAVAILABLE',
          message:
            'Lobby couldn’t confirm your email address with the sign-in service. Try again in a minute.',
        },
      })
      await page.goto(link)
      await page.getByTestId('invite-accept').click()
      await expect(page.getByTestId('invite-error')).toHaveText(
        'Couldn’t confirm your email right now. Try again in a minute.',
      )
      await expect(page.getByTestId('invite-retry')).toBeVisible()

      // 409 ROLE_REQUIRES_CREATOR: the server's words, no retry.
      await page.unroute(accept)
      const roleMessage =
        'Only people at Dark Burn Creative or Trailer Park Group can own boards or be workspace admins in Lobby. Choose a different role for this person.'
      await refuse(409, { error: { code: 'ROLE_REQUIRES_CREATOR', message: roleMessage } })
      await page.getByTestId('invite-retry').click()
      await expect(page.getByTestId('invite-error')).toHaveText(roleMessage)
      await expect(page.getByTestId('invite-retry')).toHaveCount(0)

      // 403 INVITATION_EMAIL_MISMATCH although the preview said this account matches (fresher data at
      // accept): the mismatch state, from the preview's masked address. Accept checked the account
      // with the sign-in service, found the invited address gone and stored what it found, so the page
      // reads the session again and names the account's address as it is now (fixer round 2; this
      // rewrite of /api/me stands in for the api's stored addresses after that check).
      await page.unroute(accept)
      let refused403 = false
      let meReadsAfter = 0
      const nowEmail = 'ivy.now@client.example.test'
      await page.route(accept, (route) => {
        refused403 = true
        return route.fulfill({
          status: 403,
          json: {
            error: {
              code: 'INVITATION_EMAIL_MISMATCH',
              message: 'This invitation is for i•••@client.example.test.',
            },
            mismatch: { invitedEmailHint: 'i•••@client.example.test', invitedBy: { name: 'Alice Park' } },
          },
        })
      })
      await rewriteMe(page, (me) => {
        if (!refused403) return me
        meReadsAfter++
        return { ...me, access: { creator: false, reason: 'outside', email: nowEmail } }
      })
      await page.reload()
      await page.getByTestId('invite-accept').click()
      const mismatch = page.getByTestId('invite-email-mismatch')
      await expect(mismatch).toContainText('This invitation was sent to i•••@client.example.test.')
      await expect(mismatch).toContainText(`You're signed in as ${nowEmail}.`)
      await expect(mismatch).toContainText(`ask Alice Park to invite ${nowEmail}.`)
      await expect(mismatch).not.toContainText(email)
      expect(meReadsAfter).toBeGreaterThan(0)
      await expect(page.getByTestId('invite-mismatch-switch')).toBeVisible()
      expect(await invitations(aliceApi, board)).toContainEqual(
        expect.objectContaining({ kind: 'invite', email, uses: 0 }),
      )

      // The real api: ivy has the invited address, so accepting works.
      await page.unroute(accept)
      await page.unroute('**/api/auth/me')
      await page.unroute('**/api/me')
      await page.reload()
      await page.getByTestId('invite-accept').click()
      await expect(page).toHaveURL(new RegExp(`/b/${board}$`), { timeout: 30_000 })
      await waitForLobbyBoard(page)
    } finally {
      await ivy.context.close()
    }
  })
})

// ---- fixer round 3 (docs/DOMAIN-ACCESS-CONTRACTS.md §21) ------------------------------------------------

const OWN_ADDRESS = 'That’s your own address. Enter the email address of the person you want to invite.'

test('fixer round 3: the invite page when Lobby can’t be reached says so with a retry, never the signed-out or another state', async ({
  browser,
  users,
  board,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const email = 'ivo@client.example.test'
  const res = await aliceApi.fetch('POST', `/api/boards/${board}/invitations`, { role: 'viewer', email })
  expect(res.status()).toBe(201)
  const link = ((await res.json()) as { url: string }).url
  const token = inviteToken(link)
  const ivo = await signedInContext(browser, freshHandle('ivo'), { name: 'Ivo Invitee', email })
  try {
    const page = ivo.page
    const unreachable = page.getByTestId('api-unreachable')
    const retry = page.getByTestId('api-unreachable-retry')
    const preview = `**/api/invitations/${token}`
    const badGateway = { status: 502, contentType: 'text/plain', body: 'Bad gateway' }

    await test.step('the invitation read answers 502: "Can’t reach Lobby", and Try again loads it', async () => {
      await page.route(preview, (route) => route.fulfill(badGateway))
      await page.goto(link)
      await expect(unreachable).toBeVisible()
      await expect(unreachable.getByRole('heading')).toHaveText("Can't reach Lobby")
      await expect(unreachable).toContainText('Lobby had a problem handling that. Try again in a moment.')
      await expect(page.getByTestId('invite-invalid')).toHaveCount(0)
      await capture('domain-access-invite-unreachable.png', page, testInfo)
      await page.unroute(preview)
      await retry.click()
      await expect(page.getByTestId('invite-accept')).toBeVisible()
      await expect(unreachable).toHaveCount(0)
    })

    await test.step('the connection drops while the session is read: not the signed-out "Sign in or create an account with …"', async () => {
      await page.route('**/api/auth/me', (route) => route.abort('connectionreset'))
      await page.reload()
      await expect(unreachable).toBeVisible()
      await expect(page.getByTestId('invite-signin')).toHaveCount(0)
      await expect(page.getByTestId('invite-page')).toHaveCount(0)
      await page.unroute('**/api/auth/me')
      await retry.click()
      await expect(page.getByTestId('invite-accept')).toBeVisible()
    })

    await test.step('the session re-read after a 403 mismatch fails: "Can’t reach Lobby"; Try again shows the mismatch', async () => {
      const accept = `**/api/invitations/${token}/accept`
      let refused = false
      await page.route(accept, (route) => {
        refused = true
        return route.fulfill({
          status: 403,
          json: {
            error: {
              code: 'INVITATION_EMAIL_MISMATCH',
              message: 'This invitation is for i•••@client.example.test.',
            },
            mismatch: { invitedEmailHint: 'i•••@client.example.test', invitedBy: { name: 'Alice Park' } },
          },
        })
      })
      for (const path of ['**/api/auth/me', '**/api/me'])
        await page.route(path, (route) => (refused ? route.fulfill(badGateway) : route.continue()))
      await page.getByTestId('invite-accept').click()
      await expect(unreachable).toBeVisible()
      await expect(page.getByTestId('invite-signin')).toHaveCount(0)
      await expect(page.getByTestId('invite-email-mismatch')).toHaveCount(0)
      await page.unroute('**/api/auth/me')
      await page.unroute('**/api/me')
      await retry.click()
      const mismatch = page.getByTestId('invite-email-mismatch')
      await expect(mismatch).toContainText('This invitation was sent to i•••@client.example.test.')
      await expect(mismatch).toContainText(`You're signed in as ${email}.`)
      await page.unroute(accept)
    })

    // Nothing was redeemed on the way: the real accept still works.
    expect(await invitations(aliceApi, board)).toContainEqual(
      expect.objectContaining({ kind: 'invite', email, uses: 0 }),
    )
    await page.reload()
    await page.getByTestId('invite-accept').click()
    await expect(page).toHaveURL(new RegExp(`/b/${board}$`), { timeout: 30_000 })
    await waitForLobbyBoard(page)
  } finally {
    await ivo.context.close()
  }
})

test('fixer round 3: a creator typing her own address in Invite people or Link for one person is told at once, and no link is made', async ({
  users,
  board,
  canvasSession,
}) => {
  const aliceApi = await users.api('alice')
  const own = (await aliceApi.me()).access?.email ?? ''
  expect(own).toBe('alice@dev.invalid')
  const a = await canvasSession('alice')
  await openShareFromButton(a.page)
  const dialog = shareDialog(a.page)

  await test.step('Invite people: the hint says so while typing; Create invite link makes nothing', async () => {
    const input = dialog.getByTestId('share-invite-input')
    await input.fill(` ${own.toUpperCase()}`)
    await expect(dialog.getByTestId('share-invite-hint')).toHaveText(OWN_ADDRESS)
    await dialog.getByTestId('share-invite-submit').click()
    await expect(dialog.getByTestId('share-invite-notice')).toHaveText(OWN_ADDRESS)
    await expect(dialog.getByTestId('share-invite-notice')).toHaveAttribute('role', 'alert')
    // Fixer round 4 (§22): said once: the alert replaces the hint's copy of the sentence.
    await expect(dialog.getByTestId('share-invite-hint')).toHaveText('')
    await expect(dialog.getByText(OWN_ADDRESS, { exact: true })).toHaveCount(1)
    await expect(dialog.getByTestId('share-invite-link')).toHaveCount(0)
    // Typing again clears the alert, and the hint says it again (once).
    await input.fill(own)
    await expect(dialog.getByTestId('share-invite-notice')).toHaveCount(0)
    await expect(dialog.getByTestId('share-invite-hint')).toHaveText(OWN_ADDRESS)
    await expect(dialog.getByText(OWN_ADDRESS, { exact: true })).toHaveCount(1)
    // Someone else's address: the usual hint again.
    await input.fill('pat@client.example.test')
    await expect(dialog.getByTestId('share-invite-hint')).toContainText('only this address can use')
    await input.fill('')
  })

  await test.step('Link for one person: the field error says so while typing; Create invite link makes nothing', async () => {
    await openMoreWaysToShare(a.page)
    await dialog.getByTestId('one-person-link-email').fill(own)
    await expect(dialog.getByTestId('one-person-link-error')).toHaveText(OWN_ADDRESS)
    await dialog.getByTestId('invite-create').click()
    await expect(dialog.getByTestId('one-person-link-error')).toHaveText(OWN_ADDRESS)
    await expect(dialog.getByTestId('invite-link')).toHaveCount(0)
  })

  expect(await invitations(aliceApi, board)).toEqual([])
  // The api refuses it too (any of her verified addresses), with the same words.
  const refused = await aliceApi.fetch('POST', `/api/boards/${board}/invitations`, {
    role: 'viewer',
    email: own,
  })
  expect(refused.status()).toBe(409)
  expect(await errorCode(refused)).toBe('INVITATION_TO_SELF')
  expect(await invitations(aliceApi, board)).toEqual([])
})

test('fixer round 3: an invitation to a board in the trash says so and cannot be accepted; after a restore it works again', async ({
  browser,
  users,
  board,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const title = (
    (await (await aliceApi.fetch('GET', `/api/boards/${board}`)).json()) as { board: { title: string } }
  ).board.title
  const email = 'tina@client.example.test'
  const res = await aliceApi.fetch('POST', `/api/boards/${board}/invitations`, { role: 'viewer', email })
  expect(res.status()).toBe(201)
  const link = ((await res.json()) as { url: string }).url
  const token = inviteToken(link)
  const trash = async () =>
    expect((await aliceApi.fetch('POST', `/api/boards/${board}/trash`)).status()).toBe(200)
  const restore = async () =>
    expect((await aliceApi.fetch('POST', `/api/boards/${board}/restore`)).status()).toBe(200)
  await trash()

  const tina = await signedInContext(browser, freshHandle('tina'), { name: 'Tina Invitee', email })
  try {
    const page = tina.page
    const trashed = page.getByTestId('invite-board-trashed')

    await test.step('the invitee: "This board is in the trash", whom to ask, and nothing to accept', async () => {
      await page.goto(link)
      await expect(trashed).toContainText('This board is in the trash')
      await expect(trashed).toHaveAttribute('role', 'status')
      await expect(page.getByTestId('invite-board-trashed-body')).toHaveText(
        `“${title}” is in the trash, so this invitation can’t be used right now. Ask Alice Park to restore it: the link works again once the board is back, until it expires.`,
      )
      await expect(page.getByTestId('invite-title')).toHaveText(`“${title}”`)
      await expect(page.getByTestId('invite-accept')).toHaveCount(0)
      await expect(page.getByTestId('invite-trashed-home')).toBeVisible()
      await capture('domain-access-invite-board-trashed.png', page, testInfo)
      // A forged accept is refused and redeems nothing.
      const forged = await tina.context.request.post(`${WEB_URL}/api/invitations/${token}/accept`, {
        headers: { origin: WEB_URL },
      })
      expect(forged.status()).toBe(409)
      expect(await errorCode(forged)).toBe('BOARD_IN_TRASH')
    })

    await test.step('signed out and as the inviter: the same state, with no sign-in and no "ask yourself"', async () => {
      const anon = await browser.newContext()
      try {
        const p = await anon.newPage()
        await p.goto(link)
        await expect(p.getByTestId('invite-board-trashed')).toBeVisible()
        await expect(p.getByTestId('invite-signin')).toHaveCount(0)
        await expect(p.getByTestId('invite-guest-form')).toHaveCount(0)
      } finally {
        await anon.close()
      }
      const alice = await signedInContext(browser, 'alice')
      try {
        await alice.page.goto(link)
        await expect(alice.page.getByTestId('invite-board-trashed-body')).toHaveText(
          `“${title}” is in the trash, so nobody can use this link right now. Once the board is restored, the link works again until it expires.`,
        )
        await expect(alice.page.getByTestId('invite-own-back')).toHaveCount(0)
      } finally {
        await alice.context.close()
      }
    })

    await test.step('fixer round 4: the wrong account learns whom the link is for, and no "works again" promise', async () => {
      const wesEmail = 'wes@client.example.test'
      const wes = await signedInContext(browser, freshHandle('wes'), { name: 'Wes Wrong', email: wesEmail })
      try {
        await wes.page.goto(link)
        await expect(wes.page.getByTestId('invite-board-trashed')).toContainText('This board is in the trash')
        await expect(wes.page.getByTestId('invite-board-trashed-body')).toHaveText(
          `“${title}” is in the trash. This link is for t•••@client.example.test, so it won’t let you in as ${wesEmail}, even once the board is restored.`,
        )
        await expect(wes.page.getByTestId('invite-board-trashed-body')).not.toContainText('works again')
        await expect(wes.page.getByTestId('invite-accept')).toHaveCount(0)
        await expect(wes.page.getByTestId('invite-trashed-home')).toBeVisible()
      } finally {
        await wes.context.close()
      }
    })

    await test.step('restored: the link is still unused and offers Accept; trashed again before the click: the page says so', async () => {
      await restore()
      expect(await invitations(aliceApi, board)).toEqual([
        expect.objectContaining({ kind: 'invite', email, uses: 0 }),
      ])
      await page.reload()
      await expect(page.getByTestId('invite-title')).toHaveText(`Join “${title}”`)
      await trash()
      await page.getByTestId('invite-accept').click()
      await expect(trashed).toContainText('This board is in the trash')
      await expect(page.getByTestId('invite-accept')).toHaveCount(0)
      await expect(page.getByTestId('invite-error')).toHaveCount(0)
    })

    await test.step('restored again: tina accepts and opens the board as a viewer', async () => {
      await restore()
      await page.reload()
      await page.getByTestId('invite-accept').click()
      await expect(page).toHaveURL(new RegExp(`/b/${board}$`), { timeout: 30_000 })
      await waitForLobbyBoard(page)
      await expect(page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'viewer')
      expect(await invitations(aliceApi, board)).toEqual([])
    })
  } finally {
    await tina.context.close()
  }
})
