import {
  HAND_AUTO_LOWER_MS,
  type WorkshopHandEvent as HandEvent,
  HandsResponse,
  isNewerHands,
  WorkshopHandEvent,
  WorkshopState,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { HAND_DISCONNECT_GRACE_MS, HandRegistry } from '../../../src/features/workshops/hands.ts'
import { listen, openStream } from './streams.ts'
import { expectStatus, json, setupWorld, type World } from './support.ts'

const BOARD = 'b-board000001'
const A = { id: 'usr_aaaaaaaaaaaa', name: 'Ann' }
const B = { id: 'usr_bbbbbbbbbbbb', name: 'Ben' }
const C = { id: 'usr_cccccccccccc', name: 'Cal' }

function registry(opts: { maxPerBoard?: number } = {}) {
  let t = Date.parse('2026-09-27T10:00:00.000Z')
  const published: { boardId: string; event: HandEvent }[] = []
  const r = new HandRegistry({
    now: () => new Date(t),
    publish: (boardId, event) => published.push({ boardId, event }),
    ...opts,
  })
  return {
    r,
    published,
    advance: (ms: number) => {
      t += ms
    },
    ids: () => r.list(BOARD).map((h) => h.userId),
  }
}

describe('hand registry (pure)', () => {
  it('queues hands first raised first; raising again keeps the place and publishes nothing', () => {
    const { r, published, advance, ids } = registry()
    r.streamOpened(BOARD, A.id)
    r.streamOpened(BOARD, B.id)
    r.raise(BOARD, B)
    advance(1_000)
    r.raise(BOARD, A)
    advance(1_000)
    expect(r.raise(BOARD, B).changed).toBe(false)
    expect(ids()).toEqual([B.id, A.id])
    expect(published).toHaveLength(2)
    expect(published[1]?.event).toEqual({
      hands: [
        { userId: B.id, name: 'Ben', raisedAt: '2026-09-27T10:00:00.000Z' },
        { userId: A.id, name: 'Ann', raisedAt: '2026-09-27T10:00:01.000Z' },
      ],
      changes: [{ userId: A.id, name: 'Ann', raised: true, reason: 'raised', byUserId: null, byName: null }],
      version: { epoch: r.version().epoch, n: 2 },
    })
    // Every event parses with the published contract.
    for (const p of published) WorkshopHandEvent.parse(p.event)
  })

  it('versions every list: later changes are newer, another process (epoch) always replaces', () => {
    const { r } = registry()
    const v0 = r.version()
    r.raise(BOARD, A)
    const v1 = r.version()
    r.raise('b-otherboard1', B) // any board's change moves the counter
    const v2 = r.version()
    expect(isNewerHands(v0, v1)).toBe(true)
    expect(isNewerHands(v2, v1)).toBe(false)
    expect(isNewerHands(v1, v1)).toBe(true) // the same list again is fine
    expect(isNewerHands(null, v0)).toBe(true)
    expect(isNewerHands(v2, null)).toBe(false)
    const restarted = registry().r
    expect(restarted.version().epoch).not.toBe(v2.epoch)
    expect(isNewerHands(v2, restarted.version())).toBe(true)
  })

  it('lowering: by the owner, by a facilitator, all at once; idempotent', () => {
    const { r, published, ids } = registry()
    for (const u of [A, B, C]) {
      r.streamOpened(BOARD, u.id)
      r.raise(BOARD, u)
    }
    expect(r.lower(BOARD, A.id, null).changed).toBe(true)
    expect(published.at(-1)?.event.changes).toEqual([
      { userId: A.id, name: 'Ann', raised: false, reason: 'lowered', byUserId: null, byName: null },
    ])
    expect(r.lower(BOARD, A.id, null).changed).toBe(false)
    r.lower(BOARD, B.id, C)
    expect(published.at(-1)?.event.changes[0]).toMatchObject({
      userId: B.id,
      reason: 'lowered_by_facilitator',
      byUserId: C.id,
      byName: 'Cal',
    })
    // Lowering your own hand "as a facilitator" is still just lowering it.
    r.raise(BOARD, A)
    r.lower(BOARD, A.id, A)
    expect(published.at(-1)?.event.changes[0]).toMatchObject({
      reason: 'lowered',
      byUserId: null,
      byName: null,
    })
    r.raise(BOARD, A)
    r.raise(BOARD, B)
    const before = published.length
    expect(r.clear(BOARD, C).changed).toBe(true)
    expect(published).toHaveLength(before + 1) // one event for the whole clear
    expect(published.at(-1)?.event).toMatchObject({ hands: [] })
    expect(published.at(-1)?.event.changes.map((c) => [c.userId, c.reason])).toEqual([
      [C.id, 'cleared'],
      [A.id, 'cleared'],
      [B.id, 'cleared'],
    ])
    expect(published.at(-1)?.event.changes.every((c) => c.byUserId === C.id && c.byName === 'Cal')).toBe(true)
    expect(ids()).toEqual([])
    expect(r.clear(BOARD, C).changed).toBe(false)
  })

  it(`goes down on its own after ${HAND_AUTO_LOWER_MS / 60_000} minutes`, () => {
    const { r, published, advance, ids } = registry()
    r.streamOpened(BOARD, A.id)
    r.raise(BOARD, A)
    advance(HAND_AUTO_LOWER_MS - 1)
    r.sweep()
    expect(ids()).toEqual([A.id])
    advance(1)
    r.sweep()
    expect(ids()).toEqual([])
    expect(published.at(-1)?.event.changes).toEqual([
      { userId: A.id, name: 'Ann', raised: false, reason: 'expired', byUserId: null, byName: null },
    ])
  })

  it('goes down when the last stream of its owner ends and none comes back within the grace', () => {
    const { r, published, advance, ids } = registry()
    r.streamOpened(BOARD, A.id)
    r.streamOpened(BOARD, A.id) // two tabs
    r.raise(BOARD, A)
    r.streamClosed(BOARD, A.id)
    advance(HAND_DISCONNECT_GRACE_MS * 10)
    r.sweep()
    expect(ids()).toEqual([A.id]) // the other tab is still open
    r.streamClosed(BOARD, A.id)
    advance(HAND_DISCONNECT_GRACE_MS - 1)
    r.sweep()
    expect(ids()).toEqual([A.id]) // within the grace (a reload)
    r.streamOpened(BOARD, A.id) // ... and back
    advance(HAND_DISCONNECT_GRACE_MS * 10)
    r.sweep()
    expect(ids()).toEqual([A.id])
    r.streamClosed(BOARD, A.id)
    advance(HAND_DISCONNECT_GRACE_MS)
    expect(ids()).toEqual([]) // list() sweeps too
    expect(published.at(-1)?.event.changes[0]).toMatchObject({ userId: A.id, reason: 'disconnected' })
    expect(r.openStreams(BOARD, A.id)).toBe(0)
  })

  it('a hand raised with no stream open goes down after the grace; streams are per board', () => {
    const { r, advance, ids } = registry()
    r.streamOpened('b-otherboard1', A.id) // open elsewhere only
    r.raise(BOARD, A)
    advance(HAND_DISCONNECT_GRACE_MS)
    r.sweep()
    expect(ids()).toEqual([])
    expect(r.list('b-otherboard1')).toEqual([])
  })

  it('one event per sweep when several hands go down together; boards are independent', () => {
    const { r, published, advance } = registry()
    r.streamOpened(BOARD, A.id)
    r.streamOpened(BOARD, B.id)
    r.streamOpened('b-otherboard1', C.id)
    r.raise(BOARD, A)
    r.raise(BOARD, B)
    r.raise('b-otherboard1', C)
    advance(1_000)
    r.streamClosed(BOARD, B.id)
    const before = published.length
    advance(HAND_AUTO_LOWER_MS)
    r.sweep()
    const sweepEvents = published.slice(before)
    expect(sweepEvents.map((p) => p.boardId).sort()).toEqual([BOARD, 'b-otherboard1'])
    const mine = sweepEvents.find((p) => p.boardId === BOARD)?.event
    expect(mine?.changes.map((c) => [c.userId, c.reason])).toEqual([
      [A.id, 'expired'],
      [B.id, 'expired'],
    ])
  })

  it('caps the hands on one board', () => {
    const { r } = registry({ maxPerBoard: 2 })
    r.raise(BOARD, A)
    r.raise(BOARD, B)
    expect(() => r.raise(BOARD, C)).toThrow(/Too many hands/)
    expect(r.raise(BOARD, A).changed).toBe(false) // already up: still fine
  })
})

// ---- routes -----------------------------------------------------------------------------------------

let w: World
afterEach(async () => {
  await w?.api.close()
})

const handEvents = (world: World) =>
  world.events.filter((e) => e.type === 'workshop.hand').map((e) => WorkshopHandEvent.parse(e.data))

describe('raise hand (routes)', () => {
  it('everyone who can view raises and lowers their own hand; identity is the session', async () => {
    w = await setupWorld()
    const path = `/api/boards/${w.boardId}/hand`
    for (const c of [w.viewer, w.commenter, w.editor, w.owner]) {
      const res = await c.req('POST', path, { raised: true, userId: w.owner.userId, name: 'Forged' })
      expectStatus(res, 200)
    }
    const body = HandsResponse.parse(json(await w.viewer.req('GET', `/api/boards/${w.boardId}/hands`)))
    expect(body.hands.map((h) => [h.userId, h.name])).toEqual([
      [w.viewer.userId, 'Vic Viewer'],
      [w.commenter.userId, 'Cora Commenter'],
      [w.editor.userId, 'Ed Editor'],
      [w.owner.userId, 'Ada Owner'],
    ])
    expect(handEvents(w).map((e) => e.changes[0]?.userId)).toEqual([
      w.viewer.userId,
      w.commenter.userId,
      w.editor.userId,
      w.owner.userId,
    ])
    expectStatus(await w.viewer.req('POST', path, { raised: false }), 200)
    expect(handEvents(w).at(-1)?.changes[0]).toMatchObject({ userId: w.viewer.userId, reason: 'lowered' })
    // A second "lower" changes nothing and publishes nothing.
    const n = w.events.length
    expectStatus(await w.viewer.req('POST', path, { raised: false }), 200)
    expect(w.events).toHaveLength(n)
  })

  it('refuses outsiders (404, no existence leak), anonymous callers and malformed bodies', async () => {
    w = await setupWorld()
    const path = `/api/boards/${w.boardId}/hand`
    expectStatus(await w.outsider.req('POST', path, { raised: true }), 404)
    expectStatus(await w.outsider.req('GET', `/api/boards/${w.boardId}/hands`), 404)
    expectStatus(await w.api.anon('POST', path, { raised: true }), 401)
    expectStatus(await w.viewer.req('POST', path, { raised: 'yes' }), 400)
    expectStatus(await w.viewer.req('POST', path), 400)
    expectStatus(await w.viewer.req('POST', '/api/boards/b-nosuchboard9/hand', { raised: true }), 404)
    expect(handEvents(w)).toEqual([])
  })

  it('facilitators lower anyone’s hand or all of them; others only their own', async () => {
    w = await setupWorld()
    for (const c of [w.viewer, w.commenter])
      expectStatus(await c.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true }), 200)
    const lower = (uid: string) => `/api/boards/${w.boardId}/hands/${uid}/lower`
    expectStatus(await w.commenter.req('POST', lower(w.viewer.userId)), 403)
    expectStatus(await w.viewer.req('POST', lower(w.commenter.userId)), 403)
    expectStatus(await w.outsider.req('POST', lower(w.viewer.userId)), 404)
    expectStatus(await w.editor.req('POST', lower('not-a-user')), 404)
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/hands/clear`), 403)
    expect(
      HandsResponse.parse(json(await w.owner.req('GET', `/api/boards/${w.boardId}/hands`))).hands,
    ).toHaveLength(2)

    const res = await w.editor.req('POST', lower(w.viewer.userId))
    expectStatus(res, 200)
    expect(HandsResponse.parse(json(res)).hands.map((h) => h.userId)).toEqual([w.commenter.userId])
    expect(handEvents(w).at(-1)?.changes).toEqual([
      {
        userId: w.viewer.userId,
        name: 'Vic Viewer',
        raised: false,
        reason: 'lowered_by_facilitator',
        byUserId: w.editor.userId,
        byName: 'Ed Editor',
      },
    ])
    // Your own hand through the same route needs only view.
    expectStatus(await w.commenter.req('POST', lower(w.commenter.userId)), 200)
    expect(handEvents(w).at(-1)?.changes[0]).toMatchObject({ reason: 'lowered', byUserId: null })

    for (const c of [w.viewer, w.commenter, w.editor])
      expectStatus(await c.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true }), 200)
    const cleared = await w.owner.req('POST', `/api/boards/${w.boardId}/hands/clear`)
    expectStatus(cleared, 200)
    expect(HandsResponse.parse(json(cleared)).hands).toEqual([])
    expect(
      handEvents(w)
        .at(-1)
        ?.changes.map((c) => c.reason),
    ).toEqual(['cleared', 'cleared', 'cleared'])
  })

  it('late joiners get the queue from GET /workshop', async () => {
    w = await setupWorld()
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true }), 200)
    w.clock.advance(1_000)
    expectStatus(await w.editor.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true }), 200)
    const state = WorkshopState.parse(json(await w.commenter.req('GET', `/api/boards/${w.boardId}/workshop`)))
    expect(state.hands.map((h) => h.userId)).toEqual([w.viewer.userId, w.editor.userId])
    expect(Date.parse(state.hands[1]?.raisedAt ?? '') - Date.parse(state.hands[0]?.raisedAt ?? '')).toBe(
      1_000,
    )
    // The same version as the last event: a client holding that event keeps it, an older one is replaced.
    const last = handEvents(w).at(-1)
    expect(state.handsVersion).toEqual(last?.version)
    const mine = HandsResponse.parse(
      json(await w.editor.req('POST', `/api/boards/${w.boardId}/hand`, { raised: false })),
    )
    expect(mine.version).toEqual(handEvents(w).at(-1)?.version)
    expect(isNewerHands(state.handsVersion, mine.version)).toBe(true)
    expect(isNewerHands(mine.version, state.handsVersion)).toBe(false)
  })

  it(`hands go down after ${HAND_AUTO_LOWER_MS / 60_000} minutes for everyone`, async () => {
    w = await setupWorld()
    const base = await listen(w)
    const s = await openStream(w, base, w.viewer.cookie)
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true }), 200)
    w.clock.advance(HAND_AUTO_LOWER_MS - 1)
    let state = WorkshopState.parse(json(await w.owner.req('GET', `/api/boards/${w.boardId}/workshop`)))
    expect(state.hands).toHaveLength(1)
    w.clock.advance(1)
    state = WorkshopState.parse(json(await w.owner.req('GET', `/api/boards/${w.boardId}/workshop`)))
    expect(state.hands).toEqual([])
    const e = await s.waitFor(
      'workshop.hand',
      (d) => WorkshopHandEvent.parse(d).changes[0]?.reason === 'expired',
    )
    expect(WorkshopHandEvent.parse(e.data).hands).toEqual([])
    await s.close()
  })

  it('a hand goes down when its owner’s event stream disconnects (after the grace), not on a reload', async () => {
    w = await setupWorld()
    const base = await listen(w)
    const owner = await openStream(w, base, w.owner.cookie) // a facilitator watching the events
    let viewer = await openStream(w, base, w.viewer.cookie)
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true }), 200)

    // A reload: the stream ends and a new one opens within the grace. The hand stays.
    await viewer.close()
    w.clock.advance(HAND_DISCONNECT_GRACE_MS - 1)
    viewer = await openStream(w, base, w.viewer.cookie)
    w.clock.advance(HAND_DISCONNECT_GRACE_MS * 3)
    let state = WorkshopState.parse(json(await w.owner.req('GET', `/api/boards/${w.boardId}/workshop`)))
    expect(state.hands.map((h) => h.userId)).toEqual([w.viewer.userId])

    // The tab closes for good.
    await viewer.close()
    w.clock.advance(HAND_DISCONNECT_GRACE_MS - 1)
    state = WorkshopState.parse(json(await w.owner.req('GET', `/api/boards/${w.boardId}/workshop`)))
    expect(state.hands).toHaveLength(1)
    w.clock.advance(1)
    // No request needed: the periodic sweep lowers it and everyone still connected is told.
    const e = await owner.waitFor(
      'workshop.hand',
      (d) => WorkshopHandEvent.parse(d).changes[0]?.reason === 'disconnected',
    )
    expect(WorkshopHandEvent.parse(e.data)).toEqual({
      hands: [],
      changes: [
        {
          userId: w.viewer.userId,
          name: 'Vic Viewer',
          raised: false,
          reason: 'disconnected',
          byUserId: null,
          byName: null,
        },
      ],
      version: expect.objectContaining({ n: expect.any(Number) }),
    })
    state = WorkshopState.parse(json(await w.owner.req('GET', `/api/boards/${w.boardId}/workshop`)))
    expect(state.hands).toEqual([])
    await owner.close()
  })

  it('a hand raised without an open event stream (a script, a refused stream) goes down after the grace', async () => {
    w = await setupWorld()
    const base = await listen(w)
    // The viewer's cookie on a refused stream (a board they cannot see) is not "being here" either.
    const refused = await fetch(`${base}/api/boards/b-nosuchboard9/events`, {
      headers: { cookie: w.viewer.cookie },
    })
    expect(refused.status).toBe(404)
    await refused.body?.cancel()
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true }), 200)
    w.clock.advance(HAND_DISCONNECT_GRACE_MS)
    const state = WorkshopState.parse(json(await w.owner.req('GET', `/api/boards/${w.boardId}/workshop`)))
    expect(state.hands).toEqual([])
  })

  it('an archived board takes no new hands; lowering still works', async () => {
    w = await setupWorld()
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true }), 200)
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/archive`), 200)
    expectStatus(await w.editor.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true }), 403)
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/hand`, { raised: false }), 200)
    const state = WorkshopState.parse(json(await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`)))
    expect(state.hands).toEqual([])
  })
})
