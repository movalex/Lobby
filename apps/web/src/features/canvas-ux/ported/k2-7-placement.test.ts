// K2-7 (wave K, UXD-09): the selection's quick actions (the selection bar) never sit over the style panel, and an
// image selection's style panel is a single row.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasElement, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { type OverlayRect, placeSelectionBar, SELBAR_PANEL_GAP } from './SelectionBar.tsx'
import { StylePanelBody, summaryKind } from './StylePanel.tsx'

const overlaps = (a: OverlayRect, b: OverlayRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The bar's box for a placement (it is drawn translateX(-50%) around `left`). */
const barBox = (p: { left: number; top: number }, half: number, h: number): OverlayRect => ({
  x: p.left - half,
  y: p.top,
  w: half * 2,
  h,
})

describe('placeSelectionBar: the quick actions step aside for the style panel (K2-7)', () => {
  // a 1392 x 852 canvas; the style panel at the top right (216 px wide, 12 px from the edges)
  const vw = 1392
  const vh = 852
  const panel: OverlayRect = { x: vw - 12 - 216, y: 12, w: 216, h: 450 }
  const half = 90
  const h = 38

  it('under the selection, centred, when it is clear of the panel', () => {
    const p = placeSelectionBar({ cx: 500, top: 300, half, h, vw, vh, panel })
    expect(p).toEqual({ left: 500, top: 300, side: 'under' })
  })

  it('a shape near the right edge: the bar would cover the panel, so it flips to the left of it', () => {
    const p = placeSelectionBar({ cx: vw - 120, top: 200, half, h, vw, vh, panel })
    expect(p.side).toBe('left')
    expect(overlaps(barBox(p, half, h), panel)).toBe(false)
    expect(barBox(p, half, h).x + half * 2).toBeLessThanOrEqual(panel.x - SELBAR_PANEL_GAP)
    expect(p.top).toBe(200)
  })

  it('with no room on the left (a narrow canvas), it goes below the panel', () => {
    const narrow = { x: 40, y: 12, w: 216, h: 300 }
    const p = placeSelectionBar({ cx: 150, top: 100, half: 120, h, vw: 300, vh, panel: narrow })
    expect(p.side).toBe('below')
    expect(p.top).toBe(narrow.y + narrow.h + SELBAR_PANEL_GAP)
    expect(overlaps(barBox(p, 120, h), narrow)).toBe(false)
  })

  it('no panel (nothing to style): the usual place', () => {
    expect(placeSelectionBar({ cx: vw - 120, top: 200, half, h, vw, vh, panel: null }).side).toBe('under')
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
