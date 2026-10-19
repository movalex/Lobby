// RT-03 (realtime audit, wave J3): a dot vote's counts no longer give the ballots away by their timing.
// Part 1, the tally alone (vote-tally.ts) on a fake clock and fake timers: counts move at wall-clock window
// boundaries only, one event per window, in commit order. Part 2, through the api (frozen app clock): a
// cast or an "I'm done" publishes nothing by itself, no read (state, past votes, the cast answer itself)
// shows another person's cast before its window is over, and close / reveal / extend behave.

import type { VoteSessionSummary, WorkshopState, WorkshopVoteState } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeliveredEvent } from '../../../src/events/hub.ts'
import { VOTE_TALLY_WINDOW_MS, VoteTally } from '../../../src/features/workshops/vote-tally.ts'
import type { Aggregates, SessionRow } from '../../../src/features/workshops/votes.ts'
import type { Client } from '../../helpers.ts'
import { expectStatus, json, note, setupWorld, type World } from './support.ts'

const W = VOTE_TALLY_WINDOW_MS

// ---- part 1: the tally --------------------------------------------------------------------------------

const agg = (totalVotesCast: number, participants = 1, participantsDone = 0): Aggregates => ({
  totalVotesCast,
  participants,
  participantsDone,
})

function rowOf(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'vot_tally0000000000000000',
    workspace_id: 'wsp_x',
    board_id: 'b-tally0000',
    title: 'Vote',
    votes_per_person: 5,
    one_per_object: false,
    scope: 'board',
    frame_id: null,
    selection: null,
    shape_types: null,
    status: 'open',
    created_by: 'usr_f',
    created_at: new Date(0),
    ends_at: null,
    closed_at: null,
    revealed_at: null,
    ...over,
  }
}

function harness(start = 10 * W + 1_000) {
  let t = start
  const timers: { fn: () => void; ms: number; at: number; cleared: boolean }[] = []
  let row = rowOf()
  const published: { agg: Aggregates; at: number; status: string }[] = []
  const tally = new VoteTally({
    now: () => new Date(t),
    load: async () => row,
    publish: (r, a, at) => published.push({ agg: a, at: at.getTime(), status: r.status }),
    setTimer: (fn, ms) => {
      const h = { fn, ms, at: t, cleared: false }
      timers.push(h)
      return h
    },
    clearTimer: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    },
  })
  /** Moves the clock to `to` and fires every timer due by then (as setTimeout would). */
  const runTo = async (to: number) => {
    for (;;) {
      const due = timers
        .filter((x) => !x.cleared && x.at + x.ms <= to)
        .sort((a, b) => a.at + a.ms - (b.at + b.ms))
      const next = due[0]
      if (!next) break
      t = Math.max(t, next.at + next.ms)
      next.cleared = true
      next.fn()
      await tally.drain()
    }
    t = to
  }
  return {
    tally,
    published,
    timers,
    get now() {
      return t
    },
    set now(v: number) {
      t = v
    },
    setRow(r: SessionRow) {
      row = r
    },
    row: () => row,
    runTo,
  }
}

const live = (a: Aggregates) => async () => a

describe('the vote tally (RT-03)', () => {
  it('shows the counts of the last finished window; one event per window, at its end, never at a cast', async () => {
    const h = harness()
    const r = h.row()
    h.tally.started(r, agg(0, 0))
    const windowStart = Math.floor(h.now / W) * W
    // three casts at different moments of one window
    for (const [i, dt] of [100, 1_700, 3_200].entries()) {
      h.now = windowStart + 1_000 + dt
      const m = h.tally.mark()
      h.tally.changed(r, agg(i + 1, i + 1), m)
      // nobody sees them yet, whenever they look
      expect(await h.tally.view(r, new Date(h.now), live(agg(99)))).toEqual(agg(0, 0))
    }
    expect(h.published).toEqual([])
    // the window's end, on the wall clock (not 5 s after the first cast)
    await h.runTo(windowStart + W + 100)
    expect(h.published).toHaveLength(1)
    expect(h.published[0]?.agg).toEqual(agg(3, 3))
    expect(h.published[0]?.at).toBeGreaterThanOrEqual(windowStart + W)
    expect(h.published[0]?.at).toBeLessThan(windowStart + W + 100)
    expect(await h.tally.view(r, new Date(h.now), live(agg(99)))).toEqual(agg(3, 3))
    // a quiet window publishes nothing
    await h.runTo(windowStart + 3 * W)
    expect(h.published).toHaveLength(1)
  })

  it('a change at the very end of a window shows at that window’s end; the next window waits for its own', async () => {
    const h = harness()
    const r = h.row()
    h.tally.started(r, agg(0, 0))
    const ws = Math.floor(h.now / W) * W
    h.now = ws + W - 1
    h.tally.changed(r, agg(1), h.tally.mark())
    h.now = ws + W // the next window: this one is not shown before ws + 2W
    h.tally.changed(r, agg(2), h.tally.mark())
    expect(await h.tally.view(r, new Date(h.now), live(agg(99)))).toEqual(agg(1))
    expect(h.published.map((p) => p.agg.totalVotesCast)).toEqual([1]) // the read sent the finished window
    await h.runTo(ws + 2 * W + 50)
    expect(h.published.map((p) => p.agg.totalVotesCast)).toEqual([1, 2])
  })

  it('a cast whose commit lands after its window was sent waits for the next boundary: never alone, off the grid (wave V review m1)', async () => {
    const h = harness()
    const r = h.row()
    h.tally.started(r, agg(0, 0))
    const b0 = Math.floor(h.now / W) * W + W
    h.now = b0 + 1_000
    h.tally.changed(r, agg(1, 1), h.tally.mark())
    // B is marked under the row lock just before the boundary; its COMMIT lands after the boundary went out
    h.now = b0 + W - 10
    const late = h.tally.mark()
    await h.runTo(b0 + W + 100)
    expect(h.published.map((p) => p.agg.totalVotesCast)).toEqual([1])
    h.tally.changed(r, agg(2, 2), late)
    expect(await h.tally.view(r, new Date(h.now + 10), live(agg(99)))).toEqual(agg(1, 1))
    await h.runTo(b0 + 2 * W - 1)
    expect(h.published.map((p) => p.agg.totalVotesCast)).toEqual([1])
    h.now = b0 + W + 2_000
    h.tally.changed(r, agg(3, 3), h.tally.mark())
    await h.runTo(b0 + 3 * W)
    expect(h.published.map((p) => ({ n: p.agg.totalVotesCast, dt: p.at - b0 }))).toEqual([
      { n: 1, dt: W + 25 },
      { n: 3, dt: 2 * W + 25 },
    ])
    for (const p of h.published) expect(p.at % W).toBeLessThanOrEqual(25)
  })

  it('commit order wins over arrival order (the mark is taken under the row lock)', async () => {
    const h = harness()
    const r = h.row()
    h.tally.started(r, agg(0, 0))
    const ws = Math.floor(h.now / W) * W
    h.now = ws + 1_000
    const first = h.tally.mark()
    const second = h.tally.mark()
    h.tally.changed(r, agg(2), second) // the later commit's continuation ran first
    h.tally.changed(r, agg(1), first)
    await h.runTo(ws + W + 50)
    expect(h.published.map((p) => p.agg.totalVotesCast)).toEqual([2])
  })

  it('ended() forgets the vote: no late event after its final one', async () => {
    const h = harness()
    const r = h.row()
    h.tally.started(r, agg(0, 0))
    h.tally.changed(r, agg(1), h.tally.mark())
    h.tally.ended(r.id)
    await h.runTo(h.now + 2 * W)
    expect(h.published).toEqual([])
    // a closed vote's counts are the live ones
    const closed = rowOf({ status: 'closed', closed_at: new Date(h.now) })
    expect(await h.tally.view(closed, new Date(h.now), live(agg(7)))).toEqual(agg(7))
  })

  it('a vote that ends by its end time publishes its last counts as final', async () => {
    const h = harness()
    const ws = Math.floor(h.now / W) * W
    const r = rowOf({ ends_at: new Date(ws + 2_000) })
    h.setRow(r)
    h.tally.started(r, agg(0, 0))
    h.now = ws + 1_500
    h.tally.changed(r, agg(4, 2), h.tally.mark())
    await h.runTo(ws + W + 50)
    expect(h.published).toEqual([{ agg: agg(4, 2), at: expect.any(Number), status: 'open' }])
    // after its end, reads answer the live (final) counts
    expect(await h.tally.view(r, new Date(h.now), live(agg(4, 2)))).toEqual(agg(4, 2))
  })

  it('after a restart (no entry yet) the first read shows the live counts and later changes wait', async () => {
    const h = harness()
    const r = h.row()
    expect(await h.tally.view(r, new Date(h.now), live(agg(3, 2)))).toEqual(agg(3, 2))
    h.tally.changed(r, agg(4, 3), h.tally.mark())
    expect(await h.tally.view(r, new Date(h.now), live(agg(99)))).toEqual(agg(3, 2))
    await h.runTo(h.now + W + 50)
    expect(h.published.map((p) => p.agg)).toEqual([agg(4, 3)])
  })

  it('close() stops every timer', async () => {
    const h = harness()
    const r = h.row()
    h.tally.started(r, agg(0, 0))
    h.tally.changed(r, agg(1), h.tally.mark())
    h.tally.close()
    expect(h.timers.every((x) => x.cleared)).toBe(true)
    await h.runTo(h.now + 2 * W)
    expect(h.published).toEqual([])
  })
})

// ---- part 2: through the api ----------------------------------------------------------------------------

let w: World
afterEach(async () => {
  await w?.api.close()
})

const voteEvents = () => w.events.filter((e: DeliveredEvent) => e.type === 'workshop.vote')
const state = async (c: Client) => {
  const res = await c.req('GET', `/api/boards/${w.boardId}/workshop`)
  expectStatus(res, 200)
  return json<WorkshopState>(res).vote
}
const pastVotes = async (c: Client) =>
  json<{ sessions: VoteSessionSummary[] }>(await c.req('GET', `/api/boards/${w.boardId}/votes`)).sessions

async function openVote(): Promise<string> {
  w = await setupWorld()
  w.sync.add(w.boardId, ...Array.from({ length: 6 }, (_, i) => note(`n${i}`)))
  // the frozen app clock, early in a window: every step below stays inside it until it is advanced
  w.clock.advance(W - (w.clock.now().getTime() % W) + 10)
  const res = await w.owner.req('POST', `/api/boards/${w.boardId}/votes`, {
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expectStatus(res, 201)
  return json<WorkshopVoteState>(res).session.id
}
const cast = (c: Client, vid: string, shapeId: string, delta: 1 | -1 = 1) =>
  c.req('POST', `/api/votes/${vid}/cast`, { shapeId, delta })

describe('vote counts through the api (RT-03)', () => {
  it('a cast publishes nothing and no read shows it before its window is over; then one event, with counts only', async () => {
    const vid = await openVote()
    const before = voteEvents().length // the start event
    expect(before).toBe(1)
    const r = await cast(w.viewer, vid, 'shape:n2')
    expectStatus(r, 200)
    // the voter sees their own ballot at once, but not a moved total (it would time their own cast for others too)
    expect(json<WorkshopVoteState>(r)).toMatchObject({ myVotes: { 'shape:n2': 1 }, totalVotesCast: 0 })
    expect(voteEvents()).toHaveLength(before)
    // another participant polling every route learns nothing
    expect(await state(w.commenter)).toMatchObject({ totalVotesCast: 0, participants: 0 })
    expect((await pastVotes(w.commenter))[0]).toMatchObject({ id: vid, totalVotesCast: 0, participants: 0 })
    // and casting themselves (to read the answer) does not either
    const probe = await cast(w.commenter, vid, 'shape:n3')
    expect(json<WorkshopVoteState>(probe).totalVotesCast).toBe(0)
    expectStatus(await cast(w.commenter, vid, 'shape:n3', -1), 200)
    expect(voteEvents()).toHaveLength(before)

    w.clock.advance(W)
    expect(await state(w.commenter)).toMatchObject({ totalVotesCast: 1, participants: 1 })
    const after = voteEvents().slice(before)
    expect(after).toHaveLength(1)
    expect(after[0]?.data).toMatchObject({
      sessionId: vid,
      status: 'open',
      totalVotesCast: 1,
      participants: 1,
    })
    // counts only: no shape, no voter
    const text = JSON.stringify(after)
    expect(text).not.toContain('shape:n2')
    expect(text).not.toContain(w.viewer.userId)
    expect((await pastVotes(w.viewer))[0]).toMatchObject({ totalVotesCast: 1, participants: 1 })
  })

  it('several people voting in one window: one event with the window’s sum; "done" waits with them', async () => {
    const vid = await openVote()
    const before = voteEvents().length
    expectStatus(await cast(w.viewer, vid, 'shape:n1'), 200)
    expectStatus(await cast(w.commenter, vid, 'shape:n4'), 200)
    expectStatus(await cast(w.editor, vid, 'shape:n4'), 200)
    expectStatus(await w.viewer.req('POST', `/api/votes/${vid}/done`), 200)
    expect(voteEvents()).toHaveLength(before)
    w.clock.advance(W)
    await state(w.owner)
    const after = voteEvents().slice(before)
    expect(after.map((e) => e.data)).toEqual([
      expect.objectContaining({ totalVotesCast: 3, participants: 3, participantsDone: 1 }),
    ])
  })

  it('extend keeps the window’s counts; close publishes the final ones at once', async () => {
    const vid = await openVote()
    // a vote with an end time, to extend
    expectStatus(await w.owner.req('POST', `/api/votes/${vid}/close`), 200)
    w.clock.advance(10) // the board's current vote is the newest one (still inside the window)
    const res = await w.owner.req('POST', `/api/boards/${w.boardId}/votes`, {
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
      durationMs: 10 * 60_000,
    })
    expectStatus(res, 201)
    const timed = json<WorkshopVoteState>(res).session.id
    expectStatus(await cast(w.viewer, timed, 'shape:n1'), 200)
    const before = voteEvents().length
    const ext = await w.owner.req('POST', `/api/votes/${timed}/extend`, { addMs: 60_000 })
    expectStatus(ext, 200)
    expect(json<WorkshopVoteState>(ext).totalVotesCast).toBe(0)
    expect(
      voteEvents()
        .slice(before)
        .map((e) => e.data),
    ).toEqual([expect.objectContaining({ sessionId: timed, status: 'open', totalVotesCast: 0 })])
    // closing: casting has stopped, the final counts go out now, and every read shows them
    const close = await w.owner.req('POST', `/api/votes/${timed}/close`)
    expect(json<WorkshopVoteState>(close)).toMatchObject({ totalVotesCast: 1, participants: 1 })
    expect(voteEvents().at(-1)?.data).toMatchObject({ sessionId: timed, status: 'closed', totalVotesCast: 1 })
    expect(await state(w.commenter)).toMatchObject({ totalVotesCast: 1 })
    // nothing late after the final event
    const n = voteEvents().length
    w.clock.advance(3 * W)
    await state(w.commenter)
    expect(voteEvents()).toHaveLength(n)
  })
})
