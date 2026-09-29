// Identity freshness (docs/DOMAIN-ACCESS-CONTRACTS.md §3.4, D12; §11.1 refresh.test.ts): "confirm when
// unknown, refresh in the background when merely stale". A fake Clerk Backend API counts the calls;
// the test clock moves time; identity.settled() waits for background refreshes.

import { Me } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClerkAuthProvider } from '../../../src/auth/clerk.ts'
import { createTestApi, ORIGIN, type TestApi } from '../../helpers.ts'
import {
  CLERK_KEYS,
  type ClerkWorld,
  clerkError,
  clerkUser,
  clerkWorld,
  fakeClerk,
  notFound,
} from './clerk-fake.ts'

vi.mock('@clerk/backend', async () => (await import('./clerk-fake.ts')).clerkBackendModule)

const HOUR = 60 * 60 * 1000
const me = (res: LightMyRequestResponse) => {
  expect(res.statusCode, res.body).toBe(200)
  return Me.parse(res.json())
}
const count = async (api: TestApi, sql: string, params: unknown[] = []) =>
  (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).n
const liveSessions = (api: TestApi, userId: string) =>
  count(api, 'sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId])

describe('identity refresh with Clerk', () => {
  let w: ClerkWorld
  beforeEach(async () => {
    fakeClerk.reset()
    w = await clerkWorld()
  })
  afterEach(() => w.api.close())

  /** A signed-in creator whose Clerk profile the test can change afterwards. */
  async function creator(sub = 'user_a') {
    clerkUser(sub, [`lobby-test-${sub.replace('_', '-')}@darkburn.com`])
    const c = await w.signIn(sub)
    fakeClerk.calls = []
    return c
  }

  it('never checked (NULL): one awaited call on /api/me, and that response already says "domain"', async () => {
    const a = await creator()
    // A user from before migration 0021: nothing stored, never checked.
    await w.api.db.query('UPDATE users SET identity_checked_at = NULL WHERE id = $1', [a.userId])
    await w.api.db.query('DELETE FROM user_emails WHERE user_id = $1', [a.userId])
    const res = me(await a.req('GET', '/api/me'))
    expect(fakeClerk.calls).toEqual(['user_a'])
    expect(res.access).toEqual({ creator: true, reason: 'domain', email: 'lobby-test-user-a@darkburn.com' })
    await w.api.identity.settled()
    expect(fakeClerk.calls).toHaveLength(1)
  })

  it('within 1 h: no call', async () => {
    const a = await creator()
    w.api.clock.advance(30 * 60 * 1000)
    expect(me(await a.req('GET', '/api/me')).access.reason).toBe('domain')
    await w.api.identity.settled()
    expect(fakeClerk.calls).toEqual([])
  })

  it('between 1 h and 24 h: answers from stored data, then exactly one background call', async () => {
    const a = await creator()
    clerkUser('user_a', ['pat@client.example.test']) // Clerk now says something else
    w.api.clock.advance(2 * HOUR)
    expect(me(await a.req('GET', '/api/me')).access.reason).toBe('domain') // stored data
    await w.api.identity.settled()
    expect(fakeClerk.calls).toEqual(['user_a'])
    expect(me(await a.req('GET', '/api/me')).access).toEqual({
      creator: false,
      reason: 'outside',
      email: 'pat@client.example.test',
    })
    await w.api.identity.settled()
    expect(fakeClerk.calls).toHaveLength(1)
  })

  it('after 24 h: an awaited call', async () => {
    const a = await creator()
    clerkUser('user_a', ['pat@client.example.test'])
    w.api.clock.advance(25 * HOUR)
    expect(me(await a.req('GET', '/api/me')).access.reason).toBe('outside')
    expect(fakeClerk.calls).toEqual(['user_a'])
  })

  it('single flight: parallel /api/me calls make one Clerk call', async () => {
    const a = await creator()
    w.api.clock.advance(25 * HOUR)
    let release = () => {}
    fakeClerk.gate = new Promise<void>((r) => {
      release = r
    })
    const pending = [a.req('GET', '/api/me'), a.req('GET', '/api/me'), a.req('GET', '/api/me')]
    while (fakeClerk.calls.length === 0) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 100)) // let the others reach the refresh too
    release()
    for (const res of await Promise.all(pending)) expect(me(res).access.reason).toBe('domain')
    expect(fakeClerk.calls).toEqual(['user_a'])
  })

  it('404 resource_not_found: every session of the account is revoked and the next request is 401', async () => {
    const a = await creator()
    const second = await w.signIn('user_a') // another device
    expect(await liveSessions(w.api, a.userId)).toBe(2)
    fakeClerk.failures.set('user_a', notFound)
    w.api.clock.advance(25 * HOUR)
    const res = await a.req('GET', '/api/me')
    expect(res.statusCode).toBe(401)
    expect(await liveSessions(w.api, a.userId)).toBe(0)
    expect((await second.req('GET', '/api/me')).statusCode).toBe(401)
    // Stored addresses are left as they are.
    expect(await count(w.api, 'user_emails WHERE user_id = $1', [a.userId])).toBe(1)
  })

  it('a background refresh that finds the account gone ends its sessions (the next request is 401)', async () => {
    const a = await creator()
    fakeClerk.failures.set('user_a', notFound)
    w.api.clock.advance(2 * HOUR)
    expect((await a.req('GET', '/api/me')).statusCode).toBe(200) // stored data, refresh in the background
    await w.api.identity.settled()
    expect((await a.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it.each([
    ['a 404 with another code', () => clerkError(404, 'not_found_elsewhere')],
    ['a 401 (a wrong key)', () => clerkError(401, 'authentication_invalid')],
    ['a 5xx', () => clerkError(502, 'bad_gateway')],
    ['a timeout', () => Object.assign(new Error('Clerk call timed out'), { name: 'TimeoutError' })],
  ])(
    '%s is "unavailable": no revocation, the stored data is kept ("unconfirmed" after 24 h)',
    async (_what, err) => {
      const a = await creator()
      fakeClerk.failures.set('user_a', err)
      w.api.clock.advance(25 * HOUR)
      const res = me(await a.req('GET', '/api/me'))
      expect(res.access).toEqual({
        creator: false,
        reason: 'unconfirmed',
        email: 'lobby-test-user-a@darkburn.com',
      })
      expect(await liveSessions(w.api, a.userId)).toBe(1)
    },
  )

  it('banned: every session is revoked', async () => {
    const a = await creator()
    clerkUser('user_a', ['lobby-test-user-a@darkburn.com'], { banned: true })
    w.api.clock.advance(25 * HOUR)
    expect((await a.req('GET', '/api/me')).statusCode).toBe(401)
    expect(await liveSessions(w.api, a.userId)).toBe(0)
  })

  it('unavailable while confirmed (under 24 h): the stored status stands', async () => {
    const a = await creator()
    fakeClerk.failures.set('user_a', () => clerkError(503, 'service_unavailable'))
    w.api.clock.advance(3 * HOUR)
    expect(me(await a.req('GET', '/api/me')).access.reason).toBe('domain')
    await w.api.identity.settled()
    expect(me(await a.req('GET', '/api/me')).access.reason).toBe('domain')
    const board = await a.req('POST', `/api/workspaces/${a.personalWorkspaceId}/boards`, {
      title: 'Still fine',
    })
    expect(board.statusCode).toBe(201)
  })

  it('unavailable while unconfirmed: /api/me is 200 "unconfirmed", creating is 503, and the 60 s backoff makes no call', async () => {
    const a = await creator()
    fakeClerk.failures.set('user_a', () => clerkError(503, 'service_unavailable'))
    w.api.clock.advance(25 * HOUR)
    expect(me(await a.req('GET', '/api/me')).access.reason).toBe('unconfirmed')
    expect(fakeClerk.calls).toHaveLength(1)
    const create = () => a.req('POST', `/api/workspaces/${a.personalWorkspaceId}/boards`, { title: 'x' })
    const refused = await create()
    expect(refused.statusCode).toBe(503)
    expect(refused.json().error).toEqual({
      code: 'IDENTITY_UNAVAILABLE',
      message: 'Lobby couldn’t confirm your email address with the sign-in service. Try again in a minute.',
    })
    expect(fakeClerk.calls).toHaveLength(1) // within the backoff: no new call
    w.api.clock.advance(61_000)
    expect((await create()).statusCode).toBe(503)
    expect(fakeClerk.calls).toHaveLength(2)
    // Clerk answers again: confirmed at once, and creating works.
    fakeClerk.failures.clear()
    w.api.clock.advance(61_000)
    expect((await create()).statusCode).toBe(201)
    expect(fakeClerk.calls).toHaveLength(3)
    expect(await count(w.api, 'boards')).toBe(1)
  })

  it('a failing Clerk call logs its status and first code, never its message or an address', async () => {
    const a = await creator()
    fakeClerk.failures.set('user_a', () => clerkError(500, 'internal_clerk_error'))
    w.api.clock.advance(25 * HOUR)
    await a.req('GET', '/api/me')
    const lines = w.logs.map((l) => JSON.parse(l) as Record<string, unknown>)
    const failed = lines.find((l) => l.evt === 'identity.refresh_failed' && l.userId === a.userId)
    expect(failed).toMatchObject({ status: 500, code: 'internal_clerk_error' })
    const all = w.logs.join('\n')
    expect(all).not.toContain('pat@client.example.test')
    expect(all).not.toContain('Clerk says')
    expect(all).not.toContain('lobby-test-user-a@')
  })

  it('an older snapshot never overwrites a newer one (two refreshes resolving out of order)', async () => {
    const a = await creator()
    // A second provider instance over the same database, whose profile calls the test resolves.
    const answers = new Map<string, (emails: string[]) => void>()
    let n = 0
    const provider = createClerkAuthProvider({
      ...CLERK_KEYS,
      publicOrigin: ORIGIN,
      deps: {
        profile: () => {
          const key = String(++n)
          return new Promise((resolve) =>
            answers.set(key, (emails) =>
              resolve({
                name: 'A',
                avatarUrl: null,
                emails: emails.map((email, i) => ({ email, isPrimary: i === 0, strategy: null })),
              }),
            ),
          )
        },
      },
    })
    const refresh = provider.refreshIdentity
    if (!refresh) throw new Error('no refreshIdentity')
    const t0 = w.api.clock.now()
    const older = refresh.call(provider, w.api.db, a.userId, new Date(t0.getTime() + 1_000))
    const newer = refresh.call(provider, w.api.db, a.userId, new Date(t0.getTime() + 2_000))
    while (answers.size < 2) await new Promise((r) => setTimeout(r, 5))
    answers.get('2')?.(['newer@client.example.test'])
    expect(await newer).toBe('ok')
    answers.get('1')?.(['lobby-test-older@darkburn.com'])
    expect(await older).toBe('ok')
    const stored = await w.api.db.query<{ email: string }>(
      'SELECT email FROM user_emails WHERE user_id = $1',
      [a.userId],
    )
    expect(stored.rows.map((r) => r.email)).toEqual(['newer@client.example.test'])
    const row = await w.api.db.one<{ identity_checked_at: Date }>(
      'SELECT identity_checked_at FROM users WHERE id = $1',
      [a.userId],
    )
    expect(row.identity_checked_at.getTime()).toBe(t0.getTime() + 2_000)
  })
})

describe('the policy is read per request (dev provider, one database, the api re-created)', () => {
  it('an exception added for an existing outsider makes a creator with a personal workspace; removing it keeps every membership', async () => {
    const first = await createTestApi()
    const db = first.db
    const alice = await first.login('alice') // Dev Studio owner
    const owner = await first.login('owner', 'Owner', { email: 'owner@personal.example.test' })
    expect(owner.me.access.reason).toBe('outside')
    expect(owner.me.workspaces).toEqual([])
    // An outsider invited into a board keeps it throughout.
    const board = (
      await alice.req('POST', `/api/workspaces/${alice.personalWorkspaceId}/boards`, { title: 'B' })
    ).json().id as string
    const inv = (
      await alice.req('POST', `/api/boards/${board}/invitations`, {
        role: 'editor',
        email: 'owner@personal.example.test',
      })
    ).json() as { url: string }
    expect((await owner.req('POST', `/api/invitations/${inv.url.split('/').pop()}/accept`)).statusCode).toBe(
      200,
    )
    // `first` stays open until the end: the database belongs to it.

    const withException = await createTestApi({
      db,
      env: { DRAFTROOM_CREATOR_EMAILS: 'owner@personal.example.test' },
    })
    const cookie = { cookie: owner.cookie }
    const asCreator = me(await withException.anon('GET', '/api/me', undefined, cookie))
    expect(asCreator.access).toEqual({
      creator: true,
      reason: 'exception',
      email: 'owner@personal.example.test',
    })
    const personal = asCreator.workspaces.find((w) => w.role === 'owner')
    expect(personal?.name).toBe("Owner's workspace")
    expect(asCreator.workspaces.map((w) => w.id)).toContain(alice.personalWorkspaceId)
    // Once only.
    me(await withException.anon('GET', '/api/me', undefined, cookie))
    expect(await count(withException, 'workspaces WHERE personal_of = $1', [owner.userId])).toBe(1)
    await withException.close()

    const withoutException = await createTestApi({ db })
    const outsider = me(await withoutException.anon('GET', '/api/me', undefined, cookie))
    expect(outsider.access.reason).toBe('outside')
    expect(outsider.workspaces.map((w) => [w.id, w.role]).sort()).toEqual(
      asCreator.workspaces.map((w) => [w.id, w.role]).sort(),
    )
    const detail = await withoutException.anon('GET', `/api/boards/${board}`, undefined, cookie)
    expect(detail.json().role).toBe('editor')
    const refused = await withoutException.anon(
      'POST',
      `/api/workspaces/${personal?.id}/boards`,
      { title: 'x' },
      cookie,
    )
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.code).toBe('CREATOR_REQUIRED')
    await withoutException.close()
    await first.close()
  })

  it('dev users stay creators after 25 h: the dev refresh stamps (no network)', async () => {
    const api = await createTestApi()
    try {
      const alice = await api.login('alice')
      api.clock.advance(25 * HOUR)
      expect(me(await alice.req('GET', '/api/me')).access).toEqual({
        creator: true,
        reason: 'dev',
        email: 'alice@dev.invalid',
      })
      expect(
        (await alice.req('POST', `/api/workspaces/${alice.personalWorkspaceId}/boards`, { title: 'x' }))
          .statusCode,
      ).toBe(201)
      // A dev user from before migration 0021 (no stored address) gets <handle>@dev.invalid.
      await api.db.query('DELETE FROM user_emails WHERE user_id = $1', [alice.userId])
      await api.db.query('UPDATE users SET identity_checked_at = NULL WHERE id = $1', [alice.userId])
      expect(me(await alice.req('GET', '/api/me')).access.reason).toBe('dev')
    } finally {
      await api.close()
    }
  })
})
