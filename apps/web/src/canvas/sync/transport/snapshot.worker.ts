/**
 * N1-1 (wave N, PERF-3a): the snapshot decode in a module Worker. A reset welcome's binary frame (gzip of the
 * snapshot's JSON) is gunzipped, parsed and validated here, with the very function the page used before
 * (canvas-schema protocol.ts `decodeSnapshotFrame`), so the page's main thread never runs the whole zod parse of a
 * large board (about 3.9 s at CPU 4x for 5k elements). Loaded by ./snapshot-decoder.ts with
 * `new Worker(new URL('./snapshot.worker.ts', import.meta.url), {type: 'module'})`, as pdf-client.ts does (the CSP's
 * worker-src 'self' covers it).
 *
 * Its first import sets zod jitless (./worker-jitless.ts); then it imports only @draftroom/canvas-schema (zod and
 * the contracts, no @excalidraw: snapshot-worker.test.ts walks the import graph).
 *
 * The protocol (./snapshot-decoder.ts):
 *  - at start: `{type: 'ready'}`;
 *  - in: `{id, bytes}` (an ArrayBuffer, transferred);
 *  - out: `{id, type: 'head', frame, total}` (the frame without its elements), then `{id, type: 'part', elements}`
 *    slices of at most DECODE_SLICE elements (each a small structured clone on the page's side, so no long task),
 *    then `{id, type: 'done'}`; or `{id, type: 'error', message}` (the decode's refusal, as `String(err)`).
 */
import './worker-jitless.ts'
import { decodeSnapshotFrame } from '@draftroom/canvas-schema/protocol'
import { DECODE_SLICE, type DecodeRequest, type DecodeResponse } from './snapshot-protocol.ts'

const scope = globalThis as unknown as {
  postMessage(message: DecodeResponse): void
  addEventListener(type: 'message', listener: (e: { data: DecodeRequest }) => void): void
}

let queue: Promise<void> = Promise.resolve()

async function decode(req: DecodeRequest): Promise<void> {
  try {
    const frame = await decodeSnapshotFrame(new Uint8Array(req.bytes))
    const { elements, ...head } = frame
    scope.postMessage({ id: req.id, type: 'head', frame: { ...head, elements: [] }, total: elements.length })
    for (let i = 0; i < elements.length; i += DECODE_SLICE)
      scope.postMessage({ id: req.id, type: 'part', elements: elements.slice(i, i + DECODE_SLICE) })
    scope.postMessage({ id: req.id, type: 'done' })
  } catch (err) {
    scope.postMessage({ id: req.id, type: 'error', message: String(err) })
  }
}

// one frame at a time, in arrival order
scope.addEventListener('message', (e) => {
  queue = queue.then(() => decode(e.data))
})
scope.postMessage({ type: 'ready' })
