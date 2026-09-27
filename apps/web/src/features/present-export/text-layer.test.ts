import { frame, geo, image, note, text } from '@draftroom/board-ops/test-fixtures'
import type { TLShape } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { placedTextFor } from './text-layer.ts'

const box = { x: 110, y: 220, w: 200, h: 200 }
const origin = { x: 100, y: 200 }

describe('placedTextFor', () => {
  it('places note text centred with the label font size and padding, relative to the page origin', () => {
    const n = note('n', 'Big idea', {})
    expect(placedTextFor(n, box, origin)).toEqual({
      text: 'Big idea',
      x: 10,
      y: 20,
      w: 200,
      h: 200,
      fontSizePx: 22,
      align: 'middle',
      verticalAlign: 'middle',
      inset: 16,
    })
  })

  it('uses the text size style, scale and alignment of text shapes', () => {
    const t = text('t', 'Heading', {}) as TLShape & { props: Record<string, unknown> }
    const big = { ...t, props: { ...t.props, size: 'xl', scale: 2, textAlign: 'end' } } as TLShape
    const placed = placedTextFor(big, box, origin)
    expect(placed?.fontSizePx).toBe(88)
    expect(placed?.align).toBe('end')
    expect(placed?.verticalAlign).toBe('start')
  })

  it('applies a note auto-shrink adjustment', () => {
    const n = note('n', 'Lots of text', {}) as TLShape & { props: Record<string, unknown> }
    const shrunk = { ...n, props: { ...n.props, fontSizeAdjustment: 0.5 } } as TLShape
    expect(placedTextFor(shrunk, box, origin)?.fontSizePx).toBe(11)
  })

  it('reads geo labels and legacy alignment values', () => {
    const g = geo('g', 'Label', {}) as TLShape & { props: Record<string, unknown> }
    const legacy = { ...g, props: { ...g.props, align: 'start-legacy', verticalAlign: 'end' } } as TLShape
    const placed = placedTextFor(legacy, box, origin)
    expect(placed?.align).toBe('start')
    expect(placed?.verticalAlign).toBe('end')
  })

  it('skips frames, images and shapes without text', () => {
    expect(placedTextFor(frame('f', 'Title'), box, origin)).toBeNull()
    expect(placedTextFor(image('i', 'asset:x', { altText: 'a photo' }), box, origin)).toBeNull()
    expect(placedTextFor(note('empty', '   '), box, origin)).toBeNull()
  })
})
