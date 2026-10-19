// /api/worker/* (docs/M3-STORAGE-CONTRACTS.md §4): the only way preview workers — on the NAS, on
// Render, or next to a local dev api — touch jobs and blobs. Workers hold no database or R2 credentials.
//
// Not browser routes: exempt from the Origin check (app.ts), refuse any request with a Cookie header,
// and authenticate with `Authorization: Bearer <DRAFTROOM_WORKER_TOKEN>` (constant-time). The fs-mode
// blob URLs (/api/worker/blobs/<opaque>) authenticate like presigned URLs (see blob-urls.ts); a Bearer
// header on them is optional but must be valid when present. Rate-limited per token (per IP without a
// valid one). Logged by route pattern only: never bodies, URLs or query strings.

import type { IncomingMessage } from 'node:http'
import { presignedPutHeaders } from '@draftroom/blob-store'
import { FORMAT_SWITCHES_OFF } from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { isId } from '@draftroom/dev-assets'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { ApiError, badRequest, forbidden, notFound, toErrorResponse } from '../errors.ts'
import { type BlobStore, deleteQuietly, originalKey } from '../files/blobs.ts'
import { ReceiveError, receiveToBlob } from '../files/receive.ts'
import { errInfo } from '../files/upload.ts'
import { bearerToken, carriesCookie, createTokenCheck } from './auth.ts'
import { type BlobUrlKind, type BlobUrlSigner, createBlobUrlSigner } from './blob-urls.ts'
import {
  claimJob,
  completeJob,
  DerivativeMissing,
  heartbeat,
  LeaseLost,
  liveReservation,
  reserveDerivative,
  retryJob,
  runningOriginal,
  TooManyDerivatives,
  UnknownDerivative,
  type VersionChange,
} from './jobs.ts'
import { liveOpOutput, runningOpSource } from './ops-jobs.ts'
import { type OpsDeps, registerOpRoutes } from './ops-routes.ts'
import {
  BLOB_URL_TTL_SEC,
  ClaimInput,
  CompleteInput,
  HeartbeatInput,
  ReserveInput,
  RetryInput,
} from './protocol.ts'

export const WORKER_ROUTES = {
  claim: '/api/worker/claim',
  heartbeat: '/api/worker/jobs/:ver/heartbeat',
  derivatives: '/api/worker/jobs/:ver/derivatives',
  complete: '/api/worker/jobs/:ver/complete',
  retry: '/api/worker/jobs/:ver/retry',
  blob: '/api/worker/blobs/:opaque',
} as const

export const WORKER_PREFIX = '/api/worker/'

export interface WorkerDeps {
  db: Db
  blobs: BlobStore
  /** DRAFTROOM_WORKER_TOKEN. */
  token: string
  now: () => Date
  /** Board event after a committed status change (never throws; see app.ts). */
  onVersionChange(change: VersionChange): Promise<void>
  /** Requests per minute per worker token (all worker routes together). Default 6000. */
  rateLimit?: { max: number; anonMax?: number; timeWindow: number }
  /**
   * Wave W: the worker ops protocol (./ops-routes.ts). Absent: every switch off (no op is handed out; claims still
   * record capabilities and answer 204), and op changes are not published.
   */
  ops?: Pick<OpsDeps, 'switches' | 'onOpChange' | 'onVersionMade' | 'onCapabilities' | 'kinds'>
}

const TOKEN_KEY = 'worker-token'

const leaseLost = () =>
  new ApiError(409, 'LEASE_LOST', 'This job is not leased to this worker (it expired or was reclaimed).')

function parseBody<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value ?? {})
  if (r.success) return r.data
  const issue = r.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  throw badRequest(`${where}${issue?.message ?? 'invalid input'}`.slice(0, 200))
}

function versionParam(req: FastifyRequest): string {
  const ver = (req.params as { ver?: string }).ver
  if (!isId('ver', ver)) throw notFound()
  return ver
}

/** An absolute URL on the origin the worker used to reach this api (fs-mode blob URLs). */
function selfUrl(req: FastifyRequest, path: string): string {
  const host = req.host
  const proto = req.protocol === 'https' ? 'https' : 'http'
  // Host is the caller's own header; anything odd yields a path the worker resolves against its base.
  return /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$|^\[[0-9A-Fa-f:.]{2,45}\](:\d{1,5})?$/.test(host)
    ? `${proto}://${host}${path}`
    : path
}

export async function workerPlugin(app: FastifyInstance, deps: WorkerDeps): Promise<void> {
  const tokenOk = createTokenCheck(deps.token)
  const signer: BlobUrlSigner = createBlobUrlSigner(deps.token, deps.now)
  const limit = deps.rateLimit ?? { max: 6_000, anonMax: 600, timeWindow: 60_000 }
  // ONE budget for all worker routes together (route-level configs would each count separately):
  // per token when a valid one is presented, per address otherwise. Needs @fastify/rate-limit on the host,
  // and refuses to start without it: these routes take a shared bearer token from the internet, so they
  // must never run unlimited because a plugin was registered later than this one (A6, SEC-M3-storage-review).
  if (typeof app.createRateLimit !== 'function')
    throw new Error(
      'workerPlugin needs @fastify/rate-limit registered before it: the worker routes are never served without their rate limit',
    )
  const valid = (req: FastifyRequest) => tokenOk(bearerToken(req.headers.authorization))
  const limiter = app.createRateLimit({
    timeWindow: limit.timeWindow,
    keyGenerator: (req) => (valid(req) ? TOKEN_KEY : `worker-anon:${req.ip}`),
    max: (req) => (valid(req) ? limit.max : (limit.anonMax ?? 600)),
  })
  const log = (req: FastifyRequest, msg: string, err?: unknown) =>
    req.log.error({ ...(err ? { err: errInfo(err) } : {}), route: req.routeOptions.url }, msg)

  /** After a commit: drop abandoned blobs, tell the boards. Never throws. */
  async function afterCommit(req: FastifyRequest, orphanKeys: string[], changes: (VersionChange | null)[]) {
    await deleteQuietly(deps.blobs, orphanKeys, (_k, err) => log(req, 'worker: blob cleanup failed', err))
    for (const c of changes) if (c) await deps.onVersionChange(c)
  }

  const mapJobError = (e: unknown): never => {
    if (e instanceof LeaseLost) throw leaseLost()
    if (e instanceof UnknownDerivative)
      throw new ApiError(
        400,
        'UNKNOWN_DERIVATIVE',
        'A listed derivative was not reserved for this job attempt.',
      )
    if (e instanceof DerivativeMissing)
      throw new ApiError(
        409,
        'DERIVATIVE_MISSING',
        'A listed derivative was not uploaded with its reserved size.',
      )
    if (e instanceof TooManyDerivatives)
      throw new ApiError(
        400,
        'TOO_MANY_DERIVATIVES',
        'This job attempt has reserved the maximum number of derivatives.',
      )
    throw e
  }

  // Worker errors: JSON { error: { code, message } } like every api route; 5xx logged by pattern only.
  const errorHandler = (err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const { status, body } = toErrorResponse(err)
    if (status >= 500) log(req, 'worker route failed', err)
    if (!req.raw.complete) reply.header('connection', 'close') // never drain an unread upload
    if (status === 401) reply.header('www-authenticate', 'Bearer')
    return reply.code(status).send(body)
  }

  /**
   * onRequest of every worker route, before any body byte is read: the rate limit, then the cookie
   * refusal, then (protocol routes) the Bearer token.
   */
  const guard = (required: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await limiter(req)
    if (!r.isAllowed && r.isExceeded) {
      reply.header('retry-after', String(r.ttlInSeconds))
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Wait a moment and try again.')
    }
    if (carriesCookie(req.headers.cookie)) throw forbidden('Worker routes do not accept browser cookies.')
    const presented = bearerToken(req.headers.authorization)
    const hasHeader = req.headers.authorization !== undefined
    if ((required || hasHeader) && !tokenOk(presented))
      throw new ApiError(401, 'NOT_AUTHENTICATED', 'A valid worker token is required.')
  }

  // ---- protocol routes (JSON) -----------------------------------------------------------------------
  app.register(async (scope) => {
    scope.setErrorHandler(errorHandler)
    scope.addHook('onRequest', guard(true))

    scope.post(WORKER_ROUTES.claim, async (req, reply) => {
      const input = parseBody(ClaimInput, req.body)
      const out = await claimJob(deps.db, deps.now(), input.workerId)
      await afterCommit(req, out.orphanKeys, out.failed)
      const job = out.job
      if (!job) return reply.code(204).send()
      let original: { url: string }
      try {
        original = await originalAccess(req, job.assetId, job.versionId)
      } catch (e) {
        // Could not hand out the original: give the job back instead of letting its lease run out.
        await retryJob(deps.db, deps.now(), job.versionId, {
          workerId: input.workerId,
          attempt: job.attempt,
          release: true,
        }).catch(() => {})
        throw e
      }
      const { workspaceId: _w, ...wire } = job
      return reply.code(200).send({ job: wire, original })
    })

    scope.post(WORKER_ROUTES.heartbeat, async (req) => {
      const ver = versionParam(req)
      const input = parseBody(HeartbeatInput, req.body)
      return heartbeat(deps.db, deps.now(), ver, input.workerId, input.attempt).catch(mapJobError)
    })

    scope.post(WORKER_ROUTES.derivatives, async (req) => {
      const ver = versionParam(req)
      const input = parseBody(ReserveInput, req.body)
      const r = await reserveDerivative(deps.db, deps.now(), ver, input).catch(mapJobError)
      const signed = await deps.blobs.presignPut(r.blobKey, {
        expiresSec: BLOB_URL_TTL_SEC,
        contentType: r.mimeType,
        contentLength: r.bytes,
      })
      const url =
        signed ??
        selfUrl(req, `/api/worker/blobs/${signer.sign({ kind: 'd', id: r.derivativeId }, BLOB_URL_TTL_SEC)}`)
      // Exactly these headers: a presigned PUT signs both, and the fs-mode endpoint checks both.
      const headers = presignedPutHeaders({ contentType: r.mimeType, contentLength: r.bytes })
      return { derivativeId: r.derivativeId, upload: { url, method: 'PUT', headers } }
    })

    scope.post(WORKER_ROUTES.complete, async (req) => {
      const ver = versionParam(req)
      const input = parseBody(CompleteInput, req.body)
      const out = await completeJob(deps.db, deps.blobs, deps.now(), ver, input).catch(mapJobError)
      await afterCommit(req, out.orphanKeys, [out.change])
      return { versionId: ver, status: out.status, repeated: out.repeated }
    })

    scope.post(WORKER_ROUTES.retry, async (req) => {
      const ver = versionParam(req)
      const input = parseBody(RetryInput, req.body)
      const out = await retryJob(deps.db, deps.now(), ver, input).catch(mapJobError)
      await afterCommit(req, out.orphanKeys, [out.change])
      return { versionId: ver, status: out.status, runAfter: out.runAfter?.toISOString() ?? null }
    })

    // wave W: the worker ops protocol, on the same guard, limit and error handler
    const ops = deps.ops
    registerOpRoutes(
      scope,
      {
        db: deps.db,
        blobs: deps.blobs,
        now: deps.now,
        switches: ops?.switches ?? FORMAT_SWITCHES_OFF,
        onOpChange: ops?.onOpChange ?? (async () => {}),
        onVersionMade: ops?.onVersionMade ?? (async () => {}),
        ...(ops?.onCapabilities ? { onCapabilities: ops.onCapabilities } : {}),
        ...(ops?.kinds ? { kinds: ops.kinds } : {}),
      },
      {
        signer,
        selfUrl,
        deleteBlobs: (req, keys) =>
          deleteQuietly(deps.blobs, keys, (_k, err) => log(req, 'worker: blob cleanup failed', err)),
      },
    )
  })

  async function originalAccess(req: FastifyRequest, assetId: string, versionId: string) {
    const signed = await deps.blobs.presignGet(originalKey(assetId, versionId), {
      expiresSec: BLOB_URL_TTL_SEC,
    })
    if (signed) return { url: signed }
    return {
      url: selfUrl(req, `/api/worker/blobs/${signer.sign({ kind: 'o', id: versionId }, BLOB_URL_TTL_SEC)}`),
    }
  }

  // ---- fs-mode blob URLs (raw bodies) ------------------------------------------------------------------
  app.register(async (scope) => {
    scope.setErrorHandler(errorHandler)
    // A derivative PUT is raw image bytes: no parser may read or buffer it (see files/plugin.ts).
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null))
    scope.addHook('onRequest', guard(false))
    // close() must neither hang on a half-sent upload nor return before its partial blob is gone.
    const uploads = new Map<IncomingMessage, Promise<unknown>>()
    scope.addHook('preClose', async () => {
      for (const raw of uploads.keys()) raw.destroy()
    })
    scope.addHook('onClose', async () => {
      await Promise.allSettled(uploads.values())
    })
    const grantOf = (req: FastifyRequest, kinds: readonly BlobUrlKind[]) => {
      const g = signer.verify((req.params as { opaque?: string }).opaque ?? '')
      if (!g || !kinds.includes(g.kind)) throw notFound()
      return g
    }

    scope.get(WORKER_ROUTES.blob, async (req, reply) => {
      // o: a preview job's original (by version); q (wave W): a running op's source original (by op)
      const g = grantOf(req, ['o', 'q'])
      const v =
        g.kind === 'o'
          ? await runningOriginal(deps.db, g.id).then((r) =>
              r ? { assetId: r.assetId, versionId: g.id } : null,
            )
          : await runningOpSource(deps.db, g.id)
      if (!v) throw notFound()
      const obj = await deps.blobs.get(originalKey(v.assetId, v.versionId))
      if (!obj) throw notFound()
      return reply
        .code(200)
        .headers({
          'content-type': 'application/octet-stream',
          'content-length': String(obj.contentLength),
          'cache-control': 'no-store',
        })
        .send(obj.body)
    })

    scope.put(WORKER_ROUTES.blob, (req, reply) => {
      const raw = req.raw
      const work = (async () => {
        // d: a preview job's derivative; p (wave W): a running op's reserved output
        const g = grantOf(req, ['d', 'p'])
        const r = g.kind === 'd' ? await liveReservation(deps.db, g.id) : await liveOpOutput(deps.db, g.id)
        if (!r) throw notFound()
        const length = req.headers['content-length']
        if (length === undefined) throw new ApiError(411, 'LENGTH_REQUIRED', 'Content-Length is required.')
        if (!/^\d{1,15}$/.test(length) || Number(length) !== Number(r.bytes))
          throw badRequest('Content-Length must equal the reserved size.')
        const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
        if (type !== r.mimeType) throw badRequest('Content-Type must equal the reserved type.')
        try {
          await receiveToBlob(raw, deps.blobs, r.blobKey, {
            declaredBytes: Number(r.bytes),
            maxBytes: Number(r.bytes),
            contentType: r.mimeType,
          })
        } catch (e) {
          await deleteQuietly(deps.blobs, [r.blobKey], (_k, err) =>
            log(req, 'worker: blob cleanup failed', err),
          )
          if (e instanceof ReceiveError) throw badRequest('The body does not match the reserved size.')
          throw e
        }
        return reply.code(200).send()
      })()
      uploads.set(raw, work)
      return work.finally(() => uploads.delete(raw))
    })
  })
}
