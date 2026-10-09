/**
 * The presence compass (wave L, W6, L6-2): an avatar chip at the edge of the screen for each colleague who
 * is off screen, pointing the way. Pure (Node-tested); the board page's edge-marker layer draws it
 * (canvas/board/chrome.tsx `EdgeMarkers`).
 *
 * It rides on W5-32's edge markers (../board/edge-markers.ts): who gets a chip (a pointer off screen, else
 * a view that does not overlap this one, so an idle peer counts by its view centre), the ray from the middle
 * of the canvas, the clamp to the edge, and the placement that keeps chips off the board's own controls. On
 * top of that the compass merges people whose chips would land on one another into one chip, the nearest
 * person's with "+N" (`sids`), and draws at most MAX_COMPASS_CHIPS chips (the farthest groups join the group
 * nearest to them). Everyone off screen the room streams to this tab is in some chip: a crowd past the room's
 * cursor cap is not (the copy says "near you", never a total).
 *
 * Presence-only and read-only: nothing here is written or sent.
 */
import type { Bounds, ScenePoint, ScreenPoint } from '../api/lobby-canvas.ts'
import {
  EDGE_CHIP_RADIUS,
  EDGE_MARGINS,
  type EdgeMarker,
  type EdgeMarkerOptions,
  type EdgeMarkerPeer,
  edgeMarkers,
} from '../board/edge-markers.ts'

/** The most chips the compass draws (more people merge into "+N"). */
export const MAX_COMPASS_CHIPS = 6

/** One chip: the nearest person of a group (its `sid`, `target` and place) and everyone in it. */
export interface CompassChip extends EdgeMarker {
  /** the people this chip stands for, nearest first (`sids[0]` is the chip's own `sid`) */
  readonly sids: readonly string[]
}

/** Where a chip would sit on the edge before any spreading: the ray at `angle` from the chip box's middle. */
function rawPlace(
  angle: number,
  size: { readonly w: number; readonly h: number },
  r: number,
  m: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number },
): { x: number; y: number } {
  const { w, h } = size
  const wide = w - m.left - m.right - 2 * r >= 0
  const tall = h - m.top - m.bottom - 2 * r >= 0
  const box = {
    left: wide ? m.left + r : w / 2,
    right: wide ? w - m.right - r : w / 2,
    top: tall ? m.top + r : h / 2,
    bottom: tall ? h - m.bottom - r : h / 2,
  }
  const cx = (box.left + box.right) / 2
  const cy = (box.top + box.bottom) / 2
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const tx = Math.abs(dx) < 1e-9 ? Number.POSITIVE_INFINITY : (dx > 0 ? box.right - cx : box.left - cx) / dx
  const ty = Math.abs(dy) < 1e-9 ? Number.POSITIVE_INFINITY : (dy > 0 ? box.bottom - cy : box.top - cy) / dy
  const t = Math.min(tx, ty)
  return { x: cx + dx * t, y: cy + dy * t }
}

/**
 * The compass for `peers` on a canvas of `size` px (the arguments of ../board/edge-markers.ts `edgeMarkers`):
 * at most `opts.max` (MAX_COMPASS_CHIPS) chips, nearest first, people whose chips would touch merged into one.
 */
export function compass(
  peers: readonly EdgeMarkerPeer[],
  viewport: Bounds,
  size: { readonly w: number; readonly h: number },
  toOverlay: (p: ScenePoint) => ScreenPoint,
  opts: EdgeMarkerOptions = {},
): CompassChip[] {
  const r = opts.chipRadius ?? EDGE_CHIP_RADIUS
  const margins = opts.margins ?? EDGE_MARGINS
  const max = Math.max(1, opts.max ?? MAX_COMPASS_CHIPS)
  // everyone off screen, nearest first (edge-markers.ts decides who and the direction)
  const all = edgeMarkers(peers, viewport, size, toOverlay, { ...opts, max: peers.length, avoid: [] })
  if (!all.length) return []
  // people whose chips would land on one another (closer than a chip and the gap between two) are one chip
  const touch = 2 * r + 4
  const groups: { lead: EdgeMarker; at: { x: number; y: number }; sids: string[] }[] = []
  for (const m of all) {
    const at = rawPlace(m.angle, size, r, margins)
    const hit = groups.find((g) => Math.hypot(g.at.x - at.x, g.at.y - at.y) < touch)
    if (hit) hit.sids.push(m.sid)
    else groups.push({ lead: m, at, sids: [m.sid] })
  }
  // too many: the farthest group joins the group whose chip is nearest to its own
  while (groups.length > max) {
    const last = groups.pop() as (typeof groups)[number]
    let best = groups[0] as (typeof groups)[number]
    let bestD = Number.POSITIVE_INFINITY
    for (const g of groups) {
      const d = Math.hypot(g.at.x - last.at.x, g.at.y - last.at.y)
      if (d < bestD) {
        bestD = d
        best = g
      }
    }
    best.sids.push(...last.sids)
  }
  // the chips themselves: the groups' nearest people, placed (and kept off the controls) by edge-markers.ts
  const leads = new Map(groups.map((g) => [g.lead.sid, g.sids]))
  const placed = edgeMarkers(
    peers.filter((p) => leads.has(p.sid)),
    viewport,
    size,
    toOverlay,
    { ...opts, max },
  )
  return placed.map((m) => ({ ...m, sids: leads.get(m.sid) ?? [m.sid] }))
}
