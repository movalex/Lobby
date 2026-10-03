import { describe, expect, it } from 'vitest'
import { exportAllowedHere } from './export-allowed.ts'
import {
  elementIdOf,
  firstFrameBounds,
  previewElementCounts,
  previewTexts,
  refOfElement,
  restoredElementIds,
  restoredSelection,
  touchesDeletedElements,
} from './model.ts'

const note = (id: string, x: number, y: number, text: string, extra: Record<string, unknown> = {}) => [
  {
    id,
    type: 'stickynote',
    x,
    y,
    width: 200,
    height: 200,
    boundElements: [{ id: `${id}.t`, type: 'text' }],
    ...extra,
  },
  {
    id: `${id}.t`,
    type: 'text',
    containerId: id,
    x: x + 10,
    y: y + 90,
    width: 180,
    height: 20,
    text,
    originalText: text,
  },
]

describe('history on elements', () => {
  it('maps api object refs and element ids both ways', () => {
    expect(elementIdOf('shape:abc')).toBe('abc')
    expect(elementIdOf('abc')).toBe('abc')
    expect(refOfElement('abc')).toBe('shape:abc')
    expect(refOfElement('shape:abc')).toBe('shape:abc')
  })

  it('a change touches "Recently deleted" when anything is deleted or a listed element comes back', () => {
    const listed = new Set(['shape:a'])
    expect(touchesDeletedElements({ created: [], deleted: ['x'] }, listed)).toBe(true)
    expect(touchesDeletedElements({ created: ['a'], deleted: [] }, listed)).toBe(true)
    expect(touchesDeletedElements({ created: ['b'], deleted: [] }, listed)).toBe(false)
    expect(touchesDeletedElements({ created: [], deleted: [] }, listed)).toBe(false)
  })

  it('selects only what a restore brought back, in the server order, as element ids', () => {
    const here = new Set(['n2', 'n1'])
    expect(restoredElementIds(['shape:n1', 'shape:gone', 'shape:n2'], (id) => here.has(id))).toEqual([
      'n1',
      'n2',
    ])
  })

  it('counts objects as people see them: a note and its label are one, deleted ones none', () => {
    const els = [
      ...note('n1', 0, 0, 'One'),
      ...note('n2', 300, 0, 'Two'),
      { id: 'r', type: 'rectangle', x: 0, y: 400, width: 10, height: 10 },
      { id: 'gone', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, isDeleted: true },
    ]
    expect(previewElementCounts(els)).toEqual({ objects: 3, text: '3 objects' })
    expect(previewElementCounts([...note('n', 0, 0, 'x')]).text).toBe('1 object')
  })

  it("lists the checkpoint's words in reading order, labels where their notes are", () => {
    const els = [
      { id: 'f', type: 'frame', name: 'Sprint ideas', x: 0, y: -40, width: 900, height: 20 },
      ...note('late', 400, 100, 'Record the voiceover'),
      ...note('early', 0, 100, 'Ship the   moodboard'),
      {
        id: 't',
        type: 'text',
        text: 'Free text',
        originalText: 'Free text',
        x: 0,
        y: 500,
        width: 80,
        height: 20,
      },
      { id: 'blank', type: 'text', text: '  ', x: 0, y: 600, width: 1, height: 1 },
    ]
    expect(previewTexts(els)).toEqual([
      'Sprint ideas',
      'Ship the moodboard',
      'Record the voiceover',
      'Free text',
    ])
  })

  it('opens on the first frame in presentation order, skipped frames only when all are', () => {
    const frame = (id: string, x: number, present?: Record<string, unknown>) => ({
      id,
      type: 'frame',
      name: id,
      x,
      y: 0,
      width: 100,
      height: 80,
      customData: present ? { lobby: { present } } : undefined,
    })
    expect(firstFrameBounds([frame('b', 500), frame('a', 0)])).toEqual({ x: 0, y: 0, width: 100, height: 80 })
    expect(firstFrameBounds([frame('b', 500), frame('a', 0, { skip: true })])?.x).toBe(500)
    expect(firstFrameBounds([frame('a', 0, { skip: true })])?.x).toBe(0)
    expect(firstFrameBounds([{ id: 'r', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }])).toBeNull()
  })

  it('export is allowed unless the known policy limits this role', () => {
    expect(exportAllowedHere(null, 'editors', false)).toBe(true)
    expect(exportAllowedHere('viewer', null, false)).toBe(true)
    expect(exportAllowedHere('viewer', 'editors', false)).toBe(false)
    expect(exportAllowedHere('editor', 'editors', false)).toBe(true)
    expect(exportAllowedHere('editor', 'editors', true)).toBe(false)
    // audit L3: a name-only guest is limited under 'everyone' too; only the owner's explicit choice lets them
    expect(exportAllowedHere('viewer', 'everyone', true)).toBe(false)
    expect(exportAllowedHere('viewer', 'everyone', false)).toBe(true)
    expect(exportAllowedHere('viewer', 'everyone-including-guests', true)).toBe(true)
  })
})

describe('what a restore selects', () => {
  it('a restored frame alone, never its restored children; other restored objects stay selected', () => {
    const frameOf: Record<string, string | null> = { F: null, N1: 'F', N2: 'F', A: null, N3: 'G' }
    const at = (id: string) => frameOf[id] ?? null
    expect(restoredSelection(['F', 'N1', 'N2'], at)).toEqual(['F'])
    // a note restored into a frame that stayed on the board (G) is selected with its connector
    expect(restoredSelection(['A', 'N3'], at)).toEqual(['A', 'N3'])
    expect(restoredSelection([], at)).toEqual([])
  })
})
