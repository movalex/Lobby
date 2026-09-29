// A staged restore of a CONVERTED board during a rollback (bridge release R0, docs/EXCALIDRAW-MIGRATION.md
// §5.9 step 2): the restored file gets the live board's new-canvas tables, unchanged.
//
// A converted board file holds tldraw's tables (which R0 serves) and the new engine's lb_* tables (the
// Excalidraw-era edits, lb_deleted, lb_source and lb_prev_*, which R0 never writes). A tldraw backup
// restored over it replaces the file whole; without this step those tables would survive only in the
// `.pre-restore-<stamp>` copy, and the roll-forward would convert the board afresh and lose them. So the
// restore puts the backup's tldraw side in place and carries the live file's lb_* side over as it is:
// every lb_* table (its schema SQL and every row, in order), its indexes, triggers and views, and the
// lb_* AUTOINCREMENT counters. The result is checked against the source (the same digests the R0 gate
// compares, r0/lb-files.ts); on any difference the restore is not applied.
//
// This is the only code in R0 that writes an lb_* table, and it writes them only into the restored copy
// before it is put in place (never into a live board file), byte-identical to the live board's own.
// The roll-forward then sees a tldraw side edited during the rollback (its clock was raised past the
// live one, restore.ts) and merges it as usual (§5.9 step 3).

import { DatabaseSync } from 'node:sqlite'
import { isLbTable } from './born-after.ts'
import { lbDigests, lbTableNames } from './lb-files.ts'

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

interface MasterRow {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}

/** Every lb_* schema object with its SQL, the counters, and every table's digest (what must match). */
export interface LbSide {
  tables: ReturnType<typeof lbDigests>
  /** indexes, triggers and views on lb_* tables (or named lb_*), by type and name */
  objects: Array<{ type: string; name: string; sql: string | null }>
  /** sqlite_sequence rows of lb_* tables */
  sequences: Array<{ name: string; seq: number }>
}

const hasTable = (db: DatabaseSync, schema: string, name: string) =>
  db.prepare(`SELECT 1 AS x FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
  undefined

function lbObjects(db: DatabaseSync, schema = 'main'): MasterRow[] {
  return (
    db
      .prepare(`SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_master ORDER BY rowid`)
      .all() as unknown as MasterRow[]
  ).filter((r) => r.type !== 'table' && (isLbTable(r.tbl_name) || isLbTable(r.name)))
}

function lbSequences(db: DatabaseSync, schema = 'main'): Array<{ name: string; seq: number }> {
  if (!hasTable(db, schema, 'sqlite_sequence')) return []
  return (
    db.prepare(`SELECT name, seq FROM ${schema}.sqlite_sequence ORDER BY name`).all() as Array<{
      name: string
      seq: number
    }>
  ).filter((r) => isLbTable(r.name))
}

/** The lb_* side of an open database (read-only queries). */
export function lbSide(db: DatabaseSync): LbSide {
  return {
    tables: lbDigests(db),
    objects: lbObjects(db)
      .map((r) => ({ type: r.type, name: r.name, sql: r.sql }))
      .sort((a, b) => `${a.type}/${a.name}`.localeCompare(`${b.type}/${b.name}`)),
    sequences: lbSequences(db),
  }
}

/** The lb_* side of a file, through a read-only connection. */
export function lbSideOfFile(path: string): LbSide {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return lbSide(db)
  } finally {
    db.close()
  }
}

/** Whether a file has any lb_* table (read-only). */
export function hasLbTables(path: string): boolean {
  return Object.keys(lbSideOfFile(path).tables).length > 0
}

/**
 * Replaces the lb_* side of `db` (the restored copy, not yet in place) with the one of `sourcePath` (a
 * consistent copy of the live board), in one transaction, then checks that both sides are identical.
 * Throws (with nothing committed, or the copy left to be discarded) when they are not.
 */
export function carryLbTables(db: DatabaseSync, sourcePath: string): { tables: number } {
  const expected = lbSideOfFile(sourcePath)
  db.prepare('ATTACH DATABASE ? AS lbsrc').run(sourcePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      // The backup's own lb_* side (a backup taken while the board was converted) goes first.
      for (const r of lbObjects(db).filter((o) => o.type === 'view' || o.type === 'trigger'))
        db.exec(`DROP ${r.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS main.${quoteIdent(r.name)}`)
      for (const t of lbTableNames(db)) db.exec(`DROP TABLE main.${quoteIdent(t)}`)
      if (hasTable(db, 'main', 'sqlite_sequence'))
        db.exec("DELETE FROM main.sqlite_sequence WHERE substr(name, 1, 3) = 'lb_'")

      const tables = (
        db
          .prepare("SELECT name, sql FROM lbsrc.sqlite_master WHERE type = 'table' ORDER BY rowid")
          .all() as Array<{ name: string; sql: string | null }>
      ).filter((t) => isLbTable(t.name))
      for (const t of tables) {
        if (!t.sql) throw new Error(`lb table ${t.name} has no schema SQL`)
        db.exec(t.sql) // unqualified: created in main, with the very same SQL text
        const order = /\bWITHOUT\s+ROWID\b/i.test(t.sql) ? '' : ' ORDER BY rowid'
        db.exec(`INSERT INTO main.${quoteIdent(t.name)} SELECT * FROM lbsrc.${quoteIdent(t.name)}${order}`)
      }
      const objects = lbObjects(db, 'lbsrc')
      for (const kind of ['index', 'view', 'trigger'])
        for (const o of objects) if (o.type === kind && o.sql) db.exec(o.sql)
      for (const s of lbSequences(db, 'lbsrc')) {
        const updated = db
          .prepare('UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?')
          .run(s.seq, s.name)
        if (Number(updated.changes) === 0)
          db.prepare('INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)').run(s.name, s.seq)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  } finally {
    db.exec('DETACH DATABASE lbsrc')
  }
  const got = lbSide(db)
  if (JSON.stringify(got) !== JSON.stringify(expected))
    throw new Error("the restored file's new-canvas (lb_*) tables differ from the live board's")
  return { tables: Object.keys(got.tables).length }
}
