import type { PrivateBrainstorm, PrivateBrainstormState } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { NEW_FRAME_H, NEW_FRAME_W, newFrameBounds } from './canvas.ts'
import { describeCounts } from './hooks.ts'
import { type EventSource, PrivateNotesStore, type RequestFn, type SessionEnded } from './store.ts'

const SID = 'pbs_0123456789abcdefghij'
const ISO = '2026-09-27T10:00:00.000Z'

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
    placed: null,
    ...over,
  }
}

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

function setup(serve: (method: string, path: string, body: unknown) => unknown) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const request = (async (method: string, path: string, opts: { body?: unknown; schema: unknown }) => {
    calls.push({ method, path, body: opts.body })
    const out = serve(method, path, opts.body)
    if (out instanceof Error) throw out
    const schema = opts.schema as { parse(v: unknown): unknown } | null
    return schema ? schema.parse(out) : undefined
  }) as RequestFn
  const events = new FakeEvents()
  const store = new PrivateNotesStore({ boardId: 'b-abc1234567', request, events })
  const ended: SessionEnded[] = []
  store.onSessionEnded((e) => ended.push(e))
  return { store, events, calls, ended }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('PrivateNotesStore', () => {
  it('takes counts from events without refetching, and refetches its own view when the session changes', async () => {
    let server = state()
    const { store, events, calls } = setup(() => server)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ loaded: true, session: { id: SID }, counts: { notes: 0 } })
    const gets = () => calls.filter((c) => c.method === 'GET').length

    events.emit('workshop.private', { session: session(), counts: { notes: 3, people: 2 } })
    expect(store.getSnapshot().counts).toEqual({ notes: 3, people: 2 })
    expect(gets()).toBe(1)

    // a reveal (status change): the caller's own view comes from the server
    server = state({
      session: session({ status: 'revealed', revealedAt: ISO }),
      counts: { notes: 3, people: 2 },
    })
    events.emit('workshop.private', {
      session: session({ status: 'revealed' }),
      counts: { notes: 3, people: 2 },
    })
    await flush()
    expect(gets()).toBe(2)
    expect(store.getSnapshot().session?.status).toBe('revealed')

    // malformed events are ignored
    events.emit('workshop.private', { session: { id: 'x' }, counts: 'lots' })
    expect(gets()).toBe(2)
    // every (re)connect refetches
    for (const l of events.resync) l()
    await flush()
    expect(gets()).toBe(3)
  })

  it('announces a session that ends once, whether the event or the reveal answer comes first', async () => {
    let server = state({ canReveal: true, counts: { notes: 2, people: 1 } })
    const { store, events, ended } = setup((method, path) => {
      if (method === 'POST' && path.endsWith('/reveal'))
        return state({
          session: null,
          counts: { notes: 0, people: 0 },
          placed: session({ status: 'placed', placedCount: 2 }),
        })
      return server
    })
    await store.refresh()
    const placed = session({ status: 'placed', placedCount: 2, endedAt: ISO })
    const reveal = store.reveal()
    expect(store.getSnapshot().busy).toBe('reveal')
    events.emit('workshop.private', { session: placed, counts: { notes: 0, people: 0 } })
    expect(store.getSnapshot().session).toBeNull()
    await reveal
    server = state({ session: null, counts: { notes: 0, people: 0 } })
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ revealedHere: true, session: { status: 'placed', placedCount: 2 } })
    expect(store.getSnapshot()).toMatchObject({ busy: null, session: null, myNotes: [] })
  })

  it('someone else ending it: announced here too, but not as revealed here', async () => {
    const { store, events, ended } = setup(() => state())
    await store.refresh()
    events.emit('workshop.private', {
      session: session({ status: 'cancelled', endedAt: ISO }),
      counts: { notes: 0, people: 0 },
    })
    expect(ended).toEqual([
      { session: expect.objectContaining({ status: 'cancelled' }), revealedHere: false },
    ])
    expect(store.getSnapshot().session).toBeNull()
  })

  it('reports refusals with the server message and refetches when the session moved on', async () => {
    const refusal = Object.assign(new Error('This brainstorm has been revealed or has ended.'), {
      code: 'PRIVATE_NOT_OPEN',
    })
    const { store, calls } = setup((method) => (method === 'POST' ? refusal : state()))
    await store.refresh()
    const r = await store.addNote({ text: 'late idea', color: 'yellow' })
    expect(r).toEqual({ ok: false, error: refusal.message, code: 'PRIVATE_NOT_OPEN' })
    await flush()
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET'])
    expect(calls[1]?.path).toBe(`/api/private-brainstorms/${SID}/notes`)
  })

  it('never sends a draft action without a session', async () => {
    const { store, calls } = setup(() => state({ session: null }))
    await store.refresh()
    expect((await store.addNote({ text: 'x', color: 'yellow' })).ok).toBe(false)
    expect((await store.reveal()).ok).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })
})

describe('helpers', () => {
  it('describes counts', () => {
    expect(describeCounts({ notes: 0, people: 0 })).toBe('No notes yet')
    expect(describeCounts({ notes: 1, people: 1 })).toBe('1 note from 1 person')
    expect(describeCounts({ notes: 7, people: 4 })).toBe('7 notes from 4 people')
  })

  it('centres a new frame in the viewport, sized for twelve notes', () => {
    const b = newFrameBounds({ x: 1000, y: 500, w: 1600, h: 900 })
    expect(b).toEqual({
      x: 1000 + 800 - NEW_FRAME_W / 2,
      y: 500 + 450 - NEW_FRAME_H / 2,
      w: NEW_FRAME_W,
      h: NEW_FRAME_H,
    })
    // 4 columns and 3 rows of 200 px notes fit (the sync server's grid: 40 px padding, 24 px gaps)
    expect(Math.floor((NEW_FRAME_W - 80 + 24) / 224)).toBe(4)
    expect(NEW_FRAME_H).toBe(80 + 3 * 200 + 2 * 24)
  })
})
