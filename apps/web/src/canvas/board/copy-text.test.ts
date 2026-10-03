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
  height?: number
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
        height: s.height ?? 100,
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

  it('CR-3A-4: notes on one visual row read left to right even when one sits a few pixels higher', () => {
    const c = canvasOf(
      [
        // the right-hand notes are 12 and 4 px higher than the left-hand one: the same row
        { id: 'left', text: 'left note', x: 0, y: 112 },
        { id: 'right', text: 'right note', x: 300, y: 100 },
        { id: 'far-right', text: 'far right note', x: 600, y: 108 },
        // the next row, 200 px lower
        { id: 'below-b', text: 'below, right', x: 300, y: 300 },
        { id: 'below-a', text: 'below, left', x: 0, y: 296 },
      ],
      ['far-right', 'right', 'below-b', 'left', 'below-a'],
    )
    expect(selectionText(c)).toBe('left note\nright note\nfar right note\nbelow, left\nbelow, right')
  })

  it('the row tolerance is half the median height: a note half a row higher is still the row, more is the row above', () => {
    const rows = (dy: number) =>
      selectionText(
        canvasOf(
          [
            { id: 'a', text: 'a', x: 0, y: 0, height: 120 },
            { id: 'b', text: 'b', x: 300, y: -dy, height: 120 },
          ],
          ['a', 'b'],
        ),
      )
    // 60 = half the median: one row, left to right (a, b); 61 above: its own, earlier row (b, a)
    expect(rows(60)).toBe('a\nb')
    expect(rows(61)).toBe('b\na')
    // no heights at all: exact tops, as before
    expect(
      selectionText(
        canvasOf(
          [
            { id: 'a', text: 'a', x: 0, y: 5, height: 0 },
            { id: 'b', text: 'b', x: 300, y: 0, height: 0 },
          ],
          ['a', 'b'],
        ),
      ),
    ).toBe('b\na')
  })

  it('a staggered column is not chained into one row', () => {
    const c = canvasOf(
      [
        { id: 'c', text: 'third', x: 0, y: 120 },
        { id: 'a', text: 'first', x: 90, y: 0 },
        { id: 'b', text: 'second', x: 0, y: 60 },
      ],
      ['c', 'a', 'b'],
    )
    // tolerance 50: first (0) alone, second (60) starts the next row, third (120) a row of its own
    expect(selectionText(c)).toBe('first\nsecond\nthird')
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
