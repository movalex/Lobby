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

  app.get('/api/snapshots/:sid/content', PREVIEW_LIMIT, async (req, reply): Promise<CheckpointContent> => {
    const user = await ctx.requireUser(req)
    const { row, access } = await visibleCheckpoint(req, user)
    if (!(await isWorkspacePerson(access, user.id))) throw forbidden(GUEST_PREVIEW)
    // Bridge release R0: a row marked as made on the new canvas (body_version 2; never written on this
    // branch yet, snapshot-rows.ts); previewed after the switch.
    if (isNewCanvasRow(row) && !(await onNewCanvas(ctx))) throw newCanvasCheckpoint()
    const raw = await bodies.read(row.storage_key)
    if (raw === null) throw gone("This checkpoint's saved content is no longer available.")
    const body = readCheckpointBody(raw)
    reply.header('cache-control', 'private, no-store')
    const newCanvas = await onNewCanvas(ctx)
    const snapshot = toCheckpoint(row, { newCanvas: !newCanvas })
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
    // v1 on the new canvas: converted on read (PARITY-5.5)
    if (newCanvas) {
      let converted: ReturnType<typeof convertV1ForPreview> = null
      try {
        converted = convertV1ForPreview(body, ctx.now().getTime())
      } catch (e) {
        req.log.warn({ err: { name: (e as Error)?.name } }, 'v1 checkpoint preview not converted')
      }
      if (converted)
        return {
          snapshot,
          schema: ELEMENT_SCHEMA_VERSION,
          records: [],
          format: 'lobby-elements',
          elements: converted.elements as NonNullable<CheckpointContent['elements']>,
          doc: converted.doc,
          converted: true,
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
