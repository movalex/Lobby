// Wave W review M3: the resident-memory cap of the worker's PDF children, checked with the real children and the
// production arguments. A plain Node script (no vitest): Node 24 runs it by type stripping, and it imports only
// ../src, node built-ins and the worker's prod dependencies (through ../src), plus ./zero-stream-pdf.ts (node
// built-ins only), so it runs INSIDE the worker image, where tests are not shipped:
//
//   docker run --rm --network none --memory 1500m --memory-swap 1500m --user node \
//     -v <repo>/apps/worker/test:/app/apps/worker/test:ro --entrypoint node draftroom-worker:latest \
//     apps/worker/test/rss-cap-check.ts
//
// For each of the review's two files (a one-page PDF whose content stream, or whose font program, is ~1.5 MB of
// deflated zeros that pdf.js inflates to ~1.5 GB outside the V8 heap):
//   1. the pdf-text child (extract-text) under run() with FILE_TEXT_LIMITS' heap and its 768 MB cap: killed,
//      memoryExceeded, the peak read near the cap;
//   2. the pdf child (previews and render-pages) under run() with PREVIEW's heap and its 768 MB cap: the same;
//   3. the extract-text and render-pages runners end to end (the file served over local HTTP): FILE_TOO_COMPLEX;
//   4. the preview path (derivePdf): a permanent PreviewError FILE_TOO_LARGE.
// And a control: a plain PDF through both children under the same caps completes, its peak well under the cap.
// Prints every number; exits 0 when all hold, 1 when one does not, 2 off Linux (the watchdog is Linux-only: run.ts).
// The children's stderr, the file's bytes and the paths are never printed.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_TEXT_LIMITS, WORKER_CAPABILITIES, type WorkerOpKind } from '@draftroom/contracts'
import type { WorkerApi } from '../src/api-client.ts'
import { PREVIEW } from '../src/config.ts'
import { PreviewError } from '../src/errors.ts'
import type { ClaimedOp, WorkerOpsApi } from '../src/ops/client.ts'
import { OpFailure, type OpRunner } from '../src/ops/dispatch.ts'
import { createExtractTextRunner, PDF_TEXT_CHILD } from '../src/ops/extract-text.ts'
import { createRenderPagesRunner } from '../src/ops/render-pages.ts'
import { derivePdf, PDF_CHILD } from '../src/pdf.ts'
import { RSS_POLL_MS, type RssReader, type RunResult, rssCapEnforced, run } from '../src/run.ts'
import { plainPdf, type ZeroStreamWhere, zeroStreamPdf } from './zero-stream-pdf.ts'

const MiB = 1024 * 1024
/** How far past the cap the peak read may be: growth during one poll period, generously (see run.ts's header). */
export const OVERSHOOT_TOLERANCE_MB = 256

export interface CheckLine {
  what: string
  ok: boolean
  detail: string
}

let reader: RssReader | undefined

const mb = (b: number | null) => (b === null ? 'n/a' : `${Math.round(b / MiB)} MB`)

/** One child under run() with the production heap flag and resident cap. */
async function childRun(child: 'pdf-text' | 'pdf', input: string, dir: string): Promise<RunResult> {
  const req =
    child === 'pdf-text'
      ? {
          input,
          output: join(dir, 'pages.json'),
          maxPages: FILE_TEXT_LIMITS.maxPages,
          maxPageChars: FILE_TEXT_LIMITS.maxPageChars,
          maxBytes: FILE_TEXT_LIMITS.maxVersionBytes,
        }
      : {
          input,
          outDir: dir,
          firstPage: 1,
          pages: 8,
          pageWidth: PREVIEW.pdfPageWidth,
          maxEdge: PREVIEW.pdfMaxEdge,
          quality: PREVIEW.pageQuality,
          maxPages: 500,
          maxImagePixels: PREVIEW.pdfEmbeddedImagePixels,
        }
  const heap = child === 'pdf-text' ? FILE_TEXT_LIMITS.childHeapMb : PREVIEW.pdfChildHeapMb
  const cap = child === 'pdf-text' ? FILE_TEXT_LIMITS.childRssMb : PREVIEW.pdfChildRssMb
  return run(
    process.execPath,
    [`--max-old-space-size=${heap}`, child === 'pdf-text' ? PDF_TEXT_CHILD : PDF_CHILD],
    {
      timeoutMs: child === 'pdf-text' ? FILE_TEXT_LIMITS.childTimeoutMs : 90_000,
      maxStdoutBytes: 64 * 1024,
      stdin: JSON.stringify(req),
      maxRssBytes: cap * MiB,
      ...(reader ? { readRss: reader } : {}),
    },
  )
}

/** A runner over `file` served from a local HTTP server: the op's failure code, or 'completed'. */
async function runnerCode(runner: OpRunner, kind: WorkerOpKind, file: string, dir: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(statSync(file).size) })
    res.end(readFileSync(file))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const op: ClaimedOp = {
    id: 'wop_rsscapcheck0000000',
    kind,
    capability: WORKER_CAPABILITIES[kind],
    boardId: 'b-rsscheck01',
    sourceVersionId: 'ver_rsscapcheck0000000',
    params: kind === 'extract-text' ? { maxPages: FILE_TEXT_LIMITS.maxPages } : { from: 1, to: 8 },
    attempt: 1,
    leaseMs: 120_000,
    source: {
      kind: 'pdf',
      name: 'check.pdf',
      mimeType: 'application/pdf',
      sizeBytes: statSync(file).size,
      pageCount: null,
    },
    original: { url: `${origin}/original`, headers: {} },
  }
  const ops = {
    text: async () => {},
    output: async () => {
      throw new Error('no output expected')
    },
  } as unknown as WorkerOpsApi
  const api = {
    blobRequest: (ref: { url: string }) => ({ url: ref.url, headers: {} }),
  } as unknown as WorkerApi
  try {
    await runner.run({
      op,
      lease: { opId: op.id, attempt: 1 },
      ops,
      api,
      tmpDir: mkdtempSync(join(dir, 'op-')),
      signal: new AbortController().signal,
      log: () => {},
    })
    return 'completed'
  } catch (e) {
    return e instanceof OpFailure ? e.code : `threw ${(e as Error)?.name ?? 'Error'}`
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

/** Runs every check (Linux only); `say` prints a line. */
export async function runRssCapCheck(
  say: (line: string) => void = console.log,
  /** a reader other than run.ts's (informative runs off Linux only); default: the platform's */
  readRss?: RssReader,
): Promise<CheckLine[]> {
  reader = readRss
  const lines: CheckLine[] = []
  const check = (what: string, ok: boolean, detail: string) => {
    lines.push({ what, ok, detail })
    say(`${ok ? 'PASS' : 'FAIL'}  ${what}: ${detail}`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'drw-rsscheck-'))
  try {
    say(`node ${process.version} ${process.platform}/${process.arch}, watchdog every ${RSS_POLL_MS} ms`)
    const control = join(dir, 'plain.pdf')
    writeFileSync(control, plainPdf())
    for (const child of ['pdf-text', 'pdf'] as const) {
      const r = await childRun(child, control, mkdtempSync(join(dir, 'c-')))
      const cap = child === 'pdf-text' ? FILE_TEXT_LIMITS.childRssMb : PREVIEW.pdfChildRssMb
      check(
        `control: plain PDF, ${child} child (cap ${cap} MB)`,
        r.code === 0 && !r.memoryExceeded && r.peakRssBytes !== null && r.peakRssBytes < cap * MiB,
        `exit ${r.code ?? r.signal}, memoryExceeded ${r.memoryExceeded}, peak read ${mb(r.peakRssBytes)}, ${r.ms} ms`,
      )
    }
    for (const where of ['content', 'font'] as ZeroStreamWhere[]) {
      const t0 = Date.now()
      const bytes = await zeroStreamPdf(where)
      const file = join(dir, `zero-${where}.pdf`)
      writeFileSync(file, bytes)
      say(`zero-stream PDF (${where}): ${bytes.length} bytes on disk, built in ${Date.now() - t0} ms`)
      for (const child of ['pdf-text', 'pdf'] as const) {
        const cap = child === 'pdf-text' ? FILE_TEXT_LIMITS.childRssMb : PREVIEW.pdfChildRssMb
        const r = await childRun(child, file, mkdtempSync(join(dir, 'c-')))
        const peak = r.peakRssBytes ?? 0
        check(
          `${where}: ${child} child killed over its ${cap} MB cap`,
          r.memoryExceeded &&
            r.signal === 'SIGKILL' &&
            peak > cap * MiB &&
            peak <= (cap + OVERSHOOT_TOLERANCE_MB) * MiB,
          `memoryExceeded ${r.memoryExceeded}, exit ${r.code ?? r.signal}, peak read ${mb(r.peakRssBytes)}, after ${r.ms} ms`,
        )
      }
      for (const [kind, runner] of [
        ['extract-text', createExtractTextRunner(reader ? { readRss: reader } : {})],
        ['render-pages', createRenderPagesRunner(() => (reader ? { readRss: reader } : {}))],
      ] as const) {
        const code = await runnerCode(runner, kind, file, dir)
        check(`${where}: the ${kind} op`, code === 'FILE_TOO_COMPLEX', `failed ${code}`)
      }
      const writer = { makeTempDir: async () => mkdtempSync(join(dir, 'p-')) } as never
      const preview = await derivePdf(file, writer, reader ? { readRss: reader } : {}).then(
        () => 'completed',
        (e: unknown) =>
          e instanceof PreviewError ? `${e.code} (${e.detail})` : `threw ${(e as Error)?.name}`,
      )
      check(`${where}: the preview job`, preview.startsWith('FILE_TOO_LARGE '), preview)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
  return lines
}

if (import.meta.main) {
  if (!rssCapEnforced) {
    console.log(
      `the resident-memory watchdog is Linux-only (run.ts); on ${process.platform} nothing would be enforced, so nothing is checked`,
    )
    process.exit(2)
  }
  const lines = await runRssCapCheck()
  const failed = lines.filter((l) => !l.ok)
  console.log(
    failed.length ? `${failed.length} of ${lines.length} checks FAILED` : `all ${lines.length} checks passed`,
  )
  process.exit(failed.length ? 1 : 0)
}
