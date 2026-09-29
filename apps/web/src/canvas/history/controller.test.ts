import { describe, expect, it } from 'vitest'
import { bump } from '../sync/headless/scene.ts'
import { note, rect } from '../sync/testing/elements.ts'
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
})
