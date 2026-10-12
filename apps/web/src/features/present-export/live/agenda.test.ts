// L5-1 run of show, the pure part: sections in order with skip, totals, the current and the next section, the
// shared timer's meaning for the live section (time left, overrun, someone else's timer), the stepper's steps,
// drift, and the presenter's record in sessionStorage (and what Wrap up reads from it).
import type { WorkshopTimer } from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type AgendaFrame,
  AgendaRecorder,
  type AgendaStorage,
  agendaActuals,
  agendaLine,
  agendaOf,
  agendaShowsTime,
  driftLine,
  driftOf,
  hasAgenda,
  minsOf,
  minsToMs,
  overText,
  runOfShowEnded,
  sectionsOf,
  stepMins,
  totalPlannedMs,
} from './agenda.ts'

const ME = 'usr_presenter0001'
const OTHER = 'usr_facilitator002'
const T0 = Date.parse('2026-10-09T10:00:00.000Z')

const frames = (over: Partial<AgendaFrame>[] = []): AgendaFrame[] =>
  [
    { id: 'f1', name: 'Warm-up', mins: 2 },
    { id: 'f2', name: 'Ideas', mins: 10 },
    { id: 'f3', name: 'Break', mins: null },
    { id: 'f4', name: 'Vote', mins: 5 },
  ].map((f, i) => ({ ...f, ...over[i] }))

const running = (over: Partial<WorkshopTimer> = {}): WorkshopTimer => ({
  status: 'running',
  durationMs: 120_000,
  remainingMs: 120_000,
  startedAt: new Date(T0).toISOString(),
  endsAt: new Date(T0 + 120_000).toISOString(),
  startedBy: ME,
  updatedAt: new Date(T0).toISOString(),
  ...over,
})
const clock = (timer: WorkshopTimer | null, at = T0, offsetMs = 0) => ({ timer, nowMs: at, offsetMs })

describe('sections and totals', () => {
  it('skipped frames are not sections: the order, the count and the next section leave them out', () => {
    const f = frames([{}, { skip: true }, {}, {}])
    expect(sectionsOf(f).map((s) => s.id)).toEqual(['f1', 'f3', 'f4'])
    const s = agendaOf(f, 'f1', clock(null), ME)
    expect(s).toMatchObject({ index: 0, total: 3, current: { id: 'f1' }, next: { id: 'f3' } })
    // a skipped frame is no section at all
    expect(agendaOf(f, 'f2', clock(null), ME)).toBeNull()
  })

  it('totals the planned minutes (a section with none plans nothing)', () => {
    expect(totalPlannedMs(sectionsOf(frames()))).toBe(minsToMs(17))
    expect(agendaOf(frames(), 'f2', clock(null), ME)?.totalPlannedMs).toBe(minsToMs(17))
  })

  it('names the current and the next section; the last has no next', () => {
    const f = frames()
    expect(agendaOf(f, 'f2', clock(null), ME)).toMatchObject({
      index: 1,
      total: 4,
      current: { id: 'f2', name: 'Ideas' },
      next: { id: 'f3', name: 'Break' },
      plannedMs: minsToMs(10),
    })
    expect(agendaOf(f, 'f4', clock(null), ME)?.next).toBeNull()
  })

  it('is no agenda without any planned minutes (today’s presenting is untouched), or for a slide that is no section', () => {
    const none = frames().map((f) => ({ ...f, mins: null }))
    expect(hasAgenda(sectionsOf(none))).toBe(false)
    expect(agendaOf(none, 'f1', clock(running()), ME)).toBeNull()
    expect(agendaOf(frames(), null, clock(null), ME)).toBeNull()
    expect(agendaOf(frames(), 'gone', clock(null), ME)).toBeNull()
  })

  it('reads minutes only when they are an integer from 1 to 240', () => {
    expect(minsOf({ mins: 5 })).toBe(5)
    expect(minsOf({ index: 1, skip: true, mins: 240 })).toBe(240)
    for (const bad of [0, 241, 1.5, '5', null, Number.NaN, -3]) expect(minsOf({ mins: bad })).toBeNull()
    for (const bad of [undefined, null, 5, 'x', [], {}]) expect(minsOf(bad)).toBeNull()
  })
})

describe('what the shared timer means for the live section', () => {
  it('the presenter’s running timer is the section’s: time left from the server’s end time and clock offset', () => {
    const t = running()
    const s = agendaOf(frames(), 'f1', clock(t, T0 + 10_000), ME)
    expect(s?.timer).toEqual({ kind: 'section', status: 'running', leftMs: 110_000, overMs: 0, own: true })
    // this browser's clock is 3 s behind the server's: its Date.now() reads 3 s early, the offset puts it right
    const behind = agendaOf(frames(), 'f1', clock(t, T0 + 10_000 - 3_000, 3_000), ME)
    expect(behind?.timer).toMatchObject({ leftMs: 110_000 })
  })

  it('past its end time it is over: how long ago it ended ("+0:42 over"), before the server even says finished', () => {
    const t = running()
    const s = agendaOf(frames(), 'f1', clock(t, T0 + 120_000 + 42_000), ME)
    expect(s?.timer).toEqual({ kind: 'section', status: 'finished', leftMs: 0, overMs: 42_000, own: true })
    expect(overText(42_000)).toBe('+0:42 over')
    // the server's own finished state reads the same
    const done = running({ status: 'finished', remainingMs: 0 })
    expect(agendaOf(frames(), 'f1', clock(done, T0 + 125_000), ME)?.timer).toMatchObject({
      status: 'finished',
      overMs: 5_000,
    })
  })

  it('a paused timer shows the time it froze at', () => {
    const t = running({ status: 'paused', remainingMs: 75_000, endsAt: null })
    expect(agendaOf(frames(), 'f1', clock(t, T0 + 999_000), ME)?.timer).toEqual({
      kind: 'section',
      status: 'paused',
      leftMs: 75_000,
      overMs: 0,
      own: true,
    })
  })

  it('someone else’s running or paused timer is theirs (held); their finished one is nobody’s', () => {
    const theirs = running({ startedBy: OTHER })
    expect(agendaOf(frames(), 'f1', clock(theirs, T0 + 1_000), ME)?.timer).toEqual({
      kind: 'held',
      holderId: OTHER,
    })
    const paused = running({ startedBy: OTHER, status: 'paused', endsAt: null })
    expect(agendaOf(frames(), 'f1', clock(paused), ME)?.timer).toMatchObject({ kind: 'held' })
    const done = running({ startedBy: OTHER, status: 'finished', remainingMs: 0 })
    expect(agendaOf(frames(), 'f1', clock(done, T0 + 130_000), ME)?.timer).toEqual({ kind: 'none' })
  })

  it('a stopped or missing timer counts nothing; a section with no minutes shows no timer at all', () => {
    expect(agendaOf(frames(), 'f1', clock(null), ME)?.timer).toEqual({ kind: 'none' })
    const stopped = running({ status: 'stopped', endsAt: null })
    expect(agendaOf(frames(), 'f1', clock(stopped), ME)?.timer).toEqual({ kind: 'none' })
    // 'Break' plans no minutes: the timer of the section before is not its own
    const s = agendaOf(frames(), 'f3', clock(running(), T0 + 1_000), ME)
    expect(s).toMatchObject({ plannedMs: null, timer: { kind: 'none' } })
  })

  it('says it as a line', () => {
    const name = (id: string) => (id === OTHER ? 'Maya' : 'Someone')
    const line = (slide: string, t: WorkshopTimer | null, at = T0) => {
      const s = agendaOf(frames(), slide, clock(t, at), ME)
      return s ? agendaLine(s, name) : null
    }
    expect(line('f1', running(), T0 + 2_000)).toBe('Section 1 of 4 · Warm-up · 1:58 left · next: Ideas')
    expect(line('f1', running(), T0 + 162_000)).toBe('Section 1 of 4 · Warm-up · +0:42 over · next: Ideas')
    expect(line('f1', running({ startedBy: OTHER }))).toBe(
      'Section 1 of 4 · Warm-up · Maya holds the timer · next: Ideas',
    )
    expect(line('f2', null)).toBe('Section 2 of 4 · Ideas · 10 min planned · next: Break')
    expect(line('f3', null)).toBe('Section 3 of 4 · Break · next: Vote')
    expect(line('f4', null)).toBe('Section 4 of 4 · Vote · 5 min planned')
    const paused = running({ status: 'paused', remainingMs: 65_000, endsAt: null })
    expect(line('f1', paused)).toBe('Section 1 of 4 · Warm-up · 1:05 left (paused) · next: Ideas')
  })
})

describe('the stepper’s steps', () => {
  it('starts at 5, moves by 1 under 10 and by 5 from there, stops at 240, and goes down to none', () => {
    expect(stepMins(null, 1)).toBe(5)
    expect(stepMins(5, 1)).toBe(6)
    expect(stepMins(9, 1)).toBe(10)
    expect(stepMins(10, 1)).toBe(15)
    expect(stepMins(235, 1)).toBe(240)
    expect(stepMins(240, 1)).toBe(240)
    expect(stepMins(15, -1)).toBe(10)
    expect(stepMins(10, -1)).toBe(9)
    expect(stepMins(2, -1)).toBe(1)
    expect(stepMins(1, -1)).toBeNull()
    expect(stepMins(null, -1)).toBeNull()
    // every step stays a valid value
    let m: number | null = null
    for (let i = 0; i < 80; i++) {
      m = stepMins(m, 1)
      expect(minsOf({ mins: m })).toBe(m)
    }
    expect(m).toBe(240)
  })
})

describe('one countdown (M2-3)', () => {
  it("the line shows the live section's time when the presenter's timer runs, pauses or has run over", () => {
    const st = (timer: WorkshopTimer | null, at = T0) => agendaOf(frames(), 'f1', clock(timer, at), ME)
    expect(agendaShowsTime(st(running()))).toBe(true)
    expect(agendaShowsTime(st(running({ status: 'paused', endsAt: null })))).toBe(true)
    expect(agendaShowsTime(st(running(), T0 + 150_000))).toBe(true) // over: "+0:30 over"
  })

  it('the line shows no time when nothing counts the section, someone else holds the timer, or there is no agenda', () => {
    expect(agendaShowsTime(agendaOf(frames(), 'f1', clock(null), ME))).toBe(false)
    expect(agendaShowsTime(agendaOf(frames(), 'f1', clock(running({ startedBy: OTHER })), ME))).toBe(false)
    // a section with no minutes shows no timer at all
    expect(agendaShowsTime(agendaOf(frames(), 'f3', clock(running()), ME))).toBe(false)
    expect(agendaShowsTime(null)).toBe(false)
  })
})

describe('the run of show is over (M2-5)', () => {
  const last = (timer: WorkshopTimer | null, at = T0) => agendaOf(frames(), 'f4', clock(timer, at), ME)
  it('the last section with its timer run out ends it; running, paused or none does not', () => {
    const over = running({ durationMs: 300_000, endsAt: new Date(T0 + 300_000).toISOString() })
    expect(runOfShowEnded(last(over, T0 + 301_000))).toBe(true)
    expect(runOfShowEnded(last(over, T0 + 100_000))).toBe(false)
    expect(runOfShowEnded(last({ ...over, status: 'paused', endsAt: null }, T0 + 400_000))).toBe(false)
    expect(runOfShowEnded(last(null))).toBe(false)
  })
  it('a section before the last, someone else’s timer and no agenda never end it', () => {
    const done = running({ endsAt: new Date(T0 + 1_000).toISOString() })
    expect(runOfShowEnded(agendaOf(frames(), 'f1', clock(done, T0 + 5_000), ME))).toBe(false)
    expect(runOfShowEnded(last({ ...done, startedBy: OTHER }, T0 + 5_000))).toBe(false)
    expect(runOfShowEnded(null)).toBe(false)
  })
})

describe('the run of show is over: the last section’s OWN timer (wave N.1)', () => {
  // the section before ran 2 minutes from T0 and its timer is still on the board, finished, when the presenter moves on
  const before = running({ durationMs: 120_000, endsAt: new Date(T0 + 120_000).toISOString() })
  const REACHED = T0 + 200_000 // the presenter reached the last section (his browser's clock)
  const last = (timer: WorkshopTimer | null, at: number, sinceMs: number | null, offsetMs = 0) =>
    agendaOf(frames(), 'f4', { timer, nowMs: at, offsetMs, sinceMs }, ME)
  const started = (ms: number, durationMs = 60_000) =>
    running({
      durationMs,
      startedAt: new Date(ms).toISOString(),
      endsAt: new Date(ms + durationMs).toISOString(),
    })

  it('the section before’s finished timer, left on the board, does not end the run as the presenter arrives', () => {
    expect(runOfShowEnded(last(before, REACHED + 5_000, REACHED))).toBe(false)
    // …and neither does it later (the last section never started a timer of its own)
    expect(runOfShowEnded(last(before, REACHED + 600_000, REACHED))).toBe(false)
  })

  it('the last section’s own timer, started once the presenter reached it, ends the run when it runs out', () => {
    const own = started(REACHED + 1_000)
    expect(runOfShowEnded(last(own, REACHED + 30_000, REACHED))).toBe(false) // running
    expect(runOfShowEnded(last(own, REACHED + 62_000, REACHED))).toBe(true) // finished at +61 s
    // started by hand a minute into the section, the same
    expect(runOfShowEnded(last(started(REACHED + 60_000), REACHED + 125_000, REACHED))).toBe(true)
  })

  it('the browser’s clock and the server’s may differ: the timer’s start is compared on the server’s clock', () => {
    const OFFSET = 3_600_000 // the server is an hour ahead of this browser
    const own = started(REACHED + OFFSET + 1_000)
    expect(runOfShowEnded(last(own, REACHED + 62_000, REACHED, OFFSET))).toBe(true)
    // the section before’s timer, as the server stamped it, is still not this section’s
    const prev = running({
      durationMs: 120_000,
      startedAt: new Date(T0 + OFFSET).toISOString(),
      endsAt: new Date(T0 + OFFSET + 120_000).toISOString(),
    })
    expect(runOfShowEnded(last(prev, REACHED + 5_000, REACHED, OFFSET))).toBe(false)
  })

  it('a record that is not on this section (or a timer with no start) ends nothing; a read with no record (a follower’s) is as before', () => {
    const own = started(REACHED + 1_000)
    expect(runOfShowEnded(last(own, REACHED + 62_000, null))).toBe(false)
    expect(runOfShowEnded(last({ ...own, startedAt: null }, REACHED + 62_000, REACHED))).toBe(false)
    expect(runOfShowEnded(agendaOf(frames(), 'f4', clock(before, REACHED + 5_000), ME))).toBe(true)
  })
})

describe('drift (presenter only)', () => {
  const sections = sectionsOf(frames()) // 2 + 10 + (none) + 5 = 17 min
  it('is planned against projected: finished sections count what they took, the rest their plan', () => {
    const d = driftOf(sections, { f1: minsToMs(3) }, 'f2', 0)
    // f1 took 3 (plan 2), f2 is live and has taken 0 so far (plan 10), f3 plans none, f4 plans 5
    expect(d).toEqual({ plannedMs: minsToMs(17), projectedMs: minsToMs(18), behindMs: minsToMs(1) })
    expect(driftLine(d as NonNullable<typeof d>)).toBe('Planned 17 min · 1 min over')
  })

  // M2-3: it read "planned 5 · projected 5" (numbers with no unit and no meaning)
  it('says it in words: the plan in minutes, then on time, N min over, or N min ahead', () => {
    const drift = (behindMs: number, plannedMin = 5) => ({
      plannedMs: minsToMs(plannedMin),
      projectedMs: minsToMs(plannedMin) + behindMs,
      behindMs,
    })
    expect(driftLine(drift(0))).toBe('Planned 5 min · on time')
    expect(driftLine(drift(minsToMs(2)))).toBe('Planned 5 min · 2 min over')
    expect(driftLine(drift(minsToMs(1)))).toBe('Planned 5 min · 1 min over')
    expect(driftLine(drift(-minsToMs(3), 60))).toBe('Planned 60 min · 3 min ahead')
    // within half a minute of the plan is on time, either way
    expect(driftLine(drift(29_000))).toBe('Planned 5 min · on time')
    expect(driftLine(drift(-29_000))).toBe('Planned 5 min · on time')
    expect(driftLine(drift(31_000))).toBe('Planned 5 min · 1 min over')
    // no jargon
    for (const b of [0, minsToMs(2), -minsToMs(2)]) expect(driftLine(drift(b))).not.toMatch(/projected/i)
  })

  it('the live section counts at least its plan, and what it has taken once that is more', () => {
    const early = driftOf(sections, {}, 'f1', 30_000)
    expect(early?.projectedMs).toBe(minsToMs(17)) // 0:30 into a 2 min section: still on plan
    const late = driftOf(sections, {}, 'f1', minsToMs(5))
    expect(late?.projectedMs).toBe(minsToMs(20)) // 5 min used of 2: 3 over
    expect(late?.behindMs).toBe(minsToMs(3))
  })

  it('a section revisited adds the earlier visit to the one in progress', () => {
    const d = driftOf(sections, { f1: minsToMs(1.5) }, 'f1', minsToMs(1))
    expect(d?.projectedMs).toBe(minsToMs(17) + minsToMs(0.5))
  })

  it('a quick run is ahead: projected below planned', () => {
    const d = driftOf(sections, { f1: minsToMs(1), f2: minsToMs(4) }, 'f4', 0)
    expect(d?.projectedMs).toBe(minsToMs(1 + 4 + 5))
    expect(d && d.behindMs < 0).toBe(true)
  })

  it('is nothing without an agenda', () => {
    expect(driftOf(sectionsOf(frames().map((f) => ({ ...f, mins: null }))), {}, 'f1', 0)).toBeNull()
  })
})

// ---- the record ---------------------------------------------------------------------------------------------

function memoryStorage(): AgendaStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe('the presenter’s record', () => {
  const sections = sectionsOf(frames())
  const clockAt = () => {
    let t = T0
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms
      },
    }
  }

  it('adds up the time each section was visited, in present order', () => {
    const storage = memoryStorage()
    const c = clockAt()
    const r = new AgendaRecorder('b-board', { storage, now: c.now })
    r.begin(sections)
    expect(r.enter('f1', sections)).toBe(true)
    c.advance(130_000)
    expect(r.enter('f2', sections)).toBe(true)
    c.advance(5 * 60_000)
    // back to f1 for a moment: its time adds to the first visit
    expect(r.enter('f1', sections)).toBe(true)
    c.advance(20_000)
    r.stop()
    expect(r.actuals()).toEqual([
      { frameId: 'f1', name: 'Warm-up', plannedMin: 2, actualMs: 150_000 },
      { frameId: 'f2', name: 'Ideas', plannedMin: 10, actualMs: 300_000 },
    ])
  })

  it('says when the visit in progress began (wave N.1: a section’s own timer is one started after it), also after a reload', () => {
    const storage = memoryStorage()
    const c = clockAt()
    const r = new AgendaRecorder('b-board', { storage, now: c.now })
    expect(r.enteredAt('f1')).toBeNull() // nothing on record
    r.begin(sections)
    r.enter('f1', sections)
    c.advance(130_000)
    r.enter('f2', sections)
    expect(r.enteredAt('f2')).toBe(T0 + 130_000)
    expect(r.enteredAt('f1')).toBeNull() // that visit is closed
    c.advance(60_000)
    // back to f1: a new visit, from now
    r.enter('f1', sections)
    expect(r.enteredAt('f1')).toBe(T0 + 190_000)
    expect(new AgendaRecorder('b-board', { storage, now: c.now }).enteredAt('f1')).toBe(T0 + 190_000)
    r.stop()
    expect(r.enteredAt('f1')).toBeNull()
  })

  it('entering the section already being visited changes nothing (a reload of the presenting tab)', () => {
    const storage = memoryStorage()
    const c = clockAt()
    const first = new AgendaRecorder('b-board', { storage, now: c.now })
    first.begin(sections)
    first.enter('f2', sections)
    c.advance(40_000)
    // the page reloaded: a new recorder over the same sessionStorage
    const again = new AgendaRecorder('b-board', { storage, now: c.now })
    expect(again.currentId()).toBe('f2')
    expect(again.enter('f2', sections)).toBe(false)
    c.advance(20_000)
    expect(again.actuals()).toEqual([{ frameId: 'f2', name: 'Ideas', plannedMin: 10, actualMs: 60_000 }])
  })

  it('counts the visit in progress up to now, and reports no run of show as null', () => {
    const storage = memoryStorage()
    const c = clockAt()
    const r = new AgendaRecorder('b-board', { storage, now: c.now })
    expect(r.actuals()).toBeNull()
    r.enter('f1', sections)
    c.advance(61_000)
    expect(r.actuals()?.[0]?.actualMs).toBe(61_000)
    expect(r.snapshot()).toMatchObject({ currentId: 'f1', currentElapsedMs: 61_000 })
  })

  it('a fresh run replaces the old one; clear forgets it', () => {
    const storage = memoryStorage()
    const c = clockAt()
    const r = new AgendaRecorder('b-board', { storage, now: c.now })
    r.enter('f1', sections)
    c.advance(10_000)
    r.stop()
    r.begin(sections)
    expect(r.actuals()).toBeNull()
    r.enter('f4', sections)
    c.advance(1_000)
    r.clear()
    expect(r.actuals()).toBeNull()
    expect(storage.data.size).toBe(0)
  })

  it('works without storage: blocked, full or damaged', () => {
    const throwing: AgendaStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    const c = clockAt()
    const r = new AgendaRecorder('b-board', { storage: throwing, now: c.now })
    expect(() => {
      r.enter('f1', sections)
      c.advance(5_000)
      r.stop()
    }).not.toThrow()
    expect(r.actuals()).toEqual([{ frameId: 'f1', name: 'Warm-up', plannedMin: 2, actualMs: 5_000 }])
    const damaged = memoryStorage()
    damaged.setItem('draftroom:agenda:b-board', '{"v":1,"sections":"nope"}')
    expect(new AgendaRecorder('b-board', { storage: damaged, now: c.now }).actuals()).toBeNull()
    damaged.setItem('draftroom:agenda:b-board', 'not json')
    expect(new AgendaRecorder('b-board', { storage: damaged, now: c.now }).actuals()).toBeNull()
    const none = new AgendaRecorder('b-board', { storage: null, now: c.now })
    none.enter('f1', sections)
    expect(none.actuals()).not.toBeNull()
  })
})

describe('agendaActuals (the export Wrap up reads)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is null on a board this tab presented no agenda on, and the recorded times after a run', () => {
    const storage = memoryStorage()
    vi.stubGlobal('sessionStorage', storage)
    expect(agendaActuals('b-board')).toBeNull()
    let t = T0
    const r = new AgendaRecorder('b-board', { now: () => t })
    const sections = sectionsOf(frames())
    r.enter('f1', sections)
    t += 90_000
    r.enter('f2', sections)
    t += 30_000
    r.stop()
    expect(agendaActuals('b-board')).toEqual([
      { frameId: 'f1', name: 'Warm-up', plannedMin: 2, actualMs: 90_000 },
      { frameId: 'f2', name: 'Ideas', plannedMin: 10, actualMs: 30_000 },
    ])
    // another board's record is another board's
    expect(agendaActuals('b-other')).toBeNull()
  })

  it('is null when storage cannot be read', () => {
    vi.stubGlobal('sessionStorage', {
      getItem() {
        throw new Error('blocked')
      },
    })
    expect(agendaActuals('b-board')).toBeNull()
  })
})
