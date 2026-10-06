// The v1 (tldraw) -> Excalidraw conversion of a checkpoint body, OFF the api's event loop (J4, CONV-1).
//
// The converter (packages/tldraw-import) costs by what is in the records, not by how many there are: about
// 90 microseconds a record, 65 ms per MiB of strokes, and 5 ms per thousand characters of a sticky note's
// label, which no size bound caps (60 notes of 20,000 characters, a 1.2 MiB body, held the loop for 6.6 s).
// checkpoint-routes.ts bounds what it will convert (`previewSettings`) so that the work stays small, and
// this module makes sure that what is converted can never hold the loop at all:
//
//  - each conversion runs in its OWN `worker_thread` (a fresh one per job, so a heap that grew is gone with
//    it), with a heap cap (`resourceLimits`), a wall-clock budget past which the worker is TERMINATED
//    (also when it is spinning in synchronous code), and a limit on the records, on the bytes sent to it
//    and on the bytes it may send back;
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

/** `limit` is a gate for the whole process: pass the same one for every call that should share the slots. */
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
