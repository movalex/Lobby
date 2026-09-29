// Runs session plans for a run's duration, in this thread or across worker threads (a 4-CPU load
// container runs 260 engine cores; one thread would be the bottleneck, and a client-bound run measures
// the clients, not the server). Every thread reports its sessions and its own event-loop delay p99, so
// the report can flag a run whose clients could not keep up.
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import type { GeneratedBoard } from './boards.ts'
import type { Profile } from './profiles.ts'
import { type ClientFactory, LoadSession, type SessionPlan, type SessionReport } from './session.ts'

export interface ThreadResult {
  readonly reports: SessionReport[]
  readonly loopDelayP99Ms: number
}

export interface RunOptions {
  readonly profile: Profile
  readonly boards: ReadonlyMap<string, GeneratedBoard>
  readonly plans: readonly SessionPlan[]
  readonly syncHttpUrl: string
  readonly t0: number
  readonly durationMs: number
  readonly probeSids: ReadonlyMap<string, string>
  readonly reconnectAfterMs?: number
  /** a stop signal checked by every session (SIGTERM, a folder over its cap) */
  readonly stopped?: () => boolean
}

export async function runInThread(opts: RunOptions, createClient: ClientFactory): Promise<ThreadResult> {
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const end = opts.t0 + opts.durationMs
  const stopping = () => Date.now() >= end || (opts.stopped?.() ?? false)
  const syncWsUrl = opts.syncHttpUrl.replace(/^http/, 'ws')
  const sessions = opts.plans.map(
    (plan) =>
      new LoadSession(plan, {
        syncWsUrl,
        createClient,
        board: opts.boards.get(plan.boardId) as GeneratedBoard,
        presenceHz: opts.profile.presenceHz,
        t0: opts.t0,
        stopping,
        reconnectAfterMs: opts.reconnectAfterMs,
        probeSid: (b) => opts.probeSids.get(b) ?? null,
      }),
  )
  await Promise.all(sessions.map((s) => s.run()))
  await Promise.all(sessions.map((s) => s.stop()))
  loop.disable()
  return { reports: sessions.map((s) => s.report()), loopDelayP99Ms: loop.percentile(99) / 1e6 }
}

/** What a worker thread gets (everything serializable; boards are regenerated from the profile). */
export interface WorkerJob {
  readonly profileName: string
  readonly plans: readonly SessionPlan[]
  readonly syncHttpUrl: string
  readonly t0: number
  readonly durationMs: number
  readonly probeSids: readonly [string, string][]
  readonly reconnectAfterMs?: number
  readonly fileIds?: readonly string[]
}

/** Splits the plans round-robin over `threads` workers (worker.ts) and merges their results. */
export async function runInWorkers(
  job: Omit<WorkerJob, 'plans'> & { plans: readonly SessionPlan[] },
  threads: number,
): Promise<ThreadResult[]> {
  const parts: SessionPlan[][] = Array.from({ length: threads }, () => [])
  for (const [i, p] of job.plans.entries()) parts[i % threads]?.push(p)
  return Promise.all(
    parts.map(
      (plans) =>
        new Promise<ThreadResult>((resolve, reject) => {
          const w = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { ...job, plans } })
          w.once('message', (m: ThreadResult | { error: string }) =>
            'error' in m ? reject(new Error(m.error)) : resolve(m),
          )
          w.once('error', reject)
          w.once('exit', (code) => {
            if (code !== 0) reject(new Error(`load worker exited with ${code}`))
          })
        }),
    ),
  )
}
