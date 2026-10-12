// A PdfBuilder that runs pdf-lib in a module worker (pdf.worker.ts), so decoding and compressing large
// page images never blocks the board. Falls back to the main thread when workers are unavailable
// (no Worker global, blocked by policy, or the worker fails to load).
//
// Wave N.1: every step has a time limit (PdfTimeLimits), so an export always ends. A vector page past its limit, or
// a file that cannot be written in time, ends this document: the worker is stopped (it may be stuck in the page) and
// the call rejects (a vector page with PdfVectorPageTimeout), and the exporter makes the document again (that page,
// or every page, as an image). Cancel (`dispose`) stops the worker at once, whatever it is doing.
import type { PdfBuilder, PdfPageInput, PdfVectorPageInput } from './pdf-build.ts'
import type { PdfWorkerRequest, PdfWorkerResponse } from './pdf-protocol.ts'

export interface DisposablePdfBuilder extends PdfBuilder {
  /** Stops the worker (cancel); a no-op after finish(). */
  dispose(): void
  readonly offThread: boolean
}

/** How long each step may take before the document is given up (ms). */
export interface PdfTimeLimits {
  /** the worker's first answer (past it the PDF is made on this thread) */
  readonly startMs: number
  /** one vector page (past it that page is an image page: the exporter makes the document again) */
  readonly vectorPageMs: number
  /** one image page */
  readonly pageMs: number
  /** writing the file (the vector pages' fonts are subset then) */
  readonly finishMs: number
}

export const PDF_TIME_LIMITS: PdfTimeLimits = {
  startMs: 10_000,
  vectorPageMs: 30_000,
  pageMs: 120_000,
  finishMs: 120_000,
}

/** A vector page took longer than its limit: this document is given up (the exporter makes it again). */
export class PdfVectorPageTimeout extends Error {
  constructor() {
    super('a vector page took too long')
    this.name = 'PdfVectorPageTimeout'
  }
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

const tookTooLong = (what: string) => () => new Error(`the PDF ${what} took too long`)
const vectorPageTimeout = () => new PdfVectorPageTimeout()

/** `p`, or a rejection with `error()` once `ms` have passed (then `onTimeout` runs). */
function limited<T>(p: Promise<T>, ms: number, error: () => Error, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.()
      reject(error())
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** Without a worker: the PDF library loads on this thread then, and only then (N6-1: never with the board). */
async function mainThreadBuilder(title: string, limits: PdfTimeLimits): Promise<DisposablePdfBuilder> {
  const [{ createPdfBuilder }, { loadFontkit }, { browserVectorDeps }] = await Promise.all([
    import('./pdf-build.ts'),
    import('./vector/fontkit.ts'),
    import('./vector/worker-deps.ts'),
  ])
  const fontkit = await loadFontkit().catch(() => null)
  const b = await createPdfBuilder({
    title,
    vector: { fontkit, deps: browserVectorDeps() },
    finishMs: limits.finishMs,
  })
  // a step past its limit may still be running here (it cannot be stopped): this document is not used again
  let dead: Error | null = null
  const step = <T>(run: () => Promise<T>, ms: number, error: () => Error): Promise<T> => {
    if (dead) return Promise.reject(dead)
    return limited(run(), ms, error, () => {
      dead = error()
    })
  }
  return {
    get pageCount() {
      return b.pageCount
    },
    addPage: (page) => step(() => b.addPage(page), limits.pageMs, tookTooLong('page')),
    addVectorPage: (page) => step(() => b.addVectorPage(page), limits.vectorPageMs, vectorPageTimeout),
    finish: () => step(() => b.finish(), limits.finishMs, tookTooLong('file')),
    dispose() {
      dead ??= new Error('PDF export cancelled')
    },
    offThread: false,
  }
}

export async function createPdfBuilderOffThread(meta: {
  title: string
  /** PDF_TIME_LIMITS unless a test sets them */
  limits?: Partial<PdfTimeLimits>
}): Promise<DisposablePdfBuilder> {
  const limits: PdfTimeLimits = { ...PDF_TIME_LIMITS, ...meta.limits }
  let worker: Worker
  try {
    worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), {
      type: 'module',
      name: 'draftroom-pdf',
    })
  } catch {
    return mainThreadBuilder(meta.title, limits)
  }

  let nextId = 1
  let dead: Error | null = null
  const pending = new Map<number, { resolve(r: PdfWorkerResponse): void; reject(e: Error): void }>()
  const failAll = (e: Error) => {
    dead = e
    for (const p of pending.values()) p.reject(e)
    pending.clear()
  }
  /** The document is given up: the worker stops (it may be stuck in a page), every call rejects with `e`. */
  const kill = (e: Error) => {
    worker.terminate()
    failAll(e)
  }
  worker.addEventListener('message', (e: MessageEvent<PdfWorkerResponse>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    p.resolve(e.data)
  })
  worker.addEventListener('error', (e) => failAll(new Error(e.message || 'The PDF worker failed')))
  worker.addEventListener('messageerror', () => failAll(new Error('The PDF worker could not read a message')))

  const call = (
    msg: WithoutId<PdfWorkerRequest>,
    ms: number,
    timedOut: () => Error,
    transfer: Transferable[] = [],
  ) =>
    new Promise<PdfWorkerResponse>((resolve, reject) => {
      if (dead) {
        reject(dead)
        return
      }
      const id = nextId++
      const timer = setTimeout(() => kill(timedOut()), ms)
      pending.set(id, {
        resolve(r) {
          clearTimeout(timer)
          resolve(r)
        },
        reject(e) {
          clearTimeout(timer)
          reject(e)
        },
      })
      worker.postMessage({ ...msg, id }, transfer)
    })
  const expectOk = (r: PdfWorkerResponse) => {
    if (r.type === 'error') throw new Error(r.message)
    return r
  }
  try {
    const start = { type: 'start' as const, title: meta.title, now: Date.now() }
    expectOk(await call(start, limits.startMs, tookTooLong('worker')))
  } catch {
    worker.terminate()
    return mainThreadBuilder(meta.title, limits)
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
      const r = expectOk(await call({ type: 'page', page }, limits.pageMs, tookTooLong('page'), transfer))
      if (r.type === 'ok') pageCount = r.pageCount
    },
    async addVectorPage(page: PdfVectorPageInput) {
      const transfer = page.headerImage ? [page.headerImage.bytes.buffer as ArrayBuffer] : []
      const msg = { type: 'vector-page' as const, page }
      const r = expectOk(await call(msg, limits.vectorPageMs, vectorPageTimeout, transfer))
      if (r.type !== 'vector') throw new Error('Unexpected reply from the PDF worker')
      pageCount = r.pageCount
      return r.outcome
    },
    async finish() {
      try {
        const r = expectOk(await call({ type: 'finish' }, limits.finishMs, tookTooLong('file')))
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
      kill(new Error('PDF export cancelled'))
    },
    offThread: true,
  }
}
