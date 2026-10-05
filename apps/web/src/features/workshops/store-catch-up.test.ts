// G1 (wave G): the workshop store never sits on a vote it could not confirm. Found live on staging
// (2026-10-05): a name-only guest's refetch after a vote event failed, so the next vote never reached
// them until a reload; and a guest whose event stream missed the end of a selection vote joined its
// leftover join card and was refused on the next (board) vote's notes. The fix under test: `confirm`
// and `joinVote` ask the server when this tab's copy is not fresh.
import { WorkshopState, type WorkshopVoteState } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { type EventSource, type RequestFn, WorkshopStore } from './store.ts'

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

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
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
