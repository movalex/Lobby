// Wave W follow-up (review nit 2, left open): finished worker ops do not stay forever. A sweep deletes the rows of ops
// that finished (done, failed or cancelled) more than OP_RETENTION.keepMs ago, a bounded batch at a time, and their
// worker_op_outputs rows with them (the foreign key cascades).
//
// What it keeps: the rows that keep a file out of the extract-text backfill (search/file-backfill.ts
// extractTextHoldsSql) while the file has no file_text_state row, i.e. an extract-text op that failed for good
// (FILE_TOO_COMPLEX, TEXT_EXTRACT_FAILED, ...: every code but WORKER_UNAVAILABLE) or one done without a state. Purging
// those would make the backfill queue the file again, and fail it again, every sweep. A done extract-text op whose text
// state exists, any remove-bg or render-pages op, a cancelled op and one failed WORKER_UNAVAILABLE go: nothing reads a
// finished one after a few hours (the request windows count the last day; a person's op state is read while its
// dialog is open).
//
// Blobs: a finished op has no outputs left (complete, fail, expiry and the claim's cancel all drop them), so normally
// there is nothing to do. One that is left over is handed to the file collector's queue (asset_gc_pending_deletes)
// unless a row still uses its key: a derivative, a derivative reservation, or (remove-bg) the version it made.
// Nothing is deleted from the blob store here, and no blob a row references is ever queued.
//
// Locks: the op rows FOR UPDATE SKIP LOCKED (the file collector locks a version's ops first: it is never waited for).

import type { Db } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { extractTextHoldsSql } from '../features/search/file-backfill.ts'

/** Tests lower these before creating the app. */
export const OP_RETENTION = {
  /** finished ops older than this go (30 days) */
  keepMs: 30 * 24 * 60 * 60 * 1000,
  /** rows per sweep */
  batch: 500,
  everyMs: 6 * 60 * 60 * 1000,
  firstAfterMs: 10 * 60 * 1000,
}

export interface OpPurgeResult {
  /** worker_ops rows deleted */
  ops: number
  /** left-over output blobs handed to the file collector */
  blobsQueued: number
}

/** One sweep (see the top of this file). */
export async function purgeFinishedOps(
  db: Db,
  now: Date,
  opts: { keepMs?: number; batch?: number } = {},
): Promise<OpPurgeResult> {
  const cutoff = new Date(now.getTime() - (opts.keepMs ?? OP_RETENTION.keepMs))
  return db.transaction(async (tx) => {
    const due = await tx.query<{ id: string }>(
      `SELECT o.id FROM worker_ops o
        WHERE o.status IN ('done', 'failed', 'cancelled') AND o.finished_at < $1
          AND NOT (${extractTextHoldsSql('o')}
                   AND NOT EXISTS (SELECT 1 FROM file_text_state s WHERE s.version_id = o.source_version_id))
        ORDER BY o.finished_at, o.id
        LIMIT $2
          FOR UPDATE OF o SKIP LOCKED`,
      [cutoff, opts.batch ?? OP_RETENTION.batch],
    )
    const ids = due.rows.map((r) => r.id)
    if (!ids.length) return { ops: 0, blobsQueued: 0 }
    const queued = await tx.query(
      `INSERT INTO asset_gc_pending_deletes (blob_key, workspace_id, created_at)
       SELECT r.blob_key, o.workspace_id, $2
         FROM worker_op_outputs r JOIN worker_ops o ON o.id = r.op_id
        WHERE r.op_id = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM asset_derivatives d WHERE d.blob_key = r.blob_key)
          AND NOT EXISTS (SELECT 1 FROM asset_derivative_reservations x WHERE x.blob_key = r.blob_key)
          AND NOT (r.role = 'original' AND EXISTS (SELECT 1 FROM asset_versions v WHERE v.id = r.version_id))
       ON CONFLICT (blob_key) DO NOTHING`,
      [ids, now],
    )
    const gone = await tx.query('DELETE FROM worker_ops WHERE id = ANY($1::text[])', [ids])
    return { ops: gone.rowCount, blobsQueued: queued.rowCount }
  })
}

/** Runs purgeFinishedOps on a timer while the app runs; a failed sweep is logged (a count, never a row). */
export function startOpRetention(app: FastifyInstance, deps: { db: Db; now: () => Date }): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let running: Promise<unknown> | null = null
  const schedule = (ms: number) => {
    if (stopped) return
    timer = setTimeout(() => {
      timer = null
      running = purgeFinishedOps(deps.db, deps.now())
        .then((r) => {
          if (r.ops)
            app.log.info(
              { evt: 'worker_ops.purged', ops: r.ops, blobs: r.blobsQueued },
              'old worker ops purged',
            )
        })
        .catch((e: unknown) => {
          const err = e as { name?: unknown; message?: unknown } | null
          app.log.warn({ err: { name: err?.name, message: err?.message } }, 'worker ops retention failed')
        })
        .finally(() => {
          running = null
          schedule(OP_RETENTION.everyMs)
        })
    }, ms)
    timer.unref?.()
  }
  app.addHook('onReady', async () => {
    stopped = false
    schedule(OP_RETENTION.firstAfterMs)
  })
  app.addHook('onClose', async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    await running
  })
}
