// N6-3: text on vector pages, split by the face that draws each character and positioned with the fonts' widths.
import { describe, expect, it } from 'vitest'
import { ownStyle, readScene } from './svg-scene.ts'
import {
  type Draw,
  FACE_URL,
  FaceIndex,
  familyList,
  layoutText,
  type Measure,
  parseFaceTable,
} from './text-layout.ts'

const LATIN = {
  family: 'Excalifont',
  url: '/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-a.woff2',
  unicodeRange: 'U+20-7e, U+a0-ff',
  weight: '400',
  style: 'normal',
}
const CJK = {
  family: 'Xiaolai',
  url: '/excalidraw-assets/fonts/Xiaolai/Xiaolai-Regular-b.woff2',
  unicodeRange: 'U+4e00-9fff',
  weight: '400',
  style: 'normal',
}

/** 10 units per character at size 20, any font; glyph runs 20 per character. */
const measure: Measure = {
  width: (d: Draw, text: string, size: number) => [...text].length * (d.kind === 'glyph' ? size : size / 2),
  ascent: (_d, size) => size * 0.8,
  descent: (_d, size) => size * 0.2,
}

function layout(textXml: string, faces = [LATIN, CJK]) {
  const s = readScene(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${textXml}</svg>`)
  const leaf = s.leaves[0]
  if (!leaf) throw new Error('no text')
  return layoutText(leaf.el, leaf.style, new FaceIndex(faces), measure, ownStyle).map((r) => ({
    text: r.text,
    font: r.draw.kind === 'face' ? r.draw.face.family : r.draw.kind,
    x: Math.round(r.x * 1e6) / 1e6,
    y: Math.round(r.y * 1e6) / 1e6,
  }))
}

describe('the face table', () => {
  it('keeps Lobby font paths only (never a foreign or relative URL)', () => {
    const json = JSON.stringify({
      v: 1,
      faces: [
        LATIN,
        { ...LATIN, url: 'https://esm.sh/x.woff2' },
        { ...LATIN, url: '//evil.example/a.woff2' },
        { ...LATIN, url: '/excalidraw-assets/fonts/../../api/x.woff2' },
        { ...LATIN, url: '/files/ast_1/ver_1/original' },
        { family: 3 },
      ],
    })
    expect(parseFaceTable(json)).toEqual([LATIN])
    expect(parseFaceTable('not json')).toEqual([])
    expect(FACE_URL.test(CJK.url)).toBe(true)
  })
  it('reads CSS family lists', () => {
    expect(familyList('Excalifont, Xiaolai, "Segoe UI Emoji"')).toEqual([
      'Excalifont',
      'Xiaolai',
      'Segoe UI Emoji',
    ])
  })
  it('the first family with a face covering a character draws it; else Helvetica when it encodes it; else a glyph', () => {
    const idx = new FaceIndex([LATIN, CJK])
    const fams = ['Excalifont', 'Xiaolai', 'Segoe UI Emoji']
    expect(idx.draw(0x41, fams)).toEqual({ kind: 'face', face: LATIN })
    expect(idx.draw(0x65e5, fams)).toEqual({ kind: 'face', face: CJK })
    expect(idx.draw(0x20ac, fams)).toEqual({ kind: 'standard' }) // € : no Lobby face here, Windows-1252 has it
    expect(idx.draw(0x1f600, fams)).toEqual({ kind: 'glyph' })
  })
})

describe('layoutText', () => {
  it('splits a line into runs by face, with whitespace between runs measured, never drawn', () => {
    const runs = layout(
      '<text x="0" y="20" font-family="Excalifont, Xiaolai, Segoe UI Emoji" font-size="20px" style="white-space: pre;">Hi 日本 go😀</text>',
    )
    expect(runs).toEqual([
      { text: 'Hi ', font: 'Excalifont', x: 0, y: 20 },
      { text: '日本', font: 'Xiaolai', x: 30, y: 20 },
      // the space after a CJK run is a gap (Xiaolai's range has no space), so "go" starts after it
      { text: 'go', font: 'Excalifont', x: 60, y: 20 },
      { text: '😀', font: 'glyph', x: 80, y: 20 },
    ])
  })
  it('keeps leading spaces as an offset (white-space: pre), and anchors middle and end with the fonts’ widths', () => {
    expect(
      layout(
        '<text x="0" y="5" font-family="Excalifont" font-size="20" style="white-space: pre;">  ab</text>',
      ),
    ).toEqual([{ text: 'ab', font: 'Excalifont', x: 20, y: 5 }])
    expect(
      layout(
        '<text x="100" y="5" font-family="Excalifont" font-size="20" text-anchor="middle">abcd</text>',
      )[0]?.x,
    ).toBe(80)
    expect(
      layout('<text x="100" y="5" font-family="Excalifont" font-size="20" text-anchor="end">abcd</text>')[0]
        ?.x,
    ).toBe(60)
  })
  it('the vote badge: spans with their own size and dx, centred on the central baseline', () => {
    const runs = layout(
      '<text x="20" y="10" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif" font-size="12" font-weight="700"><tspan font-size="10" fill-opacity="0.8">#1</tspan><tspan dx="3">3</tspan></text>',
    )
    // widths: "#1" 2×5 = 10, dx 3, "3" 6 → 19; start = 20 − 9.5; baseline = 10 + (9.6 − 2.4) / 2
    expect(runs).toEqual([
      { text: '#1', font: 'standard', x: 10.5, y: 13.6 },
      { text: '3', font: 'standard', x: 23.5, y: 13.6 },
    ])
  })
  it('without white-space: pre, spaces collapse as SVG does', () => {
    expect(layout('<text x="0" y="0" font-family="Excalifont" font-size="20">  a   b  </text>')).toEqual([
      { text: 'a b', font: 'Excalifont', x: 0, y: 0 },
    ])
  })
})
