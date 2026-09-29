// The invitation email lock (docs/DOMAIN-ACCESS-CONTRACTS.md §6.1, D2, D3; §11.1 invite-lock.test.ts):
// every single-use invitation names one address, and only an account with that verified address can
// accept it. Multi-use review, workshop and guest links are unchanged.

import {
  InvitationEmailLock,
  InvitationEmailMismatchBody,
  InvitationGuestAccess,
  InvitationPreview,
} from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256hex } from '../../../src/auth/session.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from '../../helpers.ts'
import { type ClerkWorld, clerkError, clerkUser, clerkWorld, fakeClerk } from './clerk-fake.ts'

vi.mock('@clerk/backend', async () => (await import('./clerk-fake.ts')).clerkBackendModule)

const Preview = InvitationPreview.extend(InvitationGuestAccess.shape).extend(InvitationEmailLock.shape)
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)
const code = (res: LightMyRequestResponse) => (res.json() as { error?: { code?: string } }).error?.code
const MIN = 60 * 1000

async function redeemedBy(api: TestApi, token: string) {
  return (
    await api.db.one<{ redeemed_by: string | null }>(
      'SELECT redeemed_by FROM invitations WHERE token_hash = $1',
      [sha256hex(token)],
    )
  ).redeemed_by
}

describe('creating locked invitations (dev provider)', () => {
  let api: TestApi
  let alice: Client
  let board: string
  beforeEach(async () => {
    api = await createTestApi()
    alice = await api.login('alice')
    board = await createBoard(alice, DEV_STUDIO, 'Locked')
  })
  afterEach(() => api.close())

  it('without an email: 400; a +clerk_test or non-ASCII address: 400; nothing is created', async () => {
    const cases: [unknown, string][] = [
      [{ role: 'viewer' }, 'email: Invalid input: expected string, received undefined'],
      [
        { role: 'viewer', email: 'pat+clerk_test@client.example.test' },
        'email: Lobby doesn’t accept Clerk test addresses (+clerk_test).',
      ],
      [
        { role: 'viewer', email: 'Pat+Clerk_Test@client.example.test' },
        'email: Lobby doesn’t accept Clerk test addresses (+clerk_test).',
      ],
      [{ role: 'viewer', email: 'pаt@client.example.test' }, 'email: Enter a valid email address.'],
    ]
    for (const [body, message] of cases) {
      const res = await alice.req('POST', `/api/boards/${board}/invitations`, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(res.json().error.message).toBe(message)
    }
    const ws = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, { role: 'member' })
    expect(ws.statusCode).toBe(400)
    expect((await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM invitations')).n).toBe(0)
  })

  it('stores the address normalised; the audit row says locked and the domain, never the address', async () => {
    const res = await alice.req('POST', `/api/boards/${board}/invitations`, {
      role: 'viewer',
      email: '  Pat@Client.Example.Test ',
    })
    expect(res.statusCode).toBe(201)
    const row = await api.db.one<{ invited_email: string }>('SELECT invited_email FROM invitations')
    expect(row.invited_email).toBe('pat@client.example.test')
    const audit = await api.db.one<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_events WHERE action = 'invitation.create'",
    )
    expect(audit.detail).toEqual({
      boardId: board,
      role: 'viewer',
      emailLocked: true,
      emailDomain: 'client.example.test',
    })
  })

  it('a workspace admin invitation to an outside address is 409; to a creator address it is fine; member and guest for anyone', async () => {
    const outside = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
      role: 'admin',
      email: 'pat@client.example.test',
    })
    expect(outside.statusCode).toBe(409)
    expect(code(outside)).toBe('ROLE_REQUIRES_CREATOR')
    for (const email of ['lobby-test@darkburn.com', devEmail('newcomer')])
      expect(
        (await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, { role: 'admin', email }))
          .statusCode,
      ).toBe(201)
    for (const role of ['member', 'guest'])
      expect(
        (
          await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
            role,
            email: 'pat@client.example.test',
          })
        ).statusCode,
      ).toBe(201)
  })

  it('an unbound single-use invitation (from before the lock) is gone: 410 for preview and accept', async () => {
    const token = 'U'.repeat(43)
    await api.db.query(
      `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, created_at, expires_at)
       VALUES ('inv_Unbound0000000000000', $1, $2, $3, 'editor', $4, now(), now() + interval '1 day')`,
      [sha256hex(token), DEV_STUDIO, board, alice.userId],
    )
    const bob = await api.login('bob')
    expect((await api.anon('GET', `/api/invitations/${token}`)).statusCode).toBe(410)
    const res = await bob.req('POST', `/api/invitations/${token}/accept`)
    expect(res.statusCode).toBe(410)
    expect(code(res)).toBe('GONE')
    expect(await redeemedBy(api, token)).toBeNull()
  })

  it('review, workshop and guest links are unchanged: not locked, any signed-in account may accept (D7)', async () => {
    const outsider = await api.login('pat', 'Pat', { email: 'pat@client.example.test' })
    for (const body of [{ role: 'viewer' }, { role: 'editor' }, { role: 'commenter', allowGuests: true }]) {
      const link = (await alice.req('POST', `/api/boards/${board}/review-links`, body)).json() as {
        url: string
      }
      const token = tokenOf(link.url)
      const preview = Preview.parse((await outsider.req('GET', `/api/invitations/${token}`)).json())
      expect(preview).toMatchObject({ emailLocked: false, invitedEmailHint: null, matchesYou: null })
      // Not locked: never "sent by you", not even for the creator of the link.
      const own = Preview.parse((await alice.req('GET', `/api/invitations/${token}`)).json())
      expect(own.sentByYou).toBe(false)
      expect((await outsider.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
      const anon = Preview.parse((await api.anon('GET', `/api/invitations/${token}`)).json())
      expect(anon.allowGuests).toBe(body.allowGuests === true)
      if (body.allowGuests) {
        const joined = await api.anon('POST', `/api/invitations/${token}/guest`, { name: 'Gia' })
        expect(joined.statusCode).toBe(201)
      }
    }
  })

  it('the email route with the dev provider: the link is locked to the address (email_not_configured)', async () => {
    const res = await alice.req('POST', `/api/boards/${board}/invitations/email`, {
      role: 'viewer',
      email: 'Pat@Client.Example.Test',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ mode: 'link', reason: 'email_not_configured' })
    const row = await api.db.one<{ invited_email: string }>('SELECT invited_email FROM invitations')
    expect(row.invited_email).toBe('pat@client.example.test')
  })

  it('a workspace admin invitation stops working when the invitee is no longer a creator (exception removed)', async () => {
    const withException = await createTestApi({
      env: { DRAFTROOM_CREATOR_EMAILS: 'owner@personal.example.test' },
    })
    try {
      const owner = await withException.login('alice')
      const created = await owner.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
        role: 'admin',
        email: 'owner@personal.example.test',
      })
      expect(created.statusCode).toBe(201)
      const token = tokenOf(created.json().url)
      // The same database, served again without the exception.
      const without = await createTestApi({ db: withException.db })
      try {
        const invitee = await without.login('owner', 'Owner', { email: 'owner@personal.example.test' })
        expect(invitee.me.access.reason).toBe('outside')
        const res = await invitee.req('POST', `/api/invitations/${token}/accept`)
        expect(res.statusCode).toBe(409)
        expect(code(res)).toBe('ROLE_REQUIRES_CREATOR')
        expect(await redeemedBy(without, token)).toBeNull()
      } finally {
        await without.close()
      }
    } finally {
      await withException.close()
    }
  })
})

describe('accepting locked invitations (Clerk)', () => {
  let w: ClerkWorld
  let alice: Client
  let board: string
  beforeEach(async () => {
    fakeClerk.reset()
    w = await clerkWorld()
    clerkUser('user_alice', ['lobby-test-alice@darkburn.com'], { name: 'Alice' })
    alice = await w.signIn('user_alice')
    board = await createBoard(alice, alice.personalWorkspaceId, 'Pitch')
  })
  afterEach(() => w.api.close())

  async function invite(email = 'pat@client.example.test', role = 'editor') {
    const res = await alice.req('POST', `/api/boards/${board}/invitations`, { role, email })
    expect(res.statusCode, res.body).toBe(201)
    return tokenOf(res.json().url)
  }
  const preview = async (token: string, c?: Client) =>
    Preview.parse(
      (c
        ? await c.req('GET', `/api/invitations/${token}`)
        : await w.api.anon('GET', `/api/invitations/${token}`)
      ).json(),
    )

  it('the preview says it is locked, with a masked hint and matchesYou (null signed out, true/false signed in)', async () => {
    const token = await invite('Pat.Doe@Client.Example.Test')
    expect(await preview(token)).toMatchObject({
      emailLocked: true,
      invitedEmailHint: 'p•••@client.example.test',
      matchesYou: null,
    })
    clerkUser('user_pat', ['pat.doe@client.example.test'])
    clerkUser('user_sam', ['sam@client.example.test'])
    expect((await preview(token, await w.signIn('user_pat'))).matchesYou).toBe(true)
    expect((await preview(token, await w.signIn('user_sam'))).matchesYou).toBe(false)
    expect((await preview(token, alice)).matchesYou).toBe(false)
    // sentByYou: only the inviter who created this locked link, never anyone else (or signed out).
    expect((await preview(token, alice)).sentByYou).toBe(true)
    expect((await preview(token, await w.signIn('user_sam'))).sentByYou).toBe(false)
    expect((await preview(token)).sentByYou).toBe(false)
    // The full address never appears in the preview.
    expect(JSON.stringify(await preview(token))).not.toContain('pat.doe')
  })

  it('a wrong account gets 403 with a masked body; nothing is redeemed and the link stays usable for the invitee', async () => {
    const token = await invite()
    clerkUser('user_sam', ['sam@client.example.test'])
    const sam = await w.signIn('user_sam')
    const res = await sam.req('POST', `/api/invitations/${token}/accept`)
    expect(res.statusCode).toBe(403)
    expect(InvitationEmailMismatchBody.parse(res.json())).toEqual({
      error: {
        code: 'INVITATION_EMAIL_MISMATCH',
        message:
          'This invitation is for p•••@client.example.test. Sign in with that email address to accept it.',
      },
      mismatch: { invitedEmailHint: 'p•••@client.example.test', invitedBy: { name: 'Alice' } },
    })
    expect(res.body).not.toContain('pat@')
    expect(await redeemedBy(w.api, token)).toBeNull()
    expect((await sam.req('GET', `/api/boards/${board}`)).statusCode).toBe(404)
    // The invitee (case does not matter: both sides are normalised) accepts.
    clerkUser('user_pat', ['PAT@client.example.test'])
    const pat = await w.signIn('user_pat')
    expect((await pat.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    expect((await pat.req('GET', `/api/boards/${board}`)).json().role).toBe('editor')
    const accepted = await w.api.db.one<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_events WHERE action = 'invitation.accept'",
    )
    expect(accepted.detail).toMatchObject({ emailLocked: true })
    // Used: anyone else now gets 410 (no hint).
    const gone = await sam.req('POST', `/api/invitations/${token}/accept`)
    expect(gone.statusCode).toBe(410)
    expect(gone.body).not.toContain('•••')
  })

  it('a verified SECONDARY address of the account matches', async () => {
    const token = await invite('pat@client.example.test')
    clerkUser('user_pat', ['pat.home@personal.example.test', 'pat@client.example.test'])
    const pat = await w.signIn('user_pat')
    expect((await pat.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
  })

  it.each([
    ['unverified', [{ email: 'pat@client.example.test', status: 'unverified' }]],
    ['only a +clerk_test variant', ['pat+clerk_test@client.example.test']],
  ])('an %s address does not match', async (_what, emails) => {
    const token = await invite('pat@client.example.test')
    clerkUser('user_pat', ['other@client.example.test', ...emails])
    const pat = await w.signIn('user_pat')
    const res = await pat.req('POST', `/api/invitations/${token}/accept`)
    expect(res.statusCode).toBe(403)
    expect(code(res)).toBe('INVITATION_EMAIL_MISMATCH')
    expect(await redeemedBy(w.api, token)).toBeNull()
  })

  it('a stale identity (older than 5 minutes) is refreshed before accepting', async () => {
    const token = await invite('pat@client.example.test')
    clerkUser('user_pat', ['old@client.example.test'])
    const pat = await w.signIn('user_pat')
    // Pat adds and verifies the invited address in Clerk after signing in.
    clerkUser('user_pat', ['old@client.example.test', 'pat@client.example.test'])
    fakeClerk.calls = []
    w.api.clock.advance(10 * MIN)
    expect((await pat.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    expect(fakeClerk.calls).toEqual(['user_pat'])
    // Fresh enough within 5 minutes: no call.
    const second = await invite('pat@client.example.test', 'viewer')
    fakeClerk.calls = []
    expect((await pat.req('POST', `/api/invitations/${second}/accept`)).statusCode).toBe(200)
    expect(fakeClerk.calls).toEqual([])
  })

  it('Clerk down at accept: 503 IDENTITY_UNAVAILABLE and nothing redeemed; it works once Clerk answers', async () => {
    const token = await invite('pat@client.example.test')
    clerkUser('user_pat', ['pat@client.example.test'])
    const pat = await w.signIn('user_pat')
    w.api.clock.advance(10 * MIN)
    fakeClerk.failures.set('user_pat', () => clerkError(503, 'service_unavailable'))
    const res = await pat.req('POST', `/api/invitations/${token}/accept`)
    expect(res.statusCode).toBe(503)
    expect(code(res)).toBe('IDENTITY_UNAVAILABLE')
    expect(await redeemedBy(w.api, token)).toBeNull()
    fakeClerk.failures.clear()
    w.api.clock.advance(61_000) // past the failure backoff
    expect((await pat.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
  })

  it('the email route: emailed and existing_account links are locked; granted is unchanged', async () => {
    const send = (email: string) =>
      alice.req('POST', `/api/boards/${board}/invitations/email`, { role: 'commenter', email })
    // A new person: Clerk emails a locked link.
    const emailed = await send('New@Client.Example.Test')
    expect(emailed.json()).toMatchObject({ mode: 'emailed' })
    expect(fakeClerk.invitations).toHaveLength(1)
    // A Clerk account that never opened Lobby: the inviter gets a locked link.
    clerkUser('user_zoe', ['zoe@client.example.test'])
    const existing = await send('zoe@client.example.test')
    expect(existing.json()).toMatchObject({ mode: 'link', reason: 'existing_account' })
    const rows = await w.api.db.query<{ invited_email: string }>(
      'SELECT invited_email FROM invitations ORDER BY created_at, id',
    )
    expect(rows.rows.map((r) => r.invited_email)).toEqual([
      'new@client.example.test',
      'zoe@client.example.test',
    ])
    // Someone who already uses Lobby with that verified address: granted at once (no invitation).
    clerkUser('user_kim', ['kim@client.example.test'])
    const kim = await w.signIn('user_kim')
    const granted = await send('kim@client.example.test')
    expect(granted.json()).toMatchObject({ mode: 'granted', user: { id: kim.userId } })
    expect((await kim.req('GET', `/api/boards/${board}`)).json().role).toBe('commenter')
    // The existing_account link works for zoe once she signs in, and for nobody else.
    const zoeToken = tokenOf(existing.json().url)
    expect((await kim.req('POST', `/api/invitations/${zoeToken}/accept`)).statusCode).toBe(403)
    const zoe = await w.signIn('user_zoe')
    expect((await zoe.req('POST', `/api/invitations/${zoeToken}/accept`)).statusCode).toBe(200)
  })
})
