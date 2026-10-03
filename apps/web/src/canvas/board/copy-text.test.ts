// CR-3A-4: the text a read-only role copies (copy-text.ts).
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../port.ts'
import { type CopyCanvas, MAX_COPY_CHARS, selectionText } from './copy-text.ts'

interface Spec {
  id: string
  type?: string
  x?: number
  y?: number
  text?: string
  frameId?: string | null
  containerId?: string | null
  deleted?: boolean
}

/** A canvas of these elements with `selection` selected and `hidden` ids collapsed. */
function canvasOf(specs: Spec[], selection: string[], hidden: string[] = []): CopyCanvas {
  const els = specs.map(
    (s) =>
      ({
        id: s.id,
        type: s.type ?? 'stickynote',
        x: s.x ?? 0,
        y: s.y ?? 0,
        frameId: s.frameId ?? null,
        containerId: s.containerId ?? null,
        isDeleted: s.deleted ?? false,
      }) as unknown as CanvasElement,
  )
  const byId = new Map(els.map((e) => [e.id, e]))
  const text = new Map(specs.map((s) => [s.id, s.text ?? '']))
  return {
    selection,
    get: (id) => byId.get(id),
    items: () => els.filter((e) => !e.isDeleted),
    isHidden: (id) => hidden.includes(id),
    text: { of: (id) => text.get(id) ?? '' },
  }
}

describe('selectionText (what a viewer copies)', () => {
  it('copies a note’s words', () => {
    expect(selectionText(canvasOf([{ id: 'n', text: 'Call the client' }], ['n']))).toBe('Call the client')
  })

  it('gives nothing for no selection, an item without words, or an unknown id', () => {
    const c = canvasOf([{ id: 'r', type: 'rectangle' }], [])
    expect(selectionText(c)).toBe('')
    expect(selectionText(canvasOf([{ id: 'r', type: 'rectangle' }], ['r']))).toBe('')
    expect(selectionText(canvasOf([{ id: 'r' }], ['nope']))).toBe('')
  })

  it('reads several items top to bottom, then left to right, one per line', () => {
    const c = canvasOf(
      [
        { id: 'b', text: 'second row, left', x: 0, y: 300 },
        { id: 'c', text: 'first row, right', x: 400, y: 0 },
        { id: 'a', text: 'first row, left', x: 0, y: 0 },
      ],
      ['b', 'c', 'a'],
    )
    expect(selectionText(c)).toBe('first row, left\nfirst row, right\nsecond row, left')
  })

  it('counts a selected label as its container, once', () => {
    const specs: Spec[] = [
      { id: 'box', type: 'rectangle', text: 'Label words' },
      { id: 'lbl', type: 'text', text: 'Label words', containerId: 'box' },
    ]
    expect(selectionText(canvasOf(specs, ['lbl', 'box']))).toBe('Label words')
    expect(selectionText(canvasOf(specs, ['lbl']))).toBe('Label words')
  })

  it('a selected frame gives its name and the words of what is inside it', () => {
    const c = canvasOf(
      [
        { id: 'f', type: 'frame', text: 'Retro', x: 0, y: 0 },
        { id: 'n1', text: 'Keep', x: 20, y: 40, frameId: 'f' },
        { id: 'n2', text: 'Stop', x: 220, y: 40, frameId: 'f' },
        { id: 'out', text: 'Elsewhere', x: 2000, y: 40 },
        { id: 'inner', type: 'text', text: 'Keep', containerId: 'n1', frameId: 'f', x: 30, y: 50 },
      ],
      ['f'],
    )
    expect(selectionText(c)).toBe('Retro\nKeep\nStop')
  })

  it('leaves out deleted and hidden (collapsed) items', () => {
    const c = canvasOf(
      [
        { id: 'a', text: 'shown', y: 0 },
        { id: 'b', text: 'deleted', y: 100, deleted: true },
        { id: 'c', text: 'collapsed', y: 200 },
      ],
      ['a', 'b', 'c'],
      ['c'],
    )
    expect(selectionText(c)).toBe('shown')
  })

  it('trims each piece, skips blanks and stops at the clipboard cap', () => {
    expect(
      selectionText(
        canvasOf(
          [
            { id: 'a', text: '  hello \n', y: 0 },
            { id: 'b', text: '   ', y: 10 },
          ],
          ['a', 'b'],
        ),
      ),
    ).toBe('hello')
    const big = 'x'.repeat(MAX_COPY_CHARS + 50)
    expect(selectionText(canvasOf([{ id: 'a', text: big }], ['a'])).length).toBe(MAX_COPY_CHARS)
  })
})
