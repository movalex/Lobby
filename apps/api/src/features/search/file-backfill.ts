// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): the extract-text ops the api enqueues (no requester: nobody gets a
// `file.op` event; the text simply becomes searchable).
//
// - On ready: when a `pdf`-kind version (a PDF or an Office document, by its confirmed type: FILE_TEXT_MIME_TYPES)
//   becomes `ready`, one op is queued for it (the `assets.version` path in app.ts calls enqueueFileText).
// - The backfill: every FILE_TEXT_LIMITS.backfillEveryMs, at most backfillPerSweep versions, newest first, that have no
//   file_text_state row, no active op and no op that failed for good (WORKER_UNAVAILABLE is not for good: no capable
//   worker was there, so they are tried again; FILE_TOO_COMPLEX is). Paused while preview jobs queue (previews keep
//   priority), while no capable worker was seen recently (formatsOffer: it would only queue ops that expire), while an
//   op a person asked for is queued, and up to backfillMaxQueued queued extract-text ops in all (review M2: it never
//   builds a backlog; requested ops are claimed first anyway, worker/ops-jobs.ts claimOp). It also clears the pages an
//   op left behind without a state (a run that failed after some `/text` batches), a bounded batch per sweep.
// Both only while DRAFTROOM_FILE_SEARCH is on (each checks formatsOn), and only for versions whose own board is open
// (an op belongs to its version's board, and the claim cancels it on a trashed one). The one-active-op rule
// (worker_ops_active_idx) keeps two enqueues of one version from making two ops.

import { FILE_TEXT_LIMITS } from '@draftroom/contracts'
import { type Db, newId, type Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import type { FeatureContext } from '../context.ts'
import { formatsOn } from '../formats/switch.ts'
import { FILE_TEXT_MIME_TYPES } from './file-text.ts'

/** Tests lower these before creating the app (like searchSettings). */
export const fileTextBackfillSettings = {
  everyMs: FILE_TEXT_LIMITS.backfillEveryMs as number,
  firstAfterMs: 60_000,
}

/** The op's params: every page the contract allows. */
const PARAMS = JSON.stringify({ maxPages: FILE_TEXT_LIMITS.maxPages })
/** Orphaned pages' versions cleared per sweep. */
const ORPHAN_BATCH = 20

/** The versions (of `candidates`, or every version when null) that may get an extract-text op now. */
const ELIGIBLE = `
  FROM asset_versions v
  JOIN boards b ON b.workspace_id = v.workspace_id AND b.id = v.board_id AND b.status IN ('active', 'archived')
 WHERE v.kind = 'pdf' AND v.status = 'ready' AND v.mime_type = ANY($1::text[])
   AND NOT EXISTS (SELECT 1 FROM file_text_state s WHERE s.version_id = v.id)
   AND NOT EXISTS (SELECT 1 FROM worker_ops o
                    WHERE o.kind = 'extract-text' AND o.source_version_id = v.id
                      AND (o.status IN ('queued', 'running', 'done')
                        OR (o.status = 'failed' AND o.error_code <> 'WORKER_UNAVAILABLE')))`

async function insertOps(
  q: Queryable,
  rows: readonly { id: string; workspace_id: string; board_id: string }[],
  now: Date,
): Promise<number> {
  let made = 0
  for (const v of rows) {
    const r = await q.query(
      `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, params, params_key, requested_by,
                               run_after, created_at, updated_at)
       VALUES ($1, $2, $3, 'extract-text', $4, $5::jsonb, '-', NULL, $6, $6, $6)
       ON CONFLICT (kind, source_version_id, params_key) WHERE status IN ('queued', 'running') DO NOTHING`,
      [newId('wop'), v.workspace_id, v.board_id, v.id, PARAMS, now],
    )
    made += r.rowCount
  }
  return made
}

/**
 * Queues the version's extract-text op when it may have one (see ELIGIBLE); returns whether one was made. Only while
 * file search is on and a capable worker was seen recently (else the backfill picks it up once one is).
 */
export async function enqueueFileText(
  ctx: Pick<FeatureContext, 'db' | 'config' | 'formatsOffer'>,
  versionId: string,
  now: Date,
): Promise<boolean> {
  if (!formatsOn(ctx, 'fileSearch')) return false
  if (!(await ctx.formatsOffer()).fileSearch) return false
  const rows = await ctx.db.query<{ id: string; workspace_id: string; board_id: string }>(
    `SELECT v.id, v.workspace_id, v.board_id ${ELIGIBLE} AND v.id = $2`,
    [FILE_TEXT_MIME_TYPES, versionId],
  )
  return (await insertOps(ctx.db, rows.rows, now)) > 0
}

export interface BackfillResult {
  queued: number
  orphansCleared: number
  /**
   * why nothing was queued: no capable worker, previews waiting, an op a person asked for waiting, or
   * FILE_TEXT_LIMITS.backfillMaxQueued extract-text ops queued already
   */
  paused: 'no-worker' | 'previews' | 'requests' | 'backlog' | null
}

/** One backfill sweep (see the top of this file). */
export async function backfillFileText(
  ctx: Pick<FeatureContext, 'db' | 'config' | 'formatsOffer'>,
  now: Date,
): Promise<BackfillResult> {
  const out: BackfillResult = { queued: 0, orphansCleared: 0, paused: null }
  if (!formatsOn(ctx, 'fileSearch')) return out
  out.orphansCleared = await clearOrphans(ctx.db)
  if (!(await ctx.formatsOffer()).fileSearch) {
    out.paused = 'no-worker'
    return out
  }
  const waiting = await ctx.db.maybeOne("SELECT 1 AS x FROM preview_jobs WHERE status = 'queued' LIMIT 1")
  if (waiting) {
    out.paused = 'previews'
    return out
  }
  // review M2: the backfill never builds a backlog in front of people's requests. Nothing while an op a person asked
  // for is queued; otherwise only up to FILE_TEXT_LIMITS.backfillMaxQueued queued extract-text ops in all.
  const queue = await ctx.db.one<{ asked: boolean; text: number }>(
    `SELECT EXISTS (SELECT 1 FROM worker_ops WHERE status = 'queued' AND requested_by IS NOT NULL) AS asked,
            (SELECT count(*)::int FROM worker_ops WHERE status = 'queued' AND kind = 'extract-text') AS text`,
  )
  if (queue.asked) {
    out.paused = 'requests'
    return out
  }
  const room = Math.min(FILE_TEXT_LIMITS.backfillPerSweep, FILE_TEXT_LIMITS.backfillMaxQueued - queue.text)
  if (room <= 0) {
    out.paused = 'backlog'
    return out
  }
  const rows = await ctx.db.query<{ id: string; workspace_id: string; board_id: string }>(
    `SELECT v.id, v.workspace_id, v.board_id ${ELIGIBLE}
      ORDER BY v.created_at DESC, v.id DESC
      LIMIT $2`,
    [FILE_TEXT_MIME_TYPES, room],
  )
  out.queued = await insertOps(ctx.db, rows.rows, now)
  return out
}

/** Pages of versions with no state and no active op (a run that stored some pages, then failed for good). */
async function clearOrphans(db: Db): Promise<number> {
  const r = await db.query(
    `DELETE FROM file_text_pages WHERE version_id IN (
       SELECT DISTINCT p.version_id FROM file_text_pages p
        WHERE NOT EXISTS (SELECT 1 FROM file_text_state s WHERE s.version_id = p.version_id)
          AND NOT EXISTS (SELECT 1 FROM worker_ops o
                           WHERE o.kind = 'extract-text' AND o.source_version_id = p.version_id
                             AND o.status IN ('queued', 'running'))
        LIMIT ${ORPHAN_BATCH})`,
  )
  return r.rowCount
}

/** Runs the backfill on a timer while the app runs (file search on); a failed sweep is logged and tried next time. */
export function startFileTextBackfill(app: FastifyInstance, ctx: FeatureContext): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let running: Promise<unknown> | null = null
  const schedule = (ms: number) => {
    if (stopped) return
    timer = setTimeout(() => {
      timer = null
      running = backfillFileText(ctx, ctx.now())
        .catch((e: unknown) => {
          const err = e as { name?: unknown; message?: unknown } | null
          app.log.warn({ err: { name: err?.name, message: err?.message } }, 'file text backfill failed')
        })
        .finally(() => {
          running = null
          schedule(fileTextBackfillSettings.everyMs)
        })
    }, ms)
    timer.unref?.()
  }
  app.addHook('onReady', async () => {
    stopped = false
    schedule(fileTextBackfillSettings.firstAfterMs)
  })
  app.addHook('onClose', async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    await running
  })
}
