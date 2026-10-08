// The template catalogue as engine-neutral sources: each template's picker metadata and its content, written
// once against the plan builder (./builder.ts). The tldraw registry (./registry.ts) and the Excalidraw scene
// registry (./scene/index.ts) both read this list, so the two engines always offer the same templates with
// the same content and structure.

import { type BoardBuilder, type BoardPlan, createBoardBuilder } from './builder.ts'
import type { TemplateCategory, TemplateId, TemplatePoint } from './common.ts'
import { brainstorm } from './templates/brainstorm.ts'
import { clientFeedback } from './templates/client-feedback.ts'
import { creativeBrief } from './templates/creative-brief.ts'
import { kanban } from './templates/kanban.ts'
import { launchTimeline } from './templates/launch-timeline.ts'
import { lobbyTour } from './templates/lobby-tour.ts'
import { moodBoard } from './templates/mood-board.ts'
import { pitchOutline } from './templates/pitch-outline.ts'
import { prioritisation2x2 } from './templates/prioritisation-2x2.ts'
import { productionPlan } from './templates/production-plan.ts'
import { retrospective } from './templates/retrospective.ts'
import { shotList } from './templates/shot-list.ts'
import { storyboard } from './templates/storyboard.ts'

/** What the template picker shows. */
export interface TemplateInfo {
  id: TemplateId
  name: string
  /** One sentence for the template picker. */
  description: string
  category: TemplateCategory
  /** Frame names in the intended reading order (rows top to bottom, then left to right). */
  sections: readonly string[]
}

/** A template's metadata and its content. */
export interface TemplateSource extends TemplateInfo {
  /**
   * The template's notes are its prompts and instructions (questions, placeholders), not ideas: each is
   * marked so Group into themes leaves it where it is (PlanNote `prompt`, CR-3H-2). The Lobby tour's are
   * example ideas the demo groups, so it leaves this off.
   */
  promptNotes?: boolean
  /** Adds the template's frames, texts, notes, boxes and arrows to `b` (origin = the template's top-left). */
  plan(b: BoardBuilder): void
}

export const TEMPLATE_SOURCES: readonly TemplateSource[] = Object.freeze(
  [
    brainstorm,
    moodBoard,
    storyboard,
    pitchOutline,
    retrospective,
    productionPlan,
    // wave K (K4-2): the agency templates
    creativeBrief,
    clientFeedback,
    shotList,
    launchTimeline,
    prioritisation2x2,
    kanban,
    lobbyTour,
  ].map((s) => Object.freeze({ ...s, sections: Object.freeze([...s.sections]) })),
)

const BY_ID = new Map<string, TemplateSource>(TEMPLATE_SOURCES.map((t) => [t.id, t]))

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && BY_ID.has(value)
}

export function getTemplateSource(id: unknown): TemplateSource | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined
}

/** The plan of `source` at page-space `origin` (fresh objects on every call). */
export function planOf(source: TemplateSource, origin: TemplatePoint): BoardPlan {
  const b = createBoardBuilder(origin, { promptNotes: source.promptNotes ?? false })
  source.plan(b)
  return b.finish()
}
