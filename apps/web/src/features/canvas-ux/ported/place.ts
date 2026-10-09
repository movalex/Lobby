// A11Y-07 on the Excalidraw canvas (the tldraw page's ui/place-at-center.ts): a keyboard-only way to put a
// shape on the board. Enter, with the note, shape or text tool picked and the board focused (./keys.ts),
// places that shape in the middle of the view, clear of what is already there (inside the unlocked frame
// under it), selects it and opens its text editor through the lease. One undo step. The shape takes the
// style of the next shapes (colour, fill, font), as a click would.
//
// W5-20 (the wave-5 review): as after a click with a creation tool (tldraw's rule, and the board page's
// N + click), the tool goes back to Select, so Esc then Enter edits the placed shape again instead of
// placing a blank one; with the tool lock on (Q) the tool stays, as it does after a click (wave K.1). A sticky note whose editor closes with no words in it is taken off the board in the
// same undo step (a keyboard user who changed their mind leaves nothing behind), and the live region says
// so (the a11y feature's announcer).
import type { CanvasFeatureContext, ItemKind, LobbyCanvas, StyleValues } from '../../../canvas/api/index.ts'
import { geometry, NotImplementedError } from '../../../canvas/api/index.ts'
import { announcerFor } from '../../a11y/ported/announcer.ts'
import { findEmptySpot, type Rect } from '../placement.ts'
import { frameAt, NOTE_SIZE, putInFrame } from './notes.ts'
import { createPolygon, editPolygonLabel, isPolygonTool, type PolygonKind } from './polygons.ts'
import { toolLock } from './tool-lock.ts'

/** What the live region says when an empty placed note is taken off the board (W5-20). */
export const EMPTY_NOTE_REMOVED = 'Empty sticky note removed'

export type PlaceableTool = 'note' | 'rectangle' | 'ellipse' | 'diamond' | 'text' | PolygonKind

/** A new shape keeps this much space (scene units) from what is already on the board. */
export const PLACE_GAP = 24
/** tldraw's size for a clicked (not dragged) rectangle or ellipse. */
export const SHAPE_SIZE = 200

const PLACEABLE: ReadonlySet<string> = new Set(['note', 'rectangle', 'ellipse', 'diamond', 'text'])
const SHAPES: ReadonlySet<string> = new Set(['rectangle', 'ellipse', 'diamond'])

/**
 * The tool whose shape Enter places, or null: a creation tool is picked, and (tldraw's rule) a shape tool
 * with one shape selected keeps Enter for that shape's label.
 */
export function placeableTool(ctx: Pick<CanvasFeatureContext, 'canvas'>): PlaceableTool | null {
  const { canvas } = ctx
  const tool = canvas.tool()
  // D4: the polygon tools place their shape too
  if (!tool || !(PLACEABLE.has(tool) || isPolygonTool(tool)) || canvas.editingId() !== null) return null
  if (SHAPES.has(tool) && canvas.selection.length === 1) {
    const only = canvas.get(canvas.selection[0] as string)
    if (only && SHAPES.has(only.type)) return null
  }
  return tool as PlaceableTool
}

/** The size (scene units) a placed shape takes. Pure. */
export function placedSize(tool: PlaceableTool): { w: number; h: number } {
  if (tool === 'note') return { w: NOTE_SIZE, h: NOTE_SIZE }
  if (tool === 'text') return { w: 120, h: 40 }
  return { w: SHAPE_SIZE, h: SHAPE_SIZE }
}

/** What a new shape stays clear of: every element but frames (it may go inside those) and labels. */
function obstacles(canvas: LobbyCanvas): Rect[] {
  const out: Rect[] = []
  for (const el of canvas.items()) {
    if (el.type === 'frame' || (el.type === 'text' && el.containerId)) continue
    const b = canvas.bounds(el.id)
    if (b) out.push({ x: b.x, y: b.y, w: b.width, h: b.height })
  }
  return out
}

function nextStyle(canvas: LobbyCanvas, tool: PlaceableTool): Record<string, unknown> {
  const n: StyleValues = canvas.styles.next()
  if (tool === 'text') {
    return {
      ...(n.fontFamily !== undefined ? { fontFamily: n.fontFamily } : {}),
      ...(n.fontSize !== undefined ? { fontSize: n.fontSize } : {}),
      ...(n.strokeColor !== undefined ? { strokeColor: n.strokeColor } : {}),
    }
  }
  if (tool === 'note') return {}
  const out: Record<string, unknown> = {}
  for (const f of [
    'strokeColor',
    'backgroundColor',
    'fillStyle',
    'strokeStyle',
    'roughness',
    'opacity',
  ] as const)
    if (n[f] !== undefined) out[f] = n[f]
  if (n.roundness === 'round') out.roundness = { type: tool === 'rectangle' ? 3 : 2 }
  return out
}

/**
 * W5-20: once the editor that opens on the placed note `id` closes, a note left with no words goes, in the
 * placing undo step (so one Ctrl+Z never brings back a blank note), and the live region says so.
 */
export function removeIfLeftEmpty(canvas: LobbyCanvas, id: string): void {
  let opened = false
  const off = canvas.on('editingChanged', (editing) => {
    if (editing === id) {
      opened = true
      return
    }
    off()
    if (!opened) return
    // after the editor's own close (its last words and the lease release) has run
    setTimeout(() => {
      const el = canvas.get(id)
      if (!el || (el as { isDeleted?: boolean }).isDeleted || canvas.isLocked(id) || canvas.readOnly()) return
      if (canvas.editingId() === id || canvas.text.of(id).trim() !== '') return
      canvas.transact('remove empty note', (tx) => tx.delete(id), { joinPrevious: true })
      if (canvas.selection.includes(id)) canvas.select(canvas.selection.filter((s) => s !== id))
      announcerFor(canvas).say(EMPTY_NOTE_REMOVED)
    }, 0)
  })
}

/**
 * W5-20: after a keyboard placement the tool goes back to Select, as after a click; with the tool lock on (K2-2's Q)
 * it stays, as a click keeps it (wave K.1: Enter used to drop the lock's tool).
 */
function backToSelect(canvas: LobbyCanvas): void {
  if (toolLock.get()) return
  if (canvas.tool() !== 'select') canvas.setTool('select')
}

/** Places the tool's shape; returns its id, or null on a read-only board. */
export function placeAtCenter(ctx: CanvasFeatureContext, tool: PlaceableTool): string | null {
  const { canvas } = ctx
  if (canvas.readOnly()) return null
  const size = placedSize(tool)
  const view = canvas.viewport.get()
  const spot = findEmptySpot(size, geometry.center(view), obstacles(canvas), { gap: PLACE_GAP })
  const frame = frameAt(canvas, { x: spot.x + size.w / 2, y: spot.y + size.h / 2 }, { unlockedOnly: true })
  if (isPolygonTool(tool)) {
    // D4: the polygon, ready to type its label in (its holder's)
    const made = createPolygon(
      canvas,
      tool,
      { x: spot.x, y: spot.y, width: size.w, height: size.h },
      `place ${tool}`,
    )
    if (!made) return null
    backToSelect(canvas)
    editPolygonLabel(canvas, made.holder, 'enter')
    return made.holder
  }
  const kind: ItemKind = tool
  const id = canvas.transact(`place ${tool}`, (tx) => {
    const props: Record<string, unknown> = { x: spot.x, y: spot.y, ...nextStyle(canvas, tool) }
    if (tool === 'note') props.size = NOTE_SIZE
    else if (tool === 'text') props.text = ''
    else Object.assign(props, { width: size.w, height: size.h })
    return tx.create(kind, props)
  })
  putInFrame(canvas, id, frame?.id)
  // W5-20: back to Select before the selection (switching tools keeps a selection only into Select), unless
  // the tool lock is on (K.1): then the tool stays, as after a click with it
  backToSelect(canvas)
  canvas.select([id])
  if (tool === 'note') removeIfLeftEmpty(canvas, id)
  // a crowded view pushes it to the nearest free spot, which can be off screen: bring it into view
  const placed = { x: spot.x, y: spot.y, width: size.w, height: size.h }
  if (!geometry.containsRect(view, placed)) {
    try {
      canvas.viewport.ensureVisible(placed, { margin: 64 })
    } catch (e) {
      if (!(e instanceof NotImplementedError)) throw e
      const c = geometry.center(placed)
      canvas.viewport.set({ x: c.x - view.width / 2, y: c.y - view.height / 2 })
    }
  }
  void canvas.text.edit(id, { via: 'enter', caret: 'end' })
  return id
}
