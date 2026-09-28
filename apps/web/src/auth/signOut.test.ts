// SCA-1 and SCA-4 (docs/SECURITY-REVIEW-2026-09-27.md), web half: signing out ends the Clerk session
// too, a sign-out that did not happen is reported instead of showing a signed-out screen, and after an
// explicit sign-out the sign-in page never trades a still-live Clerk session for a new Draftroom
// session without a click ("Continue as <name>").
import { describe, expect, it, vi } from 'vitest'
import { ApiError, createApiClient } from '../api/client.ts'
import { clerkAccountLabel, clerkSignInView, runSignOut, type SignOutSteps } from './signOut.ts'
import {
  createSignedOutMarks,
  type MarkStorage,
  parseSignedOutMark,
  SIGNED_OUT_KEY,
  type SignedOutMark,
} from './signOutMark.ts'

/** sessionStorage stand-in (one per "tab"; a reload keeps it). */
function memoryStorage(): MarkStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const apiError = (status: number, kind: ApiError['kind'], message = 'nope') =>
  new ApiError(kind, status, `HTTP_${status}`, message)

/** Steps that record what ran, in order; each can be told to fail. */
function steps(opts: {
  mode?: SignOutSteps['mode']
  clerk?: 'ok' | 'fail' | null
  logout?: unknown
  revokeAll?: unknown
  storage?: MarkStorage
}) {
  const log: string[] = []
  const storage = opts.storage ?? memoryStorage()
  const marks = createSignedOutMarks(() => storage)
  const s: SignOutSteps = {
    mode: opts.mode ?? 'here',
    revokeAll: async () => {
      log.push('revoke-all')
      if (opts.revokeAll) throw opts.revokeAll
    },
    logout: async () => {
      log.push('logout')
      if (opts.logout) throw opts.logout
    },
    endClerkSession:
      opts.clerk === null || opts.clerk === undefined
        ? null
        : async () => {
            log.push('clerk')
            if (opts.clerk === 'fail') throw new Error('Clerk did not load in time')
          },
    marks: {
      set: (m) => {
        log.push(`mark:${m.clerk}`)
        marks.set(m)
      },
      clear: () => {
        log.push('unmark')
        marks.clear()
      },
    },
    now: () => 1_700_000_000_000,
  }
  return { s, log, marks, storage }
}

describe('the explicit sign-out mark (sessionStorage)', () => {
  it('is set, read back after a "reload" (same storage, new reader) and cleared', () => {
    const storage = memoryStorage()
    const mark: SignedOutMark = { at: 5, clerk: 'ended' }
    createSignedOutMarks(() => storage).set(mark)
    expect(storage.data.get(SIGNED_OUT_KEY)).toBe(JSON.stringify(mark))
    const afterReload = createSignedOutMarks(() => storage)
    expect(afterReload.read()).toEqual(mark)
    afterReload.clear()
    expect(afterReload.read()).toBeNull()
    expect(storage.data.size).toBe(0)
  })

  it('counts as set whenever the key is present, even with a value it cannot read (errs toward a click)', () => {
    expect(parseSignedOutMark(null)).toBeNull()
    expect(parseSignedOutMark('garbage')).toEqual({ at: 0, clerk: 'pending' })
    expect(parseSignedOutMark('{"at":"x","clerk":"weird"}')).toEqual({ at: 0, clerk: 'pending' })
    expect(parseSignedOutMark('{"at":3,"clerk":"failed"}')).toEqual({ at: 3, clerk: 'failed' })
  })

  it('still holds for the page when storage is missing or throws (private mode, blocked site data)', () => {
    const throwing = createSignedOutMarks(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    throwing.set({ at: 1, clerk: 'pending' })
    expect(throwing.read()).toEqual({ at: 1, clerk: 'pending' })
    throwing.clear()
    expect(throwing.read()).toBeNull()

    const full = memoryStorage()
    full.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    const marks = createSignedOutMarks(() => full)
    marks.set({ at: 2, clerk: 'ended' })
    expect(marks.read()).toEqual({ at: 2, clerk: 'ended' })
    expect(createSignedOutMarks(() => null).read()).toBeNull()
  })
})

describe('runSignOut (SCA-1): sign out ends the Clerk session too', () => {
  it('marks the tab BEFORE any request, then revokes the Draftroom session, then ends the Clerk session', async () => {
    const { s, log, marks } = steps({ clerk: 'ok' })
    expect(await runSignOut(s)).toEqual({ status: 'signed-out', clerk: 'ended' })
    // The mark comes first: a 401 from any request can send the tab to /signin at once, and the
    // sign-in page must already know not to exchange the live Clerk session.
    expect(log).toEqual(['mark:pending', 'logout', 'clerk', 'mark:ended'])
    expect(marks.read()).toEqual({ at: 1_700_000_000_000, clerk: 'ended' })
  })

  it('with the dev provider there is no Clerk session to end; the mark still records the sign-out', async () => {
    const { s, log, marks } = steps({ clerk: null })
    expect(await runSignOut(s)).toEqual({ status: 'signed-out', clerk: 'none' })
    expect(log).toEqual(['mark:none', 'logout'])
    expect(marks.read()?.clerk).toBe('none')
  })

  it('a failed logout is reported, never shown as signed out (5xx, network, 429)', async () => {
    for (const err of [
      apiError(500, 'server', 'Lobby had a problem handling that.'),
      apiError(0, 'network', "Can't reach Lobby."),
      apiError(429, 'rate-limited', 'Too many requests. Wait a moment and try again.'),
      new TypeError('fetch failed'),
    ]) {
      const { s, log, marks } = steps({ clerk: 'ok', logout: err })
      const out = await runSignOut(s)
      expect(out).toMatchObject({ status: 'failed', step: 'logout', retryable: true })
      if (out.status !== 'failed') throw new Error('unreachable')
      expect(out.title).toBe('You are still signed in.')
      if (err instanceof ApiError) expect(out.detail).toContain(err.message)
      // The Clerk session is ended anyway (it is what would sign this person back in), and the tab
      // stays marked: nothing may auto-exchange here until someone clicks.
      expect(log).toEqual(['mark:pending', 'logout', 'clerk', 'mark:ended'])
      expect(marks.read()).not.toBeNull()
    }
  })

  it('a 401 from logout means the session was already gone: that is a sign-out', async () => {
    const { s } = steps({ clerk: null, logout: apiError(401, 'unauthorized') })
    expect(await runSignOut(s)).toEqual({ status: 'signed-out', clerk: 'none' })
  })

  it('a Clerk session that could not be ended is recorded in the mark for the sign-in page', async () => {
    const { s, log, marks } = steps({ clerk: 'fail' })
    expect(await runSignOut(s)).toEqual({ status: 'signed-out', clerk: 'failed' })
    expect(log).toEqual(['mark:pending', 'logout', 'clerk', 'mark:failed'])
    expect(marks.read()?.clerk).toBe('failed')
  })
})

describe('runSignOut (SCA-4): sign out everywhere', () => {
  it('revokes every session, then signs this browser out like "Sign out"', async () => {
    const { s, log } = steps({ mode: 'everywhere', clerk: 'ok' })
    expect(await runSignOut(s)).toEqual({ status: 'signed-out', clerk: 'ended' })
    expect(log).toEqual(['mark:pending', 'revoke-all', 'logout', 'clerk', 'mark:ended'])
  })

  it('an API without the route (404) says so, changes nothing and leaves no mark', async () => {
    const { s, log, marks } = steps({
      mode: 'everywhere',
      clerk: 'ok',
      revokeAll: apiError(404, 'not-found'),
    })
    const out = await runSignOut(s)
    expect(out).toMatchObject({ status: 'unsupported', retryable: false })
    if (out.status !== 'unsupported') throw new Error('unreachable')
    expect(out.detail).toContain('not available on this server yet')
    expect(log).toEqual(['mark:pending', 'revoke-all', 'unmark'])
    expect(marks.read()).toBeNull()
  })

  it('any other revoke-all failure is reported and this session is left as it was', async () => {
    const { s, log } = steps({ mode: 'everywhere', clerk: 'ok', revokeAll: apiError(503, 'server', 'Down.') })
    const out = await runSignOut(s)
    expect(out).toMatchObject({ status: 'failed', step: 'revoke-all', retryable: true })
    if (out.status !== 'failed') throw new Error('unreachable')
    expect(out.detail).toContain('Other devices were not signed out')
    expect(log).toEqual(['mark:pending', 'revoke-all'])
  })

  it('a logout failure after a successful revoke-all says the other sessions did end', async () => {
    const { s } = steps({ mode: 'everywhere', clerk: null, logout: apiError(500, 'server', 'Oops.') })
    const out = await runSignOut(s)
    expect(out).toMatchObject({ status: 'failed', step: 'logout' })
    if (out.status !== 'failed') throw new Error('unreachable')
    expect(out.title).toBe('You are still signed in on this device.')
    expect(out.detail).toContain('Your other sessions were ended')
  })

  it('the client posts POST /api/auth/sessions/revoke-all with no body; its 404 becomes "unsupported"', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return String(url).endsWith('/revoke-all')
        ? Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 })
        : new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const api = createApiClient({ fetchImpl })
    const marks = createSignedOutMarks(() => memoryStorage())
    const out = await runSignOut({
      mode: 'everywhere',
      revokeAll: api.revokeAllSessions,
      logout: api.logout,
      endClerkSession: null,
      marks,
    })
    expect(out.status).toBe('unsupported')
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(['POST /api/auth/sessions/revoke-all'])
    expect(calls[0]?.init.body).toBeUndefined()
    expect(calls[0]?.init.credentials).toBe('same-origin')
  })
})

describe('the Clerk sign-in gate (SCA-1): no auto-exchange after an explicit sign-out', () => {
  const live = { loaded: true, signedIn: true, confirmed: false, failed: false }

  it('after "Sign out", a still-live Clerk session waits for "Continue as <name>"', () => {
    expect(clerkSignInView({ ...live, explicitSignOut: true })).toBe('confirm')
    expect(clerkSignInView({ ...live, explicitSignOut: true, confirmed: true })).toBe('exchange')
  })

  it('without an explicit sign-out (an expired session, a first visit) the exchange stays automatic', () => {
    expect(clerkSignInView({ ...live, explicitSignOut: false })).toBe('exchange')
  })

  it('loading, the Clerk form and errors are unaffected by the mark', () => {
    for (const explicitSignOut of [true, false]) {
      expect(clerkSignInView({ ...live, explicitSignOut, loaded: false })).toBe('loading')
      expect(clerkSignInView({ ...live, explicitSignOut, signedIn: false })).toBe('form')
      expect(clerkSignInView({ ...live, explicitSignOut, confirmed: true, failed: true })).toBe('error')
    }
  })

  it('the shared-computer scenario: sign out with Clerk unreachable, the next visitor gets a click, not a session', async () => {
    const tab = memoryStorage()
    const { s } = steps({ clerk: 'fail', storage: tab })
    await runSignOut(s)
    // The sign-in page of the same tab (after a reload too) reads the mark; Clerk is still signed in.
    const mark = createSignedOutMarks(() => tab).read()
    expect(mark?.clerk).toBe('failed')
    expect(clerkSignInView({ ...live, explicitSignOut: mark !== null })).toBe('confirm')
  })

  it('names the Clerk account: full name, else username, else email', () => {
    expect(clerkAccountLabel({ fullName: 'Dana Rivera', username: 'dana' })).toBe('Dana Rivera')
    expect(clerkAccountLabel({ fullName: '  ', username: 'dana' })).toBe('dana')
    expect(clerkAccountLabel({ fullName: null, primaryEmailAddress: { emailAddress: 'd@x.co' } })).toBe(
      'd@x.co',
    )
    expect(clerkAccountLabel(null)).toBe('your account')
  })
})
