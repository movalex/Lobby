// Invite by email (POST /api/boards/:bid/invitations/email). The Clerk Backend API is a fake: the
// `@clerk/backend` module is replaced below (no network), so the real adapter code in
// features/dashboard/clerk-directory.ts runs against it. Clerk errors are the SDK's own
// ClerkAPIResponseError class (from '@clerk/backend/errors', which is not replaced).

import { ClerkAPIResponseError } from '@clerk/backend/errors'
import {
  BoardDetail,
  EmailInviteResult,
  InvitationAccepted,
  InvitationPreview,
  ListInvitationsResponse,
  Me,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClerkAuthProvider } from '../../../src/auth/clerk.ts'
import { EventHub } from '../../../src/events/hub.ts'
import { EMAIL_INVITE_USER_LIMIT } from '../../../src/features/dashboard/email-invites.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../../helpers.ts'
import { boardRole, setupWorld, tokenOf, type World } from './setup.ts'

// ---- the fake Clerk Backend API ------------------------------------------------------------------

interface FakeClerkUser {
  id: string
  emailAddresses: { emailAddress: string; verification: { status: string } | null }[]
}

const clerk = vi.hoisted(() => ({
  users: [] as FakeClerkUser[],
  lookupError: null as unknown,
  inviteError: null as unknown,
  clients: [] as unknown[],
  lookups: [] as unknown[],
  invitations: [] as Record<string, unknown>[],
  reset() {
    this.users = []
    this.lookupError = null
    this.inviteError = null
    this.clients = []
    this.lookups = []
    this.invitations = []
  },
}))

vi.mock('@clerk/backend', () => ({
  createClerkClient: (options: unknown) => {
    clerk.clients.push(options)
    return {
      users: {
        // Like Clerk: exact (case-insensitive) address filter, verified or not.
        getUserList: async (params: { emailAddress?: string[]; limit?: number }) => {
          clerk.lookups.push(params)
          if (clerk.lookupError) throw clerk.lookupError
          const wanted = new Set((params.emailAddress ?? []).map((e) => e.toLowerCase()))
          const data = clerk.users.filter((u) =>
            u.emailAddresses.some((a) => wanted.has(a.emailAddress.toLowerCase())),
          )
          return { data, totalCount: data.length }
        },
      },
      invitations: {
        createInvitation: async (params: Record<string, unknown>) => {
          clerk.invitations.push(params)
          if (clerk.inviteError) throw clerk.inviteError
          return { id: 'inv_clerk_fake', emailAddress: params.emailAddress, status: 'pending' }
        },
      },
    }
  },
}))

const verified = (id: string, email: string): FakeClerkUser => ({
  id,
  emailAddresses: [{ emailAddress: email, verification: { status: 'verified' } }],
})

const clerkError = (status: number, code: string, paramName?: string, message = 'Clerk says no') =>
  new ClerkAPIResponseError(message, {
    status,
    clerkTraceId: 'trace-123',
    data: [
      { code, message, long_message: `${message} (long)`, meta: paramName ? { param_name: paramName } : {} },
    ],
  })

const INVITE_URL = new RegExp(`^${ORIGIN}/invite/[A-Za-z0-9_-]{43}$`)
const emailRoute = (boardId: string) => `/api/boards/${boardId}/invitations/email`

beforeEach(() => clerk.reset())

// ---- a Clerk-provider API (sign-in through the Clerk exchange with a fake token verifier) ---------

const CLERK_KEYS = { secretKey: 'sk_test_fake_secret_0123456789', publishableKey: 'pk_test_fake' }
const PEOPLE = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'] as const
type Person = (typeof PEOPLE)[number]
const clerkIdOf = (p: Person) => `user_clerk_${p}`
/**
 * Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §11.3): each person's verified sign-in address.
 * alice works at a creator domain; everyone else is a client.
 */
const clerkEmailOf = (p: Person) =>
  p === 'alice' ? 'lobby-test-alice@darkburn.com' : `${p}@client.example.test`

interface ClerkWorld {
  api: TestApi
  events: EventHub
  logs: string[]
  signIn(p: Person): Promise<Client>
}

async function clerkWorld(): Promise<ClerkWorld> {
  const events = new EventHub()
  const logs: string[] = []
  const api = await createTestApi({
    env: {
      AUTH_PROVIDER: 'clerk',
      CLERK_SECRET_KEY: CLERK_KEYS.secretKey,
      CLERK_PUBLISHABLE_KEY: CLERK_KEYS.publishableKey,
    },
    deps: {
      events,
      logger: { level: 'info', stream: { write: (line: string) => void logs.push(line) } },
      authProvider: createClerkAuthProvider({
        ...CLERK_KEYS,
        publicOrigin: ORIGIN,
        deps: {
          verify: async (token) => {
            const p = PEOPLE.find((x) => token === `token-${x}`)
            if (!p) throw new Error('invalid')
            return { sub: clerkIdOf(p) }
          },
          profile: async (sub) => {
            const p = sub.replace('user_clerk_', '') as Person
            return {
              name: p.charAt(0).toUpperCase() + p.slice(1),
              avatarUrl: null,
              emails: [{ email: clerkEmailOf(p), isPrimary: true, strategy: 'email_code' }],
            }
          },
        },
      }),
    },
  })
  const signIn = async (p: Person): Promise<Client> => {
    const res = await api.anon('POST', '/api/auth/clerk/session', undefined, {
      authorization: `Bearer token-${p}`,
    })
    if (res.statusCode !== 200) throw new Error(`clerk sign-in ${p}: ${res.statusCode} ${res.body}`)
    const cookie = res.cookies.find((c) => c.name === 'dr_session')
    if (!cookie) throw new Error('no session cookie')
    const me = Me.parse(res.json())
    const personal = me.workspaces.find((w) => w.role === 'owner')
    return {
      me,
      userId: me.user.id,
      personalWorkspaceId: personal?.id ?? '',
      cookie: `dr_session=${cookie.value}`,
      req: (method, url, body, headers = {}) =>
        api.app.inject({
          method,
          url,
          ...(body === undefined ? {} : { payload: body as object }),
          headers: { origin: ORIGIN, cookie: `dr_session=${cookie.value}`, ...headers },
        }),
    }
  }
  return { api, events, logs, signIn }
}

async function sendInvite(c: Client, boardId: string, email: string, role = 'commenter') {
  const res = await c.req('POST', emailRoute(boardId), { email, role })
  return { res, body: res.statusCode < 300 ? EmailInviteResult.parse(res.json()) : null }
}

async function countRows(api: TestApi, sql: string, params: unknown[] = []): Promise<number> {
  return (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).n
}

describe('invite by email with Clerk sign-in (UNVERIFIED against a live Clerk; fake Backend API)', () => {
  let w: ClerkWorld
  let alice: Client
  let board: string
  let published: { type: string; data: unknown }[]

  beforeEach(async () => {
    w = await clerkWorld()
    alice = await w.signIn('alice')
    board = await createBoard(alice, alice.personalWorkspaceId, 'Launch plan')
    published = []
    // What an open board stream receives.
    w.events.subscribe(board, (e) => published.push({ type: e.type, data: e.data }))
  })
  afterEach(() => w.api.close())

  it('someone who already uses Draftroom gets the role at once (guest, audit, sync push), never lowered', async () => {
    const bob = await w.signIn('bob') // has a Draftroom identity: clerk + user_clerk_bob
    clerk.users = [verified(clerkIdOf('bob'), 'bob@example.com')]
    const before = w.api.notifications.length

    const { res, body } = await sendInvite(alice, board, '  Bob@Example.COM ', 'commenter')
    expect(res.statusCode, res.body).toBe(200)
    expect(body).toEqual({
      mode: 'granted',
      user: expect.objectContaining({ id: bob.userId, name: 'Bob' }),
      role: 'commenter',
      alreadyHadAccess: false,
    })
    // One lookup with the normalized address; no invitation email, no invitation row.
    expect(clerk.lookups).toEqual([{ emailAddress: ['bob@example.com'], limit: 10 }])
    expect(clerk.clients).toEqual([
      { secretKey: CLERK_KEYS.secretKey, publishableKey: CLERK_KEYS.publishableKey },
    ])
    expect(clerk.invitations).toEqual([])
    expect(await countRows(w.api, 'invitations WHERE board_id = $1', [board])).toBe(0)

    expect(await boardRole(bob, board)).toBe('commenter')
    const me = Me.parse((await bob.req('GET', '/api/me')).json())
    expect(me.workspaces).toContainEqual(
      expect.objectContaining({ id: alice.personalWorkspaceId, role: 'guest' }),
    )
    expect(w.api.notifications.slice(before)).toEqual([{ boardId: board, userId: bob.userId }])
    expect(published).toEqual([{ type: 'sharing.changed', data: { reason: 'grant' } }])
    const audits = await w.api.db.query<{
      action: string
      actor_id: string
      detail: Record<string, unknown>
    }>("SELECT action, actor_id, detail FROM audit_events WHERE action = 'board.member.put' ORDER BY id")
    expect(audits.rows).toEqual([
      {
        action: 'board.member.put',
        actor_id: alice.userId,
        detail: { userId: bob.userId, role: 'commenter', previousRole: null, via: 'email_invite' },
      },
    ])

    // Inviting again with a lower role changes nothing; a higher one raises the grant.
    const again = await sendInvite(alice, board, 'bob@example.com', 'viewer')
    expect(again.body).toMatchObject({ mode: 'granted', role: 'commenter', alreadyHadAccess: true })
    expect(w.api.notifications.slice(before)).toHaveLength(1)
    expect(await boardRole(bob, board)).toBe('commenter')
    const raised = await sendInvite(alice, board, 'bob@example.com', 'editor')
    expect(raised.body).toMatchObject({ mode: 'granted', role: 'editor', alreadyHadAccess: false })
    expect(await boardRole(bob, board)).toBe('editor')
    expect(w.api.notifications.slice(before)).toHaveLength(2)
  })

  it('a new person gets a single-use invitation emailed by Clerk (right redirect URL); nothing is granted until they accept, once', async () => {
    const { res, body } = await sendInvite(alice, board, 'New.Person@Example.org', 'viewer')
    expect(res.statusCode, res.body).toBe(201)
    expect(body).toEqual({
      mode: 'emailed',
      email: 'new.person@example.org',
      invitationId: expect.stringMatching(/^inv_/),
      expiresAt: expect.any(String),
    })
    // The link travels only in the email: the inviter's response does not carry it.
    expect(res.body).not.toContain('/invite/')
    expect(clerk.invitations).toEqual([
      {
        emailAddress: 'new.person@example.org',
        redirectUrl: expect.stringMatching(INVITE_URL),
        notify: true,
        ignoreExisting: true,
        expiresInDays: 7,
      },
    ])
    const inv = await w.api.db.one<{
      id: string
      role: string
      multi_use: boolean
      redeemed_by: string | null
    }>('SELECT id, role, multi_use, redeemed_by FROM invitations WHERE board_id = $1', [board])
    expect(inv).toEqual({
      id: body?.mode === 'emailed' ? body.invitationId : '',
      role: 'viewer',
      multi_use: false,
      redeemed_by: null,
    })
    const created = await w.api.db.one<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_events WHERE action = 'invitation.create'",
    )
    expect(created.detail).toEqual({ boardId: board, role: 'viewer', via: 'email' })
    expect(await countRows(w.api, 'board_members WHERE board_id = $1', [board])).toBe(1) // alice only
    const expiresAt = body?.mode === 'emailed' ? body.expiresAt : ''
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000)

    // The owner sees it among the pending single-use links (and can revoke it there).
    const pending = ListInvitationsResponse.parse(
      (await alice.req('GET', `/api/boards/${board}/invitations`)).json(),
    )
    expect(pending.invitations).toEqual([
      expect.objectContaining({ id: inv.id, kind: 'invite', role: 'viewer', url: null }),
    ])

    // The emailed link: public preview, accepted with the accepting person's own session.
    const token = tokenOf(String(clerk.invitations[0]?.redirectUrl))
    const preview = InvitationPreview.parse((await w.api.anon('GET', `/api/invitations/${token}`)).json())
    expect(preview).toMatchObject({ board: { id: board, title: 'Launch plan' }, role: 'viewer' })
    expect((await w.api.anon('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(401)
    const erin = await w.signIn('erin') // signs up through the email, then signs in to Draftroom
    const before = w.api.notifications.length
    const accepted = await erin.req('POST', `/api/invitations/${token}/accept`)
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(InvitationAccepted.parse(accepted.json())).toEqual({
      workspaceId: alice.personalWorkspaceId,
      boardId: board,
    })
    expect(BoardDetail.parse((await erin.req('GET', `/api/boards/${board}`)).json()).role).toBe('viewer')
    const erinMe = Me.parse((await erin.req('GET', '/api/me')).json())
    expect(erinMe.workspaces).toContainEqual(
      expect.objectContaining({ id: alice.personalWorkspaceId, role: 'guest' }),
    )
    // Only once: again for erin is a no-op, anyone else gets 410.
    expect((await erin.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    const frank = await w.signIn('frank')
    expect((await frank.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(410)
    expect(await boardRole(frank, board)).toBeNull()
    expect(w.api.notifications.slice(before)).toEqual([{ boardId: board, userId: erin.userId }])
    expect(await countRows(w.api, "audit_events WHERE action = 'invitation.accept'")).toBe(1)
  })

  it('an unverified address of an account counts as a new person (only verified addresses prove it is theirs)', async () => {
    await w.signIn('bob')
    clerk.users = [
      {
        id: clerkIdOf('bob'),
        emailAddresses: [{ emailAddress: 'maybe@example.com', verification: { status: 'unverified' } }],
      },
    ]
    const { body } = await sendInvite(alice, board, 'maybe@example.com')
    expect(body?.mode).toBe('emailed')
    expect(clerk.invitations).toHaveLength(1)
  })

  it('a Clerk account that never opened Draftroom gets no Clerk email: the inviter gets the link', async () => {
    clerk.users = [verified('user_clerk_zoe', 'zoe@example.com')]
    const { res, body } = await sendInvite(alice, board, 'zoe@example.com', 'editor')
    expect(res.statusCode).toBe(201)
    expect(body).toEqual({
      mode: 'link',
      reason: 'existing_account',
      email: 'zoe@example.com',
      invitationId: expect.stringMatching(/^inv_/),
      url: expect.stringMatching(INVITE_URL),
      expiresAt: expect.any(String),
    })
    expect(clerk.invitations).toEqual([])
    // The link is a normal invitation link.
    const token = tokenOf(body?.mode === 'link' ? body.url : '')
    expect((await w.api.anon('GET', `/api/invitations/${token}`)).statusCode).toBe(200)
  })

  it.each([
    [
      'an invalid address',
      () => clerkError(422, 'form_param_format_invalid', 'email_address', 'x@y is invalid'),
      'invalid_email',
    ],
    [
      'a rate limit',
      () => clerkError(429, 'too_many_requests', undefined, 'Too many requests'),
      'rate_limited',
    ],
    [
      'an existing account',
      () => clerkError(422, 'form_identifier_exists', 'email_address', 'That email address is taken'),
      'existing_account',
    ],
    ['a server error', () => clerkError(500, 'internal_clerk_error', undefined, 'boom'), 'provider_error'],
    ['a network failure', () => new TypeError(`fetch failed (${CLERK_KEYS.secretKey})`), 'provider_error'],
  ])(
    'Clerk refusing the invitation (%s) falls back to the link, without Clerk internals',
    async (_name, error, reason) => {
      clerk.inviteError = error()
      const { res, body } = await sendInvite(alice, board, 'pat@client.example')
      expect(res.statusCode, res.body).toBe(201)
      expect(body).toMatchObject({ mode: 'link', reason, url: expect.stringMatching(INVITE_URL) })
      for (const secret of [
        'Clerk says no',
        'is invalid',
        'taken',
        'boom',
        'trace-123',
        'form_',
        'too_many',
        'fetch failed',
        CLERK_KEYS.secretKey,
      ])
        expect(res.body).not.toContain(secret)
      expect(clerk.invitations).toHaveLength(1)
      // The link still works: the invitation row was created before Clerk was asked.
      const token = tokenOf(body?.mode === 'link' ? body.url : '')
      expect((await w.api.anon('GET', `/api/invitations/${token}`)).statusCode).toBe(200)
    },
  )

  it('a failed lookup sends no email (it cannot tell a new person from an existing one): link instead', async () => {
    clerk.lookupError = clerkError(503, 'service_unavailable')
    const { body } = await sendInvite(alice, board, 'pat@client.example')
    expect(body).toMatchObject({ mode: 'link', reason: 'provider_error' })
    expect(clerk.invitations).toEqual([])
  })

  it('logs carry the address domain and a keyed hash, never the address', async () => {
    await w.signIn('bob')
    clerk.users = [verified(clerkIdOf('bob'), 'bob.private@example.com')]
    await sendInvite(alice, board, 'bob.private@example.com')
    await sendInvite(alice, board, 'secret.person@example.org')
    clerk.inviteError = clerkError(
      422,
      'form_param_format_invalid',
      'email_address',
      'secret.two@example.org is invalid',
    )
    await sendInvite(alice, board, 'secret.two@example.org')
    const all = w.logs.join('\n').toLowerCase()
    for (const address of ['bob.private', 'secret.person', 'secret.two']) expect(all).not.toContain(address)
    const lines = w.logs.map((l) => JSON.parse(l) as Record<string, unknown>)
    const invites = lines.filter((l) => l.msg === 'board email invitation')
    expect(invites.map((l) => [l.mode, l.emailDomain])).toEqual([
      ['granted', 'example.com'],
      ['emailed', 'example.org'],
    ])
    const refused = lines.find((l) => l.msg === 'clerk invitation not sent')
    expect(refused).toMatchObject({
      reason: 'invalid_email',
      status: 422,
      codes: ['form_param_format_invalid'],
      traceId: 'trace-123',
    })
    expect(String(invites[0]?.emailRef)).toMatch(/^[0-9a-f]{12}$/)
  })

  it('editors without manage_access get 403, people outside the board 404, and neither reaches Clerk', async () => {
    const carol = await w.signIn('carol')
    clerk.users = [verified(clerkIdOf('carol'), 'carol@example.com')]
    expect((await sendInvite(alice, board, 'carol@example.com', 'editor')).body?.mode).toBe('granted')
    clerk.reset()
    const dave = await w.signIn('dave') // another workspace, no access to this board
    const asEditor = await sendInvite(carol, board, 'someone@example.com')
    expect(asEditor.res.statusCode).toBe(403)
    const asOutsider = await sendInvite(dave, board, 'someone@example.com')
    expect(asOutsider.res.statusCode).toBe(404)
    expect(clerk.lookups).toEqual([])
    expect(clerk.invitations).toEqual([])
    expect(await countRows(w.api, 'invitations')).toBe(0)
  })
})

// ---- development sign-in: never emails, always a link --------------------------------------------

describe('invite by email with the development sign-in provider', () => {
  let world: World
  beforeEach(async () => {
    world = await setupWorld()
  })
  afterEach(() => world.api.close())

  it('answers a single-use link to copy (email needs Clerk) and never loads the Clerk client', async () => {
    const { bob, board, erin, frank, api } = world
    const { res, body } = await sendInvite(bob, board, 'Sam@Client.example', 'editor')
    expect(res.statusCode, res.body).toBe(201)
    expect(body).toEqual({
      mode: 'link',
      reason: 'email_not_configured',
      email: 'sam@client.example',
      invitationId: expect.stringMatching(/^inv_/),
      url: expect.stringMatching(INVITE_URL),
      expiresAt: expect.any(String),
    })
    expect(clerk.clients).toEqual([])
    expect(world.published).toContainEqual({
      boardId: board,
      type: 'sharing.changed',
      data: { reason: 'invitation' },
    })
    const pending = ListInvitationsResponse.parse(
      (await bob.req('GET', `/api/boards/${board}/invitations`)).json(),
    )
    expect(pending.invitations).toEqual([
      expect.objectContaining({ kind: 'invite', role: 'editor', uses: 0 }),
    ])

    // Accepting grants exactly that role, as a guest, and only once.
    const token = tokenOf(body?.mode === 'link' ? body.url : '')
    expect((await erin.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    expect(await boardRole(erin, board)).toBe('editor')
    const me = Me.parse((await erin.req('GET', '/api/me')).json())
    expect(me.workspaces).toContainEqual(expect.objectContaining({ id: DEV_STUDIO, role: 'guest' }))
    expect((await frank.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(410)
    expect(await boardRole(frank, board)).toBeNull()
    expect(api.notifications.filter((n) => n.boardId === board)).toEqual([
      { boardId: board, userId: erin.userId },
    ])
  })

  it('checks permissions like every board route: 401, 404 (no access, other workspace, bad id, trashed), 403 (no manage_access), Origin', async () => {
    const { api, alice, bob, carol, erin, board } = world
    expect(
      (await api.anon('POST', emailRoute(board), { email: 'a@b.example', role: 'viewer' })).statusCode,
    ).toBe(401)
    expect((await sendInvite(carol, board, 'a@b.example')).res.statusCode).toBe(404) // member without access
    expect((await sendInvite(erin, board, 'a@b.example')).res.statusCode).toBe(404) // other workspace
    expect((await sendInvite(bob, 'not a board', 'a@b.example')).res.statusCode).toBe(404)
    const other = await createBoard(erin, erin.personalWorkspaceId, 'Erin only')
    expect((await sendInvite(bob, other, 'a@b.example')).res.statusCode).toBe(404)
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })
    const asEditor = await sendInvite(carol, board, 'a@b.example')
    expect(asEditor.res.statusCode).toBe(403)
    // Mutations must come from the web origin (CSRF, docs/M1-CONTRACTS.md §4).
    const foreign = await bob.req(
      'POST',
      emailRoute(board),
      { email: 'a@b.example', role: 'viewer' },
      { origin: 'https://evil.example' },
    )
    expect(foreign.statusCode).toBe(403)
    // A workspace owner may invite to any board; a trashed board takes no invitations.
    expect((await sendInvite(alice, board, 'a@b.example')).res.statusCode).toBe(201)
    expect((await bob.req('POST', `/api/boards/${board}/trash`)).statusCode).toBe(200)
    expect((await sendInvite(bob, board, 'a@b.example')).res.statusCode).toBe(404)
    expect(await countRows(api, 'invitations WHERE board_id = $1', [board])).toBe(1)
  })

  it('validates the address and the role (never ownership) before anything else', async () => {
    const { bob, board, api } = world
    const cases: [unknown, string][] = [
      [{ email: 'not-an-email', role: 'viewer' }, 'email: Enter a valid email address.'],
      [{ email: '   ', role: 'viewer' }, 'email: Enter an email address.'],
      [{ email: `${'a'.repeat(250)}@b.example`, role: 'viewer' }, 'email: That email address is too long.'],
      [{ email: 'a@b.example', role: 'owner' }, 'role:'],
      [{ email: 'a@b.example' }, 'role:'],
      [{ role: 'viewer' }, 'email:'],
      [undefined, ''],
    ]
    for (const [payload, message] of cases) {
      const res = await bob.req('POST', emailRoute(board), payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect((res.json() as { error: { message: string } }).error.message).toContain(message)
    }
    expect(await countRows(api, 'invitations')).toBe(0)
    // Validation failures do not use up the hourly allowance.
    for (let i = 0; i < EMAIL_INVITE_USER_LIMIT.max; i++)
      expect((await sendInvite(bob, board, `p${i}@b.example`)).res.statusCode).toBe(201)
  })

  it(`limits each inviter to ${EMAIL_INVITE_USER_LIMIT.max} an hour`, async () => {
    const { alice, bob, board, api } = world
    for (let i = 0; i < EMAIL_INVITE_USER_LIMIT.max; i++)
      expect((await sendInvite(bob, board, `p${i}@b.example`)).res.statusCode).toBe(201)
    const limited = await sendInvite(bob, board, 'one-more@b.example')
    expect(limited.res.statusCode).toBe(429)
    expect(limited.res.json()).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } })
    // Per inviter: alice (another owner of the board) is not affected.
    expect((await sendInvite(alice, board, 'one-more@b.example')).res.statusCode).toBe(201)
    expect(await countRows(api, 'invitations WHERE board_id = $1', [board])).toBe(
      EMAIL_INVITE_USER_LIMIT.max + 1,
    )
    api.clock.advance(EMAIL_INVITE_USER_LIMIT.windowMs + 1)
    expect((await sendInvite(bob, board, 'one-more@b.example')).res.statusCode).toBe(201)
  })
})
