// N6-3: text on vector pages, split by the face that draws each character and positioned with the fonts' widths.
import { describe, expect, it } from 'vitest'
import { ownStyle, readScene } from './svg-scene.ts'
import {
  blankWidth,
  type Draw,
  FACE_URL,
  FaceIndex,
  familyList,
  isEmojiSequence,
  isRtl,
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
    expect(idx.draw(0x41, fams)).toEqual({ kind: 'face', face: LATIN, slot: 0 })
    expect(idx.draw(0x65e5, fams)).toEqual({ kind: 'face', face: CJK, slot: 0 })
    expect(idx.draw(0x20ac, fams)).toEqual({ kind: 'standard' }) // € : no Lobby face here, Windows-1252 has it
    expect(idx.draw(0x1f600, fams)).toEqual({ kind: 'glyph' })
  })
})

describe('the face that draws a character: its range claims it AND its font has it (wave N.1)', () => {
  const MAIN = { ...LATIN, unicodeRange: 'U+20-7e, U+a0-ff, U+2000-206F' }
  const EXT = {
    ...LATIN,
    url: '/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-x.woff2',
    unicodeRange: 'U+300-36f, U+2010-2011',
  }
  // MAIN lacks U+2010, U+2011, U+00A0, U+2020, U+202F (it claims them); EXT has U+2011 and the marks; MAIN draws U+00C9
  // and U+00E9 with one glyph (as Excalifont draws U+0020 and U+00A0 with one): U+00E9 is its second code point
  const lacks = new Set([0x2010, 0x2011, 0xa0, 0x2020, 0x202f])
  const has: Record<string, (cp: number) => number> = {
    [MAIN.url]: (cp) => (lacks.has(cp) ? -1 : cp === 0xe9 ? 1 : 0),
    [EXT.url]: (cp) => (cp === 0x2010 ? -1 : 0),
  }
  const idx = new FaceIndex([MAIN, EXT], { slot: (face, cp) => has[face.url]?.(cp) ?? -1 })
  const fams = ['Excalifont', 'sans-serif']
  const kind = (d: Draw | null) =>
    d === null ? null : d.kind === 'face' ? `${d.face === MAIN ? 'main' : 'ext'}#${d.slot}` : d.kind
  it('the next face of the family, then the standard font, then a picture; a missing space is a blank', () => {
    expect(kind(idx.draw(0x41, fams))).toBe('main#0')
    expect(kind(idx.draw(0x2011, fams))).toBe('ext#0') // MAIN claims it, EXT has it
    expect(kind(idx.draw(0x2020, fams))).toBe('standard') // nobody has †: Helvetica encodes it
    expect(kind(idx.draw(0x2010, fams))).toBe('glyph') // nobody has it, Helvetica cannot: a picture
    // a no-break space nobody has: invisible text (Helvetica's 0xA0 reads back as U+0020)
    expect(kind(idx.draw(0xa0, fams))).toBe('blank')
    expect(kind(idx.draw(0x202f, fams))).toBe('blank')
    expect(kind(idx.draw(0x200d, fams))).toBe('blank') // a format character draws nothing
  })
  it('a code point sharing a glyph with a smaller one is drawn from the next embedding (its own ToUnicode)', () => {
    expect(kind(idx.draw(0xe9, fams))).toBe('main#1')
  })
  it('a cluster one font draws whole stays whole; else it is split into its code points', () => {
    expect(kind(idx.drawCluster('é', fams))).toBe(null) // MAIN has e, only EXT has the mark
    expect(kind(idx.drawCluster('́́', fams))).toBe('ext#0')
    expect(kind(idx.drawCluster('a‍', fams))).toBe(null) // a format character in it: split
    const leaf = readScene(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="0" y="0" font-family="Excalifont" ' +
        'font-size="20" style="white-space: pre;">Café a‑b</text></svg>',
    ).leaves[0]
    if (!leaf) throw new Error('no text')
    const runs = layoutText(leaf.el, leaf.style, idx, measure, ownStyle)
    expect(runs.map((r) => [r.text, kind(r.draw)])).toEqual([
      ['Cafe', 'main#0'],
      ['́', 'ext#0'],
      [' a', 'main#0'],
      ['‑', 'ext#0'],
      ['b', 'main#0'],
    ])
  })
  it('a letter with a ZWJ or U+FE0F is no emoji; U+FEFF is not right-to-left', () => {
    expect(isEmojiSequence('a‍')).toBe(false)
    expect(isEmojiSequence('a️')).toBe(false)
    expect(isEmojiSequence('❤️')).toBe(true)
    expect(isEmojiSequence('1️⃣')).toBe(true)
    expect(isRtl(0xfeff)).toBe(false)
    expect(isRtl(0x202e)).toBe(true)
  })
  it('blank widths: Unicode’s spaces, nothing for a format character', () => {
    expect(blankWidth(' ', 20)).toBe(20)
    expect(blankWidth(' ​', 20)).toBeCloseTo(4)
    expect(blankWidth(' ', 10)).toBeCloseTo(2.78)
  })
})

describe('layoutText', () => {
  it('splits a line into runs by face; a space is drawn in the run of a font that has it (the text keeps it)', () => {
    const runs = layout(
      '<text x="0" y="20" font-family="Excalifont, Xiaolai, Segoe UI Emoji" font-size="20px" style="white-space: pre;">Hi 日本 go😀</text>',
    )
    expect(runs).toEqual([
      { text: 'Hi ', font: 'Excalifont', x: 0, y: 20 },
      { text: '日本', font: 'Xiaolai', x: 30, y: 20 },
      // the space after a CJK run is Excalifont's (Xiaolai's range has no space): it opens the next Latin run
      { text: ' go', font: 'Excalifont', x: 50, y: 20 },
      { text: '😀', font: 'glyph', x: 80, y: 20 },
    ])
  })
  it('keeps leading spaces as text (white-space: pre), and anchors middle and end with the fonts’ widths', () => {
    expect(
      layout(
        '<text x="0" y="5" font-family="Excalifont" font-size="20" style="white-space: pre;">  ab</text>',
      ),
    ).toEqual([{ text: '  ab', font: 'Excalifont', x: 0, y: 5 }])
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
  it('an emoji sequence (skin tone, ZWJ family, keycap) is one picture, even where a face covers U+200D', () => {
    const wide = { ...LATIN, unicodeRange: 'U+20-7e, U+2000-206F' } // Nunito-like: General Punctuation, ZWJ in it
    const runs = layout(
      '<text x="0" y="0" font-family="Excalifont, Segoe UI Emoji" font-size="20" style="white-space: pre;">ok 👍🏽 👨‍👩‍👧 1️⃣</text>',
      [wide],
    )
    expect(runs.map((r) => [r.text, r.font])).toEqual([
      ['ok ', 'Excalifont'],
      ['👍🏽', 'glyph'],
      [' ', 'Excalifont'],
      ['👨‍👩‍👧', 'glyph'],
      [' ', 'Excalifont'],
      ['1️⃣', 'glyph'],
    ])
  })
  it('without white-space: pre, spaces collapse as SVG does', () => {
    expect(layout('<text x="0" y="0" font-family="Excalifont" font-size="20">  a   b  </text>')).toEqual([
      { text: 'a b', font: 'Excalifont', x: 0, y: 0 },
    ])
  })
})
