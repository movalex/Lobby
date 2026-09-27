// `authorize` for the file routes (apps/api/src/files/deps.ts). The file routes never read sessions or
// ACL tables themselves; they get exactly one answer from here.

import type { Db } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import { loadBoardAccess } from './access.ts'
import type { SessionStore } from './auth/session.ts'
import type { FilesDeps } from './files/deps.ts'

export function createFileAuthorizer(db: Db, sessions: SessionStore): FilesDeps['authorize'] {
  return async (req, boardId, action) => {
    const user = await sessions.user(req)
    if (!user) return { ok: false, status: 401 }
    const access = await loadBoardAccess(db, boardId, user.id)
    // Same rules as the board itself: trashed boards serve nothing, archived boards are read-only.
    if (!access || !can(access.role, 'view', access.board.status)) return { ok: false, status: 404 }
    if (action === 'edit' && !can(access.role, 'edit', access.board.status)) return { ok: false, status: 403 }
    return { ok: true, userId: user.id }
  }
}
