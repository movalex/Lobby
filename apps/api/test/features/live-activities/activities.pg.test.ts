// OWNER: WS1 (wave V). Live activity races on a real Postgres (docs/WAVE-V-CONTRACTS.md §10 WS1): the api runs
// in-process on a real pg.Pool, so simultaneous requests really run on separate connections. PGlite has one
// connection and cannot show any of this: set DRAFTROOM_TEST_DATABASE_URL (a database these tests may create and drop
// schemas in) to run it; skipped otherwise. DRAFTROOM_PG_STRESS_ITER sets the rounds (default 10). A deadlock victim or
// any other server error answers 500, so "no 5xx" includes "no deadlock".

import { type ActivityState, activitiesPath, activityActionPath } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { Client } from '../../helpers.ts'
import { act, answer, errorCode, idOf, POLL, setupWorld, start, state, type World } from './support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 10)

let w: World | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

const codes = (rs: LightMyRequestResponse[]) =>
  rs.reduce<Record<string, number>>((m, r) => {
    const k = `${r.statusCode} ${r.statusCode >= 400 ? errorCode(r) : ''}`.trim()
    m[k] = (m[k] ?? 0) + 1
    return m
  }, {})
const serverErrors = (rs: LightMyRequestResponse[]) =>
  rs.filter((r) => r.statusCode >= 500).map((r) => `${r.statusCode} ${r.body.slice(0, 200)}`)

/** A new round: a minute later (the start limit), the previous activity cancelled, a fresh one open. */
async function fresh(world: World, input: object = POLL): Promise<string> {
  world.clock.advance(61_000)
  const cur = await state(world.owner, world.board)
  if (cur.activity && cur.activity.status !== 'revealed') await act(world.owner, cur.activity.id, 'cancel')
  return idOf(await start(world.owner, world.board, input as never))
}

describe.skipIf(!PG_URL)('live activities on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('20 parallel answers of one person leave exactly one answer, the last committed one, and count once', async () => {
    w = await setupWorld()
    expect(w.api.db.kind).toBe('pg')
    for (let i = 0; i < ITER; i++) {
      const aid = await fresh(w)
      const rs = await Promise.all(
        Array.from({ length: 20 }, (_, k) =>
          answer(w?.viewer as Client, aid, { kind: 'poll', choices: [k % 3] }),
        ),
      )
      expect(serverErrors(rs)).toEqual([])
      expect(codes(rs)).toEqual({ 200: 20 })
      const rows = await w.api.db.query<{ answer: { choices: number[] } }>(
        'SELECT answer FROM live_answers WHERE activity_id = $1',
        [aid],
      )
      expect(rows.rows).toHaveLength(1)
      // the stored answer is the one the viewer reads back
      expect((await state(w.viewer, w.board)).myAnswer).toEqual({ kind: 'poll', ...rows.rows[0]?.answer })
      w.clock.advance(5_000)
      const s = await state(w.owner, w.board)
      expect(s.answered).toBe(1)
      expect(s.results).toMatchObject({ kind: 'poll', answered: 1 })
      expect((s.results as { counts: number[] }).counts.reduce((a, b) => a + b, 0)).toBe(1)
    }
  })

  it('a reveal racing answers: each answer is in the frozen results or refused ACTIVITY_NOT_OPEN; none is kept', async () => {
    w = await setupWorld()
    const people = [w.viewer, w.commenter, w.editor, w.editor2, w.client]
    for (let i = 0; i < ITER; i++) {
      const aid = await fresh(w)
      const answers = people.map((c, k) => answer(c, aid, { kind: 'poll', choices: [k % 3] }))
      const reveal = act(w.owner, aid, 'reveal')
      const rs = await Promise.all(answers)
      const rv = await reveal
      expect(serverErrors([...rs, rv])).toEqual([])
      expect(rv.statusCode).toBe(200)
      for (const r of rs) expect([200, 409]).toContain(r.statusCode)
      for (const r of rs.filter((x) => x.statusCode === 409)) expect(errorCode(r)).toBe('ACTIVITY_NOT_OPEN')
      const accepted = rs.filter((r) => r.statusCode === 200).length
      const results = (rv.json() as ActivityState).results
      expect(results?.answered, JSON.stringify(codes(rs))).toBe(accepted)
      const kept = await w.api.db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM live_answers WHERE activity_id = $1',
        [aid],
      )
      expect(kept.n).toBe(0)
      // late answers find it revealed
      expect(errorCode(await answer(w.viewer, aid, { kind: 'poll', choices: [0] }))).toBe('ACTIVITY_NOT_OPEN')
    }
  })

  it('close racing extend: closed in the end; the extend either ran first or is refused ACTIVITY_NOT_OPEN', async () => {
    w = await setupWorld()
    for (let i = 0; i < ITER; i++) {
      const s = await fresh(w, { ...POLL, durationMs: 120_000 })
      const before = await w.api.db.one<{ ends_at: Date }>(
        'SELECT ends_at FROM live_activities WHERE id = $1',
        [s],
      )
      // the starter closes while a board owner... both are the owner here: the starter and an owner on two tabs
      const [c, e] = await Promise.all([
        act(w.owner, s, 'close'),
        act(w.owner, s, 'extend', { addMs: 60_000 }),
      ])
      expect(serverErrors([c, e])).toEqual([])
      expect(c.statusCode).toBe(200)
      if (e.statusCode !== 200) expect(errorCode(e)).toBe('ACTIVITY_NOT_OPEN')
      const row = await w.api.db.one<{ status: string; ends_at: Date; closed_at: Date }>(
        'SELECT status, ends_at, closed_at FROM live_activities WHERE id = $1',
        [s],
      )
      expect(row.status).toBe('closed')
      // the extend counted only if it ran first
      expect(row.ends_at.getTime() - before.ends_at.getTime()).toBe(e.statusCode === 200 ? 60_000 : 0)
      expect((await state(w.viewer, w.board)).activity?.status).toBe('closed')
    }
  })

  it('two starts at once: one 201, the other 409 ACTIVITY_OPEN; one open activity', async () => {
    w = await setupWorld()
    for (let i = 0; i < ITER; i++) {
      w.clock.advance(61_000)
      const cur = await state(w.owner, w.board)
      if (cur.activity?.status === 'open') await act(w.owner, cur.activity.id, 'cancel')
      const rs = await Promise.all([
        w.owner.req('POST', activitiesPath(w.board), POLL),
        w.editor.req('POST', activitiesPath(w.board), POLL),
      ])
      expect(serverErrors(rs)).toEqual([])
      expect(codes(rs)).toEqual({ 201: 1, '409 ACTIVITY_OPEN': 1 })
      const open = await w.api.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM live_activities WHERE board_id = $1 AND status = 'open'",
        [w.board],
      )
      expect(open.n).toBe(1)
    }
  })

  it('answers of many people at once all count, after their window', async () => {
    w = await setupWorld()
    const aid = await fresh(w, { kind: 'words', prompt: 'One word', config: { maxWords: 2 } })
    const people = [w.viewer, w.commenter, w.editor, w.editor2, w.client, w.guest, w.reviewGuest, w.owner]
    const rs = await Promise.all(
      people.map((c, k) => answer(c, aid, { kind: 'words', words: ['same', `own${k}`] })),
    )
    expect(serverErrors(rs)).toEqual([])
    expect(codes(rs)).toEqual({ 200: people.length })
    w.clock.advance(5_000)
    const s = await state(w.owner, w.board)
    expect(s.answered).toBe(people.length)
    expect(s.results).toMatchObject({
      kind: 'words',
      words: expect.arrayContaining([{ text: 'same', count: 8 }]),
    })
    const res = await w.owner.req('GET', activityActionPath(aid, 'results'))
    expect(res.statusCode).toBe(200)
  })
})
