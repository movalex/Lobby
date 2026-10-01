import { describe, expect, it } from 'vitest'
import { bump } from '../sync/headless/scene.ts'
import { arrow, binding, note, rect, text } from '../sync/testing/elements.ts'
import { stored } from '../sync/testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../sync/testing/harness.ts'
import { UndoController } from './controller.ts'

// Undo wired to the engine core (§2.8) through the protocol fake: B2's cases (U1, U4, U5, U8, U9) on two
// headless clients. The browser runs the same controller (spec b2-*).

function undoFor(c: TestClient) {
  const ctl = new UndoController({ core: c.core, scene: c.scene, bump })
  return {
    ctl,
    /** a local edit and its step boundary */
    act(id: string, patch: Record<string, unknown>) {
      c.change(id, patch)
      ctl.boundary()
    },
  }
}

const lobby = (c: TestClient, id: string) =>
  ((c.get(id)?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}) as Record<
    string,
    unknown
  >

describe('undo on the engine (§2.8)', () => {
  it("U1: A's undo removes A's +1 and keeps B's", async () => {
    const h = createHarness({ seed: [stored(note('N', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const ua = undoFor(a)
    const ub = undoFor(b)
    ua.act('N', { customData: { lobby: { 'plusOne:alice': true } } })
    h.settle()
    ub.act('N', { customData: { lobby: { ...lobby(b, 'N'), 'plusOne:bob': true } } })
    h.settle()
    const r = ua.ctl.undo()
    expect(r?.kept).toBe(0)
    h.settle()
    expect(Object.keys(lobby(b, 'N'))).toEqual(['plusOne:bob'])
    expect(Object.keys(lobby(a, 'N'))).toEqual(['plusOne:bob'])
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it("U4: A's move is undone; B's recolour stays", async () => {
    const h = createHarness({ seed: [stored(rect('N', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const ua = undoFor(a)
    const ub = undoFor(b)
    ua.act('N', { x: 300, y: 40 })
    h.settle()
    ub.act('N', { strokeColor: '#ff0000' })
    h.settle()
    expect(ua.ctl.undo()?.kept).toBe(0)
    h.settle()
    for (const c of [a, b]) {
      expect(c.get('N')?.x).toBe(0)
      expect(c.get('N')?.strokeColor).toBe('#ff0000')
    }
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('U5: same field, B wrote later: A sees "1 change kept", N stays blue', () => {
    const h = createHarness({ seed: [stored(rect('N', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const ua = undoFor(a)
    const ub = undoFor(b)
    ua.act('N', { backgroundColor: '#ff0000' })
    h.settle()
    ub.act('N', { backgroundColor: '#0000ff' })
    h.settle()
    const r = ua.ctl.undo()
    expect(r?.kept).toBe(1)
    h.settle()
    expect(h.room.elements.get('N')?.backgroundColor).toBe('#0000ff')
  })

  it('U8: selection changes are not steps; U9: two steps inside one round trip undo one at a time', () => {
    const h = createHarness({ seed: [stored(rect('N', 'a0'))] })
    const a = h.client('alice', { latencyMs: 300 })
    h.settle()
    const ua = undoFor(a)
    for (let i = 0; i < 10; i++) {
      a.gesture({ selectedElementIds: i % 2 ? [] : ['N'] })
      ua.ctl.boundary()
    }
    expect(ua.ctl.history.undoSize).toBe(0)
    ua.act('N', { strokeColor: '#ff0000' })
    h.clock.advance(60)
    ua.act('N', { x: 50 })
    h.clock.advance(60) // neither acked yet (300 ms)
    expect(ua.ctl.history.undoSize).toBe(2)
    ua.ctl.undo()
    expect(a.get('N')?.x).toBe(0)
    expect(a.get('N')?.strokeColor).toBe('#ff0000')
    ua.ctl.undo()
    expect(a.get('N')?.strokeColor).toBe('#1e1e1e')
    h.settle()
    expect(h.room.elements.get('N')?.strokeColor).toBe('#1e1e1e')
    expect(h.room.elements.get('N')?.x).toBe(0)
  })

  it('a remote change is absorbed, never a step; an undo after it applies with no false "kept"', () => {
    const h = createHarness({ seed: [stored(rect('N', 'a0')), stored(rect('M', 'a1'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const ua = undoFor(a)
    ua.act('N', { x: 10 })
    h.settle()
    b.change('M', { y: 99 })
    h.settle()
    ua.ctl.boundary()
    expect(ua.ctl.history.undoSize).toBe(1)
    expect(ua.ctl.undo()?.kept).toBe(0)
    h.settle()
    expect(a.get('M')?.y).toBe(99)
    expect(a.get('N')?.x).toBe(0)
  })

  it('B3 L6 (4): B moves a note with its label while A types in it; the label layout is not recorded, the undo keeps nothing', async () => {
    const h = createHarness({
      seed: [
        stored(note('n1', 'a0', { boundElements: [{ id: 'n1.t', type: 'text' }] })),
        stored(text('n1.t', 'a1', { containerId: 'n1', x: 20, y: 80 })),
      ],
    })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    a.core.leaseConnect(() => {}).send({ type: 'lease.acquire', req: 1, id: 'n1' })
    h.settle()
    const ub = undoFor(b)
    // B's drag moves the note and (locally) its label; the label's layout is lease-gated: the core resets
    // it. In the browser the step boundary (CanvasPort.transact) comes BEFORE the core's scan (Excalidraw's
    // onChange runs after React's render), so the step is recorded from the scene first
    const m = (b.scene as unknown as { map: Map<string, never> }).map
    m.set('n1', bump(m.get('n1') as never, { x: 70, y: 45 }) as never)
    m.set('n1.t', bump(m.get('n1.t') as never, { x: 90, y: 125 }) as never)
    ub.ctl.boundary()
    b.gesture() // the core's scan
    h.settle()
    // A, the holder, re-lays the label out on the note's new position
    a.change('n1.t', { x: 90.5, y: 125 }, { editingTextElementId: 'n1.t' })
    h.settle()
    a.gesture()
    h.settle()
    const r = ub.ctl.undo()
    expect(r?.kept).toBe(0)
    expect(r?.result.skips.filter((s) => !s.silent)).toEqual([])
    h.settle()
    expect(b.get('n1')?.x).toBe(0)
    expect(h.room.elements.get('n1')?.x).toBe(0)
    expect(h.room.elements.get('n1.t')?.x).toBe(90.5)
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('B3 L6 (3f): an edit made offline is undoable after the reconnect (the stacks survive a welcome of the same epoch)', async () => {
    const h = createHarness({ seed: [stored(rect('N', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const ua = undoFor(a)
    h.room.cut(a.transport)
    h.settle()
    ua.act('N', { x: 300 })
    b.change('N', { strokeColor: '#ff0000' })
    h.clock.advance(2_000)
    ;(a.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    expect(h.room.elements.get('N')?.x).toBe(300)
    expect(ua.ctl.history.undoSize).toBe(1)
    expect(ua.ctl.undo()?.kept).toBe(0)
    h.settle()
    expect(h.room.elements.get('N')?.x).toBe(0)
    expect(h.room.elements.get('N')?.strokeColor).toBe('#ff0000')
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

// Wave 4d (2A): collab-conflicts.spec.ts "undo: alice's own drag, resize, note, text, arrow, delete undo and
// redo step by step" failed at its third Ctrl+Z once the room paced its commits (ac72d87: an ack comes up to
// 40 ms later, so the next press lands while the previous undo's push is in flight). The undo of a step that
// revives a bound arrow writes its before-side geometry, which the core holds as derived (E10, both ends
// bound); the boundary after it recorded the arrow at its WHOLE server copy (post-delete: unbound end, old
// geometry) as a new step and dropped the redo stack, because the arrow's scene version (an unacked local
// bump) no longer matched the server copy's. Only the held `path` is hidden now (controller.ts sceneMap).
describe('a held derived arrow path at a boundary, with a push of the arrow in flight (wave 4d, 2A)', () => {
  const P0 = {
    x: 50,
    y: 100,
    width: 0,
    height: 300,
    points: [
      [0, 0],
      [0, 300],
    ] as [number, number][],
  }
  const P1 = {
    x: 50,
    y: 100,
    width: 120,
    height: 320,
    points: [
      [0, 0],
      [120, 320],
    ] as [number, number][],
  }
  const seed = () => [
    stored(rect('g1', 'a0', { boundElements: [{ id: 'A', type: 'arrow' }] })),
    stored(rect('g3', 'a1', { y: 400, boundElements: [{ id: 'A', type: 'arrow' }] })),
    stored(
      arrow('A', 'a2', {
        ...P0,
        startBinding: binding('g1', [0.5, 1]),
        endBinding: binding('g3', [0.5, 0]),
      }),
    ),
  ]
  /** Deletes g3 and, as Excalidraw does, frees the arrow's end; the free end is then dragged (one step). */
  const deleteAndDrag = (a: TestClient) =>
    a.edit((m) => {
      m.set('g3', bump(m.get('g3') as never, { isDeleted: true }))
      m.set('A', bump(m.get('A') as never, { endBinding: null, ...P1 }))
    })

  it('the boundary after the second undo records no step and keeps both redo entries; the redos land', async () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice', { latencyMs: 300 })
    h.settle()
    const ua = undoFor(a)
    deleteAndDrag(a)
    ua.ctl.boundary()
    h.settle()
    ua.act('A', { strokeColor: '#ff0000' })
    h.settle()
    expect(ua.ctl.history.undoSize).toBe(2)
    expect(h.room.elements.get('A')?.endBinding).toBeNull()

    // the first press: its push (the arrow's style) is out, not acked for 300 ms
    expect(ua.ctl.undo()?.kept).toBe(0)
    ua.ctl.boundary()
    expect(a.core.saveStatus.state).not.toBe('saved')
    // the second press before that ack: the arrow is revived bound again, its before-side geometry
    // differs from the scene's only at the bound end (derived: held, never pushed)
    expect(ua.ctl.undo()?.kept).toBe(0)
    expect(a.core.isDerivedHeld('A')).toBe(true)
    ua.ctl.boundary() // the board page's boundary on the engine's onChange
    expect(ua.ctl.history.undoSize).toBe(0)
    expect(ua.ctl.history.redoSize).toBe(2)
    expect(a.get('g3')?.isDeleted).toBe(false)
    expect((a.get('A')?.endBinding as { elementId: string } | null)?.elementId).toBe('g3')
    expect(a.get('A')?.strokeColor).toBe('#1e1e1e')

    h.settle()
    ua.ctl.boundary()
    expect(ua.ctl.history.undoSize).toBe(0)
    expect(ua.ctl.history.redoSize).toBe(2)
    expect(h.room.elements.get('g3')?.isDeleted).toBe(false)
    expect((h.room.elements.get('A')?.endBinding as { elementId: string } | null)?.elementId).toBe('g3')
    expect(await a.hash()).toBe(await h.roomHash())

    // both redos, one press each, back to the state after the two steps
    expect(ua.ctl.redo()?.kept).toBe(0)
    ua.ctl.boundary()
    expect(ua.ctl.redo()?.kept).toBe(0)
    ua.ctl.boundary()
    expect(ua.ctl.history.redoSize).toBe(0)
    expect(ua.ctl.history.undoSize).toBe(2)
    h.settle()
    expect(h.room.elements.get('g3')?.isDeleted).toBe(true)
    expect(h.room.elements.get('A')?.endBinding).toBeNull()
    expect(h.room.elements.get('A')?.strokeColor).toBe('#ff0000')
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('the same two presses with every ack in: the stacks are the same (the fast path hid the defect)', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const ua = undoFor(a)
    deleteAndDrag(a)
    ua.ctl.boundary()
    h.settle()
    ua.act('A', { strokeColor: '#ff0000' })
    h.settle()
    expect(ua.ctl.undo()?.kept).toBe(0)
    ua.ctl.boundary()
    h.settle()
    expect(ua.ctl.undo()?.kept).toBe(0)
    ua.ctl.boundary()
    h.settle()
    ua.ctl.boundary()
    expect(ua.ctl.history.undoSize).toBe(0)
    expect(ua.ctl.history.redoSize).toBe(2)
  })
})

// The other derived hold (engine.ts classify: an arrow's label that moved with a derived arrow change is
// derived too, held by its `layout`): hidden from the step like the arrow's geometry, and only that group.
describe('a derived arrow follow with its label, at the boundary of the gesture that caused it', () => {
  const seed = () => [
    stored(
      rect('x', 'a0', { x: 0, y: 0, width: 100, height: 100, boundElements: [{ id: 'ar', type: 'arrow' }] }),
    ),
    stored(
      arrow('ar', 'a1', {
        x: 100,
        y: 50,
        points: [
          [0, 0],
          [200, 0],
        ],
        startBinding: binding('x', [1, 0.5]),
        boundElements: [{ id: 'ar.t', type: 'text' }],
      }),
    ),
    stored(text('ar.t', 'a2', { containerId: 'ar', x: 170, y: 37, text: 'why', originalText: 'why' })),
  ]

  it('records the resize only; the arrow and its label are no part of the step, and the undo keeps nothing', async () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const ua = undoFor(a)
    const resize = { resizing: true, resizingElementId: 'x', selectedElementIds: ['x'] }
    a.edit((m) => {
      m.set('x', bump(m.get('x') as never, { width: 140 }))
      // Excalidraw's updateBoundElements: the bound start moves, the free end stays, the label re-centres
      m.set(
        'ar',
        bump(m.get('ar') as never, {
          x: 140,
          points: [
            [0, 0],
            [160, 0],
          ],
          width: 160,
        }),
      )
      m.set('ar.t', bump(m.get('ar.t') as never, { x: 190 }))
    }, resize)
    expect(a.core.isDerivedHeld('ar')).toBe(true)
    expect(a.core.isDerivedHeld('ar.t')).toBe(true)
    a.gesture()
    const entry = ua.ctl.boundary()
    expect([...(entry?.changes.keys() ?? [])]).toEqual(['x'])
    expect(entry?.changes.get('x')?.fields).toEqual({ width: { before: 100, after: 140 } })
    h.settle()
    // the server's re-snap of the arrow and its label arrives as its own write: absorbed, no step
    h.room.serverWrite('ar', {
      x: 140,
      points: [
        [0, 0],
        [160, 0],
      ],
      width: 160,
    })
    h.room.serverWrite('ar.t', { x: 190 })
    h.settle()
    expect(ua.ctl.boundary()).toBeNull()
    expect(ua.ctl.history.undoSize).toBe(1)
    expect(ua.ctl.undo()?.kept).toBe(0)
    ua.ctl.boundary()
    h.settle()
    expect(h.room.elements.get('x')?.width).toBe(100)
    expect(ua.ctl.history.undoSize).toBe(0)
    expect(ua.ctl.history.redoSize).toBe(1)
    expect(await a.hash()).toBe(await h.roomHash())
  })
})
