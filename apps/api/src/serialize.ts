// Database rows -> @draftroom/contracts response shapes (camelCase, ISO timestamps).

import type { Board, BoardWithRole, Project, User } from '@draftroom/contracts'
import type { BoardRole } from '@draftroom/permissions'
import type { BoardRow } from './access.ts'
import type { SessionUser } from './auth/session.ts'

const iso = (d: Date) => d.toISOString()
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null)

/**
 * `marks`: whether `newCanvas` marks are shown (bridge release R0's badge). False on the new canvas
 * (canvas-engine.ts): a board made there is this build's own. Default true (R0's behaviour).
 */
export interface BoardMarks {
  readonly newCanvas?: boolean
}

export function toBoard(r: BoardRow, marks: BoardMarks = {}): Board {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    title: r.title,
    visibility: r.visibility,
    status: r.status,
    trashedAt: isoOrNull(r.trashed_at),
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    lastOpenedAt: isoOrNull(r.last_opened_at),
    // Bridge release R0: only boards born on the new canvas carry the field (the "new canvas" badge).
    ...(r.new_canvas === true && marks.newCanvas !== false ? { newCanvas: true as const } : {}),
  }
}

export const toBoardWithRole = (r: BoardRow, role: BoardRole, marks: BoardMarks = {}): BoardWithRole => ({
  ...toBoard(r, marks),
  role,
})

export interface UserRow {
  id: string
  name: string
  handle: string | null
  color: string
  avatar_url: string | null
}

export const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  handle: r.handle,
  color: r.color,
  avatarUrl: r.avatar_url,
})

/** Lists the five User fields: SessionUser carries more (domain access), and none of it may leak. */
export const sessionUserToUser = (u: SessionUser): User => ({
  id: u.id,
  name: u.name,
  handle: u.handle,
  color: u.color,
  avatarUrl: u.avatarUrl,
})

export interface ProjectRow {
  id: string
  workspace_id: string
  name: string
  created_at: Date
  archived_at: Date | null
}

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  createdAt: iso(r.created_at),
  archivedAt: isoOrNull(r.archived_at),
})
