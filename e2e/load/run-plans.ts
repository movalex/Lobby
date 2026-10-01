// Runs prepared session plans against an existing stack (B9's workstation half: the L2 load next to two
// browsers, §8.3 B9; B11's headless half can use it too). The caller (a spec) creates the board, its users
// and their api tickets, writes a job file, and starts this in its own Node process so the load's CPU
// never shares a thread with the test runner:
//
//   O3_INTERNAL_SECRET=… node e2e/load/run-plans.ts --job job.json --out report.json [--threads 2]
//
// The job holds no secret (tickets are 60 s api tickets, used at join); the stack's internal secret, for
// /internal/metrics and the test snapshot readback, comes only from the environment.
import { readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { parseArgs } from 'node:util'
import { TEST_HOOK_PATHS, TestSnapshot } from '../../packages/canvas-schema/src/protocol.ts'
import type { BoardSpec } from './boards.ts'
import { loadHeadlessFactory } from './headless.ts'
import { startScraper } from './metrics.ts'
import { PROFILES } from './profiles.ts'
import { buildReport, type FinalCheck, reportMarkdown } from './report.ts'
import { boardsFromSpecs, runInThread, runInWorkers, type ThreadResult } from './runner.ts'
import { HARNESS_RECONNECT_AFTER_MS, type SessionPlan } from './session.ts'

export interface PlansJob {
  readonly profileName: string
  readonly syncHttpUrl: string
  readonly boardSpecs: readonly BoardSpec[]
  readonly plans: readonly SessionPlan[]
  readonly probeSids: readonly [string, string][]
  readonly durationMs: number
  /** wall clock the sessions' join ramp starts at (default now + 2 s) */
  readonly t0?: number
}

const { values } = parseArgs({
  options: { job: { type: 'string' }, out: { type: 'string' }, threads: { type: 'string' } },
})
if (!values.job || !values.out) throw new Error('--job and --out are required')
const job = JSON.parse(readFileSync(values.job, 'utf8')) as PlansJob
const profile = PROFILES[job.profileName]
if (!profile) throw new Error(`unknown profile ${job.profileName}`)
const secret = process.env.O3_INTERNAL_SECRET ?? ''
const threads = values.threads !== undefined ? Number(values.threads) : Math.min(2, availableParallelism())
const boards = boardsFromSpecs(job.boardSpecs)
const t0 = job.t0 ?? Date.now() + 2_000
const scraper = secret ? startScraper(job.syncHttpUrl, secret, profile.metricsEveryMs) : null
const run = {
  profile: { ...profile, durationMs: job.durationMs },
  boards,
  plans: job.plans,
  syncHttpUrl: job.syncHttpUrl,
  t0,
  durationMs: job.durationMs,
  probeSids: new Map(job.probeSids),
  reconnectAfterMs: HARNESS_RECONNECT_AFTER_MS,
}
let results: ThreadResult[]
if (threads > 0)
  results = await runInWorkers(
    {
      profileName: profile.name,
      plans: job.plans,
      syncHttpUrl: job.syncHttpUrl,
      t0,
      durationMs: job.durationMs,
      probeSids: job.probeSids,
      reconnectAfterMs: HARNESS_RECONNECT_AFTER_MS,
      boardSpecs: job.boardSpecs,
    },
    threads,
  )
else results = [await runInThread(run, await loadHeadlessFactory())]
const endedAt = Date.now()
const scrapes = scraper ? await scraper.stop() : []

let final: FinalCheck = { stored: null, method: 'no internal secret' }
if (secret) {
  const stored = new Map<string, Record<string, unknown>>()
  let ok = true
  for (const id of boards.keys()) {
    const res = await fetch(`${job.syncHttpUrl}${TEST_HOOK_PATHS.snapshot(id)}`, {
      headers: { 'x-draftroom-internal': secret },
    }).catch(() => null)
    if (res?.status !== 200) {
      ok = false
      await res?.body?.cancel()
      continue
    }
    for (const el of TestSnapshot.parse(await res.json()).elements)
      stored.set(el.id, el as Record<string, unknown>)
  }
  final = ok ? { stored, method: 'test snapshot' } : { stored: null, method: 'test snapshot unavailable' }
}
const report = buildReport(
  {
    profile: `${profile.name} (workstation)`,
    startedAt: t0,
    endedAt,
    sync: job.syncHttpUrl,
    sessions: job.plans.length,
    node: process.version,
    cpus: availableParallelism(),
    threads,
    killAt: null,
    clientLoopDelayP99Ms: results.map((r) => r.loopDelayP99Ms),
  },
  results.flatMap((r) => r.reports),
  scrapes,
  [],
  final,
)
writeFileSync(values.out, JSON.stringify({ report, scrapes }, null, 1))
writeFileSync(values.out.replace(/\.json$/, '.md'), reportMarkdown(report))
console.log(`[run-plans] ${job.plans.length} sessions, report ${values.out}`)
