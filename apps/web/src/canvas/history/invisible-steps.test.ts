import { describe, expect, it } from 'vitest'
import { joinInto, joinMark } from '../board/history-join.ts'
import { bump } from '../sync/headless/scene.ts'
import { rect, text } from '../sync/testing/elements.ts'
import { stored } from '../sync/testing/fakeRoom.ts'
import { createHarness } from '../sync/testing/harness.ts'
import { UndoController } from './controller.ts'
import type { HistEl } from './diff.ts'
import { LobbyHistory } from './stack.ts'

// CR-3D-4: undo steps that change nothing a person can see. (1) The engine's re-key of an `index`
// (Excalidraw's `updateScene` re-keys every element whose key is out of place in the array, with a version
// bump) was recorded as a step of its own: seen on bob's stack as an arrow's `index` alone after alice and
// bob added a branch to the same map at once (mindmap-keyboard.spec.ts). (2) A new mind-map topic and the
// words typed into it were two steps (tldraw: one). (3) A joined write that put a field back recorded a
// step that undid nothing.

type SceneMap = Map<string, HistEl>
const el = (id: string, o: Record<string, unknown> = {}, version = 1): HistEl =>
  ({ id, type: 'rectangle', isDeleted: false, x: 0, y: 0, version, versionNonce: version, ...o }) as HistEl
const start = (...els: HistEl[]) => {
  const scene: SceneMap = new Map(els.map((e) => [e.id, e]))
  const h = new LobbyHistory()
  h.reset(scene)
  return { scene, h }
}
/** a local write (version + 1) */
const local = (scene: SceneMap, id: string, patch: Record<string, unknown>) => {
  const cur = scene.get(id) as HistEl
  scene.set(id, { ...cur, ...patch, version: (cur.version ?? 0) + 1, versionNonce: (cur.version ?? 0) + 1 })
}
/** what an undo or a redo wrote, put in the scene */
const install = (scene: SceneMap, res: { patches: Map<string, Record<string, unknown>> } | null) => {
  for (const [id, p] of res?.patches ?? []) local(scene, id, p)
}

describe("the engine's re-key of an index is no step (CR-3D-4)", () => {
  it('a new key that keeps the element where it was among the others records nothing', () => {
    const { scene, h } = start(el('A', { index: 'a0' }), el('L', { index: 'a1' }), el('B', { index: 'a2' }))
    local(scene, 'L', { index: 'a1V' })
    expect(h.record(scene)).toBeNull()
    expect(h.undoSize).toBe(0)
    expect(h.lastLocalOf('L')?.index).toBe('a1V')
    // and the next real change is recorded without it
    local(scene, 'A', { x: 5 })
    expect([...(h.record(scene)?.changes.keys() ?? [])]).toEqual(['A'])
  })

  it('two elements sharing a key: the second one re-keyed in place is no step', () => {
    // the engine sorts by (index, id): M is painted after L, and Excalidraw gives M a key of its own there
    const { scene, h } = start(
      el('A', { index: 'a0' }),
      el('L', { index: 'a1' }),
      el('M', { index: 'a1' }),
      el('B', { index: 'a2' }),
    )
    local(scene, 'M', { index: 'a1V' })
    expect(h.record(scene)).toBeNull()
  })

  it("a deleted element's new key is no step (it paints nowhere)", () => {
    const { scene, h } = start(el('A', { index: 'a0' }), el('L', { index: 'a1', isDeleted: true }))
    local(scene, 'L', { index: 'a5' })
    expect(h.record(scene)).toBeNull()
  })

  it('a reorder (the element passes another) is a step; a re-key after it folds into it, and the undo applies', () => {
    const { scene, h } = start(el('A', { index: 'a0' }), el('L', { index: 'a1' }), el('B', { index: 'a2' }))
    local(scene, 'L', { index: 'a3' }) // bring to front: L passes B
    const entry = h.record(scene)
    expect(entry?.changes.get('L')?.fields.index).toEqual({ before: 'a1', after: 'a3' })
    local(scene, 'L', { index: 'a4' }) // re-keyed on top: still above B
    expect(h.record(scene)).toBeNull()
    expect(h.undoEntries[0]?.changes.get('L')?.fields.index).toEqual({ before: 'a1', after: 'a4' })
    const u = h.undo(scene)
    expect(u?.kept).toBe(0)
    install(scene, u)
    expect(scene.get('L')?.index).toBe('a1')
    // re-keyed again where it is now: the redo entry takes the key, and the redo applies
    local(scene, 'L', { index: 'a1V' })
    expect(h.record(scene)).toBeNull()
    expect(h.redoEntries[0]?.changes.get('L')?.fields.index).toEqual({ before: 'a1V', after: 'a4' })
    const r = h.redo(scene)
    expect(r?.kept).toBe(0)
    install(scene, r)
    expect(scene.get('L')?.index).toBe('a4')
  })

  it('an index change with another change of the same element stays part of the step', () => {
    const { scene, h } = start(el('A', { index: 'a0' }), el('L', { index: 'a1' }))
    local(scene, 'L', { index: 'a1V', x: 40 })
    expect(Object.keys(h.record(scene)?.changes.get('L')?.fields ?? {}).sort()).toEqual(['index', 'x'])
  })

  it("on the engine: a re-key of someone else's element between two of alice's steps takes no press", async () => {
    const h = createHarness({
      seed: [
        stored(rect('N', 'a0')),
        stored(rect('L', 'a1', { x: 300 })),
        stored(rect('B', 'a2', { x: 600 })),
      ],
    })
    const a = h.client('alice')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump })
    a.change('N', { x: 100 })
    undo.boundary()
    // Excalidraw's own re-key (mutateElement: a version bump) of an element alice never touched
    a.change('L', { index: 'a1V' })
    expect(undo.boundary()).toBeNull()
    h.settle()
    expect(undo.history.undoSize).toBe(1)
    // one press takes back alice's move
    undo.undo()
    h.settle()
    expect(a.get('N')?.x).toBe(0)
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

describe('a new topic and the words typed into it are one step (CR-3D-4, joinAction)', () => {
  /** The board after "add topic": container C with an empty label T, made in one step. */
  const madeEmpty = () => {
    const { scene, h } = start(el('R', { index: 'a0' }))
    scene.set('C', el('C', { index: 'a1', x: 200, width: 120, height: 40 }))
    scene.set(
      'T',
      el('T', { type: 'text', index: 'a2', containerId: 'C', text: '', originalText: '', x: 260 }),
    )
    h.record(scene, 'mindmap: add topic')
    return { scene, h }
  }
  /** The editor's step: the words, the label's layout, the container's fit. */
  const typing = (scene: SceneMap, h: LobbyHistory) => {
    local(scene, 'T', { text: 'Budget', originalText: 'Budget', x: 230, width: 60 })
    local(scene, 'C', { height: 44 })
    h.record(scene)
  }

  it('the joined write after the typing folds the typing into the step that made the topic', () => {
    const { scene, h } = madeEmpty()
    typing(scene, h)
    expect(h.undoSize).toBe(2)
    const mark = h.mark()
    expect(mark.creation).toBe(h.undoEntries[0])
    // the layout after the words: another topic moves
    local(scene, 'R', { y: -20 })
    h.record(scene, 'mindmap: layout')
    h.joinAction(mark)
    expect(h.undoSize).toBe(1)
    const u = h.undo(scene)
    install(scene, u)
    expect(scene.get('C')?.isDeleted).toBe(true)
    expect(scene.get('T')?.isDeleted).toBe(true)
    expect(scene.get('R')?.y).toBe(0)
    const r = h.redo(scene)
    install(scene, r)
    expect(scene.get('T')).toMatchObject({ isDeleted: false, text: 'Budget' })
    expect(scene.get('C')).toMatchObject({ isDeleted: false, height: 44 })
  })

  it('an empty joined write (nothing to lay out) still folds them', () => {
    const { scene, h } = madeEmpty()
    typing(scene, h)
    const mark = h.mark()
    expect(h.record(scene)).toBeNull()
    expect(h.joinAction(mark)).toBe(false)
    expect(h.undoSize).toBe(1)
  })

  it("the board page's join (history-join) does the same", () => {
    const { scene, h } = madeEmpty()
    typing(scene, h)
    const mark = joinMark(h)
    joinInto(h, mark)
    expect(h.undoSize).toBe(1)
  })

  it('a note whose label the typing made stays two steps (collab-conflicts.spec.ts)', () => {
    const { scene, h } = start(el('R', { index: 'a0' }))
    scene.set('C', el('C', { type: 'stickynote', index: 'a1' }))
    h.record(scene)
    scene.set('T', el('T', { type: 'text', index: 'a2', containerId: 'C', text: 'hi', originalText: 'hi' }))
    local(scene, 'C', { height: 60 })
    h.record(scene)
    expect(h.mark().creation).toBeNull()
    h.joinAction(h.mark())
    expect(h.undoSize).toBe(2)
  })

  it('words that replace a label\'s own words (a new map\'s "Central topic") stay two steps', () => {
    const { scene, h } = start(el('R', { index: 'a0' }))
    scene.set('C', el('C', { index: 'a1' }))
    scene.set(
      'T',
      el('T', {
        type: 'text',
        index: 'a2',
        containerId: 'C',
        text: 'Central topic',
        originalText: 'Central topic',
      }),
    )
    h.record(scene)
    local(scene, 'T', { text: 'Launch plan', originalText: 'Launch plan' })
    h.record(scene)
    expect(h.mark().creation).toBeNull()
  })

  it('no fold when the typing step also changed something else, deleted the label, or after an undo', () => {
    {
      const { scene, h } = madeEmpty()
      local(scene, 'T', { text: 'Budget', originalText: 'Budget' })
      local(scene, 'R', { strokeColor: '#e03131' })
      h.record(scene)
      expect(h.mark().creation).toBeNull()
    }
    {
      const { scene, h } = madeEmpty()
      local(scene, 'T', { text: 'x', originalText: 'x' })
      h.record(scene)
      local(scene, 'T', { isDeleted: true })
      h.record(scene)
      expect(h.mark().creation).toBeNull()
    }
    {
      const { scene, h } = madeEmpty()
      typing(scene, h)
      local(scene, 'R', { x: 9 })
      h.record(scene)
      install(scene, h.undo(scene))
      expect(h.mark().creation).toBeNull()
    }
  })

  it('on the engine: one undo takes back the topic and its words for both people; one redo brings both', async () => {
    const h = createHarness({ seed: [stored(rect('R', 'a0'))] })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const undo = new UndoController({ core: a.core, scene: a.scene, bump })
    // "add topic" (one transact): the topic and its empty label
    a.edit((m) => {
      m.set('C', rect('C', 'a1', { x: 200, boundElements: [{ id: 'T', type: 'text' }] }))
      m.set('T', text('T', 'a2', { containerId: 'C', text: '', originalText: '', x: 250 }))
    })
    undo.boundary()
    h.settle()
    // the editor: the words, then the editor closes (the board page's boundary)
    a.change('T', { text: 'Budget', originalText: 'Budget', x: 225, width: 50 })
    undo.boundary()
    h.settle()
    // the mind map's layout after the editor closed: nothing to move, an empty joined write
    undo.joinPrevious(() => undo.boundary())
    expect(undo.history.undoSize).toBe(1)
    undo.undo()
    h.settle()
    for (const c of [a, b]) {
      expect(c.get('C')?.isDeleted ?? true).toBe(true)
      expect(c.get('T')?.isDeleted ?? true).toBe(true)
    }
    undo.redo()
    h.settle()
    expect(b.get('T')).toMatchObject({ isDeleted: false, text: 'Budget' })
    expect(b.get('C')?.isDeleted).toBe(false)
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

describe('a joined write that puts a field back records no step (history-join)', () => {
  it('a move and a joined write moving it back: no entry left to undo', () => {
    const { scene, h } = start(el('A', { index: 'a0' }), el('B', { index: 'a1' }))
    local(scene, 'A', { x: 10 })
    h.record(scene)
    const mark = joinMark(h)
    local(scene, 'A', { x: 0 })
    h.record(scene)
    expect(joinInto(h, mark)).toBe(true)
    // before: an entry with x 0 -> 0, a Ctrl+Z that changed nothing
    expect(h.undoSize).toBe(0)
  })

  it('a field put back while another one changed: only the other one is left', () => {
    const { scene, h } = start(el('A', { index: 'a0' }))
    local(scene, 'A', { x: 10 })
    h.record(scene)
    const mark = joinMark(h)
    local(scene, 'A', { x: 0, y: 7 })
    h.record(scene)
    joinInto(h, mark)
    expect(h.undoEntries[0]?.changes.get('A')?.fields).toEqual({ y: { before: 0, after: 7 } })
  })
})
