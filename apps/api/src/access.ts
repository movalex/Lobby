// Board access for one caller, always decided by @draftroom/permissions. SQL only gathers the inputs
// (workspace membership, explicit grant, visibility, status); it never decides access on its own.

import { BOARD_ID_PATTERN, UserId, WorkspaceId } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import {
  type BoardAction,
  type BoardRole,
  type BoardStatus,
  type BoardVisibility,
  can,
  resolveBoardRole,
  type WorkspaceRole,
} from '@draftroom/permissions'
import { badRequest, forbidden, notFound } from './errors.ts'

export interface BoardRow {
  id: string
  workspace_id: string
  project_id: string | null
  title: string
  visibility: BoardVisibility
  status: BoardStatus
  trashed_at: Date | null
  created_by: string
  created_at: Date
  updated_at: Date
  last_opened_at: Date | null
}

const BOARD_FIELDS = [
  'id',
  'workspace_id',
  'project_id',
  'title',
  'visibility',
  'status',
  'trashed_at',
  'created_by',
  'created_at',
  'updated_at',
  'last_opened_at',
] as const satisfies readonly (keyof BoardRow)[]
/** Board columns qualified with the `b` alias (SELECT … FROM boards b). */
export const BOARD_COLUMNS = BOARD_FIELDS.map((f) => `b.${f}`).join(', ')
/** Unqualified board columns (INSERT/UPDATE … RETURNING). */
export const BOARD_RETURNING = BOARD_FIELDS.join(', ')

export interface BoardAccess {
  board: BoardRow
  workspaceName: string
  workspaceRole: WorkspaceRole | null
  grant: BoardRole | null
  /** resolveBoardRole: the caller's role ignoring status (status gates actions through `can`). */
  role: BoardRole | null
}

export const isBoardId = (v: unknown): v is string => typeof v === 'string' && BOARD_ID_PATTERN.test(v)
export const isUserId = (v: unknown): v is string => UserId.safeParse(v).success
export const isWorkspaceId = (v: unknown): v is string => WorkspaceId.safeParse(v).success

export async function loadBoardAccess(
  q: Queryable,
  boardId: string,
  userId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<BoardAccess | null> {
  if (!isBoardId(boardId)) return null
  // FOR UPDATE OF b serializes concurrent membership/status changes on one board (last-owner check).
  const row = await q.maybeOne<
    BoardRow & { workspace_name: string; workspace_role: WorkspaceRole | null; board_grant: BoardRole | null }
  >(
    `SELECT ${BOARD_COLUMNS}, w.name AS workspace_name, wm.role AS workspace_role, bm.role AS board_grant
       FROM boards b
       JOIN workspaces w ON w.id = b.workspace_id
       LEFT JOIN workspace_members wm ON wm.workspace_id = b.workspace_id AND wm.user_id = $2
       LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = $2
      WHERE b.id = $1${opts.forUpdate ? ' FOR UPDATE OF b' : ''}`,
    [boardId, userId],
  )
  if (!row) return null
  const { workspace_name, workspace_role, board_grant, ...board } = row
  return {
    board,
    workspaceName: workspace_name,
    workspaceRole: workspace_role,
    grant: board_grant,
    role: resolveBoardRole({
      workspaceRole: workspace_role,
      boardGrant: board_grant,
      visibility: board.visibility,
    }),
  }
}

/**
 * The role a live canvas connection gets (ticket + GET /internal/access), with board status applied:
 * - trashed → null for everyone, owners included: a trashed board cannot be opened, only restored
 *   from the dashboard;
 * - archived → 'viewer' for anyone who can view it (archived boards are read-only until restored;
 *   commenting is off too, per `can`);
 * - active → the resolved role.
 * The sync server only sees this role, so the status cap must be applied here.
 */
export function connectionRole(access: BoardAccess | null): BoardRole | null {
  if (!access?.role) return null
  const { status } = access.board
  if (!can(access.role, 'view', status)) return null
  return status === 'archived' ? 'viewer' : access.role
}

const STATUS_ACTIONS: ReadonlySet<BoardAction> = new Set(['archive', 'trash', 'restore'])

/**
 * Board visible to the caller for `action`. A trashed board is invisible to everyone except for the
 * status actions of those who could restore it (it is in their trash list, so it is no secret to them).
 */
function visibleFor(access: BoardAccess, action: BoardAction): boolean {
  const { role } = access
  const { status } = access.board
  if (can(role, 'view', status)) return true
  return STATUS_ACTIONS.has(action) && can(role, 'restore', status)
}

/** Loads the board and checks `action`: 404 when the caller cannot see it, 403 when they can but may not act. */
export async function requireBoardAction(
  q: Queryable,
  boardId: string,
  userId: string,
  action: BoardAction,
  opts: { forUpdate?: boolean } = {},
): Promise<BoardAccess> {
  const access = await loadBoardAccess(q, boardId, userId, opts)
  if (!access || !visibleFor(access, action)) throw notFound()
  if (!can(access.role, action, access.board.status)) throw forbidden()
  return access
}

/** Loads the board if the caller may see it at all (for the status transitions, which decide themselves). */
export async function requireVisibleBoard(
  q: Queryable,
  boardId: string,
  userId: string,
  action: BoardAction,
  opts: { forUpdate?: boolean } = {},
): Promise<BoardAccess> {
  const access = await loadBoardAccess(q, boardId, userId, opts)
  if (!access || !visibleFor(access, action)) throw notFound()
  return access
}

/** The caller's role in a workspace; 404 when they are not a member (the workspace stays invisible). */
export async function requireWorkspaceRole(
  q: Queryable,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole> {
  if (!isWorkspaceId(workspaceId)) throw notFound()
  const row = await q.maybeOne<{ role: WorkspaceRole }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  )
  if (!row) throw notFound()
  return row.role
}

/** The resolved role of a board the caller was already allowed to see (never null past the checks). */
export function roleOf(access: BoardAccess): BoardRole {
  if (!access.role) throw notFound()
  return access.role
}

/** 400 (not 404) for an unknown or foreign project: the id came from the caller's own request body. */
export async function requireProjectInWorkspace(q: Queryable, projectId: string, workspaceId: string) {
  const row = await q.maybeOne('SELECT 1 AS ok FROM projects WHERE id = $1 AND workspace_id = $2', [
    projectId,
    workspaceId,
  ])
  if (!row) throw badRequest('projectId: no such project in this workspace')
}
