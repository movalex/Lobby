// Identity staleness, the review findings of domain-access fixer round 1 (docs/DOMAIN-ACCESS-CONTRACTS.md
// §3.3, §3.4, §4.2, §19):
// - the Share dialog's read paths (GET …/invitations, GET …/sharing/members) freshen the CALLER like
//   /api/me does, so a manager who never loads /api/me still loses a removed company address within
//   about 1 h (and with it the multi-use link URLs and every way to mint a link);
// - the Clerk exchange that finds the account banned ends the sessions the account already has;
// - a stored identity_checked_at LATER than this process's clock (written by a process whose clock ran
//   ahead: a deploy overlap) never blocks a newer snapshot, and freshen treats it as stale.

import { Me } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../../helpers.ts'
import { type ClerkWorld, clerkUser, clerkWorld, fakeClerk } from './clerk-fake.ts'

vi.mock('@clerk/backend', async () => (await import('./clerk-fake.ts')).clerkBackendModule)

const HOUR = 60 * 60 * 1000
const code = (res: LightMyRequestResponse) => (res.json() as { error?: { code?: string } }).error?.code
const me = (res: LightMyRequestResponse) => {
  expect(res.statusCode, res.body).toBe(200)
  return Me.parse(res.json())
}
const count = async (api: TestApi, sql: string, params: unknown[] = []) =>
  (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).n
const liveSessions = (api: TestApi, userId: string) =>
  count(api, 'sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId])
const stored = async (api: TestApi, userId: string) =>
  (
    await api.db.query<{ email: string }>('SELECT email FROM user_emails WHERE user_id = $1 ORDER BY email', [
      userId,
    ])
  ).rows.map((r) => r.email)

describe('the Share dialog’s read paths freshen the caller (Clerk)', () => {
  let w: ClerkWorld
  let alice: Client
  let bob: Client
  let board: string
  beforeEach(async () => {
    fakeClerk.reset()
    w = await clerkWorld()
    clerkUser('user_alice', ['lobby-test-alice@darkburn.com'])
    alice = await w.signIn('user_alice')
    // bob: a personal primary address plus a verified company one; he owns alice's board.
    clerkUser('user_bob', ['bob@gmail.example.test', 'lobby-test-bob@darkburn.com'])
    bob = await w.signIn('user_bob')
    board = await createBoard(alice, alice.personalWorkspaceId, 'Shared')
    await w.api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())`,
      [alice.personalWorkspaceId, bob.userId],
    )
    const owner = await alice.req('PUT', `/api/boards/${board}/members/${bob.userId}`, { role: 'owner' })
    expect(owner.statusCode, owner.body).toBe(200)
    const link = await alice.req('POST', `/api/boards/${board}/review-links`, { role: 'viewer' })
    expect(link.statusCode, link.body).toBe(201)
    // Clerk removes bob's company address; bob never loads /api/me again.
    clerkUser('user_bob', ['bob@gmail.example.test'])
    fakeClerk.calls = []
  })
  afterEach(() => w.api.close())

  const reviewUrls = async (c: Client) => {
    const res = await c.req('GET', `/api/boards/${board}/invitations`)
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as { invitations: { kind: string; url: string | null }[] }).invitations
      .filter((i) => i.kind === 'review')
      .map((i) => (i.url === null ? null : 'url'))
  }

  it('GET …/invitations: within 1 h stored data and no call; after 1 h a background refresh, then url null and no new link', async () => {
    expect(await reviewUrls(bob)).toEqual(['url'])
    await w.api.identity.settled()
    expect(fakeClerk.calls).toEqual([])

    w.api.clock.advance(2 * HOUR)
    expect(await reviewUrls(bob)).toEqual(['url']) // this response still answers from stored data
    await w.api.identity.settled()
    expect(fakeClerk.calls).toEqual(['user_bob'])
    expect(await reviewUrls(bob)).toEqual([null])

    w.api.clock.advance(21 * HOUR) // 23 h after the check: the stored status already says outside
    const minted = await bob.req('POST', `/api/boards/${board}/review-links`, { role: 'viewer' })
    expect(minted.statusCode).toBe(403)
    expect(code(minted)).toBe('CREATOR_REQUIRED')
    await w.api.identity.settled()
    // alice (a creator) still sees the URL.
    expect(await reviewUrls(alice)).toEqual(['url'])
  })

  it('GET …/sharing/members starts the same background refresh for the caller', async () => {
    w.api.clock.advance(2 * HOUR)
    const res = await bob.req('GET', `/api/boards/${board}/sharing/members`)
    expect(res.statusCode, res.body).toBe(200)
    await w.api.identity.settled()
    expect(fakeClerk.calls).toEqual(['user_bob'])
    expect(await reviewUrls(bob)).toEqual([null])
  })

  it('a manager whose stored data is older than 24 h is confirmed first (awaited), so the list already says url null', async () => {
    w.api.clock.advance(25 * HOUR)
    expect(await reviewUrls(bob)).toEqual([null])
    expect(fakeClerk.calls).toEqual(['user_bob'])
  })

  it('no Clerk call for someone who may not manage access (the route’s own 404 comes first)', async () => {
    clerkUser('user_carol', ['lobby-test-carol@darkburn.com'])
    const carol = await w.signIn('user_carol')
    fakeClerk.calls = []
    w.api.clock.advance(25 * HOUR)
    expect((await carol.req('GET', `/api/boards/${board}/invitations`)).statusCode).toBe(404)
    expect((await carol.req('GET', `/api/boards/${board}/sharing/members`)).statusCode).toBe(404)
    await w.api.identity.settled()
    expect(fakeClerk.calls).toEqual([])
  })
})

describe('the Clerk exchange and the account’s existing sessions', () => {
  let w: ClerkWorld
  beforeEach(async () => {
    fakeClerk.reset()
    w = await clerkWorld()
  })
  afterEach(() => w.api.close())

  it('an exchange that finds the account banned answers 403 and ends every session it already has', async () => {
    clerkUser('user_b', ['lobby-test-b@darkburn.com'])
    const a = await w.signIn('user_b')
    const other = await w.signIn('user_b') // another device
    expect(await liveSessions(w.api, a.userId)).toBe(2)
    clerkUser('user_b', ['lobby-test-b@darkburn.com'], { banned: true })
    w.api.clock.advance(5 * 60 * 1000)
    const res = await w.exchange('user_b')
    expect(res.statusCode).toBe(403)
    expect(code(res)).toBe('ACCOUNT_DISABLED')
    expect(res.cookies.find((c) => c.name === 'dr_session' && c.value)).toBeUndefined()
    expect(await liveSessions(w.api, a.userId)).toBe(0)
    for (const c of [a, other]) {
      expect((await c.req('GET', '/api/me')).statusCode).toBe(401)
      const created = await c.req('POST', `/api/workspaces/${a.personalWorkspaceId}/boards`, { title: 'X' })
      expect(created.statusCode).toBe(401)
    }
    expect(await count(w.api, 'boards')).toBe(0)
    const log = w.logs.find((l) => l.includes('"identity.sessions_revoked"'))
    expect(log).toBeDefined()
    expect(log).not.toContain('darkburn.com')
  })

  it('a banned first sign-in (no account yet) is refused and creates nothing', async () => {
    clerkUser('user_new', ['lobby-test-new@darkburn.com'], { banned: true })
    const res = await w.exchange('user_new')
    expect(res.statusCode).toBe(403)
    expect(await count(w.api, 'users')).toBe(0)
  })

  it('a LOCKED account (a temporary sign-in lockout) is refused, but its sessions are not ended', async () => {
    clerkUser('user_l', ['lobby-test-l@darkburn.com'])
    const a = await w.signIn('user_l')
    clerkUser('user_l', ['lobby-test-l@darkburn.com'], { locked: true })
    const res = await w.exchange('user_l')
    expect(res.statusCode).toBe(403)
    expect(code(res)).toBe('ACCOUNT_DISABLED')
    expect(await liveSessions(w.api, a.userId)).toBe(1)
  })
})

describe('a stored check time later than this process’s clock (deploy overlap, clock skew)', () => {
  let w1: ClerkWorld
  let second: ClerkWorld | null = null
  beforeEach(async () => {
    fakeClerk.reset()
    w1 = await clerkWorld()
  })
  afterEach(async () => {
    await second?.api.close()
    second = null
    await w1.api.close()
  })

  /** user_s signs in on w1, whose clock runs 10 min ahead; then Clerk removes the company address. */
  async function skewedCreator(): Promise<{ s: Client; w2: ClerkWorld }> {
    w1.api.clock.advance(10 * 60 * 1000)
    clerkUser('user_s', ['lobby-test-s@darkburn.com'])
    const s = await w1.signIn('user_s')
    expect(s.me.access.reason).toBe('domain')
    clerkUser('user_s', ['s@client.example.test'])
    fakeClerk.calls = []
    second = await clerkWorld({ db: w1.api.db }) // the correct clock
    return { s, w2: second }
  }

  it('a sign-in on the slower clock stores the new addresses (not the older rows)', async () => {
    const { s, w2 } = await skewedCreator()
    const res = await w2.exchange('user_s')
    expect(res.statusCode, res.body).toBe(200)
    expect(Me.parse(res.json()).access).toEqual({
      creator: false,
      reason: 'outside',
      email: 's@client.example.test',
    })
    expect(await stored(w2.api, s.userId)).toEqual(['s@client.example.test'])
    // The old session is refused on the stored rows too, by either process.
    for (const api of [w1.api, w2.api]) {
      const res = await api.app.inject({
        method: 'POST',
        url: `/api/workspaces/${s.personalWorkspaceId}/boards`,
        payload: { title: 'X' },
        headers: { origin: ORIGIN, cookie: s.cookie },
      })
      expect(res.statusCode).toBe(403)
      expect(code(res)).toBe('CREATOR_REQUIRED')
    }
  })

  it('/api/me on the slower clock treats the future stamp as stale: a background refresh corrects it', async () => {
    const { s, w2 } = await skewedCreator()
    const get = () => w2.api.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: s.cookie } })
    expect(me(await get()).access.reason).toBe('domain') // stored data, at once
    await w2.api.identity.settled()
    expect(fakeClerk.calls).toEqual(['user_s'])
    expect(me(await get()).access).toEqual({
      creator: false,
      reason: 'outside',
      email: 's@client.example.test',
    })
    const checked = await w2.api.db.one<{ t: Date }>(
      'SELECT identity_checked_at AS t FROM users WHERE id = $1',
      [s.userId],
    )
    expect(checked.t.getTime()).toBeLessThanOrEqual(w2.api.clock.now().getTime())
    await w2.api.identity.settled()
    expect(fakeClerk.calls).toEqual(['user_s']) // corrected once, not on every request
  })
})

describe('dev login under clock skew', () => {
  let api1: TestApi
  let api2: TestApi | null = null
  beforeEach(async () => {
    api1 = await createTestApi()
  })
  afterEach(async () => {
    await api2?.close()
    api2 = null
    await api1.close()
  })

  it('every dev login replaces the dev addresses, even after a process whose clock ran ahead', async () => {
    await api1.login('alice')
    api1.clock.advance(2 * HOUR)
    const zed = await api1.login('zed')
    expect(zed.me.access).toMatchObject({ creator: true, reason: 'dev' })
    api2 = await createTestApi({ db: api1.db }) // the correct clock
    const again = await api2.login('zed', undefined, { email: 'zed@client.example.test' })
    expect(again.me.access).toEqual({ creator: false, reason: 'outside', email: 'zed@client.example.test' })
    expect(await stored(api2, zed.userId)).toEqual(['zed@client.example.test'])
    const res = await again.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'X' })
    expect(res.statusCode).toBe(403)
    expect(code(res)).toBe('CREATOR_REQUIRED')
  })
})
