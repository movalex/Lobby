// API schema for link previews (D2, docs/research/excalidraw/REVIEW-W5-EARLY.md §9): a URL pasted on the
// Excalidraw board becomes a link card (title, site icon, opens in a new tab), drawn by Lobby's overlay;
// the page's title and icon are fetched by the api, never by the board (no third-party request or script
// in the browser). Browser-safe. Owned by the media owner (3g).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
import { z } from 'zod'

/** POST: the URL travels in the body, so it never sits in an access log's request line. */
export const LINK_PREVIEW_ROUTE = '/api/boards/:bid/link-preview'
export const linkPreviewPath = (boardId: string) => `/api/boards/${encodeURIComponent(boardId)}/link-preview`

export const LinkPreviewInput = z.strictObject({ url: z.string().min(1).max(2048) })
export type LinkPreviewInput = z.infer<typeof LinkPreviewInput>

/**
 * What the page says about itself. Every field is null when the page could not be read (unreachable,
 * refused by the api's network rules, not HTML, too slow): the card then shows the link's host.
 * `icon` is a small raster image as a `data:` URL, for this view only: it is never stored in an element.
 */
export interface LinkPreview {
  readonly title: string | null
  readonly siteName: string | null
  readonly icon: string | null
}

/** The icon's byte limit before it is encoded (a favicon; larger ones are skipped). */
export const LINK_PREVIEW_ICON_MAX_BYTES = 64 * 1024
