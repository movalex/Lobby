// One job claimed from the API (docs/M3-STORAGE-CONTRACTS.md §5), end to end:
//   heartbeat the lease (≤ 30 s apart) for as long as the job runs
//   → download the original into a short temporary local layout (size-checked, stall/deadline timeouts)
//   → run the existing processors on it via processJob() (every M0 limit and child timeout applies)
//   → per derivative: reserve it (/derivatives), PUT the bytes to the returned URL
//   → /complete (ready or a permanent failure) or /retry (transient trouble, or a release on shutdown)
//   → delete the temporary directory, whatever happened.
// A lost lease (409, or no successful heartbeat for a whole lease period) aborts the job at once: children
// are killed and nothing more is sent for it, because another worker may already own it.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AssetVersionMeta,
  claimNextJob,
  dataLayout,
  derivativePath,
  enqueueJob,
  ensureLayout,
  LIMITS,
  maxKindBytes,
  originalPath,
  PREVIEW_PROFILE,
  type ProbeFacts,
  readMeta,
  versionDir,
  writeMeta,
} from '@draftroom/dev-assets'
import {
  type ClaimedJob,
  type CompleteBody,
  isRetryable,
  type LeaseRef,
  type RemoteJob,
  type RetryReason,
  type WorkerApi,
  WorkerApiError,
} from './api-client.ts'
import { WORKER } from './config.ts'
import { type FailureCode, PreviewError, userMessage } from './errors.ts'
import { type ProcessOptions, processJob } from './processJob.ts'
import { stderrTail } from './run.ts'
import { downloadOriginal, TransferError, uploadBlob } from './transfer.ts'

export type RemoteOutcome =
  | { result: 'ready'; derivatives: number }
  | { result: 'failed'; code: FailureCode }
  | { result: 'retry'; detail: string }
  | { result: 'released' }
  | { result: 'abandoned'; reason: string }

export interface RemoteJobOptions {
  api: WorkerApi
  /** Parent of the per-job temporary directories (`drw-job-XXXXXX`). */
  tmpDir: string
  process?: Omit<ProcessOptions, 'signal' | 'log'>
  /** Override of the heartbeat interval (default leaseMs / 4, clamped to 250 ms..30 s). */
  heartbeatMs?: number
  downloadStallMs?: number
  /** Override of the download deadline (default 60 s + 1 s per MB). */
  downloadTimeoutMs?: number
  uploadTimeoutMs?: number
  /** Aborted when the worker's shutdown grace runs out: children are killed and the job is released. */
  signal: AbortSignal
  /** True once the worker is stopping: final API calls are then single attempts with short timeouts. */
  stopping: () => boolean
  log: (line: string) => void
}

export const TMP_PREFIX = 'drw-job-'

const EMPTY_PROBE: ProbeFacts = {
  width: null,
  height: null,
  pageCount: null,
  durationMs: null,
  videoCodec: null,
  audioCodec: null,
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })

/** Retries retryable API failures (network/5xx) with 0.5/1/2 s pauses. Every call here is idempotent. */
async function withRetries<T>(
  tries: number,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries || !isRetryable(e) || signal?.aborted) throw e
      await sleep(500 * 2 ** (i - 1), signal)
    }
  }
}

interface Lease {
  readonly signal: AbortSignal
  lost(): string | null
  beats(): number
  stop(): void
}

/** Heartbeat period for a lease: a quarter of it, never more than 30 s apart (contract §5), never below 250 ms. */
export function heartbeatInterval(leaseMs: number): number {
  return Math.min(WORKER.heartbeatMaxMs, Math.max(WORKER.heartbeatMinMs, Math.floor(leaseMs / 4)))
}

/** Heartbeats until stop(). Aborts `signal` (reason 'lease lost') on 409/404/410 or once a whole lease period passes without a successful heartbeat. */
function holdLease(api: WorkerApi, job: RemoteJob, o: RemoteJobOptions): Lease {
  const ctl = new AbortController()
  const inflight = new AbortController()
  let leaseMs = job.leaseMs
  const every = o.heartbeatMs ?? heartbeatInterval(leaseMs)
  // The API computed lease_until when it handled the claim, a little before we got the answer; counting
  // from "now" would overestimate. Each heartbeat below counts from when it was SENT, for the same reason.
  let validFrom = Date.now()
  let lostReason: string | null = null
  let stopped = false
  let beats = 0
  let failing = false
  let timer: NodeJS.Timeout | null = null
  const lose = (why: string) => {
    if (lostReason) return
    lostReason = why
    o.log(`${job.versionId} ${why}; abandoning it`)
    ctl.abort('lease lost')
  }
  const tick = async () => {
    timer = null
    if (stopped) return
    const sentAt = Date.now()
    try {
      const r = await api.heartbeat(
        { versionId: job.versionId, attempt: job.attempt },
        AbortSignal.any([
          inflight.signal,
          // At most one request timeout (or one beat interval, if shorter): a hung beat must not delay the next.
          AbortSignal.timeout(Math.max(1_000, Math.min(WORKER.requestTimeoutMs, every))),
        ]),
      )
      beats++
      validFrom = sentAt
      if (r.leaseMs) leaseMs = r.leaseMs
      if (failing) o.log(`${job.versionId} heartbeat ok again`)
      failing = false
    } catch (e) {
      if (stopped) return
      if (e instanceof WorkerApiError && e.kind === 'lease') {
        lose(`lease lost (heartbeat ${e.message})`)
        return
      }
      if (!failing) o.log(`${job.versionId} heartbeat failed (${(e as Error).message}); will keep trying`)
      failing = true
      if (Date.now() - validFrom >= leaseMs) {
        lose('lease expired without a successful heartbeat')
        return
      }
    }
    if (!stopped) timer = setTimeout(tick, every)
  }
  timer = setTimeout(tick, every)
  return {
    signal: ctl.signal,
    lost: () => lostReason,
    beats: () => beats,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      inflight.abort()
    },
  }
}

/** The local stand-in for the version row: what processJob() needs, and no user file name. */
function localMeta(job: RemoteJob): AssetVersionMeta {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    assetId: job.assetId,
    versionId: job.versionId,
    boardId: job.boardId,
    name: 'original',
    declaredMimeType: job.declaredMimeType,
    mimeType: job.declaredMimeType || 'application/octet-stream',
    kind: job.kind,
    sizeBytes: job.sizeBytes,
    sha256: '',
    uploadedBy: 'remote',
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    // processJob() bumps this before working, so it then equals the API's attempt counter and its
    // poison-pill / maxAttempts rules decide exactly as they did against the local queue.
    attempts: job.attempt - 1,
    error: null,
    probe: { ...EMPTY_PROBE },
    derivatives: [],
  }
}

export async function runRemoteJob(claimed: ClaimedJob, o: RemoteJobOptions): Promise<RemoteOutcome> {
  const { job } = claimed
  const { api, log } = o
  const v = job.versionId
  const ref: LeaseRef = { versionId: v, attempt: job.attempt }
  const t0 = Date.now()
  const lease = holdLease(api, job, o)
  const signal = AbortSignal.any([o.signal, lease.signal])
  let root: string | null = null

  const finalTries = () => (o.stopping() ? 1 : 4)

  /**
   * Ends the job on the API: null when accepted, else the outcome to report. A lost lease abandons the
   * job; 'rejected' (a 4xx other than the lease, e.g. 409 DERIVATIVE_MISSING) is returned as such so
   * the caller can decide; an unreachable api abandons it (the lease expires and it is claimed again).
   */
  const send = async (
    what: 'complete' | 'retry',
    fn: () => Promise<void>,
  ): Promise<RemoteOutcome | { result: 'rejected'; detail: string } | null> => {
    if (lease.lost()) return { result: 'abandoned', reason: 'lease lost' }
    lease.stop() // no heartbeat may race the final call (a late one would 409 and look like a lost lease)
    try {
      await withRetries(finalTries(), undefined, fn)
      return null
    } catch (e) {
      const err = e as WorkerApiError
      if (err.kind === 'lease') {
        log(`${v} ${what} refused (${err.message}): the lease was lost; abandoning it`)
        return { result: 'abandoned', reason: 'lease lost' }
      }
      if (err.kind === 'rejected') return { result: 'rejected', detail: `${what} ${err.message}` }
      log(`${v} ${what} failed (${err.message}); the lease will expire and the job will be claimed again`)
      return { result: 'abandoned', reason: `${what} failed` }
    }
  }

  const complete = async (body: CompleteBody, outcome: RemoteOutcome): Promise<RemoteOutcome> => {
    const r = await send('complete', () => api.complete(ref, body))
    if (r?.result === 'rejected') {
      // A refused `ready` (e.g. a derivative blob the api cannot find) is transient trouble: hand the job
      // back. A refused `failed` is not retried from here (that could loop); the lease runs out instead.
      if (body.status === 'ready') return transient(`${r.detail}`)
      log(`${v} ${r.detail}; the lease will expire and the job will be claimed again`)
      return { result: 'abandoned', reason: 'complete refused' }
    }
    if (r) return r
    const ms = Date.now() - t0
    if (outcome.result === 'ready')
      log(`${v} ${job.kind} ready: ${outcome.derivatives} derivatives in ${ms} ms`)
    else if (outcome.result === 'failed') log(`${v} ${job.kind} failed ${outcome.code} after ${ms} ms`)
    return outcome
  }

  const failed = (e: PreviewError, probe: ProbeFacts = EMPTY_PROBE) => {
    if (e.detail) log(`${v} ${e.code}: ${e.detail}`)
    return complete(
      {
        status: 'failed',
        probe,
        derivatives: [],
        error: { code: e.code, message: userMessage(e.code) },
      },
      { result: 'failed', code: e.code },
    )
  }

  const retry = async (
    reason: RetryReason,
    outcome: RemoteOutcome,
    release = false,
  ): Promise<RemoteOutcome> => {
    const r = await send('retry', () => api.retry(ref, reason, { release }))
    if (r?.result === 'rejected') {
      log(`${v} ${r.detail}; the lease will expire and the job will be claimed again`)
      return { result: 'abandoned', reason: 'retry refused' }
    }
    if (r) return r
    if (outcome.result === 'retry') log(`${v} attempt ${job.attempt} will be retried: ${reason.message}`)
    else log(`${v} handed back to the api (${reason.message})`)
    return outcome
  }

  /** Transient trouble: retried, except that the last allowed attempt fails as INTERNAL (as processJob does). */
  const transient = (detail: string) => {
    const safe = stderrTail(detail, 1)
    if (job.attempt >= LIMITS.maxAttempts) {
      return failed(new PreviewError('INTERNAL', `attempt ${job.attempt}: ${safe}`))
    }
    return retry({ code: 'TRANSIENT', message: safe }, { result: 'retry', detail: safe })
  }

  /** Our own abort: a lost lease sends nothing; a shutdown hands the job back without using up the attempt. */
  const interrupted = () => {
    if (lease.lost()) return Promise.resolve<RemoteOutcome>({ result: 'abandoned', reason: 'lease lost' })
    return retry({ code: 'RELEASED', message: 'worker shutting down' }, { result: 'released' }, true)
  }

  try {
    // Checks that need no bytes: never download what will be rejected or not looked at.
    if (job.attempt > LIMITS.maxAttempts) {
      return await failed(new PreviewError('INTERNAL', `gave up after ${job.attempt - 1} attempts`))
    }
    // the largest the kind allows (a PSD is kind pdf up to 200 MiB); processJob checks the limit of the content
    if (job.sizeBytes > maxKindBytes(job.kind)) {
      return await failed(new PreviewError('FILE_TOO_LARGE', `${job.sizeBytes} bytes`))
    }
    if (job.kind === 'other') {
      // Attachments get no derivatives and keep their declared type (M0 §6): nothing to download.
      return await complete(
        { status: 'ready', probe: { ...EMPTY_PROBE }, derivatives: [] },
        { result: 'ready', derivatives: 0 },
      )
    }

    root = await mkdtemp(join(o.tmpDir, TMP_PREFIX))
    const l = ensureLayout(dataLayout(root))
    await mkdir(versionDir(l, job.assetId, v), { recursive: true })
    try {
      await downloadOriginal(api, claimed.original, originalPath(l, job.assetId, v), {
        bytes: job.sizeBytes,
        timeoutMs:
          o.downloadTimeoutMs ??
          WORKER.downloadBaseMs + Math.ceil(job.sizeBytes / 1_000_000) * WORKER.downloadMsPerMb,
        stallMs: o.downloadStallMs ?? WORKER.downloadStallMs,
        signal,
      })
    } catch (e) {
      if (e instanceof TransferError) {
        if (e.kind === 'aborted') return await interrupted()
        if (e.kind === 'missing') return await failed(new PreviewError('FILE_MISSING', e.message))
        return await transient(e.message)
      }
      if (e instanceof WorkerApiError) return await transient(`original: ${e.message}`)
      throw e
    }

    writeMeta(l, localMeta(job))
    enqueueJob(l, {
      assetId: job.assetId,
      versionId: v,
      boardId: job.boardId,
      profile: PREVIEW_PROFILE,
      enqueuedAt: new Date().toISOString(),
      attempt: job.attempt,
    })
    const local = claimNextJob(l)
    if (!local) return await transient('local queue claim failed')
    const out = await processJob(l, local, { ...o.process, signal, log })
    if (out.result === 'released') return await interrupted()
    const meta = readMeta(l, job.assetId, v)
    if (!meta) return await transient('local meta missing')
    if (out.result === 'retry') return await transient(out.detail)
    if (out.result === 'dropped') return await transient('local job dropped')
    if (out.result === 'failed') {
      const code = (meta.error?.code ?? 'INTERNAL') as FailureCode
      // processJob() already logged the detail; report the code with the fixed user message.
      return await failed(new PreviewError(code), meta.probe)
    }

    // Ready locally: publish each derivative, then complete with the ids the API handed out.
    const ids: string[] = []
    for (const d of meta.derivatives) {
      if (signal.aborted) return await interrupted()
      const bytes = await readFile(derivativePath(l, job.assetId, v, d.file))
      if (bytes.length !== d.bytes) return await transient('derivative size changed on disk')
      try {
        const r = await withRetries(3, signal, () =>
          api.reserve(
            ref,
            {
              role: d.role,
              page: d.page,
              mimeType: d.mimeType,
              width: d.width,
              height: d.height,
              bytes: d.bytes,
            },
            signal,
          ),
        )
        await withRetries(3, signal, async () => {
          try {
            await uploadBlob(api, r.upload, bytes, {
              timeoutMs: o.uploadTimeoutMs ?? WORKER.uploadTimeoutMs,
              signal,
            })
          } catch (e) {
            // Map to the API error type so withRetries() treats network/5xx PUT failures as retryable.
            if (e instanceof TransferError && e.retryable)
              throw new WorkerApiError('network', null, e.message)
            throw e
          }
        })
        ids.push(r.derivativeId)
      } catch (e) {
        if (signal.aborted || (e instanceof WorkerApiError && e.kind === 'aborted'))
          return await interrupted()
        if (e instanceof TransferError && e.kind === 'aborted') return await interrupted()
        if (e instanceof WorkerApiError && e.kind === 'lease') {
          log(`${v} derivative reservation refused (${e.message}): the lease was lost; abandoning it`)
          lease.stop()
          return { result: 'abandoned', reason: 'lease lost' }
        }
        return await transient(`derivative upload: ${(e as Error).message}`)
      }
    }
    if (signal.aborted) return await interrupted()
    return await complete(
      {
        status: 'ready',
        mimeType: meta.mimeType,
        probe: meta.probe,
        derivatives: ids,
      },
      { result: 'ready', derivatives: ids.length },
    )
  } catch (e) {
    // Local trouble outside the processors' own handling (disk full, EPERM...).
    if (signal.aborted) return await interrupted()
    return await transient(`worker error ${(e as Error)?.name ?? 'Error'}`)
  } finally {
    lease.stop()
    if (root) {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch((e) => {
        log(`${v} could not remove its temporary directory (${(e as NodeJS.ErrnoException).code ?? 'error'})`)
      })
    }
  }
}
