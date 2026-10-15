// Wave Q integration: every tile of the Shapes tab draws a picture. Each of the built-in pieces (today's and the wave Q
// kits) is built from its real elements, rendered as the Elements panel's tile, and its drawing must hold at least one
// shape, and every element that is not a bound label must draw (an element type Preview.tsx has no case for would
// leave a blank tile: arrows and sticky notes did before this test).
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { instantiatePiece, PIECES } from '@draftroom/templates/pieces'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { drawn, type PreviewEl } from '../pieces/Preview.tsx'
import { pieceTile } from './model.ts'
import { TileView } from './Tiles.tsx'

// the Node side of the engine's text layout (the pieces measure their words)
installServerTextMetrics()

const SHAPES = /<(rect|ellipse|polygon|polyline|path)\b(?![^>]*dr-pp-text)/g

const built = PIECES.map((info) => ({
  info,
  elements: instantiatePiece(info.id, { origin: { x: 0, y: 0 } }).elements as unknown as PreviewEl[],
}))

function tileHtml(info: (typeof PIECES)[number], elements: readonly PreviewEl[]): string {
  return renderToStaticMarkup(
    createElement(TileView, {
      tile: pieceTile(info),
      domId: `t-${info.id}`,
      active: false,
      disabled: false,
      favourite: false,
      icons: { status: 'none' },
      previews: new Map([[info.id, elements]]),
      workspaceId: 'w-test',
      iconInk: null,
      onPick: () => undefined,
      onPoint: () => undefined,
      onStar: () => undefined,
      onActions: () => undefined,
    }),
  )
}

describe('the Shapes tab’s tiles', () => {
  it('cover all 84 built-in pieces', () => {
    expect(PIECES.length).toBe(84)
  })

  it.each(built.map((b) => [b.info.id, b] as const))('%s draws every element it has', (_id, { elements }) => {
    const blank = elements
      .filter((el) => !(el.type === 'text' && el.containerId))
      .filter((el) => drawn(el, 0) == null)
      .map((el) => el.type)
    expect(blank).toEqual([])
  })

  it.each(built.map((b) => [b.info.id, b] as const))('%s renders a tile with a drawing', (id, b) => {
    const html = tileHtml(b.info, b.elements)
    const svg = html.match(new RegExp(`<svg[^>]*data-piece-preview="${id}"[^>]*>(.*?)</svg>`))
    expect(svg, 'the tile holds the piece’s drawing').not.toBeNull()
    expect((svg?.[1] ?? '').match(SHAPES)?.length ?? 0).toBeGreaterThan(0)
  })

  it('draws an arrow with its heads, curved when it has roundness', () => {
    const arrow = (over: Partial<PreviewEl>): PreviewEl => ({
      type: 'arrow',
      x: 0,
      y: 0,
      width: 240,
      height: 0,
      strokeColor: '#1d1d1d',
      backgroundColor: 'transparent',
      points: [
        [0, 0],
        [240, 0],
      ],
      endArrowhead: 'arrow',
      ...over,
    })
    const html = (el: PreviewEl) => renderToStaticMarkup(createElement('svg', null, drawn(el, 0)))
    expect(html(arrow({})).match(/<polyline/g)?.length).toBe(2)
    expect(html(arrow({ startArrowhead: 'arrow' })).match(/<polyline/g)?.length).toBe(3)
    expect(html(arrow({ endArrowhead: null })).match(/<polyline/g)?.length).toBe(1)
    const curved = html(
      arrow({
        roundness: { type: 2 },
        points: [
          [0, 0],
          [120, -64],
          [240, 0],
        ],
      }),
    )
    expect(curved).toMatch(/<path d="M0,0 C/)
    expect(html(arrow({ strokeStyle: 'dashed' }))).toContain('stroke-dasharray="6 5"')
  })

  it('draws a sticky note as a square of its own colour', () => {
    const html = renderToStaticMarkup(
      createElement(
        'svg',
        null,
        drawn(
          {
            type: 'stickynote',
            x: 0,
            y: 0,
            width: 120,
            height: 120,
            strokeColor: '#1b2330',
            backgroundColor: '#f6c453',
          },
          0,
        ),
      ),
    )
    expect(html).toContain('fill="#f6c453"')
    expect(html).toContain('width="120"')
  })
})
