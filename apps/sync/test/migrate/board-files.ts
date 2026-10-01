// Board-file helpers for O4's suites and B8's scripts (no vitest import: e2e/spike-b/b8/** uses them too).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/tldraw-import/schema'
import type { TLRecord } from '@draftroom/tldraw-import/tldraw'
import { ensureLbSchema, LB_PRAGMAS, serializeGclock } from '../../src/room/schema.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { seedBoardRecords, seedTldrawBoard } from '../harness/tldraw-file.ts'

export { seedBoardRecords, seedTldrawBoard }

export const fileSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Size of the file's WAL (0 when absent): a read-only reader must never add frames. */
export const walBytes = (path: string) => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0)

/**
 * A board born on the new canvas, as O1's store writes one (the frozen §2.6 DDL, LB_PRAGMAS, lb_meta
 * without `converted_from`, one element). WAL-checkpointed and closed.
 */
export function makeBornAfterFile(path: string): void {
  const db = new DatabaseSync(path)
  try {
    for (const p of LB_PRAGMAS) db.exec(p)
    db.exec('BEGIN IMMEDIATE')
    ensureLbSchema(db)
    const meta = db.prepare('INSERT INTO lb_meta (key, value) VALUES (?, ?)')
    meta.run('clock', '1')
    meta.run('horizon', '0')
    meta.run('epoch', 'e-born-after')
    meta.run('schemaVersion', '1')
    db.prepare(
      'INSERT INTO lb_elements (id, clock, idx, deleted, type, version, gclock, data) VALUES (?, ?, ?, 0, ?, 1, ?, ?)',
    ).run('r1', 1, 'a0', 'rectangle', serializeGclock({}), JSON.stringify({ id: 'r1', type: 'rectangle' }))
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

/** Every table name of a board file (read-only). */
export function tablesOf(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
  } finally {
    db.close()
  }
}

// ---- conversion and roll-forward helpers -----------------------------------------------------------------

const FIXTURES = new URL('../../../../packages/tldraw-import/test/fixtures/', import.meta.url)

/** A converter fixture's records (templates regenerated from this tree, [DATA]'s kitchen sink). */
export function fixtureRecords(name: string): TLRecord[] {
  return JSON.parse(readFileSync(new URL(`tl-${name}.json`, FIXTURES), 'utf8')) as TLRecord[]
}

/** Appends captured deletes to a board's "Recently deleted" as one batch (what a client's delete push leaves). */
export function addDeletedRows(
  path: string,
  records: readonly TLRecord[],
  by = { id: 'usr_deleter0001', name: 'D' },
) {
  const db = new DatabaseSync(path)
  try {
    const schemaId = (
      db.prepare('SELECT id FROM dr_deleted_schemas ORDER BY id LIMIT 1').get() as { id: number }
    ).id
    const batch = Number(
      (db.prepare('SELECT COALESCE(MAX(batch), 0) + 1 AS b FROM dr_deleted_records').get() as { b: number })
        .b,
    )
    const ins = db.prepare(
      `INSERT INTO dr_deleted_records (batch, kind, record_id, shape_type, parent_id, from_id, to_id, state, schema_id,
         deleted_by, deleted_by_name, deleted_at, epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of records) {
      const rec = r as unknown as Record<string, unknown>
      ins.run(
        batch,
        r.typeName === 'binding' ? 'binding' : 'shape',
        r.id,
        r.typeName === 'shape' ? String(rec.type) : null,
        typeof rec.parentId === 'string' ? rec.parentId : null,
        typeof rec.fromId === 'string' ? rec.fromId : null,
        typeof rec.toId === 'string' ? rec.toId : null,
        JSON.stringify(r),
        schemaId,
        by.id,
        by.name,
        1_759_000_000_000,
        'epoch-old',
      )
    }
  } finally {
    db.close()
  }
}

/** Opens a board file read-only for the length of `fn`. */
export function readDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

export interface LbRow {
  id: string
  clock: number
  idx: string
  deleted: number
  type: string
  version: number
  gclock: string
  data: string
}

/** Every lb_elements row, by id. */
export const lbRows = (path: string): Map<string, LbRow> =>
  readDb(
    path,
    (db) =>
      new Map((db.prepare('SELECT * FROM lb_elements').all() as unknown as LbRow[]).map((r) => [r.id, r])),
  )

/**
 * An Excalidraw-side edit as O1's store writes one: the element's data changed by `mutate`, version + 1,
 * each written group's gclock slot and the row clock set to a new board clock above every other.
 */
export function excalidrawEdit(
  path: string,
  id: string,
  groups: readonly string[],
  mutate: (el: Record<string, unknown>) => void,
) {
  const db = new DatabaseSync(path)
  try {
    db.exec('BEGIN IMMEDIATE')
    const clock =
      Number((db.prepare("SELECT value FROM lb_meta WHERE key = 'clock'").get() as { value: string }).value) +
      1
    const row = db.prepare('SELECT * FROM lb_elements WHERE id = ?').get(id) as unknown as LbRow
    const el = JSON.parse(row.data) as Record<string, unknown>
    mutate(el)
    el.version = row.version + 1
    const gc = JSON.parse(row.gclock) as Record<string, number>
    for (const g of groups) gc[g] = clock
    const sorted = Object.fromEntries(Object.entries(gc).sort(([a], [b]) => (a < b ? -1 : 1)))
    const deleted = el.isDeleted === true ? 1 : 0
    db.prepare(
      'UPDATE lb_elements SET clock = ?, idx = ?, deleted = ?, deleted_clock = ?, deleted_at = ?, version = ?, gclock = ?, data = ? WHERE id = ?',
    ).run(
      clock,
      String(el.index),
      deleted,
      deleted ? clock : null,
      deleted ? 1 : null,
      row.version + 1,
      JSON.stringify(sorted),
      JSON.stringify(el),
      id,
    )
    db.prepare("UPDATE lb_meta SET value = ? WHERE key = 'clock'").run(String(clock))
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/** An Excalidraw-side creation (a new element row at `clock` + 1). */
export function excalidrawCreate(path: string, el: Record<string, unknown>) {
  const db = new DatabaseSync(path)
  try {
    db.exec('BEGIN IMMEDIATE')
    const clock =
      Number((db.prepare("SELECT value FROM lb_meta WHERE key = 'clock'").get() as { value: string }).value) +
      1
    db.prepare(
      'INSERT INTO lb_elements (id, clock, idx, deleted, type, version, gclock, data) VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
    ).run(
      String(el.id),
      clock,
      String(el.index),
      String(el.type),
      Number(el.version),
      '{}',
      JSON.stringify(el),
    )
    db.prepare("UPDATE lb_meta SET value = ? WHERE key = 'clock'").run(String(clock))
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/**
 * A tldraw-side (R0) edit: what R0's room wrote into the tldraw tables for one push (records set or
 * deleted at the next document clock; a delete leaves a tombstone), as SQL on the file (R0's code is not
 * on this branch). Records set are validated against the era's schema.
 */
export function r0Edit(
  dataDir: string,
  boardId: string,
  fn: (txn: {
    get(id: string): TLRecord | undefined
    set(id: string, r: TLRecord): void
    delete(id: string): void
  }) => void,
) {
  const db = new DatabaseSync(boardDbPath(dataDir, boardId))
  try {
    db.exec('BEGIN IMMEDIATE')
    const meta = db.prepare('SELECT documentClock FROM metadata LIMIT 1').get() as { documentClock: number }
    const clock = Number(meta.documentClock) + 1
    const read = db.prepare('SELECT state FROM documents WHERE id = ?')
    const upsert = db.prepare(
      'INSERT INTO documents (id, state, lastChangedClock) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, lastChangedClock = excluded.lastChangedClock',
    )
    const remove = db.prepare('DELETE FROM documents WHERE id = ?')
    const tombstone = db.prepare(
      'INSERT INTO tombstones (id, clock) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET clock = excluded.clock',
    )
    fn({
      get: (id) => {
        const row = read.get(id) as { state: Uint8Array } | undefined
        return row ? (JSON.parse(Buffer.from(row.state).toString('utf8')) as TLRecord) : undefined
      },
      set: (id, r) => {
        ;(draftroomSchema.types as Record<string, { validate(x: unknown): unknown }>)[r.typeName]?.validate(r)
        upsert.run(id, Buffer.from(JSON.stringify(r), 'utf8'), clock)
        db.prepare('DELETE FROM tombstones WHERE id = ?').run(id)
      },
      delete: (id) => {
        remove.run(id)
        tombstone.run(id, clock)
      },
    })
    db.prepare('UPDATE metadata SET documentClock = ?').run(clock)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

/**
 * R0 restoring shapes from its "Recently deleted" (deleted/restore.ts of the tldraw era): the newest
 * captured state of each id goes back into `documents` at the next clock, and the capture's rows for
 * that id are removed (removeRestored). Ids with no captured row are skipped.
 */
export function r0Restore(path: string, ids: readonly string[]): string[] {
  const db = new DatabaseSync(path)
  const restored: string[] = []
  try {
    db.exec('BEGIN IMMEDIATE')
    const meta = db.prepare('SELECT documentClock FROM metadata LIMIT 1').get() as { documentClock: number }
    const clock = Number(meta.documentClock) + 1
    for (const id of ids) {
      const row = db
        .prepare('SELECT state FROM dr_deleted_records WHERE record_id = ? ORDER BY seq DESC LIMIT 1')
        .get(id) as { state: string } | undefined
      if (!row) continue
      db.prepare(
        'INSERT INTO documents (id, state, lastChangedClock) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, lastChangedClock = excluded.lastChangedClock',
      ).run(id, Buffer.from(row.state, 'utf8'), clock)
      db.prepare('DELETE FROM tombstones WHERE id = ?').run(id)
      db.prepare('DELETE FROM dr_deleted_records WHERE record_id = ?').run(id)
      restored.push(id)
    }
    if (restored.length) db.prepare('UPDATE metadata SET documentClock = ?').run(clock)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  return restored
}

/** R0's trim of its capture (deleted/store.ts trimNow): whole batches, oldest first, down to the newest `keepBatches`. */
export function r0Trim(path: string, keepBatches = 1): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.prepare(
      'DELETE FROM dr_deleted_records WHERE batch NOT IN (SELECT DISTINCT batch FROM dr_deleted_records ORDER BY batch DESC LIMIT ?)',
    ).run(keepBatches)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}
