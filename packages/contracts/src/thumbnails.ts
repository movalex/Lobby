// API schemas for dashboard board thumbnails (docs/WAVE3-CONTRACTS.md). Browser-safe. Owned by the thumbnails owner.
//
// Do not import values from ./index.ts here: index.ts re-exports this module. The one schema built on
// another module's (the board list) reads it inside a getter, which zod evaluates lazily on first
// parse, so the import cycle through ./dashboard.ts is safe.
//
// Routes (apps/api/src/features/thumbnails):
//   PUT    /api/boards/:bid/thumbnail       raw image body (edit; never guests) → ThumbnailUploaded
//   GET    /api/boards/:bid/thumbnail[?v=]  the image (view; 404 otherwise)
//   GET    /api/boards/:bid/thumbnail/meta  → ThumbnailMetaResponse (view)
//   DELETE /api/boards/:bid/thumbnail       the board has no content any more (edit; never guests) → 204
// Board lists (`GET /api/workspaces/:wid/boards`, `…/boards/starred`) carry `thumbnailVersion`.

import { z } from 'zod'
import { ListBoardsWithStarsResponse } from './dashboard.ts'

/** Image types the api accepts (checked against the bytes' magic numbers, not only the header). */
export const THUMBNAIL_MIME_TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const
export const ThumbnailMimeType = z.enum(THUMBNAIL_MIME_TYPES)
export type ThumbnailMimeType = z.infer<typeof ThumbnailMimeType>

/** Server cap on the raw body (413 above it). */
export const THUMBNAIL_MAX_BODY_BYTES = 256 * 1024
/** What a client aims for: it re-encodes or gives up above this. */
export const THUMBNAIL_TARGET_BYTES = 200 * 1024
/** Server cap on each dimension, read from the image header. */
export const THUMBNAIL_MAX_DIMENSION = 1024
/** The size clients capture at (at most; 16:10). */
export const THUMBNAIL_WIDTH = 480
export const THUMBNAIL_HEIGHT = 300
/** One accepted upload (or removal) per board in this window; 429 with Retry-After otherwise. */
export const THUMBNAIL_MIN_INTERVAL_MS = 30_000

/** Server-generated, opaque; changes on every accepted upload (cache key and ETag). */
export const THUMBNAIL_VERSION_PATTERN = /^[0-9a-f]{24}$/
export const ThumbnailVersion = z.string().regex(THUMBNAIL_VERSION_PATTERN)

export const BoardThumbnail = z.object({
  version: ThumbnailVersion,
  mimeType: ThumbnailMimeType,
  width: z.number().int().min(1).max(THUMBNAIL_MAX_DIMENSION),
  height: z.number().int().min(1).max(THUMBNAIL_MAX_DIMENSION),
  bytes: z.number().int().min(1).max(THUMBNAIL_MAX_BODY_BYTES),
  updatedAt: z.string(),
})
export type BoardThumbnail = z.infer<typeof BoardThumbnail>

export const ThumbnailUploaded = z.object({ thumbnail: BoardThumbnail })
export type ThumbnailUploaded = z.infer<typeof ThumbnailUploaded>

/** null: the board has no thumbnail yet (the dashboard shows its placeholder). */
export const ThumbnailMetaResponse = z.object({ thumbnail: BoardThumbnail.nullable() })
export type ThumbnailMetaResponse = z.infer<typeof ThumbnailMetaResponse>

/**
 * What board lists add to each board. Defaults to null so an older server's response still parses.
 * Always null for trashed boards (nobody can open one, so nobody can load its thumbnail).
 */
export const BoardThumbnailFields = { thumbnailVersion: ThumbnailVersion.nullable().default(null) }

/**
 * The dashboard's board list: M1's list with the dashboard's `starred`, this `thumbnailVersion` and (wave
 * J, ./outside.ts) `sharedOutside`: the card's "Shared outside" marker (absent from an older server: read
 * it as false; optional, not defaulted, so code that builds a board of its own keeps compiling).
 */
export const ListBoardsWithThumbnailsResponse = z.object({
  get boards() {
    return z.array(
      ListBoardsWithStarsResponse.shape.boards.element.extend({
        ...BoardThumbnailFields,
        sharedOutside: z.boolean().optional(),
      }),
    )
  },
})
export type BoardWithThumbnail = z.infer<typeof ListBoardsWithThumbnailsResponse>['boards'][number]

/** The image URL. `?v=<version>` lets the browser keep it (a new upload means a new URL). */
export function thumbnailPath(boardId: string, version?: string | null): string {
  const base = `/api/boards/${encodeURIComponent(boardId)}/thumbnail`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}
