import { describe, expect, it } from 'vitest'
import { computeSelectAll, type SelectableElement } from './selectAll.ts'

const e = (id: string, extra: Partial<SelectableElement> = {}): SelectableElement => ({
  id,
  type: 'rectangle',
  isDeleted: false,
  locked: false,
  containerId: null,
  groupIds: [],
  ...extra,
})

describe("computeSelectAll (Lobby's Ctrl+A, §2.3.3)", () => {
  it("takes Excalidraw's set: live, unlocked, bound labels excluded", () => {
    const r = computeSelectAll([
      e('a'),
      e('b', { isDeleted: true }),
      e('c', { locked: true }),
      e('note', { type: 'stickynote' }),
      e('label', { type: 'text', containerId: 'note' }),
      e('free', { type: 'text' }),
    ])
    expect(Object.keys(r.selectedElementIds).sort()).toEqual(['a', 'free', 'note'])
    expect(r.selectedGroupIds).toEqual({})
  })

  it('removes elements hidden by a mind-map collapse, even as group members', () => {
    const r = computeSelectAll(
      [
        e('root'),
        e('child', { groupIds: ['g'] }),
        e('child2', { groupIds: ['g'] }),
        e('hidden', { groupIds: ['g'] }),
      ],
      new Set(['hidden']),
    )
    expect(Object.keys(r.selectedElementIds).sort()).toEqual(['child', 'child2', 'root'])
    expect(r.selectedGroupIds).toEqual({ g: true })
  })

  it('selects outermost groups, pulls in their labels and locked members, and skips single-member groups', () => {
    const r = computeSelectAll([
      e('n1', { type: 'stickynote', groupIds: ['inner', 'outer'] }),
      e('l1', { type: 'text', containerId: 'n1', groupIds: ['inner', 'outer'] }),
      e('n2', { groupIds: ['outer'], locked: true }),
      e('solo', { groupIds: ['lonely'] }),
    ])
    expect(r.selectedGroupIds).toEqual({ outer: true })
    expect(Object.keys(r.selectedElementIds).sort()).toEqual(['l1', 'n1', 'n2', 'solo'])
  })
})
