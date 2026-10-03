// SCA-3 (docs/SECURITY-REVIEW-2026-09-27.md, A6): the Clerk exchange signs in only an ACTIVE Clerk session.
// A token whose `sts` claim is "pending" (the user still owes a Clerk session task) or any other value is
// refused with 401 and creates no user, session or cookie; "active" signs in, and so does a token with no
// `sts` claim at all (@clerk/backend itself treats only "pending" as signed out).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertSessionActive, createClerkAuthProvider, SessionNotActiveError } from '../src/auth/clerk.ts'
import { createTestApi, ORIGIN, type TestApi } from './helpers.ts'

const STATUS_BY_TOKEN: Record<string, string | undefined> = {
  'active-token': 'active',
  'no-claim-token': undefined,
  'pending-token': 'pending',
  'expired-token': 'expired',
  'revoked-token': 'revoked',
  'future-token': 'something-clerk-adds-later',
  'empty-token': '',
  'upper-token': 'ACTIVE',
}

describe('assertSessionActive', () => {
  it('accepts an active session and a token with no status claim, and refuses everything else', () => {
    expect(() => assertSessionActive('active')).not.toThrow()
    expect(() => assertSessionActive(undefined)).not.toThrow()
    for (const sts of ['pending', 'expired', 'revoked', 'ended', '', 'ACTIVE', 'active ', 'something-new'])
      expect(() => assertSessionActive(sts), JSON.stringify(sts)).toThrow(SessionNotActiveError)
    // The reason class the exchange logs: a name, never a token or its claims.
    try {
      assertSessionActive('pending')
    } catch (e) {
      expect((e as Error).name).toBe('SessionNotActiveError')
      expect((e as Error).message).not.toMatch(/pending/)
    }
  })
})

describe('the Clerk exchange and the session status claim', () => {
  let clerk: TestApi
  beforeEach(async () => {
    clerk = await createTestApi({
      deps: {
        authProvider: createClerkAuthProvider({
          secretKey: 'sk_test_unused',
          publishableKey: 'pk_test_unused',
          publicOrigin: ORIGIN,
          deps: {
            verify: async (token) => {
              if (!(token in STATUS_BY_TOKEN)) throw new Error('invalid')
              const sts = STATUS_BY_TOKEN[token]
              return { sub: `user_${token}`, ...(sts === undefined ? {} : { sts }) }
            },
            profile: async (sub) => ({
              name: `Name of ${sub}`,
              avatarUrl: null,
              emails: [{ email: 'lobby-test-alice@darkburn.com', isPrimary: true, strategy: 'email_code' }],
            }),
          },
        }),
      },
    })
  })
  afterEach(() => clerk.close())

  const exchange = (token: string) =>
    clerk.anon('POST', '/api/auth/clerk/session', undefined, { authorization: `Bearer ${token}` })
  const counts = async () => ({
    users: (await clerk.db.one<{ n: number }>('SELECT count(*)::int AS n FROM users')).n,
    sessions: (await clerk.db.one<{ n: number }>('SELECT count(*)::int AS n FROM sessions')).n,
    identities: (await clerk.db.one<{ n: number }>('SELECT count(*)::int AS n FROM identities')).n,
  })

  it('refuses a pending (or any non-active) session with 401, and creates no user, identity, session or cookie', async () => {
    for (const token of [
      'pending-token',
      'expired-token',
      'revoked-token',
      'future-token',
      'empty-token',
      'upper-token',
    ]) {
      const res = await exchange(token)
      expect({ token, status: res.statusCode }).toEqual({ token, status: 401 })
      expect(res.json()).toEqual({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' } })
      expect(res.cookies.some((c) => c.name === 'dr_session')).toBe(false)
    }
    expect(await counts()).toEqual({ users: 0, sessions: 0, identities: 0 })
  })

  it('signs in an active session and a token that carries no status claim', async () => {
    for (const token of ['active-token', 'no-claim-token']) {
      const res = await exchange(token)
      expect({ token, status: res.statusCode, body: res.statusCode === 200 ? '' : res.body }).toEqual({
        token,
        status: 200,
        body: '',
      })
      expect(res.cookies.some((c) => c.name === 'dr_session')).toBe(true)
    }
    expect((await counts()).users).toBe(2)
  })

  it('a refused pending session counts as a failed verification (the per-address limit), an active one does not', async () => {
    // Active sign-ins from one address are never counted against it.
    for (let i = 0; i < 5; i++) expect((await exchange('active-token')).statusCode).toBe(200)
    // Pending ones are: past the limit the address is refused before anything is verified.
    const codes: number[] = []
    for (let i = 0; i < 70; i++) codes.push((await exchange('pending-token')).statusCode)
    expect(codes.slice(0, 60).every((c) => c === 401)).toBe(true)
    expect(codes.at(-1)).toBe(429)
  })
})
