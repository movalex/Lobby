// L8-3: putting a piece on the board. The piece's elements are built (`@draftroom/templates/pieces`, loaded the first
// time, once Lobby's fonts are in: the layout measures with them) and handed to the Elements panel's shared insert,
// ../elements/place.ts placeElements (wave Q: generalised from this file), which re-keys them, places them and writes
// them in ONE `transact` through `tx.insert`, so one Ctrl+Z takes the whole piece away and the room validates every
// element as it would any other. Where it goes:
//  - a click, Enter or a command (wave M, M4-4, FTU-8): the free spot nearest the middle of the view, clear of
//    frames and of what is on the board (the AI's own spot finder, ../ai/ported/apply.ts spotNear), on the open
//    canvas: it never joins a frame it was not dropped in (a Decision used to land inside a 2x2, on its axes);
//    inserting the same piece again finds the next free spot;
//  - a drop: centred on the pointer, and it joins the unlocked frame under the pointer (every element of it gets
//    the frame's id), unless it is a frame itself (a swimlane: frames do not nest) or the frame is locked (a locked
//    frame takes nothing new).
// Then this tab's camera shows it whole, clear of the board's chrome (../ai/reveal.ts; the camera only).
import type { PieceId } from '@draftroom/templates/pieces/catalog'
import type { Bounds, LobbyCanvas } from '../../canvas/api/index.ts'
import { countUsage } from '../../lib/usage.ts'
import { placeElements } from '../elements/place.ts'

export { frameAtPoint } from '../elements/place.ts'

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
    // built at the origin with the size the layout really gives; placeElements moves it into place
    const piece = mod.instantiatePiece(id, { origin: { x: 0, y: 0 } })
    const placed = placeElements(
      canvas,
      { label: `insert ${info.name.toLowerCase()}`, elements: piece.elements, bounds: piece.bounds },
      { at: opts.at ?? null, select: opts.select !== false },
    )
    if (!placed.ok) {
      if (placed.reason === 'readonly' || placed.reason === 'too-many-shapes')
        return { ok: false, reason: placed.reason }
      return { ok: false, reason: 'failed' }
    }
    countUsage('pieces.insert')
    return { ok: true, ids: placed.ids, bounds: placed.bounds, frameId: placed.frameId }
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
      return 'This board has too many objects to add this shape.'
    default:
      return 'The shape could not be added.'
  }
}
