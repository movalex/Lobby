// api -> sync internal endpoints (docs/M1-CONTRACTS.md §7, §8). The caller has already passed the
// internal-secret check in the router. The board routes (snapshot, seed, "Recently deleted", asset-refs,
// place-notes, text) are the ElementRoom's and its extensions' (room/http.ts, room-internal/**); this
// keeps what every route shares: the access re-check, the maintenance refusal and the restore cap.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AccessMonitor } from '../access.ts'
import { errorSummary } from '../log-error.ts'
import { BOARD_ID_RE } from '../rooms.ts'
import { readJson } from './body.ts'
import { HttpError } from './respond.ts'

export interface InternalDeps {
  monitor: AccessMonitor
  isClosing(): boolean
  log: (...a: unknown[]) => void
  /** Maintenance mode (bridge release R0, router.ts). Absent: never on. */
  maintenance?: { on(): boolean }
}

/** While maintenance is on, the internal routes that WRITE a board answer this (reads keep working). */
export const inMaintenance = () =>
  new HttpError(503, 'MAINTENANCE', 'Lobby is updating. Board changes are paused for a few minutes.')

/**
 * Refuses a board write while maintenance is on (bridge release R0). The router checks on entry; every
 * board-writing handler calls this AGAIN once its body has been read, synchronously before the write:
 * a body still arriving when maintenance goes on (a seed can be 64 MB) must not land after it, nor after
 * the final run-all backup that follows it (docs/EXCALIDRAW-MIGRATION.md §7.5 steps 3 and 4).
 */
export function refuseInMaintenance(deps: { maintenance?: { on(): boolean } }): void {
  if (deps.maintenance?.on()) throw inMaintenance()
}

const ACCESS_CHANGED_LIMIT = 16 * 1024

const badRequest = (message: string) => new HttpError(400, 'BAD_REQUEST', message)

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
    .catch((e: unknown) => deps.log('[access] re-check error', errorSummary(e)))
  res.writeHead(204, { 'Cache-Control': 'no-store' }).end()
}

// ---- "Recently deleted" (docs/FEATURES-M2-CONTRACTS.md "history"; the API proxies these) ----------

/** Most ids per restore call (the API allows the same; room-internal/deleted.ts enforces it). */
export const RESTORE_MAX_IDS = 500
