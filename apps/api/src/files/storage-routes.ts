// Workspace storage (packages/contracts/src/storage.ts): what a workspace stores against its quota, and
// the report of the collector of files nothing references any more (gc.ts), which this module also
// runs on a timer (DRAFTROOM_ASSET_GC, default report-only).
//
//   GET  /api/workspaces/:wid/storage             owner, admin, member (guests 403, outsiders 404);
//                                                  owners and admins also get the collector summary
//   GET  /api/workspaces/:wid/storage/gc-report   owner, admin: the versions marked unreferenced
//   POST /api/workspaces/:wid/storage/scan        owner, admin: a report-only pass over this workspace
//                                                  now (it never deletes, whatever the mode)

import type { WorkspaceStorage } from '@draftroom/contracts'
import { canCreateInWorkspace, canManageWorkspace } from '@draftroom/permissions'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireWorkspaceRole } from '../access.ts'
import type { AppContext, Params } from '../context.ts'
import { conflict, forbidden } from '../errors.ts'
import { keyedLimit } from '../rate-limit.ts'
import type { BlobStore } from './blobs.ts'
import { createAssetGc, gcReport, gcSummary } from './gc.ts'
import { countBoards, workspaceUsage } from './usage.ts'

export interface StorageDeps {
  blobs: BlobStore
  /** The sync server's internal client (its optional assetRefs reads a board's references). */
  sync: { assetRefs?(boardId: string): Promise<unknown> }
  /** The api's data dir: history's pre-milestone-3 checkpoint folder lives under it. */
  dataRoot: string
}

/** Manual checks per workspace (each reads every board of the workspace from sync). */
const SCANS_PER_MINUTE = 2

export function registerStorage(app: FastifyInstance, ctx: AppContext, deps: StorageDeps): void {
  const { db, now } = ctx
  const cfg = ctx.config.storage
  const gc = createAssetGc(
    {
      db,
      blobs: deps.blobs,
      sync: deps.sync,
      dataRoot: deps.dataRoot,
      now,
      log: app.log,
      canvas: ctx.canvas,
    },
    cfg.assetGc,
  )
  app.addHook('onReady', async () => gc.start())
  app.addHook('onClose', async () => gc.stop())
  const scans = keyedLimit(
    { max: SCANS_PER_MINUTE, timeWindow: 60_000 },
    now,
    'This workspace was checked a moment ago. Try again in a minute.',
  )

  async function workspaceRole(req: FastifyRequest) {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    return { wid, role: await requireWorkspaceRole(db, wid, user.id) }
  }

  app.get('/api/workspaces/:wid/storage', async (req) => {
    const { wid, role } = await workspaceRole(req)
    // Guests belong to a workspace only to reach the boards shared with them.
    if (!canCreateInWorkspace(role)) throw forbidden()
    const usage = await workspaceUsage(db, wid)
    const body: WorkspaceStorage = {
      workspaceId: wid,
      usedBytes: usage.used,
      quotaBytes: ctx.config.uploads.workspaceQuotaBytes,
      files: usage.files,
      maxFiles: ctx.config.uploads.workspaceMaxFiles,
      breakdown: { originals: usage.originals, previews: usage.previews, thumbnails: usage.thumbnails },
      boards: { count: await countBoards(db, wid), max: cfg.maxBoardsPerWorkspace },
    }
    if (canManageWorkspace(role)) body.gc = await gcSummary(db, wid, cfg.assetGc.mode, now())
    return body
  })

  app.get('/api/workspaces/:wid/storage/gc-report', async (req) => {
    const { wid, role } = await workspaceRole(req)
    if (!canManageWorkspace(role)) throw forbidden('Only workspace owners and admins can see this report.')
    return gcReport(db, wid, cfg.assetGc.mode, now())
  })

  app.post('/api/workspaces/:wid/storage/scan', async (req) => {
    const { wid, role } = await workspaceRole(req)
    if (!canManageWorkspace(role)) throw forbidden('Only workspace owners and admins can check storage.')
    scans.take(wid)
    const result = await gc.collect(wid, 'report')
    if (result === 'busy')
      throw conflict('SCAN_RUNNING', 'This workspace is being checked right now. Try again in a minute.')
    return gcReport(db, wid, cfg.assetGc.mode, now())
  })
}
