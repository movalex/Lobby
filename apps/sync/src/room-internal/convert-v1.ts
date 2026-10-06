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
// with a heap cap (`resourceLimits`), a wall-clock budget past which the worker is TERMINATED (also when it is
// spinning in synchronous code), and limits on the records, on the bytes sent to it and on the bytes it may send
// back; the body goes in and the answer comes back as one JSON string each (a structured clone of a big object
// graph would itself hold the loop, and the string's size is the limit's byte count). One conversion runs at a
// time and a few may wait (./gate.ts): a caller past either is told `busy` (503), not queued without end. The
// worker (./convert-v1-worker.ts) calls the same `migrateRecords` and `convertBoard` with the same text metrics
// the in-process conversion used, so what it makes is what the loop used to make.
//
// Nothing here logs: callers answer with codes and counts, never records or text. apps/api has the same
// helper for its checkpoint previews (features/history/convert-v1.ts); the two are kept alike on purpose (the
// apps do not import each other). Limits and their environment overrides are at `v1SeedLimits`.
import { Worker } from 'node:worker_threads'
import { HttpError } from '../http/respond.ts'
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
  /** the worker's old-generation heap cap, MB */
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
    }

const WORKER_URL = new URL('./convert-v1-worker.ts', import.meta.url)
const YOUNG_GEN_MB = 16
const STACK_MB = 4

export async function convertV1InWorker(
  input: ConvertV1Input,
  limits: ConvertV1Limits,
  gate: Gate,
  workerUrl: URL = WORKER_URL,
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
    if (Buffer.byteLength(json) > limits.maxBytes) return { ok: false, reason: 'too-large' }
    return await runWorker({ json, now: input.now, maxResultBytes: limits.maxResultBytes }, limits, workerUrl)
  } finally {
    release()
  }
}

function runWorker(data: WorkerInput, limits: ConvertV1Limits, workerUrl: URL): Promise<ConvertV1Outcome> {
  return new Promise((resolve) => {
    let settled = false
    const worker = new Worker(workerUrl, {
      workerData: data,
      resourceLimits: {
        maxOldGenerationSizeMb: limits.maxHeapMb,
        maxYoungGenerationSizeMb: YOUNG_GEN_MB,
        stackSizeMb: STACK_MB,
      },
      // the worker's own output never reaches the process log (it prints nothing; a stray line could hold content)
      stdout: true,
      stderr: true,
    })
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
      if (!out || typeof out !== 'object') return finish({ ok: false, reason: 'failed' })
      if (!out.ok)
        return finish({ ok: false, reason: out.reason, ...(out.detail ? { detail: out.detail } : {}) })
      try {
        finish({ ok: true, converted: JSON.parse(out.json) as ConvertedV1, conversionMs: out.conversionMs })
      } catch {
        finish({ ok: false, reason: 'failed' })
      }
    })
    worker.once('error', (e: Error & { code?: string }) =>
      finish({ ok: false, reason: e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'failed' }),
    )
    worker.once('exit', () => finish({ ok: false, reason: 'failed' }))
  })
}

// ---- the seed's limits -----------------------------------------------------------------------------------

export interface V1SeedLimits extends ConvertV1Limits {
  /** conversions at once, process-wide */
  readonly concurrent: number
  /** how many may wait for a place, and for how long */
  readonly maxQueue: number
  readonly queueWaitMs: number
}

const MiB = 1024 * 1024

/**
 * What bounds a seeded v1 body. `maxRecords` is what the api's v1 archive import allows (ARCHIVE_LIMITS in
 * packages/board-ops); `maxBytes` the JSON of those records (the api's import body is at most 25 MiB, and the
 * records are most of it); `maxResultBytes` this route's own body limit (SEED_LIMIT_BYTES); the time is under
 * the api's 15 s wait for a seed (sync-internal.ts) with the queue's wait and the worker's start inside it;
 * the heap is the migration queue's runtime cap at most (queue.ts RUNTIME_CAP_MB_MAX: the heaviest board
 * measured, 4,922 records, peaked at 65 MB). One at a time and four waiting, for four seconds at most.
 *
 * Each can be set by an environment variable (a whole number in the range, else ignored): the budget in
 * milliseconds `DRAFTROOM_V1_SEED_TIMEOUT_MS` (500 to 12,000), `DRAFTROOM_V1_SEED_HEAP_MB` (4 to 128),
 * `DRAFTROOM_V1_SEED_MAX_RECORDS` (1 to 20,000), `DRAFTROOM_V1_SEED_MAX_BYTES` (1,000 to 32 MiB),
 * `DRAFTROOM_V1_SEED_MAX_QUEUE` (0 to 16). Read when the first v1 seed arrives.
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
    maxBytes: int('DRAFTROOM_V1_SEED_MAX_BYTES', 32 * MiB, 1_000, 32 * MiB),
    maxResultBytes: 64 * MiB,
    timeoutMs: int('DRAFTROOM_V1_SEED_TIMEOUT_MS', 8_000, 500, 12_000),
    maxHeapMb: int('DRAFTROOM_V1_SEED_HEAP_MB', 128, 4, 128),
    concurrent: 1,
    maxQueue: int('DRAFTROOM_V1_SEED_MAX_QUEUE', 4, 0, 16),
    queueWaitMs: 4_000,
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
  return convertV1InWorker(input, seedGate.limits, seedGate.gate)
}

/** The refusal as the seed route's answer: 413 past a size limit, 422 past the time or heap budget, 503 busy. */
export function seedRefusalError(reason: ConvertV1Refusal, detail?: string): HttpError {
  switch (reason) {
    case 'too-many-records':
    case 'too-large':
    case 'result-too-large':
      return new HttpError(413, 'IMPORT_TOO_LARGE', 'This board is too large to convert.')
    case 'time':
    case 'memory':
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
