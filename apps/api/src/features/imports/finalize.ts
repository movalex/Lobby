// The board an import job builds (wave R; docs/WAVE-R-CONTRACTS.md §2.4). OWNER: the wave R foundation (the lead).
//
//   createImportingBoard  under the guards of createBoardFrom (features/history/new-board.ts): the workspace row first
//                         and the caller's creating role read after it (requireCreatingRoleLocked), a creator
//                         (requireCreator, 'create'), room for a board (assertBoardRoom), the project only when it is
//                         the workspace's. The row is `status = 'importing'`, PRIVATE, with the caller's owner grant,
//                         and nobody can see it (packages/permissions can(), access.ts, every list): its id is never
//                         handed out before activation. Audit `board.import.start`.
//   activateBoard         one transaction: the same guards again (the caller may have stopped being a creator, or a
//                         member, during the import: refused, and the board is discarded), then `active`, the links
//                         to files it shows (board_asset_links), and audit `board.create` with `via`.
//   discardBoard          a failed, cancelled or expired import: its files' blobs are queued for deletion (the asset
//                         collector's pending-delete table, so a failed delete is retried) and the board row deleted
//                         (its versions, jobs and grants cascade); only ever a board still `importing`.
// Sync: the job seeds the board's canvas (POST /internal/boards/:bid/seed) after this row exists. Sync has no route
// to delete a board's file, so a canvas seeded before a failed activation stays an orphan file nobody can open (the
// row is gone and ids are never reused), exactly as createBoardFrom's failed insert after a seed; its id is logged.

import { newBoardId, type Queryable } from '@draftroom/db'
import { requireCreatingRoleLocked } from '../../access.ts'
import { audit } from '../../audit.ts'
import { onNewCanvas } from '../../canvas-engine.ts'
import { ApiError } from '../../errors.ts'
import { deleteQuietly, originalKey } from '../../files/blobs.ts'
import { assertBoardRoom } from '../../files/usage.ts'
import type { FeatureContext } from '../context.ts'

export interface ImportingBoardPlan {
  workspaceId: string
  projectId: string | null
  userId: string
  title: string
  source: 'miro' | 'lobby-backup'
  /** the import row (imb_…) the board belongs to */
  importRowId: string
}

async function guards(tx: Queryable, ctx: FeatureContext, workspaceId: string, userId: string, step: string) {
  await requireCreatingRoleLocked(tx, workspaceId, userId)
  await ctx.identity.requireCreator(tx, userId, 'create', { route: `import:${step}`, by: 'route' })
}

/** Makes the job's invisible board row and records it on the import row. Returns the new board's id. */
export async function createImportingBoard(ctx: FeatureContext, plan: ImportingBoardPlan): Promise<string> {
  const newCanvas = await onNewCanvas(ctx)
  return ctx.db.transaction(async (tx) => {
    await guards(tx, ctx, plan.workspaceId, plan.userId, 'start')
    await assertBoardRoom(tx, plan.workspaceId, ctx.config.storage.maxBoardsPerWorkspace)
    let projectId = plan.projectId
    if (projectId) {
      const p = await tx.maybeOne('SELECT 1 AS ok FROM projects WHERE id = $1 AND workspace_id = $2', [
        projectId,
        plan.workspaceId,
      ])
      if (!p) projectId = null
    }
    const at = ctx.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = newBoardId()
      const row = await tx.maybeOne<{ id: string }>(
        `INSERT INTO boards (id, workspace_id, project_id, title, visibility, status, created_by, created_at,
                             updated_at, new_canvas)
         VALUES ($1, $2, $3, $4, 'private', 'importing', $5, $6, $6, $7) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, plan.workspaceId, projectId, plan.title, plan.userId, at, newCanvas],
      )
      if (!row) continue
      await tx.query(
        "INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $2, $3)",
        [id, plan.userId, at],
      )
      await tx.query('UPDATE board_imports SET board_id = $2, updated_at = $3 WHERE id = $1', [
        plan.importRowId,
        id,
        at,
      ])
      await audit(tx, {
        workspaceId: plan.workspaceId,
        actorId: plan.userId,
        action: 'board.import.start',
        target: id,
        detail: { source: plan.source, importRowId: plan.importRowId },
        at,
      })
      return id
    }
    throw new ApiError(503, 'SYNC_CONFLICT', 'Could not create the board. Try again.')
  })
}

export interface Activation {
  workspaceId: string
  userId: string
  boardId: string
  source: 'miro' | 'lobby-backup'
  /** versions of OTHER boards the new board shows (a backup restore links none: its files are its own) */
  links?: readonly { assetId: string; versionId: string }[]
  /** counts for the audit row (never names or content) */
  counts?: Readonly<Record<string, number>>
}

/** Makes the board visible, or refuses (ApiError) and leaves it importing for discardBoard. */
export async function activateBoard(ctx: FeatureContext, a: Activation): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await guards(tx, ctx, a.workspaceId, a.userId, 'activate')
    const at = ctx.now()
    const r = await tx.query(
      `UPDATE boards SET status = 'active', updated_at = $3
        WHERE id = $1 AND workspace_id = $2 AND status = 'importing'`,
      [a.boardId, a.workspaceId, at],
    )
    if (r.rowCount !== 1) throw new ApiError(409, 'IMPORT_WRONG_STATE', 'This import can no longer finish.')
    for (const l of a.links ?? [])
      await tx.query(
        `INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [a.workspaceId, a.boardId, l.assetId, l.versionId, at],
      )
    await audit(tx, {
      workspaceId: a.workspaceId,
      actorId: a.userId,
      action: 'board.create',
      target: a.boardId,
      detail: { via: a.source === 'miro' ? 'miro' : 'backup', ...(a.counts ?? {}) },
      at,
    })
  })
}

/**
 * Removes an importing board and its files (never an active one). Returns false when there was nothing to remove.
 * Blob deletes that fail stay queued in asset_gc_pending_deletes (the collector retries them); keys are not logged.
 */
export async function discardBoard(
  ctx: FeatureContext,
  boardId: string,
  why: { actorId: string | null; reason: string },
): Promise<boolean> {
  const done = await ctx.db.transaction(async (tx) => {
    const board = await tx.maybeOne<{ workspace_id: string }>(
      "SELECT workspace_id FROM boards WHERE id = $1 AND status = 'importing' FOR UPDATE",
      [boardId],
    )
    if (!board) return null
    // the asset collector's order: preview jobs before their versions (files/gc.ts deleteVersion)
    await tx.query(
      `SELECT j.version_id FROM preview_jobs j JOIN asset_versions v ON v.id = j.version_id
        WHERE v.board_id = $1 FOR UPDATE OF j`,
      [boardId],
    )
    const versions = await tx.query<{ id: string; asset_id: string }>(
      'SELECT id, asset_id FROM asset_versions WHERE board_id = $1 FOR UPDATE',
      [boardId],
    )
    const ids = versions.rows.map((v) => v.id)
    // wave W (review m9): and the unpublished outputs of the worker ops that go with the board or its versions
    const derived = await tx.query<{ blob_key: string }>(
      `SELECT blob_key FROM asset_derivatives WHERE version_id = ANY($1::text[])
       UNION SELECT blob_key FROM asset_derivative_reservations WHERE version_id = ANY($1::text[])
       UNION SELECT r.blob_key FROM worker_op_outputs r JOIN worker_ops o ON o.id = r.op_id
              WHERE o.board_id = $2 OR o.source_version_id = ANY($1::text[])`,
      [ids, boardId],
    )
    const keys = [
      ...versions.rows.map((v) => originalKey(v.asset_id, v.id)),
      ...derived.rows.map((d) => d.blob_key),
    ]
    const at = ctx.now()
    if (keys.length)
      await tx.query(
        `INSERT INTO asset_gc_pending_deletes (blob_key, workspace_id, created_at)
         SELECT k, $2, $3 FROM unnest($1::text[]) AS t(k) ON CONFLICT (blob_key) DO NOTHING`,
        [keys, board.workspace_id, at],
      )
    await tx.query("DELETE FROM boards WHERE id = $1 AND status = 'importing'", [boardId])
    await audit(tx, {
      workspaceId: board.workspace_id,
      actorId: why.actorId,
      action: 'board.import.discard',
      target: boardId,
      detail: { reason: why.reason, files: versions.rows.length },
      at,
    })
    return keys
  })
  if (!done) return false
  const failed = new Set<string>()
  await deleteQuietly(ctx.blobs, done, (key) => failed.add(key))
  const deleted = done.filter((k) => !failed.has(k))
  if (deleted.length)
    await ctx.db.query('DELETE FROM asset_gc_pending_deletes WHERE blob_key = ANY($1::text[])', [deleted])
  return true
}
