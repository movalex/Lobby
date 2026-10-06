// Domain access at sign-in (docs/DOMAIN-ACCESS-CONTRACTS.md §3.1, §3.3, §5, §8; §11.1 sign-in.test.ts):
// which addresses count, what gets stored, who gets a personal workspace and Dev Studio, and what
// `Me.access` says. Dev logins and a fake Clerk Backend API (clerk-fake.ts).

import { Me } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApi, DEV_STUDIO, devEmail, type TestApi } from '../../helpers.ts'
import { type ClerkWorld, clerkError, clerkUser, clerkWorld, fakeClerk } from './clerk-fake.ts'

vi.mock('@clerk/backend', async () => (await import('./clerk-fake.ts')).clerkBackendModule)

const count = async (api: TestApi, sql: string, params: unknown[] = []) =>
  (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).n

const storedEmails = (api: TestApi, userId: string) =>
  api.db.query<{ email: string; is_primary: boolean; source: string; verification_strategy: string | null }>(
    `SELECT email, is_primary, source, verification_strategy FROM user_emails WHERE user_id = $1
      ORDER BY is_primary DESC, email`,
    [userId],
  )

describe('dev sign-in', () => {
  let api: TestApi
  beforeEach(async () => {
    api = await createTestApi({ env: { DRAFTROOM_CREATOR_EMAILS: 'owner@personal.example.test' } })
  })
  afterEach(() => api.close())

  it('without an email: a creator (dev), with a personal workspace and Dev Studio', async () => {
    const alice = await api.login('alice')
    expect(alice.me.access).toEqual({ creator: true, reason: 'dev', email: devEmail('alice') })
    expect(alice.me.workspaces.map((w) => [w.name, w.role]).sort()).toEqual([
      ['Dev Studio', 'owner'],
      ["alice's workspace", 'owner'],
    ])
    const personal = await api.db.one<{ personal_of: string | null }>(
      'SELECT personal_of FROM workspaces WHERE id = $1',
      [alice.personalWorkspaceId],
    )
    expect(personal.personal_of).toBe(alice.userId)
    expect((await storedEmails(api, alice.userId)).rows).toEqual([
      { email: 'alice@dev.invalid', is_primary: true, source: 'dev', verification_strategy: null },
    ])
    const me = Me.parse((await alice.req('GET', '/api/me')).json())
    expect(me.access).toEqual(alice.me.access)
  })

  it('an outside address: no workspace, no Dev Studio, access "outside" with the address', async () => {
    await api.login('alice') // Dev Studio exists
    const client = await api.login('client-sam', 'Sam', { email: 'Sam@Client.Example.Test' })
    expect(client.me.workspaces).toEqual([])
    expect(client.me.access).toEqual({ creator: false, reason: 'outside', email: 'sam@client.example.test' })
    expect(await count(api, 'workspace_members WHERE user_id = $1', [client.userId])).toBe(0)
    expect(await count(api, 'workspaces WHERE created_by = $1', [client.userId])).toBe(0)
    const me = Me.parse((await client.req('GET', '/api/me')).json())
    expect(me.workspaces).toEqual([])
    expect(me.access.reason).toBe('outside')
    // /api/auth/me says the same
    const probe = Me.parse((await client.req('GET', '/api/auth/me')).json())
    expect(probe.access).toEqual(me.access)
  })

  it.each([
    ['lobby-test-a@darkburn.com'],
    ['lobby-test-b@trailerparkgroup.com'],
    ['lobby-test-c@trailerpark.com'],
  ])('%s is a creator by domain', async (email) => {
    const c = await api.login('worker', undefined, { email })
    expect(c.me.access).toEqual({ creator: true, reason: 'domain', email })
    expect(c.personalWorkspaceId).not.toBe('')
    expect(c.me.workspaces.map((w) => w.id)).toContain(DEV_STUDIO)
  })

  it('a subdomain of a creator domain is an outsider', async () => {
    const c = await api.login('sub', undefined, { email: 'lobby-test@sub.darkburn.com' })
    expect(c.me.access.reason).toBe('outside')
    expect(c.me.workspaces).toEqual([])
  })

  it('a +clerk_test address is refused with 400 (in any case), and nothing is created', async () => {
    for (const email of ['x+clerk_test@darkburn.com', 'X+Clerk_Test@darkburn.com']) {
      const res = await api.anon('POST', '/api/auth/dev/login', { handle: 'tester', email })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: {
          code: 'BAD_REQUEST',
          message: 'email: Lobby doesn’t accept Clerk test addresses (+clerk_test).',
        },
      })
    }
    expect(await count(api, 'users')).toBe(0)
  })

  it('an exception address (DRAFTROOM_CREATOR_EMAILS) is a creator: "exception"', async () => {
    const owner = await api.login('owner', 'Owner', { email: 'owner@personal.example.test' })
    expect(owner.me.access).toEqual({
      creator: true,
      reason: 'exception',
      email: 'owner@personal.example.test',
    })
    expect(owner.personalWorkspaceId).not.toBe('')
    // Exact address only.
    const other = await api.login('owner2', undefined, { email: 'owner+x@personal.example.test' })
    expect(other.me.access.reason).toBe('outside')
  })

  it('every login replaces the dev addresses (the last one decides)', async () => {
    const c = await api.login('switcher', undefined, { email: 'pat@client.example.test' })
    expect(c.me.access.reason).toBe('outside')
    const again = await api.login('switcher')
    expect(again.me.access).toEqual({ creator: true, reason: 'dev', email: 'switcher@dev.invalid' })
    // A creator now: a personal workspace on this sign-in, no Dev Studio (joined only when new).
    expect(again.me.workspaces.map((w) => w.name)).toEqual(["switcher's workspace"])
    expect((await storedEmails(api, c.userId)).rows.map((r) => r.email)).toEqual(['switcher@dev.invalid'])
  })

  it('the api never sends reason "legacy" (sign-in, /api/me, /api/auth/me; creators, outsiders, guests)', async () => {
    const alice = await api.login('alice')
    const outsider = await api.login('outsider', undefined, { email: 'o@client.example.test' })
    const board = (
      await alice.req('POST', `/api/workspaces/${alice.personalWorkspaceId}/boards`, { title: 'B' })
    ).json().id as string
    const link = (
      await alice.req('POST', `/api/boards/${board}/review-links`, { role: 'viewer', allowGuests: true })
    ).json() as { url: string }
    const joined = await api.anon('POST', `/api/invitations/${link.url.split('/').pop()}/guest`, {
      name: 'Guest G',
    })
    expect(joined.statusCode, joined.body).toBe(201)
    const guestCookie = joined.cookies.find((c) => c.name === 'dr_session')?.value ?? ''
    const bodies = [alice.me, outsider.me]
    for (const c of [alice, outsider]) {
      bodies.push((await c.req('GET', '/api/me')).json(), (await c.req('GET', '/api/auth/me')).json())
    }
    const guestMe = await api.anon('GET', '/api/me', undefined, { cookie: `dr_session=${guestCookie}` })
    bodies.push(guestMe.json())
    for (const body of bodies) {
      const me = Me.parse(body)
      expect(me.access.reason).not.toBe('legacy')
      expect(Object.keys(me.user).sort()).toEqual(['avatarUrl', 'color', 'handle', 'id', 'name'])
    }
    expect(Me.parse(guestMe.json()).access).toEqual({ creator: false, reason: 'guest', email: null })
  })

  it('a concurrent first sign-in by a creator makes exactly one user and one personal workspace', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => api.anon('POST', '/api/auth/dev/login', { handle: 'racer' })),
    )
    for (const r of results) expect(r.statusCode, r.body).toBe(200)
    const users = await api.db.query<{ id: string }>("SELECT id FROM users WHERE handle = 'racer'")
    expect(users.rows).toHaveLength(1)
    expect(await count(api, 'workspaces WHERE personal_of = $1', [users.rows[0]?.id])).toBe(1)
  })
})

describe('Clerk sign-in (fake Backend API)', () => {
  let w: ClerkWorld
  beforeEach(async () => {
    fakeClerk.reset()
    w = await clerkWorld({ env: { DRAFTROOM_CREATOR_EMAILS: 'owner@personal.example.test' } })
  })
  afterEach(() => w.api.close())

  it('a verified company address makes a creator with a personal workspace; the strategy is stored', async () => {
    clerkUser('user_a', [{ email: 'Lobby-Test-A@DarkBurn.com', strategy: 'from_oauth_google' }])
    const a = await w.signIn('user_a')
    expect(a.me.access).toEqual({ creator: true, reason: 'domain', email: 'lobby-test-a@darkburn.com' })
    expect(a.me.workspaces).toEqual([
      expect.objectContaining({ role: 'owner', name: "Name of user_a's workspace" }),
    ])
    expect((await storedEmails(w.api, a.userId)).rows).toEqual([
      {
        email: 'lobby-test-a@darkburn.com',
        is_primary: true,
        source: 'clerk',
        verification_strategy: 'from_oauth_google',
      },
    ])
    // Clerk accounts never join Dev Studio.
    expect(a.me.workspaces.map((x) => x.id)).not.toContain(DEV_STUDIO)
  })

  it('a verified SECONDARY address counts; the primary one is still the one shown', async () => {
    clerkUser('user_b', ['pat.personal@client.example.test', 'lobby-test-b@trailerparkgroup.com'])
    const b = await w.signIn('user_b')
    expect(b.me.access).toEqual({
      creator: true,
      reason: 'domain',
      email: 'pat.personal@client.example.test',
    })
    expect((await storedEmails(w.api, b.userId)).rows.map((r) => [r.email, r.is_primary])).toEqual([
      ['pat.personal@client.example.test', true],
      ['lobby-test-b@trailerparkgroup.com', false],
    ])
  })

  it.each([
    ['unverified', 'unverified'],
    ['transferable', 'transferable'],
    ['failed', 'failed'],
    ['null verification', null],
  ])('an address whose verification is %s never counts (and is not stored)', async (_what, status) => {
    clerkUser('user_c', ['someone@client.example.test', { email: 'lobby-test-c@darkburn.com', status }])
    const c = await w.signIn('user_c')
    expect(c.me.access).toEqual({ creator: false, reason: 'outside', email: 'someone@client.example.test' })
    expect(c.me.workspaces).toEqual([])
    expect((await storedEmails(w.api, c.userId)).rows.map((r) => r.email)).toEqual([
      'someone@client.example.test',
    ])
  })

  it('a verified +clerk_test address never counts: an outsider with no stored address', async () => {
    clerkUser('user_t', ['anyone+clerk_test@darkburn.com', 'Anyone+CLERK_TEST@trailerparkgroup.com'])
    const t = await w.signIn('user_t')
    expect(t.me.access).toEqual({ creator: false, reason: 'outside', email: null })
    expect(t.me.workspaces).toEqual([])
    expect((await storedEmails(w.api, t.userId)).rows).toEqual([])
  })

  it('non-ASCII look-alike addresses are dropped', async () => {
    clerkUser('user_k', [`lobby-test@darKburn.com`])
    const k = await w.signIn('user_k')
    expect(k.me.access).toEqual({ creator: false, reason: 'outside', email: null })
  })

  it.each([
    ['banned', { banned: true }],
    ['locked', { locked: true }],
  ])('a %s account is refused with 403 ACCOUNT_DISABLED and no session (nor user)', async (_what, flags) => {
    clerkUser('user_x', ['lobby-test-x@darkburn.com'], flags)
    const res = await w.exchange('user_x')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({
      error: {
        code: 'ACCOUNT_DISABLED',
        message:
          'This account can’t sign in to Lobby. Contact the person who runs Lobby at Dark Burn Creative.',
      },
    })
    expect(res.cookies.some((c) => c.name === 'dr_session')).toBe(false)
    expect(await count(w.api, 'sessions')).toBe(0)
    expect(await count(w.api, 'users')).toBe(0)
  })

  it('a first sign-in whose profile fetch fails is refused with 503 and creates no user (D9)', async () => {
    fakeClerk.failures.set('user_new', () => clerkError(500, 'internal_clerk_error'))
    const res = await w.exchange('user_new')
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('IDENTITY_UNAVAILABLE')
    expect(res.cookies.some((c) => c.name === 'dr_session')).toBe(false)
    expect(await count(w.api, 'users')).toBe(0)
    expect(await count(w.api, 'identities')).toBe(0)
    // No Clerk message (it can quote the address) in the logs.
    expect(w.logs.join('\n')).not.toContain('pat@client.example.test')
    // A 404 "resource_not_found" on a first sign-in is just as unavailable.
    fakeClerk.failures.set('user_new', () => clerkError(404, 'resource_not_found'))
    expect((await w.exchange('user_new')).statusCode).toBe(503)
  })

  it('a later sign-in whose profile fetch fails keeps the stored status and identity_checked_at', async () => {
    clerkUser('user_l', ['lobby-test-l@darkburn.com'])
    const first = await w.signIn('user_l')
    const before = await w.api.db.one<{ identity_checked_at: Date }>(
      'SELECT identity_checked_at FROM users WHERE id = $1',
      [first.userId],
    )
    w.api.clock.advance(60_000)
    fakeClerk.failures.set('user_l', () => clerkError(503, 'service_unavailable'))
    const again = await w.signIn('user_l')
    expect(again.userId).toBe(first.userId)
    expect(again.me.access).toEqual(first.me.access)
    const after = await w.api.db.one<{ identity_checked_at: Date }>(
      'SELECT identity_checked_at FROM users WHERE id = $1',
      [first.userId],
    )
    expect(after.identity_checked_at.getTime()).toBe(before.identity_checked_at.getTime())
    expect((await storedEmails(w.api, first.userId)).rows.map((r) => r.email)).toEqual([
      'lobby-test-l@darkburn.com',
    ])
  })

  it('an exception address (verified in Clerk) is a creator; the dev domain never counts under Clerk', async () => {
    clerkUser('user_o', ['owner@personal.example.test'])
    expect((await w.signIn('user_o')).me.access.reason).toBe('exception')
    clerkUser('user_d', ['someone@dev.invalid'])
    expect((await w.signIn('user_d')).me.access).toEqual({
      creator: false,
      reason: 'outside',
      email: 'someone@dev.invalid',
    })
  })

  it('dev rows never count under Clerk (only the running provider’s source)', async () => {
    clerkUser('user_s', ['someone@client.example.test'])
    const s = await w.signIn('user_s')
    await w.api.db.query(
      `INSERT INTO user_emails (user_id, email, is_primary, source, seen_at) VALUES ($1, 'lobby-test@darkburn.com', true, 'dev', now())`,
      [s.userId],
    )
    const me = Me.parse((await s.req('GET', '/api/me')).json())
    expect(me.access).toEqual({ creator: false, reason: 'outside', email: 'someone@client.example.test' })
  })
})
