// Messages between the page and the PDF worker (pdf.worker.ts). Page images travel as transferred
// ArrayBuffers (no copy).
import type { PdfPageInput } from './pdf-build.ts'

export type PdfWorkerRequest =
  | { id: number; type: 'start'; title: string; now: number }
  | { id: number; type: 'page'; page: PdfPageInput }
  | { id: number; type: 'finish' }

export type PdfWorkerResponse =
  | { id: number; type: 'ok'; pageCount: number }
  | { id: number; type: 'done'; bytes: Uint8Array }
  | { id: number; type: 'error'; message: string }
