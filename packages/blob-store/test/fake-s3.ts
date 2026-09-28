// In-process fake of the slice of the R2 S3 API the store uses, reached through an injected fetch
// (no sockets, no ports). It verifies SigV4 header and query signatures (recomputed with aws4fetch's
// signer from only the headers the request claims to have signed), presigned expiry, exact
// Content-Length, and streams PUT bodies to temp files so large uploads do not sit in memory.
// Fault injection covers 5xx/429 answers, requests that never answer, and stalled downloads.

import { mkdtempSync, rmSync } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AwsV4Signer } from 'aws4fetch'

export const FAKE_ENDPOINT = 'https://fake-r2.invalid'
export const FAKE_CREDS = {
  accountId: 'fakeaccount0000000000000000000000',
  accessKeyId: 'AKIAFAKEACCESSKEY123',
  secretAccessKey: 'fake/SECRET+key/Do-Not-Log-0123456789abcdef',
  bucket: 'draftroom-fake',
}

interface StoredObject {
  file: string
  size: number
  contentType: string
}

export interface RecordedRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  /** The fetch redirect mode the client asked for. */
  redirect: string
}

const xmlError = (status: number, code: string, extra = '') =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>fake</Message>${extra}</Error>`,
    { status, headers: { 'content-type': 'application/xml' } },
  )

function parseAmzDate(v: string | null): number | null {
  const m = v ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v) : null
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

export function createFakeS3(creds = FAKE_CREDS) {
  const dir = mkdtempSync(join(tmpdir(), 'draftroom-fake-s3-'))
  const objects = new Map<string, StoredObject>()
  const requests: RecordedRequest[] = []
  const faults: Array<{ status: number; code: string }> = []
  let hangs = 0
  const rewrites: Array<(res: Response) => Response> = []
  let stallAfter: number | null = null
  let receivedBytes = 0
  let fileSeq = 0

  function abortPromise(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }

  /** null when the request is correctly signed (header or query auth), else the 403 to send. */
  async function authError(req: Request, url: URL): Promise<Response | null> {
    const authz = req.headers.get('authorization')
    if (authz) {
      const m =
        /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
          authz,
        )
      if (!m || m[1] !== creds.accessKeyId) return xmlError(403, 'InvalidAccessKeyId')
      const datetime = req.headers.get('x-amz-date')
      const at = parseAmzDate(datetime)
      if (at === null || Math.abs(Date.now() - at) > 15 * 60_000) return xmlError(403, 'RequestTimeTooSkewed')
      const names = (m[3] ?? '').split(';')
      for (const required of ['host', 'x-amz-date', 'x-amz-content-sha256']) {
        if (!names.includes(required)) return xmlError(403, 'AccessDenied')
      }
      if (req.headers.get('x-amz-content-sha256') !== 'UNSIGNED-PAYLOAD')
        return xmlError(400, 'InvalidArgument')
      const headers: Record<string, string> = {}
      for (const h of names) if (h !== 'host') headers[h] = req.headers.get(h) ?? ''
      const expected = await new AwsV4Signer({
        method: req.method,
        url: req.url,
        headers,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        service: 's3',
        region: 'auto',
        datetime: datetime ?? '',
        allHeaders: true,
      }).authHeader()
      // Like S3, echo diagnostic details that must never reach logs or error messages.
      if (expected !== authz) {
        return xmlError(
          403,
          'SignatureDoesNotMatch',
          `<AWSAccessKeyId>${m[1]}</AWSAccessKeyId><StringToSign>${url.host}</StringToSign>`,
        )
      }
      return null
    }
    const q = url.searchParams
    const signature = q.get('X-Amz-Signature')
    if (!signature) return xmlError(403, 'AccessDenied')
    const credential = q.get('X-Amz-Credential') ?? ''
    if (q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || credential.split('/')[0] !== creds.accessKeyId) {
      return xmlError(403, 'AccessDenied')
    }
    const datetime = q.get('X-Amz-Date')
    const at = parseAmzDate(datetime)
    const expires = Number(q.get('X-Amz-Expires'))
    if (at === null || !Number.isInteger(expires) || expires < 1 || expires > 604800) {
      return xmlError(403, 'AuthorizationQueryParametersError')
    }
    if (Date.now() > at + expires * 1000)
      return xmlError(403, 'AccessDenied', '<Message>Request has expired</Message>')
    const names = (q.get('X-Amz-SignedHeaders') ?? '').split(';')
    if (!names.includes('host')) return xmlError(403, 'AccessDenied')
    const headers: Record<string, string> = {}
    for (const h of names) if (h !== 'host') headers[h] = req.headers.get(h) ?? ''
    const unsigned = new URL(req.url)
    unsigned.searchParams.delete('X-Amz-Signature')
    const expected = await new AwsV4Signer({
      method: req.method,
      url: unsigned.toString(),
      headers,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      service: 's3',
      region: 'auto',
      datetime: datetime ?? '',
      signQuery: true,
      allHeaders: true,
    }).signature()
    return expected === signature ? null : xmlError(403, 'SignatureDoesNotMatch')
  }

  async function putObject(req: Request, key: string): Promise<Response> {
    const declared = req.headers.get('content-length')
    if (declared === null || !/^\d+$/.test(declared)) return xmlError(411, 'MissingContentLength')
    const file = join(dir, `obj-${++fileSeq}`)
    const out = await open(file, 'w')
    let size = 0
    let ok = false
    try {
      if (req.body) {
        const reader = req.body.getReader()
        const onAbort = () => reader.cancel(req.signal.reason).catch(() => {})
        req.signal.addEventListener('abort', onAbort, { once: true })
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            receivedBytes += value.byteLength
            await out.write(value)
          }
        } finally {
          req.signal.removeEventListener('abort', onAbort)
        }
      }
      ok = size === Number(declared)
    } finally {
      await out.close()
      if (!ok) await rm(file, { force: true })
    }
    if (!ok) return xmlError(400, 'IncompleteBody')
    const previous = objects.get(key)
    objects.set(key, {
      file,
      size,
      contentType: req.headers.get('content-type') ?? 'application/octet-stream',
    })
    if (previous) await rm(previous.file, { force: true })
    return new Response(null, { status: 200, headers: { etag: '"fake"' } })
  }

  function fileBody(
    file: string,
    start: number,
    end: number,
    signal: AbortSignal,
  ): ReadableStream<Uint8Array> {
    let pos = start
    let fh: Awaited<ReturnType<typeof open>> | null = null
    let sent = 0
    const limit = stallAfter
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        fh = await open(file, 'r')
        signal.addEventListener(
          'abort',
          () => {
            controller.error(signal.reason)
            fh?.close().catch(() => {})
          },
          { once: true },
        )
      },
      async pull(controller) {
        if (limit !== null && sent >= limit) return new Promise<void>(() => {}) // stalled until aborted
        if (pos > end) {
          await fh?.close()
          controller.close()
          return
        }
        if (!fh) throw new Error('fake S3: object file is not open')
        const n = Math.min(64 * 1024, end - pos + 1)
        const buf = Buffer.allocUnsafe(n)
        const { bytesRead } = await fh.read(buf, 0, n, pos)
        if (bytesRead === 0) throw new Error('fake S3: object file ended early')
        pos += bytesRead
        sent += bytesRead
        controller.enqueue(buf.subarray(0, bytesRead))
      },
      async cancel() {
        await fh?.close().catch(() => {})
      },
    })
  }

  async function getObject(req: Request, obj: StoredObject | undefined, head: boolean): Promise<Response> {
    if (!obj) return head ? new Response(null, { status: 404 }) : xmlError(404, 'NoSuchKey')
    const base = { 'content-type': obj.contentType, 'accept-ranges': 'bytes', etag: '"fake"' }
    if (head) {
      return new Response(null, { status: 200, headers: { ...base, 'content-length': String(obj.size) } })
    }
    const range = req.headers.get('range')
    let start = 0
    let end = obj.size - 1
    let status = 200
    if (range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range)
      if (!m) return xmlError(400, 'InvalidArgument')
      start = Number(m[1])
      end = Math.min(Number(m[2]), obj.size - 1)
      if (start >= obj.size) return xmlError(416, 'InvalidRange')
      status = 206
    }
    const headers: Record<string, string> = {
      ...base,
      'content-length': String(Math.max(0, end - start + 1)),
    }
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${obj.size}`
    const body = obj.size === 0 ? null : fileBody(obj.file, start, end, req.signal)
    return new Response(body, { status, headers })
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (`${url.protocol}//${url.host}` !== FAKE_ENDPOINT) {
      // What undici does for an unknown host: the message names the host, the cause has a code.
      const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${url.hostname}`), { code: 'ENOTFOUND' })
      throw new TypeError('fetch failed', { cause })
    }
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      headers[k] = v
    })
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      redirect: req.redirect,
    })
    if (hangs > 0) {
      hangs--
      return abortPromise(req.signal)
    }
    const denied = await authError(req, url)
    if (denied) return denied
    const fault = faults.shift()
    if (fault) return xmlError(fault.status, fault.code)
    const rewrite = rewrites.shift()
    return rewrite ? rewrite(await route(req, url)) : route(req, url)
  }

  async function route(req: Request, url: URL): Promise<Response> {
    const prefix = `/${creds.bucket}/`
    if (!url.pathname.startsWith(prefix)) return xmlError(404, 'NoSuchBucket')
    const key = decodeURIComponent(url.pathname.slice(prefix.length))
    switch (req.method) {
      case 'PUT':
        return putObject(req, key)
      case 'GET':
        return getObject(req, objects.get(key), false)
      case 'HEAD':
        return getObject(req, objects.get(key), true)
      case 'DELETE': {
        const obj = objects.get(key)
        objects.delete(key)
        if (obj) await rm(obj.file, { force: true })
        return new Response(null, { status: 204 })
      }
      default:
        return xmlError(405, 'MethodNotAllowed')
    }
  }

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    try {
      return await Promise.race([handle(req), abortPromise(req.signal)])
    } catch (e) {
      if (req.signal.aborted) throw req.signal.reason
      if (e instanceof TypeError) throw e
      throw new TypeError('fetch failed', { cause: e }) // a failing request body, like undici
    }
  }) as typeof fetch

  return {
    fetch: fakeFetch,
    requests,
    /** The next `times` signed requests are answered with `status`/`code`. */
    fail(status: number, code: string, times = 1) {
      for (let i = 0; i < times; i++) faults.push({ status, code })
    },
    /** The next signed request's real response is passed through `fn` (to fake odd upstream answers). */
    rewriteNext(fn: (res: Response) => Response) {
      rewrites.push(fn)
    },
    /** The next `times` requests never answer (until the caller aborts). */
    hang(times = 1) {
      hangs += times
    },
    /** GET bodies started from now on stop after `bytes` bytes (null = normal). */
    stallDownloadsAfter(bytes: number | null) {
      stallAfter = bytes
    },
    receivedBytes: () => receivedBytes,
    async listKeys(prefix: string): Promise<string[]> {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    },
    async objectSize(key: string): Promise<number | null> {
      const obj = objects.get(key)
      return obj ? (await stat(obj.file)).size : null
    },
    close() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

export type FakeS3 = ReturnType<typeof createFakeS3>
