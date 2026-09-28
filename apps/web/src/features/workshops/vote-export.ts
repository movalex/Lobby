// Revealed vote results in exports (final review R14): the retro's key output is the ranking, but the
// result badges are an HTML overlay (WorkshopOverlay ResultBadges), so tldraw's SVG export, and every
// PNG, SVG, PDF and clipboard image made from it, left them out. This module lets present-export draw
// the same badges into the exported SVG, and gives the CSV its votes column.
//
// Only what this person sees on the board: a revealed vote whose badges are shown (the Voting panel's
// "Show results on the board" switch is per person). Results reach the browser only once revealed, so
// an export never shows counts before the reveal.
//
// The workshops feature provides the results per editor (provideVoteResultsForExport, index.tsx);
// present-export reads them (voteResultsForExport) and adds the badges (withVoteBadges) to the SVG
// every export is made from. No editor or DOM here beyond the registry: unit-tested in Node.

import type { VoteResult } from '@draftroom/contracts'
import type { WorkshopSnapshot } from './store.ts'

/** The revealed results this person sees as badges, or null. */
export function shownResults(snap: Pick<WorkshopSnapshot, 'vote' | 'showResults'>): VoteResult[] | null {
  const vote = snap.vote
  if (vote?.session.status !== 'revealed' || !vote.results || !snap.showResults) return null
  return vote.results.length > 0 ? vote.results : null
}

const sources = new WeakMap<object, () => readonly VoteResult[] | null>()

/** Registers where an editor's revealed results come from; returns the unregister function. */
export function provideVoteResultsForExport(editor: object, get: () => readonly VoteResult[] | null) {
  sources.set(editor, get)
  return () => {
    if (sources.get(editor) === get) sources.delete(editor)
  }
}

/** The results to draw into an export of this editor's board (null: none revealed or shown). */
export function voteResultsForExport(editor: object): readonly VoteResult[] | null {
  const results = sources.get(editor)?.() ?? null
  return results && results.length > 0 ? results : null
}

/** A badge on the voted shape's top-right corner (page coordinates), as on the board. */
export interface ExportBadge {
  x: number
  y: number
  rank: number
  /** Votes. */
  n: number
}

// The board's badge (workshops.css .dr-wk-badge) at 100%: 28 px pill, 2 px white border, 13 px bold
// count, "#rank" in 11 px for the top 3 (amber) and dark for the rest. Literal colours: an exported SVG
// is drawn as an image, where the app's CSS variables do not exist (light values, like the export).
const H = 28
const PAD_X = 9
const GAP = 4
const COUNT_PX = 13
const RANK_PX = 11
/** Average advance of a digit / "#" in a bold sans-serif, as a fraction of the font size. */
const CHAR_EM = 0.62
const OFFSET = { x: -18, y: -14 }
const TOP = { fill: '#f0a53a', text: '#1b2330' }
const REST = { fill: '#1b2330', text: '#ffffff' }
const FONT =
  'ui-sans-serif, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, Helvetica, Arial, sans-serif'

const num = (v: number) => String(Math.round(v * 100) / 100)

function badgeWidth(b: ExportBadge): number {
  const count = String(b.n).length * COUNT_PX * CHAR_EM
  const rank = b.rank <= 3 ? `#${b.rank}`.length * RANK_PX * CHAR_EM + GAP : 0
  return Math.max(H, Math.ceil(PAD_X * 2 + rank + count))
}

export interface ViewBox {
  minX: number
  minY: number
  width: number
  height: number
}

/** The viewBox of an exported <svg> (tldraw writes page coordinates there), or null. */
export function viewBoxOf(svg: string): ViewBox | null {
  const m =
    /<svg\b[^>]*?\sviewBox="\s*(-?[\d.e+-]+)[\s,]+(-?[\d.e+-]+)[\s,]+([\d.e+-]+)[\s,]+([\d.e+-]+)\s*"/i.exec(
      svg,
    )
  if (!m) return null
  const [minX, minY, width, height] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number]
  return [minX, minY, width, height].every(Number.isFinite) ? { minX, minY, width, height } : null
}

/**
 * The badges as SVG elements, each placed like the board's (its left edge 18 px left of the corner,
 * centred on the top edge), moved inside `view` when the corner is at its edge so no badge is cut off.
 * Best rank drawn last (on top).
 */
export function voteBadgesSvg(badges: readonly ExportBadge[], view?: ViewBox | null): string {
  const out: string[] = []
  const sorted = [...badges].sort((a, b) => b.rank - a.rank || a.n - b.n)
  for (const b of sorted) {
    const w = badgeWidth(b)
    let x = b.x + OFFSET.x
    let y = b.y + OFFSET.y
    if (view) {
      x = Math.min(Math.max(x, view.minX + 2), view.minX + view.width - w - 2)
      y = Math.min(Math.max(y, view.minY + 2), view.minY + view.height - H - 2)
    }
    const c = b.rank <= 3 ? TOP : REST
    const label = `${b.n} vote${b.n === 1 ? '' : 's'}, rank ${b.rank}`
    const rank =
      b.rank <= 3
        ? `<tspan font-size="${RANK_PX}" fill-opacity="0.8">#${b.rank}</tspan><tspan dx="${GAP}">${b.n}</tspan>`
        : `${b.n}`
    out.push(
      `<g data-dr-vote-badge="${b.rank}" transform="translate(${num(x)} ${num(y)})"><title>${label}</title>` +
        `<rect x="1" y="1" width="${w - 2}" height="${H - 2}" rx="${(H - 2) / 2}" fill="${c.fill}" stroke="#ffffff" stroke-width="2"/>` +
        `<text x="${num(w / 2)}" y="${H / 2}" text-anchor="middle" dominant-baseline="central" fill="${c.text}" ` +
        `font-family="${FONT}" font-size="${COUNT_PX}" font-weight="700">${rank}</text></g>`,
    )
  }
  return out.length ? `<g data-dr-vote-results="">${out.join('')}</g>` : ''
}

/** `svg` with the badges drawn on top of everything (before its closing tag); unchanged without any. */
export function withVoteBadges(svg: string, badges: readonly ExportBadge[]): string {
  if (badges.length === 0) return svg
  const end = svg.lastIndexOf('</svg>')
  if (end < 0) return svg
  const layer = voteBadgesSvg(badges, viewBoxOf(svg))
  return `${svg.slice(0, end)}${layer}${svg.slice(end)}`
}

/** "votes" cell per shape id for the CSV (empty for shapes without votes). */
export function votesByShape(results: readonly VoteResult[] | null): (shapeId: string) => string {
  const counts = new Map((results ?? []).map((r) => [r.shapeId, r.count]))
  return (id) => {
    const n = counts.get(id)
    return n === undefined ? '' : String(n)
  }
}
