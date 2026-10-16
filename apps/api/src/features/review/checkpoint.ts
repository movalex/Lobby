// OWNER: WS1 (wave S, review rounds; docs/WAVE-S-CONTRACTS.md §2.1). Starting a round takes a NAMED MANUAL checkpoint
// of the board, "Review round 2 sent" (contracts reviewRoundCheckpointName; no new checkpoint reason, so nothing in
// CheckpointReason changes), saved like History's "Save checkpoint" (features/history/index.ts): read from the sync
// server's snapshot, its body written to the checkpoint store first, its row inserted with the person who started the
// round as its author, under the same caps (the board's manual count, the byte caps, the workspace's room).
//
// Two halves, because a transaction never waits on the sync server: `readRoundCheckpoint` reads the snapshot and
// writes the body BEFORE the round's transaction; `insertRoundCheckpoint` inserts the row INSIDE it (so a round
// that is refused leaves no checkpoint row, and its body is removed by `discard`). Best effort: a sync server that
// cannot be reached, a board at a cap, or a board this build's sync cannot read leaves the round without one
// (`checkpointId` null), never fails the round.

import { HISTORY_EVENTS } from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import { onNewCanvas } from '../../canvas-engine.ts'
import type { FeatureContext } from '../context.ts'
import { manualCheckpointRefusal } from '../history/checkpoint-caps.ts'
import { MAX_SNAPSHOTS_PER_BOARD } from '../history/index.ts'
import { checkpointBodyOf } from '../history/snapshot-rows.ts'
import { snapshotBodies, snapshotStorageKey } from '../history/snapshot-store.ts'

export interface PreparedCheckpoint {
  id: string
  key: string
  made: ReturnType<typeof checkpointBodyOf>
}

/**
 * The board's snapshot, its body already written. Null when it cannot be taken now (the board keeps no more manual
 * checkpoints, the sync server cannot be reached or cannot read the board): the round then has none.
 */
export async function readRoundCheckpoint(
  ctx: FeatureContext,
  board: { id: string; workspace_id: string; new_canvas: boolean },
): Promise<PreparedCheckpoint | null> {
  try {
    if (board.new_canvas && !(await onNewCanvas(ctx))) return null
    const { n } = await ctx.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM board_snapshots WHERE board_id = $1 AND kind = 'manual'",
      [board.id],
    )
    if (n >= MAX_SNAPSHOTS_PER_BOARD) return null
    const ids = { boardId: board.id, workspaceId: board.workspace_id }
    if (await manualCheckpointRefusal(ctx.db, ids, 0, ctx.config.uploads.workspaceQuotaBytes)) return null
    const snap = await ctx.sync.snapshot(board.id)
    const made = checkpointBodyOf(board.id, snap)
    const id = newId('snp')
    const key = snapshotStorageKey(board.id, id)
    await snapshotBodies(ctx.blobs, ctx.layout.root).write(key, made.json)
    return { id, key, made }
  } catch {
    return null
  }
}

/**
 * Inside the round's transaction, first (the per-workspace advisory lock of History's saves, which no other lock may
 * precede): inserts the checkpoint row named `name` by `actorId`. False when a cap was reached meanwhile (the
 * round then has none; call `discard`).
 */
export async function insertRoundCheckpoint(
  ctx: FeatureContext,
  tx: Queryable,
  board: { id: string; workspace_id: string },
  prepared: PreparedCheckpoint,
  name: string,
  actorId: string,
): Promise<boolean> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `checkpoint-bytes:${board.workspace_id}`,
  ])
  const ids = { boardId: board.id, workspaceId: board.workspace_id }
  const { n } = await tx.one<{ n: number }>(
    "SELECT count(*)::int AS n FROM board_snapshots WHERE board_id = $1 AND kind = 'manual'",
    [board.id],
  )
  if (n >= MAX_SNAPSHOTS_PER_BOARD) return false
  if (await manualCheckpointRefusal(tx, ids, prepared.made.sizeBytes, ctx.config.uploads.workspaceQuotaBytes))
    return false
  const { made } = prepared
  await tx.query(
    `INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, created_by, created_at, document_clock,
                                  record_count, size_bytes, storage_key, content_hash, body_version)
     VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      prepared.id,
      board.workspace_id,
      board.id,
      name,
      actorId,
      ctx.now(),
      made.documentClock,
      made.recordCount,
      made.sizeBytes,
      prepared.key,
      made.contentHash,
      made.body.version,
    ],
  )
  return true
}

/** Removes a written body whose row was not inserted (the round was refused, or a cap was reached). */
export async function discardRoundCheckpoint(ctx: FeatureContext, prepared: PreparedCheckpoint | null) {
  if (!prepared) return
  await snapshotBodies(ctx.blobs, ctx.layout.root)
    .remove(prepared.key)
    .catch(() => {})
}

/** After COMMIT: History's panels refresh, as for any saved checkpoint. */
export function publishRoundCheckpoint(ctx: FeatureContext, boardId: string, snapshotId: string) {
  ctx.events.publish(boardId, { type: HISTORY_EVENTS.snapshot, data: { snapshotId } })
}
