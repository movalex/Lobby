// G1 (wave G): the workshop store never sits on a vote it could not confirm. Found live on staging
// (2026-10-05): a name-only guest's refetch after a vote event failed, so the next vote never reached
// them until a reload; and a guest whose event stream missed the end of a selection vote joined its
// leftover join card and was refused on the next (board) vote's notes. The fixes under test: a failed
// refetch is retried with a backoff until one succeeds, and `confirm`/`joinVote` ask the server when
// this tab's copy is not fresh.
import { WorkshopState, type WorkshopVoteState } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import {
  type EventSource,
  REFRESH_RETRY_MAX_MS,
  REFRESH_RETRY_MIN_MS,
  type RequestFn,
  retryableError,
  WorkshopStore,
} from './store.ts'

const ISO = (ms: number) => new Date(Date.parse('2026-10-05T10:00:00.000Z') + ms).toISOString()
const S1 = 'vot_selection000000001'
const S2 = 'vot_boardvote000000002'

function vote(id: string, over: Partial<WorkshopVoteState['session']> = {}): WorkshopVoteState {
  return {
    session: {
      id,
      boardId: 'b-abc1234567',
      title: 'Vote',
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
      frameId: null,
      selection: null,
      shapeTypes: null,
      status: 'open',
      createdBy: 'usr_facilitator0001',
      createdAt: ISO(0),
      endsAt: null,
      closedAt: null,
      revealedAt: null,
      ...over,
    },
    myVotes: {},
    myRemaining: 3,
    done: false,
    participantsDone: 0,
    participants: 0,
    totalVotesCast: 0,
    results: null,
  }
}
const selectionVote = () => vote(S1, { scope: 'selection', selection: ['shape:went', 'shape:improve'] })

class FakeEvents implements EventSource {
  listeners = new Map<string, Set<(d: unknown) => void>>()
  resync = new Set<() => void>()
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
    return 0
  }
  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(data)
  }
}

/** What the api client throws (apps/web/src/api/client.ts ApiError): a kind and a status. */
const apiError = (kind: string, status: number) =>
  Object.assign(new Error(kind), { kind, status, code: kind })
const offline = () => apiError('network', 0)

function harness(initial: z.input<typeof WorkshopState>) {
  let server = initial
  /** Answers for the next GETs, in order: a state, or an error to throw. */
  const plan: (Error | null)[] = []
  const gets: number[] = []
  const casts: string[] = []
  let now = 1_000_000
  const request = (async (method: string, path: string, opts: { body?: unknown }) => {
    if (method === 'GET' && path.endsWith('/workshop')) {
      gets.push(Date.now())
      const step = plan.shift()
      if (step) throw step
      return WorkshopState.parse(server)
    }
    if (method === 'POST' && path.endsWith('/cast')) {
      casts.push(path)
      const v = WorkshopState.parse(server).vote as WorkshopVoteState
      const { shapeId } = opts.body as { shapeId: string }
      return { ...v, myVotes: { [shapeId]: 1 }, myRemaining: v.myRemaining - 1 }
    }
    throw new Error(`unexpected ${method} ${path}`)
  }) as unknown as RequestFn
  const events = new FakeEvents()
  const store = new WorkshopStore({
    boardId: 'b-abc1234567',
    userId: 'usr_guest000000001',
    request,
    events,
    storage: null,
    nowMs: () => now,
  })
  // The board page shows the store (the top bar, the overlay): retries only run while someone does.
  const unsubscribe = store.subscribe(() => {})
  return {
    store,
    events,
    gets,
    casts,
    plan,
    unsubscribe,
    setServer(s: z.input<typeof WorkshopState>) {
      server = s
    },
    advanceClock(ms: number) {
      now += ms
    },
  }
}

const state = (v: WorkshopVoteState | null) => ({ timer: null, vote: v, serverNow: ISO(0) })
const voteEvent = (sessionId: string, status: 'open' | 'closed' | 'revealed') => ({
  sessionId,
  status,
  totalVotesCast: 0,
  participants: 0,
  participantsDone: 0,
  endsAt: null,
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('G1: a failed refetch is tried again', () => {
  it('a new vote whose refetch failed still reaches the page (the retry brings it), without a reload', async () => {
    const h = harness(state(selectionVote()))
    await h.store.refresh()
    expect(h.store.getSnapshot().vote?.session.id).toBe(S1)
    // the facilitator ends it: the event comes, its refetch fails (the page is offline for a moment)
    h.setServer(state(vote(S1, { scope: 'selection', status: 'closed' })))
    h.plan.push(offline())
    h.events.emit('workshop.vote', voteEvent(S1, 'closed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.getSnapshot()).toMatchObject({ stale: true, vote: { session: { status: 'closed' } } })
    // and starts a board vote: that event's refetch fails too
    h.setServer(state(vote(S2)))
    h.plan.push(offline())
    h.events.emit('workshop.vote', voteEvent(S2, 'open'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.getSnapshot().vote?.session.id).toBe(S1)
    // before G1 nothing else ever asked again: the guest stayed on the ended vote until a reload
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MIN_MS)
    expect(h.store.getSnapshot()).toMatchObject({
      stale: false,
      vote: { session: { id: S2, scope: 'board', status: 'open' } },
      participation: null,
    })
    // caught up: no more retries
    const n = h.gets.length
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 4)
    expect(h.gets.length).toBe(n)
  })

  it('backs off (1 s, 2 s, 4 s … at most 15 s) while the api cannot be reached, and starts over after a success', async () => {
    const h = harness(state(vote(S2)))
    await h.store.refresh()
    for (let i = 0; i < 8; i++) h.plan.push(offline())
    const start = h.gets.length
    void h.store.refresh() // fails: the first retry is 1 s later
    await vi.advanceTimersByTimeAsync(120_000)
    const times = h.gets.slice(start)
    const gaps = times.slice(1).map((t, i) => t - (times[i] as number))
    // 8 failures, then the 9th refetch (the plan is used up) succeeds and nothing more is asked
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000])
    expect(h.store.getSnapshot().stale).toBe(false)
    // the next failure waits 1 s again
    h.plan.push(offline())
    void h.store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    const before = h.gets.length
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MIN_MS)
    expect(h.gets.length).toBe(before + 1)
  })

  it('a reconnect (the stream’s hello) during the backoff refetches at once; one retry runs at a time', async () => {
    const h = harness(state(selectionVote()))
    await h.store.refresh()
    h.plan.push(offline(), offline(), offline())
    void h.store.refresh()
    void h.store.refresh()
    void h.store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    h.setServer(state(vote(S2)))
    const before = h.gets.length
    for (const r of h.events.resync) r()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.gets.length).toBe(before + 1)
    expect(h.store.getSnapshot().vote?.session.id).toBe(S2)
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 2)
    expect(h.gets.length).toBe(before + 1) // the pending retry was cancelled by the success
  })

  it('refusals are not retried: signed out, no access, no such board', async () => {
    for (const [kind, status] of [
      ['unauthorized', 401],
      ['forbidden', 403],
      ['not-found', 404],
    ] as const) {
      const h = harness(state(vote(S2)))
      await h.store.refresh()
      h.plan.push(apiError(kind, status))
      await h.store.refresh()
      expect(h.store.getSnapshot().stale).toBe(true)
      const n = h.gets.length
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 2)
      expect(h.gets.length, kind).toBe(n)
    }
    expect(retryableError(apiError('server', 503))).toBe(true)
    expect(retryableError(apiError('rate-limited', 429))).toBe(true)
    expect(retryableError(apiError('bad-response', 200))).toBe(true)
    expect(retryableError(apiError('conflict', 409))).toBe(false)
    expect(retryableError({ status: 502 })).toBe(true)
    expect(retryableError({ status: 404 })).toBe(false)
  })

  it('a slow failure older than a refetch that succeeded leaves the state confirmed (no stale flag, no retry)', async () => {
    const h = harness(state(vote(S2)))
    let fail: (e: Error) => void = () => {}
    const slow = new Promise<never>((_, reject) => {
      fail = reject
    })
    // the first refetch hangs, a second one succeeds, then the first fails
    const realRequest = (h.store as unknown as { request: RequestFn }).request
    let first = true
    ;(h.store as unknown as { request: RequestFn }).request = ((...args: Parameters<RequestFn>) => {
      if (first) {
        first = false
        return slow
      }
      return realRequest(...args)
    }) as RequestFn
    const p1 = h.store.refresh()
    await h.store.refresh()
    fail(offline())
    await p1
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, vote: { session: { id: S2 } } })
    const n = h.gets.length
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 2)
    expect(h.gets.length).toBe(n)
  })

  it('an answer older than a refetch that failed does not make the store current: it is shown, the store stays stale and the retry still runs (wave I note: failedSeq, as private-notes)', async () => {
    const h = harness(state(selectionVote()))
    await h.store.refresh()
    // a refetch hangs; the next one (sent after it, when a board vote had started) fails; then the hung one
    // answers with what the server had when it was asked: the selection vote
    let answer: (s: z.output<typeof WorkshopState>) => void = () => {}
    const slow = new Promise<z.output<typeof WorkshopState>>((resolve) => {
      answer = resolve
    })
    const realRequest = (h.store as unknown as { request: RequestFn }).request
    let first = true
    ;(h.store as unknown as { request: RequestFn }).request = ((...args: Parameters<RequestFn>) => {
      if (first) {
        first = false
        return slow
      }
      return realRequest(...args)
    }) as RequestFn
    const older = WorkshopState.parse(state(selectionVote()))
    const p1 = h.store.refresh()
    h.setServer(state(vote(S2)))
    h.plan.push(offline())
    await h.store.refresh()
    expect(h.store.getSnapshot().stale).toBe(true)
    answer(older)
    await p1
    // the old answer is applied (it is the newest state this tab has), but the tab is not caught up
    expect(h.store.getSnapshot()).toMatchObject({ stale: true, vote: { session: { id: S1 } } })
    // so acting on it still asks the server first, however recent that answer was
    const asked = h.gets.length
    await h.store.confirm(60_000)
    expect(h.gets.length).toBe(asked + 1)
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, vote: { session: { id: S2 } } })
  })

  it('...and without a confirm the retry brings the vote that started meanwhile, then stops', async () => {
    const h = harness(state(selectionVote()))
    await h.store.refresh()
    let answer: (s: z.output<typeof WorkshopState>) => void = () => {}
    const slow = new Promise<z.output<typeof WorkshopState>>((resolve) => {
      answer = resolve
    })
    const realRequest = (h.store as unknown as { request: RequestFn }).request
    let first = true
    ;(h.store as unknown as { request: RequestFn }).request = ((...args: Parameters<RequestFn>) => {
      if (first) {
        first = false
        return slow
      }
      return realRequest(...args)
    }) as RequestFn
    const p1 = h.store.refresh()
    h.setServer(state(vote(S2)))
    h.plan.push(offline())
    await h.store.refresh()
    answer(WorkshopState.parse(state(selectionVote())))
    await p1
    expect(h.store.getSnapshot().stale).toBe(true)
    const n = h.gets.length
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MIN_MS)
    expect(h.gets.length).toBe(n + 1)
    expect(h.store.getSnapshot()).toMatchObject({
      stale: false,
      vote: { session: { id: S2, scope: 'board' } },
    })
    // caught up: no more retries
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 4)
    expect(h.gets.length).toBe(n + 1)
  })

  it('nobody showing the store (the board was left): the retry stops; someone showing it again resumes it', async () => {
    const h = harness(state(vote(S2)))
    await h.store.refresh()
    h.unsubscribe()
    h.plan.push(offline())
    await h.store.refresh()
    const n = h.gets.length
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 2)
    expect(h.gets.length).toBe(n)
    const off = h.store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS)
    expect(h.gets.length).toBe(n + 1)
    expect(h.store.getSnapshot().stale).toBe(false)
    off()
    // disposed: never again
    h.plan.push(offline())
    h.store.subscribe(() => {})
    await h.store.refresh()
    h.store.dispose()
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 2)
    expect(h.gets.length).toBe(n + 2)
  })
})

describe('G1: acting on the vote confirms it first', () => {
  it('confirm refetches unless the server answered within maxAgeMs (and the last refetch did not fail)', async () => {
    const h = harness(state(vote(S2)))
    await h.store.refresh()
    const n = h.gets.length
    h.advanceClock(4_000)
    await h.store.confirm(5_000)
    expect(h.gets.length).toBe(n)
    h.advanceClock(2_000)
    await h.store.confirm(5_000)
    expect(h.gets.length).toBe(n + 1)
    await h.store.confirm(0) // 0: always ask
    expect(h.gets.length).toBe(n + 2)
    // a vote request's answer is a confirmation too
    h.advanceClock(60_000)
    await h.store.cast('shape:loose', 1)
    await h.store.confirm(5_000)
    expect(h.gets.length).toBe(n + 2)
    // after a failed refetch the copy is not trusted, however recent
    h.plan.push(offline())
    await h.store.refresh()
    const m = h.gets.length
    await h.store.confirm(5_000)
    expect(h.gets.length).toBe(m + 1)
  })

  it('joining a join card that outlived its vote shows the vote open now, with its own join card', async () => {
    const h = harness(state(selectionVote()))
    await h.store.refresh()
    expect(h.store.getSnapshot()).toMatchObject({ vote: { session: { id: S1 } }, participation: null })
    // the stream missed the end of S1 and the start of S2 (no events at all)
    h.setServer(state(vote(S2)))
    await h.store.joinVote(S1)
    expect(h.store.getSnapshot()).toMatchObject({
      vote: { session: { id: S2, scope: 'board', status: 'open' } },
      participation: null,
    })
    // joining that one sticks
    await h.store.joinVote(S2)
    expect(h.store.getSnapshot()).toMatchObject({ vote: { session: { id: S2 } }, participation: 'joined' })
  })
})
