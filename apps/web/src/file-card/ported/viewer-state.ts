// OWNER: 3g. Which PDF card's page viewer is open on this board page (local UI state, never synced;
// file-card/viewer-state.ts on tldraw, keyed by the page's registries instead of the editor).
import type { FeatureRegistries } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'

export interface PdfViewerRequest {
  /** the card's element id */
  readonly id: string
  /** the page to open at (1-based) */
  readonly page: number
  /** changes on every open, so reopening the same card starts fresh */
  readonly nonce: number
}

const requests = new WeakMap<FeatureRegistries, Atom<PdfViewerRequest | null>>()
let nonce = 0

export function pdfViewerRequest(registries: FeatureRegistries): Atom<PdfViewerRequest | null> {
  let a = requests.get(registries)
  if (!a) {
    a = atom<PdfViewerRequest | null>('media-pdf-viewer', null)
    requests.set(registries, a)
  }
  return a
}

export function openPdfViewer(registries: FeatureRegistries, id: string, page = 1): void {
  pdfViewerRequest(registries).set({ id, page, nonce: ++nonce })
}

export function closePdfViewer(registries: FeatureRegistries): void {
  pdfViewerRequest(registries).set(null)
}
