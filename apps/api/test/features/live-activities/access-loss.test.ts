// Wave V follow-up (gate review u2): an open activity takes no answer from someone who lost the board. After the loss
// the route's own access check refuses them (as before); a loss that commits between that check and the answer's
// transaction is caught by the re-check under the activity's row lock, which every loss of access takes first
// (src/features/breakouts/access-loss.ts). Their earlier answer, given while they had access, still counts.

import type { Queryable } from '@draftroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { DEV_STUDIO } from '../../helpers.ts'
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

const answersOf = async (aid: string, userId: string) =>
  (
    await w.api.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM live_answers WHERE activity_id = $1 AND user_id = $2',
      [aid, userId],
    )
  ).n

const removals = {
  'a board member removed': () => w.owner.req('DELETE', `/api/boards/${w.board}/members/${w.viewer.userId}`),
  'a workspace member removed': () =>
    w.owner.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${w.viewer.userId}`),
}

describe('an open activity and someone who lost the board', () => {
  for (const [path, remove] of Object.entries(removals)) {
    it(`${path}: their next answer is refused`, async () => {
      w = await setupWorld()
      const aid = idOf(await start(w.owner, w.board, { ...POLL, anonymous: false }))
      expectStatus(await answer(w.viewer, aid, { kind: 'poll', choices: [0] }), 200)
      expectStatus(await remove(), 200)
      expect((await answer(w.viewer, aid, { kind: 'poll', choices: [1] })).statusCode).toBe(404)
      // the answer they gave while they had the board stays as it was
      const row = await w.api.db.one<{ answer: { choices: number[] } }>(
        'SELECT answer FROM live_answers WHERE activity_id = $1 AND user_id = $2',
        [aid, w.viewer.userId],
      )
      expect(row.answer.choices).toEqual([0])
    })

    it(`${path} between the answer route checks and its transaction: refused, nothing kept`, async () => {
      w = await setupWorld()
      const aid = idOf(await start(w.owner, w.board, { ...POLL, anonymous: false }))
      beforeNextTransaction(async () => {
        expectStatus(await remove(), 200)
      })
      const res = await answer(w.viewer, aid, { kind: 'poll', choices: [1] })
      expect(res.statusCode, res.body).toBe(404)
      expect(await answersOf(aid, w.viewer.userId)).toBe(0)
    })
  }
})
