// Routes of automatic checkpoints and retention (docs/WAVE4-CONTRACTS.md checkpoints-2):
//
//   GET    /api/snapshots/:sid/content              preview a checkpoint (any kind)
//   DELETE /api/snapshots/:sid                      board owners delete a checkpoint (audited)
//   GET    /internal/boards/:bid/session-ended?at=  the sync server: the last editor left after changes
//   (hook) GET /internal/boards/:bid/touched        the sync server's edit report (routes/boards.ts owns
//                                                   the route; this listens to its answers)
//
// Who may do what (every check is here, server-side; the UI only mirrors it):
//   list (index.ts)  anyone who can view the board (names, times and reasons only), except name-only
//                    guests: 403 GUEST_ACCOUNT_REQUIRED (DANA-05; saving one is refused to them too)
//   preview          view on the board AND a workspace membership above guest: the people who could
//                    restore it as a new board anyway. Workspace guests and name-only guests get 403:
//                    a checkpoint can hold content removed before the board was shared with them
//                    (the same reasoning as "Recently deleted", authz-001).
//   delete           the board's owners (manage_access; archived boards included), never a guest.
//   restore          unchanged (index.ts: view + workspace member + export policy).
//
// A v1 (tldraw) body is previewed on the new canvas as the elements the converter makes of it
// (PARITY-5.5, docs/EXCALIDRAW-MIGRATION.md §5.5 "v1 is converted on read"): the converter a restore as a
// new board uses at the seed (packages/tldraw-import, apps/sync/src/room-internal/seed.ts), on read, the
// stored body never rewritten. The answer is a lobby-elements payload marked `converted`. A body the
// converter cannot read keeps the v1 answer (the records), and so does an api on the tldraw sync.
//
// The conversion runs on the api's event loop (about 90 microseconds per record for notes, about 65 ms per
// MiB of body for strokes, measured), so it is bounded twice: a v1 body of more than
// `previewSettings.maxRecords` records, or whose stored body is larger than `previewSettings.maxBodyBytes`,
// is not converted at all and answers "too large to preview" (the v1 shape with no records and no format,
// which the web already shows as "can't be previewed here yet; restoring it as a new board still works").
// Both are decided from the row's own record count and size_bytes before the body is even read (the body's
// own size and count are checked again once it is, in case a row was wrong). What was converted is kept in
// a small LRU by checkpoint id (a preview opened again, by anyone who may open it, is not converted
// again), and so is the too-large answer. Both are decided after the access checks, so nothing is served
// to someone who may not see it.

import { installedServerTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { ELEMENT_SCHEMA_VERSION } from '@draftroom/canvas-schema/protocol'
import { type CheckpointContent, SNAPSHOT_ID_PATTERN } from '@draftroom/contracts'
import { can, canCreateInWorkspace } from '@draftroom/permissions'
import { convertBoard, migrateRecords, type TlRecord } from '@draftroom/tldraw-import'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { type BoardAccess, isBoardId, requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import { onNewCanvas } from '../../canvas-engine.ts'
import type { Params } from '../../context.ts'
import { forbidden, gone, notFound, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import type { CheckpointService } from './checkpoints.ts'
import {
  isNewCanvasRow,
  newCanvasCheckpoint,
  readCheckpointBody,
  SNAPSHOT_COLUMNS,
  SNAPSHOT_FROM,
  type SnapshotRow,
  toCheckpoint,
} from './snapshot-rows.ts'
import type { SnapshotBodies } from './snapshot-store.ts'

/** The sync server's edit report (apps/api/src/routes/boards.ts). */
export const TOUCHED_ROUTE = '/internal/boards/:bid/touched'
export const SESSION_ENDED_ROUTE = '/internal/boards/:bid/session-ended'

const AtQuery = z.object({ at: z.coerce.number().int().min(0).max(8.64e15).optional() })

/**
 * A v1 body's records as the new canvas's elements and board document, for the preview (PARITY-5.5), or
 * null when the converter cannot read them (a schema newer than it, a record it refuses): the preview then
 * answers the records as before. Codes only, never board content, reach the log.
 */
export function convertV1ForPreview(
  body: { readonly schema: unknown; readonly records: readonly Record<string, unknown>[] },
  now: number,
): { elements: Record<string, unknown>[]; doc: Record<string, unknown> } | null {
  const migrated = migrateRecords(body.records, body.schema)
  if (!migrated.ok) return null
  const metrics = installedServerTextMetrics() ?? installServerTextMetrics()
  const conv = convertBoard(migrated.records as TlRecord[], { updatedAt: now, metrics })
  if (conv.failures.length) return null
  const doc: Record<string, unknown> = {}
  if (conv.doc.startView) doc.startView = conv.doc.startView
  if (conv.doc.workshop) doc.workshop = conv.doc.workshop
  for (const [key, def] of Object.entries(conv.doc.tagDefs)) doc[`tagDef:${key}`] = def
  return { elements: conv.elements as unknown as Record<string, unknown>[], doc }
}

/**
 * What bounds a v1 preview (PARITY-5.5). A conversion costs by what is in the records, not only by how
 * many there are, so a checkpoint is converted only within BOTH bounds: `maxRecords` and `maxBodyBytes`.
 * Measured warm on a 64-core desktop (wave E; convertV1ForPreview, the median of five runs; the wave-D
 * review's own timings agree):
 *   - notes with a short label: 87 to 93 microseconds a record (1,000 records 93 ms, 2,000 records 174 ms;
 *     a body of 0.46 MiB per 1,000 records);
 *   - freehand strokes: 60 to 70 ms per MiB of stored body, whatever the record count (1,000 strokes of 400
 *     points, 3.4 MiB: 233 ms; 2,000 strokes of 400 points, 6.8 MiB: 409 ms; 300 strokes of 1,000 points,
 *     2.4 MiB: 156 ms). The 55 to 85 microseconds a record that the wave-B comments quoted hold for notes
 *     only, and not even for those.
 * So at the two bounds one conversion takes about 100 ms (1,000 notes) to 175 ms (2.5 MiB of strokes) on that
 * machine, near the `slowMs` it is asked to stay under. A smaller, slower core (a hosted api) takes longer
 * by a factor nobody has measured here: `checkpoint.preview.slow` on staging shows whether the bounds are
 * right. `maxBodyBytes` is compared with the row's size_bytes (the stored JSON, in bytes) before the body
 * is read.
 * `cacheEntries` / `cacheBytes`: the LRU of converted answers. The cost of one is twice the stored body's
 * size (the converted JSON measured 1.9 times it), so 16 MiB is about three boards at the size bound (more
 * at typical sizes); one that alone would take half the budget is not kept (none within the bound is).
 * A mutable object, like `checkpointSettings`, so tests can lower it.
 */
export const previewSettings = {
  maxRecords: 1_000,
  maxBodyBytes: 2.5 * 1024 * 1024,
  cacheEntries: 8,
  cacheBytes: 16 * 1024 * 1024,
  /** A conversion slower than this is logged (counts only), so staging shows whether the cap is right. */
  slowMs: 200,
}

type PreviewOutcome =
  | { kind: 'converted'; elements: Record<string, unknown>[]; doc: Record<string, unknown> }
  | { kind: 'too-large' }

/**
 * A least-recently-used cache of v1 preview outcomes by checkpoint id, bounded by entries and by the
 * summed cost (bytes). An entry remembers the storage key it was made from and is dropped when the row
 * now points elsewhere (a body is never rewritten, so this is only a guard).
 */
export class PreviewCache {
  private readonly map = new Map<string, { storageKey: string; cost: number; outcome: PreviewOutcome }>()
  private total = 0

  get(id: string, storageKey: string): PreviewOutcome | null {
    const hit = this.map.get(id)
    if (!hit) return null
    this.map.delete(id)
    if (hit.storageKey !== storageKey) {
      this.total -= hit.cost
      return null
    }
    this.map.set(id, hit) // most recently used goes last
    return hit.outcome
  }

  set(id: string, storageKey: string, cost: number, outcome: PreviewOutcome): void {
    const { cacheEntries, cacheBytes } = previewSettings
    const old = this.map.get(id)
    if (old) {
      this.total -= old.cost
      this.map.delete(id)
    }
    if (cacheEntries < 1 || cost > cacheBytes / 2) return
    this.map.set(id, { storageKey, cost, outcome })
    this.total += cost
    for (const [key, entry] of this.map) {
      if (this.map.size <= cacheEntries && this.total <= cacheBytes) break
      if (key === id) continue // never evict what was just stored
      this.map.delete(key)
      this.total -= entry.cost
    }
  }

  get size(): number {
    return this.map.size
  }
}

/** Previews carry a whole board: per client, per minute (like the other heavy history routes). */
const PREVIEW_LIMIT = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }
const DELETE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: 60_000 } } }

const GUEST_PREVIEW = 'Guests can’t open earlier versions of a board. Ask the board’s owner for a copy.'
const OWNERS_DELETE = 'Only the board’s owners can delete checkpoints.'

export function registerCheckpointRoutes(
  app: FastifyInstance,
  ctx: FeatureContext,
  checkpoints: CheckpointService,
  bodies: SnapshotBodies,
): void {
  const { db } = ctx
  const previews = new PreviewCache()

  /** The time a sync report names, never later than this server's clock (like the touched route). */
  const reportedAt = (req: FastifyRequest): Date => {
    const current = ctx.now().getTime()
    const parsed = AtQuery.safeParse(req.query)
    const at = parsed.success ? parsed.data.at : undefined
    return new Date(Math.min(at ?? current, current))
  }

  /** A checkpoint the caller can see (404 otherwise: no existence leak), with the board's access. */
  async function visibleCheckpoint(
    req: FastifyRequest,
    user: { id: string },
  ): Promise<{ row: SnapshotRow; access: BoardAccess }> {
    const { sid = '' } = req.params as Params
    if (!SNAPSHOT_ID_PATTERN.test(sid)) throw notFound()
    const row = await db.maybeOne<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_FROM} WHERE s.id = $1`,
      [sid],
    )
    if (!row) throw notFound()
    const access = await requireBoardAction(db, row.board_id, user.id, 'view')
    if (row.workspace_id !== access.board.workspace_id) throw notFound()
    return { row, access }
  }

  /** A workspace member above guest, and not a name-only guest account. */
  async function isWorkspacePerson(access: BoardAccess, userId: string): Promise<boolean> {
    if (!canCreateInWorkspace(access.workspaceRole)) return false
    return (await userKind(db, userId)) !== 'guest'
  }

  // ---- the sync server's reports -------------------------------------------------------------------

  // Every accepted canvas write reaches the api here (throttled to one report per board per minute by
  // the sync server). The route itself checks the internal secret and answers 204 only when it passed.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' || reply.statusCode !== 204 || req.routeOptions.url !== TOUCHED_ROUTE) return
    const { bid = '' } = req.params as Params
    if (!isBoardId(bid)) return
    try {
      await checkpoints.changed(bid, reportedAt(req))
    } catch (e) {
      req.log.warn({ err: { message: (e as Error)?.message } }, 'checkpoint change not recorded')
    }
  })

  // A GET, like touched: the root CSRF hook refuses POSTs without the web Origin. Idempotent: a repeat
  // only moves the session end later, and the checkpoint compares content before it saves anything.
  app.get(SESSION_ENDED_ROUTE, async (req, reply) => {
    // The internal secret is checked by the root guard (app.ts registerInternalSecretGuard).
    const { bid = '' } = req.params as Params
    parse(AtQuery, req.query)
    if (!isBoardId(bid)) throw notFound()
    await checkpoints.sessionEnded(bid, reportedAt(req))
    return reply.code(204).send()
  })

  // ---- preview ----------------------------------------------------------------------------------------

  /** A v1 checkpoint's preview as the web draws it: the converted elements, marked `converted`. */
  function v1Answer(snapshot: CheckpointContent['snapshot'], outcome: PreviewOutcome): CheckpointContent {
    if (outcome.kind === 'too-large') return noPreview(snapshot)
    return {
      snapshot,
      schema: ELEMENT_SCHEMA_VERSION,
      records: [],
      format: 'lobby-elements',
      elements: outcome.elements as NonNullable<CheckpointContent['elements']>,
      doc: outcome.doc,
      converted: true,
    }
  }

  /**
   * "Too large to preview": the v1 shape with nothing in it (no format, no records, no schema), which the
   * web shows as "can't be previewed here yet; restoring it as a new board still works". Remembered, so
   * the next request does not even read the body. Counts only reach the log.
   */
  function tooLargeToPreview(
    req: FastifyRequest,
    snapshot: CheckpointContent['snapshot'],
    row: SnapshotRow,
    size: { records: number; bytes: number },
  ): CheckpointContent {
    previews.set(row.id, row.storage_key, 1, { kind: 'too-large' })
    req.log.info(
      {
        evt: 'checkpoint.preview.too_large',
        records: size.records,
        bytes: size.bytes,
        max: previewSettings.maxRecords,
        maxBytes: previewSettings.maxBodyBytes,
      },
      'v1 checkpoint too large to preview',
    )
    return noPreview(snapshot)
  }
  /** Whether a v1 body of this many records and stored bytes is past either bound of the preview. */
  const pastPreviewBounds = (records: number, bytes: number) =>
    records > previewSettings.maxRecords || bytes > previewSettings.maxBodyBytes
  const noPreview = (snapshot: CheckpointContent['snapshot']): CheckpointContent => ({
    snapshot,
    schema: null,
    records: [],
  })

  app.get('/api/snapshots/:sid/content', PREVIEW_LIMIT, async (req, reply): Promise<CheckpointContent> => {
    const user = await ctx.requireUser(req)
    const { row, access } = await visibleCheckpoint(req, user)
    if (!(await isWorkspacePerson(access, user.id))) throw forbidden(GUEST_PREVIEW)
    // Bridge release R0: a row marked as made on the new canvas (body_version 2; never written on this
    // branch yet, snapshot-rows.ts); previewed after the switch.
    if (isNewCanvasRow(row) && !(await onNewCanvas(ctx))) throw newCanvasCheckpoint()
    reply.header('cache-control', 'private, no-store')
    const newCanvas = await onNewCanvas(ctx)
    const snapshot = toCheckpoint(row, { newCanvas: !newCanvas })
    // A v1 row on the new canvas: what is already known (converted before, or too large), and the row's
    // own record count and stored size, decide before the body is read or parsed.
    const v1Row = newCanvas && !isNewCanvasRow(row)
    if (v1Row) {
      const known = previews.get(row.id, row.storage_key)
      if (known) return v1Answer(snapshot, known)
      const records = Number(row.record_count)
      const bytes = Number(row.size_bytes)
      if (pastPreviewBounds(records, bytes)) return tooLargeToPreview(req, snapshot, row, { records, bytes })
    }
    const raw = await bodies.read(row.storage_key)
    if (raw === null) throw gone("This checkpoint's saved content is no longer available.")
    // The body's own size, before it is parsed, in case the row's was wrong (a v2 body is not bounded here).
    const rawBytes = v1Row ? Buffer.byteLength(raw, 'utf8') : 0
    if (v1Row && pastPreviewBounds(0, rawBytes))
      return tooLargeToPreview(req, snapshot, row, { records: Number(row.record_count), bytes: rawBytes })
    const body = readCheckpointBody(raw)
    // v2 (Excalidraw engine): elements and the board document
    if (body.version === 2)
      return {
        snapshot,
        schema: body.schema,
        records: [],
        format: 'lobby-elements',
        elements: body.elements as NonNullable<CheckpointContent['elements']>,
        doc: body.doc,
      }
    // v1 on the new canvas: converted on read (PARITY-5.5), within the cap, once per checkpoint
    if (newCanvas) {
      // the body's own count, in case the row's was wrong
      if (pastPreviewBounds(body.records.length, rawBytes))
        return tooLargeToPreview(req, snapshot, row, { records: body.records.length, bytes: rawBytes })
      // a concurrent request may have converted it while this one read the body
      const known = previews.get(row.id, row.storage_key)
      if (known) return v1Answer(snapshot, known)
      let converted: ReturnType<typeof convertV1ForPreview> = null
      const started = performance.now()
      try {
        converted = convertV1ForPreview(body, ctx.now().getTime())
      } catch (e) {
        req.log.warn({ err: { name: (e as Error)?.name } }, 'v1 checkpoint preview not converted')
      }
      const ms = Math.round(performance.now() - started)
      if (ms > previewSettings.slowMs)
        req.log.warn(
          {
            evt: 'checkpoint.preview.slow',
            ms,
            records: body.records.length,
            bytes: rawBytes,
            max: previewSettings.maxRecords,
            maxBytes: previewSettings.maxBodyBytes,
          },
          'v1 checkpoint preview conversion was slow',
        )
      if (converted) {
        const outcome: PreviewOutcome = { kind: 'converted', ...converted }
        previews.set(row.id, row.storage_key, 2 * (Number(row.size_bytes) || raw.length), outcome)
        return v1Answer(snapshot, outcome)
      }
    }
    // v1: the tldraw records, as before
    return { snapshot, schema: body.schema, records: body.records as CheckpointContent['records'] }
  })

  // ---- deletion ------------------------------------------------------------------------------------

  app.delete('/api/snapshots/:sid', DELETE_LIMIT, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { row, access } = await visibleCheckpoint(req, user)
    if (
      !can(access.role, 'manage_access', access.board.status) ||
      !(await isWorkspacePerson(access, user.id))
    )
      throw forbidden(OWNERS_DELETE)
    const removed = await checkpoints.remove(row.board_id, [row.id], {
      onlyAuto: false,
      audit: { actorId: user.id },
    })
    if (!removed.length) throw notFound() // deleted meanwhile (another owner, or retention)
    return reply.code(204).send()
  })
}
