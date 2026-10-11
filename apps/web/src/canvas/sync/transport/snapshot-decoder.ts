/**
 * N1-1 (wave N, PERF-3a): the page's snapshot decoder, one per board session. The socket's in-order frame chain
 * (./socket.ts) awaits `decode(bytes)` for each binary frame, so arrival order is kept exactly as before; only
 * where the work runs changes:
 *
 *  - a module Worker (./snapshot.worker.ts), created lazily (at the first reset welcome, `warm()`, or the first
 *    large binary frame) and terminated with the session (`dispose`): gunzip, JSON.parse and the whole zod parse
 *    leave the main thread; the decoded elements come back in slices (each a short structured clone). A frame under
 *    WORKER_MIN_BYTES decodes on the main thread all the same (cheaper than the worker's round trip);
 *  - the main thread, the very same `decodeSnapshotFrame`, when the Worker constructor throws (no Worker, a policy),
 *    when the worker fails to start (its `error` before its `ready`), or with WORKER_DECODE off.
 *
 * The bytes are transferred to the worker (no copy), and only once it said `ready`, so a worker that never starts
 * leaves them to the main-thread fallback. A frame the worker refuses rejects with the refusal's own text, so the
 * socket takes today's INVALID path exactly (`snapshot_frame_invalid`, dropped). A worker that dies with a frame
 * in it rejects that frame with `SnapshotDecodeLost` (the socket reconnects: the next welcome brings the snapshot
 * again) and every later frame decodes on the main thread.
 *
 * `onDecoded(where)` reports each decode's side (the board session counts `open.decode:<where>`).
 */
import { decodeSnapshotFrame, type SnapshotFrame } from '@draftroom/canvas-schema/protocol'
import {
  type DecodeRequest,
  type DecodeResponse,
  type SnapshotDecode,
  SnapshotDecodeLost,
} from './snapshot-protocol.ts'

export { SnapshotDecodeLost }

/** The part of a Worker the decoder uses (the browser's, or a test's fake). */
export interface WorkerLike {
  postMessage(message: DecodeRequest, transfer: ArrayBuffer[]): void
  /** `message` events carry `{data: DecodeResponse}` */
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (e: unknown) => void): void
  terminate(): void
}

export type DecodeSide = 'worker' | 'main'

export interface SnapshotDecoder extends SnapshotDecode {
  dispose(): void
  /** where the next frame decodes (null: not decided yet, the worker is starting) */
  readonly side: DecodeSide | null
}

/** The worker's refusal of a frame: its String() is the main thread's `String(err)` of the same refusal. */
class WorkerRefusal extends Error {
  readonly text: string
  constructor(text: string) {
    super(text)
    this.text = text
  }
  override toString(): string {
    return this.text
  }
}

/**
 * Frames smaller than this (gzip bytes) decode on the main thread, worker or not: a small board's decode takes a few
 * ms there, less than the round trip to a worker (about 500 elements: ~16 KiB of gzip, measured on the 10k fixture's
 * first elements), so small boards open exactly as before.
 */
export const WORKER_MIN_BYTES = 16 * 1024

/** How long a worker may take to say `ready` before frames decode on the main thread. */
export const WORKER_START_TIMEOUT_MS = 10_000

export interface SnapshotDecoderOptions {
  /** WORKER_DECODE: false decodes every frame on the main thread */
  readonly worker: boolean
  /** the worker's constructor (default: the module worker; tests pass a fake) */
  readonly createWorker?: () => WorkerLike
  readonly onDecoded?: (side: DecodeSide) => void
  readonly log?: (event: string, detail: Readonly<Record<string, unknown>>) => void
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
  /** the main-thread decode (default canvas-schema's `decodeSnapshotFrame`) */
  readonly decodeMain?: (bytes: Uint8Array) => Promise<SnapshotFrame>
  /** frames below this many bytes decode on the main thread (default WORKER_MIN_BYTES) */
  readonly minBytes?: number
}

const moduleWorker = (): WorkerLike =>
  new Worker(new URL('./snapshot.worker.ts', import.meta.url), {
    type: 'module',
    name: 'lobby-snapshot',
  }) as unknown as WorkerLike

interface Pending {
  resolve(frame: SnapshotFrame): void
  reject(err: unknown): void
  frame: SnapshotFrame | null
  elements: SnapshotFrame['elements']
}

export function createSnapshotDecoder(o: SnapshotDecoderOptions): SnapshotDecoder {
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const decodeMain = o.decodeMain ?? decodeSnapshotFrame
  let worker: WorkerLike | null = null
  /** 'starting' until the worker says ready; 'broken' once it failed (the main thread from then on) */
  let state: 'off' | 'starting' | 'ready' | 'broken' = o.worker ? 'off' : 'broken'
  let started: Promise<boolean> | null = null
  let settleStart: ((ok: boolean) => void) | null = null
  let startTimer: unknown = null
  let nextId = 1
  const pending = new Map<number, Pending>()
  let disposed = false

  const fail = (why: string) => {
    if (state === 'broken') return
    o.log?.('snapshot_worker_failed', { why, pending: pending.size })
    state = 'broken'
    if (startTimer !== null) clearTimer(startTimer)
    startTimer = null
    settleStart?.(false)
    settleStart = null
    for (const p of pending.values()) p.reject(new SnapshotDecodeLost())
    pending.clear()
    try {
      worker?.terminate()
    } catch {
      // gone either way
    }
    worker = null
  }

  const onMessage = (msg: DecodeResponse) => {
    if (msg.type === 'ready') {
      if (state !== 'starting') return
      state = 'ready'
      if (startTimer !== null) clearTimer(startTimer)
      startTimer = null
      settleStart?.(true)
      settleStart = null
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    if (msg.type === 'head') p.frame = msg.frame
    else if (msg.type === 'part') for (const el of msg.elements) p.elements.push(el)
    else if (msg.type === 'done') {
      pending.delete(msg.id)
      if (!p.frame) p.reject(new WorkerRefusal('Error: the snapshot worker sent no frame'))
      else p.resolve({ ...p.frame, elements: p.elements })
    } else {
      pending.delete(msg.id)
      p.reject(new WorkerRefusal(msg.message))
    }
  }

  /** Starts the worker (once); resolves whether it said ready. */
  const start = (): Promise<boolean> => {
    if (started) return started
    if (state === 'broken' || disposed) return Promise.resolve(false)
    started = new Promise<boolean>((resolve) => {
      settleStart = resolve
    })
    state = 'starting'
    try {
      const w = (o.createWorker ?? moduleWorker)()
      worker = w
      w.addEventListener('message', (e) => onMessage((e as { data: DecodeResponse }).data))
      w.addEventListener('error', () => fail('error'))
      w.addEventListener('messageerror', () => fail('messageerror'))
      startTimer = setTimer(() => {
        startTimer = null
        if (state === 'starting') fail('start timeout')
      }, WORKER_START_TIMEOUT_MS)
    } catch (err) {
      o.log?.('snapshot_worker_unavailable', { error: String(err).slice(0, 200) })
      fail('constructor')
    }
    return started
  }

  const viaMain = async (bytes: Uint8Array): Promise<SnapshotFrame> => {
    const frame = await decodeMain(bytes)
    o.onDecoded?.('main')
    return frame
  }

  return {
    get side() {
      return state === 'broken' ? 'main' : state === 'ready' ? 'worker' : null
    },
    warm() {
      if (o.worker) void start()
    },
    async decode(bytes) {
      if (bytes.byteLength < (o.minBytes ?? WORKER_MIN_BYTES)) return viaMain(bytes)
      if (disposed || state === 'broken' || !(await start()) || !worker) return viaMain(bytes)
      const id = nextId++
      // the frame's own buffer, transferred (no copy); a view into a larger buffer is sliced out first
      const buffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : (bytes.slice().buffer as ArrayBuffer)
      const w = worker
      const out = new Promise<SnapshotFrame>((resolve, reject) => {
        pending.set(id, { resolve, reject, frame: null, elements: [] })
      })
      try {
        w.postMessage({ id, bytes: buffer }, [buffer])
      } catch (err) {
        // not sent (nothing was transferred): this frame and every later one on the main thread
        pending.delete(id)
        o.log?.('snapshot_worker_post_failed', { error: String(err).slice(0, 200) })
        fail('post')
        return viaMain(bytes)
      }
      const frame = await out
      o.onDecoded?.('worker')
      return frame
    },
    dispose() {
      disposed = true
      if (startTimer !== null) clearTimer(startTimer)
      startTimer = null
      settleStart?.(false)
      settleStart = null
      for (const p of pending.values()) p.reject(new SnapshotDecodeLost())
      pending.clear()
      try {
        worker?.terminate()
      } catch {
        // gone either way
      }
      worker = null
      if (state !== 'broken') state = 'broken'
    },
  }
}
