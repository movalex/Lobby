// OWNER: WS4 (wave R, board backup and restore). The backup routes (@draftroom/contracts board-backup.ts;
// docs/WAVE-R-CONTRACTS.md §5), over packages/board-archive:
//
//   POST /api/boards/:bid/backup/ticket    a one-minute ticket for the direct download              R4-1
//   GET  /api/boards/:bid/backup?ticket=   the .lobby zip, streamed from the api's own origin       R4-1
//   POST /api/workspaces/:wid/backups      restore: a new board through the import runner (202)     R4-2
//
// The ticket route decides who may download (./export.ts: view, the board's export policy, no name-only guest; the
// guard rows refuse guests first) and checks the limits, so a download that cannot happen is refused there, in the
// page, not in the browser's download bar. The download is ticket-authorised (./tickets.ts: single use, the minting
// session still signed in) and runs the same checks again as that person. A restore needs a creator who may create
// in the workspace ('always', purpose create: domain-access/guard.ts, and again in the route); it is an import job,
// source 'lobby-backup' (./restore.ts), registered on the shared runner (../imports).

import { Readable } from 'node:stream'
import {
  BACKUP_GUESTS_MESSAGE,
  BACKUP_MIME_TYPE,
  BACKUP_ROUTES,
  backupDownloadPath,
} from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, unauthenticated } from '../../errors.ts'
import { contentDisposition } from '../../files/disposition.ts'
import { keyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { requireExportAllowed } from '../export-control/policy.ts'
import { guestRefused } from '../guests/guard.ts'
import { importRunnerOf } from '../imports/index.ts'
import { routeUnlessPending } from '../pending-routes.ts'
import { backupFileName, backupStream, planBackup } from './export.ts'
import { createBackupSource, handleRestore, Spools, spoolKey } from './restore.ts'
import { createBackupTicketStore } from './tickets.ts'

/** Downloads one api process streams at once (each holds its board.json in memory: ≤ 64 MiB). */
export const BACKUP_DOWNLOADS_PER_PROCESS = 4
/** How often finished restores' spooled uploads are removed (the job removes its own; this catches the rest). */
export const BACKUP_SPOOL_SWEEP_MS = 60 * 60_000
const SPOOL_SWEEP_DAYS = 3

const busy = () =>
  new ApiError(
    503,
    'TOO_MANY_BACKUPS',
    'Too many backups are being made right now. Try again in a minute.',
    { 'retry-after': '30' },
  )

export async function registerBackup(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db } = ctx
  const tickets = createBackupTicketStore({ now: ctx.now })
  const mints = keyedLimit(
    { max: 30, timeWindow: 60_000 },
    ctx.now,
    'Too many backups asked for. Wait a minute and try again.',
  )
  let streaming = 0

  const stopListening = ctx.sessions.onRevoked((ids) => tickets.revokeSessions(ids))
  const ticketSweep = setInterval(() => tickets.sweep(), 15_000)
  ticketSweep.unref()

  /** The board as `userId` may back it up (404 when they cannot see it, 403 EXPORT_DISABLED, 403 for a guest). */
  const exportable = async (boardId: string, userId: string) => {
    const access = await requireBoardAction(db, boardId, userId, 'view')
    if ((await userKind(db, userId)) === 'guest') throw guestRefused(BACKUP_GUESTS_MESSAGE)
    await requireExportAllowed(db, access, userId)
    return access
  }

  routeUnlessPending(app, 'POST', BACKUP_ROUTES.ticket, async (req) => {
    const user = await ctx.requireUser(req)
    const sessionId = ctx.sessions.idOf(req)
    if (!sessionId) throw unauthenticated()
    mints.take(user.id)
    const { bid = '' } = req.params as Params
    const access = await exportable(bid, user.id)
    // the limits, before the person waits for a download that cannot come
    await planBackup(ctx, access, user.id)
    const minted = tickets.mint({ boardId: access.board.id, userId: user.id, sessionId })
    if (!minted) throw busy()
    const origin = ctx.config.eventsOrigin ?? ''
    return {
      url: `${origin}${backupDownloadPath(access.board.id)}?ticket=${encodeURIComponent(minted.ticket)}`,
      expiresAt: minted.expiresAt,
    }
  })

  routeUnlessPending(app, 'GET', BACKUP_ROUTES.download, async (req, reply) => {
    const { bid = '' } = req.params as Params
    const claims = tickets.consume((req.query as Record<string, unknown> | undefined)?.ticket)
    if (!claims || claims.boardId !== bid) throw unauthenticated()
    if (!(await ctx.sessions.activeIds([claims.sessionId])).has(claims.sessionId)) throw unauthenticated()
    const access = await exportable(bid, claims.userId)
    if (streaming >= BACKUP_DOWNLOADS_PER_PROCESS)
      throw busy()
    const plan = await planBackup(ctx, access, claims.userId)
    streaming++
    let released = false
    const release = () => {
      if (released) return
      released = true
      streaming--
    }
    reply.raw.on('close', release)
    reply
      .code(200)
      .header('content-type', BACKUP_MIME_TYPE)
      .header('content-disposition', contentDisposition('attachment', backupFileName(access.board.title)))
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
    const body = Readable.from(backupStream(ctx, plan))
    body.on('error', (e) => {
      release()
      req.log.warn({ feature: 'backup', err: { name: (e as Error)?.name } }, 'backup download stopped')
    })
    body.on('end', release)
    return reply.send(body)
  })

  // The restore's body is the file itself: a scope of its own whose one parser reads nothing (as the upload route's,
  // files/plugin.ts), so the handler streams the request to the blob store; the root's Origin check still applies.
  const runner = importRunnerOf(app)
  const spools = new Spools()
  if (runner) runner.useSource(createBackupSource(ctx, spools))
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null))
    routeUnlessPending(scope, 'POST', BACKUP_ROUTES.restore, async (req, reply) => {
      if (!runner) throw new ApiError(404, 'NOT_FOUND', 'Not found.')
      return handleRestore(ctx, runner, spools, req, reply)
    })
  })

  // finished restores' spooled uploads (the job deletes its own; a crash or an expired pause leaves one)
  const sweepSpools = async () => {
    const since = new Date(ctx.now().getTime() - SPOOL_SWEEP_DAYS * 86_400_000)
    const rows = await db.query<{ batch_id: string }>(
      `SELECT DISTINCT batch_id FROM board_imports
        WHERE source = 'lobby-backup' AND status IN ('done', 'failed', 'cancelled') AND finished_at >= $1
        LIMIT 1000`,
      [since],
    )
    for (const r of rows.rows) await ctx.blobs.delete(spoolKey(r.batch_id)).catch(() => {})
  }
  let spoolTimer: ReturnType<typeof setInterval> | null = null
  app.addHook('onReady', async () => {
    spoolTimer = setInterval(() => {
      sweepSpools().catch(() => {})
    }, BACKUP_SPOOL_SWEEP_MS)
    spoolTimer.unref()
  })
  app.addHook('onClose', async () => {
    clearInterval(ticketSweep)
    if (spoolTimer) clearInterval(spoolTimer)
    stopListening()
  })
}
