// OWNER: WS2 (wave T, storyboards). What the storyboard's chips layer draws, apart from React and the camera, so a
// big board (thousands of panels) does no per-frame work:
//  - `ChipModelCache.build` reads the storyboards once per scene change and reuses each storyboard's chip rows while
//    its head and panels keep their versions (a change elsewhere on the board recomputes no timings);
//  - the rows are in SCENE coordinates: one transform layer (the camera) moves them all, so a pan or a zoom recomputes
//    nothing but the cull;
//  - `visibleRows` culls to the viewport (with a margin), so only what is on screen is drawn.
import { formatRunningTime, storyboardTimings } from '@draftroom/canvas-schema/planning'
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import { PANEL_HEADER } from './model.ts'
import type { Sb } from './ops.ts'
import { boardsOf } from './state.ts'

export interface ChipRow {
  readonly id: string
  readonly n: number
  readonly ms: number
  /** the chip's top-left in scene coordinates (inside the panel's header band) */
  readonly x: number
  readonly y: number
}

export interface HeadRow {
  readonly id: string
  /** the line's left middle in scene coordinates (right of the head) */
  readonly x: number
  readonly y: number
  readonly text: string
}

export interface ChipModel {
  readonly chips: readonly ChipRow[]
  readonly heads: readonly HeadRow[]
}

/** @internal (tests) how often the work ran: whole builds, and storyboards whose rows were computed again */
export const chipStats = { builds: 0, storyboards: 0 }

type Reader = Pick<LobbyCanvas, 'get' | 'index' | 'isHidden'>

const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

const versionOf = (el: CanvasElement | undefined) =>
  el ? `${(el as { version?: number }).version ?? 0}:${live(el) ? 1 : 0}` : '-'

/** What a storyboard's rows depend on: its head's and panels' versions (position, keys) and whether each is hidden. */
function keyOf(canvas: Reader, sb: Sb): string {
  const parts: string[] = [sb.head ? `${sb.head.id}=${versionOf(canvas.get(sb.head.id))}` : '']
  for (const p of sb.panels)
    parts.push(`${p.id}=${versionOf(canvas.get(p.id))}${canvas.isHidden(p.id) ? 'h' : ''}`)
  if (sb.head && canvas.isHidden(sb.head.id)) parts.push('head-hidden')
  return parts.join('|')
}

function rowsOf(canvas: Reader, sb: Sb): { chips: ChipRow[]; head: HeadRow | null } {
  chipStats.storyboards++
  const t = storyboardTimings(sb)
  const chips: ChipRow[] = []
  for (const row of t.panels) {
    const f = canvas.get(row.id)
    if (!live(f) || canvas.isHidden(row.id)) continue
    chips.push({
      id: row.id,
      n: row.number,
      ms: row.durationMs,
      x: f.x + 12,
      y: f.y + (PANEL_HEADER - 26) / 2,
    })
  }
  const h = sb.head ? canvas.get(sb.head.id) : undefined
  let head: HeadRow | null = null
  if (live(h) && !canvas.isHidden(h.id)) {
    const n = sb.panels.length
    head = {
      id: h.id,
      x: h.x + h.width + 16,
      y: h.y + h.height / 2,
      text: `${n} ${n === 1 ? 'panel' : 'panels'} · ${formatRunningTime(t.totalMs)} · ${sb.settings?.aspect ?? '16:9'}`,
    }
  }
  return { chips, head }
}

/** The chip rows of every storyboard, each storyboard's reused while its elements keep their versions. */
export class ChipModelCache {
  private readonly bySb = new Map<string, { key: string; chips: ChipRow[]; head: HeadRow | null }>()
  private last: ChipModel = { chips: [], heads: [] }

  build(canvas: Reader): ChipModel {
    chipStats.builds++
    const seen = new Set<string>()
    let changed = false
    const chips: ChipRow[] = []
    const heads: HeadRow[] = []
    for (const sb of boardsOf(canvas).values()) {
      seen.add(sb.id)
      const key = keyOf(canvas, sb)
      let entry = this.bySb.get(sb.id)
      if (!entry || entry.key !== key) {
        entry = { key, ...rowsOf(canvas, sb) }
        this.bySb.set(sb.id, entry)
        changed = true
      }
      chips.push(...entry.chips)
      if (entry.head) heads.push(entry.head)
    }
    for (const id of [...this.bySb.keys()])
      if (!seen.has(id)) {
        this.bySb.delete(id)
        changed = true
      }
    // nothing of any storyboard changed: the same model (the layer's signal sees no change, React renders nothing)
    if (!changed && chips.length === this.last.chips.length && heads.length === this.last.heads.length)
      return this.last
    this.last = { chips, heads }
    return this.last
  }
}

/** The rows inside the viewport (scene bounds), grown by `margin` screen pixels on each side. */
export function visibleRows<T extends { readonly x: number; readonly y: number }>(
  rows: readonly T[],
  view: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    readonly zoom: number
  },
  margin = 200,
): T[] {
  const m = margin / Math.max(view.zoom, 0.01)
  const x0 = view.x - m
  const y0 = view.y - m
  const x1 = view.x + view.width + m
  const y1 = view.y + view.height + m
  return rows.filter((r) => r.x >= x0 && r.x <= x1 && r.y >= y0 && r.y <= y1)
}
