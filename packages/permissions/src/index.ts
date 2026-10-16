// Board/workspace authorization rules (docs/M1-CONTRACTS.md §3). Pure and browser-safe: the API and
// sync server enforce with these; the web client only uses them to decide what UI to show.

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'guest'] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const BOARD_ROLES = ['owner', 'editor', 'commenter', 'viewer'] as const
export type BoardRole = (typeof BOARD_ROLES)[number]

export const BOARD_VISIBILITIES = ['private', 'workspace_view', 'workspace_edit'] as const
export type BoardVisibility = (typeof BOARD_VISIBILITIES)[number]

/** The statuses a board can be seen in (lists, routes, the dashboard's filters). */
export const BOARD_STATUSES = ['active', 'archived', 'trashed'] as const
export type BoardStatus = (typeof BOARD_STATUSES)[number]

/**
 * Wave R (migration 0035_board_imports): a board an import job is still building (Miro import, a backup restore) is
 * stored with status `importing` until the job activates it in one transaction. It is NOT a BoardStatus: no
 * list, filter, route or schema names it, `can()` refuses every action on it (and on any other status it does not
 * know, so a build that meets a newer status fails closed), and the api's access loaders treat its row as missing.
 */
export const IMPORTING_BOARD_STATUS = 'importing'
/** Every value boards.status may hold (0035's CHECK). */
export const BOARD_ROW_STATUSES = [...BOARD_STATUSES, IMPORTING_BOARD_STATUS] as const
export type BoardRowStatus = (typeof BOARD_ROW_STATUSES)[number]

/** Whether a stored status is one a person may ever see the board in (fails closed on anything else). */
export function isBoardStatus(status: unknown): status is BoardStatus {
  return (BOARD_STATUSES as readonly unknown[]).includes(status)
}

/**
 * A board someone can open (active or archived): what the lists, the search index and the background passes keep.
 * Never "not trashed" (that would take in `importing`, or any status a newer build adds); SQL spells it
 * `status IN ('active', 'archived')` (apps/api's tripwire test refuses `<> 'trashed'`).
 */
export function isOpenBoardStatus(status: unknown): status is 'active' | 'archived' {
  return status === 'active' || status === 'archived'
}

export const BOARD_ACTIONS = [
  'view',
  'comment',
  'edit',
  'rename',
  'manage_access',
  'archive',
  'trash',
  'restore',
  'change_visibility',
] as const
export type BoardAction = (typeof BOARD_ACTIONS)[number]

const RANK: Record<BoardRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 }

export function maxRole(a: BoardRole | null, b: BoardRole | null): BoardRole | null {
  if (!a) return b
  if (!b) return a
  return RANK[a] >= RANK[b] ? a : b
}

export function roleAtLeast(role: BoardRole | null, min: BoardRole): boolean {
  return !!role && RANK[role] >= RANK[min]
}

export interface BoardAccessInput {
  /** The caller's membership in the board's workspace; null = not a member (tenant boundary). */
  workspaceRole: WorkspaceRole | null
  /** Explicit board_members grant, if any. */
  boardGrant: BoardRole | null
  visibility: BoardVisibility
}

/**
 * The caller's role on a board, ignoring board status (status gates actions in `can`).
 * Never grants anything to a non-member of the workspace, even with a stale board grant.
 */
export function resolveBoardRole(input: BoardAccessInput): BoardRole | null {
  const { workspaceRole, boardGrant, visibility } = input
  if (!workspaceRole) return null
  if (workspaceRole === 'owner' || workspaceRole === 'admin') return 'owner'
  if (workspaceRole === 'guest') return boardGrant
  const fromVisibility: BoardRole | null =
    visibility === 'workspace_edit' ? 'editor' : visibility === 'workspace_view' ? 'viewer' : null
  return maxRole(boardGrant, fromVisibility)
}

const ACTIVE: Record<BoardAction, BoardRole> = {
  view: 'viewer',
  comment: 'commenter',
  edit: 'editor',
  rename: 'editor',
  manage_access: 'owner',
  archive: 'owner',
  trash: 'owner',
  restore: 'owner',
  change_visibility: 'owner',
}

/**
 * Whether `role` may perform `action` on a board in `status`.
 * - archived: read-only for everyone (view); owners may restore or trash it.
 * - trashed: nobody can open it; owners may restore it (it is listed in their trash).
 * - anything else (wave R's `importing`, or a status a newer build added): nothing, for anyone.
 */
export function can(role: BoardRole | null, action: BoardAction, status: BoardStatus = 'active'): boolean {
  if (!role) return false
  if (!isBoardStatus(status)) return false
  if (status === 'trashed') return action === 'restore' && role === 'owner'
  if (status === 'archived') {
    if (action === 'view') return true
    return role === 'owner' && (action === 'restore' || action === 'trash' || action === 'manage_access')
  }
  if (action === 'restore') return false // nothing to restore on an active board
  return RANK[role] >= RANK[ACTIVE[action]]
}

/** Canvas write access for the sync server (read-only sessions get `isReadonly: true`). */
export function canEditCanvas(role: BoardRole | null, status: BoardStatus = 'active'): boolean {
  return can(role, 'edit', status)
}

/** Workspace-level: who may create boards/projects and invite people into the workspace. */
export function canCreateInWorkspace(role: WorkspaceRole | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'member'
}
export function canManageWorkspace(role: WorkspaceRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §4.1): creating workspaces, projects and boards (in
 * any form) needs a creator AND a workspace role that may create. `canCreateInWorkspace` itself stays
 * role-only: it also gates reads (members, projects, storage).
 */
export function canCreateContent(creator: boolean, role: WorkspaceRole | null): boolean {
  return creator && canCreateInWorkspace(role)
}

/**
 * Domain access: handing out access on a board (invitations, review/workshop/guest links, extending a
 * link, approving a request, raising a role or the visibility) needs a creator AND manage_access.
 * Lowering, removing, revoking and denying stay role-only.
 */
export function canHandOutAccess(
  creator: boolean,
  role: BoardRole | null,
  status: BoardStatus = 'active',
): boolean {
  return creator && can(role, 'manage_access', status)
}
