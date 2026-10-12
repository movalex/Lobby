// Wave N.1 review (a guard, no bug today): the web's undo takes the confirmed row object as its baseline when the
// scene holds the same row (apps/web/src/canvas/history/controller.ts `adopt`, `applied.same`: the same id, version
// and versionNonce), which is right only while the room gives EVERY content write a new version. This holds the
// room to it on every merge write path (room/merge.ts): a create (a row of the room's own version and nonce, above a
// tombstone's), a patch that changes something (stored + 1; one that changes nothing is no write), a delete, and the
// server's own writes in a push (`bump`): the re-snap of an arrow whose target moved, the index fixes, and the
// repairs (a container's label, a deleted target's bindings, a deleted frame's children). After each push, every
// element whose content (all but version, versionNonce, updated) differs from before has a greater version and a new
// nonce. The web's side: apps/web/src/canvas/history/same-baseline.test.ts.
import { isDeepStrictEqual } from 'node:util'
import type { Op } from '@draftroom/canvas-schema/protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  bind,
  type El,
  editTarget,
  newArrow,
  newFrame,
  newRect,
  newText,
  type Scene,
  useServerTextMetrics,
} from '../room/arrows/support/excalidraw.ts'
import { patchOf, type Room, type TestClient } from '../room/arrows/support/room.ts'
import { freshBoard } from '../room/arrows/support/scenario.ts'

beforeAll(() => useServerTextMetrics())

const NOT_CONTENT = ['version', 'versionNonce', 'updated']
const contentOf = (e: El) => {
  const out = { ...e }
  for (const k of NOT_CONTENT) delete out[k]
  return out
}

/** Runs `push` and returns the ids whose content changed, and those of them without a new version and nonce. */
async function step(room: Room, push: () => Promise<unknown>) {
  const before = await room.stored()
  await push()
  const after = await room.stored()
  const changed: string[] = []
  const unbumped: string[] = []
  for (const [id, el] of after) {
    const prev = before.get(id)
    if (!prev) continue // a create: its own check below
    if (isDeepStrictEqual(contentOf(prev), contentOf(el))) continue
    changed.push(id)
    if (!(el.version > prev.version) || el.versionNonce === prev.versionNonce) unbumped.push(id)
  }
  return { before, after, changed: changed.sort(), unbumped }
}

/** A patch of `id` from this client's copy changed by `edit`. */
function patch(c: TestClient, id: string, edit: (local: Scene) => void): Op {
  const local = c.copy()
  edit(local)
  return patchOf(local.get(id), c.confirmed.get(id) as El)
}

describe('every content write the room makes has a new version (the web undo baseline’s premise)', () => {
  it('a create: a nonce of the room’s own (never the client’s copy); over a tombstone, a version above it', async () => {
    const room = await freshBoard('version create')
    const c = await room.client('ann')
    const R = newRect({ x: 0, y: 0, width: 100, height: 60 })
    const T = { ...newRect({ x: 300, y: 0, width: 100, height: 60 }), version: 7 }
    await c.create([R, T])
    const stored = await room.stored()
    // the stored row is never the client's copy by (version, versionNonce): the web's sameRow tells them apart
    for (const el of [R, T]) {
      expect((stored.get(el.id) as El).version).toBeGreaterThanOrEqual(1)
      expect((stored.get(el.id) as El).versionNonce).not.toBe(el.versionNonce)
    }
    // deleted, then created again with the same id (an undo of the delete): above the tombstone's version
    await c.push([patch(c, R.id, (s) => Object.assign(s.get(R.id), { isDeleted: true }))])
    const tomb = (await room.stored()).get(R.id) as El
    expect(tomb.isDeleted).toBe(true)
    const r = await step(room, () => c.create([{ ...R, x: 40, version: 1 }]))
    expect(r.changed).toEqual([R.id])
    expect((r.after.get(R.id) as El).version).toBeGreaterThan(tomb.version)
    expect(r.unbumped).toEqual([])
  })

  it('a patch: a content change gets stored + 1, a patch that changes nothing is no write', async () => {
    const room = await freshBoard('version patch')
    const c = await room.client('ann')
    const R = newRect({ x: 0, y: 0, width: 100, height: 60 })
    await c.create([R])
    for (const edit of [
      (el: El) => Object.assign(el, { x: 120, y: 30 }),
      (el: El) => Object.assign(el, { strokeColor: '#e03131', backgroundColor: '#ffc9c9' }),
      (el: El) => Object.assign(el, { width: 240, height: 90 }),
      (el: El) => Object.assign(el, { angle: 0.5 }),
      (el: El) => Object.assign(el, { link: 'https://example.com/a', locked: true }),
    ]) {
      const r = await step(room, () => c.push([patch(c, R.id, (s) => edit(s.get(R.id)))]))
      expect(r.changed).toEqual([R.id])
      expect(r.unbumped).toEqual([])
      expect((r.after.get(R.id) as El).version).toBe((r.before.get(R.id) as El).version + 1)
    }
    // the same values again: nothing written, the version stays
    const same = await step(room, () =>
      c.push([{ k: 'p', id: R.id, pv: (c.confirmed.get(R.id) as El).version, g: { pos: { x: 120 } } } as Op]),
    )
    expect(same.changed).toEqual([])
    expect((same.after.get(R.id) as El).version).toBe((same.before.get(R.id) as El).version)
  })

  it('a delete, and the repairs it makes: the label of a deleted container, a deleted target’s arrow', async () => {
    const room = await freshBoard('version delete')
    const c = await room.client('ann')
    const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
    const L = newText({ x: 50, y: 40, text: 'label', fontSize: 20, containerId: X.id })
    X.boundElements = [{ id: L.id, type: 'text' }]
    const Y = newRect({ x: 500, y: 0, width: 200, height: 100 })
    const A = {
      ...newArrow({ x: 205, y: 50 }),
      points: [
        [0, 0],
        [290, 0],
      ],
    }
    bind(A, X, Y)
    await c.create([X, L, Y, A])
    // the container goes: its label goes with it (the room's repair), the arrow's start binding is nulled
    const r = await step(room, () =>
      c.push([patch(c, X.id, (s) => Object.assign(s.get(X.id), { isDeleted: true }))]),
    )
    expect(r.changed).toEqual(expect.arrayContaining([X.id, L.id, A.id]))
    expect((r.after.get(L.id) as El).isDeleted).toBe(true)
    expect((r.after.get(A.id) as El).startBinding).toBeNull()
    expect(r.unbumped).toEqual([])
  })

  it('a deleted frame: its children’s frameId is cleared by the room, each with a new version', async () => {
    const room = await freshBoard('version frame')
    const c = await room.client('ann')
    const F = newFrame({ x: 0, y: 0, width: 600, height: 400 })
    const K = { ...newRect({ x: 50, y: 50, width: 100, height: 60 }), frameId: F.id }
    const M = { ...newRect({ x: 250, y: 50, width: 100, height: 60 }), frameId: F.id }
    await c.create([F, K, M])
    const r = await step(room, () =>
      c.push([patch(c, F.id, (s) => Object.assign(s.get(F.id), { isDeleted: true }))]),
    )
    expect(r.changed).toEqual([F.id, K.id, M.id].sort())
    expect((r.after.get(K.id) as El).frameId).toBeNull()
    expect(r.unbumped).toEqual([])
  })

  it('the room’s re-snap: a moved target’s bound arrow, which no op of the push wrote, gets a new version', async () => {
    const room = await freshBoard('version resnap')
    const c = await room.client('ann')
    const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
    const Y = newRect({ x: 500, y: 300, width: 200, height: 100 })
    const A = {
      ...newArrow({ x: 205, y: 50 }),
      points: [
        [0, 0],
        [290, 300],
      ],
    }
    bind(A, X, Y)
    await c.create([X, Y, A])
    // the target moves; the client pushes the target only (its arrow's follow is the room's to derive)
    const r = await step(room, () => c.push([patch(c, Y.id, (s) => editTarget(s, Y.id, { x: 700, y: 500 }))]))
    expect(r.changed).toEqual([A.id, Y.id].sort())
    expect(r.unbumped).toEqual([])
  })

  it('the room’s index fixes: a key another element holds, and a label left below its container', async () => {
    const room = await freshBoard('version index')
    const c = await room.client('ann')
    const P = newRect({ x: 0, y: 0, width: 100, height: 60 })
    const M = newRect({ x: 200, y: 0, width: 100, height: 60 })
    const Q = newRect({ x: 400, y: 0, width: 100, height: 60 })
    await c.create([P, M, Q])
    const held = (c.confirmed.get(P.id) as El).index
    const r = await step(room, () =>
      c.push([patch(c, Q.id, (s) => Object.assign(s.get(Q.id), { index: held }))]),
    )
    expect(r.changed).toEqual([Q.id])
    expect((r.after.get(Q.id) as El).index).not.toBe(held)
    expect(r.unbumped).toEqual([])
    // a container brought to the front over its label: the room re-keys the label (no op of the push wrote it)
    const X = newRect({ x: 0, y: 200, width: 200, height: 100 })
    const L = newText({ x: 50, y: 240, text: 'label', fontSize: 20, containerId: X.id })
    X.boundElements = [{ id: L.id, type: 'text' }]
    await c.create([X, L])
    const top = (await room.stored()).get(L.id) as El
    const s2 = await step(room, () =>
      c.push([patch(c, X.id, (s) => Object.assign(s.get(X.id), { index: `${top.index}V` }))]),
    )
    expect(s2.changed).toEqual([X.id, L.id].sort())
    expect((s2.after.get(L.id) as El).index > (s2.after.get(X.id) as El).index).toBe(true)
    expect(s2.unbumped).toEqual([])
  })
})
