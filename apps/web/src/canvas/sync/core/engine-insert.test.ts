import type { CreateOp, Op } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { UndoController } from '../../history/controller.ts'
import { bump } from '../headless/scene.ts'
import { note, rect, text } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../testing/harness.ts'

// CR-2D-2 (wave 2D): the engine-side write path for prepared elements (LobbyEngineCore.prepareInsert and
// insert; CanvasPort.transact's tx.insert in the browser). Templates and paste-as-notes install their
// elements exactly as authored: nothing is rebuilt through the note or text tools.

const ops = (c: TestClient): Op[] => c.core.pushLog().flatMap((p) => [...p.ops])
const createsOf = (c: TestClient): CreateOp[] => ops(c).filter((o): o is CreateOp => o.k === 'c')

/** A template's note with its label, as 2D's builder authors them (a frame, a label size and ink the note tool would not give). */
function templateNote(id: string) {
  return [
    note(id, 'Zz', {
      x: 40,
      y: 60,
      frameId: null,
      strokeColor: '#5c940d',
      backgroundColor: '#d8f5a2',
      boundElements: [{ id: `${id}.t`, type: 'text' }],
      customData: { lobby: { kind: 'note' } },
      version: 7,
      versionNonce: 99,
    }),
    text(`${id}.t`, 'Zz0', {
      containerId: id,
      x: 60,
      y: 150,
      fontSize: 28,
      strokeColor: '#2b8a3e',
      text: 'Goal',
      originalText: 'Goal',
      version: 3,
      versionNonce: 98,
    }),
  ]
}

describe('engine core: insert of prepared elements (CR-2D-2)', () => {
  it('keeps ids and every field as given; fresh top keys in the given order; pushed whole as creates; stored', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0')), stored(rect('r2', 'a5'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const given = templateNote('T1')
    const ids = a.core.insert(given)
    expect(ids).toEqual(['T1', 'T1.t'])
    expect(a.core.saveStatus.state).toBe('saving')
    h.settle()
    const [n, t] = [a.get('T1'), a.get('T1.t')]
    // every field but `index` is the given one
    for (const [el, want] of [
      [n, given[0]],
      [t, given[1]],
    ] as const) {
      // (version, versionNonce and updated are the server's once stored)
      const {
        index: _i,
        version: _v,
        versionNonce: _n,
        updated: _u,
        ...rest
      } = want as Record<string, unknown>
      expect(el).toMatchObject(rest)
    }
    // on top of the board, the label above its container
    const idx = (id: string) => h.room.elements.get(id)?.index as string
    expect(idx('T1') > idx('r2')).toBe(true)
    expect(idx('T1.t') > idx('T1')).toBe(true)
    // pushed as creates, whole, with the given fields
    const cs = createsOf(a)
    expect(cs.map((c) => c.el.id)).toEqual(['T1', 'T1.t'])
    expect(cs[1]?.el).toMatchObject({ fontSize: 28, strokeColor: '#2b8a3e', text: 'Goal', containerId: 'T1' })
    expect(h.room.elements.get('T1')).toMatchObject({ strokeColor: '#5c940d', backgroundColor: '#d8f5a2' })
    expect(b.get('T1.t')).toMatchObject({ fontSize: 28, x: 60, y: 150 })
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('refuses the whole batch, installing nothing, on an existing id, a repeated id, a deleted element, no id', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    const before = [...a.scene.map.keys()]
    expect(() => a.core.insert([rect('n1', 'a1'), rect('r1', 'a2')])).toThrow(/r1 exists/)
    expect(() => a.core.insert([rect('n1', 'a1'), rect('n1', 'a2')])).toThrow(/twice/)
    expect(() => a.core.insert([rect('n1', 'a1', { isDeleted: true })])).toThrow(/deleted/)
    expect(() => a.core.insert([{ type: 'rectangle' }])).toThrow(/no id/)
    // an id the server has as a tombstone is taken too
    a.change('r1', { isDeleted: true })
    h.settle()
    expect(() => a.core.insert([rect('r1', 'a3')])).toThrow(/r1 exists/)
    expect([...a.scene.map.keys()]).toEqual(before)
    expect(createsOf(a)).toEqual([])
  })

  it('a read-only session cannot insert', () => {
    const h = createHarness()
    const v = h.client('viewer', { readonly: true })
    h.settle()
    expect(() => v.core.insert([rect('n1', 'a1')])).toThrow(/read-only/)
    expect(v.scene.map.size).toBe(0)
  })

  it('`above` places the batch above a given key (a transaction that created elements first)', () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    h.settle()
    const copies = a.core.prepareInsert([rect('n1', 'zz'), rect('n2', 'a0')], 'a5')
    expect(copies.map((c) => c.id)).toEqual(['n1', 'n2'])
    expect((copies[0]?.index as string) > 'a5').toBe(true)
    expect((copies[1]?.index as string) > (copies[0]?.index as string)).toBe(true)
    // nothing is installed by prepareInsert itself
    expect(a.scene.map.has('n1')).toBe(false)
  })

  it('an insert is one undo step: undo removes the whole batch for everyone, redo brings it back', async () => {
    const h = createHarness({ seed: [stored(rect('r1', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump })
    a.core.insert(templateNote('T1'))
    undo.boundary()
    h.settle()
    expect(b.get('T1')?.isDeleted).toBe(false)
    expect(undo.undo()?.kept).toBe(0)
    h.settle()
    for (const c of [a, b]) {
      expect(c.get('T1')?.isDeleted).toBe(true)
      expect(c.get('T1.t')?.isDeleted).toBe(true)
    }
    undo.redo()
    h.settle()
    expect(b.get('T1.t')).toMatchObject({ isDeleted: false, fontSize: 28 })
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('a refused insert (an element the schema rejects) leaves the scene with "Change not saved"', async () => {
    const h = createHarness()
    const a = h.client('alice')
    h.settle()
    const rejects: string[] = []
    a.core.on((e) => {
      if (e.kind === 'reject') rejects.push(`${e.id} ${e.code}`)
    })
    // the protocol fake validates every op with the frozen schemas, as the room does: INVALID
    a.core.insert([{ ...rect('bad', 'a1'), type: 'not-a-type' }])
    h.settle()
    expect(rejects).toEqual(['bad INVALID'])
    expect(a.get('bad')).toBeUndefined()
    expect(a.core.saveStatus.state).toBe('not-saved')
  })
})
