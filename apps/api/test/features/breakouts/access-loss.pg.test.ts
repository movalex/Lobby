// Wave V follow-up (gate review u2) on a real Postgres: a loss of access and a placement in a group, truly at once.
// Both take the running session's row lock (the loss at step 2 of its transaction, src/features/breakouts/access-loss.ts;
// a placement before it re-checks access, breakouts/index.ts `change`), so whichever goes first, the person ends up out
// of the groups:
//   - the placement holds the lock: the removal waits for it, then takes out the person it just placed;
//   - the removal holds the lock: the placement waits, then re-checks, sees the access gone and is refused.
// Each test stops the REAL route midway (race-support.ts pausingDb) and runs the REAL other route against it.
// PGlite has one connection and cannot show any of this: set DRAFTROOM_TEST_DATABASE_URL to run it; skipped otherwise.

import { breakoutActionPath } from '@draftroom/contracts'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { blockedBy, type PausingDb, pausingDb } from '../../race-support.ts'
import { type BreakoutWorld, breakoutWorld, frames, start } from './support.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

async function world(
  env: Record<string, string> = {},
): Promise<{ w: BreakoutWorld; paused: PausingDb; base: Awaited<ReturnType<typeof openTestDb>> }> {
  const base = await openTestDb()
  const paused = pausingDb(base)
  const w = await breakoutWorld({ db: paused.db, env })
  cleanup.push(async () => {
    await w.api.close()
    await base.close()
  })
  return { w, paused, base }
}

const members = async (w: BreakoutWorld, brk: string) =>
  (
    await w.api.db.query<{ user_id: string }>('SELECT user_id FROM breakout_members WHERE session_id = $1', [
      brk,
    ])
  ).rows.map((r) => r.user_id)

/** assign's own lock of the session (store.ts lockSession) */
const ASSIGN_LOCK = /FROM breakout_sessions s WHERE s\.id = \$1 FOR UPDATE OF s/
/** a loss of access locking the board's running sessions (access-loss.ts lockForAccessLoss, board scope) */
const LOSS_LOCK = /FROM breakout_sessions\s+WHERE board_id = \$1 AND status = 'running'/

describe.skipIf(!PG)('a loss of access against a placement in a group (real Postgres)', () => {
  it('assign holds the session: the removal waits, then takes out the person assign placed', async () => {
    const { w, paused, base } = await world()
    expect(w.api.db.kind).toBe('pg')
    const s = await start(w, w.owner, { mode: 'manual', groups: frames(2) })
    const brk = s.session?.id ?? ''
    const pause = paused.arm(ASSIGN_LOCK, 'after')
    const assigning = w.owner.req('POST', breakoutActionPath(brk, 'assign'), {
      moves: [{ userId: w.editor.userId, groupId: 'g1' }],
    })
    const pid = await pause.reached
    const removing = w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.editor.userId}`)
    try {
      await blockedBy(base, pid, 'the removal')
    } finally {
      pause.release()
    }
    expect((await assigning).statusCode).toBe(200)
    expect((await removing).statusCode).toBe(200)
    expect(await members(w, brk)).toEqual([])
  })

  it('the removal holds the session: assign waits, re-checks and is refused, and places nobody', async () => {
    const { w, paused, base } = await world()
    const s = await start(w, w.owner, { mode: 'manual', groups: frames(2) })
    const brk = s.session?.id ?? ''
    const pause = paused.arm(LOSS_LOCK, 'after')
    const removing = w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.editor.userId}`)
    const pid = await pause.reached
    // the editor may still open the board here (the removal has not committed): assign's first check passes
    const assigning = w.owner.req('POST', breakoutActionPath(brk, 'assign'), {
      moves: [{ userId: w.editor.userId, groupId: 'g1' }],
    })
    try {
      await blockedBy(base, pid, 'assign')
    } finally {
      pause.release()
    }
    expect((await removing).statusCode).toBe(200)
    const res = await assigning
    expect(res.statusCode, res.body).toBe(400)
    expect(await members(w, brk)).toEqual([])
  })

  it('an answer against the removal holding the open activity: the answer waits and is refused', async () => {
    const { w, paused, base } = await world({ DRAFTROOM_LIVE_ACTIVITIES: 'on' })
    const made = await w.owner.req('POST', `/api/boards/${w.boardId}/activities`, {
      kind: 'poll',
      prompt: 'Which one first?',
      config: { options: ['Alpha', 'Beta'] },
      anonymous: false,
    })
    expect(made.statusCode, made.body).toBe(201)
    const aid = (made.json() as { activity: { id: string } }).activity.id
    const pause = paused.arm(/FROM live_activities WHERE board_id = \$1 AND status = 'open'/, 'after')
    const removing = w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.viewer.userId}`)
    const pid = await pause.reached
    const answering = w.viewer.req('POST', `/api/activities/${aid}/answer`, {
      answer: { kind: 'poll', choices: [0] },
    })
    try {
      await blockedBy(base, pid, 'the answer')
    } finally {
      pause.release()
    }
    expect((await removing).statusCode).toBe(200)
    expect((await answering).statusCode).toBe(404)
    const n = await w.api.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM live_answers WHERE activity_id = $1',
      [aid],
    )
    expect(n.n).toBe(0)
  })
})
