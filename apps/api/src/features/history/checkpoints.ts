// Automatic checkpoints and retention (docs/WAVE4-CONTRACTS.md checkpoints-2; REV-10).
//
// What makes one (kind `auto`, a `reason` on the row):
//   hourly          the board changed and its first unsaved change is an hour old, at most one an hour.
//                   Changes arrive through the sync server's edit reports (apps/sync/src/touch.ts ->
//                   GET /internal/boards/:bid/touched), which checkpoint-routes.ts listens to.
//   session_end     the last editor left after changes (apps/sync/src/session-end.ts ->
//                   GET /internal/boards/:bid/session-ended); at least `sessionEndGapMs` after the
//                   board's previous automatic checkpoint, so reloading a tab does not make a series.
//   before_restore  a checkpoint of the board is about to be restored as a new board (index.ts).
//   import          the board as imported, before anyone edited it (index.ts).
//   before_reveal   a private brainstorm's notes are about to be put on the board, and
//   before_ai_themes  AI "Group into themes" is about to rearrange notes: other features ask for these
//                   through before-change.ts (R10).
//   engine_migration  the cut-over's restore point of a board converted to the new canvas, once per board
//                   (captureEngineMigration; the run in checkpoint-all.ts; plan §5.5, migration 0022).
//
// Every one is read from the sync server's snapshot (a read of the room's storage: editing never
// waits for it) and is skipped when its content equals the board's newest tldraw (v1) checkpoint of
// any kind (content hash, snapshot-rows.ts). Work on one board is serialized in this process; a claim column
// keeps two api instances apart. A sync server that cannot be reached is retried with a backoff.
//
// Retention (retention.ts) runs after every automatic checkpoint of a board and over all boards every
// `pruneEveryMs`. A deleted checkpoint's row goes first, together with an entry in
// board_snapshot_blob_deletions (same transaction); the stored body is deleted afterwards and the entry
// removed, so a failed blob delete is retried by the next pass instead of leaking.

import {
  AUTO_CHECKPOINT_INTERVAL_MS,
  type BoardCheckpoint,
  CHECKPOINT_EVENTS,
  type CheckpointReason,
  HISTORY_EVENTS,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { audit } from '../../audit.ts'
import { isObject } from '../../canvas/lobby-elements.ts'
import { onNewCanvas } from '../../canvas-engine.ts'
import { SyncNewCanvasBoard } from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'
import { boardCheckpointBytes, checkpointByteCaps } from './checkpoint-caps.ts'
import { planRetention, type RetentionPolicy, SAFETY_REASONS } from './retention.ts'
import {
  checkpointBodyOf,
  SNAPSHOT_COLUMNS,
  SNAPSHOT_FROM,
  type SnapshotRow,
  toCheckpoint,
} from './snapshot-rows.ts'
import { type SnapshotBodies, snapshotStorageKey } from './snapshot-store.ts'

const MINUTE = 60_000

export interface CheckpointSettings {
  /** How often the scheduler looks for due boards (0: no timer; tests call runDue themselves). */
  tickMs: number
  /** How often every board's automatic checkpoints are thinned out (0: never on a timer). */
  pruneEveryMs: number
  /** At most one hourly checkpoint per this interval, once the first unsaved change is this old. */
  hourlyMs: number
  /** A session_end checkpoint waits until this long after the board's previous automatic one. */
  sessionEndGapMs: number
  /** How long a claimed board stays with the instance that claimed it. */
  claimMs: number
  /**
   * Failed attempts in a row before a pending checkpoint is given up (the next change starts over).
   * The backoff tops out at 30 min, so the default of 100 keeps trying for about two days: an outage
   * of the sync server or the blob store (a NAS reboot, a deploy) must not drop the checkpoint of a
   * board that nobody edits again afterwards.
   */
  maxFailures: number
  /** Boards handled per scheduler pass (one after the other). */
  batch: number
  /**
   * Automatic checkpoints kept per board at most, whatever retention says (a guard against bugs).
   * Checkpoints made before a restore or at an import stop at 80% of it: restores, which any workspace
   * member who can view the board may run, must never use up the room that hourly and session-end
   * checkpoints need.
   */
  maxAutoPerBoard: number
  retention?: RetentionPolicy
}

/**
 * Read when an app is built (like guestSweepSettings): tests that drive the scheduler themselves set
 * `tickMs` / `pruneEveryMs` to 0 first.
 */
export const checkpointSettings: CheckpointSettings = {
  tickMs: MINUTE,
  pruneEveryMs: 6 * 60 * MINUTE,
  hourlyMs: AUTO_CHECKPOINT_INTERVAL_MS,
  sessionEndGapMs: 10 * MINUTE,
  claimMs: 5 * MINUTE,
  maxFailures: 100,
  batch: 10,
  maxAutoPerBoard: 1_000,
}

export type CaptureOutcome =
  | { status: 'saved'; checkpoint: BoardCheckpoint }
  | { status: 'unchanged' }
  /** new-canvas (bridge release R0): the board was made on the new canvas; this build cannot read it. */
  | { status: 'skipped'; why: 'missing' | 'trashed' | 'limit' | 'new-canvas' }

/**
 * captureNamed (bridge release R0, checkpoint-all.ts): a named manual checkpoint the operator saves
 * (no author). `unchanged`: the board's newest tldraw checkpoint is already this one (same name, no
 * author, same content and document clock), which is returned.
 */
export type NamedCaptureOutcome =
  | { status: 'saved'; checkpoint: BoardCheckpoint }
  | { status: 'unchanged'; checkpoint: BoardCheckpoint }
  | { status: 'skipped'; why: 'missing' | 'new-canvas' }

/**
 * captureEngineMigration (the cut-over's restore point per converted board, docs/EXCALIDRAW-MIGRATION.md
 * §5.5, migration 0022; checkpoint-all.ts): one automatic `engine_migration` checkpoint of the board as
 * its conversion left it (a v2 body). `unchanged`: the board already has one, which is returned (a run
 * repeated, even after an edit, saves nothing: the restore point is the board's first state on the new
 * canvas). Skipped: `new-canvas`, a board born on the new canvas (nothing of it was converted);
 * `tldraw`, a board whose snapshot is still a tldraw one (this api's sync is not the Excalidraw build);
 * `not-converted`, a v2 board whose document carries no conversion record (`lb_doc.import`: a board
 * that had no file before the move, so nothing was converted); `limit`, as capture(); `missing`.
 */
export type MigrationCaptureOutcome =
  | { status: 'saved'; checkpoint: BoardCheckpoint }
  | { status: 'unchanged'; checkpoint: BoardCheckpoint }
  | { status: 'skipped'; why: 'missing' | 'new-canvas' | 'tldraw' | 'not-converted' | 'limit' }

/** What an automatic checkpoint was made before, in its name (R2-09: two of the same reason can be told apart). */
export interface CheckpointAbout {
  /** before_restore: the name of the checkpoint that was restored. */
  restoredName?: string
  /**
   * before_restore of an "Undo restore" (W7, restore-elements.ts): its checkpoint is named for that, not after the
   * checkpoint it restores from (a 'before_restore' one itself: the names would nest).
   */
  undoingRestore?: boolean
  /** before_reveal: the private brainstorm's prompt. */
  prompt?: string
  /** before_ai_themes: how many notes AI grouped, and the frame they are in when there is one. */
  notes?: number
  frame?: string
}

/** A name part on one line, cut to `max` characters (whole code points) with an ellipsis. */
function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const chars = [...one]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : one
}

/** Names shown for automatic checkpoints (the UI labels them by reason too). */
export function autoCheckpointName(reason: CheckpointReason, about: CheckpointAbout = {}): string {
  switch (reason) {
    case 'hourly':
      return 'Hourly checkpoint'
    case 'session_end':
      return 'After an editing session'
    case 'import':
      return 'As imported'
    case 'before_reveal': {
      const prompt = about.prompt ? clip(about.prompt, 72) : ''
      return prompt ? `Before revealing private notes: “${prompt}”` : 'Before revealing private notes'
    }
    case 'before_ai_themes': {
      const n = about.notes && about.notes > 0 ? about.notes : 0
      const what = n ? `${n} ${n === 1 ? 'note' : 'notes'}` : 'notes'
      const frame = about.frame ? clip(about.frame, 60) : ''
      return frame ? `Before AI grouped ${what} in ${frame}` : `Before AI grouped ${what} into themes`
    }
    case 'before_restore': {
      if (about.undoingRestore) return 'Before undoing a restore'
      if (!about.restoredName) return 'Before a restore'
      const name = about.restoredName.length > 90 ? `${about.restoredName.slice(0, 89)}…` : about.restoredName
      return `Before restoring “${name}”`
    }
    // Bridge release R0: only the Excalidraw build makes these (right after converting a board).
    case 'engine_migration':
      return 'Moved to the new canvas'
  }
}

export interface CheckpointService {
  /** Saves an automatic checkpoint of the board now, unless its content is unchanged. Throws SyncUnavailable. */
  capture(boardId: string, reason: CheckpointReason, opts?: CheckpointAbout): Promise<CaptureOutcome>
  /**
   * Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §7.5 step 4, checkpoint-all.ts): saves a MANUAL
   * checkpoint named `name` with no author (the operator's, not a person's), read from the sync
   * snapshot like any checkpoint. Manual, so retention never removes it. Nothing is saved when the
   * board's newest tldraw checkpoint is already the same one (same name, no author, same content and
   * document clock): a repeated call saves nothing twice. A board made on the new canvas, or gone, is skipped. Throws
   * SyncUnavailable.
   */
  captureNamed(boardId: string, name: string): Promise<NamedCaptureOutcome>
  /**
   * The cut-over's restore point (docs/EXCALIDRAW-MIGRATION.md §5.5, runbook step C12; checkpoint-all.ts):
   * one automatic `engine_migration` checkpoint of a converted board, body_version 2, saved once per
   * board (MigrationCaptureOutcome). Read from the sync snapshot like any checkpoint. Throws SyncUnavailable.
   */
  captureEngineMigration(boardId: string): Promise<MigrationCaptureOutcome>
  /** capture() that logs instead of throwing (before risky operations: they must not fail because of it). */
  captureQuietly(
    boardId: string,
    reason: CheckpointReason,
    opts?: CheckpointAbout,
  ): Promise<CaptureOutcome | null>
  /** The sync server reported a canvas change at `at`. */
  changed(boardId: string, at: Date): Promise<void>
  /** The last editor left the board after changes, at `at`; wakes the scheduler. */
  sessionEnded(boardId: string, at: Date): Promise<void>
  /** One scheduler pass: saves the checkpoints that are due. Returns how many boards it handled. */
  runDue(): Promise<number>
  /** Applies retention to one board; returns the ids it deleted. */
  prune(boardId: string): Promise<string[]>
  /** Applies retention to every board with automatic checkpoints, then retries pending blob deletes. */
  pruneAll(): Promise<number>
  /** Deletes checkpoint rows (ids of `boardId`) and their bodies; `audit` records who did it. */
  remove(
    boardId: string,
    ids: readonly string[],
    opts: { onlyAuto: boolean; audit?: { actorId: string } },
  ): Promise<SnapshotRow[]>
  /** Retries the blob deletes still queued. Returns how many were done. */
  drainBlobDeletions(): Promise<number>
  /** Runs a scheduler pass soon (never concurrently with another). */
  poke(): void
  /** Resolves once no scheduler pass is running (tests). */
  idle(): Promise<void>
}

interface StateRow {
  workspace_id: string
  session_ended_at: Date | null
  failures: number
}

export function createCheckpointService(
  ctx: FeatureContext,
  bodies: SnapshotBodies,
  log: { warn(msg: string): void; info(msg: string): void },
  settings: CheckpointSettings = { ...checkpointSettings },
): CheckpointService {
  const { db, now } = ctx

  // ---- one thing at a time per board (this process) --------------------------------------------
  const locks = new Map<string, Promise<unknown>>()
  function withBoard<T>(boardId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(boardId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    locks.set(boardId, tail)
    void tail.then(() => {
      if (locks.get(boardId) === tail) locks.delete(boardId)
    })
    return run
  }

  // ---- bookkeeping -------------------------------------------------------------------------------

  /** Everything up to `startedAt` is covered by a checkpoint (saved now, or an equal older one). */
  async function covered(boardId: string, workspaceId: string, startedAt: Date, saved: boolean) {
    await db.query(
      `INSERT INTO board_checkpoint_state (board_id, workspace_id, last_auto_at)
       VALUES ($1, $2, CASE WHEN $4::boolean THEN $3::timestamptz END)
       ON CONFLICT (board_id) DO UPDATE SET
         dirty_since = CASE WHEN board_checkpoint_state.last_change_at > $3::timestamptz
                            THEN board_checkpoint_state.last_change_at END,
         session_ended_at = CASE WHEN board_checkpoint_state.session_ended_at > $3::timestamptz
                                 THEN board_checkpoint_state.session_ended_at END,
         last_auto_at = CASE WHEN $4::boolean THEN $3::timestamptz ELSE board_checkpoint_state.last_auto_at END,
         failures = 0, retry_at = NULL, claimed_until = NULL`,
      [boardId, workspaceId, startedAt, saved],
    )
  }

  const forget = (boardId: string) =>
    db.query('DELETE FROM board_checkpoint_state WHERE board_id = $1', [boardId])

  async function changed(boardId: string, at: Date) {
    await db.query(
      `INSERT INTO board_checkpoint_state (board_id, workspace_id, dirty_since, last_change_at)
       SELECT id, workspace_id, $2::timestamptz, $2::timestamptz FROM boards WHERE id = $1 AND status <> 'trashed'
       ON CONFLICT (board_id) DO UPDATE SET
         dirty_since = COALESCE(board_checkpoint_state.dirty_since, EXCLUDED.dirty_since),
         last_change_at = GREATEST(board_checkpoint_state.last_change_at, EXCLUDED.last_change_at)`,
      [boardId, at],
    )
  }

  async function sessionEnded(boardId: string, at: Date) {
    await db.query(
      `INSERT INTO board_checkpoint_state (board_id, workspace_id, dirty_since, last_change_at, session_ended_at)
       SELECT id, workspace_id, $2::timestamptz, $2::timestamptz, $2::timestamptz
         FROM boards WHERE id = $1 AND status <> 'trashed'
       ON CONFLICT (board_id) DO UPDATE SET
         dirty_since = COALESCE(board_checkpoint_state.dirty_since, EXCLUDED.dirty_since),
         last_change_at = GREATEST(board_checkpoint_state.last_change_at, EXCLUDED.last_change_at),
         session_ended_at = GREATEST(board_checkpoint_state.session_ended_at, EXCLUDED.session_ended_at)`,
      [boardId, at],
    )
    poke()
  }

  // ---- saving ------------------------------------------------------------------------------------

  async function captureNow(
    boardId: string,
    reason: CheckpointReason,
    opts: CheckpointAbout,
  ): Promise<CaptureOutcome> {
    const board = await db.maybeOne<{ workspace_id: string; status: string; new_canvas: boolean }>(
      'SELECT workspace_id, status, new_canvas FROM boards WHERE id = $1',
      [boardId],
    )
    if (!board) return { status: 'skipped', why: 'missing' }
    if (board.status === 'trashed') {
      await forget(boardId)
      return { status: 'skipped', why: 'trashed' }
    }
    // Bridge release R0: a board made on the new canvas is not this build's to read (its sync refuses it),
    // unless this api's sync runs the new canvas (canvas-engine.ts)
    const newBuild = await onNewCanvas(ctx)
    if (board.new_canvas && !newBuild) return { status: 'skipped', why: 'new-canvas' }
    const startedAt = now()
    let snap: Awaited<ReturnType<typeof ctx.sync.snapshot>>
    try {
      snap = await ctx.sync.snapshot(boardId)
    } catch (e) {
      if (e instanceof SyncNewCanvasBoard) return { status: 'skipped', why: 'new-canvas' }
      throw e
    }
    const made = checkpointBodyOf(boardId, snap)
    // Compared with the newest checkpoint of the same body version only (bridge release R0): one made on
    // the other canvas holds other content, and its clock is not this one's (2 on the new canvas).
    const newest = await db.maybeOne<{ content_hash: string | null; document_clock: number }>(
      `SELECT content_hash, document_clock::float8 AS document_clock FROM board_snapshots
        WHERE board_id = $1 AND body_version = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [boardId, made.body.version],
    )
    const unchanged =
      newest !== null &&
      (newest.content_hash !== null
        ? newest.content_hash === made.contentHash
        : Number(newest.document_clock) === made.documentClock)
    if (unchanged) {
      await covered(boardId, board.workspace_id, startedAt, false)
      return { status: 'unchanged' }
    }
    return saveAuto(boardId, board.workspace_id, reason, opts, made, startedAt, newBuild)
  }

  /**
   * Writes an automatic checkpoint of `made` (its body, its row, the bookkeeping, the event, retention),
   * once the caller decided it is worth saving: capture()'s content check, or the one restore point of
   * captureEngineMigration().
   */
  async function saveAuto(
    boardId: string,
    workspaceId: string,
    reason: CheckpointReason,
    opts: CheckpointAbout,
    made: ReturnType<typeof checkpointBodyOf>,
    startedAt: Date,
    newBuild: boolean,
  ): Promise<{ status: 'saved'; checkpoint: BoardCheckpoint } | { status: 'skipped'; why: 'limit' }> {
    const count = async () =>
      (
        await db.one<{ n: number }>(
          "SELECT count(*)::int AS n FROM board_snapshots WHERE board_id = $1 AND kind <> 'manual'",
          [boardId],
        )
      ).n
    // Safety checkpoints stop earlier than routine ones (see maxAutoPerBoard).
    const limit = SAFETY_REASONS.has(reason)
      ? Math.floor(settings.maxAutoPerBoard * 0.8)
      : settings.maxAutoPerBoard
    if ((await count()) >= limit) {
      await prune(boardId)
      if ((await count()) >= limit) {
        log.warn(`board ${boardId} has ${limit} automatic checkpoints; not saving a ${reason} one`)
        return { status: 'skipped', why: 'limit' }
      }
    }
    // J4 CKPT-FLOOD: and a board's checkpoints (manual and automatic) may not take more than
    // checkpointByteCaps.totalBytesPerBoard (checkpoint-caps.ts); retention first, then skipped like the count cap.
    const overBytes = async () =>
      (await boardCheckpointBytes(db, boardId)).total + made.sizeBytes > checkpointByteCaps.totalBytesPerBoard
    if (await overBytes()) {
      await prune(boardId)
      if (await overBytes()) {
        log.warn(`board ${boardId} has reached its checkpoint size limit; not saving a ${reason} one`)
        return { status: 'skipped', why: 'limit' }
      }
    }

    const id = newId('snp')
    const key = snapshotStorageKey(boardId, id)
    await bodies.write(key, made.json)
    let row: SnapshotRow
    try {
      row = await db.one<SnapshotRow>(
        `WITH ins AS (
           INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, reason, created_by, created_at,
                                        document_clock, record_count, size_bytes, storage_key, content_hash,
                                        body_version)
           VALUES ($1, $2, $3, $4, 'auto', $5, NULL, $6, $7, $8, $9, $10, $11, $12) RETURNING *)
         SELECT ${SNAPSHOT_COLUMNS} FROM ins s LEFT JOIN users u ON u.id = s.created_by`,
        [
          id,
          workspaceId,
          boardId,
          autoCheckpointName(reason, opts),
          reason,
          now(),
          made.documentClock,
          made.recordCount,
          made.sizeBytes,
          key,
          made.contentHash,
          made.body.version, // R0's contract: 2 for a body made on the new canvas
        ],
      )
    } catch (e) {
      await bodies.remove(key).catch(() => warnErr('checkpoint body cleanup failed', e))
      throw e
    }
    await covered(boardId, workspaceId, startedAt, true)
    ctx.events.publish(boardId, { type: HISTORY_EVENTS.snapshot, data: { snapshotId: id } })
    await prune(boardId).catch((e: unknown) => warnErr('checkpoint retention failed', e))
    return { status: 'saved', checkpoint: toCheckpoint(row, { newCanvas: !newBuild }) }
  }

  async function captureEngineMigrationNow(boardId: string): Promise<MigrationCaptureOutcome> {
    const board = await db.maybeOne<{ workspace_id: string; new_canvas: boolean }>(
      'SELECT workspace_id, new_canvas FROM boards WHERE id = $1',
      [boardId],
    )
    if (!board) return { status: 'skipped', why: 'missing' }
    // Born on the new canvas (R0's contract, canvas-engine.ts): nothing of it was converted.
    if (board.new_canvas) return { status: 'skipped', why: 'new-canvas' }
    const newBuild = await onNewCanvas(ctx)
    // One restore point per board: the first state on the new canvas. A repeated run (step C12 run
    // again, a roll-forward) finds it and saves nothing, whatever the board looks like now.
    const existing = await db.maybeOne<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_FROM}
        WHERE s.board_id = $1 AND s.reason = 'engine_migration' ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
      [boardId],
    )
    if (existing) return { status: 'unchanged', checkpoint: toCheckpoint(existing, { newCanvas: !newBuild }) }
    const startedAt = now()
    let snap: Awaited<ReturnType<typeof ctx.sync.snapshot>>
    try {
      snap = await ctx.sync.snapshot(boardId)
    } catch (e) {
      if (e instanceof SyncNewCanvasBoard) return { status: 'skipped', why: 'new-canvas' }
      throw e
    }
    const made = checkpointBodyOf(boardId, snap)
    // A tldraw body is not a state on the new canvas: this api's sync is not the Excalidraw build.
    if (made.body.version !== 2) return { status: 'skipped', why: 'tldraw' }
    // The converter records itself in the board document (`lb_doc.import`, plan §5.3 step 3); a board
    // without it was born empty on the new canvas (it had no file to convert).
    if (!isConversionRecord(made.body.doc.import)) return { status: 'skipped', why: 'not-converted' }
    return saveAuto(boardId, board.workspace_id, 'engine_migration', {}, made, startedAt, newBuild)
  }

  async function captureNamedNow(boardId: string, name: string): Promise<NamedCaptureOutcome> {
    const board = await db.maybeOne<{ workspace_id: string; new_canvas: boolean }>(
      'SELECT workspace_id, new_canvas FROM boards WHERE id = $1',
      [boardId],
    )
    if (!board) return { status: 'skipped', why: 'missing' }
    const newBuild = await onNewCanvas(ctx)
    if (board.new_canvas && !newBuild) return { status: 'skipped', why: 'new-canvas' }
    let snap: Awaited<ReturnType<typeof ctx.sync.snapshot>>
    try {
      snap = await ctx.sync.snapshot(boardId)
    } catch (e) {
      if (e instanceof SyncNewCanvasBoard) return { status: 'skipped', why: 'new-canvas' }
      throw e
    }
    const made = checkpointBodyOf(boardId, snap)
    const newest = await db.maybeOne<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_FROM}
        WHERE s.board_id = $1 AND s.body_version = $2 ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
      [boardId, made.body.version],
    )
    if (
      newest?.kind === 'manual' &&
      newest.created_by === null &&
      newest.name === name &&
      newest.content_hash === made.contentHash &&
      Number(newest.document_clock) === made.documentClock
    )
      return { status: 'unchanged', checkpoint: toCheckpoint(newest, { newCanvas: !newBuild }) }
    const id = newId('snp')
    const key = snapshotStorageKey(boardId, id)
    await bodies.write(key, made.json)
    let row: SnapshotRow
    try {
      row = await db.one<SnapshotRow>(
        `WITH ins AS (
           INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, created_by, created_at,
                                        document_clock, record_count, size_bytes, storage_key, content_hash,
                                        body_version)
           VALUES ($1, $2, $3, $4, 'manual', NULL, $5, $6, $7, $8, $9, $10, $11) RETURNING *)
         SELECT ${SNAPSHOT_COLUMNS} FROM ins s LEFT JOIN users u ON u.id = s.created_by`,
        [
          id,
          board.workspace_id,
          boardId,
          name,
          now(),
          made.documentClock,
          made.recordCount,
          made.sizeBytes,
          key,
          made.contentHash,
          made.body.version, // R0's contract: 2 for a body made on the new canvas
        ],
      )
    } catch (e) {
      await bodies.remove(key).catch(() => warnErr('checkpoint body cleanup failed', e))
      throw e
    }
    ctx.events.publish(boardId, { type: HISTORY_EVENTS.snapshot, data: { snapshotId: id } })
    return { status: 'saved', checkpoint: toCheckpoint(row, { newCanvas: !newBuild }) }
  }

  const warnErr = (message: string, e: unknown) =>
    log.warn(`${message} (${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? ''})`)

  const capture: CheckpointService['capture'] = (boardId, reason, opts = {}) =>
    withBoard(boardId, () => captureNow(boardId, reason, opts))

  const captureQuietly: CheckpointService['captureQuietly'] = async (boardId, reason, opts) => {
    try {
      return await capture(boardId, reason, opts)
    } catch (e) {
      warnErr(`automatic ${reason} checkpoint of board ${boardId} failed`, e)
      return null
    }
  }

  // ---- the scheduler -----------------------------------------------------------------------------

  async function runDue(): Promise<number> {
    const t = now()
    const hourAgo = new Date(t.getTime() - settings.hourlyMs)
    const gapAgo = new Date(t.getTime() - settings.sessionEndGapMs)
    const due = await db.query<{ board_id: string }>(
      `SELECT board_id FROM board_checkpoint_state
        WHERE dirty_since IS NOT NULL
          AND (retry_at IS NULL OR retry_at <= $1)
          AND (claimed_until IS NULL OR claimed_until <= $1)
          AND ((session_ended_at IS NOT NULL AND (last_auto_at IS NULL OR last_auto_at <= $3))
               OR (dirty_since <= $2 AND (last_auto_at IS NULL OR last_auto_at <= $2)))
        ORDER BY COALESCE(session_ended_at, dirty_since), board_id
        LIMIT ${Math.max(1, Math.floor(settings.batch))}`,
      [t, hourAgo, gapAgo],
    )
    let handled = 0
    for (const { board_id: boardId } of due.rows) {
      const at = now()
      const claimed = await db.maybeOne<StateRow>(
        `UPDATE board_checkpoint_state SET claimed_until = $2
          WHERE board_id = $1 AND dirty_since IS NOT NULL AND (claimed_until IS NULL OR claimed_until <= $3)
          RETURNING workspace_id, session_ended_at, failures`,
        [boardId, new Date(at.getTime() + settings.claimMs), at],
      )
      if (!claimed) continue // another instance has it, or it is no longer due
      handled++
      const reason: CheckpointReason = claimed.session_ended_at ? 'session_end' : 'hourly'
      try {
        const outcome = await capture(boardId, reason)
        if (outcome.status === 'skipped' && outcome.why === 'missing') await forget(boardId)
        // At the limit: retention frees room by the hour at most, so try again then (not every tick,
        // which would read the whole board from sync each minute). Still pending meanwhile. A board
        // made on the new canvas (bridge release R0) likewise: kept pending for the new build.
        else if (outcome.status === 'skipped' && (outcome.why === 'limit' || outcome.why === 'new-canvas'))
          await postpone(boardId, settings.hourlyMs)
        else if (outcome.status === 'skipped') await release(boardId)
      } catch (e) {
        await failed(boardId, claimed.failures + 1, e)
      }
    }
    return handled
  }

  const release = (boardId: string) =>
    db.query('UPDATE board_checkpoint_state SET claimed_until = NULL WHERE board_id = $1', [boardId])
  const postpone = (boardId: string, ms: number) =>
    db.query('UPDATE board_checkpoint_state SET retry_at = $2, claimed_until = NULL WHERE board_id = $1', [
      boardId,
      new Date(now().getTime() + ms),
    ])

  async function failed(boardId: string, failures: number, e: unknown) {
    if (failures >= settings.maxFailures) {
      warnErr(`gave up on an automatic checkpoint of board ${boardId} after ${failures} attempts`, e)
      await db.query(
        `UPDATE board_checkpoint_state SET dirty_since = NULL, session_ended_at = NULL, failures = 0,
                retry_at = NULL, claimed_until = NULL WHERE board_id = $1`,
        [boardId],
      )
      return
    }
    warnErr(`automatic checkpoint of board ${boardId} failed (attempt ${failures})`, e)
    const backoff = Math.min(30 * MINUTE, 30_000 * 2 ** (failures - 1))
    await db.query(
      'UPDATE board_checkpoint_state SET failures = $2, retry_at = $3, claimed_until = NULL WHERE board_id = $1',
      [boardId, failures, new Date(now().getTime() + backoff)],
    )
  }

  let running: Promise<void> | null = null
  let again = false
  function poke() {
    if (running) {
      again = true
      return
    }
    running = (async () => {
      do {
        again = false
        await runDue()
      } while (again)
    })()
      .catch((e: unknown) => warnErr('automatic checkpoint pass failed', e))
      .finally(() => {
        running = null
      })
  }
  async function idle() {
    while (running) await running
  }

  // ---- retention and deletion ------------------------------------------------------------------

  async function drainKeys(keys: readonly string[]): Promise<number> {
    let done = 0
    for (const key of keys) {
      try {
        await bodies.remove(key)
        await db.query('DELETE FROM board_snapshot_blob_deletions WHERE storage_key = $1', [key])
        done++
      } catch (e) {
        warnErr('a checkpoint body could not be deleted (retried later)', e)
        await db
          .query('UPDATE board_snapshot_blob_deletions SET attempts = attempts + 1 WHERE storage_key = $1', [
            key,
          ])
          .catch(() => {})
      }
    }
    return done
  }

  async function remove(
    boardId: string,
    ids: readonly string[],
    opts: { onlyAuto: boolean; audit?: { actorId: string } },
  ): Promise<SnapshotRow[]> {
    if (!ids.length) return []
    const at = now()
    const rows = await db.transaction(async (tx) => {
      const deleted = await tx.query<SnapshotRow>(
        `WITH del AS (
           DELETE FROM board_snapshots WHERE board_id = $1 AND id = ANY($2::text[])
             ${opts.onlyAuto ? "AND kind <> 'manual'" : ''}
           RETURNING *)
         SELECT ${SNAPSHOT_COLUMNS} FROM del s LEFT JOIN users u ON u.id = s.created_by`,
        [boardId, [...ids]],
      )
      for (const r of deleted.rows) {
        await queueBlobDeletion(tx, r, at)
        if (opts.audit)
          await audit(tx, {
            workspaceId: r.workspace_id,
            actorId: opts.audit.actorId,
            action: 'board.checkpoint.delete',
            target: boardId,
            detail: {
              snapshotId: r.id,
              name: r.name,
              kind: r.kind,
              reason: r.reason,
              createdAt: r.created_at.toISOString(),
            },
            at,
          })
      }
      return deleted.rows
    })
    if (rows.length) {
      await drainKeys(rows.map((r) => r.storage_key))
      ctx.events.publish(boardId, {
        type: CHECKPOINT_EVENTS.removed,
        data: { snapshotIds: rows.map((r) => r.id) },
      })
    }
    return rows
  }

  async function prune(boardId: string): Promise<string[]> {
    const rows = await db.query<{ id: string; reason: CheckpointReason | null; created_at: Date }>(
      "SELECT id, reason, created_at FROM board_snapshots WHERE board_id = $1 AND kind <> 'manual'",
      [boardId],
    )
    const plan = planRetention(
      rows.rows.map((r) => ({ id: r.id, reason: r.reason, createdAt: r.created_at })),
      now(),
      settings.retention,
    )
    if (!plan.remove.length) return []
    const removed = await remove(boardId, plan.remove, { onlyAuto: true })
    if (removed.length)
      log.info(`retention removed ${removed.length} automatic checkpoint(s) of board ${boardId}`)
    return removed.map((r) => r.id)
  }

  async function drainBlobDeletions(): Promise<number> {
    const queued = await db.query<{ storage_key: string }>(
      'SELECT storage_key FROM board_snapshot_blob_deletions ORDER BY queued_at LIMIT 500',
    )
    return drainKeys(queued.rows.map((r) => r.storage_key))
  }

  async function pruneAll(): Promise<number> {
    const boards = await db.query<{ board_id: string }>(
      "SELECT DISTINCT board_id FROM board_snapshots WHERE kind <> 'manual' ORDER BY board_id",
    )
    let removed = 0
    for (const { board_id } of boards.rows) {
      try {
        removed += (await withBoard(board_id, () => prune(board_id))).length
      } catch (e) {
        warnErr(`checkpoint retention failed for board ${board_id}`, e)
      }
    }
    await drainBlobDeletions()
    return removed
  }

  return {
    capture,
    captureNamed: (boardId, name) => withBoard(boardId, () => captureNamedNow(boardId, name)),
    captureEngineMigration: (boardId) => withBoard(boardId, () => captureEngineMigrationNow(boardId)),
    captureQuietly,
    changed,
    sessionEnded,
    runDue,
    prune: (boardId) => withBoard(boardId, () => prune(boardId)),
    pruneAll,
    remove: (boardId, ids, opts) => withBoard(boardId, () => remove(boardId, ids, opts)),
    drainBlobDeletions,
    poke,
    idle,
  }
}

/**
 * Whether a board document's `import` value is the converter's record (canvas-schema doc.ts
 * ImportDocValue, written by the board conversion and by a seed of tldraw records): read loosely, the
 * sync validated it when it was written.
 */
export const isConversionRecord = (value: unknown): boolean =>
  isObject(value) && typeof value.from === 'string' && typeof value.converterVersion === 'string'

/** Queues a deleted row's body for deletion (inside the transaction that deletes the row). */
async function queueBlobDeletion(tx: Queryable, r: SnapshotRow, at: Date) {
  await tx.query(
    `INSERT INTO board_snapshot_blob_deletions (storage_key, workspace_id, board_id, queued_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (storage_key) DO NOTHING`,
    [r.storage_key, r.workspace_id, r.board_id, at],
  )
}

/** Runs the scheduler and the retention pass while the app runs (one API instance: docs/DEPLOY.md). */
export function startCheckpointTimers(
  app: FastifyInstance,
  service: CheckpointService,
  settings: Pick<CheckpointSettings, 'tickMs' | 'pruneEveryMs'>,
): void {
  const timers: ReturnType<typeof setInterval>[] = []
  let pruning: Promise<unknown> | null = null
  const pruneOnce = () => {
    if (pruning) return
    pruning = service
      .pruneAll()
      .catch((e: unknown) =>
        app.log.warn({ err: { message: (e as Error)?.message } }, 'checkpoint retention failed'),
      )
      .finally(() => {
        pruning = null
      })
  }
  app.addHook('onReady', async () => {
    if (settings.tickMs > 0) timers.push(setInterval(() => service.poke(), settings.tickMs))
    if (settings.pruneEveryMs > 0) {
      timers.push(setInterval(pruneOnce, settings.pruneEveryMs))
      // A first pass soon after start (deploys restart the api more often than the interval).
      timers.push(setTimeout(pruneOnce, Math.min(settings.pruneEveryMs, 2 * MINUTE)))
    }
    for (const t of timers) t.unref()
  })
  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t)
    timers.length = 0
    await service.idle()
    await pruning // the database closes after this hook
  })
}
