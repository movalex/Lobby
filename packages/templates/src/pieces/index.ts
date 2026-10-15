/**
 * `@draftroom/templates/pieces`: the shape kits ("Pieces", wave L, L8-3) as Excalidraw elements. A piece is a
 * function that returns native elements in board units, built with the template scene builder (../builder.ts)
 * and emitted by the template emitter (../scene/emit.ts), so each one passes the server's element check and the
 * cross-element invariants as authored. Every element carries `customData.lobby.kind = 'piece-<id>'`; image
 * placeholders carry the template slot marker and no file; a piece of several elements is one group; ids are
 * fresh on every call. The catalogue the panel searches (names, categories, keywords) is ./catalog.ts, which has
 * no engine in it: load this module only when a piece is inserted.
 *
 * Text layout needs text metrics: in a browser call this once Lobby's fonts have loaded (`sceneFontLoads` in
 * ../scene/index.ts, `document.fonts.ready`); in Node install the server table first (`installServerTextMetrics`).
 */
import type { IdSource } from '@draftroom/board-ops/elements'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import { round2 } from '@draftroom/canvas-schema/limits'
import { createBoardBuilder } from '../builder.ts'
import { type TemplateBounds, TemplateError, type TemplatePoint, unionRects } from '../common.ts'
import { planToScene } from '../scene/emit.ts'
import { type PieceId, pieceInfo, pieceKind } from './catalog.ts'
import { ARROW_PIECES } from './arrows.ts'
import { BADGE_PIECES } from './badges.ts'
import { CALLOUT_PIECES } from './callouts.ts'
import { DELIVERABLE_PIECES } from './deliverables.ts'
import { DEVICE_PIECES } from './devices.ts'
import { FLOWCHART_PIECES } from './flowchart.ts'
import { finish, freshId, type PieceDef } from './kit.ts'
import { PEOPLE_PIECES } from './people.ts'
import { STICKY_KIT_PIECES } from './sticky-kits.ts'
import { STORYBOARD_PIECES } from './storyboard.ts'
import { WIREFRAME_PIECES } from './wireframe.ts'

export * from './catalog.ts'

/** Largest accepted |origin| coordinate: every element must stay within ±1e6 (canvas-schema limits.ts COORD_LIMIT). */
export const PIECE_MAX_ORIGIN = 900_000

const DEFS: Readonly<Record<PieceId, PieceDef>> = Object.freeze({
  ...FLOWCHART_PIECES,
  ...WIREFRAME_PIECES,
  ...PEOPLE_PIECES,
  ...ARROW_PIECES,
  ...CALLOUT_PIECES,
  ...BADGE_PIECES,
  ...STICKY_KIT_PIECES,
  ...DEVICE_PIECES,
  ...STORYBOARD_PIECES,
  ...DELIVERABLE_PIECES,
})

export interface PieceContext {
  /** scene position of the piece's top-left corner */
  origin: TemplatePoint
  /** the board's top index: the piece's elements get fresh indices above it (on top of the board) */
  indexAbove?: string | null
}

export interface PieceInstance {
  readonly id: PieceId
  /** every element, in paint order, fresh ids, indices above `indexAbove` */
  readonly elements: WireElement[]
  /** scene-space bounds of the piece (its outer elements) */
  readonly bounds: TemplateBounds
  /** the ids a person selects after inserting it: every element but the bound labels */
  readonly topLevelIds: string[]
  /** the piece is a frame: it is never put inside another frame */
  readonly frame: boolean
}

/** The axis-aligned box of an unrotated element (a linear element's box from its points). */
function boxOf(e: WireElement): TemplateBounds {
  if (e.type === 'arrow' || e.type === 'line') {
    const xs = e.points.map((p) => e.x + p[0])
    const ys = e.points.map((p) => e.y + p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  return { x: e.x, y: e.y, w: e.width, h: e.height }
}

/**
 * Piece `id` at `ctx.origin`, as elements the server accepts. Throws TemplateError for an unknown id or an
 * origin outside the canvas.
 */
export function instantiatePiece(
  id: PieceId,
  ctx: PieceContext,
  opts: { newId?: IdSource; now?: number } = {},
): PieceInstance {
  const info = pieceInfo(id)
  const def = DEFS[id]
  if (!info || !def) throw new TemplateError('unknown-template', 'Unknown piece id')
  const { x, y } = ctx.origin
  if (![x, y].every((v) => Number.isFinite(v) && Math.abs(v) <= PIECE_MAX_ORIGIN))
    throw new TemplateError('invalid-context', 'Piece origin out of range')
  const newId = opts.newId ?? freshId
  // built at the origin of its own space (the builder adds an origin to frames only) and moved to `ctx.origin` after
  const b = createBoardBuilder({ x: 0, y: 0 })
  const after = def.build(b)
  const plan = b.finish()
  const emitted = planToScene(plan, {
    indexAbove: null,
    newId,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  const built = after ? after(emitted) : (emitted.elements as unknown as Record<string, unknown>[])
  const worked: Record<string, unknown>[] = built.map((e) => ({
    ...e,
    x: round2((e.x as number) + x),
    y: round2((e.y as number) + y),
  }))
  const elements = finish(worked, {
    kind: pieceKind(id),
    group: !info.frame && worked.filter((e) => !(e.type === 'text' && e.containerId)).length > 1,
    indexAbove: ctx.indexAbove ?? null,
    newId,
  })
  const top = elements.filter((e) => !(e.type === 'text' && e.containerId))
  const bounds = unionRects(top.map(boxOf)) ?? { x, y, w: 0, h: 0 }
  return { id, elements, bounds, topLevelIds: top.map((e) => e.id), frame: !!info.frame }
}
