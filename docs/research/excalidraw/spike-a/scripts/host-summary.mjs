// Summarises host-run.sh output: per run, per spec file, per test: status and duration, and the
// metric lines the specs print (A1-, A2-, A4-, A5-, A6-, A16-, A17- prefixes).
//   node docs/research/excalidraw/spike-a/scripts/host-summary.mjs <HOST_OUT> [--metrics]
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? '/tmp/host-runs'
const withMetrics = process.argv.includes('--metrics')
for (let r = 1; r <= 9; r++) {
  const file = join(dir, `e2e-${r}.json`)
  if (!existsSync(file)) continue
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const unit = readFileSync(join(dir, `unit-${r}.log`), 'utf8').match(/Tests\s+(\d+ passed[^\n]*)/)?.[1]
  console.log(`\n## run ${r}  (unit: ${unit ?? '?'}; e2e: ${JSON.stringify(report.stats)})`)
  const walk = (suite, file) => {
    for (const s of suite.suites ?? []) walk(s, s.file ?? file)
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const res = t.results?.at(-1)
        console.log(`${res?.status === 'passed' ? 'PASS' : 'FAIL'}  ${(spec.file ?? file).padEnd(28)} ${spec.title}  (${res?.duration ?? '?'} ms)`)
        if (withMetrics) {
          for (const o of res?.stdout ?? []) {
            const text = (o.text ?? '').trim()
            if (/^A\d+-/.test(text)) console.log(`      ${text.slice(0, 600)}`)
          }
        }
      }
    }
  }
  for (const s of report.suites ?? []) walk(s, s.file)
}
