// Wave W (WS4, deck import; docs/WAVE-W-CONTRACTS.md §6): the `render-pages` op runner. A preview job renders a deck's
// pages 1..8 (dev-assets LIMITS.eagerPdfPages); "Insert as slides" on a longer deck asks the api for its pages
// 9..min(N, 100) in runs of at most 30 (contracts deckRenderRuns), one op per run, and this runner renders one run:
//
//   refuse a size no deck may have (before any download) → download the original (transfer.ts caps) → Office?
//   convert it to PDF through the same converter as previews (the no-network sidecar on the NAS), ONCE per source
//   version for all its runs and its extract-text op (below) → the existing pdf-child.ts renders pages from..to at the
//   SAME width and quality as a preview's pages (1024 px webp, the `page` role: the loader and a 7e5b4d6 web read them
//   unchanged), under a heap flag AND a resident-memory cap (Linux, run.ts) → each page re-read with sharp (the child
//   parsed hostile input: its output is checked, not trusted) → reserved as a `page` output and PUT → complete with
//   RenderPagesResult {pageCount, rendered}.
//
// One conversion per deck (review M2): a 100-slide deck is four runs, and each used to convert the PPTX again (up to
// 120 s of the one-at-a-time sidecar each). The converted PDF now goes to the worker's short-lived cache keyed by the
// source version id (ops/office-pdf-cache.ts: 20 min from last use, 4 entries and 512 MB, in-flight de-duplication,
// failures never cached), shared with extract-text. Not a stored conversion from the preview: the preview pipeline
// keeps none (office.ts deriveOffice converts into its job's temp dir and stores only the rendered pages), and storing
// one would be a new artefact with its own api, quota and GC.
//
// A page the api already has (its `page` derivative exists: a run made earlier, or by another op) is refused at
// reservation with 409 PAGE_EXISTS and skipped here, so a re-run renders only what is missing and never duplicates a
// page (the api's completer also skips such pages under the version's row lock: there is no unique index).
//
// Failures as users see them (contracts WORKER_OP_MESSAGES): a file that is not a PDF or a presentation the converter
// takes → SOURCE_UNSUPPORTED; the original gone → SOURCE_MISSING; more pages than LIMITS.maxPdfPages → TOO_MANY_PAGES;
// the child killed at its budget → TIMEOUT; the child killed over its memory cap, or dead with no answer (a native abort,
// a V8 heap out of memory) → FILE_TOO_COMPLEX, never retried (the same rule as extract-text and remove-bg: the same file
// would do it again); anything else the file itself breaks → RENDER_PAGES_FAILED; a child that cannot be started, a
// network or storage hiccup → RENDER_PAGES_FAILED with a retry (attempts are capped by the api). Logs carry an op id and
// a code or reason, never a name, a path or a URL.

import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RenderPagesParams, type WorkerOpErrorCode } from '@draftroom/contracts'
import { LIMITS, maxKindBytes, type OfficeFormat } from '@draftroom/dev-assets'
import { WorkerApiError } from '../api-client.ts'
import { PREVIEW, WORKER } from '../config.ts'
import { AbortedError, PreviewError, TransientError } from '../errors.ts'
import { lockedSharp } from '../image.ts'
import { type OfficeConverter, officeInput, officeOff } from '../office.ts'
import { PDF_CHILD } from '../pdf.ts'
import { type PdfChildRequest, type PdfChildResponse, pageFileName } from '../pdf-protocol.ts'
import { type RssReader, run } from '../run.ts'
import { confirmKind, contentByteLimit, sniffFile } from '../sniff.ts'
import { downloadOriginal, TransferError, uploadBlob } from '../transfer.ts'
import { OpFailure, type OpRunContext, type OpRunner, type OpRunResult } from './dispatch.ts'
import type { OfficePdfCache } from './office-pdf-cache.ts'

/** What the runner needs beyond its op context (worker.ts sets them once at start: configureRenderPages). */
export interface RenderPagesDeps {
  /** The previews' Office converter (absent or off: an Office deck fails WORKER_UNAVAILABLE, a PDF still renders). */
  office?: OfficeConverter
  officeTimeoutMs?: number
  /** --max-old-space-size of the pdf child (WORKER_PDF_HEAP_MB), default PREVIEW.pdfChildHeapMb */
  pdfHeapMb?: number
  /** the pdf child's resident-memory cap (WORKER_PDF_RSS_MB; Linux only, run.ts), default PREVIEW.pdfChildRssMb */
  pdfRssMb?: number
  /** test hook: run.ts's resident-set reader (lets the memory kill run off Linux too) */
  readRss?: RssReader | null
  /** the converted-PDF cache shared with extract-text (worker.ts); absent: each op converts into its own temp dir */
  pdfCache?: OfficePdfCache
  /** the pdf child's budget for one run (default LIMITS.jobTimeoutMs, as a preview's eight pages) */
  pdfTimeoutMs?: number
  /** test hook: another pdf child entry */
  pdfChildPath?: string
}

/** The api's refusal of a page it already has (features/formats/deck/kind.ts). */
export const PAGE_EXISTS = 'PAGE_EXISTS'

const DECK_MIMES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
])

const fail = (code: WorkerOpErrorCode, retry = false): never => {
  throw new OpFailure(code, retry)
}

/** A file failure from the shared preview code, as this op's code. */
function opCodeOf(e: PreviewError): WorkerOpErrorCode {
  switch (e.code) {
    case 'FILE_MISSING':
      return 'SOURCE_MISSING'
    case 'TIMEOUT':
      return 'TIMEOUT'
    case 'PDF_TOO_MANY_PAGES':
    case 'OFFICE_TOO_MANY_PAGES':
      return 'TOO_MANY_PAGES'
    case 'OFFICE_UNAVAILABLE':
      return 'WORKER_UNAVAILABLE'
    case 'TYPE_MISMATCH':
    case 'PDF_ENCRYPTED':
    case 'OFFICE_ENCRYPTED':
      return 'SOURCE_UNSUPPORTED'
    default:
      return 'RENDER_PAGES_FAILED'
  }
}

/** Runs the pdf child over pages `from..to` of `pdf` into `outDir`. */
async function renderRun(
  pdf: string,
  outDir: string,
  from: number,
  to: number,
  deps: RenderPagesDeps,
  signal: AbortSignal,
  log: (line: string) => void,
  opId: string,
): Promise<{ pageCount: number; rendered: number[] }> {
  const req: PdfChildRequest = {
    input: pdf,
    outDir,
    firstPage: from,
    pages: to,
    pageWidth: PREVIEW.pdfPageWidth,
    maxEdge: PREVIEW.pdfMaxEdge,
    quality: PREVIEW.pageQuality,
    maxPages: LIMITS.maxPdfPages,
    maxImagePixels: PREVIEW.pdfEmbeddedImagePixels,
  }
  const rssMb = deps.pdfRssMb ?? PREVIEW.pdfChildRssMb
  const r = await run(
    process.execPath,
    [`--max-old-space-size=${deps.pdfHeapMb ?? PREVIEW.pdfChildHeapMb}`, deps.pdfChildPath ?? PDF_CHILD],
    {
      timeoutMs: deps.pdfTimeoutMs ?? LIMITS.jobTimeoutMs,
      maxStdoutBytes: 64 * 1024,
      stdin: JSON.stringify(req),
      signal,
      maxRssBytes: rssMb * 1024 * 1024,
      ...(deps.readRss !== undefined ? { readRss: deps.readRss } : {}),
    },
  )
  if (r.aborted) throw new AbortedError()
  if (r.timedOut) return fail('TIMEOUT')
  // the child could not be started: this machine, not the file (tried again)
  if (r.spawnError) return fail('RENDER_PAGES_FAILED', true)
  if (r.memoryExceeded) {
    log(`${opId} pdf child over its ${rssMb} MB memory cap, killed`)
    return fail('FILE_TOO_COMPLEX')
  }
  let res: PdfChildResponse
  try {
    res = JSON.parse(r.stdout.toString('utf8')) as PdfChildResponse
  } catch {
    // no answer: the child crashed (a native abort, its heap) or was killed from outside. The same file would do it
    // again (review m8): final, as in extract-text and remove-bg.
    log(`${opId} pdf child gave no answer (exit ${r.code ?? r.signal})`)
    return fail('FILE_TOO_COMPLEX')
  }
  if (!res.ok) {
    if (res.reason === 'too_many_pages') return fail('TOO_MANY_PAGES')
    if (res.reason === 'encrypted') return fail('SOURCE_UNSUPPORTED')
    return fail('RENDER_PAGES_FAILED')
  }
  const pageCount = res.pageCount
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return fail('RENDER_PAGES_FAILED')
  const want: number[] = []
  for (let n = from; n <= Math.min(to, pageCount); n++) want.push(n)
  const rendered = Array.isArray(res.rendered) ? res.rendered : []
  if (rendered.length !== want.length || want.some((n, i) => rendered[i] !== n))
    return fail('RENDER_PAGES_FAILED')
  return { pageCount, rendered: want }
}

/** A PDF to render and what to do when done with it (an Office conversion may be the cache's). */
interface PdfInHand {
  path: string
  release(): void
}

/** The PDF to render: the original itself, or its conversion (the cache's, or this op's temp dir's). */
async function pdfOf(ctx: OpRunContext, original: string, deps: RenderPagesDeps): Promise<PdfInHand> {
  const size = (await stat(original)).size
  if (size === 0) return fail('RENDER_PAGES_FAILED')
  if (size > maxKindBytes('pdf')) return fail('SOURCE_UNSUPPORTED')
  const sniffed = await sniffFile(original)
  if (size > contentByteLimit('pdf', sniffed)) return fail('SOURCE_UNSUPPORTED')
  let office: OfficeFormat | null
  try {
    office = await officeInput(original, sniffed)
  } catch (e) {
    if (e instanceof PreviewError) return fail(opCodeOf(e))
    throw e
  }
  if (!office) {
    let mime: string | null
    try {
      mime = confirmKind('pdf', sniffed)
    } catch (e) {
      if (e instanceof PreviewError) return fail('SOURCE_UNSUPPORTED')
      throw e
    }
    // Photoshop and TIFF files are kind pdf too: one flattened page, never a deck
    if (mime !== 'application/pdf') return fail('SOURCE_UNSUPPORTED')
    return { path: original, release: () => {} }
  }
  if (!DECK_MIMES.has(office.mime)) return fail('SOURCE_UNSUPPORTED')
  const converter = deps.office ?? officeOff()
  const format = office
  const convert = (outDir: string) =>
    converter.convert(original, format, outDir, {
      timeoutMs: deps.officeTimeoutMs ?? LIMITS.officeConvertTimeoutMs,
      signal: ctx.signal,
    })
  try {
    if (deps.pdfCache) {
      const held = await deps.pdfCache.acquire(ctx.op.sourceVersionId, convert, ctx.signal)
      if (held.shared) ctx.log(`${ctx.op.id} reused the converted PDF`)
      return held
    }
    const outDir = join(ctx.tmpDir, 'office')
    await mkdir(outDir, { recursive: true })
    return { path: await convert(outDir), release: () => {} }
  } catch (e) {
    if (e instanceof PreviewError) return fail(opCodeOf(e))
    if (e instanceof TransientError) return fail('RENDER_PAGES_FAILED', true)
    throw e
  }
}

const isPageExists = (e: unknown) =>
  e instanceof WorkerApiError && e.status === 409 && e.message.endsWith(` ${PAGE_EXISTS}`)

/** The render-pages runner over `deps()` (read at each run, so worker.ts may set them after import). */
export function createRenderPagesRunner(deps: () => RenderPagesDeps = () => ({})): OpRunner {
  return {
    kind: 'render-pages',
    async run(ctx: OpRunContext): Promise<OpRunResult> {
      const d = deps()
      const params = RenderPagesParams.safeParse(ctx.op.params)
      if (!params.success) return fail('INTERNAL')
      const { from, to } = params.data
      if (ctx.op.source.kind !== 'pdf') return fail('SOURCE_UNSUPPORTED')
      // review nit 7: a size no deck may have is refused before any byte is downloaded (as extract-text, remove-bg)
      if (ctx.op.source.sizeBytes < 1) return fail('RENDER_PAGES_FAILED')
      if (ctx.op.source.sizeBytes > maxKindBytes('pdf')) return fail('SOURCE_UNSUPPORTED')
      const original = join(ctx.tmpDir, 'original')
      try {
        await downloadOriginal(ctx.api, ctx.op.original, original, {
          bytes: ctx.op.source.sizeBytes,
          timeoutMs:
            WORKER.downloadBaseMs + Math.ceil(ctx.op.source.sizeBytes / 1_000_000) * WORKER.downloadMsPerMb,
          stallMs: WORKER.downloadStallMs,
          signal: ctx.signal,
        })
      } catch (e) {
        if (e instanceof TransferError) {
          if (e.kind === 'aborted') throw new AbortedError()
          if (e.kind === 'missing') return fail('SOURCE_MISSING')
          return fail('RENDER_PAGES_FAILED', true)
        }
        throw e
      }
      const pdf = await pdfOf(ctx, original, d)
      const outDir = join(ctx.tmpDir, 'pages')
      let done: { pageCount: number; rendered: number[] }
      try {
        await mkdir(outDir, { recursive: true })
        done = await renderRun(pdf.path, outDir, from, to, d, ctx.signal, ctx.log, ctx.op.id)
      } finally {
        pdf.release() // the pages are written: the converted PDF may expire from here on
      }
      const { pageCount, rendered } = done

      const sharp = lockedSharp()
      const outputs: string[] = []
      const made: number[] = []
      for (const n of rendered) {
        if (ctx.signal.aborted) throw new AbortedError()
        const bytes = await readFile(join(outDir, pageFileName(n)))
        const meta = await sharp(bytes).metadata()
        if (meta.format !== 'webp' || !meta.width || !meta.height) return fail('RENDER_PAGES_FAILED')
        let reservation: Awaited<ReturnType<typeof ctx.ops.output>>
        try {
          reservation = await ctx.ops.output(
            ctx.lease,
            {
              role: 'page',
              page: n,
              mimeType: 'image/webp',
              width: meta.width,
              height: meta.height,
              bytes: bytes.length,
            },
            ctx.signal,
          )
        } catch (e) {
          if (isPageExists(e)) continue // the api has this page already (an earlier run)
          if (e instanceof WorkerApiError && (e.kind === 'server' || e.kind === 'network'))
            return fail('RENDER_PAGES_FAILED', true)
          if (e instanceof WorkerApiError && e.kind === 'rejected') return fail('RENDER_PAGES_FAILED')
          throw e
        }
        try {
          await uploadBlob(ctx.api, reservation.upload, bytes, {
            timeoutMs: WORKER.uploadTimeoutMs,
            signal: ctx.signal,
          })
        } catch (e) {
          if (e instanceof TransferError && e.kind === 'aborted') throw new AbortedError()
          if (e instanceof TransferError) return fail('RENDER_PAGES_FAILED', true)
          throw e
        }
        outputs.push(reservation.outputId)
        made.push(n)
      }
      // contracts RenderPagesResult: the document's page count and the pages this run published
      const result = { pageCount, rendered: made }
      ctx.log(`${ctx.op.id} rendered ${made.length} page(s)`)
      return { outputs, result }
    },
  }
}

let configured: RenderPagesDeps = {}

/** worker.ts, once at start: the previews' Office converter and the pdf child's heap, for every render-pages op. */
export function configureRenderPages(deps: RenderPagesDeps): void {
  configured = { ...deps }
}

/** The runner OP_RUNNERS registers (ops/dispatch.ts). */
export const renderPagesRunner: OpRunner = createRenderPagesRunner(() => configured)
