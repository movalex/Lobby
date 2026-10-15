// OWNER: WS3 (wave Q). Putting a tile of the Elements panel on the board. Every source ends in ./place.ts
// placeElements: native elements, re-keyed, at the free spot nearest the middle of the view (a click, Enter, a tap) or
// centred on the pointer (a drop, joining the unlocked frame there), written in ONE transaction (one undo step), with
// the room's checks before anything is written.
//  - an icon: its geometry from WS1's shard, as elements at the chosen size and colour (./icons-port.ts);
//  - a shape: the piece built at the origin (@draftroom/templates/pieces), recoloured when a colour is chosen;
//  - a library item: POST /place first (it links the item's files into this board BEFORE anything is pushed: sync
//    caches a negative file-refs answer for 30 s), then its elements.
// Then the usage count and, for built-ins, a stamped use (the api stamps items itself on /place).
import { lobbyColor } from '@draftroom/board-ops/elements'
import {
  type ElementDragTarget,
  type InsertColorName,
  type InsertOptions,
  libraryMarkKey,
  parseIconKey,
} from '@draftroom/contracts'
import { isPieceId } from '@draftroom/templates/pieces/catalog'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { countUsage } from '../../lib/usage.ts'
import { loadPieces } from '../pieces/insert.ts'
import { placeLibraryItem } from './client.ts'
import { type IconsApi, loadIconsApi } from './icons-port.ts'
import { type PlaceFailure, placeElements } from './place.ts'

export type InsertFailure = PlaceFailure | 'unknown' | 'unavailable' | 'refused' | 'gone'

export type InsertResult =
  | {
      ok: true
      ids: string[]
      /** the mark key of what was inserted (Recents) */
      markKey: string
    }
  | { ok: false; reason: InsertFailure }

export interface InsertTileOptions {
  readonly options: InsertOptions
  /** the drop point (scene); default: the free spot nearest the middle of the view */
  readonly at?: { x: number; y: number } | null
  /** the icons (default: loaded once) */
  readonly icons?: IconsApi | null
  /** a library item's name for the undo label (default: 'library item') */
  readonly itemName?: string
}

type El = Record<string, unknown>

/**
 * A shape in another of Lobby's colours: lines and outlines take the colour's ink, filled shapes its pale tint (the
 * 'semi' fill), words keep theirs (readable on the tint). Frames and image slots are left as they are.
 */
export function tintElements(elements: readonly El[], color: InsertColorName | null): El[] {
  if (!color) return elements.map((e) => ({ ...e }))
  const c = lobbyColor(color)
  return elements.map((e) => {
    if (e.type === 'text' || e.type === 'frame' || e.type === 'image') return { ...e }
    const out: El = { ...e, strokeColor: c.solid }
    if (typeof e.backgroundColor === 'string' && e.backgroundColor !== 'transparent')
      out.backgroundColor = c.semi
    return out
  })
}

/** Lobby's fonts are in (a piece's words are measured with them). */
async function fontsReady(): Promise<void> {
  try {
    await (globalThis.document as Document | undefined)?.fonts?.ready
  } catch {
    // measure with what there is
  }
}

const fromPlace = (r: ReturnType<typeof placeElements>, markKey: string): InsertResult =>
  r.ok ? { ok: true, ids: r.ids, markKey } : { ok: false, reason: r.reason }

export async function insertTile(
  ctx: Pick<CanvasFeatureContext, 'canvas' | 'board'>,
  target: ElementDragTarget,
  o: InsertTileOptions,
): Promise<InsertResult> {
  const { canvas } = ctx
  if (canvas.readOnly()) return { ok: false, reason: 'readonly' }
  const place = { at: o.at ?? null, lock: o.options.lock }
  try {
    if (target.source === 'icon') {
      const key = parseIconKey(target.id)
      if (!key) return { ok: false, reason: 'unknown' }
      const api = o.icons === undefined ? await loadIconsApi() : o.icons
      if (!api) return { ok: false, reason: 'unavailable' }
      const index = await api.loadIndex()
      const geometry = await api.loadGeometry(index, key.set, key.name)
      if (!geometry) return { ok: false, reason: 'unknown' }
      if (canvas.readOnly()) return { ok: false, reason: 'readonly' }
      const source = api.elements({ ...key, geometry, size: o.options.size, color: o.options.color })
      // an icon is one group already (WS1's elements): no second group around it
      const version = index.sets.find((s) => s.id === key.set)?.version ?? '0.0.0'
      const markKey = libraryMarkKey({ source: 'icon', ...key, version })
      const r = fromPlace(placeElements(canvas, source, { ...place, keepTogether: false }), markKey)
      if (r.ok) countUsage('elements.insert.icon')
      return r
    }
    if (target.source === 'piece') {
      if (!isPieceId(target.id)) return { ok: false, reason: 'unknown' }
      const [mod] = await Promise.all([loadPieces(), fontsReady()])
      const info = mod.pieceInfo(target.id)
      if (!info) return { ok: false, reason: 'unknown' }
      if (canvas.readOnly()) return { ok: false, reason: 'readonly' }
      const piece = mod.instantiatePiece(target.id, { origin: { x: 0, y: 0 } })
      const elements = tintElements(piece.elements as unknown as El[], o.options.color)
      // a piece of several elements is one group already (the kit's own); a frame piece is never grouped
      const r = fromPlace(
        placeElements(
          canvas,
          { label: `insert ${info.name.toLowerCase()}`, elements, bounds: piece.bounds },
          place,
        ),
        libraryMarkKey({ source: 'piece', id: target.id }),
      )
      if (r.ok) countUsage('elements.insert.piece')
      return r
    }
    // a library item: linked into this board first, then pushed
    let answer: Awaited<ReturnType<typeof placeLibraryItem>>
    try {
      answer = await placeLibraryItem(ctx.board.id, target.id)
    } catch (e) {
      const code = (e as { code?: string }).code
      const status = (e as { status?: number | null }).status
      if (code === 'unavailable') return { ok: false, reason: 'unavailable' }
      if (status === 404) return { ok: false, reason: 'gone' }
      return { ok: false, reason: 'refused' }
    }
    if (canvas.readOnly()) return { ok: false, reason: 'readonly' }
    const label = `insert ${answer.item.name || o.itemName || 'library item'}`
    const r = fromPlace(
      placeElements(
        canvas,
        { label, elements: answer.elements },
        { ...place, keepTogether: o.options.keepTogether },
      ),
      libraryMarkKey({ source: 'item', id: target.id }),
    )
    if (r.ok) countUsage('elements.insert.item')
    return r
  } catch (e) {
    console.error('elements: insert failed', e)
    return { ok: false, reason: 'failed' }
  }
}

/** What to tell the person when an insert did not happen. */
export function insertFailureText(reason: InsertFailure): string {
  switch (reason) {
    case 'readonly':
      return 'You can view this board but not add to it.'
    case 'too-many-shapes':
      return 'This board has too many objects to add this.'
    case 'unavailable':
      return 'This isn’t available right now. Try again in a moment.'
    case 'gone':
      return 'That library item is gone, or you can no longer use it.'
    case 'refused':
      return 'You can’t add that library item to this board.'
    case 'invalid':
      return 'This element can’t be added to the board.'
    default:
      return 'The element could not be added.'
  }
}
