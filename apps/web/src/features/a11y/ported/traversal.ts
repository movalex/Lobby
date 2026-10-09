// OWNER: 3i. Keyboard traversal between elements (docs/EXCALIDRAW-MIGRATION.md §4.8 (2)): the replacement for
// tldraw's `selectAdjacentShape`, `selectFirstChildShape`, `selectParentShape` and the skip button's "select
// the first shape" (tldraw-map.ts: `feature:3i`). Other features (3c's comment tool walks the board the same
// way) import these instead of reimplementing them.
//
// Every move is a selection change only (no undo step, nothing pushed) followed by "bring it into view", as
// tldraw's `_selectShapesAndZoom` did.
import {
  type Bounds,
  type CanvasElement,
  geometry,
  items,
  type LobbyCanvas,
  NotImplementedError,
} from '../../../canvas/api/index.ts'
import { animateCamera } from './motion.ts'
import {
  adjacentEntry,
  elementBounds,
  entryOfSelection,
  type LevelInput,
  levelOfSelection,
  type OrderEntry,
  readingOrder,
} from './reading-order.ts'

/** The canvas as a reading-order input (live elements, their bounds, the collapse filter). */
export function levelInput(canvas: LobbyCanvas): LevelInput {
  const elements = canvas.items()
  const byId = new Map(elements.map((e) => [e.id, e]))
  return {
    elements,
    bounds: (id) => {
      const el = byId.get(id)
      return el ? elementBounds(el) : null
    },
    isHidden: (id) => canvas.isHidden(id),
  }
}

/** The level the selection is on, in reading order, and that level's frame id (null: the top level). */
export function selectionLevel(canvas: LobbyCanvas): { frame: string | null; order: OrderEntry[] } {
  const frame = levelOfSelection(canvas.selection, (id) => canvas.get(id))
  return { frame, order: readingOrder(levelInput(canvas), frame) }
}

/** Screen pixels kept around an element brought into view (tldraw's zoomToSelectionIfOffscreen used 256). */
export const VIEW_MARGIN = 64

/**
 * Moves the camera so `ids` are on screen when they are not (tldraw's `zoomToSelectionIfOffscreen`), through
 * 3b's `viewport.ensureVisible` (it pans the least and keeps the zoom; it zooms out only when the item does
 * not fit). Until 3b lands it (a stub throws NotImplementedError), a plain re-centre through `viewport.set`
 * at the current zoom stands in: no engine call either way. The move glides, or jumps when the person
 * prefers reduced motion (W5-21).
 */
export function bringIntoView(canvas: LobbyCanvas, ids: readonly string[]): void {
  if (!ids.length) return
  try {
    canvas.viewport.ensureVisible(ids, { animate: animateCamera(), margin: VIEW_MARGIN })
    return
  } catch (e) {
    if (!(e instanceof NotImplementedError)) throw e
  }
  const b = canvas.boundsOf(ids)
  if (!b) return
  const v = canvas.viewport.get()
  if (isOnScreen(b, v, VIEW_MARGIN / v.zoom)) return
  canvas.viewport.set(
    { x: b.x + b.width / 2 - v.width / 2, y: b.y + b.height / 2 - v.height / 2 },
    { animate: animateCamera() },
  )
}

/** `b` lies wholly inside the view, `margin` scene units in from its edges (or fills the view). */
export function isOnScreen(b: Bounds, v: Bounds, margin: number): boolean {
  const m = Math.min(margin, Math.max(0, (v.width - b.width) / 2), Math.max(0, (v.height - b.height) / 2))
  return (
    b.x >= v.x + m &&
    b.y >= v.y + m &&
    b.x + b.width <= v.x + v.width - m &&
    b.y + b.height <= v.y + v.height - m
  )
}

function selectEntry(canvas: LobbyCanvas, entry: OrderEntry | null): boolean {
  if (!entry) return false
  canvas.select(entry.ids)
  bringIntoView(canvas, entry.ids)
  return true
}

// ---- wave L (W4, L4-1): the walk along the connections ------------------------------------------------------
//
// Alt+Arrow on one shape that has bound connectors selects the connected shape nearest the pressed arrow's
// direction (a selection change only, as every move here), so a flow is walked the way it was built. With no
// connected shape that way (none within WALK_MAX_ANGLE of it), or no connector, or several things selected, it
// is the reading order as before. The commands 'a11y.next' / 'a11y.previous' do not carry their key, so the arrow
// comes from the board's key-down stream: features/flow notes each Alt+Arrow (noteWalkKey) just before the key
// registry runs the command, which reads it back here once (takeWalkKey).

/** How far from the pressed direction a connected shape may lie and still be walked to, degrees. */
export const WALK_MAX_ANGLE = 70
/** A noted Alt+Arrow older than this (ms) is not the key the command is running for. */
const WALK_KEY_TTL_MS = 250

const walkKeys = new WeakMap<object, { key: string; at: number }>()
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** The board saw Alt+`key` (an arrow key) go down: the walk that follows goes that way. */
export function noteWalkKey(canvas: object, key: string): void {
  walkKeys.set(canvas, { key, at: nowMs() })
}

/** The Alt+Arrow just noted for `canvas` (once), or null. */
export function takeWalkKey(canvas: object): string | null {
  const k = walkKeys.get(canvas)
  walkKeys.delete(canvas)
  return k && nowMs() - k.at <= WALK_KEY_TTL_MS ? k.key : null
}

const ARROW_VECTORS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
}

/** The live shapes bound to `id` through a connector at its other end, deduplicated, in connector order. */
export function connectedShapes(id: string, get: (id: string) => CanvasElement | undefined): string[] {
  const el = get(id)
  if (!el || el.isDeleted) return []
  const out: string[] = []
  for (const arrowId of items.arrowsOf(el)) {
    const a = get(arrowId)
    if (!a || a.isDeleted || a.type !== 'arrow') continue
    const { start, end } = items.arrowEnds(a)
    const other = start === id ? end : end === id ? start : null
    if (!other || other === id || out.includes(other)) continue
    const o = get(other)
    if (o && !o.isDeleted) out.push(other)
  }
  return out
}

/**
 * The connected shape of the one selected element nearest the direction of `key` (an arrow key's name), or null:
 * the smallest angle to that direction within WALK_MAX_ANGLE, then the nearest, then the id.
 */
export function connectedNeighbour(
  canvas: Pick<LobbyCanvas, 'get' | 'selection' | 'isHidden'>,
  key: string,
): string | null {
  const v = ARROW_VECTORS[key]
  if (!v) return null
  const get = (id: string) => canvas.get(id)
  const ids = [
    ...new Set(
      canvas.selection.map((id) => {
        const el = get(id)
        return el ? items.containerOf(el, get).id : id
      }),
    ),
  ]
  if (ids.length !== 1) return null
  const from = get(ids[0] as string)
  if (!from || from.type === 'arrow' || from.type === 'line') return null
  const c = geometry.center(elementBounds(from))
  const minCos = Math.cos((WALK_MAX_ANGLE * Math.PI) / 180)
  let best: { id: string; cos: number; d: number } | null = null
  for (const id of connectedShapes(from.id, get)) {
    if (canvas.isHidden(id)) continue
    const el = get(id) as CanvasElement
    const p = geometry.center(elementBounds(el))
    const dx = p.x - c.x
    const dy = p.y - c.y
    const d = Math.hypot(dx, dy)
    if (d < 1e-6) continue
    const cos = (dx * v[0] + dy * v[1]) / d
    if (cos < minCos) continue
    if (
      !best ||
      cos > best.cos + 1e-6 ||
      (Math.abs(cos - best.cos) <= 1e-6 &&
        (d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && id < best.id)))
    )
      best = { id, cos, d }
  }
  return best?.id ?? null
}

/**
 * Alt+→ / Alt+↓ and Alt+← / Alt+↑: the connected shape that way (see above), else the next or previous element of
 * the selection's level, wrapping.
 */
export function selectAdjacent(canvas: LobbyCanvas, direction: 'next' | 'prev'): boolean {
  const key = takeWalkKey(canvas)
  const along = key ? connectedNeighbour(canvas, key) : null
  if (along) {
    canvas.select([along])
    bringIntoView(canvas, [along])
    return true
  }
  const { order } = selectionLevel(canvas)
  return selectEntry(canvas, adjacentEntry(order, canvas.selection, direction))
}

/** Ctrl/Cmd+Shift+↓: inside the selected frame, its first element in reading order. */
export function selectFirstChild(canvas: LobbyCanvas): boolean {
  const { order } = selectionLevel(canvas)
  const entry = entryOfSelection(order, canvas.selection)
  if (!entry || entry.group || entry.lead.type !== 'frame') return false
  const inside = readingOrder(levelInput(canvas), entry.lead.id)
  return selectEntry(canvas, inside[0] ?? null)
}

/** Ctrl/Cmd+Shift+↑: from inside a frame, the frame itself. */
export function selectParent(canvas: LobbyCanvas): boolean {
  const frame = levelOfSelection(canvas.selection, (id) => canvas.get(id))
  if (!frame || !canvas.get(frame)) return false
  canvas.select([frame])
  bringIntoView(canvas, [frame])
  return true
}

/**
 * The keyboard enters the canvas (F6, "Skip to canvas"): the board takes it and, when nothing is selected,
 * the first element in reading order is selected and brought into view, as tldraw's "Move focus to canvas"
 * did. Returns whether something is selected afterwards.
 */
export function enterCanvas(canvas: LobbyCanvas): boolean {
  canvas.focus({ preventScroll: true })
  if (canvas.selection.length) return true
  const first = readingOrder(levelInput(canvas), null)[0] ?? null
  return selectEntry(canvas, first)
}
