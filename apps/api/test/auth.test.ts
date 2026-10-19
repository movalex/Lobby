import { AuthConfig, FORMAT_SWITCHES_OFF, Me, WORKER_CAPABILITIES } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClerkAuthProvider } from '../src/auth/clerk.ts'
import { sha256hex } from '../src/auth/session.ts'
import { createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from './helpers.ts'

let api: TestApi
beforeEach(async () => {
  api = await createTestApi()
})
afterEach(() => api.close())

describe('dev sign-in', () => {
  it('creates the user with a personal workspace; the first user owns Dev Studio, later ones are members', async () => {
    const alice = await api.login('alice', 'Alice A')
    expect(Me.parse(alice.me)).toEqual(alice.me)
    expect(alice.me.user).toMatchObject({ name: 'Alice A', handle: 'alice', avatarUrl: null })
    expect(alice.me.user.color).toMatch(/^#[0-9a-f]{6}$/)
    const byName = (ws: { name: string; role: string }[]) =>
      ws.map((w) => [w.name, w.role]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))
    expect(byName(alice.me.workspaces)).toEqual([
      ["Alice A's workspace", 'owner'],
      ['Dev Studio', 'owner'],
    ])
    expect(alice.me.workspaces.find((w) => w.name === 'Dev Studio')?.id).toBe(DEV_STUDIO)
    const bob = await api.login('bob')
    expect(byName(bob.me.workspaces)).toEqual([
      ["bob's workspace", 'owner'],
      ['Dev Studio', 'member'],
    ])
    expect(bob.personalWorkspaceId).not.toBe(alice.personalWorkspaceId)
  })

  it('logging in again is the same user, keeps its workspaces and color, and updates the name', async () => {
    const first = await api.login('alice')
    const again = await api.login('alice', 'Alice Renamed')
    expect(again.userId).toBe(first.userId)
    expect(again.me.user.color).toBe(first.me.user.color)
    expect(again.me.user.name).toBe('Alice Renamed')
    expect(again.me.workspaces.map((w) => w.id)).toEqual(first.me.workspaces.map((w) => w.id))
    expect((await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM users')).n).toBe(1)
  })

  it('gives each user a deterministic color derived from the handle', async () => {
    const a = await api.login('alice')
    const other = await createTestApi()
    try {
      const a2 = await other.login('alice')
      expect(a2.me.user.color).toBe(a.me.user.color)
    } finally {
      await other.close()
    }
  })

  it('rejects invalid handles', async () => {
    for (const handle of ['Alice', 'a b', '', 'x'.repeat(33)]) {
      const res = await api.anon('POST', '/api/auth/dev/login', { handle })
      expect(res.statusCode, handle).toBe(400)
      expect(res.json().error.code).toBe('BAD_REQUEST')
    }
  })

  it('sets an HttpOnly, SameSite=Lax, 30-day cookie and stores only its sha256', async () => {
    const res = await api.anon('POST', '/api/auth/dev/login', { handle: 'alice' })
    const cookie = res.cookies.find((c) => c.name === 'dr_session')
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' })
    expect(cookie?.secure).toBeFalsy() // PUBLIC_ORIGIN is http in tests
    expect(cookie?.maxAge).toBe(30 * 24 * 60 * 60)
    const value = cookie?.value ?? ''
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const rows = (await api.db.query<{ id_hash: string }>('SELECT id_hash FROM sessions')).rows
    expect(rows.map((r) => r.id_hash)).toEqual([sha256hex(value)])
    expect(rows[0]?.id_hash).not.toContain(value)
  })

  it('marks the cookie Secure when PUBLIC_ORIGIN is https', async () => {
    const https = await createTestApi({ env: { PUBLIC_ORIGIN: 'https://draftroom.example' } })
    try {
      const res = await https.anon(
        'POST',
        '/api/auth/dev/login',
        { handle: 'alice' },
        { origin: 'https://draftroom.example' },
      )
      expect(res.statusCode).toBe(200)
      expect(res.cookies.find((c) => c.name === 'dr_session')?.secure).toBe(true)
      // The http dev origin is now foreign.
      expect((await https.anon('POST', '/api/auth/dev/login', { handle: 'bob' })).statusCode).toBe(403)
    } finally {
      await https.close()
    }
  })

  it('a second login in the same browser revokes the previous session', async () => {
    const alice = await api.login('alice')
    const res = await api.anon('POST', '/api/auth/dev/login', { handle: 'bob' }, { cookie: alice.cookie })
    expect(res.statusCode).toBe(200)
    expect((await alice.req('GET', '/api/me')).statusCode).toBe(401)
  })
})

describe('sessions', () => {
  it('GET /api/me: 401 without a session, 200 with one', async () => {
    expect((await api.anon('GET', '/api/me')).statusCode).toBe(401)
    const alice = await api.login('alice')
    const res = await alice.req('GET', '/api/me')
    expect(res.statusCode).toBe(200)
    expect(Me.parse(res.json()).user.id).toBe(alice.userId)
  })

  it('logout returns 204, revokes the session server-side and clears the cookie', async () => {
    const alice = await api.login('alice')
    const out = await alice.req('POST', '/api/auth/logout')
    expect(out.statusCode).toBe(204)
    const cleared = out.cookies.find((c) => c.name === 'dr_session')
    expect(cleared?.value).toBe('')
    // The old cookie value is dead even if a client keeps sending it.
    expect((await alice.req('GET', '/api/me')).statusCode).toBe(401)
    const row = await api.db.one<{ revoked_at: Date | null }>('SELECT revoked_at FROM sessions')
    expect(row.revoked_at).toBeInstanceOf(Date)
    // Logging out again (or without a session) is not an error.
    expect((await alice.req('POST', '/api/auth/logout')).statusCode).toBe(204)
    expect((await api.anon('POST', '/api/auth/logout')).statusCode).toBe(204)
  })

  it('sessions expire after 30 days', async () => {
    const alice = await api.login('alice')
    api.clock.advance(29 * 24 * 60 * 60 * 1000)
    expect((await alice.req('GET', '/api/me')).statusCode).toBe(200)
    api.clock.advance(2 * 24 * 60 * 60 * 1000)
    expect((await alice.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it('ignores malformed or unknown cookies', async () => {
    for (const cookie of ['dr_session=nope', `dr_session=${'A'.repeat(43)}`, 'other=1']) {
      expect((await api.anon('GET', '/api/me', undefined, { cookie })).statusCode).toBe(401)
    }
  })
})

describe('CSRF', () => {
  it('refuses mutations without an Origin or with a foreign Origin (403), before doing anything', async () => {
    const alice = await api.login('alice')
    const url = `/api/workspaces/${alice.personalWorkspaceId}/boards`
    const noOrigin = await api.app.inject({
      method: 'POST',
      url,
      payload: { title: 'x' },
      headers: { cookie: alice.cookie },
    })
    expect(noOrigin.statusCode).toBe(403)
    expect(noOrigin.json().error.code).toBe('FORBIDDEN')
    const foreign = await alice.req('POST', url, { title: 'x' }, { origin: 'https://evil.example' })
    expect(foreign.statusCode).toBe(403)
    const sameHostOtherPort = await alice.req(
      'POST',
      url,
      { title: 'x' },
      { origin: 'http://127.0.0.1:5999' },
    )
    expect(sameHostOtherPort.statusCode).toBe(403)
    expect((await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')).n).toBe(0)
    // Logout and login are mutations too.
    const logout = await api.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: alice.cookie },
    })
    expect(logout.statusCode).toBe(403)
    expect((await alice.req('GET', '/api/me')).statusCode).toBe(200)
    const login = await api.app.inject({
      method: 'POST',
      url: '/api/auth/dev/login',
      payload: { handle: 'eve' },
    })
    expect(login.statusCode).toBe(403)
  })

  it('reads (GET) do not need an Origin', async () => {
    const alice = await api.login('alice')
    const res = await api.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: alice.cookie } })
    expect(res.statusCode).toBe(200)
  })

  it('accepts only JSON bodies (or none): form and text bodies are 415', async () => {
    const alice = await api.login('alice')
    const url = `/api/workspaces/${alice.personalWorkspaceId}/boards`
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      const res = await alice.req('POST', url, 'title=x', { 'content-type': type })
      expect(res.statusCode, type).toBe(415)
    }
    const bad = await alice.req('POST', url, '{nope', { 'content-type': 'application/json' })
    expect(bad.statusCode).toBe(400)
    // A bodyless POST with a JSON content type is treated as "no body".
    const empty = await alice.req('POST', '/api/auth/logout', '', { 'content-type': 'application/json' })
    expect(empty.statusCode).toBe(204)
  })
})

describe('auth config and rate limit', () => {
  it('GET /api/auth/config names the dev provider', async () => {
    const res = await api.anon('GET', '/api/auth/config')
    expect(AuthConfig.parse(res.json())).toEqual({
      providers: ['dev'],
      designPreviews: false,
      live: { activities: false, joinCodes: false, breakouts: false },
      formats: FORMAT_SWITCHES_OFF,
    })
  })

  it('GET /api/auth/config tells the web whether design files are previewed (DRAFTROOM_DESIGN_PREVIEWS)', async () => {
    const on = await createTestApi({ env: { DRAFTROOM_DESIGN_PREVIEWS: 'on' } })
    try {
      expect(AuthConfig.parse((await on.anon('GET', '/api/auth/config')).json())).toEqual({
        providers: ['dev'],
        designPreviews: true,
        live: { activities: false, joinCodes: false, breakouts: false },
        formats: FORMAT_SWITCHES_OFF,
      })
    } finally {
      await on.close()
    }
    for (const value of ['off', '']) {
      const off = await createTestApi({ env: { DRAFTROOM_DESIGN_PREVIEWS: value } })
      try {
        expect((await off.anon('GET', '/api/auth/config')).json()).toMatchObject({ designPreviews: false })
      } finally {
        await off.close()
      }
    }
  })

  it('GET /api/auth/config offers the wave W features: doc cards and admin by their switch, the worker-backed three only with a capable worker seen in 10 min', async () => {
    let now = new Date('2026-10-19T12:00:00Z')
    const on = await createTestApi({
      env: {
        DRAFTROOM_DOC_CARDS: 'on',
        DRAFTROOM_REMOVE_BACKGROUND: 'on',
        DRAFTROOM_FILE_SEARCH: 'on',
        DRAFTROOM_DECK_IMPORT: 'off',
        DRAFTROOM_WORKSPACE_ADMIN: 'on',
      },
      deps: { now: () => now },
    })
    try {
      const formats = async () => AuthConfig.parse((await on.anon('GET', '/api/auth/config')).json()).formats
      // no worker has reported anything: only the two switch-only features
      expect(await formats()).toEqual({
        docCards: true,
        removeBackground: false,
        fileSearch: false,
        deckImport: false,
        admin: true,
      })
      // a worker reports remove-bg and render-pages (deck import is off) and an OLD extract-text capability
      await on.db.query(
        `INSERT INTO worker_capabilities_seen (capability, last_seen_at, worker_id)
         VALUES ($1, $4, 'nas-1'), ($2, $4, 'nas-1'), ($3, $4, 'nas-1')`,
        [WORKER_CAPABILITIES['remove-bg'], WORKER_CAPABILITIES['render-pages'], 'extract-text:old@1', now],
      )
      now = new Date(now.getTime() + 20_000) // past the 15 s cache
      expect(await formats()).toEqual({
        docCards: true,
        removeBackground: true,
        fileSearch: false,
        deckImport: false,
        admin: true,
      })
      // ten minutes later without a claim, the worker counts as gone
      now = new Date(now.getTime() + 10 * 60_000)
      expect((await formats())?.removeBackground).toBe(false)
    } finally {
      await on.close()
    }
  })

  it('GET /api/auth/config tells the web which wave V features run (DRAFTROOM_LIVE_ACTIVITIES, _JOIN_CODES, _BREAKOUTS)', async () => {
    const on = await createTestApi({
      env: { DRAFTROOM_LIVE_ACTIVITIES: 'on', DRAFTROOM_JOIN_CODES: 'off', DRAFTROOM_BREAKOUTS: 'ON' },
    })
    try {
      expect(AuthConfig.parse((await on.anon('GET', '/api/auth/config')).json()).live).toEqual({
        activities: true,
        joinCodes: false,
        breakouts: true,
      })
    } finally {
      await on.close()
    }
  })

  it('rate-limits sign-in attempts', async () => {
    const limited = await createTestApi({ deps: { authRateLimit: { max: 3, timeWindow: 60_000 } } })
    try {
      const codes: number[] = []
      for (let i = 0; i < 5; i++)
        codes.push((await limited.anon('POST', '/api/auth/dev/login', { handle: `u${i}` })).statusCode)
      expect(codes).toEqual([200, 200, 200, 429, 429])
      const res = await limited.anon('POST', '/api/auth/dev/login', { handle: 'u9' })
      expect(res.json()).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } })
    } finally {
      await limited.close()
    }
  })

  it('without the dev provider, the dev login route does not exist', async () => {
    const clerk = await createTestApi({
      deps: {
        authProvider: createClerkAuthProvider({
          secretKey: 'sk_test_unused',
          publishableKey: 'pk_test_unused',
          publicOrigin: ORIGIN,
          deps: {
            verify: async () => ({ sub: 'user_x' }),
            profile: async () => ({ name: 'X', avatarUrl: null, emails: [] }),
          },
        }),
      },
    })
    try {
      expect((await clerk.anon('POST', '/api/auth/dev/login', { handle: 'alice' })).statusCode).toBe(404)
      expect(AuthConfig.parse((await clerk.anon('GET', '/api/auth/config')).json())).toEqual({
        providers: ['clerk'],
        clerkPublishableKey: 'pk_test_unused',
        designPreviews: false,
        live: { activities: false, joinCodes: false, breakouts: false },
        formats: FORMAT_SWITCHES_OFF,
      })
    } finally {
      await clerk.close()
    }
  })
})

describe('clerk provider (UNVERIFIED against real Clerk; exercised with a fake verifier)', () => {
  const tokens: Record<string, string> = {
    'good-token-1': 'user_clerk1',
    'good-token-2': 'user_clerk2',
    'outside-token': 'user_clerk3',
  }
  // Domain access: verified addresses (docs/DOMAIN-ACCESS-CONTRACTS.md §11.3). Fake local parts only.
  const emailOf: Record<string, string> = {
    user_clerk1: 'lobby-test-alice@darkburn.com',
    user_clerk2: 'lobby-test-bob@darkburn.com',
    user_clerk3: 'pat@client.example.test',
  }
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
              const sub = tokens[token]
              if (!sub) throw new Error('invalid')
              return { sub }
            },
            profile: async (sub) => ({
              name: `Name of ${sub}`,
              avatarUrl: 'https://img.example/a.png',
              emails: [{ email: emailOf[sub] ?? '', isPrimary: true, strategy: 'email_code' }],
            }),
          },
        }),
      },
    })
  })
  afterEach(() => clerk.close())

  const exchange = (token?: string) =>
    clerk.anon(
      'POST',
      '/api/auth/clerk/session',
      undefined,
      token ? { authorization: `Bearer ${token}` } : {},
    )

  it('maps the Clerk subject to one internal user, auto-provisioned with a personal workspace', async () => {
    const res = await exchange('good-token-1')
    expect(res.statusCode).toBe(200)
    const me = Me.parse(res.json())
    expect(me.user).toMatchObject({
      name: 'Name of user_clerk1',
      handle: null,
      avatarUrl: 'https://img.example/a.png',
    })
    expect(me.workspaces).toEqual([expect.objectContaining({ role: 'owner' })])
    expect(res.cookies.some((c) => c.name === 'dr_session')).toBe(true)
    const again = Me.parse((await exchange('good-token-1')).json())
    expect(again.user.id).toBe(me.user.id)
    const identity = await clerk.db.one('SELECT provider, subject, user_id FROM identities')
    expect(identity).toEqual({ provider: 'clerk', subject: 'user_clerk1', user_id: me.user.id })
    expect(Me.parse((await exchange('good-token-2')).json()).user.id).not.toBe(me.user.id)
  })

  it('an account without a creator address signs in as an outsider: no workspace, access "outside"', async () => {
    const res = await exchange('outside-token')
    expect(res.statusCode, res.body).toBe(200)
    const me = Me.parse(res.json())
    expect(me.workspaces).toEqual([])
    expect(me.access).toEqual({ creator: false, reason: 'outside', email: 'pat@client.example.test' })
    const creator = Me.parse((await exchange('good-token-1')).json())
    expect(creator.access).toEqual({
      creator: true,
      reason: 'domain',
      email: 'lobby-test-alice@darkburn.com',
    })
    expect((await clerk.db.one<{ n: number }>('SELECT count(*)::int AS n FROM workspaces')).n).toBe(1)
  })

  it('rejects missing and invalid tokens with 401 and issues no session', async () => {
    expect((await exchange()).statusCode).toBe(401)
    const bad = await exchange('forged')
    expect(bad.statusCode).toBe(401)
    expect(bad.cookies.some((c) => c.name === 'dr_session')).toBe(false)
    expect((await clerk.db.one<{ n: number }>('SELECT count(*)::int AS n FROM users')).n).toBe(0)
  })
})
