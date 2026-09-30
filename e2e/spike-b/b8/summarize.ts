// B8's per-run summaries for the evidence file (docs/research/excalidraw/spike-b/B8.md). O4.
//
//   node e2e/spike-b/b8/summarize.ts convert <results-run1.json> [<results-run2.json> ...]
//   node e2e/spike-b/b8/summarize.ts restore <restore-run1.json> [<restore-run2.json> ...]
//   node e2e/spike-b/b8/summarize.ts two <b8-two-browsers.json of run 1> [<run 2> ...]
//   node e2e/spike-b/b8/summarize.ts drill <run1/<board>.drill.json> [...]   (grouped by board, in run order)
//
// `convert` reads convert-corpus.ts results files (one per run, the same boards in each) and prints one line
// per board: pass per run, records -> elements, items, lossy codes with counts, ms per run, bytes before ->
// after, peak heap used / total (min-max), checks passed per run, each check's total/failed (run 1) and
// whether every run gave the same checks, and lb_source's digest prefix. `restore` reads the restore
// specs' reports and prints the totals per run. `two` reads the two-browser specs' rows (one file per run)
// and prints one line per board: the pass fields per run, elements, conversion and open ms, the snapshot
// hash prefix. `drill` reads the drill reports and prints one line per board and run: checks passed,
// conflicts per cycle (element id and group), the merge counts, the roll-forward ms, wall times, whether
// every release closed the board file cleanly, the born-after checks and what was not applicable, plus the
// failed checks' names. All print ids, counts, codes, timings, bytes and hashes only (§8.6.7): the inputs
// hold nothing else. Exit 1 if any board or run failed.

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
  console.log('usage: summarize.ts convert|restore|two|drill <run files...>')
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
} else if (mode === 'two') {
  type Row = Record<string, unknown> & { board: string }
  const runs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Row[])
  const PASS = ['converted', 'checkerRan', 'allElements', 'converged'] as const
  const ZERO = ['reportViolations', 'violations', 'pushesA', 'pushesB'] as const
  const okRow = (r: Row | undefined) =>
    !!r && PASS.every((k) => r[k] === true) && ZERO.every((k) => r[k] === 0)
  console.log(`runs ${runs.length}, boards per run ${runs.map((r) => r.length).join('/')}`)
  for (const b of runs[0] ?? []) {
    const rs = runs.map((r) => r.find((x) => x.board === b.board))
    if (!rs.every(okRow)) bad++
    console.log(
      [
        b.board,
        `pass ${rs.map((r) => (okRow(r) ? 'y' : 'n')).join('/')}`,
        `records ${b.recordsIn} -> elements ${b.elementsOut} (snapshot ${rs.map((r) => r?.snapshotElements).join('/')}, tombstones ${rs.map((r) => r?.tombstones).join('/')})`,
        `violations ${rs.map((r) => r?.violations).join('/')}`,
        `pushes A ${rs.map((r) => r?.pushesA).join('/')} B ${rs.map((r) => r?.pushesB).join('/')}`,
        `convert ms ${rs.map((r) => r?.convertMs).join('/')}`,
        `open ms A ${rs.map((r) => r?.openMsA).join('/')} B ${rs.map((r) => r?.openMsB).join('/')}`,
        `heap ${range(rs.map((r) => Number(r?.peakHeapTotalMb ?? 0)))} MB`,
        `hash ${[...new Set(rs.map((r) => r?.hash))].join('/')}`,
      ].join(' | '),
    )
  }
  if (runs.some((r) => r.length !== (runs[0]?.length ?? 0))) bad++
} else if (mode === 'drill') {
  type C = { name: string; pass: boolean; detail?: string }
  type Report = {
    source?: string
    boardId: string
    ok: boolean
    releasesClean?: { clean: boolean }[]
    conversion: { ok: boolean; recordsIn: number; elementsOut: number; ms: number } | null
    setup: C[]
    cycles: {
      cycle: number
      checks: C[]
      conflicts: { elementId: string; group: string }[]
      counts: Record<string, number> | null
      ms: number | null
      wallMs: { a: number | null; standIn: number; rollForward: number }
      afterRollForward: { snapshotEqualsMerged: boolean; trigger?: string } | null
    }[]
    bornAfterBoard: string
    bornAfter: C[]
    applicable: Record<string, boolean>
  }
  const reps = files.map((f) => ({ f, r: JSON.parse(readFileSync(f, 'utf8')) as Report }))
  const byBoard = new Map<string, typeof reps>()
  for (const x of reps) {
    const k = x.r.source ?? x.r.boardId
    byBoard.set(k, [...(byBoard.get(k) ?? []), x])
  }
  for (const [board, xs] of byBoard) {
    xs.forEach(({ r }, i) => {
      const all = [...r.setup, ...r.cycles.flatMap((c) => c.checks), ...r.bornAfter]
      const failed = all.filter((c) => !c.pass)
      if (!r.ok || failed.length) bad++
      const na = Object.entries(r.applicable)
        .filter(([, v]) => !v)
        .map(([k]) => k)
      console.log(
        [
          `${board} run${i + 1}`,
          `ok ${r.ok}`,
          `checks ${all.length - failed.length}/${all.length}`,
          `convert ${r.conversion ? `${r.conversion.recordsIn}->${r.conversion.elementsOut} ${r.conversion.ms} ms` : '-'}`,
          ...r.cycles.map(
            (c) =>
              `c${c.cycle}: conflicts ${c.conflicts.map((x) => `${x.elementId}/${x.group}`).join(',') || 'none'}; written ${c.counts?.elementsWritten} untouched ${c.counts?.elementsUntouched} parentMoved ${c.counts?.parentMoved} lb_deleted+ ${c.counts?.deletedRowsAppended}; rf ${c.ms} ms (wall ${c.wallMs.rollForward}); A ${c.wallMs.a} ms; R0 ${c.wallMs.standIn} ms; rf by ${c.afterRollForward?.trigger ?? '-'}; merged=snapshot ${c.afterRollForward?.snapshotEqualsMerged ?? '-'}`,
          ),
          `born-after ${r.bornAfter.filter((c) => c.pass).length}/${r.bornAfter.length}`,
          `releases clean ${(r.releasesClean ?? []).filter((x) => x.clean).length}/${(r.releasesClean ?? []).length}`,
          `n/a ${na.join(',') || 'none'}`,
          ...(failed.length ? [`FAILED ${failed.map((c) => c.name).join('; ')}`] : []),
        ].join(' | '),
      )
    })
  }
} else {
  console.log('usage: summarize.ts convert|restore|two|drill <run files...>')
  process.exit(2)
}
process.exit(bad ? 1 : 0)
