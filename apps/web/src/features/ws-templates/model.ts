// OWNER: W8 (wave M, M8-4). Workspace templates on the web, the pure rules: who is offered "Save as workspace
// template", the categories' words, and the picker's search over a workspace's templates. The servers decide
// (features/ws-templates in the api); these only decide what is shown.

import {
  type MeAccess,
  type WorkspaceTemplate,
  WS_TEMPLATE_CATEGORIES,
  WS_TEMPLATE_NAME_MAX,
  type WsTemplateCategory,
} from '@draftroom/contracts'
import type { WorkspaceRole } from '@draftroom/permissions'

export const WS_CATEGORY_LABEL: Record<WsTemplateCategory, string> = {
  ideate: 'Ideate',
  visual: 'Visual',
  plan: 'Plan',
  review: 'Review',
  other: 'Other',
}
export const WS_CATEGORY_OPTIONS: readonly { value: WsTemplateCategory; label: string }[] =
  WS_TEMPLATE_CATEGORIES.map((value) => ({ value, label: WS_CATEGORY_LABEL[value] }))

export interface SaveFacts {
  /** Me.access (a creator: a verified address on a creator domain, or the exceptions list). */
  access: Pick<MeAccess, 'creator'>
  /** The caller's role in the board's workspace (Me.workspaces), null when they have none. */
  workspaceRole: WorkspaceRole | null
  boardStatus: 'active' | 'archived' | 'trashed'
  /** A template list of this workspace answered 404 in this tab (an api without templates). */
  missing: boolean
}

/** "Save as workspace template" is offered to a creator who is a workspace owner or admin (the api's own rule). */
export function canSaveWsTemplate(f: SaveFacts): boolean {
  if (f.missing || !f.access.creator) return false
  if (f.workspaceRole !== 'owner' && f.workspaceRole !== 'admin') return false
  return f.boardStatus !== 'trashed'
}

/** The name the dialog starts with: the board's title, cut to the contract's length. */
export function defaultTemplateName(boardTitle: string): string {
  const t = boardTitle.replace(/\s+/g, ' ').trim()
  return [...t].slice(0, WS_TEMPLATE_NAME_MAX).join('').trim() || 'Team template'
}

/** A name the api accepts (trimmed, 1..80), or null. */
export function templateNameOrNull(raw: string): string | null {
  const t = raw.trim()
  return t.length >= 1 && [...t].length <= WS_TEMPLATE_NAME_MAX ? t : null
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()

/** The picker's search: every word in the template's name, its category's word or who saved it. */
export function filterWsTemplates(
  templates: readonly WorkspaceTemplate[],
  query: string,
): WorkspaceTemplate[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [...templates]
  return templates.filter((t) => {
    const hay = fold([t.name, WS_CATEGORY_LABEL[t.category], t.addedBy?.name ?? ''].join(' '))
    return words.every((w) => hay.includes(w))
  })
}

/** The card's small line: the category, and who saved it. */
export const templateMeta = (t: WorkspaceTemplate): string =>
  t.addedBy ? `${WS_CATEGORY_LABEL[t.category]} · saved by ${t.addedBy.name}` : WS_CATEGORY_LABEL[t.category]
