// Feature module: history (docs/FEATURES-M2-CONTRACTS.md "history"; checklist REV-07, REV-08, DSH-02,
// DSH-03, PRS-06 export archive). Named checkpoints, restore-as-new / duplicate / import (new private
// boards), board export, and the "Recently deleted" proxy to the sync server. Every decision goes
// through access.ts (packages/permissions); 404 whenever the caller cannot see the board.

import { draftroomSchema } from '@draftroom/canvas-schema'
import {
  type BoardSnapshot,
  CreateSnapshotInput,
  DuplicateBoardInput,
  HISTORY_EVENTS,
  IMPORT_BODY_LIMIT_BYTES,
  ImportBoardQuery,
  RestoreDeletedInput,
  RestoreSnapshotInput,
  SNAPSHOT_ID_PATTERN,
  type SnapshotKind,
} from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { can, canCreateInWorkspace } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction, requireProjectInWorkspace, requireWorkspaceRole } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, forbidden, gone, notFound, parse } from '../../errors.ts'
import { contentDisposition } from '../../files/disposition.ts'
import { toBoardWithRole } from '../../serialize.ts'
import type { FeatureContext } from '../context.ts'
import { ArchiveError, exportBoardArchive, importBoardArchive, type SerializedSchema } from './board-ops.ts'
import { archiveRef, filesShownOn, filesViewableBy, referencedFiles } from './files.ts'
import { createBoardFrom, viaSync } from './new-board.ts'
import { snapshotBodies, snapshotStorageKey } from './snapshot-store.ts'
import { createDeletedApi } from './sync-deleted.ts'

/** Checkpoints kept per board (a board past it must be asked to prune; none do yet). */
export const MAX_SNAPSHOTS_PER_BOARD = 500
const MAX_LISTED = 500
/** Heavy routes (a full board copy each): per client, per minute. */
const HEAVY = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }

interface SnapshotRow {
  id: string
  workspace_id: string
  board_id: string
  name: string
  kind: SnapshotKind
  created_by: string | null
  creator_name: string | null
  created_at: Date
  document_clock: number
  record_count: number
  size_bytes: number
  storage_key: string
}

const SNAPSHOT_COLUMNS = `s.id, s.workspace_id, s.board_id, s.name, s.kind, s.created_by, u.name AS creator_name,
  s.created_at, s.document_clock::float8 AS document_clock, s.record_count, s.size_bytes::float8 AS size_bytes, s.storage_key`

const toSnapshot = (r: SnapshotRow): BoardSnapshot => ({
  id: r.id,
  boardId: r.board_id,
  name: r.name,
  kind: r.kind,
  createdBy: r.created_by ? { id: r.created_by, name: r.creator_name ?? '' } : null,
  createdAt: r.created_at.toISOString(),
  documentClock: Number(r.document_clock),
  recordCount: Number(r.record_count),
  sizeBytes: Number(r.size_bytes),
})

/** The stored checkpoint body (object store). */
interface CheckpointBody {
  format: 'draftroom-checkpoint'
  version: 1
  boardId: string
  documentClock: number
  schema: unknown
  documents: { state: Record<string, unknown>; lastChangedClock: number }[]
}

const clip = (s: string, max = 120) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

export async function registerHistory(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db } = ctx
  const bodies = snapshotBodies(ctx.blobs, ctx.layout.root)
  const deleted = createDeletedApi(ctx)
  const warn = (message: string) => app.log.warn({ feature: 'history' }, message)

  /** The caller may create boards in the workspace (members and above; guests may not). */
  async function requireCreator(workspaceId: string, userId: string) {
    const role = await requireWorkspaceRole(db, workspaceId, userId)
    if (!canCreateInWorkspace(role)) throw forbidden('Only workspace members can create boards.')
  }

  // ---- checkpoints -------------------------------------------------------------------------------

  app.get('/api/boards/:bid/snapshots', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const rows = await db.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM board_snapshots s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.board_id = $1 AND s.workspace_id = $2
        ORDER BY s.created_at DESC, s.id DESC LIMIT ${MAX_LISTED}`,
      [bid, access.board.workspace_id],
    )
    return { snapshots: rows.rows.map(toSnapshot) }
  })

  app.post('/api/boards/:bid/snapshots', HEAVY, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(CreateSnapshotInput, req.body)
    const access = await requireBoardAction(db, bid, user.id, 'edit')
    const workspaceId = access.board.workspace_id
    const { n } = await db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM board_snapshots WHERE board_id = $1',
      [bid],
    )
    if (n >= MAX_SNAPSHOTS_PER_BOARD)
      throw conflict('SNAPSHOT_LIMIT', `A board keeps at most ${MAX_SNAPSHOTS_PER_BOARD} checkpoints.`)

    const snap = await viaSync(() => ctx.sync.snapshot(bid))
    const documents = (Array.isArray(snap.documents) ? snap.documents : []).map((d) => ({
      state: d.state,
      lastChangedClock: Number(d.lastChangedClock ?? 0),
    }))
    const documentClock = Math.max(0, Math.floor(Number(snap.documentClock ?? 0)) || 0)
    const id = newId('snp')
    const key = snapshotStorageKey(bid, id)
    const body: CheckpointBody = {
      format: 'draftroom-checkpoint',
      version: 1,
      boardId: bid,
      documentClock,
      schema: snap.schema,
      documents,
    }
    const json = JSON.stringify(body)
    await bodies.write(key, json)
    let row: SnapshotRow
    try {
      const inserted = await db.one<{ id: string }>(
        `INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, created_by, created_at, document_clock, record_count, size_bytes, storage_key)
         VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          id,
          workspaceId,
          bid,
          input.name,
          user.id,
          ctx.now(),
          documentClock,
          documents.length,
          Buffer.byteLength(json),
          key,
        ],
      )
      row = await db.one<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM board_snapshots s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`,
        [inserted.id],
      )
    } catch (e) {
      await bodies
        .remove(key)
        .catch((e: unknown) => warn(`checkpoint body cleanup failed: ${(e as Error)?.name ?? 'Error'}`))
      throw e
    }
    ctx.events.publish(bid, { type: HISTORY_EVENTS.snapshot, data: { snapshotId: id } })
    reply.code(201)
    return toSnapshot(row)
  })

  app.post('/api/snapshots/:sid/restore-as-new', HEAVY, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { sid = '' } = req.params as Params
    const input = parse(RestoreSnapshotInput, req.body ?? {})
    if (!SNAPSHOT_ID_PATTERN.test(sid)) throw notFound()
    const snapshot = await db.maybeOne<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM board_snapshots s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`,
      [sid],
    )
    if (!snapshot) throw notFound()
    // Seeing the checkpoint = seeing its board (404 otherwise: no existence leak).
    const access = await requireBoardAction(db, snapshot.board_id, user.id, 'view')
    const workspaceId = access.board.workspace_id
    if (snapshot.workspace_id !== workspaceId) throw notFound()
    await requireCreator(workspaceId, user.id)
    const raw = await bodies.read(snapshot.storage_key)
    if (raw === null) throw gone("This checkpoint's saved content is no longer available.")
    const body = JSON.parse(raw) as CheckpointBody
    const records = (body.documents ?? []).map((d) => d.state)
    const { shown, notShown } = await filesShownOn(
      db,
      workspaceId,
      snapshot.board_id,
      referencedFiles(records),
    )
    const board = await createBoardFrom(
      ctx,
      {
        userId: user.id,
        workspaceId,
        projectId: access.board.project_id,
        title: input.title ?? clip(`${access.board.title} (${snapshot.name})`),
        records,
        schema: body.schema,
        files: shown,
        via: 'restore',
        from: { boardId: snapshot.board_id, snapshotId: snapshot.id },
      },
      warn,
    )
    reply.code(201)
    return created(board, shown.length, notShown)
  })

  app.post('/api/boards/:bid/duplicate', HEAVY, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(DuplicateBoardInput, req.body ?? {})
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const workspaceId = access.board.workspace_id
    await requireCreator(workspaceId, user.id)
    if (input.keepSharing && !can(access.role, 'manage_access', access.board.status))
      throw forbidden('Only the board owner can copy its sharing settings.')
    const snap = await viaSync(() => ctx.sync.snapshot(bid))
    const records = (Array.isArray(snap.documents) ? snap.documents : []).map((d) => d.state)
    const { shown, notShown } = await filesShownOn(db, workspaceId, bid, referencedFiles(records))
    const board = await createBoardFrom(
      ctx,
      {
        userId: user.id,
        workspaceId,
        projectId: access.board.project_id,
        title: input.title ?? clip(`Copy of ${access.board.title}`),
        records,
        schema: snap.schema,
        files: shown,
        shareLike: input.keepSharing ? { boardId: bid, visibility: access.board.visibility } : undefined,
        via: 'duplicate',
        from: { boardId: bid },
      },
      warn,
    )
    reply.code(201)
    return created(board, shown.length, notShown)
  })

  // ---- portable archive (PRS-06 export part, PRS-11) --------------------------------------------

  app.get('/api/boards/:bid/export', HEAVY, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const snap = await viaSync(() => ctx.sync.snapshot(bid))
    const records = (Array.isArray(snap.documents) ? snap.documents : []).map((d) => d.state)
    const { shown, versions } = await filesShownOn(
      db,
      access.board.workspace_id,
      bid,
      referencedFiles(records),
    )
    const assets = shown.flatMap((f) => {
      const version = versions.get(`${f.assetId}/${f.versionId}`)
      const ref = version ? archiveRef(version) : null
      return ref ? [ref] : []
    })
    const archive = exportBoardArchive(
      records as unknown as Parameters<typeof exportBoardArchive>[0],
      snap.schema as SerializedSchema,
      assets,
    )
    reply.header('content-disposition', contentDisposition('attachment', `${access.board.title}.lobby.json`))
    return archive
  })

  app.post(
    '/api/workspaces/:wid/boards/import',
    { ...HEAVY, bodyLimit: IMPORT_BODY_LIMIT_BYTES },
    async (req, reply) => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      await requireCreator(wid, user.id)
      const query = parse(ImportBoardQuery, req.query)
      if (query.projectId) await requireProjectInWorkspace(db, query.projectId, wid)
      let imported: ReturnType<typeof importBoardArchive>
      try {
        imported = importBoardArchive(req.body, { targetPageId: 'page:page' as never })
      } catch (e) {
        if (e instanceof ArchiveError)
          throw new ApiError(400, 'INVALID_ARCHIVE', clip(`This file can't be imported: ${e.message}.`, 300))
        throw e
      }
      const refs = new Map<string, { assetId: string; versionId: string }>()
      for (const a of imported.assets) refs.set(`${a.assetId}/${a.versionId}`, a)
      for (const f of referencedFiles(imported.records)) refs.set(`${f.assetId}/${f.versionId}`, f)
      const { allowed, dropped } = await filesViewableBy(db, wid, user.id, [...refs.values()])
      const warnings = [...imported.warnings]
      if (dropped.length)
        warnings.push(
          `${dropped.length} file(s) in this archive are not available to you in this workspace, so they were not carried over and show as missing.`,
        )
      const board = await createBoardFrom(
        ctx,
        {
          userId: user.id,
          workspaceId: wid,
          projectId: query.projectId ?? null,
          title: query.title ?? 'Imported board',
          records: imported.records,
          schema: draftroomSchema.serialize(),
          files: allowed,
          via: 'import',
        },
        warn,
      )
      reply.code(201)
      return { ...created(board, allowed.length, dropped.length), warnings }
    },
  )

  // ---- recently deleted (captured by the sync server) ------------------------------------------

  app.get('/api/boards/:bid/deleted', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    await requireBoardAction(db, bid, user.id, 'view')
    return viaSync(() => deleted.list(bid))
  })

  app.post('/api/boards/:bid/deleted/restore', HEAVY, async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(RestoreDeletedInput, req.body)
    await requireBoardAction(db, bid, user.id, 'edit')
    const result = await viaSync(() => deleted.restore(bid, input.ids))
    if (result.restored.length)
      ctx.events.publish(bid, {
        type: HISTORY_EVENTS.deletedRestored,
        data: { restored: result.restored.length },
      })
    return result
  })
}

function created(board: Parameters<typeof toBoardWithRole>[0], linked: number, dropped: number) {
  const warnings: string[] = []
  if (dropped > 0)
    warnings.push(
      `${dropped} referenced file(s) could not be carried over to the new board and show as missing.`,
    )
  return { board: toBoardWithRole(board, 'owner'), warnings, linkedFiles: linked, droppedFiles: dropped }
}
