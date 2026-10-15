// Review fix (wave Q): a library item's drawing never makes a request from its colours. An item's elements are
// another person's data; `url(…)` in a fill or a stroke (or in the `--pf` custom property the dark theme mixes) would
// make every viewer of the tile GET that URL. Only #hex, rgb()/rgba()/hsl()/hsla() with numeric arguments, the CSS
// named colours and `transparent` are drawn; anything else is the default.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { previewColor } from '../pieces/Preview.tsx'
import { type ItemPreviewEl, ItemPreview } from './Previews.tsx'

const el = (over: Partial<ItemPreviewEl>): ItemPreviewEl => ({
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  ...over,
})

const HOSTILE = [
  'url(https://evil.example/x#p)',
  'URL( "https://evil.example/x" )',
  'red;background:url(https://evil.example/y)',
  'rgb(1, 2, 3) url(https://evil.example/z)',
  'var(--x, url(https://evil.example/v))',
  'image-set("https://evil.example/s" 1x)',
  'rgb(calc(1), 2, 3)',
  '#fff" onload="x',
  'r\\65 d',
  '<b>',
  'expression(alert(1))',
]

function itemHtml(elements: readonly ItemPreviewEl[]): string {
  return renderToStaticMarkup(
    createElement(ItemPreview, {
      id: 'lbi_0123456789abcdefghij',
      elements,
      width: 200,
      height: 100,
      thumb: () => null,
    }),
  )
}

describe('a library item preview’s colours', () => {
  it.each(HOSTILE)('draws %s as the default (no url( in the markup)', (bad) => {
    const html = itemHtml(
      (['rectangle', 'ellipse', 'diamond', 'stickynote', 'line', 'arrow', 'text'] as const).map((type) =>
        el({
          type,
          strokeColor: bad,
          backgroundColor: bad,
          points: [
            [0, 0],
            [50, 20],
            [90, 60],
          ],
          endArrowhead: 'arrow',
          originalText: 'Hi',
        }),
      ),
    )
    expect(html).not.toMatch(/url\(/i)
    expect(html).not.toContain('evil.example')
    expect(html).not.toContain('expression')
    expect(html).not.toContain('onload')
  })

  it('keeps the colours a board really uses', () => {
    for (const ok of [
      '#1e1e1e',
      '#abc',
      '#ffec99cc',
      'transparent',
      'red',
      'RebeccaPurple',
      'rgb(255, 0, 0)',
      'rgba(255,0,0,0.5)',
      'rgb(10% 20% 30% / 50%)',
      'hsl(120deg 50% 50%)',
      'hsla(120, 50%, 50%, .3)',
    ])
      expect(previewColor(ok, 'D')).toBe(ok.trim())
    const html = itemHtml([el({ backgroundColor: '#ffec99', strokeColor: 'rgb(1, 2, 3)' })])
    expect(html).toContain('fill="#ffec99"')
    expect(html).toContain('stroke="rgb(1, 2, 3)"')
    expect(html).toContain('--pf:#ffec99')
  })

  it('refuses what is not a colour', () => {
    for (const bad of [...HOSTILE, '', 'notacolour', '#ggg', '#12345', 'rgb()', 'rgb(1,2)', 'hsl(a, b, c)'])
      expect(previewColor(bad, 'D')).toBe('D')
  })
})
