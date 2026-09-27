import { type BoardRole, type BoardStatus, can } from '../lib/permissions.ts'

export interface AccessPill {
  label: string
  title: string
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
    }
  }
  if (can(role, 'comment', status)) {
    return { label: 'Can comment', title: 'You can look around and comment, but not change the board' }
  }
  return { label: 'View only', title: 'You can look around but not change this board' }
}

/** Whether the editor must be read-only for this role (tldraw instance state; the server enforces). */
export const isReadonlyRole = (role: BoardRole, status: BoardStatus) => !can(role, 'edit', status)
