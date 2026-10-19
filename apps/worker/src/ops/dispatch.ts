// Wave W (docs/WAVE-W-CONTRACTS.md §3.5): one runner per op kind, behind one interface. OWNER: the wave W lead (this
// registry); each workstream adds its runner (one line each, through the lead): WS2 remove-bg.ts, WS3 extract-text.ts,
// WS4 render-pages.ts. A kind with no runner here is never reported as a capability (ops/capabilities.ts), so the api
// never hands this worker an op it cannot do. The foundation registers none.

import type { WorkerOpErrorCode, WorkerOpKind } from '@draftroom/contracts'
import type { WorkerApi } from '../api-client.ts'
import type { ClaimedOp, OpLease, WorkerOpsApi } from './client.ts'
import { createExtractTextRunner } from './extract-text.ts'
import { removeBgRunner } from './remove-bg.ts'

export interface OpRunContext {
  op: ClaimedOp
  lease: OpLease
  ops: WorkerOpsApi
  /** the preview client, for blobRequest (download the source, upload outputs: transfer.ts) */
  api: WorkerApi
  /** this op's own temporary directory (removed after the op, whatever happens) */
  tmpDir: string
  /** aborted when the lease is lost or the worker's shutdown grace ran out */
  signal: AbortSignal
  log(line: string): void
}

/** What a finished run hands to complete: the reserved outputs to publish and the kind's result (WORKER_OP_RESULTS). */
export interface OpRunResult {
  outputs: string[]
  result: Record<string, unknown>
}

/** A run that failed in a known way: `code` is what users see (contracts WORKER_OP_MESSAGES); `retry` for transient. */
export class OpFailure extends Error {
  readonly code: WorkerOpErrorCode
  readonly retry: boolean
  constructor(code: WorkerOpErrorCode, retry = false) {
    super(code)
    this.name = 'OpFailure'
    this.code = code
    this.retry = retry
  }
}

export interface OpRunner {
  readonly kind: WorkerOpKind
  run(ctx: OpRunContext): Promise<OpRunResult>
}

/**
 * The runners this worker build has. Getters: a runner's module may import this one (OpFailure), so whichever of the
 * two loads first, a binding is read only once both have run.
 */
export const OP_RUNNERS: Readonly<Partial<Record<WorkerOpKind, OpRunner>>> = {
  // WS2 (ops/remove-bg.ts, the model in a child: ops/bg-child.ts)
  get 'remove-bg'() {
    return removeBgRunner
  },
  // WS3 (ops/extract-text.ts, ops/pdf-text-child.ts): PDFs here; worker.ts gives it the office converter
  get 'extract-text'() {
    return createExtractTextRunner()
  },
  // 'render-pages': renderPagesRunner,  WS4 (ops/render-pages.ts, reusing pdf-child.ts)
}
