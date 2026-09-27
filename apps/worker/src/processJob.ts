// One preview job, end to end. Idempotent per versionId (+ PREVIEW_PROFILE): a version that is
// already `ready` with its derivatives on disk, or already `failed`, is finished without changes.
// Only the claim holder writes meta.json after upload, so plain read-modify-write is safe.
import { readFile, stat } from 'node:fs/promises'
import {
  type AssetVersionMeta,
  type ClaimedJob,
  type DataLayout,
  finishJob,
  LIMITS,
  originalPath,
  type ProbeFacts,
  readMeta,
  touchJob,
  updateMeta,
} from '@draftroom/dev-assets'
import { WORKER } from './config.ts'
import {
  createDerivativeWriter,
  type DerivativeWriter,
  derivativesPresent,
  removeUnreferenced,
} from './derivatives.ts'
import {
  AbortedError,
  type FailureCode,
  PreviewError,
  TransientError,
  throwIfAborted,
  userMessage,
} from './errors.ts'
import { type Derived, deriveImage } from './image.ts'
import { derivePdf } from './pdf.ts'
import { releaseJob } from './queue.ts'
import { confirmKind, sniffFile } from './sniff.ts'
import { deriveVideo } from './video.ts'

export interface ProcessOptions {
  ffmpegPath?: string
  ffprobePath?: string
  pdfTimeoutMs?: number
  probeTimeoutMs?: number
  posterTimeoutMs?: number
  /** Test hook: replacement pdf child entry point. */
  pdfChildPath?: string
  heartbeatMs?: number
  /** Aborting kills running children and releases the job back to the queue (worker shutdown). */
  signal?: AbortSignal
  log?: (line: string) => void
}

export type JobOutcome =
  | { result: 'done'; status: 'ready'; skipped: boolean }
  | { result: 'failed'; status: 'failed'; code: string }
  | { result: 'retry'; status: 'queued'; detail: string }
  | { result: 'released'; status: 'queued' }
  | { result: 'dropped' }

const EMPTY_PROBE: ProbeFacts = {
  width: null,
  height: null,
  pageCount: null,
  durationMs: null,
  videoCodec: null,
  audioCodec: null,
}

function probeFacts(p: Record<string, unknown>): ProbeFacts {
  const out = { ...EMPTY_PROBE }
  for (const k of Object.keys(EMPTY_PROBE) as (keyof ProbeFacts)[]) {
    const v = p[k]
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

const INVALID_EMPTY: Record<AssetVersionMeta['kind'], FailureCode | null> = {
  image: 'IMAGE_INVALID',
  pdf: 'PDF_INVALID',
  video: 'VIDEO_INVALID',
  other: null,
}

async function derive(
  meta: AssetVersionMeta,
  path: string,
  writer: DerivativeWriter,
  opts: ProcessOptions,
): Promise<Derived & { mimeType: string | null }> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    throw new PreviewError('FILE_MISSING')
  }
  if (size > LIMITS.maxBytes[meta.kind]) throw new PreviewError('FILE_TOO_LARGE', `${size} bytes`)
  if (meta.kind === 'other') return { probe: {}, derivatives: [], mimeType: null }
  const empty = INVALID_EMPTY[meta.kind]
  if (size === 0 && empty) throw new PreviewError(empty, 'empty file')
  const mimeType = confirmKind(meta.kind, await sniffFile(path))
  throwIfAborted(opts.signal)
  switch (meta.kind) {
    case 'image':
      return { ...(await deriveImage(await readFile(path), writer)), mimeType }
    case 'pdf':
      return {
        ...(await derivePdf(path, writer, {
          timeoutMs: opts.pdfTimeoutMs,
          childPath: opts.pdfChildPath,
          signal: opts.signal,
        })),
        mimeType,
      }
    case 'video':
      return { ...(await deriveVideo(path, writer, opts)), mimeType }
  }
}

export async function processJob(
  l: DataLayout,
  claim: ClaimedJob,
  opts: ProcessOptions = {},
): Promise<JobOutcome> {
  const { assetId, versionId } = claim.job
  const log = opts.log ?? (() => {})
  const heartbeat = setInterval(() => touchJob(claim), opts.heartbeatMs ?? WORKER.heartbeatMs)
  try {
    let current: AssetVersionMeta | null
    try {
      current = readMeta(l, assetId, versionId)
    } catch {
      current = null // unreadable meta.json: nothing this worker can safely update
    }
    if (!current || current.assetId !== assetId || current.versionId !== versionId) {
      finishJob(l, claim, 'failed')
      log(`${versionId} dropped: no matching meta.json`)
      return { result: 'dropped' }
    }
    if (current.status === 'ready' && derivativesPresent(l, current)) {
      finishJob(l, claim, 'done')
      return { result: 'done', status: 'ready', skipped: true }
    }
    if (current.status === 'failed') {
      finishJob(l, claim, 'failed')
      return { result: 'failed', status: 'failed', code: current.error?.code ?? 'INTERNAL' }
    }
    // Poison-pill guard: attempts that crashed the whole worker are counted here too (the counter
    // is bumped before work starts), so a file that kills the process cannot loop forever.
    if (current.attempts >= LIMITS.maxAttempts) {
      return fail(l, claim, new PreviewError('INTERNAL', `gave up after ${current.attempts} attempts`), log)
    }
    const meta = updateMeta(l, assetId, versionId, (m) => ({
      ...m,
      status: 'processing',
      attempts: m.attempts + 1,
      error: null,
    }))
    const writer = createDerivativeWriter(l, assetId, versionId)
    const t0 = Date.now()
    let out: Awaited<ReturnType<typeof derive>>
    try {
      out = await derive(meta, originalPath(l, assetId, versionId), writer, opts)
    } catch (e) {
      await writer.discard()
      if (e instanceof AbortedError || opts.signal?.aborted) {
        // Shutdown: this attempt does not count against the job.
        updateMeta(l, assetId, versionId, (m) => ({
          ...m,
          status: 'queued',
          attempts: Math.max(0, m.attempts - 1),
        }))
        releaseJob(l, claim, claim.job.attempt)
        log(`${versionId} released (worker stopping)`)
        return { result: 'released', status: 'queued' }
      }
      if (e instanceof PreviewError) return fail(l, claim, e, log)
      // Anything else (child crash, missing tool, filesystem trouble) may be transient.
      const detail = e instanceof TransientError ? e.detail : String((e as Error)?.name ?? 'Error')
      if (meta.attempts >= LIMITS.maxAttempts) {
        return fail(l, claim, new PreviewError('INTERNAL', `attempt ${meta.attempts}: ${detail}`), log)
      }
      updateMeta(l, assetId, versionId, (m) => ({ ...m, status: 'queued' }))
      releaseJob(l, claim, claim.job.attempt + 1)
      log(`${versionId} attempt ${meta.attempts} failed, will retry: ${detail}`)
      return { result: 'retry', status: 'queued', detail }
    }
    // Outside the try on purpose: once meta references the files, nothing may discard them. If a
    // step below throws, the claim stays in processing/, is requeued when stale, and the rerun
    // short-circuits (ready + derivatives present) or cleans up.
    // Derivative files are already renamed into place; only now does meta reference them.
    const ready = updateMeta(l, assetId, versionId, (m) => ({
      ...m,
      status: 'ready',
      mimeType: out.mimeType ?? m.mimeType,
      error: null,
      probe: probeFacts(out.probe),
      derivatives: out.derivatives,
    }))
    removeUnreferenced(l, ready)
    finishJob(l, claim, 'done')
    log(`${versionId} ${meta.kind} ready in ${Date.now() - t0} ms (${out.derivatives.length} derivatives)`)
    return { result: 'done', status: 'ready', skipped: false }
  } finally {
    clearInterval(heartbeat)
  }
}

function fail(l: DataLayout, claim: ClaimedJob, e: PreviewError, log: (s: string) => void): JobOutcome {
  const { assetId, versionId } = claim.job
  const failed = updateMeta(l, assetId, versionId, (m) => ({
    ...m,
    status: 'failed',
    error: { code: e.code, message: userMessage(e.code) },
    probe: probeFacts(e.probe),
    derivatives: [],
  }))
  removeUnreferenced(l, failed)
  finishJob(l, claim, 'failed')
  log(`${versionId} failed ${e.code}${e.detail ? ` (${e.detail})` : ''}`)
  return { result: 'failed', status: 'failed', code: e.code }
}
