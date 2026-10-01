// Spike B (O5): the pure halves of the SVG export (docs/EXCALIDRAW-MIGRATION.md §2.10.4): which elements
// an export draws, which self-hosted woff2 files cover its text (subsetting by file, no WebAssembly, no
// eval), the @font-face rule, and the standalone check. The browser half (the SVG opens with the network
// off) is B7 (e2e/spike-b/tests/b7-*.spec.ts).
import { describe, expect, it } from 'vitest'
import {
  charsPerFamily,
  type FamilyInfo,
  fontFaceRule,
  inRanges,
  LOBBY_FONT_FAMILIES,
  parseUnicodeRange,
  selectFaces,
  selfContainedProblems,
  woff2DataUrl,
} from './fonts.ts'
import { exportElements } from './select.ts'

describe('exportElements', () => {
  const els = [
    { id: 'n', type: 'stickynote' },
    { id: 'n.t', type: 'text', containerId: 'n' },
    { id: 'F', type: 'frame' },
    { id: 'c', type: 'rectangle', frameId: 'F' },
    { id: 'c.t', type: 'text', containerId: 'c', frameId: 'F' },
    { id: 'gone', type: 'rectangle', isDeleted: true },
    { id: 'h', type: 'stickynote' },
    { id: 'h.t', type: 'text', containerId: 'h' },
  ]
  it('drops deleted and hidden elements (a collapsed branch is left out of an export)', () => {
    const hidden = new Set(['h', 'h.t'])
    expect(exportElements(els, { isHidden: (id) => hidden.has(id) }).map((e) => e.id)).toEqual([
      'n',
      'n.t',
      'F',
      'c',
      'c.t',
    ])
  })
  it('a partial export takes the chosen elements with their labels and a frame with its children', () => {
    expect(exportElements(els, { only: new Set(['n']) }).map((e) => e.id)).toEqual(['n', 'n.t'])
    expect(exportElements(els, { only: new Set(['F']) }).map((e) => e.id)).toEqual(['F', 'c', 'c.t'])
    const hidden = new Set(['c', 'c.t'])
    expect(
      exportElements(els, { only: new Set(['F']), isHidden: (id) => hidden.has(id) }).map((e) => e.id),
    ).toEqual(['F'])
  })
})

describe('the families an export may embed', () => {
  it('are the server allowlist, Lilita One (7, decision D3) included', () => {
    expect([...LOBBY_FONT_FAMILIES]).toEqual([5, 6, 7, 8])
  })
})

describe('unicode ranges', () => {
  it('parses single points, spans, wildcards and Google-style padded ranges', () => {
    const r = parseUnicodeRange('U+20-7e,U+a1-a6, U+0131 ,U+4??, u+1F600-1F64F')
    expect(inRanges(0x41, r)).toBe(true)
    expect(inRanges(0x1f, r)).toBe(false)
    expect(inRanges(0xa3, r)).toBe(true)
    expect(inRanges(0x131, r)).toBe(true)
    expect(inRanges(0x4ff, r)).toBe(true)
    expect(inRanges(0x500, r)).toBe(false)
    expect(inRanges(0x1f602, r)).toBe(true)
    expect(parseUnicodeRange('')).toEqual([[0, 0x10ffff]])
  })
})

describe('selectFaces: only the woff2 files whose range covers the exported characters', () => {
  const face = (family: string, file: string, unicodeRange: string, weight = '400') => ({
    family,
    url: `http://127.0.0.1:7912/excalidraw-assets/fonts/${family}/${file}.woff2`,
    unicodeRange,
    weight,
    style: 'normal',
  })
  // Shapes as the pinned engine registers them (chunk-FN755BR4.js 917-960, 1292-1420).
  const registered = new Map<number, FamilyInfo>([
    [
      5,
      {
        local: false,
        faces: [
          face('Excalifont', 'latin', 'U+20-7e,U+a0-a3,U+a5-a6'),
          face('Excalifont', 'latin-ext', 'U+100-130'),
          face('Excalifont', 'cyrillic', 'U+400-45f'),
        ],
      },
    ],
    [
      6,
      {
        local: false,
        faces: [
          face('Nunito', 'cyrillic', 'U+0301, U+0400-045F', '500'),
          face('Nunito', 'latin', 'U+0000-00FF, U+0131', '500'),
        ],
      },
    ],
    [8, { local: false, faces: [face('Comic Shanns', 'latin', 'U+20-7e')] }],
    [
      100,
      {
        local: false,
        faces: [face('Xiaolai', 'cjk-1', 'U+4e00-4eff'), face('Xiaolai', 'cjk-2', 'U+4f00-4fff')],
      },
    ],
    [1000, { local: true, faces: [face('Segoe UI Emoji', 'local', '')] }],
  ])
  const fallbacks = (f: number) => (f === 5 ? [100, 1000] : [1000])
  const text = (fontFamily: number, originalText: string) => ({ type: 'text', fontFamily, originalText })

  it('picks per family by coverage; CJK in Excalifont falls back to the Xiaolai files it needs', () => {
    const chars = charsPerFamily([
      text(5, 'Hello Ā'),
      text(6, 'Plain text'),
      text(5, '一丁'), // U+4E00, U+4E01
      { type: 'rectangle' },
      { ...text(8, 'deleted'), isDeleted: true },
    ])
    const picked = selectFaces(chars, registered, fallbacks).map((f) => f.url.split('/fonts/')[1])
    expect(picked.sort()).toEqual(
      [
        'Excalifont/latin.woff2',
        'Excalifont/latin-ext.woff2',
        'Nunito/latin.woff2',
        'Xiaolai/cjk-1.woff2',
      ].sort(),
    )
  })

  it('emoji and characters no self-hosted face covers are left to the viewer (no local font is embedded)', () => {
    const picked = selectFaces(charsPerFamily([text(8, '😀')]), registered, fallbacks)
    expect(picked).toEqual([])
  })

  it('the @font-face rule embeds the file as data:, with its range and weight', () => {
    const rule = fontFaceRule(face('Nunito', 'latin', 'U+0000-00FF', '500'), 'data:font/woff2;base64,AAAA')
    expect(rule).toBe(
      '@font-face { font-family: "Nunito"; src: url("data:font/woff2;base64,AAAA") format("woff2"); font-weight: 500; font-style: normal; font-display: swap; unicode-range: U+0000-00FF; }',
    )
    expect(fontFaceRule(face('Comic Shanns', 'x', ''), 'data:x')).not.toContain('unicode-range')
    expect(woff2DataUrl(new Uint8Array([119, 79, 70, 50]).buffer)).toBe('data:font/woff2;base64,d09GMg==')
  })
})

describe('selfContainedProblems: an exported SVG must stand alone', () => {
  it('accepts data: URLs, #refs and the SVG namespace; flags blob:, relative and foreign references', () => {
    const ok =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="F"/><style class="style-fonts">@font-face { src: url("data:font/woff2;base64,AA") }</style></defs>' +
      '<g clip-path="url(#F)"><image href="data:image/png;base64,AAA"/><use xlink:href="#F"/></g>' +
      '<text>href="/files/x" and url(/files/y) in text are only text</text></svg>'
    expect(selfContainedProblems(ok)).toEqual([])
    const bad =
      '<svg><image href="blob:http://127.0.0.1:7912/abc"/><image xlink:href="/files/ast_x/ver_y/d/drv_z?board=b"/>' +
      '<style>@font-face { src: url(https://esm.sh/font.woff2) }</style><rect style="fill:url(/x.png)"/></svg>'
    expect(selfContainedProblems(bad)).toEqual([
      'blob:http://127.0.0.1:7912/abc',
      '/files/ast_x/ver_y/d/drv_z?board=b',
      '/x.png',
      'https://esm.sh/font.woff2',
    ])
  })
})
