// OWNER: WS5 (wave T). A timeline layout as drawing primitives (rects, lines, paths, text), pure. The board page's
// overlay renders them as React SVG (./Overlay.tsx, with the bars as pointer-active groups) and an export serialises
// the same primitives to SVG markup (./export.ts), with literal colours, text as `<text>` (searchable in the vector
// PDF), no clip paths and no external references: a bar's label is cut to fit by the layout, not by a clip.
import { CARD_STATUS_LABELS, type CardStatus } from '@draftroom/canvas-schema/planning'
import {
  BAR_FONT,
  type Bar,
  LABEL_W,
  type Lane,
  type Layout,
  MILESTONE_HALF,
  RULER_FONT,
  RULER_H,
  RULER_TOP_H,
  textWidth,
} from './layout.ts'

export type Prim =
  | {
      readonly t: 'rect'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly rx?: number
      readonly fill: string
      /** fill-opacity (the lane bands and the ruler tint what is under them: cards inside the frame stay visible) */
      readonly fo?: number
      readonly stroke?: string
      readonly sw?: number
      readonly dash?: string
    }
  | {
      readonly t: 'line'
      readonly x1: number
      readonly y1: number
      readonly x2: number
      readonly y2: number
      readonly stroke: string
      readonly sw: number
      readonly dash?: string
    }
  | {
      readonly t: 'path'
      readonly d: string
      readonly fill: string
      readonly stroke?: string
      readonly sw?: number
    }
  | {
      readonly t: 'text'
      readonly x: number
      readonly y: number
      readonly s: string
      readonly size: number
      readonly fill: string
      readonly weight?: number
      readonly anchor?: 'start' | 'middle' | 'end'
    }

export interface Palette {
  /** the tint the lane bands and the ruler are drawn in, at low opacity */
  readonly tint: string
  readonly grid: string
  readonly gridMajor: string
  readonly ink: string
  readonly inkSoft: string
  readonly today: string
  readonly overdue: string
  readonly notice: string
  readonly status: Readonly<
    Record<CardStatus, { readonly fill: string; readonly ink: string; readonly edge: string }>
  >
}

// Each status is a fill with the text colour that reads on it (AA) and an edge; the status is also a marker shape and
// the card's status word in the label for assistive technology and the tooltip, never colour alone.
export const LIGHT: Palette = {
  tint: '#3b4a63',
  grid: '#dfe5ee',
  gridMajor: '#b9c3d3',
  ink: '#1b2330',
  inkSoft: '#4a5568',
  today: '#d6336c',
  overdue: '#b42318',
  notice: '#5b6472',
  status: {
    todo: { fill: '#e3e8ef', ink: '#1b2330', edge: '#8793a6' },
    doing: { fill: '#cfe3ff', ink: '#0b2a5b', edge: '#3b82d8' },
    review: { fill: '#e6d9ff', ink: '#2f1565', edge: '#8a63d2' },
    blocked: { fill: '#ffd9d6', ink: '#5c0f08', edge: '#d9534f' },
    done: { fill: '#d3f0dc', ink: '#0c3b1c', edge: '#3f9d63' },
  },
}

export const DARK: Palette = {
  tint: '#9fb0cc',
  grid: '#323c52',
  gridMajor: '#4a566f',
  ink: '#eef2f8',
  inkSoft: '#b4bfd0',
  today: '#ff7aa8',
  overdue: '#ff8f85',
  notice: '#b4bfd0',
  status: {
    todo: { fill: '#3a4459', ink: '#eef2f8', edge: '#8793a6' },
    doing: { fill: '#1f4373', ink: '#e6f0ff', edge: '#5aa0f0' },
    review: { fill: '#43307a', ink: '#f0eaff', edge: '#a98be6' },
    blocked: { fill: '#74221d', ink: '#ffe9e6', edge: '#ff7a73' },
    done: { fill: '#1d5033', ink: '#e3f7ea', edge: '#5cc486' },
  },
}

/** The ruler, the lane bands, the grid and the today marker: everything but the bars. */
export function framePrims(layout: Layout, p: Palette, o: { readonly todayLabel?: boolean } = {}): Prim[] {
  const out: Prim[] = []
  const { width, height, axis } = layout
  out.push({
    t: 'rect',
    x: 0.5,
    y: 0.5,
    w: width - 1,
    h: height - 1,
    fill: 'none',
    stroke: p.gridMajor,
    sw: 1,
  })
  // lane bands (and their labels)
  layout.lanes.forEach((lane: Lane, i) => {
    if (i % 2 === 0) out.push({ t: 'rect', x: 0, y: lane.y, w: width, h: lane.h, fill: p.tint, fo: 0.07 })
    if (lane.label !== null && lane.h >= 16) {
      const label = clipLabel(lane.label, Math.min(LABEL_W, axis.x) - 16)
      if (label)
        out.push({ t: 'text', x: 10, y: lane.y + 22, s: label, size: BAR_FONT, fill: p.ink, weight: 600 })
    }
  })
  // the ruler
  out.push({ t: 'rect', x: 0, y: 0, w: width, h: RULER_H, fill: p.tint, fo: 0.14 })
  out.push({ t: 'line', x1: 0, y1: RULER_H, x2: width, y2: RULER_H, stroke: p.gridMajor, sw: 1 })
  for (const m of layout.months) {
    out.push({ t: 'line', x1: m.x, y1: 0, x2: m.x, y2: RULER_TOP_H, stroke: p.gridMajor, sw: 1 })
    if (m.label)
      out.push({ t: 'text', x: m.x + 6, y: 15, s: m.label, size: RULER_FONT, fill: p.ink, weight: 600 })
  }
  out.push({ t: 'line', x1: axis.x, y1: RULER_TOP_H, x2: width, y2: RULER_TOP_H, stroke: p.grid, sw: 1 })
  for (const tk of layout.ticks) {
    // the grid under the bars: majors (a month, a year) stronger; a day grid is left out when it would be a wash
    if (tk.w >= 5 || tk.major)
      out.push({
        t: 'line',
        x1: tk.x,
        y1: tk.major ? 0 : RULER_TOP_H,
        x2: tk.x,
        y2: height,
        stroke: tk.major ? p.gridMajor : p.grid,
        sw: 1,
      })
    if (tk.label)
      out.push({
        t: 'text',
        x: tk.x + 4,
        y: RULER_TOP_H + 17,
        s: tk.label,
        size: RULER_FONT,
        fill: p.inkSoft,
      })
  }
  if (layout.lanes.length && axis.x > 0)
    out.push({ t: 'line', x1: axis.x, y1: RULER_H, x2: axis.x, y2: height, stroke: p.gridMajor, sw: 1 })
  // today
  if (layout.todayX !== null) {
    out.push({
      t: 'line',
      x1: layout.todayX,
      y1: RULER_TOP_H,
      x2: layout.todayX,
      y2: height,
      stroke: p.today,
      sw: 2,
    })
    if (o.todayLabel !== false) {
      const w = textWidth('Today', RULER_FONT) + 12
      const x = Math.min(Math.max(layout.todayX - w / 2, axis.x), Math.max(axis.x, width - w))
      out.push({ t: 'rect', x, y: RULER_TOP_H + 2, w, h: 18, rx: 9, fill: p.today })
      out.push({
        t: 'text',
        x: x + w / 2,
        y: RULER_TOP_H + 15,
        s: 'Today',
        size: RULER_FONT,
        fill: '#ffffff',
        weight: 700,
        anchor: 'middle',
      })
    }
  }
  // notices at the bottom edge
  const notes: string[] = []
  if (layout.capped > 0) notes.push(`Showing ${layout.shown + layout.below} of ${layout.inRange}`)
  if (layout.below > 0)
    notes.push(
      `${layout.below} more card${layout.below === 1 ? '' : 's'} below. Make the frame taller to see them.`,
    )
  if (layout.inRange === 0)
    notes.push('No cards with a due date in this range. A card with a due date shows here as a bar.')
  for (const [i, s] of notes.entries())
    out.push({
      t: 'text',
      x: axis.x + 10,
      y: height - 10 - (notes.length - 1 - i) * 16,
      s: clipLabel(s, width - axis.x - 20),
      size: RULER_FONT,
      fill: p.notice,
    })
  return out
}

function clipLabel(s: string, maxW: number): string {
  if (textWidth(s, BAR_FONT) <= maxW) return s
  const n = Math.floor(maxW / (BAR_FONT * 0.56)) - 1
  return n >= 3 ? `${s.slice(0, n).trimEnd()}…` : ''
}

/** A status marker of radius `r` centred at (cx, cy): an open ring (to do), half (in progress), dot (review), cross, check. */
function marker(status: CardStatus, cx: number, cy: number, r: number, ink: string, bg: string): Prim[] {
  const ring: Prim = {
    t: 'path',
    d: circle(cx, cy, r),
    fill: status === 'done' ? ink : 'none',
    stroke: ink,
    sw: 1.5,
  }
  const k = r / 5
  const q = 2.6 * k
  switch (status) {
    case 'todo':
      return [ring]
    case 'doing':
      return [ring, { t: 'path', d: `M${cx} ${cy - r}A${r} ${r} 0 0 1 ${cx} ${cy + r}Z`, fill: ink }]
    case 'review':
      return [ring, { t: 'path', d: circle(cx, cy, 1.8 * k), fill: ink }]
    case 'blocked':
      return [
        ring,
        {
          t: 'path',
          d: `M${cx - q} ${cy - q}L${cx + q} ${cy + q}M${cx + q} ${cy - q}L${cx - q} ${cy + q}`,
          fill: 'none',
          stroke: ink,
          sw: 1.5,
        },
      ]
    case 'done':
      return [
        ring,
        {
          t: 'path',
          d: `M${cx - 2.8 * k} ${cy}L${cx - 0.6 * k} ${cy + 2.4 * k}L${cx + 3 * k} ${cy - 2.4 * k}`,
          fill: 'none',
          stroke: bg,
          sw: 1.6,
        },
      ]
  }
}

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`

/** One bar (or milestone) as primitives at its layout position, optionally moved/resized (a drag's preview). */
export function barPrims(bar: Bar, p: Palette, at: { x: number; w: number } = bar): Prim[] {
  const s = p.status[bar.card.status]
  const out: Prim[] = []
  const stroke = bar.overdue ? p.overdue : s.edge
  const sw = bar.overdue ? 2 : 1.25
  if (bar.kind === 'milestone') {
    const cx = at.x + at.w / 2
    const cy = bar.y + bar.h / 2
    const r = MILESTONE_HALF
    out.push({
      t: 'path',
      d: `M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}Z`,
      fill: s.fill,
      stroke,
      sw,
    })
    out.push(...marker(bar.card.status, cx, cy, 4, s.ink, s.fill))
    if (bar.label)
      out.push({ t: 'text', x: cx + r + 6, y: bar.y + 15, s: bar.label, size: BAR_FONT, fill: p.ink })
    return out
  }
  out.push({ t: 'rect', x: at.x, y: bar.y, w: at.w, h: bar.h, rx: 5, fill: s.fill, stroke, sw })
  // a bar that starts before the range: a notch on its left edge
  if (bar.clippedLeft)
    out.push({
      t: 'path',
      d: `M${at.x + 1} ${bar.y + 3}L${at.x + 7} ${bar.y + bar.h / 2}L${at.x + 1} ${bar.y + bar.h - 3}`,
      fill: 'none',
      stroke: s.ink,
      sw: 1.5,
    })
  if (bar.labelInside) {
    out.push(...marker(bar.card.status, at.x + 13, bar.y + bar.h / 2, 5, s.ink, s.fill))
    out.push({ t: 'text', x: at.x + 24, y: bar.y + 15.5, s: bar.label, size: BAR_FONT, fill: s.ink })
  } else if (at.w >= 18) {
    out.push(...marker(bar.card.status, at.x + at.w / 2, bar.y + bar.h / 2, 5, s.ink, s.fill))
  }
  if (!bar.labelInside && bar.label)
    out.push({ t: 'text', x: at.x + at.w + 6, y: bar.y + 15.5, s: bar.label, size: BAR_FONT, fill: p.ink })
  return out
}

// ---- SVG markup ------------------------------------------------------------------------------------------------------

export const FONT =
  'ui-sans-serif, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, Helvetica, Arial, sans-serif'

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const num = (v: number) => String(Math.round(v * 100) / 100)

/** One primitive as SVG markup. */
export function primSvg(prim: Prim): string {
  switch (prim.t) {
    case 'rect':
      return (
        `<rect x="${num(prim.x)}" y="${num(prim.y)}" width="${num(prim.w)}" height="${num(prim.h)}"` +
        `${prim.rx ? ` rx="${num(prim.rx)}" ry="${num(prim.rx)}"` : ''} fill="${prim.fill}"` +
        `${prim.fo !== undefined ? ` fill-opacity="${prim.fo}"` : ''}` +
        `${prim.stroke ? ` stroke="${prim.stroke}" stroke-width="${num(prim.sw ?? 1)}"` : ''}` +
        `${prim.dash ? ` stroke-dasharray="${prim.dash}"` : ''}/>`
      )
    case 'line':
      return (
        `<line x1="${num(prim.x1)}" y1="${num(prim.y1)}" x2="${num(prim.x2)}" y2="${num(prim.y2)}" ` +
        `stroke="${prim.stroke}" stroke-width="${num(prim.sw)}"${prim.dash ? ` stroke-dasharray="${prim.dash}"` : ''}/>`
      )
    case 'path':
      return (
        `<path d="${prim.d}" fill="${prim.fill}"` +
        `${prim.stroke ? ` stroke="${prim.stroke}" stroke-width="${num(prim.sw ?? 1)}" stroke-linecap="round" stroke-linejoin="round"` : ''}/>`
      )
    case 'text':
      return (
        `<text x="${num(prim.x)}" y="${num(prim.y)}" font-family="${FONT}" font-size="${prim.size}" ` +
        `fill="${prim.fill}"${prim.weight ? ` font-weight="${prim.weight}"` : ''}` +
        `${prim.anchor && prim.anchor !== 'start' ? ` text-anchor="${prim.anchor}"` : ''}>${esc(prim.s)}</text>`
      )
  }
}

export const primsSvg = (prims: readonly Prim[]): string => prims.map(primSvg).join('')

export { CARD_STATUS_LABELS }
