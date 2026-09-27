import type { BoardMember, WorkspaceMember } from '@draftroom/contracts'
import { BOARD_ROLES, type BoardRole, type BoardVisibility, roleAtLeast } from '../lib/permissions.ts'

export const VISIBILITY_OPTIONS: readonly {
  value: BoardVisibility
  label: string
  describe(workspace: string): string
}[] = [
  {
    value: 'private',
    label: 'Private',
    describe: () => 'Only the people listed below can open this board.',
  },
  {
    value: 'workspace_view',
    label: 'Workspace can view',
    describe: (ws) => `Everyone in ${ws} can open and view this board. People listed below keep their role.`,
  },
  {
    value: 'workspace_edit',
    label: 'Workspace can edit',
    describe: (ws) => `Everyone in ${ws} can open and edit this board. Guests still need to be added.`,
  },
]

/** Invite links can hand out any role except owner (the API rejects owner invitations too). */
export const inviteRoleOptions = (): Exclude<BoardRole, 'owner'>[] =>
  BOARD_ROLES.filter((r): r is Exclude<BoardRole, 'owner'> => r !== 'owner')

/**
 * Only explicit grants get a role select. Workspace-derived access (workspace admins are owners of
 * every board; visibility gives members view/edit) is not changed by a board grant, so offering a
 * select there would look like it did something it does not.
 */
export const memberRoleEditable = (m: BoardMember) => m.source === 'grant'

/** Workspace members who can be given an explicit grant (not already granted on this board). */
export function shareableWorkspaceMembers(
  workspaceMembers: readonly WorkspaceMember[],
  boardMembers: readonly BoardMember[],
): WorkspaceMember[] {
  const granted = new Set(boardMembers.filter((m) => m.source === 'grant').map((m) => m.user.id))
  return workspaceMembers
    .filter((m) => !granted.has(m.user.id) && m.role !== 'owner' && m.role !== 'admin')
    .sort((a, b) => a.user.name.localeCompare(b.user.name))
}

/** You first, then by role (owners first), then by name. */
export function sortMembers(members: readonly BoardMember[], selfUserId: string): BoardMember[] {
  return [...members].sort((a, b) => {
    if (a.user.id === selfUserId) return -1
    if (b.user.id === selfUserId) return 1
    const byRole = rank(b.role) - rank(a.role)
    return byRole || a.user.name.localeCompare(b.user.name)
  })
}

const rank = (r: BoardRole) =>
  roleAtLeast(r, 'owner') ? 4 : roleAtLeast(r, 'editor') ? 3 : roleAtLeast(r, 'commenter') ? 2 : 1
