// OWNER: 3i (docs/EXCALIDRAW-CONTRACTS.md §7.2; docs/EXCALIDRAW-MIGRATION.md §4.8). Reading order over the
// board's elements: the replacement for tldraw's `getCurrentPageShapesInReadingOrder` and the order behind
// `selectAdjacentShape` (tldraw-map.ts: `feature:3i`). Pure: it takes plain elements and a bounds lookup, so
// it runs on the live canvas, on a snapshot or in a Node test.
//
// A "level" is what the keyboard walks at once, as tldraw's parent chain did:
//  - the top level: every content element outside a frame (frames included), and
//  - one frame's level: the elements whose `frameId` is that frame.
// Bound labels are never entries (their container is), collapsed (hidden) elements are skipped, and a group
// (Excalidraw's shared `groupIds`) is ONE entry at its level: selecting it selects every member, as a tldraw
// group shape was one tab stop.
import { type Bounds, type CanvasElement, geometry, items } from '../../../canvas/api/index.ts'

/** One tab stop of a level: an element, or an outermost group of elements. */
export interface OrderEntry {
  /** the element id, or `group:<groupId>` */
  readonly key: string
  /** what selecting the entry selects */
  readonly ids: readonly string[]
  readonly bounds: Bounds
  /** the element (an element entry) or the group's first member (a group entry) */
  readonly lead: CanvasElement
  readonly group: string | null
}

export interface LevelInput {
  /** live elements in paint order (`canvas.items()`) */
  readonly elements: readonly CanvasElement[]
  bounds(id: string): Bounds | null
  /** hidden by a mind-map collapse (`canvas.isHidden`) */
  isHidden?(id: string): boolean
}

/**
 * An element's axis-aligned scene bounds from its own fields, rotation included: a linear element (arrow,
 * line, pen) from its points, anything else from its box. The reading order needs every element's bounds at
 * once, and `canvas.bounds(id)` measures one element against the whole scene each time (O(n) per call), so
 * a level of a heavy board would cost O(n²); this is O(1) per element and equal to it for boxes.
 */
export function elementBounds(el: CanvasElement): Bounds {
  const points = (el as { points?: readonly (readonly [number, number])[] }).points
  const raw =
    points?.length && el.type !== 'image'
      ? (geometry.fromPoints(points.map(([px, py]) => ({ x: el.x + px, y: el.y + py }))) ??
        geometry.rect(el.x, el.y, el.width, el.height))
      : geometry.rect(el.x, el.y, el.width, el.height)
  if (!el.angle) return raw
  return geometry.fromPoints(geometry.corners(raw, el.angle)) ?? raw
}

/** Tldraw's constants (Editor._getShapesInReadingOrder): rows 100 scene px apart, a 20° "same row" swap. */
const ROW_THRESHOLD = 100
const SHALLOW_ANGLE = 20

const isLabel = (el: CanvasElement) => el.type === 'text' && !!el.containerId

/** The entries of one level (`frame` = null for the top level), NOT yet in reading order. */
export function levelEntries(input: LevelInput, frame: string | null): OrderEntry[] {
  const out: OrderEntry[] = []
  const groups = new Map<string, CanvasElement[]>()
  for (const el of items.contentItems(input.elements)) {
    if (isLabel(el) || input.isHidden?.(el.id)) continue
    if ((el.frameId ?? null) !== frame) continue
    // a frame's own group memberships are ignored: frames are always their own stop
    const g = el.type === 'frame' ? null : items.outerGroupOf(el)
    if (g) {
      const list = groups.get(g)
      if (list) list.push(el)
      else {
        groups.set(g, [el])
        // the group's place in paint order is its first member's
        out.push({
          key: `group:${g}`,
          ids: [],
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          lead: el,
          group: g,
        })
      }
      continue
    }
    const b = input.bounds(el.id)
    if (!b) continue
    out.push({ key: el.id, ids: [el.id], bounds: b, lead: el, group: null })
  }
  return out.flatMap((e) => {
    if (!e.group) return [e]
    const members = groups.get(e.group) ?? []
    const boxes = members.map((m) => input.bounds(m.id)).filter((b): b is Bounds => !!b)
    const bounds = geometry.union(boxes)
    if (!bounds) return []
    return [{ ...e, ids: members.map((m) => m.id), bounds }]
  })
}

/**
 * `below` sits under `above` in the same column: their boxes share some width and none of their height.
 * A heading and its subtitle (two text boxes as wide as the frame, one under the other) are stacked; two
 * notes side by side, or scattered items, are not.
 */
export function isStacked(above: Bounds, below: Bounds): boolean {
  const shareWidth = above.x < below.x + below.width && below.x < above.x + above.width
  const shareHeight = above.y < below.y + below.height && below.y < above.y + above.height
  return shareWidth && !shareHeight
}

/**
 * Tldraw 5.4.2's reading order (Editor._getShapesInReadingOrder), on entry centres: sorted top to bottom,
 * grouped into rows (a centre within 100 px of the row's last one joins it), each row left to right, then
 * within a row a nearer entry two places on (at a shallow angle) swaps forward.
 *
 * One change (the early wave-5 review W5-59: a frame's subtitle was read before its title): an entry that
 * is stacked under the row's last one (./isStacked: the same column, no shared height) starts a new row
 * even when their centres are less than 100 px apart, so a heading is read before the line under it
 * whatever their widths. tldraw sorted the two by their centres' x, which put a full-width subtitle first
 * whenever it was a little narrower than its heading.
 */
export function inReadingOrder<T extends { readonly bounds: Bounds }>(entries: readonly T[]): T[] {
  if (entries.length <= 1) return [...entries]
  const withCentres = entries.map((entry) => ({ entry, c: geometry.center(entry.bounds) }))
  withCentres.sort((a, b) => a.c.y - b.c.y)
  const rows: (typeof withCentres)[] = []
  for (const w of withCentres) {
    let row = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      const last = rows[i]?.[(rows[i]?.length ?? 1) - 1]
      if (last && Math.abs(w.c.y - last.c.y) < ROW_THRESHOLD) {
        if (!isStacked(last.entry.bounds, w.entry.bounds)) row = i
        break
      }
    }
    if (row === -1) rows.push([w])
    else rows[row]?.push(w)
  }
  for (const row of rows) row.sort((a, b) => a.c.x - b.c.x)
  for (const row of rows) {
    if (row.length <= 2) continue
    for (let i = 0; i < row.length - 2; i++) {
      const cur = row[i]
      const next = row[i + 1]
      const after = row[i + 2]
      if (!cur || !next || !after) continue
      const d1 = dist2(cur.c, next.c)
      const d2 = dist2(cur.c, after.c)
      if (d2 < d1 * 0.9) {
        const angle = Math.abs(Math.atan2(after.c.y - cur.c.y, after.c.x - cur.c.x) * (180 / Math.PI))
        if (angle <= SHALLOW_ANGLE) {
          row[i + 1] = after
          row[i + 2] = next
        }
      }
    }
  }
  return rows.flat().map((w) => w.entry)
}

const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2

/** One level in reading order. */
export function readingOrder(input: LevelInput, frame: string | null = null): OrderEntry[] {
  return inReadingOrder(levelEntries(input, frame))
}

/**
 * The level a selection belongs to: the frame every selected element shares, else the top level
 * (tldraw's `isSelectedWithinContainer`). Labels count as their containers.
 */
export function levelOfSelection(
  selection: readonly string[],
  get: (id: string) => CanvasElement | undefined,
): string | null {
  let frame: string | null | undefined
  for (const id of selection) {
    const raw = get(id)
    if (!raw) continue
    const el = items.containerOf(raw, (x) => get(x))
    const f = el.frameId ?? null
    if (frame === undefined) frame = f
    else if (frame !== f) return null
  }
  return frame ?? null
}

/** The entry the selection is "on": the one whose ids it equals, else the first entry it touches. */
export function entryOfSelection(
  order: readonly OrderEntry[],
  selection: readonly string[],
): OrderEntry | null {
  if (!selection.length) return null
  const sel = new Set(selection)
  const exact = order.find((e) => e.ids.length === sel.size && e.ids.every((id) => sel.has(id)))
  if (exact) return exact
  return order.find((e) => e.ids.some((id) => sel.has(id))) ?? null
}

/**
 * The next or previous entry of `order` from the selection, wrapping at both ends (tldraw's
 * selectAdjacentShape 'next' / 'prev'). With nothing selected on the level, 'next' is the first entry and
 * 'prev' the last.
 */
export function adjacentEntry(
  order: readonly OrderEntry[],
  selection: readonly string[],
  direction: 'next' | 'prev',
): OrderEntry | null {
  if (!order.length) return null
  const current = entryOfSelection(order, selection)
  const at = current ? order.indexOf(current) : -1
  if (at < 0) return (direction === 'next' ? order[0] : order[order.length - 1]) ?? null
  const n = order.length
  return order[(at + (direction === 'next' ? 1 : -1) + n) % n] ?? null
}
