import { describe, expect, it } from 'vitest'
import { bump } from '../sync/headless/scene.ts'
import { rect } from '../sync/testing/elements.ts'
import { stored } from '../sync/testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../sync/testing/harness.ts'
import type { SceneElement } from '../sync/types.ts'
import { SELECTION_SETTLE_MS, selectedGroups, UndoController } from './controller.ts'
import type { HistEl, Scene } from './diff.ts'
import { LobbyHistory } from './stack.ts'

// Wave B follow-ups (D3-2), both about the selection a step comes back with (F11, undo-selection.test.ts):
//  (1) a redo restored an EMPTY selection when the boundary that recorded the step ran before the engine
//      applied a select made in the same breath (the mind map selects its topic again as its editor closes);
//  (2) a restored selection lost `selectedGroupIds`, so a group came back as its members.

/** Alice's undo on a scene whose gesture state the test sets, with a clock the test moves. */
function undoFor(c: TestClient) {
  let t = 1_000_000
  const selects: { ids: string[]; groups: string[] }[] = []
  const ctl = new UndoController({
    core: c.core,
    scene: c.scene,
    bump,
    now: () => t,
    select: (ids, groups) => {
      selects.push({ ids: [...ids], groups: [...groups] })
      c.gesture({ selectedElementIds: [...ids] })
    },
  })
  /** the engine's state is now this selection: the board page's boundary follows every change */
  const engineSelects = (ids: string[]) => {
    c.gesture({ selectedElementIds: ids })
    return ctl.boundary()
  }
  const selected = () => [...c.scene.read().gesture.selectedElementIds]
  const advance = (ms: number) => {
    t += ms
  }
  const afters = () => ctl.history.undoEntries.map((e) => e.selection?.after)
  return { ctl, engineSelects, selected, selects, advance, afters }
}

describe('a step that ended with nothing selected takes the select the engine applies right after it', () => {
  const seed = () => [
    stored(rect('N', 'a0')),
    stored(rect('M', 'a1', { x: 300 })),
    stored(rect('P', 'a2', { x: 600 })),
  ]

  it('the redo selects what the step ended with, not the empty selection the boundary read', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['M'])
    // the step: the engine's own state at the boundary has nothing selected (a select made in the same breath
    // as the write is still waiting for the next render)
    a.change('N', { x: 100 }, { selectedElementIds: [] })
    expect(u.ctl.boundary()).not.toBeNull()
    expect(u.afters()).toEqual([[]])
    // the render applies the select: a boundary with no change
    expect(u.engineSelects(['N'])).toBeNull()
    expect(u.afters()).toEqual([['N']])
    // a click elsewhere, then undo and redo
    u.advance(5_000)
    u.engineSelects(['P'])
    u.ctl.undo()
    expect(a.get('N')?.x).toBe(0)
    expect(u.selected()).toEqual(['M'])
    u.engineSelects([])
    u.ctl.redo()
    expect(a.get('N')?.x).toBe(100)
    expect(u.selected()).toEqual(['N'])
  })

  it('an undo right after the step, before any quiet boundary, finds the select too', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['M'])
    a.change('N', { x: 100 }, { selectedElementIds: [] })
    u.ctl.boundary()
    // the render lands (no boundary call yet: the page's own boundary follows), then Ctrl+Z at once: its
    // own boundary is the one that finds the selection
    a.gesture({ selectedElementIds: ['N'] })
    u.ctl.undo()
    expect(u.selected()).toEqual(['M'])
    u.ctl.redo()
    expect(u.selected()).toEqual(['N'])
  })

  it('a selection that arrives after the window is the person’s own: the step stays empty', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['M'])
    a.change('N', { isDeleted: true }, { selectedElementIds: [] })
    u.ctl.boundary()
    u.advance(SELECTION_SETTLE_MS + 1)
    u.engineSelects(['P'])
    expect(u.afters()).toEqual([[]])
    u.ctl.undo()
    expect(u.selected()).toEqual(['M'])
    u.ctl.redo()
    // a delete: nothing selected after it, as it was
    expect(u.selected()).toEqual([])
  })

  it('a step that ended with something selected keeps it: a later select within the window changes nothing', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['N'])
    a.change('N', { x: 100 }, { selectedElementIds: ['N'] })
    u.ctl.boundary()
    u.engineSelects([])
    u.engineSelects(['M'])
    expect(u.afters()).toEqual([['N']])
  })

  it('an undo or a redo ends the window: the next select never reaches the redo entry', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['M'])
    a.change('N', { x: 100 }, { selectedElementIds: [] })
    u.ctl.boundary()
    u.ctl.undo()
    expect(u.selected()).toEqual(['M'])
    // within the window of the step, after its undo: a selection is the person's own
    u.engineSelects(['P'])
    u.ctl.redo()
    expect(u.selected()).toEqual([])
  })

  it('a joined write (the layout after a typed topic) keeps the select that follows it with the merged step', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['M'])
    // the topic is made: selected (a select made right after, not applied yet at this boundary)
    a.change('N', { x: 100 }, { selectedElementIds: [] })
    u.ctl.boundary()
    u.engineSelects(['N'])
    // the editor closes: the engine clears the selection, the step is recorded with none
    a.change('N', { y: 40 }, { selectedElementIds: [] })
    u.ctl.boundary()
    // the topic is selected again and the layout joins the step, all before the engine applies the select
    u.ctl.joinPrevious(() => {
      a.change('P', { x: 700 }, { selectedElementIds: [] })
      u.ctl.boundary()
    })
    expect(u.ctl.history.undoSize).toBe(2)
    expect(u.afters().at(-1)).toEqual([])
    // the engine applies the select
    expect(u.engineSelects(['N'])).toBeNull()
    expect(u.afters().at(-1)).toEqual(['N'])
    u.engineSelects([])
    u.ctl.undo()
    u.engineSelects([])
    u.ctl.redo()
    expect(u.selected()).toEqual(['N'])
  })
})

describe('LobbyHistory.settleSelection', () => {
  const el = (id: string, o: Record<string, unknown> = {}, version = 1): HistEl =>
    ({ id, type: 'rectangle', isDeleted: false, x: 0, y: 0, version, ...o }) as HistEl
  const scene = (...els: HistEl[]): Scene => new Map(els.map((e) => [e.id, e]))

  it('gives an empty `after` the selection, and nothing else', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a')))
    h.record(scene(el('a', { x: 1 }, 2)), 'move', { before: ['b'], after: [] })
    expect(h.settleSelection([])).toBe(false)
    expect(h.settleSelection(['a'])).toBe(true)
    expect(h.undoEntries[0]?.selection).toEqual({ before: ['b'], after: ['a'] })
    // not twice: it has a selection now
    expect(h.settleSelection(['c'])).toBe(false)
    expect(h.undoEntries[0]?.selection?.after).toEqual(['a'])
  })

  it('does nothing without a step, without a recorded selection, or while a redo is possible', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a')))
    expect(h.settleSelection(['a'])).toBe(false)
    h.record(scene(el('a', { x: 1 }, 2)))
    expect(h.settleSelection(['a'])).toBe(false)
    h.record(scene(el('a', { x: 2 }, 3)), undefined, { before: [], after: [] })
    h.undo(scene(el('a', { x: 2 }, 3)))
    expect(h.redoSize).toBe(1)
    expect(h.settleSelection(['a'])).toBe(false)
  })
})

describe('a group is restored as a group (selectedGroupIds)', () => {
  const g = (id: string, groupIds: string[], o: Record<string, unknown> = {}) =>
    rect(id, `a${id.length}${id}`, { groupIds, ...o }) as SceneElement

  describe('selectedGroups', () => {
    it('a group whose members are all selected is selected; one with a member left out is its members', () => {
      const els = [g('A', ['g1']), g('B', ['g1']), g('C', ['g2']), g('D', ['g2']), g('E', [])]
      expect(selectedGroups(['A', 'B'], els)).toEqual(['g1'])
      expect(selectedGroups(['A'], els)).toEqual([])
      expect(selectedGroups(['A', 'B', 'C', 'D', 'E'], els)).toEqual(['g1', 'g2'])
      expect(selectedGroups(['A', 'B', 'C'], els)).toEqual(['g1'])
      expect(selectedGroups(['E'], els)).toEqual([])
      expect(selectedGroups([], els)).toEqual([])
    })

    it('nested groups: the outermost one the selection holds whole', () => {
      // g1 inside g2 (innermost first, as Excalidraw's groupIds run)
      const els = [g('A', ['g1', 'g2']), g('B', ['g1', 'g2']), g('C', ['g2']), g('D', [])]
      expect(selectedGroups(['A', 'B', 'C'], els)).toEqual(['g2'])
      // the inner group alone (editing inside the outer one)
      expect(selectedGroups(['A', 'B'], els)).toEqual(['g1'])
      expect(selectedGroups(['A', 'C'], els)).toEqual([])
    })

    it('a deleted member does not count, a live one that is not selected does', () => {
      const els = [g('A', ['g1']), g('B', ['g1']), g('C', ['g1'], { isDeleted: true })]
      expect(selectedGroups(['A', 'B'], els)).toEqual(['g1'])
      const locked = [g('A', ['g1']), g('B', ['g1'], { locked: true })]
      // the restore leaves a locked member out of the selection: the group is not selected whole
      expect(selectedGroups(['A'], locked)).toEqual([])
    })

    it('an element of two selected groups contributes the outer one only', () => {
      const els = [g('A', ['g1', 'g2']), g('B', ['g1', 'g2'])]
      expect(selectedGroups(['A', 'B'], els)).toEqual(['g2'])
    })
  })

  const seed = () => [
    stored(rect('A', 'a0', { groupIds: ['g1'] })),
    stored(rect('B', 'a1', { x: 300, groupIds: ['g1'] })),
    stored(rect('C', 'a2', { x: 600 })),
  ]

  it('undo and redo hand the group to `select` with its members', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['A', 'B'])
    // move the group: both members, selected as a group
    a.edit(
      (m) => {
        for (const id of ['A', 'B']) m.set(id, bump(m.get(id) as never, { y: 50 }))
      },
      { selectedElementIds: ['A', 'B'] },
    )
    expect(u.ctl.boundary()).not.toBeNull()
    // the person clicks away: the group's selection is gone
    u.engineSelects([])
    u.ctl.undo()
    expect(a.get('A')?.y).toBe(0)
    expect(u.selects).toEqual([{ ids: ['A', 'B'], groups: ['g1'] }])
    u.engineSelects([])
    u.ctl.redo()
    expect(a.get('A')?.y).toBe(50)
    expect(u.selects.at(-1)).toEqual({ ids: ['A', 'B'], groups: ['g1'] })
  })

  it('members selected without the group (a lone member, or another element) come back without it', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['A', 'C'])
    a.change('C', { y: 20 }, { selectedElementIds: ['A', 'C'] })
    u.ctl.boundary()
    u.engineSelects([])
    u.ctl.undo()
    expect(u.selects).toEqual([{ ids: ['A', 'C'], groups: [] }])
  })

  it('Ctrl+G: the undo ungroups and restores the members, the redo groups them and restores the group', () => {
    const h = createHarness({ seed: [stored(rect('A', 'a0')), stored(rect('B', 'a1', { x: 300 }))] })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['A', 'B'])
    a.edit(
      (m) => {
        for (const id of ['A', 'B']) m.set(id, bump(m.get(id) as never, { groupIds: ['g9'] }))
      },
      { selectedElementIds: ['A', 'B'] },
    )
    expect(u.ctl.boundary()).not.toBeNull()
    u.engineSelects([])
    u.ctl.undo()
    expect(a.get('A')?.groupIds).toEqual([])
    // ungrouped again: nothing to select as a group
    expect(u.selects).toEqual([{ ids: ['A', 'B'], groups: [] }])
    u.engineSelects([])
    u.ctl.redo()
    expect(a.get('A')?.groupIds).toEqual(['g9'])
    expect(u.selects.at(-1)).toEqual({ ids: ['A', 'B'], groups: ['g9'] })
  })

  it('a member bob locked since: the rest comes back as members, not as the group', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['A', 'B'])
    a.edit(
      (m) => {
        for (const id of ['A', 'B']) m.set(id, bump(m.get(id) as never, { y: 50 }))
      },
      { selectedElementIds: ['A', 'B'] },
    )
    u.ctl.boundary()
    h.settle()
    b.change('B', { locked: true })
    h.settle()
    u.engineSelects([])
    u.ctl.undo()
    expect(u.selects.at(-1)).toEqual({ ids: ['A'], groups: [] })
  })

  it('a selection that is already the one to restore is left alone, groups or not (no select call)', () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const u = undoFor(a)
    u.engineSelects(['A', 'B'])
    a.edit(
      (m) => {
        for (const id of ['A', 'B']) m.set(id, bump(m.get(id) as never, { y: 50 }))
      },
      { selectedElementIds: ['A', 'B'] },
    )
    u.ctl.boundary()
    u.ctl.undo()
    expect(u.selects).toEqual([])
  })
})
