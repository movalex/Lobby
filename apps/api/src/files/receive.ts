import { createHash } from 'node:crypto'
import { pipeline, type Readable, Transform } from 'node:stream'
import type { BlobStore } from './blobs.ts'

const REASONS = {
  TOO_LARGE: 'body exceeds the allowed size',
  INCOMPLETE: 'body ended before Content-Length bytes',
  ABORTED: 'the client went away before the body was complete',
} as const

export class ReceiveError extends Error {
  readonly reason: keyof typeof REASONS
  constructor(reason: keyof typeof REASONS, options?: { cause?: unknown }) {
    super(REASONS[reason], options)
    this.reason = reason
  }
}

export interface ReceiveLimits {
  /** The request's Content-Length: the body must be exactly this long. */
  declaredBytes: number
  /** Hard cap for the upload's kind. */
  maxBytes: number
}

/**
 * A pass-through that hashes and counts, and fails with TOO_LARGE as soon as more than `cap` bytes
 * arrive (the chunk that crosses the cap is never passed on).
 */
export function meter(cap: number) {
  const hash = createHash('sha256')
  const state = { bytes: 0, tooLarge: false }
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      state.bytes += chunk.length
      if (state.bytes > cap) {
        state.tooLarge = true
        return done(new ReceiveError('TOO_LARGE'))
      }
      hash.update(chunk)
      done(null, chunk)
    },
  })
  return {
    stream,
    bytes: () => state.bytes,
    tooLarge: () => state.tooLarge,
    digest: () => hash.digest('hex'),
  }
}

// How a body stream fails when its client goes away (the store then rejects with that same error).
const BODY_FAILURES = new Set(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR', 'ECONNABORTED'])
const codeOf = (e: unknown) => (e as { code?: unknown } | null)?.code

/**
 * Streams `source` into the blob store under `key` while hashing it, and aborts as soon as more than
 * min(declared, max) bytes arrive. Nothing is buffered beyond the streams' own high-water marks: the
 * store pulls at its own pace (a disk, or an R2 PUT with an exact Content-Length). Node's HTTP parser
 * already stops a body at Content-Length; this cap is the second, independent line so a parser or proxy
 * change can never let an upload grow past its limit in storage.
 *
 * Rejects with ReceiveError (TOO_LARGE / INCOMPLETE / ABORTED: the client went away) or the store's
 * own error (a storage failure). On any rejection the caller owns deleting `key`.
 */
export async function receiveToBlob(
  source: Readable,
  blobs: BlobStore,
  key: string,
  limits: ReceiveLimits & { contentType: string },
): Promise<{ bytes: number; sha256: string }> {
  const m = meter(Math.min(limits.declaredBytes, limits.maxBytes))
  const piped = new Promise<void>((resolve, reject) => {
    pipeline(source, m.stream, (err) => (err ? reject(err) : resolve()))
  })
  const stored = blobs.put(key, m.stream, {
    contentType: limits.contentType,
    contentLength: limits.declaredBytes,
  })
  // A store that fails (or returns) before reading everything must not leave the pipeline waiting for
  // a reader forever: tear the meter down, which also stops reading the request.
  stored.then(
    () => {
      if (!m.stream.readableEnded) m.stream.destroy(new Error('the blob store stopped reading the upload'))
    },
    (err: unknown) => m.stream.destroy(err instanceof Error ? err : new Error('the blob store failed')),
  )
  const [pipe, put] = await Promise.allSettled([piped, stored])
  if (m.tooLarge()) throw new ReceiveError('TOO_LARGE')
  if (pipe.status === 'fulfilled') {
    // The body ended on its own: short of Content-Length is the client's fault, whatever the store says.
    if (m.bytes() !== limits.declaredBytes) throw new ReceiveError('INCOMPLETE')
    if (put.status === 'rejected') throw put.reason
    return { bytes: m.bytes(), sha256: m.digest() }
  }
  // The pipeline broke. A store that rejects with anything but the body's own failure broke it itself
  // (a storage problem, a 500); otherwise the body failed (the client went away).
  if (
    put.status === 'rejected' &&
    put.reason !== pipe.reason &&
    !BODY_FAILURES.has(String(codeOf(put.reason)))
  )
    throw put.reason
  throw new ReceiveError('ABORTED', { cause: pipe.reason })
}
