// Wave M (M7-1, CAP-SYNC-RECHECK): POST /internal/access-many, the sync's batched access re-check. One request
// per recheck round answers every (board, user) pair the way GET /internal/access answers it, with the
// person's `signedInSince` (RT-01) once per person, in two queries whatever the number of pairs. The sync half
// (one call per round, the 404 fallback to the per-pair route, jitter) is apps/sync/src/access*.test.ts.
//
// On PGlite here; the real-Postgres twin (the query count on a pg.Pool) is access-many.pg.test.ts.

import {
  ACCESS_MANY_MAX_PAIRS,
  ACCESS_MANY_PATH,
  type AccessManyPair,
  AccessManyResponse,
} from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_TTL_MS } from '../src/auth/session.ts'
import { counting } from './access-many-support.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
  TICKET_SECRET,
} from './helpers.ts'

let api: TestApi | undefined
let base: Db | undefined
afterEach(async () => {
  await api?.close()
  await base?.close()
  api = undefined
  base = undefined
})

const SECRET_HEADER = 'x-draftroom-internal'

async function many(
  a: TestApi,
  pairs: unknown,
  headers: Record<string, string> = { [SECRET_HEADER]: INTERNAL_SECRET },
) {
  return a.app.inject({ method: 'POST', url: ACCESS_MANY_PATH, payload: { pairs } as object, headers })
}

async function single(a: TestApi, boardId: string, userId: string) {
  const res = await a.app.inject({
    method: 'GET',
    url: `/internal/access?boardId=${boardId}&userId=${userId}`,
    headers: { [SECRET_HEADER]: INTERNAL_SECRET },
  })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as { role: string | null; signedInSince: number | null }
}

describe('POST /internal/access-many: authorization and limits', () => {
  it('needs the internal secret: none, a wrong one, the ticket secret or a session cookie get 401 and nothing is read', async () => {
    api = await createTestApi()
    const bob = await api.login('bob')
    const board = await createBoard(bob, DEV_STUDIO, 'B')
    const pairs = [{ boardId: board, userId: bob.userId }]
    const refusedHeaders: Record<string, string>[] = [
      {},
      { [SECRET_HEADER]: 'x'.repeat(INTERNAL_SECRET.length) },
      { [SECRET_HEADER]: TICKET_SECRET },
      { cookie: bob.cookie },
    ]
    for (const headers of refusedHeaders) {
      const res = await many(api, pairs, headers)
      expect(res.statusCode, JSON.stringify(headers)).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'NOT_AUTHENTICATED', message: 'Internal credentials required.' },
      })
      expect(res.body).not.toContain(bob.userId)
    }
    // a foreign Origin without the secret: the secret guard answers first (401, not the CSRF 403)
    const foreign = await many(api, pairs, { origin: 'https://evil.example' })
    expect(foreign.statusCode).toBe(401)
    // the route is registered (no longer pending) and answers with the secret; it is server to server, so the
    // web-Origin check does not apply (no Origin at all, as the sync sends it, or any other one)
    expect(api.app.hasRoute({ method: 'POST', url: ACCESS_MANY_PATH })).toBe(true)
    expect((await many(api, pairs)).statusCode).toBe(200)
    expect(
      (await many(api, pairs, { [SECRET_HEADER]: INTERNAL_SECRET, origin: 'https://evil.example' }))
        .statusCode,
    ).toBe(200)
    // the exemption is this route's only: another POST without the web origin is still refused
    const other = await api.app.inject({
      method: 'POST',
      url: `/api/boards/${board}/ticket`,
      headers: { cookie: bob.cookie, [SECRET_HEADER]: INTERNAL_SECRET },
    })
    expect(other.statusCode).toBe(403)
  })

  it(`takes 1 to ${ACCESS_MANY_MAX_PAIRS} well-formed pairs (400 otherwise), and answers each in order, a repeated pair each time`, async () => {
    api = await createTestApi()
    const bob = await api.login('bob')
    const board = await createBoard(bob, DEV_STUDIO, 'B')
    const pair = { boardId: board, userId: bob.userId }
    const atCap = Array.from({ length: ACCESS_MANY_MAX_PAIRS }, () => pair)
    const ok = await many(api, atCap)
    expect(ok.statusCode, ok.body).toBe(200)
    const body = AccessManyResponse.parse(ok.json())
    expect(body.results).toHaveLength(ACCESS_MANY_MAX_PAIRS)
    expect(new Set(body.results.map((r) => r.role))).toEqual(new Set(['owner']))
    expect(Object.keys(body.signedInSince)).toEqual([bob.userId])
    for (const bad of [
      [...atCap, pair], // one over the cap
      [],
      [{ boardId: 'Not_A_Board!', userId: bob.userId }],
      [{ boardId: board, userId: 'alice' }],
      [{ ...pair, extra: 1 }],
      'pairs',
    ]) {
      const res = await many(api, bad)
      expect(res.statusCode, JSON.stringify(bad).slice(0, 80)).toBe(400)
      expect(res.json().error.code).toBe('BAD_REQUEST')
    }
    const noBody = await api.app.inject({
      method: 'POST',
      url: ACCESS_MANY_PATH,
      headers: { [SECRET_HEADER]: INTERNAL_SECRET },
    })
    expect(noBody.statusCode).toBe(400)
  })
})

describe('POST /internal/access-many: the same answers as GET /internal/access', () => {
  it('for every pair: grants, visibility, archived, trashed, unknown boards and people, and RT-01 signedInSince', async () => {
    api = await createTestApi()
    const alice = await api.login('alice') // Dev Studio owner
    const bob = await api.login('bob', 'Bob B')
    const carol = await api.login('carol')
    const dave = await api.login('dave')
    const erin = await api.login('erin')
    const live = await createBoard(bob, DEV_STUDIO, 'Live')
    const open = await createBoard(bob, DEV_STUDIO, 'Open')
    const archived = await createBoard(bob, DEV_STUDIO, 'Archived')
    const trashed = await createBoard(bob, DEV_STUDIO, 'Trashed')
    await bob.req('PUT', `/api/boards/${live}/members/${carol.userId}`, { role: 'commenter' })
    await bob.req('PATCH', `/api/boards/${open}`, { visibility: 'workspace_view' })
    await bob.req('PUT', `/api/boards/${archived}/members/${carol.userId}`, { role: 'editor' })
    await bob.req('POST', `/api/boards/${archived}/archive`)
    await bob.req('POST', `/api/boards/${trashed}/trash`)
    // dave signs out everywhere: still granted nothing, and signed in nowhere (null)
    expect((await dave.req('POST', '/api/auth/sessions/revoke-all')).statusCode).toBe(200)
    // erin's only session is expired by the time of the check
    api.clock.advance(SESSION_TTL_MS + 60_000)
    for (const handle of ['alice', 'bob', 'carol']) await api.login(handle) // a live session again

    const people: Client[] = [alice, bob, carol, dave, erin]
    const users = [...people.map((c) => c.userId), 'usr_00000000000000000000']
    const boards = [live, open, archived, trashed, 'b-0000000000']
    const pairs: AccessManyPair[] = []
    for (const boardId of boards) for (const userId of users) pairs.push({ boardId, userId })
    const res = await many(api, pairs)
    expect(res.statusCode, res.body).toBe(200)
    const body = AccessManyResponse.parse(res.json())
    expect(body.results.map((r) => `${r.boardId}/${r.userId}`)).toEqual(
      pairs.map((p) => `${p.boardId}/${p.userId}`),
    )
    for (const [i, p] of pairs.entries()) {
      const one = await single(api, p.boardId, p.userId)
      expect({ pair: p, role: body.results[i]?.role }).toEqual({ pair: p, role: one.role })
      expect({ user: p.userId, since: body.signedInSince[p.userId] }).toEqual({
        user: p.userId,
        since: one.signedInSince,
      })
    }
    // the cases above are really there (not all null): owner, commenter, workspace view, archived viewer
    const role = (b: string, c: Client) =>
      body.results.find((r) => r.boardId === b && r.userId === c.userId)?.role
    expect(role(live, bob)).toBe('owner')
    expect(role(live, alice)).toBe('owner')
    expect(role(live, carol)).toBe('commenter')
    expect(role(open, carol)).toBe('viewer')
    expect(role(archived, carol)).toBe('viewer')
    expect(role(trashed, bob)).toBeNull()
    expect(role(live, dave)).toBeNull()
    expect(body.signedInSince[dave.userId]).toBeNull()
    expect(body.signedInSince[erin.userId]).toBeNull()
    expect(body.signedInSince[bob.userId]).toEqual(expect.any(Number))
    expect(body.signedInSince.usr_00000000000000000000).toBeNull()
  })

  it('answers in exactly two queries, for one pair or for 500', async () => {
    base = await openTestDb()
    const { db, statements } = counting(base)
    api = await createTestApi({ db })
    const owners = await Promise.all(
      ['u1', 'u2', 'u3', 'u4', 'u5'].map((h) => api?.login(h) as Promise<Client>),
    )
    const boards: string[] = []
    for (const [i, o] of owners.entries()) boards.push(await createBoard(o, o.personalWorkspaceId, `B${i}`))
    const pairs: AccessManyPair[] = []
    for (let i = 0; pairs.length < ACCESS_MANY_MAX_PAIRS; i++)
      pairs.push({
        boardId: boards[i % boards.length] as string,
        userId:
          i % 7 === 0 ? `usr_${String(i).padStart(20, '0')}` : (owners[i % owners.length] as Client).userId,
      })
    for (const n of [1, ACCESS_MANY_MAX_PAIRS]) {
      statements.length = 0
      const res = await many(api, pairs.slice(0, n))
      expect(res.statusCode, res.body).toBe(200)
      expect(AccessManyResponse.parse(res.json()).results).toHaveLength(n)
      expect({ n, queries: statements.length }).toEqual({ n, queries: 2 })
    }
  })
})
