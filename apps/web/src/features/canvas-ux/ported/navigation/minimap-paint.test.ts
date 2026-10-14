// P-048 (wave P): unfilled shapes are as plain in the minimap as notes (an outline in the minimap's ink).
import { describe, expect, it } from 'vitest'
import { minimapPaint } from './Minimap.tsx'

const colors = { ink: '#6b7280', fill: '#d1d5db' }

describe('minimapPaint', () => {
  it('an unfilled rectangle, ellipse or diamond: an outline in the ink (it used to be a faint grey fill)', () => {
    for (const type of ['rectangle', 'ellipse', 'diamond'])
      expect(minimapPaint({ type, backgroundColor: 'transparent' }, colors), type).toEqual({
        fill: null,
        stroke: '#6b7280',
      })
  })
  it('a filled shape keeps its fill and gets the outline too (a light fill reads on white)', () => {
    expect(minimapPaint({ type: 'rectangle', backgroundColor: '#dce1f8' }, colors)).toEqual({
      fill: '#dce1f8',
      stroke: '#6b7280',
    })
  })
  it('texts and lines are outlined; notes and images are their fill; frames their outline', () => {
    expect(minimapPaint({ type: 'text', backgroundColor: 'transparent' }, colors).stroke).toBe('#6b7280')
    expect(minimapPaint({ type: 'arrow' }, colors).stroke).toBe('#6b7280')
    expect(minimapPaint({ type: 'stickynote', backgroundColor: '#f8e48f' }, colors)).toEqual({
      fill: '#f8e48f',
      stroke: null,
    })
    expect(minimapPaint({ type: 'image' }, colors)).toEqual({ fill: '#d1d5db', stroke: null })
    expect(minimapPaint({ type: 'frame', backgroundColor: '#fff' }, colors)).toEqual({
      fill: null,
      stroke: '#6b7280',
    })
  })
})
