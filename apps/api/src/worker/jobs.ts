// The preview job state machine in Postgres (docs/M3-STORAGE-CONTRACTS.md §2, §4). HTTP-free, so the
// lease rules are testable directly; apps/api/src/worker/routes.ts adds auth, URLs and events.
//
//   preview_jobs.status   queued ──claim──> running ──complete──> done | failed
//                           ^                 │ └──retry (attempts left)──> queued (run_after = backoff)
//                           └──lease expired──┘ (reclaimed by the next claim; attempts count claims)
//
// Rules that keep two workers from ever doing the same job at once:
// - claim picks the oldest claimable row with FOR UPDATE SKIP LOCKED and flips it to running in the
//   same transaction; a concurrent claimer skips the locked row (real Postgres) or runs after the
//   commit (PGlite serializes transactions) and no longer sees it as claimable either way.
// - every lease-bound call (heartbeat, reserve, complete, retry) re-checks, under the row lock,
//   status = running AND lease_owner = workerId (AND attempts = attempt when the worker sends it).
// - no I/O inside a transaction: blob checks happen before it (and are re-validated by the lease
//   check inside it); blob deletions of dropped reservations happen after commit.
// Clock: `now` comes from the api (tests move it), never from Postgres now().

import type { Db, Queryable } from '@draftroom/db'
import type { AssetKind } from '@draftroom/dev-assets'
import { newId } from '@draftroom/dev-assets'
import { DERIVATIVE_EXT, derivativeKey } from '../files/blobs.ts'
import {
  backoffMs,
  type CompleteInput,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_DERIVATIVES_PER_JOB,
  type ReserveInput,
  type RetryInput,
  sanitizeProbe,
  userFailure,
} from './protocol.ts'

export class LeaseLost extends Error {
  constructor() {
    super('lease not held')
    this.name = 'LeaseLost'
  }
}

/** A listed derivative id that is not a reservation of this job attempt (400). */
export class UnknownDerivative extends Error {
  constructor() {
    super('unknown derivative')
    this.name = 'UnknownDerivative'
  }
}

/** A reserved derivative whose blob is absent or not the declared size/type (409: upload it first). */
export class DerivativeMissing extends Error {
  constructor() {
    super('derivative blob missing')
    this.name = 'DerivativeMissing'
  }
}

export class TooManyDerivatives extends Error {
  constructor() {
    super('too many derivatives')
    this.name = 'TooManyDerivatives'
  }
}

/** What a board event needs about a version whose status changed. */
export interface VersionChange {
  versionId: string
  assetId: string
  boardId: string
  workspaceId: string
  status: 'queued' | 'processing' | 'ready' | 'failed'
}

export interface ClaimedJob {
  versionId: string
  assetId: string
  boardId: string
  kind: AssetKind
  name: string
  declaredMimeType: string
  sizeBytes: number
  attempt: number
  leaseMs: number
}

export interface ClaimOutcome {
  job: (ClaimedJob & { workspaceId: string }) | null
  /** Versions failed during this claim (out of attempts: a file that kept killing its worker). */
  failed: VersionChange[]
  /** Blobs of reservations dropped by reclaiming expired leases (delete after commit). */
  orphanKeys: string[]
}

interface JobRow {
  version_id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  attempts: number
  lease_owner: string | null
  asset_id: string
  board_id: string
  workspace_id: string
  kind: AssetKind
  version_status: VersionChange['status']
}

const JOB_COLUMNS = `j.version_id, j.status, j.attempts, j.lease_owner, v.asset_id, v.board_id, v.workspace_id,
  v.kind, v.status AS version_status`

const leaseUntil = (now: Date) => new Date(now.getTime() + LEASE_MS)

const change = (j: JobRow, status: VersionChange['status']): VersionChange => ({
  versionId: j.version_id,
  assetId: j.asset_id,
  boardId: j.board_id,
  workspaceId: j.workspace_id,
  status,
})

/** The job row locked for update, only while `workerId` holds its lease (and `attempt` matches). */
async function lockLease(tx: Queryable, versionId: string, workerId: string, attempt?: number) {
  const j = await tx.maybeOne<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM preview_jobs j JOIN asset_versions v ON v.id = j.version_id
      WHERE j.version_id = $1 FOR UPDATE OF j`,
    [versionId],
  )
  if (j?.status !== 'running' || j.lease_owner !== workerId) return null
  if (attempt !== undefined && attempt !== j.attempts) return null
  return j
}

async function dropReservations(tx: Queryable, versionId: string, keep: readonly string[] = []) {
  const rows = await tx.query<{ blob_key: string }>(
    'DELETE FROM asset_derivative_reservations WHERE version_id = $1 AND NOT (id = ANY($2::text[])) RETURNING blob_key',
    [versionId, keep],
  )
  return rows.rows.map((r) => r.blob_key)
}

/**
 * The api gives up on a job (out of attempts). lease_owner is cleared: only a worker's own `complete`
 * leaves it set, so a late `complete` from the last holder is a 409, not a "repeated" success.
 */
async function failVersion(tx: Queryable, j: JobRow, now: Date, code: string, lastError: string | null) {
  const failure = userFailure(code)
  await tx.query(
    `UPDATE preview_jobs SET status = 'failed', lease_owner = NULL, lease_until = NULL, last_error = $2,
        updated_at = $3
      WHERE version_id = $1`,
    [j.version_id, lastError, now],
  )
  await tx.query(
    `UPDATE asset_versions SET status = 'failed', error_code = $2, error_message = $3, updated_at = $4
      WHERE id = $1`,
    [j.version_id, failure.code, failure.message, now],
  )
}

/**
 * POST /api/worker/claim: the oldest claimable job (queued and due, or running with an expired lease),
 * now `running` under `workerId` for LEASE_MS, attempts + 1, its version `processing`.
 */
export async function claimJob(db: Db, now: Date, workerId: string): Promise<ClaimOutcome> {
  const failed: VersionChange[] = []
  const orphanKeys: string[] = []
  // Each pass either claims a job, fails an exhausted one (then looks again), or finds nothing.
  for (let pass = 0; pass < 10; pass++) {
    const step = await db.transaction(async (tx) => {
      const j = await tx.maybeOne<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM preview_jobs j JOIN asset_versions v ON v.id = j.version_id
          WHERE (j.status = 'queued' AND j.run_after <= $1) OR (j.status = 'running' AND j.lease_until < $1)
          ORDER BY j.run_after, j.created_at, j.version_id
          LIMIT 1
          FOR UPDATE OF j SKIP LOCKED`,
        [now],
      )
      if (!j) return { kind: 'none' as const }
      // A reclaimed lease: whatever the previous holder reserved is abandoned.
      const dropped = await dropReservations(tx, j.version_id)
      if (j.attempts >= MAX_ATTEMPTS) {
        await failVersion(tx, j, now, 'INTERNAL', `gave up after ${j.attempts} attempts`)
        return { kind: 'failed' as const, change: change(j, 'failed'), dropped }
      }
      const attempts = j.attempts + 1
      await tx.query(
        `UPDATE preview_jobs SET status = 'running', lease_owner = $2, lease_until = $3, attempts = $4,
            updated_at = $5
          WHERE version_id = $1`,
        [j.version_id, workerId, leaseUntil(now), attempts, now],
      )
      const v = await tx.one<{
        kind: AssetKind
        name: string
        declared_mime_type: string
        size_bytes: number
      }>(
        `UPDATE asset_versions SET status = 'processing', attempts = $2, error_code = NULL, error_message = NULL,
            updated_at = $3
          WHERE id = $1
          RETURNING kind, name, declared_mime_type, size_bytes::float8 AS size_bytes`,
        [j.version_id, attempts, now],
      )
      const job = {
        versionId: j.version_id,
        assetId: j.asset_id,
        boardId: j.board_id,
        workspaceId: j.workspace_id,
        kind: v.kind,
        name: v.name,
        declaredMimeType: v.declared_mime_type,
        sizeBytes: Number(v.size_bytes),
        attempt: attempts,
        leaseMs: LEASE_MS,
      }
      return { kind: 'claimed' as const, job, dropped }
    })
    if (step.kind === 'none') return { job: null, failed, orphanKeys }
    orphanKeys.push(...step.dropped)
    if (step.kind === 'claimed') return { job: step.job, failed, orphanKeys }
    failed.push(step.change)
  }
  return { job: null, failed, orphanKeys }
}

/** POST /api/worker/jobs/:ver/heartbeat: extends the lease; LeaseLost if it is not held any more. */
export async function heartbeat(
  db: Db,
  now: Date,
  versionId: string,
  workerId: string,
  attempt?: number,
): Promise<{ leaseMs: number }> {
  const r = await db.query(
    `UPDATE preview_jobs SET lease_until = $3, updated_at = $4
      WHERE version_id = $1 AND status = 'running' AND lease_owner = $2 AND ($5::int IS NULL OR attempts = $5)`,
    [versionId, workerId, leaseUntil(now), now, attempt ?? null],
  )
  if (r.rowCount !== 1) throw new LeaseLost()
  return { leaseMs: LEASE_MS }
}

export interface Reservation {
  derivativeId: string
  blobKey: string
  mimeType: 'image/webp' | 'image/png'
  bytes: number
}

/** POST /api/worker/jobs/:ver/derivatives: a fresh derivative id + blob key for this attempt. */
export async function reserveDerivative(
  db: Db,
  now: Date,
  versionId: string,
  input: ReserveInput,
): Promise<Reservation> {
  return db.transaction(async (tx) => {
    const j = await lockLease(tx, versionId, input.workerId, input.attempt)
    if (!j) throw new LeaseLost()
    const { n } = await tx.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM asset_derivative_reservations WHERE version_id = $1 AND attempt = $2',
      [versionId, j.attempts],
    )
    if (n >= MAX_DERIVATIVES_PER_JOB) throw new TooManyDerivatives()
    const derivativeId = newId('drv')
    const blobKey = derivativeKey(j.asset_id, versionId, derivativeId, DERIVATIVE_EXT[input.mimeType])
    await tx.query(
      `INSERT INTO asset_derivative_reservations
         (id, version_id, attempt, role, page, width, height, mime_type, bytes, blob_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        derivativeId,
        versionId,
        j.attempts,
        input.role,
        input.page ?? null,
        input.width,
        input.height,
        input.mimeType,
        input.bytes,
        blobKey,
        now,
      ],
    )
    return { derivativeId, blobKey, mimeType: input.mimeType, bytes: input.bytes }
  })
}

interface ReservationRow {
  id: string
  role: string
  page: number | null
  width: number
  height: number
  mime_type: 'image/webp' | 'image/png'
  bytes: number
  blob_key: string
}

export interface BlobHead {
  head(key: string): Promise<{ contentLength: number; contentType: string | null } | null>
}

export interface CompleteOutcome {
  status: 'ready' | 'failed'
  /** true when this worker had already completed the job (nothing changed). */
  repeated: boolean
  change: VersionChange | null
  orphanKeys: string[]
}

/**
 * POST /api/worker/jobs/:ver/complete. `ready`: every listed derivative must be a reservation of this
 * attempt whose blob exists with the reserved size (and type, when the store reports one); then the
 * derivative rows, the version (ready + probe + confirmed type) and the job (done) are written in one
 * transaction. `failed`: the version gets the user-safe message for the code. Repeating a completed
 * call from the same worker answers the stored result.
 */
export async function completeJob(
  db: Db,
  blobs: BlobHead,
  now: Date,
  versionId: string,
  input: CompleteInput,
): Promise<CompleteOutcome> {
  const current = await db.maybeOne<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM preview_jobs j JOIN asset_versions v ON v.id = j.version_id WHERE j.version_id = $1`,
    [versionId],
  )
  const repeatOf = (j: JobRow | null): CompleteOutcome | null =>
    j &&
    (j.status === 'done' || j.status === 'failed') &&
    j.lease_owner === input.workerId &&
    (input.attempt === undefined || input.attempt === j.attempts)
      ? {
          status: j.version_status === 'ready' ? 'ready' : 'failed',
          repeated: true,
          change: null,
          orphanKeys: [],
        }
      : null
  const repeated = repeatOf(current)
  if (repeated) return repeated
  if (
    current?.status !== 'running' ||
    current.lease_owner !== input.workerId ||
    (input.attempt !== undefined && input.attempt !== current.attempts)
  )
    throw new LeaseLost()

  const ready = input.status === 'ready'
  const listed = ready ? input.derivatives : []
  let reservations: ReservationRow[] = []
  if (listed.length) {
    reservations = (
      await db.query<ReservationRow>(
        `SELECT id, role, page, width, height, mime_type, bytes::float8 AS bytes, blob_key
           FROM asset_derivative_reservations
          WHERE version_id = $1 AND attempt = $2 AND id = ANY($3::text[])`,
        [versionId, current.attempts, listed],
      )
    ).rows
    if (reservations.length !== listed.length) throw new UnknownDerivative()
    const heads = await Promise.all(reservations.map((r) => blobs.head(r.blob_key)))
    heads.forEach((h, i) => {
      const r = reservations[i] as ReservationRow
      if (!h || h.contentLength !== Number(r.bytes)) throw new DerivativeMissing()
      const type = h.contentType?.split(';')[0]?.trim().toLowerCase()
      if (type && type !== 'application/octet-stream' && type !== r.mime_type) throw new DerivativeMissing()
    })
  }
  const byId = new Map(reservations.map((r) => [r.id, r]))

  return db.transaction(async (tx) => {
    const j = await lockLease(tx, versionId, input.workerId, current.attempts)
    if (!j) {
      // Lost the race to our own earlier call (a client retry) or to a reclaim.
      const again = await tx.maybeOne<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM preview_jobs j JOIN asset_versions v ON v.id = j.version_id WHERE j.version_id = $1`,
        [versionId],
      )
      const r = repeatOf(again)
      if (r) return r
      throw new LeaseLost()
    }
    let position = 0
    for (const id of listed) {
      const r = byId.get(id) as ReservationRow
      await tx.query(
        `INSERT INTO asset_derivatives (id, version_id, position, role, page, width, height, mime_type, bytes, blob_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          r.id,
          versionId,
          position++,
          r.role,
          r.page,
          r.width,
          r.height,
          r.mime_type,
          r.bytes,
          r.blob_key,
          now,
        ],
      )
    }
    const probe = JSON.stringify(sanitizeProbe(input.probe ?? {}))
    // A type confirmed by content exists only for previewable kinds (as in M0): an 'other' file keeps
    // its upload-time type (octet-stream), whatever a worker echoes back.
    const confirmed = j.kind === 'other' ? null : (input.mimeType ?? null)
    if (ready) {
      await tx.query(
        `UPDATE asset_versions SET status = 'ready', mime_type = COALESCE($2, mime_type), probe = $3::jsonb,
            error_code = NULL, error_message = NULL, updated_at = $4
          WHERE id = $1`,
        [versionId, confirmed, probe, now],
      )
      await tx.query(
        `UPDATE preview_jobs SET status = 'done', lease_until = NULL, last_error = NULL, updated_at = $2
          WHERE version_id = $1`,
        [versionId, now],
      )
    } else {
      const failure = userFailure(input.error?.code)
      await tx.query(
        `UPDATE asset_versions SET status = 'failed', probe = $2::jsonb, error_code = $3, error_message = $4,
            updated_at = $5
          WHERE id = $1`,
        [versionId, probe, failure.code, failure.message, now],
      )
      await tx.query(
        `UPDATE preview_jobs SET status = 'failed', lease_until = NULL, last_error = $2, updated_at = $3
          WHERE version_id = $1`,
        [versionId, failure.code, now],
      )
    }
    // Published derivatives become rows; every other reservation (unlisted, earlier attempts) is dropped.
    const orphanKeys = await dropReservations(tx, versionId, listed)
    await tx.query('DELETE FROM asset_derivative_reservations WHERE version_id = $1', [versionId])
    return {
      status: ready ? ('ready' as const) : ('failed' as const),
      repeated: false,
      change: change(j, ready ? 'ready' : 'failed'),
      orphanKeys,
    }
  })
}

export interface RetryOutcome {
  status: 'queued' | 'failed'
  runAfter: Date | null
  change: VersionChange
  orphanKeys: string[]
}

const clipDetail = (e: RetryInput['error']): string | null => {
  if (!e) return null
  const text = typeof e === 'string' ? e : [e.code, e.message].filter(Boolean).join(': ')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are stripped on purpose
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) || null
}

/**
 * POST /api/worker/jobs/:ver/retry: a transient failure. Back to `queued` after backoff(attempt), or
 * `failed` (INTERNAL) once LIMITS.maxAttempts attempts are used. `release` (worker shutdown) requeues
 * at once and does not count the attempt.
 */
export async function retryJob(
  db: Db,
  now: Date,
  versionId: string,
  input: RetryInput,
): Promise<RetryOutcome> {
  return db.transaction(async (tx) => {
    const j = await lockLease(tx, versionId, input.workerId, input.attempt)
    if (!j) throw new LeaseLost()
    const orphanKeys = await dropReservations(tx, versionId)
    const detail = clipDetail(input.error)
    if (!input.release && j.attempts >= MAX_ATTEMPTS) {
      await failVersion(tx, j, now, 'INTERNAL', detail)
      return { status: 'failed' as const, runAfter: null, change: change(j, 'failed'), orphanKeys }
    }
    const attempts = input.release ? Math.max(0, j.attempts - 1) : j.attempts
    const runAfter = input.release ? now : new Date(now.getTime() + backoffMs(j.attempts))
    await tx.query(
      `UPDATE preview_jobs SET status = 'queued', attempts = $2, run_after = $3, lease_owner = NULL,
          lease_until = NULL, last_error = COALESCE($4, last_error), updated_at = $5
        WHERE version_id = $1`,
      [versionId, attempts, runAfter, detail, now],
    )
    await tx.query(
      `UPDATE asset_versions SET status = 'queued', attempts = $2, updated_at = $3 WHERE id = $1`,
      [versionId, attempts, now],
    )
    return { status: 'queued' as const, runAfter, change: change(j, 'queued'), orphanKeys }
  })
}

/** The original's blob key and size for a version that is being processed (fs-mode blob GET). */
export async function runningOriginal(
  q: Queryable,
  versionId: string,
): Promise<{ assetId: string; sizeBytes: number } | null> {
  return q.maybeOne<{ assetId: string; sizeBytes: number }>(
    `SELECT v.asset_id AS "assetId", v.size_bytes::float8 AS "sizeBytes"
       FROM preview_jobs j JOIN asset_versions v ON v.id = j.version_id
      WHERE j.version_id = $1 AND j.status = 'running'`,
    [versionId],
  )
}

/** A live reservation (fs-mode blob PUT): its key, size and type. */
export async function liveReservation(
  q: Queryable,
  derivativeId: string,
): Promise<{ blobKey: string; bytes: number; mimeType: string } | null> {
  return q.maybeOne<{ blobKey: string; bytes: number; mimeType: string }>(
    `SELECT r.blob_key AS "blobKey", r.bytes::float8 AS bytes, r.mime_type AS "mimeType"
       FROM asset_derivative_reservations r
       JOIN preview_jobs j ON j.version_id = r.version_id AND j.status = 'running' AND j.attempts = r.attempt
      WHERE r.id = $1`,
    [derivativeId],
  )
}
