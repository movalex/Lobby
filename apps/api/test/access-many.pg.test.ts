// Wave M (M7-1): POST /internal/access-many on a real Postgres (a pg.Pool, where requests run on separate
// connections): two queries for one pair or for 500, and batches racing grant changes answer every pair with a
// role that was true at some point of the race (never a 5xx). Set DRAFTROOM_TEST_DATABASE_URL to a database these
// tests may create and drop schemas in; skipped otherwise. The PGlite twin is access-many.test.ts.

import {
  ACCESS_MANY_MAX_PAIRS,
  ACCESS_MANY_PATH,
  type AccessManyPair,
  AccessManyResponse,
} from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { counting } from './access-many-support.ts'
import { type Client, createBoard, createTestApi, INTERNAL_SECRET, type TestApi } from './helpers.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL

let api: TestApi | undefined
let base: Db | undefined
afterEach(async () => {
  await api?.close()
  await base?.close()
  api = undefined
  base = undefined
})

const many = (a: TestApi, pairs: AccessManyPair[]) =>
  a.app.inject({
    method: 'POST',
    url: ACCESS_MANY_PATH,
    payload: { pairs },
    headers: { 'x-draftroom-internal': INTERNAL_SECRET },
  })

describe.skipIf(!PG)('POST /internal/access-many on a real Postgres', () => {
  it('answers in exactly two queries, for one pair or for 500', async () => {
    base = await openTestDb()
    expect(base.kind).toBe('pg')
    const { db, statements } = counting(base)
    api = await createTestApi({ db })
    const owners: Client[] = []
    for (const h of ['p1', 'p2', 'p3', 'p4']) owners.push(await api.login(h))
    const boards: string[] = []
    for (const [i, o] of owners.entries()) boards.push(await createBoard(o, o.personalWorkspaceId, `B${i}`))
    const pairs: AccessManyPair[] = Array.from({ length: ACCESS_MANY_MAX_PAIRS }, (_, i) => ({
      boardId: boards[i % boards.length] as string,
      userId: (owners[(i * 3) % owners.length] as Client).userId,
    }))
    for (const n of [1, ACCESS_MANY_MAX_PAIRS]) {
      statements.length = 0
      const res = await many(api, pairs.slice(0, n))
      expect(res.statusCode, res.body).toBe(200)
      expect(AccessManyResponse.parse(res.json()).results).toHaveLength(n)
      expect({ n, queries: statements.length }).toEqual({ n, queries: 2 })
    }
  })

  it('batches racing grants and removals: every answer is one of the states the race went through, no 5xx', async () => {
    api = await createTestApi()
    const owner = await api.login('powner')
    const guest = await api.login('pguest')
    const board = await createBoard(owner, owner.personalWorkspaceId, 'Race')
    const pairs = [
      { boardId: board, userId: guest.userId },
      { boardId: board, userId: owner.userId },
    ]
    const seen = new Set<string>()
    for (let round = 0; round < 10; round++) {
      const a = api
      const changes = [
        owner.req('PUT', `/api/boards/${board}/members/${guest.userId}`, { role: 'editor' }),
        owner.req('DELETE', `/api/boards/${board}/members/${guest.userId}`),
      ]
      const batches = Array.from({ length: 8 }, () => many(a, pairs))
      const all = await Promise.all([...changes, ...batches])
      for (const res of all) expect(res.statusCode, res.body).toBeLessThan(500)
      for (const res of all.slice(2)) {
        const body = AccessManyResponse.parse(res.json())
        expect(body.results[1]?.role).toBe('owner')
        const role = body.results[0]?.role ?? null
        expect([null, 'editor']).toContain(role)
        seen.add(String(role))
      }
    }
    expect(seen.size).toBeGreaterThan(0)
  })
})
