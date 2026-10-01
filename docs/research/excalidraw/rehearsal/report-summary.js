// Summarises /var/data/migration/*.json (conversion and roll-forward reports) as ids, counts, codes and
// timings only (run inside the sync container: docker exec -i … node - < report-summary.js [kind]).
const fs = require('fs')
const dir = '/var/data/migration'
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'))
  if (f.endsWith('.rollforward.json')) {
    console.log(
      JSON.stringify({
        file: f,
        kind: r.kind,
        ok: r.ok,
        reason: r.reason ?? null,
        cycle: r.cycle,
        counts: r.counts,
        conflicts: r.conflicts,
        lossy: r.lossy,
        resnap: r.resnap,
        invariants: r.invariants,
        violations: (r.violations ?? []).length,
        failures: (r.failures ?? []).length,
        repaired: (r.repaired ?? []).length,
        indexSharesKept: r.indexSharesKept,
        ms: r.ms,
        peakHeapUsedMb: r.peakHeapUsedMb,
      }),
    )
  } else if (f.endsWith('.drop-legacy.json')) {
    console.log(JSON.stringify({ file: f, ok: r.ok, reason: r.reason ?? null }))
  } else {
    console.log(
      JSON.stringify({
        file: f,
        ok: r.ok,
        reason: r.reason ?? null,
        recordsIn: r.recordsIn,
        elementsOut: r.elementsOut,
        lossy: r.lossy,
        ms: r.ms,
        peakHeapUsedMb: r.peakHeapUsedMb,
        sourceMatchesBackup: r.sourceMatchesBackup,
        backupKey: r.backupKey,
        digestEqualsExpected: r.expectedSourceSha256 !== null && r.expectedSourceSha256 === r.sourceSha256,
        disk: r.disk,
        diffOk: r.diff ? r.diff.ok : null,
        diffChecks: r.diff ? r.diff.checks.map((c) => `${c.name}:${c.pass ? 'pass' : 'FAIL ' + c.failed}`) : null,
        invariants: r.invariants,
        violations: (r.violations ?? []).length,
        cycle: r.cycle ?? null,
        keys: Object.keys(r),
      }),
    )
  }
}
