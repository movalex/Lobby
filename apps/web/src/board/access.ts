import { type BoardRole, type BoardStatus, can } from '../lib/permissions.ts'

export interface AccessPill {
  label: string
  title: string
  /** The pill is a button that opens the "ask for more access" flow (PRI-09b). */
  request: boolean
}

/**
 * The top-bar pill for people who cannot edit the canvas. UI only: the sync server decides what a
 * session may write (read-only sessions have their writes skipped), this just explains it.
 */
export function readonlyPill(role: BoardRole, status: BoardStatus): AccessPill | null {
  if (can(role, 'edit', status)) return null
  if (status === 'archived') {
    return {
      label: 'Archived · View only',
      title: 'This board is archived: it is read-only until an owner restores it',
      request: false,
    }
  }
  if (can(role, 'comment', status)) {
    return {
      label: 'Can comment',
      title: 'You can look around and comment (comments are saved), but not change the board',
      request: true,
    }
  }
  return { label: 'View only', title: 'You can look around but not change this board', request: true }
}

/** Whether the editor must be read-only for this role (tldraw instance state; the server enforces). */
export const isReadonlyRole = (role: BoardRole, status: BoardStatus) => !can(role, 'edit', status)

/**
 * The one-time hint after a blocked edit on a read-only board (PRI-08). `owner` is the name of
 * someone who can grant access, when known.
 */
export function blockedEditHint(role: BoardRole, owner: string | null): string {
  const what = role === 'commenter' ? 'You can comment on this board.' : 'You can view this board.'
  return `${what} Ask ${owner ?? 'an owner'} for edit access.`
}

const ROLE_NAME: Record<BoardRole, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}

/**
 * The toast when my role on an open board changes (PRI-09b), or null when nothing to say. Raising
 * someone to edit is the change they asked for, so it reads as a grant.
 */
export function roleChangeNotice(before: BoardRole, after: BoardRole): string | null {
  if (before === after) return null
  if (after === 'editor' && (before === 'viewer' || before === 'commenter'))
    return 'You can edit this board now'
  if (after === 'owner') return 'You are now an owner of this board'
  return `Your access changed to ${ROLE_NAME[after]}`
}
