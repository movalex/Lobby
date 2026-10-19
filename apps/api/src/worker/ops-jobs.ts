// Wave W (docs/WAVE-W-CONTRACTS.md §3): the worker ops state machine in Postgres (migration 0039 worker_ops,
// worker_op_outputs, worker_capabilities_seen). HTTP-free, like ./jobs.ts for previews, whose rules it copies; the HTTP
// side is ./ops-routes.ts and each kind's own work is ./ops-kinds.ts. OWNER: the wave W lead.
//
//   worker_ops.status   queued ──claim──> running ──complete──> done
//                         ^   │              │ └──fail (retry, attempts left) / release──> queued (run_after)
//                         │   │              └──fail──> failed (error_code)
//                         │   └──(15 min due and unclaimed, or its switch off: expireOps)──> failed WORKER_UNAVAILABLE
//                         │       (its board trashed or gone at claim)──> cancelled CANCELLED
//                         └──lease expired──┘ (reclaimed by the next claim; attempts count claims)
//
// - A worker is handed only ops whose kind's CURRENT capability it reported (contracts claimableKinds) and whose switch
//   is on; previews keep priority because the worker asks for an op only when its preview claim was empty.
// - claim picks the oldest claimable row FOR UPDATE SKIP LOCKED and flips it to running in the same transaction; every
//   lease-bound call re-checks, under the row lock, status = running AND lease_owner AND attempts = attempt.
// - No I/O inside a transaction: output blobs are checked before `complete`'s transaction, deleted after commit.
// Clock: `now` comes from the api (tests move it), never from Postgres now().

import {
  claimableKinds,
  FILE_TEXT_LIMITS,
  type FormatSwitches,
  opFailureCode,
  WORKER_CAPABILITIES,
  WORKER_CAPABILITY_RE,
  WORKER_OP_KINDS,
  WORKER_OP_LIMITS,
  WORKER_OP_SWITCH,
  type WorkerOpCompleteInput,
  type WorkerOpErrorCode,
  type WorkerOpFailInput,
  type WorkerOpKind,
  type WorkerOpOutputInput,
  type WorkerOpStatus,
  type WorkerOpTextInput,
} from '@draftroom/contracts'
import { type Db, newId, type Queryable } from '@draftroom/db'
import { newId as newAssetId } from '@draftroom/dev-assets'
import { DERIVATIVE_EXT, derivativeKey, originalKey } from '../files/blobs.ts'
import { type BlobHead, LeaseLost } from './jobs.ts'
import {
  type LockedOp,
  OP_KINDS,
  type OpKindHandler,
  OpRefused,
  type OutputReader,
  type PublishedOutput,
} from './ops-kinds.ts'
import { backoffMs } from './protocol.ts'

/** What the browser side needs after a committed status change (the requester's `file.op` event). */
export interface OpChange {
  opId: string
  kind: WorkerOpKind
  boardId: string
  workspaceId: string
  requestedBy: string | null
  status: WorkerOpStatus
}

export interface ClaimedOp {
  id: string
  kind: WorkerOpKind
  capability: string
  boardId: string
  workspaceId: string
  sourceVersionId: string
  sourceAssetId: string
  params: Record<string, unknown>
  attempt: number
  leaseMs: number
  source: {
    kind: 'image' | 'pdf' | 'video' | 'other'
    name: string
    mimeType: string
    sizeBytes: number
    pageCount: number | null
  }
}

interface OpRow {
  id: string
  kind: WorkerOpKind
  workspace_id: string
  board_id: string
  source_version_id: string
  params: Record<string, unknown>
  status: WorkerOpStatus
  attempts: number
  lease_owner: string | null
  requested_by: string | null
  asset_id: string
}

const OP_COLUMNS = `o.id, o.kind, o.workspace_id, o.board_id, o.source_version_id, o.params, o.status, o.attempts,
  o.lease_owner, o.requested_by, v.asset_id`

const leaseUntil = (now: Date) => new Date(now.getTime() + WORKER_OP_LIMITS.leaseMs)

const changeOf = (o: OpRow, status: WorkerOpStatus): OpChange => ({
  opId: o.id,
  kind: o.kind,
  boardId: o.board_id,
  workspaceId: o.workspace_id,
  requestedBy: o.requested_by,
  status,
})

const lockedOf = (o: OpRow): LockedOp => ({
  id: o.id,
  kind: o.kind,
  workspaceId: o.workspace_id,
  boardId: o.board_id,
  sourceVersionId: o.source_version_id,
  sourceAssetId: o.asset_id,
  params: o.params,
  attempt: o.attempts,
  requestedBy: o.requested_by,
})

/** The kinds this api hands out at all (their switch on). */
export const enabledKinds = (switches: FormatSwitches): WorkerOpKind[] =>
  (Object.keys(WORKER_OP_SWITCH) as WorkerOpKind[]).filter((k) => switches[WORKER_OP_SWITCH[k]] === true)

/** The SQL of `<alias>.kind`'s current capability (contracts WORKER_CAPABILITIES; constant, regex-checked words). */
function capabilityOfSql(alias: string): string {
  const arms = WORKER_OP_KINDS.map((k) => {
    const cap = WORKER_CAPABILITIES[k]
    if (!/^[a-z-]+$/.test(k) || !WORKER_CAPABILITY_RE.test(cap)) throw new Error('unexpected capability word')
    return `WHEN '${k}' THEN '${cap}'`
  })
  return `CASE ${alias}.kind ${arms.join(' ')} END`
}

/** The two cutoffs of overdueCodeSql at `now`. */
export const overdueCutoffs = (now: Date): { deadline: Date; absent: Date } => ({
  deadline: new Date(now.getTime() - WORKER_OP_LIMITS.requestedQueueDeadlineMs),
  absent: new Date(now.getTime() - WORKER_OP_LIMITS.workerAbsentMs),
})

/**
 * SQL: the code a QUEUED op `<alias>` has run into by now, or NULL (review M2: age in a busy queue is never a reason).
 *   - WORKER_BUSY: a person asked for it (`requested_by`) and it is still queued requestedQueueDeadlineMs after the
 *     request (requested ops are claimed first, so only other people's requests can keep it waiting that long);
 *   - WORKER_UNAVAILABLE: it has been due for workerAbsentMs AND no worker reporting its kind's current capability has
 *     checked in (a claim or a check-in: worker_capabilities_seen) for workerAbsentMs.
 * `deadline` and `absent` are the SQL of overdueCutoffs(now)'s two values (parameters).
 */
export function overdueCodeSql(alias: string, deadline: string, absent: string): string {
  return `(CASE WHEN ${alias}.status <> 'queued' THEN NULL
     WHEN ${alias}.requested_by IS NOT NULL AND ${alias}.created_at < ${deadline} THEN 'WORKER_BUSY'
     WHEN ${alias}.run_after < ${absent} AND NOT EXISTS (
            SELECT 1 FROM worker_capabilities_seen cs
             WHERE cs.capability = ${capabilityOfSql(alias)} AND cs.last_seen_at >= ${absent})
       THEN 'WORKER_UNAVAILABLE'
     END)`
}

/**
 * Writes the overdue queued ops of one kind and source version as failed (a request route, before it checks for an
 * active op, so an op that reads as failed does not hold the one-active-op index against a new request). Returns the
 * changes for the requesters' events.
 */
export async function expireOverdueOf(
  tx: Queryable,
  now: Date,
  kind: WorkerOpKind,
  versionId: string,
): Promise<OpChange[]> {
  const { deadline, absent } = overdueCutoffs(now)
  const overdue = overdueCodeSql('o', '$3', '$4')
  // SKIP LOCKED: an op a claim holds is being claimed, not over
  const rows = await tx.query<OpRow & { code: WorkerOpErrorCode }>(
    `SELECT ${OP_COLUMNS}, ${overdue} AS code
       FROM worker_ops o JOIN asset_versions v ON v.id = o.source_version_id
      WHERE o.kind = $1 AND o.source_version_id = $2 AND o.status = 'queued' AND ${overdue} IS NOT NULL
      FOR UPDATE OF o SKIP LOCKED`,
    [kind, versionId, deadline, absent],
  )
  for (const o of rows.rows) await finish(tx, o, now, 'failed', o.code)
  return rows.rows.map((o) => changeOf(o, 'failed'))
}

/** The op row locked for update, only while `workerId` holds its lease for `attempt`. */
async function lockLease(
  tx: Queryable,
  opId: string,
  workerId: string,
  attempt: number,
): Promise<OpRow | null> {
  const o = await tx.maybeOne<OpRow>(
    `SELECT ${OP_COLUMNS} FROM worker_ops o JOIN asset_versions v ON v.id = o.source_version_id
      WHERE o.id = $1 FOR UPDATE OF o`,
    [opId],
  )
  if (o?.status !== 'running' || o.lease_owner !== workerId || o.attempts !== attempt) return null
  return o
}

async function dropOutputs(tx: Queryable, opId: string, keep: readonly string[] = []): Promise<string[]> {
  const rows = await tx.query<{ blob_key: string }>(
    'DELETE FROM worker_op_outputs WHERE op_id = $1 AND NOT (id = ANY($2::text[])) RETURNING blob_key',
    [opId, keep],
  )
  return rows.rows.map((r) => r.blob_key)
}

async function finish(
  tx: Queryable,
  o: OpRow,
  now: Date,
  status: 'failed' | 'cancelled',
  code: WorkerOpErrorCode,
): Promise<void> {
  await tx.query(
    `UPDATE worker_ops SET status = $2, error_code = $3, lease_owner = NULL, lease_until = NULL, finished_at = $4,
        updated_at = $4
      WHERE id = $1`,
    [o.id, status, code, now],
  )
}

/**
 * Records the capabilities a worker reported (well-formed ones; at most WORKER_OP_LIMITS.maxCapabilities), at most one
 * write per capability every 30 s. Returns how many rows it wrote (0: nothing the offer could read differently).
 */
export async function recordCapabilities(
  db: Queryable,
  now: Date,
  workerId: string,
  capabilities: readonly string[],
): Promise<number> {
  const caps = [...new Set(capabilities)].slice(0, WORKER_OP_LIMITS.maxCapabilities)
  if (!caps.length) return 0
  const r = await db.query(
    `INSERT INTO worker_capabilities_seen (capability, last_seen_at, worker_id)
       SELECT c, $2, $3 FROM unnest($1::text[]) AS c
     ON CONFLICT (capability) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, worker_id = EXCLUDED.worker_id
       WHERE worker_capabilities_seen.last_seen_at < $2 - interval '30 seconds'`,
    [caps, now, workerId],
  )
  return r.rowCount
}

export interface OpExpireOutcome {
  changes: OpChange[]
  /** blobs of the outputs of running ops it failed (delete after commit) */
  orphanKeys: string[]
}

/**
 * Fails every op that cannot run (run on each claim; the changes go to the requesters' events):
 *   - a queued op of a kind whose switch is off (WORKER_UNAVAILABLE), or one overdueCodeSql names (WORKER_BUSY,
 *     WORKER_UNAVAILABLE);
 *   - a running op of a kind whose switch is off once its lease has run out (no claim may reclaim it; its reserved
 *     outputs are dropped instead of waiting for the switch to come back: review nit 4).
 */
export async function expireOps(db: Db, now: Date, switches: FormatSwitches): Promise<OpExpireOutcome> {
  const on = enabledKinds(switches)
  const { deadline, absent } = overdueCutoffs(now)
  const overdue = overdueCodeSql('o', '$2', '$3')
  return db.transaction(async (tx) => {
    const rows = await tx.query<OpRow & { code: WorkerOpErrorCode | null }>(
      `SELECT ${OP_COLUMNS},
              CASE WHEN NOT (o.kind = ANY($1::text[])) THEN 'WORKER_UNAVAILABLE' ELSE ${overdue} END AS code
         FROM worker_ops o JOIN asset_versions v ON v.id = o.source_version_id
        WHERE (o.status = 'queued' AND (NOT (o.kind = ANY($1::text[])) OR ${overdue} IS NOT NULL))
           OR (o.status = 'running' AND o.lease_until < $4 AND NOT (o.kind = ANY($1::text[])))
        ORDER BY o.run_after LIMIT 100
        FOR UPDATE OF o SKIP LOCKED`,
      [on, deadline, absent, now],
    )
    const orphanKeys: string[] = []
    for (const o of rows.rows) {
      if (o.status === 'running') orphanKeys.push(...(await dropOutputs(tx, o.id)))
      await finish(tx, o, now, 'failed', o.code ?? 'WORKER_UNAVAILABLE')
    }
    return { changes: rows.rows.map((o) => changeOf(o, 'failed')), orphanKeys }
  })
}

export interface OpClaimOutcome {
  op: ClaimedOp | null
  /** ops failed or cancelled during this claim (out of attempts, a trashed board, a source that is not ready) */
  changes: OpChange[]
  /** blobs of outputs dropped by reclaiming expired leases (delete after commit) */
  orphanKeys: string[]
}

/**
 * POST /api/worker/ops/claim: the oldest claimable op of a kind this worker can do and this api runs (queued and due,
 * or running with an expired lease), now `running` under `workerId` for the lease, attempts + 1.
 */
export async function claimOp(
  db: Db,
  now: Date,
  workerId: string,
  capabilities: readonly string[],
  switches: FormatSwitches,
): Promise<OpClaimOutcome> {
  const enabled = new Set(enabledKinds(switches))
  const kinds = claimableKinds(capabilities).filter((k) => enabled.has(k))
  const changes: OpChange[] = []
  const orphanKeys: string[] = []
  if (!kinds.length) return { op: null, changes, orphanKeys }
  for (let pass = 0; pass < 10; pass++) {
    const step = await db.transaction(async (tx) => {
      const o = await tx.maybeOne<
        OpRow & {
          board_status: string
          version_status: string
          v_kind: ClaimedOp['source']['kind']
          v_name: string
          v_mime: string
          v_size: number
          v_pages: number | null
        }
      >(
        `SELECT ${OP_COLUMNS}, b.status AS board_status, v.status AS version_status, v.kind AS v_kind,
                v.name AS v_name, v.mime_type AS v_mime, v.size_bytes::float8 AS v_size,
                CASE WHEN jsonb_typeof(v.probe -> 'pageCount') = 'number' THEN (v.probe ->> 'pageCount')::int END
                  AS v_pages
           FROM worker_ops o
           JOIN asset_versions v ON v.id = o.source_version_id
           JOIN boards b ON b.workspace_id = o.workspace_id AND b.id = o.board_id
          WHERE o.kind = ANY($2::text[])
            AND ((o.status = 'queued' AND o.run_after <= $1) OR (o.status = 'running' AND o.lease_until < $1))
          -- review M2: an op a person asked for before every op nobody asked for (the backfill's and the on-ready
          -- extract-text ops), then the oldest due first
          ORDER BY (o.requested_by IS NULL), o.run_after, o.created_at, o.id
          LIMIT 1
          FOR UPDATE OF o SKIP LOCKED`,
        [now, kinds],
      )
      if (!o) return { kind: 'none' as const }
      const dropped = await dropOutputs(tx, o.id)
      if (o.board_status !== 'active' && o.board_status !== 'archived') {
        await finish(tx, o, now, 'cancelled', 'CANCELLED')
        return { kind: 'ended' as const, change: changeOf(o, 'cancelled'), dropped }
      }
      if (o.version_status !== 'ready') {
        await finish(tx, o, now, 'failed', 'SOURCE_MISSING')
        return { kind: 'ended' as const, change: changeOf(o, 'failed'), dropped }
      }
      if (o.attempts >= WORKER_OP_LIMITS.maxAttempts) {
        await finish(tx, o, now, 'failed', 'INTERNAL')
        return { kind: 'ended' as const, change: changeOf(o, 'failed'), dropped }
      }
      const attempt = o.attempts + 1
      await tx.query(
        `UPDATE worker_ops SET status = 'running', lease_owner = $2, lease_until = $3, attempts = $4, updated_at = $5
          WHERE id = $1`,
        [o.id, workerId, leaseUntil(now), attempt, now],
      )
      const op: ClaimedOp = {
        id: o.id,
        kind: o.kind,
        capability: WORKER_CAPABILITIES[o.kind],
        boardId: o.board_id,
        workspaceId: o.workspace_id,
        sourceVersionId: o.source_version_id,
        sourceAssetId: o.asset_id,
        params: o.params,
        attempt,
        leaseMs: WORKER_OP_LIMITS.leaseMs,
        source: {
          kind: o.v_kind,
          name: o.v_name,
          mimeType: o.v_mime,
          sizeBytes: Number(o.v_size),
          pageCount: o.v_pages ?? null,
        },
      }
      return { kind: 'claimed' as const, op, dropped, change: changeOf(o, 'running') }
    })
    if (step.kind === 'none') return { op: null, changes, orphanKeys }
    orphanKeys.push(...step.dropped)
    changes.push(step.change)
    if (step.kind === 'claimed') return { op: step.op, changes, orphanKeys }
  }
  return { op: null, changes, orphanKeys }
}

/** POST /api/worker/ops/:op/heartbeat: extends the lease; LeaseLost when it is not held any more. */
export async function heartbeatOp(
  db: Queryable,
  now: Date,
  opId: string,
  workerId: string,
  attempt: number,
): Promise<{ leaseMs: number }> {
  const r = await db.query(
    `UPDATE worker_ops SET lease_until = $3, updated_at = $4
      WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND attempts = $5`,
    [opId, workerId, leaseUntil(now), now, attempt],
  )
  if (r.rowCount !== 1) throw new LeaseLost()
  return { leaseMs: WORKER_OP_LIMITS.leaseMs }
}

export interface OpOutputReservation {
  outputId: string
  blobKey: string
  mimeType: 'image/png' | 'image/webp'
  bytes: number
}

/**
 * POST /api/worker/ops/:op/output: a fresh output id and blob key for this attempt, once the kind allowed it. An
 * original gets a NEW asset and version id (its key `assets/<new ast>/<new ver>/original`); a page a derivative id under
 * the SOURCE version (`assets/<ast>/<ver>/d/<drv>.<ext>`).
 */
export async function reserveOpOutput(
  db: Db,
  now: Date,
  opId: string,
  input: WorkerOpOutputInput,
  kinds: Readonly<Record<WorkerOpKind, OpKindHandler>> = OP_KINDS,
): Promise<OpOutputReservation> {
  return db.transaction(async (tx) => {
    const o = await lockLease(tx, opId, input.workerId, input.attempt)
    if (!o) throw new LeaseLost()
    const { n } = await tx.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM worker_op_outputs WHERE op_id = $1 AND attempt = $2',
      [opId, o.attempts],
    )
    if (n >= WORKER_OP_LIMITS.maxOutputsPerOp)
      throw new OpRefused(
        400,
        'TOO_MANY_OUTPUTS',
        'This op attempt has reserved the maximum number of outputs.',
      )
    await kinds[o.kind].checkOutput(tx, lockedOf(o), input)
    const outputId = newId('wpo')
    let assetId: string
    let versionId: string
    let derivativeId: string | null = null
    let blobKey: string
    if (input.role === 'original') {
      assetId = newAssetId('ast')
      versionId = newAssetId('ver')
      blobKey = originalKey(assetId, versionId)
    } else {
      assetId = o.asset_id
      versionId = o.source_version_id
      derivativeId = newAssetId('drv')
      blobKey = derivativeKey(assetId, versionId, derivativeId, DERIVATIVE_EXT[input.mimeType])
    }
    await tx.query(
      `INSERT INTO worker_op_outputs (id, op_id, attempt, role, page, width, height, mime_type, bytes, asset_id,
                                      version_id, derivative_id, blob_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        outputId,
        opId,
        o.attempts,
        input.role,
        input.page ?? null,
        input.width,
        input.height,
        input.mimeType,
        input.bytes,
        assetId,
        versionId,
        derivativeId,
        blobKey,
        now,
      ],
    )
    return { outputId, blobKey, mimeType: input.mimeType, bytes: input.bytes }
  })
}

/** POST /api/worker/ops/:op/text: a batch of extracted pages, under the lease, stored by the kind (extract-text). */
export async function acceptOpText(
  db: Db,
  now: Date,
  opId: string,
  input: WorkerOpTextInput,
  kinds: Readonly<Record<WorkerOpKind, OpKindHandler>> = OP_KINDS,
): Promise<{ pages: number }> {
  const chars = input.pages.reduce((s, p) => s + p.body.length, 0)
  if (chars > FILE_TEXT_LIMITS.maxPageChars * WORKER_OP_LIMITS.textPagesPerCall)
    throw new OpRefused(400, 'TEXT_TOO_LARGE', 'This batch of text is too large.')
  return db.transaction(async (tx) => {
    const o = await lockLease(tx, opId, input.workerId, input.attempt)
    if (!o) throw new LeaseLost()
    await kinds[o.kind].acceptText(tx, lockedOf(o), input, now)
    return { pages: input.pages.length }
  })
}

export interface OpCompleteOutcome {
  status: WorkerOpStatus
  repeated: boolean
  change: OpChange | null
  orphanKeys: string[]
  versionChanges: { versionId: string; assetId: string; boardId: string; workspaceId: string }[]
}

interface OutputRow {
  id: string
  role: 'original' | 'page'
  page: number | null
  width: number
  height: number
  mime_type: 'image/png' | 'image/webp'
  bytes: number
  asset_id: string
  version_id: string
  derivative_id: string | null
  blob_key: string
}

/**
 * POST /api/worker/ops/:op/complete: every listed output must be a reservation of this attempt whose blob exists with
 * the reserved size (and type, when the store reports one); then the kind's completer writes its rows and the op is
 * done, in one transaction. Repeating a completed call of the same worker and attempt answers the stored status.
 */
export async function completeOp(
  db: Db,
  blobs: BlobHead & OutputReader,
  now: Date,
  opId: string,
  input: WorkerOpCompleteInput,
  kinds: Readonly<Record<WorkerOpKind, OpKindHandler>> = OP_KINDS,
): Promise<OpCompleteOutcome> {
  const repeatOf = (o: { status: WorkerOpStatus; lease_owner: string | null; attempts: number } | null) =>
    o && o.status === 'done' && o.lease_owner === input.workerId && o.attempts === input.attempt
      ? { status: o.status, repeated: true, change: null, orphanKeys: [], versionChanges: [] }
      : null
  const current = await db.maybeOne<{
    status: WorkerOpStatus
    lease_owner: string | null
    attempts: number
    kind: WorkerOpKind
  }>('SELECT status, lease_owner, attempts, kind FROM worker_ops WHERE id = $1', [opId])
  const repeated = repeatOf(current)
  if (repeated) return repeated
  if (
    current?.status !== 'running' ||
    current.lease_owner !== input.workerId ||
    current.attempts !== input.attempt
  )
    throw new LeaseLost()
  const resultBytes = Buffer.byteLength(JSON.stringify(input.result))
  if (resultBytes > WORKER_OP_LIMITS.resultBytes)
    throw new OpRefused(400, 'RESULT_TOO_LARGE', 'The op result is too large.')

  const listed = input.outputs
  if (new Set(listed).size !== listed.length)
    throw new OpRefused(400, 'DUPLICATE_OUTPUT', 'Each output is listed once.')
  let outputs: OutputRow[] = []
  if (listed.length) {
    outputs = (
      await db.query<OutputRow>(
        `SELECT id, role, page, width, height, mime_type, bytes::float8 AS bytes, asset_id, version_id, derivative_id,
                blob_key
           FROM worker_op_outputs WHERE op_id = $1 AND attempt = $2 AND id = ANY($3::text[])`,
        [opId, input.attempt, listed],
      )
    ).rows
    if (outputs.length !== listed.length)
      throw new OpRefused(400, 'UNKNOWN_OUTPUT', 'A listed output was not reserved for this op attempt.')
    const heads = await Promise.all(outputs.map((r) => blobs.head(r.blob_key)))
    heads.forEach((h, i) => {
      const r = outputs[i] as OutputRow
      const type = h?.contentType?.split(';')[0]?.trim().toLowerCase()
      if (
        !h ||
        h.contentLength !== Number(r.bytes) ||
        (type && type !== 'application/octet-stream' && type !== r.mime_type)
      )
        throw new OpRefused(409, 'OUTPUT_MISSING', 'A listed output was not uploaded with its reserved size.')
    })
  }
  const byId = new Map(outputs.map((r) => [r.id, r]))
  const published: PublishedOutput[] = listed.map((id) => {
    const r = byId.get(id) as OutputRow
    return {
      id: r.id,
      role: r.role,
      page: r.page,
      width: r.width,
      height: r.height,
      mimeType: r.mime_type,
      bytes: Number(r.bytes),
      assetId: r.asset_id,
      versionId: r.version_id,
      derivativeId: r.derivative_id,
      blobKey: r.blob_key,
    }
  })
  // the kind's own check of the stored bytes (remove-bg: their sha256), outside the transaction like the heads above
  const kind = kinds[current.kind]
  if (kind.verify) await kind.verify(blobs, { outputs: published, result: input.result })

  return db.transaction(async (tx) => {
    const o = await lockLease(tx, opId, input.workerId, input.attempt)
    if (!o) {
      const again = await tx.maybeOne<{
        status: WorkerOpStatus
        lease_owner: string | null
        attempts: number
      }>('SELECT status, lease_owner, attempts FROM worker_ops WHERE id = $1', [opId])
      const r = repeatOf(again)
      if (r) return r
      throw new LeaseLost()
    }
    const done = await kinds[o.kind].complete(tx, lockedOf(o), {
      outputs: published,
      result: input.result,
      now,
    })
    const stored = JSON.stringify(done.result)
    if (Buffer.byteLength(stored) > WORKER_OP_LIMITS.resultBytes)
      throw new OpRefused(400, 'RESULT_TOO_LARGE', 'The op result is too large.')
    await tx.query(
      `UPDATE worker_ops SET status = 'done', lease_until = NULL, result = $2::jsonb, result_version_id = $3,
          finished_at = $4, updated_at = $4
        WHERE id = $1`,
      [opId, stored, done.resultVersionId ?? null, now],
    )
    // published outputs became the kind's rows; every other reservation (unlisted, or listed but not adopted by the
    // kind) is dropped and its blob deleted after commit
    const unpublished = new Set(done.unpublished ?? [])
    const orphanKeys = await dropOutputs(
      tx,
      opId,
      listed.filter((id) => !unpublished.has(id)),
    )
    await tx.query('DELETE FROM worker_op_outputs WHERE op_id = $1', [opId])
    return {
      status: 'done' as const,
      repeated: false,
      change: changeOf(o, 'done'),
      orphanKeys,
      versionChanges: done.versionChanges ?? [],
    }
  })
}

export interface OpFailOutcome {
  status: WorkerOpStatus
  change: OpChange
  orphanKeys: string[]
}

/**
 * POST /api/worker/ops/:op/fail: `release` hands it back at once (a shutdown; the attempt not counted); `retry` queues it
 * again after backoffMs(attempt) while attempts remain; otherwise it fails with the worker's code as users see it
 * (contracts opFailureCode: an unknown code is INTERNAL).
 */
export async function failOp(
  db: Db,
  now: Date,
  opId: string,
  input: WorkerOpFailInput,
): Promise<OpFailOutcome> {
  return db.transaction(async (tx) => {
    const o = await lockLease(tx, opId, input.workerId, input.attempt)
    if (!o) throw new LeaseLost()
    const orphanKeys = await dropOutputs(tx, opId)
    if (input.release || (input.retry && o.attempts < WORKER_OP_LIMITS.maxAttempts)) {
      const attempts = input.release ? Math.max(0, o.attempts - 1) : o.attempts
      const runAfter = input.release ? now : new Date(now.getTime() + backoffMs(o.attempts))
      await tx.query(
        `UPDATE worker_ops SET status = 'queued', attempts = $2, run_after = $3, lease_owner = NULL, lease_until = NULL,
            updated_at = $4
          WHERE id = $1`,
        [opId, attempts, runAfter, now],
      )
      return { status: 'queued' as const, change: changeOf(o, 'queued'), orphanKeys }
    }
    await finish(tx, o, now, 'failed', opFailureCode(input.code))
    return { status: 'failed' as const, change: changeOf(o, 'failed'), orphanKeys }
  })
}

/** The source original of a running op (fs-mode blob GET). */
export async function runningOpSource(
  q: Queryable,
  opId: string,
): Promise<{ assetId: string; versionId: string } | null> {
  return q.maybeOne<{ assetId: string; versionId: string }>(
    `SELECT v.asset_id AS "assetId", v.id AS "versionId"
       FROM worker_ops o JOIN asset_versions v ON v.id = o.source_version_id
      WHERE o.id = $1 AND o.status = 'running'`,
    [opId],
  )
}

/** A live output reservation (fs-mode blob PUT): its key, size and type. */
export async function liveOpOutput(
  q: Queryable,
  outputId: string,
): Promise<{ blobKey: string; bytes: number; mimeType: string } | null> {
  return q.maybeOne<{ blobKey: string; bytes: number; mimeType: string }>(
    `SELECT r.blob_key AS "blobKey", r.bytes::float8 AS bytes, r.mime_type AS "mimeType"
       FROM worker_op_outputs r
       JOIN worker_ops o ON o.id = r.op_id AND o.status = 'running' AND o.attempts = r.attempt
      WHERE r.id = $1`,
    [outputId],
  )
}
