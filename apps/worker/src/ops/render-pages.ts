// Wave W (WS4, deck import; docs/WAVE-W-CONTRACTS.md §6): the `render-pages` op runner. A preview job renders a deck's
// pages 1..8 (dev-assets LIMITS.eagerPdfPages); "Insert as slides" on a longer deck asks the api for its pages
// 9..min(N, 100) in runs of at most 30 (contracts deckRenderRuns), one op per run, and this runner renders one run:
//
//   download the original (transfer.ts caps) → Office? convert it to PDF through the same converter as previews
//   (the no-network sidecar on the NAS; the converted PDF lives in this op's temp dir only, for this op only) → the
//   existing pdf-child.ts renders pages from..to at the SAME width and quality as a preview's pages (1024 px webp, the
//   `page` role: the loader and a 7e5b4d6 web read them unchanged) → each page re-read with sharp (the child parsed
//   hostile input: its output is checked, not trusted) → reserved as a `page` output and PUT → complete with
//   RenderPagesResult {pageCount, rendered}.
//
// A page the api already has (its `page` derivative exists: a run made earlier, or by another op) is refused at
// reservation with 409 PAGE_EXISTS and skipped here, so a re-run renders only what is missing and never duplicates a
// page (the api's completer also skips such pages under the version's row lock: there is no unique index).
//
// Failures as users see them (contracts WORKER_OP_MESSAGES): a file that is not a PDF or a presentation the converter
// takes → SOURCE_UNSUPPORTED; the original gone → SOURCE_MISSING; more pages than LIMITS.maxPdfPages → TOO_MANY_PAGES;
// the child killed at its budget → TIMEOUT; anything the file itself breaks → RENDER_PAGES_FAILED; a crash, a network or
// storage hiccup → RENDER_PAGES_FAILED with a retry (attempts are capped by the api). Logs carry an op id and a code,
// never a name, a path or a URL.

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
import { run } from '../run.ts'
import { confirmKind, contentByteLimit, sniffFile } from '../sniff.ts'
import { downloadOriginal, TransferError, uploadBlob } from '../transfer.ts'
import { OpFailure, type OpRunContext, type OpRunner, type OpRunResult } from './dispatch.ts'

/** What the runner needs beyond its op context (worker.ts sets them once at start: configureRenderPages). */
export interface RenderPagesDeps {
  /** The previews' Office converter (absent or off: an Office deck fails WORKER_UNAVAILABLE, a PDF still renders). */
  office?: OfficeConverter
  officeTimeoutMs?: number
  /** --max-old-space-size of the pdf child (WORKER_PDF_HEAP_MB), default PREVIEW.pdfChildHeapMb */
  pdfHeapMb?: number
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
  const r = await run(
    process.execPath,
    [`--max-old-space-size=${deps.pdfHeapMb ?? PREVIEW.pdfChildHeapMb}`, deps.pdfChildPath ?? PDF_CHILD],
    {
      timeoutMs: deps.pdfTimeoutMs ?? LIMITS.jobTimeoutMs,
      maxStdoutBytes: 64 * 1024,
      stdin: JSON.stringify(req),
      signal,
    },
  )
  if (r.aborted) throw new AbortedError()
  if (r.timedOut) return fail('TIMEOUT')
  if (r.spawnError) return fail('RENDER_PAGES_FAILED', true)
  let res: PdfChildResponse
  try {
    res = JSON.parse(r.stdout.toString('utf8')) as PdfChildResponse
  } catch {
    // no answer: the child crashed (a native abort, its heap) or was killed from outside
    return fail('RENDER_PAGES_FAILED', true)
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

/** The PDF to render: the original itself, or its conversion (in this op's temp dir). */
async function pdfOf(ctx: OpRunContext, original: string, deps: RenderPagesDeps): Promise<string> {
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
    return original
  }
  if (!DECK_MIMES.has(office.mime)) return fail('SOURCE_UNSUPPORTED')
  const outDir = join(ctx.tmpDir, 'office')
  await mkdir(outDir, { recursive: true })
  const converter = deps.office ?? officeOff()
  try {
    return await converter.convert(original, office, outDir, {
      timeoutMs: deps.officeTimeoutMs ?? LIMITS.officeConvertTimeoutMs,
      signal: ctx.signal,
    })
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
      await mkdir(outDir, { recursive: true })
      const { pageCount, rendered } = await renderRun(pdf, outDir, from, to, d, ctx.signal)

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
