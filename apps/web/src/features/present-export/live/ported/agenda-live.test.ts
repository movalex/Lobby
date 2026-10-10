// L5-1 run of show, the live side (./agenda-live.ts) over the real workshop store and a small in-memory board:
// what the presenting tab does as the live slide moves. The api is the kit's fake (every request recorded).
import type { WorkshopTimer } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atom } from '../../../../lib/signals.ts'
import { ME, workshopKit } from '../../../workshops/ported/ctx-kit.ts'
import { el } from '../../../workshops/ported/test-kit.ts'
import { agendaActuals, driftOf, sectionsOf } from '../agenda.ts'
import { type AgendaLive, agendaFramesOf, mountAgenda } from './agenda-live.ts'

const OTHER = 'usr_someoneelse0002'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

const frame = (id: string, name: string, index: number, mins?: number, more: Record<string, unknown> = {}) =>
  el(id, 'frame', {
    name,
    x: index * 1000,
    y: 0,
    width: 800,
    height: 450,
    customData: { lobby: { present: { index, ...(mins ? { mins } : {}) } } },
    ...more,
  })

const timerAt = (
  durationMs: number,
  startedBy = ME,
  status: WorkshopTimer['status'] = 'running',
): WorkshopTimer => {
  const now = Date.now()
  return {
    status,
    durationMs,
    remainingMs: durationMs,
    startedAt: new Date(now).toISOString(),
    endsAt: status === 'running' ? new Date(now + durationMs).toISOString() : null,
    startedBy,
    updatedAt: new Date(now).toISOString(),
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Answers the next `n` timer requests as the api does (a running timer of the asked length, started by me). */
function answerTimers(kit: ReturnType<typeof workshopKit>, n: number, refuse = false) {
  for (let i = 0; i < n; i++)
    kit.next(
      (m, p) => m === 'POST' && p.endsWith('/timer'),
      (body) => {
        if (refuse)
          throw Object.assign(new Error('Someone else is running this timer.'), { code: 'TIMER_NOT_YOURS' })
        const ms = (body as { durationMs: number }).durationMs
        return { timer: timerAt(ms), serverNow: new Date().toISOString() }
      },
    )
}
const timerCalls = (kit: ReturnType<typeof workshopKit>) =>
  kit.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/timer')).map((c) => c.body)

function setup(
  elements = [frame('f1', 'Warm-up', 0, 2), frame('f2', 'Ideas', 1, 1), frame('f3', 'Break', 2)],
) {
  const kit = workshopKit({ elements })
  const presentingLive = atom('t-live', false)
  const cur = atom('t-cur', { index: 0, slideId: 'f1' as string | null, count: elements.length })
  /** the live presentation's id as the api names it (a hand-off keeps it) */
  const pid = { current: 'prs_one' as string | null }
  const agenda: AgendaLive = mountAgenda(kit.ctx, {
    presenter: { current: () => cur.get() },
    presentingLive,
    presentationId: () => pid.current,
  })
  const go = async (slideId: string | null) => {
    cur.set({ index: ['f1', 'f2', 'f3'].indexOf(slideId ?? ''), slideId, count: elements.length })
    await settle()
  }
  const present = async (on = true) => {
    presentingLive.set(on)
    await settle()
  }
  return { kit, agenda, go, present, presentingLive, cur, pid }
}

let storage: ReturnType<typeof memoryStorage>
beforeEach(() => {
  storage = memoryStorage()
  vi.stubGlobal('sessionStorage', storage)
})
afterEach(() => vi.unstubAllGlobals())

describe('the frames as the presentation names them', () => {
  it('are the slides in present order with their minutes; skipped and empty frames are not sections', () => {
    const { kit, agenda } = setup([
      frame('f1', 'Warm-up', 1, 2),
      frame('f2', '', 0, 5), // unnamed: "Frame 1", and first by its index
      frame('f3', 'Skipped', 2, 9, {
        customData: { lobby: { present: { index: 2, skip: true, mins: 9 } } },
      }),
      frame('f4', 'Flat', 3, 3, { width: 0 }),
    ])
    expect(agendaFramesOf(kit.ctx.canvas)).toEqual([
      { id: 'f2', name: 'Frame 1', mins: 5 },
      { id: 'f1', name: 'Warm-up', mins: 2 },
    ])
    agenda.dispose()
  })
})

describe('the section timer follows the live slide', () => {
  it('starts the first section’s timer when the presentation to everyone begins, and each next one as the slide moves', async () => {
    const { kit, agenda, go, present } = setup()
    answerTimers(kit, 3)
    await present()
    expect(timerCalls(kit)).toEqual([{ action: 'start', durationMs: 120_000 }])
    await go('f2')
    expect(timerCalls(kit)).toEqual([
      { action: 'start', durationMs: 120_000 },
      { action: 'start', durationMs: 60_000 },
    ])
    // the same slide again (any re-run of the watcher) starts nothing
    await go('f2')
    expect(timerCalls(kit)).toHaveLength(2)
    agenda.dispose()
  })

  it('a section with no minutes starts nothing, and does not stop the one before', async () => {
    const { kit, agenda, go, present } = setup()
    answerTimers(kit, 2)
    await present()
    await go('f3') // "Break": no minutes
    expect(timerCalls(kit)).toHaveLength(1)
    expect(
      kit.calls.some((c) => c.path.endsWith('/timer') && (c.body as { action: string }).action === 'stop'),
    ).toBe(false)
    agenda.dispose()
  })

  it('does nothing outside a presentation to everyone (a private preview never touches the shared timer)', async () => {
    const { kit, agenda, go } = setup()
    await go('f2')
    expect(kit.calls).toEqual([])
    expect(agendaActuals(kit.ctx.board.id)).toBeNull()
    agenda.dispose()
  })

  it('with Auto-time off it starts nothing, but the record still counts the sections', async () => {
    const { kit, agenda, go, present } = setup()
    expect(agenda.autoTime.get()).toBe(true) // on by default: the board has minutes
    agenda.setAutoTime(false)
    expect(agenda.autoTime.get()).toBe(false)
    expect(storage.data.get(`draftroom:agenda-auto:${kit.ctx.board.id}`)).toBe('off')
    await present()
    await go('f2')
    expect(timerCalls(kit)).toEqual([])
    expect(agenda.recorder.actuals()?.map((a) => a.frameId)).toEqual(['f1', 'f2'])
    agenda.dispose()
  })

  it('never stops, or starts over, a timer someone else is running (it asks nothing while it sees it)', async () => {
    const { kit, agenda, go, present } = setup()
    kit.workshop = { timer: timerAt(600_000, OTHER), vote: null, serverNow: new Date().toISOString() }
    await kit.store.refresh()
    await present()
    await go('f2')
    expect(timerCalls(kit)).toEqual([])
    expect(kit.store.getSnapshot().timer?.startedBy).toBe(OTHER) // still theirs, still running
    agenda.dispose()
  })

  it('when the api says it is someone else’s (this tab was behind), it fetches the truth and leaves the timer alone', async () => {
    const { kit, agenda, present } = setup()
    answerTimers(kit, 1, true)
    kit.workshop = { timer: timerAt(600_000, OTHER), vote: null, serverNow: new Date().toISOString() }
    const before = kit.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/workshop')).length
    await present()
    expect(timerCalls(kit)).toHaveLength(1)
    expect(kit.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/workshop')).length).toBe(
      before + 1,
    )
    expect(kit.store.getSnapshot().timer?.startedBy).toBe(OTHER)
    agenda.dispose()
  })

  it('a presentation with no planned minutes anywhere is today’s presenting: nothing is called or recorded', async () => {
    const { kit, agenda, go, present } = setup([
      frame('f1', 'A', 0),
      frame('f2', 'B', 1),
      frame('f3', 'C', 2),
    ])
    expect(agenda.autoTime.get()).toBe(false)
    await present()
    await go('f2')
    expect(kit.calls).toEqual([])
    expect(agenda.recorder.active()).toBe(false)
    agenda.dispose()
  })

  it('a failing board read never breaks presenting', async () => {
    const { kit, agenda, present } = setup()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(kit.ctx.canvas as unknown as { items: () => never }).items = () => {
      throw new Error('boom')
    }
    await expect(present()).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
    agenda.dispose()
  })
})

describe('the record of the run', () => {
  it('records the time in each section, closes the visit when the presentation ends, and a new run starts afresh', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-09T10:00:00Z'))
      const { kit, agenda, go, present, pid } = setup()
      answerTimers(kit, 4)
      await present()
      vi.advanceTimersByTime(130_000)
      await go('f2')
      vi.advanceTimersByTime(45_000)
      await present(false) // Esc: the presentation ends
      expect(agendaActuals(kit.ctx.board.id)).toEqual([
        { frameId: 'f1', name: 'Warm-up', plannedMin: 2, actualMs: 130_000 },
        { frameId: 'f2', name: 'Ideas', plannedMin: 1, actualMs: 45_000 },
      ])
      // the next run (a new presentation) forgets this one
      pid.current = 'prs_two'
      await go('f1')
      await present()
      expect(agendaActuals(kit.ctx.board.id)).toEqual([
        { frameId: 'f1', name: 'Warm-up', plannedMin: 2, actualMs: 0 },
      ])
      agenda.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('handing the presentation off and taking it back keeps the record and does not restart the section (round 1)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-09T10:00:00Z'))
      const { kit, agenda, go, present } = setup()
      answerTimers(kit, 4)
      await present()
      vi.advanceTimersByTime(130_000)
      await go('f2')
      vi.advanceTimersByTime(40_000)
      // handed to B (same presentation, this tab stops presenting), then back to this tab on the same slide
      await present(false)
      vi.advanceTimersByTime(10_000)
      await present()
      vi.advanceTimersByTime(5_000)
      expect(timerCalls(kit)).toEqual([
        { action: 'start', durationMs: 120_000 },
        { action: 'start', durationMs: 60_000 },
      ])
      expect(agendaActuals(kit.ctx.board.id)).toEqual([
        { frameId: 'f1', name: 'Warm-up', plannedMin: 2, actualMs: 130_000 },
        { frameId: 'f2', name: 'Ideas', plannedMin: 1, actualMs: 45_000 },
      ])
      // a next section after taking it back is a new visit with its own timer
      await go('f3')
      expect(timerCalls(kit)).toHaveLength(2) // Break has no minutes
      agenda.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('taking the presentation back after a reload of this tab keeps the record and does not restart the section (round 2)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-09T10:00:00Z'))
      const first = setup()
      answerTimers(first.kit, 2)
      await first.present()
      vi.advanceTimersByTime(130_000)
      await first.go('f2')
      vi.advanceTimersByTime(40_000)
      // handed to B (this tab stops presenting), then this tab reloads while B presents
      await first.present(false)
      expect(timerCalls(first.kit)).toHaveLength(2)
      first.agenda.dispose()
      const second = setup()
      answerTimers(second.kit, 2)
      second.cur.set({ index: 1, slideId: 'f2', count: 3 })
      vi.advanceTimersByTime(10_000)
      // B hands the same presentation back on f2: the room's f2 countdown is not started over
      await second.present()
      vi.advanceTimersByTime(5_000)
      expect(timerCalls(second.kit)).toEqual([])
      expect(agendaActuals(second.kit.ctx.board.id)).toEqual([
        { frameId: 'f1', name: 'Warm-up', plannedMin: 2, actualMs: 130_000 },
        { frameId: 'f2', name: 'Ideas', plannedMin: 1, actualMs: 45_000 },
      ])
      // a new presentation after the reload still starts afresh
      await second.present(false)
      second.pid.current = 'prs_two'
      await second.go('f1')
      await second.present()
      expect(timerCalls(second.kit)).toEqual([{ action: 'start', durationMs: 120_000 }])
      expect(agendaActuals(second.kit.ctx.board.id)).toEqual([
        { frameId: 'f1', name: 'Warm-up', plannedMin: 2, actualMs: 0 },
      ])
      second.agenda.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  // M2-3: a record outlived its presentation in the same tab (the tab reloaded, or the presentation ended elsewhere,
  // with a visit still open), and the next presentation inherited its times and its open visit
  it('a new presentation in the same tab starts afresh: no times of the last one (no "projected" number) and its first section’s timer is not skipped', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
      const first = setup()
      answerTimers(first.kit, 3)
      await first.present()
      vi.advanceTimersByTime(130_000)
      await first.go('f2')
      vi.advanceTimersByTime(40_000)
      // the tab goes (a reload, a crash) in the middle of f2: nothing stops the recorder, the visit stays open
      first.agenda.dispose()
      expect(first.agenda.recorder.currentId()).toBe('f2')

      // later, in the same tab (same sessionStorage), another presentation to everyone begins on f2
      const second = setup()
      second.pid.current = 'prs_two'
      answerTimers(second.kit, 2)
      second.cur.set({ index: 1, slideId: 'f2', count: 3 })
      vi.advanceTimersByTime(60_000)
      await second.present()
      // its first section's timer starts (it was skipped: the open visit of the other presentation was "this" visit)
      expect(timerCalls(second.kit)).toEqual([{ action: 'start', durationMs: 60_000 }])
      // nothing of the last run: no f1 time, f2 counts from now
      expect(agendaActuals(second.kit.ctx.board.id)).toEqual([
        { frameId: 'f2', name: 'Ideas', plannedMin: 1, actualMs: 0 },
      ])
      expect(second.agenda.recorder.presentationId()).toBe('prs_two')
      // the drift has nothing to project from the last run: on plan
      const snap = second.agenda.recorder.snapshot()
      expect(snap.actualMs).toEqual({ f2: 0 })
      const d = driftOf(
        sectionsOf(agendaFramesOf(second.kit.ctx.canvas)),
        snap.actualMs,
        snap.currentId,
        snap.currentElapsedMs,
      )
      expect(d?.behindMs).toBe(0)
      second.agenda.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the same presentation after a reload keeps its record (only another presentation’s is dropped)', async () => {
    const first = setup()
    answerTimers(first.kit, 2)
    await first.present()
    await first.go('f2')
    first.agenda.dispose()
    const second = setup() // the same presentation id, prs_one
    second.cur.set({ index: 1, slideId: 'f2', count: 3 })
    await second.present()
    expect(second.agenda.recorder.presentationId()).toBe('prs_one')
    expect(second.agenda.recorder.currentId()).toBe('f2')
    expect(timerCalls(second.kit)).toEqual([])
    second.agenda.dispose()
  })

  it('a reload of the presenting tab carries on in the same section without starting its timer again', async () => {
    const first = setup()
    answerTimers(first.kit, 2)
    await first.present()
    await first.go('f2')
    expect(timerCalls(first.kit)).toHaveLength(2)
    first.agenda.dispose()
    // the tab reloads: new store, new watcher, the same sessionStorage; the live slide is f2
    const second = setup()
    second.cur.set({ index: 1, slideId: 'f2', count: 3 })
    await second.present()
    expect(timerCalls(second.kit)).toEqual([])
    expect(second.agenda.recorder.currentId()).toBe('f2')
    second.agenda.dispose()
  })
})
