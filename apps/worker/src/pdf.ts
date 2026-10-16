// PDF previews: pages 1..min(pageCount, LIMITS.eagerPdfPages) rendered by pdf-child.ts in a separate
// Node process with a heap cap and a SIGKILL timeout; the worker only turns page 1 into the thumb.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DerivativeRecord, LIMITS } from '@draftroom/dev-assets'
import { PREVIEW } from './config.ts'
import type { DerivativeWriter } from './derivatives.ts'
import { AbortedError, PreviewError, TransientError } from './errors.ts'
import type { Derived } from './image.ts'
import { lockedSharp, toWebp } from './image.ts'
import { type PdfChildRequest, type PdfChildResponse, pageFileName } from './pdf-protocol.ts'
import { run, stderrTail } from './run.ts'

export const PDF_CHILD = fileURLToPath(new URL('./pdf-child.ts', import.meta.url))

export interface PdfOptions {
  timeoutMs?: number
  /** Test hook: a different child entry (e.g. one that hangs or crashes). */
  childPath?: string
  /** V8 heap cap of the child in MB (WORKER_PDF_HEAP_MB); default PREVIEW.pdfChildHeapMb. */
  heapMb?: number
  signal?: AbortSignal
  /** Refuse Illustrator's "saved without PDF Content" stub (NO_PDF_CONTENT): uploaded PDFs and .ai files. */
  noPdfContentCheck?: boolean
}

export async function derivePdf(
  input: string,
  writer: DerivativeWriter,
  opts: PdfOptions = {},
): Promise<Derived> {
  const outDir = await writer.makeTempDir()
  const req: PdfChildRequest = {
    input,
    outDir,
    pages: LIMITS.eagerPdfPages,
    pageWidth: PREVIEW.pdfPageWidth,
    maxEdge: PREVIEW.pdfMaxEdge,
    quality: PREVIEW.pageQuality,
    maxPages: LIMITS.maxPdfPages,
    maxImagePixels: PREVIEW.pdfEmbeddedImagePixels,
    noPdfContentCheck: opts.noPdfContentCheck === true,
  }
  // One budget for the whole child run (import + load + every eager page).
  const timeoutMs = opts.timeoutMs ?? LIMITS.jobTimeoutMs
  const r = await run(
    process.execPath,
    [`--max-old-space-size=${opts.heapMb ?? PREVIEW.pdfChildHeapMb}`, opts.childPath ?? PDF_CHILD],
    { timeoutMs, maxStdoutBytes: 64 * 1024, stdin: JSON.stringify(req), signal: opts.signal },
  )
  if (r.aborted) throw new AbortedError()
  if (r.timedOut) throw new PreviewError('TIMEOUT', `pdf child killed after ${r.ms} ms`)
  if (r.spawnError) throw new TransientError(`pdf child spawn failed: ${r.spawnError}`)
  let res: PdfChildResponse
  try {
    res = JSON.parse(r.stdout.toString('utf8')) as PdfChildResponse
  } catch {
    // No response: the child crashed (native abort, OOM) or was killed from outside.
    throw new TransientError(
      `pdf child exited code=${r.code} signal=${r.signal} ${stderrTail(r.stderr)}`.trim(),
    )
  }
  if (!res.ok) {
    if (res.reason === 'encrypted') throw new PreviewError('PDF_ENCRYPTED', res.name)
    if (res.reason === 'no_pdf_content') throw new PreviewError('NO_PDF_CONTENT', res.name)
    if (res.reason === 'too_many_pages') {
      throw new PreviewError('PDF_TOO_MANY_PAGES', `${res.pageCount} pages`, {
        pageCount: res.pageCount ?? null,
      })
    }
    throw new PreviewError('PDF_INVALID', res.name)
  }
  const pageCount = res.pageCount
  const expected = Math.min(pageCount, LIMITS.eagerPdfPages)
  if (!Number.isInteger(pageCount) || pageCount < 1 || res.rendered.length !== expected) {
    throw new PreviewError('PDF_INVALID', `child rendered ${res.rendered.length}/${expected} pages`)
  }
  // The child parsed hostile input, so its output is re-checked here rather than trusted: fixed
  // file names from page numbers we asked for, dimensions read back from the files themselves.
  const sharp = lockedSharp()
  const derivatives: DerivativeRecord[] = []
  for (let n = 1; n <= expected; n++) {
    const src = join(outDir, pageFileName(n))
    const bytes = await readFile(src)
    const meta = await sharp(bytes).metadata()
    if (meta.format !== 'webp') throw new PreviewError('PDF_INVALID', `page ${n} output is ${meta.format}`)
    derivatives.push(
      await writer.adopt({
        role: 'page',
        page: n,
        src,
        bytes: bytes.length,
        width: meta.width,
        height: meta.height,
      }),
    )
    if (n === 1) {
      const thumb = await toWebp(bytes, PREVIEW.thumbEdge, PREVIEW.thumbQuality)
      derivatives.push(await writer.write({ role: 'thumb', page: 1, ...thumb }))
    }
  }
  return { probe: { pageCount }, derivatives }
}
