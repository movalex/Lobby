import { describe, expect, it } from 'vitest'
import { selectedGroups } from '../history/controller.ts'
import { rect } from '../sync/testing/elements.ts'
import type { SceneElement } from '../sync/types.ts'
import { type GroupedElement, groupsWithoutHiddenMembers } from './select-groups.ts'

// F2 (wave F; the E2 follow-up): the session's `select` for an undo or a redo hands the engine the groups of
// the restored selection. The port's `select` leaves a hidden id out of the selection, but a group naming the
// hidden member would still select it (the group box, the move): such a group must not be handed over.

const el = (id: string, groupIds: string[], o: Partial<GroupedElement> = {}): GroupedElement => ({
  id,
  groupIds,
  ...o,
})
const hiddenIds =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id)

describe('groupsWithoutHiddenMembers', () => {
  const scene = [el('A', ['g1']), el('B', ['g1']), el('C', ['g2']), el('D', ['g2']), el('E', [])]

  it('a group with a hidden member is left out; one with none stays', () => {
    expect(groupsWithoutHiddenMembers(['g1', 'g2'], scene, hiddenIds('B'))).toEqual(['g2'])
    expect(groupsWithoutHiddenMembers(['g1', 'g2'], scene, hiddenIds('C', 'D'))).toEqual(['g1'])
    expect(groupsWithoutHiddenMembers(['g1', 'g2'], scene, hiddenIds('A', 'D'))).toEqual([])
  })

  it('nothing hidden: the groups as they came, the same array', () => {
    const groups = ['g1', 'g2']
    expect(groupsWithoutHiddenMembers(groups, scene, () => false)).toBe(groups)
    expect(groupsWithoutHiddenMembers([], scene, hiddenIds('A'))).toEqual([])
  })

  it('a hidden element in no group, or in a group that was not asked about, changes nothing', () => {
    expect(groupsWithoutHiddenMembers(['g1'], scene, hiddenIds('E', 'C'))).toEqual(['g1'])
  })

  it('a deleted hidden member does not count (it is neither drawn nor moved with the group)', () => {
    const els = [el('A', ['g1']), el('B', ['g1'], { isDeleted: true }), el('C', ['g1'])]
    expect(groupsWithoutHiddenMembers(['g1'], els, hiddenIds('B'))).toEqual(['g1'])
    expect(groupsWithoutHiddenMembers(['g1'], [...els, el('Z', ['g1'])], hiddenIds('Z'))).toEqual([])
  })

  it('a member of nested groups hides every group it is in, the inner ones too', () => {
    const els = [el('A', ['in', 'out']), el('B', ['in', 'out']), el('C', ['out']), el('D', ['solo'])]
    expect(groupsWithoutHiddenMembers(['out'], els, hiddenIds('C'))).toEqual([])
    expect(groupsWithoutHiddenMembers(['in', 'out'], els, hiddenIds('C'))).toEqual(['in'])
    expect(groupsWithoutHiddenMembers(['in', 'out', 'solo'], els, hiddenIds('A'))).toEqual(['solo'])
  })

  it('asks the registry only about members of the groups in question', () => {
    const asked: string[] = []
    groupsWithoutHiddenMembers(['g1'], scene, (id) => {
      asked.push(id)
      return false
    })
    expect(asked.sort()).toEqual(['A', 'B'])
  })

  it('an element without groupIds (an engine element that has none) is skipped', () => {
    expect(groupsWithoutHiddenMembers(['g1'], [{ id: 'A' }, el('B', ['g1'])], hiddenIds('A'))).toEqual(['g1'])
  })
})

describe('an undo of a step made on a group with a hidden member (the history side, then the session’s filter)', () => {
  const g = (id: string, groupIds: string[]) => rect(id, `a${id}`, { groupIds }) as SceneElement

  it('the controller names the group; the session’s filter drops it, so the restore selects the visible members only', () => {
    const elements = [g('A', ['g1']), g('B', ['g1']), g('C', [])]
    // what the controller hands `select`: both members selected, so the group (it does not know B is hidden)
    const groups = selectedGroups(['A', 'B'], elements)
    expect(groups).toEqual(['g1'])
    expect(groupsWithoutHiddenMembers(groups, elements, hiddenIds('B'))).toEqual([])
    // the same step with nothing hidden still restores the group as a group
    expect(groupsWithoutHiddenMembers(groups, elements, () => false)).toEqual(['g1'])
  })
})
