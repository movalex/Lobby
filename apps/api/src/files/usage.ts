// What a workspace stores, and the limits that bound it (FC-1, SEAM-02, SEAM-11).
//
// "Used" storage is what counts toward the quota: uploaded originals, the previews the worker made
// from them, and the boards' dashboard thumbnails. Checkpoint bodies (history, snapshots/...) are also
// kept in the blob store but are NOT counted (they are bounded per board by history's checkpoint
// cap). The upload quota and the storage line in the dashboard read the same numbers. Previews and
// thumbnails are written without a quota check of their own (the worker's previews are bounded per
// original; a thumbnail is at most 256 KB per board and replaces the previous one, and the board cap
// bounds their number), so "used" can go past the quota; the next upload is then refused.

import type { Queryable } from '@draftroom/db'
import { ApiError } from '../errors.ts'

export interface WorkspaceUsage {
  originals: number
  previews: number
  thumbnails: number
  /** originals + previews + thumbnails */
  used: number
  /** Uploaded file versions. */
  files: number
}

/** bigint sums as float8: PGlite and node-postgres map int8 differently (exact up to 2^53). */
export async function workspaceUsage(q: Queryable, workspaceId: string): Promise<WorkspaceUsage> {
  const r = await q.one<{ originals: number; files: number; previews: number; thumbnails: number }>(
    `SELECT
       (SELECT COALESCE(SUM(size_bytes), 0)::float8 FROM asset_versions WHERE workspace_id = $1) AS originals,
       (SELECT count(*)::int FROM asset_versions WHERE workspace_id = $1) AS files,
       (SELECT COALESCE(SUM(d.bytes), 0)::float8
          FROM asset_derivatives d JOIN asset_versions v ON v.id = d.version_id
         WHERE v.workspace_id = $1) AS previews,
       (SELECT COALESCE(SUM(bytes), 0)::float8 FROM board_thumbnails WHERE workspace_id = $1) AS thumbnails`,
    [workspaceId],
  )
  const originals = Number(r.originals)
  const previews = Number(r.previews)
  const thumbnails = Number(r.thumbnails)
  return { originals, previews, thumbnails, used: originals + previews + thumbnails, files: Number(r.files) }
}

/** Originals one person uploaded to a workspace (the per-guest allowance counts these). */
export async function uploaderUsage(
  q: Queryable,
  workspaceId: string,
  userId: string,
): Promise<{ bytes: number; files: number }> {
  const r = await q.one<{ bytes: number; files: number }>(
    `SELECT COALESCE(SUM(size_bytes), 0)::float8 AS bytes, count(*)::int AS files
       FROM asset_versions WHERE workspace_id = $1 AND uploaded_by = $2`,
    [workspaceId, userId],
  )
  return { bytes: Number(r.bytes), files: Number(r.files) }
}

/** Originals all name-only guests (users.kind = 'guest') uploaded to a workspace (the guest pool). */
export async function guestsUsage(
  q: Queryable,
  workspaceId: string,
): Promise<{ bytes: number; files: number }> {
  const r = await q.one<{ bytes: number; files: number }>(
    `SELECT COALESCE(SUM(v.size_bytes), 0)::float8 AS bytes, count(*)::int AS files
       FROM asset_versions v JOIN users u ON u.id = v.uploaded_by AND u.kind = 'guest'
      WHERE v.workspace_id = $1`,
    [workspaceId],
  )
  return { bytes: Number(r.bytes), files: Number(r.files) }
}

/** True for a name-only guest (a user without an account: 0009_guests). */
export async function isNameOnlyGuest(q: Queryable, userId: string): Promise<boolean> {
  const r = await q.maybeOne<{ kind: string }>('SELECT kind FROM users WHERE id = $1', [userId])
  return r?.kind === 'guest'
}

export async function countBoards(q: Queryable, workspaceId: string): Promise<number> {
  const r = await q.one<{ n: number }>('SELECT count(*)::int AS n FROM boards WHERE workspace_id = $1', [
    workspaceId,
  ])
  return Number(r.n)
}

/**
 * SEAM-11: 409 BOARD_LIMIT_REACHED when the workspace already holds `max` boards (every status: a
 * trashed board keeps its canvas, checkpoints and files, and can be restored). It first locks the
 * workspace row (NO KEY: rows that reference the workspace are not blocked), so inside the transaction
 * that inserts the board, two simultaneous creations cannot both take the last place. Outside a
 * transaction (an early check before slow work) the lock ends with the statement.
 */
export async function assertBoardRoom(q: Queryable, workspaceId: string, max: number): Promise<void> {
  await q.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [workspaceId])
  if ((await countBoards(q, workspaceId)) < max) return
  throw new ApiError(
    409,
    'BOARD_LIMIT_REACHED',
    `This workspace has reached its limit of ${max.toLocaleString('en-US')} boards (boards in the trash count too), so a new board can't be made here. Ask a workspace owner for help.`,
  )
}
