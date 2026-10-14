import { WorkshopState, type WorkshopTimer, type WorkshopVoteState } from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import {
  type EventSource,
  FIRST_LOAD_FALLBACK_MS,
  type RequestFn,
  WorkshopStore,
  workshopStoreFor,
} from './store.ts'

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

/** What the server sends (hands may be left out: the schema defaults them, as the real client parses). */
type ServerState = z.input<typeof WorkshopState>

function harness(initial: ServerState) {
  const calls: Call[] = []
  let current = initial
  const handlers: ((c: Call) => unknown | Promise<unknown>)[] = []
  const request = (async (method: string, path: string, opts: { body?: unknown; schema: unknown }) => {
    const call = { method, path, body: opts.body }
    calls.push(call)
    const h = handlers.shift()
    if (h) return h(call)
    if (method === 'GET' && path.endsWith('/workshop')) return WorkshopState.parse(current)
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
    setServer: (s: ServerState) => {
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

  it('RT-03: an answer to a request sent before a vote event keeps the event’s counts, and its own ballot', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    let release: () => void = () => {}
    // the server answered this cast with the counts of the window before (0), and the answer is slow
    h.next(
      () =>
        new Promise((res) => {
          release = () => res(voteState({ myVotes: { 'shape:a': 1 }, myRemaining: 2, totalVotesCast: 0 }))
        }),
    )
    const p = h.store.cast('shape:a', 1)
    await flush()
    // meanwhile the window ends: its event (this cast and someone else's) arrives first
    h.events.emit('workshop.vote', {
      sessionId: SID,
      status: 'open',
      totalVotesCast: 2,
      participants: 2,
      participantsDone: 1,
      endsAt: null,
    })
    release()
    await p
    expect(h.store.getSnapshot().vote).toMatchObject({
      myVotes: { 'shape:a': 1 },
      myRemaining: 2,
      totalVotesCast: 2,
      participants: 2,
      participantsDone: 1,
    })
    // a request sent after the event applies its own counts again
    h.next(() => voteState({ myVotes: { 'shape:a': 2 }, myRemaining: 1, totalVotesCast: 3, participants: 2 }))
    await h.store.cast('shape:a', 1)
    expect(h.store.getSnapshot().vote).toMatchObject({ totalVotesCast: 3, myRemaining: 1 })
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

describe('results news (RETRO-08)', () => {
  const results = [
    { shapeId: 'shape:a', count: 4, rank: 1 },
    { shapeId: 'shape:b', count: 2, rank: 2 },
  ]
  const revealed = () =>
    voteState({
      session: { ...voteState().session, status: 'revealed', revealedAt: ISO(5_000) },
      results,
      totalVotesCast: 6,
    })

  it('announces results this tab saw arrive (event, then the refetch), once, until dismissed', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    expect(h.store.getSnapshot().resultsNews).toBeNull()
    // The facilitator reveals: aggregates first (status), then the results event.
    h.setServer({ timer: null, vote: revealed(), serverNow: ISO(5_000) })
    h.events.emit('workshop.vote', {
      sessionId: SID,
      status: 'revealed',
      totalVotesCast: 6,
      participantsDone: 2,
      participants: 2,
      endsAt: null,
    })
    await flush()
    const news = h.store.getSnapshot().resultsNews
    expect(news).toMatchObject({ sessionId: SID })
    h.events.emit('workshop.vote.results', { sessionId: SID, results, totalVotesCast: 6, participants: 2 })
    await h.store.refresh()
    // Still the same piece of news, not a second one.
    expect(h.store.getSnapshot().resultsNews?.seq).toBe(news?.seq)
    h.store.dismissResultsNews()
    expect(h.store.getSnapshot().resultsNews).toBeNull()
    await h.store.refresh()
    expect(h.store.getSnapshot().resultsNews).toBeNull()
  })

  it('the results event alone is news too', async () => {
    const h = harness({
      timer: null,
      vote: voteState({ session: { ...voteState().session, status: 'closed' } }),
      serverNow: ISO(0),
    })
    await h.store.refresh()
    h.events.emit('workshop.vote.results', { sessionId: SID, results, totalVotesCast: 6, participants: 2 })
    expect(h.store.getSnapshot().resultsNews).toMatchObject({ sessionId: SID })
  })

  it('a board opened after the reveal (a late joiner) gets no news', async () => {
    const h = harness({ timer: null, vote: revealed(), serverNow: ISO(0) })
    await h.store.refresh()
    await h.store.refresh()
    expect(h.store.getSnapshot().vote?.results).toHaveLength(2)
    expect(h.store.getSnapshot().resultsNews).toBeNull()
  })

  it('a new vote clears the news of the last one', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    h.events.emit('workshop.vote.results', { sessionId: SID, results, totalVotesCast: 6, participants: 2 })
    expect(h.store.getSnapshot().resultsNews).not.toBeNull()
    const other = voteState({ session: { ...voteState().session, id: 'vot_zzzzzzzzzzzzzzzzzzzz' } })
    h.setServer({ timer: null, vote: other, serverNow: ISO(9_000) })
    await h.store.refresh()
    expect(h.store.getSnapshot().resultsNews).toBeNull()
  })

  // M2-4 (FTU-12): the facilitator kept the card after opening Voting and putting the results on the board
  it('opening the Voting panel ends the card, and closing the panel does not bring it back', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    h.events.emit('workshop.vote.results', { sessionId: SID, results, totalVotesCast: 6, participants: 2 })
    expect(h.store.getSnapshot().resultsNews).not.toBeNull()
    h.store.panelChanged('tags') // another panel: the card stays
    expect(h.store.getSnapshot().resultsNews).not.toBeNull()
    h.store.panelChanged('voting')
    expect(h.store.getSnapshot().resultsNews).toBeNull()
    h.store.panelChanged(null)
    expect(h.store.getSnapshot().resultsNews).toBeNull()
  })

  it('"Results to board" ends the card', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    h.events.emit('workshop.vote.results', { sessionId: SID, results, totalVotesCast: 6, participants: 2 })
    h.store.dismissResultsNews('to-board')
    expect(h.store.getSnapshot().resultsNews).toBeNull()
    // and a dismissal with nothing to dismiss changes nothing (no extra render)
    let renders = 0
    h.store.subscribe(() => renders++)
    h.store.dismissResultsNews('to-board')
    h.store.panelChanged('voting')
    expect(renders).toBe(0)
  })

  it('a newer reveal makes a new card even after the last was dismissed', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    h.events.emit('workshop.vote.results', { sessionId: SID, results, totalVotesCast: 6, participants: 2 })
    const first = h.store.getSnapshot().resultsNews
    h.store.dismissResultsNews('see-all')
    const second = 'vot_zzzzzzzzzzzzzzzzzzzz'
    h.setServer({
      timer: null,
      vote: voteState({ session: { ...voteState().session, id: second } }),
      serverNow: ISO(9_000),
    })
    await h.store.refresh()
    h.events.emit('workshop.vote.results', { sessionId: second, results, totalVotesCast: 6, participants: 2 })
    const news = h.store.getSnapshot().resultsNews
    expect(news).toMatchObject({ sessionId: second })
    expect(news?.seq).toBeGreaterThan(first?.seq ?? 0)
  })

  it('announcements repeat when the same text comes twice', () => {
    const h = harness({ timer: null, vote: null, serverNow: ISO(0) })
    h.store.announce('Voted. 2 of 3 left')
    const first = h.store.getSnapshot().announcement
    h.store.announce('Voted. 2 of 3 left')
    expect(h.store.getSnapshot().announcement?.text).toBe('Voted. 2 of 3 left')
    expect(h.store.getSnapshot().announcement?.seq).toBe((first?.seq ?? 0) + 1)
  })
})

describe('one /workshop request per board open (K3-6)', () => {
  /** A stream that is already connected: onResync runs the listener at once, as BoardEvents does. */
  class ConnectedEvents extends FakeEvents {
    override onResync(l: () => void) {
      const off = super.onResync(l)
      l()
      return off
    }
  }
  const counting = () => {
    const calls: string[] = []
    const request = (async (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      return WorkshopState.parse({ timer: null, vote: null, serverNow: ISO(0) })
    }) as unknown as RequestFn
    return { calls, request }
  }
  const make = (events: EventSource, request: RequestFn) => () =>
    new WorkshopStore({ boardId: 'b-abc1234567', userId: 'usr_me0000000001', request, events, storage: null })

  it('the stream connects after the store is made: its first resync is the one load', async () => {
    vi.useFakeTimers()
    try {
      const { calls, request } = counting()
      const events = new FakeEvents()
      const store = workshopStoreFor(events, make(events, request))
      await vi.advanceTimersByTimeAsync(500)
      expect(calls).toEqual([]) // nothing before the stream says hello
      for (const r of events.resync) r()
      await vi.advanceTimersByTimeAsync(FIRST_LOAD_FALLBACK_MS * 2)
      expect(calls).toEqual(['GET /api/boards/b-abc1234567/workshop'])
      expect(store.getSnapshot().loaded).toBe(true)
      // the same stream gets the same store: no second load
      expect(workshopStoreFor(events, make(events, request))).toBe(store)
      expect(calls).toHaveLength(1)
      // a reconnect refetches, as always
      for (const r of events.resync) r()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the stream is already connected: the resync as the store subscribes is the one load', async () => {
    vi.useFakeTimers()
    try {
      const { calls, request } = counting()
      const events = new ConnectedEvents()
      workshopStoreFor(events, make(events, request))
      await vi.advanceTimersByTimeAsync(FIRST_LOAD_FALLBACK_MS * 2)
      expect(calls).toEqual(['GET /api/boards/b-abc1234567/workshop'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stream that never connects: the store loads on its own after the fallback, once', async () => {
    vi.useFakeTimers()
    try {
      const { calls, request } = counting()
      const events = new FakeEvents()
      const store = workshopStoreFor(events, make(events, request))
      await vi.advanceTimersByTimeAsync(FIRST_LOAD_FALLBACK_MS - 1)
      expect(calls).toEqual([])
      await vi.advanceTimersByTimeAsync(2)
      expect(calls).toHaveLength(1)
      expect(store.getSnapshot().loaded).toBe(true)
      await vi.advanceTimersByTimeAsync(FIRST_LOAD_FALLBACK_MS * 3)
      expect(calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a store left before it loaded fetches nothing later', async () => {
    vi.useFakeTimers()
    try {
      const { calls, request } = counting()
      const events = new FakeEvents()
      const store = workshopStoreFor(events, make(events, request))
      store.dispose()
      await vi.advanceTimersByTimeAsync(FIRST_LOAD_FALLBACK_MS * 2)
      expect(calls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the "Vote started" banner (K3-1)', () => {
  const event = (over: Partial<{ sessionId: string; status: string; totalVotesCast: number }> = {}) => ({
    sessionId: SID,
    status: 'open',
    totalVotesCast: 0,
    participants: 0,
    participantsDone: 0,
    endsAt: null,
    ...over,
  })

  it('a vote-start event shows it to a participant who has not joined, once', async () => {
    const h = harness({ timer: null, vote: null, serverNow: ISO(0) })
    await h.store.refresh()
    expect(h.store.getSnapshot().voteBanner).toBeNull()
    h.setServer({ timer: null, vote: voteState(), serverNow: ISO(1) })
    h.events.emit('workshop.vote', event())
    await flush()
    const banner = h.store.getSnapshot().voteBanner
    expect(banner).toMatchObject({ sessionId: SID, title: 'Vote', votesPerPerson: 3, scope: 'board' })
    expect(banner?.createdBy).toBe('usr_facilitator0001')
    // count updates, refetches: the same banner, not a new one
    h.events.emit('workshop.vote', event({ totalVotesCast: 2 }))
    await h.store.refresh()
    expect(h.store.getSnapshot().voteBanner?.seq).toBe(banner?.seq)
  })

  it('hides on join, and the join is the vote confirmed with the server', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    expect(h.store.getSnapshot().voteBanner).not.toBeNull()
    const gets = h.calls.length
    await h.store.joinVote(SID)
    expect(h.store.getSnapshot().voteBanner).toBeNull()
    expect(h.store.getSnapshot().participation).toBe('joined')
    expect(h.calls.length).toBe(gets + 1) // G1: the join refetches the vote
  })

  it('hides on skip ("Not now"), for good', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    h.store.setParticipation(SID, 'skipped')
    expect(h.store.getSnapshot().voteBanner).toBeNull()
    await h.store.refresh()
    expect(h.store.getSnapshot().voteBanner).toBeNull()
  })

  it('hides when the vote closes, and the next vote has a banner of its own', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    const first = h.store.getSnapshot().voteBanner?.seq
    h.setServer({
      timer: null,
      vote: voteState({ session: { ...voteState().session, status: 'closed' } }),
      serverNow: ISO(1),
    })
    h.events.emit('workshop.vote', event({ status: 'closed' }))
    expect(h.store.getSnapshot().voteBanner).toBeNull() // at once, from the event
    await flush()
    expect(h.store.getSnapshot().voteBanner).toBeNull()
    const next = voteState({
      session: { ...voteState().session, id: 'vot_nextvote0000000000', title: 'Round 2' },
    })
    h.setServer({ timer: null, vote: next, serverNow: ISO(2) })
    h.events.emit('workshop.vote', event({ sessionId: 'vot_nextvote0000000000' }))
    await flush()
    const banner = h.store.getSnapshot().voteBanner
    expect(banner).toMatchObject({ sessionId: 'vot_nextvote0000000000', title: 'Round 2' })
    expect(banner?.seq).not.toBe(first)
  })

  it('not for a participant who is not eligible (an archived board, presenting); back, as the same banner', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    h.store.setVoteEligible(false)
    await h.store.refresh()
    expect(h.store.getSnapshot().voteBanner).toBeNull()
    h.store.setVoteEligible(true)
    const seq = h.store.getSnapshot().voteBanner?.seq
    expect(seq).toBeGreaterThan(0)
    h.store.setVoteEligible(false)
    expect(h.store.getSnapshot().voteBanner).toBeNull()
    h.store.setVoteEligible(true)
    expect(h.store.getSnapshot().voteBanner?.seq).toBe(seq) // shown once: not a new entrance
  })

  it('not for whoever started the vote (they are in it), nor for someone who already voted', async () => {
    const h = harness({ timer: null, vote: null, serverNow: ISO(0) })
    await h.store.refresh()
    h.next(() => voteState())
    await h.store.startVote({ votesPerPerson: 3, onePerObject: false, scope: 'board' })
    expect(h.store.getSnapshot().voteBanner).toBeNull()
    const other = harness({
      timer: null,
      vote: voteState({ myVotes: { 'shape:a': 1 }, myRemaining: 2 }),
      serverNow: ISO(0),
    })
    await other.store.refresh()
    expect(other.store.getSnapshot().voteBanner).toBeNull()
  })

  it('P-001: a click on a note before joining joins and casts at once, the join first', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    expect(h.store.getSnapshot().voteBanner).not.toBeNull()
    const order: string[] = []
    h.next((c) => {
      order.push(`${c.method} ${c.path}`)
      return WorkshopState.parse({ timer: null, vote: voteState(), serverNow: ISO(1) })
    })
    h.next((c) => {
      order.push(`${c.method} ${c.path}`)
      return voteState({ myVotes: { 'shape:note1': 1 }, myRemaining: 2 })
    })
    const r = await h.store.joinAndCast(SID, 'shape:note1')
    expect(r?.ok).toBe(true)
    expect(order).toEqual([`GET /api/boards/b-abc1234567/workshop`, `POST /api/votes/${SID}/cast`])
    expect(h.calls.at(-1)?.body).toEqual({ shapeId: 'shape:note1', delta: 1 })
    const snap = h.store.getSnapshot()
    expect(snap.participation).toBe('joined')
    expect(snap.voteBanner).toBeNull()
    expect(snap.ballot?.myVotes).toEqual({ 'shape:note1': 1 })
  })

  it('P-001: nothing is cast when the vote it was for is no longer the open one', async () => {
    const h = harness({ timer: null, vote: voteState(), serverNow: ISO(0) })
    await h.store.refresh()
    h.next(() =>
      WorkshopState.parse({
        timer: null,
        vote: voteState({ session: { ...voteState().session, status: 'closed' } }),
        serverNow: ISO(1),
      }),
    )
    const r = await h.store.joinAndCast(SID, 'shape:note1')
    expect(r).toBeNull()
    expect(h.calls.filter((c) => c.path.endsWith('/cast'))).toEqual([])
  })
})

describe('the vote’s starter is in it (K3-1)', () => {
  it('on another tab, or after a reload: no banner, joined', async () => {
    const calls: string[] = []
    const request = (async (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      return WorkshopState.parse({ timer: null, vote: voteState(), serverNow: ISO(0) })
    }) as unknown as RequestFn
    const store = new WorkshopStore({
      boardId: 'b-abc1234567',
      userId: 'usr_facilitator0001', // voteState()'s createdBy
      request,
      events: new FakeEvents(),
      storage: null,
    })
    await store.refresh()
    expect(store.getSnapshot().participation).toBe('joined')
    expect(store.getSnapshot().voteBanner).toBeNull()
  })
})
