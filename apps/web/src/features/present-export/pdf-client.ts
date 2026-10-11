// A PdfBuilder that runs pdf-lib in a module worker (pdf.worker.ts), so decoding and compressing large
// page images never blocks the board. Falls back to the main thread when workers are unavailable
// (no Worker global, blocked by policy, or the worker fails to load).
import { createPdfBuilder, type PdfBuilder, type PdfPageInput, type PdfVectorPageInput } from './pdf-build.ts'
import type { PdfWorkerRequest, PdfWorkerResponse } from './pdf-protocol.ts'
import { loadFontkit } from './vector/fontkit.ts'
import { browserVectorDeps } from './vector/worker-deps.ts'

export interface DisposablePdfBuilder extends PdfBuilder {
  /** Stops the worker (cancel); a no-op after finish(). */
  dispose(): void
  readonly offThread: boolean
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

const START_TIMEOUT_MS = 10_000

async function mainThreadBuilder(title: string): Promise<DisposablePdfBuilder> {
  const fontkit = await loadFontkit().catch(() => null)
  const b = await createPdfBuilder({ title, vector: { fontkit, deps: browserVectorDeps() } })
  return {
    get pageCount() {
      return b.pageCount
    },
    addPage: (page) => b.addPage(page),
    addVectorPage: (page) => b.addVectorPage(page),
    finish: () => b.finish(),
    dispose() {},
    offThread: false,
  }
}

export async function createPdfBuilderOffThread(meta: { title: string }): Promise<DisposablePdfBuilder> {
  let worker: Worker
  try {
    worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), {
      type: 'module',
      name: 'draftroom-pdf',
    })
  } catch {
    return mainThreadBuilder(meta.title)
  }

  let nextId = 1
  let dead: Error | null = null
  const pending = new Map<number, { resolve(r: PdfWorkerResponse): void; reject(e: Error): void }>()
  const failAll = (e: Error) => {
    dead = e
    for (const p of pending.values()) p.reject(e)
    pending.clear()
  }
  worker.addEventListener('message', (e: MessageEvent<PdfWorkerResponse>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    p.resolve(e.data)
  })
  worker.addEventListener('error', (e) => failAll(new Error(e.message || 'The PDF worker failed')))
  worker.addEventListener('messageerror', () => failAll(new Error('The PDF worker could not read a message')))

  const call = (msg: WithoutId<PdfWorkerRequest>, transfer: Transferable[] = []) =>
    new Promise<PdfWorkerResponse>((resolve, reject) => {
      if (dead) {
        reject(dead)
        return
      }
      const id = nextId++
      pending.set(id, { resolve, reject })
      worker.postMessage({ ...msg, id }, transfer)
    })
  const expectOk = (r: PdfWorkerResponse) => {
    if (r.type === 'error') throw new Error(r.message)
    return r
  }

  try {
    const started = await Promise.race([
      call({ type: 'start', title: meta.title, now: Date.now() }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('PDF worker did not start')), START_TIMEOUT_MS),
      ),
    ])
    expectOk(started)
  } catch {
    worker.terminate()
    return mainThreadBuilder(meta.title)
  }

  let pageCount = 0
  let finished = false
  return {
    get pageCount() {
      return pageCount
    },
    async addPage(page: PdfPageInput) {
      const transfer = [page.image.bytes.buffer as ArrayBuffer]
      if (page.headerImage) transfer.push(page.headerImage.bytes.buffer as ArrayBuffer)
      const r = expectOk(await call({ type: 'page', page }, transfer))
      if (r.type === 'ok') pageCount = r.pageCount
    },
    async addVectorPage(page: PdfVectorPageInput) {
      const transfer = page.headerImage ? [page.headerImage.bytes.buffer as ArrayBuffer] : []
      const r = expectOk(await call({ type: 'vector-page', page }, transfer))
      if (r.type !== 'vector') throw new Error('Unexpected reply from the PDF worker')
      pageCount = r.pageCount
      return r.outcome
    },
    async finish() {
      try {
        const r = expectOk(await call({ type: 'finish' }))
        if (r.type !== 'done') throw new Error('Unexpected reply from the PDF worker')
        return r.bytes
      } finally {
        finished = true
        worker.terminate()
      }
    },
    dispose() {
      if (finished) return
      finished = true
      worker.terminate()
      failAll(new Error('PDF export cancelled'))
    },
    offThread: true,
  }
}
