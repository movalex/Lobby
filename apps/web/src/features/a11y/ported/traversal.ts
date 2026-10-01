// OWNER: 3i. Keyboard traversal between elements (docs/EXCALIDRAW-MIGRATION.md §4.8 (2)): the replacement for
// tldraw's `selectAdjacentShape`, `selectFirstChildShape`, `selectParentShape` and the skip button's "select
// the first shape" (tldraw-map.ts: `feature:3i`). Other features (3c's comment tool walks the board the same
// way) import these instead of reimplementing them.
//
// Every move is a selection change only (no undo step, nothing pushed) followed by "bring it into view", as
// tldraw's `_selectShapesAndZoom` did.
import { type Bounds, type LobbyCanvas, NotImplementedError } from '../../../canvas/api/index.ts'
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

/** Alt+→ / Alt+↓ and Alt+← / Alt+↑: the next or previous element of the selection's level, wrapping. */
export function selectAdjacent(canvas: LobbyCanvas, direction: 'next' | 'prev'): boolean {
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
