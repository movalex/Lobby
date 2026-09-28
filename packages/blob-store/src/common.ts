// Argument checks and the byte meter shared by both implementations.

import { BlobStoreError } from './errors.ts'
import type { BlobRange } from './types.ts'

/** Below R2's single-PUT cap (5 GiB); the product limits are <= 500 MB. */
export const MAX_OBJECT_BYTES = 5_000_000_000
/** Presigned URLs live at most 15 minutes (docs/M3-STORAGE-CONTRACTS.md §1, §7). */
export const MAX_PRESIGN_EXPIRES_SEC = 900

const invalid = (message: string) => new BlobStoreError('INVALID_ARGUMENT', `blob store: ${message}`)

// Visible ASCII + space; no CR/LF, so a content type can never smuggle a header.
const CONTENT_TYPE_RE = /^[\x21-\x7e][\x20-\x7e]{0,254}$/

export function checkContentType(contentType: unknown): string {
  if (typeof contentType !== 'string' || !CONTENT_TYPE_RE.test(contentType)) {
    throw invalid('contentType must be 1-255 printable ASCII characters')
  }
  return contentType
}

export function checkContentLength(contentLength: unknown, what = 'contentLength'): number {
  if (
    typeof contentLength !== 'number' ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    contentLength > MAX_OBJECT_BYTES
  ) {
    throw invalid(`${what} must be an integer between 0 and ${MAX_OBJECT_BYTES}`)
  }
  return contentLength
}

export function checkPut(
  body: unknown,
  opts: { contentType: string; contentLength: number } | undefined,
): { contentType: string; contentLength: number; bytes: Uint8Array | null } {
  if (!opts || typeof opts !== 'object') throw invalid('put options are required')
  const contentType = checkContentType(opts.contentType)
  const contentLength = checkContentLength(opts.contentLength)
  if (body instanceof Uint8Array) {
    if (body.byteLength !== contentLength) {
      throw new BlobStoreError('LENGTH_MISMATCH', 'blob store: body length does not match contentLength')
    }
    return { contentType, contentLength, bytes: body }
  }
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
    throw invalid('body must be a readable stream or a Uint8Array')
  }
  return { contentType, contentLength, bytes: null }
}

export function checkRange(range: unknown): BlobRange | undefined {
  if (range === undefined) return undefined
  const r = range as Partial<BlobRange> | null
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.start !== 'number' ||
    typeof r.end !== 'number' ||
    !Number.isSafeInteger(r.start) ||
    !Number.isSafeInteger(r.end) ||
    r.start < 0 ||
    r.end < r.start
  ) {
    throw invalid('range must be integers with 0 <= start <= end')
  }
  return { start: r.start, end: r.end }
}

export function checkExpires(expiresSec: unknown): number {
  if (
    typeof expiresSec !== 'number' ||
    !Number.isInteger(expiresSec) ||
    expiresSec < 1 ||
    expiresSec > MAX_PRESIGN_EXPIRES_SEC
  ) {
    throw invalid(`expiresSec must be an integer between 1 and ${MAX_PRESIGN_EXPIRES_SEC}`)
  }
  return expiresSec
}

export function checkPresignPut(
  opts: { expiresSec: number; contentType: string; contentLength?: number } | undefined,
): { expiresSec: number; contentType: string; contentLength: number | undefined } {
  if (!opts || typeof opts !== 'object') throw invalid('presign options are required')
  return {
    expiresSec: checkExpires(opts.expiresSec),
    contentType: checkContentType(opts.contentType),
    contentLength: opts.contentLength === undefined ? undefined : checkContentLength(opts.contentLength),
  }
}

/** The headers a presignPut() upload must carry (they are part of its signature). */
export function presignedPutHeaders(opts: {
  contentType: string
  contentLength?: number
}): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': checkContentType(opts.contentType) }
  if (opts.contentLength !== undefined)
    headers['Content-Length'] = String(checkContentLength(opts.contentLength))
  return headers
}

export const lengthMismatch = () =>
  new BlobStoreError('LENGTH_MISMATCH', 'blob store: body length does not match contentLength')

/**
 * Re-yields `source` chunk by chunk (pull-based, so backpressure reaches the source) and fails as
 * soon as more than `expected` bytes arrive, or at the end if fewer did. An early exit (error or
 * consumer abort) ends the source's iterator, which destroys a Node stream.
 */
export async function* meteredChunks(
  source: NodeJS.ReadableStream,
  expected: number,
  onChunk?: (bytesSoFar: number) => void,
): AsyncGenerator<Uint8Array> {
  let seen = 0
  for await (const chunk of source as AsyncIterable<unknown>) {
    let bytes: Uint8Array
    if (chunk instanceof Uint8Array) bytes = chunk
    else if (typeof chunk === 'string') bytes = Buffer.from(chunk)
    else throw invalid('body stream must yield bytes')
    seen += bytes.byteLength
    if (seen > expected) throw lengthMismatch()
    onChunk?.(seen)
    if (bytes.byteLength > 0) yield bytes
  }
  if (seen !== expected) throw lengthMismatch()
}
