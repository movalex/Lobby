// Present to everyone (present-live): the in-memory registry's rules, with a controllable clock and a
// fake "who is connected", then the routes' permission matrix and the presence rules over real event
// streams.
import {
  FOLLOWER_GRACE_MS,
  isNewerLive,
  LivePresentation,
  PRESENT_LIVE_EVENTS,
  PRESENTER_GRACE_MS,
  PRESENTER_OFFLINE_NOTICE_MS,
  type PresentLiveEvent,
  PresentLiveEvent as PresentLiveEventSchema,
  PresentLiveState,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  newPresentationId,
  PresentationRegistry,
  PresentRuleError,
  presentationSettings,
} from '../../../src/features/workshops/presentation.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { listen, type OpenStream, openStream } from './streams.ts'
import { expectStatus, json, setupWorld, type World } from './support.ts'

const BOARD = 'b-board000001'
const A = { id: 'usr_aaaaaaaaaaaa', name: 'Ann' }
const B = { id: 'usr_bbbbbbbbbbbb', name: 'Ben' }
const C = { id: 'usr_cccccccccccc', name: 'Cal' }
const TAB = 'tab-aaaaaaaa'
const TAB2 = 'tab-bbbbbbbb'
const slide = (n: number, count = 5) => ({ slideId: `shape:f${n}`, index: n, count })

function registry(opts: { followersPublishMs?: number } = {}) {
  let t = Date.parse('2026-09-28T10:00:00.000Z')
  const published: { boardId: string; event: PresentLiveEvent }[] = []
  const online = new Set<string>([A.id, B.id, C.id])
  const r = new PresentationRegistry({
    now: () => new Date(t),
    publish: (boardId, event) => published.push({ boardId, event }),
    online: (_b, userId) => online.has(userId),
    followersPublishMs: opts.followersPublishMs ?? 0,
  })
  return {
    r,
    published,
    online,
    advance: (ms: number) => {
      t += ms
    },
    last: () => published[published.length - 1]?.event,
    kinds: () => published.map((p) => p.event.change.kind),
  }
}

const rule = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof PresentRuleError) return e.code
    throw e
  }
  return null
}

describe('presentation registry (pure)', () => {
  it('start → slide → follow → end, one whole-state event each, every one valid for the contract', () => {
    const { r, published, kinds, last } = registry()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(0) })
    expect(p.id).toMatch(/^prs_[0-9A-Za-z]{20}$/)
    expect(p).toMatchObject({ presenter: { userId: A.id, name: 'Ann' }, tab: TAB, slideId: 'shape:f0' })
    expect(r.slide(BOARD, A.id, { id: p.id, tab: TAB, slide: slide(1) })).toBe(true)
    // The same slide again changes nothing and publishes nothing.
    expect(r.slide(BOARD, A.id, { id: p.id, tab: TAB, slide: slide(1) })).toBe(false)
    r.follow(BOARD, { ...B, guest: false }, p.id, true)
    r.follow(BOARD, { ...C, guest: true }, p.id, true)
    expect(last()?.presentation?.followers).toEqual([
      { userId: B.id, name: 'Ben', guest: false },
      { userId: C.id, name: 'Cal', guest: true },
    ])
    expect(last()?.presentation?.followerCount).toBe(2)
    expect(r.stop(BOARD, A, p.id, false)).toBe(true)
    expect(kinds()).toEqual(['started', 'slide', 'followers', 'followers', 'ended'])
    expect(last()).toMatchObject({
      presentation: null,
      change: { kind: 'ended', reason: 'stopped', byUserId: A.id, byName: 'Ann' },
    })
    for (const e of published) PresentLiveEventSchema.parse(e.event)
    expect(r.size()).toBe(0)
  })

  it('versions every state: later is newer, another process (epoch) always replaces', () => {
    const { r } = registry()
    const v0 = r.version()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(0) })
    const v1 = r.version()
    r.slide(BOARD, A.id, { id: p.id, tab: TAB, slide: slide(2) })
    const v2 = r.version()
    expect(isNewerLive(v0, v1)).toBe(true)
    expect(isNewerLive(v2, v1)).toBe(false)
    expect(isNewerLive(v2, v2)).toBe(true)
    expect(isNewerLive(v2, registry().r.version())).toBe(true)
  })

  it('one presentation per board: someone else is refused while the presenter is here', () => {
    const { r, online, advance } = registry()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(0) })
    expect(rule(() => r.start(BOARD, B, { tab: TAB2, slide: slide(3) }))).toBe('ALREADY_PRESENTING')
    expect(rule(() => r.start(BOARD, B, { tab: TAB2, slide: slide(3), takeOver: true }))).toBe(
      'ALREADY_PRESENTING',
    )
    // Only the presenter moves slides, and only from the presenting tab.
    expect(rule(() => r.slide(BOARD, B.id, { id: p.id, tab: TAB2, slide: slide(1) }))).toBe('NOT_PRESENTER')
    expect(rule(() => r.slide(BOARD, A.id, { id: p.id, tab: TAB2, slide: slide(1) }))).toBe('OTHER_TAB')
    expect(rule(() => r.slide(BOARD, A.id, { id: newPresentationId(), tab: TAB, slide: slide(1) }))).toBe(
      'NOT_PRESENTING',
    )
    // The presenter away for a moment: another editor may take over (after being told).
    online.delete(A.id)
    r.get(BOARD)
    advance(PRESENTER_OFFLINE_NOTICE_MS)
    expect(r.get(BOARD)?.presenterOnline).toBe(false)
    expect(rule(() => r.start(BOARD, B, { tab: TAB2, slide: slide(3) }))).toBe('PRESENTER_AWAY')
    r.follow(BOARD, { ...C, guest: false }, p.id, true)
    const taken = r.start(BOARD, B, { tab: TAB2, slide: slide(3), takeOver: true })
    // The same presentation (its followers keep following), a new presenter.
    expect(taken).toMatchObject({ id: p.id, presenter: { userId: B.id }, tab: TAB2, slideId: 'shape:f3' })
    expect(taken.presenterOnline).toBe(true)
    expect(taken.followers.map((f) => f.userId)).toEqual([C.id])
  })

  it('the presenter again: moves it to another tab (claim) without a new id or losing followers', () => {
    const { r, kinds } = registry()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(0) })
    r.follow(BOARD, { ...B, guest: false }, p.id, true)
    const again = r.start(BOARD, A, { tab: TAB2, slide: slide(0) })
    expect(again).toMatchObject({ id: p.id, tab: TAB2, followerCount: 1 })
    // The same tab re-announcing the same slide publishes nothing.
    r.start(BOARD, A, { tab: TAB2, slide: slide(0) })
    expect(kinds()).toEqual(['started', 'followers', 'claimed'])
  })

  it('hand-off: the new presenter has no tab until one claims it; the old one follows', () => {
    const { r, last } = registry()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(2) })
    r.follow(BOARD, { ...B, guest: false }, p.id, true)
    r.handOff(BOARD, A, p.id, B)
    expect(last()?.change).toMatchObject({ kind: 'handoff', byUserId: A.id })
    expect(last()?.presentation).toMatchObject({
      id: p.id,
      presenter: { userId: B.id, name: 'Ben' },
      tab: null,
      slideId: 'shape:f2',
      followers: [{ userId: A.id, name: 'Ann', guest: false }],
    })
    // A no longer presents; B's tab claims it.
    expect(rule(() => r.slide(BOARD, A.id, { id: p.id, tab: TAB, slide: slide(3) }))).toBe('NOT_PRESENTER')
    expect(r.start(BOARD, B, { tab: TAB2, slide: slide(2) })).toMatchObject({ tab: TAB2 })
    expect(r.slide(BOARD, B.id, { id: p.id, tab: TAB2, slide: slide(3) })).toBe(true)
  })

  it('follow: idempotent, needs the current id to follow, stepping out of a gone one is fine', () => {
    const { r, kinds } = registry()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(0) })
    expect(r.follow(BOARD, { ...B, guest: false }, p.id, true).changed).toBe(true)
    expect(r.follow(BOARD, { ...B, guest: false }, p.id, true).changed).toBe(false)
    expect(r.follow(BOARD, { ...A, guest: false }, p.id, true).changed).toBe(false) // the presenter
    expect(rule(() => r.follow(BOARD, { ...C, guest: false }, newPresentationId(), true))).toBe(
      'NOT_PRESENTING',
    )
    expect(r.follow(BOARD, { ...C, guest: false }, newPresentationId(), false).changed).toBe(false)
    expect(r.follow(BOARD, { ...B, guest: false }, p.id, false).changed).toBe(true)
    expect(kinds()).toEqual(['started', 'followers', 'followers'])
  })

  it('the presenter leaving: "offline" after the notice, ended after the grace; back in time keeps it', () => {
    const { r, online, advance, kinds, last } = registry()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(0) })
    online.delete(A.id)
    r.sweep()
    advance(PRESENTER_OFFLINE_NOTICE_MS - 1)
    r.sweep()
    expect(r.get(BOARD)?.presenterOnline).toBe(true)
    advance(1)
    r.sweep()
    expect(last()?.change.kind).toBe('presenter-offline')
    // A reload: the stream is back before the grace ran out.
    online.add(A.id)
    r.sweep()
    expect(last()?.change.kind).toBe('presenter-online')
    expect(r.get(BOARD)?.id).toBe(p.id)
    // Gone for good this time.
    online.delete(A.id)
    r.sweep()
    advance(PRESENTER_GRACE_MS - 1)
    r.sweep()
    expect(r.get(BOARD)).not.toBeNull()
    advance(1)
    r.sweep()
    expect(r.get(BOARD)).toBeNull()
    expect(last()?.change).toEqual({ kind: 'ended', reason: 'presenter-left', byUserId: null, byName: null })
    expect(kinds()).toEqual([
      'started',
      'presenter-offline',
      'presenter-online',
      'presenter-offline',
      'ended',
    ])
  })

  it('followers without a connection for the grace stop counting', () => {
    const { r, online, advance, last } = registry()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(0) })
    r.follow(BOARD, { ...B, guest: false }, p.id, true)
    r.follow(BOARD, { ...C, guest: false }, p.id, true)
    online.delete(B.id)
    r.sweep()
    advance(FOLLOWER_GRACE_MS - 1)
    r.sweep()
    expect(r.get(BOARD)?.followerCount).toBe(2)
    advance(1)
    r.sweep()
    expect(last()?.presentation?.followers.map((f) => f.userId)).toEqual([C.id])
  })

  it('resume after an api restart: the same id comes back, so followers keep following', () => {
    const { r, last } = registry()
    const id = newPresentationId()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(4), resumeId: id })
    expect(p.id).toBe(id)
    expect(last()?.change.kind).toBe('resumed')
  })

  it('ending: the presenter or an owner (asOwner); nobody else; a gone id is a no-op', () => {
    const { r, last } = registry()
    const p = r.start(BOARD, A, { tab: TAB, slide: slide(0) })
    expect(rule(() => r.stop(BOARD, B, p.id, false))).toBe('NOT_PRESENTER')
    expect(r.stop(BOARD, B, newPresentationId(), false)).toBe(false)
    expect(r.stop(BOARD, C, p.id, true)).toBe(true)
    expect(last()?.change).toMatchObject({ kind: 'ended', reason: 'ended-by-owner', byUserId: C.id })
  })

  it('coalesces follower changes into one event per window (a room joining at once)', () => {
    vi.useFakeTimers()
    try {
      const { r, kinds, last, advance } = registry({ followersPublishMs: 300 })
      const p = r.start(BOARD, A, { tab: TAB, slide: slide(0) })
      // The start just published: the first follower waits for the window, the rest join its event.
      r.follow(BOARD, { ...B, guest: false }, p.id, true)
      r.follow(BOARD, { ...C, guest: true }, p.id, true)
      expect(kinds()).toEqual(['started'])
      advance(300)
      vi.advanceTimersByTime(300)
      expect(kinds()).toEqual(['started', 'followers'])
      expect(last()?.presentation?.followerCount).toBe(2)
      // A slide event in between carries the followers too, and cancels the pending one.
      r.follow(BOARD, { ...B, guest: false }, p.id, false)
      r.slide(BOARD, A.id, { id: p.id, tab: TAB, slide: slide(1) })
      expect(last()?.presentation?.followerCount).toBe(1)
      vi.advanceTimersByTime(1000)
      expect(kinds()).toEqual(['started', 'followers', 'slide'])
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---- routes ------------------------------------------------------------------------------------------

const defaults = { ...presentationSettings }
let w: World
const open: OpenStream[] = []

beforeEach(() => {
  // Deterministic: presence is swept on every read and write (no timer), follower changes publish at once.
  Object.assign(presentationSettings, { ...defaults, sweepMs: 0, followersPublishMs: 0 })
})
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {})
  Object.assign(presentationSettings, defaults)
  await w?.api.close()
})

const path = (w: World, rest = '') => `/api/boards/${w.boardId}/presentation${rest}`
const liveEvents = (w: World) =>
  w.events
    .filter((e) => e.type === PRESENT_LIVE_EVENTS.changed)
    .map((e) => PresentLiveEventSchema.parse(e.data))
const startBody = (tab = TAB, n = 0) => ({ tab, ...slide(n) })

async function start(w: World, c = w.editor, tab = TAB) {
  const res = await c.req('POST', path(w), startBody(tab))
  expectStatus(res, 200)
  const p = PresentLiveState.parse(json(res)).presentation
  if (!p) throw new Error('no presentation')
  return p
}

describe('presentation routes: who may do what', () => {
  it('editors present; viewers and commenters see it and follow; outsiders get 404, anonymous 401', async () => {
    w = await setupWorld()
    // Nothing yet: everyone who can view sees null.
    for (const c of [w.owner, w.editor, w.commenter, w.viewer]) {
      const res = await c.req('GET', path(w))
      expectStatus(res, 200)
      expect(PresentLiveState.parse(json(res)).presentation).toBeNull()
    }
    expectStatus(await w.outsider.req('GET', path(w)), 404)
    expectStatus(await w.api.anon('GET', path(w)), 401)
    expectStatus(await w.viewer.req('POST', path(w), startBody()), 403)
    expectStatus(await w.commenter.req('POST', path(w), startBody()), 403)
    expectStatus(await w.outsider.req('POST', path(w), startBody()), 404)
    expectStatus(await w.editor.req('POST', path(w), { tab: 'x' }), 400)

    const p = await start(w)
    // The name comes from the session.
    expect(p.presenter).toEqual({ userId: w.editor.userId, name: 'Ed Editor' })
    for (const c of [w.viewer, w.commenter]) {
      expectStatus(await c.req('POST', path(w, '/follow'), { id: p.id, following: true }), 200)
    }
    expectStatus(await w.outsider.req('POST', path(w, '/follow'), { id: p.id, following: true }), 404)
    const got = PresentLiveState.parse(json(await w.viewer.req('GET', path(w)))).presentation
    expect(got?.followers.map((f) => f.name)).toEqual(['Vic Viewer', 'Cora Commenter'])
    // Only the presenter moves slides.
    const other = await w.owner.req('POST', path(w, '/slide'), { id: p.id, tab: TAB, ...slide(1) })
    expectStatus(other, 409)
    expect(json<{ error: { code: string } }>(other).error.code).toBe('NOT_PRESENTER')
    expectStatus(await w.viewer.req('POST', path(w, '/slide'), { id: p.id, tab: TAB, ...slide(1) }), 403)
    expectStatus(await w.editor.req('POST', path(w, '/slide'), { id: p.id, tab: TAB, ...slide(1) }), 200)
    // Someone else starting is told who presents.
    const clash = await w.owner.req('POST', path(w), startBody(TAB2))
    expectStatus(clash, 409)
    expect(json<{ error: { code: string; message: string } }>(clash).error).toMatchObject({
      code: 'ALREADY_PRESENTING',
      message: expect.stringContaining('Ed Editor is presenting'),
    })
    // Every event parses and names nothing but what the board already shows.
    const evs = liveEvents(w)
    expect(evs.map((e) => e.change.kind)).toEqual(['started', 'followers', 'followers', 'slide'])
    for (const e of evs) {
      if (e.presentation) LivePresentation.parse(e.presentation)
      expect(JSON.stringify(e)).not.toMatch(/cookie|session|handle|email/i)
    }
  })

  it('ending: an editor who is not the presenter cannot; a board owner can; the presenter can', async () => {
    w = await setupWorld()
    const p = await start(w)
    const res = await w.commenter.req('POST', path(w, '/stop'), { id: p.id })
    expectStatus(res, 403)
    // The owner (Dev Studio owner = board owner) ends it for everyone.
    expectStatus(await w.owner.req('POST', path(w, '/stop'), { id: p.id }), 200)
    expect(liveEvents(w).at(-1)?.change).toMatchObject({
      kind: 'ended',
      reason: 'ended-by-owner',
      byUserId: w.owner.userId,
    })
    const again = await start(w)
    // An already ended id is a no-op (a double click), for anyone who can view.
    expectStatus(await w.viewer.req('POST', path(w, '/stop'), { id: p.id }), 200)
    expectStatus(await w.editor.req('POST', path(w, '/stop'), { id: again.id }), 200)
    expect(liveEvents(w).at(-1)?.change).toMatchObject({ kind: 'ended', reason: 'stopped' })
    expect(PresentLiveState.parse(json(await w.viewer.req('GET', path(w)))).presentation).toBeNull()
  })

  it('name-only guests follow (their marker is a flag) but never present or receive a hand-off', async () => {
    w = await setupWorld()
    const link = await guestLink(w.owner, w.boardId, { role: 'editor' })
    const guest = await joinAsGuest(w.api, link.url, 'Sam')
    const refused = await guest.req('POST', path(w), startBody())
    expectStatus(refused, 403)
    expect(json<{ error: { code: string } }>(refused).error.code).toBe('GUEST_ACCOUNT_REQUIRED')
    const p = await start(w)
    expectStatus(await guest.req('POST', path(w, '/follow'), { id: p.id, following: true }), 200)
    const got = PresentLiveState.parse(json(await guest.req('GET', path(w)))).presentation
    // The marker is part of the display name, as on the rest of the board, and a flag too.
    expect(got?.followers).toEqual([{ userId: guest.userId, name: 'Sam (guest)', guest: true }])
    // Handing over to the guest is refused even though they can edit and are on the board.
    const base = await listen(w)
    open.push(await openStream(w, base, guest.cookie))
    open.push(await openStream(w, base, w.editor.cookie))
    const handoff = await w.editor.req('POST', path(w, '/handoff'), { id: p.id, userId: guest.userId })
    expectStatus(handoff, 409)
    expect(json<{ error: { code: string } }>(handoff).error.code).toBe('GUEST_CANNOT_PRESENT')
  })

  it('hand-off: only to someone who can edit, has an account and is on the board now', async () => {
    w = await setupWorld()
    const base = await listen(w)
    open.push(await openStream(w, base, w.editor.cookie))
    const p = await start(w)
    const code = async (userId: string) =>
      json<{ error: { code: string } }>(await w.editor.req('POST', path(w, '/handoff'), { id: p.id, userId }))
        .error?.code
    expect(await code(w.viewer.userId)).toBe('CANNOT_PRESENT')
    expect(await code(w.outsider.userId)).toBe('CANNOT_PRESENT')
    expect(await code('usr_nobodynobodynobody')).toBe('CANNOT_PRESENT')
    expect(await code(w.owner.userId)).toBe('NOT_ON_BOARD')
    // Not the presenter: refused.
    const notMine = await w.owner.req('POST', path(w, '/handoff'), { id: p.id, userId: w.editor.userId })
    expect(json<{ error: { code: string } }>(notMine).error.code).toBe('NOT_PRESENTER')
    open.push(await openStream(w, base, w.owner.cookie))
    const ok = await w.editor.req('POST', path(w, '/handoff'), { id: p.id, userId: w.owner.userId })
    expectStatus(ok, 200)
    const after = PresentLiveState.parse(json(ok)).presentation
    expect(after).toMatchObject({ presenter: { userId: w.owner.userId, name: 'Ada Owner' }, tab: null })
    expect(after?.followers.map((f) => f.userId)).toEqual([w.editor.userId])
    // The new presenter's tab claims it, and only then moves slides.
    const claimed = await w.owner.req('POST', path(w), startBody(TAB2, 0))
    expectStatus(claimed, 200)
    expect(PresentLiveState.parse(json(claimed)).presentation?.tab).toBe(TAB2)
    expectStatus(await w.owner.req('POST', path(w, '/slide'), { id: p.id, tab: TAB2, ...slide(2) }), 200)
  })

  it('is rate limited: slide storms per board, follow toggles per person', async () => {
    presentationSettings.slidesPerSecond = 3
    presentationSettings.followsPer10s = 2
    w = await setupWorld()
    const p = await start(w)
    for (let i = 1; i <= 3; i++)
      expectStatus(await w.editor.req('POST', path(w, '/slide'), { id: p.id, tab: TAB, ...slide(i) }), 200)
    const fast = await w.editor.req('POST', path(w, '/slide'), { id: p.id, tab: TAB, ...slide(4) })
    expectStatus(fast, 429)
    expect(fast.headers['retry-after']).toBe('1')
    for (const following of [true, false])
      expectStatus(await w.viewer.req('POST', path(w, '/follow'), { id: p.id, following }), 200)
    expectStatus(await w.viewer.req('POST', path(w, '/follow'), { id: p.id, following: true }), 429)
    // Someone else is not held back by the viewer's limit.
    expectStatus(await w.commenter.req('POST', path(w, '/follow'), { id: p.id, following: true }), 200)
  })
})

describe('presentation routes: presence over real event streams', () => {
  it('the presenter closing the tab: followers see "offline", then the end; a reload keeps it', async () => {
    w = await setupWorld()
    const base = await listen(w)
    const presenterTab = await openStream(w, base, w.editor.cookie)
    const viewer = await openStream(w, base, w.viewer.cookie)
    open.push(viewer)
    const p = await start(w)
    expectStatus(await w.viewer.req('POST', path(w, '/follow'), { id: p.id, following: true }), 200)

    // A reload: the old stream ends, a new one opens before the grace.
    await presenterTab.close()
    await w.viewer.req('GET', path(w)) // the sweep notices the presenter has no stream
    w.clock.advance(PRESENTER_OFFLINE_NOTICE_MS)
    const offline = PresentLiveState.parse(json(await w.viewer.req('GET', path(w)))).presentation
    expect(offline?.presenterOnline).toBe(false)
    await viewer.waitFor(
      PRESENT_LIVE_EVENTS.changed,
      (d) => (d as PresentLiveEvent).change.kind === 'presenter-offline',
    )
    const reloaded = await openStream(w, base, w.editor.cookie)
    const back = PresentLiveState.parse(json(await w.viewer.req('GET', path(w)))).presentation
    expect(back).toMatchObject({ id: p.id, presenterOnline: true })

    // Closing it for good: after the grace it ends for everyone, and the stream says why.
    await reloaded.close()
    await w.viewer.req('GET', path(w))
    w.clock.advance(PRESENTER_GRACE_MS)
    expect(PresentLiveState.parse(json(await w.viewer.req('GET', path(w)))).presentation).toBeNull()
    const end = await viewer.waitFor(
      PRESENT_LIVE_EVENTS.changed,
      (d) => (d as PresentLiveEvent).change.kind === 'ended',
    )
    expect((end.data as PresentLiveEvent).change.reason).toBe('presenter-left')
  })

  it('a follower whose streams all ended stops counting after the grace', async () => {
    w = await setupWorld()
    const base = await listen(w)
    open.push(await openStream(w, base, w.editor.cookie))
    const viewer = await openStream(w, base, w.viewer.cookie)
    const p = await start(w)
    expectStatus(await w.viewer.req('POST', path(w, '/follow'), { id: p.id, following: true }), 200)
    await viewer.close()
    await w.editor.req('GET', path(w))
    w.clock.advance(FOLLOWER_GRACE_MS)
    const after = PresentLiveState.parse(json(await w.editor.req('GET', path(w)))).presentation
    expect(after?.followerCount).toBe(0)
  })
})
