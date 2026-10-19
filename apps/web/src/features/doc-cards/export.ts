// OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2 "The face is never in an export"). The `doc-cards` export
// layer: the DOM face (./DocFace.tsx) is never drawn into an export. The engine's export draws the card and its label's
// plain words (the Markdown marks included: `# Plan`, `**bold**`); this layer covers each exported card's label with the
// card's own fill and draws the same words with the marks taken out, on the label's own wrapped lines (Excalidraw's
// layout, so the words sit where the engine put them): a heading in bold, list markers as •, ☐/☑ and numbers, a
// quote with its bar, a rule as a line, code in the monospace face, link words underlined (no link: an export holds no
// target). Literal colours, text as `<text>` (searchable in the vector PDF), no external reference.
//
// With the feature off this layer is quiet and an export shows the plain words, as an older tab does.
import { isAllowedColor } from '@draftroom/canvas-schema/limits'
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import type { ExportOverlayInput, ExportOverlayLayer } from '../present-export/ported/badges.ts'
import {
  type Block,
  itemMarker,
  type ParsedDoc,
  parseMarkdownLite,
  type StyledRun,
  styledRuns,
} from './markdown-lite.ts'
import { DOC_CARD_KIND, DOC_FILL, docLabel } from './model.ts'
import { docCardsOn } from './state.ts'

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )

const FAMILY: Readonly<Record<number, string>> = {
  1: 'Virgil',
  2: 'Helvetica',
  3: 'Cascadia',
  5: 'Excalifont',
  6: 'Nunito',
  7: 'Lilita One',
  8: 'Comic Shanns',
}
const MONO = 'Cascadia, ui-monospace, Consolas, monospace'
const LINK_INK = '#1c6fd1'
const QUOTE_INK = '#5f6b7a'
const RULE_INK = '#c4bfb0'

/** One wrapped line of the label: the source line it shows and the part of that line, [from, to). */
export interface Segment {
  readonly line: number
  readonly from: number
  readonly to: number
  /** the first wrapped line of its source line (where a list marker goes) */
  readonly first: boolean
}

/**
 * The label's wrapped lines (`text`, Excalidraw's wrapping of `originalText` at the card's width) mapped onto the source
 * lines: each wrapped line is a part of one source line, in order (a break drops the spaces it falls on). When they do
 * not map (a stale layout), one segment per source line.
 */
export function segmentsOf(original: string, wrapped: string): Segment[] {
  const src = original.split('\n')
  const out: Segment[] = []
  const chunks = wrapped.split('\n')
  let k = 0
  let ok = true
  for (let line = 0; line < src.length && ok; line++) {
    const L = src[line] as string
    const end = L.trimEnd().length
    let c = 0
    let first = true
    do {
      const chunk = chunks[k]
      if (chunk === undefined) {
        ok = false
        break
      }
      k++
      const piece = chunk.trimEnd()
      if (piece === '') {
        out.push({ line, from: c, to: c, first })
        first = false
        if (end === 0) break
        continue
      }
      const at = L.indexOf(piece, c)
      if (at < 0 || L.slice(c, at).trim() !== '') {
        ok = false
        break
      }
      out.push({ line, from: at, to: at + piece.length, first })
      first = false
      c = at + piece.length
      while (c < L.length && (L[c] === ' ' || L[c] === '\t')) c++
    } while (c < end)
  }
  if (ok && k === chunks.length) return out
  return src.map((L, line) => ({ line, from: 0, to: L.length, first: true }))
}

/** The runs of `runs` inside [from, to), cut to it. */
function runsIn(runs: readonly StyledRun[], from: number, to: number): StyledRun[] {
  const out: StyledRun[] = []
  for (const r of runs) {
    const a = Math.max(from, r.from)
    const b = Math.min(to, r.from + r.s.length)
    if (b <= a) continue
    out.push({ ...r, s: r.s.slice(a - r.from, b - r.from), from: a })
  }
  return out
}

function tspans(runs: readonly StyledRun[], base: { bold: boolean; ink: string }): string {
  return runs
    .map((r) => {
      const attrs: string[] = []
      if (r.strong || base.bold) attrs.push('font-weight="700"')
      if (r.em) attrs.push('font-style="italic"')
      if (r.code) attrs.push(`font-family="${MONO}"`)
      if (r.link) attrs.push(`fill="${LINK_INK}"`, 'text-decoration="underline"')
      return `<tspan${attrs.length ? ` ${attrs.join(' ')}` : ''}>${esc(r.s)}</tspan>`
    })
    .join('')
}

const colorOr = (c: unknown, fallback: string) =>
  typeof c === 'string' && c !== 'transparent' && isAllowedColor(c) ? c : fallback

/** The baseline of a line in its line box (the label's font: Nunito's metrics, a generic rule otherwise). */
function baselineIn(fontFamily: number, fontSize: number, lineHeightPx: number): number {
  const [ascent, descent] = fontFamily === 6 ? [1.011, 0.353] : [0.95, 0.25]
  return (lineHeightPx - (ascent + descent) * fontSize) / 2 + ascent * fontSize
}

/** One card's markup (export coordinates), or '' when it has no label or no fill to cover it with. */
export function docCardSvg(
  card: CanvasElement,
  label: CanvasElement,
  origin: { readonly x: number; readonly y: number },
  doc?: ParsedDoc,
): string {
  const fill = (card as { backgroundColor?: unknown }).backgroundColor
  // a transparent card shows what is under it: covering its words would hide that, so it keeps the plain words
  if (fill === 'transparent' || (card as { fillStyle?: unknown }).fillStyle !== 'solid') return ''
  const l = label as unknown as {
    x: number
    y: number
    width: number
    height: number
    text?: string
    originalText?: string
    fontSize?: number
    fontFamily?: number
    lineHeight?: number
    strokeColor?: string
  }
  const original = String(l.originalText ?? '')
  const wrapped = String(l.text ?? original)
  const fontSize = Number(l.fontSize) || 16
  const fontFamily = Number(l.fontFamily) || 6
  const lh = (Number(l.lineHeight) || 1.25) * fontSize
  const ink = colorOr(l.strokeColor, '#1b2330')
  const x0 = l.x - origin.x
  const y0 = l.y - origin.y
  const parsed = doc ?? parseMarkdownLite(original)
  const byLine = new Map<number, Block>()
  for (const b of parsed.blocks) byLine.set(b.line, b)
  const runsByLine = new Map<number, StyledRun[]>()
  const base = baselineIn(fontFamily, fontSize, lh)
  const family = `${FAMILY[fontFamily] ?? 'Nunito'}, Segoe UI Emoji, sans-serif`
  let body = ''
  segmentsOf(original, wrapped).forEach((seg, i) => {
    const b = byLine.get(seg.line)
    if (!b || b.t === 'blank') return
    const top = y0 + i * lh
    if (b.t === 'rule') {
      body += `<rect x="${x0}" y="${top + lh / 2 - 0.5}" width="${l.width}" height="1" fill="${RULE_INK}"/>`
      return
    }
    let runs = runsByLine.get(seg.line)
    if (!runs) {
      runs = styledRuns(b)
      runsByLine.set(seg.line, runs)
    }
    // the first wrapped line also holds the line's mark (`# `, `- [ ] `): its words start at the block's start
    const from = seg.first && 'start' in b ? Math.min(seg.from, b.start) : seg.from
    const part = runsIn(runs, from, seg.to)
    let x = x0
    let lead = ''
    if (b.t === 'item') {
      x = x0 + b.depth * fontSize * 1.25
      if (seg.first) lead = `<tspan>${esc(`${itemMarker(b)} `)}</tspan>`
      else x += fontSize * 1.25
    }
    if (b.t === 'quote') {
      body += `<rect x="${x0}" y="${top}" width="3" height="${lh}" fill="${RULE_INK}"/>`
      x = x0 + 10
    }
    const textInk = b.t === 'quote' ? QUOTE_INK : ink
    const spans = lead + tspans(part, { bold: b.t === 'heading', ink: textInk })
    if (!spans) return
    body += `<text x="${x}" y="${top + base}" font-family="${family}" font-size="${fontSize}" fill="${textInk}" xml:space="preserve"${b.t === 'quote' ? ' font-style="italic"' : ''}>${spans}</text>`
  })
  const cover = colorOr(fill, DOC_FILL)
  // the cover: the label's box (its words only; the card's stroke and corners stay the engine's)
  return (
    `<rect x="${x0 - 1}" y="${y0 - 1}" width="${l.width + 2}" height="${l.height + 2}" fill="${cover}"/>` +
    body
  )
}

/** Every exported doc card's markup (export coordinates). */
export function docCardsExportSvg(input: Pick<ExportOverlayInput, 'canvas' | 'exported' | 'origin'>): string {
  const { canvas, exported, origin } = input
  let out = ''
  for (const card of canvas.index.byKind(DOC_CARD_KIND)) {
    if (!exported.has(card.id) || card.type !== 'rectangle' || card.isDeleted) continue
    const label = docLabel(canvas, card)
    if (!label) continue
    out += docCardSvg(card, label, origin)
  }
  return out ? `<g data-layer="doc-cards">${out}</g>` : ''
}

/** The layer as the export-overlay registry takes it: under wave T's chips (10 to 40) and the vote badges (100). */
export const DOC_CARDS_OVERLAY: ExportOverlayLayer = {
  id: 'doc-cards',
  order: 5,
  active: (canvas: LobbyCanvas) => docCardsOn() && canvas.index.byKind(DOC_CARD_KIND).length > 0,
  svg: (input) => docCardsExportSvg(input),
}
