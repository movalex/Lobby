// Runs session plans for a run's duration, in this thread or across worker threads (a 4-CPU load
// container runs 260 engine cores; one thread would be the bottleneck, and a client-bound run measures
// the clients, not the server). Every thread reports its sessions and its own event-loop delay p99, so
// the report can flag a run whose clients could not keep up.
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { type BoardSpec, type GeneratedBoard, generateBoard } from './boards.ts'
import type { Profile } from './profiles.ts'
import { type ClientFactory, LoadSession, type SessionPlan, type SessionReport } from './session.ts'

/** Regenerates boards from their specs (deterministic), keyed by id. */
export function boardsFromSpecs(specs: readonly BoardSpec[]): Map<string, GeneratedBoard> {
  return new Map(specs.map((s) => [s.id, generateBoard(s)]))
}

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
  /** the thin client for plans marked thin (real sync runs) */
  readonly createThinClient?: ClientFactory
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
        createThinClient: opts.createThinClient,
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
  /** explicit boards (a real stack's ids) instead of the profile's fixed ones */
  readonly boardSpecs?: readonly BoardSpec[]
  /**
   * each worker's old-generation cap (MB): a container with a memory limit (the NAS's 2 GB) needs it, or
   * each worker's V8 heap grows lazily towards its own default limit and together they pass the limit
   */
  readonly workerHeapMb?: number
}

/**
 * Splits the plans over `threads` workers: the thin sessions (thin.ts; the measuring sessions among them
 * read A→B visibility and the probe's cursor at the socket) all go to worker 0, whose event loop then has
 * no engine core to run, so the time a frame waits before the meter sees it is the network's, not a
 * neighbour core's scene rebuild (seen in the NAS smoke run: one worker at a 677 ms loop p99 on the heavy
 * board). The full-core sessions go round-robin over the other workers. With one worker, or no thin
 * session, everything is round-robin over all of them.
 */
export function partitionPlans(plans: readonly SessionPlan[], threads: number): SessionPlan[][] {
  const parts: SessionPlan[][] = Array.from({ length: Math.max(1, threads) }, () => [])
  const thin = plans.filter((p) => p.thin)
  if (threads < 2 || thin.length === 0) {
    for (const [i, p] of plans.entries()) parts[i % parts.length]?.push(p)
    return parts
  }
  parts[0] = [...thin]
  const full = plans.filter((p) => !p.thin)
  for (const [i, p] of full.entries()) parts[1 + (i % (threads - 1))]?.push(p)
  return parts
}

/**
 * Runs the plans over `threads` workers (worker.ts, partitionPlans) and merges their results. Only the
 * WorkerJob fields cross into a worker (a function or a board map would not clone, or clone for nothing);
 * `stopped` is polled here and sent to the workers as a stop message.
 */
export async function runInWorkers(
  job: WorkerJob & { readonly stopped?: () => boolean },
  threads: number,
): Promise<ThreadResult[]> {
  const parts = partitionPlans(job.plans, threads)
  const base: Omit<WorkerJob, 'plans'> = {
    profileName: job.profileName,
    syncHttpUrl: job.syncHttpUrl,
    t0: job.t0,
    durationMs: job.durationMs,
    probeSids: [...job.probeSids],
    reconnectAfterMs: job.reconnectAfterMs,
    fileIds: job.fileIds,
    boardSpecs: job.boardSpecs,
  }
  const workers: Worker[] = []
  const poll = setInterval(() => {
    if (job.stopped?.()) for (const w of workers) w.postMessage({ type: 'stop' })
  }, 500)
  try {
    return await Promise.all(
      parts.map(
        (plans) =>
          new Promise<ThreadResult>((resolve, reject) => {
            const w = new Worker(new URL('./worker.ts', import.meta.url), {
              workerData: { ...base, plans },
              ...(job.workerHeapMb ? { resourceLimits: { maxOldGenerationSizeMb: job.workerHeapMb } } : {}),
            })
            workers.push(w)
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
  } finally {
    clearInterval(poll)
  }
}
