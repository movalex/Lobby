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
export function sortMembers<M extends BoardMember>(members: readonly M[], selfUserId: string): M[] {
  return [...members].sort((a, b) => {
    if (a.user.id === selfUserId) return -1
    if (b.user.id === selfUserId) return 1
    const byRole = rank(b.role) - rank(a.role)
    return byRole || a.user.name.localeCompare(b.user.name)
  })
}

const rank = (r: BoardRole) =>
  roleAtLeast(r, 'owner') ? 4 : roleAtLeast(r, 'editor') ? 3 : roleAtLeast(r, 'commenter') ? 2 : 1

// ---- dashboard-share additions (docs/FEATURES-M2-CONTRACTS.md) ------------------------------------

export const ROLE_OPTION_LABEL: Record<BoardRole, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}

export type InviteTarget =
  | { kind: 'empty' }
  | { kind: 'member'; member: WorkspaceMember }
  | { kind: 'already'; member: WorkspaceMember }
  | { kind: 'email'; email: string }
  | { kind: 'unknown'; text: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * What the "Invite by @handle or email" field refers to. A handle (with or without @) or an exact
 * name of someone in the workspace is granted directly; an email address or anyone else gets an
 * invite link to send them (Draftroom does not send email).
 */
export function parseInviteTarget(
  text: string,
  workspaceMembers: readonly WorkspaceMember[],
  boardMembers: readonly Pick<BoardMember, 'user' | 'source'>[],
): InviteTarget {
  const t = text.trim()
  if (!t) return { kind: 'empty' }
  if (EMAIL_RE.test(t)) return { kind: 'email', email: t }
  const handle = t.replace(/^@/, '').toLowerCase()
  const byHandle = workspaceMembers.find((m) => m.user.handle?.toLowerCase() === handle)
  const byName = workspaceMembers.filter((m) => m.user.name.toLowerCase() === t.toLowerCase())
  const member = byHandle ?? (byName.length === 1 ? byName[0] : undefined)
  if (!member) return { kind: 'unknown', text: t }
  const granted = boardMembers.some((b) => b.user.id === member.user.id && b.source === 'grant')
  return granted ? { kind: 'already', member } : { kind: 'member', member }
}

export interface AccessDetail {
  user: { id: string }
  role: BoardRole
  source: 'grant' | 'workspace'
  grant: BoardRole | null
  workspaceRole: 'owner' | 'admin' | 'member' | 'guest'
  withoutGrant: BoardRole | null
  viaReviewLink: boolean
  linkEndsAt: string | null
}

/** "Through which grant" for one person (PRS-02). */
export function accessSource(
  m: AccessDetail,
  workspaceName: string,
  formatDate: (iso: string) => string,
): string {
  if (m.viaReviewLink)
    return m.linkEndsAt
      ? `Joined with a review link · until ${formatDate(m.linkEndsAt)}`
      : 'Joined with a review link'
  if (m.source === 'workspace') {
    if (m.workspaceRole === 'owner' || m.workspaceRole === 'admin')
      return `${workspaceName} ${m.workspaceRole} · owns every board`
    const through = `Everyone in ${workspaceName} can ${m.role === 'editor' ? 'edit' : 'view'}`
    return m.grant ? `${through} (also invited as “${ROLE_OPTION_LABEL[m.grant]}”)` : through
  }
  return m.workspaceRole === 'guest' ? 'Direct access · guest' : 'Direct access'
}

/**
 * When removing someone's direct invite leaves them another grant, the dialog says so (PRS-02). Null
 * when removal ends their access (or they have no direct invite to remove).
 */
export function removalNote(m: AccessDetail): string | null {
  if (!m.grant || !m.withoutGrant) return null
  return `Removing their invite leaves “${ROLE_OPTION_LABEL[m.withoutGrant]}” through the workspace.`
}

/**
 * Direct grants can be changed or removed; workspace-derived access cannot (M1 rule). A workspace
 * owner/admin owns every board whatever their grant says, so their grant is not offered for editing.
 */
export const grantEditable = (m: Pick<AccessDetail, 'grant' | 'workspaceRole'>) =>
  m.grant !== null && m.workspaceRole !== 'owner' && m.workspaceRole !== 'admin'

// ---- shell-sharing-platform fixes ------------------------------------------------------------------

/** "Oct 4" for a review link, "3:40 PM" for a workshop link (they last hours). */
export type LinkDateFormat = (iso: string, kind: 'date' | 'time') => string

/**
 * The access line a non-manager sees under "Workspace access" while a link is open (PRI-07): the
 * select says "Private", but anyone with the link can get in. The widest open link wins.
 */
export function linkAccessLine(
  links: readonly { role: 'viewer' | 'commenter' | 'editor'; expiresAt: string }[],
  format: LinkDateFormat,
): string | null {
  if (!links.length) return null
  const top = links.some((l) => l.role === 'editor')
    ? 'editor'
    : links.some((l) => l.role === 'commenter')
      ? 'commenter'
      : 'viewer'
  const last = links
    .filter((l) => l.role === top)
    .reduce((a, b) => (Date.parse(b.expiresAt) > Date.parse(a.expiresAt) ? b : a))
  if (top === 'editor')
    return `Anyone with the workshop link can edit until ${format(last.expiresAt, 'time')}.`
  return `Anyone with the review link can ${top === 'commenter' ? 'comment' : 'view'} until ${format(last.expiresAt, 'date')}.`
}

/**
 * The confirmation before removing someone (PRI-21). When the workspace still gives them access,
 * say what they keep instead.
 */
export function removeConfirmText(name: string, fallback: string | null): string {
  if (fallback) return `Remove ${name}’s invite? ${fallback}`
  return `Remove ${name}? ${name} loses access now.`
}
