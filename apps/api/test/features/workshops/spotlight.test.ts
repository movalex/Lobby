// Spotlight for everyone (wave L, L5-2): who may start and end it, the objects it names, the cooldown, the
// five-minute end, the end with its starter's last event stream, the state on GET /workshop, and the
// contract (a previous build's WorkshopState still parses with the new field).
import {
  isNewerSpotlight,
  SPOTLIGHT_MAX_MS,
  SpotlightState,
  WORKSHOP_EVENTS,
  WorkshopSpotlightEvent,
  WorkshopState,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { SPOTLIGHT_STARTER_GRACE_MS, SpotlightRegistry } from '../../../src/features/workshops/spotlight.ts'
import { guestLink, joinAsGuest, setupWorld as setupGuestWorld } from '../guests/support.ts'
import { listen, type OpenStream, openStream } from './streams.ts'
import { expectStatus, json, note, setupWorld, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.api.close()
})

const BOARD = 'b-board000001'
const ANN = { id: 'usr_aaaaaaaaaaaa', name: 'Ann' }
const BEN = { id: 'usr_bbbbbbbbbbbb', name: 'Ben' }

function registry(opts: { maxMs?: number; graceMs?: number } = {}) {
  let t = Date.parse('2026-10-09T10:00:00.000Z')
  const published: { boardId: string; event: WorkshopSpotlightEvent }[] = []
  const online = new Set<string>()
  const r = new SpotlightRegistry({
    now: () => new Date(t),
    publish: (boardId, event) => published.push({ boardId, event }),
    online: (boardId, userId) => online.has(`${boardId}/${userId}`),
    ...opts,
  })
  return {
    r,
    published,
    online,
    advance: (ms: number) => {
      t += ms
    },
  }
}
describe('spotlight registry (pure)', () => {
  it('starts one spotlight per board and replaces it; every change is a whole, versioned state', () => {
    const { r, published, online } = registry()
    online.add(`${BOARD}/${ANN.id}`)
    online.add(`${BOARD}/${BEN.id}`)
    const a = r.start(BOARD, ANN, { refs: ['shape:n1', 'shape:n2'], bringEveryone: false })
    expect(a).toMatchObject({
      refs: ['shape:n1', 'shape:n2'],
      bringEveryone: false,
      by: { userId: ANN.id, name: 'Ann' },
      startedAt: '2026-10-09T10:00:00.000Z',
      endsAt: new Date(Date.parse('2026-10-09T10:00:00.000Z') + SPOTLIGHT_MAX_MS).toISOString(),
    })
    const b = r.start(BOARD, BEN, { refs: ['shape:n3'], bringEveryone: true })
    expect(r.get(BOARD)).toEqual(b)
    expect(r.size()).toBe(1)
    // a replacement is not an end: the second event carries the new spotlight and no reason
    expect(published.map((p) => [p.event.spotlight?.by.name, p.event.reason])).toEqual([
      ['Ann', null],
      ['Ben', null],
    ])
    expect(a.version).not.toEqual(b.version)
    for (const p of published) WorkshopSpotlightEvent.parse(p.event)
    // a later state is never older than an earlier one
    expect(isNewerSpotlight(a.version, b.version)).toBe(true)
    expect(isNewerSpotlight(b.version, a.version)).toBe(false)
    expect(isNewerSpotlight({ epoch: 'other-process', n: 0 }, a.version)).toBe(true)
  })

  it('ends on request (idempotent, published once) and says who did it', () => {
    const { r, published, online } = registry()
    online.add(`${BOARD}/${ANN.id}`)
    r.start(BOARD, ANN, { refs: ['shape:n1'], bringEveryone: false })
    expect(r.end(BOARD, ANN, false)).toBe(true)
    expect(r.end(BOARD, ANN, false)).toBe(false)
    expect(r.get(BOARD)).toBeNull()
    expect(published).toHaveLength(2)
    expect(published[1]?.event).toMatchObject({
      spotlight: null,
      reason: 'ended',
      endedBy: { userId: ANN.id, name: 'Ann' },
    })
    r.start(BOARD, ANN, { refs: ['shape:n1'], bringEveryone: false })
    r.end(BOARD, BEN, true)
    expect(published.at(-1)?.event).toMatchObject({ reason: 'ended-by-owner', endedBy: { name: 'Ben' } })
  })

  it('ends by itself after the maximum time, for everyone, with no one asking', () => {
    const { r, published, online, advance } = registry()
    online.add(`${BOARD}/${ANN.id}`)
    r.start(BOARD, ANN, { refs: ['shape:n1'], bringEveryone: false })
    advance(SPOTLIGHT_MAX_MS - 1)
    r.sweep()
    expect(r.get(BOARD)).not.toBeNull()
    advance(1)
    r.sweep() // the sweeper's tick
    expect(r.get(BOARD)).toBeNull()
    expect(published.at(-1)?.event).toMatchObject({ spotlight: null, reason: 'expired', endedBy: null })
    expect(published).toHaveLength(2) // the later get() published nothing more
  })

  it('ends when its starter has had no event stream for the grace, not before (a reload keeps it)', () => {
    const { r, published, online, advance } = registry()
    online.add(`${BOARD}/${ANN.id}`)
    r.start(BOARD, ANN, { refs: ['shape:n1'], bringEveryone: false })
    online.delete(`${BOARD}/${ANN.id}`) // the tab closed
    advance(SPOTLIGHT_STARTER_GRACE_MS - 1)
    expect(r.get(BOARD)).not.toBeNull()
    online.add(`${BOARD}/${ANN.id}`) // the reload is back within the grace
    advance(60_000)
    expect(r.get(BOARD)).not.toBeNull()
    online.delete(`${BOARD}/${ANN.id}`) // and gone for good
    expect(r.get(BOARD)).not.toBeNull() // the grace starts when this was first seen
    advance(SPOTLIGHT_STARTER_GRACE_MS)
    expect(r.get(BOARD)).toBeNull()
    expect(published.at(-1)?.event).toMatchObject({ spotlight: null, reason: 'starter-left' })
  })

  it('one that starts with no stream at all (a script) ends after the same grace', () => {
    const { r, advance } = registry()
    r.start(BOARD, ANN, { refs: ['shape:n1'], bringEveryone: false })
    advance(SPOTLIGHT_STARTER_GRACE_MS - 1)
    expect(r.get(BOARD)).not.toBeNull()
    advance(1)
    expect(r.get(BOARD)).toBeNull()
  })
})

/** Shapes the fake sync holds, by element id. */
const seed = (world: World, ...ids: string[]) => world.sync.add(world.boardId, ...ids.map((id) => note(id)))

const url = (world: World, tail = '') => `/api/boards/${world.boardId}/spotlight${tail}`
const spotlightEvents = (world: World) =>
  world.events
    .filter((e) => e.type === WORKSHOP_EVENTS.spotlight)
    .map((e) => WorkshopSpotlightEvent.parse(e.data))

/** Keeps `client`'s event stream open (a facilitator's open tab), as a real board has. */
async function present(world: World, ...clients: { cookie: string }[]): Promise<OpenStream[]> {
  const base = await listen(world)
  return Promise.all(clients.map((c) => openStream(world, base, c.cookie)))
}

describe('POST /api/boards/:bid/spotlight', () => {
  it('a facilitator spotlights objects: everyone gets the whole state by event and on GET /workshop', async () => {
    w = await setupWorld()
    seed(w, 'a', 'b')
    await present(w, w.editor, w.viewer)
    const res = await w.editor.req('POST', url(w), {
      refs: ['shape:a', 'shape:b', 'shape:a'], // repeats are dropped
      bringEveryone: true,
      by: { userId: w.owner.userId, name: 'Someone else' }, // ignored: identity comes from the session
    })
    expectStatus(res, 200)
    const state = SpotlightState.parse(res.json())
    expect(state.spotlight).toMatchObject({
      refs: ['shape:a', 'shape:b'],
      bringEveryone: true,
      by: { userId: w.editor.userId, name: 'Ed Editor' },
    })
    const events = spotlightEvents(w)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ spotlight: state.spotlight, reason: null })
    // a viewer reads it with the workshop state (late joiners and reloads see it)
    const get = await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`)
    expectStatus(get, 200)
    const workshop = WorkshopState.parse(get.json())
    expect(workshop.spotlight).toEqual(state.spotlight)
    expect(workshop.spotlightVersion).toEqual(events[0]?.version)
  })

  it('refuses a viewer and a commenter (403), an outsider (404) and a visitor (401); nothing is published', async () => {
    w = await setupWorld()
    seed(w, 'a')
    const body = { refs: ['shape:a'] }
    expectStatus(await w.viewer.req('POST', url(w), body), 403)
    expectStatus(await w.commenter.req('POST', url(w), body), 403)
    expectStatus(await w.outsider.req('POST', url(w), body), 404)
    expectStatus(await w.api.anon('POST', url(w), body), 401)
    expect(spotlightEvents(w)).toHaveLength(0)
    expect(w.sync.snapshots).toBe(0) // refused people never cost a snapshot
  })

  it('refuses a name-only guest, even on a workshop link that made them an editor (403 GUEST_ACCOUNT_REQUIRED)', async () => {
    const g = await setupGuestWorld()
    try {
      const link = await guestLink(g.bob, g.board, { role: 'editor' })
      const sam = await joinAsGuest(g.api, link.url, 'Sam')
      for (const [path, body] of [
        [`/api/boards/${g.board}/spotlight`, { refs: ['shape:a'] }],
        [`/api/boards/${g.board}/spotlight/end`, {}],
      ] as const) {
        const res = await sam.req('POST', path, body)
        expect(res.statusCode, path).toBe(403)
        expect((res.json() as { error: { code: string } }).error.code).toBe('GUEST_ACCOUNT_REQUIRED')
      }
    } finally {
      await g.api.close()
    }
  })

  it('answers 400 for no objects, too many, a malformed ref, and objects that are not on the board (or deleted)', async () => {
    w = await setupWorld()
    seed(w, 'a', 'b')
    await present(w, w.editor)
    for (const refs of [
      [],
      ['nope'],
      ['shape:a', 'shape:has space'],
      Array.from({ length: 201 }, (_, i) => `shape:n${i}`),
    ])
      expectStatus(await w.editor.req('POST', url(w), { refs }), 400)
    expectStatus(await w.editor.req('POST', url(w), {}), 400)
    const unknown = await w.editor.req('POST', url(w), { refs: ['shape:a', 'shape:ghost'] })
    expectStatus(unknown, 400)
    expect(unknown.body).toMatch(/not on this board/)
    // a deleted object is gone from the canvas authority's snapshot
    w.sync.boards.get(w.boardId)?.delete('shape:b')
    w.clock.advance(1) // the shape index runs on the app clock: a frozen one would reuse the snapshot just read
    expectStatus(await w.editor.req('POST', url(w), { refs: ['shape:b'] }), 400)
    // none of those cost a cooldown: a good start right away works
    expectStatus(await w.editor.req('POST', url(w), { refs: ['shape:a'] }), 200)
    expect(spotlightEvents(w)).toHaveLength(1)
  })

  it('answers 503 when the board cannot be asked (never a spotlight on objects nobody could check)', async () => {
    w = await setupWorld()
    seed(w, 'a')
    w.sync.down = true
    const res = await w.editor.req('POST', url(w), { refs: ['shape:a'] })
    expectStatus(res, 503)
    expect(spotlightEvents(w)).toHaveLength(0)
  })

  it('has a cooldown per person and board: 429 with Retry-After; another facilitator is not held back', async () => {
    w = await setupWorld()
    seed(w, 'a')
    await present(w, w.editor, w.owner)
    const body = { refs: ['shape:a'] }
    expectStatus(await w.editor.req('POST', url(w), body), 200)
    const again = await w.editor.req('POST', url(w), body)
    expectStatus(again, 429)
    expect(Number(again.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expect(json<{ error: { code: string } }>(again).error.code).toBe('RATE_LIMITED')
    // the owner starts theirs at once (and replaces Ed's: one spotlight per board)
    expectStatus(await w.owner.req('POST', url(w), body), 200)
    w.clock.advance(3_000)
    expectStatus(await w.editor.req('POST', url(w), body), 200)
    expect(spotlightEvents(w).map((e) => e.spotlight?.by.name)).toEqual([
      'Ed Editor',
      'Ada Owner',
      'Ed Editor',
    ])
  })

  it('ends by itself after five minutes, for everyone, on the fake clock', async () => {
    w = await setupWorld()
    seed(w, 'a')
    await present(w, w.editor, w.viewer)
    expectStatus(await w.editor.req('POST', url(w), { refs: ['shape:a'] }), 200)
    w.clock.advance(SPOTLIGHT_MAX_MS - 1_000)
    const before = WorkshopState.parse(
      (await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`)).json(),
    )
    expect(before.spotlight).not.toBeNull()
    w.clock.advance(1_000)
    const after = WorkshopState.parse((await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`)).json())
    expect(after.spotlight).toBeNull()
    expect(isNewerSpotlight(before.spotlightVersion ?? null, after.spotlightVersion ?? null)).toBe(true)
    const events = spotlightEvents(w)
    expect(events.at(-1)).toMatchObject({ spotlight: null, reason: 'expired' })
  })

  it('ends when its starter’s last event stream closes (after the grace); a second tab keeps it', async () => {
    w = await setupWorld()
    seed(w, 'a')
    const base = await listen(w)
    const tab1 = await openStream(w, base, w.editor.cookie)
    const tab2 = await openStream(w, base, w.editor.cookie)
    expectStatus(await w.editor.req('POST', url(w), { refs: ['shape:a'] }), 200)
    await tab1.close()
    w.clock.advance(SPOTLIGHT_STARTER_GRACE_MS + 1_000)
    const get = () => w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`)
    expect(WorkshopState.parse((await get()).json()).spotlight).not.toBeNull() // the other tab is still here
    await tab2.close()
    expect(WorkshopState.parse((await get()).json()).spotlight).not.toBeNull() // the grace has not run out
    w.clock.advance(SPOTLIGHT_STARTER_GRACE_MS + 1_000)
    expect(WorkshopState.parse((await get()).json()).spotlight).toBeNull()
    expect(spotlightEvents(w).at(-1)).toMatchObject({
      spotlight: null,
      reason: 'starter-left',
      endedBy: null,
    })
  })
})

describe('POST /api/boards/:bid/spotlight/end', () => {
  it('the starter ends their own; a board owner ends someone else’s; others cannot', async () => {
    w = await setupWorld()
    seed(w, 'a')
    await present(w, w.editor)
    const body = { refs: ['shape:a'] }
    expectStatus(await w.editor.req('POST', url(w), body), 200)

    // a viewer, a commenter and an outsider are refused; the spotlight stays
    expectStatus(await w.viewer.req('POST', url(w, '/end'), {}), 403)
    expectStatus(await w.commenter.req('POST', url(w, '/end'), {}), 403)
    expectStatus(await w.outsider.req('POST', url(w, '/end'), {}), 404)
    expectStatus(await w.api.anon('POST', url(w, '/end'), {}), 401)
    expect(spotlightEvents(w)).toHaveLength(1)

    // the owner (a board owner through the workspace) ends Ed's
    const owner = await w.owner.req('POST', url(w, '/end'), {})
    expectStatus(owner, 200)
    expect(SpotlightState.parse(owner.json()).spotlight).toBeNull()
    expect(spotlightEvents(w).at(-1)).toMatchObject({
      spotlight: null,
      reason: 'ended-by-owner',
      endedBy: { name: 'Ada Owner' },
    })

    // the starter ends their own; ending it again is not an error and publishes nothing
    w.clock.advance(3_000)
    expectStatus(await w.editor.req('POST', url(w), body), 200)
    expectStatus(await w.editor.req('POST', url(w, '/end'), {}), 200)
    expect(spotlightEvents(w).at(-1)).toMatchObject({ spotlight: null, reason: 'ended' })
    const n = spotlightEvents(w).length
    expectStatus(await w.editor.req('POST', url(w, '/end'), {}), 200)
    expect(spotlightEvents(w)).toHaveLength(n)
  })

  it('another facilitator who is not an owner cannot end it (403), and a viewer can ask when none runs (200, nothing happens)', async () => {
    w = await setupWorld()
    seed(w, 'a')
    await present(w, w.owner)
    expectStatus(await w.owner.req('POST', url(w), { refs: ['shape:a'] }), 200)
    // Ed is an editor: not the starter, not an owner
    expectStatus(await w.editor.req('POST', url(w, '/end'), {}), 403)
    expect(
      WorkshopState.parse((await w.editor.req('GET', `/api/boards/${w.boardId}/workshop`)).json()).spotlight,
    ).not.toBeNull()
    expectStatus(await w.owner.req('POST', url(w, '/end'), {}), 200)
    const none = await w.viewer.req('POST', url(w, '/end'), {})
    expectStatus(none, 200)
    expect(SpotlightState.parse(none.json()).spotlight).toBeNull()
  })
})

describe('the contract', () => {
  it('parses a previous build’s WorkshopState (no spotlight), and a previous build’s parse strips the new fields', async () => {
    w = await setupWorld()
    seed(w, 'a')
    await present(w, w.editor)
    expectStatus(await w.editor.req('POST', url(w), { refs: ['shape:a'] }), 200)
    const wire = (await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`)).json() as Record<
      string,
      unknown
    >
    expect(wire.spotlight).toBeTruthy()

    // the schema as wave K shipped it: not strict, so it drops what it does not know
    const { z } = await import('zod')
    const previous = z.object({
      timer: z.unknown().nullable(),
      vote: z.unknown().nullable(),
      hands: z.array(z.unknown()).default([]),
      handsVersion: z.unknown().nullable().default(null),
      serverNow: z.string(),
    })
    const old = previous.parse(wire)
    expect(old).not.toHaveProperty('spotlight')
    expect(old).not.toHaveProperty('spotlightVersion')

    // and the new schema reads an answer without the fields (an api from before wave L)
    const { spotlight: _s, spotlightVersion: _v, ...before } = wire
    const parsed = WorkshopState.parse(before)
    expect(parsed.spotlight).toBeUndefined()
    expect(parsed.spotlightVersion).toBeUndefined()
    // and a null spotlight (none running)
    expect(WorkshopState.parse({ ...before, spotlight: null, spotlightVersion: null }).spotlight).toBeNull()
  })

  it('carries only object refs and a name already on the board (no ballot, no private text)', async () => {
    w = await setupWorld()
    seed(w, 'a')
    await present(w, w.editor)
    const res = await w.editor.req('POST', url(w), { refs: ['shape:a'], bringEveryone: false })
    const keys = Object.keys(json<{ spotlight: object }>(res).spotlight).sort()
    expect(keys).toEqual(['bringEveryone', 'by', 'endsAt', 'refs', 'startedAt', 'version'])
  })
})
