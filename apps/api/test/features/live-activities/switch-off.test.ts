// OWNER: WS1 (wave V; lead decision a). With DRAFTROOM_LIVE_ACTIVITIES off, every live activity route is an unknown
// route (the root 404) for every caller, nothing is read or written, no event goes out and the open-state part is
// null; the rows stay in Postgres, and with the switch on again the activity comes back as it was (one that ended by
// its time meanwhile reads as closed).

import {
  ACTIVITY_ROUTE_KEYS,
  activitiesPath,
  activityActionPath,
  activityPath,
  OpenStateBody,
  openStatePath,
} from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { POLL } from './support.ts'

const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }
let db: Db | null = null
const apis: TestApi[] = []
afterEach(async () => {
  for (const a of apis.splice(0)) await a.close()
  await db?.close()
  db = null
})

const ON = { DRAFTROOM_LIVE_ACTIVITIES: 'on' }
const fill = (pattern: string, board: string, aid: string) =>
  pattern.replace(':bid', board).replace(':aid', aid)

const tables = async (q: Db) =>
  JSON.stringify([
    (await q.query('SELECT * FROM live_activities ORDER BY id')).rows,
    (await q.query('SELECT * FROM live_answers ORDER BY activity_id, user_id')).rows,
  ])

describe('the live activities switch', () => {
  it('off: every route is an unknown route for everyone, nothing is written, no event, the part is null; on again: as it was', async () => {
    db = await openTestDb()
    let t = Date.now()
    const now = () => new Date(t)
    // on: an activity with an answer
    const on1 = await createTestApi({ db, env: ON, deps: { now } })
    apis.push(on1)
    const owner = await on1.login('ada', 'Ada Owner')
    const viewer = await on1.login('vic', 'Vic Viewer')
    const board = await createBoard(owner, DEV_STUDIO, 'Switch')
    expect(
      (await owner.req('PUT', `/api/boards/${board}/members/${viewer.userId}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(200)
    const guest = await joinAsGuest(on1, (await guestLink(owner, board, { role: 'editor' })).url, 'Gus')
    const s = await owner.req('POST', activitiesPath(board), { ...POLL, durationMs: 60_000 })
    expect(s.statusCode).toBe(201)
    const aid = (s.json() as { activity: { id: string } }).activity.id
    expect(
      (
        await viewer.req('POST', activityActionPath(aid, 'answer'), {
          answer: { kind: 'poll', choices: [1] },
        })
      ).statusCode,
    ).toBe(200)
    const before = await tables(db)

    // off: the same database, another api process
    const hub = new EventHub()
    const off = await createTestApi({ db, deps: { now, events: hub } })
    apis.push(off)
    expect(off.config.live.activities).toBe(false)
    const published: unknown[] = []
    hub.subscribe(board, (e) => published.push(e))
    const o = await off.login('ada', 'Ada Owner')
    const v = await off.login('vic', 'Vic Viewer')
    for (const key of ACTIVITY_ROUTE_KEYS) {
      const [method = 'GET', pattern = ''] = key.split(' ') as ['GET' | 'POST', string]
      const url = fill(pattern, board, aid)
      for (const [who, c] of [
        ['owner', o],
        ['viewer', v],
      ] as const)
        for (const body of [undefined, {}, { answer: { kind: 'poll', choices: [0] } }, POLL]) {
          const res = await c.req(method, url, method === 'GET' ? undefined : body)
          expect([key, who, res.statusCode]).toEqual([key, who, 404])
          expect(res.json()).toEqual(UNKNOWN)
        }
      const anon = await off.anon(method, url, method === 'GET' ? undefined : {})
      expect([key, 'anonymous', anon.statusCode]).toEqual([key, 'anonymous', 404])
      expect(anon.json()).toEqual(UNKNOWN)
      // a name-only guest (its session is in the same database): the guard rows never answer while off
      const asGuest = await off.anon(method, url, method === 'GET' ? undefined : {}, { cookie: guest.cookie })
      expect([key, 'guest', asGuest.statusCode]).toEqual([key, 'guest', 404])
      expect(asGuest.json()).toEqual(UNKNOWN)
    }
    const open = await o.req('GET', openStatePath(board))
    expect(open.statusCode).toBe(200)
    expect((OpenStateBody.parse(open.json()) as { activity?: unknown }).activity ?? null).toBeNull()
    expect(await tables(db)).toBe(before)
    expect(published).toEqual([])

    // on again, after its end time: it reads as it was, closed by its time; the answer is there
    t += 61_000
    const on2 = await createTestApi({ db, env: ON, deps: { now } })
    apis.push(on2)
    const o2 = await on2.login('ada', 'Ada Owner')
    const v2 = await on2.login('vic', 'Vic Viewer')
    const st = await o2.req('GET', activityPath(board))
    expect(st.statusCode).toBe(200)
    expect(st.json()).toMatchObject({
      activity: { id: aid, status: 'closed' },
      answered: 1,
      results: { kind: 'poll', counts: [0, 1, 0] },
    })
    expect((await v2.req('GET', activityPath(board))).json()).toMatchObject({
      myAnswer: { kind: 'poll', choices: [1] },
    })
    // and a new one may start (the ended one is closed under the lock)
    expect((await o2.req('POST', activitiesPath(board), POLL)).statusCode).toBe(201)
  })
})
