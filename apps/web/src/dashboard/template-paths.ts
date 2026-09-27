// Board paths for new boards (kept apart from template-catalog.ts, which pulls in the template
// builders and is loaded lazily by the picker).

/** The template ids of @draftroom/templates (the catalog test checks this list stays in sync). */
export const TEMPLATE_IDS = [
  'brainstorm',
  'mood-board',
  'storyboard',
  'pitch-outline',
  'retrospective',
  'production-plan',
] as const
export type NewBoardTemplateId = (typeof TEMPLATE_IDS)[number]

/**
 * Where a new board opens. With a template, `?template=<id>` asks the board page (canvas-ux feature)
 * to insert it once on this first open and then drop the parameter.
 */
export function newBoardPath(boardId: string, templateId: NewBoardTemplateId | null): string {
  const base = `/b/${encodeURIComponent(boardId)}`
  return templateId ? `${base}?template=${encodeURIComponent(templateId)}` : base
}
