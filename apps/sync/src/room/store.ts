// The board file of one ElementRoom (docs/EXCALIDRAW-MIGRATION.md §2.6) on the frozen DDL of
// room/schema.ts: `lb_meta`, `lb_elements` (one row per element, its tombstone included), `lb_doc`,
// `lb_deleted`. No parsed element cache: merges read the stored row by id; snapshots concatenate the
// stored `data` strings.
//
// Synchronous (node:sqlite). The room owns the transaction boundaries: one BEGIN IMMEDIATE per drain
// batch, a SAVEPOINT per push (§2.4.3).

import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import {
  ensureLbSchema,
  ensureReceiptsSchema,
  type Gclock,
  LB_META_RECEIPT_GAPS,
  LB_PRAGMAS,
  LB_SCHEMA_VERSION,
  parseGclock,
  RECEIPTS,
  serializeGclock,
} from './schema.ts'

/** One `lb_elements` row, parsed. */
export interface ElementRow {
  readonly id: string
  readonly clock: number
  readonly idx: string
  readonly deleted: boolean
  readonly deletedClock: number | null
  readonly deletedAt: number | null
  readonly type: string
  readonly version: number
  readonly gclock: Gclock
  readonly el: WireElement
}

interface RawRow {
  id: string
  clock: number
  idx: string
  deleted: number
  deleted_clock: number | null
  deleted_at: number | null
  type: string
  version: number
  gclock: string
  data: string
}

const parseRow = (r: RawRow): ElementRow => ({
  id: r.id,
  clock: r.clock,
  idx: r.idx,
  deleted: r.deleted === 1,
  deletedClock: r.deleted_clock,
  deletedAt: r.deleted_at,
  type: r.type,
  version: r.version,
  gclock: parseGclock(r.gclock),
  el: JSON.parse(r.data) as WireElement,
})

/** A row to write: the element and its bookkeeping. */
export interface RowWrite {
  readonly el: WireElement
  readonly clock: number
  readonly gclock: Gclock
  readonly deletedClock: number | null
  readonly deletedAt: number | null
}

export interface DeletedRowWrite {
  readonly batch: number
  readonly el: WireElement
  readonly deletedBy: string
  readonly deletedByName: string
  readonly deletedAt: number
  /**
   * The room session that deleted it (one id per room open, element-room.ts), stored in `lb_deleted.epoch`
   * as today's store does (deleted/store.ts `epoch`; a converted row keeps its tldraw session's id).
   */
  readonly session: string
}

/**
 * "Recently deleted" retention (§2.6: the same limits and trim rules as today's store, deleted/store.ts
 * DELETED_LIMITS, pinned equal by store-deleted.test.ts): the most recent `retainRecent` rows of any room
 * session, plus everything the current room session deleted, up to `hardCap` rows in all; whole batches
 * are dropped, oldest first, so each limit is rounded up to the batch it falls in. Trimmed after every
 * `trimEvery` new deletions, outside the push that made them.
 */
export const LB_DELETED_LIMITS = Object.freeze({ retainRecent: 1_000, hardCap: 10_000, trimEvery: 100 })
export interface DeletedRetention {
  readonly retainRecent: number
  readonly hardCap: number
}

/** Board-level meta (lb_meta). */
export interface BoardMeta {
  clock: number
  horizon: number
  epoch: string
}

/** Tombstones kept: 14 days and at most 10,000 per board (limits.ts). */
export interface CompactionLimits {
  readonly maxTombstones: number
  readonly ttlMs: number
}

/** The file holds a tldraw board with no `lb_*` data: it must be converted first (O4, §5.3). */
export class BoardNeedsConversion extends Error {
  constructor() {
    super('This board has not been converted to the new canvas yet.')
    this.name = 'BoardNeedsConversion'
  }
}

const newEpoch = () => randomBytes(12).toString('base64url')

export class BoardStore {
  readonly path: string
  readonly db: DatabaseSync
  private readonly st: ReturnType<typeof prepareStatements>
  meta: BoardMeta
  private closed = false

  constructor(path: string) {
    this.path = path
    const db = new DatabaseSync(path)
    this.db = db
    try {
      for (const p of LB_PRAGMAS) db.exec(p)
      db.exec('BEGIN IMMEDIATE')
      try {
        const hasLbMeta = !!db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lb_meta'")
          .get()
        const hasTldraw = !!db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'")
          .get()
        if (!hasLbMeta && hasTldraw) throw new BoardNeedsConversion()
        ensureLbSchema(db)
        const get = db.prepare('SELECT value FROM lb_meta WHERE key = ?')
        const read = (k: string) => (get.get(k) as { value: string } | undefined)?.value
        let epoch = read('epoch')
        if (!epoch) {
          epoch = newEpoch()
          const set = db.prepare('INSERT OR REPLACE INTO lb_meta (key, value) VALUES (?, ?)')
          set.run('epoch', epoch)
          set.run('clock', '0')
          set.run('horizon', '0')
          set.run('schemaVersion', String(LB_SCHEMA_VERSION))
        }
        this.meta = {
          epoch,
          clock: Number(read('clock') ?? '0'),
          horizon: Number(read('horizon') ?? '0'),
        }
        db.exec('COMMIT')
      } catch (e) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw e
      }
    } catch (e) {
      db.close()
      throw e
    }
    this.st = prepareStatements(db)
  }

  // ---- transactions ----------------------------------------------------------------------------

  begin(): void {
    this.db.exec('BEGIN IMMEDIATE')
  }
  savepoint(name: string): void {
    this.db.exec(`SAVEPOINT ${name}`)
  }
  release(name: string): void {
    this.db.exec(`RELEASE ${name}`)
  }
  rollbackTo(name: string): void {
    this.db.exec(`ROLLBACK TO ${name}`)
    this.db.exec(`RELEASE ${name}`)
  }
  commit(): void {
    this.db.exec('COMMIT')
  }
  rollback(): void {
    if (this.db.isTransaction) this.db.exec('ROLLBACK')
  }
  get inTransaction(): boolean {
    return this.db.isTransaction
  }

  // ---- elements --------------------------------------------------------------------------------

  get(id: string): ElementRow | null {
    const r = this.st.get.get(id) as RawRow | undefined
    return r ? parseRow(r) : null
  }

  upsert(w: RowWrite): void {
    const el = w.el
    this.st.upsert.run(
      el.id,
      w.clock,
      el.index ?? '',
      el.isDeleted ? 1 : 0,
      w.deletedClock,
      w.deletedAt,
      el.type,
      el.version,
      serializeGclock(w.gclock),
      JSON.stringify(el),
    )
  }

  /** Rows written after `clock` (tombstones included), in `(idx, id)` order. */
  since(clock: number): ElementRow[] {
    return (this.st.since.all(clock) as unknown as RawRow[]).map(parseRow)
  }
  /**
   * The same rows as stored JSON with the deleted flag, unparsed: a catch-up concatenates them
   * (catch-up.ts), as the reset snapshot concatenates `snapshotRows()`.
   */
  sinceRaw(clock: number): { data: string; deleted: boolean }[] {
    return (this.st.sinceData.all(clock) as { data: string; deleted: number }[]).map((r) => ({
      data: r.data,
      deleted: r.deleted === 1,
    }))
  }
  countSince(clock: number): number {
    return (this.st.countSince.get(clock) as { n: number }).n
  }

  /**
   * Every element (tombstones included) as stored JSON with its deleted flag, in `(idx, id)` order: the
   * reset snapshot (element-room.ts redacts the tombstones before they leave, W5-02).
   */
  snapshotRows(): { data: string; deleted: boolean }[] {
    return (this.st.snapshotData.all() as { data: string; deleted: number }[]).map((r) => ({
      data: r.data,
      deleted: r.deleted === 1,
    }))
  }
  /** Live elements only, in `(idx, id)` order (the internal snapshot route). */
  liveJson(): string[] {
    return (this.st.liveData.all() as { data: string }[]).map((r) => r.data)
  }
  /** Every element, tombstones included, in `(id)` order (the test snapshot). */
  allJsonById(): string[] {
    return (this.st.allById.all() as { data: string }[]).map((r) => r.data)
  }
  /**
   * Live `(idx, id)` pairs in order, with what the room's caches need, read in SQL (json_extract) so a
   * board's thousands of rows are not parsed in JS at room open: the group ids (JSON text, null or '[]'
   * when none), whether the element is a bound label, and the guest uid that created it, if any. After a
   * SIGKILL every open board reopens at once (B9's restart window); the 3,798-row board's open was
   * one of the restart's longest tasks.
   */
  liveIndexRows(): {
    idx: string
    id: string
    type: string
    groupIds: string | null
    label: boolean
    byGuest: string | null
  }[] {
    return (
      this.st.liveIndex.all() as {
        idx: string
        id: string
        type: string
        groups: string | null
        cid: unknown
        guest: unknown
        by: unknown
      }[]
    ).map((r) => ({
      idx: r.idx,
      id: r.id,
      type: r.type,
      groupIds: r.groups,
      label: r.type === 'text' && typeof r.cid === 'string' && r.cid.length > 0,
      byGuest: (r.guest === 1 || r.guest === true) && typeof r.by === 'string' ? r.by : null,
    }))
  }
  /**
   * Every tombstone's `(idx, id)`, whether it is a bound label, and who created it (the room's caches: the
   * z-order keys a live element may not take, V3; the guest cap's deleted items, D5). Read in SQL, so a
   * board's 10,000 tombstones are not parsed at room open.
   */
  tombstoneIndexRows(): { idx: string; id: string; label: boolean; byGuest: string | null }[] {
    return (
      this.st.deadIndex.all() as { idx: string; id: string; cid: unknown; guest: unknown; by: unknown }[]
    ).map((r) => ({
      idx: r.idx,
      id: r.id,
      label: typeof r.cid === 'string' && r.cid.length > 0,
      byGuest: (r.guest === 1 || r.guest === true) && typeof r.by === 'string' ? r.by : null,
    }))
  }
  counts(): { live: number; dead: number } {
    const r = this.st.counts.get() as { live: number | null; dead: number | null }
    return { live: r.live ?? 0, dead: r.dead ?? 0 }
  }
  liveChildrenOfFrame(frameId: string): string[] {
    return (this.st.childrenOfFrame.all(frameId) as { id: string }[]).map((r) => r.id)
  }

  // ---- meta ------------------------------------------------------------------------------------

  setClock(clock: number): void {
    this.st.setMeta.run('clock', String(clock))
  }
  setHorizon(horizon: number): void {
    this.st.setMeta.run('horizon', String(horizon))
  }

  /**
   * The receipt gaps lb_meta keeps (schema.ts LB_META_RECEIPT_GAPS, RCPT-1): per user, the highest clock whose
   * receipt is missing. Empty when there are none; an unreadable value counts as none and is logged by the
   * caller's count only (it holds no content).
   */
  receiptGapsMeta(): Map<string, number> {
    const out = new Map<string, number>()
    const row = this.st.getMeta.get(LB_META_RECEIPT_GAPS) as { value: string } | undefined
    if (!row) return out
    try {
      const v = JSON.parse(row.value) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v))
        for (const [uid, clock] of Object.entries(v as Record<string, unknown>))
          if (typeof clock === 'number' && Number.isSafeInteger(clock) && clock >= 0) out.set(uid, clock)
    } catch {
      // not JSON: none
    }
    return out
  }
  /** Writes lb_meta's receipt gaps (`gaps` empty: removes the key). Inside a batch that advances the clock. */
  setReceiptGapsMeta(gaps: ReadonlyMap<string, number>): void {
    if (!gaps.size) this.st.delMeta.run(LB_META_RECEIPT_GAPS)
    else this.st.setMeta.run(LB_META_RECEIPT_GAPS, JSON.stringify(Object.fromEntries(gaps)))
  }

  // ---- doc -------------------------------------------------------------------------------------

  /** Every doc key with a value (null = removed keys are left out). */
  docAll(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const r of this.st.docAll.all() as { key: string; value: string | null }[])
      if (r.value !== null) out[r.key] = JSON.parse(r.value)
    return out
  }
  docGet(key: string): { clock: number; value: unknown } | null {
    const r = this.st.docGet.get(key) as { clock: number; value: string | null } | undefined
    return r ? { clock: r.clock, value: r.value === null ? null : JSON.parse(r.value) } : null
  }
  docSet(key: string, clock: number, value: unknown): void {
    this.st.docSet.run(key, clock, value === null ? null : JSON.stringify(value))
  }
  /** The clock every doc key was last written at, removed keys included (`welcome.docClocks`, CONTRACTS_REV 9). */
  docClocks(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.st.docClocks.all() as { key: string; clock: number }[]) out[r.key] = r.clock
    return out
  }
  /** The doc keys written after `clock`, null for a removed one (the `changes` after a cached snapshot, DEF-3F-1). */
  docSince(clock: number): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const r of this.st.docSince.all(clock) as { key: string; value: string | null }[])
      out[r.key] = r.value === null ? null : JSON.parse(r.value)
    return out
  }
  docCountPrefix(prefix: string): number {
    return (this.st.docCountPrefix.get(prefix.length, prefix) as { n: number }).n
  }
  /** How many doc keys were written at `clock` (a server write's report is checked against it). */
  docCountAt(clock: number): number {
    return (this.st.docCountAt.get(clock) as { n: number }).n
  }

  // ---- push receipts (CONTRACTS_REV 11, W5-ENG-2; schema.ts lb_receipts) ---------------------------

  /** Whether lb_receipts exists in the file (null: not checked since the open or a rolled-back write). */
  private receiptsTable: boolean | null = null
  private hasReceiptsTable(): boolean {
    this.receiptsTable ??= !!this.db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'lb_receipts'")
      .get()
    return this.receiptsTable
  }
  /** After a rolled-back receipts write (its CREATE TABLE may have gone with it): checked again. */
  forgetReceiptsTable(): void {
    this.receiptsTable = null
  }

  /**
   * Records committed pushes' receipts, inside the batch's transaction (they commit with the push). The
   * table is made here, in the first batch that has a receipt, not when the file is opened (schema.ts
   * lb_receipts: it changes the file only together with its clock).
   */
  putReceipts(rows: readonly { uid: string; rid: string; clock: number }[], at: number): void {
    if (!rows.length) return
    if (!this.hasReceiptsTable()) {
      ensureReceiptsSchema(this.db)
      this.receiptsTable = true
    }
    for (const r of rows) this.st.receiptPut.run(r.uid, r.rid, r.clock, at)
  }

  /**
   * A receipt gap (element-room.ts recordReceipts, wave D2): per user, the highest clock of a committed push
   * whose receipt could not be recorded, kept as that user's marker row (as the ring's trim keeps what it
   * dropped), so `receipts()` answers complete only past it, after a restart too. Inside the batch's
   * transaction (it advances the clock); makes the table when the failed write's CREATE was rolled back.
   */
  markReceiptGap(gap: ReadonlyMap<string, number>, now: number): void {
    if (!gap.size) return
    if (!this.hasReceiptsTable()) {
      ensureReceiptsSchema(this.db)
      this.receiptsTable = true
    }
    for (const [uid, clock] of gap) this.st.receiptMark.run(uid, clock, now)
  }

  /**
   * The ring's limits, in a batch that wrote receipts: each of `uids` back to `perUser` receipts once it holds
   * `trimAt` (its marker remembers the highest clock dropped), and, when `ttl`, every receipt older than
   * `ttlMs` (the board marker). Returns how many rows were dropped.
   */
  trimReceipts(uids: Iterable<string>, now: number, ttl: boolean): number {
    if (!this.hasReceiptsTable()) return 0
    let dropped = 0
    const mark = (uid: string, clock: number) => this.st.receiptMark.run(uid, clock, now)
    for (const uid of new Set(uids)) {
      const n = (this.st.receiptCount.get(uid) as { n: number }).n
      if (n < RECEIPTS.trimAt) continue
      const cut = this.st.receiptNth.get(uid, RECEIPTS.perUser) as { clock: number } | undefined
      if (!cut) continue
      dropped += Number(this.st.receiptDropUser.run(uid, cut.clock).changes)
      mark(uid, cut.clock)
    }
    if (ttl) {
      const old = this.st.receiptOldest.get(now - RECEIPTS.ttlMs) as { clock: number | null }
      if (old.clock !== null) {
        dropped += Number(this.st.receiptDropAll.run(old.clock).changes)
        mark('', old.clock)
      }
    }
    return dropped
  }

  /**
   * The answer to a receipts query for `uid`: the named receipts it holds (id → clock), and the clock from
   * which this user's receipts are complete (the higher of its marker and the board's, plus one; 0 when
   * nothing was ever trimmed).
   */
  receipts(uid: string, rids: readonly string[]): { landed: Record<string, number>; from: number } {
    // no table: no receipt was ever recorded in this file (rev 11 makes it with the first one)
    if (!this.hasReceiptsTable()) return { landed: {}, from: 0 }
    const landed: Record<string, number> = {}
    for (const rid of new Set(rids)) {
      if (!rid) continue
      const r = this.st.receiptGet.get(uid, rid) as { clock: number } | undefined
      if (r) landed[rid] = r.clock
    }
    const m = this.st.receiptFloor.get(uid) as { clock: number | null }
    return { landed, from: m.clock === null ? 0 : m.clock + 1 }
  }

  // ---- recently deleted ------------------------------------------------------------------------

  insertDeleted(w: DeletedRowWrite): void {
    const el = w.el as WireElement & { containerId?: string | null }
    this.st.deletedInsert.run(
      w.batch,
      el.id,
      el.type,
      el.containerId ?? null,
      el.frameId ?? null,
      JSON.stringify(el),
      w.deletedBy,
      w.deletedByName,
      w.deletedAt,
      w.session,
    )
  }

  /** Who deleted the element last ("Recently deleted"'s row), or null when no row is kept (trimmed, or converted without one). */
  deletedBy(id: string): string | null {
    const r = this.st.deletedBy.get(id) as { deleted_by: string | null } | undefined
    return r?.deleted_by ?? null
  }

  /**
   * The retention of LB_DELETED_LIMITS (outside a push): rows of other room sessions older than the
   * batch of the `retainRecent`-th newest row go, then every row older than the batch of the
   * `hardCap`-th newest row. "Older" is by `seq` (insertion order), never by batch number: a converted
   * board's rows keep their tldraw batch numbers, which overlap the room's (a push's clock). A batch
   * is kept whole from its first row on. Returns how many rows were dropped.
   */
  trimDeleted(limits: DeletedRetention, session: string): number {
    const floorOf = (nth: number): number | null => {
      const row = this.st.deletedNth.get(nth - 1) as { batch: number } | undefined
      if (!row) return null
      return (this.st.deletedBatchFloor.get(row.batch) as { s: number }).s
    }
    let dropped = 0
    const recent = floorOf(limits.retainRecent)
    if (recent !== null) dropped += Number(this.st.deletedTrimOld.run(recent, session).changes)
    const cap = floorOf(limits.hardCap)
    if (cap !== null) dropped += Number(this.st.deletedTrimAll.run(cap).changes)
    return dropped
  }
  deletedCount(): number {
    return (this.st.deletedCount.get() as { n: number }).n
  }

  // ---- compaction (§2.6): at room open ---------------------------------------------------------

  /**
   * Purges tombstones older than `ttlMs`, and the oldest beyond `maxTombstones`, then raises `horizon`
   * to the highest purged deletion clock (a client whose `since` is below it gets a reset). Returns
   * how many rows were purged.
   */
  compact(now: number, limits: CompactionLimits): number {
    const victims = new Map<string, number>()
    for (const r of this.st.tombstonesOlder.all(now - limits.ttlMs) as {
      id: string
      deleted_clock: number | null
    }[])
      victims.set(r.id, r.deleted_clock ?? 0)
    for (const r of this.st.tombstonesByAge.all(limits.maxTombstones) as {
      id: string
      deleted_clock: number | null
    }[])
      victims.set(r.id, r.deleted_clock ?? 0)
    if (victims.size === 0) return 0
    let horizon = this.meta.horizon
    this.begin()
    try {
      for (const [id, dc] of victims) {
        this.st.purge.run(id)
        horizon = Math.max(horizon, dc)
      }
      this.setHorizon(horizon)
      this.commit()
    } catch (e) {
      this.rollback()
      throw e
    }
    this.meta.horizon = horizon
    return victims.size
  }

  sizeBytes(): number {
    let n = 0
    for (const p of [this.path, `${this.path}-wal`]) if (existsSync(p)) n += statSync(p).size
    return n
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.rollback()
    } finally {
      this.db.close()
    }
  }
}

const COLS = 'id, clock, idx, deleted, deleted_clock, deleted_at, type, version, gclock, data'

/**
 * Every statement the store runs, prepared on its first use and kept for the life of the open file. The
 * room open prepared all of them at once (about 40 statements, about 2 ms per board on the workstation,
 * several times that on the NAS): after a SIGKILL every open board's room reopens inside the restart
 * window B9 measured, and a reconnect storm uses a handful of them.
 */
function prepareStatements(db: DatabaseSync) {
  const prepared = new Map<string, StatementSync>()
  const p = (sql: string): StatementSync => {
    let st = prepared.get(sql)
    if (!st) {
      st = db.prepare(sql)
      prepared.set(sql, st)
    }
    return st
  }
  const lazy = <T extends Record<string, string>>(sql: T): { readonly [K in keyof T]: StatementSync } => {
    const out = {} as Record<string, StatementSync>
    for (const k of Object.keys(sql))
      Object.defineProperty(out, k, { enumerable: true, get: () => p(sql[k] as string) })
    return out as { readonly [K in keyof T]: StatementSync }
  }
  return lazy({
    get: `SELECT ${COLS} FROM lb_elements WHERE id = ?`,
    upsert: `INSERT INTO lb_elements (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET clock = excluded.clock, idx = excluded.idx, deleted = excluded.deleted,
         deleted_clock = excluded.deleted_clock, deleted_at = excluded.deleted_at, type = excluded.type,
         version = excluded.version, gclock = excluded.gclock, data = excluded.data`,
    since: `SELECT ${COLS} FROM lb_elements WHERE clock > ? ORDER BY idx, id`,
    sinceData: 'SELECT data, deleted FROM lb_elements WHERE clock > ? ORDER BY idx, id',
    countSince: 'SELECT count(*) AS n FROM lb_elements WHERE clock > ?',
    snapshotData: 'SELECT data, deleted FROM lb_elements ORDER BY idx, id',
    liveData: 'SELECT data FROM lb_elements WHERE deleted = 0 ORDER BY idx, id',
    allById: 'SELECT data FROM lb_elements ORDER BY id',
    liveIndex: `SELECT idx, id, type, json_extract(data, '$.groupIds') AS groups,
         json_extract(data, '$.containerId') AS cid,
         json_extract(data, '$.customData.lobbyServer.createdBy.guest') AS guest,
         json_extract(data, '$.customData.lobbyServer.createdBy.uid') AS by
         FROM lb_elements WHERE deleted = 0 ORDER BY idx, id`,
    deadIndex: `SELECT idx, id, json_extract(data, '$.containerId') AS cid,
         json_extract(data, '$.customData.lobbyServer.createdBy.guest') AS guest,
         json_extract(data, '$.customData.lobbyServer.createdBy.uid') AS by
         FROM lb_elements WHERE deleted = 1 ORDER BY idx, id`,
    counts:
      'SELECT sum(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS live, sum(deleted) AS dead FROM lb_elements',
    childrenOfFrame: "SELECT id FROM lb_elements WHERE deleted = 0 AND json_extract(data, '$.frameId') = ?",
    setMeta: 'INSERT OR REPLACE INTO lb_meta (key, value) VALUES (?, ?)',
    getMeta: 'SELECT value FROM lb_meta WHERE key = ?',
    delMeta: 'DELETE FROM lb_meta WHERE key = ?',
    docAll: 'SELECT key, clock, value FROM lb_doc',
    docGet: 'SELECT key, clock, value FROM lb_doc WHERE key = ?',
    docSet: 'INSERT OR REPLACE INTO lb_doc (key, clock, value) VALUES (?, ?, ?)',
    docClocks: 'SELECT key, clock FROM lb_doc',
    docSince: 'SELECT key, value FROM lb_doc WHERE clock > ?',
    docCountPrefix: 'SELECT count(*) AS n FROM lb_doc WHERE value IS NOT NULL AND substr(key, 1, ?) = ?',
    deletedInsert: `INSERT INTO lb_deleted (batch, element_id, type, container_id, frame_id, data, deleted_by,
         deleted_by_name, deleted_at, epoch, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
    deletedCount: 'SELECT count(*) AS n FROM lb_deleted',
    deletedBy: 'SELECT deleted_by FROM lb_deleted WHERE element_id = ? ORDER BY seq DESC LIMIT 1',
    deletedNth: 'SELECT batch FROM lb_deleted ORDER BY seq DESC LIMIT 1 OFFSET ?',
    deletedBatchFloor: 'SELECT min(seq) AS s FROM lb_deleted WHERE batch = ?',
    deletedTrimOld: 'DELETE FROM lb_deleted WHERE seq < ? AND epoch <> ?',
    deletedTrimAll: 'DELETE FROM lb_deleted WHERE seq < ?',
    docCountAt: 'SELECT count(*) AS n FROM lb_doc WHERE clock = ?',
    tombstonesOlder:
      'SELECT id, deleted_clock FROM lb_elements WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?',
    tombstonesByAge:
      'SELECT id, deleted_clock FROM lb_elements WHERE deleted = 1 ORDER BY deleted_clock DESC, id LIMIT -1 OFFSET ?',
    purge: 'DELETE FROM lb_elements WHERE id = ?',
    // push receipts (rid '' = a trim marker: per user, or the board's with uid '')
    receiptPut: 'INSERT OR REPLACE INTO lb_receipts (uid, rid, clock, at) VALUES (?, ?, ?, ?)',
    receiptGet: "SELECT clock FROM lb_receipts WHERE uid = ? AND rid = ? AND rid <> ''",
    receiptCount: "SELECT count(*) AS n FROM lb_receipts WHERE uid = ? AND rid <> ''",
    receiptNth:
      "SELECT clock FROM lb_receipts WHERE uid = ? AND rid <> '' ORDER BY clock DESC LIMIT 1 OFFSET ?",
    receiptDropUser: "DELETE FROM lb_receipts WHERE uid = ? AND rid <> '' AND clock <= ?",
    receiptOldest: "SELECT max(clock) AS clock FROM lb_receipts WHERE rid <> '' AND at < ?",
    receiptDropAll: "DELETE FROM lb_receipts WHERE rid <> '' AND clock <= ?",
    receiptMark: `INSERT INTO lb_receipts (uid, rid, clock, at) VALUES (?, '', ?, ?)
       ON CONFLICT(uid, rid) DO UPDATE SET clock = max(clock, excluded.clock), at = excluded.at`,
    receiptFloor: "SELECT max(clock) AS clock FROM lb_receipts WHERE rid = '' AND uid IN (?, '')",
  })
}
