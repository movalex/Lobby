import { describe, expect, it } from 'vitest'
import { boardContents, contentsSummary, flatten } from './contents.ts'
import { clip, describeElement, describeSelection, editorLabel, kindLabel } from './describe.ts'
import { readingOrder } from './reading-order.ts'
import { el, frame, input, note, text } from './test-kit.ts'

const board = [
  frame('f', 0, 0, 800, 500, 'Retro'),
  ...note('in-1', 100, 100, 'Keep me', { frameId: 'f' }),
  text('in-2', 400, 100, 'Stop', { frameId: 'f' }),
  ...note('loose', 1000, 100, 'Faster builds'),
  ...note('empty', 1300, 100, ''),
  el({ id: 'r', type: 'rectangle', x: 0, y: 700 }),
  el({ id: 'e', type: 'ellipse', x: 200, y: 700 }),
  el({ id: 'g1', type: 'diamond', x: 400, y: 700, groupIds: ['grp'] }),
  el({ id: 'g2', type: 'arrow', x: 600, y: 700, groupIds: ['grp'] }),
  el({
    id: 'pic',
    type: 'image',
    x: 1000,
    y: 700,
    customData: { lobby: { file: { kind: 'pdf', name: 'Plan.pdf' } } },
  }),
]
const get = (id: string) => board.find((e) => e.id === id)

function say(selection: string[]) {
  const level = selection.every((id) => get(id)?.frameId === 'f') && selection.length ? 'f' : null
  return describeSelection(selection, {
    get,
    order: readingOrder(input(board), level),
    frame: level ? (get(level) ?? null) : null,
  })
}

describe('what the live region says', () => {
  it('names each kind as Lobby does (Connector, Pen, Sticky note)', () => {
    expect(kindLabel(el({ type: 'stickynote' }))).toBe('Sticky note')
    expect(kindLabel(el({ type: 'arrow' }))).toBe('Connector')
    expect(kindLabel(el({ type: 'freedraw' }))).toBe('Pen')
    expect(kindLabel(el({ type: 'freedraw', customData: { lobby: { kind: 'highlight' } } }))).toBe(
      'Highlight',
    )
    expect(kindLabel(el({ type: 'diamond' }))).toBe('Diamond')
    expect(kindLabel(el({ type: 'frame' }))).toBe('Frame')
    expect(kindLabel(el({ type: 'embeddable' }))).toBe('Item')
  })

  it('"<Kind>: <words>. i of n" at the top level; a frame name, a file name, no words', () => {
    expect(say(['loose'])).toBe('Sticky note: Faster builds. 2 of 7')
    expect(say(['f'])).toBe('Frame: Retro. 1 of 7')
    expect(say(['r'])).toBe('Rectangle. 4 of 7')
    expect(say(['empty'])).toBe('Sticky note. 3 of 7')
    expect(describeElement(get('pic') as never, get)).toBe('File: Plan.pdf')
  })

  it('inside a frame, the position is within the frame', () => {
    expect(say(['in-1'])).toBe('Sticky note: Keep me. 1 of 2 in Retro')
    expect(say(['in-2'])).toBe('Text: Stop. 2 of 2 in Retro')
  })

  it('a label counts as its note; a group is one stop; several are counted', () => {
    expect(say(['loose-label'])).toBe('Sticky note: Faster builds. 2 of 7')
    expect(say(['g1', 'g2'])).toBe('Group of 2 shapes. 6 of 7')
    expect(say(['r', 'e'])).toBe('2 shapes selected')
    expect(say([])).toBe('')
    expect(say(['nope'])).toBe('')
  })

  it('W5-59: the open text editor is named after what it edits (a label as its container)', () => {
    expect(editorLabel(get('loose'), get)).toBe('Sticky note text')
    expect(editorLabel(get('loose-label'), get)).toBe('Sticky note text')
    expect(editorLabel(get('in-2'), get)).toBe('Text')
    expect(editorLabel(get('r'), get)).toBe('Rectangle text')
    expect(editorLabel(get('f'), get)).toBe('Frame name')
    expect(editorLabel(undefined, get)).toBe('Text')
  })

  it('long words are clipped', () => {
    expect(clip('x'.repeat(300)).length).toBe(200)
    expect(clip('short')).toBe('short')
  })
})

describe('the content list', () => {
  it('notes, frames and texts in reading order, a frame holding its own', () => {
    const c = boardContents(input(board))
    expect(c.nodes.map((n) => [n.kind, n.label, n.children.map((ch) => ch.label)])).toEqual([
      ['frame', 'Frame: Retro', ['Sticky note: Keep me', 'Text: Stop']],
      ['note', 'Sticky note: Faster builds', []],
      ['note', 'Sticky note', []],
    ])
    expect(c.counts).toEqual({ notes: 3, frames: 1, texts: 1 })
    expect(contentsSummary(c.counts)).toBe('3 notes, 1 frame, 1 text')
    expect(flatten(c.nodes).map((r) => [r.node.id, r.depth])).toEqual([
      ['f', 0],
      ['in-1', 1],
      ['in-2', 1],
      ['loose', 0],
      ['empty', 0],
    ])
    expect(flatten(c.nodes, 2)).toHaveLength(2)
  })

  it('an empty board; hidden (collapsed) notes are left out', () => {
    expect(contentsSummary(boardContents(input([])).counts)).toBe(
      'No notes, frames or text on this board yet.',
    )
    const c = boardContents(input(board, ['loose', 'in-1']))
    expect(c.counts).toEqual({ notes: 1, frames: 1, texts: 1 })
  })

  it('notes inside a group are listed one by one', () => {
    const grouped = [
      ...note('a', 300, 0, 'Second', { groupIds: ['g'] }),
      ...note('b', 0, 0, 'First', { groupIds: ['g'] }),
    ]
    expect(boardContents(input(grouped)).nodes.map((n) => n.label)).toEqual([
      'Sticky note: First',
      'Sticky note: Second',
    ])
  })
})
