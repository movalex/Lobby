// Wave V (WS4) on a real Postgres: breakouts under concurrent writers. Every change of a session takes its row lock, so
// parallel joins never overfill a capped group, parallel late joiners spread evenly and each lands once, a facilitator's
// move and the person's own join leave them in exactly one group, and two starts at the same moment make one session.
// PGlite has one connection and cannot show any of this: set DRAFTROOM_TEST_DATABASE_URL to run it; skipped otherwise.
// DRAFTROOM_PG_STRESS_ITER sets the rounds (default 3).
import { type BreakoutState, breakoutActionPath, breakoutsPath } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { Client } from '../../helpers.ts'
import {
  type BreakoutWorld,
  breakoutWorld,
  codeOf,
  frames,
  grant,
  groupsOf,
  start,
  state,
} from './support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 3)

let w: BreakoutWorld | null = null
afterEach(async () => {
  await w?.api.close()
  w = null
})

async function people(world: BreakoutWorld, n: number, prefix: string): Promise<Client[]> {
  const out: Client[] = []
  for (let i = 0; i < n; i++) {
    const c = await world.api.login(`${prefix}${i}`, `Person ${prefix}${i}`)
    await grant(world.owner, world.boardId, c.userId, 'viewer')
    out.push(c)
  }
  return out
}

const end = async (world: BreakoutWorld, s: BreakoutState) =>
  world.owner.req('POST', breakoutActionPath(s.session?.id ?? '', 'end'), {})

describe.skipIf(!PG_URL)('breakouts on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('parallel joins never overfill a capped group', async () => {
    w = await breakoutWorld()
    expect(w.api.db.kind).toBe('pg')
    const crowd = await people(w, 12, 'j')
    for (let round = 0; round < ITER; round++) {
      const s = await start(w, w.owner, { mode: 'choose', groupCap: 3 })
      const brk = s.session?.id ?? ''
      const answers = await Promise.all(
        crowd.map((c) => c.req('POST', breakoutActionPath(brk, 'join'), { groupId: 'g1' })),
      )
      const ok = answers.filter((r) => r.statusCode === 200)
      expect(ok).toHaveLength(3)
      for (const r of answers.filter((x) => x.statusCode !== 200))
        expect(codeOf(r)).toBe('BREAKOUT_GROUP_FULL')
      const after = await state(w, w.owner)
      expect(groupsOf(after).g1).toHaveLength(3)
      expect(after.session?.rev).toBe(3)
      expect((await end(w, s)).statusCode).toBe(200)
    }
  })

  it('parallel late joiners in auto mode each land once, and the groups differ by at most one', async () => {
    w = await breakoutWorld()
    const crowd = await people(w, 13, 'l')
    for (let round = 0; round < ITER; round++) {
      const s = await start(w, w.owner, { mode: 'auto', groups: frames(4) })
      expect(s.members).toEqual([]) // nobody had a tab open
      // everyone reads at once, the first of them three times over (three tabs opening)
      const first = crowd[0] as Client
      await Promise.all([
        ...crowd.map((c) => c.req('GET', breakoutsPath(w?.boardId ?? ''))),
        first.req('GET', breakoutsPath(w.boardId)),
        first.req('GET', breakoutsPath(w.boardId)),
      ])
      const after = await state(w, w.owner)
      expect(after.members.map((m) => m.userId).sort()).toEqual(crowd.map((c) => c.userId).sort())
      const sizes = Object.values(groupsOf(after)).map((g) => g.length)
      expect(sizes).toHaveLength(4)
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
      expect(after.session?.rev).toBe(13)
      expect((await end(w, s)).statusCode).toBe(200)
    }
  })

  it('a move by the facilitator and the person own join at once leave them in exactly one group', async () => {
    w = await breakoutWorld()
    const crowd = await people(w, 6, 'm')
    for (let round = 0; round < ITER; round++) {
      const s = await start(w, w.owner, { mode: 'choose', groups: frames(3) })
      const brk = s.session?.id ?? ''
      const owner = w.owner
      await Promise.all(
        crowd.flatMap((c, i) => [
          owner.req('POST', breakoutActionPath(brk, 'assign'), {
            moves: [{ userId: c.userId, groupId: i % 2 ? 'g2' : 'g3' }],
          }),
          c.req('POST', breakoutActionPath(brk, 'join'), { groupId: 'g1' }),
        ]),
      )
      const after = await state(w, w.owner)
      const ids = after.members.map((m) => m.userId)
      expect(ids.sort()).toEqual(crowd.map((c) => c.userId).sort())
      expect(new Set(ids).size).toBe(ids.length)
      // every change bumped the rev once, under the lock: the last event carries the final members
      const last = w.events.filter((e) => e.type === 'workshop.breakout').at(-1)?.data as BreakoutState
      expect(last.session?.rev).toBe(after.session?.rev)
      expect(groupsOf(last)).toEqual(groupsOf(after))
      expect((await end(w, s)).statusCode).toBe(200)
    }
  })

  it('two starts at the same moment make one session (the other is BREAKOUTS_RUNNING)', async () => {
    w = await breakoutWorld()
    for (let round = 0; round < ITER; round++) {
      const body = { groups: frames(2), mode: 'manual' }
      const [a, b] = await Promise.all([
        w.owner.req('POST', breakoutsPath(w.boardId), body),
        w.editor.req('POST', breakoutsPath(w.boardId), body),
      ])
      const codes = [a?.statusCode, b?.statusCode].sort()
      expect(codes).toEqual([201, 409])
      const loser = a?.statusCode === 409 ? a : b
      if (loser) expect(codeOf(loser)).toBe('BREAKOUTS_RUNNING')
      const running = await w.api.db.query(
        "SELECT id FROM breakout_sessions WHERE board_id = $1 AND status = 'running'",
        [w.boardId],
      )
      expect(running.rows).toHaveLength(1)
      const s = await state(w, w.owner)
      expect((await end(w, s)).statusCode).toBe(200)
    }
  })
})
