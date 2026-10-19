// Wave W, WS2 (docs/WAVE-W-CONTRACTS.md §4.1 step 2): the `remove-bg` op runner. OWNER: WS2.
//
//   the claimed op's source (an image the api checked) → download it with the transfer.ts caps (its exact size)
//   → `node --max-old-space-size=256 bg-child.ts` (a request JSON on stdin, the minimal env, a 45 s SIGKILL, 64 KB of
//     stdout, and on Linux a REMOVE_BG_LIMITS.childRssMb resident-memory SIGKILL, run.ts): decode, the model, the mask
//     as alpha, a PNG RGBA written to this op's temp dir. Killed over its memory cap, or dead without an answer:
//     FILE_TOO_COMPLEX, never retried (the same rule as extract-text and render-pages)
//   → re-read that PNG here (the child parsed hostile input, so its output is checked, never trusted)
//   → reserve one `original` output, PUT the bytes, and hand complete `RemoveBgResult {sha256, width, height, bytes}`.
//
// The model runs ONLY in the child (ops/bg-inference.ts createOrtInference is reached from bg-child.ts alone): a native
// crash or an out-of-memory there takes the child down, never this worker. The model file is never downloaded: its path
// is DRAFTROOM_BG_MODEL_PATH (absolute) and the child re-checks it against BG_MODEL.sha256 (null until the owner's
// approved file: then this runner never runs, because the capability is never reported, ops/capabilities.ts).
//
// Logging: an op id, a code and a timing at most; never the file's name, a URL, a path or the child's stderr.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REMOVE_BG_LIMITS, type WorkerOpErrorCode } from '@draftroom/contracts'
import { WORKER } from '../config.ts'
import { lockedSharp } from '../image.ts'
import { type RssReader, run } from '../run.ts'
import { downloadOriginal, TransferError, uploadBlob } from '../transfer.ts'
import { BG_MODEL } from './bg-model.ts'
// Types only: dispatch.ts registers this runner (its OP_RUNNERS imports this module), so a value import back would be
// a cycle; OpFailure is loaded when a run needs it (failure() below).
import type { OpRunContext, OpRunner, OpRunResult } from './dispatch.ts'

export const BG_CHILD = fileURLToPath(new URL('./bg-child.ts', import.meta.url))

/** What the child reads on stdin (bg-child.ts). Paths are this op's temp dir and the configured model file only. */
export interface BgChildRequest {
  input: string
  output: string
  modelPath: string
  /** the pinned hash the child re-checks the model's bytes against (BG_MODEL.sha256; tests pass the tiny model's) */
  modelSha256: string | null
  /** the model's square input (u2netp: 320) */
  size: number
  maxInputPixels: number
  maxInputEdge: number
  maxOutputEdge: number
  /** libvips' own budget for each decode or encode, in seconds */
  sharpTimeoutSeconds: number
}

/** The child's one answer on stdout. `reason` is a fixed word; `name` an error class name at most (for the log). */
export type BgChildResponse =
  | { ok: true; width: number; height: number; coverage: number; ms: { model: number; total: number } }
  | {
      ok: false
      reason: 'unsupported' | 'animated' | 'too_large' | 'invalid' | 'model' | 'empty'
      name?: string
    }

export interface RemoveBgOptions {
  /** DRAFTROOM_BG_MODEL_PATH, read when an op runs (default: the environment's) */
  modelPath?: () => string | null | undefined
  /** the hash the model must have (default BG_MODEL.sha256: null = nothing passes) */
  modelSha256?: string | null
  /** test hooks: another child entry (one that hangs, crashes or runs out of heap), its heap and time budget */
  childPath?: string
  heapMb?: number
  /** the child's resident-memory cap in MB (default REMOVE_BG_LIMITS.childRssMb; Linux only, run.ts) */
  rssMb?: number
  /** test hook: run.ts's resident-set reader (lets the memory kill run off Linux too) */
  readRss?: RssReader | null
  timeoutMs?: number
  downloadStallMs?: number
  downloadTimeoutMs?: number
  uploadTimeoutMs?: number
}

const PNG_NAME = 'no-background.png'
const SOURCE_NAME = 'source'

/** A failure as the op ends with it (dispatch.ts OpFailure, loaded lazily: see the import above). */
async function failure(code: WorkerOpErrorCode, retry = false): Promise<Error> {
  const { OpFailure } = await import('./dispatch.ts')
  return new OpFailure(code, retry)
}

/** The child's refusal as the code users see (contracts WORKER_OP_MESSAGES). */
export function childFailureCode(
  reason: Exclude<BgChildResponse, { ok: true }>['reason'],
): WorkerOpErrorCode {
  switch (reason) {
    case 'unsupported':
    case 'animated':
      return 'SOURCE_UNSUPPORTED'
    case 'too_large':
      return 'IMAGE_TOO_LARGE'
    case 'model':
      return 'WORKER_UNAVAILABLE'
    default:
      return 'REMOVE_BG_FAILED'
  }
}

export function createRemoveBgRunner(o: RemoveBgOptions = {}): OpRunner {
  const modelPath = o.modelPath ?? (() => process.env.DRAFTROOM_BG_MODEL_PATH)
  const modelSha256 = o.modelSha256 === undefined ? BG_MODEL.sha256 : o.modelSha256
  return {
    kind: 'remove-bg',
    async run(ctx: OpRunContext): Promise<OpRunResult> {
      const { op, signal } = ctx
      const t0 = Date.now()
      // the api checked all of this at the request; a claim that says otherwise is refused, not guessed at
      if (op.source.kind !== 'image' || !REMOVE_BG_LIMITS.inputMimeTypes.includes(op.source.mimeType))
        throw await failure('SOURCE_UNSUPPORTED')
      if (op.source.sizeBytes < 1 || op.source.sizeBytes > REMOVE_BG_LIMITS.maxInputBytes)
        throw await failure('IMAGE_TOO_LARGE')
      const path = modelPath()
      if (!path) throw await failure('WORKER_UNAVAILABLE')

      const input = join(ctx.tmpDir, SOURCE_NAME)
      const output = join(ctx.tmpDir, PNG_NAME)
      try {
        await downloadOriginal(ctx.api, op.original, input, {
          bytes: op.source.sizeBytes,
          timeoutMs:
            o.downloadTimeoutMs ??
            WORKER.downloadBaseMs + Math.ceil(op.source.sizeBytes / 1_048_576) * WORKER.downloadMsPerMb,
          stallMs: o.downloadStallMs ?? WORKER.downloadStallMs,
          signal,
        })
      } catch (e) {
        if (e instanceof TransferError) {
          if (e.kind === 'aborted') throw e
          if (e.kind === 'missing') throw await failure('SOURCE_MISSING')
          throw await failure('INTERNAL', true)
        }
        throw e
      }

      const req: BgChildRequest = {
        input,
        output,
        modelPath: path,
        modelSha256,
        size: REMOVE_BG_LIMITS.modelSize,
        maxInputPixels: REMOVE_BG_LIMITS.maxInputPixels,
        maxInputEdge: REMOVE_BG_LIMITS.maxInputEdge,
        maxOutputEdge: REMOVE_BG_LIMITS.maxOutputEdge,
        sharpTimeoutSeconds: 20,
      }
      const rssMb = o.rssMb ?? REMOVE_BG_LIMITS.childRssMb
      const r = await run(
        process.execPath,
        [`--max-old-space-size=${o.heapMb ?? REMOVE_BG_LIMITS.childHeapMb}`, o.childPath ?? BG_CHILD],
        {
          timeoutMs: o.timeoutMs ?? REMOVE_BG_LIMITS.childTimeoutMs,
          maxStdoutBytes: 64 * 1024,
          stdin: JSON.stringify(req),
          signal,
          maxRssBytes: rssMb * 1024 * 1024,
          ...(o.readRss !== undefined ? { readRss: o.readRss } : {}),
        },
      )
      if (r.aborted) throw new Error('aborted')
      if (r.timedOut) throw await failure('TIMEOUT')
      // a spawn error is this machine (the executable, a pid limit), not the file: tried again
      if (r.spawnError) throw await failure('INTERNAL', true)
      // Review M3/m8, the same rule for every op kind: a child killed over its resident-memory cap, or one that died
      // with no answer (a native abort, a V8 heap out of memory, the kernel's OOM killer), is FILE_TOO_COMPLEX, final:
      // the same file would do it again.
      if (r.memoryExceeded) {
        ctx.log(`${op.id} remove-bg child over its ${rssMb} MB memory cap, killed`)
        throw await failure('FILE_TOO_COMPLEX')
      }
      let res: BgChildResponse
      try {
        res = JSON.parse(r.stdout.toString('utf8')) as BgChildResponse
      } catch {
        ctx.log(`${op.id} remove-bg child gave no answer (exit ${r.code ?? r.signal})`)
        throw await failure('FILE_TOO_COMPLEX')
      }
      if (!res || typeof res !== 'object') throw await failure('REMOVE_BG_FAILED')
      if (!res.ok) throw await failure(childFailureCode(res.reason))

      const png = await checkedPng(output, res).catch(async () => {
        throw await failure('REMOVE_BG_FAILED')
      })
      const sha256 = createHash('sha256').update(png.bytes).digest('hex')
      const reservation = await ctx.ops.output(
        ctx.lease,
        {
          role: 'original',
          mimeType: 'image/png',
          width: png.width,
          height: png.height,
          bytes: png.bytes.length,
        },
        signal,
      )
      try {
        await uploadBlob(ctx.api, reservation.upload, png.bytes, {
          timeoutMs: o.uploadTimeoutMs ?? WORKER.uploadTimeoutMs,
          signal,
        })
      } catch (e) {
        if (e instanceof TransferError && e.kind === 'aborted') throw e
        throw await failure('INTERNAL', true)
      }
      ctx.log(`${op.id} remove-bg ${png.width}x${png.height} in ${Date.now() - t0} ms`)
      // contracts RemoveBgResult (the api's completer checks it against the reserved output)
      const result = { sha256, width: png.width, height: png.height, bytes: png.bytes.length }
      return { outputs: [reservation.outputId], result }
    },
  }
}

/** The child's PNG, read back: a PNG with an alpha channel, the size it said, within the output limits. */
export async function checkedPng(
  path: string,
  said: { width: number; height: number },
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const bytes = await readFile(path)
  if (bytes.length < 1 || bytes.length > REMOVE_BG_LIMITS.maxOutputBytes) throw new Error('output size')
  const meta = await lockedSharp()(bytes, {
    limitInputPixels: REMOVE_BG_LIMITS.maxOutputEdge ** 2,
  }).metadata()
  if (meta.format !== 'png' || meta.channels !== 4 || !meta.hasAlpha)
    throw new Error('output is not RGBA PNG')
  const { width, height } = meta
  if (width !== said.width || height !== said.height) throw new Error('output size differs')
  if (
    width < 1 ||
    height < 1 ||
    width > REMOVE_BG_LIMITS.maxOutputEdge ||
    height > REMOVE_BG_LIMITS.maxOutputEdge
  )
    throw new Error('output edge')
  return { bytes, width, height }
}

/** The runner this worker build registers (ops/dispatch.ts OP_RUNNERS). */
export const removeBgRunner: OpRunner = createRemoveBgRunner()
