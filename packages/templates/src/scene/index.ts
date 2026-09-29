/**
 * `@draftroom/templates/scene`: the templates on the new canvas. Every template (the Lobby tour included) is
 * the same engine-neutral source as the tldraw build's (../source.ts), emitted as Excalidraw elements
 * (./emit.ts) instead of tldraw records: same frames, texts, notes, boxes and arrows in the same places, with
 * fresh ids on every call. Inserting them is one `transact` of the canvas (plan §4.2 "insert as one undo
 * step"; the insert itself is wave 3b's).
 *
 * The default (tldraw) web build never imports this module (it loads the engine wrappers); it uses
 * `@draftroom/templates` until wave 4 removes the tldraw emitter.
 */

import type { IdSource } from '@draftroom/board-ops/elements'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import { isValidIndexKey } from '@draftroom/canvas-schema/engine'
import {
  guardContext,
  ownProp,
  readOrigin,
  type TemplateBounds,
  TemplateError,
  type TemplateId,
  type TemplatePoint,
  unionRects,
} from '../common.ts'
import { getTemplateSource, planOf } from '../source.ts'
import { planToScene } from './emit.ts'

export {
  IMAGE_SLOT_META,
  isTemplateId,
  planBounds,
  planTemplate,
  SWATCH_META,
  TEMPLATE_INFOS,
  type TemplateBounds,
  type TemplateCategory,
  TemplateError,
  type TemplateId,
  type TemplateInfo,
  type TemplatePoint,
} from '../plan.ts'
export {
  FONT_FAMILY,
  LABEL_FONT_SIZE,
  LINE_HEIGHT,
  planToScene,
  type SceneEmitOptions,
  type SceneEmitResult,
  STROKE_WIDTH,
  TEXT_FONT_SIZE,
} from './emit.ts'

/**
 * Largest accepted |origin| coordinate on the new canvas: every element must stay within ±1e6 (canvas-schema
 * limits.ts COORD_LIMIT), and the widest template (the tour) is about 10,400 wide.
 */
export const SCENE_MAX_ORIGIN = 900_000

export interface SceneTemplateContext {
  /** Scene-space position of the template's top-left corner. */
  origin: TemplatePoint
  /** The board's top index: the template's elements get fresh indices above it (on top of the board). */
  indexAbove?: string | null
}

export interface SceneTemplateInstance {
  /** every element, in paint order, fresh ids, indices above `indexAbove` */
  elements: WireElement[]
  /** scene-space bounds of the template's top-level elements (its frames and page-level arrows) */
  bounds: TemplateBounds
  /** the ids of the top-level elements (what an insert selects) */
  topLevelIds: string[]
}

/**
 * Validates an untrusted scene context. Returns a fresh plain copy or throws TemplateError('invalid-context').
 */
export function parseSceneTemplateContext(input: unknown): SceneTemplateContext {
  return guardContext(() => {
    if (input === null || typeof input !== 'object')
      throw new TemplateError('invalid-context', 'Template context must be an object')
    const origin = readOrigin(input, SCENE_MAX_ORIGIN)
    const key = ownProp(input, 'indexAbove')
    if (key === undefined || key === null) return { origin, indexAbove: null }
    if (typeof key !== 'string' || key.length > 200 || !isValidIndexKey(key))
      throw new TemplateError('invalid-context', 'Template context indexAbove must be a fractional index key')
    return { origin, indexAbove: key }
  })
}

/**
 * A template as Excalidraw elements (validated by the server's own element check and cross-element
 * invariants) plus the bounds of its top-level elements. Throws TemplateError for unknown ids or bad contexts.
 * Text metrics: see ./emit.ts (Node callers install the server table first).
 */
export function instantiateSceneTemplate(
  id: TemplateId,
  ctx: SceneTemplateContext,
  opts: { newId?: IdSource; now?: number } = {},
): SceneTemplateInstance {
  const source = getTemplateSource(id)
  if (!source) throw new TemplateError('unknown-template', 'Unknown template id')
  const parsed = parseSceneTemplateContext(ctx)
  const { elements } = planToScene(planOf(source, parsed.origin), {
    indexAbove: parsed.indexAbove,
    newId: opts.newId,
    now: opts.now,
  })
  const top = elements.filter((e) => e.frameId === null && !(e.type === 'text' && e.containerId))
  const bounds = unionRects(top.map(boxOf)) ?? { x: parsed.origin.x, y: parsed.origin.y, w: 0, h: 0 }
  return { elements, bounds, topLevelIds: top.map((e) => e.id) }
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
