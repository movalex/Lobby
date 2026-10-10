// Wave M on a real Postgres with the api's capped pool (render.yaml: DRAFTROOM_DB_POOL_MAX=5):
// - M5-1: 20 board opens at once (GET /api/boards/:bid/open-state, one READ ONLY transaction each) all complete,
//   with no pool starvation (a transaction never waits for a second pooled client);
// - M5-2: with the pool at 5, 10 open-states, 20 live event streams and 10 bell polls all answer within 2 s (the
//   streams hold no client).
// PGlite has one connection and cannot show any of this: set DRAFTROOM_TEST_DATABASE_URL (a database these tests may
// create and drop a schema in); skipped otherwise.

import { randomBytes } from 'node:crypto'
import { OPEN_STATE_PARTS, OpenStateBody, openStatePath } from '@draftroom/contracts'
import { type Db, migrate, openDb } from '@draftroom/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { listen, openSse, type SseStream } from '../../sse.ts'
import { FakeSync } from '../workshops/support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const POOL_MAX = 5

async function adminExec(sql: string): Promise<void> {
  const admin = await openDb({ kind: 'pg', connectionString: PG_URL, maxConnections: 1 })
  try {
    await admin.exec(sql)
  } finally {
    await admin.close()
  }
}

describe.skipIf(!PG_URL)('the board-open read on a pool of 5 (real Postgres)', () => {
  const schema = `dr_open_${process.pid}_${randomBytes(4).toString('hex')}`
  let db: Db
  let api: TestApi
  let owner: Client
  const people: Client[] = []
  let board: string

  beforeAll(async () => {
    await adminExec(`CREATE SCHEMA ${schema}`)
    const u = new URL(PG_URL)
    u.searchParams.set('options', `-c search_path=${schema}`)
    db = await openDb({ kind: 'pg', connectionString: u.toString(), maxConnections: POOL_MAX })
    await migrate(db)
    api = await createTestApi({
      db,
      deps: {
        syncInternal: new FakeSync(),
        events: new EventHub({ limits: { perUserPerBoard: 50, perUser: 50, perBoard: 200, total: 500 } }),
        limits: { streamOpens: { max: 1_000, timeWindow: 60_000 } },
      },
    })
    owner = await api.login('ada', 'Ada Owner')
    board = await createBoard(owner, DEV_STUDIO, 'Busy board')
    for (let i = 0; i < 10; i++) {
      const c = await api.login(`p${i}`, `Person ${i}`)
      expect(
        (await owner.req('PUT', `/api/boards/${board}/members/${c.userId}`, { role: 'editor' })).statusCode,
      ).toBe(200)
      people.push(c)
    }
    await owner.req('POST', `/api/boards/${board}/threads`, {
      anchor: { kind: 'point', x: 1, y: 2 },
      body: 'Hi',
    })
    await owner.req('POST', `/api/boards/${board}/timer`, { action: 'start', durationMs: 300_000 })
  }, 120_000)

  afterAll(async () => {
    await api?.close()
    await db?.close()
    await adminExec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  })

  const open = (c: Client) => c.req('GET', openStatePath(board))

  it('M5-1: 20 open-states at once all complete (no pool starvation), each with every part', async () => {
    const started = Date.now()
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => open(people[i % people.length] as Client)),
    )
    const ms = Date.now() - started
    for (const res of answers) {
      expect(res.statusCode, res.body).toBe(200)
      const body = OpenStateBody.parse(res.json())
      for (const part of OPEN_STATE_PARTS) expect(body[part], part).not.toBeNull()
    }
    console.log(`[open-state.pg] 20 concurrent open-states on a pool of ${POOL_MAX}: ${ms} ms`)
    expect(ms).toBeLessThan(15_000)
  }, 60_000)

  it('M5-2: with the pool at 5, 10 open-states + 20 event streams + 10 bell polls all answer within 2 s', async () => {
    const base = await listen(api)
    const streams: SseStream[] = []
    try {
      // 20 live streams, held open for the whole test (two per person)
      for (let i = 0; i < 20; i++) {
        const c = people[i % people.length] as Client
        const s = await openSse(base, board, c.cookie)
        expect(s.status).toBe(200)
        await s.waitFor('hello', 5_000)
        streams.push(s)
      }
      const timed = async (run: () => Promise<{ statusCode: number }>) => {
        const t0 = Date.now()
        const res = await run()
        return { status: res.statusCode, ms: Date.now() - t0 }
      }
      const calls = [
        ...Array.from({ length: 10 }, (_, i) => () => open(people[i] as Client)),
        ...Array.from(
          { length: 10 },
          (_, i) => () => (people[i] as Client).req('GET', '/api/me/notifications?since=0'),
        ),
      ]
      const results = await Promise.all(calls.map((c) => timed(c)))
      console.log(`[open-state.pg] storm: ${JSON.stringify(results.map((r) => r.ms))}`)
      for (const r of results) {
        expect([200, 204]).toContain(r.status)
        expect(r.ms).toBeLessThan(2_000)
      }
      // the streams are still live (they hold no pooled client, and nothing waited on them)
      for (const s of streams) expect(s.ended()).toBe(false)
    } finally {
      for (const s of streams) await s.close()
    }
  }, 120_000)
})
