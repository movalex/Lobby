// L8-3: putting a piece on the board. The same path a template takes (canvas-ux navigation/template-insert.ts):
// the piece's elements are built with fresh ids (`@draftroom/templates/pieces`, loaded the first time), placed,
// and written in ONE `transact` through `tx.insert`, so one Ctrl+Z takes the whole piece away and the room
// validates every element as it would any other. Where it goes:
//  - a click, Enter or a command (wave M, M4-4, FTU-8): the free spot nearest the middle of the view, clear of
//    frames and of what is on the board (the AI's own spot finder, ../ai/ported/apply.ts spotNear), on the open
//    canvas: it never joins a frame it was not dropped in (a Decision used to land inside a 2x2, on its axes);
//    inserting the same piece again finds the next free spot;
//  - a drop: centred on the pointer, and it joins the unlocked frame under the pointer (every element of it gets
//    the frame's id), unless it is a frame itself (a swimlane: frames do not nest) or the frame is locked (a locked
//    frame takes nothing new).
// Then this tab's camera shows it whole, clear of the board's chrome (../ai/reveal.ts; the camera only).
import { MAX_ITEMS } from '@draftroom/canvas-schema/limits'
import type { PieceId } from '@draftroom/templates/pieces/catalog'
import { type Bounds, type CanvasElement, geometry, items, type LobbyCanvas } from '../../canvas/api/index.ts'
import { countUsage } from '../../lib/usage.ts'
import { spotNear } from '../ai/ported/apply.ts'
import { revealResult } from '../ai/reveal.ts'

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
    // measure at the origin (the size the layout really gives), then build at the place
    const probe = mod.instantiatePiece(id, { origin: { x: 0, y: 0 } })
    const drop = opts.at ?? null
    // a drop: centred on the pointer; else the free spot nearest the middle of the view, on the open canvas
    const at = drop
      ? { x: drop.x - probe.bounds.w / 2, y: drop.y - probe.bounds.h / 2 }
      : spotNear(canvas, { w: probe.bounds.w, h: probe.bounds.h }, [])
    const topLeft = { x: Math.round(at.x - probe.bounds.x), y: Math.round(at.y - probe.bounds.y) }
    const piece = mod.instantiatePiece(id, { origin: topLeft, indexAbove: topIndex(canvas) })
    // only a drop joins the unlocked frame under the pointer (not a frame of its own: frames do not nest)
    const frame = piece.frame || !drop ? null : frameAtPoint(canvas, drop)
    const frameId = frame && !canvas.isLocked(frame.id) ? frame.id : null
    const elements = frameId ? piece.elements.map((e) => ({ ...e, frameId })) : piece.elements
    const outer = elements.filter((e) => !(e.type === 'text' && e.containerId))
    if (items.contentItems(canvas.items()).length + outer.length > MAX_ITEMS)
      return { ok: false, reason: 'too-many-shapes' }
    canvas.transact(`insert ${info.name.toLowerCase()}`, (tx) => tx.insert(elements))
    const present = piece.topLevelIds.filter((x) => live(canvas.get(x)))
    if (present.length !== piece.topLevelIds.length) return { ok: false, reason: 'failed' }
    countUsage('pieces.insert')
    if (opts.select !== false) canvas.select(piece.topLevelIds)
    const bounds = { x: piece.bounds.x, y: piece.bounds.y, width: piece.bounds.w, height: piece.bounds.h }
    // shown whole, clear of the board's chrome (this tab's camera only)
    void revealResult(canvas, piece.topLevelIds)
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
