// Wave W (docs/WAVE-W-CONTRACTS.md §3.2): the worker's client of /api/worker/ops/*. OWNER: the wave W lead. Built on
// the preview client's one POST (api-client.ts createApiCall): the token goes to the API origin only, no redirects, a
// timeout, errors by kind; the same logging rule (never a URL, a header, a body or a file name).
//
// An api before wave W has no ops routes: its claim (and check-in) answers 404, or, from main's CSRF hook, 403
// FORBIDDEN "Cross-origin request refused." (the hook exempts the worker by matched route only, so an unknown route
// POSTed without an Origin header is refused before routing; review m3). Both are reported as 'unsupported' so the loop
// backs off for a long while and keeps doing previews. A 403 here is not a token problem: a slot asks for an op only
// after its preview claim, under the same token, succeeded (a wrong token fails that claim first, logged there).

import {
  WORKER_OP_ROUTES,
  WorkerOpClaimed,
  type WorkerOpErrorCode,
  type WorkerOpKind,
  type WorkerOpOutputInput,
} from '@draftroom/contracts'
import { type ApiCall, type BlobRef, WorkerApiError } from '../api-client.ts'

export interface ClaimedOp {
  id: string
  kind: WorkerOpKind
  capability: string
  boardId: string
  sourceVersionId: string
  params: Record<string, unknown>
  attempt: number
  leaseMs: number
  source: {
    kind: 'image' | 'pdf' | 'video' | 'other'
    name: string
    mimeType: string
    sizeBytes: number
    pageCount: number | null
  }
  /** where to GET the source original (presigned, or the API's fs-mode route) */
  original: BlobRef
}

export interface OpLease {
  opId: string
  attempt: number
}

export type OpOutputDraft = Omit<WorkerOpOutputInput, 'workerId' | 'attempt'>

export interface OpReservation {
  outputId: string
  upload: BlobRef & { method: 'PUT' }
}

export interface WorkerOpsApi {
  /** An op for these capabilities, null when there is none, 'unsupported' when this api has no ops routes. */
  claim(capabilities: readonly string[], signal?: AbortSignal): Promise<ClaimedOp | null | 'unsupported'>
  /**
   * Records this worker's capabilities without taking an op (every WORKER_OP_LIMITS.checkinEveryMs, also while its
   * slots are busy: remote-loop.ts), 'unsupported' when this api has no ops routes. Optional for test fakes.
   */
  checkin?(capabilities: readonly string[], signal?: AbortSignal): Promise<'ok' | 'unsupported'>
  heartbeat(lease: OpLease, signal?: AbortSignal): Promise<{ leaseMs: number | null }>
  output(lease: OpLease, draft: OpOutputDraft, signal?: AbortSignal): Promise<OpReservation>
  text(lease: OpLease, pages: { page: number; body: string }[], signal?: AbortSignal): Promise<void>
  complete(
    lease: OpLease,
    outputs: string[],
    result: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void>
  fail(
    lease: OpLease,
    code: WorkerOpErrorCode,
    opts?: { retry?: boolean; release?: boolean },
    signal?: AbortSignal,
  ): Promise<void>
}

const OP_RE = /^wop_[0-9A-Za-z]{10,40}$/
const OUT_RE = /^wpo_[0-9A-Za-z]{10,40}$/

export function parseOpClaim(body: unknown): ClaimedOp {
  const r = WorkerOpClaimed.safeParse(body)
  if (!r.success) throw new WorkerApiError('protocol', 200, 'ops claim: the body does not match the contract')
  const { op, source } = r.data
  return { ...op, original: { url: source.url, headers: {} } }
}

function parseReservation(body: unknown): OpReservation {
  const b = body as {
    outputId?: unknown
    upload?: { url?: unknown; method?: unknown; headers?: unknown }
  } | null
  if (!b || typeof b.outputId !== 'string' || !OUT_RE.test(b.outputId))
    throw new WorkerApiError('protocol', 200, 'ops output: outputId missing or invalid')
  const up = b.upload
  if (
    !up ||
    typeof up.url !== 'string' ||
    up.url === '' ||
    String(up.method ?? 'PUT').toUpperCase() !== 'PUT'
  )
    throw new WorkerApiError('protocol', 200, 'ops output: upload is not a PUT url')
  const headers: Record<string, string> = {}
  if (up.headers && typeof up.headers === 'object')
    for (const [k, v] of Object.entries(up.headers as Record<string, unknown>))
      if (typeof v === 'string') headers[k.toLowerCase()] = v
  return { outputId: b.outputId, upload: { url: up.url, headers, method: 'PUT' } }
}

/**
 * The answer of an api with no ops routes (the header): 404, or 403 from a pre-wave-W CSRF hook. Only for the claim and
 * the check-in (routes that are not lease-bound); the preview routes keep reading 403 as a token problem.
 */
export const isOpsUnsupported = (e: unknown): boolean =>
  e instanceof WorkerApiError && (e.status === 404 || e.status === 403)

export function createWorkerOpsApi(call: ApiCall): WorkerOpsApi {
  const path = (lease: OpLease, action: string) => {
    if (!OP_RE.test(lease.opId)) throw new WorkerApiError('rejected', null, 'invalid op id')
    return `/api/worker/ops/${lease.opId}/${action}`
  }
  return {
    async claim(capabilities, signal) {
      let r: { status: number; json: unknown }
      try {
        r = await call(WORKER_OP_ROUTES.claim, { capabilities: [...capabilities] }, signal, false)
      } catch (e) {
        if (isOpsUnsupported(e)) return 'unsupported'
        throw e
      }
      if (r.status === 204 || r.json === null) return null
      return parseOpClaim(r.json)
    },
    async checkin(capabilities, signal) {
      try {
        await call(WORKER_OP_ROUTES.checkin, { capabilities: [...capabilities] }, signal, false)
      } catch (e) {
        if (isOpsUnsupported(e)) return 'unsupported'
        throw e
      }
      return 'ok'
    },
    async heartbeat(lease, signal) {
      const r = await call(path(lease, 'heartbeat'), { attempt: lease.attempt }, signal, true)
      const ms = (r.json as { leaseMs?: unknown } | null)?.leaseMs
      return { leaseMs: typeof ms === 'number' && Number.isSafeInteger(ms) && ms > 0 ? ms : null }
    },
    async output(lease, draft, signal) {
      const r = await call(path(lease, 'output'), { attempt: lease.attempt, ...draft }, signal, true)
      return parseReservation(r.json)
    },
    async text(lease, pages, signal) {
      await call(path(lease, 'text'), { attempt: lease.attempt, pages }, signal, true)
    },
    async complete(lease, outputs, result, signal) {
      await call(path(lease, 'complete'), { attempt: lease.attempt, outputs, result }, signal, true)
    },
    async fail(lease, code, opts, signal) {
      await call(
        path(lease, 'fail'),
        {
          attempt: lease.attempt,
          code,
          ...(opts?.retry ? { retry: true } : {}),
          ...(opts?.release ? { release: true } : {}),
        },
        signal,
        true,
      )
    },
  }
}
