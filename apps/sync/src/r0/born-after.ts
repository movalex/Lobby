// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.9 step 4, §5.10): refuse boards born on the new
// canvas. Reviewed port of the spike's R0 stand-in check (spike/excalidraw apps/sync/src/r0/born-after.ts).
//
// R0 is the last tldraw build and the rollback target of the Excalidraw cut-over. After a cut-over, board
// files can hold the new engine's `lb_*` tables. R0 must never open a TLSocketRoom or SQLiteSyncStorage on
// a board born on the new canvas: either would create tldraw's `documents` and `metadata` tables inside an
// element board file. RoomRegistry.open() runs this check (through pre-open.ts) BEFORE its writable
// `new DatabaseSync(path)`, and every room open and every internal board route (snapshot, text,
// asset-refs, seed, deleted, place-notes) reaches a board file through open(), so this one check covers
// all of them.
//
// What it does, before any writable handle exists:
//  - no file: nothing to check (a new tldraw board; the check never creates the file);
//  - otherwise it opens the file READ-ONLY and lists its tables:
//      - no `lb_*` table: a tldraw board, served as today;
//      - `lb_meta` with a `converted_from` row, and tldraw's `documents` and `metadata`: a board converted
//        at the cut-over, served by the tldraw room from its tldraw tables (R0 never writes, trims or
//        alters any lb_* table: this read is the only place the room path looks at one);
//      - any other file with `lb_*` tables: born on the new canvas (no `converted_from`, or no `lb_meta`
//        at all), or converted and then stripped of its tldraw tables (after drop-legacy): refused with
//        reason `new-canvas` (sockets 4099 NEW_CANVAS_BOARD, internal routes 409 `new-canvas`).
// A read error is thrown as it is (open() then fails before any writable handle exists): refusing or
// serving on a guess could both be wrong, and neither may touch the file.
//
// The read-only handle never writes board data. On a WAL file SQLite may create the `-shm` index a
// read-only reader needs (and an empty `-wal`); that is not board data.

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/** What a board file is, as R0 sees it. */
export type BoardFileKind =
  /** no file yet (a new tldraw board) */
  | 'missing'
  /** tldraw tables only (or an empty file): served */
  | 'tldraw'
  /** lb_* with `lb_meta.converted_from`, and tldraw's tables: served by the tldraw room */
  | 'converted'
  /** lb_* without `converted_from` (or without `lb_meta`): born on the new canvas, refused */
  | 'born-after'
  /** `converted_from` present but tldraw's `documents`/`metadata` are gone (after drop-legacy): refused */
  | 'converted-without-tldraw'

/** How long the read-only reader waits for a writer's lock (the event loop is blocked meanwhile). */
const READ_BUSY_TIMEOUT_MS = 2_000

/** Every table name of an open database (read-only query). */
export function tableNames(db: DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  )
}

/** The new engine's tables: every name that starts with `lb_` (lb_prev_* included). */
export const isLbTable = (name: string) => name.startsWith('lb_')

/** The kind of a file whose tables are `tables`; reads `lb_meta` through `db` only when it exists. */
export function classifyTables(
  db: DatabaseSync,
  tables: ReadonlySet<string>,
): Exclude<BoardFileKind, 'missing'> {
  if (![...tables].some(isLbTable)) return 'tldraw'
  if (!tables.has('lb_meta')) return 'born-after'
  const row = db.prepare("SELECT 1 AS present FROM lb_meta WHERE key = 'converted_from'").get() as
    | { present: number }
    | undefined
  if (!row) return 'born-after'
  if (!tables.has('documents') || !tables.has('metadata')) return 'converted-without-tldraw'
  return 'converted'
}

/** Classifies a board file with one read-only connection (closed before returning). Never writes. */
export function classifyBoardFile(path: string): BoardFileKind {
  if (!existsSync(path)) return 'missing'
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec(`PRAGMA busy_timeout = ${READ_BUSY_TIMEOUT_MS}`)
    return classifyTables(db, tableNames(db))
  } finally {
    db.close()
  }
}

/** Only tldraw and converted boards may be opened by the tldraw room. */
export const isServable = (kind: BoardFileKind) =>
  kind === 'missing' || kind === 'tldraw' || kind === 'converted'
