/**
 * A Miro board's report (contracts imports.ts ImportBoardReport): counts by result and by type, the notes, and one
 * row per item for the CSV, kept within IMPORT_REPORT_MAX_ROWS and IMPORT_REPORT_MAX_BYTES as the 0035 CHECK measures
 * it (importReportBytes: Postgres's jsonb text, not the compact JSON, which is a tenth smaller for short rows): when the
 * rows do not fit, the ones that say something (failed, placeholder, approximate, skipped) are kept before the
 * native ones, and `rowsOmitted` says how many were left out. Ids, types and codes only: never content. Pure.
 */
import {
  IMPORT_REPORT_MAX_BYTES,
  IMPORT_REPORT_MAX_ROWS,
  type ImportBoardReport,
  type ImportItemResult,
  type ImportReportRow,
  importReportBytes,
} from '@draftroom/contracts'

export type ReportRow = ImportReportRow

const MAX_TYPE_KEYS = 48

const PRIORITY: Readonly<Record<ImportItemResult, number>> = {
  failed: 0,
  placeholder: 1,
  approximate: 2,
  skipped: 3,
  native: 4,
}

const typeKey = (t: string) => (/^[a-z][a-z0-9_]{0,47}$/.test(t) ? t : 'unknown')

export function buildReport(
  rows: readonly ReportRow[],
  noteCounts: ReadonlyMap<string, number>,
  extraByType: ReadonlyMap<string, ReadonlyMap<ImportItemResult, number>> = new Map(),
): ImportBoardReport {
  const counts = { native: 0, approximate: 0, placeholder: 0, failed: 0, skipped: 0 }
  const byType: Record<string, Partial<Record<ImportItemResult, number>>> = {}
  const bump = (type: string, result: ImportItemResult, n = 1) => {
    let key = typeKey(type)
    if (!(key in byType) && Object.keys(byType).length >= MAX_TYPE_KEYS) key = 'unknown'
    const t = byType[key] ?? {}
    t[result] = (t[result] ?? 0) + n
    byType[key] = t
  }
  const clean: ReportRow[] = rows.map((r) => ({
    sourceId: r.sourceId.slice(0, 80),
    type: typeKey(r.type),
    result: r.result,
    elementId: r.elementId ? r.elementId.slice(0, 64) : null,
    note: r.note,
  }))
  for (const r of clean) {
    counts[r.result]++
    bump(r.type, r.result)
  }
  for (const [type, m] of extraByType) for (const [result, n] of m) bump(type, result, n)
  const notes: Record<string, number> = {}
  for (const [n, c] of [...noteCounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) notes[n] = c

  // the rows that fit, the telling ones first (each kept row stays in Miro's order)
  const ranked = clean
    .map((r, i) => ({ r, i }))
    .sort((a, b) => PRIORITY[a.r.result] - PRIORITY[b.r.result] || a.i - b.i)
  // the report without rows, its rowsOmitted at its widest: what is left of the cap is the rows' (each with its ", ")
  const summary = { total: clean.length, counts, byType, notes, rows: [], rowsOmitted: clean.length }
  const budget = IMPORT_REPORT_MAX_BYTES - importReportBytes(summary)
  const keep = new Set<number>()
  let bytes = 0
  for (const { r, i } of ranked) {
    if (keep.size >= IMPORT_REPORT_MAX_ROWS) break
    const size = importReportBytes(r) + (keep.size ? 2 : 0)
    if (bytes + size > budget) break
    bytes += size
    keep.add(i)
  }
  const kept = clean.filter((_, i) => keep.has(i))
  return { ...summary, rows: kept, rowsOmitted: clean.length - kept.length }
}
