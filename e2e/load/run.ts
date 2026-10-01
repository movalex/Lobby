// The load generator (docs/EXCALIDRAW-MIGRATION.md §8.3 B9, §2.13 L1/L2; plain Node 24, no build):
//
//   node e2e/load/run.ts --profile L1 --sync http://draftroom-spike-sync:5858 --api-listen 0.0.0.0:7899 \
//     --out /reports --threads 4 [--seed file|push|none] [--tag r1] [--duration-s 600] [--host-samples f.jsonl]
//     [--cul] [--t0-file /reports/t0.txt] [--kill-file /reports/kill.txt] [--worker-heap-mb 320]
//   node e2e/load/run.ts --profile dry --fake --out <dir>          (plumbing only: an in-memory room)
//
// It runs the fake api sync talks to (fake-api.ts, on the per-run internal secret), headless clients on
// O2's real engine core with signed test tickets (tickets.ts, the per-run ticket secret), and writes one
// JSON report and its markdown table into --out. Secrets come from DRAFTROOM_TICKET_SECRET and
// DRAFTROOM_INTERNAL_SECRET (run.env on the NAS, generated per run); they are never printed.
//
// Boards: gen-boards.ts writes them before sync starts (`--seed file`, the default, as §8.3 lists the
// commands); the generator regenerates the same boards in memory (deterministic) for its bookkeeping and
// checks that sync serves them. `--seed push` creates them through the protocol instead (raw pushes).
// At the end it reads every board back (the test snapshot when sync runs with DRAFTROOM_TEST_HOOKS=1,
// else a fresh raw reader) for the acked-but-missing check.
import { availableParallelism } from 'node:os'
import { parseArgs } from 'node:util'
import { type LoadRunOptions, runLoad } from './load.ts'
import { PROFILES } from './profiles.ts'
import { reportMarkdown } from './report.ts'
import { newRunSecrets, secretsFromEnv } from './tickets.ts'

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', default: 'dry' },
      sync: { type: 'string', default: 'http://127.0.0.1:7890' },
      'api-listen': { type: 'string' },
      seed: { type: 'string', default: 'file' },
      threads: { type: 'string' },
      'duration-s': { type: 'string' },
      tag: { type: 'string', default: new Date().toISOString().replace(/[:.]/g, '-') },
      out: { type: 'string' },
      'host-samples': { type: 'string' },
      fake: { type: 'boolean', default: false },
      cul: { type: 'boolean', default: false },
      't0-file': { type: 'string' },
      'worker-heap-mb': { type: 'string' },
      'kill-file': { type: 'string' },
    },
  })
  const profile = PROFILES[values.profile as string]
  if (!profile) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(', ')}`)
  const seed = values.seed as LoadRunOptions['seed']
  if (!['file', 'push', 'none'].includes(seed)) throw new Error('--seed must be file, push or none')
  const listen = values['api-listen']?.split(':')
  let stop = false
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.once(sig, () => {
      stop = true
    })
  const report = await runLoad({
    profile,
    syncHttpUrl: (values.sync as string).replace(/\/$/, ''),
    secrets: values.fake ? newRunSecrets() : secretsFromEnv(),
    apiListen: listen ? { host: listen[0] as string, port: Number(listen[1]) } : undefined,
    seed,
    threads: values.threads !== undefined ? Number(values.threads) : Math.min(4, availableParallelism()),
    workerHeapMb: values['worker-heap-mb'] ? Number(values['worker-heap-mb']) : undefined,
    durationMs: values['duration-s'] ? Number(values['duration-s']) * 1000 : undefined,
    tag: values.tag as string,
    out: values.out ?? null,
    hostSamples: values['host-samples'],
    fake: values.fake,
    cul: values.cul ? {} : undefined,
    t0File: values['t0-file'],
    killFile: values['kill-file'],
    stopped: () => stop,
  })
  process.stdout.write(reportMarkdown(report))
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[load] ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  },
)
