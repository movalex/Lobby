// Module worker: assembles the PDF with @cantoo/pdf-lib off the main thread (PNG decoding and deflate of
// multi-megapixel pages would otherwise block the board for seconds; a vector page's font subsetting too).
// Loaded by pdf-client.ts.
import { createPdfBuilder, type PdfBuilder } from './pdf-build.ts'
import type { PdfWorkerRequest, PdfWorkerResponse } from './pdf-protocol.ts'
import { loadFontkit } from './vector/fontkit.ts'
import { browserVectorDeps } from './vector/worker-deps.ts'

let builder: PdfBuilder | null = null
let queue: Promise<void> = Promise.resolve()

const reply = (msg: PdfWorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

async function handle(msg: PdfWorkerRequest) {
  try {
    if (msg.type === 'start') {
      const fontkit = await loadFontkit().catch(() => null)
      builder = await createPdfBuilder({
        title: msg.title,
        now: new Date(msg.now),
        vector: { fontkit, deps: browserVectorDeps() },
      })
      reply({ id: msg.id, type: 'ok', pageCount: 0 })
    } else if (msg.type === 'page') {
      if (!builder) throw new Error('PDF not started')
      await builder.addPage(msg.page)
      reply({ id: msg.id, type: 'ok', pageCount: builder.pageCount })
    } else if (msg.type === 'vector-page') {
      if (!builder) throw new Error('PDF not started')
      const outcome = await builder.addVectorPage(msg.page)
      reply({ id: msg.id, type: 'vector', pageCount: builder.pageCount, outcome })
    } else {
      if (!builder) throw new Error('PDF not started')
      const bytes = await builder.finish()
      builder = null
      reply({ id: msg.id, type: 'done', bytes }, [bytes.buffer as ArrayBuffer])
    }
  } catch (e) {
    reply({ id: msg.id, type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

self.addEventListener('message', (e: MessageEvent<PdfWorkerRequest>) => {
  // One message at a time, in order (pages must not interleave).
  queue = queue.then(() => handle(e.data))
})
