// OWNER: WS1 (wave V). The live activity tally window alone (src/features/live-activities/tally.ts) on a fake clock and
// fake timers (docs/WAVE-V-CONTRACTS.md §2.2 rule 2): answers move at wall-clock window boundaries only (5 s for an
// anonymous activity or live results, 1 s for a named one whose results are not live), one event per window that
// changed something, in commit order; a snapshot holds the answers alone, in a canonical order.

import type { ActivityAnswer } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  ActivityTally,
  EMPTY_SNAPSHOT,
  type Snapshot,
  snapshotOf,
  type TallyRow,
} from '../../../src/features/live-activities/tally.ts'

const poll = (...choices: number[]): ActivityAnswer => ({ kind: 'poll', choices })
const snap = (...answers: ActivityAnswer[]) => snapshotOf(answers)
const counts = (s: Snapshot) => s.answers.length

function rowOf(over: Partial<TallyRow> = {}): TallyRow {
  return {
    id: 'act_tally000000000000000',
    anonymous: true,
    results_live: false,
    status: 'open',
    ends_at: null,
    ...over,
  }
}

function harness(row0: TallyRow = rowOf(), start = 1_000_000_000_000) {
  let t = start
  let row = row0
  const timers: { fn: () => void; ms: number; at: number; cleared: boolean }[] = []
  const published: { n: number; digest: string; at: number }[] = []
  const tally = new ActivityTally({
    now: () => new Date(t),
    load: async () => row,
    publish: (_r, s, at) => published.push({ n: counts(s), digest: s.digest, at: at.getTime() }),
    setTimer: (fn, ms) => {
      const h = { fn, ms, at: t, cleared: false }
      timers.push(h)
      return h
    },
    clearTimer: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    },
  })
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
    setRow(r: TallyRow) {
      row = r
    },
    row: () => row,
    runTo,
  }
}

const live = (s: Snapshot) => async () => s

describe('a snapshot', () => {
  it('is the same multiset whatever order the answers came in, and holds nothing but the answers', () => {
    const a = snap(poll(2), poll(0), { kind: 'words', words: ['agile'] }, poll(0, 1))
    const b = snap(poll(0, 1), { kind: 'words', words: ['agile'] }, poll(0), poll(2))
    expect(a.digest).toBe(b.digest)
    expect(a.answers).toEqual(b.answers)
    expect(snap(poll(0)).digest).not.toBe(snap(poll(1)).digest)
    expect(Object.keys(a)).toEqual(['answers', 'digest'])
    expect(EMPTY_SNAPSHOT.answers).toEqual([])
  })
})

describe('the activity tally', () => {
  it('window widths: 5 s anonymous or live, 1 s named and not live', () => {
    const h = harness()
    expect(h.tally.windowOf({ anonymous: true, results_live: false })).toBe(5_000)
    expect(h.tally.windowOf({ anonymous: true, results_live: true })).toBe(5_000)
    expect(h.tally.windowOf({ anonymous: false, results_live: true })).toBe(5_000)
    expect(h.tally.windowOf({ anonymous: false, results_live: false })).toBe(1_000)
  })

  it('shows the answers of the last finished window; one event per window, at its end, never at an answer', async () => {
    const h = harness()
    const W = 5_000
    const r = h.row()
    h.tally.started(r)
    const ws = Math.floor(h.now / W) * W
    const all: ActivityAnswer[] = []
    for (const [i, dt] of [100, 1_700, 3_200].entries()) {
      h.now = ws + 1_000 + dt
      all.push(poll(i))
      const m = h.tally.mark()
      h.tally.changed(r, snapshotOf(all), m)
      expect(counts(await h.tally.view(r, new Date(h.now), live(snap(poll(9)))))).toBe(0)
    }
    expect(h.published).toEqual([])
    await h.runTo(ws + W + 100)
    expect(h.published.map((p) => p.n)).toEqual([3])
    expect(h.published[0]?.at).toBeGreaterThanOrEqual(ws + W)
    expect(counts(await h.tally.view(r, new Date(h.now), live(EMPTY_SNAPSHOT)))).toBe(3)
    // a quiet window publishes nothing
    await h.runTo(ws + 3 * W)
    expect(h.published).toHaveLength(1)
  })

  it('a changed answer with the same count is a change (one event); an unchanged multiset is not', async () => {
    const h = harness()
    const W = 5_000
    const r = h.row()
    h.tally.started(r, snap(poll(0)))
    const ws = Math.floor(h.now / W) * W
    h.now = ws + 100
    h.tally.changed(r, snap(poll(1)), h.tally.mark())
    await h.runTo(ws + W + 50)
    expect(h.published.map((p) => p.n)).toEqual([1])
    // two people swap answers within one window: the multiset is the same, nothing to tell
    h.tally.changed(r, snap(poll(1), poll(0)), h.tally.mark())
    await h.runTo(ws + 2 * W + 50)
    h.tally.changed(r, snap(poll(0), poll(1)), h.tally.mark())
    await h.runTo(ws + 3 * W + 50)
    expect(h.published.map((p) => p.n)).toEqual([1, 2])
  })

  it('an answer whose commit lands after its window was sent waits for the next boundary: never alone, off the grid (review m1)', async () => {
    const h = harness()
    const W = 5_000
    const r = h.row()
    h.tally.started(r)
    const b0 = Math.floor(h.now / W) * W + W
    h.now = b0 + 1_000
    h.tally.changed(r, snap(poll(0)), h.tally.mark())
    // B is marked under the row lock just before the boundary; its COMMIT is slow and lands after the boundary went out
    h.now = b0 + 4_990
    const late = h.tally.mark()
    await h.runTo(b0 + 5_100)
    expect(h.published.map((p) => p.n)).toEqual([1])
    h.tally.changed(r, snap(poll(0), poll(1)), late)
    // neither a read right after it nor a timer sends B by itself
    expect(counts(await h.tally.view(r, new Date(h.now + 10), live(EMPTY_SNAPSHOT)))).toBe(1)
    await h.runTo(b0 + 2 * W - 1)
    expect(h.published.map((p) => p.n)).toEqual([1])
    // B goes out at the next boundary, with whatever else that window held (here C)
    h.now = b0 + 7_000
    h.tally.changed(r, snap(poll(0), poll(1), poll(2)), h.tally.mark())
    await h.runTo(b0 + 3 * W)
    expect(h.published.map((p) => ({ n: p.n, dt: p.at - b0 }))).toEqual([
      { n: 1, dt: 5_025 },
      { n: 3, dt: 10_025 },
    ])
    for (const p of h.published) expect(p.at % W).toBeLessThanOrEqual(25)
  })

  it('a named activity whose results are not live counts in 1 s windows', async () => {
    const r = rowOf({ anonymous: false })
    const h = harness(r)
    h.tally.started(r)
    const ws = Math.floor(h.now / 1_000) * 1_000
    h.now = ws + 200
    h.tally.changed(r, snap(poll(0)), h.tally.mark())
    expect(counts(await h.tally.view(r, new Date(ws + 900), live(EMPTY_SNAPSHOT)))).toBe(0)
    expect(counts(await h.tally.view(r, new Date(ws + 1_000), live(EMPTY_SNAPSHOT)))).toBe(1)
    expect(h.published.map((p) => p.n)).toEqual([1])
  })

  it('commit order wins over arrival order (the mark is taken under the row lock)', async () => {
    const h = harness()
    const r = h.row()
    h.tally.started(r)
    const first = h.tally.mark()
    const second = h.tally.mark()
    h.tally.changed(r, snap(poll(0), poll(1)), second)
    h.tally.changed(r, snap(poll(0)), first)
    await h.runTo(h.now + 5_000 + 50)
    expect(h.published.map((p) => p.n)).toEqual([2])
  })

  it('ended() forgets the activity: no late event after its final one; a closed one reads the stored answers', async () => {
    const h = harness()
    const r = h.row()
    h.tally.started(r)
    h.tally.changed(r, snap(poll(0)), h.tally.mark())
    h.tally.ended(r.id)
    expect(h.tally.size).toBe(0)
    await h.runTo(h.now + 10_000)
    expect(h.published).toEqual([])
    const closed = rowOf({ status: 'closed' })
    expect(counts(await h.tally.view(closed, new Date(h.now), live(snap(poll(0), poll(2)))))).toBe(2)
  })

  it('an answer that committed before the close but reaches the tally after ended() publishes nothing (review u3)', async () => {
    // A's mark, then B's (both under the row lock, both before the close); B's change lands, the close commits and
    // ends the activity, and only then does A's change get here. Before the fix it made a new entry and, a window
    // later, published A's snapshot (1 answer) after the final event (2): the web applies a same-status event's
    // counts, so every tab showed the stale count of a closed activity.
    const h = harness(rowOf({ anonymous: false, results_live: true }))
    const r = h.row()
    h.tally.started(r)
    const a = h.tally.mark()
    const b = h.tally.mark()
    h.tally.changed(r, snap(poll(0), poll(1)), b)
    h.setRow({ ...r, status: 'closed' })
    h.tally.ended(r.id)
    h.tally.changed(r, snap(poll(0)), a)
    expect(h.tally.size).toBe(0)
    await h.runTo(h.now + 10_000)
    expect(h.published).toEqual([])
    // a later activity on another id is counted as always
    const next = rowOf({ id: 'act_tally000000000000001' })
    h.setRow(next)
    h.tally.started(next)
    h.tally.changed(next, snap(poll(2)), h.tally.mark())
    await h.runTo(h.now + 10_000)
    expect(h.published.map((p) => p.n)).toEqual([1])
  })

  it('an activity that ends by its end time publishes its last answers as final, then forgets it', async () => {
    const h = harness()
    const W = 5_000
    const ws = Math.floor(h.now / W) * W
    const r = rowOf({ ends_at: new Date(ws + 2_000) })
    h.setRow(r)
    h.tally.started(r)
    h.now = ws + 1_500
    h.tally.changed(r, snap(poll(0), poll(1)), h.tally.mark())
    await h.runTo(ws + W + 50)
    expect(h.published.map((p) => p.n)).toEqual([2])
    expect(h.tally.size).toBe(0)
    expect(counts(await h.tally.view(r, new Date(h.now), live(snap(poll(0), poll(1)))))).toBe(2)
  })

  it('after a restart (no entry yet) the first read shows the stored answers and later changes wait', async () => {
    const h = harness()
    const r = h.row()
    expect(counts(await h.tally.view(r, new Date(h.now), live(snap(poll(0), poll(1)))))).toBe(2)
    h.tally.changed(r, snap(poll(0), poll(1), poll(2)), h.tally.mark())
    expect(counts(await h.tally.view(r, new Date(h.now), live(EMPTY_SNAPSHOT)))).toBe(2)
    await h.runTo(h.now + 5_000 + 50)
    expect(h.published.map((p) => p.n)).toEqual([3])
  })

  it('close() stops every timer', async () => {
    const h = harness()
    const r = h.row()
    h.tally.started(r)
    h.tally.changed(r, snap(poll(0)), h.tally.mark())
    h.tally.close()
    expect(h.timers.every((x) => x.cleared)).toBe(true)
    await h.runTo(h.now + 10_000)
    expect(h.published).toEqual([])
  })

  it('no read between two boundaries learns a single answer: every read inside a window answers the same', async () => {
    const h = harness()
    const W = 5_000
    const r = h.row()
    h.tally.started(r)
    const ws = Math.floor(h.now / W) * W + W
    const all: ActivityAnswer[] = []
    const seen = new Set<number>()
    for (let i = 0; i < 40; i++) {
      h.now = ws + i * 100 // 40 answers inside one window (4 s)
      all.push(poll(i % 3))
      h.tally.changed(r, snapshotOf(all), h.tally.mark())
      seen.add(counts(await h.tally.view(r, new Date(h.now + 50), live(EMPTY_SNAPSHOT))))
    }
    expect([...seen]).toEqual([0])
    expect(counts(await h.tally.view(r, new Date(ws + W), live(EMPTY_SNAPSHOT)))).toBe(40)
  })
})
