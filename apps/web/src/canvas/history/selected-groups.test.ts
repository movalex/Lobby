import { describe, expect, it } from 'vitest'
import { bump } from '../sync/headless/scene.ts'
import { rect } from '../sync/testing/elements.ts'
import { stored } from '../sync/testing/fakeRoom.ts'
import { createHarness } from '../sync/testing/harness.ts'
import type { SceneElement } from '../sync/types.ts'
import { selectedGroups, UndoController } from './controller.ts'

// Wave E (E2, the D3 review's follow-up to D3-2a): a restored selection names a group only when Excalidraw
// would select that group itself. Excalidraw's `selectGroup` (@excalidraw/element groups.ts) refuses a group
// with fewer than 2 elements, so a group whose other members were deleted comes back as its lone member: before,
// `selectedGroups(['A'], [A in g1, B in g1 deleted])` returned ['g1'] and the engine was handed
// `selectedGroupIds: { g1: true }` for one element (a group-selected look Excalidraw never produces).

const g = (id: string, groupIds: string[], o: Record<string, unknown> = {}) =>
  rect(id, `a${id.length}${id}`, { groupIds, ...o }) as SceneElement

describe('selectedGroups: a group with fewer than 2 live members is not selected', () => {
  it('one live member (the other deleted): the member alone, not its group', () => {
    const els = [g('A', ['g1']), g('B', ['g1'], { isDeleted: true })]
    expect(selectedGroups(['A'], els)).toEqual([])
    // with a second live member the group is selected as before
    const two = [g('A', ['g1']), g('B', ['g1'], { isDeleted: true }), g('C', ['g1'])]
    expect(selectedGroups(['A', 'C'], two)).toEqual(['g1'])
  })

  it('a group of one element (never a group Excalidraw makes, but a scene may hold one) is not selected', () => {
    expect(selectedGroups(['A'], [g('A', ['solo']), g('B', [])])).toEqual([])
  })

  it('nested groups: an inner group down to one live member leaves the outer one, if it still has 2', () => {
    // g1 inside g2: B (g1's other member) is deleted; C keeps g2 at 2 live members
    const els = [g('A', ['g1', 'g2']), g('B', ['g1', 'g2'], { isDeleted: true }), g('C', ['g2'])]
    expect(selectedGroups(['A', 'C'], els)).toEqual(['g2'])
    // the inner group alone (editing inside the outer one) is down to A: nothing
    expect(selectedGroups(['A'], els)).toEqual([])
    // and with C deleted too, the outer group is down to A as well
    const lone = [
      g('A', ['g1', 'g2']),
      g('B', ['g1', 'g2'], { isDeleted: true }),
      g('C', ['g2'], { isDeleted: true }),
    ]
    expect(selectedGroups(['A'], lone)).toEqual([])
  })

  it('an undo after bob deleted the other member restores the lone member without the group', () => {
    const h = createHarness({
      seed: [
        stored(rect('A', 'a0', { groupIds: ['g1'] })),
        stored(rect('B', 'a1', { x: 300, groupIds: ['g1'] })),
      ],
    })
    const a = h.client('alice')
    const b = h.client('bob')
    h.settle()
    const selects: { ids: string[]; groups: string[] }[] = []
    const ctl = new UndoController({
      core: a.core,
      scene: a.scene,
      bump,
      select: (ids, groups) => {
        selects.push({ ids: [...ids], groups: [...groups] })
        a.gesture({ selectedElementIds: [...ids] })
      },
    })
    a.gesture({ selectedElementIds: ['A', 'B'] })
    ctl.boundary()
    // alice moves the group (both members, selected as a group)
    a.edit(
      (m) => {
        for (const id of ['A', 'B']) m.set(id, bump(m.get(id) as never, { y: 50 }))
      },
      { selectedElementIds: ['A', 'B'] },
    )
    expect(ctl.boundary()).not.toBeNull()
    h.settle()
    // bob deletes B; alice clicks away
    b.change('B', { isDeleted: true })
    h.settle()
    a.gesture({ selectedElementIds: [] })
    ctl.boundary()
    ctl.undo()
    expect(a.get('A')?.y).toBe(0)
    expect(selects.at(-1)).toEqual({ ids: ['A'], groups: [] })
  })
})
