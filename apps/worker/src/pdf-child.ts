// Isolated PDF renderer: `node --max-old-space-size=<n> pdf-child.ts`, request JSON on stdin.
// It runs in its own process because pdf.js parses on the calling thread in Node (no real worker)
// and Skia can abort natively (SIGILL seen in research); the parent enforces a SIGKILL timeout.

import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas'
import { getDocument, type PDFPageProxy, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { type PdfChildRequest, type PdfChildResponse, pageFileName } from './pdf-protocol.ts'

// pdf.js logs through console.log; stdout is reserved for the single JSON response.
const toStderr = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`)
console.log = toStderr
console.info = toStderr
console.warn = toStderr
console.debug = toStderr

const require = createRequire(import.meta.url)
// Factory URLs are plain filesystem paths in Node and MUST end with '/'; forward slashes on Windows.
const PDFJS_ROOT = require
  .resolve('pdfjs-dist/package.json')
  .replace(/[\\/]package\.json$/, '')
  .replaceAll('\\', '/')

// doc.canvasFactory is typed as `Object` in 6.3.289; this is the shape NodeCanvasFactory has.
type CanvasAndContext = { canvas: Canvas; context: SKRSContext2D }
type NodeCanvasFactory = {
  create(width: number, height: number): CanvasAndContext
  destroy(cc: CanvasAndContext): void
}
type RenderCanvas = Parameters<PDFPageProxy['render']>[0]['canvas']

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function render(req: PdfChildRequest): Promise<PdfChildResponse> {
  const data = new Uint8Array(await readFile(req.input)) // pdf.js rejects a Node Buffer
  let loadingTask: ReturnType<typeof getDocument>
  try {
    loadingTask = getDocument({
      data,
      standardFontDataUrl: `${PDFJS_ROOT}/standard_fonts/`, // without it text renders in a random system font
      cMapUrl: `${PDFJS_ROOT}/cmaps/`,
      wasmUrl: `${PDFJS_ROOT}/wasm/`,
      iccUrl: `${PDFJS_ROOT}/iccs/`,
      useSystemFonts: false,
      enableXfa: false,
      maxImageSize: req.maxImagePixels,
      verbosity: VerbosityLevel.ERRORS,
    })
  } catch (e) {
    return failure(e) // getDocument throws synchronously for e.g. empty data
  }
  try {
    const doc = await loadingTask.promise
    const pageCount = doc.numPages
    if (pageCount > req.maxPages)
      return { ok: false, reason: 'too_many_pages', name: 'LimitError', pageCount }
    const cf = doc.canvasFactory as NodeCanvasFactory
    const rendered: number[] = []
    for (let n = 1; n <= Math.min(pageCount, req.pages); n++) {
      const page = await doc.getPage(n)
      try {
        const base = page.getViewport({ scale: 1 }) // PDF points, /Rotate applied
        if (!(base.width > 0 && base.height > 0 && Number.isFinite(base.width * base.height))) {
          return { ok: false, reason: 'invalid', name: 'BadPageSize' }
        }
        // Width target, but never an edge above maxEdge: bounds native canvas memory for any MediaBox.
        const scale = Math.min(
          req.pageWidth / base.width,
          req.maxEdge / base.height,
          req.maxEdge / base.width,
        )
        const viewport = page.getViewport({ scale })
        const cc = cf.create(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
        try {
          await page.render({ canvas: cc.canvas as unknown as RenderCanvas, viewport }).promise // white background
          await writeFile(join(req.outDir, pageFileName(n)), await cc.canvas.encode('webp', req.quality))
        } finally {
          cf.destroy(cc)
        }
      } finally {
        page.cleanup()
      }
      rendered.push(n)
    }
    return { ok: true, pageCount, rendered }
  } catch (e) {
    return failure(e)
  } finally {
    await loadingTask.destroy().catch(() => {}) // PDFDocumentProxy has no destroy() in 6.x
  }
}

function failure(e: unknown): PdfChildResponse {
  const name = String((e as Error)?.name ?? 'Error')
  // Without loadingTask.onPassword, a password request rejects (it does not hang).
  if (name === 'PasswordException') return { ok: false, reason: 'encrypted', name }
  return { ok: false, reason: 'invalid', name }
}

const res = await render(JSON.parse(await readStdin()) as PdfChildRequest)
// Exit explicitly once the response is flushed: a leftover pdf.js handle must not keep the child
// alive until the parent's SIGKILL.
process.stdout.write(JSON.stringify(res), () => process.exit(0))
