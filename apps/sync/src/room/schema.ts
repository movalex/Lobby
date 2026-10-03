// The board file of the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §2.6), frozen at the spike B
// contracts step C0 (docs/research/excalidraw/spike-b/CONTRACTS.md). Lead-owned: O1's store and O4's
// conversion both use it, and a change needs the OK of O1 and O4.
//
// One SQLite file per board (`board-<id>.sqlite`, rooms.ts boardDbPath), with the same pragmas as today
// plus a 4 MB page cache. The tldraw tables and `dr_deleted_*` stay untouched in a converted file until
// `drop-legacy`; the new build never writes, trims or rebuilds them.

import type { DatabaseSync } from 'node:sqlite'

/** The `lb_meta.schemaVersion` this build writes (the element schema version, protocol.ts ELEMENT_SCHEMA_VERSION). */
export const LB_SCHEMA_VERSION = 1

/** Per board file, set on every open, outside any transaction. */
export const LB_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = FULL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA cache_size = -4000',
] as const

/** The Excalidraw engine's tables, in creation order. */
export const LB_TABLES = ['lb_meta', 'lb_elements', 'lb_doc', 'lb_deleted', 'lb_source'] as const
export type LbTable = (typeof LB_TABLES)[number]

/** The DDL of §2.6, statement by statement (idempotent: IF NOT EXISTS). */
export const LB_DDL: readonly string[] = [
  // clock, horizon, epoch, schemaVersion, converted_from (JSON, ConvertedFrom below)
  'CREATE TABLE IF NOT EXISTS lb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS lb_elements (id TEXT PRIMARY KEY, clock INTEGER NOT NULL, idx TEXT NOT NULL,
  deleted INTEGER NOT NULL, deleted_clock INTEGER, deleted_at INTEGER, type TEXT NOT NULL,
  version INTEGER NOT NULL, gclock TEXT NOT NULL,
  data TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS lb_elements_clock ON lb_elements(clock)',
  'CREATE INDEX IF NOT EXISTS lb_elements_order ON lb_elements(idx, id)',
  // value NULL = removed
  'CREATE TABLE IF NOT EXISTS lb_doc (key TEXT PRIMARY KEY, clock INTEGER NOT NULL, value TEXT)',
  `CREATE TABLE IF NOT EXISTS lb_deleted (seq INTEGER PRIMARY KEY AUTOINCREMENT, batch INTEGER NOT NULL,
  element_id TEXT NOT NULL, type TEXT NOT NULL, container_id TEXT, frame_id TEXT,
  data TEXT NOT NULL, deleted_by TEXT NOT NULL, deleted_by_name TEXT NOT NULL,
  deleted_at INTEGER NOT NULL, epoch TEXT NOT NULL, origin TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS lb_deleted_element ON lb_deleted(element_id, seq)',
  'CREATE INDEX IF NOT EXISTS lb_deleted_batch ON lb_deleted(batch)',
  // converted boards only: the tldraw `documents` rows this board was last converted or merged from
  // (the roll-forward base, §5.9); dropped by drop-legacy
  'CREATE TABLE IF NOT EXISTS lb_source (id TEXT PRIMARY KEY, state BLOB NOT NULL)',
]

/** Creates the tables that are missing (never alters or drops). Call inside the opening transaction. */
export function ensureLbSchema(db: DatabaseSync): void {
  for (const stmt of LB_DDL) db.exec(stmt)
}

// ---- lb_receipts: push receipts (CONTRACTS_REV 11, W5-ENG-2) -------------------------------------------

/**
 * The room's push receipts (protocol.ts `Push.rid`, `ReceiptsQuery`): one row per committed push that
 * carried a receipt id, keyed by the pushing user (`uid`, from the ticket) and the id, with the clock the
 * push committed at and when (ms). A small ring per user (`RECEIPTS.perUser`) and an age limit
 * (`RECEIPTS.ttlMs`); what a trim dropped is remembered as a MARKER row (`rid` = '', `clock` = the
 * highest clock dropped: per user for the ring, `uid` = '' for the age limit), so an answer can say from
 * which clock a user's receipts are complete.
 *
 * Not one of the frozen §2.6 tables (LB_TABLES). The room's store makes it (IF NOT EXISTS, idempotent) in
 * the first drain batch that records a receipt, inside that batch's transaction, and writes it only in
 * batches that advance the clock: the backups' digest (r0/lb-files.ts `lbRecordsSha256`, every lb_* table
 * with its SQL) then never changes while `lb_meta.clock` stays, which the restore drill's live check
 * requires ("live board has the backup clock but different records"). Made on open instead, every board
 * opened after the deploy and not written since its last backup would fail that check. A file from before
 * rev 11, a converted file, a restored backup and a file R0 served get it with their next receipt; a
 * receipts query on a file without it is answered "nothing landed, complete from 0". It is an lb_* table,
 * so the backups (the whole file), the digest and the restore drill cover it, and it survives a restart
 * (written with the COMMIT); the conversion and the roll-forward's lb_prev copies leave it alone, and
 * drop-legacy keeps it (a serving table).
 */
export const LB_RECEIPTS_TABLE = 'lb_receipts'
export const LB_RECEIPTS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lb_receipts (uid TEXT NOT NULL, rid TEXT NOT NULL, clock INTEGER NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (uid, rid)) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS lb_receipts_clock ON lb_receipts(uid, clock)',
]
/** The receipt ring's limits: per user, and an age (a reconnect asks within seconds, a reload within days). */
export const RECEIPTS = Object.freeze({
  perUser: 64,
  /** a user's ring is trimmed back to `perUser` once it holds this many */
  trimAt: 96,
  ttlMs: 7 * 86_400_000,
  /** how often (at most) the age limit runs, in a writing batch */
  ttlEveryMs: 3_600_000,
})

/** Creates the receipts table when it is missing (idempotent). Call inside a transaction that advances the clock. */
export function ensureReceiptsSchema(db: DatabaseSync): void {
  for (const stmt of LB_RECEIPTS_DDL) db.exec(stmt)
}

// ---- lb_meta ---------------------------------------------------------------------------------------

export const LB_META_KEYS = ['clock', 'horizon', 'epoch', 'schemaVersion', 'converted_from'] as const
export type LbMetaKey = (typeof LB_META_KEYS)[number]

/**
 * `lb_meta.converted_from` (JSON), written by the conversion (§5.3 step 3) and refreshed by every
 * roll-forward (§5.9). A board WITHOUT it was born on the new canvas: the R0 stand-in refuses to open it.
 */
export interface ConvertedFrom {
  /** the tldraw `metadata.documentClock` converted */
  documentClock: number
  schemaHash: string
  /** sha256 of `lb_source`, computed as the backup manifest's recordsSha256 (id and state, by id) */
  sourceSha256: string
  converterVersion: string
  /** the final pre-cut-over backup object in R2; null for lazily converted boards */
  backupKey: string | null
  /** the last `dr_deleted_records.seq` copied into `lb_deleted` */
  deletedSeq: number
  /** the lb clock right after the conversion or roll-forward ("ours changed" = gclock[g] > lbClock) */
  lbClock: number
  /** 0 at the first conversion, +1 per roll-forward (names the lb_prev_<cycle>_* copies) */
  cycle: number
}

/** `lb_deleted.origin`. */
export type LbDeletedOrigin = 'live' | 'converted'

// ---- gclock: the per-group write clocks of an element --------------------------------------------------

/**
 * `lb_elements.gclock` (JSON): the clock of the last write to each group of the element (protocol.ts
 * GROUP_NAMES: `pos`, `shape`, `path`, `text`, `layout`, `textStyle`, `style`, `bind`, `bound`, `z`,
 * `membership`, `meta`, `file`, `life`), `fit` for derived writes (a container fit, the server's re-snaps,
 * §3.2), and `c:<key>` per `customData.lobby` key. A missing slot means "never written since the element
 * was created or converted" (read as its row's creation clock). Keys are serialized sorted.
 */
export type Gclock = Readonly<Record<string, number>>

const GCLOCK_KEY =
  /^(?:pos|shape|path|text|layout|textStyle|style|bind|bound|z|membership|meta|file|life|fit|c:.{1,200})$/

/** Parses a stored gclock; throws on anything that is not a map of known slots to non-negative integer clocks. */
export function parseGclock(text: string): Gclock {
  const raw = JSON.parse(text) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('gclock: not an object')
  for (const [k, v] of Object.entries(raw)) {
    if (!GCLOCK_KEY.test(k)) throw new Error('gclock: unknown slot')
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('gclock: bad clock')
  }
  return raw as Gclock
}

/** Serializes a gclock with sorted keys (byte-stable rows). */
export function serializeGclock(g: Gclock): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(g).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  )
}

// ---- lb_prev_<cycle>_*: the pre-merge copies of each roll-forward (§5.9) ----------------------------------

/** `lb_prev_<cycle>_<suffix>` for a copy of `table` made before roll-forward `cycle` (1, 2, …). */
export function lbPrevTable(cycle: number, table: LbTable): string {
  if (!Number.isSafeInteger(cycle) || cycle < 1) throw new Error('lb_prev cycle must be a positive integer')
  return `lb_prev_${cycle}_${table.slice('lb_'.length)}`
}
/** Matches every `lb_prev_*` table name (drop-legacy removes them). */
export const LB_PREV_TABLE_PATTERN = /^lb_prev_[1-9][0-9]*_(?:meta|elements|doc|deleted|source)$/
