import type { WorkshopState, WorkshopTimer, WorkshopVoteState } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { type EventSource, type RequestFn, WorkshopStore } from './store.ts'

const ISO = (ms: number) => new Date(Date.parse('2026-09-26T10:00:00.000Z') + ms).toISOString()
const SID = 'vot_0123456789abcdefghij'

function timer(over: Partial<WorkshopTimer> = {}): WorkshopTimer {
  return {
    status: 'running',
    durationMs: 60_000,
    remainingMs: 60_000,
    endsAt: ISO(60_000),
    startedAt: ISO(0),
    startedBy: 'usr_facilitator0001',
    updatedAt: ISO(0),
    ...over,
  }
}

function voteState(over: Partial<WorkshopVoteState> = {}): WorkshopVoteState {
  return {
    session: {
      id: SID,
      boardId: 'b-abc1234567',
      title: 'Vote',
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
      frameId: null,
      shapeTypes: null,
      status: 'open',
      createdBy: 'usr_facilitator0001',
      createdAt: ISO(0),
      endsAt: null,
      closedAt: null,
      revealedAt: null,
    },
    myVotes: {},
    myRemaining: 3,
    done: false,
    participantsDone: 0,
    participants: 0,
    totalVotesCast: 0,
    results: null,
    ...over,
  }
}

class FakeEvents implements EventSource {
  listeners = new Map<string, Set<(d: unknown) => void>>()
  resync = new Set<() => void>()
  offset = 0
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
  serverOffsetMs() {
    return this.offset
  }
  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(data)
  }
}

interface Call {
  method: string
  path: string
  body?: unknown
}

function harness(initial: WorkshopState) {
  const calls: Call[] = []
  let current = initial
  const handlers: ((c: Call) => unknown | Promise<unknown>)[] = []
  const request = (async (method: string, path: string, opts: { body?: unknown; schema: unknown }) => {
    const call = { method, path, body: opts.body }
    calls.push(call)
    const h = handlers.shift()
    if (h) return h(call)
    if (method === 'GET' && path.endsWith('/workshop')) return current
    throw new Error(`unexpected ${method} ${path}`)
  }) as unknown as RequestFn
  const events = new FakeEvents()
  const store = new WorkshopStore({
    boardId: 'b-abc1234567',
    userId: 'usr_me0000000001',
    request,
    events,
    storage: null,
  })
  return {
    store,
    events,
    calls,
    setServer: (s: WorkshopState) => {
      current = s
    },
    next: (h: (c: Call) => unknown | Promise<unknown>) => handlers.push(h),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('WorkshopStore', () => {
  it('loads, then applies timer events directly (they are safe for everyone)', async () => {
    const h = harness({ timer: null, vote: null, serverNow: ISO(0) })
    await h.store.refresh()
    expect(h.store.getSnapshot()).toMatchObject({ loaded: true, timer: null, vote: null })
    h.events.emit('workshop.timer', { timer: timer() })
    expect(h.store.getSnapshot().timer?.status).toBe('running')
    // an older timer (a slow, stale message) never replaces a newer one
    h.events.emit('workshop.timer', { timer: timer({ status: 'paused', endsAt: null, updatedAt: ISO(-5) }) })
    expect(h.store.getSnapshot().timer?.status).toBe('running')
    // garbage is ignored
    h.events.emit('workshop.timer', { timer: { status: 'exploded' } })
    expect(h.store.getSnapshot().timer?.status).toBe('running')
  })

  it('vote events only carry aggregates; a new or ended vote refetches the caller’s own view', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    const before = h.calls.length
    h.events.emit('workshop.vote', {
      sessionId: SID,
      status: 'open',
      totalVotesCast: 4,
      participants: 2,
      participantsDone: 1,
      endsAt: null,
    })
    expect(h.store.getSnapshot().vote).toMatchObject({
      totalVotesCast: 4,
      participants: 2,
      participantsDone: 1,
    })
    expect(h.calls.length).toBe(before) // same vote, same status: no refetch
    h.setServer({
      timer: null,
      vote: voteState({ session: { ...voteState().session, status: 'closed' } }),
      serverNow: ISO(1),
    })
    h.events.emit('workshop.vote', {
      sessionId: SID,
      status: 'closed',
      totalVotesCast: 4,
      participants: 2,
      participantsDone: 1,
      endsAt: null,
    })
    await flush()
    expect(h.calls.at(-1)?.path).toBe('/api/boards/b-abc1234567/workshop')
    h.events.emit('workshop.vote', {
      sessionId: 'vot_another0000000000',
      status: 'open',
      totalVotesCast: 0,
      participants: 0,
      participantsDone: 0,
      endsAt: null,
    })
    await flush()
    expect(h.calls.filter((c) => c.path.endsWith('/workshop')).length).toBe(3)
  })

  it('results events reveal the ranking for the current vote', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    h.events.emit('workshop.vote.results', {
      sessionId: SID,
      results: [{ shapeId: 'shape:a', count: 2, rank: 1 }],
      totalVotesCast: 2,
      participants: 1,
    })
    expect(h.store.getSnapshot().vote).toMatchObject({
      session: { status: 'revealed' },
      results: [{ shapeId: 'shape:a', count: 2, rank: 1 }],
    })
  })

  it('casts are optimistic, sent one at a time in order, and reconciled with the server', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    const releases: (() => void)[] = []
    const reply = (v: WorkshopVoteState) => () => new Promise((res) => releases.push(() => res(v)))
    h.next(reply(voteState({ myVotes: { 'shape:a': 1 }, myRemaining: 2 })))
    h.next(reply(voteState({ myVotes: { 'shape:a': 2 }, myRemaining: 1 })))
    const p1 = h.store.cast('shape:a', 1)
    const p2 = h.store.cast('shape:a', 1)
    // both dots show immediately
    expect(h.store.getSnapshot().ballot).toEqual({ myVotes: { 'shape:a': 2 }, myRemaining: 1 })
    await flush()
    expect(h.calls.filter((c) => c.path.endsWith('/cast'))).toHaveLength(1) // second waits for the first
    releases.shift()?.()
    await p1
    await flush()
    expect(h.calls.filter((c) => c.path.endsWith('/cast'))).toHaveLength(2)
    releases.shift()?.()
    await p2
    expect(h.store.getSnapshot()).toMatchObject({
      pendingCount: 0,
      ballot: { myVotes: { 'shape:a': 2 }, myRemaining: 1 },
    })
  })

  it('a refused cast rolls the dot back; over-budget casts never leave the browser', async () => {
    const h = harness({ timer: null, vote: voteState({ myRemaining: 1 }), serverNow: ISO(0) })
    await h.store.refresh()
    h.next(() => {
      throw Object.assign(new Error('This allows one vote per object.'), { code: 'ONE_PER_OBJECT' })
    })
    const r = await h.store.cast('shape:a', 1)
    expect(r).toMatchObject({ ok: false, code: 'ONE_PER_OBJECT' })
    expect(h.store.getSnapshot().ballot).toEqual({ myVotes: {}, myRemaining: 1 })
    h.next(() => voteState({ myVotes: { 'shape:b': 1 }, myRemaining: 0 }))
    expect((await h.store.cast('shape:b', 1)).ok).toBe(true)
    const castsBefore = h.calls.filter((c) => c.path.endsWith('/cast')).length
    const over = await h.store.cast('shape:c', 1)
    expect(over).toMatchObject({ ok: false, code: 'LOCAL' })
    expect(h.calls.filter((c) => c.path.endsWith('/cast')).length).toBe(castsBefore)
  })

  it('refreshes on every (re)connect; the clock offset comes from its own round trips', async () => {
    const h = harness({ timer: null, vote: null, serverNow: new Date(Date.now() + 5_000).toISOString() })
    h.events.offset = 1_234 // the stream's one-way estimate: only used until a response is in
    expect(h.store.serverOffsetMs()).toBe(1_234)
    for (const r of h.events.resync) r()
    await flush()
    expect(h.calls.filter((c) => c.path.endsWith('/workshop'))).toHaveLength(1)
    // from the response: about +5 s, whatever the stream said
    expect(Math.abs(h.store.serverOffsetMs() - 5_000)).toBeLessThan(1_000)
  })

  it('clock offset: server time minus the round trip midpoint, keeping the tightest sample', async () => {
    let local = 1_000_000
    const TRUE_OFFSET = 7_000 // the server clock is 7 s ahead
    const replies: { rtt: number; stampAfter: number }[] = []
    const request = (async () => {
      const r = replies.shift() ?? { rtt: 40, stampAfter: 20 }
      // The server stamps serverNow somewhere inside the round trip.
      const serverNow = new Date(local + r.stampAfter + TRUE_OFFSET).toISOString()
      local += r.rtt
      return { timer: null, vote: null, serverNow }
    }) as unknown as RequestFn
    const events = new FakeEvents()
    // A hello handled 1.5 s late (page still loading) gives a one-way estimate 1.5 s too low.
    events.offset = TRUE_OFFSET - 1_500
    const store = new WorkshopStore({
      boardId: 'b-abc1234567',
      userId: 'usr_me0000000001',
      request,
      events,
      storage: null,
      nowMs: () => local,
    })
    replies.push({ rtt: 600, stampAfter: 100 }) // slow and lopsided: error 200 ms (<= rtt/2)
    await store.refresh()
    expect(store.serverOffsetMs()).toBe(TRUE_OFFSET - 200)
    replies.push({ rtt: 20, stampAfter: 10 }) // tight: exact
    await store.refresh()
    expect(store.serverOffsetMs()).toBe(TRUE_OFFSET)
    replies.push({ rtt: 900, stampAfter: 900 }) // a worse sample does not replace a better one
    await store.refresh()
    expect(store.serverOffsetMs()).toBe(TRUE_OFFSET)
    // ...unless the best one is over a minute old
    local += 61_000
    replies.push({ rtt: 100, stampAfter: 60 })
    await store.refresh()
    expect(store.serverOffsetMs()).toBe(TRUE_OFFSET + 10)
  })

  it('join/skip is remembered per vote; people who already voted count as joined', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    expect(h.store.getSnapshot().participation).toBeNull()
    h.store.setParticipation(SID, 'skipped')
    expect(h.store.getSnapshot().participation).toBe('skipped')
    h.setServer({
      timer: null,
      vote: voteState({ myVotes: { 'shape:a': 1 }, myRemaining: 2 }),
      serverNow: ISO(0),
    })
    await h.store.refresh()
    expect(h.store.getSnapshot().participation).toBe('joined')
  })
})
