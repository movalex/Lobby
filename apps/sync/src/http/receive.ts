import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export class ReceiveError extends Error {
  readonly reason: 'TOO_LARGE' | 'INCOMPLETE'
  constructor(reason: 'TOO_LARGE' | 'INCOMPLETE') {
    super(reason === 'TOO_LARGE' ? 'body exceeds the allowed size' : 'body ended before Content-Length bytes')
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
 * Streams `source` into a NEW file at `dest` (fails if it exists) while hashing it, and aborts as
 * soon as more than min(declared, max) bytes arrive. Node's HTTP parser already stops a body at
 * Content-Length; this cap is the second, independent line so a parser or proxy change can never
 * let an upload grow past its limit on disk. On any rejection the caller owns deleting `dest`.
 */
export async function receiveToFile(
  source: Readable,
  dest: string,
  limits: ReceiveLimits,
): Promise<{ bytes: number; sha256: string }> {
  const cap = Math.min(limits.declaredBytes, limits.maxBytes)
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length
      if (bytes > cap) return done(new ReceiveError('TOO_LARGE'))
      hash.update(chunk)
      done(null, chunk)
    },
  })
  // flush: fsync before close, so a crash cannot leave a renamed-but-truncated original.
  await pipeline(source, meter, createWriteStream(dest, { flags: 'wx', flush: true }))
  if (bytes !== limits.declaredBytes) throw new ReceiveError('INCOMPLETE')
  return { bytes, sha256: hash.digest('hex') }
}
