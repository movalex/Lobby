// Text on a vector page (wave N, N6-3). The SVG names each line's font families (`Excalifont, Xiaolai, …`), and
// Lobby's fonts come as one woff2 file per unicode range (canvas/export/fonts.ts). A PDF text run has ONE font, so
// each line is split here into runs by the face that draws each character (each grapheme cluster), as the browser
// picks it: the first face, in the order of the line's families and of the face table, whose range claims the
// character AND whose font has a glyph for it (wave N.1: a range is a claim, not a promise; Nunito's latin file claims
// U+2000-206F and lacks a third of it, and fontkit would draw its .notdef there: a box, or in Lilita One, Comic Shanns
// and Excalifont nothing). A character none of the line's faces has is drawn in the PDF's standard Helvetica when it
// can encode it (the vote badges' system font, a footer; U+0020 its only space), else in a last-resort face (`any`:
// Lobby's CJK font), else as a small picture the browser draws at its place (emoji, a symbol no Lobby font has); a
// space or a format character no font has is nothing visible. Pictures and those blanks keep their text as invisible
// text (vector-page.ts), so every character is in the PDF's text exactly. A cluster no one font draws whole (a letter
// and a mark from another file) is split into its code points.
//
// The runs are positioned here (the SVG's `text-anchor`, `dx` and the baseline rule applied with the embedded
// fonts' own advance widths), so every run is drawn left-aligned on the baseline. Pure: the fonts' measures and
// glyphs are handed in, so this is tested in Node.

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

/** What draws one character or cluster. */
export type Draw =
  /**
   * A Lobby face. `slot`: which embedding of it. A font may draw two code points with one glyph (Excalifont's space
   * and no-break space), and a PDF font's ToUnicode names one text a glyph, so the n-th code point of such a pair or
   * group is drawn from the face's n-th extra embedding (its own subset and ToUnicode); 0 for everything else.
   */
  | { readonly kind: 'face'; readonly face: PdfFace; readonly slot: number }
  | { readonly kind: 'standard' }
  /** no Lobby font has it (emoji, a symbol): a picture the browser draws, its text invisible text */
  | { readonly kind: 'glyph' }
  /** a space or a format character no Lobby font has: nothing visible, its text invisible text */
  | { readonly kind: 'blank' }

const STANDARD: Draw = { kind: 'standard' }
const GLYPH: Draw = { kind: 'glyph' }
const BLANK: Draw = { kind: 'blank' }

/** What the faces' fonts have: the glyphs behind the ranges' claims (vector-page.ts reads the embedded fonts). */
export interface FaceGlyphs {
  /** -1: the face's font has no glyph for `cp`; else the embedding that draws it (see Draw `slot`) */
  slot(face: PdfFace, cp: number): number
}

/** Each face taken at its range's word (no font read): the layout tests, and a page's first look at its text. */
export const DECLARED: FaceGlyphs = { slot: () => 0 }

/** Whether the standard PDF fonts (Helvetica) encode a code point: Windows-1252 (../pdf-text.ts, one table). */
export const winAnsi = isWinAnsiCodePoint

/**
 * Right-to-left scripts (Hebrew, Arabic, Syriac, Thaana, N'Ko…) and the explicit right-to-left embedding, override
 * and isolate marks: never laid out here (the page is drawn as an image). U+FEFF (a BOM) is not Arabic.
 */
export const isRtl = (cp: number) =>
  (cp >= 0x0590 && cp <= 0x08ff) ||
  (cp >= 0xfb1d && cp <= 0xfdff) ||
  (cp >= 0xfe70 && cp <= 0xfefc) ||
  cp === 0x200f ||
  cp === 0x202b ||
  cp === 0x202e ||
  cp === 0x2067

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u

/**
 * A code point that draws nothing: a control character, or a default-ignorable one (Unicode's
 * DerivedCoreProperties: ZWJ, ZWSP, the soft hyphen, variation selectors, bidi marks, a BOM) less the Hangul fillers,
 * as HarfBuzz and fontkit treat them.
 */
export function isInvisible(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true
  if (cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0) return false
  return DEFAULT_IGNORABLE.test(String.fromCodePoint(cp))
}

const isSpaceCp = (cp: number) => /^\s$/u.test(String.fromCodePoint(cp))

/**
 * The advance (in em) of a space no Lobby font has, as Unicode defines it (a no-break space, a figure or punctuation
 * space: Helvetica's, as the board's `sans-serif` fallback draws them); 0 for what draws nothing.
 */
const SPACE_EM: ReadonlyMap<number, number> = new Map([
  [0x2000, 0.5],
  [0x2001, 1],
  [0x2002, 0.5],
  [0x2003, 1],
  [0x2004, 1 / 3],
  [0x2005, 0.25],
  [0x2006, 1 / 6],
  [0x2007, 0.556],
  [0x2009, 0.2],
  [0x200a, 0.1],
  [0x2028, 0],
  [0x2029, 0],
  [0x202f, 0.2],
  [0x205f, 4 / 18],
  [0x3000, 1],
])
const HELVETICA_SPACE_EM = 0.278

/** The width of a blank run (spaces and format characters no Lobby font has) at `sizePx`. */
export function blankWidth(text: string, sizePx: number): number {
  let em = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    em += isInvisible(cp) ? 0 : (SPACE_EM.get(cp) ?? HELVETICA_SPACE_EM)
  }
  return em * sizePx
}

export class FaceIndex {
  private readonly ranges = new Map<PdfFace, Ranges>()
  readonly faces: readonly PdfFace[]
  private readonly glyphs: FaceGlyphs
  constructor(faces: readonly PdfFace[], glyphs: FaceGlyphs = DECLARED) {
    this.faces = faces
    this.glyphs = glyphs
    for (const f of faces) this.ranges.set(f, parseUnicodeRange(f.unicodeRange))
  }

  /** The embedding of `face` that draws every code point of `cps` (its range claims each, its font has each), or -1. */
  private slotOf(face: PdfFace, cps: readonly number[]): number {
    const ranges = this.ranges.get(face) as Ranges
    let slot = -1
    for (const cp of cps) {
      if (!inRanges(cp, ranges)) return -1
      const s = this.glyphs.slot(face, cp)
      if (s < 0 || (slot >= 0 && s !== slot)) return -1
      slot = s
    }
    return slot
  }

  /**
   * What draws a cluster (see the header): the first face of `families` (in order, then in the table's order) that
   * draws all of it; else the standard font when it encodes all of it (U+0020 its only space); else a last-resort
   * face (`any`: Lobby's CJK font) that draws it; else, for one code point, nothing visible (a space or a format
   * character) or a picture. Null: no one font draws the whole cluster (the caller splits it into its code points).
   */
  drawCluster(cluster: string, families: readonly string[]): Draw | null {
    const cps = [...cluster].map((ch) => ch.codePointAt(0) ?? 0)
    if (cps.length === 1 && isInvisible(cps[0] as number)) return BLANK
    if (cps.length > 1 && cps.some(isInvisible)) return null
    for (const fam of families)
      for (const face of this.faces) {
        if (face.family !== fam) continue
        const slot = this.slotOf(face, cps)
        if (slot >= 0) return { kind: 'face', face, slot }
      }
    if (cps.every((cp) => winAnsi(cp) && (cp === 0x20 || !isSpaceCp(cp)))) return STANDARD
    for (const face of this.faces) {
      if (!face.any) continue
      const slot = this.slotOf(face, cps)
      if (slot >= 0) return { kind: 'face', face, slot }
    }
    if (cps.length > 1) return null
    return isSpaceCp(cps[0] as number) ? BLANK : GLYPH
  }

  /** What draws one code point (a cluster of one: never split). */
  draw(cp: number, families: readonly string[]): Draw {
    return this.drawCluster(String.fromCodePoint(cp), families) ?? GLYPH
  }
}

const sameDraw = (a: Draw, b: Draw) =>
  a.kind === b.kind && (a.kind !== 'face' || (b.kind === 'face' && a.face === b.face && a.slot === b.slot))

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
  /** the span's CSS font-family list (a picture is drawn with it, as the board draws the character) */
  readonly families: string
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

/**
 * SVG's default white-space handling (no `pre`): newlines go, tabs and runs of spaces become one space, the ends are
 * trimmed. Only XML's white space: a no-break or thin space is a character, kept as it is.
 */
function collapse(spans: Span[]): Span[] {
  const out = spans.map((s) => ({ ...s, text: s.text.replace(/[\n\r]/g, '').replace(/[ \t]+/g, ' ') }))
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

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

/**
 * A cluster drawn as an emoji: a pictograph in a ZWJ sequence, with a skin tone, emoji presentation (U+FE0F) or a tag
 * sequence, or a keycap. A letter followed by a ZWJ or U+FE0F is a letter (the mark draws nothing).
 */
export function isEmojiSequence(cluster: string): boolean {
  if ([...cluster].length < 2) return false
  let sequence = false
  for (const ch of cluster) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0x20e3) return true
    if (
      cp === 0x200d ||
      cp === 0xfe0f ||
      (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
      (cp >= 0xe0020 && cp <= 0xe007f)
    )
      sequence = true
  }
  return sequence && PICTOGRAPHIC.test(cluster)
}

/**
 * Lays out one <text> (a line): its spans split into runs by the face that draws each character, positioned with
 * the fonts' widths, the anchor and the baseline rule. A space is a character like any other: in the run of the
 * font that has it (its own character, a no-break or thin space kept as it is), so the PDF's text has it exactly.
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
  // runs before positioning: [draw, text, span style]
  interface Piece {
    readonly draw: Draw
    readonly text: string
    readonly style: Style
    readonly dxBefore: number
  }
  const pieces: Piece[] = []
  for (const span of spans) {
    const families = familyList(span.style['font-family'])
    let cur: { draw: Draw; text: string } | null = null
    let dx = span.dx
    const flush = () => {
      if (cur?.text) pieces.push({ draw: cur.draw, text: cur.text, style: span.style, dxBefore: dx })
      if (cur?.text) dx = 0
      cur = null
    }
    const add = (piece: string, d: Draw) => {
      const c = cur as { draw: Draw; text: string } | null
      if (c && sameDraw(c.draw, d)) c.text += piece
      else {
        flush()
        cur = { draw: d, text: piece }
      }
    }
    for (const ch of clusters(span.text.replace(/[\n\r\t]/g, ' '))) {
      // an emoji sequence (ZWJ, a skin tone, a keycap, emoji presentation) is one picture, never split by face
      const whole = isEmojiSequence(ch) ? GLYPH : faces.drawCluster(ch, families)
      if (whole) add(ch, whole)
      else for (const c of ch) add(c, faces.draw(c.codePointAt(0) ?? 0, families))
    }
    flush()
  }
  if (pieces.length === 0) return []

  const sizeOf = (s: Style) => {
    const v = num(s['font-size'])
    return v && v > 0 ? v : 16
  }
  const widths = pieces.map((p) =>
    measure.width(p.draw, p.text, sizeOf(p.style), BOLD(p.style['font-weight'])),
  )
  const total = pieces.reduce((sum, p, i) => sum + p.dxBefore + (widths[i] as number), 0)
  const anchor = style['text-anchor'] ?? 'start'
  let x = (num(text.attrs.x) ?? 0) - (anchor === 'middle' ? total / 2 : anchor === 'end' ? total : 0)
  // the baseline: the line's own font (its first run that draws something) gives the central and hanging offsets
  const first = pieces.find((p) => p.draw.kind !== 'blank') ?? (pieces[0] as Piece)
  const firstDraw = first.draw
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
      families: p.style['font-family'] ?? '',
    })
    x += w
  })
  return out
}

/** Whether a <text> uses right-to-left characters (laid out here never: the page is drawn as an image). */
export function hasRtl(text: XElement): boolean {
  for (const ch of textOf(text)) if (isRtl(ch.codePointAt(0) ?? 0)) return true
  return false
}
