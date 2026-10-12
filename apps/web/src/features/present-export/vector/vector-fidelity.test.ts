// N6-1/N6-3 fidelity (wave N.1): a vector PDF made the way the PDF worker makes it (createPdfBuilder with the font
// engine and the served font files) from two REAL frame exports (fixtures captured from the e2e board: the intro frame
// with Nunito and CJK text, and a mid board's frame with an Excalifont title, six notes, shapes, a dashed outline and
// arrows), then read back from the bytes alone:
//  - the text, extracted the way a viewer does it (each text-showing operator's glyph codes through its font's
//    ToUnicode map): every line of the SVG is there exactly once, in order (no hidden duplicate layer), the CJK line
//    whole across its runs;
//  - the fonts: every embedded font program is a TrueType subset (FontFile2) of one of the served files, and each glyph
//    it draws has exactly that file's outline (points and on-curve flags) and advance width (the PDF's /W widths);
//  - the shapes: vector path objects (filled and stroked), the dashed outline a dash pattern, and no picture on
//    either page.
// n6-vector-pdf.spec.ts checks the same file in pdf.js (the text it finds, and its drawing against the image page).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as pdfLibFontkit from '@pdf-lib/fontkit'
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { servedFontFile } from '../../../canvas/export/test-fixtures.ts'
import { createPdfBuilder } from '../pdf-build.ts'
import { loadFontkit, type OutlinePoint } from './fontkit.ts'
import { isRtl } from './text-layout.ts'

interface FkGlyph {
  readonly id: number
  readonly advanceWidth: number
  _getContours(): OutlinePoint[][]
}
interface FkFont {
  readonly postscriptName: string
  readonly unitsPerEm: number
  readonly numGlyphs: number
  getGlyph(gid: number): FkGlyph
  glyphForCodePoint(cp: number): FkGlyph
  hasGlyphForCodePoint(cp: number): boolean
  layout(text: string): { glyphs: FkGlyph[] }
}
interface FkEngine {
  create(b: Uint8Array): FkFont
}
const installed = pdfLibFontkit as unknown as { default?: FkEngine } & FkEngine
/** @pdf-lib/fontkit itself (no adapter): reads the served files and the PDF's font programs. */
const engine: FkEngine = installed.default ?? installed

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const INTRO = fixture('intro-names.svg.xml')
const MID = fixture('mid-frame.svg.xml')

/** The lines of an SVG's <text> elements, in paint order (the fixtures' text is plain: no entities but &amp;). */
const svgLines = (svg: string) =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => (m[1] as string).replaceAll('&amp;', '&'))
/** The face URLs of a 'names' SVG's face table. */
const faceUrls = (svg: string) => [...svg.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1] as string)

/** The PDF as the worker makes it: the font engine, the served font files, one vector page a fixture. */
async function buildPdf() {
  const fontkit = await loadFontkit()
  if (!fontkit) throw new Error('the font engine did not load')
  const b = await createPdfBuilder({
    title: 'Fidelity',
    now: new Date(0),
    vector: { fontkit, deps: { fetchFace: async (url) => servedFontFile(url) } },
  })
  const intro = await b.addVectorPage({ title: 'Intro', widthPx: 800, heightPx: 600, svg: INTRO })
  const mid = await b.addVectorPage({ title: 'Step 2', widthPx: 960, heightPx: 540, svg: MID })
  if (!intro.vector || !mid.vector) throw new Error(`not vector pages: ${JSON.stringify([intro, mid])}`)
  return b.finish()
}

/** A ToUnicode CMap (bfchar and bfrange) → code → text. */
function parseToUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>()
  const utf16 = (hex: string) => {
    const units: number[] = []
    for (let i = 0; i + 4 <= hex.length; i += 4) units.push(Number.parseInt(hex.slice(i, i + 4), 16))
    return String.fromCharCode(...units)
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of (block[1] as string).matchAll(BFCHAR))
      out.set(Number.parseInt(m[1] as string, 16), utf16(m[2] as string))
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of (block[1] as string).matchAll(BFRANGE)) {
      const lo = Number.parseInt(m[1] as string, 16)
      const hi = Number.parseInt(m[2] as string, 16)
      if (m[3]) {
        const base = utf16(m[3])
        for (let c = lo; c <= hi; c++)
          out.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)))
      } else {
        const list = [...(m[4] as string).matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => utf16(x[1] as string))
        list.forEach((t, i) => {
          out.set(lo + i, t)
        })
      }
    }
  return out
}

/** A stream's decoded bytes as text (latin1: content streams and CMaps are ASCII). */
const streamText = (s: PDFRawStream) => new TextDecoder('latin1').decode(decodePDFRawStream(s).decode())

/** A content stream's tokens: hex and literal strings, array brackets, names, and numbers or operators. */
const TOKEN = /<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\)|\[|\]|\/[^\s/<>[\]()]+|[^\s/<>[\]()]+/g

/** The operators that paint a path (fill, stroke or both), not the clip-only `n`. */
const PAINT = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*'])

/** WinAnsiEncoding's codes 0x80–0x9F (the standard font's text: Latin-1 elsewhere). */
const WIN_ANSI_HIGH = new Map(
  Object.entries({
    0x80: 0x20ac,
    0x82: 0x201a,
    0x83: 0x192,
    0x84: 0x201e,
    0x85: 0x2026,
    0x86: 0x2020,
    0x87: 0x2021,
    0x88: 0x2c6,
    0x89: 0x2030,
    0x8a: 0x160,
    0x8b: 0x2039,
    0x8c: 0x152,
    0x8e: 0x17d,
    0x91: 0x2018,
    0x92: 0x2019,
    0x93: 0x201c,
    0x94: 0x201d,
    0x95: 0x2022,
    0x96: 0x2013,
    0x97: 0x2014,
    0x98: 0x2dc,
    0x99: 0x2122,
    0x9a: 0x161,
    0x9b: 0x203a,
    0x9c: 0x153,
    0x9e: 0x17e,
    0x9f: 0x178,
  }).map(([k, v]) => [Number(k), v]),
)
const winAnsiText = (code: number) => String.fromCodePoint(WIN_ANSI_HIGH.get(code) ?? code)

/** A glyph code its font's ToUnicode map does not name (U+FFFD). */
const MISSING = '�'

/** ToUnicode entries: `<code> <text>` and `<lo> <hi> <first text>` or `<lo> <hi> [<text> …]`. */
const BFCHAR = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
const BFRANGE = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g

interface PdfFontInfo {
  readonly baseFont: string
  /** code (a 2-byte CID, = the subset's glyph id) → text */
  readonly toUnicode: Map<number, string>
  /** the embedded TrueType program, or null (a standard font) */
  readonly program: Uint8Array | null
  /** CID → width (1000 units an em) */
  readonly widths: Map<number, number>
  readonly cid: boolean
}

function fontInfo(doc: PDFDocument, dict: PDFDict): PdfFontInfo {
  const baseFont = String(dict.get(PDFName.of('BaseFont')))
  const tu = dict.get(PDFName.of('ToUnicode'))
  const toUnicode = tu ? parseToUnicode(streamText(doc.context.lookup(tu) as PDFRawStream)) : new Map()
  const descendants = dict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)
  if (!descendants) return { baseFont, toUnicode, program: null, widths: new Map(), cid: false }
  const cidFont = doc.context.lookup(descendants.get(0)) as PDFDict
  const descriptor = cidFont.lookup(PDFName.of('FontDescriptor'), PDFDict)
  const ff = doc.context.lookup(descriptor.get(PDFName.of('FontFile2'))) as PDFRawStream
  const widths = new Map<number, number>()
  const w = cidFont.lookupMaybe(PDFName.of('W'), PDFArray)
  if (w) {
    // [c [w1 w2 ...]] or [c1 c2 w]
    const items = w.asArray().map((x) => (x instanceof PDFRef ? doc.context.lookup(x) : x))
    for (let i = 0; i < items.length; ) {
      const c = (items[i] as PDFNumber).asNumber()
      const next = items[i + 1]
      if (next instanceof PDFArray) {
        next.asArray().forEach((v, k) => {
          widths.set(c + k, (v as PDFNumber).asNumber())
        })
        i += 2
      } else {
        const c2 = (next as PDFNumber).asNumber()
        const width = (items[i + 2] as PDFNumber).asNumber()
        for (let k = c; k <= c2; k++) widths.set(k, width)
        i += 3
      }
    }
  }
  return { baseFont, toUnicode, program: decodePDFRawStream(ff).decode(), widths, cid: true }
}

interface PageRead {
  /** each text-showing operator's text, in order, with the font it used */
  readonly runs: { font: string; text: string; codes: number[] }[]
  readonly fonts: Map<string, PdfFontInfo>
  readonly ops: string[]
}

/** What a viewer reads from a page: its content streams' operators, and each text run through ToUnicode. */
function readPage(doc: PDFDocument, index: number): PageRead {
  const page = doc.getPages()[index]
  if (!page) throw new Error(`no page ${index}`)
  const fonts = new Map<string, PdfFontInfo>()
  const fontDict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)
  for (const [name, ref] of fontDict?.entries() ?? [])
    fonts.set(name.asString(), fontInfo(doc, doc.context.lookup(ref) as PDFDict))
  const c = page.node.Contents()
  const streams = c instanceof PDFStream ? [c] : c ? c.asArray().map((r) => doc.context.lookup(r)) : []
  let content = ''
  for (const s of streams) if (s instanceof PDFRawStream) content += `${streamText(s)}\n`
  const tokens = content.match(TOKEN) ?? []
  const runs: PageRead['runs'] = []
  const ops: string[] = []
  let font = ''
  const operands: string[] = []
  for (const t of tokens) {
    if (/^[A-Za-z*'"]+$/.test(t)) {
      ops.push(t)
      if (t === 'Tf') font = operands.find((o) => o.startsWith('/')) ?? font
      if (t === 'Tj' || t === 'TJ') {
        const info = fonts.get(font)
        const codes: number[] = []
        let text = ''
        for (const o of operands)
          if (o.startsWith('<')) {
            const hex = o.slice(1, -1).replace(/\s+/g, '')
            const step = info?.cid ? 4 : 2
            for (let i = 0; i + step <= hex.length; i += step) {
              const code = Number.parseInt(hex.slice(i, i + step), 16)
              codes.push(code)
              text += info?.toUnicode.get(code) ?? (info?.cid ? MISSING : winAnsiText(code))
            }
          } else if (o.startsWith('(')) text += o.slice(1, -1)
        runs.push({ font, text, codes })
      }
      operands.length = 0
    } else operands.push(t)
  }
  return { runs, fonts, ops }
}

const pts = (contours: OutlinePoint[][]) =>
  contours.map((c) => c.map((p) => `${Math.round(p.x)},${Math.round(p.y)}${p.onCurve ? '' : '~'}`).join(' '))

const doc = await PDFDocument.load(await buildPdf())
const pages = [readPage(doc, 0), readPage(doc, 1)]

describe('a vector PDF read back from its bytes (two real frame exports, the served fonts)', () => {
  it('the text: every SVG line exactly once, in order, the header first; the CJK line whole across its runs', () => {
    for (const [i, svg] of [INTRO, MID].entries()) {
      const page = pages[i] as PageRead
      const lines = svgLines(svg)
      expect(lines.length).toBeGreaterThan(i === 0 ? 1 : 15)
      const text = page.runs.map((r) => r.text)
      expect(text.join('\n')).not.toContain(MISSING)
      // the runs of the drawing, after the header's title (drawn last, in the standard font)
      const body = page.runs.filter((r) => page.fonts.get(r.font)?.cid).map((r) => r.text)
      // a line is one run, or (several fonts: CJK comes in many files) consecutive runs end to end
      let at = 0
      for (const line of lines) {
        let got = ''
        while (got.length < line.length && at < body.length) got += body[at++]
        expect(got, `the line "${line}"`).toBe(line)
      }
      expect(at, 'no run beyond the SVG’s lines (no hidden copy of the text)').toBe(body.length)
      // the header's title, in the standard font: the page's bookmark name
      const title = i === 0 ? 'Intro' : 'Step 2'
      expect(page.runs.some((r) => !page.fonts.get(r.font)?.cid && r.text === title)).toBe(true)
    }
    expect(svgLines(INTRO)).toContain('日本語のメモ')
  })

  it('the fonts: TrueType subsets of the served files, each glyph drawn with that file’s own outline and advance', () => {
    const sources = [...new Set([...faceUrls(INTRO), ...faceUrls(MID)])].map((url) => {
      const file = servedFontFile(url)
      if (!file) throw new Error(`not served: ${url}`)
      return { url, font: engine.create(file) }
    })
    const seen = new Set<string>()
    let glyphs = 0
    for (const page of pages)
      for (const [name, info] of page.fonts) {
        if (!info.cid || seen.has(info.baseFont)) continue
        seen.add(info.baseFont)
        const program = info.program as Uint8Array
        expect(program.length, `${name} is a subset`).toBeLessThan(20_000)
        const embedded = engine.create(program)
        const mine = (p: PageRead) => p.runs.filter((r) => p.fonts.get(r.font)?.baseFont === info.baseFont)
        const runs = pages.flatMap(mine)
        expect(runs.length).toBeGreaterThan(0)
        // the glyphs the source font lays each run out in (ligatures and alternates included), code by code
        const laidOut = (font: FkFont, text: string) => font.layout(text).glyphs
        const same = (a: FkGlyph, b: FkGlyph) =>
          JSON.stringify(pts(a._getContours())) === JSON.stringify(pts(b._getContours()))
        const covers = (font: FkFont, text: string) =>
          [...text].every((ch) => font.hasGlyphForCodePoint(ch.codePointAt(0) as number))
        const drawsLike = (font: FkFont, r: PageRead['runs'][number]) => {
          if (!covers(font, r.text)) return false
          const want = laidOut(font, r.text)
          if (want.length !== r.codes.length) return false
          return r.codes.every((cid, k) => same(embedded.getGlyph(cid), want[k] as FkGlyph))
        }
        // the served file this subset came from: same PostScript name, and every glyph it draws equal
        const match = sources.find(({ font }) => {
          if (!info.baseFont.slice(1).startsWith(font.postscriptName)) return false
          return runs.every((r) => drawsLike(font, r))
        })
        expect(match, `${info.baseFont}: a served file whose outlines it carries`).toBeDefined()
        const src = (match as { font: FkFont }).font
        for (const r of runs) {
          const want = laidOut(src, r.text)
          r.codes.forEach((cid, k) => {
            const g = want[k] as FkGlyph
            const label = `${info.baseFont} "${r.text}" glyph ${k}`
            expect(embedded.getGlyph(cid).advanceWidth, `${label} advance`).toBe(g.advanceWidth)
            expect(info.widths.get(cid), `${label} /W`).toBeCloseTo(
              (g.advanceWidth * 1000) / src.unitsPerEm,
              0,
            )
            glyphs++
          })
        }
      }
    // Nunito (both pages), Excalifont (the title) and the CJK line's Xiaolai files
    expect([...seen].some((n) => /Nunito/.test(n))).toBe(true)
    expect([...seen].some((n) => /Excalifont/.test(n))).toBe(true)
    expect([...seen].filter((n) => /Xiaolai/.test(n)).length).toBeGreaterThanOrEqual(2)
    expect(glyphs).toBeGreaterThan(40)
  })

  it('the shapes: path objects filled and stroked, the dashed outline a dash pattern, no picture on either page', () => {
    const paint = (ops: string[]) => ops.filter((o) => PAINT.has(o))
    for (const page of pages) expect(page.ops.filter((o) => o === 'Do')).toEqual([])
    // the intro: the frame's white, the note and its shadow
    expect(paint((pages[0] as PageRead).ops).length).toBeGreaterThanOrEqual(3)
    const mid = (pages[1] as PageRead).ops
    // six notes, their shadows, a rectangle and an ellipse (fill and outline), a diamond and two arrows
    expect(paint(mid).length).toBeGreaterThanOrEqual(18)
    expect(mid.filter((o) => o === 'S').length, 'outlines stroked').toBeGreaterThanOrEqual(4)
    expect(mid.filter((o) => o === 'c').length, 'the ellipse as Bézier curves').toBeGreaterThanOrEqual(4)
    expect(mid).toContain('d') // the dashed diamond's dash pattern
  })
})

// ---- wave N.1 review (finding 1): a character a face's unicode-range claims but its font has no glyph for ---------
// The canvas's browser falls through to the face's family's next face, then the next family, per glyph; the PDF must
// too: a run is never laid out in a font without the glyph (fontkit would draw its .notdef: a box in Nunito, nothing
// in Lilita One, Comic Shanns and Excalifont). What no Lobby font has is a picture drawn by the browser (as emoji
// are), and every such character, and every space no font has, is still in the text (ToUnicode) exactly.

/** Lobby's faces as the engine registers them (family, served file, declared unicode-range: the browser's form). */
const GOOGLE_LATIN =
  'U+0-FF, U+131, U+152-153, U+2BB-2BC, U+2C6, U+2DA, U+2DC, U+304, U+308, U+329, U+2000-206F, U+2074, U+20AC, ' +
  'U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
const GOOGLE_LATIN_EXT =
  'U+100-2AF, U+304, U+308, U+329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, ' +
  'U+2C60-2C7F, U+A720-A7FF'
const lobbyFace = (family: string, file: string, unicodeRange: string, weight = '400') => ({
  family,
  url: `/excalidraw-assets/fonts/${file}`,
  unicodeRange,
  weight,
  style: 'normal',
})
const NUNITO_LATIN_EXT = lobbyFace(
  'Nunito',
  'Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTo3j6zbXWjgevT5.woff2',
  GOOGLE_LATIN_EXT,
  '500',
)
const NUNITO_LATIN = lobbyFace(
  'Nunito',
  'Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2',
  GOOGLE_LATIN,
  '500',
)
const LILITA_LATIN = lobbyFace(
  'Lilita One',
  'Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2',
  GOOGLE_LATIN,
)
const EXCALIFONT_LATIN = lobbyFace(
  'Excalifont',
  'Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2',
  'U+20-7E, U+A0-A3, U+A5-A6, U+A8-AB, U+AD-B1, U+B4, U+B6-B8, U+BA-FF, U+131, U+152-153, U+2BC, U+2C6, U+2DA, ' +
    'U+2DC, U+304, U+308, U+2013-2014, U+2018-201A, U+201C-201E, U+2020, U+2022, U+2024-2026, U+2030, ' +
    'U+2039-203A, U+20AC, U+2122, U+2212',
)
const EXCALIFONT_MARKS = lobbyFace(
  'Excalifont',
  'Excalifont/Excalifont-Regular-623ccf21b21ef6b3a0d87738f77eb071.woff2',
  'U+300-301, U+303',
)
const NUNITO_CSS = 'Nunito, sans-serif, Segoe UI Emoji'
const LILITA_CSS = 'Lilita One, sans-serif, Segoe UI Emoji'
const EXCALIFONT_CSS = 'Excalifont, Xiaolai, sans-serif, Segoe UI Emoji'

const xmlText = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

interface Line {
  readonly css: string
  readonly text: string
}

/** A 600×400 frame of text lines (each a note's line as Excalidraw writes it) with a 'names' face table. */
function linesFrame(lines: readonly Line[], faces: readonly object[]): string {
  const texts = lines.map(
    (l, i) =>
      `<g transform="translate(20 ${20 + i * 30}) rotate(0 100 12)"><text x="0" y="19.08" ` +
      `font-family="${l.css}" font-size="20px" fill="#1e1e1e" text-anchor="start" style="white-space: pre;" ` +
      `direction="ltr" dominant-baseline="alphabetic">${xmlText(l.text)}</text></g>`,
  )
  return (
    '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" width="600" height="400">' +
    `<defs><metadata id="lobby-pdf-faces">${xmlText(JSON.stringify({ v: 1, faces }))}</metadata></defs>` +
    `<rect x="0" y="0" width="600" height="400" fill="#ffffff"></rect>${texts.join('')}</svg>`
  )
}

const PICTURE = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

/** One vector page of `lines`, made as the worker makes it, with the browser's glyph pictures stood in for. */
async function linesPdf(lines: readonly Line[], faces: readonly object[]) {
  const fontkit = await loadFontkit()
  if (!fontkit) throw new Error('the font engine did not load')
  const pictured: string[] = []
  const b = await createPdfBuilder({
    title: 'Glyphs',
    now: new Date(0),
    vector: {
      fontkit,
      deps: {
        fetchFace: async (url) => servedFontFile(url),
        glyphs: async (text, size) => {
          pictured.push(text)
          const width = [...text].length * size * 0.5
          return { png: PICTURE, width, ascent: size * 0.8, descent: size * 0.2 }
        },
      },
    },
  })
  const svg = linesFrame(lines, faces)
  const outcome = await b.addVectorPage({ title: 'Glyphs', widthPx: 600, heightPx: 400, svg })
  return { outcome, bytes: await b.finish(), pictured }
}

/** The text pdf.js finds on each page (its own text items in order, a line break where it ends a line). */
async function pdfJsText(bytes: Uint8Array): Promise<string[]> {
  // pdf.js is the e2e package's (its devDependency): the viewer the e2e specs read exported PDFs with
  const e2e = createRequire(new URL('../../../../../../e2e/package.json', import.meta.url))
  const root = dirname(e2e.resolve('pdfjs-dist/package.json'))
  const pdfjs = (await import(pathToFileURL(join(root, 'legacy/build/pdf.mjs')).href)) as {
    getDocument(src: object): {
      promise: Promise<{
        numPages: number
        getPage(n: number): Promise<{
          getTextContent(o?: object): Promise<{ items: { str?: string; hasEOL?: boolean }[] }>
        }>
      }>
      destroy(): Promise<void>
    }
  }
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: `${root.replaceAll('\\', '/')}/standard_fonts/`,
    useSystemFonts: false,
    verbosity: 0,
  })
  try {
    const d = await task.promise
    const out: string[] = []
    for (let n = 1; n <= d.numPages; n++) {
      const content = await (await d.getPage(n)).getTextContent({ disableNormalization: true })
      out.push(content.items.map((i) => `${i.str ?? ''}${i.hasEOL ? '\n' : ''}`).join(''))
    }
    return out
  } finally {
    await task.destroy()
  }
}

/**
 * A line as pdf.js reports it: pdf.js itself folds every Unicode space into U+0020 and drops format characters
 * (\p{Cf}: ZWJ, soft hyphen, BOM…) in every document (its getTextContent has no option to keep them).
 */
const asPdfJsReads = (line: string) => line.replace(/\s/gu, ' ').replace(/\p{Cf}/gu, '')

/** Every line of the page, read through the fonts' ToUnicode maps: the runs in order, end to end, exactly. */
function expectLines(page: PageRead, lines: readonly string[]) {
  const runs = page.runs.filter((r) => r.text !== 'Glyphs')
  let at = 0
  for (const line of lines) {
    let got = ''
    while (got.length < line.length && at < runs.length) got += (runs[at++] as PageRead['runs'][number]).text
    expect(got, `the line ${JSON.stringify(line)}`).toBe(line)
  }
  expect(at, 'no text beyond the lines').toBe(runs.length)
}

/** No text-showing operator of an embedded (CID) font draws glyph 0, the font's .notdef. */
function expectNoNotdef(page: PageRead) {
  for (const r of page.runs) {
    const font = page.fonts.get(r.font)
    if (font?.cid) expect(r.codes, `${font.baseFont} "${r.text}"`).not.toContain(0)
  }
}

/** The code points a face declares (C0 and C1 controls aside) that its font file has no glyph for. */
function declaredButMissing(face: { url: string; unicodeRange: string }): number[] {
  const font = engine.create(servedFontFile(face.url) as Uint8Array)
  const out: number[] = []
  for (const part of face.unicodeRange.split(',')) {
    const m = /U\+([0-9A-F]+)(?:-([0-9A-F]+))?/i.exec(part.trim()) as RegExpExecArray
    const lo = Number.parseInt(m[1] as string, 16)
    const hi = m[2] ? Number.parseInt(m[2], 16) : lo
    for (let cp = lo; cp <= hi; cp++)
      if (cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f) && !font.hasGlyphForCodePoint(cp)) out.push(cp)
  }
  return out
}

describe('a character a face’s range claims but its font lacks: never a box or a gap, always in the text', () => {
  it('a Nunito note "non‑breaking 12 345 †": each character in a font that has it, the text exact', async () => {
    const line = 'non‑breaking 12 345 †'
    // as the canvas names them: Nunito's latin-ext face (it declares U+2020) before its latin one
    const faces = [NUNITO_LATIN_EXT, NUNITO_LATIN]
    const { outcome, bytes } = await linesPdf([{ css: NUNITO_CSS, text: line }], faces)
    expect(outcome).toEqual({ vector: true })
    const page = readPage(await PDFDocument.load(bytes), 0)
    expectNoNotdef(page)
    expectLines(page, [line])
    expect((await pdfJsText(bytes))[0]).toContain(asPdfJsReads(line))
  })

  it('a Lilita One note with U+00A0 (its latin file claims it, has none): a no-break space, not a gap', async () => {
    const line = 'Lilita One rocks'
    const { outcome, bytes } = await linesPdf([{ css: LILITA_CSS, text: line }], [LILITA_LATIN])
    expect(outcome).toEqual({ vector: true })
    const page = readPage(await PDFDocument.load(bytes), 0)
    expectNoNotdef(page)
    expectLines(page, [line])
    expect((await pdfJsText(bytes))[0]).toContain(asPdfJsReads(line))
  })

  it('an Excalifont note whose accent its latin file lacks: the mark comes from Excalifont’s own marks file', async () => {
    const line = 'Café au lait'
    const faces = [EXCALIFONT_LATIN, EXCALIFONT_MARKS]
    const { outcome, bytes } = await linesPdf([{ css: EXCALIFONT_CSS, text: line }], faces)
    expect(outcome).toEqual({ vector: true })
    const page = readPage(await PDFDocument.load(bytes), 0)
    expectNoNotdef(page)
    expectLines(page, [line])
    expect((await pdfJsText(bytes))[0]).toContain(asPdfJsReads(line))
  })

  it('Excalifont draws U+0020 and U+00A0 with one glyph: each keeps its own text (a second embedding for U+00A0)', async () => {
    const line = 'a b c d e'
    const { outcome, bytes } = await linesPdf([{ css: EXCALIFONT_CSS, text: line }], [EXCALIFONT_LATIN])
    expect(outcome).toEqual({ vector: true })
    const page = readPage(await PDFDocument.load(bytes), 0)
    expectNoNotdef(page)
    expectLines(page, [line])
    // two embedded subsets of the one file, each glyph named one text by its ToUnicode
    const subsets = new Set([...page.fonts.values()].filter((f) => f.cid).map((f) => f.baseFont))
    expect(subsets.size).toBe(2)
    expect((await pdfJsText(bytes))[0]).toContain(asPdfJsReads(line))
  })

  it('every code point Nunito’s and Lilita One’s latin files claim but lack: no .notdef, each one in the text', async () => {
    const lines: Line[] = []
    const faces = [NUNITO_LATIN_EXT, NUNITO_LATIN, LILITA_LATIN]
    for (const [face, css, count] of [
      [NUNITO_LATIN, NUNITO_CSS, 100],
      [LILITA_LATIN, LILITA_CSS, 112],
    ] as const) {
      const missing = declaredButMissing(face)
      expect(missing.length, face.url).toBe(count)
      // the right-to-left marks among them reorder the line on the board: such a page is an image page (as RTL text)
      const rtl = missing.filter(isRtl)
      expect(rtl, face.url).toEqual([0x200f, 0x202b, 0x202e, 0x2067])
      expect((await linesPdf([{ css, text: `a${String.fromCodePoint(0x202e)}b` }], faces)).outcome).toEqual({
        vector: false,
        reason: 'it has right-to-left text',
      })
      // the rest each after a letter the face has, ten to a line
      const rest = missing.filter((cp) => !isRtl(cp))
      for (let i = 0; i < rest.length; i += 10) {
        const text = rest
          .slice(i, i + 10)
          .map((cp) => `a${String.fromCodePoint(cp)}`)
          .join('')
        lines.push({ css, text })
      }
    }
    const { outcome, bytes, pictured } = await linesPdf(lines, faces)
    expect(outcome).toEqual({ vector: true })
    const page = readPage(await PDFDocument.load(bytes), 0)
    expectNoNotdef(page)
    expectLines(
      page,
      lines.map((l) => l.text),
    )
    // what no Lobby font here has is a picture (‑, ‒, ‰, ⁂…); the spaces and format characters are not
    expect(pictured).toContain('‑')
    const hex = (t: string) => [...t].map((c) => (c.codePointAt(0) as number).toString(16))
    expect(pictured.filter((t) => /\s|\p{Cf}/u.test(t)).map(hex)).toEqual([])
  })
})
