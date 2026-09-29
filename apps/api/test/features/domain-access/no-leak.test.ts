// Nothing leaks (docs/DOMAIN-ACCESS-CONTRACTS.md §4.4, §14 item 5; §11.1 no-leak.test.ts): the api log
// stream, audit_events.detail, every error body and every User-shaped JSON carry no test address, no
// exception address, no unmasked invited address and no accept token. me.user has exactly the five
// User keys.

import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type ClerkWorld, clerkError, clerkUser, clerkWorld, fakeClerk } from './clerk-fake.ts'

vi.mock('@clerk/backend', async () => (await import('./clerk-fake.ts')).clerkBackendModule)

const USER_KEYS = ['avatarUrl', 'color', 'handle', 'id', 'name']
const ADDRESSES = [
  'pat@client.example.test',
  'sam@client.example.test',
  'owner@personal.example.test',
  'lobby-test-a@darkburn.com',
]

/** Every User-shaped object in a JSON body (anything with id + color + avatarUrl). */
function users(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const v of value) users(v, out)
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if ('id' in o && 'color' in o && 'avatarUrl' in o) out.push(o)
    for (const v of Object.values(o)) users(v, out)
  }
  return out
}

describe('no leaks (dev provider)', () => {
  let api: TestApi
  let logs: string[]
  const errors: string[] = []
  const bodies: unknown[] = []
  const track = async (p: Promise<LightMyRequestResponse>) => {
    const res = await p
    if (res.statusCode >= 400) errors.push(res.body)
    else if (res.body) bodies.push(res.json())
    return res
  }

  beforeEach(async () => {
    logs = []
    errors.length = 0
    bodies.length = 0
    api = await createTestApi({
      env: { DRAFTROOM_CREATOR_EMAILS: 'owner@personal.example.test' },
      deps: { logger: { level: 'debug', stream: { write: (l: string) => void logs.push(l) } } },
    })
  })
  afterEach(() => api.close())

  it('logs, audit rows, error bodies and User JSON carry no address and no token', async () => {
    const alice = await api.login('alice')
    const pat = await api.login('pat', 'Pat', { email: 'Pat@Client.Example.Test' })
    const sam = await api.login('sam', 'Sam', { email: 'sam@client.example.test' })
    const owner = await api.login('owner', 'Owner', { email: 'owner@personal.example.test' })
    const dom = await api.login('dom', 'Dom', { email: 'lobby-test-a@darkburn.com' })
    for (const c of [alice, pat, sam, owner, dom]) bodies.push(c.me.user)
    await api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())`,
      [DEV_STUDIO, pat.userId],
    )
    const board = await createBoard(alice, DEV_STUDIO, 'Leaks')

    // Refusals (logged, never with an address).
    await track(pat.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'x' }))
    await track(pat.req('POST', `/api/boards/${board}/review-links`, { role: 'viewer' }))
    await track(
      alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
        role: 'admin',
        email: 'sam@client.example.test',
      }),
    )
    await track(
      alice.req('POST', `/api/boards/${board}/invitations`, { role: 'viewer', email: 'x+clerk_test@a.test' }),
    )

    // A locked invitation: previewed, refused for the wrong account, accepted by the invitee.
    const created = await alice.req('POST', `/api/boards/${board}/invitations`, {
      role: 'editor',
      email: 'sam@client.example.test',
    })
    const token = String(created.json().url).split('/').pop() ?? ''
    await track(api.anon('GET', `/api/invitations/${token}`))
    await track(pat.req('GET', `/api/invitations/${token}`))
    const mismatch = await track(pat.req('POST', `/api/invitations/${token}/accept`))
    expect(mismatch.statusCode).toBe(403)
    expect((await track(sam.req('POST', `/api/invitations/${token}/accept`))).statusCode).toBe(200)
    await track(pat.req('POST', `/api/invitations/${token}/accept`)) // 410 now

    // The email route (its logs carry a domain and a keyed hash only).
    await alice.req('POST', `/api/boards/${board}/invitations/email`, {
      role: 'viewer',
      email: 'pat@client.example.test',
    })

    // Everything that returns users.
    for (const c of [alice, pat, sam, owner, dom]) {
      await track(c.req('GET', '/api/me'))
      await track(c.req('GET', '/api/auth/me'))
    }
    await track(alice.req('GET', `/api/boards/${board}/members`))
    await track(sam.req('GET', `/api/boards/${board}/members`))
    await track(alice.req('GET', `/api/boards/${board}/sharing/members`))
    await track(alice.req('GET', `/api/workspaces/${DEV_STUDIO}/members`))
    await api.identity.settled()

    // me.user: exactly the five User keys; no User object anywhere carries more.
    const found = users(bodies)
    expect(found.length).toBeGreaterThan(10)
    for (const u of found) expect(Object.keys(u).sort()).toEqual(USER_KEYS)

    const audit = (await api.db.query<{ detail: unknown }>('SELECT detail FROM audit_events')).rows
      .map((r) => JSON.stringify(r.detail))
      .join('\n')
    const texts: [string, string][] = [
      ['logs', logs.join('\n')],
      ['audit', audit],
      ['errors', errors.join('\n')],
      ['users', JSON.stringify(found)],
    ]
    for (const [where, text] of texts) {
      for (const address of ADDRESSES)
        expect(text.toLowerCase(), `${where}: ${address}`).not.toContain(address)
      expect(text, `${where}: token`).not.toContain(token)
    }
    // The refusal and mismatch logs are there, with domains only.
    const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.find((l) => l.evt === 'creator.refused')).toMatchObject({
      userId: pat.userId,
      emailDomains: ['client.example.test'],
    })
    expect(lines.find((l) => l.evt === 'invitation.email_mismatch')).toMatchObject({
      userId: pat.userId,
      invitedDomain: 'client.example.test',
      callerDomains: ['client.example.test'],
    })
    // The accept route is logged by its pattern.
    expect(lines.some((l) => l.route === '/api/invitations/:token/accept')).toBe(true)
  })

  it('the full invited address appears in exactly one response: the manager-only pending list', async () => {
    const alice = await api.login('alice')
    const board = await createBoard(alice, DEV_STUDIO, 'Pending')
    const created = await alice.req('POST', `/api/boards/${board}/invitations`, {
      role: 'viewer',
      email: 'pat@client.example.test',
    })
    expect(created.body).not.toContain('pat@')
    const token = String(created.json().url).split('/').pop() ?? ''
    expect((await api.anon('GET', `/api/invitations/${token}`)).body).not.toContain('pat@')
    expect((await alice.req('GET', `/api/boards/${board}/invitations`)).body).toContain(
      'pat@client.example.test',
    )
    expect((await alice.req('GET', `/api/boards/${board}/sharing`)).body).not.toContain('pat@')
  })
})

describe('no leaks (Clerk)', () => {
  let w: ClerkWorld
  beforeEach(async () => {
    fakeClerk.reset()
    w = await clerkWorld()
  })
  afterEach(() => w.api.close())

  it('Clerk failures (whose messages quote addresses) never reach a log or a body', async () => {
    fakeClerk.failures.set('user_new', () => clerkError(500, 'internal', 'boom for pat@client.example.test'))
    const refused = await w.exchange('user_new')
    expect(refused.statusCode).toBe(503)
    expect(refused.body).not.toContain('pat@')
    clerkUser('user_a', ['lobby-test-a@darkburn.com'])
    const a = await w.signIn('user_a')
    w.api.clock.advance(25 * 60 * 60 * 1000)
    fakeClerk.failures.set('user_a', () =>
      clerkError(502, 'bad_gateway', 'lobby-test-a@darkburn.com unreachable'),
    )
    const me = await a.req('GET', '/api/me')
    expect(me.statusCode).toBe(200)
    expect(Object.keys(me.json().user).sort()).toEqual(USER_KEYS)
    await w.api.identity.settled()
    const all = w.logs.join('\n')
    for (const address of ADDRESSES) expect(all).not.toContain(address)
    expect(all).not.toContain('unreachable')
    expect(all).not.toContain('boom')
  })
})
