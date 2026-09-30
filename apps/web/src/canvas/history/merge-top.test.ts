import { describe, expect, it } from 'vitest'
import { bump } from '../sync/headless/scene.ts'
import { rect } from '../sync/testing/elements.ts'
import { stored } from '../sync/testing/fakeRoom.ts'
import { createHarness } from '../sync/testing/harness.ts'
import { UndoController } from './controller.ts'
import type { HistEl, Scene } from './diff.ts'
import { LobbyHistory } from './stack.ts'

// LobbyHistory.mergeTop() (2C's request at wave 2: `transact(label, fn, {joinPrevious: true})` merged
// entries through the live `undoEntries` array; the history owner's own merge replaces that).

const el = (id: string, o: Record<string, unknown> = {}, version = 1): HistEl =>
  ({ id, type: 'rectangle', isDeleted: false, x: 0, y: 0, strokeColor: '#1e1e1e', version, ...o }) as HistEl
const scene = (...els: HistEl[]): Scene => new Map(els.map((e) => [e.id, e]))

describe('LobbyHistory.mergeTop (2C: joinPrevious)', () => {
  it('two steps become one: one undo reverts both, one redo restores both', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a'), el('b')))
    h.record(scene(el('a', { x: 10 }, 2), el('b')))
    h.record(scene(el('a', { x: 10 }, 2), el('b', { strokeColor: '#e03131' }, 2)))
    expect(h.undoSize).toBe(2)
    expect(h.mergeTop()).toBe(true)
    expect(h.undoSize).toBe(1)
    const now = scene(el('a', { x: 10 }, 2), el('b', { strokeColor: '#e03131' }, 2))
    const u = h.undo(now)
    expect(u?.patches.get('a')).toMatchObject({ x: 0 })
    expect(u?.patches.get('b')).toMatchObject({ strokeColor: '#1e1e1e' })
    expect(h.undoSize).toBe(0)
    const r = h.redo(scene(el('a', {}, 3), el('b', {}, 3)))
    expect(r?.patches.get('a')).toMatchObject({ x: 10 })
    expect(r?.patches.get('b')).toMatchObject({ strokeColor: '#e03131' })
  })

  it('a field changed in both keeps the earlier before and the later after; a field back to its start is dropped', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a')))
    h.record(scene(el('a', { x: 10, y: 5 }, 2)))
    h.record(scene(el('a', { x: 30, y: 0 }, 3)))
    expect(h.mergeTop()).toBe(true)
    const c = h.undoEntries[0]?.changes.get('a')
    expect(c?.fields.x).toEqual({ before: 0, after: 30 })
    expect(c?.fields.y).toBeUndefined()
  })

  it('with a mark: joins exactly one new step on top of the marked one; never after an undo or a redo', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a')))
    // nothing before the write: no join
    let m = h.mark()
    h.record(scene(el('a', { x: 1 }, 2)))
    expect(h.mergeTop(m)).toBe(false)
    // the write recorded nothing: no join
    m = h.mark()
    expect(h.mergeTop(m)).toBe(false)
    // one step on top of the marked one: joined
    m = h.mark()
    h.record(scene(el('a', { x: 2 }, 3)))
    expect(h.mergeTop(m)).toBe(true)
    expect(h.undoSize).toBe(1)
    // two steps on top of the mark: no join
    m = h.mark()
    h.record(scene(el('a', { x: 3 }, 4)))
    h.record(scene(el('a', { x: 4 }, 5)))
    expect(h.mergeTop(m)).toBe(false)
    expect(h.undoSize).toBe(3)
    // after an undo (something to redo at the mark): the previous step is not the user's last change
    h.undo(scene(el('a', { x: 4 }, 5)))
    m = h.mark()
    h.record(scene(el('a', { x: 9 }, 7)))
    expect(h.mergeTop(m)).toBe(false)
  })

  it('without a mark: nothing to merge into, or something to redo, is no merge', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a')))
    expect(h.mergeTop()).toBe(false)
    h.record(scene(el('a', { x: 1 }, 2)))
    expect(h.mergeTop()).toBe(false)
    h.record(scene(el('a', { x: 2 }, 3)))
    h.undo(scene(el('a', { x: 2 }, 3)))
    expect(h.mergeTop()).toBe(false)
  })

  it('pending pushes of both steps stay pending: an ack still folds its fix into the merged step', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a')))
    h.record(scene(el('a', { x: 10 }, 2)))
    h.markPushed(1, ['a'])
    h.record(scene(el('a', { x: 10, y: 7 }, 3)))
    h.markPushed(2, ['a'])
    expect(h.mergeTop()).toBe(true)
    const c = h.undoEntries[0]?.changes.get('a')
    expect(c?.pending.map((p) => p.seq)).toEqual([1, 2])
    h.onAck({ seq: 2, r: [{ id: 'a', ok: true, fix: { y: 8 } }] })
    expect(h.undoEntries[0]?.changes.get('a')?.fields.y).toEqual({ before: 0, after: 8 })
  })
})

describe('UndoController.joinPrevious on the engine (2C: a second tab sees one undo revert both)', () => {
  it("A's move and the derived write joined to it are undone together, for everyone", async () => {
    const h = createHarness({ seed: [stored(rect('X', 'a0')), stored(rect('Y', 'a1'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump })
    a.change('X', { x: 200 })
    undo.boundary()
    // the derived write (a re-layout after the move), joined to the move
    undo.joinPrevious(() => {
      a.change('Y', { x: 260, y: 40 })
      undo.boundary()
    })
    expect(undo.history.undoSize).toBe(1)
    h.settle()
    expect(b.get('Y')?.x).toBe(260)
    undo.undo()
    h.settle()
    for (const c of [a, b]) {
      expect(c.get('X')?.x).toBe(0)
      expect(c.get('Y')).toMatchObject({ x: 0, y: 0 })
    }
    undo.redo()
    h.settle()
    expect(b.get('X')?.x).toBe(200)
    expect(b.get('Y')).toMatchObject({ x: 260, y: 40 })
    expect(await a.hash()).toBe(await h.roomHash())
  })
})
