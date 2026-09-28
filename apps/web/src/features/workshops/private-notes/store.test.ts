import { type PrivateBrainstorm, type PrivateBrainstormState, PrivateTarget } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { NEW_FRAME_H, NEW_FRAME_W, newFrameBounds, targetForFrame } from './canvas.ts'
import { chipCounts, describeCounts } from './hooks.ts'
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
    starterLeft: false,
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
      { session: expect.objectContaining({ status: 'cancelled' }), revealedHere: false, endedHere: false },
    ])
    expect(store.getSnapshot().session).toBeNull()
    // R2-03: the panel says what happened instead of the intro, until the next session starts.
    expect(store.getSnapshot().lastEnded).toMatchObject({ id: SID, status: 'cancelled' })
  })

  it('a cancel sent from this tab is ended here (it removes the empty frame it made, R2-01)', async () => {
    const { store, ended } = setup((method, path) => {
      if (method === 'POST' && path.endsWith('/cancel'))
        return state({ session: null, placed: session({ status: 'cancelled', endedAt: ISO }) })
      return state({ canReveal: true })
    })
    await store.refresh()
    expect((await store.cancel()).ok).toBe(true)
    expect(ended).toEqual([
      { session: expect.objectContaining({ status: 'cancelled' }), revealedHere: false, endedHere: true },
    ])
    expect(store.getSnapshot().lastEnded).toMatchObject({ status: 'cancelled' })
  })

  it('the last ended session is forgotten once a new one starts', async () => {
    let server = state()
    const { store, events } = setup(() => server)
    await store.refresh()
    events.emit('workshop.private', {
      session: session({ status: 'placed', placedCount: 3, endedAt: ISO }),
      counts: { notes: 0, people: 0 },
    })
    expect(store.getSnapshot().lastEnded).toMatchObject({ status: 'placed', placedCount: 3 })
    server = state({ session: session({ id: 'pbs_abcdefghij0123456789' }) })
    await store.refresh()
    expect(store.getSnapshot().lastEnded).toBeNull()
  })

  it('"Add your notes" asks the composer to take the keyboard once, and only right away (A11Y2-01)', () => {
    const { store } = setup(() => state())
    expect(store.takeComposeFocus(0)).toBe(false)
    const before = store.getSnapshot().composeFocus
    store.requestComposeFocus(1_000)
    expect(store.getSnapshot().composeFocus).toBe(before + 1)
    expect(store.takeComposeFocus(1_100)).toBe(true)
    expect(store.takeComposeFocus(1_200)).toBe(false) // once
    // A request nobody could take at once (no composer on screen) never steals the keyboard later.
    store.requestComposeFocus(2_000)
    expect(store.takeComposeFocus(60_000)).toBe(false)
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

  it('refetches its own view when the board’s people change (the starter may have left: SEAM-07)', async () => {
    let server = state()
    const { store, events, calls } = setup(() => server)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ canReveal: false, starterLeft: false })
    server = state({ canReveal: true, starterLeft: true })
    events.emit('sharing.changed', { reason: 'grant' })
    await flush()
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2)
    expect(store.getSnapshot()).toMatchObject({ canReveal: true, starterLeft: true })
    // No session: nothing to refetch for.
    server = state({ session: null })
    await store.refresh()
    events.emit('sharing.changed', { reason: 'grant' })
    await flush()
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3)
  })

  it('never sends a draft action without a session', async () => {
    const { store, calls } = setup(() => state({ session: null }))
    await store.refresh()
    expect((await store.addNote({ text: 'x', color: 'yellow' })).ok).toBe(false)
    expect((await store.reveal()).ok).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })
})

describe('asking people to write when a brainstorm starts (final review R2/R4)', () => {
  const ME = 'usr_participant0001'
  function withMe(serve: () => PrivateBrainstormState) {
    const request = (async (_m: string, _p: string, opts: { schema: unknown }) =>
      (opts.schema as { parse(v: unknown): unknown }).parse(serve())) as RequestFn
    const events = new FakeEvents()
    const store = new PrivateNotesStore({ boardId: 'b-abc1234567', request, events, userId: ME })
    return { store, events }
  }

  it('someone else’s new session asks once; answering it (or reloading the view) never asks again', async () => {
    let server = state({ session: null })
    const { store, events } = withMe(() => server)
    await store.refresh()
    expect(store.getSnapshot().startNews).toBeNull()
    server = state()
    events.emit('workshop.private', { session: session(), counts: { notes: 0, people: 0 } })
    await flush()
    expect(store.getSnapshot().startNews).toEqual({ sessionId: SID })
    store.dismissStartNews()
    expect(store.getSnapshot().startNews).toBeNull()
    await store.refresh()
    expect(store.getSnapshot().startNews).toBeNull()
  })

  it('never for the starter, nor for someone who already wrote in it', async () => {
    const mine = withMe(() => state({ session: session({ createdBy: ME }) }))
    await mine.store.refresh()
    expect(mine.store.getSnapshot().startNews).toBeNull()
    const wrote = withMe(() =>
      state({
        myNotes: [
          { id: 'pnt_0123456789abcdefghij', text: 'x', color: 'yellow', createdAt: ISO, updatedAt: ISO },
        ],
      }),
    )
    await wrote.store.refresh()
    expect(wrote.store.getSnapshot().startNews).toBeNull()
  })

  it('a session already running when the board opens asks too (someone who joins late)', async () => {
    const { store } = withMe(() => state())
    await store.refresh()
    expect(store.getSnapshot().startNews).toEqual({ sessionId: SID })
  })
})

describe('helpers', () => {
  it('describes counts', () => {
    expect(describeCounts({ notes: 0, people: 0 })).toBe('No notes yet')
    expect(describeCounts({ notes: 1, people: 1 })).toBe('1 note from 1 person')
    expect(describeCounts({ notes: 7, people: 4 })).toBe('7 notes from 4 people')
  })

  it('words the top-bar chip in full (round-2 F17: not "0 from 0" or "3 from 2")', () => {
    expect(chipCounts('open', { notes: 0, people: 0 })).toBe('Waiting for notes')
    expect(chipCounts('open', { notes: 3, people: 2 })).toBe('3 notes from 2 people')
    expect(chipCounts('revealed', { notes: 3, people: 2 })).toBe('Revealing…')
    // R4: someone who can write and has not yet is asked to, whatever the counts
    expect(chipCounts('open', { notes: 0, people: 0 }, true)).toBe('Add your notes')
    expect(chipCounts('open', { notes: 3, people: 2 }, true)).toBe('Add your notes')
    expect(chipCounts('revealed', { notes: 3, people: 2 }, true)).toBe('Revealing…')
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

  it('puts a new frame in free space beside the frame in view, never over it (DANA2-02, R2-01)', () => {
    const viewport = { x: -900, y: 100, w: 1800, h: 1100 }
    // The frame in view ('2 · What went well', 800 × 960) sits where a centred frame would go.
    const inView = { x: -560, y: 216, w: 800, h: 960 }
    const neighbour = { x: 400, y: 216, w: 800, h: 960 }
    const b = newFrameBounds(viewport, [inView, neighbour])
    expect(b).toMatchObject({ w: NEW_FRAME_W, h: NEW_FRAME_H })
    const overlaps = (r: typeof inView) =>
      b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h
    expect(overlaps(inView)).toBe(false)
    expect(overlaps(neighbour)).toBe(false)
    // …and still near the view (not somewhere off past everything).
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    expect(Math.hypot(cx - 0, cy - 650)).toBeLessThan(2_500)
  })
})

describe('targets (adversarial review)', () => {
  it('a selected frame of any size gives a target the API accepts', () => {
    const fakeEditor = (b: { x: number; y: number; w: number; h: number }) =>
      ({
        getShapePageBounds: () => b,
        getAncestorPageId: () => 'page:page',
      }) as unknown as Parameters<typeof targetForFrame>[0]
    const frame = { id: 'shape:huge', type: 'frame' } as unknown as Parameters<typeof targetForFrame>[1]
    for (const b of [
      { x: -50, y: 20, w: 250_000, h: 0.2 },
      { x: 0, y: 0, w: 640, h: 480 },
    ]) {
      const t = targetForFrame(fakeEditor(b), frame)
      expect(PrivateTarget.safeParse(t).success, JSON.stringify(b)).toBe(true)
    }
  })
})
