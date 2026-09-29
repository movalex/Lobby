// How the internal routes built outside the room (room-internal/**) reach a board file of the Excalidraw
// engine (docs/EXCALIDRAW-MIGRATION.md §2.4.6, §2.6), through the room service's public surface only:
//
//  - READS open the board file READ-ONLY (a second SQLite connection; WAL lets it read beside the room's
//    writer) inside one read transaction, so every answer is one consistent state. A board file that
//    still holds a tldraw board (or a converted one whose tldraw side moved during a rollback) is first
//    prepared by the room: `service.prepareBoard` (CR 2F-2) when the room has it, else through the room's
//    own snapshot route, which waits for the same conversion (room/index.ts `existing`).
//  - WRITES (seed, place-notes, restore) are one `ServerWriteApply`: synchronous, inside one transaction.
//    When the room has `service.serverWrite` (CR 2F-2) the room runs it in its queue, so every session
//    gets the change. Until then a write runs here only while the board has no room in this process
//    (checked in the same synchronous block that opens the file, so no socket can open one meanwhile):
//    the next room open reads it from the file. A write to an open board answers 503 `unavailable`
//    ("try again"), never a write behind the room's back. One writer per board file stays true.

import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { RoomExtensionContext, ServerWriteApply } from '../engine-switch.ts'
import { HttpError } from '../http/respond.ts'
import { boardFileState } from '../room/migrate/index.ts'
import type { ConvertedFrom } from '../room/schema.ts'
import { BoardNeedsConversion, BoardStore } from '../room/store.ts'
import { BOARD_ID_RE, boardDbPath } from '../rooms.ts'

export const unavailable = (message = 'This board is not available right now. Try again in a moment.') =>
  new HttpError(503, 'unavailable', message)
export const boardNotFound = () => new HttpError(404, 'board-not-found', 'No such board.')

/** A board id from a route's capture (still percent-encoded), checked against the strict pattern. */
export function boardParam(raw: string): string {
  let id: string
  try {
    id = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'bad-request', 'Invalid board id.')
  }
  if (!BOARD_ID_RE.test(id)) throw new HttpError(400, 'bad-request', 'Invalid board id.')
  return id
}

export const boardPath = (ctx: RoomExtensionContext, boardId: string) =>
  boardDbPath(ctx.deps.dataDir, boardId)

const now = (ctx: RoomExtensionContext) => ctx.deps.now?.() ?? Date.now()

// ---- preparation --------------------------------------------------------------------------------------

/** A response that keeps nothing: the room's snapshot route is called only for its preparation. */
function discardingResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    writeHead(status: number) {
      res.statusCode = status
      res.headersSent = true
      return res
    },
    setHeader() {
      return res
    },
    end() {
      return res
    },
    write() {
      return true
    },
  }
  return res as unknown as ServerResponse
}

/** Has the room convert (or roll forward) a board file that needs it, and waits for it. */
async function prepare(ctx: RoomExtensionContext, boardId: string): Promise<void> {
  if (ctx.service.prepareBoard) {
    await ctx.service.prepareBoard(boardId)
    return
  }
  const path = `/internal/boards/${encodeURIComponent(boardId)}/snapshot`
  const route = ctx.service.routes().find((r) => r.method === 'GET' && r.path.test(path))
  if (!route) throw unavailable()
  const match = route.path.exec(path)
  const req = { method: 'GET', url: path, headers: {} } as unknown as IncomingMessage
  await route.handle(req, discardingResponse(), match ? match.slice(1) : [])
}

/**
 * The board file of `boardId`, ready to read on the new canvas: 'missing' when the board has no file (it
 * was never opened or seeded). Throws 503 when it could not be prepared.
 */
export async function readableBoard(
  ctx: RoomExtensionContext,
  boardId: string,
): Promise<{ state: 'missing' } | { state: 'ready'; path: string }> {
  const path = boardPath(ctx, boardId)
  let state = boardFileState(path)
  if (state === 'missing') return { state }
  if (state === 'tldraw' || state === 'rollforward-needed') {
    await prepare(ctx, boardId)
    state = boardFileState(path)
  }
  if (state === 'element' || state === 'converted') return { state: 'ready', path }
  if (state === 'missing') return { state }
  throw unavailable('This board is not ready on the new canvas.')
}

// ---- reads ----------------------------------------------------------------------------------------------

/** Runs `fn` on a read-only connection to the board file, inside one read transaction. */
export function readBoardFile<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN')
    try {
      return fn(db)
    } finally {
      if (db.isTransaction) db.exec('COMMIT')
    }
  } finally {
    db.close()
  }
}

export interface BoardMeta {
  clock: number
  epoch: string
  horizon: number
  convertedFrom: ConvertedFrom | null
}

export function readMeta(db: DatabaseSync): BoardMeta {
  const rows = db.prepare('SELECT key, value FROM lb_meta').all() as { key: string; value: string }[]
  const m = new Map(rows.map((r) => [r.key, r.value]))
  let convertedFrom: ConvertedFrom | null = null
  try {
    const raw = m.get('converted_from')
    convertedFrom = raw ? (JSON.parse(raw) as ConvertedFrom) : null
  } catch {
    convertedFrom = null
  }
  return {
    clock: Number(m.get('clock') ?? 0) || 0,
    epoch: m.get('epoch') ?? '',
    horizon: Number(m.get('horizon') ?? 0) || 0,
    convertedFrom,
  }
}

/** Whether a table exists in the file (legacy tldraw tables are optional). */
export const hasTable = (db: DatabaseSync, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

// ---- writes ---------------------------------------------------------------------------------------------

/**
 * Runs a server write on the board (see the top of this file). `create`: the board file may not exist
 * yet (seed); otherwise a board without a file is 404.
 */
export async function writeBoard<T>(
  ctx: RoomExtensionContext,
  boardId: string,
  apply: ServerWriteApply<T>,
  opts: { create?: boolean } = {},
): Promise<T> {
  const path = boardPath(ctx, boardId)
  if (!opts.create) {
    const r = await readableBoard(ctx, boardId)
    if (r.state === 'missing') throw boardNotFound()
    if (ctx.service.serverWrite) return ctx.service.serverWrite(boardId, apply)
  }
  // From here on everything is synchronous: nothing can open this board between the check and the write.
  if (ctx.service.roomIfOpen(boardId))
    throw unavailable('This board is open on the new canvas; its server writes need the room (CR 2F-2).')
  if (!opts.create && !existsSync(path)) throw boardNotFound()
  let store: BoardStore
  try {
    store = new BoardStore(path)
  } catch (e) {
    if (e instanceof BoardNeedsConversion) throw unavailable('This board is not ready on the new canvas.')
    throw e
  }
  let wrote = false
  let result: T
  try {
    store.begin()
    try {
      const clock = store.meta.clock + 1
      const out = apply({ store, clock, now: now(ctx) })
      wrote = out.changed.length > 0 || Object.keys(out.doc).length > 0
      if (wrote) store.setClock(clock)
      store.commit()
      if (wrote) store.meta.clock = clock
      result = out.result
    } catch (e) {
      store.rollback()
      throw e
    }
  } finally {
    store.close()
  }
  if (wrote) ctx.deps.onDocumentChange(boardId)
  return result
}
