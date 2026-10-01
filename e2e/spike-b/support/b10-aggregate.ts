// B10's evidence (docs/EXCALIDRAW-MIGRATION.md §8.3 B10): every receiving-only browser and simulated
// client across B1–B9 pushes 0 ops. Reads every push log the specs wrote (writePushEvidence: <output>/b10/
// *.json under e2e/test-results/spike-b-*/, or the folders given) and the load reports' `echo` block
// (e2e/load report JSON), and prints the table for B10.md. Exit 1 if any receiver pushed.
//   node e2e/spike-b/support/b10-aggregate.ts [folder …] [--load report.json …]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PushEvidence } from './pushes.ts'

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (name.endsWith('.json')) yield p
  }
}

const args = process.argv.slice(2)
const loadIdx = args.indexOf('--load')
const folders = (loadIdx >= 0 ? args.slice(0, loadIdx) : args).map((f) => resolve(f))
const loads = loadIdx >= 0 ? args.slice(loadIdx + 1) : []
const roots = folders.length
  ? folders
  : readdirSync(resolve(import.meta.dirname, '../../test-results'))
      .filter((d) => d.startsWith('spike-b-'))
      .map((d) => resolve(import.meta.dirname, '../../test-results', d))

const rows: PushEvidence[] = []
for (const root of roots)
  for (const file of walk(root)) {
    if (!/[\\/]b10[\\/]/.test(file)) continue
    try {
      const e = JSON.parse(readFileSync(file, 'utf8')) as PushEvidence
      if (typeof e.receiver === 'string' && typeof e.ops === 'number') rows.push(e)
    } catch {}
  }

const bySpec = new Map<string, { receivers: number; pushed: number; ops: number }>()
for (const r of rows) {
  const k = r.spec
  const v = bySpec.get(k) ?? { receivers: 0, pushed: 0, ops: 0 }
  v.receivers++
  if (r.ops > 0) v.pushed++
  v.ops += r.ops
  bySpec.set(k, v)
}
const lines = ['| Source | Receiver logs | Receivers that pushed | Ops pushed |', '|---|---|---|---|']
for (const [spec, v] of [...bySpec].sort())
  lines.push(`| ${spec} | ${v.receivers} | ${v.pushed} | ${v.ops} |`)
let bad = rows.some((r) => r.ops > 0)
for (const f of loads) {
  const j = JSON.parse(readFileSync(f, 'utf8')) as {
    report: {
      meta: { profile: string }
      echo: { receivers: number; receiversThatPushed: number; receiverOps: number }
    }
  }
  const e = j.report.echo
  lines.push(
    `| load ${j.report.meta.profile} (${f.split(/[\\/]/).pop()}) | ${e.receivers} | ${e.receiversThatPushed} | ${e.receiverOps} |`,
  )
  if (e.receiversThatPushed > 0) bad = true
}
console.log(lines.join('\n'))
console.log(
  `\n${rows.length} receiver logs from ${roots.length} folders; ${bad ? 'SOME RECEIVER PUSHED' : 'every receiver pushed 0 ops'}`,
)
process.exit(bad ? 1 : 0)
