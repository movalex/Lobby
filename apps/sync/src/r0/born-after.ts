// The R0 stand-in's born-after check (docs/EXCALIDRAW-MIGRATION.md §5.9 step 4, §8.3 B8 "The R0
// stand-in", §5.10). O4 owns this file; it becomes R0's reviewed code and gate test.
//
// R0 (the bridge release, tldraw) must never open a TLSocketRoom or SQLiteSyncStorage on a board that
// was born on the new canvas: either would create tldraw's `documents` and `metadata` tables inside an
// element board file. RoomRegistry.open() runs this check (registered through engine-switch.ts
// `registerPreOpenCheck`) BEFORE its writable `new DatabaseSync(path)`, and every room open and every
// internal board route (snapshot, text, asset-refs, seed, deleted, place-notes) reaches a board file
// through open(), so this one check covers all of them.
//
// What it does, before any writable handle exists:
//  - no file: nothing to check (a new tldraw board; the check never creates the file);
//  - otherwise it opens the file READ-ONLY, looks in sqlite_master for `lb_meta` and, if it exists,
//    reads `converted_from`:
//      - no `lb_meta`: a tldraw board, served as today;
//      - `lb_meta` with `converted_from` and tldraw's tables: a converted board, served by the tldraw
//        room as R0 serves it (R0 never writes or trims any lb_* table: nothing here names one except
//        this read);
//      - `lb_meta` WITHOUT `converted_from` (or a converted board whose tldraw tables are gone): born on
//        the new canvas → refused with reason `new-canvas` (sockets 4099 NEW_CANVAS_BOARD, internal
//        routes 409 `new-canvas`, both mapped by the lead's app.ts and router.ts).
// A read error is thrown as it is (open() then fails before any writable handle exists): refusing or
// serving on a guess could both be wrong, and neither may touch the file.
//
// The read-only handle never writes board data. On a WAL file SQLite may create the `-shm` index a
// read-only reader needs; that is not board data (§8.3 B8 "born-after").

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { PreOpenCheck, PreOpenVerdict } from '../engine-switch.ts'

/** What a board file is, as the stand-in sees it. */
export type BoardFileKind =
  /** no file yet (a new tldraw board) */
  | 'missing'
  /** tldraw tables only (or an empty file): served */
  | 'tldraw'
  /** lb_* with `lb_meta.converted_from`, and tldraw's tables: served by the tldraw room */
  | 'converted'
  /** lb_* without `converted_from`: born on the new canvas, refused */
  | 'born-after'
  /** `converted_from` present but tldraw's `documents`/`metadata` are gone (after drop-legacy): refused */
  | 'converted-without-tldraw'

/** How long the read-only reader waits for a writer's lock (the event loop is blocked meanwhile). */
const READ_BUSY_TIMEOUT_MS = 2_000

/** Classifies a board file with one read-only connection (closed before returning). Never writes. */
export function classifyBoardFile(path: string): BoardFileKind {
  if (!existsSync(path)) return 'missing'
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec(`PRAGMA busy_timeout = ${READ_BUSY_TIMEOUT_MS}`)
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((r) => r.name),
    )
    if (!tables.has('lb_meta')) return 'tldraw'
    const row = db.prepare("SELECT value FROM lb_meta WHERE key = 'converted_from'").get() as
      | { value: string }
      | undefined
    if (!row) return 'born-after'
    if (!tables.has('documents') || !tables.has('metadata')) return 'converted-without-tldraw'
    return 'converted'
  } finally {
    db.close()
  }
}

/** The verdict for one kind: only tldraw and converted boards may be opened by the tldraw room. */
export function verdictFor(kind: BoardFileKind): PreOpenVerdict {
  return kind === 'born-after' || kind === 'converted-without-tldraw'
    ? { ok: false, reason: 'new-canvas' }
    : { ok: true }
}

/** The pre-open check the stand-in registers (r0/index.ts). Synchronous, like RoomRegistry.open(). */
export const bornAfterCheck: PreOpenCheck = (ctx) =>
  ctx.exists ? verdictFor(classifyBoardFile(ctx.path)) : { ok: true }
