// I1 (wave I): the private-notes store never sits on a view it could not confirm. Same bug class wave G fixed
// in workshops/store.ts (G1): a refetch that failed was marked stale and never asked again, so a brainstorm
// someone started while this person's request failed (an offline blip, a deploy) never reached them until a
// reload: the stream's event comes once. The fix under test: a failed refetch is retried with a backoff until
// one succeeds, and nobody showing the store means no retrying.
import type { PrivateBrainstorm, PrivateBrainstormState } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REFRESH_RETRY_MAX_MS, REFRESH_RETRY_MIN_MS } from '../store.ts'
import { type EventSource, PrivateNotesStore, type RequestFn } from './store.ts'

const SID = 'pbs_0123456789abcdefghij'
const SID2 = 'pbs_zyxwvutsrqponmlkjihg'
const ISO = '2026-10-05T10:00:00.000Z'

function session(over: Partial<PrivateBrainstorm> = {}): PrivateBrainstorm {
  return {
    id: SID,
    boardId: 'b-abc1234567',
    prompt: 'What should we stop doing?',
    anonymous: true,
    frameId: 'shape:frame1',
    status: 'open',
    createdBy: 'usr_facilitator0001',
    createdAt: ISO,
    revealedAt: null,
    endedAt: null,
    placedCount: null,
    ...over,
  }
}

function state(over: Partial<PrivateBrainstormState> = {}): PrivateBrainstormState {
  return {
    session: session(),
    counts: { notes: 0, people: 0 },
    myNotes: [],
    canReveal: false,
    starterLeft: false,
    placed: null,
    ...over,
  }
}
const noSession = () => state({ session: null })

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
  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(data)
  }
}

/** What the api client throws (apps/web/src/api/client.ts ApiError): a kind and a status. */
const apiError = (kind: string, status: number) =>
  Object.assign(new Error(kind), { kind, status, code: kind })
const offline = () => apiError('network', 0)

function harness(initial: PrivateBrainstormState = noSession()) {
  let server = initial
  /** Answers for the next GETs, in order: an error to throw (null: the server's state). */
  const plan: (Error | null)[] = []
  const gets: number[] = []
  const request = (async (method: string, path: string, opts: { body?: unknown; schema: unknown }) => {
    if (method === 'GET' && path.endsWith('/private-brainstorm')) {
      gets.push(Date.now())
      const step = plan.shift()
      if (step) throw step
      return (opts.schema as { parse(v: unknown): unknown }).parse(server)
    }
    if (method === 'POST' && path.endsWith('/notes')) {
      const note = {
        id: 'pnt_0123456789abcdef',
        sessionId: SID,
        text: (opts.body as { text: string }).text,
        color: 'yellow',
        createdAt: ISO,
        updatedAt: ISO,
      }
      server = { ...server, myNotes: [...server.myNotes, note] } as PrivateBrainstormState
      return (opts.schema as { parse(v: unknown): unknown }).parse(server)
    }
    throw new Error(`unexpected ${method} ${path}`)
  }) as unknown as RequestFn
  const events = new FakeEvents()
  const store = new PrivateNotesStore({ boardId: 'b-abc1234567', request, events })
  // The board page shows the store (the top-bar chip): retries only run while someone does.
  const unsubscribe = store.subscribe(() => {})
  return {
    store,
    events,
    gets,
    plan,
    unsubscribe,
    setServer(s: PrivateBrainstormState) {
      server = s
    },
  }
}

const event = (s: PrivateBrainstorm = session()) => ({ session: s, counts: { notes: 0, people: 0 } })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('I1: a failed refetch of the private brainstorm is tried again', () => {
  it('a brainstorm started while the refetch failed still reaches the person (the retry brings it), without a reload', async () => {
    const h = harness()
    await h.store.refresh()
    expect(h.store.getSnapshot()).toMatchObject({ loaded: true, session: null, stale: false })
    // the facilitator starts one: the event comes, its refetch fails (the page is offline for a moment)
    h.setServer(state())
    h.plan.push(offline())
    h.events.emit('workshop.private', event())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.getSnapshot()).toMatchObject({ stale: true, session: null })
    // before I1 nothing else ever asked again: the person never saw it until a reload
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MIN_MS)
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, session: { id: SID, status: 'open' } })
    expect(h.store.getSnapshot().startNews).toEqual({ sessionId: SID })
    // caught up: no more retries
    const n = h.gets.length
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 4)
    expect(h.gets.length).toBe(n)
  })

  it('backs off (1 s, 2 s, 4 s … at most 15 s) while the api cannot be reached, and starts over after a success', async () => {
    const h = harness()
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
    const h = harness()
    await h.store.refresh()
    h.plan.push(offline(), offline(), offline())
    void h.store.refresh()
    void h.store.refresh()
    void h.store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    h.setServer(state())
    const before = h.gets.length
    for (const r of h.events.resync) r()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.gets.length).toBe(before + 1)
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, session: { id: SID } })
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 2)
    expect(h.gets.length).toBe(before + 1) // the pending retry was cancelled by the success
  })

  it('refusals are not retried: signed out, no access, no such board', async () => {
    for (const [kind, status] of [
      ['unauthorized', 401],
      ['forbidden', 403],
      ['not-found', 404],
    ] as const) {
      const h = harness()
      await h.store.refresh()
      h.plan.push(apiError(kind, status))
      await h.store.refresh()
      expect(h.store.getSnapshot().stale).toBe(true)
      const n = h.gets.length
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 2)
      expect(h.gets.length, kind).toBe(n)
    }
    // a server error and a rate limit are
    for (const err of [apiError('server', 503), apiError('rate-limited', 429)]) {
      const h = harness()
      await h.store.refresh()
      h.plan.push(err)
      await h.store.refresh()
      const n = h.gets.length
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MIN_MS)
      expect(h.gets.length, err.message).toBe(n + 1)
      expect(h.store.getSnapshot().stale).toBe(false)
    }
  })

  it('a slow failure older than a refetch that succeeded leaves the state confirmed (no stale flag, no retry)', async () => {
    const h = harness()
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
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, loaded: true })
    const n = h.gets.length
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 2)
    expect(h.gets.length).toBe(n)
  })

  it('an answer older than a refetch that failed does not make the store current: the retry still runs', async () => {
    const h = harness()
    await h.store.refresh()
    // an action is in flight; an event's refetch (sent after it) fails; then the action's answer arrives
    let answer: (s: PrivateBrainstormState) => void = () => {}
    const realRequest = (h.store as unknown as { request: RequestFn }).request
    ;(h.store as unknown as { request: RequestFn }).request = ((method: string, ...rest: unknown[]) => {
      if (method === 'POST')
        return new Promise((resolve) => {
          answer = resolve as typeof answer
        })
      return (realRequest as (...a: unknown[]) => unknown)(method, ...rest)
    }) as RequestFn
    h.setServer(state())
    const start = h.store.start({ prompt: 'p', anonymous: true, frameId: null } as never)
    h.plan.push(offline())
    h.events.emit('workshop.private', event())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.getSnapshot().stale).toBe(true)
    answer(noSession()) // the action's answer predates the event
    await start
    expect(h.store.getSnapshot().stale).toBe(true)
    const n = h.gets.length
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MIN_MS)
    expect(h.gets.length).toBe(n + 1)
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, session: { id: SID } })
  })

  it('an action’s answer (the person’s whole view) confirms the store: the stale flag and the retry end', async () => {
    const h = harness(state())
    await h.store.refresh()
    h.plan.push(offline())
    await h.store.refresh()
    expect(h.store.getSnapshot().stale).toBe(true)
    const n = h.gets.length
    const r = await h.store.addNote({ text: 'an idea', color: 'yellow' } as never)
    expect(r.ok).toBe(true)
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, myNotes: [{ text: 'an idea' }] })
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MAX_MS * 2)
    expect(h.gets.length).toBe(n)
  })

  it('nobody showing the store (the board was left): the retry stops; someone showing it again resumes it; dispose ends it', async () => {
    const h = harness()
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

  it('a session change seen while stale still ends up shown: ended, then a new one, each refetch retried', async () => {
    const h = harness(state())
    await h.store.refresh()
    h.setServer(state({ session: session({ id: SID2 }) }))
    h.plan.push(offline(), offline())
    h.events.emit('workshop.private', event(session({ id: SID2 })))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.getSnapshot().session?.id).toBe(SID)
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MIN_MS) // fails again
    expect(h.store.getSnapshot().session?.id).toBe(SID)
    await vi.advanceTimersByTimeAsync(2 * REFRESH_RETRY_MIN_MS)
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, session: { id: SID2 } })
  })
})
