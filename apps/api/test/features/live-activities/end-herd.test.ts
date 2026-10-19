// Wave V gate (review u1, the refetch herd at an end time). Every tab of a timed activity asks the api for it again
// END_REFRESH_DELAY_MS after its end (the web store's end timer, synchronized to the api's clock), so the first reads
// after the end come all at once, and each of them sees an open activity past its end time and settles it (review
// m2). Settling takes the activity's row lock in a transaction: N readers queued N transactions on one row, each
// holding a pool connection (the api's pool is 5 on Render) while it waited, so one end time of a 200-person workshop
// held the whole api's pool for the length of 200 serialized transactions. The reads that come together now share
// one settle in this process (one api instance per board); each still answers the settled state.

import type { Queryable } from '@draftroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { answer, expectStatus, idOf, POLL, setupWorld, start, state, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.close()
})

/** Counts the transactions begun on the api's database while `fn` runs. */
async function countTransactions<T>(fn: () => Promise<T>): Promise<{ out: T; transactions: number }> {
  const db = w.api.db as { transaction: <R>(f: (tx: Queryable) => Promise<R>) => Promise<R> }
  const original = db.transaction
  let transactions = 0
  db.transaction = <R>(f: (tx: Queryable) => Promise<R>): Promise<R> => {
    transactions++
    return original.call(db, f) as Promise<R>
  }
  try {
    return { out: await fn(), transactions }
  } finally {
    db.transaction = original
  }
}

describe('the first reads after an end time (review u1)', () => {
  it('many readers at once settle the activity once, and every one of them reads it closed with its count', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, { ...POLL, durationMs: 60_000 }))
    expectStatus(await answer(w.viewer, aid, { kind: 'poll', choices: [1] }), 200)
    expectStatus(await answer(w.commenter, aid, { kind: 'poll', choices: [2] }), 200)
    w.clock.advance(61_000)
    const readers = [w.owner, w.editor, w.editor2, w.commenter, w.viewer, w.client, w.guest, w.reviewGuest]
    const { out, transactions } = await countTransactions(() =>
      Promise.all([...readers, ...readers, ...readers].map((c) => state(c, w.board))),
    )
    expect(out).toHaveLength(24)
    for (const s of out) expect(s).toMatchObject({ activity: { id: aid, status: 'closed' }, answered: 2 })
    // the settle (the GET's only transaction): once, not once per reader
    expect(transactions).toBe(1)
    const row = await w.api.db.one<{ status: string; n: number }>(
      `SELECT status, (SELECT count(*)::int FROM live_answers WHERE activity_id = $1) AS n
         FROM live_activities WHERE id = $1`,
      [aid],
    )
    expect(row).toEqual({ status: 'closed', n: 0 })
    // a later read has nothing left to settle
    const later = await countTransactions(() => state(w.viewer, w.board))
    expect(later.transactions).toBe(0)
  })
})
