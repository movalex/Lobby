// api -> sync internal endpoints (docs/M1-CONTRACTS.md §7, §8). The caller has already passed the
// internal-secret check in the router.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSchema } from '@tldraw/tlschema'
import type { AccessMonitor } from '../access.ts'
import { BOARD_ID_RE, type RoomRegistry } from '../rooms.ts'
import { emptyBoardSnapshot, prepareSeedSnapshot } from '../snapshot.ts'
import { readJson } from './body.ts'
import { HttpError, sendJson } from './respond.ts'

export interface InternalDeps {
  registry: RoomRegistry
  schema: TLSchema
  monitor: AccessMonitor
  isClosing(): boolean
  log: (...a: unknown[]) => void
}

const ACCESS_CHANGED_LIMIT = 16 * 1024
/** A board snapshot is JSON of every record; generous, but bounded before parsing. */
export const SEED_LIMIT_BYTES = 64 * 1024 * 1024

const badRequest = (message: string) => new HttpError(400, 'BAD_REQUEST', message)
const unavailable = () => new HttpError(503, 'SHUTTING_DOWN', 'The sync server is shutting down.')

function boardIdParam(raw: string): string {
  if (!BOARD_ID_RE.test(raw)) throw new HttpError(400, 'INVALID_BOARD_ID', 'Invalid board id.')
  return raw
}

export async function handleAccessChanged(req: IncomingMessage, res: ServerResponse, deps: InternalDeps) {
  const body = (await readJson(req, ACCESS_CHANGED_LIMIT)) as { boardId?: unknown; userId?: unknown } | null
  const boardId = body?.boardId
  const userId = body?.userId
  if (typeof boardId !== 'string' || !BOARD_ID_RE.test(boardId)) throw badRequest('boardId is invalid.')
  if (userId !== undefined && (typeof userId !== 'string' || userId.length === 0 || userId.length > 128))
    throw badRequest('userId is invalid.')
  // Answer at once: the re-check calls back into the API, which is waiting on this response.
  void deps.monitor
    .accessChanged(boardId, userId)
    .catch((e: unknown) => deps.log('[access] re-check error', e))
  res.writeHead(204, { 'Cache-Control': 'no-store' }).end()
}

export function handleSnapshot(res: ServerResponse, deps: InternalDeps, rawBoardId: string) {
  const boardId = boardIdParam(rawBoardId)
  if (deps.isClosing()) throw unavailable()
  // A board that was never opened has no storage; answer with what a first visitor would see.
  sendJson(res, 200, deps.registry.snapshot(boardId) ?? emptyBoardSnapshot(deps.schema))
}

export async function handleSeed(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InternalDeps,
  rawBoardId: string,
) {
  const boardId = boardIdParam(rawBoardId)
  const body = (await readJson(req, SEED_LIMIT_BYTES)) as { snapshot?: unknown } | null
  const prepared = prepareSeedSnapshot(body?.snapshot, deps.schema)
  if (!prepared.ok) throw new HttpError(400, 'INVALID_SNAPSHOT', `Invalid snapshot: ${prepared.message}`)
  // From here on everything is synchronous: nothing can open this board between check and write.
  if (deps.isClosing()) throw unavailable()
  const result = deps.registry.seed(boardId, prepared.snapshot)
  if (result === 'exists')
    throw new HttpError(
      409,
      'BOARD_EXISTS',
      'This board already has canvas data; seeding never overwrites it.',
    )
  sendJson(res, 201, { boardId, records: prepared.snapshot.documents.length })
}

// ---- "Recently deleted" (docs/FEATURES-M2-CONTRACTS.md "history"; the API proxies these) ----------

const RESTORE_LIMIT_BYTES = 256 * 1024
/** Most ids per restore call (the API allows the same). */
export const RESTORE_MAX_IDS = 500
const SHAPE_ID_RE = /^shape:[\x21-\x7e]{1,200}$/
const MAX_LIST_LIMIT = 2_000

/** GET /internal/boards/:bid/deleted?limit= -> { entries, total, limit } (newest first). */
export function handleListDeleted(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InternalDeps,
  rawBoardId: string,
) {
  const boardId = boardIdParam(rawBoardId)
  if (deps.isClosing()) throw unavailable()
  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit')
  let limit = MAX_LIST_LIMIT
  if (raw !== null) {
    if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1) throw badRequest('limit must be a positive integer.')
    limit = Math.min(Number(raw), MAX_LIST_LIMIT)
  }
  const { entries, total } = deps.registry.listDeleted(boardId, limit)
  sendJson(res, 200, { entries, total, limit })
}

/** POST /internal/boards/:bid/deleted/restore { ids } -> { restored, skipped, bindings, reparented }. */
export async function handleRestoreDeleted(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InternalDeps,
  rawBoardId: string,
) {
  const boardId = boardIdParam(rawBoardId)
  const body = (await readJson(req, RESTORE_LIMIT_BYTES)) as { ids?: unknown } | null
  const ids = body?.ids
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > RESTORE_MAX_IDS)
    throw badRequest(`ids must be an array of 1 to ${RESTORE_MAX_IDS} shape ids.`)
  for (const id of ids)
    if (typeof id !== 'string' || !SHAPE_ID_RE.test(id)) throw badRequest('ids must be shape ids.')
  if (deps.isClosing()) throw unavailable()
  sendJson(res, 200, deps.registry.restoreDeleted(boardId, ids as string[]))
}
