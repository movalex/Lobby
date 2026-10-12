// The font engine of vector PDF pages (wave N, N6-1): @pdf-lib/fontkit (MIT) reads Lobby's self-hosted font files
// and subsets them into the PDF (PDFDocument.registerFontkit, embedFont(bytes, { subset: true })). It loads with the
// PDF worker only, never with the board.
//
// NOT INSTALLED YET: adding @pdf-lib/fontkit to the catalog needs one fetch from the npm registry, which this
// wave's agent rules did not allow without the lead's approval (WS6 report). Until the dependency lands this answers
// null, every vector page with text in a Lobby font falls back to an image page (vector-page.ts says why), and
// VECTOR_PDF (../vector-pdf.ts) stays false so nobody is offered a vector PDF that is not one. Landing it:
//   1. pnpm-workspace.yaml catalog: '@pdf-lib/fontkit': <exact version>; apps/web/package.json: "@pdf-lib/fontkit": "catalog:";
//   2. here: `return (await import('@pdf-lib/fontkit')).default`;
//   3. VECTOR_PDF = true, and the fontkit-gated tests run (vector-page.fontkit.test.ts, n6-vector-pdf.spec.ts).
import type { PDFDocument } from '@cantoo/pdf-lib'

export type Fontkit = Parameters<PDFDocument['registerFontkit']>[0]

export async function loadFontkit(): Promise<Fontkit | null> {
  return null
}
