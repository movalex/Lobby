// Wave W (docs/WAVE-W-CONTRACTS.md §3.5): one worker op, from claim to complete. OWNER: the wave W lead. The preview loop
// (remote-loop.ts) calls `runOneOp` only when its preview claim came back empty, in the same slot, so previews keep
// priority and ops share WORKER_CONCURRENCY with them.
//
//   claim (capabilities) → a temp dir → heartbeats every leaseMs/4 (≤ 30 s) → the kind's runner → complete
//   - the runner throws OpFailure: fail with its code (retry when it says transient);
//   - anything else thrown: fail INTERNAL (retry: a crash may be the machine, not the file);
//   - the lease is lost (409/404 on a heartbeat or a call): the runner is aborted, nothing more is sent;
//   - the worker shuts down past its grace: the runner is aborted and the op released (attempt not counted).
// Never logs a URL, a header, a body, a file name or a param: an op id, its kind and an error code at most.

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_OP_ERROR_CODES, type WorkerOpErrorCode } from '@draftroom/contracts'
import { type WorkerApi, WorkerApiError } from '../api-client.ts'
import { WORKER } from '../config.ts'
import { TMP_PREFIX } from '../remote-job.ts'
import type { ClaimedOp, OpLease, WorkerOpsApi } from './client.ts'
import { OP_RUNNERS, OpFailure, type OpRunner } from './dispatch.ts'

export interface RunOpOptions {
  ops: WorkerOpsApi
  api: WorkerApi
  capabilities: readonly string[]
  runners?: Readonly<Partial<Record<string, OpRunner>>>
  tmpDir: string
  /** the worker's shutdown (after its grace): abort and release */
  signal: AbortSignal
  heartbeatMs?: number
  log(line: string): void
}

export type RunOpOutcome =
  | { kind: 'none' }
  | { kind: 'unsupported' }
  | { kind: 'done'; opId: string }
  | { kind: 'failed'; opId: string; code: string }
  | { kind: 'lease-lost'; opId: string }
  | { kind: 'released'; opId: string }

const beatEvery = (leaseMs: number, override?: number) =>
  override ?? Math.max(WORKER.heartbeatMinMs, Math.min(WORKER.heartbeatMaxMs, Math.floor(leaseMs / 4)))

const isLease = (e: unknown) => e instanceof WorkerApiError && e.kind === 'lease'

/**
 * WS2: the api refused a lease-bound call (complete, output) with an op code users know (a remove-bg complete that
 * found no quota room left: 409 QUOTA_EXCEEDED; a board no longer active: 409 CANCELLED): the op fails with that code
 * at once, rather than retrying work the api will refuse again.
 */
const refusedWith = (e: unknown): OpFailure | null =>
  e instanceof WorkerApiError &&
  e.kind === 'rejected' &&
  (WORKER_OP_ERROR_CODES as readonly string[]).includes(e.code)
    ? new OpFailure(e.code as WorkerOpErrorCode)
    : null

/** Claims one op for `capabilities` and runs it to the end. */
export async function runOneOp(o: RunOpOptions): Promise<RunOpOutcome> {
  if (!o.capabilities.length) return { kind: 'none' }
  const claimed = await o.ops.claim(o.capabilities, o.signal)
  if (claimed === 'unsupported') return { kind: 'unsupported' }
  if (!claimed) return { kind: 'none' }
  return runClaimedOp(claimed, o)
}

export async function runClaimedOp(op: ClaimedOp, o: RunOpOptions): Promise<RunOpOutcome> {
  const lease: OpLease = { opId: op.id, attempt: op.attempt }
  const runners = o.runners ?? OP_RUNNERS
  const runner = runners[op.kind]
  const lost = new AbortController()
  const signal = AbortSignal.any([o.signal, lost.signal])
  o.log(`${op.id} claimed (${op.kind}, attempt ${op.attempt})`)
  if (!runner) {
    // the api gave us a kind we did not report (it never should): hand it back at once
    await o.ops.fail(lease, 'INTERNAL', { release: true }).catch(() => {})
    return { kind: 'released', opId: op.id }
  }
  const beat = setInterval(
    () => {
      o.ops.heartbeat(lease, signal).catch((e) => {
        if (isLease(e)) lost.abort('lease lost')
      })
    },
    beatEvery(op.leaseMs, o.heartbeatMs),
  )
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(o.tmpDir, TMP_PREFIX))
    const result = await runner.run({ op, lease, ops: o.ops, api: o.api, tmpDir: dir, signal, log: o.log })
    if (lost.signal.aborted) return { kind: 'lease-lost', opId: op.id }
    await o.ops.complete(lease, result.outputs, result.result, o.signal)
    o.log(`${op.id} done`)
    return { kind: 'done', opId: op.id }
  } catch (e) {
    if (lost.signal.aborted || isLease(e)) return { kind: 'lease-lost', opId: op.id }
    if (o.signal.aborted) {
      await o.ops.fail(lease, 'INTERNAL', { release: true }).catch(() => {})
      return { kind: 'released', opId: op.id }
    }
    const failure = e instanceof OpFailure ? e : (refusedWith(e) ?? new OpFailure('INTERNAL', true))
    o.log(`${op.id} failed (${failure.code}${failure.retry ? ', will retry' : ''})`)
    await o.ops.fail(lease, failure.code, failure.retry ? { retry: true } : {}).catch(() => {})
    return { kind: 'failed', opId: op.id, code: failure.code }
  } finally {
    clearInterval(beat)
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}
