import type { HandChange, HandsResponse, WorkshopHandEvent } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { handNotice, waitedFor } from './hand-notices.ts'
import { type EventSource, type ReactionShown, type RequestFn, WorkshopStore } from './store.ts'

const ME = 'usr_me0000000001'
const BOB = 'usr_bob000000001'
const ALI = 'usr_ali000000001'
const T0 = '2026-09-27T10:00:00.000Z'

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

const hand = (userId: string, name: string) => ({ userId, name, raisedAt: T0 })
const v = (n: number, epoch = 'e1') => ({ epoch, n })

function harness(opts: { now?: () => number } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const replies: (() => unknown)[] = []
  let workshop: Record<string, unknown> = {
    timer: null,
    vote: null,
    hands: [],
    handsVersion: v(0),
    serverNow: T0,
  }
  const request = (async (method: string, path: string, o: { body?: unknown }) => {
    calls.push({ method, path, body: o.body })
    const r = replies.shift()
    if (r) return r()
    if (method === 'GET' && path.endsWith('/workshop')) return workshop
    return undefined
  }) as unknown as RequestFn
  const events = new FakeEvents()
  const store = new WorkshopStore({
    boardId: 'b-abc1234567',
    userId: ME,
    request,
    events,
    storage: null,
    nowMs: opts.now,
  })
  return {
    store,
    events,
    calls,
    reply: (fn: () => unknown) => replies.push(fn),
    setWorkshop: (w: Record<string, unknown>) => {
      workshop = w
    },
  }
}

const change = (over: Partial<HandChange>): HandChange => ({
  userId: BOB,
  name: 'Bob',
  raised: true,
  reason: 'raised',
  byUserId: null,
  byName: null,
  ...over,
})

describe('WorkshopStore: hands', () => {
  it('late joiners get the queue from the workshop state; mine is picked out', async () => {
    const h = harness()
    h.setWorkshop({
      timer: null,
      vote: null,
      hands: [hand(BOB, 'Bob'), hand(ME, 'Me')],
      handsVersion: v(3),
      serverNow: T0,
    })
    await h.store.refresh()
    const s = h.store.getSnapshot()
    expect(s.hands.map((x) => x.userId)).toEqual([BOB, ME])
    expect(s.myHand?.userId).toBe(ME)
  })

  it('applies newer events (telling listeners what changed), ignores older ones, and a new API process always wins', async () => {
    const h = harness()
    await h.store.refresh()
    const seen: HandChange[][] = []
    h.store.onHandChanges((c) => seen.push(c))
    const e = (hands: unknown[], n: number, epoch = 'e1'): WorkshopHandEvent =>
      ({ hands, changes: [change({})], version: v(n, epoch) }) as WorkshopHandEvent
    h.events.emit('workshop.hand', e([hand(BOB, 'Bob')], 2))
    expect(h.store.getSnapshot().hands).toHaveLength(1)
    h.events.emit('workshop.hand', e([], 1)) // late, older
    expect(h.store.getSnapshot().hands).toHaveLength(1)
    expect(seen).toHaveLength(1)
    h.events.emit('workshop.hand', e([], 0, 'e2')) // the API restarted
    expect(h.store.getSnapshot().hands).toHaveLength(0)
    h.events.emit('workshop.hand', { nonsense: true })
    expect(seen).toHaveLength(2)
  })

  it('a refetch older than the event already applied does not undo it', async () => {
    const h = harness()
    await h.store.refresh()
    h.events.emit('workshop.hand', { hands: [hand(BOB, 'Bob')], changes: [change({})], version: v(5) })
    h.setWorkshop({ timer: null, vote: null, hands: [], handsVersion: v(4), serverNow: T0 })
    await h.store.refresh()
    expect(h.store.getSnapshot().hands.map((x) => x.userId)).toEqual([BOB])
  })

  it('raise, lower someone, clear: the right routes, and the responses are applied', async () => {
    const h = harness()
    await h.store.refresh()
    const res = (hands: unknown[], n: number): HandsResponse =>
      ({ hands, version: v(n), serverNow: T0 }) as HandsResponse
    h.reply(() => res([hand(ME, 'Me')], 1))
    expect(await h.store.setHand(true)).toEqual({ ok: true })
    expect(h.store.getSnapshot().myHand?.userId).toBe(ME)
    h.reply(() => res([], 2))
    await h.store.lowerHand(BOB)
    h.reply(() => res([], 3))
    await h.store.clearHands()
    expect(h.calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/boards/b-abc1234567/hand', body: { raised: true } },
      { method: 'POST', path: `/api/boards/b-abc1234567/hands/${BOB}/lower`, body: undefined },
      { method: 'POST', path: '/api/boards/b-abc1234567/hands/clear', body: undefined },
    ])
    expect(h.store.getSnapshot().hands).toEqual([])
  })

  it('a refused change reports the server’s message and refetches', async () => {
    const h = harness()
    await h.store.refresh()
    h.reply(() => {
      throw Object.assign(new Error('This board is read-only.'), { code: 'FORBIDDEN' })
    })
    expect(await h.store.setHand(true)).toMatchObject({ ok: false, error: 'This board is read-only.' })
    expect(h.calls.filter((c) => c.path.endsWith('/workshop'))).toHaveLength(2)
  })

  it('the tools request counts up (each "Show queue" opens the popover again)', () => {
    const h = harness()
    h.store.requestTools('hands')
    const a = h.store.getSnapshot().toolsRequest
    h.store.requestTools('hands')
    expect(h.store.getSnapshot().toolsRequest).toEqual({ seq: (a?.seq ?? 0) + 1, section: 'hands' })
  })
})

describe('WorkshopStore: reactions', () => {
  it('shows others’ reactions from the stream, never this person’s own echo', () => {
    const h = harness()
    const shown: ReactionShown[] = []
    h.store.onReaction((r) => shown.push(r))
    h.events.emit('workshop.reaction', { userId: BOB, name: 'Bob', emoji: '🎉' })
    h.events.emit('workshop.reaction', { userId: ME, name: 'Me', emoji: '🎉' })
    h.events.emit('workshop.reaction', { userId: BOB, name: 'Bob', emoji: '💩' }) // not in the allowlist
    expect(shown).toEqual([{ userId: BOB, name: 'Bob', emoji: '🎉', mine: false }])
  })

  it('shows its own at once and sends it; past five a second it neither shows nor sends', async () => {
    let t = 0
    const h = harness({ now: () => t })
    const shown: ReactionShown[] = []
    h.store.onReaction((r) => shown.push(r))
    for (let i = 0; i < 5; i++) expect(await h.store.react('👏', 'Me')).toEqual({ ok: true })
    expect(await h.store.react('👏', 'Me')).toMatchObject({ ok: false, code: 'RATE_LIMITED' })
    expect(shown).toHaveLength(5)
    expect(shown.every((r) => r.mine && r.userId === ME)).toBe(true)
    expect(h.calls.filter((c) => c.path.endsWith('/reactions'))).toHaveLength(5)
    expect(h.calls[0]).toEqual({
      method: 'POST',
      path: '/api/boards/b-abc1234567/reactions',
      body: { emoji: '👏' },
    })
    t = 1_000
    expect(await h.store.react('👍', 'Me')).toEqual({ ok: true })
  })
})

describe('hand notices', () => {
  const opts = { selfUserId: ME, facilitator: true, raisedCount: 1 }
  it('facilitators hear about hands going up (not their own); nobody else does', () => {
    expect(handNotice(change({}), opts)).toMatchObject({ text: 'Bob raised a hand.', openQueue: true })
    expect(handNotice(change({}), { ...opts, raisedCount: 3 })?.text).toBe('Bob raised a hand (3 hands up).')
    expect(handNotice(change({ userId: ME }), opts)).toBeNull()
    expect(handNotice(change({}), { ...opts, facilitator: false })).toBeNull()
  })

  it('a person hears when someone else lowered their hand or it timed out', () => {
    const mine = { userId: ME, name: 'Me', raised: false }
    expect(
      handNotice(change({ ...mine, reason: 'lowered_by_facilitator', byUserId: ALI, byName: 'Ali' }), opts)
        ?.text,
    ).toBe('Ali lowered your hand.')
    expect(handNotice(change({ ...mine, reason: 'cleared', byUserId: ALI, byName: 'Ali' }), opts)?.text).toBe(
      'Ali lowered all hands, yours too.',
    )
    expect(handNotice(change({ ...mine, reason: 'cleared', byUserId: ME, byName: 'Me' }), opts)).toBeNull()
    expect(handNotice(change({ ...mine, reason: 'expired' }), opts)?.text).toMatch(/after 10 minutes/)
    expect(handNotice(change({ ...mine, reason: 'lowered' }), opts)).toBeNull()
    expect(handNotice(change({ ...mine, reason: 'disconnected' }), opts)).toBeNull()
    expect(handNotice(change({ raised: false, reason: 'lowered_by_facilitator' }), opts)).toBeNull()
  })

  it('waitedFor', () => {
    const t = Date.parse(T0)
    expect(waitedFor(T0, t + 30_000, 0)).toBe('just now')
    expect(waitedFor(T0, t + 125_000, 0)).toBe('2 min')
    expect(waitedFor(T0, t, 65 * 60_000)).toBe('1 h 5 min')
    expect(waitedFor(T0, t - 10_000, 0)).toBe('just now')
  })
})
