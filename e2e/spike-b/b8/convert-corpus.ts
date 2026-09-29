// B8's conversions (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "Conversion runs inside the spike's sync
// process, in the capped worker, one board at a time, on copies of these files"). O4.
//
//   node e2e/spike-b/b8/convert-corpus.ts --corpus <folder of board-*.sqlite> --work <folder> --out <results.json>
//        [--mode runtime|maintenance] [--cap <MB>] [--anchors <corpus.json>] [--backups <downloads folder>]
//        [--staging]
//
// Copies every board file into <work>/rooms (the inputs are never opened for writing), then converts each
// through the sync's own migration service (room/migrate: the process-wide queue of one, a fresh capped
// worker per board, the disk check, the one transaction, the semantic diff with the local-mode check), and
// checks what the service does not: the tldraw tables and dr_deleted_* byte-identical, lb_source's digest
// equal to the input's (and, with --backups, to the restored backup object's) recordsSha256, every
// dr_deleted row mapped, the anchors resolving, the element count within the item caps.
//
// --staging (the restored staging copies, §8.6.7): SPIKE_B8_DIR must be set and --work must lie inside it;
// TEMP/TMP are moved inside it; every output holds ids, counts, codes, timings, bytes and hashes only.
// The per-board lossy list (codes with tldraw ids) stays in the work folder; the results file carries
// counts per code. Nothing is printed but counts.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import type { ConvertReport } from '../../../apps/sync/src/room/migrate/convert-board.ts'
import { drDeletedDigests, recordsSha256, tableDigest } from '../../../apps/sync/src/room/migrate/digest.ts'
import { MigrationService } from '../../../apps/sync/src/room/migrate/service.ts'
import { MAX_ITEMS, MAX_LIVE_ELEMENTS } from '../../../packages/canvas-schema/src/limits.ts'
import { assertNoR2 } from './stand-in.ts'

export interface BoardResult {
  readonly boardId: string
  readonly ok: boolean
  readonly reason?: string
  readonly recordsIn: number
  readonly shapesIn: number
  readonly elementsOut: number
  readonly items: number
  readonly lossy: Readonly<Record<string, number>>
  readonly ms: number
  readonly workerMs: number
  readonly bytesBefore: number
  readonly bytesAfter: number
  readonly disk: ConvertReport['disk'] | null
  readonly peakHeapUsedMb: number | null
  readonly peakHeapTotalMb: number | null
  readonly checks: Readonly<Record<string, { pass: boolean; total?: number; failed?: number; note?: string }>>
  readonly sourceSha256: string | null
}

const isInside = (child: string, parent: string) => {
  const r = relative(resolve(parent), resolve(child))
  return !!r && !r.startsWith('..') && !r.includes(':')
}

export async function convertCorpus(opts: {
  corpus: string
  work: string
  mode: 'runtime' | 'maintenance'
  capMb?: number
  anchors?: Record<string, readonly string[]>
  /** restored backup objects: <backups>/<boardId>/<object>.sqlite (their recordsSha256 is the backup's) */
  backups?: string
  staging?: boolean
  verifyLocalMode?: boolean
}): Promise<BoardResult[]> {
  assertNoR2()
  if (opts.staging) {
    const b8 = process.env.SPIKE_B8_DIR
    if (!b8 || !isInside(opts.work, b8))
      throw new Error('--staging needs SPIKE_B8_DIR and a --work folder inside it')
    const tmp = join(opts.work, 'tmp')
    mkdirSync(tmp, { recursive: true })
    process.env.TEMP = tmp
    process.env.TMP = tmp
    process.env.TMPDIR = tmp
  }
  process.env.DRAFTROOM_BACKUP_STORE = 'off'
  const rooms = join(opts.work, 'rooms')
  rmSync(opts.work, { recursive: true, force: true })
  mkdirSync(rooms, { recursive: true })
  const files = readdirSync(opts.corpus)
    .filter((f) => /^board-.+\.sqlite$/.test(f))
    .sort()
  for (const f of files) {
    cpSync(join(opts.corpus, f), join(rooms, f))
    for (const ext of ['-wal'])
      if (existsSync(join(opts.corpus, f + ext))) cpSync(join(opts.corpus, f + ext), join(rooms, f + ext))
  }
  // the restored backup objects are read from copies too
  let backups: string | null = null
  if (opts.backups && existsSync(opts.backups)) {
    backups = join(opts.work, 'backups')
    cpSync(opts.backups, backups, { recursive: true })
  }
  const svc = new MigrationService({
    roomsDir: rooms,
    verifyLocalMode: opts.verifyLocalMode ?? true,
    ...(opts.capMb ? { runtimeCapMb: opts.capMb, maintenanceCapMb: opts.capMb } : {}),
  })
  const results: BoardResult[] = []
  try {
    for (const f of files) {
      const boardId = (/^board-(.+)\.sqlite$/.exec(f) as RegExpExecArray)[1] as string
      const path = join(rooms, f)
      const before = readOnly(path, (db) => ({
        documents: tableDigest(db, 'documents'),
        metadata: tableDigest(db, 'metadata'),
        dr: drDeletedDigests(db),
        recordsSha256: recordsSha256(db, 'documents'),
        deletedRows: tableDigest(db, 'dr_deleted_records').rows,
      }))
      const backupSha = backups ? backupRecordsSha256(join(backups, boardId)) : null
      const t0 = performance.now()
      const res = opts.mode === 'runtime' ? await svc.prepare(boardId) : (await svc.convertAll())[boardId]
      const ms = Math.round(performance.now() - t0)
      const st = svc.status().boards.find((b) => b.boardId === boardId)
      const reportPath = join(opts.work, 'migration', `${boardId}.json`)
      const report = existsSync(reportPath)
        ? (JSON.parse(readFileSync(reportPath, 'utf8')) as ConvertReport)
        : null
      const checks: Record<string, { pass: boolean; total?: number; failed?: number; note?: string }> = {}
      if (report?.invariants === 'ran')
        checks.invariants = {
          pass: (report.violations ?? []).length === 0,
          failed: (report.violations ?? []).length,
        }
      for (const c of report?.diff?.checks ?? [])
        checks[`diff:${c.name}`] = {
          pass: c.pass,
          total: c.total,
          failed: c.failed,
          ...(c.skipped ? { note: c.skipped } : {}),
        }
      let items = 0
      if (report?.ok) {
        const after = readOnly(path, (db) => ({
          documents: tableDigest(db, 'documents'),
          metadata: tableDigest(db, 'metadata'),
          dr: drDeletedDigests(db),
          lbSource: recordsSha256(db, 'lb_source'),
          lbDeleted: tableDigest(db, 'lb_deleted').rows,
          elements: db.prepare('SELECT id, type, data FROM lb_elements WHERE deleted = 0').all() as Array<{
            id: string
            type: string
            data: string
          }>,
        }))
        checks['tldraw-tables-identical'] = {
          pass:
            JSON.stringify([after.documents, after.metadata]) ===
            JSON.stringify([before.documents, before.metadata]),
        }
        checks['dr-deleted-identical'] = { pass: JSON.stringify(after.dr) === JSON.stringify(before.dr) }
        checks['lb-source-digest'] = {
          pass:
            after.lbSource === before.recordsSha256 && (backupSha === null || backupSha === after.lbSource),
          note:
            backupSha === null
              ? 'against the input file'
              : 'against the input file and the restored backup object',
        }
        checks['deleted-mapped'] = {
          pass: (report.deleted?.unmapped ?? 1) === 0 && report.deleted.rowsIn === before.deletedRows,
          total: before.deletedRows,
          failed: report.deleted?.unmapped ?? 0,
        }
        const live = new Set(after.elements.map((e) => e.id))
        items = after.elements.filter((e) => !(e.type === 'text' && JSON.parse(e.data).containerId)).length
        checks['item-caps'] = {
          pass: items <= MAX_ITEMS && after.elements.length <= MAX_LIVE_ELEMENTS,
          total: items,
        }
        const anchors = opts.anchors?.[boardId]
        if (anchors?.length) {
          const failed = anchors.filter((a) => !live.has(a.replace(/^shape:/, ''))).length
          checks['anchors-seeded'] = { pass: failed === 0, total: anchors.length, failed }
        }
      }
      results.push({
        boardId,
        ok: res?.ready === true && report?.ok === true && Object.values(checks).every((c) => c.pass),
        ...(res && !res.ready
          ? { reason: res.reason }
          : report && !report.ok
            ? { reason: report.reason }
            : {}),
        recordsIn: report?.recordsIn ?? 0,
        shapesIn: report?.shapesIn ?? 0,
        elementsOut: report?.elementsOut ?? 0,
        items,
        lossy: report?.lossy ?? {},
        ms,
        workerMs: st?.ms ?? 0,
        bytesBefore: report?.bytesBefore ?? statSync(path).size,
        bytesAfter: report?.bytesAfter ?? statSync(path).size,
        disk: report?.disk ?? null,
        peakHeapUsedMb: report?.peakHeapUsedMb ?? null,
        peakHeapTotalMb: report?.peakHeapTotalMb ?? null,
        checks,
        sourceSha256: report?.sourceSha256 ?? null,
      })
    }
  } finally {
    await svc.close()
  }
  return results
}

function readOnly<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** The recordsSha256 of the newest restored backup object of a board (null when there is none). */
function backupRecordsSha256(dir: string): string | null {
  if (!existsSync(dir)) return null
  const objs = readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .sort()
  const newest = objs.at(-1)
  return newest ? readOnly(join(dir, newest), (db) => recordsSha256(db, 'documents')) : null
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      corpus: { type: 'string' },
      work: { type: 'string' },
      out: { type: 'string' },
      mode: { type: 'string', default: 'runtime' },
      cap: { type: 'string' },
      anchors: { type: 'string' },
      backups: { type: 'string' },
      staging: { type: 'boolean', default: false },
      'no-local-mode': { type: 'boolean', default: false },
    },
  })
  if (!values.corpus || !values.work || !values.out)
    throw new Error('--corpus, --work and --out are required')
  const anchorFile = values.anchors
    ? (JSON.parse(readFileSync(values.anchors, 'utf8')) as Array<{ boardId: string; anchors: string[] }>)
    : []
  const results = await convertCorpus({
    corpus: resolve(values.corpus),
    work: resolve(values.work),
    mode: values.mode === 'maintenance' ? 'maintenance' : 'runtime',
    ...(values.cap ? { capMb: Number(values.cap) } : {}),
    anchors: Object.fromEntries(anchorFile.map((b) => [b.boardId, b.anchors])),
    ...(values.backups ? { backups: resolve(values.backups) } : {}),
    staging: values.staging,
    verifyLocalMode: !values['no-local-mode'],
  })
  mkdirSync(dirname(resolve(values.out)), { recursive: true })
  writeFileSync(resolve(values.out), `${JSON.stringify(results, null, 1)}\n`)
  const ok = results.filter((r) => r.ok).length
  console.log(`convert-corpus: ${ok}/${results.length} boards passed`)
}
