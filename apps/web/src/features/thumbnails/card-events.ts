// "This tab just changed a board's thumbnail": the dashboard card listens, so a thumbnail sent while
// the board closed (the upload finishes after the dashboard fetched its list) still shows without a
// reload. Same tab only; other tabs and people see it with their next board list.
//
// N1-THUMBS: leaving a board sends its picture as the dashboard asks for its list. The list can be read
// before the upload is stored and reach the page after the upload's answer, before any card is there
// to hear it: a card made then takes this tab's recent announcement (`recentThumbnail`).

import { THUMBNAIL_MIN_INTERVAL_MS } from '@draftroom/contracts'

export const THUMBNAIL_UPDATED_EVENT = 'draftroom:thumbnail-updated'

/**
 * How long this tab's announcement counts for a card made after it. Well inside the api's one upload
 * per board every THUMBNAIL_MIN_INTERVAL_MS (anyone's): no board list read meanwhile can hold a picture
 * newer than the announced one.
 */
export const RECENT_ANNOUNCEMENT_MS = THUMBNAIL_MIN_INTERVAL_MS / 3

export interface ThumbnailUpdatedDetail {
  boardId: string
  /** The new version; null when the thumbnail was removed (the board has no content). */
  version: string | null
}

/** This tab's last announcement per board, and when (Date.now()). */
const announced = new Map<string, { version: string | null; at: number }>()

export function announceThumbnail(boardId: string, version: string | null): void {
  if (typeof window === 'undefined') return
  const now = Date.now()
  for (const [id, a] of announced) if (now - a.at >= RECENT_ANNOUNCEMENT_MS) announced.delete(id)
  announced.set(boardId, { version, at: now })
  window.dispatchEvent(
    new CustomEvent<ThumbnailUpdatedDetail>(THUMBNAIL_UPDATED_EVENT, { detail: { boardId, version } }),
  )
}

/** This tab's announcement of `boardId`'s thumbnail in the last RECENT_ANNOUNCEMENT_MS, if any. */
export function recentThumbnail(boardId: string): { version: string | null } | null {
  const a = announced.get(boardId)
  if (!a || Date.now() - a.at >= RECENT_ANNOUNCEMENT_MS) return null
  return { version: a.version }
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
