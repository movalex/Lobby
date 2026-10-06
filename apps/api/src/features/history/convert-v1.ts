// The v1 (tldraw) -> Excalidraw conversion of a checkpoint body, OFF the api's event loop (J4, CONV-1).
//
// The converter (packages/tldraw-import) costs by what is in the records, not by how many there are: about
// 90 microseconds a record, 65 ms per MiB of strokes, and 5 ms per thousand characters of a sticky note's
// label, which no size bound caps (60 notes of 20,000 characters, a 1.2 MiB body, held the loop for 6.6 s).
// checkpoint-routes.ts bounds what it will convert (`previewSettings`) so that the work stays small, and
// this module makes sure that what is converted can never hold the loop at all:
//
//  - each conversion runs in its OWN `worker_thread` (a fresh one per job, so a heap that grew is gone with
//    it), with a heap cap sized by the body (`workerHeapMb`: the heap a conversion needs grows with the body,
//    most of all with freehand strokes, which the preview bounds in checkpoint-routes.ts bound by bytes, so
//    a body inside them always fits), a wall-clock budget past which the worker is TERMINATED (also when it
//    is spinning in synchronous code), and a limit on the records, on the bytes sent to it and on the bytes
//    it may send back;
//  - the body goes to the worker as one JSON string and the answer comes back as one (a structured clone of
//    a big object graph would itself hold the loop, and the string's size is the limit's byte count);
//  - at most `concurrent` conversions run at once and a bounded number wait (../link-preview/gate.ts): a
//    caller past either is told `busy` instead of queueing without end.
//
// The worker (./convert-v1-worker.ts) installs the same text metrics the in-process conversion used and calls
// the same `migrateRecords` and `convertBoard`, so its answer is the one the event loop used to compute.
// Nothing here logs: the caller logs counts and codes, never records or text.
//
// apps/sync/src/room-internal/convert-v1.ts is the same helper for the sync's seed (a v1 archive import);
// the two are kept alike on purpose (the apps do not import each other).
import { Worker } from 'node:worker_threads'
import { type Gate, GateFull } from '../link-preview/gate.ts'

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
