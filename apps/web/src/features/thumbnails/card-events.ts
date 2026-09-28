// "This tab just changed a board's thumbnail": the dashboard card listens, so a thumbnail sent while
// the board closed (the upload finishes after the dashboard fetched its list) still shows without a
// reload. Same tab only; other tabs and people see it with their next board list.

export const THUMBNAIL_UPDATED_EVENT = 'draftroom:thumbnail-updated'

export interface ThumbnailUpdatedDetail {
  boardId: string
  /** The new version; null when the thumbnail was removed (the board has no content). */
  version: string | null
}

export function announceThumbnail(boardId: string, version: string | null): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ThumbnailUpdatedDetail>(THUMBNAIL_UPDATED_EVENT, { detail: { boardId, version } }),
  )
}

/** Calls `fn` with each new version of `boardId`'s thumbnail; returns the unsubscribe. */
export function onThumbnailUpdated(boardId: string, fn: (version: string | null) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<ThumbnailUpdatedDetail>).detail
    if (detail?.boardId === boardId) fn(detail.version)
  }
  window.addEventListener(THUMBNAIL_UPDATED_EVENT, listener)
  return () => window.removeEventListener(THUMBNAIL_UPDATED_EVENT, listener)
}
