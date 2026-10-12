// The font engine of vector PDF pages (wave N, N6-1; wave N.1): @pdf-lib/fontkit 1.1.1 (MIT; its one dependency, pako,
// is MIT AND Zlib) reads Lobby's self-hosted font files and subsets them into the PDF (PDFDocument.registerFontkit,
// embedFont(bytes, { subset: true })). Its build bundles a pure-JS brotli decoder (no WASM, no eval), so it reads the
// woff2 files under /excalidraw-assets/fonts/ as they are served: their metrics, layout and glyph outlines.
//
// Two adapters, both proven on every font file the build ships (fontkit.test.ts) and in a viewer (n6-vector-pdf):
//  1. Subsets of a woff2 font. Every Lobby font is a woff2 file whose glyf and loca tables are TRANSFORMED (WOFF2 §5):
//     fontkit decodes the outlines from the transformed streams, but its TrueType subsetter copies each glyph's raw
//     bytes through loca offsets the transformed table does not have, so the subset's glyphs were bytes of the
//     transformed streams (the text was there, searchable, and invisible in pdf.js). Its own re-encoder
//     (`encodeSimple`, used for variable fonts) drops a trailing flag repeat count and garbles some glyphs. So for
//     these fonts each glyph is written here from its decoded contours (`encodeSimpleGlyph`): the same points and
//     on-curve flags, a composite flattened into its components' points, no hinting instructions (PDF viewers draw
//     outlines, not hinted pixels).
//  2. @cantoo/pdf-lib's subset embedder calls `subset.encode()` with no argument whenever the subset has an `encode`
//     method (fontkit 2's sync API); @pdf-lib/fontkit's `encode(stream)` needs the stream it writes into, so the call
//     threw. The subsets handed to the fork expose the stream API only (`includeGlyph`, `encodeStream`, `cff`): the
//     path upstream pdf-lib takes with this same engine.
// The adapters use fontkit internals (`_addGlyph`, `_getContours`, the subset's `glyf`/`loca`/`hmtx` arrays): the
// version is pinned exactly in the catalog, and fontkit.test.ts fails if any of them moves.
//
// It loads with the PDF worker only (pdf.worker.ts), or with pdf-client.ts's no-worker fallback chunk, never with the
// board: this module is reached from those two alone (the fallback imports it dynamically, with pdf-build.ts), so the
// engine is in the worker's bundle and in a lazy page chunk the board never loads statically
// (apps/web/test/bundle/pdf-worker-chunk.test.ts reads the module graph and proves both).
import type { PDFDocument } from '@cantoo/pdf-lib'
import * as pdfLibFontkit from '@pdf-lib/fontkit'

export type Fontkit = Parameters<PDFDocument['registerFontkit']>[0]

/** A glyph outline point as fontkit decodes it (font units). */
export interface OutlinePoint {
  readonly x: number
  readonly y: number
  readonly onCurve: boolean
}

// TrueType simple glyph flags (OpenType `glyf`)
const ON_CURVE = 0x01
const X_SHORT = 0x02
const Y_SHORT = 0x04
const X_SAME_OR_POSITIVE = 0x10
const Y_SAME_OR_POSITIVE = 0x20

const int16 = (n: number) => Math.max(-32768, Math.min(32767, Math.round(n)))

/**
 * One TrueType simple glyph (a `glyf` entry) from its contours: the points in order with their on-curve flags, one
 * flag byte a point (no repeat runs), each coordinate a delta in a byte where it fits, no instructions, padded to 4
 * bytes. Empty (no points): zero bytes, as an empty glyph is in `glyf`.
 */
export function encodeSimpleGlyph(contours: readonly (readonly OutlinePoint[])[]): Uint8Array {
  const list = contours.filter((c) => c.length > 0)
  const points = list.flat().map((p) => ({ x: int16(p.x), y: int16(p.y), on: p.onCurve }))
  if (points.length === 0) return new Uint8Array(0)
  const ends: number[] = []
  let n = -1
  for (const c of list) {
    n += c.length
    ends.push(n)
  }
  let xMin = Number.POSITIVE_INFINITY
  let yMin = Number.POSITIVE_INFINITY
  let xMax = Number.NEGATIVE_INFINITY
  let yMax = Number.NEGATIVE_INFINITY
  for (const p of points) {
    xMin = Math.min(xMin, p.x)
    yMin = Math.min(yMin, p.y)
    xMax = Math.max(xMax, p.x)
    yMax = Math.max(yMax, p.y)
  }
  const flags: number[] = []
  const xs: number[] = [] // each delta: a byte (its sign in the flag) or a signed word (xWide)
  const ys: number[] = []
  const xWide: boolean[] = []
  const yWide: boolean[] = []
  let px = 0
  let py = 0
  for (const p of points) {
    let flag = p.on ? ON_CURVE : 0
    const dx = p.x - px
    const dy = p.y - py
    if (dx === 0) flag |= X_SAME_OR_POSITIVE
    else if (Math.abs(dx) <= 255) {
      flag |= X_SHORT | (dx > 0 ? X_SAME_OR_POSITIVE : 0)
      xs.push(Math.abs(dx))
      xWide.push(false)
    } else {
      xs.push(dx)
      xWide.push(true)
    }
    if (dy === 0) flag |= Y_SAME_OR_POSITIVE
    else if (Math.abs(dy) <= 255) {
      flag |= Y_SHORT | (dy > 0 ? Y_SAME_OR_POSITIVE : 0)
      ys.push(Math.abs(dy))
      yWide.push(false)
    } else {
      ys.push(dy)
      yWide.push(true)
    }
    flags.push(flag)
    px = p.x
    py = p.y
  }
  const coordBytes = (wide: boolean[]) => wide.reduce((s, w) => s + (w ? 2 : 1), 0)
  const size = 10 + 2 * ends.length + 2 + flags.length + coordBytes(xWide) + coordBytes(yWide)
  const out = new Uint8Array(size + ((4 - (size % 4)) % 4))
  const v = new DataView(out.buffer)
  v.setInt16(0, ends.length)
  v.setInt16(2, xMin)
  v.setInt16(4, yMin)
  v.setInt16(6, xMax)
  v.setInt16(8, yMax)
  let o = 10
  for (const e of ends) {
    v.setUint16(o, e)
    o += 2
  }
  v.setUint16(o, 0) // instructionLength
  o += 2
  for (const f of flags) out[o++] = f
  const write = (values: number[], wide: boolean[]) => {
    values.forEach((value, i) => {
      if (wide[i]) {
        v.setInt16(o, value)
        o += 2
      } else out[o++] = value
    })
  }
  write(xs, xWide)
  write(ys, yWide)
  return out
}

/** What the adapters read of @pdf-lib/fontkit 1.1.1 (its own typings declare no default export or internals). */
interface PdfLibGlyph {
  readonly advanceWidth: number
  _getContours(): OutlinePoint[][]
  _getMetrics(): { leftBearing: number }
}
interface PdfLibMaxp {
  maxPoints: number
  maxContours: number
}
interface PdfLibFont {
  createSubset(): PdfLibSubset
  readonly directory?: { readonly tables?: Record<string, { readonly transformed?: boolean } | undefined> }
  readonly stream?: { readonly buffer?: { readonly constructor: unknown } }
  readonly maxp?: PdfLibMaxp
  getGlyph(gid: number): PdfLibGlyph
}
interface PdfLibSubset {
  includeGlyph(glyph: unknown): number
  encodeStream(): unknown
  readonly cff?: unknown
  // TTFSubset internals the woff2 adapter writes
  glyphs?: number[]
  glyf?: unknown[]
  loca?: { offsets: number[] }
  hmtx?: { metrics: { advance: number; bearing: number }[] }
  offset?: number
  _addGlyph?(gid: number): number
  encode?(stream: unknown): unknown
}
interface PdfLibFontkit {
  create(buffer: Uint8Array, postscriptName?: string): unknown
}

const isFont = (f: unknown): f is PdfLibFont =>
  !!f && typeof f === 'object' && typeof (f as Partial<PdfLibFont>).createSubset === 'function'

/** Whether fontkit's subsetter would copy unusable glyph bytes: a woff2 font with a transformed glyf table. */
export const hasTransformedGlyf = (font: unknown): boolean =>
  isFont(font) && font.directory?.tables?.glyf?.transformed === true

/**
 * fontkit's own Buffer (the stream it writes a subset into accepts nothing else): `from` of the class the woff2
 * font's decompressed stream holds.
 */
function bufferFrom(font: PdfLibFont, bytes: Uint8Array): unknown {
  const B = font.stream?.buffer?.constructor as { from?(b: Uint8Array): unknown } | undefined
  if (typeof B?.from !== 'function') throw new Error('fontkit: no Buffer class to write a glyph with')
  return B.from(bytes)
}

/** Makes a TTF subset of a woff2 font write each glyph from its decoded contours (adapter 1 in the header). */
function writeGlyphsFromOutlines(subset: PdfLibSubset, font: PdfLibFont) {
  subset._addGlyph = function addGlyph(this: PdfLibSubset, gid: number): number {
    const glyph = font.getGlyph(gid)
    const bytes = encodeSimpleGlyph(glyph._getContours())
    const glyf = this.glyf as unknown[]
    const loca = this.loca as { offsets: number[] }
    const hmtx = this.hmtx as { metrics: { advance: number; bearing: number }[] }
    glyf.push(bufferFrom(font, bytes))
    loca.offsets.push(this.offset as number)
    hmtx.metrics.push({ advance: glyph.advanceWidth, bearing: glyph._getMetrics().leftBearing })
    this.offset = (this.offset as number) + bytes.length
    return glyf.length - 1
  }
  // the subset's maxp is a copy of the font's, taken while it is encoded: a flattened composite may hold more points
  // or contours than the font's simple glyphs did, so the font's maxp is raised to cover every glyph first (the
  // glyph list is complete: flattened composites add no component glyphs)
  const encode = subset.encode
  if (typeof encode !== 'function') throw new Error('fontkit: the subset has no encode')
  subset.encode = function encodeWithMaxp(this: PdfLibSubset, stream: unknown) {
    const maxp = font.maxp
    if (maxp)
      for (const gid of this.glyphs ?? []) {
        const contours = font.getGlyph(gid)._getContours()
        maxp.maxPoints = Math.max(maxp.maxPoints, contours.reduce((s, c) => s + c.length, 0))
        maxp.maxContours = Math.max(maxp.maxContours, contours.length)
      }
    return encode.call(this, stream)
  }
}

/** The subset as the fork reads it: no `encode`, so it takes `encodeStream()` (adapter 2 in the header). */
function streamOnly(subset: PdfLibSubset): PdfLibSubset {
  return {
    includeGlyph: (glyph) => subset.includeGlyph(glyph),
    encodeStream: () => subset.encodeStream(),
    get cff() {
      return subset.cff
    },
  }
}

/** @pdf-lib/fontkit with its subsets made right for Lobby's woff2 fonts and for @cantoo/pdf-lib (see the header). */
export function adaptFontkit(engine: PdfLibFontkit): Fontkit {
  return {
    create(buffer: Uint8Array, postscriptName?: string) {
      const font = engine.create(buffer, postscriptName)
      if (isFont(font)) {
        const own = font.createSubset.bind(font)
        const woff2 = hasTransformedGlyf(font)
        font.createSubset = () => {
          const subset = own()
          if (woff2 && !subset.cff) writeGlyphsFromOutlines(subset, font)
          return streamOnly(subset)
        }
      }
      return font as ReturnType<Fontkit['create']>
    },
  }
}

/** The font engine, or null when it cannot load (a vector page with Lobby-font text then falls back to an image). */
export async function loadFontkit(): Promise<Fontkit | null> {
  try {
    const mod = pdfLibFontkit as unknown as { default?: PdfLibFontkit } & PdfLibFontkit
    const engine = mod.default ?? mod
    return typeof engine?.create === 'function' ? adaptFontkit(engine) : null
  } catch {
    return null
  }
}
