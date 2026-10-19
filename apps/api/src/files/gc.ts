// The collector of uploaded files nothing references any more (UPL-1). Report-first: by default
// (DRAFTROOM_ASSET_GC=report) it only marks and reports; it deletes only with DRAFTROOM_ASSET_GC=delete.
//
// A version counts as REFERENCED while any of these holds (checked per workspace: a board can only show
// files of its own workspace, files-auth.ts):
//   - a board of the workspace shows it: a record on its current canvas, or a shape its "Recently
//     deleted" capture can put back (sync: GET /internal/boards/:bid/asset-refs; every board, archived
//     and trashed ones included);
//   - a checkpoint of the workspace names it (its body, read once: asset_gc_snapshot_refs), or a
//     board_asset_links row does (a board made from content that showed it);
//   - an element library item shows it (library_item_files, wave Q): a deleted item's rows count too until the
//     library's purge removes the item, 30 days after its delete (features/library/purge.ts);
//   - its board is in the trash (a restore brings the board back with its files);
//   - it is in flight: uploaded less than ASSET_GC_IN_FLIGHT_DAYS ago, or its preview job is running;
//   - wave S (0037): a comment thread is pinned to it (an `asset` anchor naming it: the thread shows that version's
//     previews, in the version list and the viewer, whatever version the card shows now; resolved threads too);
//   - wave S: it is part of a CHAIN (versions sharing one asset id, asset_versions.supersedes) any other version of
//     which is referenced by any rule above: a deliverable on a board keeps its whole history (v1 to v3 stay while v4
//     is on the canvas). A chain goes only as a whole: under the version's row lock, a version is kept while any
//     other version of its asset is not itself marked past the grace period (a version uploaded since the pass
//     began is unmarked, so it holds its chain).
// An image or video asset record counts only while a shape uses it (gc-refs.ts explains why).
//
// A pass marks every other version `unreferenced_since = now` and clears the mark of every marked
// version it finds referenced again. A pass that could not read a board or a checkpoint is INCOMPLETE:
// it still clears marks, but marks and deletes nothing new (it never guesses "not referenced").
//
// Deletion (delete mode, complete passes only), for versions unreferenced for ASSET_GC_GRACE_DAYS or
// more: every source is read AGAIN right before (a reference that appeared since the pass started
// keeps the version), then one transaction per version re-checks the database sources under a row
// lock, records the version's object keys in asset_gc_pending_deletes, deletes the rows (derivatives,
// the preview job and reservations cascade) and writes an audit event. The objects are deleted after
// the commit; a failed object delete stays pending and the next delete-mode pass retries it.
//
// Not a reference source: sync's board backups (their manifests list every asset record, so they would
// keep every image ever placed). The newest 12 backups of a board left idle for a long time can predate
// the grace period, so restoring such a backup can show a collected file as missing.

import type {
  AssetGcMode,
  AssetGcReport,
  AssetGcReportEntry,
  AssetGcRun,
  AssetGcSummary,
  StorageAmount,
} from '@draftroom/contracts'
import { ASSET_GC_GRACE_DAYS, ASSET_GC_IN_FLIGHT_DAYS, ASSET_GC_REPORT_LIMIT } from '@draftroom/contracts'
import { type Db, pgErrorCode, type Queryable } from '@draftroom/db'
import { audit } from '../audit.ts'
import { type CanvasEngineProbe, TLDRAW_ONLY } from '../canvas-engine.ts'
import { snapshotBodies } from '../features/history/snapshot-store.ts'
import type { BlobStore } from './blobs.ts'
import { originalKey } from './blobs.ts'
import {
  type CheckpointVersionRef,
  parseBoardRefs,
  UnreadableCheckpointBody,
  type VersionRef,
  versionsInCheckpoint,
} from './gc-refs.ts'

const DAY = 86_400_000

export type GcPassMode = 'report' | 'delete'

export interface AssetGcLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface AssetGcDeps {
  db: Db
  blobs: BlobStore
  /** The sync server's asset-refs endpoint (sync-internal.ts). Absent = no board can be read. */
  sync: { assetRefs?(boardId: string): Promise<unknown> }
  /**
   * Which canvas the sync runs (canvas-engine.ts): on the new canvas a checkpoint marked `body_version` 2
   * is this build's own and is read (its v2 body); otherwise it is R0's "unread". Absent = tldraw.
   */
  canvas?: CanvasEngineProbe
  /** Root of history's pre-milestone-3 checkpoint folder (snapshot-store.ts): the api's data dir. */
  dataRoot: string
  now: () => Date
  log: AssetGcLog
  /** Asked between boards: true stops the pass early, and a stopped pass changes nothing. */
  shouldStop?: () => boolean
}

export interface WorkspacePassResult {
  workspaceId: string
  mode: GcPassMode
  /** false: a board or checkpoint could not be read (or the pass was stopped). */
  complete: boolean
  boardsScanned: number
  boardsFailed: number
  checkpointsFailed: number
  marked: number
  cleared: number
  deleted: StorageAmount
}

interface VersionGcRow {
  id: string
  asset_id: string
  created_at: Date
  unreferenced_since: Date | null
  board_status: string
  job_status: string | null
}

interface References {
  versions: Set<string>
  complete: boolean
  stopped: boolean
  boardsScanned: number
  boardsFailed: number
  checkpointsFailed: number
}

/** Name/message/code only: driver and fetch errors can carry statement parameters or URLs. */
const errInfo = (err: unknown) => {
  const e = err as { name?: unknown; message?: unknown; code?: unknown } | null
  return { name: e?.name, message: e?.message, code: e?.code }
}

const FOREIGN_KEY_VIOLATION = '23503'

/**
 * The refs of a checkpoint with every asset id known: a v2 element may name only its version, whose
 * asset is read from asset_versions (in the workspace). A version that no longer exists needs no keeping.
 */
async function withAssetIds(
  deps: AssetGcDeps,
  workspaceId: string,
  named: readonly CheckpointVersionRef[],
): Promise<VersionRef[]> {
  const out: VersionRef[] = []
  const bare: string[] = []
  for (const r of named) {
    if (r.assetId) out.push({ assetId: r.assetId, versionId: r.versionId })
    else bare.push(r.versionId)
  }
  for (let i = 0; i < bare.length; i += 500) {
    const rows = await deps.db.query<{ id: string; asset_id: string }>(
      'SELECT id, asset_id FROM asset_versions WHERE workspace_id = $1 AND id = ANY($2::text[])',
      [workspaceId, bare.slice(i, i + 500)],
    )
    for (const r of rows.rows) out.push({ assetId: r.asset_id, versionId: r.id })
  }
  return out
}

/**
 * Reads every checkpoint of the workspace that was never read, and records the versions its body
 * names (bodies never change). A body that is gone, or that is not JSON, can restore nothing: it is
 * recorded with no references. A read that fails (the blob store is unreachable) is counted and
 * retried by the next pass.
 *
 * v1 (tldraw) and v2 (the Excalidraw engine) bodies are both read (gc-refs.ts versionsInCheckpoint).
 * Bridge release R0: a checkpoint this build cannot read (a row marked body_version 2 while the sync is a
 * tldraw one, canvas-engine.ts; or a body of neither format) can show files the pass cannot see. It
 * is counted as unread (the pass is incomplete: nothing new is marked or deleted) and NOT recorded,
 * because a recorded scan is never repeated and "no references" would then outlive the roll-forward.
 */
async function scanCheckpoints(deps: AssetGcDeps, workspaceId: string): Promise<number> {
  const pending = await deps.db.query<{ id: string; storage_key: string; body_version: number }>(
    `SELECT s.id, s.storage_key, s.body_version FROM board_snapshots s
      WHERE s.workspace_id = $1
        AND NOT EXISTS (SELECT 1 FROM asset_gc_snapshot_scans c WHERE c.snapshot_id = s.id)
      ORDER BY s.created_at, s.id`,
    [workspaceId],
  )
  const bodies = snapshotBodies(deps.blobs, deps.dataRoot)
  let failed = 0
  const newCanvas = () => {
    failed++
    deps.log.warn(
      { workspaceId },
      'asset gc: a checkpoint made on the new canvas cannot be read by this build (the pass is incomplete)',
    )
  }
  const v2Readable = (await (deps.canvas ?? TLDRAW_ONLY).current()) === 'excalidraw'
  for (const s of pending.rows) {
    if (deps.shouldStop?.()) return failed + 1
    if (Number(s.body_version) !== 1 && !(v2Readable && Number(s.body_version) === 2)) {
      newCanvas()
      continue
    }
    let raw: string | null
    try {
      raw = await bodies.read(s.storage_key)
    } catch (err) {
      failed++
      deps.log.warn({ err: errInfo(err), snapshotId: s.id }, 'asset gc: checkpoint body unreadable')
      continue
    }
    let named: CheckpointVersionRef[] = []
    if (raw !== null) {
      try {
        named = versionsInCheckpoint(raw)
      } catch (err) {
        if (err instanceof UnreadableCheckpointBody) {
          newCanvas()
          continue
        }
        deps.log.warn(
          { snapshotId: s.id },
          'asset gc: checkpoint body is not valid JSON (it restores nothing)',
        )
      }
    }
    let refs: VersionRef[]
    try {
      refs = await withAssetIds(deps, workspaceId, named)
    } catch (err) {
      failed++
      deps.log.warn({ err: errInfo(err), snapshotId: s.id }, 'asset gc: checkpoint refs not resolved')
      continue
    }
    try {
      await deps.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO asset_gc_snapshot_scans (snapshot_id, workspace_id, scanned_at, ref_count)
           VALUES ($1, $2, $3, $4) ON CONFLICT (snapshot_id) DO NOTHING`,
          [s.id, workspaceId, deps.now(), refs.length],
        )
        for (let i = 0; i < refs.length; i += 200) {
          const part = refs.slice(i, i + 200)
          await tx.query(
            `INSERT INTO asset_gc_snapshot_refs (snapshot_id, workspace_id, asset_id, version_id)
             SELECT $1, $2, a, v FROM unnest($3::text[], $4::text[]) AS t(a, v)
             ON CONFLICT DO NOTHING`,
            [s.id, workspaceId, part.map((r) => r.assetId), part.map((r) => r.versionId)],
          )
        }
      })
    } catch (err) {
      // The checkpoint was deleted while we read it: nothing left to record.
      if (pgErrorCode(err) === FOREIGN_KEY_VIOLATION) continue
      failed++
      deps.log.warn({ err: errInfo(err), snapshotId: s.id }, 'asset gc: checkpoint refs not recorded')
    }
  }
  return failed
}

/**
 * Every source of references of one workspace except the version rows' own facts (in flight, trashed
 * board: heldByRow, applied by collectWorkspace).
 */
async function gatherReferences(deps: AssetGcDeps, workspaceId: string): Promise<References> {
  const versions = new Set<string>()
  const add = (rows: { version_id: string }[]) => {
    for (const r of rows) versions.add(r.version_id)
  }
  add(
    (
      await deps.db.query<{ version_id: string }>(
        'SELECT DISTINCT version_id FROM board_asset_links WHERE workspace_id = $1',
        [workspaceId],
      )
    ).rows,
  )
  add(
    (
      await deps.db.query<{ version_id: string }>(
        'SELECT DISTINCT version_id FROM library_item_files WHERE workspace_id = $1',
        [workspaceId],
      )
    ).rows,
  )
  // wave S: the versions comment threads are pinned to (0037's comment_threads_asset_version_idx)
  add(
    (
      await deps.db.query<{ version_id: string }>(
        `SELECT DISTINCT anchor ->> 'versionId' AS version_id FROM comment_threads
          WHERE workspace_id = $1 AND anchor ->> 'kind' = 'asset' AND anchor ->> 'versionId' IS NOT NULL`,
        [workspaceId],
      )
    ).rows,
  )
  const checkpointsFailed = await scanCheckpoints(deps, workspaceId)
  add(
    (
      await deps.db.query<{ version_id: string }>(
        'SELECT DISTINCT version_id FROM asset_gc_snapshot_refs WHERE workspace_id = $1',
        [workspaceId],
      )
    ).rows,
  )
  const boards =
    // an importing board (wave R) has no canvas yet: its versions are held below (heldByRow), not scanned
    (
      await deps.db.query<{ id: string }>(
        `SELECT id FROM boards
        WHERE workspace_id = $1 AND status IN ('active', 'archived', 'trashed') ORDER BY id`,
        [workspaceId],
      )
    ).rows
  let boardsScanned = 0
  let boardsFailed = 0
  let stopped = false
  const read = deps.sync.assetRefs?.bind(deps.sync)
  for (const b of boards) {
    if (deps.shouldStop?.()) {
      stopped = true
      break
    }
    if (!read) {
      boardsFailed++
      continue
    }
    try {
      const refs = parseBoardRefs(await read(b.id), b.id)
      if (!refs) throw new Error('unexpected asset-refs answer')
      for (const r of refs.canvas) versions.add(r.versionId)
      for (const r of refs.deleted) versions.add(r.versionId)
      for (const v of refs.versions) versions.add(v)
      // Bridge release R0: a converted board's new-canvas elements were not read (a tldraw sync's
      // `newCanvasTables: true`). Its refs count (they clear marks), but the board was not read whole, so
      // the pass is incomplete. The Excalidraw sync reads the elements and never says so.
      if (refs.partial) {
        boardsFailed++
        deps.log.warn(
          { boardId: b.id },
          'asset gc: the board also holds new-canvas elements this build does not read (the pass is incomplete)',
        )
        continue
      }
      boardsScanned++
    } catch (err) {
      boardsFailed++
      deps.log.warn({ err: errInfo(err), boardId: b.id }, 'asset gc: board references unreadable')
    }
  }
  return {
    versions,
    complete: !stopped && boardsFailed === 0 && checkpointsFailed === 0,
    stopped,
    boardsScanned,
    boardsFailed,
    checkpointsFailed,
  }
}

/**
 * Keeps a version whatever the other sources say: in flight, its board can still be restored, or its board is still
 * being imported (wave R: the job uploads before the canvas exists; a failed import removes them itself).
 */
const heldByRow = (r: VersionGcRow, inFlightCutoff: number) =>
  r.created_at.getTime() > inFlightCutoff ||
  r.board_status === 'trashed' ||
  r.board_status === 'importing' ||
  r.job_status === 'running'

/**
 * Wave S: the versions to keep, chains whole. `held(r)` says whether a version is referenced on its own; every
 * version of an asset one of whose versions is held is kept too (a deliverable keeps its history). Grouped by asset
 * within the workspace's rows (asset ids never cross a workspace: an upload's chain is checked by the upload).
 */
export function keptWithChains<R extends { id: string; asset_id: string }>(
  rows: readonly R[],
  held: (r: R) => boolean,
): Set<string> {
  const heldAssets = new Set<string>()
  for (const r of rows) if (held(r)) heldAssets.add(r.asset_id)
  return new Set(rows.filter((r) => heldAssets.has(r.asset_id)).map((r) => r.id))
}

/** Retries object deletes of versions an earlier delete-mode pass removed. */
async function retryPendingDeletes(deps: AssetGcDeps, workspaceId: string) {
  const rows = await deps.db.query<{ blob_key: string }>(
    `SELECT blob_key FROM asset_gc_pending_deletes WHERE workspace_id = $1 ORDER BY created_at, blob_key
      LIMIT 2000`,
    [workspaceId],
  )
  await deletePending(
    deps,
    rows.rows.map((r) => r.blob_key),
  )
}

async function deletePending(deps: AssetGcDeps, keys: readonly string[]) {
  for (const key of keys) {
    try {
      await deps.blobs.delete(key)
      await deps.db.query('DELETE FROM asset_gc_pending_deletes WHERE blob_key = $1', [key])
    } catch (err) {
      // Stays pending; the key names ids only, but keys are not logged either.
      deps.log.warn({ err: errInfo(err) }, 'asset gc: object delete failed (will retry)')
      await deps.db
        .query('UPDATE asset_gc_pending_deletes SET attempts = attempts + 1 WHERE blob_key = $1', [key])
        .catch(() => {})
    }
  }
}

/**
 * Deletes one version if, under its row lock, it is still marked since before `graceCutoff`, still out
 * of flight, and no database source names it. Returns the bytes freed (original + previews), or null
 * when it was kept.
 */
async function deleteVersion(
  deps: AssetGcDeps,
  workspaceId: string,
  versionId: string,
  cutoffs: { grace: Date; inFlight: Date },
  at: Date,
): Promise<number | null> {
  const done = await deps.db.transaction(async (tx) => {
    // The preview job's row first, then the version's: the order of the worker routes (claim, complete
    // and retry lock the job, then update the version; worker/jobs.ts). The other way round, deleting
    // a version whose queued job a worker is claiming deadlocks on real Postgres: this delete would
    // hold the version and wait for the job (it cascades), while the claim holds the job and waits for
    // the version. A version without a job (none queued yet) has nothing to take.
    await tx.query('SELECT version_id FROM preview_jobs WHERE version_id = $1 FOR UPDATE', [versionId])
    // Wave W (review m9): the version's worker ops the same way, before the version (the ops routes lock an op, then
    // the version: a render-pages complete takes it FOR UPDATE, a remove-bg complete's new version references it)
    await tx.query('SELECT id FROM worker_ops WHERE source_version_id = $1 FOR UPDATE', [versionId])
    const v = await tx.maybeOne<{
      id: string
      asset_id: string
      board_id: string
      name: string
      kind: string
      size_bytes: number
      unreferenced_since: Date | null
      created_at: Date
    }>(
      `SELECT id, asset_id, board_id, name, kind, size_bytes::float8 AS size_bytes, unreferenced_since, created_at
         FROM asset_versions WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [versionId, workspaceId],
    )
    if (!v?.unreferenced_since || v.unreferenced_since > cutoffs.grace || v.created_at > cutoffs.inFlight)
      return null
    const held = await tx.one<{ held: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM board_asset_links WHERE workspace_id = $1 AND version_id = $2)
           -- a library item's: a save's foreign key holds the version row, so it commits before this lock (seen
           -- here) or waits for it and then finds the version gone (the save refuses it)
           OR EXISTS (SELECT 1 FROM library_item_files WHERE workspace_id = $1 AND version_id = $2)
           OR EXISTS (SELECT 1 FROM asset_gc_snapshot_refs WHERE workspace_id = $1 AND version_id = $2)
           OR EXISTS (SELECT 1 FROM boards WHERE id = $3 AND status IN ('trashed', 'importing'))
           -- wave S: a comment thread pinned to it (a thread insert reads the version FOR SHARE first: WS3)
           OR EXISTS (SELECT 1 FROM comment_threads t WHERE t.workspace_id = $1 AND t.anchor ->> 'kind' = 'asset'
                        AND t.anchor ->> 'versionId' = $2)
           -- wave S: another version of its chain that is not itself marked past the grace period (referenced at
           -- the last pass, uploaded since, or marked too recently): a chain goes only as a whole
           OR EXISTS (SELECT 1 FROM asset_versions o WHERE o.workspace_id = $1 AND o.asset_id = $4 AND o.id <> $2
                        AND (o.unreferenced_since IS NULL OR o.unreferenced_since > $5))
           OR EXISTS (SELECT 1 FROM preview_jobs WHERE version_id = $2 AND status = 'running')
           -- wave W: a worker op running on it (its outputs are being uploaded; the next pass deletes it)
           OR EXISTS (SELECT 1 FROM worker_ops WHERE source_version_id = $2 AND status = 'running')
           -- a checkpoint made since the scan: its body is read by the next pass first
           OR EXISTS (SELECT 1 FROM board_snapshots s WHERE s.workspace_id = $1
                        AND NOT EXISTS (SELECT 1 FROM asset_gc_snapshot_scans c WHERE c.snapshot_id = s.id))
           AS held`,
      [workspaceId, versionId, v.board_id, v.asset_id, cutoffs.grace],
    )
    if (held.held) return null
    const derivatives = await tx.query<{ blob_key: string; bytes: number }>(
      'SELECT blob_key, bytes::float8 AS bytes FROM asset_derivatives WHERE version_id = $1',
      [versionId],
    )
    const reservations = await tx.query<{ blob_key: string }>(
      'SELECT blob_key FROM asset_derivative_reservations WHERE version_id = $1',
      [versionId],
    )
    // wave W (review m9): the outputs its ops reserved and never published (they cascade away with the ops)
    const opOutputs = await tx.query<{ blob_key: string }>(
      `SELECT r.blob_key FROM worker_op_outputs r JOIN worker_ops o ON o.id = r.op_id WHERE o.source_version_id = $1`,
      [versionId],
    )
    const keys = [
      originalKey(v.asset_id, v.id),
      ...derivatives.rows.map((d) => d.blob_key),
      ...reservations.rows.map((d) => d.blob_key),
      ...opOutputs.rows.map((d) => d.blob_key),
    ]
    const bytes = Number(v.size_bytes) + derivatives.rows.reduce((n, d) => n + Number(d.bytes), 0)
    await tx.query(
      `INSERT INTO asset_gc_pending_deletes (blob_key, workspace_id, created_at)
       SELECT k, $2, $3 FROM unnest($1::text[]) AS t(k) ON CONFLICT (blob_key) DO NOTHING`,
      [keys, workspaceId, at],
    )
    await tx.query('DELETE FROM asset_versions WHERE id = $1', [versionId])
    await audit(tx, {
      workspaceId,
      actorId: null,
      action: 'asset.gc_delete',
      target: versionId,
      detail: {
        assetId: v.asset_id,
        boardId: v.board_id,
        name: v.name,
        kind: v.kind,
        bytes,
        unreferencedSince: v.unreferenced_since.toISOString(),
        uploadedAt: v.created_at.toISOString(),
      },
      at,
    })
    return { keys, bytes }
  })
  if (!done) return null
  await deletePending(deps, done.keys)
  return done.bytes
}

async function recordRun(q: Queryable, r: WorkspacePassResult, startedAt: Date, finishedAt: Date) {
  await q.query(
    `INSERT INTO asset_gc_runs (workspace_id, mode, started_at, finished_at, complete, boards_scanned,
       boards_failed, checkpoints_failed, marked, cleared, deleted_versions, deleted_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (workspace_id) DO UPDATE SET mode = EXCLUDED.mode, started_at = EXCLUDED.started_at,
       finished_at = EXCLUDED.finished_at, complete = EXCLUDED.complete,
       boards_scanned = EXCLUDED.boards_scanned, boards_failed = EXCLUDED.boards_failed,
       checkpoints_failed = EXCLUDED.checkpoints_failed, marked = EXCLUDED.marked,
       cleared = EXCLUDED.cleared, deleted_versions = EXCLUDED.deleted_versions,
       deleted_bytes = EXCLUDED.deleted_bytes`,
    [
      r.workspaceId,
      r.mode,
      startedAt,
      finishedAt,
      r.complete,
      r.boardsScanned,
      r.boardsFailed,
      r.checkpointsFailed,
      r.marked,
      r.cleared,
      r.deleted.versions,
      r.deleted.bytes,
    ],
  )
}

/**
 * One pass over one workspace. Returns null when it was stopped (a closing server): a stopped pass
 * leaves every mark as it was and records nothing.
 */
export async function collectWorkspace(
  deps: AssetGcDeps,
  workspaceId: string,
  mode: GcPassMode,
): Promise<WorkspacePassResult | null> {
  const startedAt = deps.now()
  const inFlightCutoff = startedAt.getTime() - ASSET_GC_IN_FLIGHT_DAYS * DAY
  const graceCutoff = startedAt.getTime() - ASSET_GC_GRACE_DAYS * DAY
  if (mode === 'delete') await retryPendingDeletes(deps, workspaceId)

  const rows = (
    await deps.db.query<VersionGcRow>(
      `SELECT v.id, v.asset_id, v.created_at, v.unreferenced_since, b.status AS board_status,
              j.status AS job_status
         FROM asset_versions v
         JOIN boards b ON b.id = v.board_id
         LEFT JOIN preview_jobs j ON j.version_id = v.id
        WHERE v.workspace_id = $1`,
      [workspaceId],
    )
  ).rows
  const refs = await gatherReferences(deps, workspaceId)
  if (refs.stopped) return null
  // wave S: chains whole (keptWithChains): one referenced version keeps every version of its asset
  const kept = keptWithChains(rows, (r) => heldByRow(r, inFlightCutoff) || refs.versions.has(r.id))
  const referenced = (r: VersionGcRow) => kept.has(r.id)

  const toClear = rows.filter((r) => r.unreferenced_since && referenced(r)).map((r) => r.id)
  const toMark = refs.complete
    ? rows.filter((r) => !r.unreferenced_since && !referenced(r)).map((r) => r.id)
    : []
  if (toClear.length)
    await deps.db.query(
      'UPDATE asset_versions SET unreferenced_since = NULL WHERE workspace_id = $1 AND id = ANY($2::text[])',
      [workspaceId, toClear],
    )
  if (toMark.length)
    await deps.db.query(
      `UPDATE asset_versions SET unreferenced_since = $3
        WHERE workspace_id = $1 AND id = ANY($2::text[]) AND unreferenced_since IS NULL`,
      [workspaceId, toMark, startedAt],
    )

  const deleted = { versions: 0, bytes: 0 }
  if (mode === 'delete' && refs.complete) {
    const eligible = rows.filter(
      (r) => r.unreferenced_since && r.unreferenced_since.getTime() <= graceCutoff && !referenced(r),
    )
    if (eligible.length) {
      // Race guard: every source again, now. A reference that appeared since the pass started wins.
      const again = await gatherReferences(deps, workspaceId)
      if (again.stopped) return null
      if (again.complete) {
        const cutoffs = { grace: new Date(graceCutoff), inFlight: new Date(inFlightCutoff) }
        const keptNow = keptWithChains(rows, (r) => heldByRow(r, inFlightCutoff) || again.versions.has(r.id))
        for (const r of eligible) {
          if (keptNow.has(r.id)) {
            await deps.db.query('UPDATE asset_versions SET unreferenced_since = NULL WHERE id = $1', [r.id])
            continue
          }
          const bytes = await deleteVersion(deps, workspaceId, r.id, cutoffs, deps.now())
          if (bytes === null) continue
          deleted.versions++
          deleted.bytes += bytes
        }
      }
    }
  }

  const result: WorkspacePassResult = {
    workspaceId,
    mode,
    complete: refs.complete,
    boardsScanned: refs.boardsScanned,
    boardsFailed: refs.boardsFailed,
    checkpointsFailed: refs.checkpointsFailed,
    marked: toMark.length,
    cleared: toClear.length,
    deleted,
  }
  await recordRun(deps.db, result, startedAt, deps.now())
  deps.log.info(
    {
      workspaceId,
      mode,
      complete: result.complete,
      boardsScanned: result.boardsScanned,
      boardsFailed: result.boardsFailed,
      checkpointsFailed: result.checkpointsFailed,
      marked: result.marked,
      cleared: result.cleared,
      deletedVersions: deleted.versions,
      deletedBytes: deleted.bytes,
    },
    'asset gc: workspace pass',
  )
  return result
}

/** Workspaces a pass has anything to do in: they store files, or objects of theirs await deletion. */
export async function workspacesWithFiles(q: Queryable): Promise<string[]> {
  const rows = await q.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM asset_versions
     UNION SELECT workspace_id FROM asset_gc_pending_deletes
     ORDER BY workspace_id`,
  )
  return rows.rows.map((r) => r.workspace_id)
}

// ---- report ---------------------------------------------------------------------------------------

const amount = (versions: unknown, bytes: unknown): StorageAmount => ({
  versions: Number(versions ?? 0),
  bytes: Number(bytes ?? 0),
})

interface RunRow {
  mode: 'report' | 'delete'
  started_at: Date
  finished_at: Date
  complete: boolean
  boards_scanned: number
  boards_failed: number
  checkpoints_failed: number
  marked: number
  cleared: number
  deleted_versions: number
  deleted_bytes: number
}

const toRun = (r: RunRow): AssetGcRun => ({
  mode: r.mode,
  startedAt: r.started_at.toISOString(),
  finishedAt: r.finished_at.toISOString(),
  complete: r.complete,
  boardsScanned: Number(r.boards_scanned),
  boardsFailed: Number(r.boards_failed),
  checkpointsFailed: Number(r.checkpoints_failed),
  marked: Number(r.marked),
  cleared: Number(r.cleared),
  deleted: amount(r.deleted_versions, r.deleted_bytes),
})

/** Per version: original plus previews (bigint sums as float8, see usage.ts). */
const VERSION_BYTES = `(v.size_bytes + COALESCE((SELECT SUM(d.bytes) FROM asset_derivatives d
                        WHERE d.version_id = v.id), 0))::float8`

export async function gcSummary(
  q: Queryable,
  workspaceId: string,
  mode: AssetGcMode,
  now: Date,
): Promise<AssetGcSummary> {
  const graceCutoff = new Date(now.getTime() - ASSET_GC_GRACE_DAYS * DAY)
  const totals = await q.one<{ n: number; bytes: number; en: number; ebytes: number }>(
    `SELECT count(*)::int AS n, COALESCE(SUM(${VERSION_BYTES}), 0)::float8 AS bytes,
            count(*) FILTER (WHERE v.unreferenced_since <= $2)::int AS en,
            COALESCE(SUM(${VERSION_BYTES}) FILTER (WHERE v.unreferenced_since <= $2), 0)::float8 AS ebytes
       FROM asset_versions v WHERE v.workspace_id = $1 AND v.unreferenced_since IS NOT NULL`,
    [workspaceId, graceCutoff],
  )
  const run = await q.maybeOne<RunRow>(
    `SELECT mode, started_at, finished_at, complete, boards_scanned, boards_failed, checkpoints_failed,
            marked, cleared, deleted_versions, deleted_bytes::float8 AS deleted_bytes
       FROM asset_gc_runs WHERE workspace_id = $1`,
    [workspaceId],
  )
  return {
    mode,
    graceDays: ASSET_GC_GRACE_DAYS,
    inFlightDays: ASSET_GC_IN_FLIGHT_DAYS,
    lastRun: run ? toRun(run) : null,
    unreferenced: amount(totals.n, totals.bytes),
    eligible: amount(totals.en, totals.ebytes),
  }
}

export async function gcReport(
  q: Queryable,
  workspaceId: string,
  mode: AssetGcMode,
  now: Date,
): Promise<AssetGcReport> {
  const summary = await gcSummary(q, workspaceId, mode, now)
  const rows = await q.query<{
    asset_id: string
    id: string
    name: string
    kind: AssetGcReportEntry['kind']
    bytes: number
    board_id: string
    board_title: string
    created_at: Date
    unreferenced_since: Date
  }>(
    `SELECT v.asset_id, v.id, v.name, v.kind, ${VERSION_BYTES} AS bytes, v.board_id, b.title AS board_title,
            v.created_at, v.unreferenced_since
       FROM asset_versions v JOIN boards b ON b.id = v.board_id
      WHERE v.workspace_id = $1 AND v.unreferenced_since IS NOT NULL
      ORDER BY v.unreferenced_since, v.id
      LIMIT ${ASSET_GC_REPORT_LIMIT + 1}`,
    [workspaceId],
  )
  const versions: AssetGcReportEntry[] = rows.rows.slice(0, ASSET_GC_REPORT_LIMIT).map((r) => ({
    assetId: r.asset_id,
    versionId: r.id,
    name: r.name,
    kind: r.kind,
    bytes: Number(r.bytes),
    boardId: r.board_id,
    boardTitle: r.board_title,
    uploadedAt: r.created_at.toISOString(),
    unreferencedSince: r.unreferenced_since.toISOString(),
    eligibleAt: new Date(r.unreferenced_since.getTime() + ASSET_GC_GRACE_DAYS * DAY).toISOString(),
  }))
  return { workspaceId, summary, versions, truncated: rows.rows.length > ASSET_GC_REPORT_LIMIT }
}

// ---- scheduling -------------------------------------------------------------------------------------

export interface AssetGcRunner {
  /**
   * One pass over one workspace in `mode` (a manual check passes 'report'). 'busy' when a pass over
   * that workspace is already running; null when the pass was stopped.
   */
  collect(workspaceId: string, mode: GcPassMode): Promise<WorkspacePassResult | null | 'busy'>
  /** A pass over every workspace that stores files (the timer calls this). */
  collectAll(): Promise<void>
  /** Stops the timer, asks a running pass to stop and waits for it. */
  stop(): Promise<void>
}

/**
 * The periodic collector: the first pass `firstRunDelayMs` after start, then every `intervalMs`
 * (timers unref'd: they never keep the process alive). `mode: 'off'` runs no timer, but a manual
 * report-only check still works.
 */
export function createAssetGc(
  deps: Omit<AssetGcDeps, 'shouldStop'>,
  cfg: { mode: AssetGcMode; intervalMs: number; firstRunDelayMs: number },
): AssetGcRunner & { start(): void } {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const busy = new Set<string>()
  const running = new Set<Promise<unknown>>()
  const full: AssetGcDeps = { ...deps, shouldStop: () => stopped }

  const collect = async (workspaceId: string, mode: GcPassMode) => {
    if (busy.has(workspaceId)) return 'busy' as const
    busy.add(workspaceId)
    const work = collectWorkspace(full, workspaceId, mode)
    running.add(work)
    try {
      return await work
    } finally {
      running.delete(work)
      busy.delete(workspaceId)
    }
  }

  const collectAll = async () => {
    if (cfg.mode === 'off') return
    for (const workspaceId of await workspacesWithFiles(deps.db)) {
      if (stopped) return
      try {
        await collect(workspaceId, cfg.mode)
      } catch (err) {
        deps.log.warn({ err: errInfo(err), workspaceId }, 'asset gc: workspace pass failed')
      }
    }
  }

  const schedule = (ms: number) => {
    if (stopped || cfg.mode === 'off') return
    timer = setTimeout(() => {
      timer = null
      const pass = collectAll()
        .catch((err: unknown) => deps.log.warn({ err: errInfo(err) }, 'asset gc: pass failed'))
        .finally(() => {
          running.delete(pass)
          schedule(cfg.intervalMs)
        })
      running.add(pass)
    }, ms)
    timer.unref?.()
  }

  return {
    start: () => schedule(cfg.firstRunDelayMs),
    collect,
    collectAll,
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      await Promise.allSettled([...running])
    },
  }
}
