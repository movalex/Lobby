// In-test stand-in for the API's /api/worker/* protocol (docs/M3-STORAGE-CONTRACTS.md §4) plus an
// object store on a SECOND origin that accepts only presigned-style URLs (the R2 stand-in). Leases,
// attempts and idempotent completion follow the contract, so the worker is tested against the same rules
// the real API enforces. Hooks inject failures per route; every request is recorded (method, path, headers).
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Readable } from 'node:stream'
import { type AssetKind, classifyUpload, isId, LIMITS, newId, type ProbeFacts } from '@draftroom/dev-assets'
import { fixturePath } from '../scripts/make-fixtures.ts'

export interface Reserved {
  id: string
  attempt: number
  role: string
  page: number | null
  mimeType: string
  width: number
  height: number
  bytes: number
  key: string
}

export interface CompleteRecord {
  workerId: string
  status: 'ready' | 'failed'
  mimeType?: string
  probe: ProbeFacts
  derivatives: string[]
  error?: { code: string; message: string }
}

export interface FakeJob {
  versionId: string
  assetId: string
  boardId: string
  kind: AssetKind
  name: string
  declaredMimeType: string
  sizeBytes: number
  /** Source of the original's bytes (a fresh stream per GET). */
  body: () => Buffer | Readable
  status: 'queued' | 'running' | 'done' | 'failed'
  attempts: number
  runAfter: number
  leaseOwner: string | null
  leaseUntil: number
  heartbeats: number
  /** Heartbeats that arrived after the lease had already run out. */
  lateHeartbeats: number
  reservations: Map<string, Reserved>
  retries: { workerId: string; error: unknown; attempt: number; release: boolean }[]
  /** Lease-bound calls that did not say which attempt they were made under. */
  callsWithoutAttempt: number
  completes: number
  result: CompleteRecord | null
  /** Final version state as the API would store it. */
  derivatives: Reserved[]
  originalGets: number
}

export interface Recorded {
  server: 'api' | 'store'
  method: string
  path: string
  query: string
  headers: IncomingHttpHeaders
  at: number
}

/** A number overrides the response status; 'reset-after' applies the request, then destroys the socket. */
export type HookResult = number | 'reset-after' | null | undefined

export interface Hooks {
  claim?: (n: number) => HookResult
  heartbeat?: (job: FakeJob, n: number) => HookResult
  derivatives?: (job: FakeJob, n: number) => HookResult
  complete?: (job: FakeJob, n: number) => HookResult
  retry?: (job: FakeJob, n: number) => HookResult
  /** Serve the original yourself; return true when handled. */
  original?: (job: FakeJob, req: IncomingMessage, res: ServerResponse) => boolean
  put?: (req: IncomingMessage, res: ServerResponse, n: number) => boolean
}

export interface FakeApiOptions {
  token?: string
  leaseMs?: number
  /** 'store': presigned-style URLs on the store origin (R2). 'api': fs-mode /api/worker/blobs/<opaque>. */
  blobMode?: 'store' | 'api'
  /** run_after delay of /retry (the real API backs off; tests want it immediate). */
  retryDelayMs?: number
  /**
   * Hand out URLs of a real object store instead (e.g. presigned R2 URLs from packages/blob-store, for a
   * live check under a test prefix). `head` backs complete's "every listed blob exists with its size".
   */
  external?: {
    original(job: FakeJob): Promise<{ url: string; headers?: Record<string, string> }>
    upload(job: FakeJob, r: Reserved): Promise<{ url: string; headers: Record<string, string> }>
    head(r: Reserved): Promise<number | null>
  }
}

export interface AddJob {
  fixture?: string
  bytes?: Buffer
  /** A streamed original of `sizeBytes` bytes. */
  stream?: () => Readable
  sizeBytes?: number
  name?: string
  declaredMimeType?: string
  kind?: AssetKind
  attempts?: number
}

export interface FakeApi {
  readonly api: string
  readonly store: string
  readonly token: string
  readonly leaseMs: number
  readonly jobs: Map<string, FakeJob>
  readonly blobs: Map<string, { bytes: Buffer; contentType: string }>
  readonly requests: Recorded[]
  /** Signatures and opaque ids handed out in blob URLs: secrets that must never appear in worker logs. */
  readonly secrets: string[]
  hooks: Hooks
  maxRunning: number
  claims: number
  add(o: AddJob): FakeJob
  close(): Promise<void>
}

const json = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const err = (res: ServerResponse, status: number, code: string) =>
  json(res, status, { error: { code, message: `fake ${code}` } })

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        if (!res.headersSent) err(res, 500, 'FAKE_BUG')
      })
  })
  return new Promise<{ origin: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections()
            server.close(() => r())
          }),
      })
    })
  })
}

export async function startFakeApi(o: FakeApiOptions = {}): Promise<FakeApi> {
  const token = o.token ?? randomBytes(24).toString('base64url')
  const leaseMs = o.leaseMs ?? 120_000
  const blobMode = o.blobMode ?? 'store'
  const jobs = new Map<string, FakeJob>()
  const blobs = new Map<string, { bytes: Buffer; contentType: string }>()
  const requests: Recorded[] = []
  const secrets: string[] = []
  // sig/opaque -> what it grants (one key, one method), like a presigned URL.
  const grants = new Map<string, { key: string; method: 'GET' | 'PUT'; versionId: string }>()
  const counts = new Map<string, number>()
  const bump = (k: string) => {
    const n = (counts.get(k) ?? 0) + 1
    counts.set(k, n)
    return n
  }

  const record = (server: Recorded['server'], req: IncomingMessage) => {
    const u = new URL(req.url ?? '/', 'http://x')
    requests.push({
      server,
      method: req.method ?? '',
      path: u.pathname,
      query: u.search,
      headers: req.headers,
      at: Date.now(),
    })
    return u
  }

  let storeOrigin = ''
  let apiOrigin = ''

  const grantUrl = (key: string, method: 'GET' | 'PUT', versionId: string, relative: boolean) => {
    const secret = randomBytes(16).toString('hex')
    secrets.push(secret)
    grants.set(secret, { key, method, versionId })
    if (blobMode === 'api') {
      const path = `/api/worker/blobs/${secret}`
      return relative ? path : `${apiOrigin}${path}`
    }
    return `${storeOrigin}/bucket/${key}?X-Amz-Expires=900&X-Amz-Signature=${secret}`
  }

  const serveOriginal = (job: FakeJob, req: IncomingMessage, res: ServerResponse) => {
    job.originalGets++
    if (fake.hooks.original?.(job, req, res)) return
    const b = job.body()
    if (Buffer.isBuffer(b)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': b.length })
      res.end(b)
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': job.sizeBytes })
    b.pipe(res)
  }

  const acceptPut = async (req: IncomingMessage, res: ServerResponse, key: string, versionId: string) => {
    if (fake.hooks.put?.(req, res, bump('put'))) return
    const job = jobs.get(versionId)
    const r = job ? [...job.reservations.values()].find((x) => x.key === key) : undefined
    const body = await readBody(req)
    if (!r) return err(res, 403, 'NO_RESERVATION')
    if (req.headers['content-type'] !== r.mimeType) return err(res, 400, 'CONTENT_TYPE')
    if (body.length !== r.bytes || Number(req.headers['content-length']) !== r.bytes)
      return err(res, 400, 'CONTENT_LENGTH')
    blobs.set(key, { bytes: body, contentType: r.mimeType })
    json(res, 200)
  }

  // Resolves a blob grant from a store URL or an fs-mode API blob path.
  const takeGrant = (secret: string | null, method: string, key?: string) => {
    if (!secret) return null
    const g = grants.get(secret)
    if (!g || g.method !== method || (key !== undefined && g.key !== key)) return null
    return g
  }

  // Like the api: status running, same owner, unexpired, and (when sent) the same attempt, so a slot of
  // the same worker whose lease was reclaimed by its sibling is told apart from the current holder.
  const leaseHeld = (job: FakeJob, workerId: unknown, now: number, attempt: unknown): boolean =>
    job.status === 'running' &&
    job.leaseOwner === workerId &&
    job.leaseUntil >= now &&
    (attempt === undefined || attempt === job.attempts)

  const applyHook = (h: HookResult, res: ServerResponse): 'handled' | 'reset' | null => {
    if (typeof h === 'number') {
      err(res, h, h === 409 ? 'LEASE_LOST' : `HOOK_${h}`) // the api's only 409 on most routes
      return 'handled'
    }
    return h === 'reset-after' ? 'reset' : null
  }

  const apiHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const u = record('api', req)
    if (req.headers.authorization !== `Bearer ${token}`) return err(res, 401, 'UNAUTHORIZED')
    if (req.headers.cookie) return err(res, 400, 'COOKIE_REFUSED')
    const blob = /^\/api\/worker\/blobs\/([0-9a-f]+)$/.exec(u.pathname)
    if (blob) {
      const g = takeGrant(blob[1] ?? null, req.method ?? '')
      if (!g) return err(res, 404, 'NOT_FOUND')
      const job = jobs.get(g.versionId)
      if (req.method === 'GET' && job) return serveOriginal(job, req, res)
      if (req.method === 'PUT') return acceptPut(req, res, g.key, g.versionId)
      return err(res, 404, 'NOT_FOUND')
    }
    if (req.method !== 'POST') return err(res, 404, 'NOT_FOUND')
    const raw = await readBody(req)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    } catch {
      return err(res, 400, 'BAD_JSON')
    }
    const workerId = body.workerId
    if (typeof workerId !== 'string' || workerId === '') return err(res, 400, 'WORKER_ID')
    const now = Date.now()

    if (u.pathname === '/api/worker/claim') {
      fake.claims++
      const h = applyHook(fake.hooks.claim?.(fake.claims), res)
      if (h === 'handled') return
      if (h === 'reset') {
        res.socket?.destroy() // a connection reset before any job was handed out
        return
      }
      const job = [...jobs.values()].find(
        (j) => (j.status === 'queued' && j.runAfter <= now) || (j.status === 'running' && j.leaseUntil < now),
      )
      if (!job) return json(res, 204)
      job.status = 'running'
      job.leaseOwner = workerId
      job.leaseUntil = now + leaseMs
      job.attempts++
      job.reservations.clear() // reservations are scoped to one attempt
      fake.maxRunning = Math.max(
        fake.maxRunning,
        [...jobs.values()].filter((j) => j.status === 'running').length,
      )
      const key = `assets/${job.assetId}/${job.versionId}/original`
      json(res, 200, {
        job: {
          versionId: job.versionId,
          assetId: job.assetId,
          boardId: job.boardId,
          kind: job.kind,
          name: job.name,
          declaredMimeType: job.declaredMimeType,
          sizeBytes: job.sizeBytes,
          attempt: job.attempts,
          leaseMs,
        },
        original: o.external
          ? await o.external.original(job)
          : { url: grantUrl(key, 'GET', job.versionId, true), headers: {} },
      })
      return
    }

    const m = /^\/api\/worker\/jobs\/([^/]+)\/(heartbeat|derivatives|complete|retry)$/.exec(u.pathname)
    if (!m) return err(res, 404, 'NOT_FOUND')
    const versionId = m[1] ?? ''
    const action = m[2] ?? ''
    const job = jobs.get(versionId)
    if (!isId('ver', versionId) || !job) return err(res, 404, 'NOT_FOUND')
    const n = bump(`${action}:${versionId}`)
    const attempt = body.attempt
    if (attempt === undefined) job.callsWithoutAttempt++

    if (action === 'heartbeat') {
      job.heartbeats++
      if (job.status === 'running' && job.leaseOwner === workerId && job.leaseUntil < now)
        job.lateHeartbeats++
      const h = applyHook(fake.hooks.heartbeat?.(job, n), res)
      if (h === 'handled') return
      if (!leaseHeld(job, workerId, now, attempt)) return err(res, 409, 'LEASE_LOST')
      job.leaseUntil = now + leaseMs
      return json(res, 200, { leaseMs })
    }

    if (action === 'derivatives') {
      const h = applyHook(fake.hooks.derivatives?.(job, n), res)
      if (h === 'handled') return
      if (!leaseHeld(job, workerId, now, attempt)) return err(res, 409, 'LEASE_LOST')
      const { role, page, mimeType, width, height, bytes } = body as {
        role: string
        page: number | null
        mimeType: string
        width: number
        height: number
        bytes: number
      }
      if (!['thumb', 'display', 'page', 'poster'].includes(role)) return err(res, 400, 'ROLE')
      if (mimeType !== 'image/webp' && mimeType !== 'image/png') return err(res, 400, 'MIME')
      if (page !== null && !(Number.isInteger(page) && page >= 1)) return err(res, 400, 'PAGE')
      for (const x of [width, height, bytes]) if (!Number.isInteger(x) || x < 1) return err(res, 400, 'SIZE')
      const id = newId('drv')
      const key = `assets/${job.assetId}/${job.versionId}/d/${id}.${mimeType === 'image/png' ? 'png' : 'webp'}`
      const reserved: Reserved = {
        id,
        attempt: job.attempts,
        role,
        page,
        mimeType,
        width,
        height,
        bytes,
        key,
      }
      job.reservations.set(id, reserved)
      const upload = o.external
        ? await o.external.upload(job, reserved)
        : { url: grantUrl(key, 'PUT', job.versionId, false), headers: { 'content-type': mimeType } }
      json(res, 200, { derivativeId: id, upload: { ...upload, method: 'PUT' } })
      return
    }

    if (action === 'complete') {
      job.completes++
      const h = applyHook(fake.hooks.complete?.(job, n), res)
      if (h === 'handled') return
      // Idempotent for the worker that finished it.
      if (
        (job.status === 'done' || job.status === 'failed') &&
        job.leaseOwner === workerId &&
        (attempt === undefined || attempt === job.attempts)
      ) {
        return json(res, 200, { versionId, status: job.result?.status, repeated: true })
      }
      if (!leaseHeld(job, workerId, now, attempt)) return err(res, 409, 'LEASE_LOST')
      const c = body as unknown as CompleteRecord
      if (c.status !== 'ready' && c.status !== 'failed') return err(res, 400, 'STATUS')
      if (!Array.isArray(c.derivatives)) return err(res, 400, 'DERIVATIVES')
      const listed: Reserved[] = []
      for (const id of c.derivatives) {
        const r = job.reservations.get(id)
        if (!r) return err(res, 400, 'UNKNOWN_DERIVATIVE')
        const size = o.external ? await o.external.head(r) : (blobs.get(r.key)?.bytes.length ?? null)
        if (size !== r.bytes) return err(res, 409, 'DERIVATIVE_MISSING')
        listed.push(r)
      }
      if (c.status === 'failed' && (!c.error?.code || !c.error.message)) return err(res, 400, 'ERROR')
      job.status = c.status === 'ready' ? 'done' : 'failed'
      job.result = c
      job.derivatives = listed
      // 'reset-after': committed, but the answer never reaches the worker (it must retry, idempotently).
      if (h === 'reset') res.socket?.destroy()
      else json(res, 200, { versionId, status: c.status, repeated: false })
      return
    }

    // retry
    const h = applyHook(fake.hooks.retry?.(job, n), res)
    if (h === 'handled') return
    if (!leaseHeld(job, workerId, now, attempt)) return err(res, 409, 'LEASE_LOST')
    const release = body.release === true
    job.retries.push({ workerId, error: body.error, attempt: job.attempts, release })
    if (release) {
      // Shutdown hand-back (api extension): requeued at once, the attempt is not counted.
      job.status = 'queued'
      job.attempts = Math.max(0, job.attempts - 1)
      job.runAfter = now
    } else if (job.attempts >= LIMITS.maxAttempts) {
      job.status = 'failed'
      job.result = {
        workerId,
        status: 'failed',
        probe: {} as ProbeFacts,
        derivatives: [],
        error: { code: 'INTERNAL', message: 'retries exhausted' },
      }
    } else {
      job.status = 'queued'
      job.runAfter = now + (o.retryDelayMs ?? 0)
    }
    job.reservations.clear()
    json(res, 200, {})
  }

  const storeHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const u = record('store', req)
    const key = u.pathname.replace(/^\/bucket\//, '')
    const g = takeGrant(u.searchParams.get('X-Amz-Signature'), req.method ?? '', key)
    if (!g) return err(res, 403, 'SIGNATURE')
    const job = jobs.get(g.versionId)
    if (req.method === 'GET' && job) return serveOriginal(job, req, res)
    if (req.method === 'PUT') return acceptPut(req, res, g.key, g.versionId)
    return err(res, 404, 'NOT_FOUND')
  }

  const apiServer = await listen((req, res) => apiHandler(req, res))
  const storeServer = await listen((req, res) => storeHandler(req, res))
  apiOrigin = apiServer.origin
  storeOrigin = storeServer.origin

  const fake: FakeApi = {
    api: apiOrigin,
    store: storeOrigin,
    token,
    leaseMs,
    jobs,
    blobs,
    requests,
    secrets,
    hooks: {},
    maxRunning: 0,
    claims: 0,
    add(a) {
      const bytes = a.bytes ?? (a.fixture ? readFileSync(fixturePath(a.fixture)) : undefined)
      if (!bytes && !a.stream) throw new Error('fixture, bytes or stream required')
      const name = a.name ?? a.fixture ?? 'file.bin'
      const declaredMimeType = a.declaredMimeType ?? 'application/octet-stream'
      const job: FakeJob = {
        versionId: newId('ver'),
        assetId: newId('ast'),
        boardId: 'board-test',
        kind: a.kind ?? classifyUpload(declaredMimeType, name),
        name,
        declaredMimeType,
        sizeBytes: a.sizeBytes ?? bytes?.length ?? 0,
        body: () => bytes ?? (a.stream as () => Readable)(),
        status: 'queued',
        attempts: a.attempts ?? 0,
        runAfter: 0,
        leaseOwner: null,
        leaseUntil: 0,
        heartbeats: 0,
        lateHeartbeats: 0,
        reservations: new Map(),
        retries: [],
        callsWithoutAttempt: 0,
        completes: 0,
        result: null,
        derivatives: [],
        originalGets: 0,
      }
      jobs.set(job.versionId, job)
      return job
    },
    async close() {
      await Promise.all([apiServer.close(), storeServer.close()])
    },
  }
  return fake
}
