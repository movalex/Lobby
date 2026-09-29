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
import { Api, type Me } from './support/api.ts'
import { signInThroughUi, waitForBoard } from './support/board.ts'
import {
  accessRequests,
  freshHandle,
  invitations,
  inviteToken,
  mainCard,
  memberRow,
  menuActions,
  openDashboard,
  openShareFromButton,
  personalWorkspace,
  shareDialog,
  signedInContext,
} from './support/dashboard-share.ts'
import { expect, test } from './support/fixtures.ts'
import { openHistory } from './support/history.ts'
import { WEB_URL } from './support/ports.ts'

const EXCEPTION = 'owner@personal.example.test'
test.use({ apiEnv: { DRAFTROOM_CREATOR_EMAILS: EXCEPTION } })

const CREATOR_REQUIRED = 'CREATOR_REQUIRED'
const SHARE_NOTE =
  'Only people at Dark Burn Creative or Trailer Park Group can invite people, create links or give more access in Lobby. You can still lower or remove access.'
const OUTSIDE_EMPTY =
  'Boards shared with you appear here. Only people at Dark Burn Creative or Trailer Park Group can create boards. Work there? Sign in with your work email.'

/** The error code of a refused API call. */
async function errorCode(res: { json(): Promise<unknown> }): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
  return body?.error?.code ?? null
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
}) => {
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
      await expect(screen.getByTestId('no-workspace-switch')).toHaveText('Sign in with a different account')
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
  session,
}) => {
  const aliceApi = await users.api('alice')
  const a = await session('alice')
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
      await waitForBoard(page)
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
      await waitForBoard(page)
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
        await waitForBoard(p.page)
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
}) => {
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
      await waitForBoard(page)
      await openShareFromButton(page)
      const dialog = shareDialog(page)
      await expect(dialog.getByTestId('share-creator-note')).toHaveText(SHARE_NOTE)
      await expect(dialog.getByTestId('member-list')).toBeVisible()
      for (const id of [
        'share-invite-input',
        'share-add-member',
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

    await test.step('the dashboard: the board can be moved, never duplicated; nothing to create', async () => {
      await openDashboard(page, users.devStudioId)
      await expectNoCreateControls(page)
      const actions = await menuActions(mainCard(page, boardId))
      expect(actions).toContain('move')
      expect(actions).not.toContain('duplicate')
    })
  } finally {
    await own.context.close()
  }
})
