// The preview worker loop (docs/M3-STORAGE-CONTRACTS.md §5): `concurrency` slots, each claiming a job
// from the API and running it to the end. An idle or unreachable API is polled with exponential backoff
// and jitter (pollMs, 2x, 4x, ... up to pollMaxMs), reset as soon as a claim returns work. Kept free of
// process-level side effects so tests run it in-process; src/worker.ts wires it to env and signals.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaimedJob, WorkerApi } from './api-client.ts'
import { WORKER } from './config.ts'
import type { WorkerOpsApi } from './ops/client.ts'
import { type RunOpOptions, type RunOpOutcome, runOneOp } from './ops/loop.ts'
import type { ProcessOptions } from './processJob.ts'
import { type RemoteOutcome, runRemoteJob, TMP_PREFIX } from './remote-job.ts'

export interface RemoteWorkerOptions {
  api: WorkerApi
  concurrency?: number
  pollMs?: number
  pollMaxMs?: number
  /** Parent of the per-job temporary directories (default os.tmpdir()). */
  tmpDir?: string
  process?: Omit<ProcessOptions, 'signal' | 'log'>
  heartbeatMs?: number
  downloadStallMs?: number
  downloadTimeoutMs?: number
  uploadTimeoutMs?: number
  log?: (line: string) => void
  onOutcome?: (versionId: string, outcome: RemoteOutcome) => void
  /** Test hook for the jitter. */
  random?: () => number
  /**
   * Wave W (ops/loop.ts): worker ops, asked for only when a preview claim came back empty (previews keep priority), in
   * the same slot. Absent, or no capability to report: the worker never calls /api/worker/ops/* (a worker of before).
   */
  ops?: {
    api: WorkerOpsApi
    capabilities: readonly string[]
    runners?: RunOpOptions['runners']
    /** after an api answered that it has no ops routes (404), ask again only this much later (default 10 min) */
    unsupportedBackoffMs?: number
    onOutcome?: (outcome: RunOpOutcome) => void
  }
}

export interface RemoteWorkerHandle {
  /** Resolves when every slot has exited. */
  done: Promise<void>
  /**
   * Stop claiming. Running jobs get `graceMs` to finish; after that their children are killed and the
   * jobs are released back to the API. Calling again with a smaller grace shortens the wait.
   */
  stop(graceMs?: number): Promise<void>
  currentJobs(): string[]
}

/** Idle delay after `streak` consecutive empty (or failed) claims: pollMs·2^streak, ±20 %, at most max(pollMs, maxMs). */
export function idleDelay(streak: number, pollMs: number, maxMs: number, random: () => number = Math.random) {
  const cap = Math.max(pollMs, maxMs)
  const base = Math.min(cap, pollMs * 2 ** Math.min(streak, 30))
  return Math.round(Math.min(cap, base * (0.8 + 0.4 * random())))
}

/**
 * Removes job directories a crashed process left behind (a container restart keeps its writable layer,
 * so they would pile up). Only `drw-job-XXXXXX` entries older than `ageMs` are touched, so a directory
 * of a job running in another worker process on the same machine is never removed.
 */
export function sweepTmp(dir: string, ageMs: number, now = Date.now()): number {
  let removed = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const re = new RegExp(`^${TMP_PREFIX}[A-Za-z0-9]{6}$`)
  for (const n of names) {
    if (!re.test(n)) continue
    const p = join(dir, n)
    try {
      if (now - statSync(p).mtimeMs < ageMs) continue
      rmSync(p, { recursive: true, force: true, maxRetries: 3 })
      removed++
    } catch {}
  }
  return removed
}

export function startRemoteWorker(o: RemoteWorkerOptions): RemoteWorkerHandle {
  const api = o.api
  const concurrency = Math.max(1, o.concurrency ?? WORKER.concurrency)
  const pollMs = o.pollMs ?? WORKER.pollMs
  const pollMaxMs = o.pollMaxMs ?? WORKER.pollMaxMs
  const tmpDir = o.tmpDir ?? tmpdir()
  const log = o.log ?? (() => {})
  const random = o.random ?? Math.random
  // Aborted when the shutdown grace runs out (or at once for stop(0)): running jobs are released.
  const shutdown = new AbortController()
  let stopping = false
  let graceTimer: NodeJS.Timeout | null = null
  let abortAt = Number.POSITIVE_INFINITY
  const current = new Set<string>()
  const wakers = new Set<() => void>()
  // Claim trouble is logged when it starts and when it ends, not on every poll.
  let claimTrouble: string | null = null

  mkdirSync(tmpDir, { recursive: true }) // WORKER_TMP_DIR may point at a fresh volume
  const swept = sweepTmp(tmpDir, WORKER.tmpSweepAgeMs)
  if (swept) log(`removed ${swept} leftover job director${swept === 1 ? 'y' : 'ies'}`)

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms)
      function done() {
        clearTimeout(t)
        wakers.delete(done)
        resolve()
      }
      wakers.add(done)
    })

  async function handBack(versionId: string, why: string) {
    try {
      await api.retry({ versionId }, { code: 'PROTOCOL', message: why.slice(0, 300) })
    } catch {}
  }

  // wave W: an api without ops routes is asked again only after a long pause; trouble is logged once
  let opsPausedUntil = 0
  let opsTrouble: string | null = null
  /** One op, if the worker has capabilities and the api has ops. True when an op was claimed (whatever its outcome). */
  async function tryOp(): Promise<boolean> {
    const ops = o.ops
    if (!ops?.capabilities.length || Date.now() < opsPausedUntil) return false
    let outcome: RunOpOutcome
    try {
      outcome = await runOneOp({
        ops: ops.api,
        api,
        capabilities: ops.capabilities,
        ...(ops.runners ? { runners: ops.runners } : {}),
        tmpDir,
        signal: shutdown.signal,
        heartbeatMs: o.heartbeatMs,
        log,
      })
      opsTrouble = null
    } catch (e) {
      const err = e as Error & { kind?: string }
      if (err.kind === 'aborted') return false
      const what = `ops claim failed (${err.message})`
      if (what !== opsTrouble) log(what)
      opsTrouble = what
      return false
    }
    ops.onOutcome?.(outcome)
    if (outcome.kind === 'unsupported') {
      if (opsPausedUntil === 0) log('this api has no worker ops: previews only')
      opsPausedUntil = Date.now() + (ops.unsupportedBackoffMs ?? 10 * 60_000)
      return false
    }
    return outcome.kind !== 'none'
  }

  async function slot() {
    let idle = 0
    while (!stopping) {
      let claimed: ClaimedJob | null
      try {
        // Not cancelled by stop(): a claim the API already committed must not be dropped on the floor.
        // It is only cut off when the grace runs out.
        claimed = await api.claim(shutdown.signal)
        if (claimTrouble) {
          log('api reachable again')
          claimTrouble = null
        }
      } catch (e) {
        const err = e as Error & { kind?: string; status?: number | null; versionId?: string | null }
        if (err.kind === 'aborted') break
        const what =
          err.kind === 'auth'
            ? `claim refused (${err.message}): check DRAFTROOM_WORKER_TOKEN`
            : `claim failed (${err.message})`
        if (what !== claimTrouble) log(what)
        claimTrouble = what
        if (err.kind === 'protocol' && err.versionId) await handBack(err.versionId, err.message)
        if (!stopping) await sleep(idleDelay(idle++, pollMs, pollMaxMs, random))
        continue
      }
      if (!claimed) {
        // wave W: no preview to make, so ask for one op (previews keep priority)
        if (!stopping && (await tryOp())) {
          idle = 0
          continue
        }
        if (!stopping) await sleep(idleDelay(idle++, pollMs, pollMaxMs, random))
        continue
      }
      idle = 0
      const v = claimed.job.versionId
      current.add(v)
      try {
        log(`${v} claimed (${claimed.job.kind}, attempt ${claimed.job.attempt})`)
        const outcome = await runRemoteJob(claimed, {
          api,
          tmpDir,
          process: o.process,
          heartbeatMs: o.heartbeatMs,
          downloadStallMs: o.downloadStallMs,
          downloadTimeoutMs: o.downloadTimeoutMs,
          uploadTimeoutMs: o.uploadTimeoutMs,
          signal: shutdown.signal,
          stopping: () => stopping,
          log,
        })
        o.onOutcome?.(v, outcome)
      } catch (e) {
        // runRemoteJob() handles its own failures; this is a bug guard that keeps the slot alive.
        log(`${v} job error: ${(e as Error)?.name ?? 'Error'}`)
      } finally {
        current.delete(v)
      }
    }
  }

  const done = Promise.all(Array.from({ length: concurrency }, () => slot())).then(
    () => {
      if (graceTimer) clearTimeout(graceTimer)
    },
    (e) => {
      if (graceTimer) clearTimeout(graceTimer)
      throw e
    },
  )

  return {
    done,
    currentJobs: () => [...current],
    stop(graceMs = WORKER.shutdownGraceMs) {
      stopping = true
      for (const wake of [...wakers]) wake()
      const at = Date.now() + graceMs
      if (at < abortAt) {
        abortAt = at
        if (graceTimer) clearTimeout(graceTimer)
        if (graceMs <= 0) shutdown.abort('worker stopping')
        else graceTimer = setTimeout(() => shutdown.abort('worker stopping'), graceMs)
      }
      return done
    },
  }
}
