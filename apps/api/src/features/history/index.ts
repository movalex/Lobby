// Feature module: history (docs/FEATURES-M2-CONTRACTS.md "history"; checklist REV-07, REV-08, DSH-02,
// DSH-03, PRS-06 export archive). Named checkpoints, restore-as-new / duplicate / import (new private
// boards), board export, and the "Recently deleted" proxy to the sync server. Every decision goes
// through access.ts (packages/permissions); 404 whenever the caller cannot see the board.

import { draftroomSchema } from '@draftroom/canvas-schema'
import {
  CreateSnapshotInput,
  DuplicateBoardInput,
  HISTORY_EVENTS,
  IMPORT_BODY_LIMIT_BYTES,
  ImportBoardQuery,
  MAX_MANUAL_CHECKPOINTS,
  RestoreDeletedInput,
  RestoreSnapshotInput,
  SNAPSHOT_ID_PATTERN,
} from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { can, canCreateInWorkspace } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction, requireProjectInWorkspace, requireWorkspaceRole } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import { liveElements, lobbySnapshotOf } from '../../canvas/lobby-elements.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, forbidden, gone, notFound, parse } from '../../errors.ts'
import { contentDisposition } from '../../files/disposition.ts'
import { toBoardWithRole } from '../../serialize.ts'
import type { BoardSnapshotJson, RoomSnapshotJson } from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'
import { keepDownloadableFiles } from '../export-control/import-files.ts'
import { copyExportPolicy, requireExportAllowed } from '../export-control/policy.ts'
import { DELETED_GUESTS, guestRefused } from '../guests/guard.ts'
import { exportLobbyArchive, importLobbyArchive, isLobbyArchive } from './archive-v2.ts'
import { ArchiveError, exportBoardArchive, importBoardArchive, type SerializedSchema } from './board-ops.ts'
import { registerCheckpointRoutes } from './checkpoint-routes.ts'
import {
  type CheckpointService,
  checkpointSettings,
  createCheckpointService,
  startCheckpointTimers,
} from './checkpoints.ts'
import {
  archiveRef,
  filesShownOn,
  filesViewableBy,
  referencedElementFiles,
  referencedFiles,
} from './files.ts'
import { type BoardContent, createBoardFrom, viaSync } from './new-board.ts'
import {
  checkpointBodyOf,
  readCheckpointBody,
  SNAPSHOT_COLUMNS,
  SNAPSHOT_FROM,
  type SnapshotRow,
  toCheckpoint,
} from './snapshot-rows.ts'
import { snapshotBodies, snapshotStorageKey } from './snapshot-store.ts'
import { createDeletedApi } from './sync-deleted.ts'

/** Manual checkpoints kept per board (automatic ones are bounded by retention instead). */
export const MAX_SNAPSHOTS_PER_BOARD = MAX_MANUAL_CHECKPOINTS
/** Every manual checkpoint (≤ 500) and every automatic one retention keeps (well under 1,000). */
const MAX_LISTED = 1_500
/** Heavy routes (a full board copy each): per client, per minute. */
const HEAVY = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }

/** The checkpoint service of an app (tests drive its scheduler and retention through it). */
export const checkpointServices = new WeakMap<FastifyInstance, CheckpointService>()

const clip = (s: string, max = 120) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

const CHECKPOINTS_GUESTS =
  'Checkpoints are for people with an account. Sign in with an account to see earlier versions of this board.'

export async function registerHistory(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db } = ctx
  const bodies = snapshotBodies(ctx.blobs, ctx.layout.root)
  const deleted = createDeletedApi(ctx)
  const warn = (message: string) => app.log.warn({ feature: 'history' }, message)

  // Automatic checkpoints and retention (checkpoints.ts, checkpoint-routes.ts).
  const settings = { ...checkpointSettings }
  const checkpoints = createCheckpointService(
    ctx,
    bodies,
    { warn, info: (message) => app.log.info({ feature: 'history' }, message) },
    settings,
  )
  checkpointServices.set(app, checkpoints)
  startCheckpointTimers(app, checkpoints, settings)
  registerCheckpointRoutes(app, ctx, checkpoints, bodies)

  /**
   * The caller may create boards in the workspace: members and above (guests may not), and a creator
   * (domain access, docs/DOMAIN-ACCESS-CONTRACTS.md §4.2). Always the first check of a route that makes
   * a new board, before anything heavy (an archive is parsed, a snapshot is taken or captured).
   */
  async function requireBoardCreator(workspaceId: string, userId: string, route: string) {
    const role = await requireWorkspaceRole(db, workspaceId, userId)
    if (!canCreateInWorkspace(role)) throw forbidden('Only workspace members can create boards.')
    await ctx.identity.requireCreator(db, userId, 'create', { route, by: 'route' })
  }

  // ---- checkpoints -------------------------------------------------------------------------------

  // Name-only guests (a client on a review link, a workshop guest) get no History at all (DANA-05):
  // checkpoint names ("Before we hide the pricing"), who saved them and when are the team's own. 403
  // GUEST_ACCOUNT_REQUIRED after the board checks (404 first), like "Recently deleted" below; the
  // preview refuses them too (checkpoint-routes.ts). The web hides the History panel for them.
  const refuseGuests = async (userId: string) => {
    if ((await userKind(db, userId)) === 'guest') throw guestRefused(CHECKPOINTS_GUESTS)
  }

  app.get('/api/boards/:bid/snapshots', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    await refuseGuests(user.id)
    const rows = await db.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_FROM}
        WHERE s.board_id = $1 AND s.workspace_id = $2
        ORDER BY s.created_at DESC, s.id DESC LIMIT ${MAX_LISTED}`,
      [bid, access.board.workspace_id],
    )
    return { snapshots: rows.rows.map(toCheckpoint) }
  })

  app.post('/api/boards/:bid/snapshots', HEAVY, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(CreateSnapshotInput, req.body)
    const access = await requireBoardAction(db, bid, user.id, 'edit')
    await refuseGuests(user.id)
    const workspaceId = access.board.workspace_id
    // Only manual checkpoints count: automatic ones are bounded by retention (checkpoints.ts).
    const { n } = await db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM board_snapshots WHERE board_id = $1 AND kind = 'manual'",
      [bid],
    )
    if (n >= MAX_SNAPSHOTS_PER_BOARD)
      throw conflict('SNAPSHOT_LIMIT', `A board keeps at most ${MAX_SNAPSHOTS_PER_BOARD} checkpoints.`)

    const snap = await viaSync(() => ctx.sync.snapshot(bid))
    const made = checkpointBodyOf(bid, snap)
    const id = newId('snp')
    const key = snapshotStorageKey(bid, id)
    await bodies.write(key, made.json)
    let row: SnapshotRow
    try {
      const inserted = await db.one<{ id: string }>(
        `INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, created_by, created_at, document_clock, record_count, size_bytes, storage_key, content_hash)
         VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          id,
          workspaceId,
          bid,
          input.name,
          user.id,
          ctx.now(),
          made.documentClock,
          made.recordCount,
          made.sizeBytes,
          key,
          made.contentHash,
        ],
      )
      row = await db.one<SnapshotRow>(`SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_FROM} WHERE s.id = $1`, [
        inserted.id,
      ])
    } catch (e) {
      await bodies
        .remove(key)
        .catch((e: unknown) => warn(`checkpoint body cleanup failed: ${(e as Error)?.name ?? 'Error'}`))
      throw e
    }
    ctx.events.publish(bid, { type: HISTORY_EVENTS.snapshot, data: { snapshotId: id } })
    reply.code(201)
    return toCheckpoint(row)
  })

  app.post('/api/snapshots/:sid/restore-as-new', HEAVY, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { sid = '' } = req.params as Params
    const input = parse(RestoreSnapshotInput, req.body ?? {})
    if (!SNAPSHOT_ID_PATTERN.test(sid)) throw notFound()
    const snapshot = await db.maybeOne<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_FROM} WHERE s.id = $1`,
      [sid],
    )
    if (!snapshot) throw notFound()
    // Seeing the checkpoint = seeing its board (404 otherwise: no existence leak).
    const access = await requireBoardAction(db, snapshot.board_id, user.id, 'view')
    const workspaceId = access.board.workspace_id
    if (snapshot.workspace_id !== workspaceId) throw notFound()
    await requireBoardCreator(workspaceId, user.id, req.routeOptions.url ?? '')
    // A new board of your own is a full copy (export-control, docs/WAVE3-CONTRACTS.md).
    await requireExportAllowed(db, access, user.id)
    const raw = await bodies.read(snapshot.storage_key)
    if (raw === null) throw gone("This checkpoint's saved content is no longer available.")
    // The board as it is right now gets an automatic checkpoint first (unless an equal one exists), so
    // going back to an older version never loses track of where the board was. Best effort: a failure
    // is logged and the restore goes on (it never changes this board). After the read above, so
    // retention running with it can never take the content being restored.
    await checkpoints.captureQuietly(snapshot.board_id, 'before_restore', { restoredName: snapshot.name })
    // v1 bodies are tldraw records (a sync on the Excalidraw engine converts them at the seed, §5.5);
    // v2 bodies are elements (docs/EXCALIDRAW-MIGRATION.md §3.7)
    const body = readCheckpointBody(raw)
    const content: BoardContent =
      body.version === 2
        ? { format: 'lobby-elements', elements: body.elements, doc: body.doc }
        : { format: 'tldraw', records: body.records, schema: body.schema }
    const { shown, notShown } = await filesShownOn(
      db,
      workspaceId,
      snapshot.board_id,
      body.version === 2 ? await referencedElementFiles(db, body.elements) : referencedFiles(body.records),
    )
    const board = await createBoardFrom(
      ctx,
      {
        userId: user.id,
        workspaceId,
        projectId: access.board.project_id,
        title: input.title ?? clip(`${access.board.title} (${snapshot.name})`),
        content,
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
    await requireBoardCreator(workspaceId, user.id, req.routeOptions.url ?? '')
    await requireExportAllowed(db, access, user.id) // a duplicate is a full copy (export-control)
    if (input.keepSharing && !can(access.role, 'manage_access', access.board.status))
      throw forbidden('Only the board owner can copy its sharing settings.')
    const snap = await viaSync(() => ctx.sync.snapshot(bid))
    const lobby = lobbySnapshotOf(snap)
    const content = contentOf(snap)
    const { shown, notShown } = await filesShownOn(
      db,
      workspaceId,
      bid,
      lobby ? await referencedElementFiles(db, lobby.elements) : referencedFiles(recordsOf(snap)),
    )
    const board = await createBoardFrom(
      ctx,
      {
        userId: user.id,
        workspaceId,
        projectId: access.board.project_id,
        title: input.title ?? clip(`Copy of ${access.board.title}`),
        content,
        files: shown,
        shareLike: input.keepSharing ? { boardId: bid, visibility: access.board.visibility } : undefined,
        via: 'duplicate',
        from: { boardId: bid },
      },
      warn,
    )
    // export-control: the same people on the copy stay under the same export policy.
    if (input.keepSharing) await copyExportPolicy(db, bid, board, user.id, ctx.now())
    reply.code(201)
    return created(board, shown.length, notShown)
  })

  // ---- portable archive (PRS-06 export part, PRS-11) --------------------------------------------

  app.get('/api/boards/:bid/export', HEAVY, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    await requireExportAllowed(db, access, user.id) // export-control: 403 EXPORT_DISABLED for limited viewers
    const snap = await viaSync(() => ctx.sync.snapshot(bid))
    const lobby = lobbySnapshotOf(snap)
    const records = recordsOf(snap)
    const { shown, versions } = await filesShownOn(
      db,
      access.board.workspace_id,
      bid,
      lobby ? await referencedElementFiles(db, lobby.elements) : referencedFiles(records),
    )
    const assets = shown.flatMap((f) => {
      const version = versions.get(`${f.assetId}/${f.versionId}`)
      const ref = version ? archiveRef(version) : null
      return ref ? [ref] : []
    })
    // a board on the Excalidraw engine exports the v2 archive (docs/EXCALIDRAW-MIGRATION.md §3.7)
    const archive = lobby
      ? exportLobbyArchive(lobby.elements, lobby.doc, lobby.schema, assets, ctx.now())
      : exportBoardArchive(
          records as unknown as Parameters<typeof exportBoardArchive>[0],
          (snap as RoomSnapshotJson).schema as SerializedSchema,
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
      await requireBoardCreator(wid, user.id, req.routeOptions.url ?? '')
      const query = parse(ImportBoardQuery, req.query)
      if (query.projectId) await requireProjectInWorkspace(db, query.projectId, wid)
      // v2 archives (a board of the new canvas, docs/EXCALIDRAW-MIGRATION.md §3.7) are elements; v1 ones
      // are tldraw records, which a sync on the Excalidraw engine converts at the seed
      let imported: {
        content: BoardContent
        assets: { assetId: string; versionId: string }[]
        warnings: string[]
        files: { assetId: string; versionId: string }[]
      }
      try {
        if (isLobbyArchive(req.body)) {
          const v2 = importLobbyArchive(req.body)
          imported = {
            content: { format: 'lobby-elements', elements: v2.elements, doc: v2.doc },
            assets: v2.assets,
            warnings: v2.warnings,
            files: await referencedElementFiles(db, v2.elements),
          }
        } else {
          const v1 = importBoardArchive(req.body, { targetPageId: 'page:page' as never })
          imported = {
            content: { format: 'tldraw', records: v1.records, schema: draftroomSchema.serialize() },
            assets: v1.assets,
            warnings: v1.warnings,
            files: referencedFiles(v1.records),
          }
        }
      } catch (e) {
        if (e instanceof ArchiveError)
          throw new ApiError(400, 'INVALID_ARCHIVE', clip(`This file can't be imported: ${e.message}.`, 300))
        throw e
      }
      const refs = new Map<string, { assetId: string; versionId: string }>()
      for (const a of imported.assets) refs.set(`${a.assetId}/${a.versionId}`, a)
      for (const f of imported.files) refs.set(`${f.assetId}/${f.versionId}`, f)
      const viewable = await filesViewableBy(db, wid, user.id, [...refs.values()])
      // export-control: only files the importer may also download somewhere (else a limited viewer's
      // hand-made archive would link them to a board of their own and serve the originals there).
      const { kept: allowed, dropped: limited } = await keepDownloadableFiles(
        db,
        wid,
        user.id,
        viewable.allowed,
      )
      const dropped = [...viewable.dropped, ...limited]
      const warnings = [...imported.warnings]
      if (viewable.dropped.length)
        warnings.push(
          `${viewable.dropped.length} file(s) in this archive are not available to you in this workspace, so they were not carried over and show as missing.`,
        )
      if (limited.length)
        warnings.push(
          `${limited.length} file(s) in this archive are on boards whose owner turned off downloads for viewers, so they were not carried over and show as missing.`,
        )
      const board = await createBoardFrom(
        ctx,
        {
          userId: user.id,
          workspaceId: wid,
          projectId: query.projectId ?? null,
          title: query.title ?? 'Imported board',
          content: imported.content,
          files: allowed,
          via: 'import',
        },
        warn,
      )
      // The board as imported, before anyone edits it (automatic; best effort).
      await checkpoints.captureQuietly(board.id, 'import')
      reply.code(201)
      return { ...created(board, allowed.length, dropped.length), warnings }
    },
  )

  // ---- recently deleted (captured by the sync server) ------------------------------------------

  // `edit`, like restore (docs/SECURITY-REVIEW-2026-09-27.md authz-001): each entry's label is the
  // deleted note's text, so viewers, commenters and review-link guests must not read what was deleted
  // before the board was shared with them. Archived boards (read-only) answer 403 as for restore.
  // Editors with an account only (wave 3, SEAM-06): a name-only guest on a workshop (editor) link is
  // an anonymous outsider too, so 403 GUEST_ACCOUNT_REQUIRED, after the board checks (404 first).
  app.get('/api/boards/:bid/deleted', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    await requireBoardAction(db, bid, user.id, 'edit')
    if ((await userKind(db, user.id)) === 'guest') throw guestRefused(DELETED_GUESTS)
    return viaSync(() => deleted.list(bid))
  })

  // Restoring puts deleted content back on the board for everyone, so it follows the list: editors with
  // an account only. A name-only guest could otherwise restore what was deleted before they joined by
  // an id learned elsewhere (a comment's anchor keeps the shape id of a deleted note).
  app.post('/api/boards/:bid/deleted/restore', HEAVY, async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(RestoreDeletedInput, req.body)
    await requireBoardAction(db, bid, user.id, 'edit')
    if ((await userKind(db, user.id)) === 'guest') throw guestRefused(DELETED_GUESTS)
    const result = await viaSync(() => deleted.restore(bid, input.ids))
    if (result.restored.length)
      ctx.events.publish(bid, {
        type: HISTORY_EVENTS.deletedRestored,
        data: { restored: result.restored.length },
      })
    return result
  })
}

/** A tldraw snapshot's records (none for the Excalidraw engine's envelope). */
function recordsOf(snap: BoardSnapshotJson): Record<string, unknown>[] {
  if (lobbySnapshotOf(snap)) return []
  const docs = (snap as RoomSnapshotJson).documents
  return (Array.isArray(docs) ? docs : []).map((d) => d.state)
}

/** A live board as the content of a new one, in its engine's format. */
function contentOf(snap: BoardSnapshotJson): BoardContent {
  const lobby = lobbySnapshotOf(snap)
  if (lobby) return { format: 'lobby-elements', elements: liveElements(lobby.elements), doc: lobby.doc }
  return { format: 'tldraw', records: recordsOf(snap), schema: (snap as RoomSnapshotJson).schema }
}

function created(board: Parameters<typeof toBoardWithRole>[0], linked: number, dropped: number) {
  const warnings: string[] = []
  if (dropped > 0)
    warnings.push(
      `${dropped} referenced file(s) could not be carried over to the new board and show as missing.`,
    )
  return { board: toBoardWithRole(board, 'owner'), warnings, linkedFiles: linked, droppedFiles: dropped }
}
