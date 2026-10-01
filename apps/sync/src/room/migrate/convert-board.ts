// One board's conversion (docs/EXCALIDRAW-MIGRATION.md §5.3 "Per board", §5.4), run INSIDE the capped
// conversion worker (worker.ts), never on the event loop. O4.
//
//  1. disk check first: free space ≥ 3.5 × the board file + 50 MB, else stop and report;
//  2. read the tldraw tables and `dr_deleted_*` with node:sqlite, migrate the records to 5.4.2, convert
//     (whole board, page offsets computed now and frozen in `lb_doc.import.legacyPages`), convert the
//     deleted rows in local mode, and run the semantic diff; any failure stops here with nothing written;
//  3. in ONE `BEGIN IMMEDIATE`: create the lb_* tables (room/schema.ts), write lb_elements, lb_doc and
//     lb_meta (new epoch, clock 1), copy the `documents` rows into `lb_source`, write `lb_deleted`
//     (origin `converted`) and `lb_meta.converted_from`;
//  4. the tldraw tables and `dr_deleted_*` are never written, trimmed or changed;
//  5. the report goes to `<data>/migration/<board>.json` (ids, counts, codes, timings, bytes only).
//
// A worker that is terminated (time budget, heap cap) dies before COMMIT: SQLite discards the open
// transaction, so the board stays on its tldraw tables.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getHeapStatistics } from 'node:v8'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import type { ServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import {
  CONVERTED_FROM,
  CONVERTER_VERSION,
  convertBoard,
  convertDeleted,
  type LegacyPages,
  type Lossy,
  lossyCounts,
  migrateRecords,
  type TlRecord,
} from '@draftroom/tldraw-import'
import {
  hasTldrawTables,
  maxDeletedSeq,
  parseRows,
  readDeletedRows,
  readTldrawTables,
  sha256Hex,
} from '@draftroom/tldraw-import/board-file'
import { type DiffReport, semanticDiff } from '@draftroom/tldraw-import/diff'
import {
  type ConvertedFrom,
  ensureLbSchema,
  LB_PRAGMAS,
  LB_SCHEMA_VERSION,
  serializeGclock,
} from '../schema.ts'
import { recordsSha256 } from './digest.ts'

/** §5.3 step 1: free space needed before a conversion starts. */
export const DISK_FACTOR = 3.5
export const DISK_MARGIN_BYTES = 50 * 1024 * 1024

export interface ConvertJob {
  readonly kind: 'convert'
  readonly boardId: string
  /** the board file's absolute path */
  readonly path: string
  /** where the report goes (`<data>/migration`) */
  readonly reportDir: string
  /** the final pre-cut-over backup object (§5.6), or null (lazy conversions, spike runs) */
  readonly backupKey: string | null
  /** that backup's recordsSha256, when known: `lb_source`'s digest must equal it */
  readonly expectedSourceSha256?: string | null
  /** the conversion time (every element's `updated`); default now */
  readonly at?: number
  /** run the local-mode diff too (it converts every record alone again; B8 runs it) */
  readonly verifyLocalMode?: boolean
  /** test only: a free-space answer instead of statfs */
  readonly freeBytesOverride?: number
}

export interface HeapSampler {
  sample(stage: string): void
  readonly peakUsedMb: number
  readonly peakTotalMb: number
}

export function heapSampler(): HeapSampler {
  let peakUsed = 0
  let peakTotal = 0
  const s = {
    sample(_stage: string) {
      const h = getHeapStatistics()
      peakUsed = Math.max(peakUsed, h.used_heap_size)
      peakTotal = Math.max(peakTotal, h.total_heap_size)
    },
    get peakUsedMb() {
      return Math.round((peakUsed / 1024 / 1024) * 10) / 10
    },
    get peakTotalMb() {
      return Math.round((peakTotal / 1024 / 1024) * 10) / 10
    },
  }
  s.sample('start')
  return s
}

export interface ConvertReport {
  readonly kind: 'convert'
  readonly boardId: string
  readonly ok: boolean
  /** why it stopped (no content): disk, already-converted, not-a-tldraw-board, backup-digest, migration, limits, diff, deleted, source-digest, error */
  readonly reason?: string
  /** the final backup compared against (§5.6; the job's `backupKey`), null when none */
  readonly backupKey: string | null
  /** that backup's recordsSha256 (the job's `expectedSourceSha256`), null when none */
  readonly expectedSourceSha256: string | null
  readonly recordsIn: number
  readonly shapesIn: number
  readonly elementsOut: number
  readonly lossy: Readonly<Record<string, number>>
  /** code and tldraw id per loss (ids only) */
  readonly lossyList: readonly Lossy[]
  readonly failures: readonly { id: string; code: string }[]
  readonly deleted: {
    readonly rowsIn: number
    readonly rowsOut: number
    readonly unmapped: number
    readonly lastSeq: number
  }
  readonly ms: number
  readonly bytesBefore: number
  readonly bytesAfter: number
  readonly disk: { readonly freeBytes: number; readonly neededBytes: number; readonly ok: boolean }
  readonly sourceSha256: string | null
  readonly sourceMatchesBackup: boolean | null
  readonly peakHeapUsedMb: number
  readonly peakHeapTotalMb: number
  readonly diff: DiffReport | null
  readonly converterVersion: string
  /** whether the §2.4.4 invariant checker ran (O1's) and what it found (ids and codes) */
  readonly invariants?: 'ran' | 'not-implemented'
  readonly violations?: readonly { code: string; id: string }[]
}

/** O1's invariant checker on a converted board, or `not-implemented` while it is the C0 stub. */
export function runInvariants(elements: readonly WireElement[]): {
  invariants: 'ran' | 'not-implemented'
  violations: { code: string; id: string }[]
} {
  try {
    return {
      invariants: 'ran',
      violations: checkInvariants(elements).map((v) => ({ code: v.code, id: v.id })),
    }
  } catch (e) {
    if (/not implemented/.test(String((e as Error)?.message)))
      return { invariants: 'not-implemented', violations: [] }
    throw e
  }
}

export const fileBytes = (path: string) =>
  [path, `${path}-wal`].reduce((n, p) => n + (existsSync(p) ? statSync(p).size : 0), 0)

export function freeBytes(dir: string): number {
  const s = statfsSync(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/** A new lb epoch (`Epoch` in protocol.ts: [A-Za-z0-9_-]{1,64}). */
export const newEpoch = () => `c${Date.now().toString(36)}${randomBytes(6).toString('base64url')}`

/** Writes the report atomically (tmp + rename). */
export function writeReport(dir: string, name: string, report: unknown): void {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(report, null, 1)}\n`)
  renameSync(tmp, join(dir, name))
}

/** Converts one board file in place (the caller holds no other handle to it). */
export function convertBoardFile(job: ConvertJob, metrics: ServerTextMetrics): ConvertReport {
  const t0 = performance.now()
  const heap = heapSampler()
  const bytesBefore = fileBytes(job.path)
  const neededBytes = Math.ceil(DISK_FACTOR * bytesBefore + DISK_MARGIN_BYTES)
  const free = job.freeBytesOverride ?? freeBytes(dirname(job.path))
  const base = {
    kind: 'convert' as const,
    boardId: job.boardId,
    backupKey: job.backupKey,
    expectedSourceSha256: job.expectedSourceSha256 ?? null,
    recordsIn: 0,
    shapesIn: 0,
    elementsOut: 0,
    lossy: {},
    lossyList: [] as Lossy[],
    failures: [] as { id: string; code: string }[],
    deleted: { rowsIn: 0, rowsOut: 0, unmapped: 0, lastSeq: 0 },
    bytesBefore,
    bytesAfter: bytesBefore,
    disk: { freeBytes: free, neededBytes, ok: free >= neededBytes },
    sourceSha256: null as string | null,
    sourceMatchesBackup: null as boolean | null,
    diff: null as DiffReport | null,
    converterVersion: CONVERTER_VERSION,
  }
  const done = (over: Partial<ConvertReport> & { ok: boolean }): ConvertReport => {
    heap.sample('end')
    const report: ConvertReport = {
      ...base,
      ...over,
      ms: Math.round(performance.now() - t0),
      peakHeapUsedMb: heap.peakUsedMb,
      peakHeapTotalMb: heap.peakTotalMb,
    }
    writeReport(job.reportDir, `${job.boardId}.json`, report)
    return report
  }
  if (!base.disk.ok) return done({ ok: false, reason: 'disk' })

  const db = new DatabaseSync(job.path)
  try {
    for (const p of LB_PRAGMAS) db.exec(p)
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((r) => r.name),
    )
    if (tables.has('lb_meta')) return done({ ok: false, reason: 'already-converted' })
    if (!hasTldrawTables(db)) return done({ ok: false, reason: 'not-a-tldraw-board' })

    // 2. read, migrate, convert, verify (nothing written yet)
    const tl = readTldrawTables(db)
    heap.sample('read')
    // §5.3's table, §5.6: the records converted must be the ones the final backup holds (`lb_source` is a
    // copy of them, so its digest is this one). An edit after the backup, or a backup that is not the final
    // one, refuses the board here, before anything is written: the operator decides (the runbook's C10).
    if (job.expectedSourceSha256 && tl.recordsSha256 !== job.expectedSourceSha256)
      return done({
        ok: false,
        reason: 'backup-digest',
        recordsIn: tl.rows.length,
        sourceSha256: tl.recordsSha256,
        sourceMatchesBackup: false,
      })
    const migrated = migrateRecords(parseRows(tl.rows), tl.schema)
    if (!migrated.ok) return done({ ok: false, reason: 'migration', recordsIn: tl.rows.length })
    const records = migrated.records as TlRecord[]
    heap.sample('migrate')
    const at = job.at ?? Date.now()
    const conv = convertBoard(records, { updatedAt: at, metrics })
    heap.sample('convert')
    const counts = {
      recordsIn: tl.rows.length,
      shapesIn: conv.counts.shapes,
      elementsOut: conv.elements.length,
      lossy: lossyCounts(conv.lossy),
      lossyList: conv.lossy,
      failures: conv.failures.map((f) => ({ id: f.id, code: f.code })),
    }
    if (conv.failures.length) return done({ ok: false, reason: 'limits', ...counts })
    const drRows = readDeletedRows(db, 0)
    const deleted = convertDeleted(drRows, records, { updatedAt: at, metrics, legacyPages: conv.legacyPages })
    const unmapped = [...deleted.mapping.values()].filter((v) => !Array.isArray(v)).length
    const deletedCounts = {
      rowsIn: drRows.length,
      rowsOut: deleted.rows.length,
      unmapped,
      lastSeq: Math.max(deleted.lastSeq, maxDeletedSeq(db)),
    }
    const lossyAll = [...conv.lossy, ...deleted.lossy.map((l) => ({ ...l }))]
    heap.sample('deleted')
    if (deleted.failures.length)
      return done({
        ok: false,
        reason: 'deleted',
        ...counts,
        deleted: deletedCounts,
        failures: deleted.failures.map((f) => ({ id: f.id, code: f.code })),
      })
    const diff = semanticDiff({
      records,
      elements: conv.elements,
      lossy: conv.lossy,
      legacyPages: conv.legacyPages,
      ...(job.verifyLocalMode ? { localMode: { updatedAt: at, metrics } } : {}),
    })
    heap.sample('diff')
    if (!diff.ok) return done({ ok: false, reason: 'diff', ...counts, deleted: deletedCounts, diff })
    // the §2.4.4 invariants (O1's checker; skipped, and reported so, while it is the C0 stub)
    const inv = runInvariants(conv.elements)
    if (inv.violations.length)
      return done({ ok: false, reason: 'invariants', ...counts, deleted: deletedCounts, diff, ...inv })

    // 3. one transaction
    const epoch = newEpoch()
    db.exec('BEGIN IMMEDIATE')
    let sourceSha256: string
    try {
      ensureLbSchema(db)
      const insEl = db.prepare(
        'INSERT INTO lb_elements (id, clock, idx, deleted, deleted_clock, deleted_at, type, version, gclock, data) VALUES (?, 1, ?, 0, NULL, NULL, ?, ?, ?, ?)',
      )
      const noGclock = serializeGclock({})
      for (const e of conv.elements)
        insEl.run(e.id, e.index ?? '', e.type, e.version, noGclock, JSON.stringify(e))
      const insDoc = db.prepare('INSERT INTO lb_doc (key, clock, value) VALUES (?, 1, ?)')
      if (conv.doc.startView) insDoc.run('startView', JSON.stringify(conv.doc.startView))
      if (conv.doc.workshop) insDoc.run('workshop', JSON.stringify(conv.doc.workshop))
      for (const [key, def] of Object.entries(conv.doc.tagDefs))
        insDoc.run(`tagDef:${key}`, JSON.stringify(def))
      insDoc.run(
        'import',
        JSON.stringify(importDoc(at, conv.legacyPages, conv.legacyIds, lossyCounts(lossyAll))),
      )
      db.prepare('INSERT INTO lb_source (id, state) SELECT id, state FROM documents').run()
      const insDel = db.prepare(
        `INSERT INTO lb_deleted (batch, element_id, type, container_id, frame_id, data, deleted_by, deleted_by_name,
           deleted_at, epoch, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'converted')`,
      )
      for (const r of deleted.rows)
        insDel.run(
          r.batch,
          r.elementId,
          r.type,
          r.containerId,
          r.frameId,
          r.data,
          r.deletedBy,
          r.deletedByName,
          r.deletedAt,
          r.epoch,
        )
      sourceSha256 = recordsSha256(db, 'lb_source')
      if (sourceSha256 !== tl.recordsSha256) throw new SourceDigestMismatch()
      const from: ConvertedFrom = {
        documentClock: tl.documentClock,
        schemaHash: sha256Hex(tl.schemaText),
        sourceSha256,
        converterVersion: CONVERTER_VERSION,
        backupKey: job.backupKey,
        deletedSeq: deletedCounts.lastSeq,
        lbClock: 1,
        cycle: 0,
      }
      const meta = db.prepare('INSERT INTO lb_meta (key, value) VALUES (?, ?)')
      meta.run('clock', '1')
      meta.run('horizon', '0')
      meta.run('epoch', epoch)
      meta.run('schemaVersion', String(LB_SCHEMA_VERSION))
      meta.run('converted_from', JSON.stringify(from))
      db.exec('COMMIT')
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK')
      if (e instanceof SourceDigestMismatch) return done({ ok: false, reason: 'source-digest', ...counts })
      throw e
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    heap.sample('write')
    const matches = job.expectedSourceSha256 ? sourceSha256 === job.expectedSourceSha256 : null
    return done({
      ok: true,
      ...counts,
      lossy: lossyCounts(lossyAll),
      lossyList: lossyAll,
      deleted: deletedCounts,
      bytesAfter: fileBytes(job.path),
      sourceSha256,
      sourceMatchesBackup: matches,
      diff,
      ...inv,
    })
  } catch (e) {
    return done({ ok: false, reason: `error: ${(e as Error)?.name ?? 'Error'}` })
  } finally {
    db.close()
  }
}

class SourceDigestMismatch extends Error {}

/** `lb_doc.import` (doc.ts ImportDocValue). */
export function importDoc(
  at: number,
  legacyPages: LegacyPages,
  legacyIds: Readonly<Record<string, string>>,
  lossy: Readonly<Record<string, number>>,
) {
  return {
    from: CONVERTED_FROM,
    converterVersion: CONVERTER_VERSION,
    at,
    legacyPages: Object.fromEntries(
      Object.entries(legacyPages).map(([id, p]) => [
        id,
        { dx: p.dx, dy: p.dy, index: p.index, name: p.name },
      ]),
    ),
    legacyIds: { ...legacyIds },
    lossy: { ...lossy },
  }
}
