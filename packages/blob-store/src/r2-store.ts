// Cloudflare R2 BlobStore over its S3 API, signed with aws4fetch (SigV4, region `auto`), path-style
// `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`.
//
// aws4fetch only signs here; requests go through fetch directly. Its own AwsClient.fetch() retries
// by re-sending the same body, which is impossible for a stream, so streamed uploads are sent once
// with `duplex: 'half'` and an exact Content-Length (Node's fetch enforces the length; the meter
// below enforces it too). Payloads are not hashed (`x-amz-content-sha256: UNSIGNED-PAYLOAD`): the
// API already hashed the bytes, and TLS protects them in transit.
//
// Every request uses `redirect: 'error'` (+ `window: null`). Without it Node's fetch (undici 7.29)
// clones the request per the Fetch spec, which tees a streamed body, and the unread branch keeps
// every chunk: measured against live R2, a 50 MiB streamed PUT retained ~50 MB of ArrayBuffers;
// with it, < 1 MB. R2 never redirects S3 API calls, so a redirect is an error anyway.
//
// Errors never contain a URL, host, header, credential or upstream body; only op, key, HTTP status
// and the S3 error code. Credentials live only in this closure (never on the returned object).

import { Readable } from 'node:stream'
import { AwsV4Signer } from 'aws4fetch'
import {
  checkExpires,
  checkPresignPut,
  checkPut,
  checkRange,
  lengthMismatch,
  meteredChunks,
} from './common.ts'
import { BlobStoreError } from './errors.ts'
import { assertValidBlobKey } from './keys.ts'
import type { BlobObject, BlobStore } from './types.ts'

export interface R2BlobStoreConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Default `https://<accountId>.r2.cloudflarestorage.com`. `http:` is accepted only for loopback hosts. */
  endpoint?: string
  /** Max wait for response headers, per attempt (and after an upload's last byte). Default 30 000 ms. */
  timeoutMs?: number
  /** Max time without body progress: upload bytes not pulled / a download read not answered. Default 60 000 ms. */
  stallTimeoutMs?: number
  /** Extra attempts for GET/HEAD/DELETE and byte-array PUTs on network errors, timeouts, 429 and 5xx. Default 2. Streamed PUTs are never retried. */
  retries?: number
  /** Test hook: the fetch implementation (default: global fetch). */
  fetch?: typeof fetch
  /** Test hook: clock for presigned URLs, in ms since the epoch (default: Date.now). */
  now?: () => number
}

const ACCOUNT_RE = /^[A-Za-z0-9-]{1,64}$/
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const S3_CODE_RE = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/
const SYS_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/
const UNSATISFIED_RANGE_RE = /^bytes \*\/(\d+)$/
const MAX_ERROR_BODY = 8 * 1024

/** See the header comment: keeps fetch from cloning (and so teeing and buffering) request bodies. */
const NO_CLONE = { redirect: 'error', window: null } as const satisfies RequestInit

/** Abort reason marking our own timers, so a timeout is told apart from a caller abort. */
const TIMED_OUT = Object.freeze({ reason: 'blob-store-timeout' })

const invalidConfig = (what: string) =>
  new BlobStoreError('INVALID_ARGUMENT', `blob store: R2 config: ${what} is missing or invalid`)

function checkEndpoint(endpoint: string | undefined, accountId: string): string {
  if (endpoint === undefined) return `https://${accountId}.r2.cloudflarestorage.com`
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    throw invalidConfig('endpoint')
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  const okProtocol = u.protocol === 'https:' || (u.protocol === 'http:' && loopback)
  if (
    !okProtocol ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname !== '/' && u.pathname !== '')
  ) {
    throw invalidConfig('endpoint')
  }
  return `${u.protocol}//${u.host}`
}

const positiveInt = (v: unknown, fallback: number, what: string) => {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw invalidConfig(what)
  return v
}

const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, '')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const backoffMs = (attempt: number) => Math.min(2000, 100 * 4 ** attempt) * (0.5 + Math.random() / 2)

/** Content-Length as a number, or null when it is absent or not a plain decimal integer. */
function lengthOf(res: Response): number | null {
  const v = res.headers.get('content-length')
  if (v === null || !/^\d{1,16}$/.test(v)) return null
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : null
}

async function discard(res: Response) {
  await res.body?.cancel().catch(() => {})
}

/** Reads at most MAX_ERROR_BODY bytes of an error response and returns only its S3 `<Code>`. */
async function s3ErrorCode(res: Response): Promise<string | undefined> {
  if (!res.body) return undefined
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (size < MAX_ERROR_BODY) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      size += value.byteLength
    }
  } catch {
    return undefined
  } finally {
    reader.cancel().catch(() => {})
  }
  return S3_CODE_RE.exec(Buffer.concat(parts).toString('utf8'))?.[1]
}

export function createR2BlobStore(cfg: R2BlobStoreConfig): BlobStore {
  if (!cfg || typeof cfg !== 'object') throw invalidConfig('config')
  const { accessKeyId, secretAccessKey, bucket, accountId } = cfg
  if (typeof accountId !== 'string' || !ACCOUNT_RE.test(accountId)) throw invalidConfig('accountId')
  if (typeof accessKeyId !== 'string' || accessKeyId.length === 0) throw invalidConfig('accessKeyId')
  if (typeof secretAccessKey !== 'string' || secretAccessKey.length === 0)
    throw invalidConfig('secretAccessKey')
  if (typeof bucket !== 'string' || !BUCKET_RE.test(bucket)) throw invalidConfig('bucket')
  const base = `${checkEndpoint(cfg.endpoint, accountId)}/${bucket}/`
  const timeoutMs = positiveInt(cfg.timeoutMs, 30_000, 'timeoutMs')
  const stallTimeoutMs = positiveInt(cfg.stallTimeoutMs, 60_000, 'stallTimeoutMs')
  const retries = cfg.retries === undefined ? 2 : cfg.retries
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) throw invalidConfig('retries')
  const doFetch = cfg.fetch ?? globalThis.fetch
  const now = cfg.now ?? Date.now
  const signingCache = new Map<string, ArrayBuffer>()

  const signerFor = (init: {
    method: string
    url: string
    headers?: Record<string, string>
    signQuery?: boolean
    allHeaders?: boolean
    datetime?: string
  }) =>
    new AwsV4Signer({
      ...init,
      accessKeyId,
      secretAccessKey,
      service: 's3',
      region: 'auto',
      cache: signingCache,
    })

  async function signed(method: string, key: string, headers: Record<string, string>) {
    const s = await signerFor({ method, url: base + key, headers }).sign()
    return { url: s.url.toString(), headers: s.headers }
  }

  function fetchError(e: unknown, signal: AbortSignal, op: string, key: string): BlobStoreError {
    if (e instanceof BlobStoreError) return e
    if (signal.aborted && signal.reason === TIMED_OUT) {
      return new BlobStoreError('TIMEOUT', `blob store: R2 ${op} ${key} timed out`)
    }
    const raw =
      (e as { cause?: { code?: unknown } } | null)?.cause?.code ?? (e as { code?: unknown } | null)?.code
    const code = typeof raw === 'string' && SYS_CODE_RE.test(raw) ? raw : undefined
    if (code === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH') return lengthMismatch()
    return new BlobStoreError(
      'NETWORK',
      `blob store: R2 ${op} ${key} failed (network${code ? `: ${code}` : ''})`,
      {
        upstreamCode: code,
      },
    )
  }

  async function upstreamError(res: Response, op: string, key: string, code?: string) {
    const c = code ?? (op === 'HEAD' ? undefined : await s3ErrorCode(res))
    return new BlobStoreError(
      'UPSTREAM',
      `blob store: R2 ${op} ${key} failed: HTTP ${res.status}${c ? ` ${c}` : ''}`,
      {
        status: res.status,
        upstreamCode: c,
      },
    )
  }

  /**
   * One signed request with a header timeout, retried on network errors, timeouts, 429 and 5xx.
   * Returns the response with its abort controller; the caller must call `settle()` once it no
   * longer needs the response timer (after reading or handing off the body).
   */
  async function send(
    op: string,
    key: string,
    method: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<{ res: Response; ac: AbortController; settle: () => void }> {
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(TIMED_OUT), timeoutMs)
      const settle = () => clearTimeout(timer)
      let res: Response
      try {
        const s = await signed(method, key, headers)
        res = await doFetch(s.url, { ...NO_CLONE, method, headers: s.headers, body, signal: ac.signal })
      } catch (e) {
        settle()
        const err = fetchError(e, ac.signal, op, key)
        if (attempt < retries && (err.code === 'NETWORK' || err.code === 'TIMEOUT')) {
          await sleep(backoffMs(attempt))
          continue
        }
        throw err
      }
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        settle()
        await discard(res)
        await sleep(backoffMs(attempt))
        continue
      }
      return { res, ac, settle }
    }
  }

  /** The download body as a Node stream that fails with TIMEOUT when a read gets no bytes in time. */
  function nodeBody(res: Response, ac: AbortController, op: string, key: string): Readable {
    const web = res.body
    if (!web) return Readable.from([])
    const reader = web.getReader()
    let timer: NodeJS.Timeout | undefined
    let ended = false
    return new Readable({
      read() {
        timer = setTimeout(() => ac.abort(TIMED_OUT), stallTimeoutMs)
        reader.read().then(
          ({ done, value }) => {
            clearTimeout(timer)
            if (done) {
              ended = true
              this.push(null)
            } else this.push(value)
          },
          (e: unknown) => {
            clearTimeout(timer)
            this.destroy(fetchError(e, ac.signal, op, key))
          },
        )
      },
      destroy(err, cb) {
        clearTimeout(timer)
        if (!ended) {
          reader.cancel().catch(() => {})
          ac.abort()
        }
        cb(err)
      },
    })
  }

  async function putStream(
    key: string,
    source: NodeJS.ReadableStream,
    contentType: string,
    contentLength: number,
  ) {
    const ac = new AbortController()
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const arm = (ms: number) => {
      clearTimeout(timer)
      if (!settled) timer = setTimeout(() => ac.abort(TIMED_OUT), ms)
    }
    let bodyError: unknown
    async function* chunks() {
      try {
        yield* meteredChunks(source, contentLength, () => arm(stallTimeoutMs))
      } catch (e) {
        bodyError = e
        throw e
      }
      arm(timeoutMs) // every byte is out: now wait for R2's answer
    }
    arm(stallTimeoutMs)
    try {
      const s = await signed('PUT', key, {
        'content-type': contentType,
        'content-length': String(contentLength),
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      })
      let res: Response
      try {
        res = await doFetch(s.url, {
          ...NO_CLONE,
          method: 'PUT',
          headers: s.headers,
          body: chunks(),
          duplex: 'half',
          signal: ac.signal,
        })
      } catch (e) {
        if (bodyError !== undefined) throw bodyError
        throw fetchError(e, ac.signal, 'PUT', key)
      }
      if (res.status !== 200) throw await upstreamError(res, 'PUT', key)
      await discard(res)
    } finally {
      settled = true
      clearTimeout(timer)
    }
  }

  return {
    kind: 'r2',

    async put(key, body, opts) {
      assertValidBlobKey(key)
      const { contentType, contentLength, bytes } = checkPut(body, opts)
      try {
        if (!bytes) return await putStream(key, body as NodeJS.ReadableStream, contentType, contentLength)
        const { res, settle } = await send(
          'PUT',
          key,
          'PUT',
          {
            'content-type': contentType,
            'content-length': String(contentLength),
            'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
          },
          bytes,
        )
        try {
          if (res.status !== 200) throw await upstreamError(res, 'PUT', key)
          await discard(res)
        } finally {
          settle()
        }
      } catch (e) {
        const stream = body as Partial<Readable>
        if (!bytes && typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy()
        throw e
      }
    },

    async get(key, opts) {
      assertValidBlobKey(key)
      const range = checkRange(opts?.range)
      const headers: Record<string, string> = { 'accept-encoding': 'identity' }
      if (range) headers.range = `bytes=${range.start}-${range.end}`
      const { res, ac, settle } = await send('GET', key, 'GET', headers)
      let handedOff = false
      try {
        if (res.status === 404) {
          const code = await s3ErrorCode(res)
          if (code === undefined || code === 'NoSuchKey') return null
          throw await upstreamError(res, 'GET', key, code)
        }
        if (res.status === 416) {
          await discard(res)
          const m = UNSATISFIED_RANGE_RE.exec(res.headers.get('content-range') ?? '')
          throw new BlobStoreError(
            'RANGE_NOT_SATISFIABLE',
            `blob store: R2 GET ${key}: range not satisfiable`,
            {
              size: m ? Number(m[1]) : undefined,
            },
          )
        }
        if (res.status !== 200 && res.status !== 206) throw await upstreamError(res, 'GET', key)
        const contentLength = lengthOf(res)
        if (contentLength === null) {
          await discard(res)
          throw new BlobStoreError('UPSTREAM', `blob store: R2 GET ${key}: response has no valid length`, {
            status: res.status,
          })
        }
        const contentType = res.headers.get('content-type')
        let contentRange: string | undefined
        if (range) {
          if (res.status === 206) {
            const header = res.headers.get('content-range') ?? ''
            const m = CONTENT_RANGE_RE.exec(header)
            if (!m || Number(m[1]) !== range.start || Number(m[2]) - Number(m[1]) + 1 !== contentLength) {
              await discard(res)
              throw new BlobStoreError('UPSTREAM', `blob store: R2 GET ${key}: unexpected Content-Range`, {
                status: 206,
              })
            }
            contentRange = header
          } else if (range.start === 0 && range.end >= contentLength - 1 && contentLength > 0) {
            // A range covering the whole object may be answered with 200: same bytes.
            contentRange = `bytes 0-${contentLength - 1}/${contentLength}`
          } else {
            await discard(res)
            throw new BlobStoreError('UPSTREAM', `blob store: R2 GET ${key}: range was ignored`, {
              status: 200,
            })
          }
        }
        settle() // headers are in; from here the body has its own stall timer
        handedOff = true
        const result: BlobObject = { body: nodeBody(res, ac, 'GET', key), contentLength, contentType }
        if (contentRange !== undefined) result.contentRange = contentRange
        return result
      } finally {
        if (!handedOff) settle()
      }
    },

    async head(key) {
      assertValidBlobKey(key)
      const { res, settle } = await send('HEAD', key, 'HEAD', {})
      try {
        await discard(res)
        if (res.status === 404) return null
        if (res.status !== 200) throw await upstreamError(res, 'HEAD', key)
        const contentLength = lengthOf(res)
        if (contentLength === null) {
          throw new BlobStoreError('UPSTREAM', `blob store: R2 HEAD ${key}: response has no valid length`, {
            status: 200,
          })
        }
        return { contentLength, contentType: res.headers.get('content-type') }
      } finally {
        settle()
      }
    },

    async delete(key) {
      assertValidBlobKey(key)
      const { res, settle } = await send('DELETE', key, 'DELETE', {})
      try {
        if (res.status === 204 || res.status === 200 || res.status === 404) {
          await discard(res)
          return
        }
        throw await upstreamError(res, 'DELETE', key)
      } finally {
        settle()
      }
    },

    async presignGet(key, opts) {
      assertValidBlobKey(key)
      const expiresSec = checkExpires(opts?.expiresSec)
      const s = await signerFor({
        method: 'GET',
        url: `${base}${key}?X-Amz-Expires=${expiresSec}`,
        signQuery: true,
        datetime: amzDate(now()),
      }).sign()
      return s.url.toString()
    },

    async presignPut(key, opts) {
      assertValidBlobKey(key)
      const { expiresSec, contentType, contentLength } = checkPresignPut(opts)
      // allHeaders: aws4fetch leaves Content-Type/-Length unsigned by default; sign exactly these two.
      const headers: Record<string, string> = { 'content-type': contentType }
      if (contentLength !== undefined) headers['content-length'] = String(contentLength)
      const s = await signerFor({
        method: 'PUT',
        url: `${base}${key}?X-Amz-Expires=${expiresSec}`,
        headers,
        signQuery: true,
        allHeaders: true,
        datetime: amzDate(now()),
      }).sign()
      return s.url.toString()
    },
  }
}
