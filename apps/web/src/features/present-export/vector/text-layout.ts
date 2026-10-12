// Text on a vector page (wave N, N6-3). The SVG names each line's font families (`Excalifont, Xiaolai, …`), and
// Lobby's fonts come as one woff2 file per unicode range (canvas/export/fonts.ts). A PDF text run has ONE font, and
// the fork's drawSvg picks fonts by family name only, so each line is split here into runs by the face that draws
// each character: the first family in the line's list with a face whose range covers it, as the browser does.
// A character no Lobby face covers is drawn in the PDF's standard Helvetica when it can encode it (the vote badges'
// system font, a footer), and otherwise (emoji) as a small picture of the glyph at its place.
//
// The runs are positioned here (the SVG's `text-anchor`, `dx` and the baseline rule applied with the embedded
// fonts' own advance widths), so every run is drawn left-aligned on the baseline. Pure: the fonts' measures are
// handed in, so this is tested in Node.

import { inRanges, parseUnicodeRange, type Ranges } from '../../../canvas/export/fonts.ts'
import { isWinAnsiCodePoint } from '../pdf-text.ts'
import { num, type Style } from './svg-scene.ts'
import { textOf, type XElement } from './svg-tree.ts'

/** One face of the table a `fonts: 'names'` SVG carries (canvas/export/svg.ts namedFaces). */
export interface PdfFace {
  readonly family: string
  /** a same-origin path under /excalidraw-assets/fonts/ */
  readonly url: string
  readonly unicodeRange: string
  readonly weight: string
  readonly style: string
  /** a last resort for any family (Lobby's CJK font for CJK in a family without a CJK fallback) */
  readonly any?: true
}

/** Only Lobby's own font files are ever fetched: a same-origin path to a woff2 under the engine's asset folder. */
export const FACE_URL = /^\/excalidraw-assets\/fonts\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.woff2$/

/** The face table (JSON) of a 'names' SVG: well-formed entries with Lobby font URLs only. */
export function parseFaceTable(json: string | undefined): PdfFace[] {
  if (!json?.trim()) return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  const list = (raw as { faces?: unknown } | null)?.faces
  if (!Array.isArray(list)) return []
  const out: PdfFace[] = []
  for (const f of list) {
    if (!f || typeof f !== 'object') continue
    const { family, url, unicodeRange, weight, style, any } = f as Record<string, unknown>
    if (typeof family !== 'string' || !family || typeof url !== 'string' || !FACE_URL.test(url)) continue
    out.push({
      family,
      url,
      unicodeRange: typeof unicodeRange === 'string' ? unicodeRange : '',
      weight: typeof weight === 'string' ? weight : '400',
      style: typeof style === 'string' ? style : 'normal',
      ...(any === true ? { any: true as const } : {}),
    })
  }
  return out
}

/** A CSS family list (`Excalifont, Xiaolai, "Segoe UI Emoji"`) → names. */
export function familyList(css: string | undefined): string[] {
  if (!css) return []
  return css
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/** What draws one character: a Lobby face, the standard font, or nothing the PDF has (a glyph picture). */
export type Draw =
  | { readonly kind: 'face'; readonly face: PdfFace }
  | { readonly kind: 'standard' }
  | { readonly kind: 'glyph' }

/** Whether the standard PDF fonts (Helvetica) encode a code point: Windows-1252 (../pdf-text.ts, one table). */
export const winAnsi = isWinAnsiCodePoint

/** Right-to-left scripts (Hebrew, Arabic, Syriac, Thaana, N'Ko…): never laid out here (the page is drawn as an image). */
export const isRtl = (cp: number) =>
  (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)

export class FaceIndex {
  private readonly ranges = new Map<PdfFace, Ranges>()
  readonly faces: readonly PdfFace[]
  constructor(faces: readonly PdfFace[]) {
    this.faces = faces
    for (const f of faces) this.ranges.set(f, parseUnicodeRange(f.unicodeRange))
  }
  /**
   * The face of `families` (in order) that covers `cp`; else the standard font when it encodes it; else a
   * last-resort face (`any`: Lobby's CJK font) that covers it, so the character is real text; else a glyph picture.
   */
  draw(cp: number, families: readonly string[]): Draw {
    for (const fam of families)
      for (const face of this.faces)
        if (face.family === fam && inRanges(cp, this.ranges.get(face) as Ranges))
          return { kind: 'face', face }
    if (winAnsi(cp)) return { kind: 'standard' }
    for (const face of this.faces)
      if (face.any && inRanges(cp, this.ranges.get(face) as Ranges)) return { kind: 'face', face }
    return { kind: 'glyph' }
  }
}

const sameDraw = (a: Draw, b: Draw) =>
  a.kind === b.kind && (a.kind !== 'face' || (b.kind === 'face' && a.face === b.face))

/** The run's measures with the font that draws it (advance width; ascent above and descent below the baseline, >= 0). */
export interface Measure {
  width(draw: Draw, text: string, sizePx: number, bold: boolean): number
  ascent(draw: Draw, sizePx: number, bold: boolean): number
  descent(draw: Draw, sizePx: number, bold: boolean): number
}

/** One positioned run, left-aligned on its baseline, in the <text>'s own user space. */
export interface PlacedRun {
  readonly draw: Draw
  readonly text: string
  readonly x: number
  /** the baseline */
  readonly y: number
  readonly sizePx: number
  readonly bold: boolean
  readonly fill: string
  readonly fillOpacity: number
  readonly width: number
}

interface Span {
  readonly text: string
  readonly style: Style
  readonly dx: number
}

const BOLD = (w: string | undefined) => w === 'bold' || w === 'bolder' || (num(w) ?? 400) >= 600

/** The <text>'s spans: its own text and each <tspan> (with what the span overrides), in order. */
function spansOf(text: XElement, style: Style, ownOf: (el: XElement) => Record<string, string>): Span[] {
  const out: Span[] = []
  for (const c of text.children) {
    if (typeof c === 'string') out.push({ text: c, style, dx: 0 })
    else if (c.name === 'tspan') {
      const own = ownOf(c)
      const merged: Record<string, string> = { ...style }
      for (const [k, v] of Object.entries(own)) if (v !== 'inherit') merged[k] = v
      out.push({ text: textOf(c), style: merged, dx: num(c.attrs.dx) ?? 0 })
    }
  }
  return out
}

/** SVG's default white-space handling (no `pre`): newlines go, runs of spaces become one, the ends are trimmed. */
function collapse(spans: Span[]): Span[] {
  const out = spans.map((s) => ({ ...s, text: s.text.replace(/[\n\r]/g, '').replace(/\s+/g, ' ') }))
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1] as Span
    if (prev.text.endsWith(' '))
      out[i] = { ...(out[i] as Span), text: (out[i] as Span).text.replace(/^ /, '') }
  }
  if (out[0]) out[0] = { ...out[0], text: out[0].text.replace(/^ /, '') }
  const last = out[out.length - 1]
  if (last) out[out.length - 1] = { ...last, text: last.text.replace(/ $/, '') }
  return out
}

const isSpace = (ch: string) => /^\s$/.test(ch)

type SegmenterCtor = new (
  locale?: string,
  o?: { granularity: 'grapheme' },
) => { segment(s: string): Iterable<{ segment: string }> }
const Segmenter = (globalThis as { Intl?: { Segmenter?: SegmenterCtor } }).Intl?.Segmenter

/** The text's grapheme clusters (a letter with its marks, a whole emoji sequence); code points without Intl.Segmenter. */
export function clusters(text: string): string[] {
  if (!Segmenter) return [...text]
  return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
}

/** A cluster drawn as an emoji: a ZWJ sequence, a skin tone, a keycap, emoji presentation (U+FE0F), a tag sequence. */
export function isEmojiSequence(cluster: string): boolean {
  if ([...cluster].length < 2) return false
  for (const ch of cluster) {
    const cp = ch.codePointAt(0) ?? 0
    if (
      cp === 0x200d ||
      cp === 0xfe0f ||
      cp === 0x20e3 ||
      (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
      (cp >= 0xe0020 && cp <= 0xe007f)
    )
      return true
  }
  return false
}

/**
 * Lays out one <text> (a line): its spans split into runs by the face that draws each character, positioned with
 * the fonts' widths, the anchor and the baseline rule. Whitespace stays in a run whose font has it and is measured
 * between runs otherwise; it is never drawn on its own.
 */
export function layoutText(
  text: XElement,
  style: Style,
  faces: FaceIndex,
  measure: Measure,
  ownOf: (el: XElement) => Record<string, string>,
): PlacedRun[] {
  const pre = /^pre/.test(style['white-space'] ?? '')
  let spans = spansOf(text, style, ownOf)
  if (!pre) spans = collapse(spans)
  // runs before positioning: [draw, text, span style]; whitespace-only pieces carry draw null
  interface Piece {
    readonly draw: Draw | null
    readonly text: string
    readonly style: Style
    readonly dxBefore: number
  }
  const pieces: Piece[] = []
  for (const span of spans) {
    const families = familyList(span.style['font-family'])
    let cur: { draw: Draw | null; text: string } | null = null
    let dx = span.dx
    const flush = () => {
      if (cur?.text) pieces.push({ draw: cur.draw, text: cur.text, style: span.style, dxBefore: dx })
      if (cur?.text) dx = 0
      cur = null
    }
    for (const ch of clusters(span.text.replace(/[\n\r\t]/g, ' '))) {
      const cp = ch.codePointAt(0) ?? 0
      if (isSpace(ch)) {
        const c = cur as { draw: Draw | null; text: string } | null
        // a space joins the run when its font draws a space too; else it is a gap of its own
        if (c?.draw && sameDraw(faces.draw(0x20, families), c.draw)) c.text += ' '
        else if (c && c.draw === null) c.text += ' '
        else {
          flush()
          cur = { draw: null, text: ' ' }
        }
        continue
      }
      // an emoji sequence (ZWJ, a skin tone, a keycap, emoji presentation) is one picture, never split by face
      const d: Draw = isEmojiSequence(ch) ? { kind: 'glyph' } : faces.draw(cp, families)
      const c = cur as { draw: Draw | null; text: string } | null
      if (c?.draw && sameDraw(c.draw, d)) c.text += ch
      else {
        flush()
        cur = { draw: d, text: ch }
      }
    }
    flush()
  }
  if (pieces.length === 0) return []

  const sizeOf = (s: Style) => {
    const v = num(s['font-size'])
    return v && v > 0 ? v : 16
  }
  const spaceDraw = (s: Style): Draw => {
    const d = faces.draw(0x20, familyList(s['font-family']))
    return d.kind === 'glyph' ? { kind: 'standard' } : d
  }
  // measure every piece (whitespace pieces with the font that draws a space in their family list)
  const widths = pieces.map((p) => {
    const size = sizeOf(p.style)
    const bold = BOLD(p.style['font-weight'])
    if (p.draw === null) return measure.width(spaceDraw(p.style), p.text, size, bold)
    if (p.draw.kind === 'glyph') return measure.width(p.draw, p.text, size, bold)
    // a run's trailing spaces are measured in, its leading ones too (they are in the run's own font)
    return measure.width(p.draw, p.text, size, bold)
  })
  const total = pieces.reduce((sum, p, i) => sum + p.dxBefore + (widths[i] as number), 0)
  const anchor = style['text-anchor'] ?? 'start'
  let x = (num(text.attrs.x) ?? 0) - (anchor === 'middle' ? total / 2 : anchor === 'end' ? total : 0)
  // the baseline: the line's own font (its first drawn run) gives the central and hanging offsets
  const first = pieces.find((p) => p.draw !== null) ?? (pieces[0] as Piece)
  const firstDraw = first.draw ?? spaceDraw(first.style)
  const fsize = sizeOf(style)
  const fbold = BOLD(style['font-weight'])
  const asc = measure.ascent(firstDraw, fsize, fbold)
  const desc = measure.descent(firstDraw, fsize, fbold)
  const y0 = num(text.attrs.y) ?? 0
  const db = style['dominant-baseline'] ?? 'auto'
  const baseline =
    db === 'central' || db === 'middle'
      ? y0 + (asc - desc) / 2
      : db === 'hanging' || db === 'text-before-edge'
        ? y0 + asc
        : db === 'ideographic' || db === 'text-after-edge'
          ? y0 - desc
          : y0
  const out: PlacedRun[] = []
  pieces.forEach((p, i) => {
    x += p.dxBefore
    const w = widths[i] as number
    if (p.draw) {
      const fo = num(p.style['fill-opacity'] ?? '1') ?? 1
      out.push({
        draw: p.draw,
        text: p.text,
        x,
        y: baseline,
        sizePx: sizeOf(p.style),
        bold: BOLD(p.style['font-weight']),
        fill: p.style.fill ?? 'black',
        fillOpacity: Math.min(1, Math.max(0, fo)),
        width: w,
      })
    }
    x += w
  })
  return out
}

/** Whether a <text> uses right-to-left characters (laid out here never: the page is drawn as an image). */
export function hasRtl(text: XElement): boolean {
  for (const ch of textOf(text)) if (isRtl(ch.codePointAt(0) ?? 0)) return true
  return false
}
