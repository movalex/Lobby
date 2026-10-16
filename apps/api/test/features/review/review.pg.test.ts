// Wave S, WS1 (docs/WAVE-S-CONTRACTS.md §2.4): the review writes under real concurrency. PGlite has one connection, so
// the item row's FOR UPDATE, the fromSeq check under it, the live-item unique index and the one-open-round index only
// show their worth on a real Postgres. Set DRAFTROOM_TEST_DATABASE_URL (packages/db/src/testing.ts) to run them;
// skipped otherwise.
//
//   - two status sets at once with the same fromSeq: exactly one wins, the other is 409 STATUS_CHANGED with the item
//     as the winner left it; without fromSeq both apply, one after the other (status_seq 2, the item says what the
//     last event says);
//   - a status set racing the item's removal: never a 5xx; either the status lands first (its event before the
//     'removed' one) or the removal does (the status is 404); never a status event after the removal;
//   - two marks of one element at once: one 201, one 409 ALREADY_IN_REVIEW, one live row;
//   - two round starts at once: one 201, one 409 ROUND_OPEN, one open round;
//   - status sets with notes racing a round start over the same items: no deadlock and no 5xx (the round holds the
//     board FOR NO KEY UPDATE, which the status writes' key-share inserts do not wait for).

import { ReviewStatusChangedBody } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { codeOf, mark, type ReviewWorld, reviewWorld, setStatus } from './support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ROUNDS = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 5)

let w: ReviewWorld | undefined
afterEach(async () => {
  await w?.api.close()
  w = undefined
})

describe.skipIf(!PG_URL)('review writes on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('two status sets at once with the same fromSeq: one wins, the other is 409 with the winner’s item', async () => {
    w = await reviewWorld()
    const world = w
    for (let round = 0; round < ROUNDS; round++) {
      const item = await mark(world.bob, world.board, {
        elementId: `frame-${round}`,
        kind: 'frame',
        label: `Item ${round}`,
      })
      const [a, b] = await Promise.all([
        setStatus(world.ana, world.board, item.id, { status: 'approved', fromSeq: 0 }),
        setStatus(world.bob, world.board, item.id, { status: 'changes_requested', fromSeq: 0 }),
      ])
      const codes = [a.statusCode, b.statusCode].sort()
      expect(codes, `${a.body} ${b.body}`).toEqual([200, 409])
      const lost = a.statusCode === 409 ? a : b
      const won = a.statusCode === 200 ? a : b
      expect(codeOf(lost)).toBe('STATUS_CHANGED')
      const current = ReviewStatusChangedBody.parse(lost.json()).item
      const winner = (won.json() as { item: { status: string } }).item
      expect(current).toMatchObject({ statusSeq: 1, status: winner.status })
      const n = await world.api.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM review_events WHERE item_id = $1 AND kind = 'status'",
        [item.id],
      )
      expect(n.n).toBe(1)
    }
  })

  it('without fromSeq both writes apply one after the other: status_seq 2, the item matches its last event', async () => {
    w = await reviewWorld()
    const world = w
    for (let round = 0; round < ROUNDS; round++) {
      const item = await mark(world.bob, world.board, {
        elementId: `frame-${round}`,
        kind: 'frame',
        label: `Item ${round}`,
      })
      const res = await Promise.all([
        setStatus(world.ana, world.board, item.id, { status: 'approved' }),
        setStatus(world.bob, world.board, item.id, { status: 'changes_requested' }),
      ])
      expect(res.map((r) => r.statusCode)).toEqual([200, 200])
      const row = await world.api.db.one<{ status: string; status_seq: string }>(
        'SELECT status, status_seq FROM review_items WHERE id = $1',
        [item.id],
      )
      const last = await world.api.db.one<{ status: string; previous_status: string }>(
        "SELECT status, previous_status FROM review_events WHERE item_id = $1 AND kind = 'status' ORDER BY seq DESC LIMIT 1",
        [item.id],
      )
      expect(Number(row.status_seq)).toBe(2)
      expect(row.status).toBe(last.status)
      // the second write saw the first: its previous status is the first's status
      const first = await world.api.db.one<{ status: string }>(
        "SELECT status FROM review_events WHERE item_id = $1 AND kind = 'status' ORDER BY seq LIMIT 1",
        [item.id],
      )
      expect(last.previous_status).toBe(first.status)
    }
  })

  it('a status set racing the item’s removal: never 5xx, and never a status after the removal', async () => {
    w = await reviewWorld()
    const world = w
    for (let round = 0; round < ROUNDS * 2; round++) {
      const item = await mark(world.bob, world.board, {
        elementId: `frame-${round}`,
        kind: 'frame',
        label: `Item ${round}`,
      })
      const [set, del] = await Promise.all([
        setStatus(world.ana, world.board, item.id, { status: 'approved', note: 'Looks right' }),
        world.bob.req('DELETE', `/api/boards/${world.board}/review/items/${item.id}`),
      ])
      expect(del.statusCode, del.body).toBe(204)
      expect([200, 404], set.body).toContain(set.statusCode)
      const events = await world.api.db.query<{ kind: string; thread_id: string | null }>(
        'SELECT kind, thread_id FROM review_events WHERE item_id = $1 ORDER BY seq',
        [item.id],
      )
      const kinds = events.rows.map((e) => e.kind)
      expect(kinds.at(-1)).toBe('removed')
      expect(kinds).toEqual(set.statusCode === 200 ? ['added', 'status', 'removed'] : ['added', 'removed'])
      const removed = await world.api.db.one<{ removed_at: Date | null }>(
        'SELECT removed_at FROM review_items WHERE id = $1',
        [item.id],
      )
      expect(removed.removed_at).not.toBeNull()
      // a refused status left no note thread behind
      const threads = await world.api.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM comment_threads WHERE board_id = $1 AND anchor ->> 'shapeId' = $2`,
        [world.board, `shape:frame-${round}`],
      )
      expect(threads.n).toBe(set.statusCode === 200 ? 1 : 0)
    }
  })

  it('two marks of one element at once: one item; two round starts at once: one open round', async () => {
    w = await reviewWorld()
    const world = w
    for (let round = 0; round < ROUNDS; round++) {
      const body = { elementId: `same-${round}`, kind: 'frame', label: 'Same' }
      const [a, b] = await Promise.all([
        world.bob.req('POST', `/api/boards/${world.board}/review/items`, body),
        world.alice.req('POST', `/api/boards/${world.board}/review/items`, body),
      ])
      expect([a.statusCode, b.statusCode].sort(), `${a.body} ${b.body}`).toEqual([201, 409])
      expect(codeOf(a.statusCode === 409 ? a : b)).toBe('ALREADY_IN_REVIEW')
      const live = await world.api.db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM review_items WHERE board_id = $1 AND element_id = $2 AND removed_at IS NULL',
        [world.board, `same-${round}`],
      )
      expect(live.n).toBe(1)
    }
    const [r1, r2] = await Promise.all([
      world.bob.req('POST', `/api/boards/${world.board}/review/rounds`, {}),
      world.alice.req('POST', `/api/boards/${world.board}/review/rounds`, {}),
    ])
    expect([r1.statusCode, r2.statusCode].sort(), `${r1.body} ${r2.body}`).toEqual([201, 409])
    expect(codeOf(r1.statusCode === 409 ? r1 : r2)).toBe('ROUND_OPEN')
    const open = await world.api.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM review_rounds WHERE board_id = $1 AND closed_at IS NULL',
      [world.board],
    )
    expect(open.n).toBe(1)
  })

  it('status sets with notes racing a round start over the same items: no deadlock, no 5xx', async () => {
    w = await reviewWorld()
    const world = w
    for (let round = 0; round < ROUNDS; round++) {
      const items = []
      for (let i = 0; i < 4; i++)
        items.push(
          await mark(world.bob, world.board, { elementId: `r${round}-f${i}`, kind: 'frame', label: `F${i}` }),
        )
      const [start, ...sets] = await Promise.all([
        world.bob.req('POST', `/api/boards/${world.board}/review/rounds`, { keepApproved: false }),
        ...items.map((it, i) =>
          setStatus(i % 2 ? world.ana : world.alice, world.board, it.id, { status: 'approved', note: 'Ok' }),
        ),
      ])
      expect(start?.statusCode, start?.body).toBe(201)
      for (const r of sets) expect(r.statusCode, r.body).toBe(200)
      if (!start) throw new Error('no round start')
      const roundId = (start.json() as { round: { id: string } }).round.id
      const close = await world.bob.req(
        'POST',
        `/api/boards/${world.board}/review/rounds/${roundId}/close`,
        {},
      )
      expect(close.statusCode, close.body).toBe(200)
    }
  })
})
