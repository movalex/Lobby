// Isolated PDF text reader (wave W, WS3; docs/WAVE-W-CONTRACTS.md §5): `node --max-old-space-size=<n> pdf-text-child.ts`,
// the request JSON on stdin (pdf-text-protocol below), the pages written to the request's output file (the child's
// stdout cap is 64 KB), one small JSON answer on stdout. It runs in its own process for the same reasons as
// pdf-child.ts (pdf.js parses on the calling thread in Node, and a hostile file can exhaust the heap): the parent
// enforces the heap cap and a SIGKILL timeout. The file is untrusted: no fonts or images are loaded (text only), no
// system fonts, no XFA, no scripting; each page's raw text is bounded before it is cleaned, the pages read are
// bounded (maxPages), and so are the characters kept per page and the bytes kept in all.

import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { cleanPageText, type PdfTextRequest, type PdfTextResponse } from './pdf-text-protocol.ts'

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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function extract(req: PdfTextRequest): Promise<PdfTextResponse> {
  const data = new Uint8Array(await readFile(req.input)) // pdf.js rejects a Node Buffer
  let loadingTask: ReturnType<typeof getDocument>
  try {
    loadingTask = getDocument({
      data,
      // CMaps map the codes of CJK (and other CID) fonts to text; the standard fonts are never rendered here
      cMapUrl: `${PDFJS_ROOT}/cmaps/`,
      standardFontDataUrl: `${PDFJS_ROOT}/standard_fonts/`,
      useSystemFonts: false,
      enableXfa: false,
      disableFontFace: true,
      verbosity: VerbosityLevel.ERRORS,
    })
  } catch (e) {
    return failure(e) // getDocument throws synchronously for e.g. empty data
  }
  try {
    const doc = await loadingTask.promise
    const pageCount = doc.numPages
    const last = Math.min(pageCount, req.maxPages)
    const pages: { page: number; body: string }[] = []
    let bytes = 0
    let truncated = pageCount > req.maxPages
    for (let n = 1; n <= last; n++) {
      const page = await doc.getPage(n)
      let raw = ''
      try {
        const content = await page.getTextContent()
        for (const item of content.items) {
          if (!('str' in item)) continue
          raw += item.str
          if (item.hasEOL) raw += '\n'
          // a page's raw text is bounded before cleaning (a hostile page can hold megabytes of glyphs)
          if (raw.length > req.maxPageChars * 4) break
        }
      } finally {
        page.cleanup()
      }
      const body = cleanPageText(raw, req.maxPageChars)
      if (!body) continue
      const size = Buffer.byteLength(body, 'utf8')
      if (bytes + size > req.maxBytes) {
        truncated = true
        break
      }
      bytes += size
      pages.push({ page: n, body })
    }
    await writeFile(req.output, JSON.stringify(pages))
    return { ok: true, pageCount, pages: pages.length, bytes, truncated }
  } catch (e) {
    return failure(e)
  } finally {
    await loadingTask.destroy().catch(() => {})
  }
}

function failure(e: unknown): PdfTextResponse {
  const name = String((e as Error)?.name ?? 'Error')
  // Without loadingTask.onPassword, a password request rejects (it does not hang).
  if (name === 'PasswordException') return { ok: false, reason: 'encrypted', name }
  return { ok: false, reason: 'invalid', name }
}

const res = await extract(JSON.parse(await readStdin()) as PdfTextRequest)
// Exit explicitly once the response is flushed: a leftover pdf.js handle must not keep the child alive until the
// parent's SIGKILL.
process.stdout.write(JSON.stringify(res), () => process.exit(0))
