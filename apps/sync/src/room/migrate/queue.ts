// The process-wide conversion queue (docs/EXCALIDRAW-MIGRATION.md §5.3 "Worker limits", §2.13). O4.
//
//  - ONE job at a time, process-wide: convert-all, lazy conversions and roll-forward merges share one
//    FIFO with concurrency 1. A second request for a board that is already queued or running gets the
//    same promise (its joiners wait on it).
//  - Each job runs in a FRESH `worker_thread` with `resourceLimits { maxOldGenerationSizeMb,
//    maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }`: 256 MB in the maintenance window (no room open),
//    the §2.13 runtime cap otherwise (1.5 × the peak spike B8 measured for the largest board, ≤ 128 MB).
//  - Runtime gate: a runtime job starts only when process RSS + the cap ≤ 440 MB, after flushing the
//    snapshot cache; until then it waits (status `waiting-memory`, its joiners see "Preparing this board…").
//  - A worker over its cap is terminated by Node (`ERR_WORKER_OUT_OF_MEMORY`): the job fails, the board
//    stays on its tldraw tables, and only a maintenance run converts it. 60 s time budget per board: past
//    it the worker is terminated and the board is retried alone later. The process and its rooms are
//    unaffected either way.
//  - The worker's peak heap is reported per board (status and report).

import { Worker } from 'node:worker_threads'
import type { MigrateJob, WorkerInput } from './worker.ts'

export const RUNTIME_RSS_LIMIT_MB = 440
export const MAINTENANCE_CAP_MB = 256
/** §2.13: 1.5 × the largest board's measured peak, at most 128 MB (set from spike B8's numbers). */
export const RUNTIME_CAP_MB_MAX = 128
export const DEFAULT_RUNTIME_CAP_MB = 128
export const TIME_BUDGET_MS = 60_000
export const YOUNG_GEN_MB = 16
export const STACK_MB = 4

export type JobMode = 'maintenance' | 'runtime'

export type JobOutcome =
  | { readonly ok: true; readonly report: unknown; readonly ms: number }
  | {
      readonly ok: false
      /** `out-of-memory`, `time-budget`, `worker-error`, `worker-exit`, or the report's own reason */
      readonly reason: string
      readonly report?: unknown
      readonly ms: number
    }

export interface BoardStatus {
  readonly boardId: string
  readonly kind: string
  readonly mode: JobMode
  readonly state: 'queued' | 'waiting-memory' | 'running' | 'done' | 'failed'
  readonly reason?: string
  readonly ms?: number
  readonly capMb: number
  /** the worker's peak heap, from its report (MB) */
  readonly peakHeapUsedMb?: number
  readonly at: number
}

export interface MigrationQueueOptions {
  readonly log?: (...a: unknown[]) => void
  /** the runtime heap cap (MB, ≤ 128) */
  readonly runtimeCapMb?: number
  readonly maintenanceCapMb?: number
  readonly rssLimitMb?: number
  readonly timeBudgetMs?: number
  /** process RSS in bytes (default process.memoryUsage.rss) */
  readonly rss?: () => number
  /** called before a runtime job's gate check (flushes the room's snapshot cache) */
  readonly flushCaches?: () => void
  /** how often a waiting runtime job re-checks the gate */
  readonly gatePollMs?: number
  /** the worker file (default ./worker.ts) */
  readonly workerUrl?: URL
  /** accept the worker's test jobs (tests only) */
  readonly allowTestJobs?: boolean
  readonly now?: () => number
}

interface Pending {
  readonly job: MigrateJob
  readonly mode: JobMode
  readonly promise: Promise<JobOutcome>
  resolve(o: JobOutcome): void
}

export class MigrationQueue {
  private readonly opts: MigrationQueueOptions
  private readonly fifo: Pending[] = []
  private readonly byBoard = new Map<string, Pending>()
  private readonly statuses = new Map<string, BoardStatus>()
  private running: Pending | null = null
  private closed = false
  private activeWorker: Worker | null = null
  private readonly runtimeCapMb: number
  constructor(opts: MigrationQueueOptions = {}) {
    this.opts = opts
    this.runtimeCapMb = Math.min(RUNTIME_CAP_MB_MAX, opts.runtimeCapMb ?? DEFAULT_RUNTIME_CAP_MB)
  }

  /** Queues a job (or joins the one already queued or running for the board). */
  enqueue(job: MigrateJob, mode: JobMode): Promise<JobOutcome> {
    const existing = this.byBoard.get(job.boardId)
    if (existing) return existing.promise
    if (this.closed) return Promise.resolve({ ok: false, reason: 'closed', ms: 0 })
    let resolve!: (o: JobOutcome) => void
    const promise = new Promise<JobOutcome>((r) => {
      resolve = r
    })
    const p: Pending = { job, mode, promise, resolve }
    this.fifo.push(p)
    this.byBoard.set(job.boardId, p)
    this.setStatus(p, 'queued')
    void this.pump()
    return promise
  }

  /** Whether a job for the board is queued or running. */
  busy(boardId: string): boolean {
    return this.byBoard.has(boardId)
  }

  /** Every board's latest state, and the queue's depth. */
  status(): { running: string | null; queued: string[]; boards: BoardStatus[]; runtimeCapMb: number } {
    return {
      running: this.running?.job.boardId ?? null,
      queued: this.fifo.map((p) => p.job.boardId),
      boards: [...this.statuses.values()].sort((a, b) => (a.boardId < b.boardId ? -1 : 1)),
      runtimeCapMb: this.runtimeCapMb,
    }
  }

  /** Refuses new jobs, fails the queued ones and terminates the running worker. */
  async close(): Promise<void> {
    this.closed = true
    for (const p of this.fifo.splice(0)) {
      this.byBoard.delete(p.job.boardId)
      p.resolve({ ok: false, reason: 'closed', ms: 0 })
    }
    await this.activeWorker?.terminate()
  }

  private capFor(mode: JobMode) {
    return mode === 'maintenance' ? (this.opts.maintenanceCapMb ?? MAINTENANCE_CAP_MB) : this.runtimeCapMb
  }

  private setStatus(p: Pending, state: BoardStatus['state'], extra: Partial<BoardStatus> = {}) {
    this.statuses.set(p.job.boardId, {
      boardId: p.job.boardId,
      kind: p.job.kind,
      mode: p.mode,
      state,
      capMb: this.capFor(p.mode),
      at: (this.opts.now ?? Date.now)(),
      ...extra,
    })
  }

  private async pump(): Promise<void> {
    if (this.running || this.closed) return
    const p = this.fifo.shift()
    if (!p) return
    this.running = p
    try {
      if (p.mode === 'runtime') await this.waitForMemory(p)
      const outcome = this.closed
        ? ({ ok: false, reason: 'closed', ms: 0 } as const)
        : await this.runWorker(p)
      const report = (outcome.report ?? (outcome.ok ? outcome.report : undefined)) as
        | { peakHeapUsedMb?: number }
        | undefined
      this.setStatus(p, outcome.ok ? 'done' : 'failed', {
        ...(outcome.ok ? {} : { reason: outcome.reason }),
        ms: outcome.ms,
        ...(typeof report?.peakHeapUsedMb === 'number' ? { peakHeapUsedMb: report.peakHeapUsedMb } : {}),
      })
      p.resolve(outcome)
    } finally {
      this.byBoard.delete(p.job.boardId)
      this.running = null
      void this.pump()
    }
  }

  /** §2.13 runtime gate: RSS + the cap ≤ the limit, after flushing caches; waits otherwise. */
  private async waitForMemory(p: Pending): Promise<void> {
    const limit = (this.opts.rssLimitMb ?? RUNTIME_RSS_LIMIT_MB) * 1024 * 1024
    const cap = this.capFor('runtime') * 1024 * 1024
    const rss = this.opts.rss ?? (() => process.memoryUsage.rss())
    for (let first = true; !this.closed; first = false) {
      this.opts.flushCaches?.()
      if (rss() + cap <= limit) return
      if (first) {
        this.setStatus(p, 'waiting-memory')
        this.opts.log?.('[migrate] waiting for memory', p.job.boardId)
      }
      await new Promise((r) => setTimeout(r, this.opts.gatePollMs ?? 500))
    }
  }

  private runWorker(p: Pending): Promise<JobOutcome> {
    const t0 = performance.now()
    const ms = () => Math.round(performance.now() - t0)
    this.setStatus(p, 'running')
    return new Promise<JobOutcome>((resolve) => {
      let settled = false
      const input: WorkerInput = { job: p.job, allowTestJobs: this.opts.allowTestJobs === true }
      const worker = new Worker(this.opts.workerUrl ?? new URL('./worker.ts', import.meta.url), {
        workerData: input,
        resourceLimits: {
          maxOldGenerationSizeMb: this.capFor(p.mode),
          maxYoungGenerationSizeMb: YOUNG_GEN_MB,
          stackSizeMb: STACK_MB,
        },
        // the worker's own output never reaches the process log (it prints nothing; a stray line could hold content)
        stdout: true,
        stderr: true,
      })
      worker.stdout.resume()
      worker.stderr.resume()
      this.activeWorker = worker
      const finish = (o: JobOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.activeWorker = null
        void worker.terminate()
        resolve(o)
      }
      const timer = setTimeout(() => {
        this.opts.log?.('[migrate] time budget exceeded, worker terminated', p.job.boardId)
        finish({ ok: false, reason: 'time-budget', ms: ms() })
      }, this.opts.timeBudgetMs ?? TIME_BUDGET_MS)
      worker.once('message', (report: unknown) => {
        const r = report as { ok?: boolean; reason?: string } | null
        if (r?.ok === true) finish({ ok: true, report, ms: ms() })
        else finish({ ok: false, reason: r?.reason ?? 'failed', report, ms: ms() })
      })
      worker.once('error', (e: Error & { code?: string }) => {
        const oom = e?.code === 'ERR_WORKER_OUT_OF_MEMORY'
        this.opts.log?.(
          '[migrate] worker failed',
          p.job.boardId,
          oom ? 'ERR_WORKER_OUT_OF_MEMORY' : (e?.name ?? 'Error'),
        )
        finish({ ok: false, reason: oom ? 'out-of-memory' : 'worker-error', ms: ms() })
      })
      worker.once('exit', (code) => {
        finish({ ok: false, reason: `worker-exit ${code}`, ms: ms() })
      })
    })
  }
}
