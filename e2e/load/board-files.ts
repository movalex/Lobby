// Board FILES for the load runs (docs/EXCALIDRAW-MIGRATION.md §8.3 B9 "Test boards are generated inside a
// container"): written by gen-boards.ts into sync's rooms folder before sync starts.
//
//  - Excalidraw boards as `lb_*` tables, with the frozen DDL (apps/sync/src/room/schema.ts: LB_DDL,
//    LB_PRAGMAS), one row per element at clock 0 (as a seed writes them, §2.4.6), tombstones as rows with
//    `deleted = 1`, and lb_meta clock/horizon 0, a fresh epoch and schemaVersion. O1's store reads these
//    rows as its own; run.ts checks that sync serves every element before a run (`--seed file`).
//  - Unconverted tldraw boards (the conversion-under-load run): the tldraw era's storage tables, written
//    as the tldraw sync wrote them (apps/sync/test/harness/tldraw-file.ts) with records validated against
//    the era's schema, so the lazy conversion meets a real tldraw board file. Notes only (no frames or images: the generator has no
//    validated factories for them), in the heavy board's grid; the planted over-cap board is the same with
//    many notes and long texts.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureLbSchema,
  LB_PRAGMAS,
  LB_SCHEMA_VERSION,
  serializeGclock,
} from '../../apps/sync/src/room/schema.ts'
import { BOARD_ID_RE, boardDbPath } from '../../apps/sync/src/rooms.ts'
import { noteShape } from '../../apps/sync/test/harness/records.ts'
import {
  DOCUMENT_RECORD,
  PAGE_RECORD,
  writeTldrawBoardFile,
} from '../../apps/sync/test/harness/tldraw-file.ts'
import type { WireElement } from '../../packages/canvas-schema/src/elements.ts'
import { GEN_UPDATED } from './boards.ts'

/** sync's rooms folder under its data dir (@draftroom/dev-assets dataLayout: `<data>/rooms`). */
export const roomsDir = (dataDir: string) => join(resolve(dataDir), 'rooms')

export interface WrittenBoard {
  readonly boardId: string
  readonly path: string
  readonly rows: number
  readonly bytes: number
  readonly ms: number
}

/** Writes an Excalidraw board file (lb_* only). Refuses to overwrite an existing file. */
export function writeLbBoard(
  dataDir: string,
  boardId: string,
  elements: readonly WireElement[],
): WrittenBoard {
  if (!BOARD_ID_RE.test(boardId)) throw new Error(`invalid board id ${boardId}`)
  const t0 = Date.now()
  const dir = roomsDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const path = boardDbPath(dir, boardId)
  if (existsSync(path)) throw new Error(`board file exists already: ${boardId}`)
  const db = new DatabaseSync(path)
  try {
    for (const p of LB_PRAGMAS) db.exec(p)
    db.exec('BEGIN IMMEDIATE')
    ensureLbSchema(db)
    const meta = db.prepare('INSERT INTO lb_meta (key, value) VALUES (?, ?)')
    meta.run('clock', '0')
    meta.run('horizon', '0')
    meta.run('epoch', randomBytes(12).toString('base64url'))
    meta.run('schemaVersion', String(LB_SCHEMA_VERSION))
    const row = db.prepare(
      `INSERT INTO lb_elements (id, clock, idx, deleted, deleted_clock, deleted_at, type, version, gclock, data)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const el of elements) {
      if (el.index === null) throw new Error(`element ${el.id} has no index`)
      const deleted = el.isDeleted ? 1 : 0
      row.run(
        el.id,
        el.index,
        deleted,
        deleted ? 0 : null,
        deleted ? GEN_UPDATED : null,
        el.type,
        el.version,
        serializeGclock({}),
        JSON.stringify(el),
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw e
  } finally {
    db.close()
  }
  return { boardId, path, rows: elements.length, bytes: statSync(path).size, ms: Date.now() - t0 }
}

/** Writes an unconverted tldraw board of `notes` sticky notes with texts of about `textChars` characters. */
export function writeTldrawBoard(
  dataDir: string,
  boardId: string,
  opts: { notes: number; textChars?: number },
): WrittenBoard {
  const t0 = Date.now()
  const dir = roomsDir(dataDir)
  if (existsSync(boardDbPath(dir, boardId))) throw new Error(`board file exists already: ${boardId}`)
  const filler = 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor '
  const text = (i: number) => {
    const n = opts.textChars ?? 60
    let t = `Note ${i}: `
    while (t.length < n) t += filler
    return t.slice(0, n)
  }
  const records = []
  for (let i = 0; i < opts.notes; i++)
    records.push(noteShape(`${boardId}-n${i}`, text(i), { x: (i % 15) * 224, y: Math.floor(i / 15) * 224 }))
  mkdirSync(dir, { recursive: true })
  const path = boardDbPath(dir, boardId)
  writeTldrawBoardFile(path, [DOCUMENT_RECORD, PAGE_RECORD, ...records])
  return { boardId, path, rows: records.length, bytes: statSync(path).size, ms: Date.now() - t0 }
}
