// Workspace templates (wave M, WS-TEMPLATES, M8-3 / M8-4): a board saved as a team template, and new boards
// started from it. OWNER: W5 holds packages/contracts after the wave M foundation; the routes are W8's
// (apps/api/src/features/ws-templates). Frozen by the foundation.
//
//   GET    /api/workspaces/:wid/templates                 → 200 ListWorkspaceTemplatesResponse   (members, no guests)
//   POST   /api/workspaces/:wid/templates                 AddWorkspaceTemplateInput → 201 WorkspaceTemplate
//                                                          (a creator who is a workspace owner or admin)
//   DELETE /api/workspaces/:wid/templates/:bid            → 204                                  (the same)
//   POST   /api/workspaces/:wid/templates/:bid/use        UseWorkspaceTemplateInput → 201 HistoryBoardCreated
//                                                          (a member who is a creator; never "can view the source")
//
// Stored in workspace_templates (migration 0030_workspace_templates): one row per (workspace, board), removed
// with its workspace or its board. "Use" copies the board's content through the sync's duplicate/seed path
// (createBoardFrom); the template's grants and links are never copied.
//
// Until W8 implements them none of these routes is registered (the api answers 404 NOT_FOUND, as for any
// unknown route); the web hides its Workspace tab on a 404 (M8-4).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

const BoardIdLike = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const UserIdLike = z.string().regex(/^usr_[0-9A-Za-z]{10,40}$/)
const ProjectIdLike = z.string().regex(/^prj_[0-9A-Za-z]{10,40}$/)

export const WS_TEMPLATES_ROUTE = '/api/workspaces/:wid/templates'
export const WS_TEMPLATE_ROUTE = '/api/workspaces/:wid/templates/:bid'
export const WS_TEMPLATE_USE_ROUTE = '/api/workspaces/:wid/templates/:bid/use'

/** Templates per workspace. */
export const WS_TEMPLATES_MAX = 100
export const WS_TEMPLATE_NAME_MAX = 80

/**
 * The picker's categories (the template gallery's chips) and 'other'. usage_daily never sees these: a
 * workspace template is counted as `template.pick:workspace`.
 */
export const WS_TEMPLATE_CATEGORIES = ['ideate', 'visual', 'plan', 'review', 'other'] as const
export const WsTemplateCategory = z.enum(WS_TEMPLATE_CATEGORIES)
export type WsTemplateCategory = z.infer<typeof WsTemplateCategory>

const TemplateName = z.string().trim().min(1).max(WS_TEMPLATE_NAME_MAX)

export const WorkspaceTemplate = z.object({
  /** The template board (it stays a board of the workspace; its own access rules are unchanged). */
  boardId: BoardIdLike,
  name: z.string(),
  category: WsTemplateCategory,
  addedBy: z.object({ id: UserIdLike, name: z.string() }),
  addedAt: z.string(),
})
export type WorkspaceTemplate = z.infer<typeof WorkspaceTemplate>

/** GET /api/workspaces/:wid/templates: newest first. */
export const ListWorkspaceTemplatesResponse = z.object({ templates: z.array(WorkspaceTemplate) })
export type ListWorkspaceTemplatesResponse = z.infer<typeof ListWorkspaceTemplatesResponse>

/** POST /api/workspaces/:wid/templates: a board of this workspace becomes a template (again: name and category). */
export const AddWorkspaceTemplateInput = z.strictObject({
  boardId: BoardIdLike,
  name: TemplateName,
  category: WsTemplateCategory.default('other'),
})
export type AddWorkspaceTemplateInput = z.infer<typeof AddWorkspaceTemplateInput>

/** POST /api/workspaces/:wid/templates/:bid/use: where the new board goes and its title (default: the template's name). */
export const UseWorkspaceTemplateInput = z.strictObject({
  projectId: ProjectIdLike.nullable().optional(),
  title: z.string().trim().min(1).max(120).optional(),
})
export type UseWorkspaceTemplateInput = z.infer<typeof UseWorkspaceTemplateInput>

export const wsTemplatesPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/templates`
export const wsTemplatePath = (workspaceId: string, boardId: string) =>
  `${wsTemplatesPath(workspaceId)}/${encodeURIComponent(boardId)}`
export const wsTemplateUsePath = (workspaceId: string, boardId: string) =>
  `${wsTemplatePath(workspaceId, boardId)}/use`
