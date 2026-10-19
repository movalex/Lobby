// OWNER: WS2 (wave W, background removal). docs/WAVE-W-CONTRACTS.md §4.
//
//   POST /api/files/:ver/remove-background {boardId}   → 202 FileOpState   edit + an account   W2-1
//
// Checked in this order (each refusal tells no more than the one before it):
//   1. the switch DRAFTROOM_REMOVE_BACKGROUND (formatsRoute's onRequest gate: off = the unknown route's 404, for
//      everyone, before the body and the root guards);
//   2. a worker with WORKER_CAPABILITIES['remove-bg'] seen within WORKER_OP_LIMITS.capabilityFreshMs (else the same
//      404: a stale tab whose offer predates the worker leaving gets what a switch off gives);
//   3. a signed-in caller (401); the body (FileOpInput, strict: 400);
//   4. the board: viewable (404), active (409 BOARD_ARCHIVED for an archived one), edit (403), with an account (a
//      name-only guest was refused by the guest guard already, 403 GUEST_ACCOUNT_REQUIRED; checked again here);
//   5. the version: served on that board (uploaded to it, or linked to it: files-auth.ts; else 404), kind image, a
//      REMOVE_BG_LIMITS.inputMimeTypes type (400 FILE_OP_UNSUPPORTED), `ready` (409 FILE_NOT_READY), within the size
//      and pixel limits (400 FILE_OP_UNSUPPORTED);
//   6. an op for this file already queued or running: 409 FILE_OP_ACTIVE (its state in the body when it is the
//      caller's own);
//   7. in one transaction under the workspace row lock: quota room for a result as large as the source (507
//      QUOTA_EXCEEDED; the real size is checked again at complete), the windows of REMOVE_BG_LIMITS (one active op
//      per person, 30 an hour per person, 300 a day per workspace, 3 active per workspace: 429 FILE_OP_LIMIT), then
//      the worker_ops row (kind remove-bg, params {}, params_key '-', requested_by = the caller). A concurrent
//      request for the same file loses on worker_ops_active_idx: 409 FILE_OP_ACTIVE.
// 202 with the op's state; the requester follows it by its `file.op` events (or GET /api/file-ops/:op, ../ops).
// The completer is ./kind.ts. Nothing here logs a file name; nothing reaches the worker but the op row.

import {
  FileOpInput,
  type FileOpState,
  FORMAT_ERROR_CODES,
  FORMAT_ROUTE_KEYS,
  REMOVE_BG_LIMITS,
  WORKER_OP_LIMITS,
} from '@draftroom/contracts'
import { isUniqueViolation, newId, type Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireBoardAction } from '../../../access.ts'
import type { Params } from '../../../context.ts'
import { ApiError, conflict, forbidden, notFound, parse } from '../../../errors.ts'
import { probeFacts } from '../../../files/meta.ts'
import { isNameOnlyGuest } from '../../../files/usage.ts'
import { isAssetLinked } from '../../../files-auth.ts'
import { guestAccountRequired } from '../../../routes/invitations.ts'
import type { FeatureContext } from '../../context.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../../pending-routes.ts'
import { freshCapabilityKinds } from '../offer.ts'
import { fileOpState } from '../op-state.ts'
import { formatsRoute } from '../switch.ts'
import { hasRoom, removeBgQuota } from './kind.ts'

const VERSION_RE = /^ver_[0-9A-Za-z]{10,40}$/
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

export const REMOVE_BG_MESSAGES = {
  unsupported: 'Background removal works on PNG, JPEG and WebP images.',
  tooLarge:
    'This image is too large. Use one under 40 megapixels, 12,000 pixels on its longest side and 25 MB.',
  notReady: 'This image is still being processed. Try again in a moment.',
  active: 'The background of this image is already being removed.',
  activeOther: 'Someone is already removing the background of this image. Try again in a minute.',
  oneAtATime: 'You can remove one background at a time. Wait for the one in progress to finish.',
  perHour: 'You have removed many backgrounds in the last hour. Try again later.',
  perDay: 'This workspace has removed many backgrounds today. Try again tomorrow.',
  workspaceActive: 'Several backgrounds are being removed in this workspace. Try again in a minute.',
  quota: 'This workspace is out of storage. Free some space and try again.',
  archived: 'This board is archived. Restore it to remove backgrounds.',
  guest: 'Sign in with an account to remove backgrounds.',
} as const

/** The 409 FILE_OP_ACTIVE body when the active op is the caller's own: it names that op. */
interface ActiveBody {
  error: { code: string; message: string }
  op?: FileOpState
}

interface SourceRow {
  id: string
  asset_id: string
  workspace_id: string
  board_id: string
  kind: string
  mime_type: string
  size_bytes: number
  status: string
  probe: unknown
}

/** A queued op past its time no longer counts as active (it reads as failed WORKER_UNAVAILABLE: ops-jobs opExpired). */
const ACTIVE_SQL = `(status = 'running' OR (status = 'queued' AND run_after >= $STALE))`
const active = (stale: string) => ACTIVE_SQL.replace('$STALE', stale)

/** The windows of REMOVE_BG_LIMITS, counted under the workspace row lock; the first one that is full, or null. */
async function fullWindow(
  q: Queryable,
  workspaceId: string,
  userId: string,
  now: Date,
): Promise<string | null> {
  const stale = new Date(now.getTime() - WORKER_OP_LIMITS.staleQueuedMs)
  const r = await q.one<{ mine_active: number; mine_hour: number; ws_day: number; ws_active: number }>(
    `SELECT
       (SELECT count(*)::int FROM worker_ops
         WHERE kind = 'remove-bg' AND requested_by = $2 AND ${active('$3')}) AS mine_active,
       (SELECT count(*)::int FROM worker_ops
         WHERE kind = 'remove-bg' AND requested_by = $2 AND created_at > $4) AS mine_hour,
       (SELECT count(*)::int FROM worker_ops
         WHERE kind = 'remove-bg' AND workspace_id = $1 AND created_at > $5) AS ws_day,
       (SELECT count(*)::int FROM worker_ops
         WHERE kind = 'remove-bg' AND workspace_id = $1 AND ${active('$3')}) AS ws_active`,
    [workspaceId, userId, stale, new Date(now.getTime() - HOUR), new Date(now.getTime() - DAY)],
  )
  if (r.mine_active >= REMOVE_BG_LIMITS.perUserActive) return REMOVE_BG_MESSAGES.oneAtATime
  if (r.mine_hour >= REMOVE_BG_LIMITS.perUserPerHour) return REMOVE_BG_MESSAGES.perHour
  if (r.ws_day >= REMOVE_BG_LIMITS.perWorkspacePerDay) return REMOVE_BG_MESSAGES.perDay
  if (r.ws_active >= REMOVE_BG_LIMITS.perWorkspaceActive) return REMOVE_BG_MESSAGES.workspaceActive
  return null
}

/** The active remove-bg op of this file, if any. */
async function activeOpOf(
  q: Queryable,
  versionId: string,
  now: Date,
): Promise<{ id: string; requested_by: string | null } | null> {
  const stale = new Date(now.getTime() - WORKER_OP_LIMITS.staleQueuedMs)
  return q.maybeOne<{ id: string; requested_by: string | null }>(
    `SELECT id, requested_by FROM worker_ops
      WHERE kind = 'remove-bg' AND source_version_id = $1 AND params_key = '-' AND status IN ('queued', 'running')
        AND ${active('$2')}
      LIMIT 1`,
    [versionId, stale],
  )
}

const unsupported = (message: string = REMOVE_BG_MESSAGES.unsupported) =>
  new ApiError(400, FORMAT_ERROR_CODES.unsupported, message)

/** The source checks of step 5 (pure; exported for the tests). */
export function sourceRefusal(
  v: Pick<SourceRow, 'kind' | 'mime_type' | 'size_bytes' | 'status' | 'probe'>,
): ApiError | null {
  if (v.kind !== 'image' || !REMOVE_BG_LIMITS.inputMimeTypes.includes(v.mime_type)) return unsupported()
  if (v.status !== 'ready') return conflict(FORMAT_ERROR_CODES.notReady, REMOVE_BG_MESSAGES.notReady)
  const { width, height } = probeFacts(v.probe)
  if (
    Number(v.size_bytes) > REMOVE_BG_LIMITS.maxInputBytes ||
    (width !== null &&
      height !== null &&
      (width * height > REMOVE_BG_LIMITS.maxInputPixels ||
        Math.max(width, height) > REMOVE_BG_LIMITS.maxInputEdge))
  )
    return unsupported(REMOVE_BG_MESSAGES.tooLarge)
  return null
}

export async function registerRemoveBackground(
  app: FastifyInstance,
  ctx: FeatureContext,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  // the completer's quota is this api's (see kind.ts); a bare test context has no uploads config
  if (ctx.config?.uploads) {
    removeBgQuota.maxBytes = ctx.config.uploads.workspaceQuotaBytes
    removeBgQuota.maxFiles = ctx.config.uploads.workspaceMaxFiles
  }
  const [method, url] = FORMAT_ROUTE_KEYS.removeBackground.split(' ') as [PendingMethod, string]

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<FileOpState | ActiveBody> => {
    const { db } = ctx
    const now = ctx.now()
    // 2. a capable worker, or nothing here exists
    let capable = false
    try {
      capable = (await freshCapabilityKinds(db, now)).has('remove-bg')
    } catch {
      capable = false // fail closed
    }
    if (!capable) throw notFound()
    // 3.
    const user = await ctx.requireUser(req)
    const versionId = (req.params as Params).ver
    if (typeof versionId !== 'string' || !VERSION_RE.test(versionId)) throw notFound()
    const input = parse(FileOpInput, req.body ?? {})
    // 4.
    const access = await requireBoardAction(db, input.boardId, user.id, 'view')
    if (access.board.status === 'archived') throw conflict('BOARD_ARCHIVED', REMOVE_BG_MESSAGES.archived)
    if (!can(access.role, 'edit', access.board.status)) throw forbidden()
    if (await isNameOnlyGuest(db, user.id)) throw guestAccountRequired(REMOVE_BG_MESSAGES.guest)
    const workspaceId = access.board.workspace_id
    // 5.
    const v = await db.maybeOne<SourceRow>(
      `SELECT id, asset_id, workspace_id, board_id, kind, mime_type, size_bytes::float8 AS size_bytes, status, probe
         FROM asset_versions WHERE id = $1`,
      [versionId],
    )
    if (!v || v.workspace_id !== workspaceId) throw notFound()
    const served =
      v.board_id === input.boardId ||
      (await isAssetLinked(db, workspaceId, input.boardId, {
        assetId: v.asset_id,
        versionId: v.id,
        ownerBoardId: v.board_id,
      }))
    if (!served) throw notFound()
    const refusal = sourceRefusal(v)
    if (refusal) throw refusal
    // 6.
    const busy = async (): Promise<ActiveBody> => {
      const first = await activeOpOf(db, versionId, ctx.now())
      if (first?.requested_by === user.id) {
        const state = await fileOpState(db, first.id, ctx.now())
        reply.code(409)
        return {
          error: { code: FORMAT_ERROR_CODES.opActive, message: REMOVE_BG_MESSAGES.active },
          ...(state ? { op: state.state } : {}),
        }
      }
      throw conflict(FORMAT_ERROR_CODES.opActive, REMOVE_BG_MESSAGES.activeOther)
    }
    if (await activeOpOf(db, versionId, now)) return busy()
    // 7.
    const opId = newId('wop')
    const stale = new Date(now.getTime() - WORKER_OP_LIMITS.staleQueuedMs)
    try {
      await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [workspaceId])
        // a queued op of this file nobody could run is over (it reads so already: ops-jobs opExpired); written now,
        // so it does not hold the one-active-op index against this request
        await tx.query(
          `UPDATE worker_ops SET status = 'failed', error_code = 'WORKER_UNAVAILABLE', finished_at = $3, updated_at = $3
            WHERE kind = 'remove-bg' AND source_version_id = $1 AND status = 'queued' AND run_after < $2`,
          [versionId, stale, now],
        )
        if (
          !(await hasRoom(tx, workspaceId, Math.min(Number(v.size_bytes), REMOVE_BG_LIMITS.maxOutputBytes)))
        )
          throw new ApiError(507, FORMAT_ERROR_CODES.quota, REMOVE_BG_MESSAGES.quota)
        const full = await fullWindow(tx, workspaceId, user.id, now)
        if (full) throw new ApiError(429, FORMAT_ERROR_CODES.opLimit, full)
        await tx.query(
          `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, params, params_key,
                                   requested_by, run_after, created_at, updated_at)
           VALUES ($1, $2, $3, 'remove-bg', $4, '{}'::jsonb, '-', $5, $6, $6, $6)`,
          [opId, workspaceId, input.boardId, versionId, user.id, now],
        )
      })
    } catch (e) {
      if (isUniqueViolation(e)) return busy()
      throw e
    }
    const state = await fileOpState(db, opId, now)
    if (!state) throw notFound() // the board or the file went in between
    reply.code(202)
    return state.state
  }

  formatsRoute(app, ctx, 'removeBackground', method, url, handler, pending)
}
