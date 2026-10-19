// Wave W (docs/WAVE-W-CONTRACTS.md §3.2): the worker's client of /api/worker/ops/*. OWNER: the wave W lead. Built on
// the preview client's one POST (api-client.ts createApiCall): the token goes to the API origin only, no redirects, a
// timeout, errors by kind; the same logging rule (never a URL, a header, a body or a file name).
//
// An api before wave W has no ops routes: its claim answers 404, which this client reports as 'unsupported' so the
// loop backs off for a long while and keeps doing previews.

import {
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

export function createWorkerOpsApi(call: ApiCall): WorkerOpsApi {
  const path = (lease: OpLease, action: string) => {
    if (!OP_RE.test(lease.opId)) throw new WorkerApiError('rejected', null, 'invalid op id')
    return `/api/worker/ops/${lease.opId}/${action}`
  }
  return {
    async claim(capabilities, signal) {
      let r: { status: number; json: unknown }
      try {
        r = await call('/api/worker/ops/claim', { capabilities: [...capabilities] }, signal, false)
      } catch (e) {
        if (e instanceof WorkerApiError && e.kind === 'rejected' && e.status === 404) return 'unsupported'
        throw e
      }
      if (r.status === 204 || r.json === null) return null
      return parseOpClaim(r.json)
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
