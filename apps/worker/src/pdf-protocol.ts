// Messages between pdf.ts (worker) and pdf-child.ts (isolated renderer). Request on stdin, one
// JSON response on stdout. Types only.

export interface PdfChildRequest {
  /** Worker-chosen path of the original (never a user file name). */
  input: string
  /** Scratch dir the child writes p<N>.webp into. */
  outDir: string
  /** Render pages 1..min(pageCount, pages). */
  pages: number
  pageWidth: number
  maxEdge: number
  quality: number
  maxPages: number
  maxImagePixels: number
}

export type PdfChildResponse =
  | { ok: true; pageCount: number; rendered: number[] }
  | { ok: false; reason: 'encrypted' | 'invalid' | 'too_many_pages'; name: string; pageCount?: number }

export const pageFileName = (page: number) => `p${page}.webp`
