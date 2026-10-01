// What a board file is, as the migration service sees it (docs/EXCALIDRAW-MIGRATION.md §5.3 "Two entry
// points", §5.9 step 3). One read-only connection; never writes. Shared by the service (the event loop)
// and the drop-legacy job (the worker), so it imports nothing heavy.

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { ConvertedFrom } from '../schema.ts'

export type BoardFileState =
  | 'missing'
  /** tldraw tables, no lb_meta: needs the lazy conversion */
  | 'tldraw'
  /** converted and nothing changed on the tldraw side since */
  | 'converted'
  /** converted, and R0 wrote the tldraw side since (a rollback happened): needs the roll-forward */
  | 'rollforward-needed'
  /** lb_* only, no converted_from: made on the new canvas */
  | 'element'
  /** unreadable as a board */
  | 'unknown'

/** Classifies a board file with one read-only connection. Never writes. */
export function boardFileState(path: string): BoardFileState {
  if (!existsSync(path)) return 'missing'
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 2000')
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((r) => r.name),
    )
    const tldraw = tables.has('documents') && tables.has('metadata')
    if (!tables.has('lb_meta')) return tldraw ? 'tldraw' : tables.size === 0 ? 'missing' : 'unknown'
    const row = db.prepare("SELECT value FROM lb_meta WHERE key = 'converted_from'").get() as
      | { value: string }
      | undefined
    if (!row) return 'element'
    if (!tldraw) return 'converted'
    const cf = JSON.parse(row.value) as ConvertedFrom
    const meta = db.prepare('SELECT documentClock FROM metadata LIMIT 1').get() as
      | { documentClock: number | bigint }
      | undefined
    if (Number(meta?.documentClock ?? 0) > cf.documentClock) return 'rollforward-needed'
    if (tables.has('dr_deleted_records')) {
      const r = db.prepare('SELECT max(seq) AS m FROM dr_deleted_records').get() as { m: number | null }
      if (Number(r.m ?? 0) > cf.deletedSeq) return 'rollforward-needed'
    }
    return 'converted'
  } finally {
    db.close()
  }
}
