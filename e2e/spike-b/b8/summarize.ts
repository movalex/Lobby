// B8's per-run summaries for the evidence file (docs/research/excalidraw/spike-b/B8.md). O4.
//
//   node e2e/spike-b/b8/summarize.ts convert <results-run1.json> [<results-run2.json> ...]
//   node e2e/spike-b/b8/summarize.ts restore <restore-run1.json> [<restore-run2.json> ...]
//
// `convert` reads convert-corpus.ts results files (one per run, the same boards in each) and prints one line
// per board: pass per run, records -> elements, items, lossy codes with counts, ms per run, bytes before ->
// after, peak heap used / total (min-max), checks passed per run, each check's total/failed (run 1) and
// whether every run gave the same checks, and lb_source's digest prefix. `restore` reads the restore
// specs' reports and prints the totals per run. Both print ids, counts, codes, timings, bytes and hashes
// only (§8.6.7): the inputs hold nothing else. Exit 1 if any board or run failed.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { BoardResult } from './convert-corpus.ts'

type Summary = {
  elements: number
  dropped: number
  added: number
  changedBeyond1e6: number
  fields: Record<string, number>
  maxDelta: number
  rewritten: number
  boundNormalized: number
  beyondTolerance: unknown[]
}

const [mode, ...files] = process.argv.slice(2)
if (!mode || !files.length) {
  console.log('usage: summarize.ts convert|restore <run files...>')
  process.exit(2)
}
const range = (xs: readonly number[]) => {
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  return lo === hi ? String(lo) : `${lo}-${hi}`
}
let bad = 0

if (mode === 'convert') {
  const runs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as BoardResult[])
  for (const b of runs[0] ?? []) {
    const rs = runs.map((r) => r.find((x) => x.boardId === b.boardId) as BoardResult)
    if (rs.some((r) => !r?.ok)) bad++
    const checks = rs.map((r) => {
      const c = Object.values(r?.checks ?? {})
      return `${c.filter((v) => v.pass).length}/${c.length}`
    })
    const same = rs.every((r) => JSON.stringify(r?.checks) === JSON.stringify(b.checks))
    const totals = Object.entries(b.checks)
      .map(([k, v]) => `${k.replace(/^diff:/, '')}=${v.total ?? '-'}/${v.failed ?? 0}`)
      .join(' ')
    console.log(
      [
        b.boardId,
        `ok ${rs.map((r) => r?.ok).join('/')}`,
        `${b.recordsIn}->${b.elementsOut}`,
        `items ${b.items}`,
        `lossy ${JSON.stringify(b.lossy)}`,
        `ms ${rs.map((r) => r.ms).join('/')}`,
        `bytes ${b.bytesBefore}->${[...new Set(rs.map((r) => r.bytesAfter))].join('/')}`,
        `heap ${range(rs.map((r) => r.peakHeapUsedMb ?? 0))} / ${range(rs.map((r) => r.peakHeapTotalMb ?? 0))} MB`,
        `disk need ${((b.disk?.neededBytes ?? 0) / 1048576).toFixed(1)} MB ok ${rs.every((r) => r.disk?.ok)}`,
        `checks ${checks.join(' ')} same ${same}`,
        `lb_source ${String(b.sourceSha256).slice(0, 12)} same ${rs.every((r) => r.sourceSha256 === b.sourceSha256)}`,
        `totals ${totals}`,
      ].join(' | '),
    )
  }
} else if (mode === 'restore') {
  for (const f of files) {
    const o = JSON.parse(readFileSync(f, 'utf8')) as Record<string, Summary>
    const t = { elements: 0, dropped: 0, added: 0, changed: 0, rewritten: 0, bound: 0, beyond: 0, max: 0 }
    const fields: Record<string, number> = {}
    for (const s of Object.values(o)) {
      t.elements += s.elements
      t.dropped += s.dropped
      t.added += s.added
      t.changed += s.changedBeyond1e6
      t.rewritten += s.rewritten
      t.bound += s.boundNormalized
      t.beyond += s.beyondTolerance.length
      t.max = Math.max(t.max, s.maxDelta)
      for (const [k, v] of Object.entries(s.fields)) fields[k] = (fields[k] ?? 0) + v
    }
    if (t.dropped || t.added || t.beyond || !Object.keys(o).length) bad++
    console.log(
      `${basename(f)} | boards ${Object.keys(o).length} | elements ${t.elements} | dropped ${t.dropped} added ${t.added} | changed > 1e-6 ${t.changed} ${JSON.stringify(fields)} | max delta ${t.max.toFixed(4)} px | beyond tolerance ${t.beyond} | rewritten ${t.rewritten} | boundElements null->[] ${t.bound}`,
    )
  }
} else {
  console.log('usage: summarize.ts convert|restore <run files...>')
  process.exit(2)
}
process.exit(bad ? 1 : 0)
