// Messages between pdf.ts (worker) and pdf-child.ts (isolated renderer). Request on stdin, one
// JSON response on stdout. Types, and the one pattern the child matches.

export interface PdfChildRequest {
  /** Worker-chosen path of the original (never a user file name). */
  input: string
  /** Scratch dir the child writes p<N>.webp into. */
  outDir: string
  /** Render pages firstPage..min(pageCount, pages). */
  pages: number
  /**
   * Wave W (WS4, deck import: ops/render-pages.ts): the first page to render, default 1. Previews leave it out (pages
   * 1..8); a render-pages op asks for its own run (9..38, 39..68, …) at the same width.
   */
  firstPage?: number
  pageWidth: number
  maxEdge: number
  quality: number
  maxPages: number
  maxImagePixels: number
  /**
   * Wave R: a one-page document whose text is Illustrator's "saved without PDF Content" notice is refused
   * (`no_pdf_content`) instead of previewing the notice. Set for uploaded PDFs and .ai files, not Office conversions.
   */
  noPdfContentCheck?: boolean
}

export type PdfChildResponse =
  | { ok: true; pageCount: number; rendered: number[] }
  | {
      ok: false
      reason: 'encrypted' | 'invalid' | 'too_many_pages' | 'no_pdf_content'
      name: string
      pageCount?: number
    }

/** Illustrator's stub page in a file saved without "Create PDF Compatible File". */
export const NO_PDF_CONTENT_RE = /saved\s+without\s+PDF\s+Content/i

export const pageFileName = (page: number) => `p${page}.webp`
