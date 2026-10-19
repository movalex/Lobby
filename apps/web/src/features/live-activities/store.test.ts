// WS2 (wave V, V1): the live activity store against a fake api with the contracts' wire shapes (WS1 builds the real
// one). It loads on the stream's resync; an api that runs no live activities (404, its switch off) makes it absent and
// is not retried; events refetch the caller's own view on a new activity or a status change and otherwise only move
// the counts (a manager's live counts come with their own read); an open activity past its end reads closed and is
// asked again; the news (someone else's activity started, results came in) is told once and never for this tab's own
// press; every action posts to its contracts path.
import {
  type ActivityState,
  activitiesPath,
  activityActionPath,
  activityPath,
  LIVE_ACTIVITY_EVENTS,
  type LiveActivity,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ActivityNews, ActivityStore, effectiveStatus, type RequestFn, remainingMs } from './store.ts'

const BOARD = 'b-la-store01'
const ME = 'usr_participant0001'
const FAC = 'usr_facilitator0001'
const AID = 'act_0123456789abcdef'

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
  fireResync() {
    for (const l of [...this.resync]) l()
  }
}

const activity = (over: Partial<LiveActivity> = {}): LiveActivity =>
  ({
    id: AID,
    boardId: BOARD,
    kind: 'poll',
    prompt: 'Which day?',
    config: { options: ['Mon', 'Fri'], maxChoices: 1 },
    anonymous: true,
    resultsLive: false,
    status: 'open',
    createdBy: FAC,
    createdAt: '2026-10-18T10:00:00.000Z',
    endsAt: null,
    closedAt: null,
    revealedAt: null,
    placedAt: null,
    ...over,
  }) as LiveActivity

const state = (over: Partial<ActivityState> = {}): ActivityState => ({
  activity: activity(),
  answered: 0,
  myAnswer: null,
  results: null,
  canManage: false,
  starterLeft: false,
  hiddenWords: [],
  serverNow: new Date().toISOString(),
  ...over,
})

class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly kind: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.kind = status === 404 ? 'not-found' : status === 409 ? 'conflict' : 'server'
  }
}

function kit(opts: { userId?: string } = {}) {
  const events = new Events()
  const calls: { method: string; path: string; body?: unknown }[] = []
  let answer: (method: string, path: string, body: unknown) => unknown = () => state()
  const request = (async (method: string, path: string, o: { body?: unknown; schema: unknown }) => {
    calls.push({ method, path, body: o.body })
    const v = answer(method, path, o.body)
    if (v instanceof Error) throw v
    const schema = o.schema as { parse(v: unknown): unknown } | null
    return schema ? schema.parse(v) : undefined
  }) as RequestFn
  const store = new ActivityStore({ boardId: BOARD, request, events, userId: opts.userId ?? ME })
  const news: ActivityNews[] = []
  store.onNews((n) => news.push(n))
  const off = store.subscribe(() => {})
  return {
    events,
    calls,
    store,
    news,
    off,
    serve(fn: typeof answer) {
      answer = fn
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the live activity store', () => {
  it('loads on the stream resync, and an api without the feature (404) makes it absent, not retried', async () => {
    const k = kit()
    k.serve(() => new ApiError(404, 'NOT_FOUND', 'Not found.'))
    k.events.fireResync()
    await flush()
    expect(k.calls).toEqual([{ method: 'GET', path: activityPath(BOARD), body: undefined }])
    expect(k.store.getSnapshot()).toMatchObject({ absent: true, loaded: true, stale: false, activity: null })
    await new Promise((r) => setTimeout(r, 1100))
    expect(k.calls).toHaveLength(1)
    // the switch went on: the next resync finds it
    k.serve(() => state())
    k.events.fireResync()
    await flush()
    expect(k.store.getSnapshot()).toMatchObject({ absent: false, status: 'open' })
  })

  it('a new activity or a status change refetches; a count change only moves the counts', async () => {
    const k = kit()
    k.serve(() => state({ activity: null }))
    k.events.fireResync()
    await flush()
    k.serve(() => state({ answered: 0 }))
    k.events.emit(LIVE_ACTIVITY_EVENTS.activity, { activity: activity(), answered: 0, results: null })
    await flush()
    expect(k.calls.filter((c) => c.method === 'GET')).toHaveLength(2)
    expect(k.store.getSnapshot().activity?.id).toBe(AID)
    // a window's new count: no refetch for a participant
    k.events.emit(LIVE_ACTIVITY_EVENTS.activity, { activity: activity(), answered: 4, results: null })
    await flush()
    expect(k.calls.filter((c) => c.method === 'GET')).toHaveLength(2)
    expect(k.store.getSnapshot().answered).toBe(4)
    // closed: refetch (what may this person do now)
    k.serve(() => state({ activity: activity({ status: 'closed', closedAt: '2026-10-18T10:05:00.000Z' }) }))
    k.events.emit(LIVE_ACTIVITY_EVENTS.activity, {
      activity: activity({ status: 'closed', closedAt: '2026-10-18T10:05:00.000Z' }),
      answered: 4,
      results: null,
    })
    await flush()
    expect(k.calls.filter((c) => c.method === 'GET')).toHaveLength(3)
    expect(k.store.getSnapshot().status).toBe('closed')
    // garbage is ignored
    k.events.emit(LIVE_ACTIVITY_EVENTS.activity, { activity: { id: 'x' } })
    expect(k.calls.filter((c) => c.method === 'GET')).toHaveLength(3)
  })

  it('a manager without live results asks for their own counts after an event; the results event lands', async () => {
    const k = kit({ userId: FAC })
    const live = { kind: 'poll' as const, answered: 3, counts: [1, 2] }
    k.serve(() => state({ canManage: true, answered: 3, results: live }))
    k.events.fireResync()
    await flush()
    k.events.emit(LIVE_ACTIVITY_EVENTS.activity, { activity: activity(), answered: 5, results: null })
    // the event keeps the manager's last counts until their read answers
    expect(k.store.getSnapshot().results).toEqual(live)
    await flush()
    expect(k.calls.filter((c) => c.method === 'GET')).toHaveLength(2)
    const final = { kind: 'poll' as const, answered: 5, counts: [2, 3] }
    k.events.emit(LIVE_ACTIVITY_EVENTS.results, { activityId: AID, results: final })
    expect(k.store.getSnapshot().results).toEqual(final)
    // another activity's results are not ours
    k.events.emit(LIVE_ACTIVITY_EVENTS.results, { activityId: 'act_zzzzzzzzzzzzzzzz', results: live })
    expect(k.store.getSnapshot().results).toEqual(final)
  })

  it('every action posts to its contracts path with its body, and the answer is the caller view', async () => {
    const k = kit({ userId: FAC })
    k.serve(() => state({ canManage: true }))
    k.events.fireResync()
    await flush()
    const mine = { kind: 'poll' as const, choices: [1] }
    k.serve(() => state({ canManage: true, myAnswer: mine, answered: 1 }))
    expect(await k.store.answer(mine)).toEqual({ ok: true })
    expect(k.store.getSnapshot().myAnswer).toEqual(mine)
    await k.store.extend(60_000)
    await k.store.close()
    k.serve(() => state({ canManage: true, activity: activity({ status: 'closed' }) }))
    await k.store.close().catch(() => {})
    const posts = k.calls.filter((c) => c.method === 'POST')
    expect(posts[0]).toEqual({
      method: 'POST',
      path: activityActionPath(AID, 'answer'),
      body: { answer: mine },
    })
    expect(posts[1]).toEqual({
      method: 'POST',
      path: activityActionPath(AID, 'extend'),
      body: { addMs: 60_000 },
    })
    expect(posts[2]?.path).toBe(activityActionPath(AID, 'close'))
    k.serve(() => state({ canManage: true, activity: activity({ status: 'revealed' }) }))
    await k.store.reveal()
    await k.store.placed()
    await k.store.hide('Agile', true)
    expect(k.calls.slice(-3).map((c) => [c.path, c.body])).toEqual([
      [activityActionPath(AID, 'reveal'), undefined],
      [activityActionPath(AID, 'placed'), undefined],
      [activityActionPath(AID, 'hide'), { word: 'Agile', hidden: true }],
    ])
    const input = {
      kind: 'words' as const,
      prompt: 'One word?',
      config: { maxWords: 3 },
      anonymous: true,
      resultsLive: false,
      durationMs: null,
    }
    await k.store.start(input)
    expect(k.calls.at(-1)).toEqual({ method: 'POST', path: activitiesPath(BOARD), body: input })
  })

  it('an answer to an activity that is not open is not sent; a refusal says why and refetches', async () => {
    const k = kit()
    k.serve(() => state({ activity: activity({ status: 'closed' }) }))
    k.events.fireResync()
    await flush()
    const r = await k.store.answer({ kind: 'poll', choices: [0] })
    expect(r.ok).toBe(false)
    expect(k.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    k.serve(() => state())
    k.events.fireResync()
    await flush()
    k.serve((m) =>
      m === 'POST'
        ? new ApiError(409, 'ACTIVITY_NOT_OPEN', 'This poll is closed.')
        : state({ activity: null }),
    )
    const r2 = await k.store.answer({ kind: 'poll', choices: [0] })
    expect(r2).toMatchObject({ ok: false, error: 'This poll is closed.', code: 'ACTIVITY_NOT_OPEN' })
    await flush()
    expect(k.store.getSnapshot().activity).toBeNull()
    // the feature went off while the panel was open
    k.serve((m) => (m === 'POST' ? new ApiError(404, 'NOT_FOUND', 'Not found.') : state()))
    k.events.fireResync()
    await flush()
    const r3 = await k.store.answer({ kind: 'poll', choices: [0] })
    expect(r3.error).toMatch(/not available/)
  })

  it('tells once that someone else started one, never to its starter or a manager, and the results', async () => {
    const k = kit()
    k.serve(() => state())
    k.events.fireResync()
    await flush()
    k.events.fireResync()
    await flush()
    expect(k.news.map((n) => n.kind)).toEqual(['started'])
    // revealed by someone else while this tab watched
    k.serve(() => state({ activity: activity({ status: 'revealed' }) }))
    k.events.emit(LIVE_ACTIVITY_EVENTS.activity, {
      activity: activity({ status: 'revealed' }),
      answered: 2,
      results: { kind: 'poll', answered: 2, counts: [1, 1] },
    })
    await flush()
    expect(k.news.map((n) => n.kind)).toEqual(['started', 'revealed'])

    const starter = kit({ userId: FAC })
    starter.serve(() => state())
    starter.events.fireResync()
    await flush()
    const manager = kit()
    manager.serve(() => state({ canManage: true }))
    manager.events.fireResync()
    await flush()
    expect(starter.news).toEqual([])
    expect(manager.news).toEqual([])
    // this tab's own reveal brings no "results are in"
    manager.serve(() => state({ canManage: true, activity: activity({ status: 'revealed' }) }))
    await manager.store.reveal()
    expect(manager.news).toEqual([])
    // someone who already answered is not asked again
    const answered = kit()
    answered.serve(() => state({ myAnswer: { kind: 'poll', choices: [0] } }))
    answered.events.fireResync()
    await flush()
    expect(answered.news).toEqual([])
  })
})

describe('time', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('an open activity past its end reads closed, and is asked again shortly after', async () => {
    const now = Date.parse('2026-10-18T10:00:00.000Z')
    vi.setSystemTime(now)
    const a = activity({ endsAt: '2026-10-18T10:01:00.000Z' })
    expect(effectiveStatus(a, now, 0)).toBe('open')
    expect(effectiveStatus(a, now + 60_000, 0)).toBe('closed')
    expect(effectiveStatus(a, now, 60_000)).toBe('closed')
    expect(remainingMs(a, now + 30_000, 0)).toBe(30_000)
    expect(remainingMs(activity(), now, 0)).toBeNull()

    const k = kit()
    k.serve(() => state({ activity: a, serverNow: new Date(now).toISOString() }))
    k.events.fireResync()
    await vi.advanceTimersByTimeAsync(0)
    expect(k.store.getSnapshot().status).toBe('open')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(k.store.getSnapshot().status).toBe('closed')
    const gets = k.calls.filter((c) => c.method === 'GET').length
    await vi.advanceTimersByTimeAsync(700)
    expect(k.calls.filter((c) => c.method === 'GET').length).toBe(gets + 1)
    k.store.dispose()
  })
})
