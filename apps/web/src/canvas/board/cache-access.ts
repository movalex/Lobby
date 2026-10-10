// Wave M round 1 refix (M6-1 / M6-4): who may keep a board cache. The warm open's paint, its writes and the offline
// copy are for the members of the board's workspace (owner, admin, member), as the wave M plan says: an outside
// account invited to one board (workspace role 'guest') and a name-only guest never get one, whatever the board's
// export policy. Round 2 refix: the board's own answer (GET /api/boards/:id, `workspace.role`) states the role as it
// is now, so a member lowered to guest while the tab was open is not decided on the Me of the page load; only an
// answer without the field (an older api) falls back to Me. A board of a workspace that is not listed is not allowed.

import type { BoardDetail, Me } from '@draftroom/contracts'

const MEMBER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member'])

/** Whether `me` may keep this device's copy of a board of `workspace` (the board answer's workspace). */
export function boardCacheAllowed(
  me: Pick<Me, 'workspaces'>,
  workspace: Pick<BoardDetail['workspace'], 'id' | 'role'>,
): boolean {
  const role =
    workspace.role !== undefined ? workspace.role : me.workspaces.find((w) => w.id === workspace.id)?.role
  return role != null && MEMBER_ROLES.has(role)
}
