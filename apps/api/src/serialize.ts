// Database rows -> @draftroom/contracts response shapes (camelCase, ISO timestamps).

import type { Board, BoardWithRole, Project, User } from '@draftroom/contracts'
import type { BoardRole } from '@draftroom/permissions'
import type { BoardRow } from './access.ts'
import type { SessionUser } from './auth/session.ts'

const iso = (d: Date) => d.toISOString()
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null)

export function toBoard(r: BoardRow): Board {
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
  }
}

export const toBoardWithRole = (r: BoardRow, role: BoardRole): BoardWithRole => ({ ...toBoard(r), role })

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

export const sessionUserToUser = (u: SessionUser): User => ({ ...u })

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
