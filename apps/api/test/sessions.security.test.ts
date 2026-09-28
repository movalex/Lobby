// SCA-4 (docs/SECURITY-REVIEW-2026-09-27.md), server part: our session remembers the Clerk session it
// was exchanged from, and POST /api/auth/sessions/revoke-all ("sign out everywhere") ends every
// session of the signed-in person (every device, this one included), their open event streams, and
// under Clerk their Clerk sessions too, so no other device can silently exchange its way back in.

import { Me, RevokeAllSessionsResponse } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createClerkAuthProvider } from '../src/auth/clerk.ts'
import { EventHub } from '../src/events/hub.ts'
import { createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from './helpers.ts'
import { listen, openSse, type SseStream } from './sse.ts'

let api: TestApi | undefined
const streams: SseStream[] = []
afterEach(async () => {
  for (const s of streams.splice(0)) await s.close()
  await api?.close()
  api = undefined
})

const REVOKE_ALL = '/api/auth/sessions/revoke-all'

describe('sign out everywhere (dev provider)', () => {
  it('ends every session of the caller, clears this cookie, and leaves other people signed in', async () => {
    api = await createTestApi()
    const laptop = await api.login('alice')
    const phone = await api.login('alice')
    const bob = await api.login('bob')
    const res = await laptop.req('POST', REVOKE_ALL)
    expect(res.statusCode).toBe(200)
    expect(RevokeAllSessionsResponse.parse(res.json())).toEqual({
      revoked: 2,
      provider: { status: 'none', revoked: 0 },
    })
    expect(res.cookies.find((c) => c.name === 'dr_session')?.value).toBe('')
    expect((await laptop.req('GET', '/api/me')).statusCode).toBe(401)
    expect((await phone.req('GET', '/api/me')).statusCode).toBe(401)
    expect((await bob.req('GET', '/api/me')).statusCode).toBe(200)
    // Signing in again works (a new session).
    const again = await api.login('alice')
    expect((await again.req('GET', '/api/me')).statusCode).toBe(200)
  })

  it('ends the person’s open event streams on every device at once', async () => {
    const hub = new EventHub()
    api = await createTestApi({ deps: { events: hub, limits: { streamRecheckMs: 60 * 60 * 1000 } } })
    const laptop = await api.login('alice')
    const phone = await api.login('alice')
    const bob = await api.login('bob')
    const boardId = await createBoard(laptop, DEV_STUDIO, 'Board')
    await laptop.req('PATCH', `/api/boards/${boardId}`, { visibility: 'workspace_view' })
    const base = await listen(api)
    const open = async (cookie: string) => {
      const s = await openSse(base, boardId, cookie)
      streams.push(s)
      await s.waitFor('hello')
      return s
    }
    const [a, b, c] = [await open(laptop.cookie), await open(phone.cookie), await open(bob.cookie)]
    expect((await phone.req('POST', REVOKE_ALL)).statusCode).toBe(200)
    await a.waitFor('session-ended', 2_000)
    await b.waitFor('session-ended', 2_000)
    expect(c.ended()).toBe(false)
  })

  it('needs a signed-in, same-origin POST, and is rate limited per person', async () => {
    api = await createTestApi({ deps: { limits: { revokeAll: { max: 1, timeWindow: 60_000 } } } })
    expect((await api.anon('POST', REVOKE_ALL)).statusCode).toBe(401)
    const alice = await api.login('alice')
    const cross = await api.app.inject({
      method: 'POST',
      url: REVOKE_ALL,
      headers: { cookie: alice.cookie, origin: 'https://evil.example' },
    })
    expect(cross.statusCode).toBe(403)
    expect((await alice.req('GET', '/api/me')).statusCode).toBe(200)
    expect((await alice.req('POST', REVOKE_ALL)).statusCode).toBe(200)
    const again = await api.login('alice')
    expect((await again.req('POST', REVOKE_ALL)).statusCode).toBe(429)
    expect((await again.req('GET', '/api/me')).statusCode).toBe(200)
  })
})

describe('Clerk sessions (fake Clerk)', () => {
  const revokeCalls: { sub: string; known: string[] }[] = []
  let failRevoke = false
  const clerkApi = () => {
    revokeCalls.length = 0
    failRevoke = false
    return createTestApi({
      deps: {
        authProvider: createClerkAuthProvider({
          secretKey: 'sk_test_unused',
          publishableKey: 'pk_test_unused',
          publicOrigin: ORIGIN,
          deps: {
            verify: async (token) => {
              const [sub, sid] = token.split('|')
              if (!sub?.startsWith('user_')) throw new Error('invalid')
              return { sub, ...(sid === undefined ? {} : { sid }) }
            },
            profile: async (sub) => ({ name: `Name of ${sub}`, avatarUrl: null }),
            revokeSessions: async (sub, known) => {
              revokeCalls.push({ sub, known: [...known].sort() })
              if (failRevoke) throw new Error('clerk unavailable')
              return known.length + 1
            },
          },
        }),
      },
    })
  }
  const exchange = async (token: string) => {
    const res = await api?.app.inject({
      method: 'POST',
      url: '/api/auth/clerk/session',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    })
    if (res?.statusCode !== 200) throw new Error(`exchange failed: ${res?.statusCode}`)
    const cookie = res.cookies.find((c) => c.name === 'dr_session')?.value ?? ''
    return { me: Me.parse(res.json()), cookie: `dr_session=${cookie}` }
  }
  const post = (cookie: string, url: string) =>
    api?.app.inject({ method: 'POST', url, headers: { origin: ORIGIN, cookie } })

  it('stores the Clerk session id with our session (and ignores a malformed one)', async () => {
    api = await clerkApi()
    await exchange('user_clerk1|sess_2abcDEF1234567890xyz')
    await exchange('user_clerk1|../../etc')
    await exchange('user_clerk1')
    const rows = await api.db.query<{ clerk_session_id: string | null }>(
      'SELECT clerk_session_id FROM sessions',
    )
    const ids = rows.rows.map((r) => r.clerk_session_id)
    expect(ids).toHaveLength(3)
    expect(ids.filter((x) => x !== null)).toEqual(['sess_2abcDEF1234567890xyz'])
  })

  it('sign out everywhere also revokes the person’s Clerk sessions (the known ids included)', async () => {
    api = await clerkApi()
    const a = await exchange('user_clerk1|sess_aaaaaaaaaaaaaaaaaaaa')
    await exchange('user_clerk1|sess_bbbbbbbbbbbbbbbbbbbb')
    const other = await exchange('user_clerk2|sess_cccccccccccccccccccc')
    const res = await post(a.cookie, REVOKE_ALL)
    expect(res?.statusCode).toBe(200)
    expect(res?.json()).toEqual({ revoked: 2, provider: { status: 'revoked', revoked: 3 } })
    expect(revokeCalls).toEqual([
      { sub: 'user_clerk1', known: ['sess_aaaaaaaaaaaaaaaaaaaa', 'sess_bbbbbbbbbbbbbbbbbbbb'] },
    ])
    const me = await api.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: other.cookie } })
    expect(me.statusCode).toBe(200)
  })

  it('our sessions are revoked even when Clerk cannot be reached, and the answer says so', async () => {
    api = await clerkApi()
    const a = await exchange('user_clerk1|sess_aaaaaaaaaaaaaaaaaaaa')
    failRevoke = true
    const res = await post(a.cookie, REVOKE_ALL)
    expect(res?.statusCode).toBe(200)
    expect(res?.json()).toEqual({ revoked: 1, provider: { status: 'failed', revoked: 0 } })
    const me = await api.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: a.cookie } })
    expect(me.statusCode).toBe(401)
  })
})
