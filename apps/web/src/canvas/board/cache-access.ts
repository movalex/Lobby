// Wave M round 1 refix (M6-1 / M6-4): who may keep a board cache. The warm open's paint, its writes and the offline
// copy are for the members of the board's workspace (owner, admin, member), as the wave M plan says: an outside
// account invited to one board (workspace role 'guest') and a name-only guest never get one, whatever the board's
// export policy. Read from Me (the session's own answer); a board of a workspace that is not listed is not allowed.

import type { Me } from '@draftroom/contracts'

const MEMBER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member'])

/** Whether `me` may keep this device's copy of a board of workspace `workspaceId`. */
export function boardCacheAllowed(me: Pick<Me, 'workspaces'>, workspaceId: string): boolean {
  const role = me.workspaces.find((w) => w.id === workspaceId)?.role
  return role !== undefined && MEMBER_ROLES.has(role)
}
