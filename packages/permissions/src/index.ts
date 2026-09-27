// Board/workspace authorization rules (docs/M1-CONTRACTS.md §3). Pure and browser-safe: the API and
// sync server enforce with these; the web client only uses them to decide what UI to show.

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'guest'] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const BOARD_ROLES = ['owner', 'editor', 'commenter', 'viewer'] as const
export type BoardRole = (typeof BOARD_ROLES)[number]

export const BOARD_VISIBILITIES = ['private', 'workspace_view', 'workspace_edit'] as const
export type BoardVisibility = (typeof BOARD_VISIBILITIES)[number]

export const BOARD_STATUSES = ['active', 'archived', 'trashed'] as const
export type BoardStatus = (typeof BOARD_STATUSES)[number]

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
 */
export function can(role: BoardRole | null, action: BoardAction, status: BoardStatus = 'active'): boolean {
  if (!role) return false
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
