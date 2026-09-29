// B8's end-of-spike cleanup (docs/EXCALIDRAW-MIGRATION.md §8.6.7 "Deleted at the end"). O4 runs it after
// the report is written and the owner has the screenshots; the lead confirms the deletion in the report.
//
//   node e2e/spike-b/b8/cleanup.ts [--v3 <V3's worktree>] [--extra <path>]... [--yes]
//
// Without --yes it only lists what it would delete. The order is the plan's:
//  1. every `dr-e2e-*` directory named in the B8 runs' launcher logs that lies OUTSIDE SPIKE_B8_DIR (a run
//     that missed the TEMP override), first, while the logs still exist;
//  2. `e2e/test-results/spike-b-7902*` and `spike-b-7907*` in this worktree (O4's two stacks' default
//     output folders);
//  3. V3's outputs and probes: `e2e/test-results/spike-b-7942*` in V3's worktree, plus the `--extra` paths
//     V3 names (its probe outputs and the probes that read the staging copies);
//  4. SPIKE_B8_DIR itself: the copies, work folders, data and temp dirs, test-results, owner-screens, logs.
// It prints paths and counts only (no path under SPIKE_B8_DIR holds board text in its name).

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const REPO = resolve(import.meta.dirname, '../../..')
const { values } = parseArgs({
  options: {
    v3: { type: 'string' },
    extra: { type: 'string', multiple: true },
    yes: { type: 'boolean', default: false },
  },
})
const B8 = process.env.SPIKE_B8_DIR
if (!B8) {
  console.log('SPIKE_B8_DIR is not set')
  process.exit(2)
}
const inside = (p: string, parent: string) => {
  const r = relative(resolve(parent), resolve(p))
  return !r || (!r.startsWith('..') && !r.includes(':'))
}

const logs: string[] = []
const walk = (p: string, depth = 0) => {
  if (!existsSync(p) || depth > 12) return
  const st = statSync(p)
  if (st.isFile()) {
    if (/\.(log|txt|json)$/.test(p)) logs.push(p)
    return
  }
  for (const n of readdirSync(p)) walk(join(p, n), depth + 1)
}
walk(B8)
const outsideDirs = new Set<string>()
for (const f of logs) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/([A-Za-z]:[\\/][^\s"'()]*?dr-e2e-[A-Za-z0-9]+)/g)) {
    const dir = resolve(m[1] as string)
    if (!inside(dir, B8) && existsSync(dir)) outsideDirs.add(dir)
  }
}
const results = (root: string, prefixes: string[]) => {
  const dir = join(root, 'e2e', 'test-results')
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => prefixes.some((p) => n.startsWith(p)))
        .map((n) => join(dir, n))
    : []
}
const steps: [string, string[]][] = [
  ['1. dr-e2e-* outside SPIKE_B8_DIR (from the launcher logs)', [...outsideDirs].sort()],
  ["2. O4's default output folders", results(REPO, ['spike-b-7902', 'spike-b-7907'])],
  [
    "3. V3's outputs and probes",
    [
      ...(values.v3 ? results(resolve(values.v3), ['spike-b-7942']) : []),
      ...(values.extra ?? []).map((p) => resolve(p)),
    ],
  ],
  ['4. SPIKE_B8_DIR', existsSync(B8) ? [resolve(B8)] : []],
]
for (const [label, paths] of steps) {
  console.log(`${label}: ${paths.length}`)
  for (const p of paths) {
    console.log(`  ${values.yes ? 'deleting' : 'would delete'} ${p}`)
    if (values.yes) rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
if (values.yes) {
  const left = steps.flatMap(([, ps]) => ps).filter((p) => existsSync(p))
  console.log(`cleanup: ${left.length} path(s) still present`)
  process.exit(left.length ? 1 : 0)
}
