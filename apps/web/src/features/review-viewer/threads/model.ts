// OWNER: WS3 (wave S, media comments). The review viewer's pure thread logic (docs/WAVE-S-CONTRACTS.md §4): which
// threads belong to the version shown, their order, the anchor a new time, page or spot comment gets, and the spot
// math between a click and (u, v). Unit-tested.
import { toShapeRef } from '@draftroom/canvas-schema/refs'
import type { CommentAssetAnchor, CommentSpot, CommentThread } from '@draftroom/contracts'

/** A thread with an `asset` anchor (the viewer only lists those). */
export type MediaThread = CommentThread & { readonly anchor: CommentAssetAnchor }

export const isMediaThread = (t: CommentThread): t is MediaThread => t.anchor.kind === 'asset'

/** Where a new comment goes in the file: a video time, a PDF page, a spot on the picture. */
export interface MediaPlace {
  readonly timeMs?: number
  readonly page?: number
  readonly spot?: CommentSpot
}

const time = (iso: string) => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/**
 * The threads of one version of a file, in the file's order: by time (a video), by page (a PDF), then oldest first.
 * Resolved threads only with `resolved`. Threads of another version or another asset never.
 */
export function threadsOfVersion(
  threads: Iterable<CommentThread>,
  file: { readonly assetId: string; readonly versionId: string },
  opts: { readonly resolved?: boolean } = {},
): MediaThread[] {
  const out: MediaThread[] = []
  for (const t of threads) {
    if (!isMediaThread(t)) continue
    if (t.anchor.assetId !== file.assetId || t.anchor.versionId !== file.versionId) continue
    if (t.status === 'resolved' && !opts.resolved) continue
    out.push(t)
  }
  return out.sort(
    (a, b) =>
      (a.anchor.timeMs ?? -1) - (b.anchor.timeMs ?? -1) ||
      (a.anchor.page ?? 0) - (b.anchor.page ?? 0) ||
      time(a.createdAt) - time(b.createdAt) ||
      a.id.localeCompare(b.id),
  )
}

/** Every thread on any version of the asset (the CSV export lists them all, with their version). */
export function threadsOfAsset(threads: Iterable<CommentThread>, assetId: string): MediaThread[] {
  const out: MediaThread[] = []
  for (const t of threads) if (isMediaThread(t) && t.anchor.assetId === assetId) out.push(t)
  return out.sort(
    (a, b) =>
      time(a.createdAt) - time(b.createdAt) ||
      (a.anchor.timeMs ?? -1) - (b.anchor.timeMs ?? -1) ||
      a.id.localeCompare(b.id),
  )
}

/** The `asset` anchor of a new comment on the file the viewer shows (`elementId`'s card or image). */
export function mediaAnchor(
  file: { readonly elementId: string; readonly assetId: string; readonly versionId: string },
  place: Pick<MediaPlace, 'timeMs' | 'page'>,
): CommentAssetAnchor {
  return {
    kind: 'asset',
    shapeId: toShapeRef(file.elementId),
    assetId: file.assetId,
    versionId: file.versionId,
    ...(place.page !== undefined ? { page: Math.max(1, Math.round(place.page)) } : {}),
    ...(place.timeMs !== undefined ? { timeMs: Math.max(0, Math.round(place.timeMs)) } : {}),
  }
}

const unit4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000

/**
 * The spot under a click on the picture's box (its on-screen rect): (u, v) in [0, 1], 4 decimals; null outside
 * the box (or a box of no size).
 */
export function spotAt(
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  clientX: number,
  clientY: number,
): CommentSpot | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  const u = (clientX - rect.left) / rect.width
  const v = (clientY - rect.top) / rect.height
  if (u < 0 || u > 1 || v < 0 || v > 1) return null
  return { u: unit4(u), v: unit4(v) }
}

/** Where a spot pin is drawn inside the picture's box (CSS percentages). */
export const spotStyle = (spot: CommentSpot): { left: string; top: string } => ({
  left: `${unit4(spot.u) * 100}%`,
  top: `${unit4(spot.v) * 100}%`,
})

/** How many open threads each page has (the PDF viewers' page markers). */
export function threadsPerPage(threads: readonly MediaThread[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const t of threads) {
    const p = t.anchor.page
    if (p !== undefined && t.status === 'open') out.set(p, (out.get(p) ?? 0) + 1)
  }
  return out
}

/** Within this much of a thread's time, the video shows its spot pin on the frame. */
export const SPOT_SHOWN_MS = 750

/** The threads whose spot pin shows on the video frame at `ms` (its time within SPOT_SHOWN_MS), or on page `page`. */
export function spotsShown(
  threads: readonly MediaThread[],
  at: { readonly ms?: number; readonly page?: number },
) {
  return threads.filter((t) => {
    if (!t.spot) return false
    if (at.page !== undefined) return t.anchor.page === at.page
    if (at.ms !== undefined)
      return t.anchor.timeMs !== undefined && Math.abs(t.anchor.timeMs - at.ms) <= SPOT_SHOWN_MS
    return t.anchor.page === undefined && t.anchor.timeMs === undefined
  })
}
