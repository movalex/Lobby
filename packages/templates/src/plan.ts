/**
 * `@draftroom/templates/plan`: the template catalogue with neither engine in it: each template's picker
 * metadata and its plan (frames, texts, notes, boxes, arrows with their geometry). The dashboard's template
 * gallery previews templates from plans (apps/web/src/dashboard/template-catalog.ts), so its lazily loaded
 * chunk carries no tldraw and no Excalidraw code in either build.
 */
import type { BoardPlan } from './builder.ts'
import {
  type TemplateBounds,
  TemplateError,
  type TemplateId,
  type TemplatePoint,
  unionRects,
} from './common.ts'
import { getTemplateSource, planOf, TEMPLATE_SOURCES, type TemplateInfo } from './source.ts'

export type {
  BoardPlan,
  LobbyColor,
  LobbyFill,
  LobbySize,
  PlanArrow,
  PlanFrame,
  PlanGeo,
  PlanNode,
  PlanNote,
  PlanText,
} from './builder.ts'
export { type BoardBuilder, createBoardBuilder, IMAGE_SLOT_META, SWATCH_META } from './builder.ts'
export {
  NOTE_SIZE,
  type TemplateBounds,
  type TemplateCategory,
  TemplateError,
  type TemplateId,
  type TemplatePoint,
} from './common.ts'
export { getTemplateSource, isTemplateId, type TemplateInfo, type TemplateSource } from './source.ts'

/** The templates' metadata, in catalogue order (the Lobby tour last, as in `TEMPLATES`). */
export const TEMPLATE_INFOS: readonly TemplateInfo[] = Object.freeze(
  TEMPLATE_SOURCES.map(({ id, name, description, category, sections }) =>
    Object.freeze({ id, name, description, category, sections }),
  ),
)

/** A template's plan at `origin` (default 0, 0). Throws TemplateError('unknown-template'). */
export function planTemplate(id: TemplateId, origin: TemplatePoint = { x: 0, y: 0 }): BoardPlan {
  const source = getTemplateSource(id)
  if (!source) throw new TemplateError('unknown-template', 'Unknown template id')
  return planOf(source, { x: origin.x, y: origin.y })
}

/** Page-space bounds of a plan's top-level nodes (its frames and page-level arrows). */
export function planBounds(plan: BoardPlan): TemplateBounds {
  return (
    unionRects(plan.nodes.filter((n) => n.parent === null).map((n) => n.page)) ?? {
      x: plan.origin.x,
      y: plan.origin.y,
      w: 0,
      h: 0,
    }
  )
}
