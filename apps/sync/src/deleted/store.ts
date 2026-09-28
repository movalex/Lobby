// "Recently deleted" (REV-07): the records of committed shape deletes, kept in a side table of the
// board's own SQLite database (never in tldraw's documents/objects/tombstones/metadata tables).
//
// Capture path (hot, inside the push transaction — see sql.ts and capture.ts):
//   authorizer allowed a delete -> noteDeleted(prev) buffers it in memory (no I/O in the authorizer)
//   -> flush() from the transaction's before-commit hook writes one batch under a SAVEPOINT, so a
//   capture failure is logged and rolled back alone and never fails the user's delete.
// Bounded: the most recent `retainRecent` deleted shapes of any room session, plus everything deleted
// since the room opened (the current session), up to `hardCap`. Trimming drops whole batches (one push
// = one batch, restored together), oldest first, so each limit is rounded up to the batch it falls in:
// at most hardCap + perPush shapes are ever kept.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { TLRecord } from '@tldraw/tlschema'
import { shapeLabel } from './label.ts'

export interface DeletedBy {
  userId: string
  name: string
}

export interface DeletedLimits {
  /** Deleted shapes always kept, whichever room session deleted them. */
  retainRecent: number
  /** Most deleted shapes kept at all (the current session's included). */
  hardCap: number
  /** Most shapes one push can add (a bigger mass delete keeps its first `perPush`). */
  perPush: number
  /** Trim again only after this many more rows (amortizes the cost off most commits). */
  trimEvery: number
  /** Most entries one list call returns. */
  listLimit: number
}

export const DELETED_LIMITS: Readonly<DeletedLimits> = Object.freeze({
  retainRecent: 1_000,
  hardCap: 10_000,
  perPush: 10_000,
  trimEvery: 100,
  listLimit: 2_000,
})

/** Our tables in the board database. Nothing here ever writes to tldraw's tables. */
export const DELETED_TABLES = ['dr_deleted_records', 'dr_deleted_schemas'] as const

const DDL = `
CREATE TABLE IF NOT EXISTS dr_deleted_schemas (
  id INTEGER PRIMARY KEY,
  schema TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS dr_deleted_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  batch INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shape', 'binding')),
  record_id TEXT NOT NULL,
  shape_type TEXT,
  parent_id TEXT,
  from_id TEXT,
  to_id TEXT,
  state TEXT NOT NULL,
  schema_id INTEGER NOT NULL REFERENCES dr_deleted_schemas (id),
  deleted_by TEXT NOT NULL,
  deleted_by_name TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  epoch TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dr_deleted_records_record_idx ON dr_deleted_records (record_id, seq);
CREATE INDEX IF NOT EXISTS dr_deleted_records_batch_idx ON dr_deleted_records (batch);
`

/**
 * Creates the side tables if needed and registers the serialized schema the captured records are
 * written in (restore migrates them from it). Call inside the room-open transaction.
 */
export function ensureDeletedTables(db: DatabaseSync, serializedSchema: string): number {
  db.exec(DDL)
  db.prepare('INSERT OR IGNORE INTO dr_deleted_schemas (schema) VALUES (?)').run(serializedSchema)
  const row = db.prepare('SELECT id FROM dr_deleted_schemas WHERE schema = ?').get(serializedSchema) as
    | { id: number }
    | undefined
  if (!row) throw new Error('recently-deleted schema row missing')
  return row.id
}

export interface DeletedRow {
  seq: number
  batch: number
  kind: 'shape' | 'binding'
  recordId: string
  shapeType: string | null
  parentId: string | null
  fromId: string | null
  toId: string | null
  state: string
  schemaId: number
  deletedBy: string
  deletedByName: string
  deletedAt: number
  epoch: string
}

export interface DeletedEntry {
  shapeId: string
  type: string
  label: string
  deletedAt: string
  deletedBy: { id: string; name: string }
  childCount: number
}

type RawRow = {
  seq: number
  batch: number
  kind: 'shape' | 'binding'
  record_id: string
  shape_type: string | null
  parent_id: string | null
  from_id: string | null
  to_id: string | null
  state: string
  schema_id: number
  deleted_by: string
  deleted_by_name: string
  deleted_at: number
  epoch: string
}

const toRow = (r: RawRow): DeletedRow => ({
  seq: r.seq,
  batch: r.batch,
  kind: r.kind,
  recordId: r.record_id,
  shapeType: r.shape_type,
  parentId: r.parent_id,
  fromId: r.from_id,
  toId: r.to_id,
  state: r.state,
  schemaId: r.schema_id,
  deletedBy: r.deleted_by,
  deletedByName: r.deleted_by_name,
  deletedAt: r.deleted_at,
  epoch: r.epoch,
})

const COLUMNS =
  'seq, batch, kind, record_id, shape_type, parent_id, from_id, to_id, state, schema_id, deleted_by, deleted_by_name, deleted_at, epoch'

interface Pending {
  record: TLRecord
  by: DeletedBy
}

/** Chunks for `IN (…)` lists (well under SQLite's bound-parameter limit). */
function chunks<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Within one batch: the top-most shape of the batch that `id` sits in (itself when its parent survived). */
function rootIn(batch: Map<string, { parentId: string | null }>, id: string): string {
  let current = id
  for (let guard = 0; guard < 1_000; guard++) {
    const parent = batch.get(current)?.parentId
    if (!parent || parent === current || !batch.has(parent)) return current
    current = parent
  }
  return current // a cycle in client-sent parent ids: stop anywhere, never loop
}

export class DeletedStore {
  readonly epoch: string
  private readonly db: DatabaseSync
  private readonly schemaId: number
  private readonly limits: DeletedLimits
  private readonly now: () => number
  private readonly log: (...a: unknown[]) => void
  private readonly stmts: Record<
    | 'insert'
    | 'maxBatch'
    | 'countShapes'
    | 'nthRecentShapeBatch'
    | 'trimOldSessions'
    | 'trimAll'
    | 'allShapes'
    | 'latestShape'
    | 'batchRows'
    | 'schema',
    StatementSync
  >
  private nextBatch: number
  private shapeRows: number
  private rowsAtLastTrim: number
  private trimScheduled = false
  private closed = false
  private pending = new Map<string, Pending>()

  constructor(opts: {
    db: DatabaseSync
    schemaId: number
    epoch?: string
    limits?: Partial<DeletedLimits>
    now?: () => number
    log?: (...a: unknown[]) => void
  }) {
    this.db = opts.db
    this.schemaId = opts.schemaId
    this.epoch = opts.epoch ?? randomUUID()
    this.limits = { ...DELETED_LIMITS, ...opts.limits }
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
    const db = this.db
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO dr_deleted_records (batch, kind, record_id, shape_type, parent_id, from_id, to_id, state, schema_id, deleted_by, deleted_by_name, deleted_at, epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      maxBatch: db.prepare('SELECT COALESCE(MAX(batch), 0) AS b FROM dr_deleted_records'),
      countShapes: db.prepare("SELECT COUNT(*) AS n FROM dr_deleted_records WHERE kind = 'shape'"),
      nthRecentShapeBatch: db.prepare(
        "SELECT batch FROM dr_deleted_records WHERE kind = 'shape' ORDER BY seq DESC LIMIT 1 OFFSET ?",
      ),
      trimOldSessions: db.prepare('DELETE FROM dr_deleted_records WHERE batch < ? AND epoch <> ?'),
      trimAll: db.prepare('DELETE FROM dr_deleted_records WHERE batch < ?'),
      allShapes: db.prepare(
        `SELECT seq, batch, record_id, shape_type, parent_id, deleted_by, deleted_by_name, deleted_at
           FROM dr_deleted_records WHERE kind = 'shape' ORDER BY seq DESC`,
      ),
      latestShape: db.prepare(
        `SELECT ${COLUMNS} FROM dr_deleted_records WHERE record_id = ? AND kind = 'shape' ORDER BY seq DESC LIMIT 1`,
      ),
      batchRows: db.prepare(`SELECT ${COLUMNS} FROM dr_deleted_records WHERE batch = ? ORDER BY seq`),
      schema: db.prepare('SELECT schema FROM dr_deleted_schemas WHERE id = ?'),
    }
    this.nextBatch = Number((this.stmts.maxBatch.get() as { b: number }).b) + 1
    this.shapeRows = Number((this.stmts.countShapes.get() as { n: number }).n)
    this.rowsAtLastTrim = 0
  }

  // ---- capture (inside the push transaction) ------------------------------------------------------

  /** Called by the authorizer for a delete it ALLOWED. Memory only; flush() decides what is kept. */
  noteDeleted(record: TLRecord, by: DeletedBy): void {
    if (record.typeName !== 'shape' && record.typeName !== 'binding') return
    this.pending.set(record.id, { record, by })
  }

  /** After every transaction (committed or not): nothing of it may leak into the next one. */
  discardPending(): void {
    if (this.pending.size) this.pending = new Map()
  }

  /**
   * Writes what this push deleted, as one batch. Runs inside the push transaction just before COMMIT.
   * Never throws: a failure rolls back to its own savepoint and is logged.
   */
  flush(): void {
    if (this.pending.size === 0) return
    const pending = this.pending
    this.pending = new Map()
    const shapes: Pending[] = []
    const bindings: Pending[] = []
    for (const p of pending.values()) (p.record.typeName === 'shape' ? shapes : bindings).push(p)
    if (shapes.length === 0) return // a binding deleted on its own (connector end dragged away)

    // A group deleted without any of its content is an ungroup (tldraw removes the emptied group):
    // nothing a person would want back.
    const parents = new Set<string>()
    for (const s of shapes) if (s.record.typeName === 'shape') parents.add(s.record.parentId)
    let kept = shapes.filter(
      (s) => s.record.typeName === 'shape' && (s.record.type !== 'group' || parents.has(s.record.id)),
    )
    if (kept.length > this.limits.perPush) {
      this.log('[deleted] mass delete: keeping', this.limits.perPush, 'of', kept.length, 'shapes')
      kept = kept.slice(0, this.limits.perPush)
    }
    if (kept.length === 0) return
    const keptIds = new Set(kept.map((s) => s.record.id))
    // Connector bindings are kept only with a shape deleted in the same push (either end).
    const keptBindings = bindings.filter(
      (b) => b.record.typeName === 'binding' && (keptIds.has(b.record.fromId) || keptIds.has(b.record.toId)),
    )

    const batch = this.nextBatch++
    const at = this.now()
    this.db.exec('SAVEPOINT dr_deleted_capture')
    try {
      for (const { record, by } of [...kept, ...keptBindings]) {
        const isShape = record.typeName === 'shape'
        this.stmts.insert.run(
          batch,
          isShape ? 'shape' : 'binding',
          record.id,
          isShape ? record.type : null,
          isShape ? record.parentId : null,
          record.typeName === 'binding' ? record.fromId : null,
          record.typeName === 'binding' ? record.toId : null,
          JSON.stringify(record),
          this.schemaId,
          by.userId,
          by.name.slice(0, 200),
          at,
          this.epoch,
        )
      }
      this.shapeRows += kept.length
      this.db.exec('RELEASE dr_deleted_capture')
      if (
        this.shapeRows > this.limits.retainRecent &&
        this.shapeRows - this.rowsAtLastTrim >= this.limits.trimEvery
      )
        this.scheduleTrim()
    } catch (e) {
      try {
        this.db.exec('ROLLBACK TO dr_deleted_capture')
        this.db.exec('RELEASE dr_deleted_capture')
      } catch {}
      this.shapeRows = Number((this.stmts.countShapes.get() as { n: number }).n)
      this.log('[deleted] capture failed (the delete itself was kept)', (e as Error)?.message ?? e)
    }
  }

  /**
   * Trimming is not needed for the delete to be safe, so it stays off the commit path: it runs right
   * after the push, in its own short transaction (deleting old rows can cost as much as capturing).
   */
  private scheduleTrim(): void {
    if (this.trimScheduled || this.closed) return
    this.trimScheduled = true
    setImmediate(() => {
      this.trimScheduled = false
      if (this.closed) return
      try {
        this.trimNow()
      } catch (e) {
        this.log('[deleted] trim failed (retried after the next capture)', (e as Error)?.message ?? e)
      }
    })
  }

  /** Drops whole batches older than the retention (see the header), in one transaction. */
  trimNow(): void {
    if (this.db.isTransaction) {
      this.scheduleTrim() // never inside someone else's transaction
      return
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const recent = this.stmts.nthRecentShapeBatch.get(this.limits.retainRecent - 1) as
        | { batch: number }
        | undefined
      if (recent) this.stmts.trimOldSessions.run(recent.batch, this.epoch)
      const cap = this.stmts.nthRecentShapeBatch.get(this.limits.hardCap - 1) as { batch: number } | undefined
      if (cap) this.stmts.trimAll.run(cap.batch)
      this.db.exec('COMMIT')
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw e
    }
    this.shapeRows = Number((this.stmts.countShapes.get() as { n: number }).n)
    this.rowsAtLastTrim = this.shapeRows
  }

  /** The board database is closing: no more deferred work. */
  close(): void {
    this.closed = true
  }

  // ---- reads --------------------------------------------------------------------------------------

  /**
   * Restorable deletions, newest first: one entry per shape deleted on its own or as the top of what
   * one push deleted (its content is counted in childCount and restored with it). A shape's older
   * rows (deleted, brought back by undo, deleted again) and shapes back on the board are left out.
   */
  list(
    isOnBoard: (id: string) => boolean,
    limit = this.limits.listLimit,
  ): { entries: DeletedEntry[]; total: number } {
    if (this.trimScheduled && !this.db.isTransaction) this.trimNow() // show the bounded list, not the backlog
    const rows = this.stmts.allShapes.all() as Array<
      Pick<
        RawRow,
        | 'seq'
        | 'batch'
        | 'record_id'
        | 'shape_type'
        | 'parent_id'
        | 'deleted_by'
        | 'deleted_by_name'
        | 'deleted_at'
      >
    >
    const latest = new Map<string, number>()
    for (const r of rows) if (!latest.has(r.record_id)) latest.set(r.record_id, r.seq)
    const live = (r: { record_id: string; seq: number }) =>
      latest.get(r.record_id) === r.seq && !isOnBoard(r.record_id)

    const entries: DeletedEntry[] = []
    const roots: Array<(typeof rows)[number]> = []
    const childCounts = new Map<number, number>()
    let i = 0
    while (i < rows.length) {
      const batchNo = rows[i]?.batch
      const inBatch: typeof rows = []
      while (i < rows.length && rows[i]?.batch === batchNo) inBatch.push(rows[i++] as (typeof rows)[number])
      const byId = new Map(inBatch.map((r) => [r.record_id, { parentId: r.parent_id }]))
      const rootSeq = new Map<string, number>()
      for (const r of inBatch) if (rootIn(byId, r.record_id) === r.record_id) rootSeq.set(r.record_id, r.seq)
      for (const r of inBatch) {
        if (!live(r)) continue
        const root = rootIn(byId, r.record_id)
        if (root === r.record_id) roots.push(r)
        else {
          const seq = rootSeq.get(root)
          if (seq !== undefined) childCounts.set(seq, (childCounts.get(seq) ?? 0) + 1)
        }
      }
    }
    roots.sort((a, b) => b.seq - a.seq)
    for (const r of roots.slice(0, limit)) {
      const full = this.stmts.latestShape.get(r.record_id) as RawRow | undefined
      let label = ''
      try {
        label = full ? shapeLabel(JSON.parse(full.state)) : ''
      } catch {}
      entries.push({
        shapeId: r.record_id,
        type: r.shape_type ?? 'shape',
        label,
        deletedAt: new Date(r.deleted_at).toISOString(),
        deletedBy: { id: r.deleted_by, name: r.deleted_by_name },
        childCount: childCounts.get(r.seq) ?? 0,
      })
    }
    return { entries, total: roots.length }
  }

  /** The stored JSON of every captured shape row, one at a time (the asset collector's scan). */
  *shapeStates(): IterableIterator<string> {
    for (const row of this.db.prepare("SELECT state FROM dr_deleted_records WHERE kind = 'shape'").iterate())
      yield String((row as { state: string }).state)
  }

  /** The newest captured row of a shape, if any. */
  latestShapeRow(id: string): DeletedRow | null {
    const r = this.stmts.latestShape.get(id) as RawRow | undefined
    return r ? toRow(r) : null
  }

  /**
   * What restoring `id` brings back: its newest row plus every shape the same push deleted inside it
   * (rows that are also their shape's newest). Empty when nothing was captured for `id`.
   */
  shapesToRestore(id: string): DeletedRow[] {
    const root = this.latestShapeRow(id)
    if (!root) return []
    const batch = (this.stmts.batchRows.all(root.batch) as RawRow[])
      .map(toRow)
      .filter((r) => r.kind === 'shape')
    const children = new Map<string, DeletedRow[]>()
    for (const r of batch) {
      if (!r.parentId) continue
      const list = children.get(r.parentId) ?? []
      list.push(r)
      children.set(r.parentId, list)
    }
    const out: DeletedRow[] = [root]
    const seen = new Set([root.recordId])
    const queue = [root.recordId]
    while (queue.length) {
      const parent = queue.shift() as string
      for (const child of children.get(parent) ?? []) {
        if (seen.has(child.recordId)) continue
        seen.add(child.recordId)
        if (this.latestShapeRow(child.recordId)?.seq !== child.seq) continue
        out.push(child)
        queue.push(child.recordId)
      }
    }
    return out
  }

  /** Newest captured row of every binding with an end in `shapeIds`. */
  bindingsTouching(shapeIds: readonly string[]): DeletedRow[] {
    const found = new Map<string, DeletedRow>()
    for (const part of chunks(shapeIds)) {
      const marks = part.map(() => '?').join(', ')
      const rows = this.db
        .prepare(
          `SELECT ${COLUMNS} FROM dr_deleted_records
            WHERE kind = 'binding' AND (from_id IN (${marks}) OR to_id IN (${marks})) ORDER BY seq DESC`,
        )
        .all(...part, ...part) as RawRow[]
      for (const r of rows)
        if (!found.has(r.record_id) || (found.get(r.record_id)?.seq ?? 0) < r.seq)
          found.set(r.record_id, toRow(r))
    }
    return [...found.values()]
  }

  /** The serialized schema a row was captured in. */
  schemaJson(schemaId: number): string | null {
    return (this.stmts.schema.get(schemaId) as { schema: string } | undefined)?.schema ?? null
  }

  /** After a restore (call inside the same storage transaction): these are back on the board. */
  removeRestored(shapeIds: readonly string[], bindingIds: readonly string[]): void {
    for (const [kind, ids] of [
      ['shape', shapeIds],
      ['binding', bindingIds],
    ] as const) {
      for (const part of chunks(ids)) {
        this.db
          .prepare(
            `DELETE FROM dr_deleted_records WHERE kind = ? AND record_id IN (${part.map(() => '?').join(', ')})`,
          )
          .run(kind, ...part)
      }
    }
    this.shapeRows = Number((this.stmts.countShapes.get() as { n: number }).n)
  }

  /** Row counts (tests, diagnostics). */
  counts(): { shapes: number; bindings: number } {
    const r = this.db
      .prepare(
        "SELECT SUM(kind = 'shape') AS shapes, SUM(kind = 'binding') AS bindings FROM dr_deleted_records",
      )
      .get() as { shapes: number | null; bindings: number | null }
    return { shapes: Number(r.shapes ?? 0), bindings: Number(r.bindings ?? 0) }
  }
}
