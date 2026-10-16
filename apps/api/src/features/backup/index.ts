// OWNER: WS4 (wave R, board backup and restore; stubs landed by the wave R foundation). The backup routes
// (@draftroom/contracts board-backup.ts; docs/WAVE-R-CONTRACTS.md §5):
//
//   POST /api/boards/:bid/backup/ticket    a one-minute ticket for the direct download              R4-1
//   GET  /api/boards/:bid/backup?ticket=   the .lobby zip, streamed from the api's own origin       R4-1
//   POST /api/workspaces/:wid/backups      restore: a new board through the import runner (202)     R4-2
//
// What WS4 builds here (with packages/board-archive): the export stream (the export route's guards: view and the
// board's export policy; only files the caller may download), and the 'lobby-backup' import source registered on the
// runner (../imports/index.ts importRunnerOf(app).useSource), which spools the upload to the blob store, reads it by
// range and creates every file as a new version of the importing board. The guard rows are in place: a name-only
// guest is refused the ticket and the restore (guests/guard.ts; the download itself is ticket-authorised, like the
// event stream), and a restore needs a creator ('always', purpose create). Pending (../pending-routes.ts): none is
// registered until WS4 implements it.

import { BACKUP_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { type PendingMethod, routeUnlessPending } from '../pending-routes.ts'

export async function registerBackup(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  for (const key of BACKUP_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    routeUnlessPending(app, method, url, stub)
  }
}
