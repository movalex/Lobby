// §6.2 "Bound arrows" (spike subset) through the real server process and raw clients (the C0 arrow
// acceptance tests run the recheck's scenarios in-process with Excalidraw's own client copies; these run
// the rule-7 server behaviour over the wire): when a re-snap happens, `derived` rows and `fix`, labels,
// clocks (gclock.fit only), locked arrows, a deleted target, "equal after rounding writes nothing", and the
// barrier race of a free-end write against a target resize in both orders, 20 times each. Geometry within
// GEOMETRY_TOLERANCE_PX.

import { boundEndsOffEdge, pointAtIndexGlobal } from '@draftroom/canvas-schema/engine'
import { hashElements } from '@draftroom/canvas-schema/hash'
import { GEOMETRY_TOLERANCE_PX as TOL } from '@draftroom/canvas-schema/limits'
import { describe, expect, it } from 'vitest'
import type { RawClient } from './support/client.ts'
import { arrow, bindArrow, type El, label, pathUnit, rect, text } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const pv = (c: RawClient, id: string) => c.confirmed.get(id)?.version ?? 1
const scene = (a: El, i: number): [number, number] => pointAtIndexGlobal(a as never, i)
const dist = (p: number[], q: number[]) =>
  Math.max(Math.abs((p[0] ?? 0) - (q[0] ?? 0)), Math.abs((p[1] ?? 0) - (q[1] ?? 0)))
const byId = (els: readonly El[]) => new Map(els.map((e) => [e.id as string, e]))
const offEdge = (els: readonly El[], id: string) => {
  const m = byId(els)
  return boundEndsOffEdge(m.get(id) as never, m as never)
}

/** X (the start target) and a start-bound arrow with a free end at scene (505, 350). */
function startBoundSetup() {
  const X = rect('X', { x: 0, y: 0, width: 200, height: 100 })
  const A = arrow('A', {
    x: 205,
    y: 50,
    width: 300,
    height: 300,
    points: [
      [0, 0],
      [300, 300],
    ],
  })
  bindArrow(A, X, null, [1, 0.5])
  return { X, A }
}
/** The free end dragged to scene `to` on an unrotated copy: point 1 local = to − (x, y). */
function dragFree(a: El, to: [number, number]): El {
  const c = JSON.parse(JSON.stringify(a))
  c.points = [c.points[0], [to[0] - c.x, to[1] - c.y]]
  c.width = Math.abs(c.points[1][0])
  c.height = Math.abs(c.points[1][1])
  return c
}

describe('rule 7 over the wire', () => {
  it("B's resize: B pushes only X; the ack's derived row carries the arrow's re-snap; everyone sees it in the same frame", async () => {
    const st = await h.stack()
    const b = newBoardId()
    const s = await st.client({ boardId: b, user: 'setup' })
    const { X, A } = startBoundSetup()
    await s.create([X, A])
    const bob = await st.client({ boardId: b, user: 'bob' })
    const c = await st.client({ boardId: b, user: 'carol' })
    const free0 = scene(bob.confirmed.get('A'), -1)
    const ack = await bob.push([{ k: 'p', id: 'X', pv: pv(bob, 'X'), g: { shape: { height: 180 } } }])
    expect(ack.r[0]).toMatchObject({ ok: true })
    expect(ack.derived?.map((d) => d.id)).toEqual(['A'])
    expect(Object.keys(ack.derived?.[0]?.fix ?? {}).sort()).toEqual([
      'angle',
      'elbowed',
      'height',
      'points',
      'width',
      'x',
      'y',
    ])
    await c.untilClock(ack.clock)
    const frame = c.of('changes').at(-1)
    expect(frame?.ops.map((o) => (o.k === 'p' ? o.id : o.el.id)).sort()).toEqual(['A', 'X'])
    const snap = await st.snapshot(b)
    expect(offEdge(snap.elements, 'A')).toBeLessThanOrEqual(TOL)
    expect(dist(scene(byId(snap.elements).get('A') as El, -1), free0)).toBeLessThanOrEqual(TOL)
    expect(await c.hash()).toBe(await hashElements(snap.elements))
  })

  for (const order of ['C-then-B', 'B-then-C'] as const)
    it(`case a/b (${order}): C's free end survives B's resize; the start lands on X's new edge`, async () => {
      const st = await h.stack()
      const b = newBoardId()
      const s = await st.client({ boardId: b, user: 'setup' })
      const { X, A } = startBoundSetup()
      await s.create([X, A])
      const bob = await st.client({ boardId: b, user: 'bob' })
      const c = await st.client({ boardId: b, user: 'carol' })
      const drop: [number, number] = [605, 400]
      const cArrow = dragFree(c.confirmed.get('A'), drop)
      const opC = { k: 'p', id: 'A', pv: pv(c, 'A'), g: { path: pathUnit(cArrow) } }
      const opB = { k: 'p', id: 'X', pv: pv(bob, 'X'), g: { shape: { height: 180 } } }
      const [bc, bb] = [c.clock, bob.clock]
      if (order === 'C-then-B') {
        const ackC = await c.push([opC], { base: bc })
        expect(ackC.r[0]).toMatchObject({ ok: true })
        await bob.push([opB], { base: bb })
      } else {
        await bob.push([opB], { base: bb })
        const ackC = await c.push([opC], { base: bc })
        // C's push wrote the arrow: its re-snapped ends come back as `fix` (the whole unit)
        expect(Object.keys((ackC.r[0] as { fix?: object }).fix ?? {}).sort()).toEqual([
          'angle',
          'elbowed',
          'height',
          'points',
          'width',
          'x',
          'y',
        ])
      }
      const snap = await st.snapshot(b)
      const a = byId(snap.elements).get('A') as El
      expect(dist(scene(a, -1), drop)).toBeLessThanOrEqual(TOL)
      expect(offEdge(snap.elements, 'A')).toBeLessThanOrEqual(TOL)
      expect(
        a.points
          .flat()
          .every(
            (v: number) => Math.round(v * 100) === v * 100 || Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
          ),
      ).toBe(true)
    })

  it('the barrier race, 20 times in each order: the free end is where C dropped it, every client agrees', async () => {
    const st = await h.stack()
    for (const order of ['C-first', 'B-first'] as const)
      for (let i = 0; i < 20; i++) {
        const b = newBoardId()
        const s = await st.client({ boardId: b, user: 'setup' })
        const { X, A } = startBoundSetup()
        await s.create([X, A])
        const bob = await st.client({ boardId: b, user: 'bob' })
        const c = await st.client({ boardId: b, user: 'carol' })
        const drop: [number, number] = [600 + i, 380 + i]
        const opC = {
          k: 'p',
          id: 'A',
          pv: pv(c, 'A'),
          g: { path: pathUnit(dragFree(c.confirmed.get('A'), drop)) },
        }
        const opB = {
          k: 'p',
          id: 'X',
          pv: pv(bob, 'X'),
          g: { shape: { height: 120 + i * 3, width: 200 + i } },
        }
        // released together (same tick), in both send orders
        const sends =
          order === 'C-first'
            ? [c.pushNow([opC]), bob.pushNow([opB])]
            : [bob.pushNow([opB]), c.pushNow([opC])]
        const acks = await Promise.all(sends.map((x) => x.ack))
        expect(acks.every((k) => k.r[0]?.ok)).toBe(true)
        const snap = await st.snapshot(b)
        await Promise.all([s, bob, c].map((x) => x.untilClock(snap.clock)))
        const a = byId(snap.elements).get('A') as El
        expect(dist(scene(a, -1), drop)).toBeLessThanOrEqual(TOL)
        expect(offEdge(snap.elements, 'A')).toBeLessThanOrEqual(TOL)
        const digest = await hashElements(snap.elements)
        for (const x of [s, bob, c]) expect(await x.hash()).toBe(digest)
        for (const x of [s, bob, c]) x.close()
      }
  })

  it("B's push that also wrote the arrow (a selection move): the re-snap comes back as fix on it, not as derived", async () => {
    const st = await h.stack()
    const b = newBoardId()
    const s = await st.client({ boardId: b, user: 'setup' })
    const { X, A } = startBoundSetup()
    await s.create([X, A])
    const bob = await st.client({ boardId: b, user: 'bob' })
    const moved = JSON.parse(JSON.stringify(bob.confirmed.get('A')))
    moved.x += 50
    moved.y += 20
    const ack = await bob.push([
      { k: 'p', id: 'X', pv: pv(bob, 'X'), g: { pos: { x: 50, y: 20 } } },
      { k: 'p', id: 'A', pv: pv(bob, 'A'), g: { path: pathUnit(moved) } },
    ])
    expect(ack.derived ?? []).toEqual([])
    expect(offEdge((await st.snapshot(b)).elements, 'A')).toBeLessThanOrEqual(TOL)
  })

  it('a free text: an applied layout write (typing) re-snaps the arrow bound to it', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const s = await st.client({ boardId: b, user: 'setup' })
    const T = text('T', { x: 0, y: 0, width: 60, height: 25 })
    const A = arrow('A', {
      x: 65,
      y: 12.5,
      points: [
        [0, 0],
        [300, 200],
      ],
      width: 300,
      height: 200,
    })
    bindArrow(A, T, null, [1, 0.5])
    await s.create([T, A])
    const typist = await st.client({ boardId: b, user: 'typist' })
    expect((await typist.acquire('T')).type).toBe('lease.grant')
    const ack = await typist.push([
      {
        k: 'p',
        id: 'T',
        pv: pv(typist, 'T'),
        g: { text: { originalText: 'hello there' }, layout: { text: 'hello there', width: 140, height: 25 } },
      },
    ])
    expect(ack.derived?.map((d) => d.id)).toEqual(['A'])
    const snap = await st.snapshot(b)
    expect(offEdge(snap.elements, 'A')).toBeLessThanOrEqual(TOL)
    expect(scene(byId(snap.elements).get('A') as El, 0)[0]).toBeGreaterThan(140)
  })

  it('labels: an unleased arrow label gets a derived layout write; a leased one only its position', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const s = await st.client({ boardId: b, user: 'setup' })
    const X = rect('X', { x: 0, y: 0, width: 200, height: 100 })
    const Y = rect('Y', { x: 600, y: 300, width: 200, height: 100 })
    const A = arrow('A', {
      x: 205,
      y: 50,
      points: [
        [0, 0],
        [390, 300],
      ],
      width: 390,
      height: 300,
    })
    bindArrow(A, X, Y)
    const L = label('L', 'A', { text: 'label', originalText: 'label', width: 50, height: 25 })
    A.boundElements = [...(A.boundElements ?? []), { id: 'L', type: 'text' }]
    await s.create([X, Y, A, L])
    const bob = await st.client({ boardId: b, user: 'bob' })
    const l0 = byId((await st.snapshot(b)).elements).get('L') as El
    const ack = await bob.push([{ k: 'p', id: 'Y', pv: pv(bob, 'Y'), g: { pos: { x: 700, y: 500 } } }])
    expect(ack.derived?.map((d) => d.id).sort()).toEqual(['A', 'L'])
    const l1 = byId((await st.snapshot(b)).elements).get('L') as El
    expect(Math.abs(l1.x - l0.x) + Math.abs(l1.y - l0.y)).toBeGreaterThan(10)
    // someone types in the label (holds the arrow's lease): the server moves it but keeps its words and box
    const typist = await st.client({ boardId: b, user: 'typist' })
    expect((await typist.acquire('A')).type).toBe('lease.grant')
    await typist.push([
      {
        k: 'p',
        id: 'L',
        pv: pv(typist, 'L'),
        g: {
          text: { originalText: 'a much longer label now' },
          layout: { text: 'a much longer label now', width: 55 },
        },
      },
    ])
    await bob.untilClock(typist.clock)
    const before = byId((await st.snapshot(b)).elements).get('L') as El
    await bob.push([{ k: 'p', id: 'Y', pv: pv(bob, 'Y'), g: { pos: { x: 800, y: 600 } } }])
    const after = byId((await st.snapshot(b)).elements).get('L') as El
    expect({
      text: after.text,
      width: after.width,
      height: after.height,
      originalText: after.originalText,
    }).toEqual({
      text: before.text,
      width: before.width,
      height: before.height,
      originalText: before.originalText,
    })
    expect(after.x !== before.x || after.y !== before.y).toBe(true)
  })

  it('re-snaps advance gclock.fit only: an 11-minute-old replay of the arrow is not STALE; a locked arrow follows', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const s = await st.client({ boardId: b, user: 'setup' })
    const { X, A } = startBoundSetup()
    A.locked = true
    await s.create([X, A])
    const c = await st.client({ boardId: b, user: 'carol' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    const base = c.clock
    const stale = {
      k: 'p',
      id: 'A',
      pv: pv(c, 'A'),
      g: { style: { strokeColor: '#e03131' } },
      off: 11 * 60_000,
    }
    await bob.push([{ k: 'p', id: 'X', pv: pv(bob, 'X'), g: { shape: { height: 170 } } }])
    const snap1 = await st.snapshot(b)
    expect(offEdge(snap1.elements, 'A')).toBeLessThanOrEqual(TOL) // the locked arrow followed
    // unlock first (the only write a locked element takes besides z and bound), then the old replay
    await c.untilClock(snap1.clock)
    await c.push([{ k: 'p', id: 'A', pv: pv(c, 'A'), g: { meta: { locked: false } } }])
    const replay = await c.push([stale], { base })
    expect(replay.r[0]).toMatchObject({ ok: true })
  })

  it('a deleted target nulls the binding; that end stays where it is', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const s = await st.client({ boardId: b, user: 'setup' })
    const { X, A } = startBoundSetup()
    await s.create([X, A])
    const start = scene(s.confirmed.get('A'), 0)
    const ack = await s.push([{ k: 'p', id: 'X', pv: pv(s, 'X'), g: { life: { isDeleted: true } } }])
    expect(ack.r[0]).toMatchObject({ ok: true })
    const a = byId((await st.snapshot(b)).elements).get('A') as El
    expect(a.startBinding).toBeNull()
    expect(dist(scene(a, 0), start)).toBeLessThanOrEqual(TOL)
  })

  it('a target write that changes no geometry (a recolour), or a dropped fit, re-snaps nothing', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const s = await st.client({ boardId: b, user: 'setup' })
    const { X, A } = startBoundSetup()
    await s.create([X, A])
    const v0 = byId((await st.snapshot(b)).elements).get('A')?.version
    const ack = await s.push([
      { k: 'p', id: 'X', pv: pv(s, 'X'), g: { style: { backgroundColor: '#ffec99' } } },
      { k: 'p', id: 'X', pv: pv(s, 'X'), fit: { height: 400 } }, // no lease: dropped
    ])
    expect(ack.r[1]).toMatchObject({ ok: true, fitDropped: true })
    expect(ack.derived ?? []).toEqual([])
    expect(byId((await st.snapshot(b)).elements).get('A')?.version).toBe(v0)
  })
})
