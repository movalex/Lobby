import type { LivePresentation, PresentLiveState, PresentLiveVersion } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LiveRequest, LiveStore, RESTART_WAIT_MS, SLIDE_RETRY_MS } from './store.ts'

const ME = 'usr_meeeeeeeeeeee'
const ANN = 'usr_annnnnnnnnnnn'
const TAB = 'tab_aaaaaaaaaaaaaaaaaaaa'
const ID = 'prs_AAAAAAAAAAAAAAAAAAAA'
const BOARD = 'b-board000001'

const pres = (over: Partial<LivePresentation> = {}): LivePresentation => ({
  id: ID,
  presenter: { userId: ME, name: 'Me' },
  tab: TAB,
  slideId: 'shape:f0',
  index: 0,
  count: 3,
  startedAt: '2026-09-28T10:00:00.000Z',
  presenterOnline: true,
  followers: [],
  followerCount: 0,
  ...over,
})
const v = (n: number, epoch = 'e1'): PresentLiveVersion => ({ epoch, n })
const state = (presentation: LivePresentation | null, n: number, epoch = 'e1'): PresentLiveState => ({
  presentation,
  version: v(n, epoch),
  serverNow: '2026-09-28T10:00:00.000Z',
})

interface Call {
  method: string
  path: string
  body: unknown
  resolve(value: unknown): void
  reject(e: unknown): void
}

function harness(opts: { storage?: Map<string, string> } = {}) {
  const calls: Call[] = []
  const request = ((method: string, path: string, o: { body?: unknown }) =>
    new Promise((resolve, reject) => {
      calls.push({ method, path, body: o.body, resolve, reject })
    })) as unknown as LiveRequest
  const listeners = new Map<string, ((data: unknown) => void)[]>()
  const resyncs: (() => void)[] = []
  const events = {
    on(type: string, fn: (data: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
      return () => {}
    },
    onResync(fn: () => void) {
      resyncs.push(fn)
      return () => {}
    },
  }
  const map = opts.storage ?? new Map<string, string>()
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, val: string) => void map.set(k, val),
    removeItem: (k: string) => void map.delete(k),
  }
  const store = new LiveStore({ boardId: BOARD, userId: ME, tab: TAB, request, events, storage })
  const emit = (data: unknown) => {
    for (const fn of listeners.get('present.live') ?? []) fn(data)
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return {
    store,
    calls,
    emit,
    resync: () => {
      for (const f of resyncs) f()
    },
    map,
    flush,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('LiveStore: applying the api’s states', () => {
  it('applies states in version order; another api process (epoch) always wins', () => {
    const { store } = harness()
    expect(store.apply(state(pres({ index: 2 }), 5))).toBe(true)
    expect(store.apply(state(pres({ index: 1 }), 4))).toBe(false)
    expect(store.presentation.get()?.index).toBe(2)
    expect(store.apply(state(pres({ index: 0 }), 1, 'e2'))).toBe(true)
    expect(store.presentation.get()?.index).toBe(0)
    expect(store.loaded.get()).toBe(true)
  })

  it('takes events (whole states with what changed) and ignores malformed ones', () => {
    const { store, emit } = harness()
    emit({ nonsense: true })
    expect(store.loaded.get()).toBe(false)
    emit({
      presentation: null,
      change: { kind: 'ended', reason: 'stopped', byUserId: ANN, byName: 'Ann' },
      version: v(3),
    })
    expect(store.presentation.get()).toBeNull()
    expect(store.lastChange.get()).toMatchObject({ kind: 'ended', reason: 'stopped', byName: 'Ann' })
  })

  it('a refetch that finds it gone (same api) says it ended; an api restart waits for the presenter', () => {
    const { store } = harness()
    store.apply(state(pres(), 1))
    store.apply(state(null, 2))
    expect(store.lastChange.get()).toEqual({ kind: 'ended', reason: null, byUserId: null, byName: null })
    expect(store.restartLost.get()).toBeNull()

    store.apply(state(pres(), 3))
    store.apply(state(null, 0, 'e2')) // the api restarted and forgot it
    expect(store.restartLost.get()?.id).toBe(ID)
    // The presenter's tab puts it back: the wait ends.
    store.apply(state(pres(), 1, 'e2'))
    expect(store.restartLost.get()).toBeNull()

    store.apply(state(null, 0, 'e3'))
    expect(store.restartLost.get()?.id).toBe(ID)
    vi.advanceTimersByTime(RESTART_WAIT_MS)
    expect(store.restartLost.get()).toBeNull()
    expect(store.lastChange.get()?.kind).toBe('ended')
  })
})

describe('LiveStore: the presenter’s slides', () => {
  it('sends only from the presenting tab, skips what the api has, keeps one request in flight', async () => {
    const { store, calls } = harness()
    store.sendSlide({ slideId: 'shape:f1', index: 1, count: 3 })
    expect(calls).toHaveLength(0) // nothing to send to: no presentation
    store.apply(state(pres(), 1))
    store.sendSlide({ slideId: 'shape:f0', index: 0, count: 3 }) // the api has it already
    expect(calls).toHaveLength(0)
    store.sendSlide({ slideId: 'shape:f1', index: 1, count: 3 })
    store.sendSlide({ slideId: 'shape:f2', index: 2, count: 3 })
    store.sendSlide({ slideId: 'shape:f1', index: 1, count: 3 })
    expect(calls.map((c) => (c.body as { index: number }).index)).toEqual([1])
    calls[0]?.resolve(state(pres({ slideId: 'shape:f1', index: 1 }), 2))
    await tick()
    // The latest wanted slide equals what the api now has: nothing more to send.
    expect(calls).toHaveLength(1)
    store.sendSlide({ slideId: 'shape:f2', index: 2, count: 3 })
    expect(calls[1]?.body).toEqual({ id: ID, tab: TAB, slideId: 'shape:f2', index: 2, count: 3 })
    expect(calls[1]?.path).toBe(`/api/boards/${BOARD}/presentation/slide`)
  })

  it('not the presenting tab (another tab of mine, or someone else): sends nothing', () => {
    const { store, calls } = harness()
    store.apply(state(pres({ tab: 'tab_otherotherotherother' }), 1))
    store.sendSlide({ slideId: 'shape:f1', index: 1, count: 3 })
    store.apply(state(pres({ presenter: { userId: ANN, name: 'Ann' }, tab: TAB }), 2))
    store.sendSlide({ slideId: 'shape:f1', index: 1, count: 3 })
    expect(calls).toHaveLength(0)
  })

  it('a slide lost to the network goes again (the latest one)', async () => {
    const { store, calls } = harness()
    store.apply(state(pres(), 1))
    store.sendSlide({ slideId: 'shape:f1', index: 1, count: 3 })
    calls[0]?.reject(Object.assign(new Error('offline'), { code: 'NETWORK' }))
    await tick()
    expect(calls).toHaveLength(1)
    vi.advanceTimersByTime(SLIDE_RETRY_MS)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body).toMatchObject({ index: 1 })
  })
})

describe('LiveStore: following', () => {
  it('remembers the choice per presentation for the tab (sessionStorage)', () => {
    const storage = new Map<string, string>()
    const a = harness({ storage })
    a.store.setIntent(ID, 'following')
    expect(a.store.intentFor(ID)).toBe('following')
    expect(a.store.intentFor('prs_BBBBBBBBBBBBBBBBBBBB')).toBeNull()
    const b = harness({ storage })
    expect(b.store.intentFor(ID)).toBe('following')
  })

  it('after a reconnect a follower the api no longer lists follows again', async () => {
    const { store, calls, resync } = harness()
    store.setIntent(ID, 'following')
    resync()
    expect(calls[0]?.method).toBe('GET')
    calls[0]?.resolve(
      state(pres({ presenter: { userId: ANN, name: 'Ann' }, tab: 'tab_annannannannannann' }), 1),
    )
    await tick()
    expect(calls[1]).toMatchObject({ method: 'POST', body: { id: ID, following: true } })
    expect(calls[1]?.path).toBe(`/api/boards/${BOARD}/presentation/follow`)
  })

  it('the presentation back after an api restart (an event): a follower it no longer counts follows again', async () => {
    const { store, calls, emit } = harness()
    const annPres = pres({ presenter: { userId: ANN, name: 'Ann' }, tab: 'tab_annannannannannann' })
    store.apply(
      state({ ...annPres, followers: [{ userId: ME, name: 'Me', guest: false }], followerCount: 1 }, 4),
    )
    store.setIntent(ID, 'following')
    store.apply(state(null, 0, 'e2')) // restarted: forgotten
    expect(store.restartLost.get()?.id).toBe(ID)
    emit({
      presentation: annPres,
      change: { kind: 'resumed', reason: null, byUserId: ANN, byName: 'Ann' },
      version: v(1, 'e2'),
    })
    expect(store.restartLost.get()).toBeNull()
    expect(calls[0]).toMatchObject({ method: 'POST', body: { id: ID, following: true } })
    // Another event before the answer does not send a second request.
    emit({
      presentation: annPres,
      change: { kind: 'slide', reason: null, byUserId: ANN, byName: 'Ann' },
      version: v(2, 'e2'),
    })
    expect(calls).toHaveLength(1)
  })

  it('a refused action refetches when the presentation moved on', async () => {
    const { store, calls } = harness()
    store.apply(state(pres({ presenter: { userId: ANN, name: 'Ann' } }), 1))
    const r = store.follow(true)
    calls[0]?.reject(Object.assign(new Error('This presentation has ended.'), { code: 'NOT_PRESENTING' }))
    expect(await r).toEqual({ ok: false, code: 'NOT_PRESENTING', message: 'This presentation has ended.' })
    expect(calls[1]?.method).toBe('GET')
  })
})
