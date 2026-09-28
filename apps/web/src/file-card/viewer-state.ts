import { type Atom, atom, type Editor, type TLShapeId } from 'tldraw'

/** Which PDF card's page viewer is open in this tab (local UI state, never synced). */
export interface PdfViewerRequest {
  shapeId: TLShapeId
  /** The page to open at (1-based). */
  page: number
  /** Changes on every open, so reopening the same card starts fresh. */
  nonce: number
}

const requests = new WeakMap<Editor, Atom<PdfViewerRequest | null>>()
let nonce = 0

export function pdfViewerRequest(editor: Editor): Atom<PdfViewerRequest | null> {
  let a = requests.get(editor)
  if (!a) {
    a = atom<PdfViewerRequest | null>('dr-pdf-viewer', null)
    requests.set(editor, a)
  }
  return a
}

export function openPdfViewer(editor: Editor, shapeId: TLShapeId, page = 1) {
  pdfViewerRequest(editor).set({ shapeId, page, nonce: ++nonce })
}

export function closePdfViewer(editor: Editor) {
  pdfViewerRequest(editor).set(null)
}
