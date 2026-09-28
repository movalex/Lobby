// Byte transfers between the worker and object storage (or the API's fs-mode blob routes).
// Downloads stream to disk (never buffered whole), are cut off the moment they exceed the size the API
// recorded, and are aborted when they stall or run past a deadline. Uploads are small (a derivative is a
// few MB at most) and sent from memory with an exact Content-Length.
import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { type BlobRef, errorName, type WorkerApi } from './api-client.ts'

/**
 * missing   the object is gone (404/410): a verdict on this version, not a transient problem.
 * transient network trouble, a stall, a size mismatch, 403 (expired/clock-skewed signature), 5xx.
 * aborted   our own signal (shutdown or lost lease).
 */
export class TransferError extends Error {
  readonly kind: 'missing' | 'transient' | 'aborted'
  readonly retryable: boolean
  constructor(kind: TransferError['kind'], detail: string, retryable = false) {
    super(detail)
    this.name = 'TransferError'
    this.kind = kind
    this.retryable = retryable
  }
}

export interface DownloadOptions {
  /** Exact size the API recorded for the original. More bytes abort the transfer; fewer fail it. */
  bytes: number
  timeoutMs: number
  stallMs: number
  signal: AbortSignal
}

/** Streams the original to `dest` (created exclusively). On failure `dest` may hold a partial file. */
export async function downloadOriginal(
  api: WorkerApi,
  ref: BlobRef,
  dest: string,
  o: DownloadOptions,
): Promise<void> {
  const { url, headers } = api.blobRequest(ref)
  const limit = new AbortController()
  let limitReason = ''
  const cut = (why: string) => {
    if (limit.signal.aborted) return
    limitReason = why
    limit.abort()
  }
  const deadline = setTimeout(() => cut(`download exceeded ${o.timeoutMs} ms`), o.timeoutMs)
  let stall = setTimeout(() => cut(`download stalled for ${o.stallMs} ms`), o.stallMs)
  const bump = () => {
    clearTimeout(stall)
    stall = setTimeout(() => cut(`download stalled for ${o.stallMs} ms`), o.stallMs)
  }
  const signal = AbortSignal.any([o.signal, limit.signal])
  const fail = (e: unknown, stage: string): never => {
    if (e instanceof TransferError) throw e
    if (o.signal.aborted) throw new TransferError('aborted', 'aborted')
    if (limit.signal.aborted) throw new TransferError('transient', limitReason)
    throw new TransferError('transient', `${stage} ${errorName(e)}`)
  }
  try {
    let res: Response
    try {
      res = await fetch(url, { headers, redirect: 'error', signal })
    } catch (e) {
      return fail(e, 'original GET')
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      if (res.status === 404 || res.status === 410)
        throw new TransferError('missing', `original GET ${res.status}`)
      throw new TransferError('transient', `original GET ${res.status}`)
    }
    const declared = res.headers.get('content-length')
    if (declared !== null && Number(declared) !== o.bytes) {
      await res.body?.cancel().catch(() => {})
      throw new TransferError('transient', `original is ${declared} bytes, expected ${o.bytes}`)
    }
    let received = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length
        if (received > o.bytes) {
          cb(new TransferError('transient', `original is larger than the expected ${o.bytes} bytes`))
          return
        }
        bump()
        cb(null, chunk)
      },
    })
    const source = res.body
      ? Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>)
      : Readable.from([])
    try {
      await pipeline(source, counter, createWriteStream(dest, { flags: 'wx' }), { signal })
    } catch (e) {
      return fail(e, 'original body')
    }
    if (received !== o.bytes) {
      throw new TransferError('transient', `original ended after ${received} of ${o.bytes} bytes`)
    }
  } finally {
    clearTimeout(deadline)
    clearTimeout(stall)
  }
}

export interface UploadOptions {
  timeoutMs: number
  signal: AbortSignal
}

/** One PUT of a derivative to the URL the API reserved for it. */
export async function uploadBlob(
  api: WorkerApi,
  ref: BlobRef,
  body: Buffer,
  o: UploadOptions,
): Promise<void> {
  const { url, headers } = api.blobRequest(ref)
  const timeout = AbortSignal.timeout(o.timeoutMs)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      redirect: 'error',
      signal: AbortSignal.any([o.signal, timeout]),
    })
  } catch (e) {
    if (o.signal.aborted) throw new TransferError('aborted', 'aborted')
    throw new TransferError('transient', `derivative PUT ${errorName(e)}`, true)
  }
  await res.body?.cancel().catch(() => {})
  if (res.ok) return
  const retryable = res.status >= 500 || res.status === 429
  throw new TransferError('transient', `derivative PUT ${res.status}`, retryable)
}
