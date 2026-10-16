// Photoshop previews (wave R, docs/WAVE-R-CONTRACTS.md §6): the flattened composite as one page, read by psd-child.ts
// (ag-psd) in a separate Node process with a heap cap and a SIGKILL timeout. The header is checked here first, from 26
// bytes, so an oversized, PSB, 16-bit or CMYK file never starts a child. The page is a flattened preview: layers are
// never rendered, and the download is always the original.
//
// Without a real composite (saved without "Maximize Compatibility") the child hands back the file's embedded thumbnail
// instead; it becomes the cover only (a `thumb`, no `page` derivative), which is how the file card knows to say
// "Low-resolution preview".
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DerivativeRecord } from '@draftroom/dev-assets'
import { PREVIEW } from './config.ts'
import type { DerivativeWriter } from './derivatives.ts'
import { AbortedError, type FailureCode, PreviewError, TransientError } from './errors.ts'
import type { Derived } from './image.ts'
import { lockedSharp, toWebp } from './image.ts'
import {
  checkPsdHeader,
  PSD_HEADER_BYTES,
  PSD_LIMITS,
  type PsdChildRequest,
  type PsdChildResponse,
  type PsdRefusal,
  psdPageFileName,
} from './psd-protocol.ts'
import { run, stderrTail } from './run.ts'

export const PSD_CHILD = fileURLToPath(new URL('./psd-child.ts', import.meta.url))

export interface PsdOptions {
  timeoutMs?: number
  /** Test hook: a different child entry (e.g. one that hangs or crashes). */
  childPath?: string
  /** V8 heap cap of the child in MB; default PSD_LIMITS.childHeapMb. */
  heapMb?: number
  signal?: AbortSignal
}

const CODE: Record<PsdRefusal, FailureCode> = {
  invalid: 'IMAGE_INVALID',
  unsupported: 'PSD_UNSUPPORTED',
  too_large: 'DESIGN_TOO_LARGE',
  no_composite: 'PSD_NO_COMPOSITE',
}

async function readHead(path: string): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(PSD_HEADER_BYTES)
    const { bytesRead } = await fh.read(buf, 0, PSD_HEADER_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

export async function derivePsd(
  input: string,
  writer: DerivativeWriter,
  opts: PsdOptions = {},
): Promise<Derived> {
  const limits = { maxPixels: PSD_LIMITS.maxPixels, maxSide: PSD_LIMITS.maxSide }
  const head = checkPsdHeader(await readHead(input), limits)
  if (!head.ok) throw new PreviewError(CODE[head.reason], head.detail)
  const { width, height } = head.value

  const outDir = await writer.makeTempDir()
  const req: PsdChildRequest = {
    input,
    outDir,
    maxEdge: PREVIEW.displayEdge,
    quality: PREVIEW.pageQuality,
    ...limits,
    maxLayerRecords: PSD_LIMITS.maxLayerRecords,
  }
  const r = await run(
    process.execPath,
    [`--max-old-space-size=${opts.heapMb ?? PSD_LIMITS.childHeapMb}`, opts.childPath ?? PSD_CHILD],
    {
      timeoutMs: opts.timeoutMs ?? PSD_LIMITS.timeoutMs,
      maxStdoutBytes: 16 * 1024,
      stdin: JSON.stringify(req),
      signal: opts.signal,
    },
  )
  if (r.aborted) throw new AbortedError()
  if (r.timedOut) throw new PreviewError('TIMEOUT', `psd child killed after ${r.ms} ms`)
  if (r.spawnError) throw new TransientError(`psd child spawn failed: ${r.spawnError}`)
  let res: PsdChildResponse
  try {
    res = JSON.parse(r.stdout.toString('utf8')) as PsdChildResponse
  } catch {
    // No response: the child crashed (native abort, out of memory) or was killed from outside.
    throw new TransientError(
      `psd child exited code=${r.code} signal=${r.signal} ${stderrTail(r.stderr)}`.trim(),
    )
  }
  if (!res.ok) throw new PreviewError(CODE[res.reason] ?? 'IMAGE_INVALID', res.detail)

  // The child parsed hostile input, so its output is re-checked rather than trusted: a fixed file name, the
  // dimensions read back from the file itself.
  const src = join(outDir, psdPageFileName)
  const bytes = await readFile(src)
  const meta = await lockedSharp()(bytes).metadata()
  if (meta.format !== 'webp') throw new PreviewError('IMAGE_INVALID', `page output is ${meta.format}`)
  const derivatives: DerivativeRecord[] = []
  const probe = { pageCount: 1, width, height }
  const file = { page: 1, src, bytes: bytes.length, width: meta.width, height: meta.height }
  if (!res.composite) {
    derivatives.push(await writer.adopt({ role: 'thumb', ...file }))
    return { probe, derivatives }
  }
  derivatives.push(await writer.adopt({ role: 'page', ...file }))
  const thumb = await toWebp(bytes, PREVIEW.thumbEdge, PREVIEW.thumbQuality)
  derivatives.push(await writer.write({ role: 'thumb', page: 1, ...thumb }))
  return { probe, derivatives }
}
