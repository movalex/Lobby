// The selective restore (wave L, L7-2; owner W7): chosen elements of a checkpoint back into the LIVE board,
// for everyone (packages/contracts history.ts RESTORE_ELEMENTS_ROUTE):
//
//   POST /api/boards/:bid/snapshots/:sid/restore-elements  RestoreElementsInput → 200 RestoreElementsResult
//
// Who: an editor of an active board (edit: viewers and commenters 403, an archived board 403, a board the
// caller cannot see 404), with an account (a name-only guest 403 GUEST_ACCOUNT_REQUIRED, here after the board
// checks, and in the guest guard's list once W5's row lands), and a workspace member above guest: the people
// who may open the checkpoint's preview (checkpoint-routes.ts), since the restore shows its content to
// everyone on the board.
//
// What: the checkpoint's elements (a v1 body converted the way its preview is, checkpoint-routes.ts
// `elementsOf`), the asked ids closed over bound texts and containers, then, one restore per board at a
// time in this process: a 'before_restore' checkpoint FIRST (the board equal to its newest checkpoint keeps
// that one: either is the board as it was, and "Undo restore" restores from it), and the sync's internal
// route (room-internal/restore-elements.ts), which writes them in one server write. Nothing is restored
// when no checkpoint could be made (503). A sync without the route (older than canvas-schema
// RESTORE_ELEMENTS_REV) answers 404: 503 RESTORE_UNAVAILABLE. Over the board's element cap: 409 ELEMENT_LIMIT.
// The log gets counts and skip codes only, never ids or content.

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import {
  RESTORE_ELEMENTS_ERROR_CODES,
  RESTORE_ELEMENTS_MAX_ELEMENTS,
  RESTORE_ELEMENTS_ROUTE,
  RestoreElementsAnswer,
  type RestoreElementsBody,
  RestoreElementsInput,
  type RestoreElementsResult,
  restoreElementsInternalPath,
  SNAPSHOT_ID_PATTERN,
} from '@draftroom/contracts'
import { canCreateInWorkspace } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import { onNewCanvas } from '../../canvas-engine.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, forbidden, gone, notFound, parse } from '../../errors.ts'
import { SyncUnavailable } from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'
import { guestRefused } from '../guests/guard.ts'
import type { CheckpointReader } from './checkpoint-routes.ts'
import type { CheckpointAbout, CheckpointService } from './checkpoints.ts'
import { syncUnavailable } from './new-board.ts'
import { SNAPSHOT_COLUMNS, SNAPSHOT_FROM, type SnapshotRow } from './snapshot-rows.ts'
import type { SnapshotBodies } from './snapshot-store.ts'

/** The guest refusal (the same words go into W5's GUEST_REFUSED_ROUTES row for this route). */
export const RESTORE_ELEMENTS_GUESTS =
  'Restoring from a checkpoint is for editors with an account. Sign in with an account to do that.'
const WORKSPACE_GUESTS = 'Guests can’t restore from earlier versions of a board. Ask the board’s owner.'
const UNAVAILABLE = 'Restoring into the board isn’t available right now. Try again in a moment.'
const NO_CHECKPOINT =
  'Lobby couldn’t save a checkpoint of the board first, so nothing was restored. Try again in a moment.'

/** One restore at a time per client and minute budget, like the other heavy history routes. */
const HEAVY = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }
/** The sync's answer time for one restore (the room queue, the SAVEPOINT, the COMMIT). */
const SYNC_TIMEOUT_MS = 15_000

/** The sync's answer as it came (the route decides what each status means). */
export interface RestoreSyncAnswer {
  status: number
  body: unknown
}
/** api → sync restore calls; tests inject one through ApiDeps.syncInternal (it is picked up from ctx.sync). */
export interface RestoreSyncClient {
  restoreElements(boardId: string, body: RestoreElementsBody): Promise<RestoreSyncAnswer>
}
const isRestoreSyncClient = (v: unknown): v is RestoreSyncClient =>
  typeof (v as Partial<RestoreSyncClient> | null)?.restoreElements === 'function'

export function createHttpRestoreSyncClient(opts: {
  baseUrl: string
  secret: string
  timeoutMs?: number
}): RestoreSyncClient {
  const base = opts.baseUrl.replace(/\/+$/, '')
  return {
    async restoreElements(boardId, body) {
      let res: Response
      try {
        res = await fetch(`${base}${restoreElementsInternalPath(boardId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [INTERNAL_SECRET_HEADER]: opts.secret },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? SYNC_TIMEOUT_MS),
        })
      } catch (e) {
        throw new SyncUnavailable(`sync unreachable: ${(e as Error).name}`)
      }
      const text = await res.text().catch(() => '')
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      return { status: res.status, body: parsed }
    },
  }
}

// biome-ignore lint/suspicious/noExplicitAny: checkpoint elements are JSON, read field by field
type El = Record<string, any> & { id: string; type: string }
const isEl = (v: unknown): v is El =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as El).id === 'string' &&
  typeof (v as El).type === 'string' &&
  (v as El).isDeleted !== true
const isLabel = (e: El) => e.type === 'text' && typeof e.containerId === 'string' && e.containerId.length > 0

/**
 * The checkpoint's copies of `ids` closed over bound texts and containers: an asked label brings its container,
 * an asked container (or arrow) its label. What the checkpoint lacks is left out (the sync answers MISSING).
 */
export function closeOverLabels(elements: readonly unknown[], ids: readonly string[]): El[] {
  const byId = new Map<string, El>()
  const labelsOf = new Map<string, El[]>()
  for (const raw of elements) {
    if (!isEl(raw) || byId.has(raw.id)) continue
    byId.set(raw.id, raw)
    if (isLabel(raw)) labelsOf.set(raw.containerId, [...(labelsOf.get(raw.containerId) ?? []), raw])
  }
  const out = new Map<string, El>()
  for (const id of ids) {
    const el = byId.get(id)
    if (!el) continue
    const head = isLabel(el) ? (byId.get(el.containerId) ?? el) : el
    out.set(head.id, head)
    for (const r of (Array.isArray(head.boundElements) ? head.boundElements : []) as {
      id?: unknown
      type?: unknown
    }[])
      if (r?.type === 'text' && typeof r.id === 'string' && byId.has(r.id))
        out.set(r.id, byId.get(r.id) as El)
    for (const l of labelsOf.get(head.id) ?? []) out.set(l.id, l)
    if (head !== el) out.set(el.id, el)
  }
  return [...out.values()]
}

export function registerRestoreElements(
  app: FastifyInstance,
  ctx: FeatureContext,
  checkpoints: CheckpointService,
  bodies: SnapshotBodies,
  reader: CheckpointReader,
): void {
  const { db } = ctx
  const client = isRestoreSyncClient(ctx.sync)
    ? ctx.sync
    : createHttpRestoreSyncClient({ baseUrl: ctx.config.syncInternalUrl, secret: ctx.config.internalSecret })

  // one restore per board at a time in this process: its checkpoint, then its write (two at once each get the
  // checkpoint of the board as the other left it, and their writes reach the room queue in that order)
  const locks = new Map<string, Promise<unknown>>()
  const oneAtATime = <T>(boardId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(boardId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    locks.set(boardId, tail)
    void tail.then(() => {
      if (locks.get(boardId) === tail) locks.delete(boardId)
    })
    return run
  }

  /**
   * The 'before_restore' checkpoint (or the newest one, when the board equals it): its id. An "Undo restore" names
   * its own 'Before undoing a restore' (it restores from a 'before_restore' checkpoint: "Before restoring" of
   * that name would nest).
   */
  async function checkpointFirst(boardId: string, about: CheckpointAbout): Promise<string> {
    let outcome: Awaited<ReturnType<CheckpointService['capture']>>
    try {
      outcome = await checkpoints.capture(boardId, 'before_restore', about)
    } catch (e) {
      if (e instanceof SyncUnavailable)
        throw new ApiError(503, RESTORE_ELEMENTS_ERROR_CODES.unavailable, NO_CHECKPOINT)
      throw e
    }
    if (outcome.status === 'saved') return outcome.checkpoint.id
    if (outcome.status === 'unchanged') {
      const newest = await db.maybeOne<{ id: string }>(
        `SELECT id FROM board_snapshots WHERE board_id = $1 AND body_version = 2
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [boardId],
      )
      if (newest) return newest.id
    }
    throw new ApiError(503, RESTORE_ELEMENTS_ERROR_CODES.unavailable, NO_CHECKPOINT)
  }

  app.post(RESTORE_ELEMENTS_ROUTE, HEAVY, async (req): Promise<RestoreElementsResult> => {
    const user = await ctx.requireUser(req)
    const { bid = '', sid = '' } = req.params as Params
    const input = parse(RestoreElementsInput, req.body)
    const access = await requireBoardAction(db, bid, user.id, 'edit')
    if ((await userKind(db, user.id)) === 'guest') throw guestRefused(RESTORE_ELEMENTS_GUESTS)
    if (!canCreateInWorkspace(access.workspaceRole)) throw forbidden(WORKSPACE_GUESTS)
    if (!SNAPSHOT_ID_PATTERN.test(sid)) throw notFound()
    const row = await db.maybeOne<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_FROM} WHERE s.id = $1`,
      [sid],
    )
    if (!row || row.board_id !== bid || row.workspace_id !== access.board.workspace_id) throw notFound()
    // an api on the tldraw sync (bridge release R0's) has no live element board to restore into
    if (!(await onNewCanvas(ctx)))
      throw new ApiError(503, RESTORE_ELEMENTS_ERROR_CODES.unavailable, UNAVAILABLE)
    const raw = await bodies.read(row.storage_key)
    if (raw === null) throw gone("This checkpoint's saved content is no longer available.")
    const read = await reader.elementsOf(row, raw)
    if (read.kind === 'busy')
      throw new ApiError(503, 'PREVIEW_BUSY', 'Previews are busy right now. Try again in a moment.')
    if (read.kind === 'too-large')
      throw conflict('CHECKPOINT_TOO_LARGE', 'This checkpoint is too large to restore from here.')
    if (read.kind === 'unreadable')
      throw conflict('CHECKPOINT_UNREADABLE', 'This checkpoint can’t be restored from here.')
    const ids = [...new Set(input.ids)]
    const elements = closeOverLabels(read.elements, ids)
    if (!elements.length && !input.removeAbsent)
      throw new ApiError(400, 'NOT_IN_CHECKPOINT', 'None of these objects are in this checkpoint.')
    if (elements.length > RESTORE_ELEMENTS_MAX_ELEMENTS)
      throw new ApiError(400, 'TOO_MANY_ELEMENTS', 'Restore fewer objects at a time.')

    return oneAtATime(bid, async () => {
      const checkpointId = await checkpointFirst(
        bid,
        input.removeAbsent ? { undoingRestore: true } : { restoredName: row.name },
      )
      const body: RestoreElementsBody = {
        actor: { uid: user.id, name: user.name.slice(0, 200) },
        ids,
        elements,
        ...(input.removeAbsent ? { removeAbsent: true as const } : {}),
      }
      let answer: RestoreSyncAnswer
      try {
        answer = await client.restoreElements(bid, body)
      } catch (e) {
        if (e instanceof SyncUnavailable) throw syncUnavailable()
        throw e
      }
      const code = (answer.body as { error?: { code?: unknown } } | null)?.error?.code
      if (answer.status === 404)
        throw new ApiError(503, RESTORE_ELEMENTS_ERROR_CODES.unavailable, UNAVAILABLE)
      if (answer.status === 409 && code === 'element-limit')
        throw conflict(
          RESTORE_ELEMENTS_ERROR_CODES.elementLimit,
          'This board is full, so these objects can’t come back.',
        )
      if (answer.status === 409)
        throw conflict(
          'RESTORE_CONFLICT',
          'These objects can’t be restored as they are. Try fewer at a time.',
        )
      if (answer.status !== 200) throw syncUnavailable()
      const parsed = RestoreElementsAnswer.safeParse(answer.body)
      if (!parsed.success) throw syncUnavailable()
      const skipped: Record<string, number> = {}
      for (const s of parsed.data.skipped) skipped[s.code] = (skipped[s.code] ?? 0) + 1
      req.log.info(
        {
          evt: 'history.restore_elements',
          asked: ids.length,
          sent: elements.length,
          restored: parsed.data.restored.length,
          skipped,
          undo: !!input.removeAbsent,
          converted: read.converted,
        },
        'restored elements from a checkpoint',
      )
      return { ...parsed.data, checkpointId }
    })
  })
}
