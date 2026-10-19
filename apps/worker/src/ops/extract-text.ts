// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): the extract-text op's runner. It reads the text of a `pdf`-kind version
// (a PDF, or an Office document converted to PDF again through the no-network LibreOffice sidecar: one more conversion,
// the preview path untouched) and sends it to the api page by page.
//
//   download the original (transfer.ts caps: its exact recorded size, a deadline, a stall timer)
//   → sniff it: a PDF is read as it is; an Office document passes the container checks (office.ts: zip bombs,
//     encryption, macros) and is converted (≤ FILE_TEXT_LIMITS.officeTimeoutMs) once per version: the converted PDF
//     goes to the worker's short-lived cache shared with render-pages (ops/office-pdf-cache.ts, review M2); anything
//     else is SOURCE_UNSUPPORTED
//   → pdf-text-child.ts in a child process: pdf.js getTextContent over pages 1..min(N, maxPages), a
//     FILE_TEXT_LIMITS.childHeapMb heap, a childRssMb resident-memory SIGKILL (Linux, run.ts) and a childTimeoutMs
//     SIGKILL, ≤ maxPageChars a page and ≤ maxVersionBytes in all, written to a file in the op's temp dir; killed over
//     its memory cap or dead without an answer: FILE_TOO_COMPLEX, never retried (as render-pages and remove-bg)
//   → the pages re-read and re-checked here (the child parsed hostile input), then sent over `/text` in ascending order,
//     ≤ 50 pages and ≤ TEXT_BATCH_BYTES of JSON a call (the api's JSON body limit is 256 KiB), the first batch always
//     starting with page 1 (an empty body when page 1 holds no text: it tells the api a run starts afresh)
//   → complete with ExtractTextResult {pages (with text), bytes, truncated, extractor}.
// A scan (no text) completes with pages 0: the api records it `empty` (OCR is out of scope). Failures are op codes users
// see (contracts WORKER_OP_MESSAGES): never a path, a file name or a tool's output.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtractTextParams, FILE_TEXT_LIMITS, WORKER_OP_LIMITS } from '@draftroom/contracts'
import { LIMITS, officeFormatByMime } from '@draftroom/dev-assets'
import { WORKER } from '../config.ts'
import { AbortedError, PreviewError, TransientError } from '../errors.ts'
import { checkOfficeContainer, type OfficeConverter, officeOff } from '../office.ts'
import { type RssReader, run } from '../run.ts'
import { sniffFile } from '../sniff.ts'
import { downloadOriginal, TransferError } from '../transfer.ts'
import { OpFailure, type OpRunContext, type OpRunner, type OpRunResult } from './dispatch.ts'
import type { OfficePdfCache } from './office-pdf-cache.ts'
import { cleanPageText, type PdfTextRequest, type PdfTextResponse } from './pdf-text-protocol.ts'

export const PDF_TEXT_CHILD = fileURLToPath(new URL('./pdf-text-child.ts', import.meta.url))

/** A `/text` call's JSON at most (under the api's 256 KiB JSON body limit, with room for the envelope). */
export const TEXT_BATCH_BYTES = 192 * 1024
/** The child's pages file at most: its byte cap as JSON (escapes can double it) and the array's punctuation. */
const PAGES_FILE_MAX_BYTES = FILE_TEXT_LIMITS.maxVersionBytes * 2 + 64 * 1024

export interface ExtractTextOptions {
  /** Office documents to PDF (office.ts); absent: they fail WORKER_UNAVAILABLE (this worker cannot read them now) */
  office?: OfficeConverter
  officeTimeoutMs?: number
  /** the child's timeout and heap (FILE_TEXT_LIMITS by default) */
  timeoutMs?: number
  heapMb?: number
  /** the child's resident-memory cap in MB (default FILE_TEXT_LIMITS.childRssMb; Linux only, run.ts) */
  rssMb?: number
  /** test hook: run.ts's resident-set reader (lets the memory kill run off Linux too) */
  readRss?: RssReader | null
  /** test hook: another child entry (one that hangs or crashes) */
  childPath?: string
  /** the converted-PDF cache shared with render-pages (worker.ts); absent: the Office file converts in the op's dir */
  pdfCache?: OfficePdfCache
}

export interface TextPage {
  page: number
  body: string
}

/** The pages in `/text` calls: ascending, ≤ 50 pages and ≤ TEXT_BATCH_BYTES of JSON each, page 1 first. */
export function textBatches(pages: readonly TextPage[]): TextPage[][] {
  if (!pages.length) return []
  const all = pages[0]?.page === 1 ? [...pages] : [{ page: 1, body: '' }, ...pages]
  const out: TextPage[][] = []
  let cur: TextPage[] = []
  let bytes = 0
  for (const p of all) {
    const size = Buffer.byteLength(JSON.stringify(p)) + 1
    if (cur.length && (cur.length >= WORKER_OP_LIMITS.textPagesPerCall || bytes + size > TEXT_BATCH_BYTES)) {
      out.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(p)
    bytes += size
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * The child's pages, checked as untrusted: a JSON array of {page, body}, pages ascending within 1..maxPages, each body
 * cleaned again and within the caps (a page past the byte cap ends the list: truncated). Throws OpFailure on anything
 * else (the child is ours, but it parsed a hostile file).
 */
export function checkedPages(
  raw: string,
  maxPages: number,
): { pages: TextPage[]; bytes: number; truncated: boolean } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new OpFailure('TEXT_EXTRACT_FAILED')
  }
  if (!Array.isArray(value)) throw new OpFailure('TEXT_EXTRACT_FAILED')
  const pages: TextPage[] = []
  let bytes = 0
  let truncated = false
  let last = 0
  for (const v of value) {
    const p = v as { page?: unknown; body?: unknown } | null
    if (
      !p ||
      typeof p.page !== 'number' ||
      !Number.isInteger(p.page) ||
      p.page <= last ||
      p.page > maxPages ||
      typeof p.body !== 'string'
    )
      throw new OpFailure('TEXT_EXTRACT_FAILED')
    last = p.page
    const body = cleanPageText(p.body, FILE_TEXT_LIMITS.maxPageChars)
    if (!body) continue
    const size = Buffer.byteLength(body, 'utf8')
    if (bytes + size > FILE_TEXT_LIMITS.maxVersionBytes) {
      truncated = true
      break
    }
    bytes += size
    pages.push({ page: p.page, body })
  }
  return { pages, bytes, truncated }
}

/** The op's page limit: its params (strict), within the contract's cap. */
function maxPagesOf(params: Record<string, unknown>): number {
  const p = ExtractTextParams.safeParse(params)
  if (!p.success) throw new OpFailure('SOURCE_UNSUPPORTED')
  return Math.min(p.data.maxPages, FILE_TEXT_LIMITS.maxPages)
}

/** A conversion or container failure as the op code users see. */
function officeFailure(e: unknown): never {
  if (e instanceof AbortedError) throw e
  if (e instanceof TransientError) throw new OpFailure('INTERNAL', true)
  if (e instanceof PreviewError) {
    switch (e.code) {
      case 'OFFICE_UNAVAILABLE':
        throw new OpFailure('WORKER_UNAVAILABLE')
      case 'TIMEOUT':
        throw new OpFailure('TIMEOUT')
      case 'FILE_TOO_LARGE':
      case 'OFFICE_ENCRYPTED':
      case 'TYPE_MISMATCH':
        throw new OpFailure('SOURCE_UNSUPPORTED')
      default:
        throw new OpFailure('TEXT_EXTRACT_FAILED')
    }
  }
  throw new OpFailure('INTERNAL', true)
}

export function createExtractTextRunner(o: ExtractTextOptions = {}): OpRunner {
  return {
    kind: 'extract-text',
    async run(ctx: OpRunContext): Promise<OpRunResult> {
      const { op } = ctx
      const maxPages = maxPagesOf(op.params)
      if (op.source.kind !== 'pdf') throw new OpFailure('SOURCE_UNSUPPORTED')
      if (op.source.sizeBytes > Math.max(LIMITS.maxBytes.pdf, LIMITS.maxOfficeBytes))
        throw new OpFailure('SOURCE_UNSUPPORTED')
      const original = join(ctx.tmpDir, 'original')
      try {
        await downloadOriginal(ctx.api, op.original, original, {
          bytes: op.source.sizeBytes,
          timeoutMs:
            WORKER.downloadBaseMs + Math.ceil(op.source.sizeBytes / 1_000_000) * WORKER.downloadMsPerMb,
          stallMs: WORKER.downloadStallMs,
          signal: ctx.signal,
        })
      } catch (e) {
        if (e instanceof TransferError) {
          if (e.kind === 'aborted') throw new AbortedError()
          if (e.kind === 'missing') throw new OpFailure('SOURCE_MISSING')
          throw new OpFailure('INTERNAL', true)
        }
        throw e
      }
      const sniffed = await sniffFile(original)
      let pdf = original
      let release = () => {}
      const format = officeFormatByMime(sniffed.mime)
      if (format) {
        if ((await stat(original)).size > LIMITS.maxOfficeBytes) throw new OpFailure('SOURCE_UNSUPPORTED')
        try {
          await checkOfficeContainer(original, format)
          const convert = (outDir: string) =>
            (o.office ?? officeOff()).convert(original, format, outDir, {
              timeoutMs: o.officeTimeoutMs ?? FILE_TEXT_LIMITS.officeTimeoutMs,
              signal: ctx.signal,
            })
          if (o.pdfCache) {
            // review M2: one conversion per version, shared with its deck's render-pages runs
            const held = await o.pdfCache.acquire(op.sourceVersionId, convert, ctx.signal)
            if (held.shared) ctx.log(`${op.id} reused the converted PDF`)
            pdf = held.path
            release = held.release
          } else pdf = await convert(ctx.tmpDir)
        } catch (e) {
          officeFailure(e)
        }
      } else if (sniffed.mime !== 'application/pdf') {
        // a Photoshop or TIFF file is kind 'pdf' too (flattened pages): it has no text to read
        throw new OpFailure('SOURCE_UNSUPPORTED')
      }
      try {
        return await readText(ctx, o, pdf, maxPages)
      } finally {
        release()
      }
    },
  }
}

/** The child over `pdf`, its pages checked and sent; the op's result. */
async function readText(
  ctx: OpRunContext,
  o: ExtractTextOptions,
  pdf: string,
  maxPages: number,
): Promise<OpRunResult> {
  const { op } = ctx
  const output = join(ctx.tmpDir, 'pages.json')
  const req: PdfTextRequest = {
    input: pdf,
    output,
    maxPages,
    maxPageChars: FILE_TEXT_LIMITS.maxPageChars,
    maxBytes: FILE_TEXT_LIMITS.maxVersionBytes,
  }
  const rssMb = o.rssMb ?? FILE_TEXT_LIMITS.childRssMb
  const r = await run(
    process.execPath,
    [`--max-old-space-size=${o.heapMb ?? FILE_TEXT_LIMITS.childHeapMb}`, o.childPath ?? PDF_TEXT_CHILD],
    {
      timeoutMs: o.timeoutMs ?? FILE_TEXT_LIMITS.childTimeoutMs,
      maxStdoutBytes: 64 * 1024,
      stdin: JSON.stringify(req),
      signal: ctx.signal,
      maxRssBytes: rssMb * 1024 * 1024,
      ...(o.readRss !== undefined ? { readRss: o.readRss } : {}),
    },
  )
  if (r.aborted) throw new AbortedError()
  if (r.timedOut) throw new OpFailure('TIMEOUT')
  // the child could not be started: this machine, not the file (tried again)
  if (r.spawnError) throw new OpFailure('INTERNAL', true)
  // Review M3/m8, the same rule for every op kind: over its resident-memory cap, or dead with no answer (a heap exhausted
  // by a hostile file, a native abort, the kernel's OOM killer): FILE_TOO_COMPLEX, final (the same file would do it again).
  if (r.memoryExceeded) {
    ctx.log(`${op.id} pdf-text child over its ${rssMb} MB memory cap, killed`)
    throw new OpFailure('FILE_TOO_COMPLEX')
  }
  let res: PdfTextResponse
  try {
    res = JSON.parse(r.stdout.toString('utf8')) as PdfTextResponse
  } catch {
    ctx.log(`${op.id} pdf-text child gave no answer (exit ${r.code ?? r.signal})`)
    throw new OpFailure('FILE_TOO_COMPLEX')
  }
  if (!res.ok) throw new OpFailure(res.reason === 'encrypted' ? 'SOURCE_UNSUPPORTED' : 'TEXT_EXTRACT_FAILED')
  if ((await stat(output)).size > PAGES_FILE_MAX_BYTES) throw new OpFailure('TEXT_EXTRACT_FAILED')
  const read = checkedPages(await readFile(output, 'utf8'), maxPages)
  for (const batch of textBatches(read.pages)) await ctx.ops.text(ctx.lease, batch, ctx.signal)
  return {
    outputs: [],
    result: {
      pages: read.pages.length,
      bytes: read.bytes,
      truncated: res.truncated || read.truncated,
      extractor: FILE_TEXT_LIMITS.extractor,
    },
  }
}
