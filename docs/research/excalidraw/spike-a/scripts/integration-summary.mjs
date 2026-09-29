// Summarises integration-run.sh output: per run, per spec file, per test: status and duration, and
// (with --metrics) the metric lines the specs print (lines starting with A<n>- or SCAFFOLD-).
//   node docs/research/excalidraw/spike-a/scripts/integration-summary.mjs <INT_OUT> [--metrics] [--filter A7]
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? '/tmp/int-runs'
const withMetrics = process.argv.includes('--metrics')
const fi = process.argv.indexOf('--filter')
const filter = fi > 0 ? process.argv[fi + 1] : undefined
for (let r = 1; r <= 9; r++) {
  const file = join(dir, `run${r}`, 'spike.json')
  if (!existsSync(file)) continue
  const report = JSON.parse(readFileSync(file, 'utf8'))
  console.log(`\n## run ${r}  (spike: ${JSON.stringify(report.stats)})`)
  const walk = (suite, file) => {
    for (const s of suite.suites ?? []) walk(s, s.file ?? file)
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const res = t.results?.at(-1)
        const status = res?.status ?? t.status
        const f = spec.file ?? file
        if (filter && !f.includes(filter) && !spec.title.includes(filter)) continue
        console.log(`${status.toUpperCase().padEnd(8)} ${f.padEnd(34)} ${spec.title}  (${res?.duration ?? '?'} ms)`)
        if (withMetrics) {
          for (const o of res?.stdout ?? []) {
            for (const line of (o.text ?? '').split('\n')) {
              const text = line.trim()
              if (/^(A\d+|SCAFFOLD)-/.test(text)) console.log(`      ${text.slice(0, 900)}`)
            }
          }
        }
      }
    }
  }
  for (const s of report.suites ?? []) walk(s, s.file)
}
