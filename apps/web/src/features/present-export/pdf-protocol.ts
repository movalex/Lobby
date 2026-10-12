// Messages between the page and the PDF worker (pdf.worker.ts). Page images travel as transferred
// ArrayBuffers (no copy); a vector page's SVG as a string.
import type { PdfPageInput, PdfVectorPageInput } from './pdf-build.ts'
import type { VectorOutcome } from './vector/vector-page.ts'

export type PdfWorkerRequest =
  | { id: number; type: 'start'; title: string; now: number }
  | { id: number; type: 'page'; page: PdfPageInput }
  /** wave N (N6-3): a vector page; the answer says whether it was added or why not */
  | { id: number; type: 'vector-page'; page: PdfVectorPageInput }
  | { id: number; type: 'finish' }

export type PdfWorkerResponse =
  | { id: number; type: 'ok'; pageCount: number }
  | { id: number; type: 'vector'; pageCount: number; outcome: VectorOutcome }
  | { id: number; type: 'done'; bytes: Uint8Array }
  | { id: number; type: 'error'; message: string }
