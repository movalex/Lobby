// OWNER: the wave S foundation (the lead). Which file the review viewer shows on this board page (local UI state, never
// synced), keyed by the page's registries like the PDF viewer's (file-card/ported/viewer-state.ts). WS2 (versions,
// compare), WS3 (media comments) and WS4 (the review page's "Play" and "View pages") open it through openReviewViewer;
// none of them edits this file (a new field goes through the lead).
import type { FeatureRegistries } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'

/** Where in the file to open: a video time or a PDF page (the thread anchor's facts, contracts comments.ts). */
export interface ReviewViewerAt {
  readonly timeMs?: number
  readonly page?: number
}

export interface ReviewViewerRequest {
  /** the card's (or image's) element id */
  readonly elementId: string
  /** the deliverable: every version shares it (contracts asset-versions.ts) */
  readonly assetId: string
  /** the version shown (the card's current one unless a "v1" chip or the version list asked for another) */
  readonly versionId: string
  /** 'compare': WS2's compare slot shows `versionId` against `compareWith` */
  readonly mode: 'view' | 'compare'
  readonly compareWith: string | null
  readonly at: ReviewViewerAt | null
  /** a thread to open in the side list (a marker click, "Jump to 00:12.4") */
  readonly threadId: string | null
  /** changes on every open, so reopening the same file starts fresh */
  readonly nonce: number
}

export type ReviewViewerOpen = Pick<ReviewViewerRequest, 'elementId' | 'assetId' | 'versionId'> &
  Partial<Pick<ReviewViewerRequest, 'mode' | 'compareWith' | 'at' | 'threadId'>>

const requests = new WeakMap<FeatureRegistries, Atom<ReviewViewerRequest | null>>()
let nonce = 0

export function reviewViewerRequest(registries: FeatureRegistries): Atom<ReviewViewerRequest | null> {
  let a = requests.get(registries)
  if (!a) {
    a = atom<ReviewViewerRequest | null>('review-viewer', null)
    requests.set(registries, a)
  }
  return a
}

/** Opens the viewer (or reopens it on another file, version or spot). The host shows it only with its switch on. */
export function openReviewViewer(registries: FeatureRegistries, open: ReviewViewerOpen): void {
  reviewViewerRequest(registries).set({
    elementId: open.elementId,
    assetId: open.assetId,
    versionId: open.versionId,
    mode: open.mode ?? 'view',
    compareWith: open.compareWith ?? null,
    at: open.at ?? null,
    threadId: open.threadId ?? null,
    nonce: ++nonce,
  })
}

export function closeReviewViewer(registries: FeatureRegistries): void {
  reviewViewerRequest(registries).set(null)
}
