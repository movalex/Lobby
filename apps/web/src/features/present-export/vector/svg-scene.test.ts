// N6-3/N6-4: the vector page's reading of an exported SVG and its probe (what makes a page an image page).
import { describe, expect, it } from 'vitest'
import { NOTE_SHADOW_FILTER_ID } from '../../../canvas/api/parts/export-svg-notes.ts'
import {
  applyMatrix,
  maskProblem,
  multiply,
  NOTE_SHADOW_FILTER,
  parseTransform,
  pathDataOk,
  readScene,
} from './svg-scene.ts'
import { decodeXml, parseXml, SvgReadError, serializeXml, textOf } from './svg-tree.ts'

const svg = (body: string, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 400 300" width="400" height="300"><!-- svg-source:excalidraw --><metadata></metadata><defs>${defs}<style class="style-fonts">\n\n</style></defs><rect x="0" y="0" width="400" height="300" fill="#ffffff"></rect>${body}</svg>`

describe('svg-tree', () => {
  it('reads what XMLSerializer writes: entities, comments, self-closing tags, namespaced attributes', () => {
    const root = parseXml(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><!-- c --><text x="1" title="a &quot;b&quot; &amp; c">A &amp; B &lt;c&gt; &#233;&#x1F600;</text><use xlink:href="#i"/></svg>',
    )
    expect(root.name).toBe('svg')
    const text = root.children[0] as never as { attrs: Record<string, string> }
    expect(text.attrs.title).toBe('a "b" & c')
    expect(textOf(root.children[0] as never)).toBe('A & B <c> é😀')
    expect((root.children[1] as never as { attrs: Record<string, string> }).attrs['xlink:href']).toBe('#i')
    expect(decodeXml('&bogus; &#xZZ;')).toBe('&bogus; &#xZZ;')
  })
  it('writes it back (round trip) and escapes text and attributes', () => {
    const src = '<g a="x &amp; &quot;y&quot;"><text>1 &lt; 2</text><path d="M0 0"/></g>'
    expect(serializeXml(parseXml(src))).toBe(src)
  })
  it('refuses a document that is not well formed', () => {
    for (const bad of ['<svg><g></svg>', '<svg>', '<svg></g>', '<svg a="1" a="2"/>', 'text', '<svg/><svg/>'])
      expect(() => parseXml(bad), bad).toThrow(SvgReadError)
  })
  it('reads a multi-megabyte data: URL without copying the document per attribute', () => {
    const big = 'A'.repeat(6_000_000)
    const t0 = Date.now()
    const root = parseXml(`<svg><image href="data:image/png;base64,${big}" width="1" height="1"/></svg>`)
    expect((root.children[0] as never as { attrs: Record<string, string> }).attrs.href?.length).toBe(
      6_000_022,
    )
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('transforms', () => {
  it('reads Excalidraw’s translate/rotate lists and matrix(), and refuses what it cannot', () => {
    const m = parseTransform('translate(10 20) rotate(90 5 5)') as never as readonly number[]
    const [x, y] = applyMatrix(m as never, 10, 5)
    expect(x).toBeCloseTo(15)
    expect(y).toBeCloseTo(30)
    expect(parseTransform('matrix(1 0 0 1 3 4)')).toEqual([1, 0, 0, 1, 3, 4])
    expect(parseTransform('scale(-1 1)')).toEqual([-1, 0, 0, 1, 0, 0])
    expect(parseTransform('')).toEqual([1, 0, 0, 1, 0, 0])
    expect(parseTransform('translate(NaN 1)')).toBeNull()
    expect(parseTransform('perspective(3)')).toBeNull()
    expect(parseTransform('translate(1 2) junk')).toBeNull()
    expect(multiply([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 5, 5])).toEqual([2, 0, 0, 2, 10, 10])
  })
  it('path data: Excalidraw’s commands read, broken geometry (NaN, stray tokens) does not', () => {
    expect(pathDataOk('M 0 0 L 10 10 Q 5 5 10 0 C 1 2 3 4 5 6 Z')).toBe(true)
    expect(pathDataOk('M0,0l10-10h5v5z')).toBe(true)
    expect(pathDataOk('M 0 0 L NaN 10')).toBe(false)
    expect(pathDataOk('L 0 0')).toBe(false)
    expect(pathDataOk('M 0 0 L 1')).toBe(false)
    expect(pathDataOk('M 0 0 X 1 1')).toBe(false)
  })
})

describe('readScene', () => {
  it('flattens groups: the paint order, each leaf’s transform to the root, inherited style and folded opacity', () => {
    const s = readScene(
      svg(
        '<g transform="translate(10 10)" stroke="#ff0000"><g transform="translate(5 0)" opacity="0.5"><path d="M0 0 L10 0" fill="none" stroke-width="2" opacity="0.5"></path></g><text x="0" y="16" font-family="Excalifont, Xiaolai" font-size="20px" fill="#1e1e1e" stroke="none" style="white-space: pre;">Hi</text></g>',
      ),
    )
    expect(s.problems).toEqual([])
    expect(s.viewBox).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    expect(s.leaves.map((l) => l.el.name)).toEqual(['rect', 'path', 'text'])
    const path = s.leaves[1]
    expect(path?.ctm).toEqual([1, 0, 0, 1, 15, 10])
    expect(path?.style.stroke).toBe('#ff0000')
    expect(path?.opacity).toBeCloseTo(0.25)
    expect(s.leaves[2]?.style['white-space']).toBe('pre')
    expect(s.leaves[2]?.style['font-size']).toBe('20px')
  })
  it('group opacity over more than one paint is a problem (a browser composites the group once); one paint is not', () => {
    const GROUP = 'a partly transparent group'
    const problems = (body: string, defs = '') => readScene(svg(body, defs)).problems
    // Excalidraw's semi-transparent sticky note: a group with opacity over its shadow, its body and its edge
    expect(
      problems(
        '<g opacity="0.5"><path d="M4 4 L14 4 L14 14 Z" fill="#000" fill-opacity="0.16" stroke="none"></path><path d="M0 0 L10 0 L10 10 Z" fill="#fff9b1" stroke="none"></path></g>',
      ),
    ).toEqual([GROUP])
    // one element with its own opacity, filled and stroked (the stroke would show the fill through)
    expect(
      problems('<path d="M0 0 L10 0 L10 10 Z" fill="#a5d8ff" stroke="#1971c2" opacity="0.5"></path>'),
    ).toEqual([GROUP])
    // Lobby's note with its soft shadow (the page draws a light copy under it) in a semi-transparent group
    expect(
      problems(
        `<g opacity="0.6"><path d="M0 0 L10 0 L10 10 Z" fill="#fff9b1" stroke="none" filter="url(#${NOTE_SHADOW_FILTER})"></path></g>`,
        `<filter id="${NOTE_SHADOW_FILTER}"><feGaussianBlur stdDeviation="3"/></filter>`,
      ),
    ).toEqual([GROUP])
    // opacity over ONE paint is exact: a stroke-only path, a filled shape, a text, an image
    expect(problems('<g opacity="0.5"><path d="M0 0 L10 0" fill="none" stroke="#000"></path></g>')).toEqual(
      [],
    )
    expect(problems('<rect width="5" height="5" fill="#f00" opacity="0.5"></rect>')).toEqual([])
    expect(problems('<text x="0" y="10" fill="#000" opacity="0.5">Hi</text>')).toEqual([])
    expect(
      problems(
        '<g opacity="0.5"><use href="#image-f" width="10" height="10" opacity="0.5"></use></g>',
        `<symbol id="image-f"><image href="data:image/png;base64,AAAA" width="100%" height="100%"></image></symbol>`,
      ),
    ).toEqual([])
    // Excalidraw's shapes carry fill-opacity and stroke-opacity (each paint composited alone, as the page does)
    expect(
      problems(
        '<g stroke-opacity="0.5" fill-opacity="0.5"><path d="M0 0 L10 0 L10 10 Z" fill="#a5d8ff" stroke="none"></path><path d="M0 0 L10 0 L10 10 Z" fill="none" stroke="#1971c2"></path></g>',
      ),
    ).toEqual([])
    // and an opaque group is never a problem
    expect(
      problems(
        '<g opacity="1"><path d="M0 0 L10 0 L10 10 Z" fill="#a5d8ff" stroke="#000"></path><path d="M0 0 L1 1" stroke="#000"></path></g>',
      ),
    ).toEqual([])
  })
  it('Lobby’s soft note shadow is not a problem: the note is marked for its light copy', () => {
    expect(NOTE_SHADOW_FILTER).toBe(NOTE_SHADOW_FILTER_ID)
    const s = readScene(
      svg(
        `<g><path d="M0 0 L10 0 L10 10 Z" fill="#fff9b1" filter="url(#${NOTE_SHADOW_FILTER})"></path></g>`,
        `<filter id="${NOTE_SHADOW_FILTER}"><feGaussianBlur stdDeviation="3"/></filter>`,
      ),
    )
    expect(s.problems).toEqual([])
    expect(s.leaves.find((l) => l.el.name === 'path')?.noteShadow).toBe(true)
  })
  it('names every effect the vector page does not reproduce (the page becomes an image page)', () => {
    const cases: [string, string, string][] = [
      ['<path d="M0 0 L1 1" filter="url(#blur)"></path>', '<filter id="blur"/>', 'a filter'],
      ['<rect width="5" height="5" fill="url(#p)"></rect>', '<pattern id="p"/>', 'a gradient or pattern'],
      ['<g style="mix-blend-mode: multiply"><path d="M0 0 L1 1"></path></g>', '', 'a blend mode'],
      ['<foreignObject width="10" height="10"></foreignObject>', '', '<foreignObject>'],
      ['<path d="M 0 0 L NaN 1"></path>', '', 'a path it cannot read'],
      ['<text x="0" y="0" direction="rtl">x</text>', '', 'right-to-left text'],
      ['<text x="0 5" y="0">ab</text>', '', 'text placed glyph by glyph'],
      [
        '<use href="#r"></use>',
        '<symbol id="r"><rect width="1" height="1"/></symbol>',
        'a reused element that is not an image',
      ],
      [
        '<image href="https://example.com/x.png" width="1" height="1"></image>',
        '',
        'an image that is not embedded',
      ],
      [
        '<g mask="url(#m)"><path d="M0 0 L1 1"></path></g>',
        '<mask id="m"><rect width="1" height="1" fill="#808080"/></mask>',
        'a mask in shades of grey',
      ],
      ['<g clip-path="url(#nope)"><path d="M0 0 L1 1"></path></g>', '', 'a clip-path it cannot find'],
      ['<svg><rect width="1" height="1"/></svg>', '', 'a nested SVG'],
    ]
    for (const [body, defs, problem] of cases)
      expect(readScene(svg(body, defs)).problems, body).toContain(problem)
    // a class rule in a style sheet would style elements unseen
    expect(readScene(svg('', '<style>.a { fill: red }</style>')).problems).toContain('a style sheet')
    expect(
      readScene(svg('', '<style>@font-face { font-family: "X"; src: url(data:,) }</style>')).problems,
    ).toEqual([])
  })
  it('accepts the masks and clips Excalidraw writes: an arrow label’s hole, an image crop, a frame clip', () => {
    const arrowMask =
      '<mask id="mask-a" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect x="0" y="0" fill="#fff" width="200" height="200"></rect><rect x="40" y="40" fill="#000" width="30" height="20" opacity="1"></rect></mask>'
    const crop =
      '<mask id="mask-image-crop-i" fill="#fff"><rect x="5" y="5" width="50" height="50"></rect></mask>'
    const frame =
      '<clipPath id="F"><rect transform="translate(0 0) rotate(0 100 100)" width="200" height="200"></rect></clipPath>'
    const s = readScene(
      svg(
        `<g clip-path="url(#F)"><g mask="url(#mask-a)"><path d="M0 0 L100 100"></path></g></g>${arrowMask}${crop}<g mask="url(#mask-image-crop-i)"><path d="M0 0 L1 1"></path></g>`,
        frame,
      ),
    )
    expect(s.problems).toEqual([])
    const arrow = s.leaves.find((l) => l.clips.length === 2)
    expect(arrow?.clips.map((c) => c.kind)).toEqual(['clip-path', 'mask'])
    expect(maskProblem(parseXml(crop))).toBeNull()
  })
  it('the vote badges (a text with spans) and an image symbol used by <use> are fine', () => {
    const s = readScene(
      svg(
        '<g transform="translate(5 5)"><title>3 votes</title><rect x="1" y="1" width="40" height="20" rx="10" fill="#1f2a44" stroke="#ffffff" stroke-width="2"></rect><text x="20" y="11" text-anchor="middle" dominant-baseline="central" fill="#fff" font-family="ui-sans-serif, system-ui" font-size="12" font-weight="700"><tspan font-size="9" fill-opacity="0.8">#1</tspan><tspan dx="3">3</tspan></text></g><g transform="translate(10 10) rotate(0 50 50)"><use href="#image-f" width="100" height="100" opacity="1"></use></g>',
        '<symbol id="image-f"><image href="data:image/png;base64,iVBORw0KGgo=" preserveAspectRatio="none" width="100%" height="100%"></image></symbol>',
      ),
    )
    expect(s.problems).toEqual([])
    expect(s.leaves.map((l) => l.el.name)).toEqual(['rect', 'rect', 'text', 'use'])
  })
  it('reads the face table of a fonts: names export', () => {
    const s = readScene(svg('', '<metadata id="lobby-pdf-faces">{"v":1,"faces":[]}</metadata>'))
    expect(s.metadata.get('lobby-pdf-faces')).toBe('{"v":1,"faces":[]}')
  })
})
