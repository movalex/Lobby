// K2-7 (wave K, UXD-09): the selection's quick actions (the selection bar) never sit over the style panel, and an
// image selection's style panel is a single row. Since wave M (M1-3) the bar is placed by placePopover: it slides
// along its side clear of the panel (and the rest of the chrome) instead of a K2-7 'left of the panel' rule.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasElement, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { type OverlayRect, placeSelectionBar, SELBAR_GAP } from './SelectionBar.tsx'
import { StylePanelBody, summaryKind } from './StylePanel.tsx'

const overlaps = (a: OverlayRect, b: OverlayRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The bar's box for a placement (it is drawn translateX(-50%) around `left`). */
const barBox = (p: { left: number; top: number }, w: number, h: number): OverlayRect => ({
  x: p.left - w / 2,
  y: p.top,
  w,
  h,
})

describe('placeSelectionBar: the quick actions keep clear of the style panel (K2-7, M1-3)', () => {
  // a 1392 x 852 canvas; the style panel at the top right (216 px wide, 12 px from the edges)
  const vw = 1392
  const vh = 852
  const panel: OverlayRect = { x: vw - 12 - 216, y: 12, w: 216, h: 450 }
  const w = 180
  const h = 38
  const shape = (cx: number, top: number): OverlayRect => ({ x: cx - 60, y: top - 100, w: 120, h: 100 })

  it('under the selection, centred, when it is clear of the panel', () => {
    const p = placeSelectionBar({ anchor: shape(500, 300), w, h, vw, vh, obstacles: [panel] })
    expect(p).toEqual({ left: 500, top: 300 + SELBAR_GAP, side: 'below', fits: true })
  })

  it('a shape near the right edge: the bar would cover the panel, so it slides left of it, at the same height', () => {
    const p = placeSelectionBar({ anchor: shape(vw - 120, 200), w, h, vw, vh, obstacles: [panel] })
    expect(p.side).toBe('below')
    expect(p.fits).toBe(true)
    expect(overlaps(barBox(p, w, h), panel)).toBe(false)
    expect(barBox(p, w, h).x + w).toBeLessThanOrEqual(panel.x - 8)
    expect(p.top).toBe(200 + SELBAR_GAP)
  })

  it('a tablet canvas (700 px): a wide bar under the panel slides left of it, never over it', () => {
    const tablet = { x: 700 - 12 - 216, y: 12, w: 216, h: 450 }
    const p = placeSelectionBar({
      anchor: { x: 560, y: 100, w: 80, h: 60 },
      w: 400,
      h,
      vw: 700,
      vh,
      obstacles: [tablet],
    })
    expect(p.fits).toBe(true)
    expect(p.side).toBe('below')
    expect(overlaps(barBox(p, 400, h), tablet)).toBe(false)
  })

  it('nowhere clear of the panel (a canvas it fills): says so (the bar then folds), and covers the least', () => {
    const narrow = { x: 40, y: 12, w: 216, h: 300 }
    const o = { anchor: { x: 120, y: 60, w: 60, h: 40 }, w: 240, h, vw: 300, vh, obstacles: [narrow] }
    const p = placeSelectionBar(o)
    expect(p.fits).toBe(false)
    expect(placeSelectionBar({ ...o, prev: p })).toEqual(p)
  })

  it('no panel (nothing to style): the usual place', () => {
    expect(placeSelectionBar({ anchor: shape(vw - 120, 200), w, h, vw, vh, obstacles: [] })).toMatchObject({
      left: vw - 120,
      side: 'below',
    })
  })
})

describe('an image selection: a single-row style panel (K2-7)', () => {
  const image = {
    id: 'img1',
    type: 'image',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    angle: 0,
    groupIds: [],
    frameId: null,
    containerId: null,
    isDeleted: false,
    locked: false,
    opacity: 100,
    customData: undefined,
  } as unknown as CanvasElement

  it('says what is selected and holds the opacity slider only, in one row', () => {
    const canvas = {
      selection: ['img1'],
      get: (id: string) => (id === 'img1' ? image : undefined),
      items: () => [image],
      readOnly: () => false,
      tool: () => 'select',
      isHidden: () => false,
      styles: { of: () => ({ opacity: 100 }), next: () => ({}) },
    }
    const html = renderToStaticMarkup(
      createElement(StylePanelBody, { ctx: { canvas } as unknown as CanvasFeatureContext }),
    )
    expect(html).toContain('data-summary="image"')
    expect(html).toContain('cux-style--summary')
    expect(html).toContain('>Image<')
    expect(html).toContain('data-testid="style.opacity"')
    // nothing else: no colour, fill, dash, size or font rows
    for (const id of ['style.color', 'style.fill', 'style.dash', 'style.size', 'style.font'])
      expect(html, id).not.toContain(`data-testid="${id}"`)
  })

  it('names images and files', () => {
    expect(summaryKind([image])).toBe('Image')
    expect(summaryKind([image, { ...image, id: 'i2' } as CanvasElement])).toBe('2 images')
  })
})
