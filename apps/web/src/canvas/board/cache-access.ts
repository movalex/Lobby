// Wave M round 1 refix (M6-1 / M6-4): who may keep a board cache. The warm open's paint, its writes and the offline
// copy are for the members of the board's workspace (owner, admin, member), as the wave M plan says: an outside
// account invited to one board (workspace role 'guest') and a name-only guest never get one, whatever the board's
// export policy. Round 2 refix: the board's own answer (GET /api/boards/:id, `workspace.role`) states the role as it
// is now, so a member lowered to guest while the tab was open is not decided on the Me of the page load. The gate
// fails closed (wave M gate fix): an answer without the field (an api older than round 2, i.e. an api rollback) gets
// no copy, rather than the Me of the page load, which can be stale.

import type { BoardDetail } from '@draftroom/contracts'

const MEMBER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member'])

/** Whether this person may keep this device's copy of a board, by the board answer's `workspace`. */
export function boardCacheAllowed(workspace: Pick<BoardDetail['workspace'], 'role'>): boolean {
  const role = workspace.role
  return role != null && MEMBER_ROLES.has(role)
}
