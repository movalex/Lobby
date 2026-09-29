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
  /**
   * Bridge release R0 (migration 0022): the board was born on the new canvas (Excalidraw). This build
   * cannot open, duplicate or export it; the API says so (NEW_CANVAS_BOARD_MESSAGE).
   */
  new_canvas: boolean
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
  'new_canvas',
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

type AccessRow = BoardRow & {
  workspace_name: string
  workspace_role: WorkspaceRole | null
  board_grant: BoardRole | null
}

const ACCESS_COLUMNS = `${BOARD_COLUMNS}, w.name AS workspace_name, wm.role AS workspace_role, bm.role AS board_grant`

function toAccess(row: AccessRow): BoardAccess {
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

// ---- row-lock order ------------------------------------------------------------------------------
//
// With a real Postgres pool, requests run on separate connections at once, and two transactions that
// lock the same rows in opposite orders deadlock: Postgres then fails one of them (a 500). So every
// transaction that locks more than one of these takes them top-down, never bottom-up:
//   1. the board row: FOR UPDATE (requireBoardAction/loadBoardAccess `forUpdate`, lockBoardRow). Note
//      that inserting a row that references a board (board_members, comments, invitation_redemptions,
//      ...) takes a key-share lock on the board row, which waits for FOR UPDATE: that is step 1 too;
//   2. a row that belongs to the board: an invitation or review link, an access request, the board's
//      timer, thumbnail or export policy, a vote or private-brainstorm session;
//   3. a name-only guest's user row (joining or accepting a guest link, the guest sweep);
//   4. board_members and sessions rows.
// A transaction that only knows a step-2 row (joining through a link, accepting an invitation, the
// expired-link sweeper) reads it WITHOUT a lock first, locks the board, then locks and re-reads it.
// Safe exception: a reply locks its comment thread, then inserts the comment (whose key-share lock on
// the board comes after that thread lock), because no transaction that holds a board lock ever waits
// for a thread's lock. Keep it that way, or lock the board first there too.
// Assets have their own order: a preview job before its asset version (the worker routes; files/gc.ts).

/**
 * Locks the board row (step 1 above) without loading access: for a transaction that found the board
 * through one of its rows. False when the board does not exist.
 */
export async function lockBoardRow(q: Queryable, boardId: string): Promise<boolean> {
  if (!isBoardId(boardId)) return false
  return (await q.maybeOne('SELECT id FROM boards WHERE id = $1 FOR UPDATE', [boardId])) !== null
}

export async function loadBoardAccess(
  q: Queryable,
  boardId: string,
  userId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<BoardAccess | null> {
  if (!isBoardId(boardId)) return null
  // FOR UPDATE OF b serializes concurrent membership/status changes on one board (last-owner check).
  const row = await q.maybeOne<AccessRow>(
    `SELECT ${ACCESS_COLUMNS}
       FROM boards b
       JOIN workspaces w ON w.id = b.workspace_id
       LEFT JOIN workspace_members wm ON wm.workspace_id = b.workspace_id AND wm.user_id = $2
       LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = $2
      WHERE b.id = $1${opts.forUpdate ? ' FOR UPDATE OF b' : ''}`,
    [boardId, userId],
  )
  return row ? toAccess(row) : null
}

export interface BoardUserPair {
  boardId: string
  userId: string
}

export const pairKey = (p: BoardUserPair) => `${p.boardId}\u0000${p.userId}`

const PAIRS_PER_QUERY = 500

/**
 * loadBoardAccess for many (board, user) pairs in a few queries (the event streams' re-checks).
 * Keyed by pairKey(); a pair whose board does not exist (or is malformed) maps to null.
 */
export async function loadBoardAccessMany(
  q: Queryable,
  pairs: readonly BoardUserPair[],
): Promise<Map<string, BoardAccess | null>> {
  const out = new Map<string, BoardAccess | null>()
  const unique = new Map<string, BoardUserPair>()
  for (const p of pairs) {
    out.set(pairKey(p), null)
    if (isBoardId(p.boardId)) unique.set(pairKey(p), p)
  }
  const list = [...unique.values()]
  for (let i = 0; i < list.length; i += PAIRS_PER_QUERY) {
    const chunk = list.slice(i, i + PAIRS_PER_QUERY)
    const rows = await q.query<AccessRow & { pair_user: string }>(
      `SELECT p.user_id AS pair_user, ${ACCESS_COLUMNS}
         FROM unnest($1::text[], $2::text[]) AS p(board_id, user_id)
         JOIN boards b ON b.id = p.board_id
         JOIN workspaces w ON w.id = b.workspace_id
         LEFT JOIN workspace_members wm ON wm.workspace_id = b.workspace_id AND wm.user_id = p.user_id
         LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = p.user_id`,
      [chunk.map((p) => p.boardId), chunk.map((p) => p.userId)],
    )
    for (const { pair_user, ...row } of rows.rows)
      out.set(pairKey({ boardId: row.id, userId: pair_user }), toAccess(row))
  }
  return out
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
