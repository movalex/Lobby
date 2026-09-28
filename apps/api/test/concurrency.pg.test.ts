// Wave-3 races on a real Postgres (the postgres-integrity review's probes): row locks, lock order,
// deadlocks and lost updates. The api runs in-process on a real pg.Pool (the opt-in test harness), so
// simultaneous requests really run on separate connections. PGlite has one connection and cannot show
// any of this: set DRAFTROOM_TEST_DATABASE_URL (a database these tests may create and drop schemas in)
// to run them; skipped otherwise. DRAFTROOM_PG_STRESS_ITER sets the rounds per race (default 10; the
// review ran 30 to 60). lock-order.pg.test.ts forces the interleavings that used to deadlock.
//
// Every transaction in these races is a route (a deadlock victim answers 500) or a sweep called here
// (its error is counted), so "no failures" includes "no deadlock". The database-wide deadlock counter
// is printed as well, but not asserted: other test files may share the database.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewLinkCreated } from '@draftroom/contracts'
import { openDb } from '@draftroom/db'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiServer } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { EventHub } from '../src/events/hub.ts'
import { createRecordingNotifier } from '../src/notifier.ts'
import {
  cookieOf,
  freshIp,
  guestSweeper,
  joinRequest,
  sweepLinks,
  tokenOf,
  type World,
} from './features/guests/support.ts'
import { jpeg, png } from './features/thumbnails/images.ts'
import { FakeSync } from './features/workshops/support.ts'
import { createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi, testEnv } from './helpers.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 10)

// ---- instrumentation ------------------------------------------------------------------------------

interface Tally {
  codes: Record<string, number>
  failures: string[]
}
const newTally = (): Tally => ({ codes: {}, failures: [] })
function tally(t: Tally, what: string, res: LightMyRequestResponse | { statusCode: number; body: string }) {
  const k = `${what} ${res.statusCode}`
  t.codes[k] = (t.codes[k] ?? 0) + 1
  if (res.statusCode >= 500) t.failures.push(`${what}: ${res.statusCode} ${res.body.slice(0, 200)}`)
}

/** Server errors the api logged (route, driver error code and message). */
function errorLog() {
  const lines: { route?: string; code?: string; message?: string }[] = []
  const stream = {
    write(msg: string) {
      try {
        const o = JSON.parse(msg) as { route?: string; err?: { code?: string; message?: string } }
        lines.push({ route: o.route, code: o.err?.code, message: o.err?.message })
      } catch {}
    },
  }
  return { lines, logger: { level: 'error', stream } }
}

async function pgDeadlocks(): Promise<number> {
  const db = await openDb({ kind: 'pg', connectionString: PG_URL, maxConnections: 1 })
  try {
    return (
      await db.one<{ n: number }>(
        'SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()',
      )
    ).n
  } finally {
    await db.close()
  }
}
/** pg_stat counters are flushed by backends lazily (at most every second or at exit). */
const settleStats = () => new Promise((r) => setTimeout(r, 1500))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Starts every job after its own random delay in [0, jitterMs]; waits for all (never rejects). */
async function race(jobs: (() => Promise<unknown>)[], jitterMs: number) {
  return Promise.allSettled(
    jobs.map(async (j) => {
      await sleep(Math.random() * jitterMs)
      return j()
    }),
  )
}

// ---- a guests world with an error-capturing logger -------------------------------------------------

async function guestsWorld() {
  const events = new EventHub()
  const log = errorLog()
  const api = await createTestApi({ deps: { events, logger: log.logger as never } })
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const erin = await api.login('erin')
  const board = await createBoard(bob, DEV_STUDIO, 'Client review')
  const w = { api, events, alice, bob, carol, erin, board } as World
  return { w, log }
}

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => {})
  cleanup = []
})

const report = (name: string, t: Tally, log: { lines: unknown[] }, deadlocks: number) =>
  console.log(
    `\n=== ${name}\n${JSON.stringify(t.codes)}\npg deadlocks (whole database): ${deadlocks}\n5xx: ${JSON.stringify(t.failures.slice(0, 5))}\nlogged: ${JSON.stringify(log.lines.slice(0, 5))}`,
  )

describe.skipIf(!PG_URL)('wave-3 concurrency on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('guest joins vs link revoke-with-removal vs both sweeps (no deadlock, no grant left behind)', async () => {
    const { w, log } = await guestsWorld()
    cleanup.push(() => w.api.close())
    const t = newTally()
    const sweeper = guestSweeper(w)
    const d0 = await pgDeadlocks()
    const leftovers: string[] = []
    for (let i = 0; i < ITER; i++) {
      const res = await w.bob.req('POST', `/api/boards/${w.board}/review-links`, {
        role: i % 2 ? 'editor' : 'commenter',
        allowGuests: true,
      })
      expect(res.statusCode, res.body).toBe(201)
      const link = ReviewLinkCreated.parse(res.json())
      const tok = tokenOf(link.url)
      let revoked = false
      await race(
        [
          ...Array.from(
            { length: 4 },
            (_, k) => async () =>
              tally(t, 'join', await joinRequest(w.api, tok, { name: `G${i}-${k}` }, { ip: freshIp() })),
          ),
          async () => {
            const r = await w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/revoke`, {
              removeAccess: true,
            })
            tally(t, 'revoke', r)
            revoked = r.statusCode === 200
          },
          async () => {
            try {
              await sweeper.run()
              tally(t, 'guestSweep', { statusCode: 200, body: '' })
            } catch (e) {
              tally(t, 'guestSweep', {
                statusCode: 599,
                body: `${(e as { code?: string }).code} ${(e as Error).message}`,
              })
            }
          },
          async () => {
            try {
              await sweepLinks(w)
              tally(t, 'linkSweep', { statusCode: 200, body: '' })
            } catch (e) {
              tally(t, 'linkSweep', {
                statusCode: 599,
                body: `${(e as { code?: string }).code} ${(e as Error).message}`,
              })
            }
          },
        ],
        12,
      )
      if (!revoked) {
        // make sure the link is closed for the next iterations (max 20 open links per board)
        await w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/revoke`, {
          removeAccess: true,
        })
      }
      const left = await w.api.db.query<{ user_id: string }>(
        `SELECT r.user_id FROM invitation_redemptions r
           JOIN board_members bm ON bm.board_id = r.board_id AND bm.user_id = r.user_id
          WHERE r.invitation_id = $1`,
        [link.id],
      )
      if (left.rows.length) leftovers.push(`${link.id}: ${left.rows.length}`)
    }
    await settleStats()
    const deadlocks = (await pgDeadlocks()) - d0
    report('guest join vs revoke vs sweeps', t, log, deadlocks)
    expect(leftovers, 'grants that outlived a revoke with removal').toEqual([])
    expect(t.failures).toEqual([])
  })

  it('max uses stay exact under simultaneous guest joins (no lost update on use_count)', async () => {
    const { w, log } = await guestsWorld()
    cleanup.push(() => w.api.close())
    const t = newTally()
    const broken: string[] = []
    for (let i = 0; i < Math.min(ITER, 15); i++) {
      const l = ReviewLinkCreated.parse(
        (
          await w.bob.req('POST', `/api/boards/${w.board}/review-links`, {
            role: 'viewer',
            allowGuests: true,
            maxUses: 3,
          })
        ).json(),
      )
      let ok = 0
      await race(
        Array.from({ length: 8 }, (_, k) => async () => {
          const r = await joinRequest(w.api, tokenOf(l.url), { name: `M${i}-${k}` }, { ip: freshIp() })
          tally(t, 'join', r)
          if (r.statusCode === 201) ok++
        }),
        5,
      )
      const row = await w.api.db.one<{ use_count: number; closed: boolean; guests: number }>(
        `SELECT use_count, revoked_at IS NOT NULL AS closed,
                (SELECT count(*)::int FROM invitation_redemptions WHERE invitation_id = $1) AS guests
           FROM invitations WHERE id = $1`,
        [l.id],
      )
      if (ok !== 3 || row.use_count !== 3 || row.guests !== 3 || !row.closed)
        broken.push(`${i}: ok=${ok} ${JSON.stringify(row)}`)
      await w.bob.req('POST', `/api/boards/${w.board}/review-links/${l.id}/revoke`, { removeAccess: true })
    }
    report('max uses', t, log, 0)
    expect(broken).toEqual([])
    expect(t.failures).toEqual([])
  })

  it('minimal pairs: ONE guest join vs ONE revoke; ONE account accept vs ONE extend', async () => {
    const { w, log } = await guestsWorld()
    cleanup.push(() => w.api.close())
    const t = newTally()
    const d0 = await pgDeadlocks()
    for (let i = 0; i < ITER; i++) {
      const g = ReviewLinkCreated.parse(
        (
          await w.bob.req('POST', `/api/boards/${w.board}/review-links`, {
            role: 'editor',
            allowGuests: true,
          })
        ).json(),
      )
      await race(
        [
          async () =>
            tally(
              t,
              'pair1 join',
              await joinRequest(w.api, tokenOf(g.url), { name: `P${i}` }, { ip: freshIp() }),
            ),
          async () =>
            tally(
              t,
              'pair1 revoke',
              await w.bob.req('POST', `/api/boards/${w.board}/review-links/${g.id}/revoke`, {
                removeAccess: true,
              }),
            ),
        ],
        8,
      )
      await w.bob.req('POST', `/api/boards/${w.board}/review-links/${g.id}/revoke`, { removeAccess: true })
      const a = ReviewLinkCreated.parse(
        (await w.bob.req('POST', `/api/boards/${w.board}/review-links`, { role: 'editor' })).json(),
      )
      await race(
        [
          async () =>
            tally(t, 'pair2 accept', await w.carol.req('POST', `/api/invitations/${tokenOf(a.url)}/accept`)),
          async () =>
            tally(
              t,
              'pair2 extend',
              await w.bob.req('POST', `/api/boards/${w.board}/review-links/${a.id}/extend`, { hours: 1 }),
            ),
        ],
        8,
      )
      await w.bob.req('POST', `/api/boards/${w.board}/review-links/${a.id}/revoke`, { removeAccess: true })
    }
    await settleStats()
    const deadlocks = (await pgDeadlocks()) - d0
    report('minimal pairs', t, log, deadlocks)
    expect(t.failures).toEqual([])
  })

  it('account accept vs link revoke-with-removal and extend (review/workshop links)', async () => {
    const { w, log } = await guestsWorld()
    cleanup.push(() => w.api.close())
    const people = [w.carol, w.erin, await w.api.login('fay'), await w.api.login('gil')]
    const t = newTally()
    const d0 = await pgDeadlocks()
    for (let i = 0; i < ITER; i++) {
      const res = await w.bob.req('POST', `/api/boards/${w.board}/review-links`, { role: 'editor' })
      expect(res.statusCode, res.body).toBe(201)
      const link = ReviewLinkCreated.parse(res.json())
      const tok = tokenOf(link.url)
      await race(
        [
          ...people.map(
            (c) => async () => tally(t, 'accept', await c.req('POST', `/api/invitations/${tok}/accept`)),
          ),
          async () =>
            tally(
              t,
              'extend',
              await w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/extend`, { hours: 1 }),
            ),
          async () =>
            tally(
              t,
              'revoke',
              await w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/revoke`, {
                removeAccess: true,
              }),
            ),
        ],
        12,
      )
      await w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/revoke`, { removeAccess: true })
    }
    await settleStats()
    const deadlocks = (await pgDeadlocks()) - d0
    report('accept vs revoke vs extend', t, log, deadlocks)
    expect(t.failures).toEqual([])
  })

  it('expired-link sweeper vs revoke-with-removal vs extend on the same expired link', async () => {
    const { w, log } = await guestsWorld()
    cleanup.push(() => w.api.close())
    const t = newTally()
    const d0 = await pgDeadlocks()
    for (let i = 0; i < ITER; i++) {
      const res = await w.bob.req('POST', `/api/boards/${w.board}/review-links`, {
        role: 'editor',
        expiresInHours: 1,
        allowGuests: true,
      })
      expect(res.statusCode, res.body).toBe(201)
      const link = ReviewLinkCreated.parse(res.json())
      const joined = await joinRequest(w.api, tokenOf(link.url), { name: `E${i}` }, { ip: freshIp() })
      expect(joined.statusCode, joined.body).toBe(201)
      w.api.clock.advance(61 * 60_000)
      await race(
        [
          async () => {
            try {
              await sweepLinks(w)
              tally(t, 'linkSweep', { statusCode: 200, body: '' })
            } catch (e) {
              tally(t, 'linkSweep', {
                statusCode: 599,
                body: `${(e as { code?: string }).code} ${(e as Error).message}`,
              })
            }
          },
          async () =>
            tally(
              t,
              'revoke',
              await w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/revoke`, {
                removeAccess: true,
              }),
            ),
          async () =>
            tally(
              t,
              'extend',
              await w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/extend`, { hours: 1 }),
            ),
        ],
        6,
      )
    }
    await settleStats()
    const deadlocks = (await pgDeadlocks()) - d0
    report('link sweeper vs revoke vs extend (expired link)', t, log, deadlocks)
    expect(t.failures).toEqual([])
  })

  it('guest sweep vs a signed-in guest joining a 2nd link vs removal from the 1st board', async () => {
    const { w, log } = await guestsWorld()
    cleanup.push(() => w.api.close())
    const board2 = await createBoard(w.bob, DEV_STUDIO, 'Second')
    const sweeper = guestSweeper(w)
    const t = newTally()
    const broken: string[] = []
    const d0 = await pgDeadlocks()
    for (let i = 0; i < ITER; i++) {
      const l1 = ReviewLinkCreated.parse(
        (
          await w.bob.req('POST', `/api/boards/${w.board}/review-links`, {
            role: 'viewer',
            allowGuests: true,
          })
        ).json(),
      )
      const l2 = ReviewLinkCreated.parse(
        (
          await w.bob.req('POST', `/api/boards/${board2}/review-links`, { role: 'viewer', allowGuests: true })
        ).json(),
      )
      const j = await joinRequest(w.api, tokenOf(l1.url), { name: `S${i}` }, { ip: freshIp() })
      expect(j.statusCode, j.body).toBe(201)
      const guestId = (j.json() as { user: { id: string } }).user.id
      const cookie = `dr_session=${cookieOf(j)?.value}`
      let joined2 = false
      await race(
        [
          async () => {
            const r = await joinRequest(w.api, tokenOf(l2.url), {}, { cookie })
            tally(t, 'join2', r)
            joined2 = r.statusCode === 200 || r.statusCode === 201
          },
          async () =>
            tally(t, 'removeMember', await w.bob.req('DELETE', `/api/boards/${w.board}/members/${guestId}`)),
          async () => {
            try {
              await sweeper.run()
              tally(t, 'guestSweep', { statusCode: 200, body: '' })
            } catch (e) {
              tally(t, 'guestSweep', {
                statusCode: 599,
                body: `${(e as { code?: string }).code} ${(e as Error).message}`,
              })
            }
          },
        ],
        10,
      )
      await sweeper.run()
      const live = await w.api.db.one<{ sessions: number; grants: number }>(
        `SELECT (SELECT count(*)::int FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2) AS sessions,
                (SELECT count(*)::int FROM board_members WHERE user_id = $1) AS grants`,
        [guestId, w.api.clock.now()],
      )
      if (joined2 && (live.sessions === 0 || live.grants === 0))
        broken.push(`iteration ${i}: join2 succeeded but sessions=${live.sessions} grants=${live.grants}`)
      if (live.sessions > 0 !== live.grants > 0)
        broken.push(`iteration ${i}: sessions=${live.sessions} grants=${live.grants} after a full sweep`)
      for (const l of [l1, l2])
        await w.bob.req('POST', `/api/boards/${l === l1 ? w.board : board2}/review-links/${l.id}/revoke`, {
          removeAccess: true,
        })
    }
    await settleStats()
    const deadlocks = (await pgDeadlocks()) - d0
    report('guest sweep vs join2 vs member removal', t, log, deadlocks)
    expect(broken).toEqual([])
    expect(t.failures).toEqual([])
  })

  it('private brainstorm: reveal vs cancel vs reveal (never both; drafts placed once or discarded)', async () => {
    const sync = new FakeSync()
    const events = new EventHub()
    const log = errorLog()
    const api = await createTestApi({ deps: { events, syncInternal: sync, logger: log.logger as never } })
    cleanup.push(() => api.close())
    const owner = await api.login('ada')
    const editor = await api.login('ed')
    const boardId = await createBoard(owner, DEV_STUDIO, 'Workshop')
    await owner.req('PUT', `/api/boards/${boardId}/members/${editor.userId}`, { role: 'editor' })
    const placedBySession = new Map<string, Set<string>>()
    let calls = 0
    Object.assign(sync, {
      async placeNotes(
        _boardId: string,
        body: { sessionId: string; notes: { id: string }[]; frame: { id: string } },
      ) {
        calls++
        await sleep(Math.random() * 40) // the sync server's storage transaction
        const set = placedBySession.get(body.sessionId) ?? new Set<string>()
        placedBySession.set(body.sessionId, set)
        const placed: string[] = []
        const existing: string[] = []
        for (const n of body.notes) {
          if (set.has(n.id)) existing.push(`shape:${n.id}`)
          else {
            set.add(n.id)
            placed.push(`shape:${n.id}`)
          }
        }
        return { placed, existing, frameId: body.frame.id, frameCreated: false }
      },
    })
    const t = newTally()
    const broken: string[] = []
    const d0 = await pgDeadlocks()
    const target = { frameId: 'shape:frame1', pageId: 'page:page', x: 0, y: 0, w: 1000, h: 700 }
    for (let i = 0; i < ITER; i++) {
      api.clock.advance(7_000) // starts: 10 per person per minute
      const st = await owner.req('POST', `/api/boards/${boardId}/private-brainstorm`, {
        prompt: `Round ${i}`,
        anonymous: i % 2 === 1,
        target,
      })
      expect(st.statusCode, st.body).toBe(201)
      const sid = (st.json() as { session: { id: string } }).session.id
      for (const [c, n] of [
        [owner, 2],
        [editor, 3],
      ] as const)
        for (let k = 0; k < n; k++) {
          const r = await c.req('POST', `/api/private-brainstorms/${sid}/notes`, {
            text: `n${k}`,
            color: 'yellow',
          })
          expect(r.statusCode, r.body).toBe(201)
        }
      let cancelled = false
      let revealedOk = 0
      await race(
        [
          async () => {
            const r = await owner.req('POST', `/api/private-brainstorms/${sid}/reveal`)
            tally(t, 'reveal', r)
            if (r.statusCode === 200) revealedOk++
          },
          async () => {
            const r = await owner.req('POST', `/api/private-brainstorms/${sid}/cancel`)
            tally(t, 'cancel', r)
            if (r.statusCode === 200 && (r.json() as { session: unknown }).session === null) cancelled = true
          },
          async () => {
            const r = await owner.req('POST', `/api/private-brainstorms/${sid}/reveal`)
            tally(t, 'reveal', r)
            if (r.statusCode === 200) revealedOk++
          },
          async () => {
            const r = await editor.req('POST', `/api/private-brainstorms/${sid}/notes`, {
              text: 'late',
              color: 'blue',
            })
            tally(t, 'lateNote', r)
          },
        ],
        20,
      )
      const row = await api.db.one<{ status: string; placed_count: number | null }>(
        'SELECT status, placed_count FROM private_brainstorms WHERE id = $1',
        [sid],
      )
      const drafts = (
        await api.db.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM private_notes WHERE session_id = $1',
          [sid],
        )
      ).n
      const placed = placedBySession.get(sid)?.size ?? 0
      if (row.status === 'cancelled' && placed > 0)
        broken.push(`${i}: cancelled, but ${placed} drafts were put on the board`)
      if (row.status === 'placed' && (drafts !== 0 || row.placed_count !== placed))
        broken.push(`${i}: placed ${row.placed_count}, board got ${placed}, drafts left ${drafts}`)
      if (row.status === 'cancelled' && drafts !== 0)
        broken.push(`${i}: cancelled with ${drafts} drafts left`)
      if (cancelled && revealedOk > 0) broken.push(`${i}: both cancel and reveal succeeded`)
      if (row.status === 'open' || row.status === 'revealed') {
        // leave nothing active for the next round
        const c = await owner.req('POST', `/api/private-brainstorms/${sid}/cancel`)
        if (c.statusCode !== 200) await owner.req('POST', `/api/private-brainstorms/${sid}/reveal`)
        broken.push(`${i}: left ${row.status}`)
      }
    }
    await settleStats()
    const deadlocks = (await pgDeadlocks()) - d0
    report(`reveal vs cancel (${calls} place calls)`, t, log, deadlocks)
    expect(broken).toEqual([])
    expect(t.failures).toEqual([])
  })

  it('thumbnail PUT races: two api instances on one database and blob store, plus GET and DELETE', async () => {
    const events = new EventHub()
    const log = errorLog()
    const api: TestApi = await createTestApi({ deps: { events, logger: log.logger as never } })
    cleanup.push(() => api.close())
    // A second instance (a deploy overlap, or a second web dyno) with its own in-process rate limits.
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-thumb-2-'))
    const log2 = errorLog()
    const second = await createApiServer(loadConfig(testEnv(dataDir)), {
      db: api.db,
      blobs: api.blobs,
      notifier: createRecordingNotifier(),
      now: api.clock.now,
      logger: log2.logger as never,
    })
    await second.app.ready()
    cleanup.push(async () => {
      await second.close()
      rmSync(dataDir, { recursive: true, force: true })
    })
    const owner = await api.login('ada')
    const board = await createBoard(owner, DEV_STUDIO, 'Thumbs')
    const put = (app: typeof api.app, bytes: Buffer, type: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/boards/${board}/thumbnail`,
        payload: bytes,
        headers: { origin: ORIGIN, cookie: owner.cookie, 'content-type': type },
      })
    const get = () =>
      api.app.inject({
        method: 'GET',
        url: `/api/boards/${board}/thumbnail`,
        headers: { origin: ORIGIN, cookie: owner.cookie },
      })
    const del = (app: typeof api.app) =>
      app.inject({
        method: 'DELETE',
        url: `/api/boards/${board}/thumbnail`,
        headers: { origin: ORIGIN, cookie: owner.cookie },
      })
    const t = newTally()
    const broken: string[] = []
    const blobDir = join(api.config.dataDir, 'blobs', 'thumbnails', DEV_STUDIO, board)
    const d0 = await pgDeadlocks()
    for (let i = 0; i < ITER; i++) {
      api.clock.advance(31_000)
      const a = png(40 + (i % 7), 30)
      const b = jpeg(50, 20 + (i % 5))
      const deleting = i % 5 === 4
      // Whether a thumbnail existed before this round and nothing in it removes one: then every GET
      // must find one (the old or the new).
      const hadRow = !!(await api.db.maybeOne('SELECT 1 AS x FROM board_thumbnails WHERE board_id = $1', [
        board,
      ]))
      await race(
        [
          deleting
            ? async () => tally(t, 'delete#1', await del(api.app))
            : async () => tally(t, 'put#1', await put(api.app, a, 'image/png')),
          async () => tally(t, 'put#2', await put(second.app, b, 'image/jpeg')),
          ...Array.from({ length: 6 }, () => async () => {
            const r = await get()
            tally(t, hadRow && !deleting ? 'get(had a row)' : 'get', r)
          }),
        ],
        10,
      )
      const row = await api.db.maybeOne<{ blob_key: string; bytes: number }>(
        'SELECT blob_key, bytes FROM board_thumbnails WHERE board_id = $1',
        [board],
      )
      let files: string[] = []
      try {
        files = readdirSync(blobDir).filter((f) => !f.startsWith('.'))
      } catch {}
      const expected = row ? [row.blob_key.split('/').at(-1)] : []
      const stray = files.filter((f) => !expected.includes(f))
      if (row && !(await api.blobs.head(row.blob_key))) broken.push(`${i}: the row's blob is missing`)
      if (stray.length) broken.push(`${i}: orphan blobs ${stray.join(',')} (row ${row?.blob_key ?? 'none'})`)
    }
    await settleStats()
    const deadlocks = (await pgDeadlocks()) - d0
    report('thumbnail races', t, { lines: [...log.lines, ...log2.lines] }, deadlocks)
    console.log('blob dir', blobDir)
    expect(broken).toEqual([])
    expect(t.failures).toEqual([])
  })

  it('export-policy PUT vs downloads: a download that starts after the PUT answered is refused', async () => {
    const events = new EventHub()
    const log = errorLog()
    const api = await createTestApi({ deps: { events, logger: log.logger as never } })
    cleanup.push(() => api.close())
    const owner = await api.login('ada')
    const owner2 = await api.login('bea')
    const viewer = await api.login('vic')
    const board = await createBoard(owner, DEV_STUDIO, 'Pitch')
    await owner.req('PUT', `/api/boards/${board}/members/${owner2.userId}`, { role: 'owner' })
    await owner.req('PUT', `/api/boards/${board}/members/${viewer.userId}`, { role: 'viewer' })
    const up = await api.app.inject({
      method: 'POST',
      url: `/api/boards/${board}/assets`,
      payload: png(10, 10),
      headers: { origin: ORIGIN, 'content-type': 'image/png', 'x-file-name': 'a.png', cookie: owner.cookie },
    })
    expect(up.statusCode, up.body).toBe(201)
    const m = up.json() as { assetId: string; versionId: string }
    const published: string[] = []
    events.subscribe(board, (e) => {
      if (e.type === 'export-control.policy')
        published.push((e.data as { exportPolicy: string }).exportPolicy)
    })
    const t = newTally()
    const broken: string[] = []
    const d0 = await pgDeadlocks()
    let policy = 'everyone'
    let transitions = 0
    // PUT is limited to 60 per minute per client address (real time), two PUTs per round.
    for (let i = 0; i < Math.min(ITER, 25); i++) {
      const next = policy === 'everyone' ? 'editors' : 'everyone'
      let answeredAt = Number.POSITIVE_INFINITY
      const downloads: { startedAt: number; status: number }[] = []
      await race(
        [
          async () => {
            const r = await (i % 2 ? owner2 : owner).req('PUT', `/api/boards/${board}/export-policy`, {
              exportPolicy: next,
            })
            tally(t, 'put', r)
            answeredAt = performance.now()
          },
          // a second owner flipping it back and forth at the same time
          async () =>
            tally(
              t,
              'put-other',
              await (i % 2 ? owner : owner2).req('PUT', `/api/boards/${board}/export-policy`, {
                exportPolicy: next,
              }),
            ),
          ...Array.from({ length: 6 }, () => async () => {
            const startedAt = performance.now()
            const r = await viewer.req('GET', `/files/${m.assetId}/${m.versionId}/original?board=${board}`)
            tally(t, 'download', r)
            downloads.push({ startedAt, status: r.statusCode })
          }),
        ],
        15,
      )
      policy = next
      transitions++
      const late = downloads.filter((d) => d.startedAt > answeredAt)
      const wrong = late.filter((d) => d.status !== (policy === 'editors' ? 403 : 200))
      if (wrong.length)
        broken.push(`${i}: ${wrong.length} downloads started after the PUT answered got the old answer`)
      const stored = await api.db.maybeOne<{ policy: string }>(
        'SELECT policy FROM board_export_policies WHERE board_id = $1',
        [board],
      )
      if (stored?.policy !== policy) broken.push(`${i}: stored ${stored?.policy}, expected ${policy}`)
    }
    await sleep(50)
    await settleStats()
    const deadlocks = (await pgDeadlocks()) - d0
    report('export-policy vs downloads', t, log, deadlocks)
    console.log('policy events published', published.length, 'transitions', transitions)
    if (published.length !== transitions)
      broken.push(`events ${published.length} != transitions ${transitions}`)
    expect(broken).toEqual([])
    expect(t.failures).toEqual([])
  })
})
