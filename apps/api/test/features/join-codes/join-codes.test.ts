// Wave V (V2, WS3): a workshop link's short join code (docs/WAVE-V-CONTRACTS.md §3). Made by creators who manage the
// board's access, stored only as its sha256, shown to whom the link's URL is shown, resolved by anyone with it to the
// link's token while the link is open, and one 404 for everything else (no oracle); rate limited; behind
// DRAFTROOM_JOIN_CODES; never in a log line or an audit row.
import {
  formatJoinCode,
  JOIN_CODE_LOOKUPS_GLOBAL,
  JOIN_CODE_LOOKUPS_PER_ADDRESS,
  JOIN_CODE_PATTERN,
  JoinCodeResponse,
  ListInvitationsResponse,
  ResolvedJoinCode,
  ReviewLinkCreated,
} from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { reviewLinkToken } from '../../../src/features/dashboard/review-links.ts'
import {
  deriveJoinCode,
  joinCodeHash,
  sameCode,
  storedJoinCode,
} from '../../../src/features/join-codes/code.ts'
import { joinCodeLookupSettings } from '../../../src/features/join-codes/index.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  ORIGIN,
  type TestApi,
  TICKET_SECRET,
} from '../../helpers.ts'

const ON = { DRAFTROOM_JOIN_CODES: 'on' }
const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }

interface World {
  api: TestApi
  logs: string[]
  alice: Client // Dev Studio owner, a creator
  bob: Client // a member, owner of `board`, a creator
  carol: Client // a member with no access to `board`
  erin: Client // a creator outside Dev Studio
  board: string
}

const apis: TestApi[] = []
const dbs: Db[] = []
const settings = structuredClone(joinCodeLookupSettings)
afterEach(async () => {
  Object.assign(joinCodeLookupSettings, structuredClone(settings))
  for (const a of apis.splice(0)) await a.close()
  for (const d of dbs.splice(0)) await d.close()
})

async function world(env: Record<string, string> = ON, db?: Db): Promise<World> {
  const logs: string[] = []
  const api = await createTestApi({
    env,
    ...(db ? { db } : {}),
    deps: { logger: { level: 'trace', stream: { write: (l: string) => void logs.push(l) } } },
  })
  apis.push(api)
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  const board = await createBoard(bob, DEV_STUDIO, 'Workshop')
  return { api, logs, alice, bob, carol, erin, board }
}

async function link(c: Client, board: string, body: Record<string, unknown> = {}) {
  const res = await c.req('POST', `/api/boards/${board}/review-links`, {
    role: 'editor',
    allowGuests: true,
    ...body,
  })
  expect(res.statusCode, res.body).toBe(201)
  return ReviewLinkCreated.parse(res.json())
}
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)
const askCode = (c: Client, board: string, id: string) =>
  c.req('POST', `/api/boards/${board}/review-links/${id}/code`)
const resolve = (api: TestApi, code: string, ip = '10.40.0.1') =>
  api.app.inject({ method: 'GET', url: `/api/join/${encodeURIComponent(code)}`, remoteAddress: ip })

let ipSeq = 0
const freshIp = () => `10.41.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`

describe('the code (pure)', () => {
  it('is derived from the link id and the bump, 8 Crockford characters; another id or bump gives another code', () => {
    const a = deriveJoinCode(TICKET_SECRET, 'inv_0123456789abcdefghij', 0)
    expect(a).toMatch(JOIN_CODE_PATTERN)
    expect(deriveJoinCode(TICKET_SECRET, 'inv_0123456789abcdefghij', 0)).toBe(a)
    expect(deriveJoinCode(TICKET_SECRET, 'inv_0123456789abcdefghij', 1)).not.toBe(a)
    expect(deriveJoinCode(TICKET_SECRET, 'inv_0123456789abcdefghik', 0)).not.toBe(a)
    expect(deriveJoinCode(`${TICKET_SECRET}x`, 'inv_0123456789abcdefghij', 0)).not.toBe(a)
    expect(joinCodeHash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(sameCode(a, a)).toBe(true)
    expect(sameCode(a, `${a.slice(0, 7)}0` === a ? `${a.slice(0, 7)}1` : `${a.slice(0, 7)}0`)).toBe(false)
    expect(sameCode(a, a.slice(0, 7))).toBe(false)
    const row = { id: 'inv_0123456789abcdefghij', join_code_hash: joinCodeHash(a), join_code_n: 0 }
    expect(storedJoinCode(TICKET_SECRET, row)).toBe(a)
    // a rotated ticket secret: the stored hash is no longer this link's derivation, so it has no code
    expect(storedJoinCode('another-secret-0123456789abcdefghijkl', row)).toBeNull()
    expect(storedJoinCode(TICKET_SECRET, { ...row, join_code_hash: null })).toBeNull()
  })
})

describe('making a code', () => {
  it('a new workshop link comes with its code (creator); only its sha256 is stored, nowhere the code itself', async () => {
    const w = await world()
    const l = await link(w.bob, w.board)
    expect(l.joinCode).toBeDefined()
    const jc = l.joinCode ?? { code: '', display: '', joinUrl: '', expiresAt: '' }
    expect(jc.code).toMatch(JOIN_CODE_PATTERN)
    expect(jc.code).toBe(deriveJoinCode(TICKET_SECRET, l.id, 0))
    expect(jc.display).toBe(formatJoinCode(jc.code))
    expect(jc.joinUrl).toBe(`${ORIGIN}/j/${jc.code}`)
    expect(jc.expiresAt).toBe(l.expiresAt)
    const row = await w.api.db.one<{ h: string; n: number; all: string }>(
      'SELECT join_code_hash AS h, join_code_n AS n, row_to_json(i)::text AS all FROM invitations i WHERE id = $1',
      [l.id],
    )
    expect(row).toMatchObject({ h: joinCodeHash(jc.code), n: 0 })
    expect(row.all).not.toContain(jc.code)
    const audits = await w.api.db.query<{ t: string }>('SELECT row_to_json(a)::text AS t FROM audit_events a')
    for (const a of audits.rows) expect(a.t).not.toContain(jc.code)
  })

  it('POST …/code is idempotent (the same code again); the list shows it to creators who manage access, beside the URL', async () => {
    const w = await world()
    const l = await link(w.bob, w.board)
    const first = await askCode(w.bob, w.board, l.id)
    expect(first.statusCode, first.body).toBe(200)
    const again = JoinCodeResponse.parse((await askCode(w.bob, w.board, l.id)).json())
    expect(JoinCodeResponse.parse(first.json())).toEqual(again)
    expect(again.joinCode).toEqual(l.joinCode)
    const list = ListInvitationsResponse.parse(
      (await w.bob.req('GET', `/api/boards/${w.board}/invitations`)).json(),
    ).invitations
    expect(list.find((i) => i.id === l.id)?.joinCode).toEqual(l.joinCode)
  })

  it('a link made before the switch (or one whose code was cleared) gets its code on first ask, then keeps it', async () => {
    const w = await world()
    const l = await link(w.bob, w.board)
    await w.api.db.query('UPDATE invitations SET join_code_hash = NULL WHERE id = $1', [l.id])
    const list = ListInvitationsResponse.parse(
      (await w.bob.req('GET', `/api/boards/${w.board}/invitations`)).json(),
    ).invitations
    expect(list.find((i) => i.id === l.id)?.joinCode).toBeUndefined()
    const made = JoinCodeResponse.parse((await askCode(w.bob, w.board, l.id)).json())
    expect(made.joinCode.code).toBe(deriveJoinCode(TICKET_SECRET, l.id, 0))
    const audit = await w.api.db.query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_events WHERE action = 'invitation.update' AND target = $1",
      [l.id],
    )
    expect(audit.rows.map((r) => r.detail)).toEqual([{ boardId: w.board, multiUse: true, joinCode: true }])
  })

  it('a collision with another link’s code bumps n (and the code still resolves to this link)', async () => {
    const w = await world()
    const l = await link(w.bob, w.board)
    const other = await link(w.bob, w.board)
    await w.api.db.query('UPDATE invitations SET join_code_hash = NULL WHERE id = $1', [l.id])
    // the other link holds what would be this link's n = 0 code
    await w.api.db.query('UPDATE invitations SET join_code_hash = $2 WHERE id = $1', [
      other.id,
      joinCodeHash(deriveJoinCode(TICKET_SECRET, l.id, 0)),
    ])
    const made = JoinCodeResponse.parse((await askCode(w.bob, w.board, l.id)).json())
    expect(made.joinCode.code).toBe(deriveJoinCode(TICKET_SECRET, l.id, 1))
    expect(
      (await w.api.db.one<{ n: number }>('SELECT join_code_n AS n FROM invitations WHERE id = $1', [l.id])).n,
    ).toBe(1)
    const res = await resolve(w.api, made.joinCode.code)
    expect(ResolvedJoinCode.parse(res.json()).token).toBe(tokenOf(l.url))
  })

  it('only a workshop link has one: a review link gets none and its code route is 404; a closed link is 404', async () => {
    const w = await world()
    const review = await link(w.bob, w.board, { role: 'commenter' })
    expect(review.joinCode).toBeUndefined()
    expect((await askCode(w.bob, w.board, review.id)).json()).toEqual(UNKNOWN)
    const list = ListInvitationsResponse.parse(
      (await w.bob.req('GET', `/api/boards/${w.board}/invitations`)).json(),
    ).invitations
    expect(list.find((i) => i.id === review.id)?.joinCode).toBeUndefined()
    // the database refuses a code on a review link too (0038's scope CHECK)
    await expect(
      w.api.db.query('UPDATE invitations SET join_code_hash = $2 WHERE id = $1', [review.id, 'a'.repeat(64)]),
    ).rejects.toThrow()
    const revoked = await link(w.bob, w.board)
    await w.bob.req('POST', `/api/boards/${w.board}/review-links/${revoked.id}/revoke`, {})
    const r1 = await askCode(w.bob, w.board, revoked.id)
    expect(r1.statusCode).toBe(404)
    const expiring = await link(w.bob, w.board, { expiresInHours: 1 })
    w.api.clock.advance(2 * 60 * 60_000)
    expect((await askCode(w.bob, w.board, expiring.id)).statusCode).toBe(404)
    expect((await askCode(w.bob, w.board, 'inv_Nonexistent0000000000')).statusCode).toBe(404)
    expect((await askCode(w.bob, w.board, 'not-an-id')).statusCode).toBe(404)
  })

  it('who may: the creator who manages the board; not an editor, a member without access, an outsider, a guest or anonymous', async () => {
    const w = await world()
    const l = await link(w.bob, w.board)
    // carol: an editor of the board (cannot manage access)
    expect(
      (await w.bob.req('PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'editor' }))
        .statusCode,
    ).toBe(200)
    const asEditor = await askCode(w.carol, w.board, l.id)
    expect(asEditor.statusCode).toBe(403)
    // erin: outside the workspace
    expect((await askCode(w.erin, w.board, l.id)).statusCode).toBe(404)
    // a guest who joined through the link: refused before any board check
    const joined = await w.api.app.inject({
      method: 'POST',
      url: `/api/invitations/${tokenOf(l.url)}/guest`,
      payload: { name: 'Gia' },
      headers: { origin: ORIGIN },
      remoteAddress: freshIp(),
    })
    expect(joined.statusCode, joined.body).toBe(201)
    const cookie = `dr_session=${joined.cookies.find((c) => c.name === 'dr_session')?.value}`
    const asGuest = await w.api.anon('POST', `/api/boards/${w.board}/review-links/${l.id}/code`, undefined, {
      cookie,
    })
    expect(asGuest.statusCode).toBe(403)
    expect(asGuest.json().error.code).toBe('GUEST_ACCOUNT_REQUIRED')
    // anonymous
    expect((await w.api.anon('POST', `/api/boards/${w.board}/review-links/${l.id}/code`)).statusCode).toBe(
      401,
    )
    // a manager who is not a creator: CREATOR_REQUIRED (the creation matrix covers it for every route)
    const pat = await w.api.login('pat', 'Pat', { email: 'pat@client.example.test' })
    await w.api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())`,
      [DEV_STUDIO, pat.userId],
    )
    await w.api.db.query(
      `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $3, now())`,
      [w.board, pat.userId, w.bob.userId],
    )
    const asPat = await askCode(pat, w.board, l.id)
    expect(asPat.statusCode).toBe(403)
    expect(asPat.json().error.code).toBe('CREATOR_REQUIRED')
    // and pat's list carries neither the URL nor the code
    const list = ListInvitationsResponse.parse(
      (await pat.req('GET', `/api/boards/${w.board}/invitations`)).json(),
    )
    const row = list.invitations.find((i) => i.id === l.id)
    expect(row?.url).toBeNull()
    expect(row?.joinCode).toBeUndefined()
  })
})

describe('resolving a code', () => {
  it('anyone with it (no session) gets the link’s token, in any case, with or without the dash, I/L as 1 and O as 0; then joins with a name', async () => {
    const w = await world()
    const l = await link(w.bob, w.board)
    const code = l.joinCode?.code ?? ''
    for (const typed of [
      code,
      formatJoinCode(code),
      code.toLowerCase(),
      ` ${formatJoinCode(code).toLowerCase()} `,
    ]) {
      const res = await resolve(w.api, typed)
      expect(res.statusCode, typed).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(ResolvedJoinCode.parse(res.json()).token).toBe(tokenOf(l.url))
    }
    // Crockford's look-alikes
    const lookAlike = code.replace(/1/g, 'l').replace(/0/g, 'o')
    expect((await resolve(w.api, lookAlike)).statusCode).toBe(200)
    // and the token joins
    const token = ResolvedJoinCode.parse((await resolve(w.api, code)).json()).token
    const joined = await w.api.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/guest`,
      payload: { name: 'Phone' },
      headers: { origin: ORIGIN },
      remoteAddress: freshIp(),
    })
    expect(joined.statusCode, joined.body).toBe(201)
  })

  it('one 404 (the unknown route’s body) for an unknown, malformed, expired, revoked, swept code and a rotated ticket secret', async () => {
    const w = await world()
    const never = await w.api.anon('GET', '/api/wave-v-never-was')
    expect(never.json()).toEqual(UNKNOWN)
    const answers: unknown[] = []
    const add = async (code: string) => {
      const res = await resolve(w.api, code, freshIp())
      answers.push({ status: res.statusCode, body: res.json() })
    }
    await add('ZZZZ-ZZZZ')
    await add('ABCU-2345') // U is no Crockford character
    await add('short')
    await add('x'.repeat(40))
    const revoked = await link(w.bob, w.board)
    await w.bob.req('POST', `/api/boards/${w.board}/review-links/${revoked.id}/revoke`, {
      removeAccess: false,
    })
    await add(revoked.joinCode?.code ?? '')
    const expiring = await link(w.bob, w.board, { expiresInHours: 1 })
    w.api.clock.advance(61 * 60_000)
    await add(expiring.joinCode?.code ?? '')
    // a code that matches no derivation any more (another ticket secret): an api over the same database
    const open = await link(w.bob, w.board)
    const rotated = await createTestApi({
      db: w.api.db,
      env: { ...ON, DRAFTROOM_TICKET_SECRET: 'rotated-ticket-secret-0123456789abcdefgh' },
    })
    apis.push(rotated)
    const res = await resolve(rotated, open.joinCode?.code ?? '')
    answers.push({ status: res.statusCode, body: res.json() })
    for (const a of answers) expect(a).toEqual({ status: 404, body: UNKNOWN })
    // the open link still resolves on the api with its own secret
    expect((await resolve(w.api, open.joinCode?.code ?? '', freshIp())).statusCode).toBe(200)
  })

  it(`per address: ${JOIN_CODE_LOOKUPS_PER_ADDRESS.max} misses in 10 minutes, then every lookup from it is 429 (a good code too); good lookups never count; other addresses are not held`, async () => {
    const w = await world()
    const l = await link(w.bob, w.board)
    const good = l.joinCode?.code ?? ''
    const office = '10.42.0.1'
    // a room behind one address resolving the good code: never held to the 30
    for (let i = 0; i < JOIN_CODE_LOOKUPS_PER_ADDRESS.max + 20; i++)
      expect((await resolve(w.api, good, office)).statusCode).toBe(200)
    const guesser = '10.42.0.2'
    for (let i = 0; i < JOIN_CODE_LOOKUPS_PER_ADDRESS.max; i++)
      expect((await resolve(w.api, `ZZZZ${String(i).padStart(4, '0')}`, guesser)).statusCode).toBe(404)
    for (const code of ['ZZZZ-9999', good]) {
      const res = await resolve(w.api, code, guesser)
      expect(res.statusCode, code).toBe(429)
      expect(res.json().error.code).toBe('RATE_LIMITED')
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
      expect(res.body).not.toContain(good)
    }
    // an IPv6 client counts by its /64
    for (let i = 0; i < JOIN_CODE_LOOKUPS_PER_ADDRESS.max; i++)
      await resolve(w.api, 'ZZZZ-ZZZZ', `2001:db8:5:6::${(i + 1).toString(16)}`)
    expect((await resolve(w.api, good, '2001:db8:5:6:ffff::1')).statusCode).toBe(429)
    expect((await resolve(w.api, good, '2001:db8:5:7::1')).statusCode).toBe(200)
    // the office is not held by the guesser, and the guesser is free again after 10 minutes
    expect((await resolve(w.api, good, office)).statusCode).toBe(200)
    w.api.clock.advance(JOIN_CODE_LOOKUPS_PER_ADDRESS.windowMs + 1_000)
    expect((await resolve(w.api, good, guesser)).statusCode).toBe(200)
  })

  it(`globally: ${JOIN_CODE_LOOKUPS_GLOBAL.max} lookups a minute over every address (shrunk here), then 429`, async () => {
    expect(JOIN_CODE_LOOKUPS_GLOBAL).toEqual({ max: 600, windowMs: 60_000 })
    expect(JOIN_CODE_LOOKUPS_PER_ADDRESS).toEqual({ max: 30, windowMs: 10 * 60_000 })
    joinCodeLookupSettings.global = { max: 5, windowMs: 60_000 }
    const w = await world()
    const good = (await link(w.bob, w.board)).joinCode?.code ?? ''
    for (let i = 0; i < 5; i++) expect((await resolve(w.api, good, freshIp())).statusCode).toBe(200)
    const refused = await resolve(w.api, good, freshIp())
    expect(refused.statusCode).toBe(429)
    w.api.clock.advance(61_000)
    expect((await resolve(w.api, good, freshIp())).statusCode).toBe(200)
  })
})

describe('the switch and the logs', () => {
  it('off: no code is made, none is shown, and both routes are the unknown route, though the database still holds a code', async () => {
    const db = await openTestDb()
    dbs.push(db)
    const on = await world(ON, db)
    const l = await link(on.bob, on.board)
    const code = l.joinCode?.code ?? ''
    expect(code).toMatch(JOIN_CODE_PATTERN)
    const off = await createTestApi({ db, env: {} })
    apis.push(off)
    const bob = await off.login('bob')
    expect((await resolve(off, code)).json()).toEqual(UNKNOWN)
    const ask = await bob.req('POST', `/api/boards/${on.board}/review-links/${l.id}/code`)
    expect(ask.statusCode).toBe(404)
    expect(ask.json()).toEqual(UNKNOWN)
    const list = ListInvitationsResponse.parse(
      (await bob.req('GET', `/api/boards/${on.board}/invitations`)).json(),
    )
    expect(list.invitations.find((i) => i.id === l.id)?.joinCode).toBeUndefined()
    const fresh = ReviewLinkCreated.parse(
      (
        await bob.req('POST', `/api/boards/${on.board}/review-links`, { role: 'editor', allowGuests: true })
      ).json(),
    )
    expect(fresh.joinCode).toBeUndefined()
    expect(
      (
        await db.one<{ h: string | null }>('SELECT join_code_hash AS h FROM invitations WHERE id = $1', [
          fresh.id,
        ])
      ).h,
    ).toBeNull()
    // the full invite URL still works without join codes
    expect(fresh.url).toBe(`${ORIGIN}/invite/${reviewLinkToken(TICKET_SECRET, fresh.id)}`)
  })

  it('no log line carries a code, through making, listing, resolving and a refused lookup', async () => {
    const w = await world()
    const l = await link(w.bob, w.board)
    const code = l.joinCode?.code ?? ''
    await askCode(w.bob, w.board, l.id)
    await w.bob.req('GET', `/api/boards/${w.board}/invitations`)
    await resolve(w.api, code)
    await resolve(w.api, formatJoinCode(code).toLowerCase())
    await resolve(w.api, 'ZZZZ-ZZZZ')
    expect(w.logs.length).toBeGreaterThan(0)
    for (const line of w.logs) {
      expect(line).not.toContain(code)
      expect(line).not.toContain(formatJoinCode(code))
      expect(line.toLowerCase()).not.toContain(code.toLowerCase())
    }
  })
})
