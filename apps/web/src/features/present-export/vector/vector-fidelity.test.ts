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
import * as pdfLibFontkit from '@pdf-lib/fontkit'
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { servedFontFile } from '../../../canvas/export/test-fixtures.ts'
import { createPdfBuilder } from '../pdf-build.ts'
import { loadFontkit, type OutlinePoint } from './fontkit.ts'

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
        list.forEach((t, i) => out.set(lo + i, t))
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
        next.asArray().forEach((v, k) => widths.set(c + k, (v as PDFNumber).asNumber()))
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
              text += info?.toUnicode.get(code) ?? (info?.cid ? MISSING : String.fromCharCode(code))
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
            expect(info.widths.get(cid), `${label} /W`).toBeCloseTo((g.advanceWidth * 1000) / src.unitsPerEm, 0)
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
