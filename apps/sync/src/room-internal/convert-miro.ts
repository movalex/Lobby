// The `miro-v2` seed's conversion (wave R, WS1; docs/WAVE-R-CONTRACTS.md §3): what the api read from Miro becomes
// elements in a worker thread, never on this server's event loop, exactly as the v1 (tldraw) seed converts
// (./convert-v1.ts): a fresh `worker_thread` per conversion with a heap cap sized by the body (`workerHeapMb`), a
// wall-clock budget past which it is terminated, a byte limit on what it may send back, one conversion at a time and
// a short bounded queue (./gate.ts), and a worker that starts only while the process has the memory for its heap.
// The worker (./convert-miro-worker.ts) installs the server text metrics and runs packages/miro-import's
// `convertMiroBoard`; every element it makes then goes through the seed's own validation (seed.ts
// prepareSeedContent: checkElement, checkInvariants, the caps), so Miro content reaches a board only through it.
//
// Nothing here logs: callers answer with codes and counts, never content. Limits and their environment overrides
// are at `miroSeedLimits`.
import { Worker } from 'node:worker_threads'
import type { ImportBoardReport } from '@draftroom/contracts'
import { HttpError } from '../http/respond.ts'
import { RUNTIME_RSS_LIMIT_MB } from '../room/migrate/queue.ts'
import { waitForMemory, workerHeapMb } from './convert-v1.ts'
import { Gate, GateFull } from './gate.ts'

/** What the worker answers with: the elements, the board document's values and the report (JSON-safe). */
export interface ConvertedMiroSeed {
  readonly elements: Record<string, unknown>[]
  readonly doc: Record<string, unknown>
  readonly report: ImportBoardReport
}

export type MiroConvertRefusal = 'too-large' | 'result-too-large' | 'time' | 'memory' | 'busy' | 'failed'

export type MiroConvertOutcome =
  | { readonly ok: true; readonly converted: ConvertedMiroSeed; readonly conversionMs: number }
  | { readonly ok: false; readonly reason: MiroConvertRefusal; readonly cause?: string }

/** What a worker is started with. */
export interface MiroWorkerInput {
  readonly json: string
  readonly now: number
  readonly maxResultBytes: number
}

export type MiroWorkerOutput =
  | { readonly ok: true; readonly json: string; readonly conversionMs: number }
  | { readonly ok: false; readonly reason: 'result-too-large' | 'failed'; readonly cause?: string }

export interface MiroSeedLimits {
  /** the body's JSON, in bytes (the seed route's own limit bounds it before parsing) */
  readonly maxBytes: number
  readonly maxResultBytes: number
  /** wall clock from the worker's start to its answer */
  readonly timeoutMs: number
  /** the ceiling of the worker's old-generation heap, MB (it gets `workerHeapMb(bytes, this)`) */
  readonly maxHeapMb: number
  readonly concurrent: number
  readonly maxQueue: number
  readonly queueWaitMs: number
  readonly rssLimitMb: number
  readonly memoryWaitMs: number
}

const MIB = 1024 * 1024
const WORKER_URL = new URL('./convert-miro-worker.ts', import.meta.url)

/**
 * What bounds a Miro seed. A board of MIRO_IMPORT_LIMITS (10,000 items, 5,000 connectors) is about 10-20 MiB of JSON
 * and converts in a few seconds on the desktop it was measured on; the api waits up to a minute for the answer, so
 * the queue wait, the memory wait and the worker's budget add up to less. Overrides (a whole number in the range,
 * else ignored): `DRAFTROOM_MIRO_SEED_TIMEOUT_MS` (1,000 to 45,000), `DRAFTROOM_MIRO_SEED_HEAP_MB` (64 to 1,024),
 * `DRAFTROOM_MIRO_SEED_RSS_LIMIT_MB` (200 to 16,384). Read when the first Miro seed arrives.
 */
export function miroSeedLimits(env: Record<string, string | undefined> = process.env): MiroSeedLimits {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]?.trim()
    if (!raw || !/^\d+$/.test(raw)) return fallback
    const n = Number(raw)
    return n >= min && n <= max ? n : fallback
  }
  return {
    maxBytes: 64 * MIB,
    maxResultBytes: 64 * MIB,
    timeoutMs: int('DRAFTROOM_MIRO_SEED_TIMEOUT_MS', 30_000, 1_000, 45_000),
    maxHeapMb: int('DRAFTROOM_MIRO_SEED_HEAP_MB', 384, 64, 1_024),
    concurrent: 1,
    maxQueue: 4,
    queueWaitMs: 10_000,
    rssLimitMb: int('DRAFTROOM_MIRO_SEED_RSS_LIMIT_MB', RUNTIME_RSS_LIMIT_MB, 200, 16_384),
    memoryWaitMs: 5_000,
  }
}

/** Converts a `miro-v2` body (already parsed) in a worker; see the module comment. */
export async function convertMiroInWorker(
  body: unknown,
  now: number,
  limits: MiroSeedLimits,
  gate: Gate,
  workerUrl: URL = WORKER_URL,
  admit?: (heapMb: number) => Promise<boolean>,
): Promise<MiroConvertOutcome> {
  let release: () => void
  try {
    release = await gate.acquire()
  } catch (e) {
    if (e instanceof GateFull) return { ok: false, reason: 'busy' }
    throw e
  }
  try {
    const json = JSON.stringify(body)
    const bytes = Buffer.byteLength(json)
    if (bytes > limits.maxBytes) return { ok: false, reason: 'too-large' }
    // the v1 rule (48 MB plus 64 MB per MiB of body), with a floor the engine's layout needs
    const heapMb = Math.max(96, workerHeapMb(bytes, limits.maxHeapMb))
    if (admit && !(await admit(heapMb))) return { ok: false, reason: 'busy' }
    return await runWorker({ json, now, maxResultBytes: limits.maxResultBytes }, limits, heapMb, workerUrl)
  } finally {
    release()
  }
}

function runWorker(
  data: MiroWorkerInput,
  limits: MiroSeedLimits,
  heapMb: number,
  workerUrl: URL,
): Promise<MiroConvertOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let worker: Worker
    try {
      worker = new Worker(workerUrl, {
        workerData: data,
        resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        // the worker prints nothing; a stray line could hold board content, so its output never reaches the log
        stdout: true,
        stderr: true,
      })
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code
      return resolve({
        ok: false,
        reason: 'failed',
        cause: String(code ?? (e as Error)?.name ?? 'Error').slice(0, 64),
      })
    }
    worker.stdout.resume()
    worker.stderr.resume()
    worker.unref()
    const finish = (outcome: MiroConvertOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'time' }), limits.timeoutMs)
    worker.once('message', (out: MiroWorkerOutput) => {
      if (!out || typeof out !== 'object') return finish({ ok: false, reason: 'failed', cause: 'bad-answer' })
      if (!out.ok)
        return finish({ ok: false, reason: out.reason, ...(out.cause ? { cause: out.cause } : {}) })
      try {
        finish({
          ok: true,
          converted: JSON.parse(out.json) as ConvertedMiroSeed,
          conversionMs: out.conversionMs,
        })
      } catch {
        finish({ ok: false, reason: 'failed', cause: 'bad-answer' })
      }
    })
    // only codes and error NAMES are kept of a failure: a message could hold board content
    worker.once('error', (e: Error & { code?: string }) =>
      e?.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? finish({ ok: false, reason: 'memory' })
        : finish({ ok: false, reason: 'failed', cause: String(e?.code ?? e?.name ?? 'Error').slice(0, 64) }),
    )
    worker.once('exit', (code) => finish({ ok: false, reason: 'failed', cause: `exit ${code}` }))
  })
}

let miroGate: { gate: Gate; limits: MiroSeedLimits } | null = null

/** The seed's Miro conversion: the process-wide gate and limits, made when the first Miro seed arrives. */
export function convertMiroForSeed(body: unknown, now: number): Promise<MiroConvertOutcome> {
  if (!miroGate) {
    const limits = miroSeedLimits()
    miroGate = {
      limits,
      gate: new Gate({
        concurrent: limits.concurrent,
        maxQueue: limits.maxQueue,
        maxWaitMs: limits.queueWaitMs,
      }),
    }
  }
  const { limits, gate } = miroGate
  return convertMiroInWorker(body, now, limits, gate, undefined, (heapMb) =>
    waitForMemory(heapMb, { rssLimitMb: limits.rssLimitMb, waitMs: limits.memoryWaitMs }),
  )
}

/** The refusal as the seed route's answer (as the v1 seed's: 413 too large, 422 too slow, 503 busy, 500). */
export function miroRefusalError(reason: MiroConvertRefusal): HttpError {
  switch (reason) {
    case 'too-large':
    case 'result-too-large':
    case 'memory':
      return new HttpError(413, 'IMPORT_TOO_LARGE', 'This board is too large or complex to convert.')
    case 'time':
      return new HttpError(422, 'IMPORT_TOO_COMPLEX', 'This board takes too long to convert.')
    case 'busy':
      return new HttpError(503, 'BUSY', 'Conversions are busy. Try again in a moment.')
    case 'failed':
      return new HttpError(500, 'CONVERT_FAILED', 'The board could not be converted.')
  }
}
