// Wave W (docs/WAVE-W-CONTRACTS.md §3.2): what each worker op kind does on the api, behind one interface, so the shared
// state machine (./ops-jobs.ts) stays the lead's and each workstream writes only its kind. OWNER: the wave W lead (this
// registry and the stubs); WS2 replaces REMOVE_BG with features/formats/remove-bg/kind.ts, WS3 EXTRACT_TEXT with
// features/search/file-text-kind.ts, WS4 RENDER_PAGES with features/formats/deck/kind.ts (one line each here, through
// the lead).
//
// The foundation's stubs refuse every output and text call and every complete with 501 NOT_IMPLEMENTED. No deployment
// reaches them: an op exists only once a browser route (pending until its owner lands it) or WS3's enqueue makes one.

import type { WorkerOpKind, WorkerOpOutputInput, WorkerOpTextInput } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { renderPagesKind } from '../features/formats/deck/kind.ts'
import { removeBgKind } from '../features/formats/remove-bg/kind.ts'
import { extractTextKind } from '../features/search/file-text-kind.ts'

/** An op under its lease (the row locked FOR UPDATE inside the caller's transaction). */
export interface LockedOp {
  id: string
  kind: WorkerOpKind
  workspaceId: string
  boardId: string
  sourceVersionId: string
  sourceAssetId: string
  params: Record<string, unknown>
  attempt: number
  requestedBy: string | null
}

/** One reserved output of this attempt that `complete` lists (its blob verified present with its reserved size). */
export interface PublishedOutput {
  id: string
  role: 'original' | 'page'
  page: number | null
  width: number
  height: number
  mimeType: 'image/png' | 'image/webp'
  bytes: number
  assetId: string
  versionId: string
  derivativeId: string | null
  blobKey: string
}

export interface OpCompletion {
  /** worker_ops.result (≤ 4 KiB as JSON; the kind's WORKER_OP_RESULTS shape) */
  result: Record<string, unknown>
  /** remove-bg: the version it made */
  resultVersionId?: string | null
  /** versions whose status changed in this transaction (their `assets.version` events go out after COMMIT) */
  versionChanges?: { versionId: string; assetId: string; boardId: string; workspaceId: string }[]
  /**
   * Listed outputs the kind did NOT turn into rows (render-pages: a page made meanwhile by another run). Their
   * reservations are dropped with the rest and their blobs deleted after COMMIT (review m9: else nothing names them).
   */
  unpublished?: string[]
}

/** What a kind's `verify` may read: the stored outputs, streamed (outside any transaction). */
export interface OutputReader {
  get(key: string): Promise<{ body: NodeJS.ReadableStream } | null>
}

/** A kind's refusal of a worker call: a 4xx with a stable code (never the worker's own text). */
export class OpRefused extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'OpRefused'
    this.status = status
    this.code = code
  }
}

export interface OpKindHandler {
  readonly kind: WorkerOpKind
  /** May the lease holder reserve this output? Throws OpRefused when not (a page out of the op's range, a 2nd original). */
  checkOutput(tx: Queryable, op: LockedOp, input: WorkerOpOutputInput): Promise<void>
  /** extract-text: store a batch of pages. Others: OpRefused. */
  acceptText(tx: Queryable, op: LockedOp, input: WorkerOpTextInput, now: Date): Promise<void>
  /**
   * Optional, before the complete transaction (no transaction is open: it may stream the outputs): checks the stored
   * outputs against the worker's `result` (remove-bg: the PNG's sha256, review m10). Throws OpRefused to refuse.
   */
  verify?(
    blobs: OutputReader,
    done: { outputs: PublishedOutput[]; result: Record<string, unknown> },
  ): Promise<void>
  /** In the complete transaction, under the lease: check `result`, write the kind's rows. Throws OpRefused to refuse. */
  complete(
    tx: Queryable,
    op: LockedOp,
    done: { outputs: PublishedOutput[]; result: Record<string, unknown>; now: Date },
  ): Promise<OpCompletion>
}

const notYet = () => new OpRefused(501, 'NOT_IMPLEMENTED', 'This op kind is not ready yet.')

/** The foundation's handler of a kind its owner has not landed: refuses everything (501). */
export const stubKind = (kind: WorkerOpKind): OpKindHandler => ({
  kind,
  async checkOutput() {
    throw notYet()
  },
  async acceptText() {
    throw notYet()
  },
  async complete() {
    throw notYet()
  },
})

/**
 * Every kind's handler (each workstream swaps its stub for its own, one line). Getters: each kind's module imports this
 * one (OpRefused, the types), so whichever of the two loads first, a binding is read only once both have run.
 */
export const OP_KINDS: Readonly<Record<WorkerOpKind, OpKindHandler>> = {
  // WS2: features/formats/remove-bg/kind.ts
  get 'remove-bg'() {
    return removeBgKind
  },
  // WS3: features/search/file-text-kind.ts
  get 'extract-text'() {
    return extractTextKind
  },
  // WS4: features/formats/deck/kind.ts
  get 'render-pages'() {
    return renderPagesKind
  },
}
