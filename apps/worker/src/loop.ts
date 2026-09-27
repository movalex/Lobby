// The worker loop (contract §6): claim a job every pollMs, requeue abandoned claims every
// requeueEveryMs, one job at a time. Kept free of process-level side effects so tests can run it
// in-process; src/worker.ts wires it to env and signals.
import { claimNextJob, type DataLayout, LIMITS, requeueStale } from '@draftroom/dev-assets'
import { WORKER } from './config.ts'
import { type JobOutcome, type ProcessOptions, processJob } from './processJob.ts'

export interface WorkerOptions extends Omit<ProcessOptions, 'signal'> {
  pollMs?: number
  requeueEveryMs?: number
  staleMs?: number
  onOutcome?: (versionId: string, outcome: JobOutcome) => void
}

export interface WorkerHandle {
  /** Resolves when the loop has exited. */
  done: Promise<void>
  /**
   * Stop claiming. A running job gets `graceMs` to finish; after that its children are killed and
   * the job is released back to the queue. Calling again with a smaller grace shortens the wait.
   */
  stop(graceMs?: number): Promise<void>
  currentJob(): string | null
}

export function startWorker(l: DataLayout, opts: WorkerOptions = {}): WorkerHandle {
  const pollMs = opts.pollMs ?? WORKER.pollMs
  const requeueEveryMs = opts.requeueEveryMs ?? WORKER.requeueEveryMs
  const staleMs = opts.staleMs ?? LIMITS.staleProcessingMs
  const log = opts.log ?? (() => {})
  const jobAbort = new AbortController()
  let stopping = false
  let current: string | null = null
  let wake: (() => void) | null = null
  let graceTimer: NodeJS.Timeout | null = null
  let abortAt = Number.POSITIVE_INFINITY

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms)
      function done() {
        clearTimeout(t)
        wake = null
        resolve()
      }
      wake = done
    })

  async function loop() {
    let lastRequeue = Number.NEGATIVE_INFINITY
    while (!stopping) {
      try {
        if (Date.now() - lastRequeue >= requeueEveryMs) {
          lastRequeue = Date.now()
          for (const v of requeueStale(l, staleMs)) log(`${v} requeued (abandoned claim)`)
        }
        const claim = claimNextJob(l)
        if (!claim) {
          await sleep(pollMs)
          continue
        }
        current = claim.job.versionId
        const outcome = await processJob(l, claim, { ...opts, signal: jobAbort.signal })
        opts.onOutcome?.(claim.job.versionId, outcome)
      } catch (e) {
        // Filesystem trouble outside a job's own handling: the claim (if any) stays in processing/
        // and is requeued once stale. Keep the loop alive.
        log(
          `loop error: ${(e as Error)?.name ?? 'Error'}: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        )
        if (!stopping) await sleep(pollMs)
      } finally {
        current = null
      }
    }
  }

  const done = loop().finally(() => {
    if (graceTimer) clearTimeout(graceTimer)
  })

  return {
    done,
    currentJob: () => current,
    stop(graceMs = WORKER.shutdownGraceMs) {
      stopping = true
      wake?.()
      const at = Date.now() + graceMs
      if (current && at < abortAt) {
        abortAt = at
        if (graceTimer) clearTimeout(graceTimer)
        graceTimer = setTimeout(() => jobAbort.abort(), graceMs)
      }
      return done
    },
  }
}
