// `drop-legacy` (docs/EXCALIDRAW-MIGRATION.md §5.9 step 5, §7.5 step 10; the cut-over runbook's gap G8 and
// its step D7): day 7 after the cut-over, with the owner's OK, the tldraw side of every converted board
// file is removed. One board's drop runs INSIDE the capped migration worker (worker.ts), through the
// process-wide queue (one job at a time, like a conversion), started by `POST /internal/migrate/drop-legacy`
// (service.ts). 2B.
//
// Per board, in this order:
//  1. read-only checks, nothing written when one fails:
//     - `not-converted`: tldraw tables and no lb_meta. Never dropped, `force` or not: they ARE the board.
//     - `rollforward-pending`: converted, and R0 wrote the tldraw side since (a rollback happened and the
//       roll-forward has not run or failed). Never dropped, `force` or not: the roll-forward needs them.
//     - `nothing-to-drop`: born on the new canvas, or already stripped: ok, nothing done.
//     - `window`: the 7-day window (DROP_LEGACY_WINDOW_MS) since the board's conversion (`lb_doc.import.at`)
//       or its newest roll-forward (the time of `<board>.rollforward.json` in the report folder) has not
//       passed. `force` overrides this one (the owner's call), and the report says so (`forced`).
//     - `window-unknown`: no `lb_doc.import` row dates the conversion. `force` overrides it too.
//  2. the plan: the tldraw tables (`documents`, `metadata`, `objects`, `tombstones`), `dr_deleted_records`,
//     `dr_deleted_schemas`, `lb_source` and every `lb_prev_<cycle>_*`, those that exist. Any other table is
//     left alone and listed (`unknownTables`), never guessed at.
//  3. `dryRun`: the report carries the plan and the window verdict; nothing is written.
//  4. one `BEGIN IMMEDIATE` with every DROP TABLE, COMMIT, then VACUUM and a WAL checkpoint, so the file
//     gives the space back. The tables the room serves (lb_meta, lb_elements, lb_doc, lb_deleted, and
//     lb_receipts since CONTRACTS_REV 11) are never touched: their digests are the same before and after
//     (apps/sync/test/migrate/drop-legacy.test.ts).
//  5. the report goes to `<data>/migration/<board>.drop-legacy.json`: table names, bytes, times, no content.
//
// After it, R0 refuses the file (`converted-without-tldraw`, r0/born-after.ts): a rollback to R0 is no
// longer possible, which is why the window must have closed. The room's store recreates an empty
// `lb_source` on its next open (schema.ts, IF NOT EXISTS); a later run reports `nothing-to-drop` for it.

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LB_GUEST_TAGS_TABLE,
  LB_PRAGMAS,
  LB_PREV_TABLE_PATTERN,
  LB_RECEIPTS_TABLE,
  LB_TABLES,
} from '../schema.ts'
import { boardFileState } from './board-state.ts'
import { fileBytes, writeReport } from './convert-board.ts'
import { tableNames } from './digest.ts'

/** §5.9 step 5, §7.5 step 10: drop-legacy runs on day 7 after the cut-over at the earliest. */
export const DROP_LEGACY_WINDOW_MS = 7 * 86_400_000
/** The tables tldraw's sync storage creates in a board file (R0 serves a converted board from them). */
export const LEGACY_TLDRAW_TABLES = ['documents', 'metadata', 'objects', 'tombstones'] as const
/** R0's "Recently deleted" capture (deleted/store.ts); the new build has its own `lb_deleted`. */
export const LEGACY_DELETED_TABLES = ['dr_deleted_records', 'dr_deleted_schemas'] as const

/** The tables the room serves: never dropped (the push receipts too, CONTRACTS_REV 11; the guests' tag keys, TAGS-1). */
const SERVING_TABLES = new Set<string>([
  ...LB_TABLES.filter((t) => t !== 'lb_source'),
  LB_RECEIPTS_TABLE,
  LB_GUEST_TAGS_TABLE,
])

export interface DropLegacyJob {
  readonly kind: 'drop-legacy'
  readonly boardId: string
  /** the board file's absolute path */
  readonly path: string
  /** where the report goes (`<data>/migration`; the roll-forward reports are read there too) */
  readonly reportDir: string
  /** override the 7-day window and a missing conversion date (never `not-converted` or `rollforward-pending`) */
  readonly force: boolean
  /** report the plan and the verdict, write nothing */
  readonly dryRun: boolean
  /** the current time (tests); default now */
  readonly now?: number
}

export type DropLegacyReason =
  | 'no-file'
  | 'unreadable'
  | 'not-converted'
  | 'rollforward-pending'
  | 'window'
  | 'window-unknown'

export interface DropLegacyReport {
  readonly kind: 'drop-legacy'
  readonly boardId: string
  /** true: dropped (or, `dryRun`, would be dropped), or nothing to drop */
  readonly ok: boolean
  readonly reason?: DropLegacyReason | 'nothing-to-drop' | string
  readonly dryRun: boolean
  /** `force` was given AND it overrode the window (or a missing conversion date) */
  readonly forced: boolean
  /** the tables the plan names (those of the legacy set that exist) */
  readonly plan: readonly string[]
  /** the tables this run dropped (empty on a dry run or a refusal) */
  readonly dropped: readonly string[]
  /** tables that are neither the legacy set nor the room's: left alone */
  readonly unknownTables: readonly string[]
  /** `lb_doc.import.at` (ms), null when absent */
  readonly convertedAt: number | null
  /** the newest roll-forward report's time (ms), null when the board was never rolled forward here */
  readonly rolledForwardAt: number | null
  /** when the window closes (ms), null when nothing dates the conversion */
  readonly windowEndsAt: number | null
  readonly bytesBefore: number
  readonly bytesAfter: number
  readonly ms: number
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

const isLegacyTable = (t: string) =>
  (LEGACY_TLDRAW_TABLES as readonly string[]).includes(t) ||
  (LEGACY_DELETED_TABLES as readonly string[]).includes(t) ||
  t === 'lb_source' ||
  LB_PREV_TABLE_PATTERN.test(t)

/** The time `lb_doc.import.at` records, or null when the row is missing or not a time. */
function convertedAtOf(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT value FROM lb_doc WHERE key = 'import'").get() as
    | { value: string | null }
    | undefined
  if (!row?.value) return null
  try {
    const at = (JSON.parse(row.value) as { at?: unknown }).at
    return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 ? at : null
  } catch {
    return null
  }
}

/** Removes the tldraw side of one converted board file (the caller holds no other handle to it). */
export function dropLegacyBoardFile(job: DropLegacyJob): DropLegacyReport {
  const t0 = performance.now()
  const now = job.now ?? Date.now()
  const bytesBefore = fileBytes(job.path)
  const base = {
    kind: 'drop-legacy' as const,
    boardId: job.boardId,
    dryRun: job.dryRun,
    forced: false,
    plan: [] as string[],
    dropped: [] as string[],
    unknownTables: [] as string[],
    convertedAt: null as number | null,
    rolledForwardAt: null as number | null,
    windowEndsAt: null as number | null,
    bytesBefore,
    bytesAfter: bytesBefore,
  }
  const done = (over: Partial<DropLegacyReport> & { ok: boolean }): DropLegacyReport => {
    const report: DropLegacyReport = { ...base, ...over, ms: Math.round(performance.now() - t0) }
    writeReport(job.reportDir, `${job.boardId}.drop-legacy.json`, report)
    return report
  }
  let state: ReturnType<typeof boardFileState>
  try {
    state = boardFileState(job.path)
  } catch {
    return done({ ok: false, reason: 'unreadable' })
  }
  if (state === 'missing') return done({ ok: false, reason: 'no-file' })
  if (state === 'unknown') return done({ ok: false, reason: 'unreadable' })
  if (state === 'tldraw') return done({ ok: false, reason: 'not-converted' })
  if (state === 'rollforward-needed') return done({ ok: false, reason: 'rollforward-pending' })
  if (state === 'element') return done({ ok: true, reason: 'nothing-to-drop' })

  const db = new DatabaseSync(job.path)
  try {
    for (const p of LB_PRAGMAS) db.exec(p)
    const tables = tableNames(db)
    base.plan = tables.filter(isLegacyTable)
    base.unknownTables = tables.filter(
      (t) => !isLegacyTable(t) && !SERVING_TABLES.has(t) && !t.startsWith('sqlite_'),
    )
    // an empty lb_source alone is the room's own re-creation after an earlier drop: nothing legacy left
    const onlyEmptySource =
      base.plan.length === 1 &&
      base.plan[0] === 'lb_source' &&
      Number((db.prepare('SELECT count(*) AS n FROM lb_source').get() as { n: number | bigint }).n) === 0
    if (base.plan.length === 0 || onlyEmptySource)
      return done({ ok: true, reason: 'nothing-to-drop', plan: [] })

    base.convertedAt = convertedAtOf(db)
    const rfReport = join(job.reportDir, `${job.boardId}.rollforward.json`)
    base.rolledForwardAt = existsSync(rfReport) ? Math.round(statSync(rfReport).mtimeMs) : null
    const last = Math.max(base.convertedAt ?? -1, base.rolledForwardAt ?? -1)
    base.windowEndsAt = last < 0 ? null : last + DROP_LEGACY_WINDOW_MS
    if (base.windowEndsAt === null) {
      if (!job.force) return done({ ok: false, reason: 'window-unknown' })
      base.forced = true
    } else if (now < base.windowEndsAt) {
      if (!job.force) return done({ ok: false, reason: 'window' })
      base.forced = true
    }
    if (job.dryRun) return done({ ok: true })

    db.exec('BEGIN IMMEDIATE')
    try {
      for (const t of base.plan) db.exec(`DROP TABLE ${quoteIdent(t)}`)
      db.exec('COMMIT')
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw e
    }
    db.exec('VACUUM')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return done({ ok: true, dropped: base.plan, bytesAfter: fileBytes(job.path) })
  } catch (e) {
    return done({ ok: false, reason: `error: ${(e as Error)?.name ?? 'Error'}` })
  } finally {
    db.close()
  }
}
