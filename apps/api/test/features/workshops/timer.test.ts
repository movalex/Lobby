import type { WorkshopState } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyTimerAction,
  normalizeTimer,
  type TimerState,
  timeLeftMs,
  timerHolder,
  timerView,
} from '../../../src/features/workshops/timer.ts'
import { expectStatus, json, setupWorld, type World } from './support.ts'

const T0 = new Date('2026-09-26T10:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const MIN = 60_000

function run(steps: [number, Parameters<typeof applyTimerAction>[1]][]): TimerState {
  let s: TimerState | null = null
  for (const [t, action] of steps) s = applyTimerAction(s, action, at(t), 'usr_facilitator0001').next
  if (!s) throw new Error('no state')
  return s
}

describe('timer arithmetic (pure)', () => {
  it('a running or paused timer is held by its starter; a stopped or finished one by nobody (R3)', () => {
    const me = 'usr_facilitator0001'
    const running = run([[0, { action: 'start', durationMs: MIN }]])
    expect(timerHolder(null, 'usr_other000000001', at(0))).toBeNull()
    expect(timerHolder(running, me, at(1000))).toBeNull() // your own
    expect(timerHolder(running, 'usr_other000000001', at(1000))).toBe(me)
    const paused = applyTimerAction(running, { action: 'pause' }, at(1000), me).next
    expect(timerHolder(paused, 'usr_other000000001', at(10 * MIN))).toBe(me)
    expect(timerHolder(running, 'usr_other000000001', at(2 * MIN))).toBeNull() // finished
    const stopped = applyTimerAction(running, { action: 'stop' }, at(1000), me).next
    expect(timerHolder(stopped, 'usr_other000000001', at(2000))).toBeNull()
  })

  it('start stores the end timestamp; time left is derived from it', () => {
    const s = run([[0, { action: 'start', durationMs: 5 * MIN }]])
    expect(s.status).toBe('running')
    expect(s.endsAt?.toISOString()).toBe(at(5 * MIN).toISOString())
    expect(timeLeftMs(s, at(0))).toBe(5 * MIN)
    expect(timeLeftMs(s, at(90_000))).toBe(210_000)
    expect(timerView(s, at(90_000))).toMatchObject({
      status: 'running',
      remainingMs: 210_000,
      durationMs: 5 * MIN,
    })
  })

  it('pause freezes what is left; resume continues from it; add extends either', () => {
    let s = run([
      [0, { action: 'start', durationMs: 5 * MIN }],
      [30_000, { action: 'pause' }],
    ])
    expect(s).toMatchObject({ status: 'paused', remainingMs: 270_000, endsAt: null })
    // Paused time does not count down, however long it lasts.
    expect(timeLeftMs(s, at(10 * MIN))).toBe(270_000)
    s = applyTimerAction(s, { action: 'add', addMs: MIN }, at(10 * MIN), 'u').next
    expect(s).toMatchObject({ status: 'paused', remainingMs: 330_000 })
    s = applyTimerAction(s, { action: 'resume' }, at(20 * MIN), 'u').next
    expect(s.status).toBe('running')
    expect(s.endsAt?.toISOString()).toBe(at(20 * MIN + 330_000).toISOString())
    s = applyTimerAction(s, { action: 'add', addMs: 5 * MIN }, at(21 * MIN), 'u').next
    expect(timeLeftMs(s, at(21 * MIN))).toBe(330_000 - MIN + 5 * MIN)
    // the set duration is what Stop resets to; adds do not change it
    expect(s.durationMs).toBe(5 * MIN)
  })

  it('a running timer past its end is finished; +time runs it again; stop resets to the set duration', () => {
    const s = run([[0, { action: 'start', durationMs: MIN }]])
    expect(normalizeTimer(s, at(MIN)).status).toBe('finished')
    expect(timerView(s, at(2 * MIN))).toMatchObject({ status: 'finished', remainingMs: 0 })
    const again = applyTimerAction(s, { action: 'add', addMs: MIN }, at(3 * MIN), 'u')
    expect(again.changed).toBe(true)
    expect(again.next.status).toBe('running')
    expect(timeLeftMs(again.next, at(3 * MIN + 15_000))).toBe(45_000)
    const stopped = applyTimerAction(again.next, { action: 'stop' }, at(3 * MIN + 20_000), 'u').next
    expect(stopped).toMatchObject({ status: 'stopped', remainingMs: MIN, endsAt: null })
    expect(timeLeftMs(stopped, at(99 * MIN))).toBe(MIN)
  })

  it('no-ops report changed=false; impossible actions are refused', () => {
    const s = run([
      [0, { action: 'start', durationMs: MIN }],
      [1000, { action: 'pause' }],
    ])
    expect(applyTimerAction(s, { action: 'pause' }, at(2000), 'u').changed).toBe(false)
    const running = applyTimerAction(s, { action: 'resume' }, at(2000), 'u').next
    expect(applyTimerAction(running, { action: 'resume' }, at(3000), 'u').changed).toBe(false)
    // pausing a timer that already reached zero changes nothing
    expect(applyTimerAction(running, { action: 'pause' }, at(10 * MIN), 'u').changed).toBe(false)
    const stopped = applyTimerAction(running, { action: 'stop' }, at(4000), 'u').next
    expect(applyTimerAction(stopped, { action: 'stop' }, at(5000), 'u').changed).toBe(false)
    expect(() => applyTimerAction(stopped, { action: 'add', addMs: MIN }, at(5000), 'u')).toThrow(
      /Start the timer/,
    )
    expect(() => applyTimerAction(null, { action: 'pause' }, at(0), 'u')).toThrow()
    const long = run([[0, { action: 'start', durationMs: 24 * 60 * MIN - 1000 }]])
    expect(() => applyTimerAction(long, { action: 'add', addMs: 5 * MIN }, at(0), 'u')).toThrow(/24 hours/)
  })

  it('start restarts from the full duration from any state', () => {
    const s = run([
      [0, { action: 'start', durationMs: MIN }],
      [30_000, { action: 'pause' }],
      [40_000, { action: 'start', durationMs: 2 * MIN }],
    ])
    expect(s).toMatchObject({ status: 'running', durationMs: 2 * MIN, startedAt: at(40_000) })
    expect(timeLeftMs(s, at(40_000))).toBe(2 * MIN)
  })
})

describe('timer routes', () => {
  let w: World
  afterEach(async () => {
    await w?.api.close()
  })

  const timer = (c: World['owner'], body: unknown) => c.req('POST', `/api/boards/${w.boardId}/timer`, body)
  const state = async (c: World['owner']) => {
    const res = await c.req('GET', `/api/boards/${w.boardId}/workshop`)
    expectStatus(res, 200)
    return json<WorkshopState>(res)
  }

  it('only editors and owners control it; viewers and commenters see it; outsiders see nothing', async () => {
    w = await setupWorld()
    expectStatus(await timer(w.viewer, { action: 'start', durationMs: MIN }), 403)
    expectStatus(await timer(w.commenter, { action: 'start', durationMs: MIN }), 403)
    expectStatus(await timer(w.outsider, { action: 'start', durationMs: MIN }), 404)
    expectStatus(await w.api.anon('POST', `/api/boards/${w.boardId}/timer`, { action: 'stop' }), 401)
    expect(w.events).toHaveLength(0)

    expectStatus(await timer(w.editor, { action: 'start', durationMs: MIN }), 200)
    expectStatus(await timer(w.owner, { action: 'pause' }), 200) // the board owner may act on anyone's
    for (const c of [w.viewer, w.commenter]) {
      const s = await state(c)
      expect(s.timer).toMatchObject({ status: 'paused', remainingMs: MIN, startedBy: w.editor.userId })
    }
    expectStatus(await w.outsider.req('GET', `/api/boards/${w.boardId}/workshop`), 404)
    // viewers can't pause/resume/stop/add either
    for (const body of [{ action: 'resume' }, { action: 'stop' }, { action: 'add', addMs: MIN }])
      expectStatus(await timer(w.viewer, body), 403)
  })

  it('late joiners get the same remaining time (server timestamps); pause/resume/add through the API', async () => {
    w = await setupWorld()
    expectStatus(await timer(w.owner, { action: 'start', durationMs: 5 * MIN }), 200)
    w.clock.advance(90_000)
    const late = await state(w.viewer) // joins 90 s in
    expect(late.timer?.status).toBe('running')
    expect(late.timer?.remainingMs).toBe(210_000)
    // The client computes endsAt - serverNow: identical to what the server says.
    expect(Date.parse(late.timer?.endsAt ?? '') - Date.parse(late.serverNow)).toBe(210_000)

    w.clock.advance(30_000)
    const paused = json<{ timer: { remainingMs: number; status: string } }>(
      await timer(w.owner, { action: 'pause' }),
    )
    expect(paused.timer).toMatchObject({ status: 'paused', remainingMs: 180_000 })
    w.clock.advance(10 * MIN)
    expect((await state(w.commenter)).timer).toMatchObject({
      status: 'paused',
      remainingMs: 180_000,
      endsAt: null,
    })
    expectStatus(await timer(w.owner, { action: 'add', addMs: MIN }), 200)
    expectStatus(await timer(w.owner, { action: 'resume' }), 200)
    w.clock.advance(60_000)
    expect((await state(w.viewer)).timer?.remainingMs).toBe(180_000)
    w.clock.advance(180_000)
    expect((await state(w.viewer)).timer).toMatchObject({ status: 'finished', remainingMs: 0 })
    expectStatus(await timer(w.owner, { action: 'stop' }), 200)
    expect((await state(w.viewer)).timer).toMatchObject({ status: 'stopped', remainingMs: 5 * MIN })
  })

  it("someone else's running or paused timer is theirs: other editors can't pause, stop, extend or restart it (R3)", async () => {
    w = await setupWorld()
    expectStatus(await timer(w.owner, { action: 'start', durationMs: 5 * MIN }), 200)
    w.clock.advance(2_000)
    for (const body of [
      { action: 'pause' },
      { action: 'stop' },
      { action: 'add', addMs: MIN },
      { action: 'start', durationMs: MIN },
    ]) {
      const res = await timer(w.editor, body)
      expectStatus(res, 403)
      expect(json<{ error: { code: string } }>(res).error.code).toBe('TIMER_NOT_YOURS')
    }
    expect((await state(w.viewer)).timer).toMatchObject({ status: 'running', startedBy: w.owner.userId })
    expect(w.events).toHaveLength(1) // only the start
    expectStatus(await timer(w.owner, { action: 'pause' }), 200)
    expectStatus(await timer(w.editor, { action: 'resume' }), 403)
    // Once it is stopped (or finished), anyone who facilitates starts their own; the owner may still
    // act on it, and the editor on their own.
    expectStatus(await timer(w.owner, { action: 'stop' }), 200)
    expectStatus(await timer(w.editor, { action: 'start', durationMs: MIN }), 200)
    expectStatus(await timer(w.editor, { action: 'pause' }), 200)
    expectStatus(await timer(w.owner, { action: 'resume' }), 200)
    w.clock.advance(2 * MIN)
    expect((await state(w.viewer)).timer?.status).toBe('finished')
    expectStatus(await timer(w.owner, { action: 'start', durationMs: MIN }), 200)
  })

  it('publishes each change (after commit) and nothing for no-ops', async () => {
    w = await setupWorld()
    expectStatus(await timer(w.owner, { action: 'start', durationMs: MIN }), 200)
    expectStatus(await timer(w.owner, { action: 'resume' }), 200) // already running: no-op
    expectStatus(await timer(w.owner, { action: 'add', addMs: 5 * MIN }), 200)
    expect(w.events.map((e) => e.type)).toEqual(['workshop.timer', 'workshop.timer'])
    const last = w.events[1]?.data as { timer: { remainingMs: number; endsAt: string } }
    expect(last.timer.remainingMs).toBe(6 * MIN)
    const s = await state(w.viewer)
    expect(s.timer?.endsAt).toBe(last.timer.endsAt)
  })

  it('rejects bad input and actions that do not apply', async () => {
    w = await setupWorld()
    expectStatus(await timer(w.owner, { action: 'start', durationMs: 0 }), 400)
    expectStatus(await timer(w.owner, { action: 'start', durationMs: 25 * 60 * MIN }), 400)
    expectStatus(await timer(w.owner, { action: 'explode' }), 400)
    expectStatus(await timer(w.owner, { action: 'add', addMs: MIN }), 409) // no timer yet
    expectStatus(await timer(w.owner, { action: 'pause' }), 409)
    expect((await state(w.owner)).timer).toBeNull()
  })

  it('an archived board keeps showing the timer but nobody can change it', async () => {
    w = await setupWorld()
    expectStatus(await timer(w.owner, { action: 'start', durationMs: MIN }), 200)
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/archive`), 200)
    expectStatus(await timer(w.owner, { action: 'pause' }), 403)
    expect((await state(w.viewer)).timer?.status).toBe('running')
  })
})
