// Wave V gate (review u2, the answer route's check-then-act). POST …/answer reads the board's status outside its
// transaction; an archive that commits after that read and before the answer's transaction must still refuse the
// answer. It does: archiving closes every open activity under its row lock in the status transaction (routes/boards.ts,
// review m2), and the answer re-checks the activity under the same row lock, so the answer either commits first (and
// is then settled with the rest) or sees the activity closed. Here the archive is run at the worst moment: after every
// check of the answer route and before its transaction begins.

import type { Queryable } from '@draftroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { answer, expectStatus, idOf, POLL, setupWorld, start, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.close()
})

/** Runs `before` once, just before the next transaction on the api's database begins. */
function beforeNextTransaction(before: () => Promise<void>): void {
  const db = w.api.db as { transaction: <R>(f: (tx: Queryable) => Promise<R>) => Promise<R> }
  const original = db.transaction
  db.transaction = async <R>(f: (tx: Queryable) => Promise<R>): Promise<R> => {
    db.transaction = original
    await before()
    return original.call(db, f) as Promise<R>
  }
}

describe('an archive between the answer route checks and its transaction (review u2)', () => {
  for (const anonymous of [true, false])
    it(`${anonymous ? 'anonymous' : 'named'}: the answer is refused and nothing of it is kept`, async () => {
      w = await setupWorld()
      const aid = idOf(await start(w.owner, w.board, { ...POLL, anonymous }))
      expectStatus(await answer(w.commenter, aid, { kind: 'poll', choices: [0] }), 200)
      beforeNextTransaction(async () => {
        expectStatus(await w.owner.req('POST', `/api/boards/${w.board}/archive`), 200)
      })
      const res = await answer(w.viewer, aid, { kind: 'poll', choices: [1] })
      expect(res.statusCode).toBe(409)
      const row = await w.api.db.one<{ status: string; mine: number; all: number }>(
        `SELECT status,
           (SELECT count(*)::int FROM live_answers WHERE activity_id = $1 AND user_id = $2) AS mine,
           (SELECT count(*)::int FROM live_answers WHERE activity_id = $1) AS all
           FROM live_activities WHERE id = $1`,
        [aid, w.viewer.userId],
      )
      expect(row.status).toBe('closed')
      expect(row.mine).toBe(0)
      // anonymous: settled at the archive (no answer row); named: the earlier answer stays
      expect(row.all).toBe(anonymous ? 0 : 1)
    })
})
