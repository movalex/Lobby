// SCA-2 (docs/SECURITY-REVIEW-2026-09-27.md): per-IP auth limits of 30 per minute locked out invitees
// behind one NAT, and a 429 on logout left the session valid. Now:
// - logout is never rate limited and always revokes (and clears the cookie even when revoking fails);
// - the invitation preview is limited per link token (plus a generous per-IP backstop against floods
//   of made-up tokens), and accepting is limited per signed-in user;
// - the Clerk exchange counts only FAILED verifications per IP (a NAT full of real sign-ins is never
//   refused), and successful exchanges per Clerk user.

import { afterEach, describe, expect, it } from 'vitest'
import { CLERK_EXCHANGES_PER_SUBJECT, createClerkAuthProvider } from '../src/auth/clerk.ts'
import { createBoard, createTestApi, devEmail, ORIGIN, type TestApi } from './helpers.ts'

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

const PRODUCTION_AUTH_LIMIT = { max: 30, timeWindow: 60_000 }
const tokenOf = (url: string) => url.split('/').pop() ?? ''

describe('logout', () => {
  it('is never rate limited: after a burst of logouts, the next logout still revokes its session', async () => {
    api = await createTestApi({ deps: { authRateLimit: { max: 3, timeWindow: 60_000 } } })
    for (let i = 0; i < 10; i++) expect((await api.anon('POST', '/api/auth/logout')).statusCode).toBe(204)
    const alice = await api.login('alice')
    const out = await alice.req('POST', '/api/auth/logout')
    expect(out.statusCode).toBe(204)
    expect(out.cookies.find((c) => c.name === 'dr_session')?.value).toBe('')
    expect((await alice.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it('clears the cookie even when the server cannot revoke, and says the sign-out did not finish', async () => {
    api = await createTestApi()
    const alice = await api.login('alice')
    const db = api.db
    const query = db.query.bind(db)
    db.query = (async (sql: string, params?: unknown[]) => {
      if (/^UPDATE sessions SET revoked_at/.test(sql)) throw new Error('database unavailable')
      return query(sql, params)
    }) as typeof db.query
    try {
      const out = await alice.req('POST', '/api/auth/logout')
      expect(out.statusCode).toBe(503)
      expect(out.json().error.code).toBe('LOGOUT_INCOMPLETE')
      expect(out.cookies.find((c) => c.name === 'dr_session')?.value).toBe('')
    } finally {
      db.query = query as typeof db.query
    }
  })
})

describe('invitations behind one NAT', () => {
  it('25 invitees on one public IP can each preview their link three times and accept it', async () => {
    api = await createTestApi({ deps: { authRateLimit: PRODUCTION_AUTH_LIMIT } })
    const owner = await api.login('owner')
    const boardId = await createBoard(owner, owner.personalWorkspaceId, 'Workshop')
    const codes: number[] = []
    for (let i = 0; i < 25; i++) {
      const inv = await owner.req('POST', `/api/boards/${boardId}/invitations`, {
        role: 'viewer',
        email: devEmail(`invitee-${i}`),
      })
      const token = tokenOf((inv.json() as { url: string }).url)
      for (let k = 0; k < 3; k++) codes.push((await api.anon('GET', `/api/invitations/${token}`)).statusCode)
      const person = await api.login(`invitee-${i}`)
      codes.push((await person.req('POST', `/api/invitations/${token}/accept`)).statusCode)
    }
    expect(codes.filter((c) => c !== 200)).toEqual([])
  })

  it('previews are limited per link token; other links from the same IP are unaffected', async () => {
    api = await createTestApi({
      deps: { limits: { invitations: { previewPerToken: { max: 3, timeWindow: 60_000 } } } },
    })
    const owner = await api.login('owner')
    const boardId = await createBoard(owner, owner.personalWorkspaceId, 'B')
    const mk = async () =>
      tokenOf(
        (
          (
            await owner.req('POST', `/api/boards/${boardId}/invitations`, {
              role: 'viewer',
              email: devEmail('someone'),
            })
          ).json() as {
            url: string
          }
        ).url,
      )
    const [a, b] = [await mk(), await mk()]
    const preview = (t: string) => api?.anon('GET', `/api/invitations/${t}`)
    const codes = []
    for (let i = 0; i < 4; i++) codes.push((await preview(a))?.statusCode)
    expect(codes).toEqual([200, 200, 200, 429])
    expect(Number((await preview(a))?.headers['retry-after'])).toBeGreaterThan(0)
    expect((await preview(b))?.statusCode).toBe(200)
    // Made-up tokens are 404 and use no token bucket of a real link.
    expect((await preview('A'.repeat(43)))?.statusCode).toBe(404)
  })

  it('a per-IP backstop still stops one client flooding made-up tokens', async () => {
    api = await createTestApi({
      deps: { limits: { invitations: { previewPerIp: { max: 5, timeWindow: 60_000 } } } },
    })
    const codes: number[] = []
    for (let i = 0; i < 7; i++) {
      const token = `${String(i).padStart(2, '0')}${'x'.repeat(41)}`
      codes.push((await api.anon('GET', `/api/invitations/${token}`)).statusCode)
    }
    expect(codes).toEqual([404, 404, 404, 404, 404, 429, 429])
    // Another client is not affected.
    const other = await api.app.inject({
      method: 'GET',
      url: `/api/invitations/${'y'.repeat(43)}`,
      remoteAddress: '198.51.100.7',
    })
    expect(other.statusCode).toBe(404)
  })

  it('accepting is limited per signed-in user, not per IP', async () => {
    api = await createTestApi({
      deps: { limits: { invitations: { acceptPerUser: { max: 2, timeWindow: 60_000 } } } },
    })
    const owner = await api.login('owner')
    const boardId = await createBoard(owner, owner.personalWorkspaceId, 'B')
    const tokens: string[] = []
    for (let i = 0; i < 4; i++)
      tokens.push(
        tokenOf(
          (
            (
              await owner.req('POST', `/api/boards/${boardId}/invitations`, {
                role: 'viewer',
                email: devEmail(i < 3 ? 'zoe' : 'yan'),
              })
            ).json() as {
              url: string
            }
          ).url,
        ),
      )
    const zoe = await api.login('zoe')
    const yan = await api.login('yan')
    const accept = (c: typeof zoe, t: string) => c.req('POST', `/api/invitations/${t}/accept`)
    expect((await accept(zoe, tokens[0] ?? '')).statusCode).toBe(200)
    expect((await accept(zoe, tokens[1] ?? '')).statusCode).toBe(200)
    const third = await accept(zoe, tokens[2] ?? '')
    expect(third.statusCode).toBe(429)
    expect(third.json().error.code).toBe('RATE_LIMITED')
    expect((await accept(yan, tokens[3] ?? '')).statusCode).toBe(200)
  })
})

describe('Clerk exchange (fake verifier)', () => {
  const clerkApi = (authRateLimit = { max: 5, timeWindow: 60_000 }) =>
    createTestApi({
      deps: {
        authRateLimit,
        authProvider: createClerkAuthProvider({
          secretKey: 'sk_test_unused',
          publishableKey: 'pk_test_unused',
          publicOrigin: ORIGIN,
          deps: {
            verify: async (token) => {
              const m = /^good-(\d+)$/.exec(token)
              if (!m) throw new Error('invalid')
              return { sub: `user_${m[1]}` }
            },
            profile: async (sub) => ({ name: `Name of ${sub}`, avatarUrl: null, emails: [] }),
          },
        }),
      },
    })
  const exchange = (token: string, remoteAddress = '203.0.113.10') =>
    api?.app.inject({
      method: 'POST',
      url: '/api/auth/clerk/session',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      remoteAddress,
    })

  it('counts only failed verifications per IP: 40 real sign-ins from one office all pass', async () => {
    api = await clerkApi()
    const codes: number[] = []
    for (let i = 0; i < 40; i++) codes.push((await exchange(`good-${i}`))?.statusCode ?? 0)
    expect(codes.filter((c) => c !== 200)).toEqual([])
  })

  it('after too many failures an IP must wait, even with a valid token; other IPs are unaffected', async () => {
    api = await clerkApi()
    for (let i = 0; i < 5; i++) expect((await exchange('forged'))?.statusCode).toBe(401)
    const blocked = await exchange('good-1')
    expect(blocked?.statusCode).toBe(429)
    expect(Number(blocked?.headers['retry-after'])).toBeGreaterThan(0)
    expect((await exchange('good-2', '198.51.100.7'))?.statusCode).toBe(200)
    api.clock.advance(61_000)
    expect((await exchange('good-1'))?.statusCode).toBe(200)
  })

  it('bounds successful exchanges per Clerk user (each costs a Clerk API call)', async () => {
    api = await clerkApi()
    const codes: number[] = []
    for (let i = 0; i <= CLERK_EXCHANGES_PER_SUBJECT.max; i++)
      codes.push((await exchange('good-7'))?.statusCode ?? 0)
    expect(codes.slice(0, -1).every((c) => c === 200)).toBe(true)
    expect(codes.at(-1)).toBe(429)
    expect((await exchange('good-8'))?.statusCode).toBe(200)
  })
})
