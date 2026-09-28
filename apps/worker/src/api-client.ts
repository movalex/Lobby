// HTTP client of the worker protocol (docs/M3-STORAGE-CONTRACTS.md §4): claim, heartbeat, derivative
// reservation, complete, retry. The worker's only credential is the bearer token; it is sent to the
// configured API origin and nowhere else (presigned blob URLs on another origin never see it).
//
// Logging rule for everything built on this: never log a URL (presigned URLs are credentials), a
// header, a request/response body or a file name. Errors carry a status code and an error name only.
import { type AssetKind, isId, type ProbeFacts } from '@draftroom/dev-assets'

export interface RemoteJob {
  versionId: string
  assetId: string
  boardId: string
  kind: AssetKind
  /** User-chosen display name: never logged, never used as a path. */
  name: string
  declaredMimeType: string
  sizeBytes: number
  /** 1-based; the API counts the claim that produced this job. */
  attempt: number
  leaseMs: number
}

/** Where to GET or PUT bytes: a presigned R2 URL, or an API blob route (fs mode, relative or same-origin). */
export interface BlobRef {
  url: string
  headers: Record<string, string>
}

export interface ClaimedJob {
  job: RemoteJob
  original: BlobRef
}

export interface DerivativeDraft {
  role: 'thumb' | 'display' | 'page' | 'poster'
  page: number | null
  mimeType: 'image/webp' | 'image/png'
  width: number
  height: number
  bytes: number
}

export interface Reservation {
  derivativeId: string
  upload: BlobRef & { method: 'PUT' }
}

export interface CompleteBody {
  status: 'ready' | 'failed'
  mimeType?: string
  probe: ProbeFacts
  derivatives: string[]
  /** `message` is the fixed user-safe catalog text (errors.ts), never tool output. */
  error?: { code: string; message: string }
}

/** Sent with /retry: `message` is for the API's last_error column (server-side only, path-free). */
export interface RetryReason {
  code: 'TRANSIENT' | 'RELEASED' | 'PROTOCOL'
  message: string
}

/**
 * The lease a call is made under. `attempt` (the claim's) is sent on every lease-bound call, so that
 * of two slots sharing one workerId only the one holding the CURRENT attempt is accepted (a slot whose
 * lease expired and was reclaimed by its sibling gets 409). Omitted only when a claim was unreadable.
 */
export interface LeaseRef {
  versionId: string
  attempt?: number
}

/**
 * lease    409 LEASE_LOST (or 404/410) on a job route: the lease is not (or no longer) this worker's.
 *          Stop, touch nothing.
 * auth     401/403: wrong or rotated token.
 * rejected another 4xx: the API refused the request as sent (retrying the same call cannot help).
 * server   5xx or 429: the API is up but struggling (retryable).
 * network  no response: connection refused/reset, DNS, timeout (retryable).
 * protocol a 2xx whose body does not match the contract.
 * aborted  our own signal (shutdown or lost lease) cancelled the call.
 */
export type ApiErrorKind = 'lease' | 'auth' | 'rejected' | 'server' | 'network' | 'protocol' | 'aborted'

export class WorkerApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null
  /** Set for a claim whose body was invalid but still named a valid version (so it can be handed back). */
  readonly versionId: string | null
  constructor(kind: ApiErrorKind, status: number | null, detail: string, versionId: string | null = null) {
    super(detail)
    this.name = 'WorkerApiError'
    this.kind = kind
    this.status = status
    this.versionId = versionId
  }
}

export const isRetryable = (e: unknown) =>
  e instanceof WorkerApiError && (e.kind === 'server' || e.kind === 'network')

export interface WorkerApiOptions {
  /** API origin, e.g. `https://draftroom-api.onrender.com` (validated by env.ts). */
  baseUrl: string
  token: string
  workerId: string
  requestTimeoutMs: number
  /** Refuse plain-http blob URLs on another origin (production). */
  requireHttpsBlobs?: boolean
}

export interface WorkerApi {
  readonly origin: string
  readonly workerId: string
  claim(signal?: AbortSignal): Promise<ClaimedJob | null>
  heartbeat(lease: LeaseRef, signal?: AbortSignal): Promise<{ leaseMs: number | null }>
  reserve(lease: LeaseRef, d: DerivativeDraft, signal?: AbortSignal): Promise<Reservation>
  complete(lease: LeaseRef, body: CompleteBody, signal?: AbortSignal): Promise<void>
  /**
   * `release: true` (worker shutdown) hands the job back at once without counting the attempt (an api
   * extension of §4 /retry; an api without it ignores the key and treats it as a transient failure).
   */
  retry(
    lease: LeaseRef,
    error: RetryReason,
    opts?: { release?: boolean },
    signal?: AbortSignal,
  ): Promise<void>
  /** URL + headers for a blob transfer. The bearer token is added only for the API's own origin. */
  blobRequest(ref: BlobRef): { url: string; headers: Record<string, string> }
}

const KINDS = new Set<AssetKind>(['image', 'pdf', 'video', 'other'])
// Hop-by-hop or computed by fetch itself; never taken from a server-provided header map.
const DROP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'keep-alive',
])

export function errorName(e: unknown): string {
  const err = e as { name?: unknown; cause?: { code?: unknown; name?: unknown } } | null
  const cause = err?.cause?.code ?? err?.cause?.name
  const name = typeof err?.name === 'string' ? err.name : 'Error'
  return typeof cause === 'string' ? `${name}/${cause}` : name
}

function kindForStatus(status: number, jobRoute: boolean, code: string): ApiErrorKind {
  // A 409 with another code is not about the lease: e.g. DERIVATIVE_MISSING on complete (upload again).
  if (jobRoute && status === 409) return code === '' || code === 'LEASE_LOST' ? 'lease' : 'rejected'
  if (jobRoute && (status === 404 || status === 410)) return 'lease'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status >= 500) return 'server'
  return 'rejected'
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const isInt = (x: unknown, min: number): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min

function headerMap(x: unknown, what: string): Record<string, string> {
  if (x === undefined || x === null) return {}
  if (!isObj(x)) throw new Error(`${what} headers is not an object`)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(x)) {
    if (typeof v !== 'string') throw new Error(`${what} header value is not a string`)
    out[k.toLowerCase()] = v
  }
  return out
}

function blobRef(x: unknown, what: string): BlobRef {
  if (!isObj(x) || typeof x.url !== 'string' || x.url === '') throw new Error(`${what} has no url`)
  return { url: x.url, headers: headerMap(x.headers, what) }
}

export function parseClaim(body: unknown): ClaimedJob {
  const j = isObj(body) && isObj(body.job) ? body.job : null
  const versionId = j && isId('ver', j.versionId) ? j.versionId : null
  try {
    if (!j || !versionId) throw new Error('job.versionId missing or invalid')
    if (!isId('ast', j.assetId)) throw new Error('job.assetId invalid')
    if (typeof j.boardId !== 'string' || j.boardId === '') throw new Error('job.boardId invalid')
    if (typeof j.kind !== 'string' || !KINDS.has(j.kind as AssetKind)) throw new Error('job.kind invalid')
    if (!isInt(j.sizeBytes, 0)) throw new Error('job.sizeBytes invalid')
    if (!isInt(j.attempt, 1)) throw new Error('job.attempt invalid')
    if (!isInt(j.leaseMs, 1)) throw new Error('job.leaseMs invalid')
    return {
      job: {
        versionId,
        assetId: j.assetId,
        boardId: j.boardId,
        kind: j.kind as AssetKind,
        name: typeof j.name === 'string' ? j.name : '',
        declaredMimeType: typeof j.declaredMimeType === 'string' ? j.declaredMimeType : '',
        sizeBytes: j.sizeBytes,
        attempt: j.attempt,
        leaseMs: j.leaseMs,
      },
      original: blobRef(isObj(body) ? body.original : undefined, 'original'),
    }
  } catch (e) {
    throw new WorkerApiError('protocol', 200, `claim: ${(e as Error).message}`, versionId)
  }
}

function parseReservation(body: unknown): Reservation {
  if (!isObj(body) || !isId('drv', body.derivativeId)) {
    throw new WorkerApiError('protocol', 200, 'derivatives: derivativeId missing or invalid')
  }
  const up = isObj(body.upload) ? body.upload : null
  if (!up || (up.method !== undefined && String(up.method).toUpperCase() !== 'PUT')) {
    throw new WorkerApiError('protocol', 200, 'derivatives: upload.method is not PUT')
  }
  try {
    return { derivativeId: body.derivativeId, upload: { ...blobRef(up, 'upload'), method: 'PUT' } }
  } catch (e) {
    throw new WorkerApiError('protocol', 200, `derivatives: ${(e as Error).message}`)
  }
}

export function createWorkerApi(o: WorkerApiOptions): WorkerApi {
  const base = new URL(o.baseUrl)
  const origin = base.origin
  const auth = `Bearer ${o.token}`

  async function call(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    jobRoute: boolean,
  ): Promise<{ status: number; json: unknown }> {
    const timeout = AbortSignal.timeout(o.requestTimeoutMs)
    let res: Response
    try {
      res = await fetch(new URL(path, origin), {
        method: 'POST',
        headers: {
          authorization: auth,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'draftroom-worker',
        },
        body: JSON.stringify({ workerId: o.workerId, ...body }),
        redirect: 'error', // never replay the token to wherever a redirect points
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (e) {
      if (signal?.aborted) throw new WorkerApiError('aborted', null, 'aborted')
      throw new WorkerApiError('network', null, errorName(e))
    }
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      if (signal?.aborted) throw new WorkerApiError('aborted', null, 'aborted')
      throw new WorkerApiError('network', res.status, `body ${errorName(e)}`)
    }
    if (res.status === 204 || text === '') {
      if (!res.ok)
        throw new WorkerApiError(kindForStatus(res.status, jobRoute, ''), res.status, `HTTP ${res.status}`)
      return { status: res.status, json: null }
    }
    if (!res.ok) {
      // The API's error JSON has a code; keep only that (never the message: it could echo input).
      let code = ''
      try {
        const e = JSON.parse(text) as { error?: { code?: unknown } }
        if (typeof e.error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.error.code)) code = e.error.code
      } catch {}
      throw new WorkerApiError(
        kindForStatus(res.status, jobRoute, code),
        res.status,
        `HTTP ${res.status}${code ? ` ${code}` : ''}`,
      )
    }
    try {
      return { status: res.status, json: JSON.parse(text) }
    } catch {
      throw new WorkerApiError('protocol', res.status, 'response is not JSON')
    }
  }

  const jobPath = (lease: LeaseRef, action: string) => {
    if (!isId('ver', lease.versionId)) throw new WorkerApiError('rejected', null, 'invalid version id')
    return `/api/worker/jobs/${lease.versionId}/${action}`
  }
  const leaseBody = (lease: LeaseRef) => (lease.attempt === undefined ? {} : { attempt: lease.attempt })

  return {
    origin,
    workerId: o.workerId,
    async claim(signal) {
      const r = await call('/api/worker/claim', {}, signal, false)
      if (r.status === 204 || r.json === null) return null
      return parseClaim(r.json)
    },
    async heartbeat(lease, signal) {
      const r = await call(jobPath(lease, 'heartbeat'), leaseBody(lease), signal, true)
      const leaseMs = isObj(r.json) && isInt(r.json.leaseMs, 1) ? r.json.leaseMs : null
      return { leaseMs }
    },
    async reserve(lease, d, signal) {
      const r = await call(jobPath(lease, 'derivatives'), { ...leaseBody(lease), ...d }, signal, true)
      return parseReservation(r.json)
    },
    async complete(lease, body, signal) {
      await call(jobPath(lease, 'complete'), { ...leaseBody(lease), ...body }, signal, true)
    },
    async retry(lease, error, opts, signal) {
      const release = opts?.release ? { release: true } : {}
      await call(jobPath(lease, 'retry'), { ...leaseBody(lease), error, ...release }, signal, true)
    },
    blobRequest(ref) {
      let u: URL
      try {
        u = new URL(ref.url, origin)
      } catch {
        throw new WorkerApiError('protocol', null, 'blob url is not a URL')
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new WorkerApiError('protocol', null, 'blob url is not http(s)')
      }
      if (u.username || u.password) throw new WorkerApiError('protocol', null, 'blob url carries credentials')
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(ref.headers)) if (!DROP_HEADERS.has(k)) headers[k] = v
      if (u.origin === origin) {
        headers.authorization = auth // fs mode: /api/worker/blobs/<opaque> on the API itself
      } else if (o.requireHttpsBlobs && u.protocol !== 'https:') {
        throw new WorkerApiError('protocol', null, 'cross-origin blob url is not https')
      }
      return { url: u.href, headers }
    },
  }
}
