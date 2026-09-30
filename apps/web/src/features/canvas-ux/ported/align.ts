// Align and distribute for the selection bar (MAK-03) on the Excalidraw canvas, and the moves they make.
// tldraw's actions (align-left … distribute-vertical) did this on the tldraw board; here it is plain
// geometry over the canvas API: the pure plan (`alignDeltas`, `distributeDeltas`, over units) and the
// writes (`moveUnits`), inside the caller's `transact` (one undo step).
//
// A unit is what moves as one: an element, a whole group (its outermost group), a frame with what is in
// it. A moved container takes its bound label along (Excalidraw keeps the label's own x/y), a moved frame
// its children; arrows bound to what moved are re-snapped by the server (§2.4.4), so they are not
// written here. Locked elements never move (the server refuses them anyway).
import type { Bounds, CanvasElement, LobbyCanvas, LobbyTx } from '../../../canvas/api/index.ts'
import { geometry, items } from '../../../canvas/api/index.ts'

export type AlignOp = 'left' | 'center-horizontal' | 'right' | 'top' | 'center-vertical' | 'bottom'
export type DistributeOp = 'horizontal' | 'vertical'

export interface Unit {
  readonly id: string
  /** the elements that move with it (labels and frame children are added by `moveUnits`) */
  readonly members: readonly string[]
  readonly bounds: Bounds
}

export interface Delta {
  readonly dx: number
  readonly dy: number
}

/** Each unit's move so that the chosen edge or centre lines up with the selection's (tldraw's align). */
export function alignDeltas(units: readonly Unit[], op: AlignOp): Map<string, Delta> {
  const out = new Map<string, Delta>()
  const all = geometry.union(units.map((u) => u.bounds))
  if (!all || units.length < 2) return out
  for (const u of units) {
    const b = u.bounds
    let dx = 0
    let dy = 0
    if (op === 'left') dx = all.x - b.x
    else if (op === 'right') dx = all.x + all.width - (b.x + b.width)
    else if (op === 'center-horizontal') dx = all.x + all.width / 2 - (b.x + b.width / 2)
    else if (op === 'top') dy = all.y - b.y
    else if (op === 'bottom') dy = all.y + all.height - (b.y + b.height)
    else dy = all.y + all.height / 2 - (b.y + b.height / 2)
    if (dx || dy) out.set(u.id, { dx, dy })
  }
  return out
}

/**
 * Equal gaps between the units along one axis; the first and the last stay where they are (tldraw's
 * distribute: sorted by their leading edge, three or more units).
 */
export function distributeDeltas(units: readonly Unit[], op: DistributeOp): Map<string, Delta> {
  const out = new Map<string, Delta>()
  if (units.length < 3) return out
  const h = op === 'horizontal'
  const start = (b: Bounds) => (h ? b.x : b.y)
  const size = (b: Bounds) => (h ? b.width : b.height)
  const sorted = [...units].sort((a, b) => start(a.bounds) - start(b.bounds) || (a.id < b.id ? -1 : 1))
  const first = sorted[0] as Unit
  const last = sorted[sorted.length - 1] as Unit
  const span = start(last.bounds) + size(last.bounds) - start(first.bounds)
  const total = sorted.reduce((s, u) => s + size(u.bounds), 0)
  const gap = (span - total) / (sorted.length - 1)
  let at = start(first.bounds) + size(first.bounds) + gap
  for (const u of sorted.slice(1, -1)) {
    const d = at - start(u.bounds)
    if (Math.abs(d) > 1e-9) out.set(u.id, h ? { dx: d, dy: 0 } : { dx: 0, dy: d })
    at += size(u.bounds) + gap
  }
  return out
}

/**
 * The selection as units: bound labels count as their container, a group's members as one unit, an
 * element inside a selected frame as part of that frame. Locked elements are left out.
 */
export function unitsOf(canvas: Pick<LobbyCanvas, 'get' | 'bounds' | 'isLocked'>, ids: readonly string[]) {
  const byId = new Map<string, CanvasElement>()
  for (const id of ids) {
    const el = canvas.get(id)
    if (!el || (el as { isDeleted?: boolean }).isDeleted) continue
    const root = items.containerOf(el, (x) => canvas.get(x))
    if (!canvas.isLocked(root.id)) byId.set(root.id, root)
  }
  const frames = new Set([...byId.values()].filter((e) => e.type === 'frame').map((e) => e.id))
  const groups = new Map<string, string[]>()
  const units: Unit[] = []
  for (const el of byId.values()) {
    if (el.frameId && frames.has(el.frameId)) continue
    const g = items.outerGroupOf(el)
    if (g) groups.set(g, [...(groups.get(g) ?? []), el.id])
    else {
      const b = canvas.bounds(el.id)
      if (b) units.push({ id: el.id, members: [el.id], bounds: b })
    }
  }
  for (const [g, members] of groups) {
    const b = geometry.union(members.map((m) => canvas.bounds(m)))
    if (b) units.push({ id: `group:${g}`, members, bounds: b })
  }
  return units
}

/** Writes the moves: every member, its bound labels and (for a frame) its children, by the unit's delta. */
export function moveUnits(
  canvas: Pick<LobbyCanvas, 'get' | 'items' | 'isLocked'>,
  tx: Pick<LobbyTx, 'update'>,
  units: readonly Unit[],
  deltas: ReadonlyMap<string, Delta>,
): number {
  const all = canvas.items()
  const moved = new Set<string>()
  const move = (id: string, d: Delta) => {
    if (moved.has(id)) return
    const el = canvas.get(id)
    if (!el || (el as { isDeleted?: boolean }).isDeleted || el.locked) return
    moved.add(id)
    tx.update(id, { x: el.x + d.dx, y: el.y + d.dy })
    const label = items.labelOf(el, (x) => canvas.get(x))
    if (label) move(label.id, d)
    if (el.type === 'frame') for (const c of items.childrenOf(el.id, all)) move(c, d)
  }
  for (const u of units) {
    const d = deltas.get(u.id)
    if (!d) continue
    for (const m of u.members) move(m, d)
  }
  return moved.size
}
