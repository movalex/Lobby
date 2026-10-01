// Spike B, O5: voting against the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §1 A2, §2.4.6, §4.4).
// - A2's push: every change of "is a dot vote open" reaches sync after it commits (start, close,
//   reveal, extend, and a timed vote's end, which has no request of its own);
// - eligibility reads the engine's `lobby-elements` snapshot (sync-internal.ts LobbyElementsSnapshot):
//   elements are `shape:<id>` refs, bound labels are not objects, frames parent their children.

import type { WorkshopStateBody } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { shapesFromSnapshot, voteTypeOfElement } from '../../../src/features/workshops/shapes.ts'
import { createWorkshopStatePusher } from '../../../src/features/workshops/workshop-state.ts'
import { SyncUnavailable } from '../../../src/sync-internal.ts'
import type { Client } from '../../helpers.ts'
import { expectStatus, FakeSync, json, setupWorld, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.api.close()
})

/** Records every A2 push; its snapshot can be the engine's `lobby-elements` envelope. */
class EngineSync extends FakeSync {
  readonly pushes: { boardId: string; body: WorkshopStateBody }[] = []
  elements = new Map<string, Record<string, unknown>[]>()
  async workshopState(boardId: string, body: WorkshopStateBody): Promise<void> {
    this.pushes.push({ boardId, body })
  }
  override async snapshot(boardId: string) {
    const els = this.elements.get(boardId)
    if (!els) return super.snapshot(boardId)
    this.snapshots++
    return {
      format: 'lobby-elements',
      schema: 1,
      clock: 7,
      elements: els,
      doc: {},
    } as unknown as Awaited<ReturnType<FakeSync['snapshot']>>
  }
}

async function engineWorld() {
  w = await setupWorld()
  const sync = new EngineSync()
  // setupWorld's api holds its own FakeSync; swap the instance's behaviour in place (same object).
  Object.setPrototypeOf(w.sync, EngineSync.prototype)
  Object.assign(w.sync, { pushes: sync.pushes, elements: sync.elements })
  return w.sync as unknown as EngineSync
}

const el = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  isDeleted: false,
  frameId: null,
  ...extra,
})

async function startVote(c: Client, body: Record<string, unknown> = {}) {
  const res = await c.req('POST', `/api/boards/${w.boardId}/votes`, {
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
    ...body,
  })
  expectStatus(res, 201)
  return json<{ session: { id: string } }>(res).session.id
}
/** Pushes are fire-and-forget: wait until `n` arrived. */
async function pushes(sync: EngineSync, n: number) {
  for (let i = 0; i < 200 && sync.pushes.length < n; i++) await new Promise((r) => setTimeout(r, 5))
  return sync.pushes.map((p) => p.body)
}

describe('A2 push: the api tells sync on every change', () => {
  it('start, close, a new start, reveal, extend', async () => {
    const sync = await engineWorld()
    const open = { voteOpen: true, anonymous: true }
    const shut = { voteOpen: false, anonymous: false }
    const vid = await startVote(w.owner)
    expect(await pushes(sync, 1)).toEqual([open])
    expect(sync.pushes[0]?.boardId).toBe(w.boardId)
    expectStatus(await w.owner.req('POST', `/api/votes/${vid}/close`), 200)
    expect(await pushes(sync, 2)).toEqual([open, shut])
    // Closing again changes nothing, so nothing is pushed.
    expectStatus(await w.owner.req('POST', `/api/votes/${vid}/close`), 200)
    const vid2 = await startVote(w.owner, { durationMs: 5 * 60_000 })
    expect(await pushes(sync, 3)).toEqual([open, shut, open])
    expectStatus(await w.owner.req('POST', `/api/votes/${vid2}/extend`, { addMs: 60_000 }), 200)
    expect(await pushes(sync, 4)).toEqual([open, shut, open, open])
    expectStatus(await w.owner.req('POST', `/api/votes/${vid2}/reveal`), 200)
    expect(await pushes(sync, 5)).toEqual([open, shut, open, open, shut])
    await new Promise((r) => setTimeout(r, 30))
    expect(sync.pushes).toHaveLength(5)
  })

  it('a refused start pushes nothing (only committed changes are told)', async () => {
    const sync = await engineWorld()
    expect(
      (
        await w.viewer.req('POST', `/api/boards/${w.boardId}/votes`, {
          votesPerPerson: 3,
          onePerObject: false,
          scope: 'board',
        })
      ).statusCode,
    ).toBe(403)
    await new Promise((r) => setTimeout(r, 30))
    expect(sync.pushes).toEqual([])
  })
})

describe('A2 push: the pusher itself', () => {
  it("arms a timer at a timed vote's end that re-reads and pushes; a re-arm replaces it; close clears it", async () => {
    w = await setupWorld()
    const sent: WorkshopStateBody[] = []
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const pusher = createWorkshopStatePusher({
      db: w.api.db,
      sync: {
        ...w.sync,
        snapshot: w.sync.snapshot.bind(w.sync),
        seed: w.sync.seed,
        workshopState: async (_b, body) => void sent.push(body),
      },
      now: w.clock.now,
      log: { debug() {}, warn() {} },
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false }
        timers.push(t)
        return t
      },
      clearTimer: (h) => {
        ;(h as { cleared: boolean }).cleared = true
      },
    })
    const vid = await startVote(w.owner, { durationMs: 2 * 60_000 })
    void vid
    pusher.changed(w.boardId)
    await pusher.drain()
    expect(sent).toEqual([{ voteOpen: true, anonymous: true }])
    expect(timers).toHaveLength(1)
    expect(timers[0]?.ms).toBe(2 * 60_000 + 50)
    // Re-arm (an extend): the first timer is cleared.
    pusher.changed(w.boardId)
    await pusher.drain()
    expect(timers[0]?.cleared).toBe(true)
    expect(timers).toHaveLength(2)
    // The end passes; the timer fires: the vote reads closed and that is pushed, with no new timer.
    w.clock.advance(2 * 60_000 + 100)
    timers[1]?.fn()
    await pusher.drain()
    expect(sent.at(-1)).toEqual({ voteOpen: false, anonymous: false })
    expect(timers).toHaveLength(2)
    // After close, nothing more is armed or sent.
    pusher.close()
    pusher.changed(w.boardId)
    await pusher.drain()
    expect(sent).toHaveLength(3)
  })

  it('never throws: sync down, sync without the route (404), the database failing', async () => {
    w = await setupWorld()
    const logs: string[] = []
    const make = (fail: () => never) =>
      createWorkshopStatePusher({
        db: w.api.db,
        sync: {
          snapshot: w.sync.snapshot.bind(w.sync),
          seed: w.sync.seed,
          workshopState: async () => fail(),
        },
        now: w.clock.now,
        log: { debug: (_o, m) => void logs.push(`debug ${m}`), warn: (_o, m) => void logs.push(`warn ${m}`) },
      })
    const notFound = make(() => {
      throw new SyncUnavailable('workshop-state failed with 404', 404)
    })
    notFound.changed(w.boardId)
    await notFound.drain()
    const down = make(() => {
      throw new SyncUnavailable('sync unreachable: TypeError')
    })
    down.changed(w.boardId)
    await down.drain()
    expect(logs).toEqual(['debug sync has no workshop-state route', 'warn sync workshop-state not delivered'])
    notFound.close()
    down.close()
  })
})

describe('eligibility on the lobby-elements snapshot', () => {
  it('maps element types to the vote vocabulary; bound labels are not objects', () => {
    expect(voteTypeOfElement(el('n', 'stickynote'))).toBe('note')
    expect(voteTypeOfElement(el('r', 'rectangle'))).toBe('geo')
    expect(voteTypeOfElement(el('d', 'diamond'))).toBe('geo')
    expect(voteTypeOfElement(el('t', 'text'))).toBe('text')
    expect(voteTypeOfElement(el('l', 'text', { containerId: 'n' }))).toBeNull()
    expect(voteTypeOfElement(el('f', 'freedraw'))).toBe('draw')
    expect(voteTypeOfElement(el('h', 'freedraw', { customData: { lobby: { kind: 'highlight' } } }))).toBe(
      'highlight',
    )
    expect(voteTypeOfElement(el('a', 'arrow'))).toBe('arrow')
    expect(voteTypeOfElement(el('i', 'image'))).toBe('image')
    expect(voteTypeOfElement(el('F', 'frame'))).toBe('frame')
    expect(voteTypeOfElement(el('x', 'embeddable'))).toBeNull()
    const map = shapesFromSnapshot({
      format: 'lobby-elements',
      schema: 1,
      clock: 1,
      elements: [
        el('F', 'frame'),
        el('n1', 'stickynote', { frameId: 'F' }),
        el('n1-label', 'text', { containerId: 'n1', frameId: 'F' }),
        el('gone', 'stickynote', { isDeleted: true }),
        el('bad id!', 'stickynote'),
      ],
      doc: {},
    })
    expect([...map.keys()].sort()).toEqual(['shape:F', 'shape:n1'])
    expect(map.get('shape:n1')).toEqual({ id: 'shape:n1', type: 'note', parentId: 'shape:F' })
    expect(map.get('shape:F')?.parentId).toBe('page:page')
  })

  it('casts on a note, refuses a bound label, an arrow and a deleted note; frame scope follows frameId', async () => {
    const sync = await engineWorld()
    sync.elements.set(w.boardId, [
      el('F', 'frame'),
      el('inF', 'stickynote', { frameId: 'F' }),
      el('inF-label', 'text', { containerId: 'inF', frameId: 'F' }),
      el('out', 'stickynote'),
      el('arr', 'arrow'),
      el('gone', 'stickynote', { isDeleted: true }),
    ])
    const vid = await startVote(w.owner)
    const cast = (shapeId: string) => w.editor.req('POST', `/api/votes/${vid}/cast`, { shapeId, delta: 1 })
    expectStatus(await cast('shape:inF'), 200)
    expectStatus(await cast('shape:out'), 200)
    expect((await cast('shape:inF-label')).statusCode).toBe(400)
    expect((await cast('shape:arr')).statusCode).toBe(400)
    expect((await cast('shape:gone')).statusCode).toBe(400)
    expectStatus(await w.owner.req('POST', `/api/votes/${vid}/close`), 200)
    const framed = await startVote(w.owner, { scope: 'frame', frameId: 'shape:F' })
    const castF = (shapeId: string) =>
      w.editor.req('POST', `/api/votes/${framed}/cast`, { shapeId, delta: 1 })
    expectStatus(await castF('shape:inF'), 200)
    expect((await castF('shape:out')).statusCode).toBe(400)
  })
})
