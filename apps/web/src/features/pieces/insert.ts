// L8-3: putting a piece on the board. The same path a template takes (canvas-ux navigation/template-insert.ts):
// the piece's elements are built with fresh ids (`@draftroom/templates/pieces`, loaded the first time), placed,
// and written in ONE `transact` through `tx.insert`, so one Ctrl+Z takes the whole piece away and the room
// validates every element as it would any other. Where it goes:
//  - a click, Enter or a command: centred on the middle of the view; inserting the same piece again nudges it
//    down and to the right, so a row of buttons is not one button on top of another;
//  - a drop: centred on the pointer.
// Either way it joins the unlocked frame under that point (every element of it gets the frame's id), unless it
// is a frame itself (a swimlane: frames do not nest) or the frame is locked (a locked frame takes nothing new).
import { MAX_ITEMS } from '@draftroom/canvas-schema/limits'
import type { PieceId } from '@draftroom/templates/pieces/catalog'
import { type Bounds, type CanvasElement, geometry, items, type LobbyCanvas } from '../../canvas/api/index.ts'

export type InsertPieceResult =
  | { ok: true; ids: string[]; bounds: Bounds; frameId: string | null }
  | { ok: false; reason: 'readonly' | 'too-many-shapes' | 'failed' | 'unknown' }

type PiecesModule = typeof import('@draftroom/templates/pieces')

let loaded: Promise<PiecesModule> | null = null
/** The builders, loaded once (they bring the engine's text layout: the panel's list needs none of it). */
export const loadPieces = (): Promise<PiecesModule> => {
  loaded ??= import('@draftroom/templates/pieces')
  return loaded
}

/** Lobby's fonts are in (text layout measures with them: the elements must be built after they load). */
async function fontsReady(): Promise<void> {
  try {
    await (globalThis.document as Document | undefined)?.fonts?.ready
  } catch {
    // measure with what there is
  }
}

const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** The innermost frame whose area holds `point`, or null. */
export function frameAtPoint(
  canvas: Pick<LobbyCanvas, 'items' | 'isHidden'>,
  point: { x: number; y: number },
) {
  let best: { el: CanvasElement; area: number } | null = null
  for (const el of canvas.items()) {
    if (el.type !== 'frame' || !live(el) || canvas.isHidden(el.id)) continue
    const b = { x: el.x, y: el.y, width: el.width, height: el.height }
    if (!geometry.containsPoint(b, point)) continue
    const area = b.width * b.height
    if (!best || area < best.area) best = { el, area }
  }
  return best?.el ?? null
}

/** The board's top fractional index (the piece goes on top). */
function topIndex(canvas: LobbyCanvas): string | null {
  let top: string | null = null
  for (const e of canvas.items()) if (e.index && (top === null || e.index > top)) top = e.index
  return top
}

const NUDGE = 24

/** Down and right from `topLeft` until no earlier copy of this piece sits there. */
function clearOfCopies(canvas: LobbyCanvas, kind: string, topLeft: { x: number; y: number }) {
  const copies = canvas.items().filter((e) => items.lobbyValue(e, 'kind') === kind)
  const at = { ...topLeft }
  for (let i = 0; i < 20; i++) {
    const taken = copies.some((e) => Math.abs(e.x - at.x) < 2 && Math.abs(e.y - at.y) < 2)
    if (!taken) break
    at.x += NUDGE
    at.y += NUDGE
  }
  return at
}

export interface InsertPieceOptions {
  /** the pointer (a drop): the piece is centred on it. Default: the middle of the view. */
  readonly at?: { x: number; y: number } | null
  /** select the new piece (default true) */
  readonly select?: boolean
  /** the builders (default: loaded on first use) */
  readonly load?: () => Promise<PiecesModule>
}

export async function insertPiece(
  canvas: LobbyCanvas,
  id: PieceId,
  opts: InsertPieceOptions = {},
): Promise<InsertPieceResult> {
  if (canvas.readOnly()) return { ok: false, reason: 'readonly' }
  try {
    const [mod] = await Promise.all([(opts.load ?? loadPieces)(), fontsReady()])
    const info = mod.pieceInfo(id)
    if (!info) return { ok: false, reason: 'unknown' }
    if (canvas.readOnly()) return { ok: false, reason: 'readonly' }
    const v = canvas.viewport.get()
    const centre = opts.at ?? { x: v.x + v.width / 2, y: v.y + v.height / 2 }
    // measure at the origin (the size the layout really gives), then build at the place
    const probe = mod.instantiatePiece(id, { origin: { x: 0, y: 0 } })
    let topLeft = {
      x: Math.round(centre.x - probe.bounds.w / 2 - probe.bounds.x),
      y: Math.round(centre.y - probe.bounds.h / 2 - probe.bounds.y),
    }
    if (!opts.at) topLeft = clearOfCopies(canvas, mod.pieceKind(id), topLeft)
    const piece = mod.instantiatePiece(id, { origin: topLeft, indexAbove: topIndex(canvas) })
    // the unlocked frame under the point takes it (not a frame of its own: frames do not nest)
    const frame = piece.frame ? null : frameAtPoint(canvas, centre)
    const frameId = frame && !canvas.isLocked(frame.id) ? frame.id : null
    const elements = frameId ? piece.elements.map((e) => ({ ...e, frameId })) : piece.elements
    const outer = elements.filter((e) => !(e.type === 'text' && e.containerId))
    if (items.contentItems(canvas.items()).length + outer.length > MAX_ITEMS)
      return { ok: false, reason: 'too-many-shapes' }
    canvas.transact(`insert ${info.name.toLowerCase()}`, (tx) => tx.insert(elements))
    const present = piece.topLevelIds.filter((x) => live(canvas.get(x)))
    if (present.length !== piece.topLevelIds.length) return { ok: false, reason: 'failed' }
    if (opts.select !== false) canvas.select(piece.topLevelIds)
    const bounds = { x: piece.bounds.x, y: piece.bounds.y, width: piece.bounds.w, height: piece.bounds.h }
    try {
      canvas.viewport.ensureVisible(bounds, { animate: true })
    } catch {
      // the camera is not the board
    }
    return { ok: true, ids: piece.topLevelIds, bounds, frameId }
  } catch (e) {
    console.error('piece insert failed', e)
    return { ok: false, reason: 'failed' }
  }
}

/** What to tell the person when an insert did not happen. */
export function failureText(reason: Extract<InsertPieceResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'readonly':
      return 'You can view this board but not add to it.'
    case 'too-many-shapes':
      return 'This board has too many objects to add this piece.'
    default:
      return 'The piece could not be added.'
  }
}
