// Wave W (docs/WAVE-W-CONTRACTS.md §3.2): /api/worker/ops/* — the worker ops protocol, registered inside the preview
// protocol's scope of ./routes.ts, so it shares its Bearer token check, its cookie refusal, its rate limit (one budget
// for every worker route), its error shape and its pattern-only logging. OWNER: the wave W lead.
//
// The preview routes do not change: a worker before wave W never calls these and never sees an op. A worker of wave W
// calls `claim` only when its preview claim came back empty (previews keep priority). This api before wave W has no
// such route: the worker reads its 404 as "no ops here" and backs off.

import { presignedPutHeaders } from '@draftroom/blob-store'
import {
  type FormatSwitches,
  WORKER_OP_ROUTES,
  type WorkerOpClaimed,
  WorkerOpClaimInput,
  WorkerOpCompleteInput,
  type WorkerOpDone,
  WorkerOpFailInput,
  WorkerOpLeaseInput,
  WorkerOpOutputInput,
  WorkerOpTextInput,
} from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { ApiError, badRequest, notFound } from '../errors.ts'
import { type BlobStore, originalKey } from '../files/blobs.ts'
import type { BlobUrlSigner } from './blob-urls.ts'
import { LeaseLost } from './jobs.ts'
import {
  acceptOpText,
  claimOp,
  completeOp,
  expireOps,
  failOp,
  heartbeatOp,
  type OpChange,
  recordCapabilities,
  reserveOpOutput,
} from './ops-jobs.ts'
import { OP_KINDS, type OpKindHandler, OpRefused } from './ops-kinds.ts'
import { BLOB_URL_TTL_SEC } from './protocol.ts'

export interface OpsDeps {
  db: Db
  blobs: BlobStore
  now: () => Date
  switches: FormatSwitches
  /** After a committed op status change (the requester's `file.op` event). Never throws. */
  onOpChange(change: OpChange): Promise<void>
  /** After a committed version change made by a kind (a remove-bg's new version: `assets.version`). Never throws. */
  onVersionMade(change: {
    versionId: string
    assetId: string
    boardId: string
    workspaceId: string
  }): Promise<void>
  /** A claim that recorded capabilities (the auth config's offer cache forgets). */
  onCapabilities?(): void
  /** The kinds (tests swap them; the app uses OP_KINDS). */
  kinds?: Readonly<Record<string, OpKindHandler>>
}

export interface OpsHelpers {
  signer: BlobUrlSigner
  selfUrl(req: FastifyRequest, path: string): string
  deleteBlobs(req: FastifyRequest, keys: string[]): Promise<void>
}

function parseBody<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value ?? {})
  if (r.success) return r.data
  const issue = r.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  throw badRequest(`${where}${issue?.message ?? 'invalid input'}`.slice(0, 200))
}

const OP_ID_RE = /^wop_[0-9A-Za-z]{10,40}$/
function opParam(req: FastifyRequest): string {
  const op = (req.params as { op?: string }).op
  if (typeof op !== 'string' || !OP_ID_RE.test(op)) throw notFound()
  return op
}

const mapOpError = (e: unknown): never => {
  if (e instanceof LeaseLost)
    throw new ApiError(
      409,
      'LEASE_LOST',
      'This op is not leased to this worker (it expired or was reclaimed).',
    )
  if (e instanceof OpRefused) throw new ApiError(e.status, e.code, e.message)
  throw e
}

/** Registers the six ops routes on `scope` (the preview protocol scope: guard, limiter, error handler already on it). */
export function registerOpRoutes(scope: FastifyInstance, deps: OpsDeps, h: OpsHelpers): void {
  const kinds = (deps.kinds ?? OP_KINDS) as typeof OP_KINDS

  const after = async (req: FastifyRequest, orphanKeys: string[], changes: (OpChange | null)[]) => {
    await h.deleteBlobs(req, orphanKeys)
    for (const c of changes) if (c) await deps.onOpChange(c)
  }

  scope.post(WORKER_OP_ROUTES.claim, async (req, reply) => {
    const input = parseBody(WorkerOpClaimInput, req.body)
    const now = deps.now()
    await recordCapabilities(deps.db, now, input.workerId, input.capabilities)
    deps.onCapabilities?.()
    const expired = await expireOps(deps.db, now, deps.switches)
    await after(req, [], expired)
    const out = await claimOp(deps.db, now, input.workerId, input.capabilities, deps.switches)
    await after(req, out.orphanKeys, out.changes)
    const op = out.op
    if (!op) return reply.code(204).send()
    let source: { url: string }
    try {
      const signed = await deps.blobs.presignGet(originalKey(op.sourceAssetId, op.sourceVersionId), {
        expiresSec: BLOB_URL_TTL_SEC,
      })
      source = {
        url:
          signed ??
          h.selfUrl(req, `/api/worker/blobs/${h.signer.sign({ kind: 'q', id: op.id }, BLOB_URL_TTL_SEC)}`),
      }
    } catch (e) {
      // could not hand out the source: give the op back instead of letting its lease run out
      await failOp(deps.db, deps.now(), op.id, {
        workerId: input.workerId,
        attempt: op.attempt,
        code: 'INTERNAL',
        release: true,
      }).catch(() => {})
      throw e
    }
    const body: WorkerOpClaimed = {
      op: {
        id: op.id,
        kind: op.kind,
        capability: op.capability,
        boardId: op.boardId,
        sourceVersionId: op.sourceVersionId,
        params: op.params,
        attempt: op.attempt,
        leaseMs: op.leaseMs,
        source: op.source,
      },
      source,
    }
    return reply.code(200).send(body)
  })

  scope.post(WORKER_OP_ROUTES.heartbeat, async (req) => {
    const op = opParam(req)
    const input = parseBody(WorkerOpLeaseInput, req.body)
    return heartbeatOp(deps.db, deps.now(), op, input.workerId, input.attempt).catch(mapOpError)
  })

  scope.post(WORKER_OP_ROUTES.output, async (req) => {
    const op = opParam(req)
    const input = parseBody(WorkerOpOutputInput, req.body)
    const r = await reserveOpOutput(deps.db, deps.now(), op, input, kinds).catch(mapOpError)
    const signed = await deps.blobs.presignPut(r.blobKey, {
      expiresSec: BLOB_URL_TTL_SEC,
      contentType: r.mimeType,
      contentLength: r.bytes,
    })
    const url =
      signed ??
      h.selfUrl(req, `/api/worker/blobs/${h.signer.sign({ kind: 'p', id: r.outputId }, BLOB_URL_TTL_SEC)}`)
    const headers = presignedPutHeaders({ contentType: r.mimeType, contentLength: r.bytes })
    return { outputId: r.outputId, upload: { url, method: 'PUT' as const, headers } }
  })

  scope.post(WORKER_OP_ROUTES.text, async (req) => {
    const op = opParam(req)
    const input = parseBody(WorkerOpTextInput, req.body)
    return acceptOpText(deps.db, deps.now(), op, input, kinds).catch(mapOpError)
  })

  scope.post(WORKER_OP_ROUTES.complete, async (req): Promise<WorkerOpDone> => {
    const op = opParam(req)
    const input = parseBody(WorkerOpCompleteInput, req.body)
    const out = await completeOp(deps.db, deps.blobs, deps.now(), op, input, kinds).catch(mapOpError)
    await after(req, out.orphanKeys, [out.change])
    for (const v of out.versionChanges) await deps.onVersionMade(v)
    return { opId: op, status: out.status, repeated: out.repeated }
  })

  scope.post(WORKER_OP_ROUTES.fail, async (req): Promise<WorkerOpDone> => {
    const op = opParam(req)
    const input = parseBody(WorkerOpFailInput, req.body)
    const out = await failOp(deps.db, deps.now(), op, input).catch(mapOpError)
    await after(req, out.orphanKeys, [out.change])
    return { opId: op, status: out.status, repeated: false }
  })
}
