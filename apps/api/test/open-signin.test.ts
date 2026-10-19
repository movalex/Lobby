// Open email sign-in and partner boards (docs/OPEN-SIGNIN.md): the provider, the shared workspace,
// the partner route's guard and idempotence, and the config rules that keep it off every other server.

import { AuthConfig, Me, PartnerBoard } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEmailAuthProvider } from '../src/auth/email.ts'
import { type GoogleIdentity, GoogleTokenError } from '../src/auth/google-id-token.ts'
import { SHARED_OWNER_ID, SHARED_WORKSPACE_ID } from '../src/auth/shared-workspace.ts'
import { loadConfig } from '../src/config.ts'
import {
  createTestApi,
  INTERNAL_SECRET,
  ORIGIN,
  type TestApi,
  TICKET_SECRET,
  testEnv,
  WORKER_TOKEN,
} from './helpers.ts'

const PARTNER_TOKEN = 'test-partner-token-0123456789abcdefghijkl'
const OPEN_ENV = {
  DRAFTROOM_DEV_AUTH: '0',
  AUTH_PROVIDER: 'email',
  DRAFTROOM_OPEN_SIGNIN: '1',
  DRAFTROOM_SHARED_WORKSPACE_NAME: 'Banzerini House',
  DRAFTROOM_PARTNER_TOKEN: PARTNER_TOKEN,
}

interface EmailClient {
  me: Me
  userId: string
  req(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown): Promise<LightMyRequestResponse>
}

let api: TestApi
beforeEach(async () => {
  api = await createTestApi({ env: OPEN_ENV })
})
afterEach(() => api.close())

async function emailLogin(email: string, name: string): Promise<EmailClient> {
  const res = await api.anon('POST', '/api/auth/email/login', { email, name })
  if (res.statusCode !== 200) throw new Error(`email login failed: ${res.statusCode} ${res.body}`)
  const cookie = res.cookies.find((c) => c.name === 'dr_session')
  if (!cookie) throw new Error('no session cookie')
  const me = Me.parse(res.json())
  return {
    me,
    userId: me.user.id,
    req: (method, url, body) => api.anon(method, url, body, { cookie: `dr_session=${cookie.value}` }),
  }
}

const partner = (ref: string, body: unknown, headers: Record<string, string> = {}) =>
  api.app.inject({
    method: 'PUT',
    url: `/api/partner/boards/${ref}`,
    payload: body as object,
    // No Origin: a server-to-server call (the Origin check exempts the partner prefix).
    headers: { authorization: `Bearer ${PARTNER_TOKEN}`, ...headers },
  })

describe('open email sign-in', () => {
  it('advertises the email provider and the shared workspace name', async () => {
    const res = await api.anon('GET', '/api/auth/config')
    expect(res.statusCode).toBe(200)
    expect(AuthConfig.parse(res.json())).toEqual({
      providers: ['email'],
      sharedWorkspaceName: 'Banzerini House',
      openSigninMethods: ['email'],
      designPreviews: false,
      live: { activities: false, joinCodes: false, breakouts: false },
    })
  })

  it('signs anyone in with an address and a name: a creator in the shared workspace, no personal one', async () => {
    const dana = await emailLogin('Dana@Example.com', 'Dana Rivera')
    expect(dana.me.user).toMatchObject({ name: 'Dana Rivera', handle: null })
    expect(dana.me.access).toEqual({ creator: true, reason: 'domain', email: 'dana@example.com' })
    expect(dana.me.workspaces).toEqual([{ id: SHARED_WORKSPACE_ID, name: 'Banzerini House', role: 'member' }])

    // The same address (any case) is the same account; the name follows the latest sign-in.
    const again = await emailLogin('dana@example.com', 'Dana R.')
    expect(again.userId).toBe(dana.userId)
    expect(again.me.user.name).toBe('Dana R.')
    expect(again.me.workspaces.map((w) => w.id)).toEqual([SHARED_WORKSPACE_ID])

    const sam = await emailLogin('sam@another.test', 'Sam')
    expect(sam.userId).not.toBe(dana.userId)
    expect(sam.me.workspaces).toEqual([{ id: SHARED_WORKSPACE_ID, name: 'Banzerini House', role: 'member' }])
  })

  it('stays a creator after the 24-hour grace period (the refresh only re-stamps)', async () => {
    const dana = await emailLogin('dana@example.com', 'Dana')
    api.clock.advance(25 * 60 * 60 * 1000)
    const me = await dana.req('GET', '/api/me')
    expect(me.statusCode).toBe(200)
    // GET /api/me gives a creator without one a personal workspace, except under open sign-in.
    expect((me.json() as Me).workspaces.map((w) => w.id)).toEqual([SHARED_WORKSPACE_ID])
    await api.identity.settled()
    const create = await dana.req('POST', `/api/workspaces/${SHARED_WORKSPACE_ID}/boards`, { title: 'Ideas' })
    expect(create.statusCode).toBe(201)
  })

  it('refuses a missing name, a bad address and the dev route', async () => {
    expect(
      (await api.anon('POST', '/api/auth/email/login', { email: 'a@b.test', name: '  ' })).statusCode,
    ).toBe(400)
    expect(
      (await api.anon('POST', '/api/auth/email/login', { email: 'not-an-email', name: 'A' })).statusCode,
    ).toBe(400)
    expect(
      (await api.anon('POST', '/api/auth/email/login', { email: 'a+clerk_test@b.test', name: 'A' }))
        .statusCode,
    ).toBe(400)
    expect((await api.anon('POST', '/api/auth/dev/login', { handle: 'alice' })).statusCode).toBe(404)
  })

  it('members create boards in the shared workspace (private until shared, like any board)', async () => {
    const dana = await emailLogin('dana@example.com', 'Dana')
    const sam = await emailLogin('sam@example.com', 'Sam')
    const create = await dana.req('POST', `/api/workspaces/${SHARED_WORKSPACE_ID}/boards`, {
      title: 'Set ideas',
    })
    expect(create.statusCode).toBe(201)
    const id = (create.json() as { id: string }).id
    expect((await sam.req('GET', `/api/boards/${id}`)).statusCode).toBe(404)
    const share = await dana.req('PATCH', `/api/boards/${id}`, { visibility: 'workspace_edit' })
    expect(share.statusCode).toBe(200)
    const seen = await sam.req('GET', `/api/boards/${id}`)
    expect(seen.statusCode).toBe(200)
    expect(seen.json()).toMatchObject({ role: 'editor' })
  })
})

// Wave J's outsider features on the theater (docs/OPEN-SIGNIN.md): the open lookup makes everyone who
// signs in a creator, so nobody there is "External", no board is "Shared outside" because of who signs
// in, the owner hears no "outsider joined", the Share dialog asks no outside confirm, and the built-in
// owner of the shared workspace (it never signs in) neither reads 'unconfirmed' nor makes every board's
// composer start "Team only". Name-only guests stay guests.
describe('wave J outside markers under open sign-in', () => {
  it('labels nobody outside: tags, shared outside, the joined notice, the address check, team only', async () => {
    const dana = await emailLogin('dana@example.com', 'Dana')
    const sam = await emailLogin('sam@another.test', 'Sam')
    const create = await dana.req('POST', `/api/workspaces/${SHARED_WORKSPACE_ID}/boards`, { title: 'Set' })
    expect(create.statusCode).toBe(201)
    const id = (create.json() as { id: string }).id
    expect((await dana.req('PATCH', `/api/boards/${id}`, { visibility: 'workspace_edit' })).statusCode).toBe(
      200,
    )

    // Sam opens it (a ticket): the owner hears nothing.
    expect((await sam.req('POST', `/api/boards/${id}/ticket`)).statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 200))
    const joined = await api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'outsider_joined'",
    )
    expect(joined.n).toBe(0)

    // The board's outside people and the "Shared outside" marker, for a manager and for an editor.
    for (const c of [dana, sam]) {
      const outside = await c.req('GET', `/api/boards/${id}/sharing/outside`)
      expect(outside.statusCode, outside.body).toBe(200)
      expect(outside.json()).toMatchObject({ sharedOutside: false, people: [] })
    }
    const list = await dana.req('GET', `/api/workspaces/${SHARED_WORKSPACE_ID}/boards`)
    const listed = (list.json() as { boards: { id: string; sharedOutside?: boolean }[] }).boards
    expect(listed.find((b) => b.id === id)?.sharedOutside).toBe(false)

    // The people picker (a manager of the board): every member, the built-in owner included, is inside.
    const members = await dana.req('GET', `/api/workspaces/${SHARED_WORKSPACE_ID}/members?boardId=${id}`)
    expect(members.statusCode, members.body).toBe(200)
    const outsideOf = Object.fromEntries(
      (members.json() as { members: { user: { id: string }; outside?: unknown }[] }).members.map((m) => [
        m.user.id,
        m.outside,
      ]),
    )
    expect(outsideOf).toEqual({ [SHARED_OWNER_ID]: false, [dana.userId]: false, [sam.userId]: false })

    // The Share dialog's address check: any address is inside (everyone who signs in is a creator).
    const check = await dana.req('POST', `/api/boards/${id}/sharing/address-check`, {
      email: 'new.person@elsewhere.test',
    })
    expect(check.statusCode, check.body).toBe(200)
    expect(check.json()).toMatchObject({ outside: false, internalOnly: null })

    // Comments: no author is External, and the composer does not start "Team only".
    const posted = await sam.req('POST', `/api/boards/${id}/threads`, {
      anchor: { kind: 'point', x: 0, y: 0 },
      body: 'Hello',
    })
    expect(posted.statusCode, posted.body).toBe(201)
    const threads = await dana.req('GET', `/api/boards/${id}/threads`)
    const body = threads.json() as {
      threads: { comments: { author: { external?: boolean } }[] }[]
      privacy: { teamOnly: boolean; teamOnlyDefault: boolean }
    }
    expect(body.threads.flatMap((t) => t.comments).map((c) => c.author.external)).toEqual([false])
    expect(body.privacy).toEqual({ teamOnly: true, teamOnlyDefault: false })
  })

  it('display names lose control, bidi and zero-width characters on input (J1-8)', async () => {
    const eve = await emailLogin('eve@example.com', 'Eve‮ nimdA​')
    expect(eve.me.user.name).toBe('Eve nimdA')
    const invisible = await api.anon('POST', '/api/auth/email/login', { email: 'x@example.com', name: '​‮' })
    expect(invisible.statusCode).toBe(400)
  })

  it('feedback: anyone signed in sends it, nobody reads the inbox through the app (J5)', async () => {
    const dana = await emailLogin('dana@example.com', 'Dana')
    const sent = await dana.req('POST', '/api/feedback', { text: 'The stage plot is upside down' })
    expect(sent.statusCode, sent.body).toBe(201)
    expect((await dana.req('GET', '/api/feedback/access')).json()).toEqual({ admin: false })
    expect((await dana.req('GET', '/api/feedback')).statusCode).toBe(404)
  })

  it('a sign-in on a shared computer ends the previous person’s session, and the sync hears it (J3 RT-01)', async () => {
    const first = await api.anon('POST', '/api/auth/email/login', { email: 'dana@example.com', name: 'Dana' })
    const cookie = first.cookies.find((c) => c.name === 'dr_session')?.value
    const danaId = (first.json() as Me).user.id
    const board = await api.anon(
      'POST',
      `/api/workspaces/${SHARED_WORKSPACE_ID}/boards`,
      { title: 'Notes' },
      { cookie: `dr_session=${cookie}` },
    )
    expect(board.statusCode).toBe(201)
    const boardId = (board.json() as { id: string }).id
    api.sessionEnds.length = 0
    const next = await api.anon(
      'POST',
      '/api/auth/email/login',
      { email: 'sam@example.com', name: 'Sam' },
      { cookie: `dr_session=${cookie}` },
    )
    expect(next.statusCode).toBe(200)
    expect(api.sessionEnds).toEqual([danaId])
    const access = await api.app.inject({
      method: 'GET',
      url: `/internal/access?boardId=${boardId}&userId=${danaId}`,
      headers: { 'x-draftroom-internal': INTERNAL_SECRET },
    })
    expect(access.json()).toMatchObject({ role: 'owner', signedInSince: null })
  })
})

describe('partner boards', () => {
  it('creates the board for a key once, then returns the same one (renaming it when the title changed)', async () => {
    const first = await partner('theaitre:production:42', { title: 'James and the Giant Peach' })
    expect(first.statusCode).toBe(201)
    const board = PartnerBoard.parse(first.json())
    expect(board).toMatchObject({
      ref: 'theaitre:production:42',
      title: 'James and the Giant Peach',
      created: true,
    })
    expect(board.url).toBe(`${ORIGIN}/b/${board.boardId}`)

    const again = await partner('theaitre:production:42', { title: 'James and the Giant Peach' })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ boardId: board.boardId, created: false })

    const renamed = await partner('theaitre:production:42', { title: 'James & the Giant Peach' })
    expect(renamed.json()).toMatchObject({ boardId: board.boardId, title: 'James & the Giant Peach' })

    const other = await partner('theaitre:production:43', { title: 'Frog and Toad' })
    expect(other.statusCode).toBe(201)
    expect((other.json() as PartnerBoard).boardId).not.toBe(board.boardId)
  })

  it('two first calls for one key at once make one board', async () => {
    const [a, b] = await Promise.all([
      partner('theaitre:production:7', { title: 'Seven' }),
      partner('theaitre:production:7', { title: 'Seven' }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201])
    expect((a.json() as PartnerBoard).boardId).toBe((b.json() as PartnerBoard).boardId)
  })

  it('every signed-in person edits a partner board; nobody but its built-in owner can trash it', async () => {
    const { boardId } = PartnerBoard.parse(
      (await partner('theaitre:production:42', { title: 'Peach' })).json(),
    )
    const dana = await emailLogin('dana@example.com', 'Dana')
    const opened = await dana.req('GET', `/api/boards/${boardId}`)
    expect(opened.statusCode).toBe(200)
    expect(opened.json()).toMatchObject({
      role: 'editor',
      board: { visibility: 'workspace_edit', title: 'Peach' },
    })
    expect((await dana.req('POST', `/api/boards/${boardId}/ticket`)).statusCode).toBe(200)
    expect((await dana.req('POST', `/api/boards/${boardId}/trash`)).statusCode).toBe(403)
    const owner = await api.db.one<{ user_id: string }>(
      "SELECT user_id FROM board_members WHERE board_id = $1 AND role = 'owner'",
      [boardId],
    )
    expect(owner.user_id).toBe(SHARED_OWNER_ID)
    const list = await dana.req('GET', `/api/workspaces/${SHARED_WORKSPACE_ID}/boards`)
    expect((list.json() as { boards: { id: string }[] }).boards.map((b) => b.id)).toContain(boardId)
  })

  it('refuses no token, a wrong token, a browser cookie and a bad key', async () => {
    const body = { title: 'Peach' }
    const none = await api.app.inject({ method: 'PUT', url: '/api/partner/boards/x1', payload: body })
    expect(none.statusCode).toBe(401)
    expect(none.headers['www-authenticate']).toBe('Bearer')
    expect((await partner('x1', body, { authorization: `Bearer ${WORKER_TOKEN}` })).statusCode).toBe(401)
    const dana = await emailLogin('dana@example.com', 'Dana')
    const withCookie = await dana.req('PUT', '/api/partner/boards/x1', body)
    expect(withCookie.statusCode).toBe(403)
    expect((await partner('x1', body, { cookie: 'dr_session=abc' })).statusCode).toBe(403)
    expect((await partner('Has-Capitals', body)).statusCode).toBe(400)
    expect((await partner('x1', { title: '' })).statusCode).toBe(400)
    const count = await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')
    expect(count.n).toBe(0)
  })
})

describe('open sign-in configuration', () => {
  const env = (extra: Record<string, string>) => testEnv('/tmp/dr-open-config', extra)

  it('needs the explicit flag, and the flag and its settings need the email provider', () => {
    expect(() => loadConfig(env({ DRAFTROOM_DEV_AUTH: '0', AUTH_PROVIDER: 'email' }))).toThrow(
      /requires DRAFTROOM_OPEN_SIGNIN=1/,
    )
    expect(() => loadConfig(env({ DRAFTROOM_OPEN_SIGNIN: '1' }))).toThrow(/requires AUTH_PROVIDER=email/)
    expect(() => loadConfig(env({ DRAFTROOM_PARTNER_TOKEN: PARTNER_TOKEN }))).toThrow(
      /DRAFTROOM_PARTNER_TOKEN requires AUTH_PROVIDER=email/,
    )
    expect(() => loadConfig(env({ DRAFTROOM_SHARED_WORKSPACE_NAME: 'X' }))).toThrow(
      /requires AUTH_PROVIDER=email/,
    )
    expect(() => loadConfig(env({ ...OPEN_ENV, DRAFTROOM_OPEN_SIGNIN: 'yes' }))).toThrow(/must be 1/)
  })

  it('refuses feedback inbox readers (J5): their addresses could not be verified', () => {
    expect(() => loadConfig(env({ ...OPEN_ENV, DRAFTROOM_FEEDBACK_ADMINS: 'lead@example.com' }))).toThrow(
      /DRAFTROOM_FEEDBACK_ADMINS needs a provider that verifies addresses/,
    )
    expect(loadConfig(env({ ...OPEN_ENV, DRAFTROOM_FEEDBACK_ADMINS: '' })).feedbackAdmins).toEqual([])
  })

  it('keeps the partner token apart from every other secret', () => {
    for (const same of [TICKET_SECRET, INTERNAL_SECRET, WORKER_TOKEN])
      expect(() => loadConfig(env({ ...OPEN_ENV, DRAFTROOM_PARTNER_TOKEN: same }))).toThrow(/must differ/)
    expect(() => loadConfig(env({ ...OPEN_ENV, DRAFTROOM_PARTNER_TOKEN: 'short' }))).toThrow(/at least/)
  })

  it('is allowed in production, and partner routes exist only with a token', () => {
    const config = loadConfig(env({ ...OPEN_ENV, DRAFTROOM_PARTNER_TOKEN: '' }))
    expect(config.openSignin).toEqual({
      workspaceName: 'Banzerini House',
      partnerToken: null,
      methods: ['email'],
      googleClientId: null,
    })
    expect(config.authProvider).toBe('email')
  })

  it('has no partner routes without a token', async () => {
    const without = await createTestApi({ env: { ...OPEN_ENV, DRAFTROOM_PARTNER_TOKEN: '' } })
    try {
      const res = await without.app.inject({
        method: 'PUT',
        url: '/api/partner/boards/x1',
        payload: { title: 'Peach' },
        headers: { authorization: `Bearer ${PARTNER_TOKEN}`, origin: ORIGIN },
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await without.close()
    }
  })
})

describe('open sign-in with Google', () => {
  const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com'
  const GOOGLE_ENV = {
    ...OPEN_ENV,
    DRAFTROOM_OPEN_SIGNIN_METHODS: 'google',
    DRAFTROOM_GOOGLE_CLIENT_ID: CLIENT_ID,
  }
  // Stands in for Google: "good:<email>:<name>" verifies, anything else is refused.
  const fakeVerify = async (credential: string): Promise<GoogleIdentity> => {
    const [kind, email, name] = credential.split(':')
    if (kind !== 'good' || !email) throw new GoogleTokenError('bad signature')
    return { sub: `sub-${email}`, email, name: name || null }
  }
  const withGoogle = (methods: ('email' | 'google')[], env: Record<string, string>) =>
    createTestApi({
      env,
      deps: {
        authProvider: createEmailAuthProvider({
          workspaceName: 'Banzerini House',
          methods,
          googleClientId: CLIENT_ID,
          verifyGoogle: fakeVerify,
        }),
      },
    })
  const googleLogin = (t: TestApi, credential: string) =>
    t.anon('POST', '/api/auth/google/login', { credential })

  it('Google only: the page is told to show the Google button; the typed-address route is gone', async () => {
    const g = await withGoogle(['google'], GOOGLE_ENV)
    try {
      expect(AuthConfig.parse((await g.anon('GET', '/api/auth/config')).json())).toEqual({
        providers: ['email'],
        sharedWorkspaceName: 'Banzerini House',
        openSigninMethods: ['google'],
        googleClientId: CLIENT_ID,
        designPreviews: false,
        live: { activities: false, joinCodes: false, breakouts: false },
      })
      expect(
        (await g.anon('POST', '/api/auth/email/login', { email: 'a@b.test', name: 'A' })).statusCode,
      ).toBe(404)
      const res = await googleLogin(g, 'good:Dana.Rivera@gmail.com:Dana Rivera')
      expect(res.statusCode).toBe(200)
      const me = Me.parse(res.json())
      expect(me.user.name).toBe('Dana Rivera')
      expect(me.access).toEqual({ creator: true, reason: 'domain', email: 'dana.rivera@gmail.com' })
      expect(me.workspaces).toEqual([{ id: SHARED_WORKSPACE_ID, name: 'Banzerini House', role: 'member' }])
      expect(res.cookies.some((c) => c.name === 'dr_session')).toBe(true)
    } finally {
      await g.close()
    }
  })

  it('a refused token is a 401 with no session; a missing name falls back to the address', async () => {
    const g = await withGoogle(['google'], GOOGLE_ENV)
    try {
      const refused = await googleLogin(g, 'forged')
      expect(refused.statusCode).toBe(401)
      expect(refused.json()).toMatchObject({ error: { code: 'GOOGLE_SIGN_IN_FAILED' } })
      expect(refused.cookies.some((c) => c.name === 'dr_session')).toBe(false)
      expect((await g.anon('POST', '/api/auth/google/login', {})).statusCode).toBe(400)
      const noName = Me.parse((await googleLogin(g, 'good:sam@school.example:')).json())
      expect(noName.user.name).toBe('sam')
    } finally {
      await g.close()
    }
  })

  it('a Google profile name is cleaned like a typed one (wave J, J1-8)', async () => {
    const g = await withGoogle(['google'], GOOGLE_ENV)
    try {
      expect(Me.parse((await googleLogin(g, 'good:dana@gmail.com:Dana‮ Rivera')).json()).user.name).toBe(
        'Dana Rivera',
      )
      expect(Me.parse((await googleLogin(g, 'good:sam@school.example:​')).json()).user.name).toBe('sam')
    } finally {
      await g.close()
    }
  })

  it('both ways in: the same address is the same account', async () => {
    const g = await withGoogle(['email', 'google'], {
      ...GOOGLE_ENV,
      DRAFTROOM_OPEN_SIGNIN_METHODS: 'email,google',
    })
    try {
      const typed = await g.anon('POST', '/api/auth/email/login', { email: 'dana@example.com', name: 'Dana' })
      const viaGoogle = await googleLogin(g, 'good:Dana@Example.com:Dana R.')
      expect(Me.parse(viaGoogle.json()).user.id).toBe(Me.parse(typed.json()).user.id)
    } finally {
      await g.close()
    }
  })

  it('configuration: google needs a client id, a client id needs google, methods are email/google only', () => {
    const env = (extra: Record<string, string>) => testEnv('/tmp/dr-open-google', { ...OPEN_ENV, ...extra })
    expect(
      loadConfig(env({ DRAFTROOM_OPEN_SIGNIN_METHODS: 'google', DRAFTROOM_GOOGLE_CLIENT_ID: CLIENT_ID }))
        .openSignin,
    ).toMatchObject({ methods: ['google'], googleClientId: CLIENT_ID })
    expect(() => loadConfig(env({ DRAFTROOM_OPEN_SIGNIN_METHODS: 'google' }))).toThrow(
      /needs DRAFTROOM_GOOGLE_CLIENT_ID/,
    )
    expect(() =>
      loadConfig(
        env({ DRAFTROOM_OPEN_SIGNIN_METHODS: 'google', DRAFTROOM_GOOGLE_CLIENT_ID: 'not-a-client-id' }),
      ),
    ).toThrow(/needs DRAFTROOM_GOOGLE_CLIENT_ID/)
    expect(() => loadConfig(env({ DRAFTROOM_GOOGLE_CLIENT_ID: CLIENT_ID }))).toThrow(
      /does not include google/,
    )
    expect(() => loadConfig(env({ DRAFTROOM_OPEN_SIGNIN_METHODS: 'facebook' }))).toThrow(
      /email and\/or google/,
    )
    expect(() =>
      loadConfig(testEnv('/tmp/dr-open-google', { DRAFTROOM_OPEN_SIGNIN_METHODS: 'google' })),
    ).toThrow(/requires AUTH_PROVIDER=email/)
  })
})
