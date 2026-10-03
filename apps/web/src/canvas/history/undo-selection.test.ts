import { describe, expect, it } from 'vitest'
import { bump } from '../sync/headless/scene.ts'
import { rect } from '../sync/testing/elements.ts'
import { stored } from '../sync/testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../sync/testing/harness.ts'
import { UndoController } from './controller.ts'
import type { HistEl, Scene } from './diff.ts'
import { LobbyHistory } from './stack.ts'

// F11 (3i): an undo restores the selection its step was made with, a redo the one it ended with (tldraw
// did; a keyboard or screen-reader user keeps their place after Ctrl+Z). The selection is never a change:
// selection clicks still make no step (U8, a11y-keyboard-safety.spec.ts F11).

const el = (id: string, o: Record<string, unknown> = {}, version = 1): HistEl =>
  ({ id, type: 'rectangle', isDeleted: false, x: 0, y: 0, version, ...o }) as HistEl
const scene = (...els: HistEl[]): Scene => new Map(els.map((e) => [e.id, e]))

describe('LobbyHistory: the selection a step was made with (F11)', () => {
  it('an undo hands back `before`, a redo `after`; the entry keeps both through the round trip', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a'), el('b')))
    h.record(scene(el('a', { x: 10 }, 2), el('b')), 'move', { before: ['a'], after: ['a', 'b'] })
    const u = h.undo(scene(el('a', { x: 10 }, 2), el('b')))
    expect(u?.selection).toEqual(['a'])
    const r = h.redo(scene(el('a', {}, 3), el('b')))
    expect(r?.selection).toEqual(['a', 'b'])
    expect(h.undo(scene(el('a', { x: 10 }, 4), el('b')))?.selection).toEqual(['a'])
  })

  it('no selection recorded: null (the caller leaves the selection alone)', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a')))
    h.record(scene(el('a', { x: 1 }, 2)))
    expect(h.undo(scene(el('a', { x: 1 }, 2)))?.selection).toBeNull()
  })

  it("mergeTop keeps the earlier step's before and the later step's after", () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a'), el('b')))
    h.record(scene(el('a', { x: 1 }, 2), el('b')), undefined, { before: ['a'], after: ['a'] })
    h.record(scene(el('a', { x: 1 }, 2), el('b', { x: 5 }, 2)), undefined, { before: ['a'], after: ['b'] })
    expect(h.mergeTop()).toBe(true)
    expect(h.undoEntries[0]?.selection).toEqual({ before: ['a'], after: ['b'] })
  })
})

/** Alice's undo with a selection the scene's gesture state holds (the browser's is Excalidraw's appState). */
function undoFor(c: TestClient) {
  const selects: string[][] = []
  const ctl = new UndoController({
    core: c.core,
    scene: c.scene,
    bump,
    select: (ids) => {
      selects.push([...ids])
      c.gesture({ selectedElementIds: [...ids] })
    },
  })
  /** what the person selects (a click, Ctrl+A, Escape): the board page's boundary follows every change */
  const select = (ids: string[]) => {
    c.gesture({ selectedElementIds: ids })
    expect(ctl.boundary()).toBeNull()
  }
  const selected = () => [...c.scene.read().gesture.selectedElementIds]
  return { ctl, select, selected, selects }
}

describe('UndoController: undo and redo re-select (F11, a11y-keyboard-safety.spec.ts)', () => {
  const seed = () => [stored(rect('N', 'a0')), stored(rect('M', 'a1', { x: 300 }))]

  it('after selection clicks, the undo selects the moved note again, and so does the redo', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.select(['N'])
    a.change('N', { x: 100 }, { selectedElementIds: ['N'] })
    expect(u.ctl.boundary()).not.toBeNull()
    // click empty canvas, click the other note, Escape, Ctrl+A: no steps
    u.select([])
    u.select(['M'])
    u.select([])
    u.select(['N', 'M'])
    expect(u.ctl.history.undoSize).toBe(1)
    u.ctl.undo()
    expect(a.get('N')?.x).toBe(0)
    expect(u.selected()).toEqual(['N'])
    u.select([])
    u.ctl.redo()
    expect(a.get('N')?.x).toBe(100)
    expect(u.selected()).toEqual(['N'])
    // the re-selection itself is no step: the redo stack is still there after an undo and its boundary
    u.ctl.undo()
    expect(u.ctl.boundary()).toBeNull()
    expect(u.ctl.history.redoSize).toBe(1)
    h.settle()
  })

  it('a delete clears the selection: its undo brings the note back selected, its redo leaves nothing selected', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.select(['N'])
    // Excalidraw's Delete: the element goes and the selection is cleared in the same change
    a.change('N', { isDeleted: true }, { selectedElementIds: [] })
    expect(u.ctl.boundary()).not.toBeNull()
    u.ctl.undo()
    expect(a.get('N')?.isDeleted).toBe(false)
    expect(u.selected()).toEqual(['N'])
    u.ctl.redo()
    expect(a.get('N')?.isDeleted).toBe(true)
    expect(u.selected()).toEqual([])
  })

  it('two steps: each undo selects what its own step was made with', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.select(['N'])
    a.change('N', { x: 100 }, { selectedElementIds: ['N'] })
    u.ctl.boundary()
    u.select(['M'])
    a.change('M', { strokeColor: '#e03131' }, { selectedElementIds: ['M'] })
    u.ctl.boundary()
    u.select([])
    u.ctl.undo()
    expect(u.selected()).toEqual(['M'])
    u.ctl.undo()
    expect(u.selected()).toEqual(['N'])
    u.ctl.redo()
    expect(u.selected()).toEqual(['N'])
    u.ctl.redo()
    expect(u.selected()).toEqual(['M'])
  })

  it('what is gone or locked since is not selected again; the rest is', () => {
    const h = createHarness({ seed: [...seed(), stored(rect('L', 'a2', { x: 600 }))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const u = undoFor(a)
    u.select(['N', 'M', 'L'])
    a.edit(
      (m) => {
        for (const id of ['N', 'M', 'L']) m.set(id, bump(m.get(id) as never, { y: 50 }))
      },
      { selectedElementIds: ['N', 'M', 'L'] },
    )
    u.ctl.boundary()
    h.settle()
    // bob deletes M and locks L
    b.change('M', { isDeleted: true })
    b.change('L', { locked: true })
    h.settle()
    u.select([])
    u.ctl.undo()
    expect(a.get('N')?.y).toBe(0)
    expect(u.selected()).toEqual(['N'])
  })

  it('a selection that is already the one to restore is left as it is (no extra select)', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.select(['N'])
    a.change('N', { x: 100 }, { selectedElementIds: ['N'] })
    u.ctl.boundary()
    u.ctl.undo()
    expect(u.selects).toEqual([])
    expect(u.selected()).toEqual(['N'])
  })

  it('joinPrevious: the joined step undoes to the selection the first write was made with', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.select(['N'])
    a.change('N', { x: 100 }, { selectedElementIds: ['N'] })
    u.ctl.boundary()
    u.ctl.joinPrevious(() => {
      a.change('M', { x: 400 }, { selectedElementIds: ['M'] })
      u.ctl.boundary()
    })
    expect(u.ctl.history.undoSize).toBe(1)
    u.select([])
    u.ctl.undo()
    expect(u.selected()).toEqual(['N'])
    u.ctl.redo()
    expect(u.selected()).toEqual(['M'])
  })

  it('without a select option the selection stays as it is (the headless client)', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const ctl = new UndoController({ core: a.core, scene: a.scene, bump })
    a.gesture({ selectedElementIds: ['N'] })
    ctl.boundary()
    a.change('N', { x: 100 }, { selectedElementIds: ['N'] })
    ctl.boundary()
    a.gesture({ selectedElementIds: ['M'] })
    ctl.boundary()
    expect(ctl.undo()?.result.selection).toEqual(['N'])
    expect([...a.scene.read().gesture.selectedElementIds]).toEqual(['M'])
  })
})
