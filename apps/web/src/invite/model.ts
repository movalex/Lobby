import type { InvitationPreview } from '@draftroom/contracts'

const BOARD_ROLE: Record<string, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}
const WORKSPACE_ROLE: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
}

export interface InvitationSummary {
  eyebrow: string
  title: string
  roleLabel: string
  acceptLabel: string
}

/** Copy for the invitation screen. Unknown roles are shown as "Member"/"Can view" rather than raw. */
export function invitationSummary(inv: InvitationPreview): InvitationSummary {
  const who = inv.invitedBy.name || 'Someone'
  if (inv.board) {
    return {
      eyebrow: `${who} invited you to a board`,
      title: `Join “${inv.board.title}”`,
      roleLabel: BOARD_ROLE[inv.role] ?? 'Can view',
      acceptLabel: 'Accept and open board',
    }
  }
  return {
    eyebrow: `${who} invited you to a workspace`,
    title: `Join ${inv.workspace.name}`,
    roleLabel: WORKSPACE_ROLE[inv.role] ?? 'Member',
    acceptLabel: 'Accept and open workspace',
  }
}
