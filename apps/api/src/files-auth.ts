// `authorize` for the file routes (apps/api/src/files/deps.ts). The file routes never read sessions or
// ACL tables themselves; they get exactly one answer from here.
//
// History phase (docs/FEATURES-M2-CONTRACTS.md "history"): a version uploaded to board A
// (asset_versions.board_id = A, packages/db 0007_assets) is also served on board B when B holds a link
// to it (board_asset_links, same workspace). Links are written only when B was made from content that
// could already show the file (restore-as-new, duplicate, import); `linkedAsset` answers that second
// question for the file routes.

import type { Db, Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import { loadBoardAccess } from './access.ts'
import type { SessionStore } from './auth/session.ts'
import type { FileAssetRef, FileAuthorizer } from './files/deps.ts'

export function createFileAuthorizer(db: Db, sessions: SessionStore): FileAuthorizer {
  const authorize: FileAuthorizer = async (req, boardId, action) => {
    const user = await sessions.user(req)
    if (!user) return { ok: false, status: 401 }
    const access = await loadBoardAccess(db, boardId, user.id)
    // Same rules as the board itself: trashed boards serve nothing, archived boards are read-only.
    if (!access || !can(access.role, 'view', access.board.status)) return { ok: false, status: 404 }
    if (action === 'edit' && !can(access.role, 'edit', access.board.status)) return { ok: false, status: 403 }
    return { ok: true, userId: user.id, workspaceId: access.board.workspace_id }
  }
  authorize.linkedAsset = async (req, boardId, asset) => {
    const user = await sessions.user(req)
    if (!user) return false
    const access = await loadBoardAccess(db, boardId, user.id)
    if (!access || !can(access.role, 'view', access.board.status)) return false
    return isAssetLinked(db, access.board.workspace_id, boardId, asset)
  }
  return authorize
}

/**
 * Whether `boardId` holds a link to the asset version, inside `workspaceId`, and the board the file
 * was uploaded to is in that workspace too (defense in depth: links are only written after that check).
 */
export async function isAssetLinked(
  q: Queryable,
  workspaceId: string,
  boardId: string,
  asset: FileAssetRef,
): Promise<boolean> {
  const row = await q.maybeOne(
    `SELECT 1 AS ok
       FROM board_asset_links l
       JOIN boards owner ON owner.id = $5 AND owner.workspace_id = l.workspace_id
      WHERE l.workspace_id = $1 AND l.board_id = $2 AND l.asset_id = $3 AND l.version_id = $4`,
    [workspaceId, boardId, asset.assetId, asset.versionId, asset.ownerBoardId],
  )
  return row !== null
}

/**
 * Every board of the workspace that can show the version: the board it was uploaded to (if it is in
 * this workspace) plus the boards linked to it.
 */
export async function boardsShowingAsset(
  q: Queryable,
  workspaceId: string,
  asset: FileAssetRef,
): Promise<string[]> {
  const rows = await q.query<{ board_id: string }>(
    `SELECT b.id AS board_id FROM boards b WHERE b.id = $4 AND b.workspace_id = $1
     UNION
     SELECT l.board_id FROM board_asset_links l
       JOIN boards owner ON owner.id = $4 AND owner.workspace_id = l.workspace_id
      WHERE l.workspace_id = $1 AND l.asset_id = $2 AND l.version_id = $3`,
    [workspaceId, asset.assetId, asset.versionId, asset.ownerBoardId],
  )
  return rows.rows.map((r) => r.board_id)
}
