// The v1 (tldraw) -> Excalidraw conversion of a SEEDED body, off the sync server's event loop (J4,
// IMPORT-V1-SYNC-BLOCK).
//
// POST /internal/boards/:bid/seed with `{ snapshot }` (a v1 `.lobby.json` import, a restored or duplicated v1
// checkpoint) ran the converter (packages/tldraw-import) on the sync's main event loop, the loop every open
// board's sockets share, with no limit on what it costs. A conversion costs by what is in the records, not by
// how many there are: about 90 microseconds a record, 65 ms per MiB of strokes, and 110 ms for ONE sticky note
// of 20,000 characters (60 of them, a 1.2 MiB body, held the loop for 6.6 s; the archive caps allow thousands).
// The file is the person's own, so the cost is the other side's to choose.
//
// Each conversion now runs in its OWN `worker_thread` (a fresh one per job: a heap that grew is gone with it)
// with a heap cap sized by the body (`workerHeapMb`; `resourceLimits`), a wall-clock budget past which the worker
// is TERMINATED (also when it is spinning in synchronous code), and limits on the records, on the bytes sent to
// it and on the bytes it may send back; the body goes in and the answer comes back as one JSON string each (a
// structured clone of a big object graph would itself hold the loop, and the string's size is the limit's byte
// count). One conversion runs at a time and a few may wait (./gate.ts), and a worker starts only while the
// process has the memory for its heap (`waitForMemory`): a caller past any of them is told `busy` (503), not
// queued without end, and a body past the heap is refused `memory` (413, too large or complex). The
// worker (./convert-v1-worker.ts) calls the same `migrateRecords` and `convertBoard` with the same text metrics
// the in-process conversion used, so what it makes is what the loop used to make.
//
// Nothing here logs: callers answer with codes and counts, never records or text. apps/api has the same
// helper for its checkpoint previews (features/history/convert-v1.ts); the two are kept alike on purpose (the
// apps do not import each other). Limits and their environment overrides are at `v1SeedLimits`.
import { Worker } from 'node:worker_threads'
import { HttpError } from '../http/respond.ts'
import { RUNTIME_RSS_LIMIT_MB } from '../room/migrate/queue.ts'
import { Gate, GateFull } from './gate.ts'

export interface ConvertV1Limits {
  /** more records than this: refused without a worker */
  readonly maxRecords: number
  /** the JSON of the records and their schema, in bytes: more is refused without a worker */
  readonly maxBytes: number
  /** the answer's JSON, in bytes: a worker whose answer would be larger refuses */
  readonly maxResultBytes: number
  /** wall clock from the worker's start (its module loading, about 0.25 s, included) to its answer */
  readonly timeoutMs: number
  /** the CEILING of the worker's old-generation heap, MB: it gets `workerHeapMb(bytes, this)`, by the body's size */
  readonly maxHeapMb: number
}

export interface ConvertV1Input {
  readonly records: readonly unknown[]
  readonly schema: unknown
  readonly now: number
}

/** What the converter makes of the records (JSON-safe). */
export interface ConvertedV1 {
  readonly elements: Record<string, unknown>[]
  readonly doc: {
    startView?: { x: number; y: number; w: number; h: number; frameId?: string }
    workshop?: { hideNoteAuthors: boolean; hideCursors: boolean }
    tagDefs: Record<string, { name: string; color: string }>
  }
  readonly legacyPages: Record<string, { dx: number; dy: number; index: number; name: string }>
  readonly legacyIds: Record<string, string>
  /** converter's lossy codes -> counts */
  readonly lossy: Record<string, number>
}

/** Why a conversion was not made: past a limit (so it is not retried), or not readable, or not possible now. */
export type ConvertV1Refusal =
  | 'too-many-records'
  | 'too-large'
  | 'result-too-large'
  | 'time'
  | 'memory'
  | 'busy'
  | 'unreadable'
  | 'failed'

export type ConvertV1Outcome =
  | {
      readonly ok: true
      readonly converted: ConvertedV1
      /** the conversion itself, in the worker (its start-up excluded) */
      readonly conversionMs: number
    }
  | {
      readonly ok: false
      readonly reason: ConvertV1Refusal
      /** `unreadable`: the migration's reason; `failed`: the converter's failure codes */
      readonly detail?: string
      /** `failed` without a detail: what the worker or its thread reported, a code or an error's NAME (for the log) */
      readonly cause?: string
    }

/** What a worker is started with. */
export interface WorkerInput {
  readonly json: string
  readonly now: number
  readonly maxResultBytes: number
}

/** What a worker answers with (once). */
export type WorkerOutput =
  | { readonly ok: true; readonly json: string; readonly conversionMs: number }
  | {
      readonly ok: false
      readonly reason: 'result-too-large' | 'unreadable' | 'failed'
      readonly detail?: string
      readonly cause?: string
    }

const WORKER_URL = new URL('./convert-v1-worker.ts', import.meta.url)
const YOUNG_GEN_MB = 16
const STACK_MB = 4
const MIB = 1024 * 1024

/**
 * The old-generation heap a worker gets for a body of `bodyBytes` (the JSON of its records and schema), at most
 * `ceilingMb`. What a conversion holds grows with the body, most of all with freehand strokes (every point is an
 * object while it is converted): measured on the real worker, the smallest heap that converted a stroke board
 * was 96 MB at 1.5 MiB, 144 MB at 2.4 MiB and 224 MB at 4.0 MiB (about 32 MB plus 48 MB per MiB), and boards
 * of notes took a third of that (the heaviest sample, 4,922 records, 48 MB at 2.3 MiB). The cap is 48 MB plus
 * 64 MB per MiB (1.3 to 1.5 times what strokes need), never under 64 MB: a small body that runs away is stopped
 * early, and a big one has the room it needs, up to the ceiling.
 */
export function workerHeapMb(bodyBytes: number, ceilingMb: number): number {
  const wanted = Math.ceil(48 + (64 * bodyBytes) / MIB)
  return Math.min(ceilingMb, Math.max(64, wanted))
}

/**
 * `admit` (optional) is asked once the body is measured, a place is held and no worker has started, with the
 * heap the worker would get (MB): `false` answers `busy` (the sync server holds a worker back while the process
 * has no memory to spare).
 */
export async function convertV1InWorker(
  input: ConvertV1Input,
  limits: ConvertV1Limits,
  gate: Gate,
  workerUrl: URL = WORKER_URL,
  admit?: (heapMb: number) => Promise<boolean>,
): Promise<ConvertV1Outcome> {
  if (input.records.length > limits.maxRecords) return { ok: false, reason: 'too-many-records' }
  let release: () => void
  try {
    release = await gate.acquire()
  } catch (e) {
    if (e instanceof GateFull) return { ok: false, reason: 'busy' }
    throw e
  }
  try {
    let json: string
    try {
      json = JSON.stringify({ records: input.records, schema: input.schema })
    } catch {
      return { ok: false, reason: 'unreadable', detail: 'the records are not JSON' }
    }
    const bytes = Buffer.byteLength(json)
    if (bytes > limits.maxBytes) return { ok: false, reason: 'too-large' }
    const heapMb = workerHeapMb(bytes, limits.maxHeapMb)
    if (admit && !(await admit(heapMb))) return { ok: false, reason: 'busy' }
    return await runWorker(
      { json, now: input.now, maxResultBytes: limits.maxResultBytes },
      limits,
      heapMb,
      workerUrl,
    )
  } finally {
    release()
  }
}

function runWorker(
  data: WorkerInput,
  limits: ConvertV1Limits,
  heapMb: number,
  workerUrl: URL,
): Promise<ConvertV1Outcome> {
  return new Promise((resolve) => {
    let settled = false
    let worker: Worker
    try {
      worker = new Worker(workerUrl, {
        workerData: data,
        resourceLimits: {
          maxOldGenerationSizeMb: heapMb,
          maxYoungGenerationSizeMb: YOUNG_GEN_MB,
          stackSizeMb: STACK_MB,
        },
        // the worker's own output never reaches the process log (it prints nothing; a stray line could hold content)
        stdout: true,
        stderr: true,
      })
    } catch (e) {
      // a thread that cannot be started (a bad worker path, no resources): a failed conversion, with its code
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
    const finish = (outcome: ConvertV1Outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'time' }), limits.timeoutMs)
    worker.once('message', (out: WorkerOutput) => {
      if (!out || typeof out !== 'object') return finish({ ok: false, reason: 'failed', cause: 'bad-answer' })
      if (!out.ok)
        return finish({
          ok: false,
          reason: out.reason,
          ...(out.detail ? { detail: out.detail } : {}),
          ...(out.cause ? { cause: out.cause } : {}),
        })
      try {
        finish({ ok: true, converted: JSON.parse(out.json) as ConvertedV1, conversionMs: out.conversionMs })
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

// ---- the seed's limits -----------------------------------------------------------------------------------

export interface V1SeedLimits extends ConvertV1Limits {
  /** conversions at once, process-wide */
  readonly concurrent: number
  /** how many may wait for a place, and for how long */
  readonly maxQueue: number
  readonly queueWaitMs: number
  /** a worker starts only while process RSS plus its heap fits under this (MB), for at most `memoryWaitMs` */
  readonly rssLimitMb: number
  readonly memoryWaitMs: number
}

/**
 * What bounds a seeded v1 body. `maxRecords` is what the api's v1 archive import allows (ARCHIVE_LIMITS in
 * packages/board-ops); `maxBytes` the JSON of those records (the api's import body is at most 25 MiB, and the
 * records are most of it); `maxResultBytes` this route's own body limit (SEED_LIMIT_BYTES).
 *
 * The api waits 15 s for a seed (sync-internal.ts), so the waits and the worker's budget add up to less: a place
 * for at most 3 s (one at a time, four waiting), memory for at most 2 s, then the worker's `timeoutMs` (8 s, 9 s
 * at most; its start-up is inside it, and a slower plan than the 64-core desktop it was measured on is why it is
 * this long: the heaviest sample board, 4,922 records, takes 2.2 s there).
 *
 * The heap is a CEILING, 256 MB (the migration queue's maintenance cap, queue.ts MAINTENANCE_CAP_MB): a worker
 * gets what its body needs (`workerHeapMb`, 48 MB plus 64 MB per MiB, 64 MB at least) up to it. That is about
 * 4 MiB of freehand strokes (a stroke board takes 48 MB per MiB of heap; the heaviest sample board, 2.3 MiB of
 * notes, 48 MB) or 20 MiB of notes, whatever `maxBytes` says: a body that needs more is refused `memory`
 * (413, "too large or complex"), and an operator with the memory raises the ceiling and the RSS limit
 * together. A worker is also held back while the process could not hold its heap (RSS plus the heap over
 * `rssLimitMb`: the migration queue's runtime limit, queue.ts RUNTIME_RSS_LIMIT_MB, 440 MB of the 512 MB
 * plan, so a seed and a runtime migration worker cannot add up to the OOM line, and an OOM would drop every
 * open board's sockets): it waits a little for memory and answers busy (503) when none comes.
 *
 * Each can be set by an environment variable (a whole number in the range, else ignored): the budget in
 * milliseconds `DRAFTROOM_V1_SEED_TIMEOUT_MS` (500 to 9,000), the heap ceiling `DRAFTROOM_V1_SEED_HEAP_MB` (4
 * to 512), `DRAFTROOM_V1_SEED_RSS_LIMIT_MB` (200 to 16,384), `DRAFTROOM_V1_SEED_MAX_RECORDS` (1 to 20,000),
 * `DRAFTROOM_V1_SEED_MAX_BYTES` (1,000 to 32 MiB), `DRAFTROOM_V1_SEED_MAX_QUEUE` (0 to 16). Read when the
 * first v1 seed arrives.
 */
export function v1SeedLimits(env: Record<string, string | undefined> = process.env): V1SeedLimits {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]?.trim()
    if (!raw || !/^\d+$/.test(raw)) return fallback
    const n = Number(raw)
    return n >= min && n <= max ? n : fallback
  }
  return {
    maxRecords: int('DRAFTROOM_V1_SEED_MAX_RECORDS', 20_000, 1, 20_000),
    maxBytes: int('DRAFTROOM_V1_SEED_MAX_BYTES', 32 * MIB, 1_000, 32 * MIB),
    maxResultBytes: 64 * MIB,
    timeoutMs: int('DRAFTROOM_V1_SEED_TIMEOUT_MS', 8_000, 500, 9_000),
    maxHeapMb: int('DRAFTROOM_V1_SEED_HEAP_MB', 256, 4, 512),
    concurrent: 1,
    maxQueue: int('DRAFTROOM_V1_SEED_MAX_QUEUE', 4, 0, 16),
    queueWaitMs: 3_000,
    rssLimitMb: int('DRAFTROOM_V1_SEED_RSS_LIMIT_MB', RUNTIME_RSS_LIMIT_MB, 200, 16_384),
    memoryWaitMs: 2_000,
  }
}

export interface MemoryGate {
  readonly rssLimitMb: number
  readonly waitMs: number
  /** how often to look again (default 250 ms) */
  readonly pollMs?: number
  /** process RSS in bytes (default process.memoryUsage.rss) */
  readonly rss?: () => number
}

/**
 * Whether a worker with `heapMb` of heap may start: once process RSS plus that heap fits under the limit (the
 * migration queue's runtime gate, queue.ts waitForMemory). Looks again until `waitMs` is over; false then.
 */
export async function waitForMemory(heapMb: number, gate: MemoryGate): Promise<boolean> {
  const limit = gate.rssLimitMb * MIB
  const heap = heapMb * MIB
  const rss = gate.rss ?? (() => process.memoryUsage.rss())
  const deadline = performance.now() + gate.waitMs
  for (;;) {
    if (rss() + heap <= limit) return true
    const left = deadline - performance.now()
    if (left <= 0) return false
    await new Promise((r) => setTimeout(r, Math.min(gate.pollMs ?? 250, Math.max(1, left))))
  }
}

let seedGate: { gate: Gate; limits: V1SeedLimits } | null = null

/** The seed's conversion: the process-wide gate and the limits, made when the first v1 seed arrives. */
export function convertForSeed(input: ConvertV1Input): Promise<ConvertV1Outcome> {
  if (!seedGate) {
    const limits = v1SeedLimits()
    seedGate = {
      limits,
      gate: new Gate({
        concurrent: limits.concurrent,
        maxQueue: limits.maxQueue,
        maxWaitMs: limits.queueWaitMs,
      }),
    }
  }
  const { limits, gate } = seedGate
  return convertV1InWorker(input, limits, gate, undefined, (heapMb) =>
    waitForMemory(heapMb, { rssLimitMb: limits.rssLimitMb, waitMs: limits.memoryWaitMs }),
  )
}

/**
 * The refusal as the seed route's answer: 413 past a size limit or the heap (the body is too large or too
 * complex for this server to convert), 422 past the time budget, 503 busy (no place, or no memory for a worker
 * just now: try again).
 */
export function seedRefusalError(reason: ConvertV1Refusal, detail?: string): HttpError {
  switch (reason) {
    case 'too-many-records':
    case 'too-large':
    case 'result-too-large':
    case 'memory':
      return new HttpError(413, 'IMPORT_TOO_LARGE', 'This board is too large or complex to convert.')
    case 'time':
      return new HttpError(422, 'IMPORT_TOO_COMPLEX', 'This board takes too long to convert.')
    case 'busy':
      return new HttpError(503, 'BUSY', 'Conversions are busy. Try again in a moment.')
    case 'unreadable':
      return new HttpError(
        400,
        'bad-request',
        `The tldraw records cannot be read (${detail ?? 'unreadable'}).`,
      )
    case 'failed':
      return detail
        ? new HttpError(400, 'bad-request', `The board cannot be converted (${detail}).`)
        : new HttpError(500, 'CONVERT_FAILED', 'The board could not be converted.')
  }
}
