// Wave V (WS4): one board page's breakout state, and the web half of "follow never leaks across groups": a page obeys
// a group summon only for its own group of the same session, never its own summon, whatever reaches it (the api
// already sends a group's summon to that group's streams only: apps/api/test/features/breakouts/leak.test.ts).
import {
  BREAKOUT_EVENTS,
  type BreakoutState,
  type WorkshopBreakoutBroadcastEvent,
  type WorkshopBreakoutSummonEvent,
} from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import type { BreakoutsClient, Outcome } from './client.ts'
import { BreakoutStore } from './store.ts'
import { iso, ME, OTHER, STARTER, sample, T0 } from './test-kit.ts'

class Events {
  readonly listeners = new Map<string, Set<(d: unknown) => void>>()
  readonly resync = new Set<() => void>()
  on(type: string, l: (d: unknown) => void) {
    const s = this.listeners.get(type) ?? new Set()
    s.add(l)
    this.listeners.set(type, s)
    return () => void s.delete(l)
  }
  onResync(l: () => void) {
    this.resync.add(l)
    return () => void this.resync.delete(l)
  }
  emit(type: string, data: unknown) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(data)
  }
}

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })

function world(answer: () => Outcome<BreakoutState>) {
  const events = new Events()
  const calls: string[] = []
  const client = {
    state: async () => {
      calls.push('state')
      return answer()
    },
  } as unknown as BreakoutsClient
  const groups: string[] = []
  const summons: WorkshopBreakoutSummonEvent[] = []
  const messages: WorkshopBreakoutBroadcastEvent[] = []
  const store = new BreakoutStore({
    client,
    boardId: 'b-0123456789',
    userId: ME,
    events,
    now: () => T0,
    onMyGroup: (_s, g) => groups.push(g),
    onSummon: (e) => summons.push(e),
    onBroadcast: (e) => messages.push(e),
  })
  store.connect()
  return { events, calls, store, groups, summons, messages }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const SESSION = 'brk_0123456789abcdefghij'
const summon = (over: Partial<WorkshopBreakoutSummonEvent> = {}): WorkshopBreakoutSummonEvent => ({
  sessionId: SESSION,
  userId: STARTER,
  name: 'Ada',
  groupId: 'g2',
  ...over,
})

describe('the breakout store', () => {
  it('reads the state, then follows the events of its session; an older rev never wins', async () => {
    const w = world(() => ok(sample()))
    await w.store.refresh()
    expect(w.store.state.get()?.myGroupId).toBe('g2')
    expect(w.groups).toEqual(['g2'])
    const base = sample()
    // moved to g1 by the facilitator (rev 2): the page reads its own group from the members
    w.events.emit(BREAKOUT_EVENTS.state, {
      session: { ...base.session, rev: 2 },
      members: [{ userId: ME, name: 'Me', groupId: 'g1' }],
    })
    expect(w.store.state.get()?.myGroupId).toBe('g1')
    expect(w.groups).toEqual(['g2', 'g1'])
    // a late, older state is dropped
    w.events.emit(BREAKOUT_EVENTS.state, {
      session: { ...base.session, rev: 1 },
      members: [{ userId: ME, name: 'Me', groupId: 'g2' }],
    })
    expect(w.store.state.get()?.myGroupId).toBe('g1')
    expect(w.calls).toEqual(['state'])
  })

  it('a new session in an event is read again (the caller own view is the api); a reconnect reads again', async () => {
    let answer = sample({ session: null, members: [], myGroupId: null })
    const w = world(() => ok(answer))
    await w.store.refresh()
    answer = sample()
    w.events.emit(BREAKOUT_EVENTS.state, { session: answer.session, members: answer.members })
    await tick()
    expect(w.calls).toEqual(['state', 'state'])
    expect(w.store.state.get()?.myGroupId).toBe('g2')
    for (const l of w.events.resync) l()
    await tick()
    expect(w.calls).toHaveLength(3)
  })

  it('an api without breakouts (404): unavailable, no state', async () => {
    const w = world(() => ({ ok: false, unavailable: true, code: 'NOT_FOUND', message: 'x' }))
    await w.store.refresh()
    expect(w.store.available.get()).toBe(false)
    expect(w.store.state.get()).toBeNull()
  })

  it('ended: nobody is in a group any more (no summon applies); sawRunning says the page saw it run', async () => {
    const w = world(() => ok(sample()))
    await w.store.refresh()
    expect(w.store.sawRunning.get()).toBe(true)
    const base = sample()
    w.events.emit(BREAKOUT_EVENTS.state, {
      session: { ...base.session, rev: 5, status: 'ended', endedAt: iso(T0 + 1000) },
      members: base.members,
    })
    expect(w.store.state.get()?.myGroupId).toBeNull()
    expect(w.store.sawRunning.get()).toBe(true)
    w.events.emit(BREAKOUT_EVENTS.summon, summon())
    expect(w.summons).toEqual([])
  })
})

describe('follow never leaks across groups (the web half)', () => {
  it('obeys a summon of its own group only: not another group, not another session, not its own, not in no group', async () => {
    const w = world(() => ok(sample()))
    await w.store.refresh()
    w.events.emit(BREAKOUT_EVENTS.summon, summon({ groupId: 'g1' }))
    w.events.emit(BREAKOUT_EVENTS.summon, summon({ sessionId: 'brk_zzzzzzzzzzzzzzzzzzzz' }))
    w.events.emit(BREAKOUT_EVENTS.summon, summon({ userId: ME }))
    w.events.emit(BREAKOUT_EVENTS.summon, { garbage: true })
    expect(w.summons).toEqual([])
    w.events.emit(BREAKOUT_EVENTS.summon, summon())
    expect(w.summons.map((s) => s.groupId)).toEqual(['g2'])

    // moved out of every group: no summon applies any more
    const base = sample()
    w.events.emit(BREAKOUT_EVENTS.state, {
      session: { ...base.session, rev: 9 },
      members: [{ userId: OTHER, name: 'Other', groupId: 'g1' }],
    })
    w.events.emit(BREAKOUT_EVENTS.summon, summon())
    w.events.emit(BREAKOUT_EVENTS.summon, summon({ groupId: 'g1' }))
    expect(w.summons).toHaveLength(1)
  })

  it('shows a broadcast of its session only', async () => {
    const w = world(() => ok(sample()))
    await w.store.refresh()
    const b = (over: Partial<WorkshopBreakoutBroadcastEvent>) => ({
      sessionId: SESSION,
      text: 'Five minutes left',
      from: { userId: STARTER, name: 'Ada' },
      groupId: null,
      at: iso(T0),
      ...over,
    })
    w.events.emit(BREAKOUT_EVENTS.broadcast, b({}))
    w.events.emit(BREAKOUT_EVENTS.broadcast, b({ sessionId: 'brk_zzzzzzzzzzzzzzzzzzzz' }))
    w.events.emit(BREAKOUT_EVENTS.broadcast, b({ groupId: 'g2', text: 'Group 2 only' }))
    expect(w.messages.map((m) => m.text)).toEqual(['Five minutes left', 'Group 2 only'])
  })
})
