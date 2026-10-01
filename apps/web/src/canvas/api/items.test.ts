import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../port.ts'
import {
  arrowEnds,
  arrowsOf,
  childrenOf,
  containerOf,
  contentItems,
  groupMembers,
  itemKindOf,
  labelOf,
  lobbyEntries,
  lobbyValue,
  outerGroupOf,
  textOf,
} from './items.ts'

const el = (p: Record<string, unknown>): CanvasElement =>
  ({
    id: 'x',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    ...p,
  }) as unknown as CanvasElement

describe('canvas api items', () => {
  const note = el({
    id: 'n',
    type: 'stickynote',
    boundElements: [
      { id: 'n.t', type: 'text' },
      { id: 'a', type: 'arrow' },
    ],
  })
  const label = el({ id: 'n.t', type: 'text', containerId: 'n', originalText: 'Hello' })
  const free = el({ id: 't', type: 'text', originalText: 'Free', frameId: 'f' })
  const frame = el({ id: 'f', type: 'frame', name: 'Ideas' })
  const arrow = el({
    id: 'a',
    type: 'arrow',
    startBinding: { elementId: 'n' },
    endBinding: null,
    groupIds: ['g1', 'g2'],
  })
  const hl = el({ id: 'h', type: 'freedraw', customData: { lobby: { kind: 'highlight' } } })
  const card = el({
    id: 'c',
    type: 'image',
    customData: { lobby: { file: { kind: 'pdf' }, 'tag:red': true, 'tag:x': 1 } },
  })
  const photo = el({ id: 'p', type: 'image', customData: { lobby: { file: { kind: 'image' } } } })
  const all = [note, label, free, frame, arrow, hl, card, photo]
  const get = (id: string) => all.find((e) => e.id === id)

  it('kinds', () => {
    expect(all.map(itemKindOf)).toEqual([
      'note',
      'label',
      'text',
      'frame',
      'arrow',
      'highlight',
      'file-card',
      'image',
    ])
  })

  it('labels, containers and text', () => {
    expect(labelOf(note, get)?.id).toBe('n.t')
    expect(containerOf(label, get).id).toBe('n')
    expect(textOf(note, get)).toBe('Hello')
    expect(textOf(free, get)).toBe('Free')
    expect(textOf(frame, get)).toBe('Ideas')
    expect(textOf(arrow, get)).toBe('')
  })

  it('bindings, frames, groups, content', () => {
    expect(arrowsOf(note)).toEqual(['a'])
    expect(arrowEnds(arrow)).toEqual({ start: 'n', end: null })
    expect(childrenOf('f', all)).toEqual(['t'])
    expect(outerGroupOf(arrow)).toBe('g2')
    expect(groupMembers('g1', all)).toEqual(['a'])
    expect(contentItems(all).map((e) => e.id)).not.toContain('n.t')
  })

  it('customData.lobby readers', () => {
    expect(lobbyValue(hl, 'kind')).toBe('highlight')
    expect(lobbyEntries(card, 'tag:')).toEqual([
      { suffix: 'red', value: true },
      { suffix: 'x', value: 1 },
    ])
  })
})
